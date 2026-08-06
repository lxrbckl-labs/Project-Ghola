import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { discoverAppPaths } from '../integration/support-discovery';
import { discoverObsidianVault } from '../integration/vault-discovery';
import { validateManifest } from '../manifest/validator';
import type { AtlassianBridge } from '../extension';
import type { BitbucketPrClient } from '../integration/bitbucket-pr-client';
import type { ModuleLoader } from '../modules/loader';
import type { PromptComposer } from '../prompts/composer';
import { syncAliasFile, validateAlias, type CliAlias } from '../session/alias-sync';
import { resolveLedgerRoot } from '../session/host-path';
import { resolveAgentPromptFilePath } from '../session/prompt-file';
import {
  mergeChangedModuleSettings,
  readModuleSettings,
  writeModuleSettings,
} from '../state/module-settings';
import type { ConfigurationsStore } from './configurations-store';
import {
  readLinqpadConnections,
  resolveLinqpadConnectionsPath,
} from './linqpad-connections';
import type {
  FeedbackEntry,
  GholaDetail,
  HostToWebviewMessage,
  ModuleSummary,
  NamedConfiguration,
  PromptFragmentDetail,
  SettingKeywordEntry,
  WarRoomData,
  WarRoomGhola,
  WarRoomMission,
  WarRoomSettings,
  WebviewToHostMessage,
} from './protocol';

/**
 * Module id whose Session Manifest entry receives an injected
 * `feedbackFilePath` parameter at compose time. The path is the same file the
 * Settings panel "Feedback" tab reads/writes, so TPM and the panel share state.
 */
const FEEDBACK_MODULE_ID = 'tool.feedback-log';

/**
 * Session-mode module whose sub-toggle setting VALUES must always reach TPM's
 * Session Manifest even when left at their schema defaults. See
 * `getComposeSettings` for why the composer's normal "(defaults)" rendering is
 * insufficient for this module.
 */
const GHOLA_MODE_ID = 'mode.war';

/** Disk schema version for the feedback log JSON file. */
const FEEDBACK_SCHEMA_VERSION = 1;

/**
 * Return a shallow-cloned settings map with the host-injected
 * `tool.feedback-log.feedbackFilePath` removed (and the now-empty
 * `tool.feedback-log` entry dropped). Used only by modified-detection so the
 * machine-specific runtime path never registers as a user-visible diff. Does
 * not mutate the input; compose/apply/save still see the injected path.
 */
function withoutInjectedFeedbackPath(
  settings: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const feedback = settings[FEEDBACK_MODULE_ID];
  if (!feedback || !('feedbackFilePath' in feedback)) return settings;
  const out: Record<string, Record<string, unknown>> = { ...settings };
  const { feedbackFilePath: _omit, ...rest } = feedback;
  if (Object.keys(rest).length === 0) {
    delete out[FEEDBACK_MODULE_ID];
  } else {
    out[FEEDBACK_MODULE_ID] = rest;
  }
  return out;
}

