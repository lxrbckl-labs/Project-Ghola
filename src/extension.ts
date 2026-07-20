import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { AtlassianClient } from './integration/atlassian-client';
import { adfToPlainText } from './integration/adf-to-text';
import { BitbucketPrClient } from './integration/bitbucket-pr-client';
import { discoverObsidianVault } from './integration/vault-discovery';
import { startBitbucketBridge } from './integration/bitbucket-bridge-server';
import type { GetCommentsResult, PostCommentResult } from './integration/bitbucket-bridge-server';
import { ModuleLoader } from './modules/loader';
import { ModuleState, migrateCommitPushEnabled } from './modules/state';
import { PromptComposer } from './prompts/composer';
import { SessionLauncher } from './session/launcher';
import { BUILT_IN_CONFIGURATIONS, DEFAULT_ENABLED_IDS } from './settings-panel/built-in-configurations';
import { ConfigurationsStore } from './settings-panel/configurations-store';
import { SettingsPanel } from './settings-panel/host';
import { SET_CONTEXT_KEYS, WORKSPACE_STATE_KEYS } from './state/keys';
import {
  BitbucketTokenEntry,
  BitbucketTokenSummary,
  readBitbucketTokens,
  writeBitbucketTokens,
  summarizeBitbucketTokens,
  addBitbucketToken,
  removeBitbucketToken,
  reorderBitbucketTokens,
  setBitbucketTokenLabel,
  replaceBitbucketTokenValue,
} from './state/bitbucket-tokens';
import {
  readModuleSettings,
  writeModuleSettings,
  migrateModuleSettingsToGlobal,
  migrateGitBranchCommandsEnabled,
} from './state/module-settings';
import { ModeStatusBarItem, MODE_STATUS_BAR_CONFIG_SECTION } from './status-bar/mode-status-bar';

/** Module id for the atlassian-suite integration. */
const ATLASSIAN_MODULE_ID = 'integration.atlassian-suite';

/**
 * SecretStorage keys for the per-product Atlassian API tokens. Jira and
 * Bitbucket are stored under separate keys so the UX is unambiguous about
 * which token authenticates which product — the user enters two distinct
 * tokens (one per product surface) and the bridge never mixes them.
 */
const ATLASSIAN_JIRA_TOKEN_SECRET_KEY = 'ghola.atlassianSuite.jiraToken';
const ATLASSIAN_BITBUCKET_TOKEN_SECRET_KEY = 'ghola.atlassianSuite.bitbucketToken';

/**
 * SecretStorage key for the ORDERED list of Bitbucket tokens (multi-token
 * failover). The whole list is JSON-serialized under this single key (see
 * `state/bitbucket-tokens.ts`). The legacy single-token key above is migrated
 * into this list on first read and then left orphaned in place — never deleted.
 */
const ATLASSIAN_BITBUCKET_TOKENS_SECRET_KEY = 'ghola.atlassianSuite.bitbucketTokens';

/*
 * LEGACY: `ghola.atlassianSuite.apiToken` — SecretStorage key from a
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
 * Persisted to `context.workspaceState` so the Settings panel can render a
 * fresh-on-reload indicator without re-running the probes on activation.
 *
 * Shared with SWE-2 — they read this off the bridge to render the panel's
 * Validate-status indicator.
 */
export interface AtlassianValidationResult {
  jira: { status: 'ok' | 'failed' | 'skipped'; message?: string; displayName?: string };
  /**
   * PER-TOKEN Bitbucket outcome — one entry per stored token (keyed by its
   * stable `id`), validated individually so the panel can show which specific
   * token is `ok`, expired (401 → `failed`), or wrong-scope (403 → `failed`).
   * Empty when no Bitbucket token is stored. Jira stays a single aggregate.
   */
  bitbucket: BitbucketTokenValidation[];
  /** ISO 8601 timestamp of when the probe ran. */
  lastCheckedAt: string;
}

/**
 * Validation outcome for a SINGLE Bitbucket token, tied to the entry's stable
 * `id` so the panel can join it back to the masked token row. `message` carries
 * the sanitized reason on `failed` (it preserves the 401-vs-403 hint from the
 * REST probe); the token value never appears here.
 */
export interface BitbucketTokenValidation {
  id: string;
  status: 'ok' | 'failed' | 'skipped';
  message?: string;
  displayName?: string;
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
   * need to construct an authenticated HTTP request (the validation routine
   * and the host-side Jira ticket fetcher) or to derive a masked LAST-4
   * fingerprint. The full returned value MUST NOT be forwarded across the
   * webview boundary or written to any log / output channel — only a derived
   * last-4 fragment may cross the boundary (see `broadcastAtlassianTokenStatus`).
   */
  getJiraToken(): Promise<string | undefined>;
  /**
   * Read the stored Bitbucket token. Same host-only contract as
   * `getJiraToken()`. The full value never crosses the webview boundary; only a
   * derived last-4 fragment may.
   *
   * Back-compat single-token accessor: now sourced from the ordered token list
   * (via migration), returning the FIRST entry's value or `undefined` when the
   * list is empty. Existing single-token callers are unaffected.
   */
  getBitbucketToken(): Promise<string | undefined>;

  /**
   * Read the FULL ordered list of Bitbucket tokens, including secret values.
   * Host-only consumer contract (identical to `getBitbucketToken()`): the
   * future rotation loop uses this to try each token in order. Values MUST NOT
   * cross the webview boundary — use `getBitbucketTokenSummaries()` for the UI.
   */
  getBitbucketTokens(): Promise<BitbucketTokenEntry[]>;
  /**
   * Non-secret masked view of the Bitbucket token list for the panel: each
   * entry's `id`, `label`, and last-4 fingerprint only. Safe to forward across
   * the webview boundary.
   */
  getBitbucketTokenSummaries(): Promise<BitbucketTokenSummary[]>;

