import * as path from 'path';
import * as vscode from 'vscode';
import { TicketWidgetProvider } from './ticket-widget/provider';
import { TicketTodosStoreManager } from './ticket-widget/todos-store';
import { registerCommands } from './commands';
import { AtlassianClient } from './integration/atlassian-client';
import { BitbucketPrClient } from './integration/bitbucket-pr-client';
import { ModuleLoader } from './modules/loader';
import { ModuleState } from './modules/state';
import { PromptComposer } from './prompts/composer';
import { SessionLauncher } from './session/launcher';
import { ConfigurationsStore } from './settings-panel/configurations-store';
import { SettingsPanel } from './settings-panel/host';
import { SET_CONTEXT_KEYS, WORKSPACE_STATE_KEYS } from './state/keys';

/** Module id for the atlassian-suite integration. */
const ATLASSIAN_MODULE_ID = 'integration.atlassian-suite';

/**
 * SecretStorage keys for the per-product Atlassian API tokens. Jira and
 * Bitbucket are stored under separate keys so the UX is unambiguous about
 * which token authenticates which product — the user enters two distinct
 * tokens (one per product surface) and the bridge never mixes them.
 */
const ATLASSIAN_JIRA_TOKEN_SECRET_KEY = 'nomeda.atlassianSuite.jiraToken';
const ATLASSIAN_BITBUCKET_TOKEN_SECRET_KEY = 'nomeda.atlassianSuite.bitbucketToken';

/*
 * LEGACY: `nomeda.atlassianSuite.apiToken` — SecretStorage key from a
 * previous single-token design that stored one shared token used for both
 * Jira and Bitbucket. Intentionally orphaned in place: this codebase no
 * longer reads, writes, migrates, or deletes it. Users were informed that
 * re-entering credentials once after the split is expected. Recorded here
 * only so future readers do not reintroduce the key under the assumption it
 * is unused — it may still exist in some users' SecretStorage and should
 * stay untouched. Do NOT convert this comment back into a `const`; an
 * unused declaration would trip `noUnusedLocals`.
 */

/**
 * Outcome of a single end-to-end Atlassian credential probe. Each product can
 * be `'ok'` (the API accepted the token), `'failed'` (the API rejected it or
 * the network failed), or `'skipped'` (a required configuration field is
 * missing so the probe was not even attempted).
 *
 * Persisted to `context.workspaceState` so the Settings panel and Branch
 * Widget can render a fresh-on-reload indicator without re-running the probes
 * on activation.
 *
 * Shared with SWE-2 — they read this off the bridge to render the panel's
 * Validate-status indicator.
 */
export interface AtlassianValidationResult {
  jira: { status: 'ok' | 'failed' | 'skipped'; message?: string; displayName?: string };
  bitbucket: { status: 'ok' | 'failed' | 'skipped'; message?: string; displayName?: string };
  /** ISO 8601 timestamp of when the probe ran. */
  lastCheckedAt: string;
}

/**
 * Coordination surface passed to `SettingsPanel` so the panel's webview can
 * query whether each Atlassian API token is currently stored without ever
 * receiving the token value itself, and subscribe to a refresh event when
 * the token-set/clear commands fire. Token VALUES never leave the host.
 *
 * Shared with SWE-2 — they consume this interface when wiring the panel-side
 * per-product token-status indicators.
 */
export interface AtlassianBridge {
  // ── Per-product token storage queries ──
  /** Resolves to true when a Jira token is currently stored in SecretStorage. */
  isJiraTokenSet(): Promise<boolean>;
  /** Resolves to true when a Bitbucket token is currently stored in SecretStorage. */
  isBitbucketTokenSet(): Promise<boolean>;
  /**
   * Read the stored Jira token. Intended ONLY for host-side consumers that
   * need to construct an authenticated HTTP request (the Branch Widget
   * provider and the validation routine). The returned value MUST NOT be
   * forwarded across the webview boundary or written to any log / output
   * channel.
   */
  getJiraToken(): Promise<string | undefined>;
  /**
   * Read the stored Bitbucket token. Same host-only contract as
   * `getJiraToken()`. Never crosses the webview boundary.
   */
  getBitbucketToken(): Promise<string | undefined>;

