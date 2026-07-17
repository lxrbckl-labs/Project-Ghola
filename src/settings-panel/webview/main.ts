// Webview-side entry. Compiled to dist/webview.js as a browser IIFE.
// Plain TS + DOM only — no framework, no markdown lib (renders prompts as <pre>).

import type {
  CliAlias,
  GholaDetail,
  HostToWebviewMessage,
  ModuleSummary,
  NamedConfiguration,
  PromptFragmentDetail,
  SettingKeywordEntry,
  WarRoomData,
  WebviewToHostMessage,
} from '../protocol';
import type { SettingsField } from '../../manifest/types';

// ─── Feedback tab protocol types ──────────────────────────────────────────
// kept in sync with src/settings-panel/protocol.ts (SWE-1 owns the canonical
// declarations there; these local re-declarations are removed once the host
// adds them to the union types above).

interface FeedbackEntry {
  id: string;
  createdAt: string; // ISO 8601 date string
  text: string;
  status: 'pending' | 'approved';
  branch?: string | null; // git branch at log time; null = detached HEAD; absent on legacy entries
}

interface FeedbackLoadedMessage {
  type: 'feedbackLoaded';
  entries: FeedbackEntry[];
}

// These are referenced in message-send sites; kept here for documentation.
// interface FeedbackRequestedMessage { type: 'feedbackRequested'; }
// interface FeedbackEntryUpdateMessage { type: 'feedbackEntryUpdate'; id: string; status: 'approved'; }
// interface FeedbackEntryDeleteMessage { type: 'feedbackEntryDelete'; id: string; }

// ─── Atlassian Suite protocol types ─────────────────────────────────────────
// Local re-declarations kept in sync with src/settings-panel/protocol.ts.

/** Masked descriptor of one stored Bitbucket token (never the value). */
interface BitbucketTokenStatus {
  id: string;
  label: string;
  set: boolean;
  last4?: string;
}

interface AtlassianTokenStatusMessage {
  type: 'atlassianTokenStatus';
  jiraSet: boolean;
  /** Last 4 chars of the stored Jira token (masked confirmation hint), if any. */
  jiraLast4?: string;
  /** One masked descriptor per stored Bitbucket token, in failover order. */
  bitbucketTokens: BitbucketTokenStatus[];
}

interface AtlassianValidationProductStatus {
  status: 'ok' | 'failed' | 'skipped';
  message?: string;
  displayName?: string;
}

/** Per-token Bitbucket validation outcome, joined to a row by `id`. */
interface BitbucketTokenValidation extends AtlassianValidationProductStatus {
  id: string;
}

interface AtlassianValidationResult {
  jira: AtlassianValidationProductStatus;
  bitbucket: BitbucketTokenValidation[];
  lastCheckedAt: string;
}

interface AtlassianValidationResultMessage {
  type: 'atlassianValidationResult';
  result: AtlassianValidationResult | null;
}

// Webview → host send-site types (documented here, sent via postMessage):
// interface AtlassianSetJiraTokenMessage { type: 'atlassianSetJiraToken'; }
// interface AtlassianClearJiraTokenMessage { type: 'atlassianClearJiraToken'; }
// interface AtlassianSetBitbucketTokenMessage { type: 'atlassianSetBitbucketToken'; }
// interface AtlassianClearBitbucketTokenMessage { type: 'atlassianClearBitbucketToken'; }
// interface AtlassianTokenStatusRequestedMessage { type: 'atlassianTokenStatusRequested'; }
// interface AtlassianValidateMessage { type: 'atlassianValidate'; }
// interface AtlassianValidationStatusRequestedMessage { type: 'atlassianValidationStatusRequested'; }

interface VsCodeApi {
  postMessage(msg: WebviewToHostMessage): void;
  setState(state: unknown): void;
  getState<T = unknown>(): T | undefined;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

type SectionId =
  | 'general'
  | 'modules'
  | 'agents'
  | 'sessions'
  | 'warroom';

/**
 * Modules-tab navigation state. The tab is either showing the list of all
 * modules or a single module's detail page. Detail pages render inline prompt
 * content fetched from the host; switching tabs or pressing Back resets to
 * 'list' and clears any cached detail payloads.
 */
type ModuleView = { mode: 'list' } | { mode: 'detail'; moduleId: string };

/**
 * Agents-tab navigation state. Mirrors `ModuleView`: the tab shows either the
 * flat list of the three agents or a single agent's detail page (its composed
 * prompt + config). Switching tabs or pressing Back resets to 'list'.
 */
type AgentView = { mode: 'list' } | { mode: 'detail'; agentId: 'tpm' | 'swe' | 'qa' };

/**
 * Inline name-input state for the Configurations row. `false` when no inline
 * editor is active. `{ mode: 'create' }` when entering a name for a new
 * "Save as new" configuration. `{ mode: 'rename', id }` when editing the
 * name of an existing entry. Cleared on tab leave and after submit/cancel.
 */
type ConfigNameEditMode =
  | false
  | { mode: 'create' }
  | { mode: 'rename'; id: string };

interface UIState {
  activeSection: SectionId;
  modules: ModuleSummary[];
  settingsValues: Record<string, unknown>;
  dirty: boolean;
  composedPrompts: Record<string, string>;
  /** Current view inside the Modules tab. Ephemeral. */
  moduleView: ModuleView;
  /** Current view inside the Agents tab. Ephemeral. */
  agentView: AgentView;
  /** Per-module detail payloads keyed by moduleId. Populated by 'moduleDetail' messages. */
  moduleDetails: Record<string, PromptFragmentDetail[]>;
  /**
   * Per-module human/operator-facing setup guides keyed by moduleId. Populated
   * from the 'moduleDetail' message's `setupGuide` field (only for modules that
   * declare `setupGuidePath`). Rendered in the detail panel's Setup Guide
   * section only — never part of any agent prompt.
   */
  moduleSetupGuides: Record<string, { content: string; error?: string }>;
  /**
   * Per-setting keywords payloads keyed by `moduleId::settingKey`. Populated
   * by 'settingKeywords' messages. `error` strings live in `settingKeywordErrors`
   * under the same key so a successful payload (possibly empty) is unambiguous.
   */
  settingKeywords: Record<string, SettingKeywordEntry[]>;
  /** Error strings for keyword loads, keyed identically to `settingKeywords`. */
  settingKeywordErrors: Record<string, string>;
  /** Free-text filter for the Modules tab. Ephemeral; cleared on tab switch. */
  moduleSearch: string;
  /** Value of ghola.cliCommand VS Code configuration. */
  cliCommand: string;
  /** Value of ghola.sessionCommand VS Code configuration. */
  sessionCommand: string;
  /** Current SWE agent counts and model preferences pulled from `ghola.swe.*` VS Code configuration. */
  sweConfig: {
    performanceCores: number;
    efficiencyCores: number;
    performanceCoresModel: string;
    efficiencyCoresModel: string;
  };
  /** Current QA agent count and model preference pulled from `ghola.qa.*` VS Code configuration. */
  qaConfig: { count: number; model: string };
  /** All named configurations known to the host. Updated by 'configurationsChanged'. */
  configurations: NamedConfiguration[];
  /** Currently active configuration id, or null when no preset is selected. */
  activeConfigurationId: string | null;
  /** True when the live module/settings state has diverged from the active config. */
  isConfigurationModified: boolean;
  /** Inline name-input state machine for create / rename UX. */
  configNameEditMode: ConfigNameEditMode;
  /** True when the Manage panel under the kebab is expanded (Modules tab only). */
  configManageOpen: boolean;
  /**
   * LINQPad connection discovery state. Initial 'loading' covers the brief
   * window between webview boot and the host's first `linqpadConnections`
   * payload. The webview never reads the filesystem itself — all data comes
   * from the host. `error` is the host's reported message (only set when
   * status is 'not-installed' or 'error').
   */
  linqpadConnections: {
    status: 'loading' | 'ok' | 'not-installed' | 'error';
    list: string[];
    path?: string;
    error?: string;
  };
  /**
   * Per-keyValue-field dirty drafts. Keyed by `moduleId::settingKey`. While a
   * draft is in flight (user has added / removed / edited rows but not yet
   * clicked Save), the renderer reads from here instead of `settingsValues`.
   * Cleared on Save (after persistSettings) or when the user navigates away
   * from the Modules detail page.
   */
  /**
   * Drafts store either `Record<string, string>` (default keyValue shape) or
   * `Record<string, { value: string; enabled: boolean; description?: string }>`
   * (when the manifest sets `optionalEnabled: true` for the field; the
   * optional `description` is populated when the same field also sets
   * `optionalDescription: true`). Shape is determined per field by
   * `field.optionalEnabled` / `field.optionalDescription` at render time.
   * Note: `description` is panel-only metadata and is stripped from the
   * agent-facing value at compose time.
   */
  keyValueDrafts: Record<
    string,
    Record<string, string> | Record<string, { value: string; enabled: boolean; description?: string }>
  >;
  /** Registered Claude CLI aliases (mirrors `ghola.cliAliases`). */
  aliases: CliAlias[];
  /**
   * Currently-selected alias from the launch dropdown (mirrors
   * `ghola.selectedAlias`). Empty string falls back to the legacy
   * `cliCommand` text input.
   */
  selectedAlias: string;
  /** Shell rc file the aliases are persisted into (mirrors `ghola.aliasFile`). */
  aliasFile: string;
  /**
   * Whether the Jira API token is currently stored in SecretStorage.
   * Set by 'atlassianTokenStatus' messages from the host; never contains the
   * actual token value.
   */
  atlassianJiraTokenSet: boolean;
  /**
   * Ordered list of masked Bitbucket token descriptors (id + label + last4),
   * in failover order. Set by 'atlassianTokenStatus' messages from the host;
   * never contains an actual token value.
   */
  atlassianBitbucketTokens: BitbucketTokenStatus[];
  /**
   * Last 4 characters of the stored Jira token — a masked confirmation
   * fingerprint sent by the host so the operator can verify a token was
   * replaced. Never the full token. Undefined when unset.
   */
  atlassianJiraTokenLast4?: string;
  /** Whether the Jira Clear token button is in its two-step confirm state. */
  atlassianJiraTokenConfirming: boolean;
  /**
   * Id of the Bitbucket token row whose Remove button is currently in its
   * two-step confirm state, or null when none. Only one row confirms at a time.
   */
  atlassianBitbucketRemoveConfirmingId: string | null;
  /**
   * Last validation result received from the host. Null means no validation
   * has been run yet. Updated by 'atlassianValidationResult' messages.
   */
  atlassianValidation: AtlassianValidationResult | null;
  /**
   * True while a validate command is in flight (user clicked Validate /
   * Re-validate). Set to true on click; cleared when a result message arrives.
   */
  atlassianValidating: boolean;
  /**
   * True while a `supportDiscoverPaths` scan is in flight (user clicked
   * Discover paths in the `mode.support` module detail view). Set to true on
   * click; cleared when a `supportDiscoveryResult` message arrives.
   */
  supportDiscovering: boolean;
  /**
   * Last support-mode path-discovery result received from the host via
   * 'supportDiscoveryResult'. Null means no scan has been run yet this
   * session.
   */
  supportDiscoveryResult: {
    found: Record<string, string>;
    notFound: string[];
    scanned: number;
    error?: string;
  } | null;
  /**
   * True while an `obsidianDetectVault` scan is in flight (user clicked
   * Detect vault in the `tool.obsidian-notes` module detail view). Set to
   * true on click; cleared when an `obsidianVaultResult` message arrives.
   */
  obsidianDetecting: boolean;
  /**
   * Last Obsidian vault-detection result received from the host via
   * 'obsidianVaultResult'. Null means no scan has been run yet this session.
   */
  obsidianVaultResult: {
    vaultPath: string | null;
    candidates?: string[];
    scanned: number;
    error?: string;
  } | null;
  /** Feedback entries last received from the host via 'feedbackLoaded'. */
  feedbackEntries: FeedbackEntry[];
  /**
   * Set of entry ids whose "No" button is in the two-step confirm state.
   * When an id is in this set the button renders as "Confirm?" and the next
   * click posts the delete message. A timeout clears the state automatically.
   */
  feedbackPendingNoConfirm: Set<string>;
  /**
   * Last War Room payload received from the host via 'warRoomData'. Undefined
   * until the first response arrives — the War Room tab requests a fresh copy
   * on every tab-entry (see `setSection`), then the host also pushes fresh
   * payloads live whenever the ghola ledger changes on disk.
   */
  warRoomData: WarRoomData | undefined;
  /**
   * True once a 'requestWarRoom' message has been posted for the current
   * empty-data window, so `renderWarRoom` doesn't re-post on every re-render
   * while waiting for the host's reply. Set to `true` by `setSection` on
   * each tab-entry (one request per entry) and by the 'warRoomData' handler
   * on every reply.
   */
  warRoomRequested: boolean;
  /**
   * War Room drill-in: the subject+id of the ghola currently shown in detail,
   * or `null` to show the main War Room view (mission/roster/stable/etc.).
   * Set by clicking a roster or Stable card; cleared by the detail page's
   * Back button.
   */
  warRoomGhola: { subject: string; id: string } | null;
  /**
   * Per-ghola detail payloads keyed by `subject::id` (see
   * `gholaDetailCacheKey`). Populated by 'gholaDetail' messages; cached
   * regardless of which ghola is currently being viewed so re-opening a
   * previously-viewed ghola doesn't re-request while a fresher payload is
   * still in flight for another one.
   */
  gholaDetails: Record<string, GholaDetail>;
  /** God-console instruction draft text, live in the input before Send is clicked. */
  warRoomDirectiveDraft: string;
  /**
   * Operator-selected War Room subject slug, or null to follow the host's
   * auto-pick. Persisted across re-renders so a live watcher push or a
   * tab-entry refresh keeps the chosen subject instead of snapping back to the
   * auto-picked one. Reconciled to null in `renderWarRoom` when the selected
   * subject disappears from the ledger's subject list, so auto refreshes fall
   * back to the payload's `subject`.
   */
  warRoomSelectedSubject: string | null;
  /**
   * When true, the War Room re-requests a fresh payload on a fixed interval
   * (`warRoomAutoRefreshSeconds`) while the tab is on screen. Off by default —
   * the operator opts in via the refresh-row toggle. Held in module state (not
   * persisted), mirroring `warRoomSelectedSubject`.
   */
  warRoomAutoRefresh: boolean;
  /**
   * Auto-refresh cadence in seconds when `warRoomAutoRefresh` is on. Defaults to
   * 30. Adjustable via the refresh-row rate picker.
   */
  warRoomAutoRefreshSeconds: number;
}

const state: UIState = {
  activeSection: 'general',
  modules: [],
  settingsValues: {},
  dirty: false,
  composedPrompts: {},
  moduleView: { mode: 'list' },
  agentView: { mode: 'list' },
  moduleDetails: {},
  moduleSetupGuides: {},
  settingKeywords: {},
  settingKeywordErrors: {},
  moduleSearch: '',
  cliCommand: 'claude',
  sessionCommand: 'initiate',
  sweConfig: { performanceCores: 2, efficiencyCores: 1, performanceCoresModel: 'opus', efficiencyCoresModel: 'sonnet' },
  qaConfig: { count: 1, model: 'sonnet' },
  configurations: [],
  activeConfigurationId: null,
  isConfigurationModified: false,
  configNameEditMode: false,
  configManageOpen: false,
  linqpadConnections: { status: 'loading', list: [] },
  keyValueDrafts: {},
  aliases: [],
  selectedAlias: '',
  aliasFile: '~/.bashrc',
  atlassianJiraTokenSet: false,
  atlassianBitbucketTokens: [],
  atlassianJiraTokenConfirming: false,
  atlassianBitbucketRemoveConfirmingId: null,
  atlassianValidation: null,
  atlassianValidating: false,
  supportDiscovering: false,
  supportDiscoveryResult: null,
  obsidianDetecting: false,
  obsidianVaultResult: null,
  feedbackEntries: [],
  feedbackPendingNoConfirm: new Set(),
  warRoomData: undefined,
  warRoomRequested: false,
  warRoomGhola: null,
  gholaDetails: {},
  warRoomDirectiveDraft: '',
  warRoomSelectedSubject: null,
  warRoomAutoRefresh: false,
  warRoomAutoRefreshSeconds: 30,
};

/**
 * Handle for the War Room auto-refresh interval. Held at module scope (not in
 * the typed `state`) since it is a runtime timer, not serializable UI state.
 * `null` when auto-refresh is off or the War Room tab is not active.
 */
let warRoomAutoRefreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * (Re)apply the War Room auto-refresh timer to match current state. Always
 * clears any existing timer first (so this is safe to call on every toggle,
 * rate change, and tab transition), then starts a fresh interval ONLY when
 * auto-refresh is on AND the War Room tab is active. Each tick posts a
 * `requestWarRoom` unless the operator is drilled into a single-ghola detail,
 * where a background list refresh would be wasted.
 */
function applyWarRoomAutoRefresh(): void {
  if (warRoomAutoRefreshTimer !== null) {
    clearInterval(warRoomAutoRefreshTimer);
    warRoomAutoRefreshTimer = null;
  }
  if (state.warRoomAutoRefresh && state.activeSection === 'warroom') {
    const ms = Math.max(5, state.warRoomAutoRefreshSeconds) * 1000;
    warRoomAutoRefreshTimer = setInterval(() => {
      if (state.activeSection === 'warroom' && !state.warRoomGhola) {
        postRequestWarRoom();
      }
    }, ms);
  }
}

const root = document.getElementById('app')!;

// Inline 16x16 monochrome SVG icons — fill="currentColor" so they pick up the
// surrounding text color (VS Code foreground / button foreground). Path data
// taken from Codicons (refresh, chevron-right, arrow-left) and trimmed.
const REFRESH_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.681 3H2V2h3.5l.5.5V6H5V4a5 5 0 1 0 4.53-.761l.302-.954A6 6 0 1 1 4.681 3z"/></svg>`;

const CHEVRON_RIGHT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M5.7 13.7l-.7-.7L9.6 8.4 5 3.8l.7-.7L11.1 8.4l-5.4 5.3z"/></svg>`;

const ARROW_LEFT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.5 7.5h-9.79l3.65-3.65-.71-.7L1.5 8l5.15 5.15.71-.7-3.65-3.65H13.5v-1.3z"/></svg>`;

const PLAY_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><polygon points="7,5 7,19 19,12"/></svg>`;

// Closed 3-D parcel glyph — sits in the "Update Extension" button next to the
// Play button on the Session launch row. Isometric package box (all faces
// closed, no arrow, no gap), matching Mandrake's update-extension button.
// Stroke-based with stroke="currentColor" so it themes with the surrounding
// button-foreground color; sized 20x20 to match the Play button on this row.
// Source geometry from Tabler Icons "package" (MIT).
const UPDATE_EXTENSION_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 4.5l0 9l-8 4.5l-8 -4.5l0 -9l8 -4.5"/><path d="M12 12l8 -4.5"/><path d="M12 12l0 9"/><path d="M12 12l-8 -4.5"/><path d="M16 5.25l-8 4.5"/></svg>`;

// Floppy-disk save glyph. Sits in the save button next to module setting inputs;
// fill="currentColor" so it picks up the surrounding text color.
const SAVE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.353 1.146l1.5 1.5L15 3v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 14V2a1.5 1.5 0 0 1 1.5-1.5H13l.353.146zM2.5 1.5a.5.5 0 0 0-.5.5v12a.5.5 0 0 0 .5.5H3v-5a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 .5.5v5h.5a.5.5 0 0 0 .5-.5V3.207L12.793 1.5H11v3.5a.5.5 0 0 1-.5.5h-6a.5.5 0 0 1-.5-.5V1.5H2.5zM5 1.5v3h5v-3H5zM4 14h8V9.5H4V14z"/></svg>`;

// Vertical ellipsis — the kebab "Manage" affordance on the Configurations row.
const KEBAB_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="8" cy="3" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="8" cy="13" r="1.4"/></svg>`;

// Plus glyph — the "Save as new" affordance.
const PLUS_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M7.5 1h1v6h6v1h-6v6h-1V8h-6V7h6V1z"/></svg>`;

// Star glyph — marks a configuration as default.
const STAR_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5l1.96 4.05L14.5 6.2l-3.3 3.18.79 4.55L8 11.8l-3.99 2.13.79-4.55L1.5 6.2l4.54-.65L8 1.5z"/></svg>`;

// Pencil glyph — rename affordance in the Manage panel.
const PENCIL_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.23 1l1.77 1.77-9.62 9.62L3 13.5l.11-2.39L12.73 1.5l.5-.5zM11.94 3.79L4.18 11.55l-.06 1.32 1.32-.06 7.76-7.76-1.26-1.26z"/></svg>`;

// Trash glyph — delete affordance in the Manage panel.
const TRASH_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M10 1H6L5 2H2v1h1l1 11h8l1-11h1V2h-3l-1-1zm-3 4h1v8H7V5zm2 0h1v8H9V5zm-4 0h1v8H5V5z"/></svg>`;

// Check glyph — confirm action inside the inline name input.
const CHECK_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.5 7.5a.75.75 0 0 1-1.06 0L1.72 9.28a.75.75 0 1 1 1.06-1.06l3 3 7-7a.75.75 0 0 1 1.06 0z"/></svg>`;

// X glyph — cancel action inside the inline name input.
const CLOSE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06z"/></svg>`;

// Clipboard glyph — used by the "Copy module-generation prompt" button on the
// Modules search row.
const COPY_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M10 1H6a1 1 0 0 0-1 1v1H3.5A1.5 1.5 0 0 0 2 4.5v10A1.5 1.5 0 0 0 3.5 16h9a1.5 1.5 0 0 0 1.5-1.5v-10A1.5 1.5 0 0 0 12.5 3H11V2a1 1 0 0 0-1-1zM6 2h4v2H6V2zm-2.5 3H5v.5a.5.5 0 0 0 .5.5h5a.5.5 0 0 0 .5-.5V5h1.5a.5.5 0 0 1 .5.5v9a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5v-9a.5.5 0 0 1 .5-.5z"/></svg>`;

// Upload tray glyph — used by the "Upload module from filesystem" button on
// the Modules search row. Up-arrow rising out of a tray base.
const UPLOAD_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5l4 4-.71.71L8.5 3.41V11h-1V3.41L4.71 6.21 4 5.5l4-4zM2.5 11.5h1V14h9v-2.5h1V14a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-2.5z"/></svg>`;

// Key glyph — leads each Atlassian token slot to flag the row as a secret/credential field.
// Path adapted from GitHub Octicons (MIT).
const KEY_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M10.5 0a5.5 5.5 0 1 1-1.288 10.848l-.932.932a.75.75 0 0 1-.53.22H7v.75a.75.75 0 0 1-.22.53l-.5.5a.75.75 0 0 1-.53.22H5v.75a.75.75 0 0 1-.22.53l-.5.5a.75.75 0 0 1-.53.22h-2A1.75 1.75 0 0 1 0 14.25v-2c0-.2.079-.39.22-.53l5.932-5.932A5.5 5.5 0 0 1 10.5 0zm0 1.5a4 4 0 0 0-3.957 4.585.75.75 0 0 1-.21.65L1.5 12.56v1.69c0 .136.114.25.25.25h1.69l.06-.06v-.94c0-.2.079-.39.22-.53l.5-.5a.75.75 0 0 1 .53-.22h.94l.06-.06v-.94c0-.2.079-.39.22-.53l.5-.5a.75.75 0 0 1 .53-.22h.94l1.815-1.815a.75.75 0 0 1 .65-.21A4 4 0 1 0 10.5 1.5zm1 2.5a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"/></svg>`;

// GitHub octocat glyph — leads the repo button in the Session header row. Single
// path, fill=currentColor so it inherits the button's theme color (no asset/CSP
// concern). Path adapted from GitHub Octicons (MIT), mark-github 16px.
const GITHUB_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`;

function init(): void {
  render();
  vscode.postMessage({ type: 'ready' });
  vscode.postMessage({ type: 'getSettings' });
  window.addEventListener('message', (ev) => {
    // Route protocol-extension messages before the typed switch so the
    // compiler doesn't complain about unknown discriminants on message types
    // that live outside the HostToWebviewMessage union.
    const raw = ev.data as { type?: string };
    if (raw.type === 'feedbackLoaded') {
      handleFeedbackLoaded(raw as unknown as FeedbackLoadedMessage);
      return;
    }
    if (raw.type === 'atlassianTokenStatus') {
      handleAtlassianTokenStatus(raw as unknown as AtlassianTokenStatusMessage);
      return;
    }
    if (raw.type === 'atlassianValidationResult') {
      handleAtlassianValidationResult(raw as unknown as AtlassianValidationResultMessage);
      return;
    }
    handleMessage(ev.data as HostToWebviewMessage);
  });
  // Escape pops the detail view back to the list (Modules and Agents tabs).
  // Guard against firing when the user is typing in an input field, where
  // Escape is a common "clear/cancel" gesture that should not navigate away.
  window.addEventListener('keydown', (ev) => {
    if (
      ev.key !== 'Escape' ||
      ev.target instanceof HTMLInputElement ||
      ev.target instanceof HTMLSelectElement ||
      ev.target instanceof HTMLTextAreaElement
    ) {
      return;
    }
    if (state.activeSection === 'modules' && state.moduleView.mode === 'detail') {
      backToModuleList();
    } else if (state.activeSection === 'agents' && state.agentView.mode === 'detail') {
      backToAgentList();
    } else if (state.activeSection === 'warroom' && state.warRoomGhola) {
      backFromWarRoomGholaDetail();
    }
  });
}

function handleMessage(msg: HostToWebviewMessage): void {
  switch (msg.type) {
    case 'modulesChanged':
      state.modules = msg.modules;
      // If a detail view is open for a module that no longer exists, pop back to list.
      if (state.moduleView.mode === 'detail') {
        const currentId = state.moduleView.moduleId;
        if (!state.modules.some((m) => m.id === currentId)) {
          state.moduleView = { mode: 'list' };
        }
      }
      render();
      // Refresh prompts whenever modules change.
      ['tpm', 'swe', 'qa'].forEach((id) =>
        vscode.postMessage({ type: 'getComposedPrompt', agent: id }),
      );
      break;
    case 'settingsLoaded':
      state.settingsValues = msg.values ?? {};
      state.cliCommand = msg.cliCommand ?? 'claude';
      state.sessionCommand = msg.sessionCommand ?? 'initiate';
      if (msg.swe) {
        state.sweConfig = {
          performanceCores: msg.swe.performanceCores,
          efficiencyCores: msg.swe.efficiencyCores,
          performanceCoresModel: msg.swe.performanceCoresModel ?? 'opus',
          efficiencyCoresModel: msg.swe.efficiencyCoresModel ?? 'sonnet',
        };
      }
      if (msg.qa) {
        state.qaConfig = {
          count: msg.qa.count,
          model: msg.qa.model ?? 'sonnet',
        };
      }
      state.aliases = msg.aliases ?? [];
      state.selectedAlias = msg.selectedAlias ?? '';
      state.aliasFile = msg.aliasFile ?? '~/.bashrc';
      state.dirty = false;
      render();
      break;
    case 'aliasesLoaded':
      state.aliases = msg.aliases ?? [];
      state.selectedAlias = msg.selectedAlias ?? '';
      state.aliasFile = msg.aliasFile ?? state.aliasFile;
      render();
      break;
    case 'aliasesSaved':
      if (!msg.ok) {
        // Best-effort surface; toast UX is future work — match `settingsSaved`.
        console.error('[ghola] alias save failed', msg.error);
      }
      break;
    case 'settingsSaved':
      if (msg.ok) {
        state.dirty = false;
        render();
      } else {
        // Best-effort surface; real toast UX is future work.
        console.error('[ghola] save failed', msg.error);
      }
      break;
    case 'composedPromptUpdated':
      state.composedPrompts[msg.agent] = msg.prompt;
      render();
      break;
    case 'moduleDetail':
      // Cache the payload regardless. Only re-render if it's still the viewed module.
      state.moduleDetails[msg.moduleId] = msg.fragments;
      if (msg.setupGuide) {
        state.moduleSetupGuides[msg.moduleId] = msg.setupGuide;
      }
      if (
        state.moduleView.mode === 'detail' &&
        state.moduleView.moduleId === msg.moduleId
      ) {
        render();
      }
      break;
    case 'settingKeywords': {
      // Cache regardless — a late-arriving payload after the user navigates
      // away should still populate state for the next visit. Re-render only
      // if the user is still viewing this module's detail page.
      const cacheKey = settingKeywordsCacheKey(msg.moduleId, msg.settingKey);
      if (msg.error) {
        state.settingKeywordErrors[cacheKey] = msg.error;
        delete state.settingKeywords[cacheKey];
      } else {
        state.settingKeywords[cacheKey] = msg.keywords;
        delete state.settingKeywordErrors[cacheKey];
      }
      if (
        state.moduleView.mode === 'detail' &&
        state.moduleView.moduleId === msg.moduleId
      ) {
        render();
      }
      break;
    }
    case 'supportDiscoveryResult':
      handleSupportDiscoveryResult(msg);
      break;
    case 'obsidianVaultResult':
      handleObsidianVaultResult(msg);
      break;
    case 'linqpadConnections':
      state.linqpadConnections = {
        status: msg.status === 'ok' ? 'ok' : msg.status,
        list: msg.connections,
        path: msg.resolvedPath,
        error: msg.error,
      };
      // Only re-render when the user is on a module detail page that actually
      // uses LINQPad; otherwise it's wasted work. Cheap and safe to always
      // re-render though — the dropdown lives behind a navigation gate.
      if (state.activeSection === 'modules' && state.moduleView.mode === 'detail') {
        render();
      }
      break;
    case 'configurationsChanged':
      state.configurations = msg.configurations;
      state.activeConfigurationId = msg.activeId;
      state.isConfigurationModified = msg.isModified;
      // If the active config has been deleted, drop any rename-in-progress
      // pointing at it. Create-mode is tied to user intent, not data — leave alone.
      if (state.configNameEditMode !== false && state.configNameEditMode.mode === 'rename') {
        const renameId = state.configNameEditMode.id;
        if (!state.configurations.some((c) => c.id === renameId)) {
          state.configNameEditMode = false;
        }
      }
      render();
      break;
    case 'warRoomData':
      // Cache regardless of the active tab — a live watcher push can arrive
      // while the user is on a different tab. Only re-render if War Room is
      // actually on screen so we don't pay for DOM work nobody sees.
      state.warRoomData = msg.data;
      state.warRoomRequested = true;
      if (state.activeSection === 'warroom') {
        render();
      }
      break;
    case 'revealSection': {
      // Only known SectionIds are valid navigation targets; ignore anything
      // else defensively (the host currently only ever sends 'warroom', fired
      // on a ghola-mode launch's auto-open).
      const knownSections: SectionId[] = ['general', 'modules', 'agents', 'sessions', 'warroom'];
      if ((knownSections as string[]).includes(msg.section)) {
        setSection(msg.section as SectionId);
      }
      break;
    }
    case 'gholaDetail': {
      // Cache regardless of which ghola is currently open — a late reply for
      // a ghola the user has since navigated away from should still populate
      // state for the next visit. Re-render only if it's still being viewed.
      const cacheKey = gholaDetailCacheKey(msg.data.subject, msg.data.id);
      state.gholaDetails[cacheKey] = msg.data;
      if (
        state.activeSection === 'warroom' &&
        state.warRoomGhola &&
        gholaDetailCacheKey(state.warRoomGhola.subject, state.warRoomGhola.id) === cacheKey
      ) {
        render();
      }
      break;
    }
  }
}

/**
 * Handle the feedbackLoaded message from the host. Updates the entries list
 * and re-renders only the feedback card lists (not the whole tab) to preserve
 * scroll position. Full render is the fallback when the detail view is not active.
 */
function handleFeedbackLoaded(msg: FeedbackLoadedMessage): void {
  state.feedbackEntries = msg.entries;
  const isFeedbackDetailOpen =
    state.activeSection === 'modules' &&
    state.moduleView.mode === 'detail' &&
    state.moduleView.moduleId === 'tool.feedback-log';
  if (isFeedbackDetailOpen) {
    // Re-render only the two card lists in place so scroll position is kept.
    const pendingList = document.getElementById('feedback-pending-list');
    const approvedList = document.getElementById('feedback-approved-list');
    if (pendingList && approvedList) {
      renderFeedbackList(pendingList, 'pending');
      renderFeedbackList(approvedList, 'approved');
      return;
    }
    // Fallback — full render if the lists don't exist yet (first paint).
    render();
  }
}

/**
 * Handle the atlassianTokenStatus message. Updates per-product token-set state
 * and re-renders the token block if the Atlassian Suite module is currently open.
 */
function handleAtlassianTokenStatus(msg: AtlassianTokenStatusMessage): void {
  state.atlassianJiraTokenSet = msg.jiraSet;
  state.atlassianJiraTokenLast4 = msg.jiraLast4;
  state.atlassianBitbucketTokens = msg.bitbucketTokens ?? [];
  // Reset confirming state when tokens flip — the button context changes.
  state.atlassianJiraTokenConfirming = false;
  // Drop a stale remove-confirm if that row no longer exists.
  if (
    state.atlassianBitbucketRemoveConfirmingId !== null &&
    !state.atlassianBitbucketTokens.some((t) => t.id === state.atlassianBitbucketRemoveConfirmingId)
  ) {
    state.atlassianBitbucketRemoveConfirmingId = null;
  }
  const isAtlassianDetailOpen =
    state.activeSection === 'modules' &&
    state.moduleView.mode === 'detail' &&
    state.moduleView.moduleId === 'integration.atlassian-suite';
  if (isAtlassianDetailOpen) {
    // Re-render only the token block in place to preserve scroll position.
    const tokenBlock = document.getElementById('atlassian-token-block');
    if (tokenBlock) {
      const fresh = renderAtlassianTokenSlots();
      fresh.id = 'atlassian-token-block';
      tokenBlock.replaceWith(fresh);
      return;
    }
    render();
  }
}

/**
 * Handle the atlassianValidationResult message. Updates validation state and
 * re-renders only the validation block when the Atlassian Suite detail view is open.
 */
function handleAtlassianValidationResult(msg: AtlassianValidationResultMessage): void {
  state.atlassianValidation = msg.result;
  state.atlassianValidating = false;
  const isAtlassianDetailOpen =
    state.activeSection === 'modules' &&
    state.moduleView.mode === 'detail' &&
    state.moduleView.moduleId === 'integration.atlassian-suite';
  if (isAtlassianDetailOpen) {
    // Re-render both the token block (label colors) and the validation block in
    // place to preserve scroll position.
    const tokenBlock = document.getElementById('atlassian-token-block');
    if (tokenBlock) {
      const freshTokens = renderAtlassianTokenSlots();
      freshTokens.id = 'atlassian-token-block';
      tokenBlock.replaceWith(freshTokens);
    }
    const validationBlock = document.getElementById('atlassian-validation-block');
    if (validationBlock) {
      const fresh = renderAtlassianValidationBlock();
      fresh.id = 'atlassian-validation-block';
      validationBlock.replaceWith(fresh);
      return;
    }
    render();
  }
}

/**
 * Handle the supportDiscoveryResult message. Updates discovery state and, if
 * the `mode.support` module detail view is open, does a full re-render so
 * both the discovery block and the `appMap` keyValue table (a separate
 * element on the same detail page) pick up the newly-written paths. The
 * cached keyValue draft is cleared first — otherwise the table would keep
 * showing the stale pre-scan values even though `state.settingsValues`
 * already has the fresh `appMap` (the host re-posts `settingsLoaded` before
 * this message, per `discoverSupportPaths` in host.ts).
 */
function handleSupportDiscoveryResult(msg: {
  type: 'supportDiscoveryResult';
  found: Record<string, string>;
  notFound: string[];
  scanned: number;
  error?: string;
}): void {
  state.supportDiscovering = false;
  state.supportDiscoveryResult = {
    found: msg.found,
    notFound: msg.notFound,
    scanned: msg.scanned,
    error: msg.error,
  };
  // Discard the cached appMap draft so it re-seeds from the freshly-written
  // state.settingsValues on next render instead of showing stale empties.
  delete state.keyValueDrafts['mode.support::appMap'];
  const isSupportDetailOpen =
    state.activeSection === 'modules' &&
    state.moduleView.mode === 'detail' &&
    state.moduleView.moduleId === 'mode.support';
  if (isSupportDetailOpen) {
    // A full re-render (rather than an in-place block swap, as the Atlassian
    // validation handler does) is required here: the appMap keyValue table is
    // a sibling element on the same detail page and also needs to pick up
    // the re-seeded draft, so there is no single element to target-replace.
    render();
  }
}

/**
 * Handle the obsidianVaultResult message. Updates detection state and, if the
 * `tool.obsidian-notes` module detail view is open, does a full re-render so
 * the `vaultPath` string input picks up the newly-written setting. Unlike
 * the support-mode appMap keyValue field, plain string fields (see
 * `renderModuleSettingField`) read straight from `state.settingsValues` on
 * every render with no separate draft cache, so there is nothing to clear
 * here — the host's `settingsLoaded` reply (sent before this message, per
 * `detectObsidianVault` in host.ts) already refreshed `state.settingsValues`.
 */
function handleObsidianVaultResult(msg: {
  type: 'obsidianVaultResult';
  vaultPath: string | null;
  candidates?: string[];
  scanned: number;
  error?: string;
}): void {
  state.obsidianDetecting = false;
  state.obsidianVaultResult = {
    vaultPath: msg.vaultPath,
    candidates: msg.candidates,
    scanned: msg.scanned,
    error: msg.error,
  };
  const isObsidianDetailOpen =
    state.activeSection === 'modules' &&
    state.moduleView.mode === 'detail' &&
    state.moduleView.moduleId === 'tool.obsidian-notes';
  if (isObsidianDetailOpen) {
    render();
  }
}

function setSection(id: SectionId): void {
  // Reset Modules-tab ephemeral UI state when leaving the Modules tab.
  if (state.activeSection === 'modules' && id !== 'modules') {
    state.moduleSearch = '';
    state.moduleView = { mode: 'list' };
    state.moduleDetails = {};
    state.moduleSetupGuides = {};
    state.settingKeywords = {};
    state.settingKeywordErrors = {};
    // Discard any in-flight keyValue drafts — they only make sense while the
    // user is on a module detail page actively editing rows.
    state.keyValueDrafts = {};
  }
  // Reset Agents-tab ephemeral view state when entering the Agents tab so it
  // always lands on the list (mirrors the Modules reset above).
  if (id === 'agents' && state.activeSection !== 'agents') {
    state.agentView = { mode: 'list' };
  }
  // Reset the War Room drill-in when leaving the tab so re-entering always
  // lands on the main War Room view (mirrors the Modules/Agents resets above).
  if (state.activeSection === 'warroom' && id !== 'warroom') {
    state.warRoomGhola = null;
  }
  // Re-request fresh War Room data on every entry into the tab. Without
  // this, `renderWarRoom`'s own request-once guard (`warRoomRequested`) only
  // fires while `warRoomData` is still undefined — once any payload has
  // arrived (even a stale `{ empty: true }` posted before the ledger watcher
  // was armed), nothing ever prompts a re-fetch again, and the tab can stay
  // stuck showing that stale state. Posting unconditionally here (and
  // pre-marking the guard so `renderWarRoom` doesn't also double-post) keeps
  // it to exactly one request per tab-entry; the host's live watcher pushes
  // keep updating `warRoomData` independently of this.
  if (id === 'warroom' && state.activeSection !== 'warroom') {
    state.warRoomRequested = true;
    postRequestWarRoom();
  }
  // Clear inline configuration name editor and manage panel on any tab leave —
  // both are tab-scoped ephemeral UI states.
  if (state.activeSection !== id) {
    state.configNameEditMode = false;
    state.configManageOpen = false;
  }
  state.activeSection = id;
  // Start the War Room auto-refresh timer on entry (if opted in) and stop it on
  // leave — applyWarRoomAutoRefresh reads the now-updated activeSection.
  applyWarRoomAutoRefresh();
  render();
}

function render(): void {
  root.innerHTML = '';
  root.appendChild(renderRail());
  root.appendChild(renderContent());
}

/**
 * Whether War Mode is enabled. Reads the `mode.war::enabled` setting value
 * (default false) rather than the module's loader/enabled state — the master
 * toggle lives on the Agents tab, not the Modules tab.
 */
function gholaEnabled(): boolean {
  return state.settingsValues['mode.war::enabled'] === true;
}

function renderRail(): HTMLElement {
  // Horizontal top header (tab strip): Session, Modules, and the Agents tab
  // (its own list->detail page), plus War Room while War Mode is enabled.
  const rail = el('nav', { class: 'rail' });
  rail.appendChild(railItem('general', 'Session'));
  rail.appendChild(railItem('modules', 'Modules'));
  rail.appendChild(railItem('agents', 'Agents'));
  // War Room only appears while War Mode is enabled — it has nothing to
  // show otherwise (no ledger pointer is ever set) and its auto-open only
  // fires from a ghola-mode launch, so gating it here keeps the two in sync.
  if (gholaEnabled()) {
    rail.appendChild(railItem('warroom', 'War Room'));
  }
  return rail;
}

function railItem(id: SectionId, label: string): HTMLElement {
  const cls = `rail-item${state.activeSection === id ? ' active' : ''}`;
  const btn = el('button', { class: cls });
  btn.textContent = label;
  btn.addEventListener('click', () => setSection(id));
  return btn;
}

function renderContent(): HTMLElement {
  const wrapper = el('section', { class: 'content' });
  switch (state.activeSection) {
    case 'general':
      renderGeneral(wrapper);
      break;
    case 'modules':
      renderModules(wrapper);
      break;
    case 'agents':
      renderAgents(wrapper);
      break;
    case 'sessions':
      renderSessions(wrapper);
      break;
    case 'warroom':
      renderWarRoom(wrapper);
      break;
  }
  return wrapper;
}

function renderGeneral(wrapper: HTMLElement): void {
  // Header row: project name (left) + action cluster (right). Sits ABOVE the
  // cover hero and is appended unconditionally so it still shows when no cover
  // image is bundled. The action cluster holds the relocated Update Extension
  // button and, to its right, a GitHub button that opens the repo externally.
  const nameRow = el('div', { class: 'session-name-row' });
  nameRow.appendChild(textEl('span', 'PROJECT GHOLA', 'session-name-label'));

  const nameActions = el('div', { class: 'session-name-actions' });

  // Update Extension button — relocated here from the launch row. Delegates to
  // the ghola.updateExtension command on the host; renders [icon][version].
  const updateBtn = el('button', {
    class: 'icon-button framed session-action-button update-extension-btn',
    type: 'button',
    'aria-label': `Update Extension (current version ${root.dataset.version || 'dev'})`,
    title: 'Update the Ghola extension: pull latest from the remote repository, rebuild, reinstall, and reload.',
  }) as HTMLButtonElement;
  const updateBtnIcon = el('span', { class: 'update-btn-icon' });
  updateBtnIcon.innerHTML = UPDATE_EXTENSION_ICON_SVG;
  const updateBtnVersion = textEl('span', root.dataset.version || 'dev', 'update-btn-version');
  updateBtn.append(updateBtnIcon, updateBtnVersion);
  updateBtn.addEventListener('click', () => vscode.postMessage({ type: 'updateExtension' }));

  // GitHub button — far right. Opens the repo via the existing openExternal
  // message (https-only, validated host-side); inline SVG glyph inherits theme.
  const githubBtn = el('button', {
    class: 'icon-button framed session-action-button session-github-button',
    type: 'button',
    'aria-label': 'Open the Project Ghola repository on GitHub',
    title: 'Open the Project Ghola repository on GitHub',
  }) as HTMLButtonElement;
  githubBtn.innerHTML = GITHUB_ICON_SVG;
  githubBtn.addEventListener('click', () => vscode.postMessage({
    type: 'openExternal',
    url: 'https://github.com/lxRbckl/Project-Ghola',
  } as unknown as WebviewToHostMessage));

  nameActions.append(updateBtn, githubBtn);
  nameRow.appendChild(nameActions);
  wrapper.appendChild(nameRow);

  // Hero banner: pixel-art cover image injected by the host as `data-cover-uri`
  // on the `#app` root (mirrors how `data-version` is read). Rendered as the
  // first child of the Session page. When the URI is empty/absent (image not
  // bundled) nothing is rendered, so the page degrades cleanly with no crash.
  const coverUri = root.dataset.coverUri;
  if (coverUri) {
    const hero = el('div', { class: 'session-hero' });
    hero.style.backgroundImage = `url("${coverUri}")`;
    wrapper.appendChild(hero);
  }

