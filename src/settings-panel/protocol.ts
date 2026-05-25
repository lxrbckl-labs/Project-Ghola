// Message protocol shared between extension host and webview.
// Keep this file isomorphic: no `vscode` import, no Node imports.

import type { ModuleManifest } from '../manifest/types';

/**
 * A single Claude CLI alias registered with Nomeda.
 *
 * IMPORTANT: This must stay in sync with `CliAlias` in
 * `src/session/alias-sync.ts`. We re-declare the shape here (rather than
 * re-exporting) because `alias-sync.ts` imports `fs/promises`, and this
 * protocol file is consumed by both the webview (no Node) and the host.
 */
export interface CliAlias {
  alias: string;
  command: string;
}

export interface ModuleSummary {
  id: string;
  name: string;
  version: string;
  description?: string;
  enabled: boolean;
  /** Mirrors `ModuleManifest.proactive`. The detail view renders a pill when true. */
  proactive?: boolean;
  contributes: ModuleManifest['contributes'];
  /**
   * Unique set of agent targets this module contributes to, derived from
   * `contributes.promptFragments[].target`. "all" is expanded to ["tpm","swe","qa"].
   * Empty array when the module declares no prompt fragments.
   */
  targets: string[];
}

/**
 * A single prompt-fragment payload sent to the webview for the Modules-tab
 * detail view. The webview never reads the filesystem; the host always reads
 * the file (relative to the module root) and ships the raw text. On read
 * failure, `error` is set and `content` is empty.
 */
export interface PromptFragmentDetail {
  target: string;
  contentPath: string;
  absolutePath: string;
  content: string;
  error?: string;
}

/**
 * A user-saved named configuration preset capturing a snapshot of the enabled
 * module set plus the flattened settings dict. Persisted in workspaceState as
 * `nomeda.configurations`. The active selection is tracked separately via
 * `nomeda.activeConfigurationId`.
 *
 * `settings` is the flattened `{ "moduleId::fieldKey": value }` shape that
 * mirrors the `nomeda.moduleSettings` workspaceState entry, so apply / save
 * are straight memcpys against the existing settings store.
 */
export interface NamedConfiguration {
  id: string;
  name: string;
  enabledIds: string[];
  settings: Record<string, Record<string, unknown>>;
  isDefault: boolean;
  createdAt: number;
}

/**
 * A single { keyword, purpose } row from a setting's keywords JSON file.
 * Shipped to the webview verbatim for table rendering, and used by the agent
 * for full reference understanding of the setting's vocabulary.
 */
export interface SettingKeywordEntry {
  keyword: string;
  purpose: string;
}

/**
 * A single entry in the `tool.feedback-log` module's persistent feedback log.
 * Both TPM (via Read/Write tools, given the file path as a manifest parameter)
 * and the Settings panel "Feedback" tab (via host-side Node fs) read and write
 * the same JSON file. The `id` field is an implementation detail used by the
 * panel for triage routing and is not surfaced to the user by TPM.
 */
export interface FeedbackEntry {
  id: string;
  createdAt: string;
  text: string;
  status: 'pending' | 'approved';
  /** Git branch active when the entry was logged. Null when detached HEAD or
   * not a git repo. Absent on entries logged before this field was introduced. */
  branch?: string | null;
}

// ─── Atlassian validation types ───────────────────────────────────────────

/**
 * Per-product validation outcome. Re-declared here (rather than re-exported
 * from `src/extension.ts`) so the webview can consume this file without
 * pulling in any Node / vscode imports.
 */
export interface AtlassianValidationProductStatus {
  status: 'ok' | 'failed' | 'skipped';
  message?: string;
  displayName?: string;
}

export interface AtlassianValidationResult {
  jira: AtlassianValidationProductStatus;
  bitbucket: AtlassianValidationProductStatus;
  /** ISO 8601 timestamp of when the validation probe completed. */
  lastCheckedAt: string;
}

// ─── Merkle test-connection types ─────────────────────────────────────────

/**
 * Outcome of a manual "Test Connection" probe initiated from the
 * `integration.merkle` module's settings detail view. The host fetches
 * `${baseUrl}/api/health` and surfaces the result back to the webview.
 * No credentials are involved — Merkle's health endpoint is unauthenticated.
 */
export interface MerkleTestResult {
  status: 'ok' | 'error';
  /** HTTP status code from the response, when one was received (vs. network failure). */
  httpStatus?: number;
  /** Short human-readable message; on error this names what went wrong. */
  message?: string;
  /** Echoed `name` field from the /api/health JSON body — should be `"project-merkle"`. */
  name?: string;
  /** Echoed `version` field. */
  serverVersion?: string;
  /** Echoed `time` field (ISO 8601 timestamp). */
  serverTime?: string;
  /** The baseUrl the test was run against — UI uses this to invalidate stale results when the user edits the field. */
  testedBaseUrl: string;
}

