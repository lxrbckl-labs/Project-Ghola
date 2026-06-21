// Built-in configuration presets seeded once into the ConfigurationsStore on
// first activation. These are ordinary, fully-editable NamedConfiguration
// records once seeded — the user can rename, edit, or delete them. Seeding is
// guarded by the `nomeda.configurations.seeded` workspace-state flag so the
// presets are never duplicated on subsequent launches and user-created configs
// are never stomped.
//
// This is a plain data module: no side effects, no imports beyond the type.

import type { NamedConfiguration } from './protocol';

/** A preset shaped as a NamedConfiguration minus the runtime-generated fields. */
export type BuiltInConfiguration = Omit<NamedConfiguration, 'id' | 'createdAt'>;

/**
 * Module ids enabled by every preset. Defined once and spread into each
 * preset's `enabledIds` so the shared baseline cannot drift between presets.
 */
const BASELINE_IDS: string[] = [
  'tool.cwd-discipline',
  'tool.secrets-wrapper-pattern',
  'tool.untrusted-jira',
  'tool.dotnet-suite',
  'tool.npm-suite',
  'tool.core-allocation',
  'tool.subagent-coordination',
  'tool.lenses',
  'tool.session-bootstrap',
  'tool.session-handoff',
  'tool.obsidian-notes',
  'tool.statusline',
  'tool.conversational-settings',
  'tool.fastpath-check',
  'tool.feedback-log',
  'tool.clipboard-image',
  'tool.open-wsl-repo',
  'tool.database-access',
  'tool.git',
  'tool.regression-scan',
  'tool.pre-pr-checklist',
  'tool.pr-description',
];

/**
 * The module set applied to a workspace on first run (fresh-install default),
 * intentionally kept identical to the "CD (Project)" preset so a new install
 * loads a coherent set that matches a visible preset.
 */
export const DEFAULT_ENABLED_IDS: string[] = [...BASELINE_IDS, 'mode.cd', 'tool.team-switchboard'];

/**
 * The four SWT session-mode presets, seeded in array order. All carry
 * `isDefault: false` so none auto-applies on startup.
 */
export const BUILT_IN_CONFIGURATIONS: BuiltInConfiguration[] = [
  {
    name: 'Ticket Work',
    enabledIds: [
      ...BASELINE_IDS,
      'mode.ticket-work',
      'integration.atlassian-suite',
      'integration.bitbucket-pr-comments',
      'tool.qa-pr-learning',
      'tool.ac-to-testing',
      'tool.playwright',
      'tool.cross-ticket-isolation',
    ],
    settings: {
      'tool.lenses': { autoKickReviewOnColleagueBranch: true, autoKickPlanningOnFreshBranch: true },
      'integration.bitbucket-pr-comments': { logCommentsEnabled: true },
    },
    isDefault: false,
  },
  {
    name: 'CD (Project)',
    enabledIds: [...DEFAULT_ENABLED_IDS],
    settings: {},
    isDefault: false,
  },
  {
    name: 'Support',
    enabledIds: [...BASELINE_IDS, 'mode.support'],
    // Empty settings so `mode.support` composes as `(defaults)` — surfacing its
    // full manifest default set (including appMap) rather than hiding fields
    // behind a partial override. Consistent with the CD and Unconstrained presets.
    settings: {},
    isDefault: false,
  },
  {
    name: 'Unconstrained',
    enabledIds: [...BASELINE_IDS, 'tool.mid-session-bootstrap', 'integration.atlassian-suite'],
    settings: {},
    isDefault: false,
  },
];