  wrapper.appendChild(textEl('h1', 'Session'));
  wrapper.appendChild(textEl('p', 'Configure the command that launches your Ghola agent team, then start a session.', 'subtitle'));

  // Launch row: [Package] [CLI Alias] [Initiation Command] [Configuration] [Play]
  // Package sits at the far left, Play at the far right, with the three
  // label-above-input fields between them. Built first, then appended to the
  // wrapper directly under the Session description (above the alias editor).
  const launchRow = el('div', { class: 'session-launch-row' });

  // Column 1 — CLI Alias picker. Replaces the legacy free-text `cliCommand`
  // input (now relocated below as "Fallback CLI" inside the alias editor).
  // Selecting an alias names the shell-registered Claude CLI invocation the
  // launcher should use; the empty option falls back to the legacy command.
  // Fields carry no visible label; each control surfaces its description via a
  // native `title` tooltip on hover — Ghola's standard hover-help mechanism.
  const aliasField = el('div', { class: 'session-launch-field' });
  const aliasPicker = renderAliasPickerDropdown();
  aliasPicker.title = 'The Claude CLI alias used to launch this session.';
  aliasField.appendChild(aliasPicker);

  // Column 2 — Initiation Command
  const sessionField = el('div', { class: 'session-launch-field' });
  const sessionInp = el('input', { class: 'setting-input session-command-input' }) as HTMLInputElement;
  sessionInp.type = 'text';
  sessionInp.title = 'The trigger word sent to the CLI after it boots to start the Ghola session.';
  sessionInp.value = state.sessionCommand;
  sessionInp.addEventListener('blur', () => {
    state.sessionCommand = sessionInp.value;
    vscode.postMessage({
      type: 'updateConfiguration',
      section: 'ghola',
      key: 'sessionCommand',
      value: sessionInp.value,
    });
  });
  sessionField.appendChild(sessionInp);

  // Column 3 — Configuration dropdown
  const configField = el('div', { class: 'session-launch-field session-launch-field--config' });
  const configDropdown = renderConfigDropdown();
  configDropdown.title = 'The module configuration preset applied to this session.';
  configField.appendChild(configDropdown);

  // Play button — sits inline at the end of the launch row, level with the inputs.
  // Modeled on Mandrake's .dir-row buttons: a framed 28x28 box holding the glyph.
  const sessionBtn = el('button', {
    class: 'icon-button framed session-action-button session-play-button',
    type: 'button',
    'aria-label': 'Open Ghola session',
    title: 'Open a new Ghola session',
  }) as HTMLButtonElement;
  sessionBtn.innerHTML = PLAY_ICON_SVG;
  sessionBtn.addEventListener('click', () => vscode.postMessage({ type: 'openSession' }));

  // Assemble the launch row in visual order: the three fields, then Play (far
  // right). All are direct children of .session-launch-row so the single row gap
  // governs every adjacent pair uniformly; flex-wrap:nowrap keeps them on one
  // line and flex-shrink:0 on .icon-button keeps the button fixed while the
  // fields absorb any narrowing. (The Update Extension button was relocated to
  // the header row above the cover hero.)
  launchRow.appendChild(aliasField);
  launchRow.appendChild(sessionField);
  launchRow.appendChild(configField);
  launchRow.appendChild(sessionBtn);

  // Launch row sits directly under the Session description. The alias registry
  // editor (its own divider) follows below it.
  wrapper.appendChild(launchRow);
  wrapper.appendChild(el('hr', { class: 'section-divider' }));
  wrapper.appendChild(renderAliasEditor());

  // CLAUDE.md bootstrap snippet, styled like the Agents tabs' Instructions
  // panel. Users paste it into their Claude Code CLAUDE.md / user memory.
  wrapper.appendChild(el('hr', { class: 'section-divider' }));
  wrapper.appendChild(renderSessionInstruction());
}

/**
 * Modules tab dispatcher. Renders either the flat list of all modules or a
 * single module's detail page depending on `state.moduleView`.
 */
function renderModules(wrapper: HTMLElement): void {
  if (state.moduleView.mode === 'detail') {
    const targetId = state.moduleView.moduleId;
    const found = state.modules.find((x) => x.id === targetId);
    if (found) {
      renderModuleDetailView(wrapper, found);
      return;
    }
    // Module disappeared — fall through to list view.
    state.moduleView = { mode: 'list' };
  }
  renderModuleListView(wrapper);
}

function renderModuleListView(wrapper: HTMLElement): void {
  wrapper.appendChild(textEl('h1', 'Modules'));
  wrapper.appendChild(
    textEl(
      'p',
      'Toggle modules on or off. Click the chevron (›) to view a module\'s details and instructions.',
      'subtitle',
    ),
  );

  // Configurations row — preset selector + save buttons + kebab manage.
  // Lives between the subtitle and the section divider per the locked design.
  wrapper.appendChild(renderConfigurationsRow({ context: 'modules' }));

  // Horizontal divider between the subtitle and the search/reload row.
  wrapper.appendChild(el('hr', { class: 'section-divider' }));

  // The list is rendered into its own container so search input keystrokes
  // don't blow away the input element (and its focus/selection).
  const listWrap = el('div', { class: 'modules-list' });

  // Search bar + inline reload icon. The bar is a flex row so the input grows
  // and the icon button sits flush on the right at a 28x28 hit target.
  const searchWrap = el('div', { class: 'modules-search' });
  const searchInput = el('input', {
    type: 'search',
    placeholder: 'Search modules…',
    'aria-label': 'Search modules',
  }) as HTMLInputElement;
  searchInput.value = state.moduleSearch;
  searchInput.addEventListener('input', () => {
    state.moduleSearch = searchInput.value;
    renderModulesList(listWrap);
  });
  searchWrap.appendChild(searchInput);

  // Copy module-generation prompt → clipboard. Sits before upload + reload so
  // the row reads [search] [copy] [upload] [reload] left-to-right.
  const copyBtn = el('button', {
    class: 'icon-button framed',
    type: 'button',
    'aria-label': 'Copy Module Generation Instruction',
    title: 'Copy Module Generation Instruction',
  }) as HTMLButtonElement;
  copyBtn.innerHTML = COPY_ICON_SVG;
  copyBtn.addEventListener('click', () =>
    vscode.postMessage({ type: 'copyNewModulePrompt' }),
  );
  searchWrap.appendChild(copyBtn);

  // Upload a module folder from the filesystem (default: ~/Downloads).
  const uploadBtn = el('button', {
    class: 'icon-button framed',
    type: 'button',
    'aria-label': 'Upload module',
    title: 'Upload module from filesystem',
  }) as HTMLButtonElement;
  uploadBtn.innerHTML = UPLOAD_ICON_SVG;
  uploadBtn.addEventListener('click', () =>
    vscode.postMessage({ type: 'uploadModule' }),
  );
  searchWrap.appendChild(uploadBtn);

  const reloadBtn = el('button', {
    class: 'icon-button framed',
    type: 'button',
    'aria-label': 'Reload modules',
    title: 'Reload modules',
  }) as HTMLButtonElement;
  reloadBtn.innerHTML = REFRESH_ICON_SVG;
  reloadBtn.addEventListener('click', () =>
    vscode.postMessage({ type: 'reloadModules' }),
  );
  searchWrap.appendChild(reloadBtn);
  wrapper.appendChild(searchWrap);

  if (state.modules.length === 0) {
    wrapper.appendChild(
      textEl(
        'div',
        'No modules discovered. Place modules under modules/ in your workspace and click Reload.',
        'empty',
      ),
    );
  }

  wrapper.appendChild(listWrap);
  renderModulesList(listWrap);
}

function renderModulesList(container: HTMLElement): void {
  container.innerHTML = '';
  const q = state.moduleSearch.trim().toLowerCase();
  const filtered = state.modules.filter((m) => {
    // mode.war is configured on the Agents tab (its master toggle + sub-
    // controls), not as a toggleable Modules card — hide it from this list.
    if (m.id === 'mode.war') return false;
    if (!q) return true;
    // Base haystack: id, name, description.
    const hay = [m.id, m.name, m.description ?? ''].join(' ').toLowerCase();
    if (hay.includes(q)) return true;
    // Badge match: check if the query is a substring of any badge label (e.g. "tp" → "tpm").
    const badgeLabels = resolveAgentBadgeLabels(m.targets ?? []);
    if (badgeLabels.some((label) => label.includes(q))) return true;
    // Descriptor match: search against category, kind, trigger, tier display text.
    const descLabels = resolveDescriptorLabels(m);
    return descLabels.some((label) => label.includes(q));
  });

  if (q && filtered.length === 0) {
    container.appendChild(textEl('div', 'No modules match.', 'empty'));
    return;
  }

  filtered.forEach((m) => {
    container.appendChild(renderModuleRow(m));
  });
}

/**
 * Compact module row. Layout (left-to-right):
 *   [toggle: stop-propagation zone] [name/meta/desc: navigates to detail] [›]
 * The toggle's click handler stops propagation so flipping the enable state
 * doesn't also navigate into the detail view.
 */
/**
 * Toggle a module while enforcing its manifest constraints on ENABLE.
 *
 * On DISABLE: fire the plain toggle, nothing else (we never touch
 * requires-dependents — keeping the disable path simple).
 *
 * On ENABLE, before the module's own enable we also:
 *   - auto-DISABLE every currently-enabled module that is mutually exclusive
 *     with `m`, checking BOTH directions: modules named in
 *     `m.mutuallyExclusiveWith`, and enabled modules whose own
 *     `mutuallyExclusiveWith` names `m.id`.
 *   - auto-ENABLE `m`'s `requires` deps that aren't already enabled, resolved
 *     TRANSITIVELY (walk the full requires graph, with a visited-set cycle
 *     guard), so a dep-of-a-dep is pulled in too.
 *
 * A required dep is never auto-disabled (requires wins over a contradictory
 * exclusivity declaration). Each action reuses the existing `toggleModule`
 * host message, so the host applies enable/disable independently and
 * re-broadcasts the module list.
 */
function requestToggleModule(m: ModuleSummary, enabled: boolean): void {
  if (!enabled) {
    vscode.postMessage({ type: 'toggleModule', id: m.id, enabled: false });
    return;
  }

  const requires = m.requires ?? [];

  // Enable set: resolve `requires` TRANSITIVELY, walking the full dependency
  // graph (BFS) so a chain like tool.qa-pr-learning ->
  // integration.bitbucket-pr-comments -> integration.atlassian-suite enables
  // BOTH downstream deps, not just the first level. `visited` (seeded with the
  // module itself) guards against cycles: a module that transitively requires
  // something which requires it back terminates instead of looping forever. An
  // already-enabled dep is still walked so its own transitive requires are
  // pulled in, but only currently-disabled deps are queued to be toggled on.
  //
  // `requiredClosure` collects EVERY module reached through the requires graph
  // (deps only, excluding `m`) regardless of its current enabled state; it is
  // the transitive protection set used below both to seed mutex sources and to
  // guard against auto-disabling anything the enable depends on.
  const enableSet = new Set<string>();
  const requiredClosure = new Set<string>();
  const visited = new Set<string>([m.id]);
  const queue = [...requires];
  while (queue.length > 0) {
    const dep = queue.shift()!;
    if (visited.has(dep)) continue;
    visited.add(dep);
    requiredClosure.add(dep);
    const depMod = state.modules.find((x) => x.id === dep);
    if (!depMod) continue;
    if (!depMod.enabled) enableSet.add(dep);
    for (const next of depMod.requires ?? []) {
      if (!visited.has(next)) queue.push(next);
    }
  }

  // Disable set: bidirectional mutual-exclusivity against currently-enabled
  // modules. Widened beyond the top-level module to also honor the mutex
  // declarations of every module the transitive walk will enable: each dep
  // pulled in by `requires` brings its OWN `mutuallyExclusiveWith` (both
  // directions) into force, so enabling a dep can't leave a module it excludes
  // silently enabled. The mutex "sources" are `m` plus every module in the
  // required closure.
  const mutexSources: ModuleSummary[] = [m];
  for (const dep of requiredClosure) {
    const depMod = state.modules.find((x) => x.id === dep);
    if (depMod) mutexSources.push(depMod);
  }
  const disableSet = new Set<string>();
  for (const source of mutexSources) {
    for (const other of state.modules) {
      if (other.id === source.id || !other.enabled) continue;
      const forward = (source.mutuallyExclusiveWith ?? []).includes(other.id);
      const reverse = (other.mutuallyExclusiveWith ?? []).includes(source.id);
      if (forward || reverse) disableSet.add(other.id);
    }
  }
  // A required dependency must never be auto-disabled (requires wins over a
  // contradictory exclusivity declaration). Guard the FULL transitive closure,
  // not just direct requires, so a transitively-required module is never
  // simultaneously slated for disable; also never disable `m` itself.
  disableSet.delete(m.id);
  for (const dep of requiredClosure) disableSet.delete(dep);

  // Apply: disable conflicts first, then enable the module and its deps.
  for (const id of disableSet) {
    vscode.postMessage({ type: 'toggleModule', id, enabled: false });
  }
  vscode.postMessage({ type: 'toggleModule', id: m.id, enabled: true });
  for (const id of enableSet) {
    vscode.postMessage({ type: 'toggleModule', id, enabled: true });
  }
}

