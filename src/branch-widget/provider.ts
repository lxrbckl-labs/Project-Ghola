import * as vscode from 'vscode';
import type { AtlassianBridge } from '../extension';
import { AtlassianClient } from '../integration/atlassian-client';
import { WORKSPACE_STATE_KEYS } from '../state/keys';
import {
  buildBitbucketBranchUrl,
  buildTicketUrl,
  extractBitbucketRepoSlug,
  extractBitbucketWorkspace,
  extractTicketKey,
} from './url-builder';

/** Module id this widget draws its configuration from. */
const ATLASSIAN_MODULE_ID = 'integration.atlassian-suite';

/**
 * Minimal structural typing for VS Code's built-in Git extension API. The Git
 * extension does not ship its types via `@types/vscode`, so we duplicate the
 * shape of the slice we actually consume. This keeps strict typing without
 * pulling in the upstream `Git` ambient declarations.
 */
interface GitRemote {
  readonly name: string;
  readonly fetchUrl?: string;
  readonly pushUrl?: string;
}
interface GitHead {
  readonly name?: string;
}
interface GitRepositoryState {
  readonly HEAD?: GitHead;
  readonly remotes: ReadonlyArray<GitRemote>;
  readonly onDidChange: vscode.Event<void>;
}
interface GitRepository {
  readonly state: GitRepositoryState;
}
interface GitAPI {
  readonly repositories: ReadonlyArray<GitRepository>;
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
}
interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitAPI;
}

/**
 * Status of the live Jira ticket probe.
 *   - `unknown`  : no ticket key extracted from the branch name.
 *   - `checking` : ticket key present, API call in flight.
 *   - `exists`   : API confirmed the ticket exists.
 *   - `missing`  : API confirmed the ticket does not exist.
 *   - `fallback` : credentials missing — we surface the URL-builder URL
 *                  without an API check; the button stays enabled.
 */
type TicketStatus = 'unknown' | 'checking' | 'exists' | 'missing' | 'fallback';

/**
 * Status of the live Bitbucket PR probe.
 *   - `unknown`  : no branch + remote — cannot even guess.
 *   - `checking` : API call in flight against the open-PR endpoint.
 *   - `found`    : an open PR exists for this branch.
 *   - `none`     : no open PR found — the URL is the branch-overview fallback.
 *   - `fallback` : credentials missing — we surface the URL-builder URL
 *                  without an API check; the button stays enabled.
 */
type PrStatus = 'unknown' | 'checking' | 'found' | 'none' | 'fallback';

/**
 * Host → webview state push. The webview is purely render-and-postMessage; all
 * URL resolution happens on the host side so the iframe never holds raw
 * remote URLs or config values it does not need.
 *
 * Each push carries a monotonically-increasing `generation` — the webview
 * ignores any message with a generation lower than the most-recently-rendered
 * one so a late-arriving API response from a previous refresh never overwrites
 * a fresh state.
 */
interface StateMessage {
  type: 'state';
  generation: number;
  branch: string | null;
  ticketKey: string | null;
  ticketUrl: string | null;
  branchUrl: string | null;
  ticketStatus: TicketStatus;
  prStatus: PrStatus;
  /** Total number of Git repositories in the workspace. 1 in the common case. */
  repoCount: number;
}

/** Webview → host messages. */
type WebviewMessage =
  | { type: 'openTicket' }
  | { type: 'openBranch' }
  | { type: 'refresh' };

/**
 * Renders a small panel inside the Source Control container that surfaces the
 * current branch's Jira ticket key and one-click links to the Jira ticket and
 * the Bitbucket PR / branch page. Visibility is gated by the
 * `nomeda.atlassianSuite.widgetEnabled` context key (driven by the
 * `integration.atlassian-suite` module's `showWidget` setting); if this
 * provider resolves a view, the toggle is on.
 *
 * State resolution is **streaming**: the synchronous git/config read is pushed
 * to the webview immediately so the user sees branch info without waiting,
 * and live API probes (ticket exists? open PR?) are spawned in parallel and
 * pushed as follow-up state messages as they resolve.
 */
