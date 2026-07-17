/**
 * Shared workspace-state and setContext key constants. Centralizing prevents
 * accidental drift when a key gets renamed or reused.
 */

export const WORKSPACE_STATE_KEYS = {
  MODULE_SETTINGS: 'ghola.moduleSettings',
  ENABLED_MODULES: 'ghola.enabledModules',
  ENABLED_MODULES_INITIALIZED: 'ghola.enabledModules.initialized',
  CONFIGURATIONS: 'ghola.configurations',
  CONFIGURATIONS_SEEDED: 'ghola.configurations.seeded',
  CONFIGURATIONS_SEEDED_NAMES: 'ghola.configurations.seededNames',
  ACTIVE_CONFIGURATION_ID: 'ghola.activeConfigurationId',
  ATLASSIAN_LAST_VALIDATION: 'ghola.atlassianSuite.lastValidation',
} as const;

export const SET_CONTEXT_KEYS = {
  COMMIT_PUSH_ENABLED: 'ghola.commitPush.enabled',
} as const;