function renderModuleRow(m: ModuleSummary): HTMLElement {
  const row = el('div', { class: 'module-row' });

  // Toggle zone — clicks here must not bubble up to the navigate handler.
  const toggleZone = el('div', { class: 'module-row-toggle' });
  toggleZone.addEventListener('click', (ev) => ev.stopPropagation());
  toggleZone.appendChild(
    renderToggle({
      checked: m.enabled,
      onChange: (next) => {
        requestToggleModule(m, next);
      },
      ariaLabel: `Enable ${m.name}`,
    }),
  );
  row.appendChild(toggleZone);

  // Text zone — non-interactive; displays name, id, version, description, badges.
  const textZone = el('div', { class: 'module-row-body' });
  const title = el('div', { class: 'module-title' });
  const nameEl = el('strong');
  nameEl.textContent = m.name;
  title.appendChild(nameEl);
  const metaEl = el('span', { class: 'meta' });
  metaEl.textContent = ` · v${m.version}`;
  title.appendChild(metaEl);
  textZone.appendChild(title);
  if (m.description) {
    textZone.appendChild(textEl('div', m.description, 'desc'));
  }
  // Agent badges + descriptor badges combined into one wrapping flex row below
  // the description. The proactive pill (when set) is a sibling in that same
  // container so all pills share one layout / spacing / visual treatment.
  const rowBadges =
    renderAgentBadges(m.targets ?? []) ??
    (m.proactive ? el('div', { class: 'agent-badges' }) : null);
  if (m.proactive && rowBadges) {
    const pill = el('span', { class: 'proactive-pill' });
    pill.textContent = 'Proactive';
    rowBadges.appendChild(pill);
  }
  // Merge descriptor spans into the same container (or create one if there were
  // no agent badges and the module is not proactive).
  const rowDescriptors = renderDescriptorBadges(m);
  if (rowDescriptors) {
    const badgeContainer = rowBadges ?? el('div', { class: 'agent-badges' });
    while (rowDescriptors.firstChild) {
      badgeContainer.appendChild(rowDescriptors.firstChild);
    }
    textZone.appendChild(badgeContainer);
  } else if (rowBadges) {
    textZone.appendChild(rowBadges);
  }
  row.appendChild(textZone);

  // Chevron — the sole navigation affordance for this row.
  const chevron = el('button', {
    class: 'module-row-chevron',
    type: 'button',
    'aria-label': `Open ${m.name} details`,
    title: 'Open details',
  }) as HTMLButtonElement;
  chevron.innerHTML = CHEVRON_RIGHT_SVG;
  chevron.addEventListener('click', () => openModuleDetail(m.id));
  row.appendChild(chevron);

  return row;
}

// ─── Configurations row helpers ──────────────────────────────────────────

interface ConfigRowOptions {
  /**
   * Where the row is being rendered. Currently 'modules' shows the full row
   * (dropdown + save buttons + kebab); 'session' is reserved if we ever need
   * a richer row on the Session tab (today the Session tab uses a bare
   * dropdown via `renderConfigDropdown`).
   */
  context: 'modules';
}

/**
 * Shared Configurations row: dropdown + Save / Save-as-new buttons + kebab
 * Manage toggle. When the inline name editor is open (create or rename), the
 * normal controls are replaced by a focused input + check/close pair.
 *
 * Save / Save-as-new live ONLY on the Modules tab per the locked design; the
 * Session tab embeds a bare dropdown via `renderConfigDropdown` instead.
 */
function renderConfigurationsRow(_opts: ConfigRowOptions): HTMLElement {
  const row = el('div', { class: 'configurations-row' });

  // Inline name editor takes the whole row when active. The state machine
  // dictates the placeholder + which message gets sent on submit.
  if (state.configNameEditMode !== false) {
    row.appendChild(renderConfigNameInput(state.configNameEditMode));
    return row;
  }

  // Dropdown — non-stretching, ~220px, occupies the left side.
  row.appendChild(renderConfigDropdown());

  // Save (commits current state into the active configuration). Disabled when
  // there is no active config OR the live state matches it already.
  const saveBtn = el('button', {
    class: 'config-action-button',
    type: 'button',
    'aria-label': 'Save changes to active configuration',
    title: 'Save changes to active configuration',
  }) as HTMLButtonElement;
  saveBtn.innerHTML = SAVE_ICON_SVG;
  const canSave =
    state.activeConfigurationId !== null && state.isConfigurationModified;
  saveBtn.disabled = !canSave;
  saveBtn.addEventListener('click', () => {
    if (!canSave) return;
    vscode.postMessage({ type: 'saveConfigurationCurrent' });
  });
  row.appendChild(saveBtn);

  // Save as new — opens the inline name editor in 'create' mode.
  const saveAsBtn = el('button', {
    class: 'config-action-button',
    type: 'button',
    'aria-label': 'Save current state as new configuration',
    title: 'Save current state as new configuration',
  }) as HTMLButtonElement;
  saveAsBtn.innerHTML = PLUS_ICON_SVG;
  saveAsBtn.addEventListener('click', () => {
    state.configNameEditMode = { mode: 'create' };
    state.configManageOpen = false;
    render();
  });
  row.appendChild(saveAsBtn);

  // Kebab — toggles the inline Manage panel that lists per-config actions.
  // Disabled when there are no saved configurations to manage.
  const kebabBtn = el('button', {
    class: 'config-action-button',
    type: 'button',
    'aria-label': 'Manage configurations',
    title: 'Manage configurations',
  }) as HTMLButtonElement;
  kebabBtn.innerHTML = KEBAB_ICON_SVG;
  kebabBtn.disabled = state.configurations.length === 0;
  if (state.configManageOpen) kebabBtn.classList.add('active');
  kebabBtn.addEventListener('click', () => {
    if (state.configurations.length === 0) return;
    state.configManageOpen = !state.configManageOpen;
    render();
  });
  row.appendChild(kebabBtn);

  // Manage panel renders directly after the row (still inside this helper so
  // it stays visually associated with the controls that opened it).
  const wrapper = el('div', { class: 'configurations-wrapper' });
  wrapper.appendChild(row);
  if (state.configManageOpen && state.configurations.length > 0) {
    wrapper.appendChild(renderConfigManagePanel());
  }
  return wrapper;
}

/** Standalone dropdown — used on its own in the Session tab. */
function renderConfigDropdown(): HTMLElement {
  const select = el('select', {
    class: 'config-dropdown',
    'aria-label': 'Active configuration',
  }) as HTMLSelectElement;

  const noneOption = el('option') as HTMLOptionElement;
  noneOption.value = '';
  noneOption.textContent = 'No configuration';
  select.appendChild(noneOption);

  state.configurations.forEach((c) => {
    const opt = el('option') as HTMLOptionElement;
    opt.value = c.id;
    opt.textContent = c.isDefault ? `${c.name}  ★` : c.name;
    select.appendChild(opt);
  });

  select.value = state.activeConfigurationId ?? '';

  select.addEventListener('change', () => {
    const next = select.value === '' ? null : select.value;
    vscode.postMessage({ type: 'selectConfiguration', id: next });
  });

  return select;
}

// ─── CLI alias registry helpers ──────────────────────────────────────────

/**
 * Launch-row alias picker. Mirrors the structure of `renderConfigDropdown`
 * (same `<select>` + `<option>` shape, same `setting-input` class) so the two
 * dropdowns visually rhyme on the Session row. When no aliases are registered a
 * single disabled placeholder option is shown; otherwise one option per alias.
 */
function renderAliasPickerDropdown(): HTMLElement {
  const select = el('select', {
    class: 'setting-input session-command-input',
    'aria-label': 'Claude CLI alias',
  }) as HTMLSelectElement;

  if (state.aliases.length === 0) {
    const placeholderOpt = el('option') as HTMLOptionElement;
    placeholderOpt.value = '';
    placeholderOpt.textContent = '(no aliases registered)';
    placeholderOpt.disabled = true;
    select.appendChild(placeholderOpt);
  } else {
    state.aliases.forEach((a) => {
      const opt = el('option') as HTMLOptionElement;
      opt.value = a.alias;
      opt.textContent = a.alias;
      select.appendChild(opt);
    });
  }

  select.value = state.selectedAlias ?? '';

  select.addEventListener('change', () => {
    state.selectedAlias = select.value;
    vscode.postMessage({
      type: 'updateConfiguration',
      section: 'ghola',
      key: 'selectedAlias',
      value: select.value,
    });
  });

  return select;
}

/**
 * Full alias editor block: heading + subhead + table (existing rows + add row).
 *
 * Layout mirrors `appendKeyValueEditor` — same `kv-table-wrap` / `kv-table`
 * scaffolding and `kv-cell-*` classes so the visual density (table-layout:
 * fixed, tight padding) carries over without new CSS.
 *
 * Auto-save semantics: every mutation (add / edit alias name on blur / edit
 * command on blur / delete) posts a `saveAliases` with the full trimmed list.
 * The host owns conflict reconciliation and rc-file writeback.
 */
/**
 * Extract the CLAUDE_CONFIG_DIR value from an alias command for display. Honors
 * quoting and extra leading env vars, falls back to `~/.claude`, and normalizes
 * `$HOME`/`${HOME}` to `~`.
 */
function aliasConfigDir(command: string): string {
  const m = command.match(/CLAUDE_CONFIG_DIR=(?:"([^"]*)"|'([^']*)'|(\S+))/);
  const raw = m ? (m[1] ?? m[2] ?? m[3]) : '';
  if (!raw) return '~/.claude';
  return raw.replace(/^\$\{?HOME\}?(?=\/|$)/, '~');
}

function renderAliasEditor(): HTMLElement {
  const block = el('div', { class: 'alias-editor' });

  // Section heading + subhead. Using plain h3/p — the file's other headings
  // are h1/h2 with class-based styling; this block is a sub-section so h3
  // keeps the visual hierarchy below the page title.
  const heading = el('h3', { class: 'setting-keywords-heading' });
  heading.textContent = 'Claude CLI Aliases';
  heading.style.marginBottom = '2px';
  block.appendChild(heading);
  const subtitle = textEl(
    'p',
    'Manage the aliases written to your shell rc file. Pick one in the dropdown below to launch with that Claude session.',
    'subtitle',
  );
  subtitle.style.marginTop = '0';
  block.appendChild(subtitle);

  // ── Table of existing aliases ──────────────────────────────────────
  // The `kv-table--full-width` modifier drops the shared 720px ceiling so
  // the alias table stretches to fill the Session tab. This editor doesn't
  // route through `appendKeyValueEditor`, so the modifier is applied here
  // directly rather than via a `fullWidth: true` manifest flag.
  const tableWrap = el('div', { class: 'kv-table-wrap' });
  const table = el('table', { class: 'kv-table kv-table--full-width' });

  const thead = el('thead');
  const headRow = el('tr');
  const aliasHead = el('th');
  aliasHead.textContent = 'Alias';
  const configDirHead = el('th', { class: 'kv-cell-configdir' });
  configDirHead.textContent = 'Config Dir';
  const actionHead = el('th', { class: 'kv-actions-head' });
  headRow.appendChild(aliasHead);
  headRow.appendChild(configDirHead);
  headRow.appendChild(actionHead);
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  if (state.aliases.length === 0) {
    const emptyRow = el('tr', { class: 'kv-empty-row' });
    const td = el('td');
    td.setAttribute('colspan', '3');
    td.textContent = 'No aliases registered. Add one below.';
    emptyRow.appendChild(td);
    tbody.appendChild(emptyRow);
  } else {
    state.aliases.forEach((a, index) => {
      tbody.appendChild(renderAliasRow(a, index));
    });
  }
  table.appendChild(tbody);

  // Add-row at the bottom — same `<tfoot>` pattern as `renderKeyValueAddRow`.
  table.appendChild(renderAliasAddRow());

  tableWrap.appendChild(table);
  block.appendChild(tableWrap);

  return block;
}

/**
 * Single committed-alias row: alias-name input (blur-committed) + delete button.
 * The command is auto-built from the template on rename and never displayed.
 */
function renderAliasRow(a: CliAlias, index: number): HTMLElement {
  const tr = el('tr', { class: 'kv-row' });

  // Alias-name input.
  const aliasTd = el('td', { class: 'kv-cell' });
  const aliasInp = el('input', { class: 'setting-input kv-input' }) as HTMLInputElement;
  aliasInp.type = 'text';
  aliasInp.value = a.alias;
  aliasInp.addEventListener('change', () => {
    const next = aliasInp.value.trim();
    if (next === a.alias) return;
    if (next.length === 0) {
      aliasInp.value = a.alias;
      return;
    }
    // Reject names that don't match the allowed character set.
    if (!/^[A-Za-z0-9_-]+$/.test(next)) {
      aliasInp.value = a.alias;
      return;
    }
    // Collision with another alias name → roll back the input.
    if (state.aliases.some((other, i) => i !== index && other.alias === next)) {
      aliasInp.value = a.alias;
      return;
    }
    // Rebuild the command from the template using the new alias name.
    const builtCommand = `CLAUDE_CONFIG_DIR=$HOME/.${next} command claude`;
    state.aliases[index] = { alias: next, command: builtCommand };
    persistAliases();
    render();
  });
  aliasTd.appendChild(aliasInp);
  tr.appendChild(aliasTd);

  // Read-only derived Config Dir column. Shows the parsed CLAUDE_CONFIG_DIR
  // path; hovering reveals the full command via the title attribute.
  const configDirTd = el('td', { class: 'kv-cell kv-cell-configdir' });
  const configDirSpan = el('span', { class: 'kv-configdir-text', title: a.command });
  configDirSpan.textContent = aliasConfigDir(a.command);
  configDirTd.appendChild(configDirSpan);
  tr.appendChild(configDirTd);

  // Delete button.
  const actionTd = el('td', { class: 'kv-cell kv-cell-actions' });
  const delBtn = el('button', {
    class: 'icon-button kv-delete-button',
    type: 'button',
    'aria-label': `Delete ${a.alias}`,
    title: 'Delete',
  }) as HTMLButtonElement;
  delBtn.innerHTML = TRASH_ICON_SVG;
  delBtn.addEventListener('click', () => {
    state.aliases = state.aliases.filter((_, i) => i !== index);
    // If the deleted alias was the active selection, drop it.
    if (state.selectedAlias === a.alias) {
      state.selectedAlias = '';
      vscode.postMessage({
        type: 'updateConfiguration',
        section: 'ghola',
        key: 'selectedAlias',
        value: '',
      });
    }
    persistAliases();
    render();
  });
  actionTd.appendChild(delBtn);
  tr.appendChild(actionTd);

  return tr;
}

/**
 * Add-alias `<tfoot>` row. Single alias-name input + Add button. The command
 * is auto-built from the template `CLAUDE_CONFIG_DIR=$HOME/.<name> command claude`
 * and never shown to the user.
 */
function renderAliasAddRow(): HTMLElement {
  const tfoot = el('tfoot', { class: 'kv-add-foot' });
  const tr = el('tr', { class: 'kv-add-row' });

  const aliasTd = el('td', { class: 'kv-cell kv-add-cell' });
  const aliasField = el('div', { class: 'kv-add-field' });
  const aliasInp = el('input', { class: 'setting-input kv-input' }) as HTMLInputElement;
  aliasInp.type = 'text';
  aliasInp.placeholder = 'claude-1';
  aliasInp.title = 'Name for the new Claude CLI alias';
  aliasField.appendChild(aliasInp);
  aliasTd.appendChild(aliasField);
  tr.appendChild(aliasTd);

  // Config Dir preview column — mirrors the data rows and live-updates to show
  // the `~/.<name>` path the auto-built command would use as the user types.
  const configDirTd = el('td', { class: 'kv-cell kv-cell-configdir' });
  const configDirSpan = el('span', { class: 'kv-configdir-text' });
  const updateConfigDirPreview = () => {
    const typed = aliasInp.value.trim();
    configDirSpan.textContent = typed.length > 0 ? `~/.${typed}` : '';
  };
  updateConfigDirPreview();
  aliasInp.addEventListener('input', updateConfigDirPreview);
  configDirTd.appendChild(configDirSpan);
  tr.appendChild(configDirTd);

  const actionTd = el('td', { class: 'kv-cell kv-cell-actions kv-add-cell kv-add-cell--actions' });
  const addBtn = el('button', { class: 'primary kv-add-button', type: 'button' }) as HTMLButtonElement;
  addBtn.textContent = 'Add';
  addBtn.addEventListener('click', () => {
    const aliasName = aliasInp.value.trim();
    // Validate: non-empty and only allowed characters.
    if (aliasName.length === 0 || !/^[A-Za-z0-9_-]+$/.test(aliasName)) {
      aliasInp.style.borderColor = 'var(--vscode-inputValidation-errorBorder)';
      return;
    }
    aliasInp.style.borderColor = '';
    // Reject duplicates — visually mark the alias input red.
    if (state.aliases.some((a) => a.alias === aliasName)) {
      aliasInp.style.borderColor = 'var(--vscode-inputValidation-errorBorder)';
      return;
    }
    // Build the command from the fixed template.
    const builtCommand = `CLAUDE_CONFIG_DIR=$HOME/.${aliasName} command claude`;
    state.aliases.push({ alias: aliasName, command: builtCommand });
    persistAliases();
    render();
  });
  actionTd.appendChild(addBtn);
  tr.appendChild(actionTd);

  tfoot.appendChild(tr);
  return tfoot;
}

/**
 * Post the full alias list to the host. Optimistic-update semantics: the local
 * `state.aliases` is already correct by the time we get here — the host write
 * is best-effort and surfaces errors via `aliasesSaved`.
 */
function persistAliases(): void {
  vscode.postMessage({ type: 'saveAliases', aliases: state.aliases });
}

function renderConfigNameInput(mode: { mode: 'create' } | { mode: 'rename'; id: string }): HTMLElement {
  const row = el('div', { class: 'config-name-input-row' });
  const input = el('input', { class: 'config-name-input', type: 'text' }) as HTMLInputElement;
  input.placeholder = mode.mode === 'create' ? 'New configuration name' : 'Rename configuration';
  if (mode.mode === 'rename') {
    const existing = state.configurations.find((c) => c.id === mode.id);
    if (existing) input.value = existing.name;
  }
  input.autofocus = true;
  // Focus on next tick — the element isn't in the DOM until render() finishes
  // attaching it, so an immediate input.focus() is a no-op.
  queueMicrotask(() => {
    input.focus();
    input.select();
  });

  const commit = (): void => {
    const value = input.value.trim();
    if (!value) {
      // Cancel rather than emit empty name.
      state.configNameEditMode = false;
      render();
      return;
    }
    if (mode.mode === 'create') {
      vscode.postMessage({ type: 'saveConfigurationAsNew', name: value });
    } else {
      vscode.postMessage({ type: 'renameConfiguration', id: mode.id, name: value });
    }
    state.configNameEditMode = false;
    // Don't re-render synchronously — the host will broadcast configurationsChanged.
  };

  const cancel = (): void => {
    state.configNameEditMode = false;
    render();
  };

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      commit();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      cancel();
    }
  });
  row.appendChild(input);

  const confirmBtn = el('button', {
    class: 'config-action-button',
    type: 'button',
    'aria-label': 'Confirm',
    title: 'Confirm',
  }) as HTMLButtonElement;
  confirmBtn.innerHTML = CHECK_ICON_SVG;
  confirmBtn.addEventListener('click', commit);
  row.appendChild(confirmBtn);

  const cancelBtn = el('button', {
    class: 'config-action-button',
    type: 'button',
    'aria-label': 'Cancel',
    title: 'Cancel',
  }) as HTMLButtonElement;
  cancelBtn.innerHTML = CLOSE_ICON_SVG;
  cancelBtn.addEventListener('click', cancel);
  row.appendChild(cancelBtn);

  return row;
}

function renderConfigManagePanel(): HTMLElement {
  const panel = el('div', { class: 'config-kebab-menu' });
  state.configurations.forEach((c) => {
    const item = el('div', { class: 'config-manage-item' });

    const name = el('span', { class: 'config-manage-name' });
    name.textContent = c.name;
    item.appendChild(name);

    if (c.isDefault) {
      const badge = el('span', { class: 'config-default-badge' });
      badge.textContent = 'default';
      item.appendChild(badge);
    }

    const actions = el('div', { class: 'config-manage-actions' });

    const renameBtn = el('button', {
      class: 'config-action-button',
      type: 'button',
      'aria-label': `Rename ${c.name}`,
      title: 'Rename',
    }) as HTMLButtonElement;
    renameBtn.innerHTML = PENCIL_ICON_SVG;
    renameBtn.addEventListener('click', () => {
      state.configNameEditMode = { mode: 'rename', id: c.id };
      state.configManageOpen = false;
      render();
    });
    actions.appendChild(renameBtn);

    const defaultBtn = el('button', {
      class: 'config-action-button',
      type: 'button',
      'aria-label': c.isDefault ? `${c.name} is the default` : `Set ${c.name} as default`,
      title: c.isDefault ? 'Default configuration' : 'Set as default',
    }) as HTMLButtonElement;
    defaultBtn.innerHTML = STAR_ICON_SVG;
    if (c.isDefault) defaultBtn.classList.add('active');
    defaultBtn.disabled = c.isDefault;
    defaultBtn.addEventListener('click', () => {
      if (c.isDefault) return;
      vscode.postMessage({ type: 'setDefaultConfiguration', id: c.id });
    });
    actions.appendChild(defaultBtn);

    const delBtn = el('button', {
      class: 'config-action-button',
      type: 'button',
      'aria-label': `Delete ${c.name}`,
      title: 'Delete',
    }) as HTMLButtonElement;
    delBtn.innerHTML = TRASH_ICON_SVG;
    delBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'deleteConfiguration', id: c.id });
    });
    actions.appendChild(delBtn);

    item.appendChild(actions);
    panel.appendChild(item);
  });
  return panel;
}

function openModuleDetail(moduleId: string): void {
  state.moduleView = { mode: 'detail', moduleId };
  if (!state.moduleDetails[moduleId]) {
    vscode.postMessage({ type: 'requestModuleDetail', moduleId });
  }

  // Feedback Logging module: trigger the initial feedback load and clear stale
  // confirm state so No-button two-step doesn't persist across navigation.
  if (moduleId === 'tool.feedback-log') {
    state.feedbackPendingNoConfirm = new Set();
    vscode.postMessage({ type: 'feedbackRequested' } as unknown as WebviewToHostMessage);
  }

  // Atlassian Suite module: request current token status and last validation result;
  // also reset transient UI state so confirm/validating don't linger across navigations.
  if (moduleId === 'integration.atlassian-suite') {
    state.atlassianJiraTokenConfirming = false;
    state.atlassianBitbucketRemoveConfirmingId = null;
    state.atlassianValidating = false;
    vscode.postMessage({ type: 'atlassianTokenStatusRequested' } as unknown as WebviewToHostMessage);
    vscode.postMessage({ type: 'atlassianValidationStatusRequested' } as unknown as WebviewToHostMessage);
  }

  // For every setting on this module that ships a keywordsPath, request the
  // parsed keywords payload now so the table renders as soon as the user lands
  // on the detail page. Cached entries (including prior error responses) are
  // skipped to avoid hammering the host on repeated visits.
  const module = state.modules.find((m) => m.id === moduleId);
  const fields = (module?.contributes?.settings ?? {}) as Record<string, SettingsField>;
  for (const [settingKey, field] of Object.entries(fields)) {
    if (!field.keywordsPath) continue;
    const cacheKey = settingKeywordsCacheKey(moduleId, settingKey);
    if (
      state.settingKeywords[cacheKey] !== undefined ||
      state.settingKeywordErrors[cacheKey] !== undefined
    ) {
      continue;
    }
    vscode.postMessage({ type: 'requestSettingKeywords', moduleId, settingKey });
  }

  // If this module has a keyValue setting fed by the LINQPad source and we
  // haven't yet received a payload (or are still loading), request one now.
  const needsLinqpad = Object.values(fields).some(
    (f) => f.type === 'keyValue' && f.valueSource === 'linqpad-connections',
  );
  if (needsLinqpad && state.linqpadConnections.status === 'loading') {
    vscode.postMessage({ type: 'requestLinqpadConnections' });
  }

  render();
}

/** Cache-key helper for the per-setting keywords store. */
function settingKeywordsCacheKey(moduleId: string, settingKey: string): string {
  return `${moduleId}::${settingKey}`;
}

function backToModuleList(): void {
  state.moduleView = { mode: 'list' };
  render();
}

/**
 * Single-module detail page. Renders the header (back / name / meta / toggle),
 * a Proactive pill (if set), description, the existing definition list, the
 * raw prompt content for each declared fragment, and (when present) the
 * module's settings editor.
 */
function renderModuleDetailView(wrapper: HTMLElement, m: ModuleSummary): void {
  const container = el('div', { class: 'module-detail' });

  // Header: back button + name/meta + enable toggle on the right.
  const header = el('div', { class: 'detail-header' });
  const back = el('button', {
    class: 'icon-button',
    type: 'button',
    'aria-label': 'Back to module list',
    title: 'Back',
  }) as HTMLButtonElement;
  back.innerHTML = ARROW_LEFT_SVG;
  back.addEventListener('click', backToModuleList);
  header.appendChild(back);

  const headTitle = el('div', { class: 'detail-title' });
  const headName = el('strong');
  headName.textContent = m.name;
  headTitle.appendChild(headName);
  const headMeta = el('span', { class: 'meta' });
  headMeta.textContent = ` · v${m.version}`;
  headTitle.appendChild(headMeta);
  header.appendChild(headTitle);

  const headSpacer = el('div', { class: 'detail-spacer' });
  header.appendChild(headSpacer);

  header.appendChild(
    renderToggle({
      checked: m.enabled,
      onChange: (next) => {
        requestToggleModule(m, next);
      },
      ariaLabel: `Enable ${m.name}`,
    }),
  );
  container.appendChild(header);

  // Description block.
  if (m.description) {
    container.appendChild(textEl('div', m.description, 'desc'));
  }

  // Setup Guide — human/operator-facing instructions loaded by the host from
  // the module's `setupGuidePath`. Rendered near the top (above Settings and
  // the agent Instructions box) and styled distinctly so it never reads as
  // agent prompt text. Only shown when the module declares a setup guide (i.e.
  // the moduleDetail payload carried a `setupGuide` with content or an error).
  const setupGuide = state.moduleSetupGuides[m.id];
  if (setupGuide && (setupGuide.content || setupGuide.error)) {
    container.appendChild(textEl('div', 'Setup Guide', 'details-header'));
    const guidePre = el('pre', { class: 'prompt setup-guide' });
    if (setupGuide.error) {
      guidePre.textContent = `(read error: ${setupGuide.error})`;
    } else {
      guidePre.textContent = setupGuide.content;
    }
    container.appendChild(guidePre);
  }

  // Agent-target badge row + descriptor metadata pills — all in one wrapping
  // flex row so the full badge summary is on a single line that wraps naturally.
  const agentBadges =
    renderAgentBadges(m.contributes?.promptFragments ?? []) ??
    (m.proactive ? el('div', { class: 'agent-badges' }) : null);
  if (m.proactive && agentBadges) {
    const pill = el('span', { class: 'proactive-pill' });
    pill.textContent = 'Proactive';
    agentBadges.appendChild(pill);
  }
  // Merge descriptor spans into the same container (or create one if there were
  // no agent badges and the module is not proactive).
  const detailDescriptors = renderDescriptorBadges(m);
  if (detailDescriptors) {
    const badgeContainer = agentBadges ?? el('div', { class: 'agent-badges' });
    while (detailDescriptors.firstChild) {
      badgeContainer.appendChild(detailDescriptors.firstChild);
    }
    container.appendChild(badgeContainer);
  } else if (agentBadges) {
    container.appendChild(agentBadges);
  }

  // Definition list (always rendered, no expander).
  const c = m.contributes;
  const dl = el('dl', { class: 'details-list' });
  appendDef(dl, 'Version', m.version);
  appendDef(dl, 'Id', m.id);

  const fragCount = c?.promptFragments?.length ?? 0;
  const agentCount = c?.agents?.length ?? 0;
  const toolCount = c?.tools?.length ?? 0;
  const uiCount = c?.settingsPanelSections?.length ?? 0;

  if (fragCount > 0) {
    const targets = (c?.promptFragments ?? []).map((f) => f.target).join(', ');
    appendDef(dl, 'Module content files', `${fragCount} (read on demand by: ${targets})`);
  }
  if (agentCount > 0) {
    const ids = (c?.agents ?? []).map((a) => a.id).join(', ');
    appendDef(dl, 'Agents', `${agentCount} (${ids})`);
  }
  if (toolCount > 0) {
    const names = (c?.tools ?? []).map((t) => t.name).join(', ');
    appendDef(dl, 'Tools', `${toolCount} (${names})`);
  }
  if (uiCount > 0) {
    appendDef(dl, 'UI sections', String(uiCount));
  }
  container.appendChild(dl);

  // Settings editor (inline, no expander wrapping). Rendered ABOVE the prompt
  // content because the configurable inputs are the actionable surface — prompt
  // content below is reference material.
  const fields = (c?.settings ?? {}) as Record<string, SettingsField>;
  const fieldEntries = Object.entries(fields);
  if (fieldEntries.length > 0) {
    container.appendChild(textEl('div', 'Settings', 'details-header'));
    const settingsWrap = el('div', { class: 'module-settings' });
    fieldEntries.forEach(([key, field]) => {
      settingsWrap.appendChild(
        renderModuleSettingField(m.id, key, field),
      );
    });
    container.appendChild(settingsWrap);
  }

  // Prompt Content section — raw module .md text from the host. Reference
  // material; sits below Settings.
  container.appendChild(textEl('div', 'Instructions', 'details-header'));
  const fragments = state.moduleDetails[m.id];
  if (fragments === undefined) {
    container.appendChild(textEl('div', 'Loading…', 'empty'));
  } else if (fragments.length === 0) {
    container.appendChild(
      textEl('div', 'This module declares no instructions.', 'empty'),
    );
  } else {
    const multiFragment = fragments.length > 1;
    fragments.forEach((f) => {
      if (multiFragment) {
        const head = el('div', { class: 'fragment-head' });
        head.textContent = fragmentTargetLabel(f.target);
        container.appendChild(head);
      }
      const pre = el('pre', { class: 'prompt fragment' });
      if (f.error) {
        pre.textContent = `(read error: ${f.error})`;
      } else {
        pre.textContent = f.content;
      }
      container.appendChild(pre);
    });
  }

  // Atlassian Suite module: render the API token management block below the
  // instructions. Tokens are stored in SecretStorage — only set/cleared status
  // flows through the panel; the values themselves are never read here.
  if (m.id === 'integration.atlassian-suite') {
    container.appendChild(textEl('div', 'Atlassian API Tokens', 'details-header'));
    const tokenBlock = renderAtlassianTokenSlots();
    tokenBlock.id = 'atlassian-token-block';
    container.appendChild(tokenBlock);

    // Validation block — appended below the token block.
    container.appendChild(textEl('div', 'Token Validation', 'details-header'));
    const validationBlock = renderAtlassianValidationBlock();
    validationBlock.id = 'atlassian-validation-block';
    container.appendChild(validationBlock);
  }

  // Support mode: render the path-discovery block below the instructions,
  // so operators can auto-fill empty appMap entries without hand-typing them.
  if (m.id === 'mode.support') {
    const discoveryBlock = renderSupportDiscoveryBlock();
    discoveryBlock.id = 'support-discovery-block';
    container.appendChild(discoveryBlock);
  }

  // Obsidian Notes module: render the vault-detection block below the
  // instructions, so operators can auto-fill the vaultPath setting without
  // hand-typing it.
  if (m.id === 'tool.obsidian-notes') {
    const detectBlock = renderObsidianDetectBlock();
    detectBlock.id = 'obsidian-detect-block';
    container.appendChild(detectBlock);
  }

  // GitHub module: render the login block below the instructions, so operators
  // can launch the interactive `gh auth login` flow in a terminal.
  if (m.id === 'tool.github') {
    const loginBlock = renderGithubLoginBlock();
    loginBlock.id = 'github-login-block';
    container.appendChild(loginBlock);
  }

  // Feedback Logging module: render the feedback entry card UI below the
  // instructions. Scoped exclusively to this module's detail view.
  if (m.id === 'tool.feedback-log') {
    container.appendChild(textEl('div', 'Feedback Entries', 'details-header'));

    const pending = state.feedbackEntries.filter((e) => e.status === 'pending');
    const approved = state.feedbackEntries.filter((e) => e.status === 'approved');
    const bothEmpty = pending.length === 0 && approved.length === 0;

    if (bothEmpty) {
      container.appendChild(
        textEl(
          'div',
          "No feedback entries yet. When you're working with the TPM and you spot an idea, say 'add this to feedback' and it'll show up here.",
          'empty feedback-empty-all',
        ),
      );
    } else {
      const pendingHeader = el('div', { class: 'feedback-section-header' });
      pendingHeader.textContent = 'Pending';
      container.appendChild(pendingHeader);

      const pendingList = el('div', { class: 'feedback-list', id: 'feedback-pending-list' });
      container.appendChild(pendingList);
      renderFeedbackList(pendingList, 'pending');

      const approvedHeader = el('div', { class: 'feedback-section-header' });
      approvedHeader.textContent = 'Approved';
      container.appendChild(approvedHeader);

      const approvedList = el('div', { class: 'feedback-list', id: 'feedback-approved-list' });
      container.appendChild(approvedList);
      renderFeedbackList(approvedList, 'approved');
    }
  }

  wrapper.appendChild(container);
}

