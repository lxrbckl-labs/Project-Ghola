import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ModuleLoader } from '../modules/loader';
import type { PromptComposer } from '../prompts/composer';
import type { StateWatcher, SessionState } from '../state/watcher';
import type {
  AgentStatusSummary,
  HostToWebviewMessage,
  ModuleSummary,
  WebviewToHostMessage,
} from './protocol';

const SETTINGS_KEY = 'nomeda.moduleSettings';

export class SettingsPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly loader: ModuleLoader,
    private readonly composer: PromptComposer,
    private readonly state: StateWatcher,
    private readonly logger?: vscode.OutputChannel,
  ) {
    this.disposables.push(
      this.loader.onDidChange(() => this.postModules()),
      this.state.onDidChange((s) => this.postAgentState(s)),
    );
  }

  open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'nomedaSettings',
      'Nomeda Settings',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
      },
    );

    this.panel.onDidDispose(
      () => {
        this.panel = undefined;
      },
      null,
      this.disposables,
    );

    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewToHostMessage) => this.handle(msg),
      null,
      this.disposables,
    );

    void this.renderHtml();
  }

  private async renderHtml(): Promise<void> {
    if (!this.panel) return;
    const webview = this.panel.webview;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'),
    );
    const nonce = this.makeNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
    ].join('; ');

    this.panel.webview.html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <title>Nomeda Settings</title>
    <style>${await this.loadStyles()}</style>
  </head>
  <body>
    <div id="app"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }

  private async loadStyles(): Promise<string> {
    // Inlined for CSP simplicity. esbuild copies styles.css into dist/ at build time.
    const stylesPath = path.join(this.context.extensionPath, 'dist', 'styles.css');
    try {
      return await fs.readFile(stylesPath, 'utf-8');
    } catch {
      return '';
    }
  }

  private async handle(msg: WebviewToHostMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
      case 'getModules':
        await this.postModules();
        break;
      case 'toggleModule':
        if (msg.enabled) await this.loader.enable(msg.id);
        else await this.loader.disable(msg.id);
        await this.postModules();
        break;
      case 'getSettings':
        this.postSettings();
        break;
      case 'saveSettings':
        await this.saveSettings(msg.values);
        break;
      case 'getComposedPrompt':
        await this.postComposedPrompt(msg.agent);
        break;
      case 'reloadModules':
        await vscode.commands.executeCommand('nomeda.reloadModules');
        break;
      case 'openSession':
        await vscode.commands.executeCommand('nomeda.openSession');
        break;
      default:
        this.logger?.appendLine(`[panel] unknown message: ${JSON.stringify(msg)}`);
    }
  }

  private async postModules(): Promise<void> {
    if (!this.panel) return;
    const modules: ModuleSummary[] = this.loader.getAll().map((h) => ({
      id: h.manifest.id,
      name: h.manifest.name,
      version: h.manifest.version,
      description: h.manifest.description,
      enabled: h.isEnabled,
      contributes: h.manifest.contributes,
    }));
    this.post({ type: 'modulesChanged', modules });
  }

  private postSettings(): void {
    if (!this.panel) return;
    const values = this.context.workspaceState.get<Record<string, unknown>>(SETTINGS_KEY, {});
    this.post({ type: 'settingsLoaded', values });
  }

  private async saveSettings(values: Record<string, unknown>): Promise<void> {
    try {
      await this.context.workspaceState.update(SETTINGS_KEY, values);
      this.post({ type: 'settingsSaved', ok: true });
    } catch (err) {
      this.post({ type: 'settingsSaved', ok: false, error: (err as Error).message });
    }
  }

  private async postComposedPrompt(agent: string): Promise<void> {
    if (!this.panel) return;
    const prompt = await this.composer.compose(agent);
    this.post({ type: 'composedPromptUpdated', agent, prompt });
  }

  private postAgentState(state: SessionState): void {
    if (!this.panel) return;
    const agents: AgentStatusSummary[] = Object.entries(state.agents).map(([id, e]) => ({
      id,
      status: e.status,
      instance: e.instance,
      lastHeartbeat: e.last_heartbeat,
    }));
    this.post({ type: 'agentStateUpdated', agents });
  }

  private post(msg: HostToWebviewMessage): void {
    this.panel?.webview.postMessage(msg);
  }

  private makeNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
    return out;
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
