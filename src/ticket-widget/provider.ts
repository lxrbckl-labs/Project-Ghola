import * as vscode from 'vscode';
import type { AtlassianBridge } from '../extension';
import { AtlassianClient } from '../integration/atlassian-client';
import { adfExtractAcceptanceCriteria } from '../integration/adf-to-text';
import { TicketTodosStoreManager, TicketTodo } from './todos-store';
import {
  buildBitbucketBranchUrl,
  buildTicketUrl,
  extractBitbucketRepoSlug,
  extractBitbucketWorkspace,
} from './url-builder';
import { WORKSPACE_STATE_KEYS } from '../state/keys';

/** Module id that supplies the Atlassian connection settings (jiraBase, etc.). */
const ATLASSIAN_MODULE_ID = 'integration.atlassian-suite';

/**
 * Minimal structural typing for VS Code's built-in Git extension API. The Git
 * extension does not ship its types via `@types/vscode`, so we duplicate the
 * shape of the slice we actually consume — matches the typing the branch
 * widget uses so we can mirror its repo-state-change wiring exactly.
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
 * Status of the live Jira ticket-details probe.
 *   - `idle`     : no ticket key on the current branch — nothing to probe.
 *   - `loading`  : ticket id present, API call in flight.
 *   - `ok`       : details loaded; `summary` / `status` populated on the state.
 *   - `missing`  : Jira returned 404 — the configured ticket id does not exist.
 *   - `fallback` : credentials missing or request failed; the widget falls
 *                  back to a URL-only view with no live summary or status.
 */
type TicketProbe = 'idle' | 'loading' | 'ok' | 'missing' | 'fallback';

/**
 * Status of the live Bitbucket PR probe.
 *   - `idle`     : PR lookup disabled (setting off, no branch, or no remote).
 *   - `loading`  : API call in flight against the open-PR endpoint.
 *   - `found`    : an open PR exists for the current branch.
 *   - `none`     : no open PR — the URL is the branch-overview fallback.
 *   - `fallback` : credentials missing or request failed; URL falls back to
 *                  the URL-builder branch URL with the button still clickable.
 */
type PrProbe = 'idle' | 'loading' | 'found' | 'none' | 'fallback';

/**
 * Host → webview state push. The webview is purely render-and-postMessage; all
 * URL resolution and todo merging happens on the host side so the iframe never
 * holds raw remote URLs, secrets, or workspaceState mutations.
 *
 * Each push carries a monotonically-increasing `generation` — the webview
 * ignores any message with a generation lower than the most-recently-rendered
 * one so a late-arriving API response from a previous refresh never overwrites
 * a fresh state.
 */
interface StateMessage {
  type: 'state';
  generation: number;
  /** When true, render the "no ticket on this branch" empty state. */
  empty: boolean;
  /** When true, render the "widget disabled" minimal placeholder. */
  disabled: boolean;
  ticketId: string;
  summary: string | null;
  status: string | null;
  ticketProbe: TicketProbe;
  prProbe: PrProbe;
  ticketUrl: string | null;
  prUrl: string | null;
  /** Whether to show the PR button at all (driven by `widgetShowsPrButton`). */
  showPrButton: boolean;
  todos: TicketTodo[];
  /** Sanitised error message for the most recent probe failure, if any. */
  errorMessage: string | null;
}

/** Webview → host messages. */
type WebviewMessage =
  | { type: 'toggle-todo'; todoId: string }
  | { type: 'add-manual-todo'; text: string }
  | { type: 'remove-todo'; todoId: string }
  | { type: 'refresh' }
  | { type: 'open-ticket' }
  | { type: 'open-pr' };

/**
 * Renders a per-ticket panel inside the Source Control container. Surfaces the
 * active ticket's summary + status, a button to
 * open the Jira ticket, an optional button to open the associated Bitbucket
 * PR, and a TODO list seeded from the ticket's acceptance-criteria section
 * (when `parseAcAsTodo` is on) and editable with user-added manual items.
 *
 * State resolution is **streaming**: the synchronous derivation of the
 * branch-bound ticket id + stored todos is posted immediately so the webview renders
 * without waiting for network I/O, and live API probes (ticket details, PR
 * lookup) are spawned in parallel and pushed as follow-up state messages.
 *
 * Visibility is gated upstream by a context key + when-clause (set by SWE-5's
 * `extension.ts` wiring). If the provider is asked to resolve while the
 * `showWidget` setting is off — defence in depth — we render a minimal
 * "Widget disabled" placeholder.
 */
