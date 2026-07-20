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
  /**
   * One-time marker for the `tool.git::allowedCommands` branch-command flip
   * (see `migrateGitBranchCommandsEnabled`). Like MODULE_SETTINGS this one is
   * read from and written to `globalState`, not `workspaceState`: the settings
   * map it guards is global, so the marker has to be global too or the
   * migration would re-run once per workspace.
   */
  GIT_BRANCH_COMMANDS_MIGRATION: 'ghola.migrations.gitBranchCommandsEnabled',
  /**
   * One-time marker for the `tool.commit-push` enabled-modules backfill (see
   * `migrateCommitPushEnabled`). Unlike GIT_BRANCH_COMMANDS_MIGRATION this one
   * is read from and written to `workspaceState`, because the enabled-modules
   * list it guards (ENABLED_MODULES) is per-workspace — a global marker would
   * let the first workspace to activate consume the migration for all of them.
   */
  COMMIT_PUSH_BACKFILL_MIGRATION: 'ghola.migrations.commitPushBackfill',
} as const;

export const SET_CONTEXT_KEYS = {
  COMMIT_PUSH_ENABLED: 'ghola.commitPush.enabled',
} as const;
