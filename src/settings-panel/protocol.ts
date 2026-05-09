// Message protocol shared between extension host and webview.
// Keep this file isomorphic: no `vscode` import, no Node imports.

import type { ModuleManifest } from '../manifest/types';

export interface ModuleSummary {
  id: string;
  name: string;
  version: string;
  description?: string;
  enabled: boolean;
  contributes: ModuleManifest['contributes'];
}

export interface AgentStatusSummary {
  id: string;
  status: 'active' | 'idle' | 'stalled' | 'error';
  instance: number | null;
  lastHeartbeat: number | null;
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
  | { type: 'openSession' };

// Host → webview
export type HostToWebviewMessage =
  | { type: 'modulesChanged'; modules: ModuleSummary[] }
  | { type: 'settingsLoaded'; values: Record<string, unknown> }
  | { type: 'settingsSaved'; ok: boolean; error?: string }
  | { type: 'composedPromptUpdated'; agent: string; prompt: string }
  | { type: 'agentStateUpdated'; agents: AgentStatusSummary[] };
