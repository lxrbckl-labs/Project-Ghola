// The ModuleManifest is the contract every Ghola module must satisfy.
// A module is a folder containing a `manifest.json` matching this shape.
// Contributions are the surfaces a module can extend: prompts, agents,
// settings, settings-panel UI sections, and tools the agent can call.

// 'tpm' | 'swe' | 'qa' name a specific agent's composed prompt; 'all' is a
// fan-out target — a fragment with target 'all' is appended to every per-agent
// prompt. The `(string & {})` fallback preserves room for module-defined custom
// agents declared via `contributes.agents[]` while keeping IDE autocomplete on
// the four canonical values.
export type AgentTarget = 'tpm' | 'swe' | 'qa' | 'all' | (string & {});

export type ModuleCategory =
  | 'safety'
  | 'workflow'
  | 'orchestration'
  | 'integration'
  | 'knowledge'
  | 'session-mode'
  | 'utility';

export type ModuleKind = 'capability' | 'convention' | 'workflow';

export type ModuleTrigger = 'session-start' | 'user-request' | 'phrase-detection' | 'always-applied' | 'event';
export type ModuleTier = 'essential' | 'recommended' | 'optional';

export interface PromptFragment {
  /** Which agent's composed prompt this fragment is appended to. */
  target: AgentTarget;
  /** Path to a markdown file, relative to the module root. Read on demand by the agent. */
  contentPath: string;
}

export interface AgentDefinition {
  /** Agent id this definition replaces ('tpm' | 'swe' | 'qa' | custom). */
  id: AgentTarget;
  /** Path to the full agent prompt markdown, relative to the module root. */
  definitionPath: string;
}

export type SettingsFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'path'
  | 'keyValue';

/**
 * Optional source identifier for `keyValue` field value-cell dropdown
 * populations. The webview consults this to decide whether to request a
 * host-provided list of candidate values to surface as a quick-pick alongside
 * the free-form text override input. Currently only `"linqpad-connections"`
 * is recognized — the host probes the LINQPad ConnectionsV2.xml file and
 * returns parsed connection names.
 */
export type SettingsValueSource = 'linqpad-connections';

export interface SettingsField {
  type: SettingsFieldType;
  label: string;
  description?: string;
  /**
   * Default value for the field. For `type === 'keyValue'` the value is a
   * `Record<string, { value: string; enabled?: boolean; description?: string }>`
   * — user-defined keys mapped to rich entry objects. `value` carries the
   * column-specific meaning for the setting (e.g. a category letter for
   * tool.git, a description string for tool.npm-suite). `enabled` is present
   * when `optionalEnabled === true`; `description` is present when
   * `optionalDescription === true`. Empty `{}` is the conventional "no entries"
   * default.
   */
  default?: unknown;
  required?: boolean;
  /** Options list — only meaningful when type === 'enum'. */
  options?: string[];
  /**
   * Optional path (relative to the module root) to a JSON file documenting the
   * finite vocabulary of canonical keywords this setting accepts. The webview
   * renders the file's contents as a Keyword/Purpose table under the input;
   * agents read the same file for full reference understanding. File shape:
   *   `[{ "keyword": string, "purpose": string }, ...]`
   * The value present in the user's parameter is still the only authorized
   * subset — the keywords file is documentation, not policy.
   */
  keywordsPath?: string;
  /**
   * When true (only meaningful for `type === 'string'` paired with
   * `keywordsPath`), the webview renders the field as a checkbox group instead
   * of a text input. Each option in the group corresponds to one entry from
   * the keywords file. The saved value is still a comma-separated string —
   * concatenation of the currently-checked keywords — so agents and the
   * composer see no schema change. Auto-saves on every check/uncheck (no
   * separate save button). If the keywords file fails to load or is empty,
   * the webview falls back to the standard text input.
   */
  multiSelect?: boolean;
  /** When true and `type` is `'string'`, the settings panel renders the field as a multi-line textarea instead of a single-line input. */
  multiline?: boolean;
  /** For `type === 'number'`: optional inclusive minimum, applied as the input's `min` attribute (spinner floor + browser validation). */
  min?: number;
  /** For `type === 'number'`: optional inclusive maximum, applied as the input's `max` attribute (spinner ceiling + browser validation). */
  max?: number;
  /**
   * For `type === 'keyValue'`: identifies a host-known source of candidate
   * values shown in the value-cell dropdown. Free-form text override is
   * always permitted regardless of this setting.
   */
  valueSource?: SettingsValueSource;
  /** Optional UI label for the key column of a `keyValue` table. */
  keyLabel?: string;
  /** Optional UI label for the value column of a `keyValue` table. */
  valueLabel?: string;
  /**
   * When true and the field type is keyValue, the value cell renders as
   * read-only display text (a styled span) rather than an editable input.
   * Use for value columns that carry a fixed taxonomy authored in the
   * manifest (e.g. tool.git's r|w|d Category) where the user should not
   * be free to type arbitrary values. Default false.
   */
  valueReadonly?: boolean;
  /**
   * Allowed values for the value column (e.g. ["r", "w", "d"]). When set
   * together with `valueReadonly: true`, the add-row renders a dropdown
   * populated from these options so the user can still classify new
   * entries — existing rows continue to display the read-only span.
   */
  valueOptions?: string[];
  /**
   * When the field type is keyValue, allow rows to be added with an empty
   * value. Default false.
   */
  optionalValue?: boolean;
  /**
   * When true and the field type is keyValue, each row carries an enabled
   * flag. Disabled rows persist but are filtered out of the agent-facing
   * parameter value at compose time. Default false.
   */
  optionalEnabled?: boolean;
  /**
   * When true and the field type is keyValue, each row gains a free-text
   * Description column rendered between Value and Delete. The description
   * is panel-only metadata — the composer does NOT pass it to the agent
   * prompt. Default false.
   */
  optionalDescription?: boolean;
  /** Optional UI label for the description column of a `keyValue` table. Default "Description". */
  descriptionLabel?: string;
  /**
   * When true, the rendered table drops its shared `max-width: 720px` ceiling
   * and stretches to fill the surrounding settings card. Applies to:
   *   - `keyValue` fields (via the `.kv-table--full-width` modifier)
   *   - fields with a `keywordsPath` (via the
   *     `.setting-keywords-table--full-width` modifier)
   * Use sparingly — only for tables whose data columns would otherwise look
   * visually pinched (e.g. tool.database-access's allowlist surfacing long
   * LINQPad connection names, or tool.dotnet-suite's keyword purpose column
   * with multi-word entries). Default false.
   */
  fullWidth?: boolean;
  /**
   * How the Enabled column renders for a `keyValue` field: `"checkbox"`
   * (default, native HTML checkbox — the project convention for kv-table
   * Enabled columns) or `"toggle"` (the `.switch`/`.slider` pattern matching
   * module-row toggles, opt-in for tables where the heavier toggle weight is
   * desirable). Only meaningful when `optionalEnabled: true`. Default
   * `"checkbox"`.
   */
  enabledStyle?: 'toggle' | 'checkbox';
  /**
   * Overrides the "Keywords" subtitle that prefixes the reference table when a
   * field declares a `keywordsPath`. Use sparingly — only when the module's
   * domain has a clearer collective noun (e.g. "Functions" for
   * tool.dotnet-suite's subcommand list). Default "Keywords".
   */
  keywordsLabel?: string;
  /**
   * Overrides the "Select" column header that appears as the leading checkbox
   * column when a `keywordsPath` field is also `multiSelect: true`. Use when
   * the override more naturally describes the action of toggling rows (e.g.
   * "Enabled" for an allowlist semantic). Default "Select". No effect when
   * `multiSelect` is false.
   */
  selectColumnLabel?: string;
}

