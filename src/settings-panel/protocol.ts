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
  /** Mirrors `ModuleManifest.structural`. When true, the webview hides this module from the Modules tab list. */
  structural?: boolean;
  contributes: ModuleManifest['contributes'];
}

/**
 * A single prompt-fragment payload sent to the webview for the Modules-tab
 * detail view. The webview never reads the filesystem; the host always reads
 * the file (relative to the module root) and ships the raw text. On read
 * failure, `error` is set and `content` is empty.
 *
 * For `core.preamble`, the host additionally fabricates an entry pointing at
 * `preamble.md` (which is structural, not a manifest-declared fragment) so the
 * detail view can render its content alongside other modules' fragments.
 */
export interface PromptFragmentDetail {
  target: string;
  contentPath: string;
  absolutePath: string;
  content: string;
  error?: string;
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
  | { type: 'updateConfiguration'; section: string; key: string; value: unknown };

// Host → webview
export type HostToWebviewMessage =
  | { type: 'modulesChanged'; modules: ModuleSummary[] }
  | { type: 'settingsLoaded'; values: Record<string, unknown>; sessionCommand: string }
  | { type: 'settingsSaved'; ok: boolean; error?: string }
  | { type: 'composedPromptUpdated'; agent: string; prompt: string }
  | { type: 'moduleDetail'; moduleId: string; fragments: PromptFragmentDetail[] };