/**
 * Computes the ordered set of agent badge labels from a pre-expanded targets
 * array (as stored in `ModuleSummary.targets`). Returns an empty array when
 * there are no targets. Order is always TPM → SWE → QA → custom (sorted).
 */
function resolveAgentBadgeLabels(targets: string[]): string[] {
  if (targets.length === 0) return [];
  const CANONICAL_ORDER = ['tpm', 'swe', 'qa'];
  const agentSet = new Set(targets.map((t) => t.toLowerCase()));
  return [
    ...CANONICAL_ORDER.filter((a) => agentSet.has(a)),
    ...[...agentSet].filter((a) => !CANONICAL_ORDER.includes(a)).sort(),
  ];
}

/**
 * Renders a row of pill badges showing which agents a module impacts.
 * Accepts either a pre-expanded `targets` array (from `ModuleSummary.targets`)
 * or a legacy fragments array (detail view still passes promptFragments).
 * Returns null when there are no badges to show.
 * Deduplicates: "all" in fragments expands to TPM+SWE+QA. Order: TPM → SWE → QA.
 */
function renderAgentBadges(
  input: string[] | Array<{ target: string }>,
): HTMLElement | null {
  // Normalise both call-sites to a flat string[] of raw target values.
  let rawTargets: string[];
  if (input.length === 0) return null;
  if (typeof input[0] === 'string') {
    // Already a targets array (from ModuleSummary.targets — already expanded).
    rawTargets = input as string[];
  } else {
    // Fragment objects from the detail view — expand "all" here.
    const frags = input as Array<{ target: string }>;
    const s = new Set<string>();
    for (const f of frags) {
      if (f.target === 'all') {
        s.add('tpm'); s.add('swe'); s.add('qa');
      } else {
        s.add(f.target.toLowerCase());
      }
    }
    rawTargets = [...s];
  }

  const ordered = resolveAgentBadgeLabels(rawTargets);
  if (ordered.length === 0) return null;

  const row = el('div', { class: 'agent-badges' });
  for (const agent of ordered) {
    const badge = el('span', { class: 'agent-badge' });
    badge.textContent = agent.toUpperCase();
    row.appendChild(badge);
  }
  return row;
}

// ─── Descriptor badge helpers ───────────────────────────────────────────────

/** Human-friendly display text for each descriptor field value. */
function descriptorDisplayText(field: string, value: string): string {
  if (field === 'category') {
    if (value === 'session-mode') return 'Session Mode';
    return value.charAt(0).toUpperCase() + value.slice(1);
  }
  if (field === 'kind') {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }
  if (field === 'trigger') {
    const map: Record<string, string> = {
      'session-start': 'Session Start',
      'user-request': 'User Request',
      'phrase-detection': 'Phrase Detection',
      'always-applied': 'Always Applied',
      'event': 'Event',
    };
    return map[value] ?? value;
  }
  if (field === 'tier') {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }
  return value;
}

/**
 * Renders descriptor metadata pills (category, kind, trigger, tier) for a module.
 * Returns a container div with badge spans, or null if no descriptors are present.
 */
function renderDescriptorBadges(m: ModuleSummary): HTMLElement | null {
  const fields: Array<{ field: string; value: string | undefined }> = [
    { field: 'category', value: m.category },
    { field: 'kind', value: m.kind },
    { field: 'trigger', value: m.trigger },
    { field: 'tier', value: m.tier },
  ];
  const present = fields.filter((f) => f.value);
  if (present.length === 0) return null;

  const container = el('div', { class: 'descriptor-badges' });
  for (const { field, value } of present) {
    const badge = el('span', { class: `descriptor-badge descriptor-badge--${field}` });
    badge.textContent = descriptorDisplayText(field, value!);
    container.appendChild(badge);
  }
  return container;
}

/**
 * Collects descriptor field values for a module as an array of lowercase strings,
 * suitable for search matching.
 */
function resolveDescriptorLabels(m: ModuleSummary): string[] {
  const labels: string[] = [];
  const fields: Array<{ field: string; value: string | undefined }> = [
    { field: 'category', value: m.category },
    { field: 'kind', value: m.kind },
    { field: 'trigger', value: m.trigger },
    { field: 'tier', value: m.tier },
  ];
  for (const { field, value } of fields) {
    if (value) {
      labels.push(descriptorDisplayText(field, value).toLowerCase());
    }
  }
  return labels;
}

/** Map a fragment target value to a friendly display label for multi-fragment modules. */
function fragmentTargetLabel(target: string): string {
  switch (target) {
    case 'tpm': return 'For TPM';
    case 'swe': return 'For SWE';
    case 'qa':  return 'For QA';
    case 'all': return 'Shared (all agents)';
    default:    return `For ${target.charAt(0).toUpperCase()}${target.slice(1)}`;
  }
}

function appendDef(dl: HTMLElement, term: string, value: string): void {
  const dt = el('dt');
  dt.textContent = term;
  const dd = el('dd');
  dd.textContent = value;
  dl.appendChild(dt);
  dl.appendChild(dd);
}

/**
 * Render a settings field inside a module's expanded panel.
 *
 * Layout per field:
 *   Label                                    ← stays above on its own line
 *   [ input grows .......... ]               ← input only, no save button
 *   Description (optional)                   ← below input
 *
 * Persistence model:
 *   - Booleans: auto-save on toggle.
 *   - String / number / enum: auto-save on commit — the input persists when
 *     it fires `change` (blur for text/number inputs, selection change for
 *     enum selects). No explicit save button.
 */
function renderModuleSettingField(
  moduleId: string,
  settingKey: string,
  field: SettingsField,
): HTMLElement {
  const key = scopedKey(moduleId, settingKey);
  const wrap = el('div', { class: 'setting' });

  const head = el('div', { class: 'setting-head' });
  const label = el('label', { class: 'setting-label' });
  label.textContent = field.label;
  head.appendChild(label);
  wrap.appendChild(head);

  const current = state.settingsValues[key] ?? field.default;

  // Multi-select checkbox group: opt-in via `multiSelect: true` on a string
  // field that ships a `keywordsPath`. The keywords file supplies the
  // closed-vocabulary option list; the saved value remains a comma-separated
  // string (agent contract unchanged). Falls back to the standard text input
  // if the keywords payload failed to load or is empty.
  if (field.type === 'string' && field.multiSelect && field.keywordsPath) {
    // Multi-select fields render the keywords table with an additional "Select"
    // column — one checkbox per row, auto-saving the canonical-ordered
    // comma-separated string. Loading / error / empty states are handled
    // internally by appendKeywordsTable, so no separate placeholder DOM here.
    const cacheKey = settingKeywordsCacheKey(moduleId, settingKey);
    const keywords = state.settingKeywords[cacheKey];

    // Parse the stored comma-separated value into a Set for membership checks.
    // Empty / non-string / undefined → empty set (no boxes checked). Reading
    // from state.settingsValues on each render (not from a closed-over Set)
    // ensures selection survives re-renders driven by other state changes.
    const selected = new Set<string>();
    if (typeof current === 'string' && current.length > 0) {
      for (const raw of current.split(',')) {
        const trimmed = raw.trim();
        if (trimmed.length > 0) selected.add(trimmed);
      }
    }

    const onToggle = (keyword: string, next: boolean): void => {
      if (next) {
        selected.add(keyword);
      } else {
        selected.delete(keyword);
      }
      // Rebuild from the keywords-file order so the persisted string is
      // canonical and stable regardless of click order. `keywords` may be
      // undefined if a toggle somehow fires before the payload lands — guard.
      const ordered = keywords ?? [];
      const nextStr = ordered
        .map((e) => e.keyword)
        .filter((kw) => selected.has(kw))
        .join(', ');
      state.settingsValues[key] = nextStr;
      persistSettings();
    };

    if (field.description) {
      wrap.appendChild(textEl('div', field.description, 'setting-desc'));
    }
    appendKeywordsTable(wrap, moduleId, settingKey, field, { selected, onToggle });
    return wrap;
  }

  if (field.type === 'keyValue') {
    appendKeyValueEditor(wrap, head, moduleId, settingKey, field, current);
    if (field.description) {
      wrap.appendChild(textEl('div', field.description, 'setting-desc'));
    }
    appendKeywordsTable(wrap, moduleId, settingKey, field);
    return wrap;
  }

  if (field.type === 'boolean') {
    // Booleans keep auto-save-on-toggle semantics. A toggle has no intermediate
    // "edited but not saved" state worth modelling, and a save button next to
    // it would be redundant chrome.
    head.appendChild(
      renderToggle({
        checked: !!current,
        onChange: (next) => {
          state.settingsValues[key] = next;
          persistSettings();
        },
        ariaLabel: field.label,
      }),
    );
    if (field.description) {
      wrap.appendChild(textEl('div', field.description, 'setting-desc'));
    }
    // Booleans theoretically could ship a keywordsPath, but the on/off shape
    // has no vocabulary to document. Still render if present — the agent reads
    // the same file, so the table keeps host + agent views in sync.
    appendKeywordsTable(wrap, moduleId, settingKey, field);
    return wrap;
  }

  // For non-boolean fields, build a flex row containing just the input.
  // Auto-save fires on `change` (blur for text/number, selection commit for
  // enum) — no explicit save button needed.
  const row = el('div', { class: 'module-field-row' });

  // Read the latest "input value" coerced to the field type.
  let readInputValue: () => unknown;

  if (field.type === 'enum') {
    const select = el('select', { class: 'setting-input' }) as HTMLSelectElement;
    (field.options ?? []).forEach((opt) => {
      const o = el('option') as HTMLOptionElement;
      o.value = opt;
      o.textContent = opt;
      if (opt === current) o.selected = true;
      select.appendChild(o);
    });
    readInputValue = () => select.value;
    row.appendChild(select);
    select.addEventListener('change', () => {
      state.settingsValues[key] = readInputValue();
      persistSettings();
    });
  } else if (field.type === 'number') {
    const inp = el('input', { class: 'setting-input' }) as HTMLInputElement;
    inp.type = 'number';
    if (typeof field.min === 'number') inp.min = String(field.min);
    if (typeof field.max === 'number') inp.max = String(field.max);
    if (current !== undefined && current !== null) inp.value = String(current);
    readInputValue = () => (inp.value === '' ? undefined : Number(inp.value));
    row.appendChild(inp);
    inp.addEventListener('change', () => {
      state.settingsValues[key] = readInputValue();
      persistSettings();
    });
  } else if (field.type === 'string' && field.multiline === true) {
    // Multi-line string — render a textarea. Same value binding, same auto-save
    // on `change` (which fires on blur for textareas, identical to inputs), and
    // the same `.setting-input` class so existing CSS applies. The extra
    // `.module-setting-textarea` class hosts textarea-specific styling
    // (resize + min-height).
    const ta = el('textarea', {
      class: 'setting-input module-setting-textarea',
      rows: '4',
    }) as HTMLTextAreaElement;
    if (current !== undefined && current !== null) ta.value = String(current);
    readInputValue = () => ta.value;
    row.appendChild(ta);
    ta.addEventListener('change', () => {
      state.settingsValues[key] = readInputValue();
      persistSettings();
    });
  } else {
    // string, path, or unknown — render text input.
    const inp = el('input', { class: 'setting-input' }) as HTMLInputElement;
    inp.type = 'text';
    if (current !== undefined && current !== null) inp.value = String(current);
    readInputValue = () => inp.value;
    row.appendChild(inp);
    inp.addEventListener('change', () => {
      state.settingsValues[key] = readInputValue();
      persistSettings();
    });
  }

  wrap.appendChild(row);

  if (field.description) {
    wrap.appendChild(textEl('div', field.description, 'setting-desc'));
  }
  appendKeywordsTable(wrap, moduleId, settingKey, field);
  return wrap;
}

/**
 * @deprecated Retired on 2026-05-12 — the multi-select checkbox group has been
 * folded into `appendKeywordsTable` as a new leftmost "Select" column. This
 * function is no longer called from anywhere; it remains in the file pending
 * user (TPM) deletion to honor the no-deletions hard rule.
 *
 * Render a multi-select checkbox group for a `string + multiSelect + keywordsPath`
 * field. The keywords payload supplies the closed-vocabulary options; the saved
 * value is the comma-separated concatenation of the currently-checked keywords
 * (agent contract unchanged). Auto-saves on every change — mirrors the keyValue
 * editor pattern, no separate Save button.
 *
 * Orphan handling: if the stored value contains keywords that are no longer
 * present in the keywords file (legacy values), they are silently dropped from
 * the checked state. The next user interaction commits a clean value without
 * them.
 */
// @ts-expect-error TS6133 — retained as dead code pending user deletion (no-rm rule).
function appendMultiSelectField(
  parent: HTMLElement,
  moduleId: string,
  settingKey: string,
  field: SettingsField,
  keywords: SettingKeywordEntry[],
  current: unknown,
): void {
  const key = scopedKey(moduleId, settingKey);

  // Parse the stored comma-separated value into a Set for membership checks.
  // Empty / non-string / undefined → empty set (no boxes checked).
  const selected = new Set<string>();
  if (typeof current === 'string' && current.length > 0) {
    for (const raw of current.split(',')) {
      const trimmed = raw.trim();
      if (trimmed.length > 0) selected.add(trimmed);
    }
  }

  const group = el('div', { class: 'multi-select-group' });

  // Preserve manifest order of options (keywords[]) so the layout is stable.
  for (const entry of keywords) {
    const itemLabel = el('label', { class: 'multi-select-item' }) as HTMLLabelElement;
    const cb = el('input', { class: 'multi-select-checkbox' }) as HTMLInputElement;
    cb.type = 'checkbox';
    cb.checked = selected.has(entry.keyword);
    cb.addEventListener('change', () => {
      if (cb.checked) {
        selected.add(entry.keyword);
      } else {
        selected.delete(entry.keyword);
      }
      // Rebuild the comma-separated value from the keyword file's order so the
      // persisted string is canonical and stable regardless of click order.
      const next = keywords
        .map((e) => e.keyword)
        .filter((kw) => selected.has(kw))
        .join(', ');
      state.settingsValues[key] = next;
      persistSettings();
    });
    const txt = el('span', { class: 'multi-select-label' });
    txt.textContent = entry.keyword;
    itemLabel.appendChild(cb);
    itemLabel.appendChild(txt);
    group.appendChild(itemLabel);
  }

  parent.appendChild(group);
}

/**
 * Render the editor for a `keyValue` field. The committed value lives in
 * `state.settingsValues[scopedKey]` as a `Record<string, string>`. The in-
 * memory draft lives in `state.keyValueDrafts[scopedKey]`; every mutation
 * auto-saves immediately (no separate Save button).
 *
 * Migration: if the committed value is a string (legacy comma-separated
 * allowlist) or any non-plain-object shape, it is silently treated as empty.
 *
 * Value-cell quick-pick: when `field.valueSource === 'linqpad-connections'`,
 * each value cell renders a `<select>` of detected connections (dropdown only
 * — no free-form override). If the LINQPad probe failed, the value cell is
 * left empty and a banner above the table explains the situation.
 */
function appendKeyValueEditor(
  parent: HTMLElement,
  head: HTMLElement,
  moduleId: string,
  settingKey: string,
  field: SettingsField,
  current: unknown,
): void {
  const key = scopedKey(moduleId, settingKey);
  const richShape = field.optionalEnabled === true;
  // Description column requires the rich shape (it carries the `description`
  // string alongside `value` + `enabled`). If a manifest sets
  // `optionalDescription: true` without `optionalEnabled`, we silently treat
  // it as false rather than introduce a description-only-no-enabled variant.
  const withDescription = richShape && field.optionalDescription === true;

  // If the stored value is a string (legacy) or any non-plain-object shape,
  // silently treat as empty and start fresh. When `optionalEnabled` is true,
  // the per-key value can be either a `{ value, enabled }` object (current
  // shape) or a bare string (legacy/migrating); coerce strings into the
  // richer shape with `enabled: true` so a default-shape manifest still
  // round-trips cleanly the first time the panel is opened.
  if (state.keyValueDrafts[key] === undefined) {
    if (richShape) {
      const seed: Record<string, { value: string; enabled: boolean; description?: string }> = {};
      if (current && typeof current === 'object' && !Array.isArray(current)) {
        for (const [k, v] of Object.entries(current as Record<string, unknown>)) {
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            const obj = v as { value?: unknown; enabled?: unknown; description?: unknown };
            const entry: { value: string; enabled: boolean; description?: string } = {
              value: typeof obj.value === 'string' ? obj.value : '',
              enabled: obj.enabled !== false,
            };
            if (withDescription) {
              entry.description = typeof obj.description === 'string' ? obj.description : '';
            }
            seed[k] = entry;
          } else if (typeof v === 'string') {
            seed[k] = withDescription
              ? { value: v, enabled: true, description: '' }
              : { value: v, enabled: true };
          } else if (v !== undefined && v !== null) {
            seed[k] = withDescription
              ? { value: String(v), enabled: true, description: '' }
              : { value: String(v), enabled: true };
          }
        }
      }
      state.keyValueDrafts[key] = seed;
    } else {
      const seed: Record<string, string> = {};
      if (current && typeof current === 'object' && !Array.isArray(current)) {
        for (const [k, v] of Object.entries(current as Record<string, unknown>)) {
          if (typeof v === 'string') seed[k] = v;
          else if (v !== undefined && v !== null) seed[k] = String(v);
        }
      }
      state.keyValueDrafts[key] = seed;
    }
  }
  const draft = state.keyValueDrafts[key]!;

  // Auto-save: every mutation immediately persists the draft.
  const persistDraft = (): void => {
    state.settingsValues[key] = { ...draft };
    persistSettings();
  };

  // ── Table of existing entries ──────────────────────────────────────
  const tableWrap = el('div', { class: 'kv-table-wrap' });
  // The `kv-table--with-description` modifier flips the column widths so
  // Value shrinks to a narrow fixed-width column and Description absorbs the
  // remaining space. Without this modifier the table keeps its legacy
  // 2-data-column layout (Key + Value).
  //
  // The `kv-table--full-width` modifier (opt-in via the manifest's
  // `fullWidth: true` flag) drops the shared 720px max-width ceiling so the
  // table stretches to fill the surrounding settings card. Used for tables
  // whose value column would otherwise look pinched (e.g. the database-access
  // allowlist surfacing long LINQPad connection names).
  const tableClasses = ['kv-table'];
  if (withDescription) tableClasses.push('kv-table--with-description');
  if (field.fullWidth === true) tableClasses.push('kv-table--full-width');
  const table = el('table', { class: tableClasses.join(' ') });
  const thead = el('thead');
  const headRow = el('tr');
  if (richShape) {
    const enHead = el('th', { class: 'kv-enabled-head' });
    enHead.textContent = 'Enabled';
    headRow.appendChild(enHead);
  }
  // The `kv-key-head` class anchors a 30% width on the Key column header.
  // Under `table-layout: fixed`, column widths come from the first row's
  // cells — putting the width on the `<th>` (not the body `<td>`) is what
  // actually constrains the column. The Value column header is left
  // unconstrained so it absorbs whatever the fixed-pixel columns leave behind.
  const kHead = el('th', { class: 'kv-key-head' });
  kHead.textContent = field.keyLabel ?? 'Key';
  const vHead = el('th', withDescription ? { class: 'kv-value-head' } : undefined);
  vHead.textContent = field.valueLabel ?? 'Value';
  const actionHead = el('th', { class: 'kv-actions-head' });
  actionHead.textContent = '';
  headRow.appendChild(kHead);
  headRow.appendChild(vHead);
  if (withDescription) {
    const dHead = el('th', { class: 'kv-description-head' });
    dHead.textContent = field.descriptionLabel ?? 'Description';
    headRow.appendChild(dHead);
  }
  headRow.appendChild(actionHead);
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  const entries = Object.entries(draft);
  // Column count: Key + Value + Actions = 3 base; +1 for Enabled (richShape);
  // +1 for Description (withDescription).
  const colSpan = (richShape ? 4 : 3) + (withDescription ? 1 : 0);
  if (entries.length === 0) {
    const emptyRow = el('tr', { class: 'kv-empty-row' });
    const td = el('td');
    td.setAttribute('colspan', String(colSpan));
    td.textContent = 'No entries. Add one below.';
    emptyRow.appendChild(td);
    tbody.appendChild(emptyRow);
  } else {
    for (const [rowKey, rowVal] of entries) {
      tbody.appendChild(renderKeyValueRow(field, draft, rowKey, rowVal, persistDraft));
    }
  }
  table.appendChild(tbody);

  // ── Add-new-entry row (lives inside the table as <tfoot>) ──────────
  // Moving the add row into the table itself means its cells inherit the
  // exact column widths from `table-layout: fixed`, so the seams between
  // Command/Description/Action columns line up by construction — no
  // hand-tuned grid math required (which previously drifted ~28px short
  // of the table's Description column right edge).
  table.appendChild(renderKeyValueAddRow(field, draft, persistDraft));

  // ── LINQPad banner (when applicable) ───────────────────────────────
  // The banner sits ABOVE the table when LINQPad discovery fails so the
  // user sees the failure mode before encountering the (now-disabled)
  // value cell in the tfoot add row.
  const wantsLinqpad = field.valueSource === 'linqpad-connections';
  const lp = state.linqpadConnections;
  if (wantsLinqpad && (lp.status === 'not-installed' || lp.status === 'error')) {
    parent.appendChild(renderLinqpadBanner(lp));
  }

  tableWrap.appendChild(table);
  parent.appendChild(tableWrap);
}

/** Render a single committed-entry row: optional enabled checkbox + key + value + optional description + delete. */
function renderKeyValueRow(
  field: SettingsField,
  draft: Record<string, string> | Record<string, { value: string; enabled: boolean; description?: string }>,
  rowKey: string,
  rowVal: string | { value: string; enabled: boolean; description?: string },
  persist: () => void,
): HTMLElement {
  const tr = el('tr', { class: 'kv-row' });
  const richShape = field.optionalEnabled === true;
  const withDescription = richShape && field.optionalDescription === true;

  // Surface the user-facing string (description text) regardless of which
  // shape the draft is in. When richShape is true, rowVal is always an
  // object; when not, it's always a string. We coerce defensively.
  const displayValue: string =
    richShape && rowVal && typeof rowVal === 'object'
      ? ((rowVal as { value?: unknown }).value as string) ?? ''
      : typeof rowVal === 'string'
        ? rowVal
        : '';
  const enabledState: boolean =
    richShape && rowVal && typeof rowVal === 'object'
      ? ((rowVal as { enabled?: unknown }).enabled !== false)
      : true;
  const descriptionState: string =
    withDescription && rowVal && typeof rowVal === 'object'
      ? ((rowVal as { description?: unknown }).description as string) ?? ''
      : '';

  // Helper to read the current rich entry while preserving fields the caller
  // didn't intend to touch (e.g. flipping `enabled` should not clobber
  // `description`, and editing `description` should not clobber `value`).
  const readRichEntry = (): { value: string; enabled: boolean; description?: string } => {
    const richDraft = draft as Record<string, { value: string; enabled: boolean; description?: string }>;
    const existing = richDraft[rowKey];
    if (existing && typeof existing === 'object') {
      return {
        value: typeof existing.value === 'string' ? existing.value : '',
        enabled: existing.enabled !== false,
        description: withDescription
          ? (typeof existing.description === 'string' ? existing.description : '')
          : existing.description,
      };
    }
    return withDescription
      ? { value: '', enabled: true, description: '' }
      : { value: '', enabled: true };
  };

  if (richShape) {
    const enTd = el('td', { class: 'kv-cell kv-cell-enabled' });
    // The Enabled column defaults to a native HTML checkbox — toggles are
    // intentionally avoided for kv-table Enabled columns project-wide.
    // Manifests can opt into the shared .switch/.slider toggle pattern via
    // `enabledStyle: "toggle"` when the row count is small and the heavier
    // visual weight is desirable. In both cases the inner
    // <input type="checkbox"> receives the change event, so keyboard
    // semantics (space/enter) and the persist handler are identical.
    const cb = el('input') as HTMLInputElement;
    cb.type = 'checkbox';
    cb.checked = enabledState;
    cb.addEventListener('change', () => {
      const richDraft = draft as Record<string, { value: string; enabled: boolean; description?: string }>;
      const existing = readRichEntry();
      richDraft[rowKey] = { ...existing, enabled: cb.checked };
      persist();
    });
    if (field.enabledStyle === 'toggle') {
      const switchLabel = el('label', {
        class: 'switch',
        'aria-label': `Enable ${rowKey}`,
      });
      cb.className = 'kv-enabled-input';
      switchLabel.appendChild(cb);
      switchLabel.appendChild(el('span', { class: 'slider' }));
      enTd.appendChild(switchLabel);
    } else {
      cb.className = 'kv-enabled-checkbox';
      cb.setAttribute('aria-label', `Enable ${rowKey}`);
      enTd.appendChild(cb);
    }
    tr.appendChild(enTd);
  }

  const kTd = el('td', { class: 'kv-cell kv-cell-key' });
  const kInp = el('input', { class: 'setting-input kv-input' }) as HTMLInputElement;
  kInp.type = 'text';
  kInp.value = rowKey;
  kInp.addEventListener('change', () => {
    const newKey = kInp.value.trim();
    if (newKey === rowKey) return;
    if (newKey.length === 0) {
      // Reject empty: roll back the input.
      kInp.value = rowKey;
      return;
    }
    if (newKey in draft && newKey !== rowKey) {
      // Collision: rolling back keeps the visible state in sync with draft.
      kInp.value = rowKey;
      return;
    }
    if (richShape) {
      const richDraft = draft as Record<string, { value: string; enabled: boolean; description?: string }>;
      const existing = readRichEntry();
      delete richDraft[rowKey];
      richDraft[newKey] = existing;
    } else {
      const plainDraft = draft as Record<string, string>;
      const v = plainDraft[rowKey] ?? '';
      delete plainDraft[rowKey];
      plainDraft[newKey] = v;
    }
    persist();
    render();
  });
  kTd.appendChild(kInp);
  tr.appendChild(kTd);

  const valueReadonly = field.valueReadonly === true;
  const vTd = el('td', {
    class: valueReadonly ? 'kv-cell kv-cell-value kv-cell--readonly' : 'kv-cell kv-cell-value',
  });
  vTd.appendChild(renderValueCell(field, displayValue, (next) => {
    if (richShape) {
      const richDraft = draft as Record<string, { value: string; enabled: boolean; description?: string }>;
      const existing = readRichEntry();
      richDraft[rowKey] = { ...existing, value: next };
    } else {
      (draft as Record<string, string>)[rowKey] = next;
    }
    persist();
  }));
  tr.appendChild(vTd);

  if (withDescription) {
    // Read-only display — descriptions are author-supplied manifest content,
    // not user-editable. The seed value flows through from appendKeyValueEditor
    // and is preserved on serialization via { value, enabled, description }.
    const dTd = el('td', { class: 'kv-cell kv-cell-description' });
    const dText = el('div', { class: 'kv-description-text' });
    dText.textContent = descriptionState;
    dTd.appendChild(dText);
    tr.appendChild(dTd);
  }

  const aTd = el('td', { class: 'kv-cell kv-cell-actions' });
  const del = el('button', {
    class: 'icon-button kv-delete-button',
    type: 'button',
    'aria-label': `Delete entry ${rowKey}`,
    title: 'Delete',
  }) as HTMLButtonElement;
  del.innerHTML = TRASH_ICON_SVG;
  del.addEventListener('click', () => {
    delete (draft as Record<string, unknown>)[rowKey];
    persist();
    render();
  });
  aTd.appendChild(del);
  tr.appendChild(aTd);

  return tr;
}

