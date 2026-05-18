import * as vscode from 'vscode';
import {
  buildBitbucketBranchUrl,
  buildTicketUrl,
  extractTicketKey,
} from './url-builder';

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
 * Host → webview state push. The webview is purely render-and-postMessage; all
 * URL resolution happens on the host side so the iframe never holds raw
 * remote URLs or config values it does not need.
 */
interface StateMessage {
  type: 'state';
  enabled: boolean;
  branch: string | null;
  ticketKey: string | null;
  ticketUrl: string | null;
  branchUrl: string | null;
  /** Total number of Git repositories in the workspace. 1 in the common case. */
  repoCount: number;
}

/** Webview → host messages. */
type WebviewMessage =
  | { type: 'openTicket' }
  | { type: 'openBranch' }
  | { type: 'openSettings' };

/**
 * Renders a small panel inside the Source Control container that surfaces the
 * current branch's Jira ticket key and one-click links to the Jira ticket and
 * the Bitbucket branch/PR page. Gated by `nomeda.branchWidget.enabled`.
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

  constructor(_context: vscode.ExtensionContext) {
    // Context is accepted for future extension (e.g. localResourceRoots, state
    // persistence) but the current implementation only needs config + globals.
  }

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

    // React to config changes for any nomeda.branchWidget.* key.
    const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('nomeda.branchWidget')) {
        this.pushState();
      }
    });
    this.viewDisposables.push(configSub);

    // Wire Git-extension listeners. Wrapped because the extension may not be
    // available in environments without the built-in Git provider.
    this.wireGitListeners();

    // Initial state push happens after the webview ready handshake fires from
    // the inline script; the script posts no message, so push immediately too.
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

  // ─── State resolution + push ───────────────────────────────────────────

  private pushState(): void {
    if (!this.view) return;
    const state = this.resolveState();
    void this.view.webview.postMessage(state);
  }

  private resolveState(): StateMessage {
    const cfg = vscode.workspace.getConfiguration('nomeda.branchWidget');
    const enabled = cfg.get<boolean>('enabled', false);
    const jiraBase = cfg.get<string>('jiraBase', 'https://herzog.atlassian.net');
    const fallbackWorkspace = cfg.get<string>('bitbucketWorkspace', '');

    const { branch, remoteUrl, repoCount } = this.readGitState();
    const ticketKey = extractTicketKey(branch);
    const ticketUrl = buildTicketUrl(ticketKey, jiraBase);
    const branchUrl = buildBitbucketBranchUrl(remoteUrl, branch, fallbackWorkspace);

    return { type: 'state', enabled, branch, ticketKey, ticketUrl, branchUrl, repoCount };
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
        const { ticketUrl } = this.resolveState();
        if (ticketUrl) await this.openInSimpleBrowser(ticketUrl);
        break;
      }
      case 'openBranch': {
        const { branchUrl } = this.resolveState();
        if (branchUrl) await this.openInSimpleBrowser(branchUrl);
        break;
      }
      case 'openSettings':
        await vscode.commands.executeCommand('nomeda.openSettings');
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
      .repo-count {
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        margin-left: auto;
        white-space: nowrap;
      }
      .disabled-state {
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
        line-height: 1.4;
      }
      .disabled-state a { color: var(--vscode-textLink-foreground); cursor: pointer; }
      .disabled-state a:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
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
        </div>
      </div>
      <div class="disabled-state" id="disabledState" hidden>
        Branch Widget is disabled. <a id="openSettings">Open Settings</a>
      </div>
    </div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const branchEl = document.getElementById('branch');
      const keyEl = document.getElementById('key');
      const ticketBtn = document.getElementById('ticket');
      const branchBtn = document.getElementById('branchBtn');
      const enabledContent = document.getElementById('enabledContent');
      const disabledState = document.getElementById('disabledState');
      const openSettings = document.getElementById('openSettings');
      const repoCountEl = document.getElementById('repoCount');

      ticketBtn.addEventListener('click', () => vscode.postMessage({ type: 'openTicket' }));
      branchBtn.addEventListener('click', () => vscode.postMessage({ type: 'openBranch' }));
      openSettings.addEventListener('click', (e) => {
        e.preventDefault();
        vscode.postMessage({ type: 'openSettings' });
      });

      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg || msg.type !== 'state') return;
        if (!msg.enabled) {
          enabledContent.hidden = true;
          disabledState.hidden = false;
          return;
        }
        enabledContent.hidden = false;
        disabledState.hidden = true;

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
        ticketBtn.disabled = !msg.ticketUrl;
        branchBtn.disabled = !msg.branchUrl;
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
