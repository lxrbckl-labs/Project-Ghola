// Message protocol shared between extension host and webview.
// Keep this file isomorphic: no `vscode` import, no Node imports.

import type { ModuleManifest } from '../manifest/types';

export interface ModuleSummary {
  id: string;
  name: string;
  version: string;
  description?: string;
  enabled: boolean;
  /** Mirrors `ModuleManifest.proactive`. The detail view renders a pill when true. */
  proactive?: boolean;
  contributes: ModuleManifest['contributes'];
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

// Webview → host
export type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'getModules' }
  | { type: 'toggleModule'; id: string; enabled: boolean }
  | { type: 'getSettings' }
  | { type: 'saveSettings'; values: Record<string, unknown> }
  | { type: 'getComposedPrompt'; agent: string }
  | { type: 'reloadModules' }
  | { type: 'openSession' }
  | { type: 'requestModuleDetail'; moduleId: string }
  | { type: 'updateConfiguration'; section: string; key: string; value: unknown }
  | { type: 'saveConfigurationCurrent' }
  | { type: 'saveConfigurationAsNew'; name: string }
  | { type: 'selectConfiguration'; id: string | null }
  | { type: 'deleteConfiguration'; id: string }
  | { type: 'renameConfiguration'; id: string; name: string }
  | { type: 'setDefaultConfiguration'; id: string };

// Host → webview
export type HostToWebviewMessage =
  | { type: 'modulesChanged'; modules: ModuleSummary[] }
  | {
      type: 'settingsLoaded';
      values: Record<string, unknown>;
      sessionCommand: string;
      swe: { performanceCores: number; efficiencyCores: number };
      qa: { count: number };
    }
  | { type: 'settingsSaved'; ok: boolean; error?: string }
  | { type: 'composedPromptUpdated'; agent: string; prompt: string }
  | { type: 'moduleDetail'; moduleId: string; fragments: PromptFragmentDetail[] }
  | {
      type: 'configurationsChanged';
      configurations: NamedConfiguration[];
      activeId: string | null;
      isModified: boolean;
    };