export class SettingsPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  /**
   * Last-known `panel.visible` for the current panel, so the
   * `onDidChangeViewState` handler in `adoptPanel` can react to a false -> true
   * transition ONLY. That event also fires on column moves and active/inactive
   * changes (where `visible` never leaves `true`), and every one of those must
   * NOT trigger a `postSettings`. Reset to `false` on dispose.
   */
  private panelWasVisible = false;
  private readonly disposables: vscode.Disposable[] = [];
  /**
   * Cached "modified vs active configuration" flag. Recomputed whenever
   * modules toggle, settings save, or the active config changes. Always
   * `false` when there is no active configuration selected.
   */
  private currentlyModified = false;

  /**
   * The subject slug the operator last EXPLICITLY requested via a
   * `requestWarRoom` message that carried a `subject`. Internal War Room
   * refreshes (ledger/control watchers, the control-writing button handlers)
   * all call `postWarRoom()` with no argument; without this the auto-pick
   * would re-run on every refresh and yank the view off the operator's chosen
   * subject. `postWarRoom` reuses this value when no explicit subject is
   * passed so the selection stays sticky. Undefined until the operator picks a
   * subject (the initial load auto-picks and leaves this unset).
   */
  private lastRequestedSubject?: string;

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
     * after batch preset application). Signals `extension.ts` subscribers (the
     * mode / War Mode status-bar item) to re-pull updated settings.
     */
    private readonly moduleSettingsEmitter: vscode.EventEmitter<void>,
    /**
     * Bitbucket PR client, used to search workspace members for the reviewer
     * picker. Undefined when the Atlassian integration is not configured.
     */
    private readonly bitbucketPrClient?: BitbucketPrClient,
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
    // subpages stay in sync with `ghola.*` config changes made outside the panel.
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((ev) => {
        if (ev.affectsConfiguration('ghola')) {
          this.postSettings();
        }
        // When the LINQPad connections override path changes, re-probe and
        // re-broadcast so any open keyValue dropdowns refresh without a manual
        // refresh click.
        if (ev.affectsConfiguration('ghola.linqpadConnectionsPath')) {
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
      // Strict singleton: a panel already exists, so surface it instead of
      // creating a second one. Reveal in its CURRENT column (never force-move to
      // Active) so reopening doesn't yank the tab across editor groups.
      this.panel.reveal(this.panel.viewColumn);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'gholaSettings',
      'Ghola',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
          vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        ],
      },
    );
    this.adoptPanel(panel);
  }

  /**
   * Adopt a webview panel that VS Code handed back when restoring a serialized
   * 'gholaSettings' panel after a window reload (see the
   * `registerWebviewPanelSerializer` registration in `extension.ts`). The
   * restored panel arrives without our webview options or HTML, so re-apply the
   * same options the create path uses, then route it through the shared
   * `adoptPanel` wiring so the message handler, dispose cleanup, and initial
   * render match a freshly-created panel exactly. If a panel is already open
   * (the user reopened it first), reveal that one and dispose the duplicate so
   * the singleton invariant holds.
   */
  revive(panel: vscode.WebviewPanel): void {
    if (this.panel) {
      // A live singleton already exists (the user reopened before restore, or VS
      // Code handed back several persisted duplicates): keep the existing panel
      // in its current column and dispose the incoming restore so a reload can
      // never stack a second panel — this also collapses legacy duplicates.
      this.panel.reveal(this.panel.viewColumn);
      panel.dispose();
      return;
    }
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ],
    };
    this.adoptPanel(panel);
  }

  /**
   * Shared post-creation wiring used by both `open()` (fresh panel) and
   * `revive()` (panel restored by the serializer). Tracks the singleton,
   * attaches the dispose cleanup and message handler, and renders the HTML so
   * the two entry points never drift.
   */
  private adoptPanel(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    this.panelWasVisible = panel.visible;
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'icon-source.png');

    panel.onDidDispose(
      () => {
        this.panel = undefined;
        this.panelWasVisible = false;
      },
      null,
      this.disposables,
    );

    // Re-push settings whenever the panel comes back ON SCREEN. Needed because
    // `retainContextWhenHidden: true` means the webview script never re-runs
    // (so its one-shot `getSettings` at load fires exactly once), while the
    // underlying `globalState` map is machine-wide and another window may have
    // changed it in the meantime.
    //
    // The FALSE -> TRUE transition guard is load-bearing: this event also fires
    // on editor-column moves and active/inactive changes, where `visible` stays
    // true throughout. Comparing against the tracked previous value means those
    // fire the event but not a `postSettings`, so dragging the tab between
    // groups or clicking around cannot produce a postSettings storm.
    panel.onDidChangeViewState(
      () => {
        const nowVisible = panel.visible;
        const becameVisible = nowVisible && !this.panelWasVisible;
        this.panelWasVisible = nowVisible;
        if (becameVisible) this.postSettings();
      },
      null,
      this.disposables,
    );

    // Re-push settings when this VS Code window gains focus. globalState is
    // machine-wide but Memento has no onDidChange event, so a save in window A
    // is invisible to window B until B actively re-reads. Refreshing on focus
    // covers the common alt-tab workflow: edit in one window, switch to another,
    // and the panel shows the current values immediately.
    vscode.window.onDidChangeWindowState(
      (state) => {
        if (state.focused && panel.visible) this.postSettings();
      },
      null,
      this.disposables,
    );

    panel.webview.onDidReceiveMessage(
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
    // Webview-safe URI for the Session page hero banner image. Computed
    // unconditionally; if `media/cover.png` is absent the webview simply skips
    // rendering the hero (see `renderGeneral`), so a missing file never throws.
    const coverUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'cover.png'),
    ).toString();
    // Webview-safe URI for the War Room tab hero banner image. Computed
    // unconditionally like `coverUri`; if `media/warroom-banner.png` is absent
    // the webview simply skips rendering the banner (see `renderWarRoom`), so a
    // missing file never throws.
    const warRoomBannerUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'warroom-banner.png'),
    ).toString();
    const nonce = this.makeNonce();
    // Extension version from the authoritative source: the bundled VERSION file
    // at the extension root. Falls back to package.json (via the activated
    // extension manifest), then 'dev', so the value never renders as
    // "undefined" when the file is missing.
    const version = this.readBundledVersion();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data: https:`,
    ].join('; ');

    this.panel.webview.html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <title>Ghola</title>
    <style>${await this.loadStyles()}</style>
  </head>
  <body>
    <div id="app" data-version="${version}" data-cover-uri="${coverUri}" data-warroom-banner-uri="${warRoomBannerUri}"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }

  /**
   * Read the bundled VERSION file (the source of truth for the extension
   * version) from the extension root. Falls back to package.json's version,
   * then 'dev', so the panel always holds a non-empty version string.
   */
  private readBundledVersion(): string {
    try {
      const raw = fsSync.readFileSync(
        path.join(this.context.extensionPath, 'VERSION'),
        'utf-8',
      );
      const trimmed = raw.trim();
      if (trimmed) return trimmed;
    } catch {
      // fall through to package.json / 'dev'
    }
    return (this.context.extension?.packageJSON?.version as string | undefined) ?? 'dev';
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
        await this.saveSettings(msg.values, msg.changedKeys);
        break;
      case 'getComposedPrompt':
        this.postComposedPrompt(msg.agent);
        break;
      case 'reloadModules':
        await vscode.commands.executeCommand('ghola.reloadModules');
        // Re-push settings VALUES too, not just the re-discovered module list.
        // `globalState` is machine-wide, so the panel's `settingsValues` may be
        // a stale snapshot of what another window has since changed; the Modules
        // tab's refresh control is the operator's explicit "resync me" gesture,
        // so it must resync values as well as modules.
        this.postSettings();
        break;
      case 'copyNewModulePrompt':
        await this.copyNewModulePrompt();
        break;
      case 'uploadModule':
        await this.uploadModule();
        break;
      case 'openSession':
        await vscode.commands.executeCommand('ghola.openSession');
        break;
      case 'updateExtension':
        await vscode.commands.executeCommand('ghola.updateExtension');
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
        await vscode.commands.executeCommand('ghola.atlassianSuite.setJiraToken');
        break;
      case 'atlassianClearJiraToken':
        await vscode.commands.executeCommand('ghola.atlassianSuite.clearJiraToken');
        break;
      case 'atlassianSetBitbucketToken':
        await vscode.commands.executeCommand('ghola.atlassianSuite.setBitbucketToken');
        break;
      case 'atlassianClearBitbucketToken':
        await vscode.commands.executeCommand('ghola.atlassianSuite.clearBitbucketToken');
        break;
      // ── Multi-token Bitbucket list operations ── The bridge mutators fire
      // onDidChangeAtlassianTokenStatus (which re-broadcasts the masked list)
      // and, for value-changing ops, onDidChangeValidation. The token VALUE
      // arrives INBOUND only and is handed straight to the host-side bridge;
      // it is never echoed back or logged.
      case 'atlassianAddBitbucketToken':
        await this.atlassianBridge.addBitbucketToken(msg.label, msg.value);
        break;
      case 'atlassianRemoveBitbucketToken':
        await this.atlassianBridge.removeBitbucketToken(msg.id);
        break;
      case 'atlassianReplaceBitbucketToken':
        await this.atlassianBridge.replaceBitbucketTokenValue(msg.id, msg.value);
        break;
      case 'atlassianSetBitbucketTokenLabel':
        await this.atlassianBridge.setBitbucketTokenLabel(msg.id, msg.label);
        break;
      case 'atlassianReorderBitbucketTokens':
        await this.atlassianBridge.reorderBitbucketTokens(msg.order);
        break;
      case 'atlassianValidateBitbucketToken':
        // Fires onDidChangeValidation → the subscription broadcasts the merged
        // result, so no explicit post is needed here.
        await this.atlassianBridge.validateBitbucketToken(msg.id);
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
      case 'supportDiscoverPaths':
        await this.discoverSupportPaths();
        break;
      case 'obsidianDetectVault':
        await this.detectObsidianVault();
        break;
      case 'githubAuthLogin':
        this.launchGithubAuthLogin();
        break;
      case 'atlassianValidate':
        // Execute the command registered by SWE-1. The bridge fires onDidChangeValidation
        // when done, which the constructor subscription above will broadcast.
        // We do NOT call bridge.validate() directly so that all telemetry / hooks
        // stay routed through the single command path.
        await vscode.commands.executeCommand('ghola.atlassianSuite.validateToken');
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
      case 'requestWarRoom':
        await this.postWarRoom(msg.subject);
        break;
      case 'gholaAwakenAll':
        await this.requestGholaAwakenAll();
        break;
      case 'gholaResumeMission':
        await this.requestGholaResumeMission(msg.id);
        break;
      case 'requestGholaDetail':
        await this.postGholaDetail(msg.subject, msg.ghola);
        break;
      case 'gholaDirective':
        await this.requestGholaDirective(msg.text);
        break;
      case 'gholaDeclareDone':
        await this.requestGholaDeclareDone(msg.id);
        break;
      case 'gholaResolveEscalation':
        await this.requestGholaEscalationResolve(msg.id, msg.subject, msg.decision);
        break;
      case 'searchWorkspaceMembers':
        await this.searchWorkspaceMembers(msg.query);
        break;
      default:
        this.logger?.appendLine(`[panel] unknown message: ${JSON.stringify(msg)}`);
    }
  }

  // ─── CLI alias registry ──────────────────────────────────────────────

  /**
   * Validate every entry, then persist to `ghola.cliAliases` and rewrite the
   * managed block in `ghola.aliasFile`. Surfaces validation and fs errors
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
        .getConfiguration('ghola')
        .update('cliAliases', aliases, vscode.ConfigurationTarget.Global);
      const aliasFile = vscode.workspace
        .getConfiguration('ghola')
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
    const cfg = vscode.workspace.getConfiguration('ghola');
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
        category: h.manifest.category,
        kind: h.manifest.kind,
        trigger: h.manifest.trigger,
        tier: h.manifest.tier,
        mutuallyExclusiveWith: h.manifest.mutuallyExclusiveWith,
        requires: h.manifest.requires,
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

    // Human/operator-facing setup guide — a top-level manifest field, loaded
    // here for the detail panel only and NEVER composed into agent prompts.
    // Resolved against the module root and gated by the SAME root-escape guard
    // the fragment loop uses so a malicious `../../` path is rejected.
    let setupGuide: { content: string; error?: string } | undefined;
    const setupGuidePath = handle.manifest.setupGuidePath;
    if (setupGuidePath) {
      const abs = path.join(handle.rootPath, setupGuidePath);
      if (!abs.startsWith(rootWithSep) && abs !== handle.rootPath) {
        setupGuide = { content: '', error: 'setupGuidePath escapes module root' };
      } else {
        try {
          setupGuide = { content: await fs.readFile(abs, 'utf-8') };
        } catch (e) {
          setupGuide = { content: '', error: (e as Error).message };
        }
      }
    }

    this.post({ type: 'moduleDetail', moduleId, fragments, setupGuide });
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
    const values = readModuleSettings(this.context.globalState, this.context.workspaceState);
    const cfg = vscode.workspace.getConfiguration('ghola');
    const cliCommand = cfg.get<string>('cliCommand', 'claude');
    const sessionCommand = cfg.get<string>('sessionCommand', 'initiate');
    const permissionMode = cfg.get<string>('permissionMode', 'bypassPermissions');
    // Nothing Remote-Control-shaped is shipped to the panel: Remote Control is
    // mandatory (the launcher appends `--remote-control` unconditionally) and its
    // session name is derived from the git branch at launch time, so there is
    // neither an enablement flag nor a name for the panel to render.
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
      permissionMode,
      swe,
      qa,
      aliases,
      selectedAlias,
      aliasFile,
    });
  }

  /**
   * Persist module setting values.
   *
   * `changedKeys` (when the webview names it) is the anti-clobber path: the
   * incoming `values` map is a SNAPSHOT the webview took when it last loaded
   * settings, and `globalState` is shared by every VS Code window on the
   * machine. Writing the snapshot back wholesale therefore erases whatever a
   * sibling window changed since — so instead we re-read the live map here and
   * fold ONLY the named keys onto it (see `mergeChangedModuleSettings`, which
   * also documents the delete-vs-empty-string semantics).
   *
   * When `changedKeys` is absent the legacy whole-map replace is preserved
   * verbatim, so callers that cannot name their key behave exactly as before.
   */
  private async saveSettings(
    values: Record<string, unknown>,
    changedKeys?: string[],
  ): Promise<void> {
    try {
      const next =
        changedKeys === undefined
          ? values
          : mergeChangedModuleSettings(
              readModuleSettings(this.context.globalState, this.context.workspaceState),
              values,
              changedKeys,
            );
      await writeModuleSettings(this.context.globalState, next);
      this.post({ type: 'settingsSaved', ok: true });
      // Module settings changed — the modified flag may have flipped.
      this.recomputeModified();
      this.postConfigurations();
      // Broadcast fresh composed prompts after settings change per architecture spec.
      this.broadcastComposedPrompts();
      // Signal extension.ts subscribers that module settings changed.
      this.moduleSettingsEmitter.fire();
    } catch (err) {
      this.post({ type: 'settingsSaved', ok: false, error: (err as Error).message });
    }
  }

  /**
   * Host-side auto-discovery of Support-mode app repo paths. Scans the
   * filesystem (see `discoverAppPaths`) for every UNMAPPED `mode.support` app —
   * a key whose `appMap` value is empty/whitespace — and writes any found path
   * back into the `appMap` setting. NEVER overwrites an existing non-empty
   * path. On success it mirrors the `saveSettings` refresh side effects (fresh
   * settings + configurations + composed prompts + module-settings event) and
   * replies with a `supportDiscoveryResult`. Discovery itself never throws;
   * this wrapper also guards the write path and still posts a result (with an
   * `error`) on any fault.
   */
  private async discoverSupportPaths(): Promise<void> {
    try {
      const flat = readModuleSettings(this.context.globalState, this.context.workspaceState);
      const appMap = (flat['mode.support::appMap'] as Record<string, string>) ?? {};
      // Derive keys from the current appMap; if empty, fall back to the module
      // defaults so a pristine session can still discover the known apps.
      const keys = Object.keys(appMap).length > 0
        ? Object.keys(appMap)
        : ['CMMS', 'HITS', 'TPS', 'MCP'];
      // Only discover for keys with no usable path yet.
      const emptyKeys = keys.filter((k) => {
        const v = appMap[k];
        return v === null || v === undefined || String(v).trim() === '';
      });

      const result = await discoverAppPaths(emptyKeys);

      // Merge — never clobber an already non-empty path.
      const nextMap: Record<string, string> = { ...appMap };
      for (const [k, v] of Object.entries(result.found)) {
        if (!nextMap[k] || !String(nextMap[k]).trim()) nextMap[k] = v;
      }
      const next = { ...flat, ['mode.support::appMap']: nextMap };
      await writeModuleSettings(this.context.globalState, next);

      // Mirror the saveSettings refresh side effects so the panel + prompts
      // reflect the newly written paths.
      this.postSettings();
      this.recomputeModified();
      this.postConfigurations();
      this.broadcastComposedPrompts();
      this.moduleSettingsEmitter.fire();

      this.post({
        type: 'supportDiscoveryResult',
        found: result.found,
        notFound: result.notFound,
        scanned: result.scanned,
        error: result.error,
      });
    } catch (err) {
      const message = (err as Error)?.message ?? 'discovery failed';
      this.logger?.appendLine(`[panel] discoverSupportPaths failed: ${message}`);
      this.post({
        type: 'supportDiscoveryResult',
        found: {},
        notFound: [],
        scanned: 0,
        error: message,
      });
    }
  }

  /**
   * Host-side auto-discovery of an Obsidian vault. Scans the filesystem (see
   * `discoverObsidianVault`) for a directory containing a `.obsidian/` marker
   * and, when one is chosen, WRITES it into the `tool.obsidian-notes`
   * `vaultPath` setting. Unlike Support's empty-only guard, this is an explicit
   * user action (the "Detect Vault" button), so it overwrites any existing
   * value. On a found vault it mirrors the `saveSettings` refresh side effects
   * (fresh settings + configurations + composed prompts + module-settings
   * event) and replies with an `obsidianVaultResult`. Discovery itself never
   * throws; this wrapper also guards the write path and still posts a result
   * (with an `error`) on any fault.
   */
  private async detectObsidianVault(): Promise<void> {
    try {
      const flat = readModuleSettings(this.context.globalState, this.context.workspaceState);

      const result = await discoverObsidianVault();

      // Only write when a vault was actually found; leave the setting as-is
      // otherwise (do not clobber a user value with an empty result).
      if (result.vaultPath) {
        const next = { ...flat, ['tool.obsidian-notes::vaultPath']: result.vaultPath };
        await writeModuleSettings(this.context.globalState, next);

        // Mirror the saveSettings refresh side effects so the panel + prompts
        // reflect the newly written path.
        this.postSettings();
        this.recomputeModified();
        this.postConfigurations();
        this.broadcastComposedPrompts();
        this.moduleSettingsEmitter.fire();
      }

      this.post({
        type: 'obsidianVaultResult',
        vaultPath: result.vaultPath,
        candidates: result.candidates,
        scanned: result.scanned,
        error: result.error,
      });
    } catch (err) {
      const message = (err as Error)?.message ?? 'vault discovery failed';
      this.logger?.appendLine(`[panel] detectObsidianVault failed: ${message}`);
      this.post({
        type: 'obsidianVaultResult',
        vaultPath: null,
        candidates: [],
        scanned: 0,
        error: message,
      });
    }
  }

  /**
   * Handle the `githubAuthLogin` message: open (or reuse) a named terminal and
   * start the interactive `gh auth login` flow in it. `gh auth login` cannot run
   * headlessly, so we never exec it or capture output — the user completes the
   * browser/token flow in the terminal. This only launches the official gh
   * command; it handles no tokens itself.
   */
  private launchGithubAuthLogin(): void {
    const terminalName = 'GitHub Login';
    const existing = vscode.window.terminals.find((t) => t.name === terminalName);
    const terminal = existing ?? vscode.window.createTerminal({ name: terminalName });
    terminal.show();
    terminal.sendText('gh auth login', true);
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
   * can read them via the `$GHOLA_TPM_PROMPT_FILE`, `$GHOLA_SWE_PROMPT_FILE`,
   * and `$GHOLA_QA_PROMPT_FILE` env vars.
   *
   * Filenames carry TWO suffix groups (see `resolveAgentPromptFilePath`): a hash
   * of the workspace folder path, so concurrent sessions in different VS Code
   * windows cannot collide, AND a per-EXTENSION-HOST-INSTANCE token, so two
   * windows or profiles on the SAME folder cannot either. The paths are therefore
   * stable for the life of this extension host — not across launches in general:
   * a window reload mints a new instance token and so a new set of paths. Within
   * one host, repeated invocations overwrite the previous prompts cleanly, which
   * is safe only because a single host hosts at most one live session terminal.
   *
   * Fail-closed: if any write fails the caller should abort the launch so a
   * terminal never opens against partial state.
   */
  async writeAllAgentPromptFiles(): Promise<{ tpm: string; swe: string; qa: string }> {
    const settings = this.getComposeSettings();
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
    const prompt = this.composer.compose(agent, this.getComposeSettings());
    this.post({ type: 'composedPromptUpdated', agent, prompt });
  }

  /** Returns the current module settings dict, keyed by `moduleId::fieldKey`. */
  private getCurrentSettings(): Record<string, Record<string, unknown>> {
    const flat = readModuleSettings(this.context.globalState, this.context.workspaceState);
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

  /**
   * The settings dict handed to `composer.compose`. This is `getCurrentSettings`
   * plus host-materialized `mode.war` defaults.
   *
   * The composer renders a module's parameters as `(defaults)` when the user
   * has no overrides, so a pristine War Mode session would hide its five
   * sub-toggles (autoOpenWarRoom / tournament / maxConcurrentGholas / dryRun /
   * autoVerify)
   * from TPM — yet those values gate real autonomous behavior. To fix this we
   * resolve `mode.war`'s schema defaults from the loaded manifest and layer
   * any user overrides on top, so all five keys always render with concrete
   * values in the Session Manifest.
   *
   * This is deliberately NARROW to `mode.war`: materializing defaults for
   * every module would bloat every prompt. It also lives here (compose-time)
   * rather than in `getCurrentSettings` so preset save/apply and
   * modified-detection continue to see only genuine user overrides — the
   * injected defaults never masquerade as user configuration.
   */
  /**
   * Whether War Mode is on. Source of truth is the `mode.war::enabled`
   * setting value (default false) in the module-settings store — NOT
   * `loader.isEnabled`. mode.war is configured as an Agents configuration,
   * not toggled as a module, so no ghola gate keys off loader state.
   */
  private isGholaEnabled(): boolean {
    const flat = readModuleSettings(this.context.globalState, this.context.workspaceState);
    return flat[`${GHOLA_MODE_ID}::enabled`] === true;
  }

  private getComposeSettings(): Record<string, Record<string, unknown>> {
    const settings = this.getCurrentSettings();
    if (!this.isGholaEnabled()) return settings;
    // Still read the manifest for the settings SCHEMA/DEFAULTS — only the
    // ENABLED decision moved to the setting.
    const schema = this.loader.find(GHOLA_MODE_ID)?.manifest.contributes?.settings;
    if (!schema) return settings;

    const resolved: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(schema)) {
      // Skip fields without a declared default so we never render a literal
      // "undefined"; every mode.war field currently declares one.
      if (field.default !== undefined) resolved[key] = field.default;
    }
    // User overrides win over schema defaults.
    Object.assign(resolved, settings[GHOLA_MODE_ID] ?? {});
    return { ...settings, [GHOLA_MODE_ID]: resolved };
  }

  // ─── War Room (War Mode) ────────────────────────────────────────────

  /**
   * Resolve `mode.war`'s five sub-toggles to concrete values, always. Reads
   * the compose-time resolved settings (schema defaults layered with user
   * overrides) and coerces each key to its declared type with a hardcoded
   * fallback so the snapshot never carries `undefined`. Used both for the War
   * Room's control-zone display and (via `getResolvedGholaSettings`) the RUN
   * auto-open gate.
   */
  private gholaSettingsSnapshot(): WarRoomSettings {
    const g = (this.getComposeSettings()[GHOLA_MODE_ID] ?? {}) as Record<string, unknown>;
    return {
      autoOpenWarRoom: typeof g.autoOpenWarRoom === 'boolean' ? g.autoOpenWarRoom : true,
      tournament: typeof g.tournament === 'boolean' ? g.tournament : false,
      maxConcurrentGholas: typeof g.maxConcurrentGholas === 'number' ? g.maxConcurrentGholas : 0,
      dryRun: typeof g.dryRun === 'boolean' ? g.dryRun : false,
      autoVerify: typeof g.autoVerify === 'boolean' ? g.autoVerify : false,
    };
  }

  /**
   * Resolved `mode.war` sub-toggles when the `mode.war::enabled` setting is
   * on, else null.
   * The RUN path uses this to gate War Room auto-open: null (disabled) short-
   * circuits, and a truthy `autoOpenWarRoom` triggers the reveal.
   */
  getResolvedGholaSettings(): WarRoomSettings | null {
    if (!this.isGholaEnabled()) return null;
    return this.gholaSettingsSnapshot();
  }

  /**
   * Reveal the settings panel and ask the webview to switch to the War Room
   * section. Safe to call whether or not a panel is currently open — `open()`
   * creates or reveals the singleton, then the `revealSection` message routes
   * the webview to the tab (the webview requests its own War Room data on
   * arrival). Never throws.
   */
  revealWarRoom(): void {
    this.open();
    this.post({ type: 'revealSection', section: 'warroom' });
  }

  /**
   * Read the ghola ledger for one subject and post a `warRoomData` payload to
   * the webview.
   *
   * Ledger resolution: the root is resolved GLOBALLY (GHOLA_LEDGER_ROOT env, else
   * the `tool.obsidian-notes` `vaultPath` setting -> <vault>/_Gholas, else
   * <homedir>/.ghola/ledger) — the SAME resolution the CLI and launcher use, and
   * NEVER the open work repo. When that ledger dir does not exist or has no
   * subject directories, we post `{ empty: true }`. Control is now PER-SUBJECT
   * (<root>/<subject>/control.json), so it is read only once a subject resolves;
   * an empty ledger carries no control (there is no subject to key the Awaken-All
   * / Declare-Done / resume / directive banners off yet).
   *
   * Parsing is done directly in TS (no child_process): a small self-contained
   * frontmatter reader over `<root>/<subject>/*.md` (skipping `_missions.md`
   * and `operating-notes.md`) plus `<root>/_archive/<subject>/*.md` for
   * archived gholas, and a block parser over `<root>/<subject>/_missions.md`.
   * Both are tolerant of a truncated trailing line (the watcher may fire mid-
   * append): unreadable ghola files are skipped and malformed mission blocks
   * are dropped rather than throwing.
   *
   * Subject selection: the passed `subject` when it matches a live subject
   * dir, else the subject whose most-recent open mission is newest, else the
   * first subject alphabetically.
   */
  async postWarRoom(subject?: string): Promise<void> {
    if (!this.panel) return;
    // Sticky selection: an explicit subject (from a `requestWarRoom` message)
    // is remembered so later internal refreshes (which all call this with no
    // argument) keep showing the operator's chosen subject instead of
    // reverting to the auto-pick. When no explicit subject is passed, reuse the
    // last remembered one.
    if (subject !== undefined) this.lastRequestedSubject = subject;
    const effectiveSubject = subject ?? this.lastRequestedSubject;
    try {
      const data = await this.buildWarRoomData(effectiveSubject);
      // Reconcile the sticky selection to the subject actually RENDERED. When
      // we were targeting a specific subject (effectiveSubject defined) but it
      // could not be resolved and buildWarRoomData fell back to another
      // subject, sync the sticky value to what is shown so a later reappearance
      // of the old subject does not snap the view back. Trace: select B ->
      // renders B, sticky=B; B disappears -> refresh renders A (fallback),
      // sticky becomes A; B reappears -> refresh renders A (sticky=A), no
      // snap-back. Initial-load auto-pick (effectiveSubject undefined) is left
      // untouched so it keeps following the most-recent-open mission until the
      // operator explicitly picks a subject.
      //
      // Late-completion guard: postWarRoom is async, so two builds can finish
      // out of order. If a NEWER explicit request has already superseded this
      // build's subject (this.lastRequestedSubject moved off the value we were
      // serving), do NOT write back - otherwise a stale build resolving late
      // would clobber the newer selection with its own fallback. Trace: pick B
      // (unresolvable) then pick C (valid); C resolves first (sticky=C); B's
      // stale build resolves and, without this guard, would overwrite sticky
      // with its fallback A. Comparing against the captured effectiveSubject
      // (stable for this invocation) skips that stale write-back.
      if (
        effectiveSubject !== undefined &&
        typeof data.subject === 'string' &&
        this.lastRequestedSubject === effectiveSubject
      ) {
        this.lastRequestedSubject = data.subject;
      }
      this.post({ type: 'warRoomData', data });
    } catch (err) {
      this.logger?.appendLine(`[panel] postWarRoom failed: ${(err as Error).message}`);
      this.post({ type: 'warRoomData', data: { empty: true } });
    }
  }

  /**
   * Resolve the War Mode ledger root GLOBALLY, by delegating to the SHARED
   * resolver in `src/session/host-path.ts` — the same call the session launcher
   * (the ledger's writer, via the env it exports to the CLI) and the
   * activation-time ledger watchers make, so the precedence and the host-path
   * normalization can never drift between them. See that module for the
   * precedence table and for why translating the path matters on win32.
   *
   * This wrapper exists only to bind the panel's state + log prefix and to drop
   * the vault provenance, which the host does not need. NEVER resolves under the
   * open work repo — no `.ghola/` is read from or written to the workspace.
   */
  private resolveLedgerRoot(): string {
    return resolveLedgerRoot(this.context.globalState, this.context.workspaceState, (m) =>
      this.logger?.appendLine(`[panel] ${m}`),
    ).root;
  }

  /**
   * Resolve which subject the per-subject control file belongs to for a control
   * WRITE (Awaken-All / Resume / Directive / Declare Done). Mirrors
   * `buildWarRoomData`'s subject selection so a button acts on the subject the
   * War Room is currently rendering: the sticky operator selection when it names
   * a live subject, else the subject whose most-recent open mission is newest,
   * else the first subject alphabetically. Returns `undefined` when the ledger
   * has no subjects yet (nothing to control) — callers no-op in that case rather
   * than writing to the work repo.
   */
  private resolveControlSubject(root: string): string | undefined {
    const subjects = listLedgerSubjects(root);
    if (subjects.length === 0) return undefined;
    const sticky = this.lastRequestedSubject;
    if (sticky && subjects.includes(sticky)) return sticky;
    return pickSubjectByRecentOpenMission(root, subjects) ?? subjects[0]!;
  }

  private async buildWarRoomData(subject?: string): Promise<WarRoomData> {
    // The ledger root is resolved GLOBALLY (vault/home), NOT from the work repo.
    // Control is now per-subject under the ledger root, so it can only be read
    // once a subject resolves — an empty ledger (no subjects) therefore carries
    // no control (the banners have no subject to key off yet), which is fine:
    // the buttons only appear once a mission/crew exists for a subject.
    const root = this.resolveLedgerRoot();
    if (!root || !fsSync.existsSync(root)) return { empty: true };

    const subjects = listLedgerSubjects(root);
    if (subjects.length === 0) return { empty: true };

    const target =
      subject && subjects.includes(subject)
        ? subject
        : pickSubjectByRecentOpenMission(root, subjects) ?? subjects[0]!;

    // Per-subject cooperative-control state (<root>/<target>/control.json).
    const control = await this.readControlState(root, target);

    // ALL missions (open + done) — the Mission Library / resume picker needs
    // the full history. Callers that want "the current mission" (the mission
    // header, the sub-purpose map) filter for `status === 'open'` themselves.
    const missions = parseMissionsSafe(readFileSyncOr(missionsPath(root, target), ''));
    const roster = collectRoster(root, target);
    const counts = countByState(roster);
    const alerts = parseAlertsSafe(readFileSyncOr(alertsPath(root, target), ''));
    const ownership = parseOwnershipSafe(readFileSyncOr(ownershipFilePath(root, target), ''));
    const escalations = parseEscalationsSafe(readFileSyncOr(escalationsFilePath(root, target), ''));

    // Self-tuning operating notes for the resolved subject only (read-only
    // War Room display) — tolerant of a missing/unreadable file, and omitted
    // entirely (rather than sent as an empty string) when there is no note
    // content yet, so the webview's `data.operatingNotes` truthiness check
    // doubles as the render gate.
    const operatingNotesRaw = readFileSyncOr(operatingNotesPath(root, target), '');
    const operatingNotes = operatingNotesRaw.trim() ? operatingNotesRaw : undefined;

    const settings: WarRoomSettings = this.gholaSettingsSnapshot();

    return {
      ledgerRoot: root,
      subject: target,
      // Every ledger subject (already sorted by listLedgerSubjects) so the War
      // Room switcher can reach subjects other than the auto-picked/target one.
      subjects,
      missions,
      roster,
      counts,
      settings,
      alerts,
      ...(ownership.length ? { ownership } : {}),
      ...(escalations.length ? { escalations } : {}),
      ...(operatingNotes ? { operatingNotes } : {}),
      ...(control ? { control } : {}),
    };
  }

  /**
   * Read `<ledger-root>/<subject>/control.json` (the per-subject cooperative
   * control file, resolved GLOBALLY — never from the work repo) and return its
   * full resolved shape (awaken-all fields plus the resume/directive/declare-done fields),
   * or `undefined` when the file is absent, unparseable, or parses to an
   * empty object. Never throws.
   *
   * `awakenAll` defaults to `false` rather than gating the whole return value:
   * the resume/directive/declareDone RMW writers (`requestGholaResumeMission`
   * / `requestGholaDirective` / `requestGholaDeclareDone`) all start from `{}`
   * when no control.json exists yet, so the FIRST such write produces a file
   * with no `awakenAll` key at all. Requiring `awakenAll` to be a boolean
   * would reject that file and hide the War Room's pending indicator until an
   * awaken (or a CLI `--ack`) happened to populate `awakenAll` too. Instead we
   * return a control object whenever the parsed JSON is a non-empty object
   * that carries at least one recognized control field (any of
   * awakenAll/resumeMission/directive/declareDone or their timestamp/ack
   * companions); an empty object (or a file with no recognized fields at all)
   * still returns `undefined` so a stray/unrelated JSON blob doesn't spuriously
   * light up the control zone.
   */
  private async readControlState(
    root: string,
    subject: string,
  ): Promise<NonNullable<WarRoomData['control']> | undefined> {
    const controlPath = path.join(ledgerSubjectDir(root, subject), 'control.json');
    try {
      const raw = await fs.readFile(controlPath, 'utf-8');
      const parsed = JSON.parse(raw) as {
        awakenAll?: unknown;
        requestedAt?: unknown;
        acknowledgedAt?: unknown;
        resumeMission?: unknown;
        resumeRequestedAt?: unknown;
        resumeAcknowledgedAt?: unknown;
        directive?: unknown;
        directiveRequestedAt?: unknown;
        directiveAcknowledgedAt?: unknown;
        declareDone?: unknown;
        declareDoneRequestedAt?: unknown;
        declareDoneAcknowledgedAt?: unknown;
        escalationResolve?: unknown;
        escalationResolveRequestedAt?: unknown;
        escalationResolveAcknowledgedAt?: unknown;
      };
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        Object.keys(parsed).length === 0
      ) {
        return undefined;
      }

      const recognized =
        'awakenAll' in parsed ||
        'requestedAt' in parsed ||
        'acknowledgedAt' in parsed ||
        'resumeMission' in parsed ||
        'resumeRequestedAt' in parsed ||
        'resumeAcknowledgedAt' in parsed ||
        'directive' in parsed ||
        'directiveRequestedAt' in parsed ||
        'directiveAcknowledgedAt' in parsed ||
        'declareDone' in parsed ||
        'declareDoneRequestedAt' in parsed ||
        'declareDoneAcknowledgedAt' in parsed ||
        'escalationResolve' in parsed ||
        'escalationResolveRequestedAt' in parsed ||
        'escalationResolveAcknowledgedAt' in parsed;
      if (!recognized) return undefined;

      const out: NonNullable<WarRoomData['control']> = {
        awakenAll: typeof parsed.awakenAll === 'boolean' ? parsed.awakenAll : false,
      };
      if (typeof parsed.requestedAt === 'string') out.requestedAt = parsed.requestedAt;
      if (typeof parsed.acknowledgedAt === 'string') out.acknowledgedAt = parsed.acknowledgedAt;
      if (typeof parsed.resumeMission === 'string' || parsed.resumeMission === null) {
        out.resumeMission = parsed.resumeMission;
      }
      if (typeof parsed.resumeRequestedAt === 'string') {
        out.resumeRequestedAt = parsed.resumeRequestedAt;
      }
      if (typeof parsed.resumeAcknowledgedAt === 'string') {
        out.resumeAcknowledgedAt = parsed.resumeAcknowledgedAt;
      }
      if (typeof parsed.directive === 'string' || parsed.directive === null) {
        out.directive = parsed.directive;
      }
      if (typeof parsed.directiveRequestedAt === 'string') {
        out.directiveRequestedAt = parsed.directiveRequestedAt;
      }
      if (typeof parsed.directiveAcknowledgedAt === 'string') {
        out.directiveAcknowledgedAt = parsed.directiveAcknowledgedAt;
      }
      if (typeof parsed.declareDone === 'string' || parsed.declareDone === null) {
        out.declareDone = parsed.declareDone;
      }
      if (typeof parsed.declareDoneRequestedAt === 'string') {
        out.declareDoneRequestedAt = parsed.declareDoneRequestedAt;
      }
      if (typeof parsed.declareDoneAcknowledgedAt === 'string') {
        out.declareDoneAcknowledgedAt = parsed.declareDoneAcknowledgedAt;
      }
      // escalationResolve is now a QUEUE (array of { id, subject, decision }).
      // Tolerant parse: within an array, entries missing a string
      // id/subject/decision are dropped rather than throwing. Mirroring the CLI,
      // an OLD single-object value (the pre-queue shape) carrying a valid
      // id+subject+decision is coerced into a 1-element array so a legacy
      // control.json written before the queue migration is still honored; any
      // other non-array value (null, a bad/2-field object, a bare string) leaves
      // the field omitted.
      // Mirror the CLI's validation (`scripts/ghola.mjs`): a valid resolve
      // entry's `decision` must be exactly 'approve' or 'deny'. The host only
      // ever WRITES those two values, so this only bites hand-edited/corrupt
      // control.json — an entry with any other `decision` (e.g. "maybe") is
      // dropped as invalid rather than surfaced, closing the host-vs-CLI
      // divergence.
      const isResolveEntry = (
        raw: unknown,
      ): raw is { id: string; subject: string; decision: 'approve' | 'deny' } =>
        !!raw &&
        typeof raw === 'object' &&
        !Array.isArray(raw) &&
        typeof (raw as { id?: unknown }).id === 'string' &&
        typeof (raw as { subject?: unknown }).subject === 'string' &&
        ((raw as { decision?: unknown }).decision === 'approve' ||
          (raw as { decision?: unknown }).decision === 'deny');
      if (Array.isArray(parsed.escalationResolve)) {
        const entries: { id: string; subject: string; decision: string }[] = [];
        for (const raw of parsed.escalationResolve) {
          if (isResolveEntry(raw)) {
            entries.push({ id: raw.id, subject: raw.subject, decision: raw.decision });
          }
        }
        out.escalationResolve = entries;
      } else if (isResolveEntry(parsed.escalationResolve)) {
        const e = parsed.escalationResolve;
        out.escalationResolve = [{ id: e.id, subject: e.subject, decision: e.decision }];
      }
      if (typeof parsed.escalationResolveRequestedAt === 'string') {
        out.escalationResolveRequestedAt = parsed.escalationResolveRequestedAt;
      }
      if (typeof parsed.escalationResolveAcknowledgedAt === 'string') {
        out.escalationResolveAcknowledgedAt = parsed.escalationResolveAcknowledgedAt;
      }
      return out;
    } catch {
      return undefined;
    }
  }

  /**
   * Serialize a control.json read-modify-write against concurrent writers.
   *
   * The host's War Room buttons and the `ghola` CLI's `*-ack` commands both do a
   * full-file read-modify-OVERWRITE of `<ledger-root>/<subject>/control.json`.
   * Without a shared lock, two writers read the same "before" state and the later
   * write clobbers the earlier one (a lost kill-switch, a lost escalation resolve).
   * This helper implements the EXACT lock protocol the CLI uses (`scripts/ghola.mjs`
   * `acquireControlLock`) on the co-located `<ledger-root>/<subject>/control.lock`,
   * so host and CLI mutually exclude. The protocol is ATOMIC and ownership-tokened -
   * there is no blind unlink that could delete a live lock:
   *   - Acquire: exclusive create via `fs.open(path, 'wx')`, then write a unique
   *     NONCE (`<pid>-<rand>-<epochMs>`) into the file and keep it for release.
   *     On EEXIST wait ~20ms and retry up to a ~2000ms timeout.
   *   - Stale takeover: a STALE lock (mtime older than ~5000ms) is a crashed
   *     holder, but we NEVER blind-unlink it (two contenders could both see it
   *     stale, both unlink+create, and one's release could then delete the
   *     other's LIVE lock). Instead we ATOMICALLY steal it: `fs.rename` the lock
   *     to a unique temp path. rename is atomic, so exactly one contender wins;
   *     losers get ENOENT and fall back into the acquire retry loop. The winner
   *     unlinks the stolen temp and retries the exclusive create.
   *   - Release: read the lock file and unlink it ONLY IF it STILL CONTAINS OUR
   *     nonce. If a stale-takeover handed the lock to someone else, their nonce
   *     is present and we leave it untouched, so we never delete a live lock.
   *
   * Fail-open on timeout / unexpected fs error: we log and still run `fn` (a
   * best-effort unsynchronized write) rather than dropping the operator's click or
   * hanging the extension, WITHOUT marking the lock acquired - so the release path
   * never touches a lock we do not own. A lost kill-switch/resolve is worse than a
   * rare unsynchronized write, and the ~2000ms budget only elapses under sustained
   * contention where the CLI holder should already have released. `fn` performs
   * its own read-modify-write of control.json; this helper only owns the lock's
   * lifecycle.
   */
  private async withControlLock(
    subjectDir: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    const gholaDir = subjectDir;
    const lockPath = path.join(gholaDir, 'control.lock');
    const timeoutMs = 2000;
    const staleMs = 5000;
    const backoffMs = 20;
    // Ownership token, unique per acquisition. Matches the CLI's nonce format
    // (`<pid>-<rand>-<epochMs>`) so host and CLI share the same steal/release
    // discipline on this file.
    const nonce = `${process.pid}-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms));

    try {
      await fs.mkdir(gholaDir, { recursive: true });
    } catch {
      // Directory creation failure is surfaced when fn's own write fails; do not
      // block lock acquisition on it.
    }

    const start = Date.now();
    let acquired = false;
    for (;;) {
      try {
        const handle = await fs.open(lockPath, 'wx');
        try {
          await handle.writeFile(nonce);
        } finally {
          await handle.close();
        }
        acquired = true;
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          // Unexpected fs error (e.g. permission): do not hang; proceed
          // best-effort without the lock.
          this.logger?.appendLine(
            `[panel] control lock: unexpected error on ${lockPath}, proceeding without lock: ${(err as Error).message}`,
          );
          break;
        }
        // Lock exists: take it over if it is stale (crashed holder), but never
        // by blind-unlink - steal it ATOMICALLY via rename so only one contender
        // wins and no live lock can be deleted out from under its owner.
        try {
          const st = await fs.stat(lockPath);
          if (Date.now() - st.mtimeMs > staleMs) {
            const tempStealPath = `${lockPath}.steal-${process.pid}-${Math.random()
              .toString(36)
              .slice(2)}-${Date.now()}`;
            try {
              await fs.rename(lockPath, tempStealPath);
              // Won the steal: remove the stolen stale lock, then retry create.
              await fs.unlink(tempStealPath).catch(() => {});
            } catch {
              // Lost the steal (another contender renamed first -> ENOENT):
              // fall through and retry the acquire loop.
            }
            continue;
          }
        } catch {
          continue; // lock vanished between EEXIST and stat: retry now
        }
        if (Date.now() - start > timeoutMs) {
          this.logger?.appendLine(
            `[panel] control lock: timed out after ${timeoutMs}ms on ${lockPath}; proceeding with best-effort write`,
          );
          break;
        }
        await sleep(backoffMs);
      }
    }

    try {
      await fn();
    } finally {
      if (acquired) {
        // Nonce-verified release: only unlink the lock if it still holds OUR
        // nonce. If a stale-takeover reassigned it, another owner's nonce is
        // present and we must leave it alone.
        try {
          const current = await fs.readFile(lockPath, 'utf-8');
          if (current === nonce) {
            await fs.unlink(lockPath).catch(() => {});
          }
        } catch {
          // Lock already gone or unreadable: nothing to release.
        }
      }
    }
  }

  /**
   * Atomically write `contents` to `filePath` via a temp-sibling + rename.
   *
   * A mid-write crash / ENOSPC can only ever truncate the TEMP file; the real
   * `filePath` is swapped in by a single `fs.rename`, which is atomic on the
   * same filesystem (guaranteed here because the temp sibling lives in the same
   * directory). So a reader (including the tolerant control.json parser) never
   * observes a half-written file: it sees either the OLD complete contents or
   * the NEW complete contents, never a truncated blob that would be misread as
   * "no control active". The temp name (`<filePath>.tmp-<pid>-<rand>`)
   * deliberately does NOT end in `control.json`, the filename the control
   * watcher's glob observes, so creating/renaming it triggers no spurious War
   * Room refresh. The temp file is unlinked in a finally so a failed rename
   * leaves no litter behind (after a successful rename the unlink is a harmless
   * ENOENT that we swallow).
   */
  private async atomicWriteJson(filePath: string, contents: string): Promise<void> {
    const tempPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    try {
      await fs.writeFile(tempPath, contents, 'utf-8');
      await fs.rename(tempPath, filePath);
    } finally {
      await fs.unlink(tempPath).catch(() => {});
    }
  }

  /**
   * Write the emergency "Awaken All" request into
   * `<ledger-root>/<subject>/control.json`: `{ awakenAll: true, requestedAt }`.
   * This is a read-modify-write (matching `requestGholaResumeMission` /
   * `requestGholaDirective`): the existing file (if any) is read first and
   * every other field (`resumeMission`, `directive`, their timestamps,
   * `acknowledgedAt`, etc.) is preserved verbatim; only `awakenAll` and
   * `requestedAt` are overwritten. This matters because an operator can click
   * Awaken All while a resume or directive request is still pending-unacked,
   * and a fresh-object write would silently clobber those. Creates the subject dir
   * if missing and never deletes the file — this is the host's own
   * extension-owned state file. Wrapped in try/catch so a write failure never
   * throws out of the message handler. Re-posts War Room data afterwards so
   * the UI reflects the pending request.
   */
  private async requestGholaAwakenAll(): Promise<void> {
    const root = this.resolveLedgerRoot();
    const subject = this.resolveControlSubject(root);
    if (!subject) {
      this.logger?.appendLine('[panel] gholaAwakenAll: no ledger subject resolved; skipping');
      return;
    }
    const dir = ledgerSubjectDir(root, subject);
    try {
      await this.withControlLock(dir, async () => {
      await fs.mkdir(dir, { recursive: true });
      const controlPath = path.join(dir, 'control.json');

      // Read-modify-write: start from whatever is already on disk (tolerant
      // of a missing/unparseable file — treat that as an empty object) so
      // unrelated fields like `resumeMission`/`directive` are never clobbered.
      let existing: Record<string, unknown> = {};
      try {
        const raw = await fs.readFile(controlPath, 'utf-8');
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>;
        }
      } catch {
        // Missing or unparseable — proceed with an empty base object.
      }

      const merged = {
        ...existing,
        awakenAll: true,
        requestedAt: new Date().toISOString(),
      };
      await this.atomicWriteJson(controlPath, JSON.stringify(merged, null, 2));
      });
    } catch (err) {
      this.logger?.appendLine(
        `[panel] gholaAwakenAll: failed to write control.json: ${(err as Error).message}`,
      );
    }
    await this.postWarRoom();
  }

  /**
   * Write a "Resume mission" request into `<ledger-root>/<subject>/control.json`:
   * `{ resumeMission: id, resumeRequestedAt }`. This is a read-modify-write —
   * the existing file (if any) is read first and every other field
   * (`awakenAll`, `requestedAt`, `acknowledgedAt`, and any prior resume
   * fields) is preserved verbatim; only `resumeMission` and
   * `resumeRequestedAt` are overwritten. Creates the subject dir if missing and
   * never deletes the file — this is the host's own extension-owned state
   * file. Wrapped in try/catch so a write failure never throws out of the
   * message handler. Re-posts War Room data afterwards so the picker shows
   * the pending indicator.
   */
  private async requestGholaResumeMission(id: string): Promise<void> {
    const root = this.resolveLedgerRoot();
    const subject = this.resolveControlSubject(root);
    if (!subject) {
      this.logger?.appendLine('[panel] gholaResumeMission: no ledger subject resolved; skipping');
      return;
    }
    const dir = ledgerSubjectDir(root, subject);
    try {
      await this.withControlLock(dir, async () => {
      await fs.mkdir(dir, { recursive: true });
      const controlPath = path.join(dir, 'control.json');

      // Read-modify-write: start from whatever is already on disk (tolerant
      // of a missing/unparseable file — treat that as an empty object) so
      // unrelated fields like `awakenAll` are never clobbered.
      let existing: Record<string, unknown> = {};
      try {
        const raw = await fs.readFile(controlPath, 'utf-8');
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>;
        }
      } catch {
        // Missing or unparseable — proceed with an empty base object.
      }

      const merged = {
        ...existing,
        resumeMission: id,
        resumeRequestedAt: new Date().toISOString(),
      };
      await this.atomicWriteJson(controlPath, JSON.stringify(merged, null, 2));
      });
    } catch (err) {
      this.logger?.appendLine(
        `[panel] gholaResumeMission: failed to write control.json: ${(err as Error).message}`,
      );
    }
    await this.postWarRoom();
  }

  /**
   * Write a god-console directive into `<ledger-root>/<subject>/control.json`:
   * `{ directive: text, directiveRequestedAt }`. Read-modify-write, mirroring
   * `requestGholaResumeMission`: the existing file (if any) is read first and
   * every other field (`awakenAll`, `resumeMission`, prior directive fields,
   * etc.) is preserved verbatim; only `directive` and `directiveRequestedAt`
   * are overwritten. Creates the subject dir if missing and never deletes the
   * file. Wrapped in try/catch so a write failure never throws out of the
   * message handler. Re-posts War Room data afterwards so the pending
   * directive is shown.
   */
  private async requestGholaDirective(text: string): Promise<void> {
    const root = this.resolveLedgerRoot();
    const subject = this.resolveControlSubject(root);
    if (!subject) {
      this.logger?.appendLine('[panel] gholaDirective: no ledger subject resolved; skipping');
      return;
    }
    const dir = ledgerSubjectDir(root, subject);
    try {
      await this.withControlLock(dir, async () => {
      await fs.mkdir(dir, { recursive: true });
      const controlPath = path.join(dir, 'control.json');

      let existing: Record<string, unknown> = {};
      try {
        const raw = await fs.readFile(controlPath, 'utf-8');
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>;
        }
      } catch {
        // Missing or unparseable — proceed with an empty base object.
      }

      const merged = {
        ...existing,
        directive: text,
        directiveRequestedAt: new Date().toISOString(),
      };
      await this.atomicWriteJson(controlPath, JSON.stringify(merged, null, 2));
      });
    } catch (err) {
      this.logger?.appendLine(
        `[panel] gholaDirective: failed to write control.json: ${(err as Error).message}`,
      );
    }
    await this.postWarRoom();
  }

  /**
   * Write a "Declare Done" request into `<ledger-root>/<subject>/control.json`:
   * `{ declareDone: id, declareDoneRequestedAt }`. Read-modify-write,
   * mirroring `requestGholaResumeMission` / `requestGholaDirective`: the
   * existing file (if any) is read first and every other field (`awakenAll`,
   * `resumeMission`, `directive`, prior declareDone fields, etc.) is preserved
   * verbatim; only `declareDone` and `declareDoneRequestedAt` are overwritten.
   * Creates the subject dir if missing and never deletes the file. Wrapped in
   * try/catch so a write failure never throws out of the message handler.
   * Re-posts War Room data afterwards so the mission header shows the
   * "Declaring done..." pending indicator in place of the button.
   */
  private async requestGholaDeclareDone(id: string): Promise<void> {
    const root = this.resolveLedgerRoot();
    const subject = this.resolveControlSubject(root);
    if (!subject) {
      this.logger?.appendLine('[panel] gholaDeclareDone: no ledger subject resolved; skipping');
      return;
    }
    const dir = ledgerSubjectDir(root, subject);
    try {
      await this.withControlLock(dir, async () => {
      await fs.mkdir(dir, { recursive: true });
      const controlPath = path.join(dir, 'control.json');

      let existing: Record<string, unknown> = {};
      try {
        const raw = await fs.readFile(controlPath, 'utf-8');
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>;
        }
      } catch {
        // Missing or unparseable — proceed with an empty base object.
      }

      const merged = {
        ...existing,
        declareDone: id,
        declareDoneRequestedAt: new Date().toISOString(),
      };
      await this.atomicWriteJson(controlPath, JSON.stringify(merged, null, 2));
      });
    } catch (err) {
      this.logger?.appendLine(
        `[panel] gholaDeclareDone: failed to write control.json: ${(err as Error).message}`,
      );
    }
    await this.postWarRoom();
  }

  /**
   * APPEND an escalation-resolution request into the queue in
   * `<ledger-root>/<subject>/control.json`:
   * `{ escalationResolve: [...prior, { id, subject, decision }], escalationResolveRequestedAt }`.
   * Read-modify-write, mirroring `requestGholaResumeMission` /
   * `requestGholaDirective` / `requestGholaDeclareDone`: the existing file (if
   * any) is read first and every other field (`awakenAll`, `resumeMission`,
   * `directive`, `declareDone`, etc.) is preserved verbatim.
   *
   * The escalationResolve field is a QUEUE, not a single slot: this method
   * APPENDS rather than overwrites, so resolving a second escalation while an
   * earlier one is still pending-unacked no longer clobbers the first (the
   * clobber bug this fixes). A prior queued entry with the same id+subject is
   * replaced in place rather than duplicated, so re-clicking a decision updates
   * it instead of stacking. Creates the subject dir if missing and never deletes the
   * file. Wrapped in try/catch so a write failure never throws out of the
   * message handler. Re-posts War Room data afterwards so the escalation shows a
   * pending indicator.
   */
  private async requestGholaEscalationResolve(
    id: string,
    subject: string,
    decision: 'approve' | 'deny',
  ): Promise<void> {
    // The decision belongs to the escalation's own subject (carried in the
    // webview message), so control is written to THAT subject's per-subject
    // control.json under the globally-resolved ledger root — never the work repo.
    const root = this.resolveLedgerRoot();
    const dir = ledgerSubjectDir(root, subject);
    try {
      await this.withControlLock(dir, async () => {
      await fs.mkdir(dir, { recursive: true });
      const controlPath = path.join(dir, 'control.json');

      let existing: Record<string, unknown> = {};
      try {
        const raw = await fs.readFile(controlPath, 'utf-8');
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>;
        }
      } catch {
        // Missing or unparseable: proceed with an empty base object.
      }

      // Start from the existing queue (tolerant: a non-array value, including a
      // legacy single object, resets to []), drop any prior entry with the same
      // id+subject, then append this decision.
      const priorRaw = (existing as { escalationResolve?: unknown }).escalationResolve;
      const prior = Array.isArray(priorRaw)
        ? (priorRaw as unknown[]).filter(
            (e): e is { id: string; subject: string; decision: string } =>
              !!e &&
              typeof e === 'object' &&
              typeof (e as { id?: unknown }).id === 'string' &&
              typeof (e as { subject?: unknown }).subject === 'string' &&
              typeof (e as { decision?: unknown }).decision === 'string',
          )
        : [];
      const queue = prior.filter((e) => !(e.id === id && e.subject === subject));
      queue.push({ id, subject, decision });

      const merged = {
        ...existing,
        escalationResolve: queue,
        escalationResolveRequestedAt: new Date().toISOString(),
      };
      await this.atomicWriteJson(controlPath, JSON.stringify(merged, null, 2));
      });
    } catch (err) {
      this.logger?.appendLine(
        `[panel] gholaResolveEscalation: failed to write control.json: ${(err as Error).message}`,
      );
    }
    await this.postWarRoom();
  }

  /**
   * Search Bitbucket workspace members and post the results to the webview.
   * Delegates to `BitbucketPrClient.searchWorkspaceMembers`; when the client
   * is unavailable (Atlassian integration not configured), posts an error.
   */
  private async searchWorkspaceMembers(query: string): Promise<void> {
    if (!this.bitbucketPrClient) {
      this.post({
        type: 'workspaceMembersResult',
        members: [],
        error: 'Bitbucket integration not configured',
      });
      return;
    }
    try {
      const result = await this.bitbucketPrClient.searchWorkspaceMembers({
        workspace: '',
        query,
      });
      if (result.status === 'ok' && result.members) {
        this.post({
          type: 'workspaceMembersResult',
          members: result.members.map((m) => ({
            accountId: m.accountId,
            displayName: m.displayName,
            avatarUrl: m.avatarUrl,
          })),
        });
      } else {
        this.post({
          type: 'workspaceMembersResult',
          members: [],
          error: result.message ?? `Workspace member search failed (${result.status})`,
        });
      }
    } catch (err) {
      this.logger?.appendLine(
        `[panel] searchWorkspaceMembers: ${(err as Error).message}`,
      );
      this.post({
        type: 'workspaceMembersResult',
        members: [],
        error: (err as Error).message,
      });
    }
  }

  /**
   * Read a single ghola's `.md` file for the War Room drill-in view and post
   * a `gholaDetail` message. Resolves the ledger root the same way
   * `buildWarRoomData` does (GLOBALLY — vault/home, never the work repo); when
   * there is no ledger dir, posts an absent-flagged detail rather than
   * throwing. Looks in the subject dir first, then falls back to
   * `_archive/<subject>/` (mirrors `collectRoster`'s two-directory scan).
   */
  private async postGholaDetail(subject: string, ghola: string): Promise<void> {
    if (!this.panel) return;
    const emptyDetail: GholaDetail = {
      subject,
      id: ghola,
      name: '',
      purpose: '',
      state: '',
      model: '',
      created: '',
      last_used: '',
      generation: 1,
      parent: null,
      reliability: 'pass:0 rework:0',
      missions: [],
      history: '',
      found: false,
    };
    try {
      const root = this.resolveLedgerRoot();
      if (!root || !fsSync.existsSync(root)) {
        this.post({ type: 'gholaDetail', data: emptyDetail });
        return;
      }

      const candidates = [
        path.join(ledgerSubjectDir(root, subject), `${ghola}.md`),
        path.join(ledgerArchiveSubjectDir(root, subject), `${ghola}.md`),
      ];
      let content: string | null = null;
      for (const candidate of candidates) {
        try {
          content = await fs.readFile(candidate, 'utf-8');
          break;
        } catch {
          continue;
        }
      }
      if (content === null) {
        this.post({ type: 'gholaDetail', data: emptyDetail });
        return;
      }

      this.post({ type: 'gholaDetail', data: parseGholaDetail(content, subject) });
    } catch (err) {
      this.logger?.appendLine(
        `[panel] postGholaDetail failed (${subject}/${ghola}): ${(err as Error).message}`,
      );
      this.post({ type: 'gholaDetail', data: emptyDetail });
    }
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

    // Strip the host-injected `tool.feedback-log.feedbackFilePath` from BOTH
    // sides: it is machine-specific runtime state, not user configuration, so
    // it must never count as a diff. The strip is symmetric so a seeded preset
    // (no stored path) and an older user config (path saved through the prior
    // injection) both compare equal to the current runtime state when pristine.
    const currentSettings = withoutInjectedFeedbackPath(this.getCurrentSettings());
    const expected = withoutInjectedFeedbackPath(active.settings);
    // Settings are global and merge-on-apply, so `current` legitimately carries
    // extra field values the preset never declared — credentials/identity, plus
    // leftover settings from other presets. A config counts as MODIFIED only
    // when a key the preset DOES declare differs; extras are ignored, so a
    // freshly-applied preset does not read as modified just because global
    // identity fields are present.
    return !this.presetSettingsSatisfied(expected, currentSettings);
  }

  /**
   * True when every module/field the preset declares in `expected` matches the
   * corresponding value in `current`. Keys present in `current` but absent from
   * `expected` are ignored (they are global field values that must not flip the
   * modified flag). A one-directional (subset) comparison, unlike the former
   * bidirectional `deepEquals`.
   */
  private presetSettingsSatisfied(
    expected: Record<string, Record<string, unknown>>,
    current: Record<string, Record<string, unknown>>,
  ): boolean {
    for (const [moduleId, fields] of Object.entries(expected)) {
      const cur = current[moduleId] ?? {};
      for (const [fieldKey, value] of Object.entries(fields)) {
        if (!deepEquals(cur[fieldKey], value)) return false;
      }
    }
    return true;
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
   * Resolve mutual-exclusivity conflicts within a preset's enabled-id list and
   * pull in required dependencies. Deterministic rule:
   *   1. Iterate `enabledIds` in stored order; keep a module only when it does
   *      not conflict (either direction of `mutuallyExclusiveWith`) with a
   *      module already kept. The FIRST-listed member of a conflicting group
   *      wins; later conflicting entries are dropped (and logged).
   *   2. Pull in each kept module's `requires` deps that aren't already present,
   *      resolved TRANSITIVELY (walk the full requires graph, not just one
   *      level). A dep is skipped when it is `mutuallyExclusiveWith` an
   *      already-kept module (either direction) so a transitively-pulled dep can
   *      never escape mutual exclusion; otherwise it is added.
   * Unknown ids (no live handle) are skipped; `pruneStaleConfigurationIds`
   * already strips those from stored presets.
   */
  private resolveConfigurationConflicts(enabledIds: string[]): string[] {
    const kept: string[] = [];
    const keptSet = new Set<string>();
    for (const candidateId of enabledIds) {
      const handle = this.loader.find(candidateId);
      if (!handle) continue;
      if (keptSet.has(candidateId)) continue;
      const excl = handle.manifest.mutuallyExclusiveWith ?? [];
      const conflicts = kept.some((keptId) => {
        if (excl.includes(keptId)) return true;
        const keptExcl = this.loader.find(keptId)?.manifest.mutuallyExclusiveWith ?? [];
        return keptExcl.includes(candidateId);
      });
      if (conflicts) {
        this.logger?.appendLine(
          `[panel] applyConfiguration: dropped '${candidateId}' — mutually exclusive with an earlier-listed module in the preset`,
        );
        continue;
      }
      kept.push(candidateId);
      keptSet.add(candidateId);
    }
    // Pull in requires deps TRANSITIVELY: walk the full requires graph (BFS)
    // so a chain like tool.qa-pr-learning -> integration.bitbucket-pr-comments
    // -> integration.atlassian-suite pulls in BOTH downstream deps, not just the
    // first level. Newly-appended deps are pushed onto the work queue so their
    // own requires are resolved in turn; `keptSet` doubles as the visited guard,
    // so a cyclic requires (a module that transitively requires something
    // already kept) terminates instead of looping forever.
    //
    // Mutex guard: a transitively-pulled dep must NOT escape mutual exclusion.
    // Because the mutex resolution above ran over `enabledIds` only (before this
    // walk), a dep pulled in here could be `mutuallyExclusiveWith` an
    // already-kept module and, added unconditionally, would violate the mutex.
    // So we SKIP a dep when it conflicts (either direction) with any kept
    // module. Not currently reachable (no mutex participant sits in a requires
    // chain today), but this closes the latent hole; when no conflict exists the
    // dep is still added, so `requires` behavior is otherwise identical.
    const requiresQueue = [...kept];
    while (requiresQueue.length > 0) {
      const keptId = requiresQueue.shift()!;
      const requires = this.loader.find(keptId)?.manifest.requires ?? [];
      for (const dep of requires) {
        if (keptSet.has(dep)) continue;
        const depHandle = this.loader.find(dep);
        if (!depHandle) continue;
        const depExcl = depHandle.manifest.mutuallyExclusiveWith ?? [];
        const conflictsWithKept = kept.some((otherId) => {
          if (depExcl.includes(otherId)) return true;
          const otherExcl = this.loader.find(otherId)?.manifest.mutuallyExclusiveWith ?? [];
          return otherExcl.includes(dep);
        });
        if (conflictsWithKept) {
          this.logger?.appendLine(
            `[panel] applyConfiguration: skipped required dep '${dep}' - mutually exclusive with a kept module`,
          );
          continue;
        }
        kept.push(dep);
        keptSet.add(dep);
        requiresQueue.push(dep);
      }
    }
    return kept;
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

    // Resolve any mutual-exclusivity conflicts the preset may carry before
    // applying it. The webview enforces exclusivity on manual toggle, but a
    // user-saved preset applied directly bypasses that enforcement, so a stale
    // preset could carry a conflicting set. Built-in presets are conflict-free.
    const targetEnabled = new Set(this.resolveConfigurationConflicts(target.enabledIds));
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
    // the `moduleId::fieldKey` shape stored in the (now GLOBAL) settings map.
    const flatSettings: Record<string, unknown> = {};
    for (const [moduleId, fields] of Object.entries(target.settings)) {
      for (const [fieldKey, value] of Object.entries(fields)) {
        flatSettings[`${moduleId}::${fieldKey}`] = value;
      }
    }
    // MERGE the preset's declared settings over the existing global map rather
    // than REPLACING it. Settings are global now, so a full replace would wipe
    // every field the preset does not declare — including credentials/identity
    // (Atlassian email, vault path, personas) that must persist across preset
    // applies and workspaces. The preset still authoritatively sets the keys it
    // declares; everything else is preserved. `computeIsModified` compares only
    // the preset-declared keys, so the preserved extras never read as "modified".
    const merged = {
      ...readModuleSettings(this.context.globalState, this.context.workspaceState),
      ...flatSettings,
    };
    await writeModuleSettings(this.context.globalState, merged);

    await this.configurations.setActiveId(id);
    this.recomputeModified();

    await this.postModules();
    this.postSettings();
    this.postConfigurations();
    this.broadcastComposedPrompts();
    // Signal extension.ts subscribers that settings changed via preset application.
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
   * Copy the user-configurable `ghola.newModulePrompt` text to the system
   * clipboard so the user can paste it into an AI chat to generate a new
   * Ghola module. Surfaces a non-modal info toast on success.
   */
  private async copyNewModulePrompt(): Promise<void> {
    const promptText = vscode.workspace
      .getConfiguration('ghola')
      .get<string>('newModulePrompt', '');
    await vscode.env.clipboard.writeText(promptText);
    vscode.window.showInformationMessage('Module-generation prompt copied to clipboard');
  }

  /**
   * Prompt the user to pick a folder (default: ~/Downloads), validate it
   * looks like a Ghola module, then copy it into the workspace modules
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
        'Selected folder has no manifest.json — not a valid Ghola module.',
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
    await vscode.commands.executeCommand('ghola.reloadModules');

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
      .getConfiguration('ghola')
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
   * Copy the user-configurable `ghola.linqpadInstallPrompt` text to the
   * system clipboard so the user can paste it into an AI chat (or a notes
   * app) to walk through a LINQPad install / connection-export. Mirrors the
   * `copyNewModulePrompt` UX exactly.
   */
  private async copyLinqpadInstallPrompt(): Promise<void> {
    const promptText = vscode.workspace
      .getConfiguration('ghola')
      .get<string>('linqpadInstallPrompt', '');
    await vscode.env.clipboard.writeText(promptText);
    vscode.window.showInformationMessage('LINQPad install prompt copied to clipboard');
  }

  // ─── Atlassian Suite token status ─────────────────────────────────────

  /**
   * Read both tokens on the host and post existence + a LAST-4 fingerprint to
   * the webview. The full token value is read here (host-side is allowed) purely
   * to derive its last 4 characters; ONLY that 4-char fragment is forwarded — the
   * full value never crosses the webview boundary and is never logged. The
   * fragment lets the operator confirm a token was actually replaced (its last 4
   * change) without exposing the secret.
   */
  private async broadcastAtlassianTokenStatus(): Promise<void> {
    if (!this.panel) return;
    // Jira: read the full value host-side purely to derive its last-4 (the value
    // never leaves the host). Bitbucket: use the bridge's MASKED summaries — the
    // full values never enter this method, so the multi-token list can only ever
    // forward id + label + last4 across the boundary.
    const [jiraToken, bitbucketSummaries] = await Promise.all([
      this.atlassianBridge.getJiraToken(),
      this.atlassianBridge.getBitbucketTokenSummaries(),
    ]);
    // Last 4 chars only, and only when the token is long enough that revealing
    // them leaks nothing meaningful; undefined otherwise.
    const last4 = (t?: string): string | undefined =>
      typeof t === 'string' && t.length >= 4 ? t.slice(-4) : undefined;
    this.post({
      type: 'atlassianTokenStatus',
      jiraSet: typeof jiraToken === 'string' && jiraToken !== '',
      jiraLast4: last4(jiraToken),
      bitbucketTokens: bitbucketSummaries.map((s) => ({
        id: s.id,
        label: s.label,
        set: true,
        // The summary's last4 is '' when the value is shorter than 4 chars;
        // normalize that to undefined so the UI shows the generic dots.
        last4: s.last4 !== '' ? s.last4 : undefined,
      })),
    });
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
      vscode.window.showErrorMessage(
        `Failed to update feedback entry: ${(err as Error).message}`,
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
      vscode.window.showErrorMessage(
        `Failed to delete feedback entry: ${(err as Error).message}`,
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

// ─── Ghola ledger parsing (War Room) ──────────────────────────────────────
//
// A self-contained, read-only mirror of the frontmatter + mission-block
// formats that `scripts/ghola.mjs` writes, so the extension host can build a
// War Room payload without spawning the CLI. Every reader tolerates a
// truncated trailing line (the file-watcher may fire mid-append): reads are
// wrapped in try/catch and malformed records are skipped rather than thrown.

/** Read a file synchronously, returning `fallback` on any error (ENOENT, partial). */
function readFileSyncOr(p: string, fallback: string): string {
  try {
    return fsSync.readFileSync(p, 'utf-8');
  } catch {
    return fallback;
  }
}

function ledgerSubjectDir(root: string, subject: string): string {
  return path.join(root, subject);
}

function ledgerArchiveSubjectDir(root: string, subject: string): string {
  return path.join(root, '_archive', subject);
}

function missionsPath(root: string, subject: string): string {
  return path.join(ledgerSubjectDir(root, subject), '_missions.md');
}

/** Path to a subject's alert log, mirroring the `_missions.md` convention. */
function alertsPath(root: string, subject: string): string {
  return path.join(ledgerSubjectDir(root, subject), 'alerts.md');
}

/** Path to a subject's ownership ledger, mirroring the `alerts.md` convention. */
function ownershipFilePath(root: string, subject: string): string {
  return path.join(ledgerSubjectDir(root, subject), 'ownership.md');
}

/** Path to a subject's escalations ledger, mirroring the `alerts.md` convention. */
function escalationsFilePath(root: string, subject: string): string {
  return path.join(ledgerSubjectDir(root, subject), 'escalations.md');
}

/**
 * Path to a subject's self-tuning operating notes, mirroring the CLI's
 * `notesFilePath` (see `cmdNote` in `ghola.mjs`).
 */
function operatingNotesPath(root: string, subject: string): string {
  return path.join(ledgerSubjectDir(root, subject), 'operating-notes.md');
}

/**
 * Parse a subject's `alerts.md` into `{ text, date }` records. The CLI (out
 * of band, in `scripts/ghola.mjs`) is the sole writer; this is a tolerant
 * reader that assumes one alert per Markdown list line in the form
 * `- YYYY-MM-DD: <text>` — mirroring the date-prefixed bullet convention used
 * elsewhere in this codebase (e.g. the agent switchboard inbox format). A
 * line missing the leading date is still surfaced (with an empty `date`)
 * rather than dropped, so a format drift on the CLI side degrades gracefully
 * instead of hiding alerts outright. Order is preserved exactly as written —
 * the CLI is trusted to append entries newest-last; this reader never
 * re-sorts. Blank lines and non-list lines are skipped. Returns `[]` on an
 * absent or empty file.
 */
function parseAlertsSafe(content: string): { text: string; date: string }[] {
  if (!content || !content.trim()) return [];
  const out: { text: string; date: string }[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('-')) continue;
    const body = line.replace(/^-\s*/, '').trim();
    if (!body) continue;
    const m = body.match(/^(\d{4}-\d{2}-\d{2}):\s*(.*)$/);
    if (m) {
      out.push({ date: m[1]!, text: m[2]! });
    } else {
      out.push({ date: '', text: body });
    }
  }
  return out;
}

/**
 * Parse a subject's `ownership.md` into `{ path, ghola, at }` records. The CLI
 * (out of band, in `scripts/ghola.mjs`) is the sole writer; this is a tolerant
 * reader for the shared line format `- <path> :: <ghola-slug> :: <iso8601>`.
 * Splits each list line on ` :: ` and requires at least three parts, peeling
 * `at` (last) and `ghola` (second-to-last) off the end and rejoining the
 * remaining leading fields with ` :: ` as `path` (so a path may itself contain
 * ` :: `, matching the CLI, which stores paths verbatim); a line with fewer
 * fields (or no `-` bullet) is skipped rather than dropped onto a partial
 * record, so CLI-side format drift degrades gracefully. The
 * header line (`# Ownership - <subject>`) and blank lines are skipped. Order is
 * preserved exactly as written; this reader never re-sorts. Returns `[]` on an
 * absent or empty file.
 */
function parseOwnershipSafe(content: string): { path: string; ghola: string; at: string }[] {
  if (!content || !content.trim()) return [];
  const out: { path: string; ghola: string; at: string }[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('-')) continue;
    const body = line.replace(/^-\s*/, '').trim();
    if (!body) continue;
    const parts = body.split(' :: ');
    if (parts.length < 3) continue;
    const at = parts[parts.length - 1]!;
    const ghola = parts[parts.length - 2]!;
    const p = parts.slice(0, parts.length - 2).join(' :: ');
    if (!p || !ghola || !at) continue;
    out.push({ path: p, ghola, at });
  }
  return out;
}