/**
 * Render the add-entry row beneath the existing rows. Returns a `<tfoot>`
 * element appended directly to the table so its cells inherit the table's
 * fixed column widths — Command/Description/Add cells line up with the
 * Command/Description/Actions columns of the data rows above by
 * construction, with no grid math to maintain.
 *
 * Cell layout mirrors the data rows:
 *   [enabled placeholder (rich only)] [key input] [value input] [Add button]
 */
function renderKeyValueAddRow(
  field: SettingsField,
  draft: Record<string, string> | Record<string, { value: string; enabled: boolean; description?: string }>,
  persist: () => void,
): HTMLElement {
  const richShape = field.optionalEnabled === true;
  const withDescription = richShape && field.optionalDescription === true;
  const tfoot = el('tfoot', { class: 'kv-add-foot' });
  const tr = el('tr', { class: 'kv-add-row' });

  if (richShape) {
    // Empty leading cell — new entries default to enabled, so no checkbox.
    // The `kv-cell-enabled` class keeps the column width aligned with the
    // table's Enabled column under `table-layout: fixed`.
    const enTd = el('td', { class: 'kv-cell kv-cell-enabled kv-add-cell kv-add-cell--enabled' });
    tr.appendChild(enTd);
  }

  const kTd = el('td', { class: 'kv-cell kv-cell-key kv-add-cell' });
  const kField = el('div', { class: 'kv-add-field' });
  const kLabel = el('label', { class: 'kv-add-label' });
  kLabel.textContent = field.keyLabel ?? 'Key';
  const kInp = el('input', { class: 'setting-input kv-input' }) as HTMLInputElement;
  kInp.type = 'text';
  kInp.placeholder = field.keyLabel ?? 'Key';
  kField.appendChild(kLabel);
  kField.appendChild(kInp);
  kTd.appendChild(kField);
  tr.appendChild(kTd);

  // Add-row special case: when the value column is read-only (so existing
  // rows show a static span) BUT the manifest supplies `valueOptions`, we
  // still need a way for the user to classify a NEW entry. Render a dropdown
  // populated from `valueOptions` instead of the read-only span; existing
  // rows remain unchanged (renderKeyValueRow still calls renderValueCell as
  // before).
  const useValueSelect =
    field.valueReadonly === true &&
    Array.isArray(field.valueOptions) &&
    field.valueOptions.length > 0;
  const vTd = el('td', {
    class: useValueSelect
      ? 'kv-cell kv-cell-value kv-add-cell kv-cell--select'
      : field.valueReadonly === true
        ? 'kv-cell kv-cell-value kv-add-cell kv-cell--readonly'
        : 'kv-cell kv-cell-value kv-add-cell',
  });
  const vField = el('div', { class: 'kv-add-field kv-add-field--value' });
  const vLabel = el('label', { class: 'kv-add-label' });
  vLabel.textContent = field.valueLabel ?? 'Value';
  vField.appendChild(vLabel);

  // Use a draft-internal mutable string for the new value so the input/select
  // can call back into our local state without touching `draft` until Add.
  let pendingValue = '';
  if (useValueSelect) {
    const select = el('select', { class: 'kv-input kv-value-select' }) as HTMLSelectElement;
    const placeholder = el('option') as HTMLOptionElement;
    placeholder.value = '';
    placeholder.textContent = '—';
    select.appendChild(placeholder);
    for (const opt of field.valueOptions!) {
      const o = el('option') as HTMLOptionElement;
      o.value = opt;
      o.textContent = opt;
      select.appendChild(o);
    }
    select.addEventListener('change', () => {
      pendingValue = select.value;
    });
    vField.appendChild(select);
  } else {
    vField.appendChild(renderValueCell(field, '', (next) => {
      pendingValue = next;
    }));
  }
  vTd.appendChild(vField);
  tr.appendChild(vTd);

  // Empty placeholder cell — descriptions are author-supplied manifest content
  // and cannot be entered by the user. New entries get an empty description.
  if (withDescription) {
    const dTd = el('td', { class: 'kv-cell kv-cell-description kv-add-cell' });
    tr.appendChild(dTd);
  }

  const aTd = el('td', { class: 'kv-cell kv-cell-actions kv-add-cell kv-add-cell--actions' });
  const addBtn = el('button', { class: 'primary kv-add-button', type: 'button' }) as HTMLButtonElement;
  addBtn.textContent = 'Add';
  addBtn.addEventListener('click', () => {
    const k = kInp.value.trim();
    const v = pendingValue.trim();
    if (k.length === 0) return;
    if (!field.optionalValue && v.length === 0) return;
    // Existing-key behavior: overwrite the value rather than error.
    // New entries get an empty description — module authors supply descriptions
    // via the manifest; user-added entries have none.
    if (richShape) {
      const richDraft = draft as Record<string, { value: string; enabled: boolean; description?: string }>;
      richDraft[k] = withDescription
        ? { value: v, enabled: true, description: '' }
        : { value: v, enabled: true };
    } else {
      (draft as Record<string, string>)[k] = v;
    }
    persist();
    render();
  });
  aTd.appendChild(addBtn);
  tr.appendChild(aTd);

  tfoot.appendChild(tr);
  return tfoot;
}

/**
 * Render the value cell of a keyValue row. For LINQPad-sourced fields, this
 * is a select-of-connections (dropdown only — no free-form override). For
 * non-LINQPad fields, it's a plain text input.
 *
 * `onChange(next)` is called every time the effective value changes — the
 * caller decides whether to persist into the draft or hold off (the add-row
 * case holds off until the Add button is clicked).
 */
function renderValueCell(
  field: SettingsField,
  initial: string,
  onChange: (next: string) => void,
): HTMLElement {
  const wrap = el('div', { class: 'kv-value-cell' });

  // Read-only display — for fields whose value column carries a fixed taxonomy
  // authored in the manifest (e.g. tool.git's r|w|d Category). No input is
  // rendered, so `onChange` is never invoked; the seeded value flows through
  // unchanged via the surrounding read path.
  if (field.valueReadonly === true) {
    const span = el('span', { class: 'kv-value-readonly' });
    span.textContent = initial;
    wrap.appendChild(span);
    return wrap;
  }

  if (field.valueSource === 'linqpad-connections') {
    const lp = state.linqpadConnections;
    // When the probe failed entirely the banner (above the table) already
    // explains the situation; render nothing in the value cell.
    const showDropdown = lp.status === 'ok' || lp.status === 'loading';

    if (showDropdown) {
      const select = el('select', { class: 'setting-input kv-select' }) as HTMLSelectElement;
      // Placeholder option keeps the select usable before the user picks.
      const placeholder = el('option') as HTMLOptionElement;
      placeholder.value = '';
      placeholder.textContent = lp.status === 'loading' ? 'Loading…' : 'Connection';
      select.appendChild(placeholder);
      for (const conn of lp.list) {
        const opt = el('option') as HTMLOptionElement;
        opt.value = conn;
        opt.textContent = conn;
        if (conn === initial) opt.selected = true;
        select.appendChild(opt);
      }
      select.addEventListener('change', () => {
        if (select.value === '') return;
        onChange(select.value);
      });
      wrap.appendChild(select);
    }

    return wrap;
  }

  // Generic keyValue: plain text input.
  const inp = el('input', { class: 'setting-input kv-input' }) as HTMLInputElement;
  inp.type = 'text';
  inp.value = initial;
  inp.addEventListener('input', () => {
    onChange(inp.value);
  });
  wrap.appendChild(inp);
  return wrap;
}

/**
 * Render the LINQPad-not-installed / error banner. Shows the host's reported
 * error string plus two affordances: copy install prompt, configure path.
 */
function renderLinqpadBanner(
  lp: UIState['linqpadConnections'],
): HTMLElement {
  const banner = el('div', { class: 'kv-banner' });
  const heading = el('div', { class: 'kv-banner-heading' });
  heading.textContent =
    lp.status === 'not-installed'
      ? 'LINQPad connections file not found'
      : 'LINQPad connections file could not be read';
  banner.appendChild(heading);

  const detail = el('div', { class: 'kv-banner-detail' });
  detail.textContent =
    lp.error ??
    'Install LINQPad and define at least one connection, then refresh.';
  banner.appendChild(detail);

  const actions = el('div', { class: 'kv-banner-actions' });

  const copyBtn = el('button', { class: 'primary', type: 'button' }) as HTMLButtonElement;
  copyBtn.textContent = 'Copy install instructions';
  copyBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'copyLinqpadInstallPrompt' });
  });
  actions.appendChild(copyBtn);

  const configBtn = el('button', { class: 'kv-banner-link', type: 'button' }) as HTMLButtonElement;
  configBtn.textContent = 'Configure path…';
  configBtn.addEventListener('click', () => {
    vscode.postMessage({
      type: 'openVSCodeSettings',
      query: 'ghola.linqpadConnectionsPath',
    });
  });
  actions.appendChild(configBtn);

  banner.appendChild(actions);
  return banner;
}


/**
 * Optional selection-mode binding for `appendKeywordsTable`. When provided,
 * the table renders a leftmost "Select" column with one checkbox per row.
 * `selected` seeds the initial checked state; `onToggle` fires on each change
 * with the keyword and its new checked value — the caller is responsible for
 * rebuilding the canonical persisted value and calling persistSettings().
 */
interface KeywordsTableSelection {
  selected: Set<string>;
  onToggle: (keyword: string, next: boolean) => void;
}

/**
 * Render the Keywords table for a setting that ships a `keywordsPath`. No-op
 * when the field has no keywordsPath. While the payload is in flight (no cache
 * entry yet), shows a "Loading…" placeholder. On error, surfaces the error
 * string inline so the developer can fix the file. On success, renders a
 * compact 2-column table with monospace keyword cells.
 *
 * When `selection` is provided (multi-select fields), the table grows a
 * leftmost "Select" column and each row becomes a clickable toggle. The saved
 * value remains a comma-separated string in canonical keyword order — that
 * rebuild happens in the caller's `onToggle` so this function stays display-
 * only.
 */
function appendKeywordsTable(
  parent: HTMLElement,
  moduleId: string,
  settingKey: string,
  field: SettingsField,
  selection?: KeywordsTableSelection,
): void {
  if (!field.keywordsPath) return;

  const block = el('div', { class: 'setting-keywords' });
  const heading = el('div', { class: 'setting-keywords-heading' });
  heading.textContent = field.keywordsLabel ?? 'Keywords';
  block.appendChild(heading);

  const cacheKey = settingKeywordsCacheKey(moduleId, settingKey);
  const error = state.settingKeywordErrors[cacheKey];
  const keywords = state.settingKeywords[cacheKey];

  if (error) {
    block.appendChild(
      textEl('div', `Could not load keywords: ${error}`, 'setting-keywords-error'),
    );
    parent.appendChild(block);
    return;
  }
  if (keywords === undefined) {
    block.appendChild(textEl('div', 'Loading…', 'setting-keywords-empty'));
    parent.appendChild(block);
    return;
  }
  if (keywords.length === 0) {
    block.appendChild(
      textEl('div', 'No keywords defined.', 'setting-keywords-empty'),
    );
    parent.appendChild(block);
    return;
  }

  // The `setting-keywords-table--full-width` modifier (opt-in via the
  // manifest's `fullWidth: true` flag) drops the shared 720px max-width ceiling
  // so the table stretches to fill the surrounding settings card. Used for
  // keyword tables whose Purpose column would otherwise look pinched (e.g.
  // tool.dotnet-suite's allowed-commands list).
  const tableClasses = ['setting-keywords-table'];
  if (field.fullWidth === true) tableClasses.push('setting-keywords-table--full-width');
  const table = el('table', { class: tableClasses.join(' ') });
  const thead = el('thead');
  const headRow = el('tr');
  if (selection) {
    const selectHead = el('th', { class: 'setting-keywords-select', scope: 'col' });
    selectHead.textContent = field.selectColumnLabel ?? 'Select';
    headRow.appendChild(selectHead);
  }
  const keywordHead = el('th', { scope: 'col' });
  keywordHead.textContent = 'Keyword';
  const purposeHead = el('th', { scope: 'col' });
  purposeHead.textContent = 'Purpose';
  headRow.appendChild(keywordHead);
  headRow.appendChild(purposeHead);
  thead.appendChild(headRow);
  table.appendChild(thead);

  // Slugify a string into a safe id fragment. Non-`[A-Za-z0-9_-]` characters
  // collapse to '-'. Combined with moduleId + settingKey + keyword, this gives
  // a deterministic, document-unique id for ARIA association.
  const idSafe = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, '-');

  const tbody = el('tbody');
  for (const entry of keywords) {
    const row = el('tr');
    const kwId = `kwlbl-${idSafe(moduleId)}-${idSafe(settingKey)}-${idSafe(entry.keyword)}`;
    const purposeId = `kwdesc-${idSafe(moduleId)}-${idSafe(settingKey)}-${idSafe(entry.keyword)}`;

    if (selection) {
      const selectCell = el('td', { class: 'setting-keywords-select' });
      const cb = el('input', { class: 'setting-keywords-checkbox' }) as HTMLInputElement;
      cb.type = 'checkbox';
      cb.checked = selection.selected.has(entry.keyword);
      cb.setAttribute('aria-labelledby', kwId);
      cb.setAttribute('aria-describedby', purposeId);
      cb.addEventListener('change', () => {
        selection.onToggle(entry.keyword, cb.checked);
      });
      selectCell.appendChild(cb);
      row.appendChild(selectCell);

      // Row-level click affordance: clicking anywhere outside the checkbox
      // itself toggles it. We delegate to cb.click() (rather than mutating
      // .checked directly) so the `change` listener fires through the normal
      // event flow.
      row.classList.add('setting-keywords-row-selectable');
      row.addEventListener('click', (event) => {
        const target = event.target as HTMLElement | null;
        if (target === cb) return;
        cb.click();
      });
    }

    const kw = el('td', { class: 'setting-keywords-kw', id: kwId });
    kw.textContent = entry.keyword;
    const purpose = el('td', { class: 'setting-keywords-purpose', id: purposeId });
    purpose.textContent = entry.purpose;
    row.appendChild(kw);
    row.appendChild(purpose);
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  block.appendChild(table);
  parent.appendChild(block);
}

/** Persist the current settingsValues to the host. */
function persistSettings(): void {
  vscode.postMessage({ type: 'saveSettings', values: state.settingsValues });
}

interface ToggleOptions {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel?: string;
  /** Optional textual on/off label rendered next to the switch. */
  labelText?: string;
  /** When true, the underlying checkbox is disabled (non-interactive). */
  disabled?: boolean;
}

/**
 * iOS-style toggle switch — pure CSS, hidden checkbox under a sliding pill.
 * The checkbox remains keyboard-operable (Tab to focus, Space to toggle) and
 * carries aria semantics for assistive tech.
 */
function renderToggle(opts: ToggleOptions): HTMLElement {
  const label = el('label', { class: 'switch' }) as HTMLLabelElement;
  const input = el('input') as HTMLInputElement;
  input.type = 'checkbox';
  input.checked = opts.checked;
  if (opts.disabled) input.disabled = true;
  if (opts.ariaLabel) input.setAttribute('aria-label', opts.ariaLabel);
  input.addEventListener('change', () => {
    opts.onChange(input.checked);
  });
  label.appendChild(input);

  const slider = el('span', { class: 'slider', 'aria-hidden': 'true' });
  label.appendChild(slider);

  if (opts.labelText !== undefined) {
    const txt = el('span', { class: 'switch-label' });
    txt.textContent = opts.labelText;
    label.appendChild(txt);
  }
  return label;
}

const AGENT_FULL_NAMES: Record<string, string> = {
  tpm: 'Technical Program Manager',
  swe: 'Software Engineer',
  qa: 'Quality Assurance',
};

/**
 * The three fixed agent cores, in display order (TPM -> SWE -> QA). Drives the
 * Agents-tab list; the role blurb for each row comes from AGENT_FULL_NAMES.
 */
const AGENTS: { id: 'tpm' | 'swe' | 'qa'; name: string }[] = [
  { id: 'tpm', name: 'TPM' },
  { id: 'swe', name: 'SWE' },
  { id: 'qa', name: 'QA' },
];

/**
 * Session tab "Instruction" panel: the CLAUDE.md bootstrap snippet a user
 * pastes into their Claude Code CLAUDE.md / user memory so the configured
 * Initiation Command boots the Ghola TPM. Reuses the unscoped
 * `agent-config-header` + `pre.prompt` classes so it matches the Agents tabs.
 * The trigger word mirrors the configured Session Command.
 */
function renderSessionInstruction(): HTMLElement {
  const wrap = el('div');

  const trigger = (state.sessionCommand || 'initiate').trim() || 'initiate';
  const snippet =
    `## Ghola Initiation\n\n` +
    `When I send the word \`${trigger}\` (the Ghola Initiation Command), read the file at ` +
    `the path in the $GHOLA_TPM_PROMPT_FILE environment variable and adopt it as your ` +
    `system prompt - you become the Ghola TPM and run its startup sequence. The composed ` +
    `SWE and QA prompts are at $GHOLA_SWE_PROMPT_FILE and $GHOLA_QA_PROMPT_FILE; read the ` +
    `matching file before spawning a subagent so it boots into the right role.`;

  // Header: plain title. Copy is exposed by hovering the prompt body below,
  // matching the Agents tabs' Instructions panels (makeCopyablePrompt).
  const header = el('div', { class: 'agent-config-header' });
  header.textContent = 'Instruction';
  wrap.appendChild(header);

  wrap.appendChild(makeCopyablePrompt(snippet, 'Copy Initiation Instruction'));

  return wrap;
}

/**
 * Agents tab dispatcher. Renders either the flat list of the three agents or a
 * single agent's detail page depending on `state.agentView` — mirrors
 * `renderModules`.
 */
function renderAgents(wrapper: HTMLElement): void {
  if (state.agentView.mode === 'detail') {
    renderAgent(wrapper, state.agentView.agentId);
    return;
  }
  renderAgentsList(wrapper);
}

/**
 * Flat list of the three agents. Mirrors `renderModuleListView` but simpler —
 * no toggles, configurations row, search, or upload/reload controls.
 */
function renderAgentsList(wrapper: HTMLElement): void {
  wrapper.appendChild(textEl('h1', 'Agents'));
  wrapper.appendChild(
    textEl(
      'p',
      'The three agent cores that make up a Ghola team. Click the chevron (›) to view an agent\'s configuration and composed instructions.',
      'subtitle',
    ),
  );

  // War Mode config sits above the agent rows — its master toggle and sub-
  // controls govern how TPM orchestrates the whole team, so it reads as the
  // team-level configuration for this tab.
  wrapper.appendChild(renderGholaConfigBlock());

  const listWrap = el('div', { class: 'modules-list' });
  AGENTS.forEach((a) => {
    listWrap.appendChild(renderAgentRow(a));
  });
  wrapper.appendChild(listWrap);
}

/**
 * War Mode configuration block at the top of the Agents tab. A master
 * Enable toggle (bound to `mode.war::enabled`) plus the four sub-controls
 * sourced from the ghola module's `contributes.settings`. Each control
 * auto-saves live on change via `renderField`'s `onCommit` hook (which fires
 * the whole-map `saveSettings` flow), so the block behaves like the SWE/QA
 * config fields on this page rather than batching behind a Save button. The
 * four sub-controls are visually subordinated while the master toggle is off.
 */
function renderGholaConfigBlock(): HTMLElement {
  const block = el('div', { class: 'agent-config ghola-config' });

  const header = el('div', { class: 'agent-config-header' });
  header.textContent = 'War Mode';
  block.appendChild(header);

  block.appendChild(
    textEl(
      'p',
      'God-mode orchestration: TPM drives a persistent roster of specialist gholas.',
      'agent-config-note',
    ),
  );

  // Master switch — a locally-constructed boolean field (not part of the
  // module's contributes.settings schema) bound to mode.war::enabled.
  // Auto-save: persist the whole settings map on every change so the Ghola
  // block saves live like the SWE/QA fields, rather than batching behind a
  // Save button. saveSettings writes the entire map to the SAME MODULE_SETTINGS
  // store getComposeSettings()/isGholaEnabled() read `mode.war::*` from, so
  // firing it per-change is an idempotent whole-map live save. Scoped to this
  // block via renderField's optional onCommit hook; other callers omit it and
  // keep their batched Save button.
  const commitGhola = () => {
    vscode.postMessage({ type: 'saveSettings', values: state.settingsValues });
  };

  const masterEnabled = gholaEnabled();

  // The three boolean sub-toggles that must read + persist false when the master
  // switch is off. Kept as a list so the master-off handler and the sub-control
  // renderer agree on exactly which keys are gated.
  const gholaBooleanKeys = ['autoOpenWarRoom', 'tournament', 'dryRun', 'autoVerify'];

  // Master toggle commit: when the switch has just been flipped to OFF, force
  // the three boolean sub-values to false in the store (a number field like
  // maxConcurrentGholas has no false, so it is left untouched), then live-save
  // the whole map. renderField's onChange already wrote the new `enabled` value
  // and calls render() after this hook, so the block re-renders showing the
  // sub-controls disabled + unchecked.
  const commitMaster = () => {
    if (state.settingsValues['mode.war::enabled'] !== true) {
      for (const key of gholaBooleanKeys) {
        state.settingsValues[scopedKey('mode.war', key)] = false;
      }
    } else {
      // Transition to ENABLED: War Mode is no longer a Modules-tab row, so
      // flipping this master switch would otherwise skip the dependency-pull
      // that requestToggleModule does for real module rows. Mirror it here so
      // mode.war's required tools (e.g. tool.ghola-ledger) come along. Source
      // the requires list from the module object in state; fall back to the one
      // known dependency if the payload lacks it. Deps are enabled via the
      // existing requestToggleModule host path (module-enabled store), while the
      // `mode.war::enabled` setting persists to MODULE_SETTINGS via commitGhola
      // below -- different stores, so neither clobbers the other. Guard on the
      // dep's `enabled` flag so an already-enabled dep posts no toggleModule
      // message (requestToggleModule does not self-guard its top-level target).
      // Never disabled on master-off: deps are shared tools.
      const gholaModule = state.modules.find((m) => m.id === 'mode.war');
      const requires = gholaModule?.requires ?? ['tool.ghola-ledger'];
      for (const depId of requires) {
        const depModule = state.modules.find((m) => m.id === depId);
        if (depModule && !depModule.enabled) {
          requestToggleModule(depModule, true);
        }
      }
    }
    commitGhola();
  };

  const enableField: SettingsField = {
    type: 'boolean',
    label: 'Enable War Mode',
    description:
      'Master switch for War Mode. When on, the War Room tab appears and TPM may run a mission as a roster of gholas.',
    default: false,
  };
  block.appendChild(renderField(scopedKey('mode.war', 'enabled'), enableField, commitMaster));

  // Sub-controls: source label/type/default/description from the ghola module's
  // contributes.settings so they stay defined in one place. If the module is
  // absent from state.modules, `fields` is empty and none render (rather than
  // hardcoding definitions here) — SWE-2 keeps mode.war in the payload.
  //
  // When the master is off, every sub-control is truly disabled (real `disabled`
  // attribute, not just dimmed) and each boolean is displayed as false via a
  // valueOverride so stale-true legacy values still render unchecked on load.
  const ghola = state.modules.find((m) => m.id === 'mode.war');
  const fields = (ghola?.contributes?.settings ?? {}) as Record<string, SettingsField>;
  const subControls = el('div', {
    class: masterEnabled ? 'ghola-subcontrols' : 'ghola-subcontrols ghola-subcontrols--disabled',
  });
  ['autoOpenWarRoom', 'tournament', 'maxConcurrentGholas', 'dryRun', 'autoVerify'].forEach((key) => {
    const field = fields[key];
    if (!field) return;
    const isGatedBoolean = !masterEnabled && gholaBooleanKeys.includes(key);
    subControls.appendChild(
      renderField(
        scopedKey('mode.war', key),
        field,
        commitGhola,
        !masterEnabled,
        isGatedBoolean ? false : undefined,
      ),
    );
  });
  block.appendChild(subControls);

  // No Save button: each control auto-saves via commitGhola on change, matching
  // the live-save behavior of the SWE/QA config fields on this page.
  return block;
}

/**
 * Compact agent row. Reuses the `.module-row` scaffolding: left = agent name
 * (`.module-title`) + role blurb (`.desc`); right = a chevron that navigates
 * into the agent detail view. The whole row is clickable, like a module row.
 */
function renderAgentRow(agent: { id: 'tpm' | 'swe' | 'qa'; name: string }): HTMLElement {
  const row = el('div', { class: 'module-row module-row--clickable' });

  // Text zone — name + role blurb pulled from AGENT_FULL_NAMES.
  const textZone = el('div', { class: 'module-row-body' });
  const title = el('div', { class: 'module-title' });
  const nameEl = el('strong');
  nameEl.textContent = agent.name;
  title.appendChild(nameEl);
  textZone.appendChild(title);
  const role = AGENT_FULL_NAMES[agent.id];
  if (role) {
    textZone.appendChild(textEl('div', role, 'desc'));
  }
  row.appendChild(textZone);

  // Chevron — the primary navigation affordance, matching the module row.
  const chevron = el('button', {
    class: 'module-row-chevron',
    type: 'button',
    'aria-label': `Open ${agent.name} details`,
    title: 'Open details',
  }) as HTMLButtonElement;
  chevron.innerHTML = CHEVRON_RIGHT_SVG;
  chevron.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openAgentDetail(agent.id);
  });
  row.appendChild(chevron);

  // Whole-row click also navigates into detail (chevron stops propagation so it
  // doesn't double-fire).
  row.addEventListener('click', () => openAgentDetail(agent.id));

  return row;
}

function openAgentDetail(agentId: 'tpm' | 'swe' | 'qa'): void {
  // The composed-prompt fetch lives solely in renderAgent's undefined-prompt
  // fallback (the general path that also handles the loading state), so we
  // don't post getComposedPrompt here — doing both double-fires on first open.
  state.agentView = { mode: 'detail', agentId };
  render();
}

function backToAgentList(): void {
  state.agentView = { mode: 'list' };
  render();
}