export type SettingsSchema = Record<string, SettingsField>;

export type UISectionPlacement =
  | 'general'
  | 'modules'
  | 'agents'
  | 'sessions'
  | string;

export interface UISectionContribution {
  id: string;
  title: string;
  placement: UISectionPlacement;
  /** Optional path to a webview HTML file for fully custom UI. */
  contentPath?: string;
}

export type ToolType = 'script' | 'mcp';

export interface ToolContribution {
  id: string;
  name: string;
  type: ToolType;
  description: string;
  /** Required when type === 'script'. */
  command?: string;
  /** Required when type === 'mcp'. */
  mcpServer?: string;
}

export interface ContributionPoints {
  promptFragments?: PromptFragment[];
  agents?: AgentDefinition[];
  settings?: SettingsSchema;
  settingsPanelSections?: UISectionContribution[];
  tools?: ToolContribution[];
}

export interface ModuleManifest {
  /** Unique module id (e.g. 'core.tpm' or 'integration.bitbucket'). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Semver. */
  version: string;
  description?: string;
  author?: string;
  /** Optional path to compiled entry .js exporting LifecycleHooks. */
  entry?: string;
  /**
   * When true, the composer marks this module in the Session Manifest with a
   * `[proactive — consult at session start]` annotation so the agent reads the
   * module's content immediately rather than on-demand.
   */
  proactive?: boolean;
  /** Functional domain group used for UI filtering and display. */
  category?: ModuleCategory;
  /** Whether the module adds a positive ability ('capability') or purely constrains agent behavior ('convention'). */
  kind?: ModuleKind;
  /** Module IDs this module depends on. Empty array or omitted means no hard dependencies. */
  requires?: string[];
  /** Module IDs that cannot be enabled alongside this module. The panel uses this to auto-disable conflicts. */
  mutuallyExclusiveWith?: string[];
  /** How the module activates: at session start, on explicit user request, via phrase detection, passively on every relevant action, or on a specific session event. */
  trigger?: ModuleTrigger;
  /** Onboarding priority — drives the setup walkthrough's recommendation order. */
  tier?: ModuleTier;
  /**
   * Path (relative to the module root) to a markdown file of human/operator-facing
   * setup instructions. Panel-only: the module detail view renders this in a
   * dedicated Setup Guide section. It is NEVER read by the composer and never
   * reaches an agent prompt — keep it top-level, not under `contributes`.
   */
  setupGuidePath?: string;
  contributes?: ContributionPoints;
}

// Lifecycle hooks are loaded lazily from the module's compiled `entry` file.
// The host calls these in response to enable/disable/settings-change events.
export interface LifecycleContext {
  moduleId: string;
  rootPath: string;
  settings: Record<string, unknown>;
  /** Append a line to the shared Ghola OutputChannel. */
  log: (msg: string) => void;
}

export interface LifecycleHooks {
  onActivate?: (ctx: LifecycleContext) => void | Promise<void>;
  onDeactivate?: (ctx: LifecycleContext) => void | Promise<void>;
  onSettingsChange?: (
    ctx: LifecycleContext,
    oldSettings: Record<string, unknown>,
    newSettings: Record<string, unknown>,
  ) => void | Promise<void>;
}