  // ── Bitbucket token list mutations (all operate on the ordered LIST) ──
  //
  // The webview drives these via the settings-panel protocol. Each mutates the
  // JSON-array secret, fires `onDidChangeAtlassianTokenStatus` so the panel
  // re-broadcasts the masked list, and (for value-changing ops) triggers a
  // re-validate. A token VALUE only ever travels INBOUND (webview -> host, e.g.
  // the user typing a new token) — never back across the boundary, never logged.
  /** Append a new token (secret `value`) with an optional label to the list. */
  addBitbucketToken(label: string | undefined, value: string): Promise<void>;
  /** Remove the token with the given stable `id`. No-op when absent. */
  removeBitbucketToken(id: string): Promise<void>;
  /** Reorder the list to `orderedIds` — this IS the failover order. */
  reorderBitbucketTokens(orderedIds: string[]): Promise<void>;
  /** Rename the token with the given `id`, preserving its id + value. */
  setBitbucketTokenLabel(id: string, label: string): Promise<void>;
  /** Replace the secret `value` of the token with the given `id`. */
  replaceBitbucketTokenValue(id: string, value: string): Promise<void>;
  /**
   * Re-validate a SINGLE Bitbucket token by `id`, merge the result into the
   * cached validation (preserving Jira and every other token's status), persist
   * it, fire `onDidChangeValidation`, and return the merged result. Never throws.
   */
  validateBitbucketToken(id: string): Promise<AtlassianValidationResult>;

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

/**
 * Resolve the War Mode ledger root GLOBALLY, with the SAME precedence the
 * `ghola` CLI (`scripts/ghola.mjs` resolveLedgerRoot), the session launcher, and
 * `SettingsPanel.resolveLedgerRoot` use, so every surface agrees:
 *   1. GHOLA_LEDGER_ROOT env (non-empty)                 -> used verbatim.
 *   2. Else the `tool.obsidian-notes` `vaultPath` setting -> <vault>/_Gholas.
 *   3. Else                                               -> <homedir>/.ghola/ledger.
 * NEVER resolves under the open work repo — no `.ghola/` is read from or written
 * to the workspace. Never throws.
 */
function resolveLedgerRoot(context: vscode.ExtensionContext): string {
  const envRoot = process.env.GHOLA_LEDGER_ROOT;
  if (typeof envRoot === 'string' && envRoot.trim() !== '') {
    return envRoot.trim();
  }
  const flat = readModuleSettings(context.globalState, context.workspaceState);
  const vaultSetting = flat['tool.obsidian-notes::vaultPath'];
  if (typeof vaultSetting === 'string' && vaultSetting.trim() !== '') {
    return path.join(vaultSetting.trim(), '_Gholas');
  }
  return path.join(os.homedir(), '.ghola', 'ledger');
}

export function activate(context: vscode.ExtensionContext): void {
  const logger = vscode.window.createOutputChannel('Ghola');
  context.subscriptions.push(logger);
  logger.appendLine('[ghola] activating v0.0.1');

  // Migrate any legacy per-workspace module settings into the global store so
  // field values (Atlassian email, vault path, personas, instructions, etc.)
  // follow the operator across workspaces and survive preset applies. Idempotent
  // and fire-and-forget: reads use `readModuleSettings`, which merges the legacy
  // fallback until this completes, so correctness never depends on its timing.
  // Then flip `git branch <name>` / `git switch` on inside an already-stored
  // tool.git allowed-commands override, which shadows the manifest default.
  // CHAINED, not fired independently: both migrations rewrite the same
  // `ghola.moduleSettings` globalState key, so running them concurrently could
  // let the legacy fold's stale snapshot clobber the flip. The branch-command
  // migration never throws, and the `.catch` keeps a failed legacy fold from
  // both skipping it and surfacing an unhandled rejection.
  void migrateModuleSettingsToGlobal(context.globalState, context.workspaceState)
    .catch((err) => {
      logger.appendLine(`[ghola] module-settings global migration failed (non-fatal): ${err}`);
    })
    .then(() => migrateGitBranchCommandsEnabled(context.globalState, context.workspaceState, logger));

  const moduleState = new ModuleState(context.workspaceState);
  const loader = new ModuleLoader(moduleState, {
    // Cores live in prompts/cores/ and are not modules. The IDs listed here are
    // the modules enabled on first run so the session boots with the same
    // baseline capabilities the cores used to ship inline.
    defaultEnabledIds: DEFAULT_ENABLED_IDS,
    logger,
  });
  context.subscriptions.push({ dispose: () => loader.dispose() });

  // Cores ship with the extension and are read from the extension install path,
  // never the workspace. Always resolve relative to context.extensionPath.
  const coresPath = path.join(context.extensionPath, 'prompts', 'cores');
  const composer = new PromptComposer(loader, coresPath, logger);

  const session = new SessionLauncher(loader, context.extensionPath, context.globalState, context.workspaceState, logger);
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
  // Settings panel subscribes to refresh its indicators.
  const validationEmitter = new vscode.EventEmitter<AtlassianValidationResult>();
  context.subscriptions.push(validationEmitter);

  // Emitter the host fires whenever module-settings change. The Settings panel
  // and the mode / War Mode status-bar item subscribe so they re-pull settings
  // after a save.
  const moduleSettingsEmitter = new vscode.EventEmitter<void>();
  context.subscriptions.push(moduleSettingsEmitter);

  // ───── Ghola mode / War Mode status-bar item ─────────────────────────
  // A native status-bar indicator showing the current session modality and
  // War-Mode flag (e.g. `Ghola: ticket-work + war`). War Mode is NOT a
  // loader-toggleable module — its source of truth is the `mode.war::enabled`
  // module-setting (an Agents configuration), exactly as the launcher/banner/
  // composer read it — so we resolve it from the flattened MODULE_SETTINGS
  // store rather than loader state, keeping the item's war flag in agreement.
  const readWarMode = (): boolean => {
    const flat = readModuleSettings(context.globalState, context.workspaceState);
    return flat['mode.war::enabled'] === true;
  };
  const modeStatusBar = new ModeStatusBarItem(loader, readWarMode);
  context.subscriptions.push(modeStatusBar);
  // Refresh on: module enable/disable (loader), module-settings save (covers
  // the mode.war::enabled War-Mode toggle), and the statusBar.enabled config
  // toggle (show/hide). Initial paint below reflects the boot state.
  context.subscriptions.push(loader.onDidChange(() => modeStatusBar.refresh()));
  context.subscriptions.push(moduleSettingsEmitter.event(() => modeStatusBar.refresh()));
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(MODE_STATUS_BAR_CONFIG_SECTION)) modeStatusBar.refresh();
    }),
  );
  modeStatusBar.refresh();

  /**
   * Read a single Atlassian-module setting from the flattened GLOBAL
   * `ghola.moduleSettings` map (via `readModuleSettings`). Falls back to the
   * manifest's declared default (if any) when the user has not yet saved the
   * field — this mirrors the webview's own `state.settingsValues[key] ??
   * field.default` logic so that pre-populated default values are visible to
   * validate() even before the user has explicitly clicked Save.
   */
  const readAtlassianSetting = (fieldKey: string): string => {
    const flat = readModuleSettings(context.globalState, context.workspaceState);
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

  // Read the ordered Bitbucket token list, running the one-time non-destructive
  // legacy migration on first access. All Bitbucket bridge accessors below
  // route through this so single-token and multi-token callers see one source.
  const readBbTokens = (): Promise<BitbucketTokenEntry[]> =>
    readBitbucketTokens(
      context.secrets,
      ATLASSIAN_BITBUCKET_TOKENS_SECRET_KEY,
      ATLASSIAN_BITBUCKET_TOKEN_SECRET_KEY,
    );

  // Probe ONE Bitbucket token in isolation and map it to a per-token result.
  // A single-token client means the shared failover loop makes exactly one
  // attempt, so the returned status reflects THIS entry alone (401 → expired,
  // 403 → wrong-scope, both surface as `failed` with the sanitized message).
  // The value is only used to build the client; it never leaves this scope.
  const probeBitbucketEntry = async (
    entry: BitbucketTokenEntry,
    email: string,
    bitbucketWorkspace: string,
  ): Promise<BitbucketTokenValidation> => {
    const client = new AtlassianClient({
      email,
      bitbucketTokens: [entry.value],
      jiraBase: '',
      bitbucketWorkspace,
    });
    const probe = await client.validateBitbucket();
    return {
      id: entry.id,
      status: probe.status,
      message: probe.message,
      displayName: probe.displayName,
    };
  };

  const atlassianBridge: AtlassianBridge = {
    isJiraTokenSet: async () =>
      (await context.secrets.get(ATLASSIAN_JIRA_TOKEN_SECRET_KEY)) !== undefined,
    isBitbucketTokenSet: async () => (await readBbTokens()).length > 0,
    onDidChangeAtlassianTokenStatus: tokenStatusEmitter.event,
    getJiraToken: async () => context.secrets.get(ATLASSIAN_JIRA_TOKEN_SECRET_KEY),
    getBitbucketToken: async () => (await readBbTokens())[0]?.value,
    getBitbucketTokens: () => readBbTokens(),
    getBitbucketTokenSummaries: async () => summarizeBitbucketTokens(await readBbTokens()),
    getLastValidation: () =>
      context.workspaceState.get<AtlassianValidationResult>(WORKSPACE_STATE_KEYS.ATLASSIAN_LAST_VALIDATION),
    onDidChangeValidation: validationEmitter.event,
    validate: async (): Promise<AtlassianValidationResult> => {
      // Read the Jira token and the ordered Bitbucket token list in parallel so
      // a slow SecretStorage call on one product does not serialise the other.
      // Jira stays single-token; Bitbucket is validated PER-TOKEN (each entry
      // probed individually) so the panel can show which specific token is
      // ok / expired / wrong-scope. Either side may be empty — a single-token
      // Jira client and an empty Bitbucket list both degrade to `skipped`.
      const [jiraToken, bitbucketTokenEntries] = await Promise.all([
        context.secrets.get(ATLASSIAN_JIRA_TOKEN_SECRET_KEY),
        readBbTokens(),
      ]);
      const email = readAtlassianSetting('email');
      const jiraBase = readAtlassianSetting('jiraBase');
      const bitbucketWorkspace = readAtlassianSetting('bitbucketWorkspace');
      const jiraClient = new AtlassianClient({
        email,
        jiraToken,
        jiraBase,
        bitbucketWorkspace: '',
      });
      const [jira, bitbucket] = await Promise.all([
        jiraClient.validateJira(),
        Promise.all(
          bitbucketTokenEntries.map((entry) =>
            probeBitbucketEntry(entry, email, bitbucketWorkspace),
          ),
        ),
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
    // ── List mutations ── Each fires the token-status event so the panel
    // re-broadcasts the masked list; value-changing ops (add / replace) also
    // trigger a re-validate so the per-token status stays fresh.
    addBitbucketToken: async (label, value) => {
      await addBitbucketToken(context.secrets, ATLASSIAN_BITBUCKET_TOKENS_SECRET_KEY, label, value);
      tokenStatusEmitter.fire();
      void atlassianBridge.validate();
    },
    removeBitbucketToken: async (id) => {
      await removeBitbucketToken(context.secrets, ATLASSIAN_BITBUCKET_TOKENS_SECRET_KEY, id);
      tokenStatusEmitter.fire();
    },
    reorderBitbucketTokens: async (orderedIds) => {
      await reorderBitbucketTokens(context.secrets, ATLASSIAN_BITBUCKET_TOKENS_SECRET_KEY, orderedIds);
      tokenStatusEmitter.fire();
    },
    setBitbucketTokenLabel: async (id, label) => {
      await setBitbucketTokenLabel(context.secrets, ATLASSIAN_BITBUCKET_TOKENS_SECRET_KEY, id, label);
      tokenStatusEmitter.fire();
    },
    replaceBitbucketTokenValue: async (id, value) => {
      await replaceBitbucketTokenValue(context.secrets, ATLASSIAN_BITBUCKET_TOKENS_SECRET_KEY, id, value);
      tokenStatusEmitter.fire();
      void atlassianBridge.validate();
    },
    validateBitbucketToken: async (id): Promise<AtlassianValidationResult> => {
      // Re-validate ONE token and merge it into the cached result so Jira and
      // every other token's status is preserved. Starting from the last cached
      // result (or an empty scaffold) keeps a per-row Validate from wiping the
      // rest of the panel.
      const prior = context.workspaceState.get<AtlassianValidationResult>(
        WORKSPACE_STATE_KEYS.ATLASSIAN_LAST_VALIDATION,
      );
      const jira = prior?.jira ?? { status: 'skipped' as const };
      const bitbucket = prior?.bitbucket ? [...prior.bitbucket] : [];
      const entries = await readBbTokens();
      const entry = entries.find((e) => e.id === id);
      if (!entry) {
        // Token was removed between click and probe — drop any stale row.
        const result: AtlassianValidationResult = {
          jira,
          bitbucket: bitbucket.filter((b) => b.id !== id),
          lastCheckedAt: new Date().toISOString(),
        };
        await context.workspaceState.update(WORKSPACE_STATE_KEYS.ATLASSIAN_LAST_VALIDATION, result);
        validationEmitter.fire(result);
        return result;
      }
      const email = readAtlassianSetting('email');
      const bitbucketWorkspace = readAtlassianSetting('bitbucketWorkspace');
      const probed = await probeBitbucketEntry(entry, email, bitbucketWorkspace);
      const idx = bitbucket.findIndex((b) => b.id === id);
      if (idx >= 0) bitbucket[idx] = probed;
      else bitbucket.push(probed);
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

  // Host-side Jira ticket fetcher passed into the loopback bridge. Reads the
  // current email + jiraBase settings and the Jira token via the bridge, builds
  // a fresh AtlassianClient, fetches the
  // ticket, and converts the ADF `description` to plain text host-side so the
  // CLI agent only ever sees text. The Jira token is confined to the client we
  // construct here — it is never logged nor returned in the result.
  const jiraGetTicket = async (
    key: string,
  ): Promise<{ exists: boolean; status?: string; summary?: string; description?: string; error?: string }> => {
    try {
      const email = readAtlassianSetting('email');
      const jiraBase = readAtlassianSetting('jiraBase');
      const jiraToken = await atlassianBridge.getJiraToken();
      const client = new AtlassianClient({
        email,
        jiraToken,
        jiraBase,
        bitbucketWorkspace: '',
      });
      const result = await client.getTicketDetails(key);
      if (!result.exists) {
        return result.error ? { exists: false, error: result.error } : { exists: false };
      }
      const description =
        result.description !== undefined ? adfToPlainText(result.description) : undefined;
      return {
        exists: true,
        status: result.status,
        summary: result.summary,
        description: description || undefined,
      };
    } catch {
      // Never surface an internal error (or the token) to the caller.
      return { exists: false, error: 'ticket fetch failed' };
    }
  };

  // Host-side Jira COMMENT fetcher passed into the loopback bridge. Same
  // containment story as `jiraGetTicket` above: reads the current email +
  // jiraBase settings and the Jira token via the bridge, builds a fresh
  // AtlassianClient, and flattens each comment's ADF body to plain text
  // host-side so the CLI agent only ever sees text. This is a READ — it does
  // not, and must not, post Jira comments.
  //
  // The three outcomes are kept strictly apart, because merging them is exactly
  // the bug that has misled agents before:
  //   - issue exists with no comments -> { exists: true, comments: [] } (SUCCESS)
  //   - issue genuinely absent        -> { exists: false, comments: [] }
  //   - real failure                  -> `error` set, with 'Jira not configured'
  //     distinguishing "no credentials" from "no ticket".
  const jiraGetComments = async (key: string): Promise<GetCommentsResult> => {
    try {
      const email = readAtlassianSetting('email');
      const jiraBase = readAtlassianSetting('jiraBase');
      const jiraToken = await atlassianBridge.getJiraToken();
      const client = new AtlassianClient({
        email,
        jiraToken,
        jiraBase,
        bitbucketWorkspace: '',
      });
      const result = await client.getIssueComments(key);
      if (result.error) {
        return { exists: result.exists, comments: [], error: result.error };
      }
      if (!result.exists) {
        return { exists: false, comments: [] };
      }
      return {
        exists: true,
        comments: result.comments.map((c) => ({
          author: c.author,
          created: c.created,
          body: c.body !== undefined ? adfToPlainText(c.body) : '',
        })),
      };
    } catch {
      // Never surface an internal error (or the token) to the caller.
      return { exists: false, comments: [], error: 'comment fetch failed' };
    }
  };

  // Host-side Jira comment POSTER passed into the loopback bridge. This is the
  // extension's ONLY Jira write. Same containment story as the readers above —
  // settings and token are read here, the token never leaves the host, and only
  // a sanitized result shape goes back to the agent.
  //
  // Authorization does NOT live here. Agent cores forbid ticketing-system
  // mutations outright; the `integration.jira-comment-write` module is what
  // lifts that for a session, and it requires the operator to approve the exact
  // comment text before anything is posted. This closure is the plumbing that
  // module drives, not a licence to post.
  //
  // Note the failure contract: `posted: false` with an error can mean the post
  // definitely failed OR that it timed out ambiguously and may have landed.
  // Nothing here retries, precisely because of that second case.
  const jiraPostComment = async (key: string, body: string): Promise<PostCommentResult> => {
    try {
      const email = readAtlassianSetting('email');
      const jiraBase = readAtlassianSetting('jiraBase');
      const jiraToken = await atlassianBridge.getJiraToken();
      const client = new AtlassianClient({
        email,
        jiraToken,
        jiraBase,
        bitbucketWorkspace: '',
      });
      const result = await client.postIssueComment(key, body);
      if (result.error) {
        return { posted: false, error: result.error };
      }
      return {
        posted: result.posted,
        ...(result.id !== undefined ? { id: result.id } : {}),
      };
    } catch {
      // Never surface an internal error (or the token) to the caller. The
      // comment may or may not have been created — say so honestly rather than
      // implying a clean failure.
      return { posted: false, error: 'comment post failed (state unconfirmed)' };
    }
  };

  // Loopback bridge: exposes `bitbucketPrClient` (Bitbucket PR ops),
  // `jiraGetTicket` (Jira ticket reads), `jiraGetComments` (Jira comment reads)
  // and `jiraPostComment` (the single Jira write, gated by the
  // `integration.jira-comment-write` module) to the CLI agent over a per-session
  // bearer-authenticated HTTP server bound to 127.0.0.1. The Bitbucket and Jira
  // API tokens stay host-side; the agent only receives the loopback URL +
  // bearer token via the session env (wired into the launcher below). When the
  // bridge fails to bind, `startBitbucketBridge` returns null and we inject no
  // env — the CLI-side module then fails loud instead of silently targeting a
  // phantom bridge.
  // `startBitbucketBridge` resolves only once the loopback server is actually
  // listening (so its random port -> url is known). We await it in a
  // fire-and-forget IIFE rather than blocking `activate`: binding a loopback
  // socket completes within a tick, long before the user can click Launch, so
  // `setBridge` runs well before any session starts and the env injects. The
  // token is only ever handed to `setBridge` (terminal env) — never logged.
  //
  // The bridge also writes its live `{ url, token }` to a COORDINATES FILE and
  // the launcher exports that path as GHOLA_BRIDGE_FILE. Location:
  // `context.storageUri` — VS Code's workspace-scoped storage dir, which lives
  // under the extension host's own state, NOT inside the user's workspace
  // folder. That placement is deliberate and load-bearing: the file contains a
  // bearer token, and a token inside the repo could be committed. We fall back
  // to `globalStorageUri` (also outside any workspace) for the no-folder-open
  // case, where `storageUri` is undefined. The path derives from the workspace,
  // never from the random port, so it is STABLE across host restarts — which is
  // the entire point: an already-running agent terminal keeps resolving the
  // live bridge after a reload instead of being orphaned on a dead port.
  const bridgeStorageUri = context.storageUri ?? context.globalStorageUri;
  const bridgeCoordinatesPath = bridgeStorageUri
    ? path.join(bridgeStorageUri.fsPath, 'bridge.json')
    : undefined;
  void (async () => {
    const bbBridge = await startBitbucketBridge(
      bitbucketPrClient,
      jiraGetTicket,
      jiraGetComments,
      jiraPostComment,
      bridgeCoordinatesPath,
      logger,
    );
    if (bbBridge) {
      context.subscriptions.push({ dispose: () => bbBridge.dispose() });
      session.setBridge(bbBridge.url, bbBridge.token, bbBridge.coordinatesPath);
    }
  })();

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

  // Auto-reopen the settings panel after a window reload (e.g. the in-app
  // "Update Extension" flow ends with workbench.action.reloadWindow, which
  // would otherwise close the panel). VS Code persists that a panel of this
  // viewType was open and calls back here on the next activation; we adopt the
  // restored panel onto the same singleton SettingsPanel instance so it
  // re-renders from current extension state. No custom getState/setState is
  // needed — the panel content is derived from workspace/global state, not
  // webview-local state. `onStartupFinished` in activationEvents guarantees the
  // extension is active when restore happens.
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer('gholaSettings', {
      async deserializeWebviewPanel(restored: vscode.WebviewPanel): Promise<void> {
        panel.revive(restored);
      },
    }),
  );

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
    vscode.commands.registerCommand('ghola.atlassianSuite.setJiraToken', async () => {
      const value = await vscode.window.showInputBox({
        prompt: 'Jira API token',
        password: true,
        ignoreFocusOut: true,
      });
      // User cancelled: showInputBox returns undefined. Empty-string and
      // whitespace-only input are treated as cancel too so we don't store a
      // sentinel empty secret or a token corrupted by stray whitespace.
      const token = value?.trim();
      if (!token) return;
      await context.secrets.store(ATLASSIAN_JIRA_TOKEN_SECRET_KEY, token);
      tokenStatusEmitter.fire();
      // Fire-and-forget validation. The validation event listeners pick up
      // the result asynchronously; awaiting would block the command UI until
      // both probes return. Errors inside `validate()` are converted to a
      // `failed` result so no rejection can escape.
      void atlassianBridge.validate();
    }),
    vscode.commands.registerCommand('ghola.atlassianSuite.clearJiraToken', async () => {
      await context.secrets.delete(ATLASSIAN_JIRA_TOKEN_SECRET_KEY);
      tokenStatusEmitter.fire();
      // Re-run validation so the persisted result reflects "Jira token
      // missing" for the cleared product without disturbing Bitbucket's
      // current state. The client handles the per-product `skipped` shape.
      void atlassianBridge.validate();
    }),
    vscode.commands.registerCommand('ghola.atlassianSuite.setBitbucketToken', async () => {
      const value = await vscode.window.showInputBox({
        prompt: 'Bitbucket API token',
        password: true,
        ignoreFocusOut: true,
      });
      const token = value?.trim();
      if (!token) return;
      // Multi-token: APPEND to the ordered list (the failover order) rather than
      // writing the orphaned legacy single key. A single-token user who runs this
      // once still ends up with a working 1-entry list.
      await addBitbucketToken(context.secrets, ATLASSIAN_BITBUCKET_TOKENS_SECRET_KEY, undefined, token);
      tokenStatusEmitter.fire();
      void atlassianBridge.validate();
    }),
    vscode.commands.registerCommand('ghola.atlassianSuite.clearBitbucketToken', async () => {
      // Multi-token: clear the whole list (write an empty array) rather than the
      // orphaned legacy single key. A valid empty list is authoritative, so the
      // migration never re-seeds it from the legacy token on the next read.
      await writeBitbucketTokens(context.secrets, ATLASSIAN_BITBUCKET_TOKENS_SECRET_KEY, []);
      tokenStatusEmitter.fire();
      void atlassianBridge.validate();
    }),
    vscode.commands.registerCommand('ghola.atlassianSuite.validateToken', async () => {
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

  // ───── Commit-and-Push button ───────────────────────────────────────
  // The Commit-and-Push action lives in the Source Control view title bar
  // (see the `scm/title` menu contribution), gated live on the
  // tool.commit-push module via the `ghola.commitPush.enabled` context key.
  const syncCommitPushContextKey = (): void => {
    const enabled = loader.find('tool.commit-push')?.isEnabled === true;
    void vscode.commands.executeCommand('setContext', SET_CONTEXT_KEYS.COMMIT_PUSH_ENABLED, enabled);
  };
  syncCommitPushContextKey();
  context.subscriptions.push(loader.onDidChange(syncCommitPushContextKey));

  // Initial discovery (best-effort). After discover() resolves we apply any
  // user-flagged default configuration so the workspace boots into the same
  // preset they last marked as default. The dev-mode openSettings call below
  // intentionally runs after this chain so the panel renders with the applied
  // configuration in place.
  // CHAINED ahead of discover(), not fired independently: the backfill rewrites
  // the same `ghola.enabledModules` workspaceState key that discover() reads at
  // its start, so racing them would let discover() snapshot the pre-migration
  // list and leave the button hidden until the next reload. The migration never
  // throws, so the chain always reaches discover().
  void migrateCommitPushEnabled(moduleState, context.workspaceState, logger)
    .then(() => loader.discover(resolveModulesDirFn(context)()))
    .then(async (handles) => {
    logger.appendLine(`[ghola] discovered ${handles.length} module(s)`);
    await seedBuiltInConfigurations(context, configurationsStore, logger);
    await panel.applyDefaultOnStartup();

    // Load-time ghola-ledger backfill. `mode.war::enabled` (an Agents
    // configuration tracked in the module-settings store, NOT a loader toggle)
    // can be true while its required `tool.ghola-ledger` module is left disabled
    // in the loader. The dependency is only pulled on the webview master-toggle
    // ON transition, so a session restored/booted with ghola already enabled
    // never composes the ledger contract fragment, leaving TPM's prompt
    // referencing a `ghola` CLI whose contract was never included. Auto-enable
    // the ledger here (same loader.enable path the toggleModule handler uses) so
    // the composed prompt stays coherent. Runs after applyDefaultOnStartup so it
    // reflects the final resolved settings/enabled state. No-op when ghola is off
    // or the ledger is already enabled/undiscovered.
    const gholaFlat = readModuleSettings(context.globalState, context.workspaceState);
    const gholaEnabled = gholaFlat['mode.war::enabled'] === true;
    const ledgerHandle = loader.find('tool.ghola-ledger');
    if (gholaEnabled && ledgerHandle && !ledgerHandle.isEnabled) {
      await loader.enable('tool.ghola-ledger');
      logger.appendLine(
        '[ghola] ghola-ledger backfill: mode.war is enabled but tool.ghola-ledger was disabled; auto-enabled it',
      );
    }

    // One-time boot auto-detect of the Obsidian vault. When `tool.obsidian-notes`
    // is enabled and its `vaultPath` is still empty, run discovery once and write
    // any found vault into the flat module-settings dict — the same write the
    // panel's "Detect Vault" button performs — so Notes goes green without a
    // manual click. Fire-and-forget so the filesystem scan never blocks
    // activation; the empty-only guard makes it naturally one-time (a written
    // path is non-empty on the next boot, so this skips). Wrapped so a scan or
    // write fault just leaves vaultPath empty, exactly as before.
    void (async () => {
      try {
        const notesEnabled = loader.find('tool.obsidian-notes')?.isEnabled === true;
        if (!notesEnabled) return;
        const flat = readModuleSettings(context.globalState, context.workspaceState);
        const current = flat['tool.obsidian-notes::vaultPath'];
        // Empty-only guard: never overwrite a user-set (non-whitespace) path.
        if (typeof current === 'string' && current.trim() !== '') return;
        const result = await discoverObsidianVault();
        if (!result.vaultPath) return;
        // Re-read immediately before writing so a concurrent panel write (e.g. a
        // user clicking Detect Vault mid-scan) is not clobbered by a stale copy.
        const latest = readModuleSettings(context.globalState, context.workspaceState);
        const latestCurrent = latest['tool.obsidian-notes::vaultPath'];
        if (typeof latestCurrent === 'string' && latestCurrent.trim() !== '') return;
        const next = { ...latest, ['tool.obsidian-notes::vaultPath']: result.vaultPath };
        await writeModuleSettings(context.globalState, next);
        // Mirror the panel's Detect-Vault refresh side effects so the panel and
        // composed prompts pick up the newly written path.
        panel.broadcastComposedPrompts();
        moduleSettingsEmitter.fire();
        logger.appendLine(`[ghola] obsidian vault auto-detected on boot: ${result.vaultPath}`);
      } catch (err) {
        logger.appendLine(`[ghola] obsidian vault boot auto-detect failed (non-fatal): ${err}`);
      }
    })();

    if (context.extensionMode === vscode.ExtensionMode.Development) {
      vscode.commands.executeCommand('ghola.openSettings');
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
      if (e.affectsConfiguration('ghola.modulesDir')) {
        void vscode.commands.executeCommand('ghola.reloadModules');
      }
    }),
  );

  // ───── War Room ledger watchers (War Mode) ────────────────────────
  // The ledger root is resolved GLOBALLY (GHOLA_LEDGER_ROOT env, else the
  // `tool.obsidian-notes` `vaultPath` setting -> <vault>/_Gholas, else
  // <homedir>/.ghola/ledger) — the SAME resolution the CLI, launcher, and host
  // use, and NEVER the open work repo. Two watchers on that real location
  // (mirroring loader.watchManifests' 250ms debounce), each re-posting the War
  // Room on any ghola-command / control write:
  //   - ledger:  <root>/**/*.md          — mission/ghola/alerts/notes writes.
  //   - control: <root>/**/control.json  — per-subject cooperative-control writes
  //              (a CLI `*-ack` or a host button touches only control.json, not
  //              any .md, so it needs its own watcher or pending indicators go
  //              stale). control.json is not a .md file, so the ledger watcher
  //              never sees it.
  // The root is static for the session, so both watchers are created once at
  // activation and target the real path even before the dir exists (the CLI's
  // resolveContext mkdir -p's it on first write). Watching a vault on /mnt/c can
  // be unreliable; that is fine — the War Room tab re-reads on open. Both
  // watchers + the debounce timer are disposed on deactivate.
  {
    const ledgerRoot = resolveLedgerRoot(context);
    let warRoomDebounce: ReturnType<typeof setTimeout> | undefined;

    const scheduleWarRoomRefresh = (): void => {
      if (warRoomDebounce !== undefined) clearTimeout(warRoomDebounce);
      warRoomDebounce = setTimeout(() => {
        warRoomDebounce = undefined;
        void panel.postWarRoom();
      }, 250);
    };

    const ledgerWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(ledgerRoot, '**/*.md'),
    );
    ledgerWatcher.onDidCreate(scheduleWarRoomRefresh);
    ledgerWatcher.onDidChange(scheduleWarRoomRefresh);
    ledgerWatcher.onDidDelete(scheduleWarRoomRefresh);

    const controlWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(ledgerRoot, '**/control.json'),
    );
    controlWatcher.onDidCreate(scheduleWarRoomRefresh);
    controlWatcher.onDidChange(scheduleWarRoomRefresh);
    controlWatcher.onDidDelete(scheduleWarRoomRefresh);

    context.subscriptions.push(ledgerWatcher, controlWatcher, {
      dispose: () => {
        if (warRoomDebounce !== undefined) clearTimeout(warRoomDebounce);
      },
    });
  }

  // Dev-mode convenience auto-open lives inside the discover().then() block
  // above so it runs after applyDefaultOnStartup completes.
}

export function deactivate(): void {
  // No-op; subscriptions handle cleanup.
}

/**
 * Built-in presets that were seeded under an earlier name and must be renamed
 * in place on activation. Because seeded presets are tracked by NAME, a plain
 * source rename would strand the old-named entry in existing stores AND seed a
 * fresh duplicate under the new name; the rename-migration pass in
 * `seedBuiltInConfigurations` reconciles both.
 */
const BUILT_IN_RENAMES: { from: string; to: string }[] = [{ from: 'CD (Project)', to: 'Project' }];

/**
 * Built-in presets that were seeded under an earlier build but have since been
 * retired from source. Because seeded presets are tracked by NAME, a plain
 * source deletion would strand the already-seeded entry in existing stores
 * (still shown in the dropdown); the removal-migration pass in
 * `seedBuiltInConfigurations` deletes the stored entry and clears its seeded
 * marker so it neither lingers nor gets resurrected.
 */
const BUILT_IN_REMOVALS: string[] = ['Unconstrained'];

/**
 * Reconcile the built-in configuration presets into the store on every
 * activation, adding any newly-introduced built-in exactly once without
 * duplicating existing presets or resurrecting ones the user deleted.
 *
 * Tracking is by preset NAME via `ghola.configurations.seededNames` (an array
 * of the built-in names already seeded). This replaces the legacy single
 * boolean `CONFIGURATIONS_SEEDED` gate, which short-circuited so a built-in
 * added after first install (e.g. "Self Upgrade") never reached the store.
 *
 * Migration: on an install that predates the names list, if the legacy boolean
 * flag is set, every built-in currently present in the store (matched by name)
 * is treated as already seeded, leaving genuinely-new built-ins eligible to be
 * added. A fresh install (no flag, no list) seeds everything.
 *
 * Presets are appended via a single `store.addMany` write, which generates each
 * id + createdAt and forces `isDefault: false`, so none auto-applies on startup.
 * Seeding stays atomic + retry-safe: the seeded-names list (and legacy flag) are
 * persisted ONLY after the store write succeeds, so a failed write leaves no
 * partial state and the next activation retries cleanly. Even if the names-list
 * write itself fails, the by-name dedupe against `store.getAll()` prevents
 * duplicates on the retry.
 */
async function seedBuiltInConfigurations(
  context: vscode.ExtensionContext,
  store: ConfigurationsStore,
  logger: vscode.OutputChannel,
): Promise<void> {
  // Rename-migration pass: rename any stored built-in preset that was seeded
  // under an old name to its current name, in place (preserving id, enabledIds,
  // settings, isDefault, createdAt via the store's field-preserving update).
  // Runs BEFORE the reconcile/add pass so the renamed preset is recognized as
  // already-seeded and not re-added as a duplicate. A collision guard skips the
  // rename when a config already carries the target name, so the migration
  // never produces two configs with the same name and never clobbers a
  // user-created "to"-named config; the old-named entry is left for the user to
  // resolve in that rare case.
  for (const { from, to } of BUILT_IN_RENAMES) {
    const all = store.getAll();
    const source = all.find((c) => c.name === from);
    if (!source || all.some((c) => c.name === to)) continue;
    try {
      await store.update(source.id, { name: to });
      // Reflect the rename in the persisted seeded-names list so the reconcile
      // pass below treats the renamed preset as already seeded (no re-add). The
      // legacy-boolean install (no names list yet) needs no update here: its
      // seeded set is recomputed from the store by name further down.
      const seeded = context.workspaceState.get<string[]>(WORKSPACE_STATE_KEYS.CONFIGURATIONS_SEEDED_NAMES);
      if (Array.isArray(seeded) && seeded.includes(from)) {
        await context.workspaceState.update(
          WORKSPACE_STATE_KEYS.CONFIGURATIONS_SEEDED_NAMES,
          seeded.map((n) => (n === from ? to : n)),
        );
      }
    } catch (err) {
      // Partial-failure note: store.update already renamed the config to `to`;
      // only the seededNames write failed, so seededNames may be left listing
      // the old `from` name on the next activation. That is harmless: the rename
      // pass then no-ops (no config named `from` remains, so `source` is
      // undefined), and the reconcile pass's existingNames dedupe prevents a
      // duplicate `to` from being added.
      logger.appendLine(`[ghola] built-in configuration rename "${from}" to "${to}" failed: ${err}`);
      return;
    }
  }

  // Recompute after the rename so the reconcile + removal passes see the NEW
  // name and do not add a fresh "Project".
  const existingNames = new Set(store.getAll().map((c) => c.name));

  // Resolve the set of built-in preset NAMES already seeded. This is computed
  // BEFORE the removal pass (below) so that pass's ownership guard can key off
  // the RESOLVED set, which is critical for the legacy-boolean branch: the
  // exact upgrade population BUILT_IN_REMOVALS targets.
  const rawSeeded = context.workspaceState.get<string[]>(
    WORKSPACE_STATE_KEYS.CONFIGURATIONS_SEEDED_NAMES,
  );
  let seededNames: string[];
  if (Array.isArray(rawSeeded)) {
    seededNames = rawSeeded;
  } else if (context.workspaceState.get<boolean>(WORKSPACE_STATE_KEYS.CONFIGURATIONS_SEEDED)) {
    // Legacy install: an older build already seeded the built-ins that existed
    // at the time. Mark every built-in currently present (by name) as done so
    // it is not re-added; genuinely-new built-ins stay eligible below.
    seededNames = BUILT_IN_CONFIGURATIONS.map((p) => p.name).filter((name) => existingNames.has(name));
    // ALSO record any retired (BUILT_IN_REMOVALS) preset that is CURRENTLY
    // PRESENT in the store as seeded. A legacy-boolean install rebuilds
    // seededNames from BUILT_IN_CONFIGURATIONS, which no longer lists
    // "Unconstrained", so without this the removal pass below would never
    // recognize the stored retired preset as ours and would never fire (the
    // precise upgrade population the removal targets). Recording it here lets the
    // removal pass's ownership guard pass, so the retired preset is
    // recorded-as-seeded then removed within this single activation. Accepted
    // trade-off (unchanged from the prior design): a user-CREATED preset that
    // happens to share a retired built-in's name is indistinguishable on a pure
    // legacy install and would also be removed.
    for (const name of BUILT_IN_REMOVALS) {
      if (existingNames.has(name) && !seededNames.includes(name)) seededNames.push(name);
    }
  } else {
    // Fresh install: nothing has been seeded yet.
    seededNames = [];
  }
  const seededSet = new Set(seededNames);

  // Removal-migration pass: delete any stored built-in preset that has been
  // retired from source. Runs AFTER the rename pass (so a renamed-then-retired
  // preset is matched under its current name) and AFTER seededNames is resolved
  // (so the legacy-boolean branch's augmentation above is in effect), and BEFORE
  // the reconcile/add pass. The reconcile pass never re-adds these because they
  // are no longer present in BUILT_IN_CONFIGURATIONS. Idempotent: a name with no
  // matching stored config is a no-op. `store.remove` also clears the
  // active-configuration id when the deleted preset was the active one, so no
  // dangling active id is left behind (same path the panel's deleteConfiguration
  // UI uses).
  for (const name of BUILT_IN_REMOVALS) {
    const target = store.getAll().find((c) => c.name === name);
    if (!target) continue;
    // Ownership guard: only delete a stored config with this name if WE seeded
    // it, i.e. the name is present in the RESOLVED seededNames set. On a
    // names-list install that is the persisted list (a user-created config that
    // merely shares a retired built-in's name is absent from it and is spared);
    // on a legacy-boolean install the branch above added the name iff it is
    // present in the store (the accepted trade-off documented there).
    if (!seededSet.has(name)) continue;
    try {
      await store.remove(target.id);
      // Drop the retired name from the in-memory + persisted seeded-names list
      // so tracking stays clean (the reconcile pass keys off it). Persisting
      // here (rather than only via the final reconcile write) preserves the
      // original removal pass's retry-safety on the names-list path and durably
      // records the legacy-boolean rebuild.
      seededSet.delete(name);
      seededNames = seededNames.filter((n) => n !== name);
      await context.workspaceState.update(
        WORKSPACE_STATE_KEYS.CONFIGURATIONS_SEEDED_NAMES,
        seededNames,
      );
    } catch (err) {
      // Partial-failure note: store.remove already deleted the config from the
      // store; only the seededNames write failed, so seededNames may be left
      // listing the removed name on the next activation. That is harmless: the
      // removal pass then no-ops (no stored config carries the name, so `target`
      // is undefined), and the reconcile pass never re-adds a name absent from
      // BUILT_IN_CONFIGURATIONS.
      logger.appendLine(`[ghola] built-in configuration removal "${name}" failed: ${err}`);
      return;
    }
  }

  // Reconcile: add each built-in whose name is neither already recorded as
  // seeded nor already present in the store (dedupe by name). A built-in the
  // user later deleted keeps its name in seededNames, so it is not resurrected.
  const toAdd = BUILT_IN_CONFIGURATIONS.filter(
    (preset) => !seededSet.has(preset.name) && !existingNames.has(preset.name),
  );

  try {
    if (toAdd.length > 0) {
      await store.addMany(
        toAdd.map((preset) => ({
          name: preset.name,
          enabledIds: preset.enabledIds,
          settings: preset.settings,
        })),
      );
    }
    // Persist the reconciled names list ONLY after the store write succeeds.
    await context.workspaceState.update(WORKSPACE_STATE_KEYS.CONFIGURATIONS_SEEDED_NAMES, [
      ...seededNames,
      ...toAdd.map((p) => p.name),
    ]);
    // Keep the legacy boolean flag set for any other/older reader.
    await context.workspaceState.update(WORKSPACE_STATE_KEYS.CONFIGURATIONS_SEEDED, true);
  } catch (err) {
    logger.appendLine(`[ghola] built-in configuration seeding failed, will retry next activation: ${err}`);
  }
}

function resolveModulesDirFn(context: vscode.ExtensionContext): () => string {
  return () => {
    const cfg = vscode.workspace.getConfiguration('ghola');
    const value = cfg.get<string>('modulesDir') ?? 'modules';
    // Default path: modules ship inside the installed extension, so resolve
    // against extensionPath. This makes the extension self-contained — it finds
    // its bundled modules in ANY workspace the user opens, not just this repo.
    // In the F5 dev host extensionPath is this repo, so dev keeps working.
    if (value === 'modules') {
      return path.join(context.extensionPath, 'modules');
    }
    // Explicit override: an absolute path is used as-is; a relative path points
    // at an in-workspace modules dir (escape hatch), resolved against the open
    // workspace root and falling back to extensionPath when no folder is open.
    if (path.isAbsolute(value)) return value;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? context.extensionPath;
    return path.join(root, value);
  };
}

