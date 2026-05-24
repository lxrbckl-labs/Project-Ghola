// Webview-side entry. Compiled to dist/webview.js as a browser IIFE.
// Plain TS + DOM only — no framework, no markdown lib (renders prompts as <pre>).

import type {
  CliAlias,
  HostToWebviewMessage,
  ModuleSummary,
  NamedConfiguration,
  PromptFragmentDetail,
  SettingKeywordEntry,
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

interface AtlassianTokenStatusMessage {
  type: 'atlassianTokenStatus';
  jiraSet: boolean;
  bitbucketSet: boolean;
}

interface AtlassianValidationProductStatus {
  status: 'ok' | 'failed' | 'skipped';
  message?: string;
  displayName?: string;
}

interface AtlassianValidationResult {
  jira: AtlassianValidationProductStatus;
  bitbucket: AtlassianValidationProductStatus;
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
  | 'agents:tpm'
  | 'agents:swe'
  | 'agents:qa'
  | 'sessions';

/**
 * Modules-tab navigation state. The tab is either showing the list of all
 * modules or a single module's detail page. Detail pages render inline prompt
 * content fetched from the host; switching tabs or pressing Back resets to
 * 'list' and clears any cached detail payloads.
 */
type ModuleView = { mode: 'list' } | { mode: 'detail'; moduleId: string };

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
  /** Per-module detail payloads keyed by moduleId. Populated by 'moduleDetail' messages. */
  moduleDetails: Record<string, PromptFragmentDetail[]>;
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
  /** Value of nomeda.cliCommand VS Code configuration. */
  cliCommand: string;
  /** Value of nomeda.sessionCommand VS Code configuration. */
  sessionCommand: string;
  /** Current SWE agent counts and model preferences pulled from `nomeda.swe.*` VS Code configuration. */
  sweConfig: {
    performanceCores: number;
    efficiencyCores: number;
    performanceCoresModel: string;
    efficiencyCoresModel: string;
  };
  /** Current QA agent count and model preference pulled from `nomeda.qa.*` VS Code configuration. */
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
  /** Registered Claude CLI aliases (mirrors `nomeda.cliAliases`). */
  aliases: CliAlias[];
  /**
   * Currently-selected alias from the launch dropdown (mirrors
   * `nomeda.selectedAlias`). Empty string falls back to the legacy
   * `cliCommand` text input.
   */
  selectedAlias: string;
  /** Shell rc file the aliases are persisted into (mirrors `nomeda.aliasFile`). */
  aliasFile: string;
  /**
   * Whether the Jira API token is currently stored in SecretStorage.
   * Set by 'atlassianTokenStatus' messages from the host; never contains the
   * actual token value.
   */
  atlassianJiraTokenSet: boolean;
  /**
   * Whether the Bitbucket API token is currently stored in SecretStorage.
   * Set by 'atlassianTokenStatus' messages from the host; never contains the
   * actual token value.
   */
  atlassianBitbucketTokenSet: boolean;
  /** Whether the Jira Clear token button is in its two-step confirm state. */
  atlassianJiraTokenConfirming: boolean;
  /** Whether the Bitbucket Clear token button is in its two-step confirm state. */
  atlassianBitbucketTokenConfirming: boolean;
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
  /** Feedback entries last received from the host via 'feedbackLoaded'. */
  feedbackEntries: FeedbackEntry[];
  /**
   * Set of entry ids whose "No" button is in the two-step confirm state.
   * When an id is in this set the button renders as "Confirm?" and the next
   * click posts the delete message. A timeout clears the state automatically.
   */
  feedbackPendingNoConfirm: Set<string>;
}

const state: UIState = {
  activeSection: 'general',
  modules: [],
  settingsValues: {},
  dirty: false,
  composedPrompts: {},
  moduleView: { mode: 'list' },
  moduleDetails: {},
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
  atlassianBitbucketTokenSet: false,
  atlassianJiraTokenConfirming: false,
  atlassianBitbucketTokenConfirming: false,
  atlassianValidation: null,
  atlassianValidating: false,
  feedbackEntries: [],
  feedbackPendingNoConfirm: new Set(),
};

const root = document.getElementById('app')!;

// Inline 16x16 monochrome SVG icons — fill="currentColor" so they pick up the
// surrounding text color (VS Code foreground / button foreground). Path data
// taken from Codicons (refresh, chevron-right, arrow-left) and trimmed.
const REFRESH_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.681 3H2V2h3.5l.5.5V6H5V4a5 5 0 1 0 4.53-.761l.302-.954A6 6 0 1 1 4.681 3z"/></svg>`;

const CHEVRON_RIGHT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M5.7 13.7l-.7-.7L9.6 8.4 5 3.8l.7-.7L11.1 8.4l-5.4 5.3z"/></svg>`;

const ARROW_LEFT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.5 7.5h-9.79l3.65-3.65-.71-.7L1.5 8l5.15 5.15.71-.7-3.65-3.65H13.5v-1.3z"/></svg>`;

const PLAY_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6,4 6,20 20,12"/></svg>`;

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
  // Escape pops the detail view back to the list (Modules tab only).
  // Guard against firing when the user is typing in an input field, where
  // Escape is a common "clear/cancel" gesture that should not navigate away.
  window.addEventListener('keydown', (ev) => {
    if (
      ev.key === 'Escape' &&
      state.activeSection === 'modules' &&
      state.moduleView.mode === 'detail' &&
      !(ev.target instanceof HTMLInputElement) &&
      !(ev.target instanceof HTMLSelectElement) &&
      !(ev.target instanceof HTMLTextAreaElement)
    ) {
      backToModuleList();
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
        console.error('[nomeda] alias save failed', msg.error);
      }
      break;
    case 'settingsSaved':
      if (msg.ok) {
        state.dirty = false;
        render();
      } else {
        // Best-effort surface; real toast UX is future work.
        console.error('[nomeda] save failed', msg.error);
      }
      break;
    case 'composedPromptUpdated':
      state.composedPrompts[msg.agent] = msg.prompt;
      render();
      break;
    case 'moduleDetail':
      // Cache the payload regardless. Only re-render if it's still the viewed module.
      state.moduleDetails[msg.moduleId] = msg.fragments;
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
  state.atlassianBitbucketTokenSet = msg.bitbucketSet;
  // Reset confirming state when tokens flip — the button context changes.
  state.atlassianJiraTokenConfirming = false;
  state.atlassianBitbucketTokenConfirming = false;
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
    // Re-render only the validation block in place to preserve scroll position.
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

function setSection(id: SectionId): void {
  // Reset Modules-tab ephemeral UI state when leaving the Modules tab.
  if (state.activeSection === 'modules' && id !== 'modules') {
    state.moduleSearch = '';
    state.moduleView = { mode: 'list' };
    state.moduleDetails = {};
    state.settingKeywords = {};
    state.settingKeywordErrors = {};
    // Discard any in-flight keyValue drafts — they only make sense while the
    // user is on a module detail page actively editing rows.
    state.keyValueDrafts = {};
  }
  // Clear inline configuration name editor and manage panel on any tab leave —
  // both are tab-scoped ephemeral UI states.
  if (state.activeSection !== id) {
    state.configNameEditMode = false;
    state.configManageOpen = false;
  }
  state.activeSection = id;
  if (id.startsWith('agents:')) {
    const agentId = id.split(':')[1]!;
    if (!(agentId in state.composedPrompts)) {
      vscode.postMessage({ type: 'getComposedPrompt', agent: agentId });
    }
  }
  render();
}

function render(): void {
  root.innerHTML = '';
  root.appendChild(renderRail());
  root.appendChild(renderContent());
}

function renderRail(): HTMLElement {
  const rail = el('aside', { class: 'rail' });
  rail.appendChild(railHeader('General'));
  rail.appendChild(railItem('general', 'Session'));
  rail.appendChild(railItem('modules', 'Modules'));
  rail.appendChild(railHeader('Agents'));
  rail.appendChild(railItem('agents:tpm', 'TPM', true));
  rail.appendChild(railItem('agents:swe', 'SWE', true));
  rail.appendChild(railItem('agents:qa', 'QA', true));
  return rail;
}

function railHeader(text: string): HTMLElement {
  const e = el('div', { class: 'rail-section' });
  e.textContent = text;
  return e;
}

function railItem(id: SectionId, label: string, sub = false): HTMLElement {
  const cls = `rail-item${sub ? ' sub' : ''}${state.activeSection === id ? ' active' : ''}`;
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
    case 'agents:tpm':
    case 'agents:swe':
    case 'agents:qa':
      renderAgent(wrapper, state.activeSection.split(':')[1]!);
      break;
    case 'sessions':
      renderSessions(wrapper);
      break;
  }
  return wrapper;
}

function renderGeneral(wrapper: HTMLElement): void {
  wrapper.appendChild(textEl('h1', 'Session'));
  wrapper.appendChild(textEl('p', 'Configure the command that launches your Nomeda agent team, then start a session.', 'subtitle'));

  // Horizontal divider between the header and the settings content.
  wrapper.appendChild(el('hr', { class: 'section-divider' }));

  // Three-column launch row: [CLI Command] [Initiation Command] [Configuration] [▶]
  // Each column is a label-above-input field; the play button sits at the far right.
  const launchRow = el('div', { class: 'session-launch-row' });

  // Column 1 — CLI Alias picker. Replaces the legacy free-text `cliCommand`
  // input (now relocated below as "Fallback CLI" inside the alias editor).
  // Selecting an alias names the shell-registered Claude CLI invocation the
  // launcher should use; the empty option falls back to the legacy command.
  const aliasField = el('div', { class: 'session-launch-field' });
  const aliasLabel = el('label', { class: 'setting-label session-command-label' });
  aliasLabel.textContent = 'CLI Alias';
  aliasField.appendChild(aliasLabel);
  aliasField.appendChild(renderAliasPickerDropdown());
  launchRow.appendChild(aliasField);

  // Column 2 — Initiation Command
  const sessionField = el('div', { class: 'session-launch-field' });
  const sessionLabel = el('label', { class: 'setting-label session-command-label' });
  sessionLabel.textContent = 'Initiation Command';
  sessionField.appendChild(sessionLabel);
  const sessionInp = el('input', { class: 'setting-input session-command-input' }) as HTMLInputElement;
  sessionInp.type = 'text';
  sessionInp.value = state.sessionCommand;
  sessionInp.addEventListener('blur', () => {
    state.sessionCommand = sessionInp.value;
    vscode.postMessage({
      type: 'updateConfiguration',
      section: 'nomeda',
      key: 'sessionCommand',
      value: sessionInp.value,
    });
  });
  sessionField.appendChild(sessionInp);
  launchRow.appendChild(sessionField);

  // Column 3 — Configuration dropdown
  const configField = el('div', { class: 'session-launch-field session-launch-field--config' });
  const configLabel = el('label', { class: 'setting-label session-command-label' });
  configLabel.textContent = 'Configuration';
  configField.appendChild(configLabel);
  configField.appendChild(renderConfigDropdown());
  launchRow.appendChild(configField);

  // Play button — far right of the row, aligned to the bottom of the columns.
  const sessionBtn = el('button', {
    class: 'icon-button framed',
    type: 'button',
    'aria-label': 'Open Nomeda session',
    title: 'Open a new Nomeda session',
  }) as HTMLButtonElement;
  sessionBtn.innerHTML = PLAY_ICON_SVG;
  sessionBtn.addEventListener('click', () => vscode.postMessage({ type: 'openSession' }));
  // Alias registry editor — lives above the launch row so the user defines
  // aliases first, then picks one from the dropdown to launch.
  wrapper.appendChild(renderAliasEditor());
  wrapper.appendChild(el('hr', { class: 'section-divider' }));

  launchRow.appendChild(sessionBtn);
  wrapper.appendChild(launchRow);

  // Custom settings sections placed in 'general' from any module.
  const customSections = state.modules
    .filter((m) => m.enabled)
    .flatMap((m) =>
      (m.contributes?.settingsPanelSections ?? [])
        .filter((s) => s.placement === 'general')
        .map((s) => ({ module: m, section: s })),
    );

  customSections.forEach(({ module, section }) => {
    wrapper.appendChild(textEl('h2', `${section.title} (${module.name})`));
    const fields = (module.contributes?.settings ?? {}) as Record<string, SettingsField>;
    Object.entries(fields).forEach(([key, field]) => {
      wrapper.appendChild(renderField(scopedKey(module.id, key), field));
    });
  });

  if (customSections.length > 0) {
    wrapper.appendChild(renderActions());
  }
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
    if (!q) return true;
    // Base haystack: id, name, description.
    const hay = [m.id, m.name, m.description ?? ''].join(' ').toLowerCase();
    if (hay.includes(q)) return true;
    // Badge match: check if the query is a substring of any badge label (e.g. "tp" → "tpm").
    const badgeLabels = resolveAgentBadgeLabels(m.targets ?? []);
    return badgeLabels.some((label) => label.includes(q));
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
function renderModuleRow(m: ModuleSummary): HTMLElement {
  const row = el('div', { class: 'module-row' });

  // Toggle zone — clicks here must not bubble up to the navigate handler.
  const toggleZone = el('div', { class: 'module-row-toggle' });
  toggleZone.addEventListener('click', (ev) => ev.stopPropagation());
  toggleZone.appendChild(
    renderToggle({
      checked: m.enabled,
      onChange: (next) => {
        vscode.postMessage({ type: 'toggleModule', id: m.id, enabled: next });
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
  // Agent badges below description — shows which agents this module targets.
  const rowBadges = renderAgentBadges(m.targets ?? []);
  if (rowBadges) {
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
      section: 'nomeda',
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
  const actionHead = el('th', { class: 'kv-actions-head' });
  headRow.appendChild(aliasHead);
  headRow.appendChild(actionHead);
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  if (state.aliases.length === 0) {
    const emptyRow = el('tr', { class: 'kv-empty-row' });
    const td = el('td');
    td.setAttribute('colspan', '2');
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
        section: 'nomeda',
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
  const aliasLabel = el('label', { class: 'kv-add-label' });
  aliasLabel.textContent = 'Alias name';
  const aliasInp = el('input', { class: 'setting-input kv-input' }) as HTMLInputElement;
  aliasInp.type = 'text';
  aliasInp.placeholder = 'claude-1';
  aliasField.appendChild(aliasLabel);
  aliasField.appendChild(aliasInp);
  aliasTd.appendChild(aliasField);
  tr.appendChild(aliasTd);

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
    state.atlassianBitbucketTokenConfirming = false;
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
        vscode.postMessage({ type: 'toggleModule', id: m.id, enabled: next });
      },
      ariaLabel: `Enable ${m.name}`,
    }),
  );
  container.appendChild(header);

  // Proactive pill — small badge near the top.
  if (m.proactive) {
    const pill = el('span', { class: 'proactive-pill' });
    pill.textContent = 'Proactive';
    container.appendChild(pill);
  }

  // Description block.
  if (m.description) {
    container.appendChild(textEl('div', m.description, 'desc'));
  }

  // Agent-target badge row — at-a-glance summary of which agents this module impacts.
  const agentBadges = renderAgentBadges(m.contributes?.promptFragments ?? []);
  if (agentBadges) {
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
    // Use the shared .switch/.slider toggle pattern so the Enabled column
    // matches module-row toggles elsewhere in the panel. The hidden <input>
    // still receives the change event and keeps space/enter keyboard
    // semantics intact.
    const switchLabel = el('label', {
      class: 'switch',
      'aria-label': `Enable ${rowKey}`,
    });
    const cb = el('input', { class: 'kv-enabled-input' }) as HTMLInputElement;
    cb.type = 'checkbox';
    cb.checked = enabledState;
    cb.addEventListener('change', () => {
      const richDraft = draft as Record<string, { value: string; enabled: boolean; description?: string }>;
      const existing = readRichEntry();
      richDraft[rowKey] = { ...existing, enabled: cb.checked };
      persist();
    });
    switchLabel.appendChild(cb);
    switchLabel.appendChild(el('span', { class: 'slider' }));
    enTd.appendChild(switchLabel);
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
      query: 'nomeda.linqpadConnectionsPath',
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
  heading.textContent = 'Keywords';
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
    selectHead.textContent = 'Select';
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

function renderAgent(wrapper: HTMLElement, agentId: string): void {
  const h1 = el('h1');
  h1.textContent = agentId.toUpperCase();
  const fullName = AGENT_FULL_NAMES[agentId];
  if (fullName) {
    const elucidation = el('span', { class: 'agent-title-elucidation' });
    elucidation.textContent = fullName;
    h1.appendChild(elucidation);
  }
  wrapper.appendChild(h1);
  wrapper.appendChild(textEl('p', 'Composed agent instruction: core definition, preamble, and Session Manifest. Module content is read on demand.', 'subtitle'));

  // SWE and QA subpages render an agent-config block above the composed prompt
  // for configuring how many concurrent subagents TPM may spawn. TPM itself is
  // singular — no count field.
  if (agentId === 'swe') {
    wrapper.appendChild(renderSweConfigBlock());
  } else if (agentId === 'qa') {
    wrapper.appendChild(renderQaConfigBlock());
  }

  // "Prompt" heading sits at the top hierarchy (NOT inside an agent-config block)
  // so it appears on all three tabs, including TPM which has no config block.
  // agent-config-header is unscoped in styles.css, so it applies here safely.
  const promptHeader = el('div', { class: 'agent-config-header' });
  promptHeader.textContent = 'Instructions';
  wrapper.appendChild(promptHeader);

  const prompt = state.composedPrompts[agentId];
  if (prompt === undefined) {
    wrapper.appendChild(textEl('div', 'Loading...', 'empty'));
    vscode.postMessage({ type: 'getComposedPrompt', agent: agentId });
    return;
  }
  const pre = el('pre', { class: 'prompt' });
  pre.textContent = prompt;
  wrapper.appendChild(pre);
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
        vscode.postMessage({ type: 'updateConfiguration', section: 'nomeda', key: 'swe.performanceCores', value: next });
      },
      (next) => {
        state.sweConfig.performanceCoresModel = next;
        vscode.postMessage({ type: 'updateConfiguration', section: 'nomeda', key: 'swe.performanceCoresModel', value: next });
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
        vscode.postMessage({ type: 'updateConfiguration', section: 'nomeda', key: 'swe.efficiencyCores', value: next });
      },
      (next) => {
        state.sweConfig.efficiencyCoresModel = next;
        vscode.postMessage({ type: 'updateConfiguration', section: 'nomeda', key: 'swe.efficiencyCoresModel', value: next });
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
        vscode.postMessage({ type: 'updateConfiguration', section: 'nomeda', key: 'qa.count', value: next });
      },
      (next) => {
        state.qaConfig.model = next;
        vscode.postMessage({ type: 'updateConfiguration', section: 'nomeda', key: 'qa.model', value: next });
      },
    ),
  );
  block.appendChild(row);
  return block;
}

/**
 * Atlassian Suite API token slots container. Renders two stacked token slots —
 * one for Jira and one for Bitbucket — followed by a single shared helper link.
 * Token values are NEVER read or displayed — only set/cleared status flows here.
 */
function renderAtlassianTokenSlots(): HTMLElement {
  const wrapper = el('div', { class: 'atlassian-token-slots' });

  wrapper.appendChild(renderSingleTokenSlot({
    label: 'Jira API Token',
    tokenSet: state.atlassianJiraTokenSet,
    confirming: state.atlassianJiraTokenConfirming,
    onSet: () => {
      vscode.postMessage({ type: 'atlassianSetJiraToken' } as unknown as WebviewToHostMessage);
    },
    onClear: () => {
      vscode.postMessage({ type: 'atlassianClearJiraToken' } as unknown as WebviewToHostMessage);
    },
    setConfirming: (v) => { state.atlassianJiraTokenConfirming = v; },
    getConfirming: () => state.atlassianJiraTokenConfirming,
  }));

  wrapper.appendChild(renderSingleTokenSlot({
    label: 'Bitbucket API Token',
    tokenSet: state.atlassianBitbucketTokenSet,
    confirming: state.atlassianBitbucketTokenConfirming,
    onSet: () => {
      vscode.postMessage({ type: 'atlassianSetBitbucketToken' } as unknown as WebviewToHostMessage);
    },
    onClear: () => {
      vscode.postMessage({ type: 'atlassianClearBitbucketToken' } as unknown as WebviewToHostMessage);
    },
    setConfirming: (v) => { state.atlassianBitbucketTokenConfirming = v; },
    getConfirming: () => state.atlassianBitbucketTokenConfirming,
  }));

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
 * Render a single product token slot (Jira or Bitbucket). Each slot has a
 * labelled header, a status line, and Set / Replace / Clear (two-step) buttons.
 * The two-step confirm is per-slot and independent of the other slot.
 */
function renderSingleTokenSlot(opts: {
  label: string;
  tokenSet: boolean;
  confirming: boolean;
  onSet: () => void;
  onClear: () => void;
  setConfirming: (v: boolean) => void;
  getConfirming: () => boolean;
}): HTMLElement {
  const { label, tokenSet, confirming, onSet, onClear, setConfirming, getConfirming } = opts;

  const slot = el('div', { class: 'atlassian-token-slot' });

  // Leading key glyph — flags the row as a credential field at a glance.
  const icon = el('span', { class: 'atlassian-token-slot-icon', 'aria-hidden': 'true' });
  icon.innerHTML = KEY_ICON_SVG;
  slot.appendChild(icon);

  // Slot header (product label).
  const slotLabel = el('div', { class: 'atlassian-token-slot-label' });
  slotLabel.textContent = label;
  slot.appendChild(slotLabel);

  // Status line.
  const statusLine = el('div', { class: 'atlassian-token-status' });
  statusLine.textContent = tokenSet ? '●●●●●● set' : 'not set';
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

  // Jira row
  statusLines.appendChild(renderValidationStatusLine('Jira', result.jira, jiraHost));
  // Bitbucket row
  statusLines.appendChild(renderValidationStatusLine('Bitbucket', result.bitbucket, workspace));

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
      detail = `${product} — ${s.message ?? 'validation failed'}`;
      break;
    case 'skipped':
      glyphText = '—'; // —
      detail = `${product} — ${s.message ?? 'skipped'}`;
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
  wrapper.appendChild(textEl('p', 'Open a Nomeda session terminal in the editor area.', 'subtitle'));
  const open = el('button', { class: 'primary' });
  open.textContent = 'Open Session';
  open.addEventListener('click', () => vscode.postMessage({ type: 'openSession' }));
  const actions = el('div', { class: 'actions' });
  actions.appendChild(open);
  wrapper.appendChild(actions);
}

function renderField(key: string, field: SettingsField): HTMLElement {
  const wrap = el('div', { class: 'field' });
  const label = el('label');
  label.textContent = field.label;
  wrap.appendChild(label);
  if (field.description) {
    wrap.appendChild(textEl('div', field.description, 'desc'));
  }
  const value = state.settingsValues[key] ?? field.default;

  if (field.type === 'boolean') {
    wrap.appendChild(
      renderToggle({
        checked: !!value,
        onChange: (next) => {
          state.settingsValues[key] = next;
          state.dirty = true;
          render();
        },
        ariaLabel: field.label,
      }),
    );
  } else if (field.type === 'enum') {
    const select = el('select') as HTMLSelectElement;
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
      render();
    });
    wrap.appendChild(select);
  } else if (field.type === 'number') {
    const inp = el('input') as HTMLInputElement;
    inp.type = 'number';
    if (value !== undefined) inp.value = String(value);
    inp.addEventListener('input', () => {
      state.settingsValues[key] = inp.value === '' ? undefined : Number(inp.value);
      state.dirty = true;
    });
    wrap.appendChild(inp);
  } else {
    const inp = el('input') as HTMLInputElement;
    inp.type = 'text';
    if (value !== undefined && value !== null) inp.value = String(value);
    inp.addEventListener('input', () => {
      state.settingsValues[key] = inp.value;
      state.dirty = true;
    });
    wrap.appendChild(inp);
  }
  return wrap;
}

function renderActions(): HTMLElement {
  const a = el('div', { class: 'actions' });
  const save = el('button', { class: 'primary' }) as HTMLButtonElement;
  save.textContent = state.dirty ? 'Save' : 'Saved';
  save.disabled = !state.dirty;
  save.addEventListener('click', () => {
    vscode.postMessage({ type: 'saveSettings', values: state.settingsValues });
  });
  a.appendChild(save);
  return a;
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

init();