export class TicketWidgetProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  /**
   * Subscriptions that live only for the lifetime of a resolved view. Disposed
   * via the view's `onDidDispose` handler so we never leak Git-extension or
   * todo-store listeners after the user collapses the SCM container.
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
   *   from workspaceState under `ghola.moduleSettings`.
   * @param moduleSettingsEvent Event fired by the host whenever
   *   `ghola.moduleSettings` is rewritten. We re-pull config and refresh.
   * @param moduleEnabledEvent Loader event fired when modules are toggled.
   *   We refresh because enabling/disabling the ticket-work module flips
   *   what defaults apply.
   * @param bridge AtlassianBridge — supplies API tokens, validation state,
   *   and a change event so the widget refreshes after the user sets / clears
   *   a token or re-validates.
   * @param readModeSetting Setting reader closure threaded in by the host.
   *   The closure receives a bare key (e.g. `'showWidget'`) and is expected to
   *   read the value from `mode.ticket-work::<key>` in the flat settings dict
   *   (or fall back to the manifest default). The active ticket key is NOT a
   *   setting — it is derived from the current git branch.
   * @param todosStore Workspace-state-backed TODO storage manager.
   */
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly moduleSettingsEvent: vscode.Event<void>,
    private readonly moduleEnabledEvent: vscode.Event<unknown>,
    private readonly bridge: AtlassianBridge,
    private readonly readModeSetting: (key: string) => unknown,
    private readonly todosStore: TicketTodosStoreManager,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    };
    webviewView.webview.html = this.renderHtml(webviewView.webview);

    const messageSub = webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      void this.handle(msg);
    });
    this.viewDisposables.push(messageSub);

    // React to module-settings changes (e.g. user toggles the PR button).
    const settingsSub = this.moduleSettingsEvent(() => this.pushState());
    this.viewDisposables.push(settingsSub);

    // React to module enable/disable events from the loader.
    const enabledSub = this.moduleEnabledEvent(() => this.pushState());
    this.viewDisposables.push(enabledSub);

    // React to Atlassian validation changes (token set / cleared / refresh).
    const validationSub = this.bridge.onDidChangeValidation(() => this.pushState());
    this.viewDisposables.push(validationSub);

    // React to todo-store mutations. Filter to changes for the *current* ticket
    // so a write to an unrelated ticket id does not trigger a refresh storm.
    const todosSub = this.todosStore.onDidChange((evt) => {
      const currentId = this.currentTicketId();
      if (evt.ticketId === currentId) this.pushState();
    });
    this.viewDisposables.push(todosSub);

    // Wire Git-extension listeners — branch changes can affect the PR probe.
    this.wireGitListeners();

    // Wire visibility changes so the panel re-renders if the user collapses
    // and reopens it without otherwise changing state.
    const visibilitySub = webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.pushState();
    });
    this.viewDisposables.push(visibilitySub);

    // Initial state push happens after a microtask delay so the webview's
    // message listener has a chance to attach before we post.
    queueMicrotask(() => this.pushState());

    webviewView.onDidDispose(() => {
      this.disposeViewSubscriptions();
      this.view = undefined;
    });
  }

  // ─── Git extension wiring ──────────────────────────────────────────────

  private wireGitListeners(): void {
    const gitExt = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!gitExt) {
      // Git extension unavailable — widget still renders, just without the PR
      // probe (we cannot detect the branch name).
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

    // ── Synchronous read of module config + stored todos ──
    const showWidget = this.readBooleanSetting('showWidget', true);
    const parseAcAsTodo = this.readBooleanSetting('parseAcAsTodo', true);
    const widgetShowsPrButton = this.readBooleanSetting('widgetShowsPrButton', true);
    const acSectionMarker = this.readStringSetting('acSectionMarker', 'Acceptance Criteria');
    // The active ticket is derived from the current git branch — read the git
    // state once here and reuse it for both the ticket key and the PR probe.
    const { branch, remoteUrl } = this.readGitState();
    const ticketId = this.deriveTicketFromBranch(branch);

    // Defence in depth — the visibility context key normally hides us when
    // showWidget is off, but if we get resolved anyway render a minimal
    // placeholder rather than a fully-wired widget.
    if (!showWidget) {
      this.post({
        type: 'state',
        generation: gen,
        empty: false,
        disabled: true,
        ticketId: '',
        summary: null,
        status: null,
        ticketProbe: 'idle',
        prProbe: 'idle',
        ticketUrl: null,
        prUrl: null,
        showPrButton: false,
        todos: [],
        errorMessage: null,
      });
      return;
    }

    // No ticket key on the current branch — render the empty state and stop.
    // Async probes are pointless without a ticket key.
    if (!ticketId) {
      this.post({
        type: 'state',
        generation: gen,
        empty: true,
        disabled: false,
        ticketId: '',
        summary: null,
        status: null,
        ticketProbe: 'idle',
        prProbe: 'idle',
        ticketUrl: null,
        prUrl: null,
        showPrButton: widgetShowsPrButton,
        todos: [],
        errorMessage: null,
      });
      return;
    }

    // Pull Atlassian-suite settings for URL construction.
    const jiraBase = this.readAtlassianStringSetting('jiraBase', 'https://herzog.atlassian.net');
    const fallbackWorkspace = this.readAtlassianStringSetting('bitbucketWorkspace', '');
    const email = this.readAtlassianStringSetting('email', '');

    const ticketUrl = buildTicketUrl(ticketId, jiraBase);
    const repoSlug = extractBitbucketRepoSlug(remoteUrl);
    const workspaceFromRemote = extractBitbucketWorkspace(remoteUrl);
    const workspace = workspaceFromRemote || fallbackWorkspace;
    const fallbackBranchUrl = buildBitbucketBranchUrl(remoteUrl, branch, fallbackWorkspace);

    // Initial probe statuses — anything we cannot run becomes `idle`.
    const ticketProbe: TicketProbe = 'loading';
    const prProbe: PrProbe =
      widgetShowsPrButton && branch && repoSlug ? 'loading' : 'idle';

    const todos = this.todosStore.getTodosForTicket(ticketId);

    // Synchronous initial post — webview renders the todo list and URL stubs
    // instantly while the probes resolve in the background.
    this.post({
      type: 'state',
      generation: gen,
      empty: false,
      disabled: false,
      ticketId,
      summary: null,
      status: null,
      ticketProbe,
      prProbe,
      ticketUrl,
      prUrl: fallbackBranchUrl,
      showPrButton: widgetShowsPrButton,
      todos,
      errorMessage: null,
    });

    // Async follow-up: token resolution + probes.
    void this.runProbes({
      gen,
      ticketId,
      ticketUrl,
      branch,
      repoSlug,
      workspace,
      jiraBase,
      email,
      parseAcAsTodo,
      acSectionMarker,
      widgetShowsPrButton,
      fallbackBranchUrl,
    });
  }

  /**
   * Async follow-up half of `pushState`. Resolves tokens, runs the live
   * probes, and posts follow-up state messages as each probe resolves. All
   * paths check `gen === this.activeGen` before posting so a late probe from
   * a stale generation is silently dropped.
   */
  private async runProbes(args: {
    gen: number;
    ticketId: string;
    ticketUrl: string | null;
    branch: string | null;
    repoSlug: string | null;
    workspace: string;
    jiraBase: string;
    email: string;
    parseAcAsTodo: boolean;
    acSectionMarker: string;
    widgetShowsPrButton: boolean;
    fallbackBranchUrl: string | null;
  }): Promise<void> {
    const {
      gen,
      ticketId,
      ticketUrl,
      branch,
      repoSlug,
      workspace,
      jiraBase,
      email,
      parseAcAsTodo,
      acSectionMarker,
      widgetShowsPrButton,
      fallbackBranchUrl,
    } = args;

    // Resolve both product tokens in parallel — they live under separate
    // SecretStorage keys and either may be undefined.
    const [jiraToken, bitbucketToken] = await Promise.all([
      this.bridge.getJiraToken(),
      this.bridge.getBitbucketToken(),
    ]);

    // Local state tracked across both probes so each post carries the latest
    // values for the OTHER probe (not just its own).
    let ticketProbe: TicketProbe = 'loading';
    let prProbe: PrProbe = widgetShowsPrButton && branch && repoSlug ? 'loading' : 'idle';
    let summary: string | null = null;
    let status: string | null = null;
    let prUrl: string | null = fallbackBranchUrl;
    let errorMessage: string | null = null;

    const canProbeTicket = Boolean(email && jiraToken && jiraBase && ticketId);
    const canProbePr =
      widgetShowsPrButton &&
      Boolean(email && bitbucketToken && workspace && repoSlug && branch);

    // Helper: snapshot the current state into a `StateMessage`. The latest
    // todos are read at snapshot time so AC-extract merges (which fire the
    // todo-store's onDidChange in a separate event loop turn) are reflected.
    const snapshot = (): StateMessage => ({
      type: 'state',
      generation: gen,
      empty: false,
      disabled: false,
      ticketId,
      summary,
      status,
      ticketProbe,
      prProbe,
      ticketUrl,
      prUrl,
      showPrButton: widgetShowsPrButton,
      todos: this.todosStore.getTodosForTicket(ticketId),
      errorMessage,
    });

    // If no probes can run, post the fallback state once so the UI clears the
    // initial `loading` markers and does not get stuck on a spinner.
    if (!canProbeTicket) ticketProbe = 'fallback';
    if (!canProbePr && widgetShowsPrButton && branch && repoSlug) prProbe = 'fallback';

    if (!canProbeTicket && !canProbePr) {
      if (gen === this.activeGen) this.post(snapshot());
      return;
    }

    // Build a single client. Both probes share the instance but each method
    // checks its own product-specific token before firing.
    const client = new AtlassianClient({
      email,
      jiraToken,
      bitbucketToken,
      jiraBase,
      bitbucketWorkspace: workspace,
    });

    // Post an intermediate state if one probe was downgraded to fallback while
    // the other still runs — without this the dead leg's loading marker would
    // never clear until the other probe finished.
    if (
      (!canProbeTicket && ticketProbe === 'fallback') ||
      (!canProbePr && prProbe === 'fallback')
    ) {
      if (gen === this.activeGen) this.post(snapshot());
    }

    const probes: Promise<void>[] = [];

    if (canProbeTicket) {
      probes.push(
        client
          .getTicketDetails(ticketId)
          .then(async (result) => {
            if (!result.exists) {
              ticketProbe = result.error ? 'fallback' : 'missing';
              if (result.error) errorMessage = result.error;
            } else {
              ticketProbe = 'ok';
              summary = result.summary ?? null;
              status = result.status ?? null;
              // If AC parsing is on and we have a description, extract +
              // merge. The merge fires `onDidChange` which triggers our own
              // listener and a fresh `pushState()` — but we only honour the
              // refresh if THIS generation is still active.
              if (parseAcAsTodo && result.description !== undefined) {
                try {
                  const extract = adfExtractAcceptanceCriteria(
                    result.description,
                    acSectionMarker,
                  );
                  if (extract.items.length > 0) {
                    await this.todosStore.mergeAcExtract(ticketId, extract.items);
                  }
                } catch {
                  // Extraction is best-effort — a malformed ADF tree never
                  // breaks the rest of the widget. The todos-store path is
                  // the only place we could leak (it never throws either).
                }
              }
            }
            if (gen === this.activeGen) this.post(snapshot());
          })
          .catch(() => {
            // `getTicketDetails` already swallows its own errors, but
            // belt-and-braces: collapse to fallback rather than getting stuck.
            ticketProbe = 'fallback';
            if (gen === this.activeGen) this.post(snapshot());
          }),
      );
    }

    if (canProbePr && repoSlug && branch) {
      probes.push(
        client
          .findOpenPrForBranch(repoSlug, branch)
          .then((result) => {
            if (result.prUrl) {
              prProbe = 'found';
              prUrl = result.prUrl;
            } else {
              prProbe = 'none';
              prUrl = fallbackBranchUrl;
            }
            if (gen === this.activeGen) this.post(snapshot());
          })
          .catch(() => {
            prProbe = 'fallback';
            prUrl = fallbackBranchUrl;
            if (gen === this.activeGen) this.post(snapshot());
          }),
      );
    }

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

  // ─── Setting readers ───────────────────────────────────────────────────

  /**
   * Read a value from the host-supplied `readModeSetting` closure, which is
   * scoped to the `mode.ticket-work` module's settings. Returns the raw
   * `unknown` value; callers narrow.
   */
  private readModeRaw(key: string): unknown {
    try {
      return this.readModeSetting(key);
    } catch {
      // Closure errors collapse to "undefined" — the caller's default applies.
      return undefined;
    }
  }

  private readBooleanSetting(key: string, defaultValue: boolean): boolean {
    const v = this.readModeRaw(key);
    if (typeof v === 'boolean') return v;
    return defaultValue;
  }

  private readStringSetting(key: string, defaultValue: string): string {
    const v = this.readModeRaw(key);
    if (typeof v === 'string' && v.trim() !== '') return v;
    return defaultValue;
  }

  /**
   * Derive the active Jira ticket key from a git branch name. Mirrors the
   * agent's branch-detection regex: strip a leading workflow prefix
   * (`feature/`, `bugfix/`, `hotfix/`, `release/`), take the last `/` path
   * segment, and match `^([A-Za-z]+)-([0-9]+)`. On a match compose
   * `UPPERCASEKEY-NUMBER` (e.g. `feature/cmms-2791-x` -> `CMMS-2791`). Returns
   * an empty string when there is no match (on `main`, a detached HEAD, or a
   * branch with no `PROJ-1234` segment).
   */
  private deriveTicketFromBranch(branch: string | null): string {
    if (!branch) return '';
    const stripped = branch.replace(/^(feature|bugfix|hotfix|release)\//i, '');
    const segments = stripped.split('/');
    const last = segments[segments.length - 1] ?? stripped;
    const match = last.match(/^([A-Za-z]+)-([0-9]+)/);
    if (!match) return '';
    return `${match[1].toUpperCase()}-${match[2]}`;
  }

  /**
   * The active ticket key for the widget, derived from the current git branch.
   * Returns an empty string when the branch yields no ticket key. This is the
   * single source of truth for "which ticket is bound" — the ticket id is no
   * longer a configurable setting.
   */
  private currentTicketId(): string {
    return this.deriveTicketFromBranch(this.readGitState().branch);
  }

  /**
   * Read a string field off the `integration.atlassian-suite` module's
   * persisted settings. Mirrors the flat `moduleId::fieldKey` shape that the
   * settings panel writes; `defaultValue` is returned when the key is absent
   * or the stored value is the empty string.
   */
  private readAtlassianStringSetting(fieldKey: string, defaultValue: string): string {
    const flat = this.context.workspaceState.get<Record<string, unknown>>(
      WORKSPACE_STATE_KEYS.MODULE_SETTINGS,
      {},
    );
    const v = flat[`${ATLASSIAN_MODULE_ID}::${fieldKey}`];
    if (typeof v === 'string' && v !== '') return v;
    return defaultValue;
  }

  private readGitState(): { branch: string | null; remoteUrl: string | null } {
    const gitExt = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!gitExt || !gitExt.isActive) {
      return { branch: null, remoteUrl: null };
    }
    try {
      const api = gitExt.exports.getAPI(1);
      const repo = api.repositories[0];
      if (!repo) return { branch: null, remoteUrl: null };
      const branch = repo.state.HEAD?.name ?? null;
      const origin = repo.state.remotes.find((r) => r.name === 'origin');
      const remoteUrl = origin?.fetchUrl ?? origin?.pushUrl ?? null;
      return { branch, remoteUrl };
    } catch {
      return { branch: null, remoteUrl: null };
    }
  }

  // ─── Message handling ──────────────────────────────────────────────────

  private async handle(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'toggle-todo': {
        const ticketId = this.currentTicketId();
        if (!ticketId) break;
        // The store fires onDidChange which triggers our own listener and a
        // refresh push, so we do not call pushState() here.
        await this.todosStore.toggleDone(ticketId, msg.todoId);
        break;
      }
      case 'add-manual-todo': {
        const ticketId = this.currentTicketId();
        if (!ticketId) break;
        const trimmed = typeof msg.text === 'string' ? msg.text.trim() : '';
        if (!trimmed) break;
        await this.todosStore.addManualTodo(ticketId, trimmed);
        break;
      }
      case 'remove-todo': {
        const ticketId = this.currentTicketId();
        if (!ticketId) break;
        await this.todosStore.removeTodo(ticketId, msg.todoId);
        break;
      }
      case 'refresh':
        this.pushState();
        break;
      case 'open-ticket': {
        const ticketId = this.currentTicketId();
        if (!ticketId) break;
        const jiraBase = this.readAtlassianStringSetting(
          'jiraBase',
          'https://herzog.atlassian.net',
        );
        const url = buildTicketUrl(ticketId, jiraBase);
        if (url) await this.openInSimpleBrowser(url);
        break;
      }
      case 'open-pr': {
        // Re-derive the PR URL on click. The live PR URL only lives in the
        // most-recent state push to the webview, so we either re-run the
        // probe synchronously here (expensive) or fall back to the branch
        // URL via the URL-builder fallback.
        const fallbackWorkspace = this.readAtlassianStringSetting('bitbucketWorkspace', '');
        const { branch, remoteUrl } = this.readGitState();
        const branchUrl = buildBitbucketBranchUrl(remoteUrl, branch, fallbackWorkspace);
        if (branchUrl) await this.openInSimpleBrowser(branchUrl);
        break;
      }
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
    <title>Ghola Ticket Widget</title>
    <style>
      body {
        padding: 8px 12px;
        font-family: var(--vscode-font-family);
        font-size: 12px;
        color: var(--vscode-foreground);
      }
      .ticket-widget { display: flex; flex-direction: column; gap: 6px; }
      .row { display: flex; align-items: center; gap: 6px; }
      .label {
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .ticket-key {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 13px;
        font-weight: 600;
        color: var(--vscode-textLink-foreground);
      }
      .summary {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
      }
      .summary.placeholder { color: var(--vscode-descriptionForeground); font-style: italic; }
      .status-line {
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
      }
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
      #refreshBtn { flex: 0 0 auto; min-width: 28px; }
      .divider {
        border-top: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border));
        margin: 4px 0;
      }
      .todos-header {
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin-bottom: 2px;
      }
      .todos { display: flex; flex-direction: column; gap: 2px; }
      .todo-item {
        display: flex;
        align-items: flex-start;
        gap: 6px;
        font-size: 12px;
        line-height: 1.4;
      }
      .todo-item input[type="checkbox"] {
        margin: 2px 0 0 0;
        flex: 0 0 auto;
      }
      .todo-item .todo-text {
        flex: 1 1 auto;
        word-wrap: break-word;
        overflow-wrap: anywhere;
      }
      .todo-item.done .todo-text {
        text-decoration: line-through;
        color: var(--vscode-descriptionForeground);
      }
      .todo-item .remove-btn {
        flex: 0 0 auto;
        background: transparent;
        color: var(--vscode-descriptionForeground);
        border: none;
        font-size: 14px;
        padding: 0 4px;
        cursor: pointer;
        min-width: 16px;
      }
      .todo-item .remove-btn:hover { color: var(--vscode-errorForeground); }
      .empty-message {
        color: var(--vscode-descriptionForeground);
        font-style: italic;
        font-size: 12px;
        padding: 4px 0;
      }
      .empty-todos {
        color: var(--vscode-descriptionForeground);
        font-style: italic;
        font-size: 11px;
        padding: 2px 0;
      }
      .error-line {
        color: var(--vscode-errorForeground);
        font-size: 11px;
        margin-top: 2px;
      }
      .add-row { display: flex; gap: 4px; margin-top: 4px; }
      .add-row input[type="text"] {
        flex: 1 1 auto;
        font-size: 12px;
        padding: 3px 6px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent);
        border-radius: 2px;
      }
      .add-row input[type="text"]:focus {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: -1px;
      }
      .add-trigger-btn {
        font-size: 12px;
        padding: 3px 8px;
        background: transparent;
        color: var(--vscode-textLink-foreground);
        border: 1px dashed var(--vscode-panel-border, var(--vscode-editorWidget-border));
        border-radius: 2px;
        cursor: pointer;
        width: 100%;
        margin-top: 4px;
      }
      .add-trigger-btn:hover {
        background: var(--vscode-list-hoverBackground);
      }
      [hidden] { display: none !important; }
    </style>
  </head>
  <body>
    <div class="ticket-widget">
      <div id="disabledMessage" class="empty-message" hidden>Widget disabled.</div>
      <div id="emptyMessage" class="empty-message" hidden>
        No ticket on this branch. Checkout a branch like feature/CMMS-1234-… to bind a ticket.
      </div>
      <div id="mainContent" hidden>
        <div class="row">
          <span class="label">Ticket:</span>
          <span class="ticket-key" id="ticketKey">—</span>
        </div>
        <div class="summary placeholder" id="summary">No summary loaded yet.</div>
        <div class="status-line" id="statusLine"></div>
        <div class="error-line" id="errorLine" hidden></div>
        <div class="buttons">
          <button id="ticketBtn" disabled>Ticket</button>
          <button id="prBtn" disabled>PR</button>
          <button id="refreshBtn" aria-label="Refresh ticket state" title="Refresh">↻</button>
        </div>
        <div class="divider"></div>
        <div class="todos-header">Acceptance Criteria</div>
        <div class="todos" id="todos"></div>
        <div class="empty-todos" id="emptyTodos" hidden>No items yet.</div>
        <button id="addTriggerBtn" class="add-trigger-btn" type="button">+ Add item</button>
        <div id="addRow" class="add-row" hidden>
          <input id="addInput" type="text" placeholder="Describe the item…" maxlength="500" />
          <button id="addSaveBtn" type="button">Add</button>
          <button id="addCancelBtn" type="button">Cancel</button>
        </div>
      </div>
    </div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();

      // ── Element handles ──
      const disabledMessage = document.getElementById('disabledMessage');
      const emptyMessage = document.getElementById('emptyMessage');
      const mainContent = document.getElementById('mainContent');
      const ticketKeyEl = document.getElementById('ticketKey');
      const summaryEl = document.getElementById('summary');
      const statusLineEl = document.getElementById('statusLine');
      const errorLineEl = document.getElementById('errorLine');
      const ticketBtn = document.getElementById('ticketBtn');
      const prBtn = document.getElementById('prBtn');
      const refreshBtn = document.getElementById('refreshBtn');
      const todosEl = document.getElementById('todos');
      const emptyTodosEl = document.getElementById('emptyTodos');
      const addTriggerBtn = document.getElementById('addTriggerBtn');
      const addRow = document.getElementById('addRow');
      const addInput = document.getElementById('addInput');
      const addSaveBtn = document.getElementById('addSaveBtn');
      const addCancelBtn = document.getElementById('addCancelBtn');

      // Track the highest generation rendered so far. Defensive: the host
      // already drops stale messages before postMessage, but a race during
      // very fast refreshes could still surface an older message — ignore it.
      let lastGen = -1;

      // ── Static event handlers ──
      ticketBtn.addEventListener('click', () => vscode.postMessage({ type: 'open-ticket' }));
      prBtn.addEventListener('click', () => vscode.postMessage({ type: 'open-pr' }));
      refreshBtn.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

      function openAddRow() {
        addTriggerBtn.hidden = true;
        addRow.hidden = false;
        addInput.value = '';
        addInput.focus();
      }
      function closeAddRow() {
        addTriggerBtn.hidden = false;
        addRow.hidden = true;
        addInput.value = '';
      }
      function submitAddRow() {
        const text = (addInput.value || '').trim();
        if (!text) {
          closeAddRow();
          return;
        }
        vscode.postMessage({ type: 'add-manual-todo', text });
        closeAddRow();
      }
      addTriggerBtn.addEventListener('click', openAddRow);
      addCancelBtn.addEventListener('click', closeAddRow);
      addSaveBtn.addEventListener('click', submitAddRow);
      addInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submitAddRow();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closeAddRow();
        }
      });

      // ── State application ──
      function renderTodos(todos) {
        // Remove all existing children (defensive — we re-build from scratch
        // each render so the DOM and todo-id set stay in sync).
        while (todosEl.firstChild) todosEl.removeChild(todosEl.firstChild);
        if (!Array.isArray(todos) || todos.length === 0) {
          emptyTodosEl.hidden = false;
          return;
        }
        emptyTodosEl.hidden = true;
        for (const todo of todos) {
          if (!todo || typeof todo.id !== 'string') continue;
          const row = document.createElement('div');
          row.className = 'todo-item' + (todo.done ? ' done' : '');
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = Boolean(todo.done);
          cb.setAttribute('aria-label', 'Toggle todo');
          cb.addEventListener('change', () => {
            vscode.postMessage({ type: 'toggle-todo', todoId: todo.id });
          });
          const text = document.createElement('span');
          text.className = 'todo-text';
          text.textContent = typeof todo.text === 'string' ? todo.text : '';
          row.appendChild(cb);
          row.appendChild(text);
          if (todo.source === 'manual') {
            const remove = document.createElement('button');
            remove.className = 'remove-btn';
            remove.type = 'button';
            remove.title = 'Remove item';
            remove.setAttribute('aria-label', 'Remove item');
            remove.textContent = '×';
            remove.addEventListener('click', () => {
              vscode.postMessage({ type: 'remove-todo', todoId: todo.id });
            });
            row.appendChild(remove);
          }
          todosEl.appendChild(row);
        }
      }

      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg || msg.type !== 'state') return;
        if (typeof msg.generation === 'number' && msg.generation < lastGen) return;
        if (typeof msg.generation === 'number') lastGen = msg.generation;

        // Top-level visibility branches.
        if (msg.disabled) {
          disabledMessage.hidden = false;
          emptyMessage.hidden = true;
          mainContent.hidden = true;
          return;
        }
        if (msg.empty) {
          disabledMessage.hidden = true;
          emptyMessage.hidden = false;
          mainContent.hidden = true;
          return;
        }
        disabledMessage.hidden = true;
        emptyMessage.hidden = true;
        mainContent.hidden = false;

        // Ticket id + summary.
        ticketKeyEl.textContent = msg.ticketId || '—';
        if (msg.summary) {
          summaryEl.textContent = msg.summary;
          summaryEl.classList.remove('placeholder');
        } else if (msg.ticketProbe === 'loading') {
          summaryEl.textContent = 'Loading…';
          summaryEl.classList.add('placeholder');
        } else if (msg.ticketProbe === 'missing') {
          summaryEl.textContent = 'Ticket not found in Jira.';
          summaryEl.classList.add('placeholder');
        } else if (msg.ticketProbe === 'fallback') {
          summaryEl.textContent = 'Summary unavailable (offline / unauthenticated).';
          summaryEl.classList.add('placeholder');
        } else {
          summaryEl.textContent = '';
          summaryEl.classList.add('placeholder');
        }

        // Status line.
        if (msg.status) {
          statusLineEl.textContent = 'Status: ' + msg.status;
          statusLineEl.hidden = false;
        } else {
          statusLineEl.textContent = '';
          statusLineEl.hidden = true;
        }

        // Error line — only shown when an error message accompanies a probe.
        if (msg.errorMessage) {
          errorLineEl.textContent = msg.errorMessage;
          errorLineEl.hidden = false;
        } else {
          errorLineEl.textContent = '';
          errorLineEl.hidden = true;
        }

        // Ticket button.
        const ticketLoading = msg.ticketProbe === 'loading';
        ticketBtn.textContent = ticketLoading ? 'Ticket …' : 'Ticket';
        ticketBtn.disabled = !msg.ticketUrl || ticketLoading;
        ticketBtn.title =
          msg.ticketProbe === 'ok' ? 'Open ticket in Jira'
          : msg.ticketProbe === 'missing' ? 'Ticket not found — open URL anyway'
          : msg.ticketProbe === 'fallback' ? 'Open ticket URL (unverified)'
          : '';

        // PR button — visibility toggled by showPrButton.
        if (msg.showPrButton) {
          prBtn.hidden = false;
          const prLoading = msg.prProbe === 'loading';
          prBtn.textContent =
            prLoading ? 'PR …'
            : msg.prProbe === 'found' ? 'PR'
            : msg.prProbe === 'none' ? 'Branch'
            : 'PR';
          prBtn.disabled = !msg.prUrl || prLoading || msg.prProbe === 'idle';
          prBtn.title =
            msg.prProbe === 'found' ? 'Open the pull request'
            : msg.prProbe === 'none' ? 'No open PR — open the branch in Bitbucket'
            : msg.prProbe === 'fallback' ? 'Open branch URL (unverified)'
            : '';
        } else {
          prBtn.hidden = true;
        }

        refreshBtn.disabled = false;

        // Todos.
        renderTodos(msg.todos);
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
