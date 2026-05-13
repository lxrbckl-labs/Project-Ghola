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
  | { type: 'openVSCodeSettings'; query: string };

// Host → webview
export type HostToWebviewMessage =
  | { type: 'modulesChanged'; modules: ModuleSummary[] }
  | {
      type: 'settingsLoaded';
      values: Record<string, unknown>;
      cliCommand: string;
      sessionCommand: string;
      swe: { performanceCores: number; efficiencyCores: number };
      qa: { count: number };
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
    };