/**
 * Parse a subject's `escalations.md` into `{ id, status, ghola, at, text }`
 * records. The CLI (out of band, in `scripts/ghola.mjs`) is the sole writer;
 * this is a tolerant reader for the shared line format
 * `- <id> :: <status> :: <ghola-slug> :: <iso8601> :: <decision text>`. Peels the
 * first four ` :: `-delimited fields (id/status/ghola/at) from the FRONT and takes
 * everything after the fourth delimiter as the decision text (which may itself
 * contain ` :: ` and may be EMPTY). Requires at least FOUR fields, not five: an
 * empty-decision escalation is written as
 * `- <id> :: <status> :: <ghola> :: <ts> :: ` (trailing space), and dropping it on
 * `parts.length < 5` made the host disagree with the CLI (which keeps it), hiding
 * the escalation. A genuinely malformed line (fewer than 4 fields, or no `-`
 * bullet) is still skipped. The header line (`# Escalations - <subject>`) and blank
 * lines are skipped. Order is preserved exactly as written; this reader never
 * re-sorts. Returns `[]` on an absent or empty file.
 *
 * Shape validation mirrors the CLI (`scripts/ghola.mjs` `parseEscalationsFile`):
 * the id must match `^E\d{4,}$` and the status must be one of
 * {pending,approved,denied,cancelled}. A row failing either is skipped
 * (tolerant, never a throw), so the host never surfaces a corrupt row the CLI
 * would drop - closing the host-vs-CLI parser divergence.
 */
