// The ModuleManifest is the contract every Nomeda module must satisfy.
// A module is a folder containing a `manifest.json` matching this shape.
// Contributions are the surfaces a module can extend: prompts, agents,
// settings, settings-panel UI sections, and tools the agent can call.

export type AgentTarget = 'tpm' | 'swe' | 'qa' | string;

export interface PromptFragment {
  /** Which agent's composed prompt this fragment is appended to. */
  target: AgentTarget;
  /** Optional logical section label rendered as a header during composition. */
  section?: string;
  /** Path to a markdown file, relative to the module root. */
  contentPath: string;
  /** Sort order within the target. Lower = earlier. Defaults to 100. */
  order?: number;
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
  | 'path';

export interface SettingsField {
  type: SettingsFieldType;
  label: string;
  description?: string;
  default?: unknown;
  required?: boolean;
  /** Options list — only meaningful when type === 'enum'. */
  options?: string[];
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
  contributes?: ContributionPoints;
}

// Lifecycle hooks are loaded lazily from the module's compiled `entry` file.
// The host calls these in response to enable/disable/settings-change events.
export interface LifecycleContext {
  moduleId: string;
  rootPath: string;
  settings: Record<string, unknown>;
  /** Append a line to the shared Nomeda OutputChannel. */
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
