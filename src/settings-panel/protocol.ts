// Message protocol shared between extension host and webview.
// Keep this file isomorphic: no `vscode` import, no Node imports.

import type { ModuleManifest } from '../manifest/types';

/**
 * A single Claude CLI alias registered with Ghola.
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
  /** Functional domain group (safety, workflow, orchestration, integration, knowledge, session-mode, utility). */
  category?: string;
  /** Whether this module adds a capability or enforces a convention. */
  kind?: string;
  /** How the module activates (session-start, user-request, phrase-detection, always-applied, event). */
  trigger?: string;
  /** Onboarding priority (essential, recommended, optional). */
  tier?: string;
  /**
   * Mirrors `ModuleManifest.mutuallyExclusiveWith`. Module IDs that cannot be
   * enabled alongside this one. The webview uses this (both directions) to
   * auto-disable conflicts when the user enables this module.
   */
  mutuallyExclusiveWith?: string[];
  /**
   * Mirrors `ModuleManifest.requires`. Module IDs this module depends on. The
   * webview auto-enables these (one level) when the user enables this module.
   */
  requires?: string[];
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
 * `ghola.configurations`. The active selection is tracked separately via
 * `ghola.activeConfigurationId`.
 *
 * `settings` is the flattened `{ "moduleId::fieldKey": value }` shape that
 * mirrors the `ghola.moduleSettings` workspaceState entry, so apply / save
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

// ─── War Room types (War Mode) ──────────────────────────────────────────

/**
 * A single mission record for the War Room, mirroring the `ghola.mjs`
 * `missionToJson` shape (see `board --subject S --json`). `progress` is the
 * chronological list of progress bullets recorded against the mission.
 */
export interface WarRoomMission {
  id: string;
  status: string;
  date: string;
  goal: string;
  groundedIn: string;
  /** Optional mission budget string (e.g. a time/token/cost ceiling). Null when unset. */
  budget?: string | null;
  /**
   * Integration-verification state for the mission, parsed from the mission
   * block's `- integration:` line. One of `pending` / `passed` / `failed`.
   * Absent when the CLI has not written the line (older ledgers).
   */
  integration?: string;
  progress: string[];
}

/**
 * A single roster entry for the War Room, mirroring the `ghola.mjs`
 * `gholaToJson` shape. `missions` are the mission ids this ghola has served.
 */
export interface WarRoomGhola {
  id: string;
  name: string;
  purpose: string;
  state: string;
  model: string;
  last_used: string;
  missions: string[];
  /** Spawn generation, counted from 1 (the original). Defaults to 1 when absent from frontmatter. */
  generation?: number;
  /** Slug of the ghola this one was spawned from, or null when it is an origin (generation 1, no parent). */
  parent?: string | null;
  /** Track-record string in the form `pass:N rework:M`. Defaults to `"pass:0 rework:0"` when absent. */
  reliability?: string;
  /**
   * Per-ghola verification state parsed from the ghola frontmatter's
   * `verification:` field. One of `pending` / `passed` / `failed`. Absent when
   * the CLI has not written the field (older ghola files).
   */
  verification?: string;
}

/**
 * Full per-ghola detail payload for the War Room drill-in view. Read from the
 * ghola's own `.md` file (frontmatter + `## History` body) on demand, rather
 * than carried on every roster entry, since the History body can be long.
 */
export interface GholaDetail {
  /**
   * Echoed back from the `requestGholaDetail` request. Not part of the ghola
   * file's own frontmatter — added so the webview can cache/match responses
   * unambiguously (the roster is scoped per-subject, so `id` alone is not
   * guaranteed unique across subjects).
   */
  subject: string;
  id: string;
  name: string;
  purpose: string;
  state: string;
  model: string;
  created: string;
  last_used: string;
  generation: number;
  parent: string | null;
  reliability: string;
  missions: string[];
  /**
   * Per-ghola verification state parsed from the ghola frontmatter's
   * `verification:` field. One of `pending` / `passed` / `failed`. Empty string
   * when the CLI has not written the field (older ghola files).
   */
  verification?: string;
  /** Raw markdown body of the `## History` section (heading itself excluded). */
  history: string;
  /**
   * False when the ghola's `.md` file could not be located (neither the
   * subject dir nor its `_archive/<subject>/` fallback) or failed to parse.
   * Every other field is then an empty/defaulted placeholder — the webview
   * uses this flag (not field-emptiness) to decide whether to show a "not
   * found" state.
   */
  found: boolean;
}

