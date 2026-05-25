import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { validateManifest } from '../manifest/validator';
import type { AtlassianBridge } from '../extension';
import type { ModuleLoader } from '../modules/loader';
import type { PromptComposer } from '../prompts/composer';
import { syncAliasFile, validateAlias, type CliAlias } from '../session/alias-sync';
import { resolveAgentPromptFilePath } from '../session/prompt-file';
import { WORKSPACE_STATE_KEYS } from '../state/keys';
import type { ConfigurationsStore } from './configurations-store';
import {
  readLinqpadConnections,
  resolveLinqpadConnectionsPath,
} from './linqpad-connections';
import type {
  FeedbackEntry,
  HostToWebviewMessage,
  ModuleSummary,
  NamedConfiguration,
  PromptFragmentDetail,
  SettingKeywordEntry,
  WebviewToHostMessage,
} from './protocol';

/**
 * Module id whose Session Manifest entry receives an injected
 * `feedbackFilePath` parameter at compose time. The path is the same file the
 * Settings panel "Feedback" tab reads/writes, so TPM and the panel share state.
 */
const FEEDBACK_MODULE_ID = 'tool.feedback-log';

/** Disk schema version for the feedback log JSON file. */
const FEEDBACK_SCHEMA_VERSION = 1;

export class SettingsPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  /**
   * Cached "modified vs active configuration" flag. Recomputed whenever
   * modules toggle, settings save, or the active config changes. Always
   * `false` when there is no active configuration selected.
   */
  private currentlyModified = false;

  /**
   * In-host mutex for serializing feedback-log read-modify-write operations.
   * Every entry-point that touches `feedbackFilePath` chains onto this promise
   * so concurrent webview messages (e.g. rapid Approve+Delete clicks) cannot
   * race against each other. Note: this only protects the host from racing
   * with itself — the TPM agent writes the same file out-of-band via its
   * Read/Write tools, and that cross-process race is documented as acceptable.
   */
  private feedbackChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly loader: ModuleLoader,
    private readonly composer: PromptComposer,
    private readonly configurations: ConfigurationsStore,
    private readonly resolveModulesDir: () => string,
    /**
     * Absolute path to the feedback-log JSON file. Computed in `extension.ts`
     * from `context.globalStorageUri` so the host and the agent (via the
     * `tool.feedback-log` manifest parameter) point at the same file.
     */
    private readonly feedbackFilePath: string,
    /**
     * Coordination surface for Atlassian credential queries and token-change
     * notifications. The token values never pass through the panel — only their
     * existence is communicated as booleans via `isJiraTokenSet()` and
     * `isBitbucketTokenSet()`.
     */
    private readonly atlassianBridge: AtlassianBridge,
    /**
     * Emitter the host fires after every successful module-settings save (and
     * after batch preset application). Signals the branch widget provider and
     * the context-key sync in `extension.ts` to re-pull updated settings.
     */
    private readonly moduleSettingsEmitter: vscode.EventEmitter<void>,
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
        // When the LINQPad connections override path changes, re-probe and
        // re-broadcast so any open keyValue dropdowns refresh without a manual
        // refresh click.
        if (ev.affectsConfiguration('nomeda.linqpadConnectionsPath')) {
          this.broadcastLinqpadConnections();
        }
      }),
    );

    // Re-broadcast Atlassian token status whenever the token is set or cleared.
    this.disposables.push(
      this.atlassianBridge.onDidChangeAtlassianTokenStatus(() => {
        void this.broadcastAtlassianTokenStatus();
      }),
    );

    // Push validation results to the webview whenever the bridge fires its event
    // (i.e., after setToken auto-validates or after the validateToken command completes).
    if (this.atlassianBridge.onDidChangeValidation) {
      this.disposables.push(
        this.atlassianBridge.onDidChangeValidation((result) => {
          this.post({ type: 'atlassianValidationResult', result });
        }),
      );
    }
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
        // If any enabled module declares a keyValue setting that draws from
        // the LINQPad connections source, eagerly probe + broadcast now so the
        // dropdown is populated by the time the user navigates to it.
        if (this.anyEnabledModuleNeedsLinqpad()) {
          this.broadcastLinqpadConnections();
        }
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
      case 'copyNewModulePrompt':
        await this.copyNewModulePrompt();
        break;
      case 'uploadModule':
        await this.uploadModule();
        break;
      case 'openSession':
        await vscode.commands.executeCommand('nomeda.openSession');
        break;
      case 'requestModuleDetail':
        await this.postModuleDetail(msg.moduleId);
        break;
      case 'requestSettingKeywords':
        await this.postSettingKeywords(msg.moduleId, msg.settingKey);
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
      case 'requestLinqpadConnections':
        this.broadcastLinqpadConnections();
        break;
      case 'copyLinqpadInstallPrompt':
        await this.copyLinqpadInstallPrompt();
        break;
      case 'openVSCodeSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', msg.query);
        break;
      case 'saveAliases':
        await this.saveAliases(msg.aliases);
        break;
      case 'getAliases':
        this.postAliases();
        break;
      case 'feedbackRequested':
        await this.runOnFeedbackChain(() => this.broadcastFeedback());
        break;
      case 'feedbackEntryUpdate':
        await this.runOnFeedbackChain(() => this.applyFeedbackUpdate(msg.id, msg.status));
        break;
      case 'feedbackEntryDelete':
        await this.runOnFeedbackChain(() => this.applyFeedbackDelete(msg.id));
        break;
      case 'atlassianSetJiraToken':
        await vscode.commands.executeCommand('nomeda.atlassianSuite.setJiraToken');
        break;
      case 'atlassianClearJiraToken':
        await vscode.commands.executeCommand('nomeda.atlassianSuite.clearJiraToken');
        break;
      case 'atlassianSetBitbucketToken':
        await vscode.commands.executeCommand('nomeda.atlassianSuite.setBitbucketToken');
        break;
      case 'atlassianClearBitbucketToken':
        await vscode.commands.executeCommand('nomeda.atlassianSuite.clearBitbucketToken');
        break;
      case 'atlassianTokenStatusRequested':
        await this.broadcastAtlassianTokenStatus();
        break;
      case 'atlassianValidationStatusRequested': {
        // Synchronous pull: return whatever is cached on the bridge right now.
        const lastResult = this.atlassianBridge.getLastValidation?.() ?? null;
        this.post({ type: 'atlassianValidationResult', result: lastResult });
        break;
      }
      case 'atlassianValidate':
        // Execute the command registered by SWE-1. The bridge fires onDidChangeValidation
        // when done, which the constructor subscription above will broadcast.
        // We do NOT call bridge.validate() directly so that all telemetry / hooks
        // stay routed through the single command path.
        await vscode.commands.executeCommand('nomeda.atlassianSuite.validateToken');
        break;
      case 'merkleTestConnection':
        await this.runMerkleTestConnection(msg.baseUrl);
        break;
      case 'openExternal': {
        // Only allow https: URLs — reject http: and any other scheme.
        let parsed: URL;
        try {
          parsed = new URL(msg.url);
        } catch {
          this.logger?.appendLine(`[panel] openExternal: invalid URL rejected: ${msg.url}`);
          break;
        }
        if (parsed.protocol !== 'https:') {
          this.logger?.appendLine(`[panel] openExternal: non-https scheme rejected: ${msg.url}`);
          break;
        }
        await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
      }
      default:
        this.logger?.appendLine(`[panel] unknown message: ${JSON.stringify(msg)}`);
    }
  }

  // ─── CLI alias registry ──────────────────────────────────────────────

  /**
   * Validate every entry, then persist to `nomeda.cliAliases` and rewrite the
   * managed block in `nomeda.aliasFile`. Surfaces validation and fs errors
   * back to the webview via `aliasesSaved`.
   */
  private async saveAliases(aliases: CliAlias[]): Promise<void> {
    for (const entry of aliases) {
      const error = validateAlias(entry);
      if (error) {
        this.post({ type: 'aliasesSaved', ok: false, error });
        return;
      }
    }
    try {
      await vscode.workspace
        .getConfiguration('nomeda')
        .update('cliAliases', aliases, vscode.ConfigurationTarget.Global);
      const aliasFile = vscode.workspace
        .getConfiguration('nomeda')
        .get<string>('aliasFile', '~/.bashrc');
      await syncAliasFile(aliasFile, aliases);
      this.post({ type: 'aliasesSaved', ok: true });
    } catch (err) {
      this.post({ type: 'aliasesSaved', ok: false, error: (err as Error).message });
    }
  }

  /**
   * Post the current alias registry + selection + rc file path to the
   * webview. Mirrors the alias-related fields on `settingsLoaded` for explicit
   * refresh requests.
   */
  private postAliases(): void {
    if (!this.panel) return;
    const cfg = vscode.workspace.getConfiguration('nomeda');
    const aliases = cfg.get<CliAlias[]>('cliAliases', []);
    const selectedAlias = cfg.get<string>('selectedAlias', '');
    const aliasFile = cfg.get<string>('aliasFile', '~/.bashrc');
    this.post({ type: 'aliasesLoaded', aliases, selectedAlias, aliasFile });
  }

  private async postModules(): Promise<void> {
    if (!this.panel) return;
    const modules: ModuleSummary[] = this.loader.getAll().map((h) => {
      const frags = h.manifest.contributes?.promptFragments ?? [];
      const targetSet = new Set<string>();
      for (const f of frags) {
        if (f.target === 'all') {
          targetSet.add('tpm');
          targetSet.add('swe');
          targetSet.add('qa');
        } else {
          targetSet.add(f.target.toLowerCase());
        }
      }
      return {
        id: h.manifest.id,
        name: h.manifest.name,
        version: h.manifest.version,
        description: h.manifest.description,
        enabled: h.isEnabled,
        proactive: h.manifest.proactive,
        contributes: h.manifest.contributes,
        targets: [...targetSet],
      };
    });
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

  /**
   * Read a setting's keywords JSON file (resolved against the module root) and
   * post the parsed entries to the webview. Mirrors `postModuleDetail`'s
   * path-traversal guard: the resolved absolute path must sit inside the
   * module's root. On any failure (missing manifest entry, missing
   * `keywordsPath`, traversal violation, fs read error, JSON parse error, or
   * shape validation error) we still emit a `settingKeywords` message with
   * `keywords: []` and a populated `error` field so the webview can decide
   * whether to surface it.
   */
  private async postSettingKeywords(
    moduleId: string,
    settingKey: string,
  ): Promise<void> {
    if (!this.panel) return;
    const handle = this.loader.find(moduleId);
    if (!handle) {
      this.post({
        type: 'settingKeywords',
        moduleId,
        settingKey,
        keywords: [],
        error: 'module not loaded',
      });
      return;
    }
    const field = handle.manifest.contributes?.settings?.[settingKey];
    if (!field) {
      this.post({
        type: 'settingKeywords',
        moduleId,
        settingKey,
        keywords: [],
        error: 'setting not found',
      });
      return;
    }
    const keywordsPath = field.keywordsPath;
    if (!keywordsPath) {
      this.post({
        type: 'settingKeywords',
        moduleId,
        settingKey,
        keywords: [],
        error: 'setting has no keywordsPath',
      });
      return;
    }

    const rootWithSep = handle.rootPath.endsWith(path.sep)
      ? handle.rootPath
      : handle.rootPath + path.sep;
    const abs = path.join(handle.rootPath, keywordsPath);
    if (!abs.startsWith(rootWithSep) && abs !== handle.rootPath) {
      this.post({
        type: 'settingKeywords',
        moduleId,
        settingKey,
        keywords: [],
        error: 'keywordsPath escapes module root',
      });
      return;
    }

    let raw: string;
    try {
      raw = await fs.readFile(abs, 'utf-8');
    } catch (e) {
      this.post({
        type: 'settingKeywords',
        moduleId,
        settingKey,
        keywords: [],
        error: (e as Error).message,
      });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      this.post({
        type: 'settingKeywords',
        moduleId,
        settingKey,
        keywords: [],
        error: `JSON parse failed: ${(e as Error).message}`,
      });
      return;
    }

    if (!Array.isArray(parsed)) {
      this.post({
        type: 'settingKeywords',
        moduleId,
        settingKey,
        keywords: [],
        error: 'keywords file must contain a JSON array',
      });
      return;
    }

    const keywords: SettingKeywordEntry[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const entry = parsed[i] as unknown;
      if (
        !entry ||
        typeof entry !== 'object' ||
        typeof (entry as { keyword?: unknown }).keyword !== 'string' ||
        typeof (entry as { purpose?: unknown }).purpose !== 'string'
      ) {
        this.post({
          type: 'settingKeywords',
          moduleId,
          settingKey,
          keywords: [],
          error: `entry ${i} is not { keyword: string, purpose: string }`,
        });
        return;
      }
      keywords.push({
        keyword: (entry as SettingKeywordEntry).keyword,
        purpose: (entry as SettingKeywordEntry).purpose,
      });
    }

    this.post({ type: 'settingKeywords', moduleId, settingKey, keywords });
  }

  private postSettings(): void {
    if (!this.panel) return;
    const values = this.context.workspaceState.get<Record<string, unknown>>(WORKSPACE_STATE_KEYS.MODULE_SETTINGS, {});
    const cfg = vscode.workspace.getConfiguration('nomeda');
    const cliCommand = cfg.get<string>('cliCommand', 'claude');
    const sessionCommand = cfg.get<string>('sessionCommand', 'initiate');
    const swe = {
      performanceCores: cfg.get<number>('swe.performanceCores', 2),
      efficiencyCores: cfg.get<number>('swe.efficiencyCores', 1),
      performanceCoresModel: cfg.get<string>('swe.performanceCoresModel', 'opus'),
      efficiencyCoresModel: cfg.get<string>('swe.efficiencyCoresModel', 'sonnet'),
    };
    const qa = {
      count: cfg.get<number>('qa.count', 1),
      model: cfg.get<string>('qa.model', 'sonnet'),
    };
    const aliases = cfg.get<CliAlias[]>('cliAliases', []);
    const selectedAlias = cfg.get<string>('selectedAlias', '');
    const aliasFile = cfg.get<string>('aliasFile', '~/.bashrc');
    this.post({
      type: 'settingsLoaded',
      values,
      cliCommand,
      sessionCommand,
      swe,
      qa,
      aliases,
      selectedAlias,
      aliasFile,
    });
  }

  private async saveSettings(values: Record<string, unknown>): Promise<void> {
    try {
      await this.context.workspaceState.update(WORKSPACE_STATE_KEYS.MODULE_SETTINGS, values);
      this.post({ type: 'settingsSaved', ok: true });
      // Module settings changed — the modified flag may have flipped.
      this.recomputeModified();
      this.postConfigurations();
      // Broadcast fresh composed prompts after settings change per architecture spec.
      this.broadcastComposedPrompts();
      // Signal branch widget + context-key sync that module settings changed.
      this.moduleSettingsEmitter.fire();
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

  /**
   * Compose the TPM, SWE, and QA prompts with the current settings and write
   * each to a workspace-scoped temp-file location so the launched terminal
   * can read them via the `$NOMEDA_TPM_PROMPT_FILE`, `$NOMEDA_SWE_PROMPT_FILE`,
   * and `$NOMEDA_QA_PROMPT_FILE` env vars. Filenames are derived from a hash
   * of the workspace folder path (see `resolveAgentPromptFilePath`) so
   * concurrent Nomeda sessions in different VS Code windows cannot collide.
   * Within a single workspace the paths are stable across launches — repeated
   * invocations overwrite the previous prompts cleanly.
   *
   * Fail-closed: if any write fails the caller should abort the launch so a
   * terminal never opens against partial state.
   */
  async writeAllAgentPromptFiles(): Promise<{ tpm: string; swe: string; qa: string }> {
    const settings = this.getCurrentSettings();
    const paths = {
      tpm: resolveAgentPromptFilePath('tpm'),
      swe: resolveAgentPromptFilePath('swe'),
      qa: resolveAgentPromptFilePath('qa'),
    };
    await fs.writeFile(paths.tpm, this.composer.compose('tpm', settings), 'utf-8');
    await fs.writeFile(paths.swe, this.composer.compose('swe', settings), 'utf-8');
    await fs.writeFile(paths.qa, this.composer.compose('qa', settings), 'utf-8');
    this.logger?.appendLine(
      `[panel] wrote composed prompts: tpm=${paths.tpm} swe=${paths.swe} qa=${paths.qa}`,
    );
    return paths;
  }

  private postComposedPrompt(agent: string): void {
    if (!this.panel) return;
    const prompt = this.composer.compose(agent, this.getCurrentSettings());
    this.post({ type: 'composedPromptUpdated', agent, prompt });
  }

  /** Returns the current module settings dict, keyed by `moduleId::fieldKey`. */
  private getCurrentSettings(): Record<string, Record<string, unknown>> {
    const flat = this.context.workspaceState.get<Record<string, unknown>>(WORKSPACE_STATE_KEYS.MODULE_SETTINGS, {});
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
    // Host-injected parameter for `tool.feedback-log`: the agent receives the
    // same absolute path the panel reads/writes so both sides share state.
    // Only injected when the module is enabled — otherwise the manifest entry
    // wouldn't appear in the agent's prompt anyway and the injection would be
    // dead weight in the workspace settings dict.
    if (this.loader.find(FEEDBACK_MODULE_ID)?.isEnabled) {
      if (!out[FEEDBACK_MODULE_ID]) out[FEEDBACK_MODULE_ID] = {};
      out[FEEDBACK_MODULE_ID]!['feedbackFilePath'] = this.feedbackFilePath;
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
    // the `moduleId::fieldKey` shape stored in workspaceState under
    // WORKSPACE_STATE_KEYS.MODULE_SETTINGS.
    const flatSettings: Record<string, unknown> = {};
    for (const [moduleId, fields] of Object.entries(target.settings)) {
      for (const [fieldKey, value] of Object.entries(fields)) {
        flatSettings[`${moduleId}::${fieldKey}`] = value;
      }
    }
    await this.context.workspaceState.update(WORKSPACE_STATE_KEYS.MODULE_SETTINGS, flatSettings);

    await this.configurations.setActiveId(id);
    this.recomputeModified();

    await this.postModules();
    this.postSettings();
    this.postConfigurations();
    this.broadcastComposedPrompts();
    // Signal branch widget + context-key sync that settings changed via preset application.
    this.moduleSettingsEmitter.fire();
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

  // ─── Module clipboard + upload ────────────────────────────────────────

  /**
   * Copy the user-configurable `nomeda.newModulePrompt` text to the system
   * clipboard so the user can paste it into an AI chat to generate a new
   * Nomeda module. Surfaces a non-modal info toast on success.
   */
  private async copyNewModulePrompt(): Promise<void> {
    const promptText = vscode.workspace
      .getConfiguration('nomeda')
      .get<string>('newModulePrompt', '');
    await vscode.env.clipboard.writeText(promptText);
    vscode.window.showInformationMessage('Module-generation prompt copied to clipboard');
  }

  /**
   * Prompt the user to pick a folder (default: ~/Downloads), validate it
   * looks like a Nomeda module, then copy it into the workspace modules
   * directory. If the module already exists, prompts the user via a modal
   * Overwrite/Cancel confirmation before replacing it.
   */
  private async uploadModule(): Promise<void> {
    const downloadsUri = vscode.Uri.file(path.join(os.homedir(), 'Downloads'));
    const selection = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      defaultUri: downloadsUri,
      title: 'Select module folder to upload',
    });
    if (!selection || selection.length === 0) return;
    const sourceFolder = selection[0]!.fsPath;

    const manifestPath = path.join(sourceFolder, 'manifest.json');
    if (!fsSync.existsSync(manifestPath)) {
      vscode.window.showErrorMessage(
        'Selected folder has no manifest.json — not a valid Nomeda module.',
      );
      return;
    }

    let parsed: unknown;
    try {
      const raw = fsSync.readFileSync(manifestPath, 'utf-8');
      parsed = JSON.parse(raw);
    } catch (err) {
      vscode.window.showErrorMessage(
        `Could not parse manifest.json: ${(err as Error).message}`,
      );
      return;
    }

    const result = validateManifest(parsed);
    if (!result.ok) {
      vscode.window.showErrorMessage(
        `Manifest validation failed: ${result.errors.join(', ')}`,
      );
      return;
    }
    const manifest = result.manifest;

    const modulesBase = this.resolveModulesDir();
    const targetFolder = path.join(modulesBase, manifest.id);

    if (fsSync.existsSync(targetFolder)) {
      const choice = await vscode.window.showWarningMessage(
        `Module "${manifest.id}" already exists. Overwrite?`,
        { modal: true },
        'Overwrite',
        'Cancel',
      );
      if (choice !== 'Overwrite') return;
      // User-approved removal: the modal dialog above is the explicit consent
      // surface, so we are permitted to delete the previous module folder.
      try {
        fsSync.rmSync(targetFolder, { recursive: true, force: true });
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to remove existing module folder: ${(err as Error).message}`,
        );
        return;
      }
    } else {
      // Ensure the parent modules dir exists before cpSync writes into it.
      try {
        fsSync.mkdirSync(modulesBase, { recursive: true });
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to create modules directory: ${(err as Error).message}`,
        );
        return;
      }
    }

    try {
      fsSync.cpSync(sourceFolder, targetFolder, { recursive: true });
    } catch (err) {
      vscode.window.showErrorMessage(
        `Failed to copy module folder: ${(err as Error).message}`,
      );
      return;
    }

    // Re-discover so the new module shows up in the Modules tab. Use the
    // existing command path so any watchers / state stay consistent.
    await vscode.commands.executeCommand('nomeda.reloadModules');

    vscode.window.showInformationMessage(`Module ${manifest.id} uploaded successfully.`);
  }

  // ─── LINQPad connection discovery ─────────────────────────────────────

  /**
   * Returns true when at least one enabled module declares a `keyValue`
   * setting whose `valueSource` is `"linqpad-connections"`. Used on `ready`
   * to decide whether to eagerly probe the LINQPad XML for the webview.
   */
  private anyEnabledModuleNeedsLinqpad(): boolean {
    for (const h of this.loader.getAll()) {
      if (!h.isEnabled) continue;
      const settings = h.manifest.contributes?.settings;
      if (!settings) continue;
      for (const field of Object.values(settings)) {
        if (field.type === 'keyValue' && field.valueSource === 'linqpad-connections') {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Resolve the LINQPad ConnectionsV2.xml path, parse it, and post a
   * `linqpadConnections` message to the webview. Reports `not-installed` when
   * no candidate path exists, `error` when the path exists but the file
   * cannot be read or parsed, and `ok` (with a possibly empty `connections`
   * array) when the parse succeeds.
   */
  private broadcastLinqpadConnections(): void {
    if (!this.panel) return;
    const override = vscode.workspace
      .getConfiguration('nomeda')
      .get<string>('linqpadConnectionsPath', '');
    const resolved = resolveLinqpadConnectionsPath(override);
    if (resolved.status === 'not-installed') {
      this.post({
        type: 'linqpadConnections',
        status: 'not-installed',
        connections: [],
        error: resolved.error,
      });
      return;
    }
    try {
      const { connections } = readLinqpadConnections(resolved.path);
      this.post({
        type: 'linqpadConnections',
        status: 'ok',
        connections,
        resolvedPath: resolved.path,
      });
    } catch (err) {
      this.post({
        type: 'linqpadConnections',
        status: 'error',
        connections: [],
        resolvedPath: resolved.path,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Copy the user-configurable `nomeda.linqpadInstallPrompt` text to the
   * system clipboard so the user can paste it into an AI chat (or a notes
   * app) to walk through a LINQPad install / connection-export. Mirrors the
   * `copyNewModulePrompt` UX exactly.
   */
  private async copyLinqpadInstallPrompt(): Promise<void> {
    const promptText = vscode.workspace
      .getConfiguration('nomeda')
      .get<string>('linqpadInstallPrompt', '');
    await vscode.env.clipboard.writeText(promptText);
    vscode.window.showInformationMessage('LINQPad install prompt copied to clipboard');
  }

  // ─── Merkle test-connection probe ─────────────────────────────────────

  /**
   * Run a manual "Test Connection" probe against `${baseUrl}/api/health` and
   * post the outcome back to the webview as `merkleTestConnectionResult`.
   *
   * Fail-closed at each stage: empty url, network error, non-200 response,
   * unparseable body, or wrong `name` field all produce a `status: 'error'`
   * payload. The 8s `AbortController` timeout mirrors the
   * `bitbucket-pr-client` request envelope so a wedged Merkle server can't
   * hang the settings panel indefinitely.
   *
   * No credentials touch this path — Merkle's health endpoint is
   * unauthenticated by design.
   */
  private async runMerkleTestConnection(rawBaseUrl: unknown): Promise<void> {
    if (typeof rawBaseUrl !== 'string' || rawBaseUrl.trim() === '') {
      this.post({
        type: 'merkleTestConnectionResult',
        result: {
          status: 'error',
          message: 'serverBaseUrl is empty',
          testedBaseUrl: '',
        },
      });
      return;
    }
    // Trim trailing slash so both `http://host:7423` and `http://host:7423/`
    // build the same health URL. Other path components are left intact.
    const baseUrl = rawBaseUrl.trim().replace(/\/+$/, '');
    const healthUrl = `${baseUrl}/api/health`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(healthUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (response.status !== 200) {
        this.post({
          type: 'merkleTestConnectionResult',
          result: {
            status: 'error',
            httpStatus: response.status,
            message: `HTTP ${response.status}`,
            testedBaseUrl: baseUrl,
          },
        });
        return;
      }
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        this.post({
          type: 'merkleTestConnectionResult',
          result: {
            status: 'error',
            httpStatus: 200,
            message: 'Response was not JSON',
            testedBaseUrl: baseUrl,
          },
        });
        return;
      }
      const body = (parsed ?? {}) as {
        name?: unknown;
        version?: unknown;
        time?: unknown;
      };
      const name = typeof body.name === 'string' ? body.name : undefined;
      const version = typeof body.version === 'string' ? body.version : undefined;
      const time = typeof body.time === 'string' ? body.time : undefined;
      if (name !== 'project-merkle') {
        this.post({
          type: 'merkleTestConnectionResult',
          result: {
            status: 'error',
            httpStatus: 200,
            message: `Endpoint responded but identifies as "${name ?? 'unknown'}", not project-merkle`,
            testedBaseUrl: baseUrl,
          },
        });
        return;
      }
      this.post({
        type: 'merkleTestConnectionResult',
        result: {
          status: 'ok',
          httpStatus: 200,
          name,
          serverVersion: version,
          serverTime: time,
          testedBaseUrl: baseUrl,
        },
      });
    } catch (err) {
      // Network-layer failure (timeout, DNS, connection refused). Use the
      // error message verbatim — none of these paths carry credentials.
      const message =
        (err as Error).name === 'AbortError'
          ? 'Request timed out after 8s'
          : (err as Error).message || 'network error';
      this.post({
        type: 'merkleTestConnectionResult',
        result: {
          status: 'error',
          message,
          testedBaseUrl: baseUrl,
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // ─── Atlassian Suite token status ─────────────────────────────────────

  /**
   * Query both `isJiraTokenSet()` and `isBitbucketTokenSet()` in parallel and
   * post the combined result to the webview. Token values are never read —
   * only existence is communicated as booleans.
   */
  private async broadcastAtlassianTokenStatus(): Promise<void> {
    if (!this.panel) return;
    const [jiraSet, bitbucketSet] = await Promise.all([
      this.atlassianBridge.isJiraTokenSet(),
      this.atlassianBridge.isBitbucketTokenSet(),
    ]);
    this.post({ type: 'atlassianTokenStatus', jiraSet, bitbucketSet });
  }

  // ─── Feedback log ─────────────────────────────────────────────────────

  /**
   * Chain `task` onto the feedback mutex so concurrent webview messages run
   * sequentially even when each one is async. The chain swallows errors from
   * individual tasks so a single failure does not poison subsequent runs;
   * tasks are expected to log + recover internally.
   */
  private runOnFeedbackChain(task: () => Promise<void>): Promise<void> {
    const next = this.feedbackChain.then(task).catch((err) => {
      this.logger?.appendLine(`[panel] feedback task failed: ${(err as Error).message}`);
    });
    this.feedbackChain = next;
    return next;
  }

  /**
   * Read the feedback JSON file. Returns an empty list when the file is
   * missing, unparseable, or malformed — the panel is the canonical writer
   * and will heal the shape on its own next write. Never throws.
   */
  private async readFeedback(): Promise<FeedbackEntry[]> {
    try {
      const raw = await fs.readFile(this.feedbackFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as { entries?: unknown };
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
        return [];
      }
      // Filter out malformed entries rather than failing the whole read.
      const valid: FeedbackEntry[] = [];
      for (const e of parsed.entries) {
        if (
          e &&
          typeof e === 'object' &&
          typeof (e as FeedbackEntry).id === 'string' &&
          typeof (e as FeedbackEntry).createdAt === 'string' &&
          typeof (e as FeedbackEntry).text === 'string' &&
          ((e as FeedbackEntry).status === 'pending' ||
            (e as FeedbackEntry).status === 'approved')
        ) {
          const raw = e as FeedbackEntry;
          const entry: FeedbackEntry = {
            id: raw.id,
            createdAt: raw.createdAt,
            text: raw.text,
            status: raw.status,
          };
          // Preserve branch if present and valid type (optional field — absent on legacy entries).
          if (raw.branch === null || typeof raw.branch === 'string') {
            entry.branch = raw.branch;
          }
          valid.push(entry);
        }
      }
      return valid;
    } catch (err) {
      // ENOENT is the expected first-read case — log louder errors only.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.logger?.appendLine(
          `[panel] feedback read failed (${this.feedbackFilePath}): ${(err as Error).message}`,
        );
      }
      return [];
    }
  }

  /**
   * Write the feedback JSON file. Ensures the parent directory exists first
   * (VS Code does not pre-create `globalStorageUri`). Errors propagate to the
   * caller so the chain wrapper can log them.
   */
  private async writeFeedback(entries: FeedbackEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(this.feedbackFilePath), { recursive: true });
    const payload = JSON.stringify(
      { schemaVersion: FEEDBACK_SCHEMA_VERSION, entries },
      null,
      2,
    );
    await fs.writeFile(this.feedbackFilePath, payload, 'utf-8');
  }

  /** Read the current feedback list and post it to the webview. */
  private async broadcastFeedback(): Promise<void> {
    const entries = await this.readFeedback();
    this.post({ type: 'feedbackLoaded', entries });
  }

  /**
   * Mark an entry approved: read, mutate matching entry's status, write,
   * re-broadcast. Missing ids are silently ignored — the webview UI is the
   * source of truth for which ids exist, and a stale id usually means the
   * TPM agent rewrote the file between the read and the click.
   */
  private async applyFeedbackUpdate(
    id: string,
    status: 'approved',
  ): Promise<void> {
    try {
      const entries = await this.readFeedback();
      const next = entries.map((e) => (e.id === id ? { ...e, status } : e));
      await this.writeFeedback(next);
      this.post({ type: 'feedbackLoaded', entries: next });
    } catch (err) {
      this.logger?.appendLine(
        `[panel] feedback update failed (${id}): ${(err as Error).message}`,
      );
      // Degrade gracefully — re-broadcast whatever read succeeds.
      const fallback = await this.readFeedback();
      this.post({ type: 'feedbackLoaded', entries: fallback });
    }
  }

  /**
   * Delete an entry by id: read, filter, write, re-broadcast. Missing ids are
   * silently ignored for the same reason as `applyFeedbackUpdate`.
   */
  private async applyFeedbackDelete(id: string): Promise<void> {
    try {
      const entries = await this.readFeedback();
      const next = entries.filter((e) => e.id !== id);
      await this.writeFeedback(next);
      this.post({ type: 'feedbackLoaded', entries: next });
    } catch (err) {
      this.logger?.appendLine(
        `[panel] feedback delete failed (${id}): ${(err as Error).message}`,
      );
      const fallback = await this.readFeedback();
      this.post({ type: 'feedbackLoaded', entries: fallback });
    }
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