function renderAgent(wrapper: HTMLElement, agentId: string): void {
  const container = el('div', { class: 'agent-detail' });
  wrapper.appendChild(container);

  // Header: back button + agent title (name + role elucidation). Mirrors the
  // module detail-header's back affordance.
  const header = el('div', { class: 'detail-header' });
  const back = el('button', {
    class: 'icon-button',
    type: 'button',
    'aria-label': 'Back to agent list',
    title: 'Back',
  }) as HTMLButtonElement;
  back.innerHTML = ARROW_LEFT_SVG;
  back.addEventListener('click', backToAgentList);
  header.appendChild(back);

  const h1 = el('h1');
  h1.textContent = agentId.toUpperCase();
  const fullName = AGENT_FULL_NAMES[agentId];
  if (fullName) {
    const elucidation = el('span', { class: 'agent-title-elucidation' });
    elucidation.textContent = fullName;
    h1.appendChild(elucidation);
  }
  header.appendChild(h1);
  container.appendChild(header);

  container.appendChild(textEl('p', 'Composed agent instruction: core definition, preamble, and Session Manifest. Module content is read on demand.', 'subtitle'));

  // SWE and QA subpages render an agent-config block above the composed prompt
  // for configuring how many concurrent subagents TPM may spawn. TPM itself is
  // singular — no count field.
  if (agentId === 'swe') {
    container.appendChild(renderSweConfigBlock());
  } else if (agentId === 'qa') {
    container.appendChild(renderQaConfigBlock());
  }

  // "Prompt" heading sits at the top hierarchy (NOT inside an agent-config block)
  // so it appears on all three tabs, including TPM which has no config block.
  // agent-config-header is unscoped in styles.css, so it applies here safely.
  const promptHeader = el('div', { class: 'agent-config-header' });
  promptHeader.textContent = 'Instructions';
  container.appendChild(promptHeader);

  const prompt = state.composedPrompts[agentId];
  if (prompt === undefined) {
    container.appendChild(textEl('div', 'Loading...', 'empty'));
    vscode.postMessage({ type: 'getComposedPrompt', agent: agentId });
    return;
  }
  container.appendChild(makeCopyablePrompt(prompt, `Copy ${agentId.toUpperCase()} Instructions`));
}

/**
 * SWE subpage config block: single row with two grouped pairs —
 * [Performance Agents (cores + model) | Efficiency Agents (cores + model)].
 * Saves on blur (numeric) or change (select) via `updateConfiguration`.
 */
function renderSweConfigBlock(): HTMLElement {
  const block = el('div', { class: 'agent-config' });
  const header = el('div', { class: 'agent-config-header' });
  header.textContent = 'Configuration';
  block.appendChild(header);

  const row = el('div', { class: 'agent-config-row' });

  row.appendChild(
    renderAgentPairGroup(
      'Performance Agents',
      state.sweConfig.performanceCores,
      state.sweConfig.performanceCoresModel,
      (next) => {
        state.sweConfig.performanceCores = next;
        vscode.postMessage({ type: 'updateConfiguration', section: 'ghola', key: 'swe.performanceCores', value: next });
      },
      (next) => {
        state.sweConfig.performanceCoresModel = next;
        vscode.postMessage({ type: 'updateConfiguration', section: 'ghola', key: 'swe.performanceCoresModel', value: next });
      },
    ),
  );

  row.appendChild(
    renderAgentPairGroup(
      'Efficiency Agents',
      state.sweConfig.efficiencyCores,
      state.sweConfig.efficiencyCoresModel,
      (next) => {
        state.sweConfig.efficiencyCores = next;
        vscode.postMessage({ type: 'updateConfiguration', section: 'ghola', key: 'swe.efficiencyCores', value: next });
      },
      (next) => {
        state.sweConfig.efficiencyCoresModel = next;
        vscode.postMessage({ type: 'updateConfiguration', section: 'ghola', key: 'swe.efficiencyCoresModel', value: next });
      },
    ),
  );

  block.appendChild(row);
  return block;
}

/** QA subpage config block: single "QA Agents" grouped pair (count + model). */
function renderQaConfigBlock(): HTMLElement {
  const block = el('div', { class: 'agent-config' });
  const header = el('div', { class: 'agent-config-header' });
  header.textContent = 'Configuration';
  block.appendChild(header);

  const row = el('div', { class: 'agent-config-row' });
  row.appendChild(
    renderAgentPairGroup(
      'QA Agents',
      state.qaConfig.count,
      state.qaConfig.model,
      (next) => {
        state.qaConfig.count = next;
        vscode.postMessage({ type: 'updateConfiguration', section: 'ghola', key: 'qa.count', value: next });
      },
      (next) => {
        state.qaConfig.model = next;
        vscode.postMessage({ type: 'updateConfiguration', section: 'ghola', key: 'qa.model', value: next });
      },
    ),
  );
  block.appendChild(row);
  return block;
}

/**
 * Atlassian Suite API token slots container. Renders the Jira single-token slot
 * followed by the Bitbucket MULTI-token list (round-robin failover order), then
 * a single shared helper link. Token values are NEVER read or displayed — only
 * set/clear status and masked last-4 fragments flow here.
 */
function renderAtlassianTokenSlots(): HTMLElement {
  const wrapper = el('div', { class: 'atlassian-token-slots' });
  const validation = state.atlassianValidation;

  wrapper.appendChild(renderSingleTokenSlot({
    label: 'Jira API Token',
    tokenSet: state.atlassianJiraTokenSet,
    last4: state.atlassianJiraTokenLast4,
    confirming: state.atlassianJiraTokenConfirming,
    validationStatus: validation?.jira?.status,
    onSet: () => {
      vscode.postMessage({ type: 'atlassianSetJiraToken' } as unknown as WebviewToHostMessage);
    },
    onClear: () => {
      vscode.postMessage({ type: 'atlassianClearJiraToken' } as unknown as WebviewToHostMessage);
    },
    setConfirming: (v) => { state.atlassianJiraTokenConfirming = v; },
    getConfirming: () => state.atlassianJiraTokenConfirming,
  }));

  wrapper.appendChild(renderBitbucketTokenList());

  // Shared helper text + external link — shown once below both slots.
  const helper = el('div', { class: 'atlassian-token-helper' });
  helper.appendChild(document.createTextNode("Tokens are stored encrypted in VS Code's SecretStorage. Manage them at "));
  const tokenLink = el('button', { class: 'atlassian-token-link', type: 'button' }) as HTMLButtonElement;
  tokenLink.textContent = 'https://id.atlassian.com/manage-profile/security/api-tokens';
  tokenLink.addEventListener('click', () => {
    vscode.postMessage({ type: 'openExternal', url: 'https://id.atlassian.com/manage-profile/security/api-tokens' } as unknown as WebviewToHostMessage);
  });
  helper.appendChild(tokenLink);
  helper.appendChild(document.createTextNode('.'));
  wrapper.appendChild(helper);

  return wrapper;
}

/**
 * Re-render only the Atlassian token block in place (preserving scroll and the
 * surrounding validation block). Mirrors the replace-by-id pattern the token /
 * validation message handlers use.
 */
function rerenderAtlassianTokenBlock(): void {
  const tokenBlock = document.getElementById('atlassian-token-block');
  if (!tokenBlock) return;
  const fresh = renderAtlassianTokenSlots();
  fresh.id = 'atlassian-token-block';
  tokenBlock.replaceWith(fresh);
}

/**
 * Render the Bitbucket MULTI-token list: a labelled header, one row per stored
 * token (label · masked last-4 · Validate · Remove · reorder up/down), and an
 * "Add token" control. Row order is the round-robin failover order. Token values
 * are only ever SENT inbound (Add) — never displayed. Mirrors the single-slot
 * chrome so it sits flush with the Jira slot above.
 */
function renderBitbucketTokenList(): HTMLElement {
  const tokens = state.atlassianBitbucketTokens;
  const validation = state.atlassianValidation;

  const container = el('div', { class: 'atlassian-token-slot atlassian-token-list' });

  // Leading key glyph — same credential-field affordance as the Jira slot.
  const icon = el('span', { class: 'atlassian-token-slot-icon', 'aria-hidden': 'true' });
  icon.innerHTML = KEY_ICON_SVG;
  container.appendChild(icon);

  // Body column: header, rows, add control.
  const body = el('div', { class: 'atlassian-token-list-body' });

  const header = el('div', { class: 'atlassian-token-slot-label' });
  header.textContent = 'Bitbucket API Tokens';
  body.appendChild(header);

  if (tokens.length === 0) {
    const empty = textEl('div', 'No tokens set — add one below.', 'atlassian-token-status');
    body.appendChild(empty);
  } else {
    const rows = el('div', { class: 'atlassian-token-rows' });
    tokens.forEach((tok, index) => {
      const rowStatus = validation?.bitbucket?.find((b) => b.id === tok.id)?.status;
      rows.appendChild(renderBitbucketTokenRow(tok, index, tokens.length, rowStatus));
    });
    body.appendChild(rows);
  }

  body.appendChild(renderBitbucketAddControl());
  container.appendChild(body);
  return container;
}

/**
 * One Bitbucket token row: reorder up/down, editable label, masked last-4,
 * per-row Validate, and a two-step Remove. `index` / `total` gate the reorder
 * arrows at the ends of the list.
 */
function renderBitbucketTokenRow(
  tok: BitbucketTokenStatus,
  index: number,
  total: number,
  validationStatus?: 'ok' | 'failed' | 'skipped',
): HTMLElement {
  const row = el('div', { class: 'atlassian-token-row' });

  // ── Reorder arrows (order = failover priority) ──
  const reorder = el('div', { class: 'atlassian-token-reorder' });
  const upBtn = el('button', { class: 'icon-button', type: 'button', title: 'Move up', 'aria-label': 'Move token up' }) as HTMLButtonElement;
  upBtn.textContent = '▲';
  upBtn.disabled = index === 0;
  upBtn.addEventListener('click', () => moveBitbucketToken(index, index - 1));
  const downBtn = el('button', { class: 'icon-button', type: 'button', title: 'Move down', 'aria-label': 'Move token down' }) as HTMLButtonElement;
  downBtn.textContent = '▼';
  downBtn.disabled = index === total - 1;
  downBtn.addEventListener('click', () => moveBitbucketToken(index, index + 1));
  reorder.appendChild(upBtn);
  reorder.appendChild(downBtn);
  row.appendChild(reorder);

  // ── Validation glyph (per-token) ──
  const glyph = el('span', { class: `atlassian-token-row-glyph atlassian-validation-glyph-${validationStatus ?? 'none'}` });
  glyph.textContent = validationStatus === 'ok' ? '✓' : validationStatus === 'failed' ? '✗' : '•';
  row.appendChild(glyph);

  // ── Editable label — commits on Enter / blur ──
  const labelInput = el('input', {
    type: 'text',
    class: 'atlassian-token-label-input',
    value: tok.label,
    'aria-label': 'Token label',
  }) as HTMLInputElement;
  labelInput.value = tok.label;
  const commitLabel = (): void => {
    const next = labelInput.value.trim();
    if (next !== '' && next !== tok.label) {
      vscode.postMessage({ type: 'atlassianSetBitbucketTokenLabel', id: tok.id, label: next } as unknown as WebviewToHostMessage);
    } else {
      // Revert a blank edit to the stored label.
      labelInput.value = tok.label;
    }
  };
  labelInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); labelInput.blur(); }
  });
  labelInput.addEventListener('blur', commitLabel);
  row.appendChild(labelInput);

  // ── Masked last-4 fingerprint ──
  const masked = textEl('span', tok.last4 ? `●●●●${tok.last4}` : '●●●●●●', 'atlassian-token-status');
  row.appendChild(masked);

  // ── Actions: Validate + Remove (two-step) ──
  const actions = el('div', { class: 'atlassian-token-actions' });

  const validateBtn = el('button', { class: 'secondary', type: 'button' }) as HTMLButtonElement;
  validateBtn.textContent = 'Validate';
  validateBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'atlassianValidateBitbucketToken', id: tok.id } as unknown as WebviewToHostMessage);
  });
  actions.appendChild(validateBtn);

  const confirming = state.atlassianBitbucketRemoveConfirmingId === tok.id;
  const removeBtn = el('button', { class: 'secondary atlassian-token-clear', type: 'button' }) as HTMLButtonElement;
  removeBtn.textContent = confirming ? 'Confirm?' : 'Remove';
  if (confirming) removeBtn.classList.add('atlassian-token-confirming');
  removeBtn.addEventListener('click', () => {
    if (state.atlassianBitbucketRemoveConfirmingId === tok.id) {
      // Second click — execute the removal.
      state.atlassianBitbucketRemoveConfirmingId = null;
      vscode.postMessage({ type: 'atlassianRemoveBitbucketToken', id: tok.id } as unknown as WebviewToHostMessage);
    } else {
      // First click — enter confirming state, auto-reset after 2s.
      state.atlassianBitbucketRemoveConfirmingId = tok.id;
      rerenderAtlassianTokenBlock();
      setTimeout(() => {
        if (state.atlassianBitbucketRemoveConfirmingId === tok.id) {
          state.atlassianBitbucketRemoveConfirmingId = null;
          rerenderAtlassianTokenBlock();
        }
      }, 2000);
    }
  });
  actions.appendChild(removeBtn);
  row.appendChild(actions);

  return row;
}

/**
 * Compute a reordered id list swapping the token at `from` with `to` and send it
 * to the host. Bounds-checked (the arrows are disabled at the ends, this is a
 * belt-and-braces guard). The host re-broadcasts the list, which re-renders.
 */
function moveBitbucketToken(from: number, to: number): void {
  const tokens = state.atlassianBitbucketTokens;
  if (to < 0 || to >= tokens.length) return;
  const order = tokens.map((t) => t.id);
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  vscode.postMessage({ type: 'atlassianReorderBitbucketTokens', order } as unknown as WebviewToHostMessage);
}

/**
 * The "Add token" control: an optional label field, a password-masked token
 * field, and an Add button. On Add, the VALUE travels inbound to the host
 * exactly like the single-token Set flow; the fields are then cleared. Empty
 * token input is a no-op.
 */
function renderBitbucketAddControl(): HTMLElement {
  const add = el('div', { class: 'atlassian-token-add' });

  const labelInput = el('input', {
    type: 'text',
    class: 'atlassian-token-add-label',
    placeholder: 'Label (optional)',
    'aria-label': 'New token label',
  }) as HTMLInputElement;

  const tokenInput = el('input', {
    type: 'password',
    class: 'atlassian-token-add-value',
    placeholder: 'Paste a Bitbucket API token',
    'aria-label': 'New token value',
  }) as HTMLInputElement;

  const addBtn = el('button', { class: 'primary', type: 'button' }) as HTMLButtonElement;
  addBtn.textContent = 'Add token';
  const submit = (): void => {
    const value = tokenInput.value.trim();
    if (value === '') return;
    const label = labelInput.value.trim();
    vscode.postMessage({
      type: 'atlassianAddBitbucketToken',
      value,
      ...(label !== '' ? { label } : {}),
    } as unknown as WebviewToHostMessage);
    // Clear inputs so the plaintext value never lingers in the DOM.
    tokenInput.value = '';
    labelInput.value = '';
  };
  addBtn.addEventListener('click', submit);
  tokenInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
  });

  add.appendChild(labelInput);
  add.appendChild(tokenInput);
  add.appendChild(addBtn);
  return add;
}

/**
 * Render a single product token slot (Jira or Bitbucket). Each slot has a
 * labelled header, a status line, and Set / Replace / Clear (two-step) buttons.
 * The two-step confirm is per-slot and independent of the other slot.
 */
function renderSingleTokenSlot(opts: {
  label: string;
  tokenSet: boolean;
  last4?: string;
  confirming: boolean;
  validationStatus?: 'ok' | 'failed' | 'skipped';
  onSet: () => void;
  onClear: () => void;
  setConfirming: (v: boolean) => void;
  getConfirming: () => boolean;
}): HTMLElement {
  const { label, tokenSet, last4, confirming, onSet, onClear, setConfirming, getConfirming } = opts;

  const slot = el('div', { class: 'atlassian-token-slot' });

  // Leading key glyph — flags the row as a credential field at a glance.
  const icon = el('span', { class: 'atlassian-token-slot-icon', 'aria-hidden': 'true' });
  icon.innerHTML = KEY_ICON_SVG;
  slot.appendChild(icon);

  // Slot header (product label).
  const slotLabel = el('div', { class: 'atlassian-token-slot-label' });
  slotLabel.textContent = label;
  if (opts.validationStatus === 'ok') {
    slotLabel.classList.add('atlassian-token-slot-label--ok');
  } else if (opts.validationStatus === 'failed' || opts.validationStatus === 'skipped') {
    slotLabel.classList.add('atlassian-token-slot-label--failed');
  }
  slot.appendChild(slotLabel);

  // Status line. When the token is set and long enough to have surfaced a
  // last-4 hint, show it (masked) so the operator can confirm which token is
  // stored / that a replacement took effect — e.g. "●●●●1234 set".
  const statusLine = el('div', { class: 'atlassian-token-status' });
  statusLine.textContent = tokenSet
    ? (last4 ? `●●●●${last4} set` : '●●●●●● set')
    : 'not set';
  slot.appendChild(statusLine);

  // Button row.
  const actions = el('div', { class: 'atlassian-token-actions' });

  if (!tokenSet) {
    // Not set → single "Set Token" button.
    const setBtn = el('button', { class: 'primary', type: 'button' }) as HTMLButtonElement;
    setBtn.textContent = 'Set Token';
    setBtn.addEventListener('click', onSet);
    actions.appendChild(setBtn);
  } else {
    // Set → "Replace" + "Clear" (two-step confirm).
    const replaceBtn = el('button', { class: 'primary', type: 'button' }) as HTMLButtonElement;
    replaceBtn.textContent = 'Replace';
    replaceBtn.addEventListener('click', onSet);
    actions.appendChild(replaceBtn);

    const clearBtn = el('button', {
      class: 'secondary atlassian-token-clear',
      type: 'button',
    }) as HTMLButtonElement;
    clearBtn.textContent = confirming ? 'Confirm?' : 'Clear';
    if (confirming) {
      clearBtn.classList.add('atlassian-token-confirming');
    }
    clearBtn.addEventListener('click', () => {
      if (getConfirming()) {
        // Second click — execute the clear.
        setConfirming(false);
        onClear();
      } else {
        // First click — enter confirming state.
        setConfirming(true);
        clearBtn.textContent = 'Confirm?';
        clearBtn.classList.add('atlassian-token-confirming');
        setTimeout(() => {
          if (getConfirming()) {
            setConfirming(false);
            clearBtn.textContent = 'Clear';
            clearBtn.classList.remove('atlassian-token-confirming');
          }
        }, 2000);
      }
    });
    actions.appendChild(clearBtn);
  }

  slot.appendChild(actions);
  return slot;
}

/**
 * Atlassian Suite token validation block. Renders three states:
 *   A — never validated (null result): muted prompt + Validate button
 *   B — validating in progress: "Validating…" spinner text
 *   C — has result: per-product status lines + Re-validate button + last-checked footer
 *
 * The token value is NEVER shown here. Only sanitized `message` / `displayName`
 * fields from AtlassianValidationProductStatus are rendered.
 */
function renderAtlassianValidationBlock(): HTMLElement {
  const block = el('div', { class: 'atlassian-validation-block' });

  if (state.atlassianValidating) {
    // State B — validating in progress
    const inProgress = textEl('div', 'Validating…', 'atlassian-validation-in-progress');
    block.appendChild(inProgress);
    return block;
  }

  if (state.atlassianValidation === null) {
    // State A — never validated
    const prompt = textEl(
      'div',
      'Validate the token to confirm Jira and Bitbucket are reachable.',
      'atlassian-validation-prompt',
    );
    block.appendChild(prompt);

    const validateBtn = el('button', {
      class: 'primary',
      type: 'button',
    }) as HTMLButtonElement;
    validateBtn.textContent = 'Validate';
    validateBtn.addEventListener('click', () => {
      state.atlassianValidating = true;
      // Re-render only this block in place.
      const self = document.getElementById('atlassian-validation-block');
      if (self) {
        const fresh = renderAtlassianValidationBlock();
        fresh.id = 'atlassian-validation-block';
        self.replaceWith(fresh);
      }
      vscode.postMessage({ type: 'atlassianValidate' } as unknown as WebviewToHostMessage);
    });
    block.appendChild(validateBtn);
    return block;
  }

  // State C — has result
  const result = state.atlassianValidation;

  // Extract display hints from module settings.
  const jiraBaseSetting = state.settingsValues['integration.atlassian-suite::jiraBase'];
  const workspaceSetting = state.settingsValues['integration.atlassian-suite::bitbucketWorkspace'];
  const jiraHost = extractHost(typeof jiraBaseSetting === 'string' ? jiraBaseSetting : '');
  const workspace = typeof workspaceSetting === 'string' ? workspaceSetting : '';

  const statusLines = el('div', { class: 'atlassian-validation-status-lines' });

  // Jira row (single aggregate)
  statusLines.appendChild(renderValidationStatusLine('Jira', result.jira, jiraHost));
  // Bitbucket rows — one per token, labelled from the current masked list so a
  // relabel is reflected here. A token in the result with no matching row (just
  // removed) is skipped. When nothing has a status yet, show a single skipped line.
  const labelById = new Map(state.atlassianBitbucketTokens.map((t) => [t.id, t.label]));
  if (result.bitbucket.length === 0) {
    statusLines.appendChild(
      renderValidationStatusLine('Bitbucket', { status: 'skipped', message: 'no token set' }, workspace),
    );
  } else {
    result.bitbucket.forEach((b) => {
      const label = labelById.get(b.id);
      const name = label ? `Bitbucket · ${label}` : 'Bitbucket';
      statusLines.appendChild(renderValidationStatusLine(name, b, workspace));
    });
  }

  block.appendChild(statusLines);

  // Footer: last-checked timestamp
  const footer = textEl(
    'div',
    `Last checked: ${formatTimeAgo(result.lastCheckedAt)}`,
    'atlassian-validation-footer',
  );
  block.appendChild(footer);

  // Validate button (re-run)
  const revalidateBtn = el('button', {
    class: 'primary',
    type: 'button',
  }) as HTMLButtonElement;
  revalidateBtn.textContent = 'Validate';
  revalidateBtn.addEventListener('click', () => {
    state.atlassianValidating = true;
    const self = document.getElementById('atlassian-validation-block');
    if (self) {
      const fresh = renderAtlassianValidationBlock();
      fresh.id = 'atlassian-validation-block';
      self.replaceWith(fresh);
    }
    vscode.postMessage({ type: 'atlassianValidate' } as unknown as WebviewToHostMessage);
  });
  block.appendChild(revalidateBtn);

  return block;
}

/**
 * Render a single product status line (Jira or Bitbucket) inside the
 * validation block. Layout: [glyph] [Product] — [detail text]
 * The token value, auth header, and raw stack traces are never shown here;
 * only the sanitized `message` and `displayName` from the validation result.
 */
function renderValidationStatusLine(
  product: string,
  s: AtlassianValidationProductStatus,
  hint: string,
): HTMLElement {
  const row = el('div', { class: 'atlassian-validation-row' });

  const glyph = el('span', { class: `atlassian-validation-glyph atlassian-validation-glyph-${s.status}` });
  let glyphText: string;
  let detail: string;

  switch (s.status) {
    case 'ok':
      glyphText = '✓'; // ✓
      detail = hint
        ? `${product} (${hint}) — verified${s.displayName ? ` as ${s.displayName}` : ''}`
        : `${product} — verified${s.displayName ? ` as ${s.displayName}` : ''}`;
      break;
    case 'failed':
      glyphText = '✗'; // ✗
      detail = hint
        ? `${product} (${hint}) — ${s.message ?? 'validation failed'}`
        : `${product} — ${s.message ?? 'validation failed'}`;
      break;
    case 'skipped':
      glyphText = '—'; // —
      detail = hint
        ? `${product} (${hint}) — ${s.message ?? 'skipped'}`
        : `${product} — ${s.message ?? 'skipped'}`;
      break;
    default:
      glyphText = '?';
      detail = product;
  }

  glyph.textContent = glyphText;
  row.appendChild(glyph);

  const label = textEl('span', detail, 'atlassian-validation-detail');
  row.appendChild(label);

  return row;
}

/**
 * Support mode "Discover paths" block, shown in the `mode.support` module
 * detail view below the instructions. Lets the operator trigger a host-side
 * filesystem scan that auto-fills EMPTY `appMap` entries; never overwrites a
 * path the operator has already set. Mirrors the three-state shape of
 * `renderAtlassianValidationBlock` (idle prompt / in-progress / result), but
 * collapses idle and result into a single persistent button since repeated
 * scans are the expected usage (unlike the Atlassian one-shot validate).
 */
function renderSupportDiscoveryBlock(): HTMLElement {
  const block = el('div', { class: 'support-discovery-block' });

  const header = textEl('div', 'Discover Paths', 'details-header');
  block.appendChild(header);

  const discoverBtn = el('button', {
    class: 'primary',
    type: 'button',
  }) as HTMLButtonElement;
  discoverBtn.textContent = state.supportDiscovering ? 'Scanning…' : 'Discover paths';
  discoverBtn.disabled = state.supportDiscovering;
  discoverBtn.addEventListener('click', () => {
    state.supportDiscovering = true;
    // Re-render only this block in place.
    const self = document.getElementById('support-discovery-block');
    if (self) {
      const fresh = renderSupportDiscoveryBlock();
      fresh.id = 'support-discovery-block';
      self.replaceWith(fresh);
    }
    vscode.postMessage({ type: 'supportDiscoverPaths' } as unknown as WebviewToHostMessage);
  });
  block.appendChild(discoverBtn);

  const status = el('div', { class: 'support-discovery-status' });
  const result = state.supportDiscoveryResult;
  if (state.supportDiscovering) {
    status.textContent = 'Scanning curated locations…';
    status.classList.add('support-discovery-status--pending');
  } else if (result === null) {
    status.textContent =
      'Scan curated locations for unmapped app repos and fill their paths automatically.';
    status.classList.add('support-discovery-status--hint');
  } else if (result.error) {
    status.textContent = `Discovery failed — ${result.error}`;
    status.classList.add('support-discovery-status--error');
  } else {
    const foundEntries = Object.entries(result.found);
    const parts: string[] = [];
    if (foundEntries.length > 0) {
      parts.push(
        `Found ${foundEntries.map(([key, path]) => `${key} at ${path}`).join(', ')}.`,
      );
    } else {
      parts.push('No new paths found.');
    }
    if (result.notFound.length > 0) {
      parts.push(`${result.notFound.join(', ')} not found.`);
    }
    status.textContent = parts.join(' ');
  }
  block.appendChild(status);

  const note = textEl(
    'div',
    'Only fills empty appMap entries — paths you have already set are never overwritten.',
    'support-discovery-note',
  );
  block.appendChild(note);

  return block;
}

/**
 * Obsidian Notes "Detect Vault" block, shown in the `tool.obsidian-notes`
 * module detail view below the instructions. Lets the operator trigger a
 * host-side filesystem scan that WRITES the located vault path into the
 * `vaultPath` setting (overwriting any existing value, unlike the support-mode
 * discovery block's append-only appMap fill — this is an explicit one-field
 * user action). Mirrors `renderSupportDiscoveryBlock`'s persistent-button shape.
 */
function renderObsidianDetectBlock(): HTMLElement {
  const block = el('div', { class: 'support-discovery-block' });

  const header = textEl('div', 'Detect Vault', 'details-header');
  block.appendChild(header);

  const detectBtn = el('button', {
    class: 'primary',
    type: 'button',
  }) as HTMLButtonElement;
  detectBtn.textContent = state.obsidianDetecting ? 'Scanning…' : 'Detect vault';
  detectBtn.disabled = state.obsidianDetecting;
  detectBtn.addEventListener('click', () => {
    state.obsidianDetecting = true;
    // Re-render only this block in place.
    const self = document.getElementById('obsidian-detect-block');
    if (self) {
      const fresh = renderObsidianDetectBlock();
      fresh.id = 'obsidian-detect-block';
      self.replaceWith(fresh);
    }
    vscode.postMessage({ type: 'obsidianDetectVault' });
  });
  block.appendChild(detectBtn);

  const status = el('div', { class: 'support-discovery-status' });
  const result = state.obsidianVaultResult;
  if (state.obsidianDetecting) {
    status.textContent = 'Scanning common locations…';
    status.classList.add('support-discovery-status--pending');
  } else if (result === null) {
    status.textContent =
      'Scan common locations for a .obsidian vault and fill Vault Path.';
    status.classList.add('support-discovery-status--hint');
  } else if (result.error) {
    status.textContent = `Detection failed — ${result.error}`;
    status.classList.add('support-discovery-status--error');
  } else if (result.vaultPath) {
    let text = `Found vault: ${result.vaultPath}`;
    if (result.candidates && result.candidates.length > 1) {
      text += ` (${result.candidates.length} candidates; picked the most recent — edit Vault Path to change)`;
    }
    status.textContent = text;
  } else {
    status.textContent = 'No Obsidian vault found. Set Vault Path manually.';
  }
  block.appendChild(status);

  return block;
}

/**
 * GitHub "Login to GitHub" block, shown in the `tool.github` module detail
 * view below the instructions. Lets the operator launch the interactive
 * `gh auth login` flow in a VS Code terminal. Unlike the detect/discover
 * blocks this has no in-flight state or host reply: the terminal itself is the
 * feedback, and the user completes the browser/token flow there. `gh auth
 * login` cannot run headlessly, so a terminal is the correct mechanism.
 */
