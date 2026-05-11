import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ModuleLoader } from '../modules/loader';
import type { PromptComposer } from '../prompts/composer';
import type { ConfigurationsStore } from './configurations-store';
import type {
  HostToWebviewMessage,
  ModuleSummary,
  NamedConfiguration,
  PromptFragmentDetail,
  WebviewToHostMessage,
} from './protocol';

const SETTINGS_KEY = 'nomeda.moduleSettings';

export class SettingsPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  /**
   * Cached "modified vs active configuration" flag. Recomputed whenever
   * modules toggle, settings save, or the active config changes. Always
   * `false` when there is no active configuration selected.
   */
  private currentlyModified = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly loader: ModuleLoader,
    private readonly composer: PromptComposer,
    private readonly configurations: ConfigurationsStore,
    private readonly logger?: vscode.OutputChannel,
  ) {
    this.disposables.push(
      this.loader.onDidChange(() => {
        // Modules may have appeared/disappeared since the configurations were
        // saved; prune stale enabledIds so the UI doesn't surface ghosts.
        void this.pruneStaleConfigurationIds().then(() => {
          this.recomputeModified();
          void this.postModules();
          this.postConfigurations();
        });
      }),
    );

    // Mirror native VS Code settings edits back into the webview so the agent
    // subpages stay in sync with `nomeda.*` config changes made outside the panel.
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((ev) => {
        if (ev.affectsConfiguration('nomeda')) {
          this.postSettings();
        }
      }),
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
        await this.postModules();
        this.postConfigurations();
        break;
      case 'getModules':
        await this.postModules();
        break;
      case 'toggleModule':
        if (msg.enabled) await this.loader.enable(msg.id);
        else await this.loader.disable(msg.id);
        // postModules + recompute happen via the loader.onDidChange handler,
        // but call them here too so the response feels synchronous if the
        // event hasn't propagated yet.
        this.recomputeModified();
        await this.postModules();
        this.postConfigurations();
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
      case 'saveConfigurationCurrent':
        await this.saveConfigurationCurrent();
        break;
      case 'saveConfigurationAsNew':
        await this.saveConfigurationAsNew(msg.name);
        break;
      case 'selectConfiguration':
        await this.applyConfiguration(msg.id);
        break;
      case 'deleteConfiguration':
        await this.deleteConfiguration(msg.id);
        break;
      case 'renameConfiguration':
        await this.renameConfiguration(msg.id, msg.name);
        break;
      case 'setDefaultConfiguration':
        await this.setDefaultConfiguration(msg.id);
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
      contributes: h.manifest.contributes,
    }));
    this.post({ type: 'modulesChanged', modules });
  }

  /**
   * Read every prompt-fragment file for a module (resolved against its root)
   * and post their raw contents to the webview.
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

    this.post({ type: 'moduleDetail', moduleId, fragments });
  }

  private postSettings(): void {
    if (!this.panel) return;
    const values = this.context.workspaceState.get<Record<string, unknown>>(SETTINGS_KEY, {});
    const cfg = vscode.workspace.getConfiguration('nomeda');
    const sessionCommand = cfg.get<string>('sessionCommand', 'initiate');
    const swe = {
      performanceCores: cfg.get<number>('swe.performanceCores', 2),
      efficiencyCores: cfg.get<number>('swe.efficiencyCores', 1),
    };
    const qa = {
      count: cfg.get<number>('qa.count', 1),
    };
    this.post({ type: 'settingsLoaded', values, sessionCommand, swe, qa });
  }

  private async saveSettings(values: Record<string, unknown>): Promise<void> {
    try {
      await this.context.workspaceState.update(SETTINGS_KEY, values);
      this.post({ type: 'settingsSaved', ok: true });
      // Module settings changed — the modified flag may have flipped.
      this.recomputeModified();
      this.postConfigurations();
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

  // ─── Configuration presets ───────────────────────────────────────────

  /**
   * Push the latest list + active id + modified flag to the webview. Safe to
   * call when the panel is not open (becomes a no-op).
   */
  private postConfigurations(): void {
    if (!this.panel) return;
    const configurations = this.configurations.getAll();
    const activeId = this.configurations.getActiveId();
    this.post({
      type: 'configurationsChanged',
      configurations,
      activeId,
      isModified: this.currentlyModified,
    });
  }

  /**
   * Compare the current enabled-module set + flattened settings to the active
   * configuration's snapshot. Returns false when there is no active config.
   * Uses sorted-array equality for enabledIds and deep equality (via JSON
   * canonicalization) for settings.
   */
  private computeIsModified(): boolean {
    const activeId = this.configurations.getActiveId();
    if (!activeId) return false;
    const active = this.configurations.findById(activeId);
    if (!active) return false;

    const currentEnabled = this.loader.getAll().filter((h) => h.isEnabled).map((h) => h.manifest.id);
    if (!sortedEquals(currentEnabled, active.enabledIds)) return true;

    const currentSettings = this.getCurrentSettings();
    return !deepEquals(currentSettings, active.settings);
  }

  /** Recompute & cache the modified flag. */
  private recomputeModified(): void {
    this.currentlyModified = this.computeIsModified();
  }

  /**
   * Persist the active configuration's enabledIds + settings to match the
   * current state. No-op when no active config is selected.
   */
  private async saveConfigurationCurrent(): Promise<void> {
    const activeId = this.configurations.getActiveId();
    if (!activeId) return;
    const enabledIds = this.loader.getAll().filter((h) => h.isEnabled).map((h) => h.manifest.id);
    const settings = this.getCurrentSettings();
    await this.configurations.update(activeId, { enabledIds, settings });
    this.recomputeModified();
    this.postConfigurations();
  }

  /**
   * Create a new configuration from the current state, then make it the
   * active selection so further edits track against it.
   */
  private async saveConfigurationAsNew(name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return;
    const enabledIds = this.loader.getAll().filter((h) => h.isEnabled).map((h) => h.manifest.id);
    const settings = this.getCurrentSettings();
    const created = await this.configurations.add(trimmed, enabledIds, settings);
    await this.configurations.setActiveId(created.id);
    this.recomputeModified();
    this.postConfigurations();
  }

  /**
   * Switch the active configuration. When `id` is null, simply clear the
   * selection — module state is left intact. When non-null, diff and apply
   * the snapshot via the loader and the settings store, then broadcast.
   */
  private async applyConfiguration(id: string | null): Promise<void> {
    if (id === null) {
      await this.configurations.setActiveId(null);
      this.recomputeModified();
      this.postConfigurations();
      return;
    }

    const target = this.configurations.findById(id);
    if (!target) return;

    const targetEnabled = new Set(target.enabledIds);
    const handles = this.loader.getAll();
    // Diff: toggle each module to its target state. Use the loader's mutating
    // methods so onDidChange fires exactly once per flip (rather than rewriting
    // the entire enabled-ids list, which could race with other listeners).
    for (const h of handles) {
      const shouldBeEnabled = targetEnabled.has(h.manifest.id);
      if (h.isEnabled && !shouldBeEnabled) {
        await this.loader.disable(h.manifest.id);
      } else if (!h.isEnabled && shouldBeEnabled) {
        await this.loader.enable(h.manifest.id);
      }
    }

    // Flatten target.settings (nested { moduleId: { fieldKey: value } }) into
    // the `moduleId::fieldKey` shape stored in workspaceState SETTINGS_KEY.
    const flatSettings: Record<string, unknown> = {};
    for (const [moduleId, fields] of Object.entries(target.settings)) {
      for (const [fieldKey, value] of Object.entries(fields)) {
        flatSettings[`${moduleId}::${fieldKey}`] = value;
      }
    }
    await this.context.workspaceState.update(SETTINGS_KEY, flatSettings);

    await this.configurations.setActiveId(id);
    this.recomputeModified();

    await this.postModules();
    this.postSettings();
    this.postConfigurations();
    this.broadcastComposedPrompts();
  }

  private async deleteConfiguration(id: string): Promise<void> {
    await this.configurations.remove(id);
    this.recomputeModified();
    this.postConfigurations();
  }

  private async renameConfiguration(id: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return;
    await this.configurations.update(id, { name: trimmed });
    this.postConfigurations();
  }

  private async setDefaultConfiguration(id: string): Promise<void> {
    await this.configurations.setDefault(id);
    this.postConfigurations();
  }

  /**
   * Drop enabledIds in stored configurations that no longer match a live
   * module on disk. Mirrors the loader's own pruning logic, but applied to
   * config snapshots so the UI never highlights ghosts. Persists the cleaned
   * list when at least one entry changed.
   */
  private async pruneStaleConfigurationIds(): Promise<void> {
    const live = new Set(this.loader.getAll().map((h) => h.manifest.id));
    const list = this.configurations.getAll();
    let mutated = false;
    const cleaned: NamedConfiguration[] = list.map((c) => {
      const filtered = c.enabledIds.filter((id) => live.has(id));
      if (filtered.length !== c.enabledIds.length) {
        mutated = true;
        return { ...c, enabledIds: filtered };
      }
      return c;
    });
    if (mutated) {
      await this.configurations.setAll(cleaned);
    }
  }

  /**
   * Called once at activation after the first `discover()` resolves. If the
   * user has a configuration flagged isDefault, applies it before the rest of
   * the UI surfaces. Idempotent: safe to call multiple times.
   */
  async applyDefaultOnStartup(): Promise<void> {
    const def = this.configurations.getAll().find((c) => c.isDefault);
    if (!def) return;
    if (this.configurations.getActiveId() === def.id) {
      // Already active — just normalize the flag and broadcast on next open.
      this.recomputeModified();
      return;
    }
    await this.applyConfiguration(def.id);
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

function sortedEquals(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i++) {
    if (sa[i] !== sb[i]) return false;
  }
  return true;
}

function deepEquals(a: unknown, b: unknown): boolean {
  // JSON canonicalization is sufficient for the small, JSON-safe settings
  // trees we store. Key order is not preserved by Object.entries unless
  // canonicalized, so sort keys before stringify.
  return canonicalJson(a) === canonicalJson(b);
}

function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(val as Record<string, unknown>).sort()) {
        out[k] = (val as Record<string, unknown>)[k];
      }
      return out;
    }
    return val;
  });
}
