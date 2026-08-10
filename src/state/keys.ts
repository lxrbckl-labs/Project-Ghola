/**
 * Shared workspace-state key constants. Centralizing prevents accidental drift
 * when a key gets renamed or reused.
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
   * One-time marker for the generic stored-kv-table reconciliation pass (see
   * `reconcileStoredKeyValueTables`). Global for the same reason as
   * GIT_BRANCH_COMMANDS_MIGRATION: the settings map it guards is global, so a
   * workspace-scoped marker would let the pass re-run once per workspace.
   *
   * The `.v1` suffix is deliberate. The reconciliation is one-shot by design, so
   * the NEXT time a module's kv catalog grows and stored maps have to be nudged
   * again, bump this to `.v2` rather than inventing a second mechanism.
   */
  KV_TABLE_RECONCILE_MIGRATION: 'ghola.migrations.keyValueTableReconcile.v1',
} as const;