// Webview → host
export type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'getModules' }
  | { type: 'toggleModule'; id: string; enabled: boolean }
  | { type: 'getSettings' }
  | { type: 'saveSettings'; values: Record<string, unknown> }
  | { type: 'getComposedPrompt'; agent: string }
  | { type: 'reloadModules' }
  | { type: 'copyNewModulePrompt' }
  | { type: 'uploadModule' }
  | { type: 'openSession' }
  | { type: 'requestModuleDetail'; moduleId: string }
  | { type: 'requestSettingKeywords'; moduleId: string; settingKey: string }
  | { type: 'updateConfiguration'; section: string; key: string; value: unknown }
  | { type: 'saveConfigurationCurrent' }
  | { type: 'saveConfigurationAsNew'; name: string }
  | { type: 'selectConfiguration'; id: string | null }
  | { type: 'deleteConfiguration'; id: string }
  | { type: 'renameConfiguration'; id: string; name: string }
  | { type: 'setDefaultConfiguration'; id: string }
  | { type: 'requestLinqpadConnections' }
  | { type: 'copyLinqpadInstallPrompt' }
  | { type: 'openVSCodeSettings'; query: string }
  | { type: 'saveAliases'; aliases: CliAlias[] }
  | { type: 'getAliases' }
  | { type: 'feedbackRequested' }
  | { type: 'feedbackEntryUpdate'; id: string; status: 'approved' }
  | { type: 'feedbackEntryDelete'; id: string }
  | { type: 'atlassianSetJiraToken' }
  | { type: 'atlassianClearJiraToken' }
  | { type: 'atlassianSetBitbucketToken' }
  | { type: 'atlassianClearBitbucketToken' }
  | { type: 'atlassianTokenStatusRequested' }
  /** Trigger an on-demand validation probe via the nomeda.atlassianSuite.validateToken command. */
  | { type: 'atlassianValidate' }
  /** Request the last cached validation result synchronously from the host. */
  | { type: 'atlassianValidationStatusRequested' }
  /**
   * Trigger a manual "Test Connection" probe against the Project-Merkle
   * deployment. `baseUrl` is the live value of the module's `serverBaseUrl`
   * setting at click time — the host echoes it back on the result so the
   * webview can invalidate the chip when the user edits the field afterwards.
   */
  | { type: 'merkleTestConnection'; baseUrl: string }
  /** Open an external https: URL via vscode.env.openExternal. Only https: scheme is accepted. */
  | { type: 'openExternal'; url: string };

// Host → webview
export type HostToWebviewMessage =
  | { type: 'modulesChanged'; modules: ModuleSummary[] }
  | {
      type: 'settingsLoaded';
      values: Record<string, unknown>;
      cliCommand: string;
      sessionCommand: string;
      swe: { performanceCores: number; efficiencyCores: number; performanceCoresModel: string; efficiencyCoresModel: string };
      qa: { count: number; model: string };
      aliases: CliAlias[];
      selectedAlias: string;
      aliasFile: string;
    }
  | { type: 'settingsSaved'; ok: boolean; error?: string }
  | { type: 'composedPromptUpdated'; agent: string; prompt: string }
  | { type: 'moduleDetail'; moduleId: string; fragments: PromptFragmentDetail[] }
  | {
      type: 'settingKeywords';
      moduleId: string;
      settingKey: string;
      keywords: SettingKeywordEntry[];
      error?: string;
    }
  | {
      type: 'configurationsChanged';
      configurations: NamedConfiguration[];
      activeId: string | null;
      isModified: boolean;
    }
  | {
      type: 'linqpadConnections';
      status: 'ok' | 'not-installed' | 'error';
      connections: string[];
      resolvedPath?: string;
      error?: string;
    }
  | { type: 'aliasesLoaded'; aliases: CliAlias[]; selectedAlias: string; aliasFile: string }
  | { type: 'aliasesSaved'; ok: boolean; error?: string }
  | { type: 'feedbackLoaded'; entries: FeedbackEntry[] }
  | { type: 'atlassianTokenStatus'; jiraSet: boolean; bitbucketSet: boolean }
  /**
   * Sent after a validation probe completes (event-driven) or in response to
   * `atlassianValidationStatusRequested` (synchronous pull). `result` is null
   * when no validation has been run yet in this session.
   */
  | { type: 'atlassianValidationResult'; result: AtlassianValidationResult | null }
  /**
   * Sent after a `merkleTestConnection` probe completes. `result` is null
   * when no test has been run yet in this session — the webview uses that to
   * distinguish the untested initial state from a recorded outcome.
   */
  | { type: 'merkleTestConnectionResult'; result: MerkleTestResult | null };
