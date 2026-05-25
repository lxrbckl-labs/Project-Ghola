/**
 * Shared workspace-state and setContext key constants. Centralizing prevents
 * accidental drift when a key gets renamed or reused.
 */

export const WORKSPACE_STATE_KEYS = {
  MODULE_SETTINGS: 'nomeda.moduleSettings',
  ENABLED_MODULES: 'nomeda.enabledModules',
  ENABLED_MODULES_INITIALIZED: 'nomeda.enabledModules.initialized',
  CONFIGURATIONS: 'nomeda.configurations',
  ACTIVE_CONFIGURATION_ID: 'nomeda.activeConfigurationId',
  TICKET_WORK_TODOS: 'nomeda.ticketWork.todos',
  ATLASSIAN_LAST_VALIDATION: 'nomeda.atlassianSuite.lastValidation',
} as const;

export const SET_CONTEXT_KEYS = {
  ATLASSIAN_SUITE_WIDGET_ENABLED: 'nomeda.atlassianSuite.widgetEnabled',
  TICKET_WORK_WIDGET_ENABLED: 'nomeda.ticketWork.widgetEnabled',
} as const;