const ESCALATION_STATUSES = new Set(['pending', 'approved', 'denied', 'cancelled']);

function parseEscalationsSafe(
  content: string,
): { id: string; status: string; ghola: string; at: string; text: string }[] {
  if (!content || !content.trim()) return [];
  const out: { id: string; status: string; ghola: string; at: string; text: string }[] = [];
  for (const rawLine of content.split('\n')) {
    // Strip a trailing CR (CRLF files) and leading indentation, but do NOT trim
    // trailing spaces: the empty-decision line ends with the delimiter ` :: `
    // whose trailing space is what keeps the empty fifth field present after the
    // split. Trimming it would collapse ` ::` into the `at` field and corrupt it.
    const line = rawLine.replace(/\r$/, '').replace(/^\s+/, '');
    if (!line.startsWith('-')) continue;
    const body = line.replace(/^-\s*/, '');
    if (!body.trim()) continue;
    const parts = body.split(' :: ');
    if (parts.length < 4) continue;
    const id = parts[0]!;
    const status = parts[1]!;
    const ghola = parts[2]!;
    const at = parts[3]!;
    // slice(4) is [] (no delimiter after `at`) or [''] (trailing-space empty
    // field) for an empty decision -> text ''. trimEnd() drops the trailing
    // space a non-empty decision may have picked up from the preserved line tail.
    const text = parts.slice(4).join(' :: ').trimEnd();
    if (!id || !status || !ghola || !at) continue;
    // Constrain id shape + status to match the CLI writer; a corrupt row the
    // CLI would drop must not surface in the War Room.
    if (!/^E\d{4,}$/.test(id)) continue;
    if (!ESCALATION_STATUSES.has(status)) continue;
    out.push({ id, status, ghola, at, text });
  }
  return out;
}