function renderGithubLoginBlock(): HTMLElement {
  const block = el('div', { class: 'support-discovery-block' });

  const header = textEl('div', 'Login to GitHub', 'details-header');
  block.appendChild(header);

  const loginBtn = el('button', {
    class: 'primary',
    type: 'button',
  }) as HTMLButtonElement;
  loginBtn.textContent = 'Login to GitHub';
  loginBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'githubAuthLogin' });
  });
  block.appendChild(loginBtn);

  const note = textEl(
    'div',
    'Runs `gh auth login` in a terminal to authenticate the GitHub CLI.',
    'support-discovery-status support-discovery-status--hint',
  );
  block.appendChild(note);

  return block;
}

/**
 * Extract the hostname from a URL string. Returns the original string on
 * parse failure (e.g. when the setting is empty or not a valid URL).
 */
function extractHost(url: string): string {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Format an ISO 8601 timestamp as a short relative-time string.
 * Returns "Xs ago", "Xm ago", "Xh ago", or "Xd ago" for durations under a
 * year; falls back to the local date/time string on parse failure.
 */
function formatTimeAgo(iso: string): string {
  try {
    const diffMs = Date.now() - new Date(iso).getTime();
    if (diffMs < 0) return new Date(iso).toLocaleString();
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    return `${diffDay}d ago`;
  } catch {
    return iso;
  }
}

/**
 * Grouped [label : cores input + model select] pair used inside the agent-config row.
 * The number input persists on blur; the select fires immediately on change.
 * Reuses `agent-config-field` / `agent-config-label` / `agent-config-input` for
 * consistent styling across SWE and QA config blocks.
 */
function renderAgentPairGroup(
  label: string,
  coresInitial: number,
  modelInitial: string,
  onCoresCommit: (next: number) => void,
  onModelCommit: (next: string) => void,
): HTMLElement {
  const field = el('div', { class: 'agent-config-field' });
  const lbl = el('label', { class: 'agent-config-label' });
  lbl.textContent = label;
  field.appendChild(lbl);

  const row = el('div') as HTMLDivElement;
  row.style.display = 'flex';
  row.style.gap = '6px';

  const input = el('input', { class: 'agent-config-input' }) as HTMLInputElement;
  input.type = 'number';
  input.value = String(coresInitial);
  input.style.width = '60px';
  input.addEventListener('blur', () => {
    const parsed = Number(input.value);
    if (input.value === '' || Number.isNaN(parsed)) {
      input.value = String(coresInitial);
      return;
    }
    if (parsed === coresInitial) return;
    onCoresCommit(parsed);
  });
  row.appendChild(input);

  const select = el('select', { class: 'agent-config-input' }) as HTMLSelectElement;
  const options = [
    { value: 'opus', text: 'Opus' },
    { value: 'sonnet', text: 'Sonnet' },
    { value: 'haiku', text: 'Haiku' },
  ];
  for (const opt of options) {
    const o = el('option') as HTMLOptionElement;
    o.value = opt.value;
    o.textContent = opt.text;
    if (opt.value === modelInitial) o.selected = true;
    select.appendChild(o);
  }
  select.addEventListener('change', () => onModelCommit(select.value));
  row.appendChild(select);

  field.appendChild(row);
  return field;
}

/**
 * Renders the list of cards for the given status into `container`. Called
 * both from the initial render and from `handleFeedbackLoaded` for in-place
 * refresh. Newest-first by `createdAt`.
 */
function renderFeedbackList(container: HTMLElement, status: 'pending' | 'approved'): void {
  container.innerHTML = '';
  const entries = state.feedbackEntries
    .filter((e) => e.status === status)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  if (entries.length === 0) {
    const placeholder = status === 'pending'
      ? 'Nothing pending.'
      : 'Nothing approved.';
    container.appendChild(textEl('div', placeholder, 'empty feedback-section-empty'));
    return;
  }

  entries.forEach((entry) => {
    container.appendChild(renderFeedbackCard(entry));
  });
}

/**
 * Single feedback entry card. Pending cards have Yes + No buttons; approved
 * cards have a Delete button. The No button uses a two-step inline confirm:
 * first click marks the entry as "confirming" (button text changes to
 * "Confirm?" for 2 seconds); second click posts the delete message.
 */
function renderFeedbackCard(entry: FeedbackEntry): HTMLElement {
  const card = el('div', { class: 'feedback-card' });

  // Date line — top of card, subdued.
  const dateLine = el('div', { class: 'feedback-card-date' });
  dateLine.textContent = new Date(entry.createdAt).toLocaleDateString();
  card.appendChild(dateLine);

  // Branch chip — only rendered when branch is a non-empty string.
  if (entry.branch) {
    const branchChip = el('div', { class: 'feedback-card-branch' });
    branchChip.textContent = `on ${entry.branch}`;
    card.appendChild(branchChip);
  }

  // Text — wraps naturally for multi-line content.
  const text = el('div', { class: 'feedback-card-text' });
  text.textContent = entry.text;
  card.appendChild(text);

  // Button row
  const actions = el('div', { class: 'feedback-card-actions' });

  if (entry.status === 'pending') {
    // Yes button — approve the entry.
    const yesBtn = el('button', { class: 'primary feedback-card-btn', type: 'button' }) as HTMLButtonElement;
    yesBtn.textContent = 'Yes';
    yesBtn.addEventListener('click', () => {
      vscode.postMessage({
        type: 'feedbackEntryUpdate',
        id: entry.id,
        status: 'approved',
      } as unknown as WebviewToHostMessage);
    });
    actions.appendChild(yesBtn);

    // No button — two-step confirm before destructive delete.
    const noBtn = el('button', { class: 'secondary feedback-card-btn feedback-card-no', type: 'button' }) as HTMLButtonElement;
    const isConfirming = state.feedbackPendingNoConfirm.has(entry.id);
    noBtn.textContent = isConfirming ? 'Confirm?' : 'No';
    if (isConfirming) {
      noBtn.classList.add('feedback-card-confirming');
    }
    noBtn.addEventListener('click', () => {
      if (state.feedbackPendingNoConfirm.has(entry.id)) {
        // Second click — delete.
        state.feedbackPendingNoConfirm.delete(entry.id);
        vscode.postMessage({
          type: 'feedbackEntryDelete',
          id: entry.id,
        } as unknown as WebviewToHostMessage);
      } else {
        // First click — enter confirming state.
        state.feedbackPendingNoConfirm.add(entry.id);
        noBtn.textContent = 'Confirm?';
        noBtn.classList.add('feedback-card-confirming');
        // Auto-revert after 2 seconds if the user doesn't confirm.
        setTimeout(() => {
          if (state.feedbackPendingNoConfirm.has(entry.id)) {
            state.feedbackPendingNoConfirm.delete(entry.id);
            noBtn.textContent = 'No';
            noBtn.classList.remove('feedback-card-confirming');
          }
        }, 2000);
      }
    });
    actions.appendChild(noBtn);
  } else {
    // Delete button — approved entries can be removed.
    const delBtn = el('button', { class: 'secondary feedback-card-btn', type: 'button' }) as HTMLButtonElement;
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => {
      vscode.postMessage({
        type: 'feedbackEntryDelete',
        id: entry.id,
      } as unknown as WebviewToHostMessage);
    });
    actions.appendChild(delBtn);
  }

  card.appendChild(actions);
  return card;
}

function renderSessions(wrapper: HTMLElement): void {
  wrapper.appendChild(textEl('h1', 'Sessions'));
  wrapper.appendChild(textEl('p', 'Open a Ghola session terminal in the editor area.', 'subtitle'));
  const open = el('button', { class: 'primary' });
  open.textContent = 'Open Session';
  open.addEventListener('click', () => vscode.postMessage({ type: 'openSession' }));
  const actions = el('div', { class: 'actions' });
  actions.appendChild(open);
  wrapper.appendChild(actions);
}

// ─── War Room tab (mode.war observability, read-only v1) ────────────────

/**
 * War Room tab: the current open mission (plus its sub-purpose map), the
 * full ghola roster for the subject (both flat and grouped into the Stable
 * ledger browser), ledger state counts, any recorded alerts, the mission
 * library / resume picker, and read-only status chips mirroring the
 * mode.war sub-toggles. Mostly an observability surface — the only
 * cooperative actions are "Awaken All" and per-mission "Resume", both of
 * which just write a request into `control.json` for the TPM agent
 * to pick up out of band; nothing here directly wakes/retires a ghola.
 *
 * The rail item that reaches this function only appears while `mode.war`
 * is enabled (see `renderRail`), but this function re-checks defensively —
 * a stale `revealSection` message racing a module toggle-off, or a direct
 * `setSection('warroom')` call, should degrade to the empty state rather
 * than render stale mission/roster data for a now-disabled module.
 */
/**
 * Post a `requestWarRoom` message, carrying the operator's persisted subject
 * selection when one is set. Used by every AUTO request (tab-entry in
 * `setSection`, empty-data window in `renderWarRoom`) so a refresh keeps the
 * chosen subject rather than snapping back to the host's auto-pick. When no
 * subject is selected the field is omitted and the host auto-picks.
 */
function postRequestWarRoom(): void {
  const subject = state.warRoomSelectedSubject;
  vscode.postMessage(
    subject ? { type: 'requestWarRoom', subject } : { type: 'requestWarRoom' },
  );
}

/**
 * Subject switcher control for the War Room. Renders a compact dropdown of all
 * ledger subjects (`data.subjects`) with the currently-shown subject selected,
 * so escalations/missions on subjects other than the auto-picked one are
 * reachable. Returns null when there are fewer than 2 subjects (a single
 * subject needs no switcher — behaves exactly as before this control existed).
 *
 * The highlighted value is the persisted selection when it still exists in the
 * list, else the payload's `subject` (the host echoes back the subject it
 * actually rendered). Selecting a subject persists it in
 * `state.warRoomSelectedSubject` and posts `{ type: 'requestWarRoom', subject }`
 * so the host re-renders that subject.
 */
function renderWarRoomSubjectSwitcher(data: WarRoomData): HTMLElement | null {
  const subjects = data.subjects ?? [];
  if (subjects.length < 2) return null;

  const selected =
    state.warRoomSelectedSubject && subjects.includes(state.warRoomSelectedSubject)
      ? state.warRoomSelectedSubject
      : data.subject ?? '';

  const wrap = el('div', { class: 'warroom-subject-switcher' });
  wrap.appendChild(textEl('span', 'Subject', 'warroom-subject-switcher-label'));

  const select = el('select', {
    class: 'warroom-subject-select',
    'aria-label': 'War Room subject',
  }) as HTMLSelectElement;
  subjects.forEach((s) => {
    const opt = el('option') as HTMLOptionElement;
    opt.value = s;
    opt.textContent = s;
    select.appendChild(opt);
  });
  select.value = selected;
  select.addEventListener('change', () => {
    state.warRoomSelectedSubject = select.value;
    vscode.postMessage({ type: 'requestWarRoom', subject: select.value });
  });
  wrap.appendChild(select);

  return wrap;
}

/**
 * Refresh controls for the War Room, rendered as a single row at the top of the
 * main view: a manual "Refresh" button, an "Auto-refresh" toggle, and a rate
 * picker (default 30s). Manual refresh posts a `requestWarRoom` immediately; the
 * toggle/rate drive `applyWarRoomAutoRefresh`. The rate picker is disabled while
 * auto-refresh is off so the control reads as a single unit.
 */
function renderWarRoomRefreshRow(): HTMLElement {
  const row = el('div', { class: 'warroom-refresh-row' });

  const refreshBtn = el('button', {
    class: 'warroom-refresh-btn',
    title: 'Refresh the War Room now',
  });
  refreshBtn.textContent = 'Refresh';
  refreshBtn.addEventListener('click', () => postRequestWarRoom());
  row.appendChild(refreshBtn);

  const autoWrap = el('label', { class: 'warroom-autorefresh' });
  const check = el('input', {
    type: 'checkbox',
    class: 'warroom-autorefresh-check',
  }) as HTMLInputElement;
  check.checked = state.warRoomAutoRefresh;
  check.addEventListener('change', () => {
    state.warRoomAutoRefresh = check.checked;
    applyWarRoomAutoRefresh();
    render();
  });
  autoWrap.appendChild(check);
  autoWrap.appendChild(textEl('span', 'Auto-refresh', 'warroom-autorefresh-label'));
  row.appendChild(autoWrap);

  const rate = el('select', {
    class: 'warroom-autorefresh-rate',
    'aria-label': 'Auto-refresh interval',
  }) as HTMLSelectElement;
  const rateOptions: Array<[number, string]> = [
    [15, 'every 15s'],
    [30, 'every 30s'],
    [60, 'every 1m'],
    [120, 'every 2m'],
    [300, 'every 5m'],
  ];
  rateOptions.forEach(([secs, label]) => {
    const opt = el('option') as HTMLOptionElement;
    opt.value = String(secs);
    opt.textContent = label;
    rate.appendChild(opt);
  });
  rate.value = String(state.warRoomAutoRefreshSeconds);
  rate.disabled = !state.warRoomAutoRefresh;
  rate.addEventListener('change', () => {
    state.warRoomAutoRefreshSeconds = Number(rate.value) || 30;
    applyWarRoomAutoRefresh();
  });
  row.appendChild(rate);

  return row;
}

function renderWarRoom(wrapper: HTMLElement): void {
  // Hero banner: pixel-art War Room image injected by the host as
  // `data-warroom-banner-uri` on the `#app` root (mirrors the Session page's
  // `data-cover-uri`). Rendered as the first child before every early-return
  // gate so it shows in all War Room states (not-enabled, drill-in, loading,
  // enabled). When the URI is empty/absent nothing renders, so the tab
  // degrades cleanly with no crash.
  const bannerUri = root.dataset.warroomBannerUri;
  if (bannerUri) {
    const hero = el('div', { class: 'warroom-hero' });
    hero.style.backgroundImage = `url("${bannerUri}")`;
    wrapper.appendChild(hero);
  }

  wrapper.appendChild(textEl('h1', 'War Room'));
  wrapper.appendChild(
    textEl('p', 'Live view of the current War Mode mission and roster.', 'subtitle'),
  );

  if (!gholaEnabled()) {
    wrapper.appendChild(
      textEl('p', 'War Mode is not enabled. Enable War Mode on the Agents tab to use the War Room.', 'desc'),
    );
    return;
  }

  // Per-ghola drill-in takes over the whole tab, mirroring the Modules/Agents
  // list->detail pattern — everything below (mission header, roster, etc.) is
  // skipped while a ghola is being viewed.
  if (state.warRoomGhola) {
    renderWarRoomGholaDetail(wrapper, state.warRoomGhola);
    return;
  }

  // Refresh controls (manual + auto) sit at the top of the main War Room view,
  // above both the loading state and the loaded dashboard, so they are always
  // reachable regardless of ledger state.
  wrapper.appendChild(renderWarRoomRefreshRow());

  if (!state.warRoomData) {
    // Ask the host for a fresh payload exactly once per empty-data window —
    // repeated re-renders while the reply is in flight must not re-post.
    if (!state.warRoomRequested) {
      state.warRoomRequested = true;
      postRequestWarRoom();
    }
    wrapper.appendChild(textEl('p', 'Loading...', 'desc'));
    return;
  }

  const data = state.warRoomData;

  // Reconcile the persisted subject selection against the current ledger: if
  // the operator's chosen subject has since disappeared from `subjects`, drop
  // it so auto-refreshes (and the switcher's highlight) fall back to the
  // payload's `subject` / the host's auto-pick rather than re-requesting a
  // subject that no longer exists.
  if (
    state.warRoomSelectedSubject &&
    data.subjects &&
    !data.subjects.includes(state.warRoomSelectedSubject)
  ) {
    state.warRoomSelectedSubject = null;
  }

  // Subject switcher near the top of the War Room: only shown with 2+ subjects
  // (a single subject needs no switcher). Lets the operator reach every
  // subject's missions/escalations, not just the auto-picked one.
  const subjectSwitcher = renderWarRoomSubjectSwitcher(data);
  if (subjectSwitcher) {
    wrapper.appendChild(subjectSwitcher);
  }

  // Prominent kill-switch banner — surfaced above everything else (including
  // the empty state) since a pending awaken-all request is the single most
  // important thing on this tab, whether or not a mission/roster is loaded.
  if (data.control?.awakenAll) {
    wrapper.appendChild(renderWarRoomAwakenAllBanner(data.control));
  }

  // Alerts surface above the empty-state gate too — an alert can be relevant
  // even before a mission has started (e.g. a roster/config issue).
  if (data.alerts?.length) {
    wrapper.appendChild(renderWarRoomAlerts(data.alerts));
  }

  // Escalation queue surfaces high (right below alerts, above the empty-state
  // gate) since a pending escalation is operator-gating: a ghola is blocked
  // waiting on an approve/deny decision.
  if (data.escalations?.length) {
    wrapper.appendChild(renderWarRoomEscalations(data.escalations, data.control));
  }

  // `data.missions` is ALL missions (open + done) as of Phase 5; the mission
  // header / sub-purpose map care only about the currently open one.
  const allMissions = data.missions ?? [];
  const openMissions = allMissions.filter((m) => m.status === 'open');
  const hasRoster = !!(data.roster && data.roster.length);
  if (data.empty || (!allMissions.length && !hasRoster)) {
    wrapper.appendChild(
      textEl('p', 'No active mission. Start a goal in a ghola-mode session.', 'desc'),
    );
    if (data.settings) {
      wrapper.appendChild(renderWarRoomControls(data.settings, data.control));
    }
    return;
  }

  if (openMissions.length) {
    wrapper.appendChild(renderWarRoomMissionHeader(openMissions[0]!, data.control, data.roster ?? []));
    wrapper.appendChild(renderWarRoomSubPurposeMap(openMissions[0]!, data.roster ?? []));
  } else {
    wrapper.appendChild(textEl('p', 'No open mission for this subject.', 'desc'));
  }
  if (hasRoster) {
    wrapper.appendChild(renderWarRoomRoster(data.roster!, data.subject ?? ''));
    wrapper.appendChild(renderWarRoomStable(data.roster!, data.subject ?? ''));
    // File-ownership registry slots between the roster/Stable views and Ledger
    // Health: a read-only "who owns what" list. Rendered only when there are
    // live claims; empty ownership renders nothing.
    if (data.ownership?.length) {
      wrapper.appendChild(renderWarRoomOwnership(data.ownership));
    }
    wrapper.appendChild(renderWarRoomLedgerHealth(data.roster!));
  }
  if (data.counts) {
    wrapper.appendChild(renderWarRoomCounts(data.counts));
  }
  if (data.operatingNotes) {
    wrapper.appendChild(renderWarRoomOperatingNotes(data.operatingNotes));
  }
  if (allMissions.length) {
    wrapper.appendChild(renderWarRoomMissionLibrary(allMissions, data.control));
  }
  if (data.settings) {
    wrapper.appendChild(renderWarRoomControls(data.settings, data.control));
  }
}

/**
 * Prominent banner shown while a "gholaAwakenAll" kill-switch request is
 * pending team stand-down (`control.awakenAll === true`). Purely
 * informational — the actual stand-down is cooperative: the TPM agent polls
 * `control.json` out of band and clears it once the team has stood
 * down, at which point the next `warRoomData` push stops rendering this.
 */
function renderWarRoomAwakenAllBanner(control: NonNullable<WarRoomData['control']>): HTMLElement {
  const banner = el('div', { class: 'warroom-awaken-banner' });
  banner.appendChild(textEl('div', 'Awaken-all requested — awaiting team stand-down', 'warroom-awaken-banner-title'));
  if (control.requestedAt) {
    banner.appendChild(
      textEl('div', `Requested at ${control.requestedAt}`, 'warroom-awaken-banner-meta'),
    );
  }
  return banner;
}

/**
 * Mission header card: goal (prominent), mission id + status + date, the
 * groundedIn reference, and the chronological progress bullets. Reuses
 * `.module-row-body`'s scoped `.module-title` / `.meta` / `.desc` styling
 * inside a `.warroom-card` box so it matches the Modules tab's visual chrome.
 *
 * Also carries the "Declare Done" affordance for the open mission — the
 * normal happy-path convergence action (as opposed to `gholaAwakenAll`'s
 * emergency stand-down). Posts `gholaDeclareDone` on click; when
 * `control?.declareDone` matches this mission's id, a "Declaring done..."
 * pending indicator is shown in place of the button, mirroring the
 * button/pending-indicator swap used by the Mission Library's Resume row.
 */
function renderWarRoomMissionHeader(
  mission: NonNullable<WarRoomData['missions']>[number],
  control: WarRoomData['control'],
  roster: NonNullable<WarRoomData['roster']>,
): HTMLElement {
  const card = el('div', { class: 'warroom-card' });
  const body = el('div', { class: 'module-row-body' });

  const title = el('div', { class: 'module-title' });
  const goalEl = el('strong');
  goalEl.textContent = mission.goal;
  title.appendChild(goalEl);
  body.appendChild(title);

  const meta = el('div', { class: 'meta' });
  meta.textContent = `${mission.id} · ${mission.status} · ${mission.date}`;
  body.appendChild(meta);

  // Status chips near the meta line: the mission's integration state plus a
  // "N/M gholas verified" rollup over the live roster. Both tolerate absent
  // fields (integration absent -> "not run"; no live roster -> no rollup).
  const statusChips = el('div', { class: 'warroom-chip-row warroom-mission-status-chips' });
  statusChips.appendChild(warRoomIntegrationIndicator(mission.integration));
  const rollup = warRoomVerificationRollup(roster);
  if (rollup) {
    statusChips.appendChild(rollup);
  }
  body.appendChild(statusChips);

  if (mission.groundedIn) {
    body.appendChild(textEl('div', `Grounded in: ${mission.groundedIn}`, 'desc'));
  }
  if (mission.budget) {
    body.appendChild(textEl('div', `Budget: ${mission.budget}`, 'desc'));
  }
  card.appendChild(body);

  if (mission.progress && mission.progress.length) {
    const list = el('ul', { class: 'warroom-progress-list' });
    mission.progress.forEach((p) => {
      const li = el('li');
      li.textContent = p;
      list.appendChild(li);
    });
    card.appendChild(list);
  }

  if (control?.declareDone === mission.id) {
    card.appendChild(textEl('div', 'Declaring done...', 'warroom-declare-done-pending'));
  } else {
    const declareDoneBtn = el('button', {
      class: 'warroom-declare-done-button',
      type: 'button',
      'aria-label': `Declare mission ${mission.id} done`,
    }) as HTMLButtonElement;
    declareDoneBtn.textContent = 'Declare Done';
    declareDoneBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'gholaDeclareDone', id: mission.id });
    });
    card.appendChild(declareDoneBtn);
  }

  return card;
}

/**
 * Roster section: one card per ghola, name + purpose + a state badge + model
 * + last_used + a reliability chip. Clicking a card opens the per-ghola
 * detail drill-in (`renderWarRoomGholaDetail`); wake/retire actions remain
 * out of scope for v1.
 */
function renderWarRoomRoster(
  roster: NonNullable<WarRoomData['roster']>,
  subject: string,
): HTMLElement {
  const section = el('div');
  section.appendChild(textEl('h2', 'Roster'));
  const list = el('div', { class: 'modules-list' });
  roster.forEach((g) => list.appendChild(renderWarRoomGholaCard(g, subject)));
  section.appendChild(list);
  return section;
}

function renderWarRoomGholaCard(
  g: NonNullable<WarRoomData['roster']>[number],
  subject: string,
): HTMLElement {
  const card = el('button', {
    class: 'warroom-card warroom-card-clickable',
    type: 'button',
    'aria-label': `View details for ${g.name}`,
  }) as HTMLButtonElement;
  card.addEventListener('click', () => openWarRoomGholaDetail(subject, g.id));

  const body = el('div', { class: 'module-row-body' });

  const title = el('div', { class: 'module-title' });
  const nameEl = el('strong');
  nameEl.textContent = g.name;
  title.appendChild(nameEl);
  const badge = el('span', { class: `warroom-badge warroom-badge--${g.state}` });
  badge.textContent = g.state;
  title.appendChild(badge);
  body.appendChild(title);

  if (g.purpose) {
    body.appendChild(textEl('div', g.purpose, 'desc'));
  }
  const meta = el('div', { class: 'meta' });
  meta.textContent = `Model: ${g.model} · Last used: ${g.last_used}`;
  body.appendChild(meta);

  const chipRow = el('div', { class: 'warroom-chip-row' });
  chipRow.appendChild(warRoomReliabilityChip(g.reliability));
  chipRow.appendChild(warRoomVerificationChip(g.verification));
  body.appendChild(chipRow);

  card.appendChild(body);
  return card;
}

/**
 * "Stable" ledger browser: groups the same roster `renderWarRoomRoster`
 * already renders flat, into Active / Dormant / Archived sections so the
 * user can scan the ledger by state rather than by id order. Read-only,
 * purely a different view over `data.roster` — archived gholas are already
 * present in the roster (see `collectRoster` in host.ts), so no extra data
 * source is needed here.
 */
function renderWarRoomStable(
  roster: NonNullable<WarRoomData['roster']>,
  subject: string,
): HTMLElement {
  const section = el('div', { class: 'warroom-stable' });
  section.appendChild(textEl('h2', 'Stable'));

  const groups: { key: string; label: string }[] = [
    { key: 'active', label: 'Active' },
    { key: 'dormant', label: 'Dormant' },
    { key: 'archived', label: 'Archived' },
  ];

  groups.forEach(({ key, label }) => {
    const rows = roster.filter((g) => g.state === key);
    const group = el('div', { class: 'warroom-stable-group' });
    group.appendChild(textEl('h3', `${label} (${rows.length})`, 'warroom-stable-group-title'));
    if (!rows.length) {
      group.appendChild(textEl('div', 'None.', 'warroom-note'));
    } else {
      const list = el('div', { class: 'warroom-stable-list' });
      rows.forEach((g) => list.appendChild(renderWarRoomStableRow(g, subject)));
      group.appendChild(list);
    }
    section.appendChild(group);
  });

  return section;
}

/** One clickable row in the Stable browser — opens the same per-ghola detail drill-in as the roster cards. */
function renderWarRoomStableRow(
  g: NonNullable<WarRoomData['roster']>[number],
  subject: string,
): HTMLElement {
  const row = el('button', {
    class: 'warroom-stable-row warroom-card-clickable',
    type: 'button',
    'aria-label': `View details for ${g.name}`,
  }) as HTMLButtonElement;
  row.addEventListener('click', () => openWarRoomGholaDetail(subject, g.id));

  const nameLine = el('div', { class: 'warroom-stable-row-name' });
  const nameEl = el('strong');
  nameEl.textContent = g.name;
  nameLine.appendChild(nameEl);
  if (g.purpose) {
    nameLine.appendChild(textEl('span', ` — ${g.purpose}`, 'warroom-stable-purpose'));
  }
  row.appendChild(nameLine);
  const meta = el('div', { class: 'meta' });
  meta.textContent = `Model: ${g.model} · Last used: ${g.last_used}`;
  row.appendChild(meta);
  const chipRow = el('div', { class: 'warroom-chip-row' });
  chipRow.appendChild(warRoomReliabilityChip(g.reliability));
  chipRow.appendChild(warRoomVerificationChip(g.verification));
  row.appendChild(chipRow);
  return row;
}

/**
 * Ledger Health: a read-only staleness display over the same roster the
 * Stable browser renders. STALE = state is active/dormant (not already
 * archived) AND `last_used` parses to a date older than 30 days — mirroring
 * the CLI's `ghola groom --days 30` cutoff (see `cmdGroom` in `ghola.mjs`) so
 * the count here always matches what a `ghola groom` run would archive.
 * Gholas with a missing/unparseable `last_used` are skipped rather than
 * counted as stale. Display only — grooming (soft-archive) itself remains a
 * `ghola groom` CLI action for the TPM or the operator; there is no button
 * here.
 */
function renderWarRoomLedgerHealth(roster: NonNullable<WarRoomData['roster']>): HTMLElement {
  const STALE_DAYS = 30;
  const cutoff = new Date().getTime() - STALE_DAYS * 24 * 60 * 60 * 1000;
  const stale = roster.filter((g) => {
    if (g.state !== 'active' && g.state !== 'dormant') return false;
    const ts = Date.parse(g.last_used || '');
    if (Number.isNaN(ts)) return false;
    return ts < cutoff;
  });

  const card = el('div', { class: 'warroom-card warroom-ledger-health' });
  card.appendChild(textEl('div', 'Ledger Health', 'module-title'));
  card.appendChild(
    textEl(
      'div',
      `Ledger health: ${stale.length} ghola(s) idle 30+ days (candidates for \`ghola groom\`).`,
      'desc',
    ),
  );
  if (stale.length) {
    const list = el('ul', { class: 'warroom-health-list' });
    stale.forEach((g) => {
      const li = el('li');
      li.textContent = `${g.name} — last used ${g.last_used}`;
      list.appendChild(li);
    });
    card.appendChild(list);
  }
  card.appendChild(
    textEl(
      'div',
      'Grooming (soft-archive) is performed by `ghola groom` — run by the TPM or the operator via the CLI. This is a display only.',
      'warroom-note',
    ),
  );
  return card;
}

/**
 * Operating Notes: the resolved subject's self-tuning playbook, written by
 * the CLI's `ghola note` command (see `cmdNote` in `ghola.mjs`) and read
 * verbatim off `<ledgerRoot>/<subject>/operating-notes.md` by the host.
 * Read-only — reuses the per-ghola History panel's raw `pre.prompt`
 * treatment (no markdown rendering). Per the War Mode design, these notes
 * are the lowest-precedence guidance layer and can never override core
 * functionality, hard rules, or mode mechanics.
 */