/**
 * The resolved `mode.war` sub-toggle snapshot the War Room renders in its
 * control zone. Values are resolved (schema defaults layered with user
 * overrides), never `(defaults)` placeholders.
 */
export interface WarRoomSettings {
  autoOpenWarRoom: boolean;
  tournament: boolean;
  maxConcurrentGholas: number;
  dryRun: boolean;
}

/**
 * The full data payload the host reads off the ghola ledger for one subject
 * and ships to the War Room tab. Mirrors the CLI's `board --subject S --json`
 * output (missions / roster / counts / ledgerRoot / subject) plus a resolved
 * `settings` snapshot. When no ledger pointer or no mission exists yet, the
 * host sends `{ empty: true }` and omits the other fields.
 */
export interface WarRoomData {
  /** True when there is no ledger pointer, no ledger dir, or no subject yet. */
  empty?: boolean;
  /** Absolute path to the ledger root the pointer resolved to. */
  ledgerRoot?: string;
  /** The subject (slug) this payload describes. */
  subject?: string;
  /**
   * ALL subject slugs present in the ledger (the immediate subdirs under the
   * ledger root, excluding `_archive`/dotdirs), sorted. Populated on every
   * non-empty payload so the War Room's subject switcher can list every
   * reachable subject, not just the one currently shown in `subject`.
   * Omitted on empty payloads (no ledger / no subjects).
   */
  subjects?: string[];
  /**
   * ALL missions for the subject — open and done alike (Phase 5: the Mission
   * Library / resume picker needs the full history, not just the CLI board's
   * default open-only view). Consumers that want "the current mission" must
   * filter for `status === 'open'` themselves.
   */
  missions?: WarRoomMission[];
  /** Every ghola for the subject (active + dormant + archived). */
  roster?: WarRoomGhola[];
  /** State tallies over the roster. */
  counts?: { active: number; dormant: number; archived: number; total: number };
  /** Resolved `mode.war` sub-toggle values. */
  settings?: WarRoomSettings;
  /**
   * Kill-switch state read from `<workspace>/.ghola/control.json`, when that
   * file exists and parses. Omitted/undefined when the file is absent — the
   * War Room treats that identically to `{ awakenAll: false }` (no banner).
   */
  control?: {
    awakenAll: boolean;
    requestedAt?: string;
    acknowledgedAt?: string;
    /** Id of the mission a "Resume" click asked the TPM agent to pick back up, or null once cleared. */
    resumeMission?: string | null;
    /** ISO 8601 timestamp of the resume request. */
    resumeRequestedAt?: string;
    /** ISO 8601 timestamp the TPM agent (out of band) acknowledged the resume request. */
    resumeAcknowledgedAt?: string;
    /**
     * God-console free-text instruction for the running mission, or null once
     * cleared. Written by the "Send" affordance in the War Room controls zone.
     */
    directive?: string | null;
    /** ISO 8601 timestamp of the directive request. */
    directiveRequestedAt?: string;
    /** ISO 8601 timestamp the TPM agent (out of band) acknowledged the directive. */
    directiveAcknowledgedAt?: string;
    /**
     * Id of the mission a "Declare Done" click asked the TPM agent to wrap up,
     * or null once cleared. Written by the "Declare Done" affordance in the
     * War Room's mission header for the open mission.
     */
    declareDone?: string | null;
    /** ISO 8601 timestamp of the declare-done request. */
    declareDoneRequestedAt?: string;
    /** ISO 8601 timestamp the TPM agent (out of band) acknowledged the declare-done request. */
    declareDoneAcknowledgedAt?: string;
    /**
     * Escalation-resolution QUEUE from the War Room's approve/deny controls.
     * Each entry is one pending decision: `id` is the escalation id (`E` + 4
     * digits), `subject` is the ledger subject the escalation belongs to, and
     * `decision` is `"approve"` or `"deny"`. Written by
     * `requestGholaEscalationResolve` (which APPENDS rather than overwrites, so
     * concurrent resolutions for different escalations do not clobber each
     * other) alongside `escalationResolveRequestedAt`. An empty array (or an
     * omitted field) means nothing is pending.
     */
    escalationResolve?: { id: string; subject: string; decision: string }[];
    /** ISO 8601 timestamp of the escalation-resolution request. */
    escalationResolveRequestedAt?: string;
    /** ISO 8601 timestamp the TPM agent (out of band) acknowledged the escalation-resolution request. */
    escalationResolveAcknowledgedAt?: string;
  };
  /**
   * Alerts recorded against the subject, read from the CLI's per-subject
   * `alerts.md` (tolerant parse — see `parseAlertsSafe` in host.ts). Ordered
   * exactly as the CLI writes them (newest-last, per the CLI's own
   * convention); the War Room does not re-sort. Omitted when the file is
   * absent or empty.
   */
  alerts?: { text: string; date: string }[];
  /**
   * Raw markdown body of the resolved subject's self-tuning
   * `operating-notes.md` (written by the CLI's `ghola note` command), for the
   * War Room's read-only "Operating Notes" display. Omitted when the file is
   * absent, unreadable, or empty. Per the War Mode design these notes are
   * the lowest-precedence guidance layer — they never override core
   * functionality, hard rules, or mode mechanics.
   */
  operatingNotes?: string;
  /**
   * Escalation records for the subject, read from the CLI's per-subject
   * `escalations.md` (tolerant parse; see `parseEscalationsSafe` in host.ts).
   * `id` is `E` + 4 digits, `status` is one of
   * `pending`/`approved`/`denied`/`cancelled` (the last added by the
   * `escalate --cancel` verb),
   * `ghola` is the requesting ghola slug, `at` is an ISO 8601 timestamp, and
   * `text` is the decision text (which may itself contain ` :: `). Ordered
   * exactly as the CLI writes them; the War Room does not re-sort. Omitted when
   * the file is absent or empty.
   */
  escalations?: { id: string; status: string; ghola: string; at: string; text: string }[];
  /**
   * Ownership records for the subject, read from the CLI's per-subject
   * `ownership.md` (tolerant parse; see `parseOwnershipSafe` in host.ts).
   * `path` is the owned file path, `ghola` is the owning ghola slug, and `at`
   * is an ISO 8601 timestamp. Ordered exactly as the CLI writes them; the War
   * Room does not re-sort. Omitted when the file is absent or empty.
   */
  ownership?: { path: string; ghola: string; at: string }[];
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
  | { type: 'updateExtension' }
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
  /** Trigger an on-demand validation probe via the ghola.atlassianSuite.validateToken command. */
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
  | { type: 'openExternal'; url: string }
  /**
   * Request a fresh War Room payload. `subject` optionally pins the view to a
   * specific ledger subject; when omitted the host picks the subject with the
   * most-recent open mission.
   */
  | { type: 'requestWarRoom'; subject?: string }
  /**
   * Emergency team stand-down request from the War Room's "Awaken All"
   * button. The host writes `<workspace>/.ghola/control.json` with
   * `{ awakenAll: true, requestedAt }` and re-posts War Room data; the TPM
   * agent (out of band) polls this file and stands the team down
   * cooperatively — this message does not itself stop anything.
   */
  | { type: 'gholaAwakenAll' }
  /**
   * Mission-library "Resume" click. The host reads-modify-writes
   * `<workspace>/.ghola/control.json`, setting `resumeMission: id` and
   * `resumeRequestedAt` while PRESERVING every other existing field
   * (`awakenAll`/`requestedAt`/`acknowledgedAt` etc. — never clobbered), then
   * re-posts War Room data so the picker shows a "Resuming <id>..." pending
   * indicator. Like `gholaAwakenAll`, this is a cooperative request: the TPM
   * agent (out of band) polls the file and picks the mission back up.
   */
  | { type: 'gholaResumeMission'; id: string }
  /**
   * War Room drill-in: request the full detail payload for one ghola. The
   * host reads `<ledgerRoot>/<subject>/<ghola>.md` (falling back to
   * `_archive/<subject>/<ghola>.md`), parses its frontmatter + `## History`
   * body, and replies with a `gholaDetail` message.
   */
  | { type: 'requestGholaDetail'; subject: string; ghola: string }
  /**
   * God-console instruction for the running mission. The host
   * read-modify-writes `<workspace>/.ghola/control.json`, setting
   * `directive: text` and `directiveRequestedAt` while PRESERVING every other
   * existing field (`awakenAll`/`resumeMission`/etc. — never clobbered), then
   * re-posts War Room data so the pending directive shows. Like
   * `gholaAwakenAll`/`gholaResumeMission`, this is a cooperative request: the
   * TPM agent (out of band) polls the file and acknowledges it.
   */
  | { type: 'gholaDirective'; text: string }
  /**
   * "Declare Done" click on the open mission's War Room header. The host
   * read-modify-writes `<workspace>/.ghola/control.json`, setting
   * `declareDone: id` and `declareDoneRequestedAt` while PRESERVING every
   * other existing field (`awakenAll`/`resumeMission`/`directive`/etc. —
   * never clobbered), then re-posts War Room data so the mission header shows
   * a "Declaring done..." pending indicator in place of the button. Like
   * `gholaAwakenAll`/`gholaResumeMission`/`gholaDirective`, this is a
   * cooperative request: the TPM agent (out of band) polls the file and
   * acknowledges it.
   */
  | { type: 'gholaDeclareDone'; id: string }
  /**
   * Approve/deny click on a War Room escalation. The host read-modify-writes
   * `<workspace>/.ghola/control.json`, APPENDING `{ id, subject, decision }`
   * to the `escalationResolve` queue and setting `escalationResolveRequestedAt`
   * while PRESERVING every other existing field (`awakenAll`/`resumeMission`/
   * `directive`/`declareDone`/etc. are never clobbered), then re-posts War Room
   * data so the escalation shows a pending indicator. `subject` scopes the
   * escalation to its ledger subject so the same `id` under different subjects
   * stays distinct. Like the other ghola control messages, this is a
   * cooperative request: the TPM agent (out of band) polls the file, resolves
   * the escalation, and acknowledges it.
   */
  | { type: 'gholaResolveEscalation'; id: string; subject: string; decision: 'approve' | 'deny' };

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
  | {
      type: 'moduleDetail';
      moduleId: string;
      fragments: PromptFragmentDetail[];
      /**
       * Human/operator-facing setup guide for the module, loaded by the host
       * from `ModuleManifest.setupGuidePath`. Present only when the module
       * declares that field; `error` is set (with empty `content`) on read
       * failure. Rendered in the detail panel's Setup Guide section only —
       * never composed into agent prompts.
       */
      setupGuide?: { content: string; error?: string };
    }
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
  | { type: 'merkleTestConnectionResult'; result: MerkleTestResult | null }
  /** A fresh War Room payload for the tab to render. */
  | { type: 'warRoomData'; data: WarRoomData }
  /** Ask the webview to reveal a named section/tab (e.g. 'warroom'). */
  | { type: 'revealSection'; section: string }
  /** Reply to `requestGholaDetail` — the full per-ghola detail payload. */
  | { type: 'gholaDetail'; data: GholaDetail };