export class BranchWidgetProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  /**
   * Subscriptions that live only for the lifetime of a resolved view. Disposed
   * via the view's `onDidDispose` handler so we never leak Git-extension
   * listeners after the user collapses the SCM container.
   */
  private viewDisposables: vscode.Disposable[] = [];
  /** Per-repo `onDidChange` subscriptions, refreshed when repositories open/close. */
  private repoSubscriptions: vscode.Disposable[] = [];
  /**
   * Monotonically-increasing generation counter. Each call to `pushState()`
   * increments this and stamps the new value onto every message it posts.
   * Late-arriving API responses from a previous generation are dropped before
   * posting; the webview also performs a defensive check on the receive side.
   */
  private activeGen = 0;

  /**
   * @param context Extension context — used to read flattened module settings
   *   from workspaceState under `nomeda.moduleSettings`.
   * @param onDidChangeModuleSettings Event fired by the host whenever
   *   `nomeda.moduleSettings` is rewritten. The provider re-pulls config and
   *   pushes fresh state to the webview when it fires.
   * @param bridge AtlassianBridge — supplies the API token, validation state,
   *   and a change event so the widget refreshes after the user sets / clears
   *   the token or re-validates.
   * @param getAtlassianSetting Optional resolver supplied by the host that
   *   reads a named setting from workspaceState and falls back to the module
   *   manifest's declared default when no persisted value exists. When provided,
   *   `readModuleSetting` delegates to it for string fields so that fields shown
   *   as pre-populated in the Settings panel (e.g. `bitbucketWorkspace`) are
   *   treated as present by the widget even before the user has saved them.
   */
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onDidChangeModuleSettings?: vscode.Event<void>,
    private readonly bridge?: AtlassianBridge,
    private readonly getAtlassianSetting?: (fieldKey: string) => string,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.renderHtml(webviewView.webview);

    const messageSub = webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      void this.handle(msg);
    });
    this.viewDisposables.push(messageSub);

    // React to module-settings changes. The host fires `onDidChangeModuleSettings`
    // after every save of the flattened `nomeda.moduleSettings` workspace-state
    // entry, so we re-pull `jiraBase` / `bitbucketWorkspace` and refresh the
    // webview without depending on a `nomeda.*` configuration key.
    if (this.onDidChangeModuleSettings) {
      const settingsSub = this.onDidChangeModuleSettings(() => this.pushState());
      this.viewDisposables.push(settingsSub);
    }

    // React to validation events (token set / cleared / re-validated). Each
    // change re-runs the full probe pass so the buttons reflect the new state.
    if (this.bridge) {
      const validationSub = this.bridge.onDidChangeValidation(() => this.pushState());
      this.viewDisposables.push(validationSub);
    }

    // Wire Git-extension listeners. Wrapped because the extension may not be
    // available in environments without the built-in Git provider.
    this.wireGitListeners();

    // Initial state push happens immediately so the webview renders branch
    // info without waiting for API probes; the async probes follow up.
    this.pushState();

    webviewView.onDidDispose(() => {
      this.disposeViewSubscriptions();
      this.view = undefined;
    });
  }

  // ─── Git extension wiring ──────────────────────────────────────────────

  private wireGitListeners(): void {
    const gitExt = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!gitExt) {
      // Git extension unavailable — widget still renders, just with no branch.
      return;
    }
    const attach = (api: GitAPI): void => {
      this.refreshRepoSubscriptions(api);
      const openSub = api.onDidOpenRepository(() => {
        this.refreshRepoSubscriptions(api);
        this.pushState();
      });
      const closeSub = api.onDidCloseRepository(() => {
        this.refreshRepoSubscriptions(api);
        this.pushState();
      });
      this.viewDisposables.push(openSub, closeSub);
    };

    if (gitExt.isActive) {
      attach(gitExt.exports.getAPI(1));
    } else {
      void gitExt.activate().then((ext) => {
        if (this.view) attach(ext.getAPI(1));
      });
    }
  }

  private refreshRepoSubscriptions(api: GitAPI): void {
    for (const sub of this.repoSubscriptions) sub.dispose();
    this.repoSubscriptions = [];
    for (const repo of api.repositories) {
      const sub = repo.state.onDidChange(() => this.pushState());
      this.repoSubscriptions.push(sub);
    }
  }

  // ─── State resolution + push (streaming) ───────────────────────────────

  /**
   * Compose and post the initial synchronous state, then spawn async API
   * probes that post follow-up updates as they resolve. Each push carries
   * the current generation counter; late responses from a previous
   * generation are dropped so a stale probe never clobbers fresh state.
   */
  private pushState(): void {
    if (!this.view) return;

    this.activeGen += 1;
    const gen = this.activeGen;

    // ── Synchronous read of git + module config ──
    const jiraBase = this.readModuleSetting<string>('jiraBase', 'https://herzog.atlassian.net');
    const fallbackWorkspace = this.readModuleSetting<string>('bitbucketWorkspace', '');
    const email = this.readModuleSetting<string>('email', '');

    const { branch, remoteUrl, repoCount } = this.readGitState();
    const ticketKey = extractTicketKey(branch);
    const fallbackTicketUrl = buildTicketUrl(ticketKey, jiraBase);
    const fallbackBranchUrl = buildBitbucketBranchUrl(remoteUrl, branch, fallbackWorkspace);

    const repoSlug = extractBitbucketRepoSlug(remoteUrl);
    const workspaceFromRemote = extractBitbucketWorkspace(remoteUrl);
    const workspace = workspaceFromRemote || fallbackWorkspace;

    // ── Decide credentials availability ──
    // We resolve the token lazily inside an async closure so the synchronous
    // initial push is not blocked on SecretStorage I/O. The closure then
    // decides whether to spawn API probes or short-circuit to fallback.
    let initialTicketStatus: TicketStatus = ticketKey ? 'checking' : 'unknown';
    let initialPrStatus: PrStatus = branch && repoSlug ? 'checking' : 'unknown';

    // Synchronous initial post — webview gets branch info instantly.
    this.post({
      type: 'state',
      generation: gen,
      branch,
      ticketKey,
      ticketUrl: fallbackTicketUrl,
      branchUrl: fallbackBranchUrl,
      ticketStatus: initialTicketStatus,
      prStatus: initialPrStatus,
      repoCount,
    });

    // Async follow-up: token + probes.
    void this.runProbes({
      gen,
      branch,
      remoteUrl,
      repoCount,
      ticketKey,
      jiraBase,
      email,
      workspace,
      repoSlug,
      fallbackTicketUrl,
      fallbackBranchUrl,
    });
  }

  /**
   * Async follow-up half of `pushState`. Resolves the token, decides whether
   * to run the API probes, and posts follow-up state messages as each probe
   * resolves. All paths check `gen === this.activeGen` before posting so a
   * late probe from a stale generation is silently dropped.
   */
  private async runProbes(args: {
    gen: number;
    branch: string | null;
    remoteUrl: string | null;
    repoCount: number;
    ticketKey: string | null;
    jiraBase: string;
    email: string;
    workspace: string;
    repoSlug: string | null;
    fallbackTicketUrl: string | null;
    fallbackBranchUrl: string | null;
  }): Promise<void> {
    const {
      gen,
      branch,
      ticketKey,
      jiraBase,
      email,
      workspace,
      repoSlug,
      repoCount,
      fallbackTicketUrl,
      fallbackBranchUrl,
    } = args;

    // Resolve both product tokens in parallel — they live under separate
    // SecretStorage keys (Jira / Bitbucket) and either may be undefined. Each
    // probe checks ITS own token independently before deciding fallback vs
    // live API check; we do NOT gate one product's probe on the other's
    // credentials.
    const [jiraToken, bitbucketToken] = await Promise.all([
      this.bridge ? this.bridge.getJiraToken() : Promise.resolve(undefined),
      this.bridge ? this.bridge.getBitbucketToken() : Promise.resolve(undefined),
    ]);

    // Helper: derive the snapshot of state for any follow-up post. The
    // ticket/PR status + URL fields are passed in; everything else is
    // captured from the closure.
    const snapshot = (
      ticketStatus: TicketStatus,
      ticketUrl: string | null,
      prStatus: PrStatus,
      branchUrl: string | null,
    ): StateMessage => ({
      type: 'state',
      generation: gen,
      branch,
      ticketKey,
      ticketUrl,
      branchUrl,
      ticketStatus,
      prStatus,
      repoCount,
    });

    // Credentials check per product:
    //   - Ticket probe needs email + Jira token + jiraBase + ticketKey.
    //   - PR probe needs email + Bitbucket token + workspace + repoSlug + branch.
    // Each gate is independent — missing a Jira token does NOT disable the
    // PR probe and vice versa.
    const canProbeTicket = Boolean(email && jiraToken && jiraBase && ticketKey);
    const canProbePr = Boolean(email && bitbucketToken && workspace && repoSlug && branch);

    // Track local status so each probe's post reflects the latest values of
    // BOTH statuses, not just its own. We need this because the two probes
    // resolve independently but each post carries the full state.
    let ticketStatus: TicketStatus = canProbeTicket
      ? 'checking'
      : ticketKey
        ? 'fallback'
        : 'unknown';
    let prStatus: PrStatus = canProbePr
      ? 'checking'
      : branch && (repoSlug || fallbackBranchUrl)
        ? 'fallback'
        : 'unknown';
    let ticketUrl: string | null = fallbackTicketUrl;
    let branchUrl: string | null = fallbackBranchUrl;

    // If neither probe will run, post the fallback state once and bail. This
    // upgrades the initial `checking` markers to `fallback` / `unknown` so the
    // UI does not show a permanent spinner.
    if (!canProbeTicket && !canProbePr) {
      if (gen === this.activeGen) {
        this.post(snapshot(ticketStatus, ticketUrl, prStatus, branchUrl));
      }
      return;
    }

    // Build a single client. Both probes share the instance but each picks
    // up its own product-specific token from the constructor options. The
    // client's per-method short-circuit ("missing token → skipped/empty
    // result") covers any per-product token absence — we do not need extra
    // branching here.
    const client = new AtlassianClient({
      email,
      jiraToken,
      bitbucketToken,
      jiraBase,
      bitbucketWorkspace: workspace,
    });

    // Post an intermediate state if a probe was downgraded to fallback while
    // the other still runs (e.g. ticket-key absent but PR probe live). Without
    // this the `checking` indicator on the dead leg would never clear.
    if (
      (!canProbeTicket && ticketStatus !== 'checking') ||
      (!canProbePr && prStatus !== 'checking')
    ) {
      if (gen === this.activeGen) {
        this.post(snapshot(ticketStatus, ticketUrl, prStatus, branchUrl));
      }
    }

    const probes: Promise<void>[] = [];

    if (canProbeTicket && ticketKey) {
      probes.push(
        client
          .checkTicketExists(ticketKey)
          .then((result) => {
            ticketStatus = result.exists ? 'exists' : 'missing';
            // Keep the URL-builder URL regardless — Jira URLs are stable and
            // the button stays useful even when the ticket lookup says missing
            // (the user may want to investigate). The status field is what
            // drives the disabled flag.
            if (gen === this.activeGen) {
              this.post(snapshot(ticketStatus, ticketUrl, prStatus, branchUrl));
            }
          })
          .catch(() => {
            // The client never throws, but belt-and-braces: a thrown error
            // collapses to fallback so the UI does not get stuck on `checking`.
            ticketStatus = 'fallback';
            if (gen === this.activeGen) {
              this.post(snapshot(ticketStatus, ticketUrl, prStatus, branchUrl));
            }
          }),
      );
    }

    if (canProbePr && repoSlug && branch) {
      probes.push(
        client
          .findOpenPrForBranch(repoSlug, branch)
          .then((result) => {
            if (result.prUrl) {
              prStatus = 'found';
              branchUrl = result.prUrl;
            } else {
              prStatus = 'none';
              // Keep the branch-overview fallback URL — when there is no
              // open PR yet the user often wants the branch page anyway.
              branchUrl = fallbackBranchUrl;
            }
            if (gen === this.activeGen) {
              this.post(snapshot(ticketStatus, ticketUrl, prStatus, branchUrl));
            }
          })
          .catch(() => {
            prStatus = 'fallback';
            branchUrl = fallbackBranchUrl;
            if (gen === this.activeGen) {
              this.post(snapshot(ticketStatus, ticketUrl, prStatus, branchUrl));
            }
          }),
      );
    }

    // Wait for all probes; we do not need the aggregate value, only to keep
    // the function alive long enough that any unhandled rejections would have
    // a chance to surface (the per-probe `.catch` above already handles them).
    await Promise.all(probes);
  }

  /**
   * Post a `StateMessage` to the webview, but only if it belongs to the
   * current generation. Returning early here is the second line of defence
   * after each caller's own `gen === this.activeGen` check.
   */
  private post(msg: StateMessage): void {
    if (!this.view) return;
    if (msg.generation !== this.activeGen) return;
    void this.view.webview.postMessage(msg);
  }

  /**
   * Read a single field from the `integration.atlassian-suite` module's
   * persisted settings. Mirrors the flat `moduleId::fieldKey` shape that the
   * panel writes; `defaultValue` is returned when the key is absent or the
   * stored value is not the expected primitive type.
   *
   * For string fields, if the stored value is absent or empty AND the host
   * supplied a `getAtlassianSetting` resolver, we delegate to it so that the
   * manifest-declared default is honoured even before the user has explicitly
   * saved the field. This mirrors the fix applied to `readAtlassianSetting` in
   * `extension.ts` and ensures the widget uses the correct workspace slug /
   * Jira base for URL construction even on first load.
   */
  private readModuleSetting<T>(fieldKey: string, defaultValue: T): T {
    const flat = this.context.workspaceState.get<Record<string, unknown>>(WORKSPACE_STATE_KEYS.MODULE_SETTINGS, {});
    const v = flat[`${ATLASSIAN_MODULE_ID}::${fieldKey}`];
    if (typeof v === typeof defaultValue && v !== null) {
      // For string fields, prefer the host resolver when the stored value is
      // an empty string — empty means "never explicitly saved", in which case
      // the manifest default (e.g. "herzog-technologies") should win.
      if (typeof v === 'string' && (v as string) === '' && this.getAtlassianSetting) {
        const resolved = this.getAtlassianSetting(fieldKey);
        return (resolved !== '' ? resolved : defaultValue) as T;
      }
      return v as T;
    }
    // No stored value at all — delegate to the host resolver (which applies
    // the manifest default) when available, otherwise use the local fallback.
    if (typeof defaultValue === 'string' && this.getAtlassianSetting) {
      const resolved = this.getAtlassianSetting(fieldKey);
      return (resolved !== '' ? resolved : defaultValue) as T;
    }
    return defaultValue;
  }

  private readGitState(): { branch: string | null; remoteUrl: string | null; repoCount: number } {
    const gitExt = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!gitExt || !gitExt.isActive) {
      return { branch: null, remoteUrl: null, repoCount: 0 };
    }
    try {
      const api = gitExt.exports.getAPI(1);
      const repoCount = api.repositories.length;
      const repo = api.repositories[0];
      if (!repo) return { branch: null, remoteUrl: null, repoCount };
      const branch = repo.state.HEAD?.name ?? null;
      const origin = repo.state.remotes.find((r) => r.name === 'origin');
      const remoteUrl = origin?.fetchUrl ?? origin?.pushUrl ?? null;
      return { branch, remoteUrl, repoCount };
    } catch {
      return { branch: null, remoteUrl: null, repoCount: 0 };
    }
  }

  // ─── Message handling ──────────────────────────────────────────────────

  private async handle(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'openTicket': {
        // Resolve the current ticket URL synchronously. The webview holds the
        // authoritative URL string in its last-rendered state, but re-deriving
        // here keeps the click side-channel free of any URL that might have
        // become stale between the last push and the click.
        const jiraBase = this.readModuleSetting<string>('jiraBase', 'https://herzog.atlassian.net');
        const { branch } = this.readGitState();
        const ticketKey = extractTicketKey(branch);
        const ticketUrl = buildTicketUrl(ticketKey, jiraBase);
        if (ticketUrl) await this.openInSimpleBrowser(ticketUrl);
        break;
      }
      case 'openBranch': {
        // For the PR/branch button we cannot recover the live PR URL
        // synchronously (it lives only in the most-recent state push). Fall
        // back to the URL-builder branch URL — same behavior as before this
        // feature shipped, and a reasonable default when the user clicks
        // mid-refresh.
        const fallbackWorkspace = this.readModuleSetting<string>('bitbucketWorkspace', '');
        const { branch, remoteUrl } = this.readGitState();
        const branchUrl = buildBitbucketBranchUrl(remoteUrl, branch, fallbackWorkspace);
        if (branchUrl) await this.openInSimpleBrowser(branchUrl);
        break;
      }
      case 'refresh':
        this.pushState();
        break;
      default:
        // Unknown message — ignore to stay forward-compatible with new fields.
        break;
    }
  }

  private async openInSimpleBrowser(url: string): Promise<void> {
    // `simpleBrowser.show` is contributed by the built-in Simple Browser
    // extension. Fall back to the OS browser if it is unavailable.
    try {
      await vscode.commands.executeCommand('simpleBrowser.show', url);
    } catch {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }
  }

  // ─── Disposal ──────────────────────────────────────────────────────────

  private disposeViewSubscriptions(): void {
    for (const sub of this.viewDisposables) sub.dispose();
    this.viewDisposables = [];
    for (const sub of this.repoSubscriptions) sub.dispose();
    this.repoSubscriptions = [];
  }

  // ─── HTML ──────────────────────────────────────────────────────────────

  private renderHtml(webview: vscode.Webview): string {
    const nonce = this.makeNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <title>Nomeda Branch Widget</title>
    <style>
      body {
        padding: 8px 12px;
        font-family: var(--vscode-font-family);
        font-size: 12px;
        color: var(--vscode-foreground);
      }
      .branch-widget { display: flex; flex-direction: column; gap: 6px; }
      .row { display: flex; align-items: center; gap: 6px; }
      .label {
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .branch {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 12px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .key {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 13px;
        font-weight: 600;
        color: var(--vscode-textLink-foreground);
        min-height: 1.2em;
      }
      .key.empty { color: var(--vscode-descriptionForeground); font-weight: normal; font-style: italic; }
      .buttons { display: flex; gap: 6px; margin-top: 2px; }
      button {
        flex: 1;
        font-size: 12px;
        padding: 4px 8px;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: 1px solid var(--vscode-button-border, transparent);
        border-radius: 2px;
        cursor: pointer;
      }
      button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
      button:disabled { opacity: 0.5; cursor: default; }
      /* The refresh button is the action chrome — narrower than the link
         buttons so it does not steal horizontal space from Ticket/PR. */
      #refreshBtn { flex: 0 0 auto; min-width: 28px; }
      .repo-count {
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        margin-left: auto;
        white-space: nowrap;
      }
    </style>
  </head>
  <body>
    <div class="branch-widget">
      <div id="enabledContent">
        <div class="row">
          <span class="label">Branch:</span>
          <span class="branch" id="branch">—</span>
          <span class="repo-count" id="repoCount" hidden></span>
        </div>
        <div class="key empty" id="key">No ticket key</div>
        <div class="buttons">
          <button id="ticket" disabled>Ticket</button>
          <button id="branchBtn" disabled>PR</button>
          <button id="refreshBtn" aria-label="Refresh branch state" title="Refresh">↻</button>
        </div>
      </div>
    </div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const branchEl = document.getElementById('branch');
      const keyEl = document.getElementById('key');
      const ticketBtn = document.getElementById('ticket');
      const branchBtn = document.getElementById('branchBtn');
      const refreshBtn = document.getElementById('refreshBtn');
      const repoCountEl = document.getElementById('repoCount');

      // Track the highest generation rendered so far. Defensive: the host
      // already drops stale messages before postMessage, but a race during
      // very fast refreshes could still surface an older message — ignore it.
      let lastGen = -1;

      ticketBtn.addEventListener('click', () => vscode.postMessage({ type: 'openTicket' }));
      branchBtn.addEventListener('click', () => vscode.postMessage({ type: 'openBranch' }));
      refreshBtn.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg || msg.type !== 'state') return;
        if (typeof msg.generation === 'number' && msg.generation < lastGen) return;
        if (typeof msg.generation === 'number') lastGen = msg.generation;

        if (msg.branch) {
          branchEl.textContent = msg.branch;
        } else {
          branchEl.textContent = 'No branch detected.';
        }
        if (msg.repoCount > 1) {
          repoCountEl.textContent = '+' + (msg.repoCount - 1) + ' more repo' + (msg.repoCount - 1 === 1 ? '' : 's');
          repoCountEl.hidden = false;
        } else {
          repoCountEl.hidden = true;
        }
        if (msg.ticketKey) {
          keyEl.textContent = msg.ticketKey;
          keyEl.classList.remove('empty');
          keyEl.hidden = false;
        } else {
          keyEl.hidden = true;
        }

        // Ticket button: label reflects probe status, disabled flag reflects
        // whether we have a URL the user can usefully click through.
        const ticketChecking = msg.ticketStatus === 'checking';
        ticketBtn.textContent = ticketChecking ? 'Ticket …' : 'Ticket';
        ticketBtn.title =
          msg.ticketStatus === 'exists' ? 'Ticket exists — open in Jira'
          : msg.ticketStatus === 'missing' ? 'Ticket not found in Jira'
          : msg.ticketStatus === 'fallback' ? 'Open ticket URL (unverified)'
          : '';
        ticketBtn.disabled =
          !msg.ticketUrl ||
          ticketChecking ||
          msg.ticketStatus === 'missing' ||
          msg.ticketStatus === 'unknown';

        // PR button: same pattern. The 'unknown' status (no branch/remote) is
        // the only state that fully disables the button — every other state
        // has at least the branch-overview fallback URL.
        const prChecking = msg.prStatus === 'checking';
        branchBtn.textContent =
          prChecking ? 'PR …'
          : msg.prStatus === 'found' ? 'PR'
          : msg.prStatus === 'none' ? 'Branch'
          : 'PR';
        branchBtn.title =
          msg.prStatus === 'found' ? 'Open the pull request'
          : msg.prStatus === 'none' ? 'No open PR — open the branch in Bitbucket'
          : msg.prStatus === 'fallback' ? 'Open branch URL (unverified)'
          : '';
        branchBtn.disabled =
          !msg.branchUrl ||
          prChecking ||
          msg.prStatus === 'unknown';

        // Refresh button is always enabled — even when no branch is detected,
        // re-running the check is harmless and may pick up a newly-opened repo.
        refreshBtn.disabled = false;
      });
    </script>
  </body>
</html>`;
  }

  private makeNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 32; i++) {
      out += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return out;
  }
}