function renderWarRoomOperatingNotes(notes: string): HTMLElement {
  const card = el('div', { class: 'warroom-card warroom-operating-notes' });
  card.appendChild(textEl('div', 'Operating Notes', 'module-title'));
  card.appendChild(
    textEl(
      'div',
      "The subject's accreted self-tuning notes (lowest-precedence guidance) — read-only.",
      'warroom-note',
    ),
  );
  const pre = el('pre', { class: 'prompt fragment' });
  pre.textContent = notes;
  card.appendChild(pre);
  return card;
}

/**
 * Sub-purpose map: the mission goal as the root, then one bullet per
 * active/dormant ghola's `purpose` — the derivable
 * goal -> sub-purpose -> ghola structure. Read-only; archived gholas are
 * excluded since they no longer serve a live sub-purpose under this mission.
 */
function renderWarRoomSubPurposeMap(
  mission: NonNullable<WarRoomData['missions']>[number],
  roster: NonNullable<WarRoomData['roster']>,
): HTMLElement {
  const card = el('div', { class: 'warroom-card warroom-subpurpose-map' });
  card.appendChild(textEl('div', 'Goal → Sub-purpose Map', 'module-title'));
  card.appendChild(textEl('div', mission.goal || '(no goal recorded)', 'warroom-subpurpose-root'));

  const liveRoster = roster.filter((g) => g.state === 'active' || g.state === 'dormant');
  if (!liveRoster.length) {
    card.appendChild(textEl('div', 'No active or dormant gholas yet.', 'warroom-note'));
    return card;
  }

  const list = el('ul', { class: 'warroom-subpurpose-list' });
  liveRoster.forEach((g) => {
    const li = el('li');
    li.textContent = `${g.name}: ${g.purpose || '(no purpose recorded)'}`;
    list.appendChild(li);
  });
  card.appendChild(list);
  return card;
}

/**
 * Mission library / resume picker: every mission (open + done) with a
 * "Resume" button that posts `gholaResumeMission`. When
 * `data.control.resumeMission` matches a row's id, that row shows a
 * "Resuming <id>..." pending indicator instead of the button — cleared once
 * the TPM agent (out of band) acknowledges and the next `warRoomData` push
 * no longer carries that id.
 */
function renderWarRoomMissionLibrary(
  missions: NonNullable<WarRoomData['missions']>,
  control: WarRoomData['control'],
): HTMLElement {
  const card = el('div', { class: 'warroom-card warroom-mission-library' });
  card.appendChild(textEl('div', 'Mission Library', 'module-title'));

  const pendingId = control?.resumeMission ?? null;
  const list = el('div', { class: 'warroom-mission-library-list' });
  missions.forEach((m) => list.appendChild(renderWarRoomMissionLibraryRow(m, pendingId)));
  card.appendChild(list);
  return card;
}

function renderWarRoomMissionLibraryRow(
  m: NonNullable<WarRoomData['missions']>[number],
  pendingId: string | null,
): HTMLElement {
  const row = el('div', { class: 'warroom-mission-library-row' });

  const body = el('div', { class: 'warroom-mission-library-body' });
  const title = el('div', { class: 'module-title' });
  const idEl = el('strong');
  idEl.textContent = m.id;
  title.appendChild(idEl);
  const badge = el('span', {
    class: `warroom-badge warroom-badge--${m.status === 'open' ? 'active' : 'archived'}`,
  });
  badge.textContent = m.status;
  title.appendChild(badge);
  body.appendChild(title);
  body.appendChild(textEl('div', m.date, 'meta'));
  if (m.goal) {
    body.appendChild(textEl('div', m.goal, 'desc'));
  }
  row.appendChild(body);

  if (pendingId === m.id) {
    row.appendChild(textEl('div', `Resuming ${m.id}...`, 'warroom-mission-resume-pending'));
  } else {
    const btn = el('button', {
      class: 'warroom-mission-resume-button',
      type: 'button',
      'aria-label': `Resume mission ${m.id}`,
    }) as HTMLButtonElement;
    btn.textContent = 'Resume';
    btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'gholaResumeMission', id: m.id });
    });
    row.appendChild(btn);
  }

  return row;
}

/**
 * Alerts card: renders each `{ text, date }` recorded for the subject.
 * Noticeable-but-not-alarming styling (distinct from the red awaken-all
 * banner) — these are informational flags, not an emergency kill-switch.
 */
function renderWarRoomAlerts(alerts: NonNullable<WarRoomData['alerts']>): HTMLElement {
  const card = el('div', { class: 'warroom-alerts-card' });
  card.appendChild(textEl('div', 'Alerts', 'warroom-alerts-title'));
  const list = el('div', { class: 'warroom-alerts-list' });
  alerts.forEach((a) => {
    const row = el('div', { class: 'warroom-alert-row' });
    if (a.date) {
      row.appendChild(textEl('span', a.date, 'warroom-alert-date'));
    }
    row.appendChild(textEl('span', a.text, 'warroom-alert-text'));
    list.appendChild(row);
  });
  card.appendChild(list);
  return card;
}

/**
 * Escalation queue: ghola-raised decisions awaiting operator approval, read
 * from `data.escalations`. Each row shows the escalation id, requesting ghola,
 * decision text, and status. `pending` rows get live Approve/Deny buttons that
 * post `gholaResolveEscalation`; when `control.escalationResolve` already
 * targets that row (the operator submitted a decision the TPM agent has not yet
 * acknowledged), a disabled "pending {approve|deny}" indicator is shown instead
 * (mirroring the Resume / Declare-Done button/pending swap). approved/denied
 * rows show only the final status badge, no buttons. The authoritative state
 * comes from the next `warRoomData` push.
 */
function renderWarRoomEscalations(
  escalations: NonNullable<WarRoomData['escalations']>,
  control: WarRoomData['control'],
): HTMLElement {
  const card = el('div', { class: 'warroom-escalations-card' });
  card.appendChild(textEl('div', 'Escalation Queue', 'warroom-escalations-title'));
  card.appendChild(
    textEl(
      'div',
      'Ghola-raised decisions awaiting operator approval. Approve or deny writes a cooperative request the TPM agent picks up out of band.',
      'warroom-note',
    ),
  );
  const list = el('div', { class: 'warroom-escalations-list' });
  escalations.forEach((e) => list.appendChild(renderWarRoomEscalationRow(e, control)));
  card.appendChild(list);
  return card;
}

function renderWarRoomEscalationRow(
  entry: NonNullable<WarRoomData['escalations']>[number],
  control: WarRoomData['control'],
): HTMLElement {
  const row = el('div', { class: 'warroom-escalation-row' });

  const body = el('div', { class: 'warroom-escalation-body' });
  const title = el('div', { class: 'module-title' });
  const idEl = el('strong');
  idEl.textContent = entry.id;
  title.appendChild(idEl);
  const statusBadge = el('span', {
    class: `warroom-badge warroom-escalation-status--${entry.status}`,
  });
  statusBadge.textContent = entry.status;
  title.appendChild(statusBadge);
  body.appendChild(title);

  const meta = el('div', { class: 'meta' });
  meta.textContent = entry.at ? `${entry.ghola} · ${entry.at}` : entry.ghola;
  body.appendChild(meta);

  if (entry.text) {
    body.appendChild(textEl('div', entry.text, 'desc'));
  }
  row.appendChild(body);

  // The subject this War Room payload describes; the escalation-resolution
  // message now carries it so the TPM agent can route each queued decision back
  // to the right ledger subject.
  const activeSubject = state.warRoomData?.subject;

  // A resolution the operator already submitted for THIS entry, still awaiting
  // the TPM agent's ack: show a disabled pending indicator instead of live
  // buttons. Because escalationResolve is now a QUEUE, find THIS row's entry by
  // id (and, when subjects are available on both sides, by subject) rather than
  // comparing a single object. Multiple rows can therefore be pending-ack at
  // once, each keyed off its own id, with no cross-row disabling.
  const pendingResolve =
    control?.escalationResolve?.find(
      (r) =>
        r.id === entry.id &&
        (!activeSubject || !r.subject || r.subject === activeSubject),
    ) ?? null;

  if (entry.status === 'pending') {
    if (pendingResolve) {
      row.appendChild(
        textEl('div', `pending ${pendingResolve.decision}...`, 'warroom-escalation-pending'),
      );
    } else {
      const actions = el('div', { class: 'warroom-escalation-actions' });

      const approve = el('button', {
        class: 'warroom-escalation-button warroom-escalation-approve',
        type: 'button',
        'aria-label': `Approve escalation ${entry.id}`,
      }) as HTMLButtonElement;
      approve.textContent = 'Approve';
      approve.addEventListener('click', () => {
        vscode.postMessage({
          type: 'gholaResolveEscalation',
          id: entry.id,
          subject: activeSubject ?? '',
          decision: 'approve',
        });
      });

      const deny = el('button', {
        class: 'warroom-escalation-button warroom-escalation-deny',
        type: 'button',
        'aria-label': `Deny escalation ${entry.id}`,
      }) as HTMLButtonElement;
      deny.textContent = 'Deny';
      deny.addEventListener('click', () => {
        vscode.postMessage({
          type: 'gholaResolveEscalation',
          id: entry.id,
          subject: activeSubject ?? '',
          decision: 'deny',
        });
      });

      actions.appendChild(approve);
      actions.appendChild(deny);
      row.appendChild(actions);
    }
  }

  return row;
}

/**
 * File-ownership registry: a read-only list of the live `path -> ghola` claims
 * recorded in the subject's `ownership.md`, with the claimed-at timestamp.
 * Read from `data.ownership`; the caller only mounts this when there is at
 * least one claim, so no empty-state branch is needed here.
 */
function renderWarRoomOwnership(
  ownership: NonNullable<WarRoomData['ownership']>,
): HTMLElement {
  const section = el('div', { class: 'warroom-ownership' });
  section.appendChild(textEl('h2', 'File Ownership'));
  section.appendChild(
    textEl(
      'div',
      'Live file-ownership registry (read-only): which ghola currently claims each path.',
      'warroom-note',
    ),
  );
  const list = el('div', { class: 'warroom-ownership-list' });
  ownership.forEach((o) => {
    const ownRow = el('div', { class: 'warroom-ownership-row' });
    ownRow.appendChild(textEl('span', o.path, 'warroom-ownership-path'));
    ownRow.appendChild(textEl('span', '->', 'warroom-ownership-arrow'));
    ownRow.appendChild(textEl('span', o.ghola, 'warroom-ownership-ghola'));
    if (o.at) {
      ownRow.appendChild(textEl('span', o.at, 'warroom-ownership-at'));
    }
    list.appendChild(ownRow);
  });
  section.appendChild(list);
  return section;
}

/** Small ledger-state summary line: active / dormant / archived / total tallies. */
function renderWarRoomCounts(counts: NonNullable<WarRoomData['counts']>): HTMLElement {
  const p = el('div', { class: 'warroom-counts' });
  p.textContent = `Active ${counts.active} · Dormant ${counts.dormant} · Archived ${counts.archived} · Total ${counts.total}`;
  return p;
}

/**
 * Read-only control-indicator row mirroring the resolved mode.war
 * sub-toggles, plus a static "Hard-rules floor: enforced" chip. These are
 * status chips only — not editable here; the note below points to where
 * they're actually configured. Also hosts the Awaken All control and the
 * god-console directive input, both of which write cooperative requests into
 * `control.json` for the TPM agent to pick up out of band.
 */
function renderWarRoomControls(
  settings: NonNullable<WarRoomData['settings']>,
  control: WarRoomData['control'],
): HTMLElement {
  const card = el('div', { class: 'warroom-card' });
  card.appendChild(textEl('div', 'Controls', 'module-title'));

  const chips = el('div', { class: 'warroom-chip-row' });
  chips.appendChild(warRoomChip('Auto-open War Room', settings.autoOpenWarRoom));
  chips.appendChild(warRoomChip('Tournament', settings.tournament));
  chips.appendChild(
    warRoomChip(
      `Max concurrent gholas: ${settings.maxConcurrentGholas === 0 ? 'unbounded' : settings.maxConcurrentGholas}`,
    ),
  );
  chips.appendChild(warRoomChip('Dry run', settings.dryRun));
  chips.appendChild(warRoomChip('Auto-verify', settings.autoVerify));
  chips.appendChild(warRoomChip('Hard-rules floor: enforced', true));
  card.appendChild(chips);

  card.appendChild(
    textEl(
      'div',
      'These are configured in the mode.war module settings (Modules tab), not here.',
      'warroom-note',
    ),
  );

  card.appendChild(el('hr', { class: 'section-divider' }));
  card.appendChild(renderWarRoomGodConsole(control));

  card.appendChild(el('hr', { class: 'section-divider' }));
  card.appendChild(renderWarRoomAwakenAllControl());

  return card;
}

/**
 * God-console: a free-text instruction input + Send button that posts
 * `gholaDirective` to the host. Clearly an "instruction to the running
 * mission" affordance rather than a kill-switch, so it uses the neutral
 * button styling (not the Awaken All danger-red treatment). When a directive
 * is already pending (`control.directive` set, not yet acknowledged), shows
 * it above the input with a note that the TPM agent polls + acknowledges it
 * cooperatively — mirroring the Awaken-All / Resume request pattern.
 */
function renderWarRoomGodConsole(control: WarRoomData['control']): HTMLElement {
  const wrap = el('div', { class: 'warroom-god-console' });
  wrap.appendChild(textEl('div', 'Send Instruction', 'warroom-god-console-title'));

  if (control?.directive) {
    const pending = el('div', { class: 'warroom-god-console-pending' });
    pending.appendChild(textEl('div', `Pending: "${control.directive}"`, 'warroom-god-console-pending-text'));
    if (control.directiveRequestedAt) {
      pending.appendChild(
        textEl('div', `Requested at ${control.directiveRequestedAt}`, 'warroom-god-console-pending-meta'),
      );
    }
    wrap.appendChild(pending);
  }

  const row = el('div', { class: 'warroom-god-console-row' });
  const input = el('input', {
    class: 'warroom-god-console-input',
    type: 'text',
    placeholder: 'Instruction for the running mission…',
    'aria-label': 'God-console instruction for the running mission',
  }) as HTMLInputElement;
  input.value = state.warRoomDirectiveDraft;
  input.addEventListener('input', () => {
    state.warRoomDirectiveDraft = input.value;
  });
  row.appendChild(input);

  const sendBtn = el('button', {
    class: 'warroom-god-console-send',
    type: 'button',
    'aria-label': 'Send instruction to the running mission',
  }) as HTMLButtonElement;
  sendBtn.textContent = 'Send';
  const submit = () => {
    const text = input.value.trim();
    if (!text) return;
    vscode.postMessage({ type: 'gholaDirective', text });
    state.warRoomDirectiveDraft = '';
    render();
  };
  sendBtn.addEventListener('click', submit);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') submit();
  });
  row.appendChild(sendBtn);
  wrap.appendChild(row);

  wrap.appendChild(
    textEl(
      'div',
      'Cooperative: the TPM agent polls for this instruction and acknowledges it, it does not interrupt anything directly.',
      'warroom-god-console-caption',
    ),
  );

  return wrap;
}

/**
 * Emergency "Awaken All" affordance: a danger-styled button that requests a
 * cooperative team stand-down, plus a one-line caption explaining what it
 * does and does not do (it is a request, not a kill — the TPM agent polls
 * `control.json` and stands the team down on its own schedule).
 */
function renderWarRoomAwakenAllControl(): HTMLElement {
  const wrap = el('div', { class: 'warroom-awaken-control' });

  const btn = el('button', {
    class: 'warroom-awaken-button',
    type: 'button',
    'aria-label': 'Awaken All — request emergency team stand-down',
  }) as HTMLButtonElement;
  btn.textContent = 'Awaken All';
  btn.addEventListener('click', () => {
    vscode.postMessage({ type: 'gholaAwakenAll' });
  });
  wrap.appendChild(btn);

  wrap.appendChild(
    textEl(
      'div',
      'Requests an emergency team stand-down — cooperative: the TPM agent polls for this and stands the team down, it does not forcibly stop anything.',
      'warroom-awaken-caption',
    ),
  );

  return wrap;
}

/**
 * One read-only status chip. `on` colors the chip to indicate an active/true
 * state; omitted (or false) renders a neutral chip — used for the
 * maxConcurrentGholas value, which has no boolean on/off meaning.
 */
function warRoomChip(label: string, on?: boolean): HTMLElement {
  const chip = el('span', { class: on ? 'warroom-chip warroom-chip--on' : 'warroom-chip' });
  chip.textContent = label;
  return chip;
}

/**
 * Track-record chip rendering a ghola's `pass:N rework:M` reliability
 * string verbatim. Falls back to the same default the host uses when the
 * field is absent, so a pre-Phase-6 ledger entry still shows a chip.
 */
function warRoomReliabilityChip(reliability: string | undefined): HTMLElement {
  const chip = el('span', { class: 'warroom-chip warroom-reliability-chip' });
  chip.textContent = reliability ?? 'pass:0 rework:0';
  return chip;
}

/**
 * Per-ghola verification chip. `passed` -> green "verified", `failed` -> red
 * "failed", `pending`/absent -> muted "pending", and any other non-empty value
 * -> red (treated as an unverified/unknown state). Absence is tolerated (the
 * CLI omits the field on older ghola files) and reads as "pending".
 */
function warRoomVerificationChip(verification: string | undefined): HTMLElement {
  const v = (verification || '').toLowerCase();
  let modifier: string;
  let label: string;
  if (v === 'passed') {
    modifier = 'passed';
    label = 'verified';
  } else if (v === 'failed') {
    modifier = 'failed';
    label = 'failed';
  } else if (v === 'pending' || v === '') {
    modifier = 'pending';
    label = 'pending';
  } else {
    modifier = 'failed';
    label = v;
  }
  const chip = el('span', {
    class: `warroom-chip warroom-verify-chip warroom-verify-chip--${modifier}`,
  });
  chip.textContent = `verification: ${label}`;
  return chip;
}

/**
 * Mission-level integration status indicator. `passed` -> green, `failed` ->
 * red, `pending` -> muted, absent -> muted "not run" (older ledgers that never
 * wrote the `- integration:` line). Rendered on the mission header near the
 * meta line.
 */
function warRoomIntegrationIndicator(integration: string | undefined): HTMLElement {
  const v = (integration || '').toLowerCase();
  let modifier: string;
  let label: string;
  if (v === 'passed') {
    modifier = 'passed';
    label = 'passed';
  } else if (v === 'failed') {
    modifier = 'failed';
    label = 'failed';
  } else if (v === 'pending') {
    modifier = 'pending';
    label = 'pending';
  } else {
    modifier = 'absent';
    label = 'not run';
  }
  const chip = el('span', {
    class: `warroom-chip warroom-integration-chip warroom-integration-chip--${modifier}`,
  });
  chip.textContent = `Integration: ${label}`;
  return chip;
}

/**
 * "N/M gholas verified" rollup chip over the live (active/dormant) roster;
 * archived gholas are excluded since they no longer serve the open mission.
 * Returns null when there is no live roster to count. Turns green only when
 * every live ghola is verified.
 */
function warRoomVerificationRollup(
  roster: NonNullable<WarRoomData['roster']>,
): HTMLElement | null {
  const live = roster.filter((g) => g.state === 'active' || g.state === 'dormant');
  if (!live.length) {
    return null;
  }
  const verified = live.filter((g) => (g.verification || '').toLowerCase() === 'passed').length;
  const chip = el('span', { class: 'warroom-chip warroom-verify-rollup' });
  chip.textContent = `${verified}/${live.length} gholas verified`;
  if (verified === live.length) {
    chip.classList.add('warroom-verify-chip--passed');
  }
  return chip;
}

/** Cache-key helper for the per-ghola detail store (`state.gholaDetails`). */
function gholaDetailCacheKey(subject: string, id: string): string {
  return `${subject}::${id}`;
}

/**
 * Open the per-ghola drill-in view for `id` under `subject`. Requests a fresh
 * `gholaDetail` payload only when nothing is cached yet for this key — a
 * cached (possibly stale) payload renders immediately while any live watcher
 * push refreshes it in place. Mirrors `openModuleDetail`'s request-once-then-
 * cache pattern.
 */
function openWarRoomGholaDetail(subject: string, id: string): void {
  state.warRoomGhola = { subject, id };
  if (!state.gholaDetails[gholaDetailCacheKey(subject, id)]) {
    vscode.postMessage({ type: 'requestGholaDetail', subject, ghola: id });
  }
  render();
}

/** Return from the per-ghola drill-in to the main War Room view. */
function backFromWarRoomGholaDetail(): void {
  state.warRoomGhola = null;
  render();
}

/**
 * Per-ghola detail drill-in: header (back button + name + state badge),
 * purpose, model/created/last-used, the lineage line (generation + parent
 * chain), the reliability chip, missions served, and the raw `## History`
 * markdown body. Mirrors `renderModuleDetailView`'s header/back-button
 * chrome so navigation feels consistent across tabs.
 */
function renderWarRoomGholaDetail(
  wrapper: HTMLElement,
  view: { subject: string; id: string },
): void {
  const container = el('div', { class: 'module-detail warroom-ghola-detail' });

  const header = el('div', { class: 'detail-header' });
  const back = el('button', {
    class: 'icon-button',
    type: 'button',
    'aria-label': 'Back to War Room',
    title: 'Back',
  }) as HTMLButtonElement;
  back.innerHTML = ARROW_LEFT_SVG;
  back.addEventListener('click', backFromWarRoomGholaDetail);
  header.appendChild(back);

  const detail = state.gholaDetails[gholaDetailCacheKey(view.subject, view.id)];

  const headTitle = el('div', { class: 'detail-title' });
  const headName = el('strong');
  headName.textContent = detail?.name || view.id;
  headTitle.appendChild(headName);
  if (detail?.state) {
    const badge = el('span', { class: `warroom-badge warroom-badge--${detail.state}` });
    badge.textContent = detail.state;
    headTitle.appendChild(badge);
  }
  header.appendChild(headTitle);
  container.appendChild(header);

  if (!detail) {
    container.appendChild(textEl('div', 'Loading…', 'empty'));
    wrapper.appendChild(container);
    return;
  }

  if (!detail.found) {
    container.appendChild(
      textEl(
        'div',
        `No ledger file found for '${view.id}' in subject '${view.subject}'.`,
        'empty',
      ),
    );
    wrapper.appendChild(container);
    return;
  }

  if (detail.purpose) {
    container.appendChild(textEl('div', detail.purpose, 'desc'));
  }

  const dl = el('dl', { class: 'details-list' });
  appendDef(dl, 'Model', detail.model || '(unknown)');
  appendDef(dl, 'Created', detail.created || '(unknown)');
  appendDef(dl, 'Last used', detail.last_used || '(unknown)');
  container.appendChild(dl);

  // Lineage: generation + parent chain. Only one hop of parent is available
  // per detail payload (the parent's own parent would require a second
  // request); a single "Parent: <slug>" line is sufficient for v1.
  const lineage = el('div', { class: 'warroom-lineage' });
  lineage.appendChild(textEl('span', `Generation ${detail.generation}`, 'warroom-lineage-gen'));
  lineage.appendChild(
    textEl(
      'span',
      detail.parent ? `Parent: ${detail.parent}` : 'Parent: origin',
      'warroom-lineage-parent',
    ),
  );
  container.appendChild(lineage);

  // Track record + verification state.
  const chips = el('div', { class: 'warroom-chip-row' });
  chips.appendChild(warRoomReliabilityChip(detail.reliability));
  chips.appendChild(warRoomVerificationChip(detail.verification));
  container.appendChild(chips);

  // Missions served.
  container.appendChild(textEl('div', 'Missions served', 'details-header'));
  if (detail.missions.length) {
    const list = el('ul', { class: 'warroom-progress-list' });
    detail.missions.forEach((m) => {
      const li = el('li');
      li.textContent = m;
      list.appendChild(li);
    });
    container.appendChild(list);
  } else {
    container.appendChild(textEl('div', 'None recorded.', 'warroom-note'));
  }

  // History.
  container.appendChild(textEl('div', 'History', 'details-header'));
  if (detail.history) {
    const pre = el('pre', { class: 'prompt fragment' });
    pre.textContent = detail.history;
    container.appendChild(pre);
  } else {
    container.appendChild(textEl('div', 'No history recorded.', 'warroom-note'));
  }

  wrapper.appendChild(container);
}

/**
 * Render a single settings field bound to `state.settingsValues[key]`.
 *
 * `onCommit` is an OPTIONAL scoped hook: when supplied, it fires the moment a
 * change is committed (toggle flip, select change, or number blur/enter) so the
 * caller can persist immediately. Existing callers omit it and keep the
 * batched Save-button flow unchanged; only the Ghola block opts into
 * auto-save. Number fields deliberately commit on `change` (blur/Enter), not on
 * every keystroke, so intermediate typing does not spam saves.
 */
function renderField(
  key: string,
  field: SettingsField,
  onCommit?: () => void,
  disabled?: boolean,
  valueOverride?: unknown,
): HTMLElement {
  const wrap = el('div', { class: 'field' });
  const label = el('label');
  label.textContent = field.label;
  wrap.appendChild(label);
  if (field.description) {
    wrap.appendChild(textEl('div', field.description, 'desc'));
  }
  // valueOverride (optional) lets a caller display a coerced value without
  // mutating the store. Used by the Ghola block to force sub-toggles to read
  // false while the master switch is off, even for stale-true legacy data.
  const value =
    valueOverride !== undefined ? valueOverride : state.settingsValues[key] ?? field.default;

  if (field.type === 'boolean') {
    wrap.appendChild(
      renderToggle({
        checked: !!value,
        onChange: (next) => {
          state.settingsValues[key] = next;
          state.dirty = true;
          onCommit?.();
          render();
        },
        ariaLabel: field.label,
        disabled,
      }),
    );
  } else if (field.type === 'enum') {
    const select = el('select') as HTMLSelectElement;
    if (disabled) select.disabled = true;
    (field.options ?? []).forEach((opt) => {
      const o = el('option') as HTMLOptionElement;
      o.value = opt;
      o.textContent = opt;
      if (opt === value) o.selected = true;
      select.appendChild(o);
    });
    select.addEventListener('change', () => {
      state.settingsValues[key] = select.value;
      state.dirty = true;
      onCommit?.();
      render();
    });
    wrap.appendChild(select);
  } else if (field.type === 'number') {
    const inp = el('input') as HTMLInputElement;
    inp.type = 'number';
    if (disabled) inp.disabled = true;
    if (value !== undefined) inp.value = String(value);
    inp.addEventListener('input', () => {
      state.settingsValues[key] = inp.value === '' ? undefined : Number(inp.value);
      state.dirty = true;
    });
    if (onCommit) {
      inp.addEventListener('change', () => onCommit());
    }
    wrap.appendChild(inp);
  } else {
    const inp = el('input') as HTMLInputElement;
    inp.type = 'text';
    if (disabled) inp.disabled = true;
    if (value !== undefined && value !== null) inp.value = String(value);
    inp.addEventListener('input', () => {
      state.settingsValues[key] = inp.value;
      state.dirty = true;
    });
    if (onCommit) {
      inp.addEventListener('change', () => onCommit());
    }
    wrap.appendChild(inp);
  }
  return wrap;
}

function scopedKey(moduleId: string, fieldKey: string): string {
  return `${moduleId}::${fieldKey}`;
}

function el(tag: string, attrs?: Record<string, string>): HTMLElement {
  const e = document.createElement(tag);
  if (attrs) Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
  return e;
}

function textEl(tag: string, text: string, className?: string): HTMLElement {
  const e = el(tag, className ? { class: className } : undefined);
  e.textContent = text;
  return e;
}

/**
 * Build a read-only prompt box (`pre.prompt`) wrapped in a `.prompt-wrap` whose
 * top-right corner reveals a copy button on hover. Shared by the Agents tabs'
 * Instructions panel and the Session tab Instruction panel so every prompt box
 * exposes copy through the identical hover affordance. `extraClass` is appended
 * to the inner `pre` (e.g. `fragment`); `ariaLabel` titles the copy button.
 */
function makeCopyablePrompt(
  text: string,
  ariaLabel: string,
  extraClass?: string,
): HTMLElement {
  const wrap = el('div', { class: 'prompt-wrap' });

  const pre = el('pre', { class: extraClass ? `prompt ${extraClass}` : 'prompt' });
  pre.textContent = text;
  wrap.appendChild(pre);

  const copyBtn = el('button', {
    class: 'prompt-copy icon-button',
    type: 'button',
    'aria-label': ariaLabel,
    title: ariaLabel,
  }) as HTMLButtonElement;
  copyBtn.innerHTML = COPY_ICON_SVG;
  copyBtn.addEventListener('click', () => {
    void navigator.clipboard.writeText(text);
    const prev = copyBtn.title;
    copyBtn.title = 'Copied';
    window.setTimeout(() => {
      copyBtn.title = prev;
    }, 1200);
  });
  wrap.appendChild(copyBtn);

  return wrap;
}

init();