  /**
   * Fires whenever EITHER product's token state changes — set or clear, for
   * Jira or Bitbucket. SWE-2 subscribes once and re-queries
   * `isJiraTokenSet()` / `isBitbucketTokenSet()` to refresh the indicators.
   */
  onDidChangeAtlassianTokenStatus: vscode.Event<void>;

  /**
   * Run Jira + Bitbucket reachability probes against the currently-configured
   * settings, persist the result to workspaceState, fire
   * `onDidChangeValidation`, and return the result. Never throws — failures
   * surface as `status: 'failed'` with a user-readable message.
   */
  validate(): Promise<AtlassianValidationResult>;
  /** Last persisted validation result (or `undefined` on first run). */
  getLastValidation(): AtlassianValidationResult | undefined;
  /** Fires every time `validate()` completes (or a token is cleared). */
  onDidChangeValidation: vscode.Event<AtlassianValidationResult>;
}

export function activate(context: vscode.ExtensionContext): void {
  const logger = vscode.window.createOutputChannel('Nomeda');
  context.subscriptions.push(logger);
  logger.appendLine('[nomeda] activating v0.0.1');

  const moduleState = new ModuleState(context.workspaceState);
  const loader = new ModuleLoader(moduleState, {
    // Cores live in prompts/cores/ and are not modules. The IDs listed here are
    // the modules enabled on first run so the session boots with the same
    // baseline capabilities the cores used to ship inline.
    defaultEnabledIds: [
      'tool.git',
      'tool.dotnet-suite',
      'tool.npm-suite',
      'tool.database-access',
      'tool.lenses',
      'tool.pre-pr-checklist',
      'tool.pr-description',
      'tool.regression-scan',
      'tool.ac-to-testing',
      'tool.mid-session-bootstrap',
      'tool.untrusted-jira',
      'tool.statusline',
      'tool.clipboard-image',
      'tool.cross-ticket-isolation',
      'tool.cwd-discipline',
      'tool.secrets-wrapper-pattern',
      'tool.qa-pr-learning',
      'tool.session-bootstrap',
      'tool.conversational-settings',
      'tool.setup-walkthrough',
      'tool.docker',
      'tool.open-wsl-repo',
      'tool.playwright',
      'tool.ssh-access',
      'tool.core-allocation',
      'tool.subagent-coordination',
      'tool.obsidian-notes',
      'tool.session-handoff',
      'mode.cd',
    ],
    logger,
  });
  context.subscriptions.push({ dispose: () => loader.dispose() });

  // Cores ship with the extension and are read from the extension install path,
  // never the workspace. Always resolve relative to context.extensionPath.
  const coresPath = path.join(context.extensionPath, 'prompts', 'cores');
  const composer = new PromptComposer(loader, coresPath, logger);

  const session = new SessionLauncher(loader, context.extensionPath, context.workspaceState, logger);
  const configurationsStore = new ConfigurationsStore(context.workspaceState);
  const resolveModulesDir = resolveModulesDirFn(context);
  // Path used by the `tool.feedback-log` module: the host reads/writes this
  // file directly from the Feedback panel tab, and the path is injected into
  // the agent-facing Session Manifest as `parameters.feedbackFilePath` so TPM
  // can read/write the same file via its Read/Write tools. `globalStorageUri`
  // is per-extension and persists across workspaces, which matches the user's
  // expectation that the feedback log follows them.
  const feedbackFilePath = path.join(context.globalStorageUri.fsPath, 'feedback.json');

  // ─── Atlassian Suite wiring ─────────────────────────────────────────
  // Emitter fired whenever EITHER product's token state changes (set or
  // clear, Jira or Bitbucket). SWE-2's panel subscribes once and re-queries
  // both `isJiraTokenSet()` / `isBitbucketTokenSet()` on each fire.
  const tokenStatusEmitter = new vscode.EventEmitter<void>();
  context.subscriptions.push(tokenStatusEmitter);

  // Emitter fired whenever a validation probe completes. Set/clear commands
  // for either product re-trigger `validate()`, so subscribers always see a
  // fresh result reflecting the new SecretStorage state (with the cleared
  // product's probe naturally returning `skipped` via the client). The
  // Branch Widget and the Settings panel both subscribe to refresh their
  // indicators.
  const validationEmitter = new vscode.EventEmitter<AtlassianValidationResult>();
  context.subscriptions.push(validationEmitter);

  // Emitter the host fires whenever module-settings change. The ticket widget
  // subscribes so it can re-pull settings after a save, and we also use it
  // locally to re-sync the widget context key.
  const moduleSettingsEmitter = new vscode.EventEmitter<void>();
  context.subscriptions.push(moduleSettingsEmitter);

  /**
   * Read a single Atlassian-module setting from the flattened
   * `nomeda.moduleSettings` workspace-state entry. Falls back to the
   * manifest's declared default (if any) when the user has not yet saved the
   * field — this mirrors the webview's own `state.settingsValues[key] ??
   * field.default` logic so that pre-populated default values are visible to
   * validate() even before the user has explicitly clicked Save.
   */
  const readAtlassianSetting = (fieldKey: string): string => {
    const flat = context.workspaceState.get<Record<string, unknown>>(WORKSPACE_STATE_KEYS.MODULE_SETTINGS, {});
    const v = flat[`${ATLASSIAN_MODULE_ID}::${fieldKey}`];
    if (typeof v === 'string') return v;
    // No saved value — fall back to the manifest default so that fields shown
    // as pre-populated in the UI (e.g. bitbucketWorkspace: "herzog-technologies")
    // are treated as present by validation even before the user has saved them.
    const manifestDefault = loader
      .find(ATLASSIAN_MODULE_ID)
      ?.manifest.contributes?.settings?.[fieldKey]?.default;
    return typeof manifestDefault === 'string' ? manifestDefault : '';
  };

  const atlassianBridge: AtlassianBridge = {
    isJiraTokenSet: async () =>
      (await context.secrets.get(ATLASSIAN_JIRA_TOKEN_SECRET_KEY)) !== undefined,
    isBitbucketTokenSet: async () =>
      (await context.secrets.get(ATLASSIAN_BITBUCKET_TOKEN_SECRET_KEY)) !== undefined,
    onDidChangeAtlassianTokenStatus: tokenStatusEmitter.event,
    getJiraToken: async () => context.secrets.get(ATLASSIAN_JIRA_TOKEN_SECRET_KEY),
    getBitbucketToken: async () => context.secrets.get(ATLASSIAN_BITBUCKET_TOKEN_SECRET_KEY),
    getLastValidation: () =>
      context.workspaceState.get<AtlassianValidationResult>(WORKSPACE_STATE_KEYS.ATLASSIAN_LAST_VALIDATION),
    onDidChangeValidation: validationEmitter.event,
    validate: async (): Promise<AtlassianValidationResult> => {
      // Two-token read happens in parallel so a slow SecretStorage call on
      // one product does not serialise the other. Either token may be
      // undefined — the client handles "missing token → skipped" itself.
      const [jiraToken, bitbucketToken] = await Promise.all([
        context.secrets.get(ATLASSIAN_JIRA_TOKEN_SECRET_KEY),
        context.secrets.get(ATLASSIAN_BITBUCKET_TOKEN_SECRET_KEY),
      ]);
      const email = readAtlassianSetting('email');
      const jiraBase = readAtlassianSetting('jiraBase');
      const bitbucketWorkspace = readAtlassianSetting('bitbucketWorkspace');
      const client = new AtlassianClient({
        email,
        jiraToken,
        bitbucketToken,
        jiraBase,
        bitbucketWorkspace,
      });
      const [jira, bitbucket] = await Promise.all([
        client.validateJira(),
        client.validateBitbucket(),
      ]);
      const result: AtlassianValidationResult = {
        jira,
        bitbucket,
        lastCheckedAt: new Date().toISOString(),
      };
      await context.workspaceState.update(WORKSPACE_STATE_KEYS.ATLASSIAN_LAST_VALIDATION, result);
      validationEmitter.fire(result);
      return result;
    },
  };

  // Long-lived Bitbucket PR-comments client. Token and workspace are read
  // lazily on every request via the bridge + setting accessor, so one
  // instance lives for the extension's lifetime and naturally honors
  // token / workspace changes without rebuilding.
  const bitbucketPrClient = new BitbucketPrClient(atlassianBridge, readAtlassianSetting);
  void bitbucketPrClient;

  const panel = new SettingsPanel(
    context,
    loader,
    composer,
    configurationsStore,
    resolveModulesDir,
    feedbackFilePath,
    atlassianBridge,
    moduleSettingsEmitter,
    logger,
  );
  context.subscriptions.push(panel);

  // Register the five Atlassian token commands. All are user-discoverable
  // from the Command Palette (declared in package.json) and can also be
  // invoked programmatically by the panel UI via
  // vscode.commands.executeCommand. Set/clear commands are split per product
  // — Jira and Bitbucket each get their own pair so the UX is unambiguous
  // about which token authenticates which surface.
  //
  // Token leak audit for this block:
  //   - Token values are read only from `showInputBox` (password-masked) and
  //     written directly to SecretStorage. They are never logged, echoed, or
  //     placed in any error path. `validate()` returns a sanitized shape that
  //     never contains the raw token.
  context.subscriptions.push(
    vscode.commands.registerCommand('nomeda.atlassianSuite.setJiraToken', async () => {
      const value = await vscode.window.showInputBox({
        prompt: 'Jira API token',
        password: true,
        ignoreFocusOut: true,
      });
      // User cancelled: showInputBox returns undefined. Empty-string is
      // treated as cancel too so we don't store a sentinel empty secret.
      if (value === undefined || value === '') return;
      await context.secrets.store(ATLASSIAN_JIRA_TOKEN_SECRET_KEY, value);
      tokenStatusEmitter.fire();
      // Fire-and-forget validation. The validation event listeners pick up
      // the result asynchronously; awaiting would block the command UI until
      // both probes return. Errors inside `validate()` are converted to a
      // `failed` result so no rejection can escape.
      void atlassianBridge.validate();
    }),
    vscode.commands.registerCommand('nomeda.atlassianSuite.clearJiraToken', async () => {
      await context.secrets.delete(ATLASSIAN_JIRA_TOKEN_SECRET_KEY);
      tokenStatusEmitter.fire();
      // Re-run validation so the persisted result reflects "Jira token
      // missing" for the cleared product without disturbing Bitbucket's
      // current state. The client handles the per-product `skipped` shape.
      void atlassianBridge.validate();
    }),
    vscode.commands.registerCommand('nomeda.atlassianSuite.setBitbucketToken', async () => {
      const value = await vscode.window.showInputBox({
        prompt: 'Bitbucket API token',
        password: true,
        ignoreFocusOut: true,
      });
      if (value === undefined || value === '') return;
      await context.secrets.store(ATLASSIAN_BITBUCKET_TOKEN_SECRET_KEY, value);
      tokenStatusEmitter.fire();
      void atlassianBridge.validate();
    }),
    vscode.commands.registerCommand('nomeda.atlassianSuite.clearBitbucketToken', async () => {
      await context.secrets.delete(ATLASSIAN_BITBUCKET_TOKEN_SECRET_KEY);
      tokenStatusEmitter.fire();
      void atlassianBridge.validate();
    }),
    vscode.commands.registerCommand('nomeda.atlassianSuite.validateToken', async () => {
      // On-demand validation invoked by SWE-2's Validate button (and from
      // the Command Palette). Result lands via the validation event
      // listeners; we still return it so callers that want to await the
      // outcome can do so.
      return atlassianBridge.validate();
    }),
  );

  registerCommands(context, {
    loader,
    panel,
    session,
    resolveModulesDir,
    logger,
  });

  // ───── Ticket Widget ────────────────────────────────────────────────
  const ticketTodosStore = new TicketTodosStoreManager(context);
  context.subscriptions.push(ticketTodosStore);

  // readModeSetting closure for mode.ticket-work — mirrors readAtlassianSetting pattern
  const readTicketWorkSetting = (key: string): unknown => {
    const flat = context.workspaceState.get<Record<string, unknown>>(WORKSPACE_STATE_KEYS.MODULE_SETTINGS, {});
    const flatKey = `mode.ticket-work::${key}`;
    if (flatKey in flat) {
      return flat[flatKey];
    }
    // Fall back to manifest default
    const handle = loader.find('mode.ticket-work');
    const setting = handle?.manifest.contributes?.settings?.[key];
    return setting?.default;
  };

  const ticketWidgetProvider = new TicketWidgetProvider(
    context,
    moduleSettingsEmitter.event,
    loader.onDidChange,
    atlassianBridge,
    readTicketWorkSetting,
    ticketTodosStore,
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('nomedaTicketWidget', ticketWidgetProvider),
  );

  // Context-key sync — show widget only when module enabled AND ticketId set
  const syncTicketWorkWidgetContextKey = (): void => {
    const moduleEnabled = loader.find('mode.ticket-work')?.isEnabled === true;
    const ticketIdRaw = readTicketWorkSetting('ticketId');
    const ticketId = typeof ticketIdRaw === 'string' && ticketIdRaw.trim() ? ticketIdRaw.trim() : '';
    const showWidgetRaw = readTicketWorkSetting('showWidget');
    const showWidget = typeof showWidgetRaw === 'boolean' ? showWidgetRaw : true;
    const enabled = moduleEnabled && ticketId !== '' && showWidget;
    void vscode.commands.executeCommand('setContext', SET_CONTEXT_KEYS.TICKET_WORK_WIDGET_ENABLED, enabled);
  };

  // Initial sync
  syncTicketWorkWidgetContextKey();

  // Re-sync on settings save (covers ticketId / showWidget changes)
  context.subscriptions.push(moduleSettingsEmitter.event(syncTicketWorkWidgetContextKey));

  // Re-sync on module enable/disable toggle
  context.subscriptions.push(loader.onDidChange(syncTicketWorkWidgetContextKey));

  // Initial discovery (best-effort). After discover() resolves we apply any
  // user-flagged default configuration so the workspace boots into the same
  // preset they last marked as default. The dev-mode openSettings call below
  // intentionally runs after this chain so the panel renders with the applied
  // configuration in place.
  void loader.discover(resolveModulesDirFn(context)()).then(async (handles) => {
    logger.appendLine(`[nomeda] discovered ${handles.length} module(s)`);
    await panel.applyDefaultOnStartup();
    if (context.extensionMode === vscode.ExtensionMode.Development) {
      vscode.commands.executeCommand('nomeda.openSettings');
    }
  });

  // File watcher: re-discover and re-broadcast composed prompts whenever a
  // manifest.json is added, changed, or deleted (250 ms debounce).
  const watcherDisposable = loader.watchManifests(resolveModulesDirFn(context), () => {
    panel.broadcastComposedPrompts();
  });
  context.subscriptions.push(watcherDisposable);

  // React to config changes that affect paths.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('nomeda.modulesDir')) {
        void vscode.commands.executeCommand('nomeda.reloadModules');
      }
    }),
  );

  // Dev-mode convenience auto-open lives inside the discover().then() block
  // above so it runs after applyDefaultOnStartup completes.
}

export function deactivate(): void {
  // No-op; subscriptions handle cleanup.
}

function resolveModulesDirFn(context: vscode.ExtensionContext): () => string {
  return () => {
    const cfg = vscode.workspace.getConfiguration('nomeda');
    const rel = cfg.get<string>('modulesDir') ?? 'modules';
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? context.extensionPath;
    return path.isAbsolute(rel) ? rel : path.join(root, rel);
  };
}

