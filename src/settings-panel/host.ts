import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ModuleLoader } from '../modules/loader';
import type { PromptComposer } from '../prompts/composer';
import type {
  HostToWebviewMessage,
  ModuleSummary,
  PromptFragmentDetail,
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
    private readonly logger?: vscode.OutputChannel,
  ) {
    this.disposables.push(
      this.loader.onDidChange(() => this.postModules()),
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
        this.postComposedPrompt(msg.agent);
        break;
      case 'reloadModules':
        await vscode.commands.executeCommand('nomeda.reloadModules');
        break;
      case 'openSession':
        await vscode.commands.executeCommand('nomeda.openSession');
        break;
      case 'requestModuleDetail':
        await this.postModuleDetail(msg.moduleId);
        break;
      case 'updateConfiguration':
        await vscode.workspace
          .getConfiguration(msg.section)
          .update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
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
      proactive: h.manifest.proactive,
      structural: h.manifest.structural,
      contributes: h.manifest.contributes,
    }));
    this.post({ type: 'modulesChanged', modules });
  }

  /**
   * Read every prompt-fragment file for a module (resolved against its root)
   * and post their raw contents to the webview. For `core.preamble`, the
   * structural `preamble.md` (which is not a manifest-declared fragment) is
   * appended as a fabricated fragment entry so the detail view can render it.
   */
  private async postModuleDetail(moduleId: string): Promise<void> {
    if (!this.panel) return;
    const handle = this.loader.find(moduleId);
    if (!handle) return;

    const fragments: PromptFragmentDetail[] = [];
    const declared = handle.manifest.contributes?.promptFragments ?? [];
    const rootWithSep = handle.rootPath.endsWith(path.sep)
      ? handle.rootPath
      : handle.rootPath + path.sep;
    for (const frag of declared) {
      const abs = path.join(handle.rootPath, frag.contentPath);
      if (!abs.startsWith(rootWithSep) && abs !== handle.rootPath) {
        fragments.push({
          target: frag.target,
          contentPath: frag.contentPath,
          absolutePath: abs,
          content: '',
          error: 'contentPath escapes module root',
        });
        continue;
      }
      try {
        const content = await fs.readFile(abs, 'utf-8');
        fragments.push({
          target: frag.target,
          contentPath: frag.contentPath,
          absolutePath: abs,
          content,
        });
      } catch (e) {
        fragments.push({
          target: frag.target,
          contentPath: frag.contentPath,
          absolutePath: abs,
          content: '',
          error: (e as Error).message,
        });
      }
    }

    // Special case: surface the structural preamble.md for `core.preamble`.
    if (moduleId === 'core.preamble') {
      const abs = path.join(handle.rootPath, 'preamble.md');
      if (!abs.startsWith(rootWithSep) && abs !== handle.rootPath) {
        fragments.push({
          target: 'all',
          contentPath: 'preamble.md',
          absolutePath: abs,
          content: '',
          error: 'contentPath escapes module root',
        });
      } else {
        try {
          const content = await fs.readFile(abs, 'utf-8');
          fragments.push({
            target: 'all',
            contentPath: 'preamble.md',
            absolutePath: abs,
            content,
          });
        } catch (e) {
          fragments.push({
            target: 'all',
            contentPath: 'preamble.md',
            absolutePath: abs,
            content: '',
            error: (e as Error).message,
          });
        }
      }
    }

    this.post({ type: 'moduleDetail', moduleId, fragments });
  }

  private postSettings(): void {
    if (!this.panel) return;
    const values = this.context.workspaceState.get<Record<string, unknown>>(SETTINGS_KEY, {});
    const sessionCommand = vscode.workspace
      .getConfiguration('nomeda')
      .get<string>('sessionCommand', 'claude');
    this.post({ type: 'settingsLoaded', values, sessionCommand });
  }

  private async saveSettings(values: Record<string, unknown>): Promise<void> {
    try {
      await this.context.workspaceState.update(SETTINGS_KEY, values);
      this.post({ type: 'settingsSaved', ok: true });
      // Broadcast fresh composed prompts after settings change per architecture spec.
      this.broadcastComposedPrompts();
    } catch (err) {
      this.post({ type: 'settingsSaved', ok: false, error: (err as Error).message });
    }
  }

  /** Re-broadcast composed prompts for all three agents to the webview. */
  broadcastComposedPrompts(): void {
    for (const agent of ['tpm', 'swe', 'qa']) {
      this.postComposedPrompt(agent);
    }
  }

  private postComposedPrompt(agent: string): void {
    if (!this.panel) return;
    const prompt = this.composer.compose(agent, this.getCurrentSettings());
    this.post({ type: 'composedPromptUpdated', agent, prompt });
  }

  /** Returns the current module settings dict, keyed by `moduleId::fieldKey`. */
  private getCurrentSettings(): Record<string, Record<string, unknown>> {
    const flat = this.context.workspaceState.get<Record<string, unknown>>(SETTINGS_KEY, {});
    // Unpack `moduleId::fieldKey` → nested { moduleId: { fieldKey: value } }.
    const out: Record<string, Record<string, unknown>> = {};
    for (const [scopedKey, value] of Object.entries(flat)) {
      const sep = scopedKey.indexOf('::');
      if (sep === -1) continue;
      const moduleId = scopedKey.slice(0, sep);
      const fieldKey = scopedKey.slice(sep + 2);
      if (!out[moduleId]) out[moduleId] = {};
      out[moduleId]![fieldKey] = value;
    }
    return out;
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