/** Subject directories under the ledger root (excludes `_archive` and dotdirs). */
function listLedgerSubjects(root: string): string[] {
  let entries: fsSync.Dirent[];
  try {
    entries = fsSync.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && e.name !== '_archive' && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

/** Strip surrounding double-quotes and unescape, mirroring `ghola.mjs` `unquote`. */
function unquoteYaml(v: string): string {
  if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return v;
}

/**
 * Parse the YAML-ish frontmatter block of a ghola file into a flat map. Only
 * the fields the War Room needs are meaningful; the parser mirrors
 * `ghola.mjs` `parseFrontmatter` (scalar `key: value` lines and `- item`
 * lists under the preceding key). Returns `{}` when no frontmatter is found.
 */
function parseGholaFrontmatter(content: string): Record<string, string | string[]> {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm: Record<string, string | string[]> = {};
  let currentKey: string | null = null;
  for (const rawLine of m[1]!.split('\n')) {
    if (rawLine.trim() === '') continue;
    const listMatch = rawLine.match(/^\s*-\s*(.*)$/);
    if (listMatch && currentKey) {
      const existing = fm[currentKey];
      const arr = Array.isArray(existing) ? existing : (fm[currentKey] = []);
      arr.push(unquoteYaml(listMatch[1]!.trim()));
      continue;
    }
    const kv = rawLine.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (kv) {
      currentKey = kv[1]!;
      const val = kv[2]!.trim();
      fm[currentKey] = val === '' || val === '[]' ? [] : unquoteYaml(val);
    }
  }
  return fm;
}

function fmString(fm: Record<string, string | string[]>, key: string): string {
  const v = fm[key];
  return typeof v === 'string' ? v : '';
}

/** Parsed integer value of a frontmatter field, or `fallback` when absent/unparseable. */
function fmNumber(fm: Record<string, string | string[]>, key: string, fallback: number): number {
  const v = fm[key];
  if (typeof v !== 'string' || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Frontmatter string field, or `null` when absent/empty — for nullable fields like `parent`. */
function fmStringOrNull(fm: Record<string, string | string[]>, key: string): string | null {
  const v = fm[key];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/**
 * Default reliability string for a ghola with no recorded track record yet.
 * Mirrors the CLI's `pass:N rework:M` convention.
 */
const DEFAULT_RELIABILITY = 'pass:0 rework:0';

/** Normalize a ghola frontmatter map into the War Room roster shape. */
function gholaFromFrontmatter(fm: Record<string, string | string[]>): WarRoomGhola {
  const missions = fm.missions;
  const verification = fmString(fm, 'verification');
  return {
    id: fmString(fm, 'id'),
    name: fmString(fm, 'name'),
    purpose: fmString(fm, 'purpose'),
    state: fmString(fm, 'state'),
    model: fmString(fm, 'model'),
    last_used: fmString(fm, 'last_used'),
    missions: Array.isArray(missions) ? missions : [],
    generation: fmNumber(fm, 'generation', 1),
    parent: fmStringOrNull(fm, 'parent'),
    reliability: fmString(fm, 'reliability') || DEFAULT_RELIABILITY,
    ...(verification ? { verification } : {}),
  };
}

/** Markdown heading this reader extracts the ghola's history body from. */
const HISTORY_HEADING = '## History';

/**
 * Extract the raw markdown body of the `## History` section (heading itself
 * excluded), stopping at the next heading of any level. Mirrors the section-
 * boundary logic `ghola.mjs`'s `appendBulletUnderHeading` uses to find where a
 * section ends. Returns `''` when the heading is absent.
 */
function extractHistorySection(body: string): string {
  const idx = body.indexOf(HISTORY_HEADING);
  if (idx === -1) return '';
  const afterHeadingIdx = idx + HISTORY_HEADING.length;
  const rest = body.slice(afterHeadingIdx);
  const nextHeadingMatch = rest.match(/\n#{1,6} /);
  const sectionEnd = nextHeadingMatch
    ? afterHeadingIdx + nextHeadingMatch.index!
    : body.length;
  return body.slice(afterHeadingIdx, sectionEnd).trim();
}

/**
 * Parse a full ghola `.md` file (frontmatter + body) into the War Room
 * detail-view shape. `found` is always `true` here — callers post the
 * absent-flagged placeholder themselves when the file could not be read at
 * all, since that check happens before this parser ever runs.
 */
function parseGholaDetail(content: string, subject: string): GholaDetail {
  const fm = parseGholaFrontmatter(content);
  const fmMatch = content.match(/^---\n[\s\S]*?\n---\n?/);
  const body = fmMatch ? content.slice(fmMatch[0].length) : content;
  const missions = fm.missions;
  return {
    subject,
    id: fmString(fm, 'id'),
    name: fmString(fm, 'name'),
    purpose: fmString(fm, 'purpose'),
    state: fmString(fm, 'state'),
    model: fmString(fm, 'model'),
    created: fmString(fm, 'created'),
    last_used: fmString(fm, 'last_used'),
    generation: fmNumber(fm, 'generation', 1),
    parent: fmStringOrNull(fm, 'parent'),
    reliability: fmString(fm, 'reliability') || DEFAULT_RELIABILITY,
    missions: Array.isArray(missions) ? missions : [],
    verification: fmString(fm, 'verification'),
    history: extractHistorySection(body),
    found: true,
  };
}

/**
 * Collect every ghola for a subject (active/dormant in the subject dir plus
 * archived under `_archive/<subject>/`), mirroring `ghola.mjs` `collectGholas`
 * so the roster + counts match the CLI's `board --json`. Skips the same five
 * non-ghola files the CLI's `collectGholas` skips (`_missions.md`,
 * `operating-notes.md`, `alerts.md`, `ownership.md`, and `escalations.md`)
 * so those Phase-7 per-subject files (which carry no ghola frontmatter) are
 * not parsed into PHANTOM empty gholas (id='', inflated counts, broken
 * verification rollup); unreadable/partial files are skipped. As a belt, any
 * ghola that still parses with an empty id (e.g. a future non-ghola sidecar
 * file, or a truncated frontmatter) is filtered out before it reaches the
 * payload.
 */
function collectRoster(root: string, subject: string): WarRoomGhola[] {
  const rows: WarRoomGhola[] = [];
  for (const dir of [ledgerSubjectDir(root, subject), ledgerArchiveSubjectDir(root, subject)]) {
    let files: string[];
    try {
      files = fsSync.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (
        !f.endsWith('.md') ||
        f === '_missions.md' ||
        f === 'operating-notes.md' ||
        f === 'alerts.md' ||
        f === 'ownership.md' ||
        f === 'escalations.md'
      ) {
        continue;
      }
      let content: string;
      try {
        content = fsSync.readFileSync(path.join(dir, f), 'utf-8');
      } catch {
        continue;
      }
      rows.push(gholaFromFrontmatter(parseGholaFrontmatter(content)));
    }
  }
  const gholas = rows.filter((g) => g.id !== '');
  gholas.sort((a, b) => a.id.localeCompare(b.id));
  return gholas;
}

function countByState(rows: WarRoomGhola[]): { active: number; dormant: number; archived: number; total: number } {
  const counts = { active: 0, dormant: 0, archived: 0, total: rows.length };
  for (const r of rows) {
    if (r.state === 'active') counts.active++;
    else if (r.state === 'dormant') counts.dormant++;
    else if (r.state === 'archived') counts.archived++;
  }
  return counts;
}

/**
 * Parse a single `## Mission …` block, mirroring `ghola.mjs`
 * `parseMissionBlock` but returning null on a malformed header (rather than
 * throwing) so a truncated trailing block is dropped, not fatal.
 */
function parseMissionBlockSafe(block: string): WarRoomMission | null {
  const lines = block.split('\n');
  const hm = lines[0]!.match(/^## Mission (\S+) \(([a-z]+)\) — (.+)$/);
  if (!hm) return null;
  const [, id, status, date] = hm;
  let goal = '';
  let groundedIn = '';
  let budget: string | null = null;
  let integration: string | undefined;
  const progress: string[] = [];
  let inProgress = false;
  for (const line of lines.slice(1)) {
    if (line.trim() === '### Progress') {
      inProgress = true;
      continue;
    }
    if (!inProgress) {
      const gm = line.match(/^- goal: (.*)$/);
      if (gm) {
        goal = gm[1]!;
        continue;
      }
      const grm = line.match(/^- grounded-in: (.*)$/);
      if (grm) {
        groundedIn = grm[1] === '(none)' ? '' : grm[1]!;
        continue;
      }
      const bm = line.match(/^- budget: (.*)$/);
      if (bm) {
        budget = bm[1] === '(none)' ? null : bm[1]!;
        continue;
      }
      const im = line.match(/^- integration: (.*)$/);
      if (im) {
        integration = im[1] === '(none)' ? undefined : im[1]!;
        continue;
      }
    } else {
      const pm = line.match(/^- (.*)$/);
      if (pm && pm[1] !== '(none yet)') progress.push(pm[1]!);
    }
  }
  return {
    id: id!,
    status: status!,
    date: date!,
    goal,
    groundedIn,
    budget,
    ...(integration !== undefined ? { integration } : {}),
    progress,
  };
}

/**
 * Parse a `_missions.md` file into mission records. Mirrors `ghola.mjs`
 * `parseMissionsFile` but drops malformed blocks instead of failing, so a
 * partially-written file never crashes the War Room refresh.
 */
function parseMissionsSafe(content: string): WarRoomMission[] {
  if (!content || !content.trim()) return [];
  const out: WarRoomMission[] = [];
  for (const raw of content.split(/\n(?=## Mission )/)) {
    const block = raw.trim();
    if (!block) continue;
    const parsed = parseMissionBlockSafe(block);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Pick the subject whose newest open mission has the latest date. Returns null
 * when no subject has an open mission (caller falls back to the first subject).
 */
function pickSubjectByRecentOpenMission(root: string, subjects: string[]): string | null {
  let best: string | null = null;
  let bestDate = '';
  for (const s of subjects) {
    const openDates = parseMissionsSafe(readFileSyncOr(missionsPath(root, s), ''))
      .filter((m) => m.status === 'open')
      .map((m) => m.date)
      .sort();
    const newest = openDates[openDates.length - 1];
    if (newest !== undefined && newest >= bestDate) {
      bestDate = newest;
      best = s;
    }
  }
  return best;
}
