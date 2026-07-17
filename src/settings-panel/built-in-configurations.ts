// Built-in configuration presets seeded once into the ConfigurationsStore on
// first activation. These are ordinary, fully-editable NamedConfiguration
// records once seeded — the user can rename, edit, or delete them. Seeding is
// guarded by the `ghola.configurations.seeded` workspace-state flag so the
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
  'tool.dotnet-suite',
  'tool.npm-suite',
  'tool.core-allocation',
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
  'tool.pr-prep',
  'tool.time',
  'tool.ghola-ledger',
  'tool.operator-profile',
  'tool.usage-observer',
];

/**
 * The module set applied to a workspace on first run (fresh-install default),
 * intentionally kept identical to the "Project" preset so a new install
 * loads a coherent set that matches a visible preset.
 */
export const DEFAULT_ENABLED_IDS: string[] = [...BASELINE_IDS, 'mode.cd', 'tool.team-switchboard', 'tool.commit-push'];

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
      'tool.commit-push',
    ],
    settings: {
      'tool.lenses': { autoKickReviewOnColleagueBranch: true, autoKickPlanningOnFreshBranch: true },
      'integration.bitbucket-pr-comments': { logCommentsEnabled: true, markReadyEnabled: true, toDraftEnabled: true },
      // A keyValue override REPLACES the module's manifest default rather than
      // deep-merging into it, so this block reproduces tool.npm-suite's FULL
      // default allowedCommands map VERBATIM and then appends the sanctioned
      // version-bump command, mirroring the Project preset so all three presets
      // (Ticket Work, Project, Self Upgrade) grant the same set. Dropping any
      // reproduced entry would silently revoke it in Ticket Work sessions.
      // Only the non-destructive `--no-git-tag-version` bump is added: it edits
      // package.json + package-lock.json only, with no git commit, tag, or publish.
      'tool.npm-suite': {
        allowedCommands: {
          'npm test': { value: "Run the project's test script.", enabled: true },
          'npm run lint': { value: 'Run the lint script if present.', enabled: true },
          'npm run typecheck': { value: 'Run the typecheck script if present.', enabled: true },
          'npm run build': { value: 'Build the project. Safe - produces artifacts in dist/ or build/ but does not modify source.', enabled: true },
          'npm ls': { value: 'List installed dependency tree. Read-only.', enabled: true },
          'npm outdated': { value: 'Show packages with newer versions available. Read-only.', enabled: true },
          'ng test': { value: 'Run Angular CLI tests.', enabled: true },
          'ng lint': { value: 'Run Angular CLI lint.', enabled: true },
          'ng build': { value: 'Build the Angular project. Safe - produces artifacts in dist/ but does not modify source.', enabled: true },
          'npm version <patch|minor|major> --no-git-tag-version': { value: 'Bump the version in package.json + package-lock.json only. The --no-git-tag-version form is mandatory: no git commit, no git tag, no publish; reversible and keeps the two version fields in sync.', enabled: true },
        },
      },
    },
    isDefault: false,
  },
  {
    name: 'Project',
    enabledIds: [...DEFAULT_ENABLED_IDS],
    // A keyValue override REPLACES the module's manifest default rather than
    // deep-merging into it (see composer renderParameters / projectValueForAgent),
    // so this block reproduces tool.npm-suite's FULL default allowedCommands map
    // VERBATIM and then appends the sanctioned version-bump command. Dropping any
    // of the reproduced entries would silently revoke it in Project sessions.
    // Only the non-destructive `--no-git-tag-version` bump is added: it edits
    // package.json + package-lock.json only, with no git commit, tag, or publish.
    // The `value` field is the panel-only description (never passed to the agent);
    // manifest em-dashes are rewritten to ASCII here to satisfy the source rule.
    settings: {
      'tool.npm-suite': {
        allowedCommands: {
          'npm test': { value: "Run the project's test script.", enabled: true },
          'npm run lint': { value: 'Run the lint script if present.', enabled: true },
          'npm run typecheck': { value: 'Run the typecheck script if present.', enabled: true },
          'npm run build': { value: 'Build the project. Safe - produces artifacts in dist/ or build/ but does not modify source.', enabled: true },
          'npm ls': { value: 'List installed dependency tree. Read-only.', enabled: true },
          'npm outdated': { value: 'Show packages with newer versions available. Read-only.', enabled: true },
          'ng test': { value: 'Run Angular CLI tests.', enabled: true },
          'ng lint': { value: 'Run Angular CLI lint.', enabled: true },
          'ng build': { value: 'Build the Angular project. Safe - produces artifacts in dist/ but does not modify source.', enabled: true },
          'npm version <patch|minor|major> --no-git-tag-version': { value: 'Bump the version in package.json + package-lock.json only. The --no-git-tag-version form is mandatory: no git commit, no git tag, no publish; reversible and keeps the two version fields in sync.', enabled: true },
        },
      },
    },
    isDefault: false,
  },
  {
    name: 'Support',
    enabledIds: [...BASELINE_IDS, 'mode.support'],
    // Empty settings so `mode.support` composes as `(defaults)` — surfacing its
    // full manifest default set (including appMap) rather than hiding fields
    // behind a partial override. Consistent with the CD preset.
    settings: {},
    isDefault: false,
  },
  {
    name: 'Self Upgrade',
    enabledIds: [...BASELINE_IDS, 'tool.self-upgrade', 'tool.github', 'tool.commit-push'],
    // The composer emits a keyValue override VERBATIM (see composer.ts
    // renderParameters / projectValueForAgent): it iterates only the entries
    // present in the override and never merges the module's manifest default.
    // So a preset override REPLACES tool.git's allowedCommands rather than
    // deep-merging into it. To keep the read-only git commands AND enable the
    // three write commands the self-upgrade commit path needs, we ship the FULL
    // tool.git default allowedCommands map with only `git add`, `git commit`,
    // and `git push` flipped to enabled: true. Descriptions are panel-only
    // metadata (never passed to the agent) and are copied from tool.git's
    // default with its em-dashes rewritten to ASCII to satisfy the source
    // ASCII rule. protectedBranches is left at its default (empty) so the push
    // to the current branch (main) is not blocked. tool.github stays at its
    // all-read-only default (no gh writes enabled here).
    settings: {
      'tool.git': {
        allowedCommands: {
          'git blame': { value: 'r', enabled: true, description: 'Show who last modified each line of a file and in which commit.' },
          'git branch': { value: 'r', enabled: true, description: 'List local branches; mark the current branch with an asterisk.' },
          'git describe': { value: 'r', enabled: true, description: 'Produce a human-readable name for the current commit using the nearest tag.' },
          'git diff': { value: 'r', enabled: true, description: 'Show changes between commits, branches, working tree, etc.' },
          'git grep': { value: 'r', enabled: true, description: 'Search tracked files for a pattern; faster than plain grep over the repo.' },
          'git log': { value: 'r', enabled: true, description: 'Show commit history with messages, authors, and dates.' },
          'git ls-files': { value: 'r', enabled: true, description: 'List files tracked by the index; useful for scoping searches.' },
          'git reflog': { value: 'r', enabled: true, description: 'Show the local history of HEAD movements; lifeline for recovering lost commits.' },
          'git remote': { value: 'r', enabled: true, description: 'List configured remotes and their URLs.' },
          'git rev-parse': { value: 'r', enabled: true, description: 'Resolve a ref to its full SHA or show repo metadata paths.' },
          'git shortlog': { value: 'r', enabled: true, description: 'Summarize git log output grouped by author.' },
          'git show': { value: 'r', enabled: true, description: 'Display a commit, tag, or object along with its diff.' },
          'git stash list': { value: 'r', enabled: true, description: 'List stashed changesets currently saved on the stash stack.' },
          'git status': { value: 'r', enabled: true, description: 'Show working tree status: modified, staged, and untracked files.' },
          'git tag': { value: 'r', enabled: true, description: 'List existing tags in the repository.' },
          'git add': { value: 'w', enabled: true, description: 'Stage file contents for the next commit.' },
          'git apply': { value: 'w', enabled: false, description: 'Apply a patch to files and/or the index without committing.' },
          'git branch <name>': { value: 'w', enabled: false, description: 'Create a new local branch pointing at the current commit.' },
          'git cherry-pick': { value: 'w', enabled: false, description: 'Apply the changes from existing commits onto the current branch.' },
          'git checkout': { value: 'w', enabled: false, description: "Switch branches (non-destructive form). Use 'git checkout -- <path>' for file-restore, which is a separate d-category entry." },
          'git clone': { value: 'w', enabled: false, description: 'Clone a repository into a new directory.' },
          'git commit': { value: 'w', enabled: true, description: 'Record staged changes to the repository as a new commit.' },
          'git fetch': { value: 'w', enabled: false, description: 'Download objects and refs from a remote without merging.' },
          'git init': { value: 'w', enabled: false, description: 'Create an empty Git repository or reinitialize an existing one.' },
          'git merge': { value: 'w', enabled: false, description: 'Join two or more development histories together into the current branch.' },
          'git mv': { value: 'w', enabled: false, description: 'Move or rename a tracked file, directory, or symlink.' },
          'git pull': { value: 'w', enabled: false, description: 'Fetch from a remote and integrate the changes into the current branch.' },
          'git push': { value: 'w', enabled: true, description: "Update a remote ref using the local ref's commits." },
          'git rebase': { value: 'w', enabled: false, description: 'Reapply commits on top of another base tip (non-interactive). Rewrites local unpublished commits; recoverable via reflog.' },
          'git remote add': { value: 'w', enabled: false, description: 'Register a new remote repository under a short name.' },
          'git reset': { value: 'w', enabled: false, description: 'Move HEAD and optionally update the index; safe modes preserve the working tree.' },
          'git restore --staged': { value: 'w', enabled: false, description: 'Unstage paths from the index without touching the working tree.' },
          'git revert': { value: 'w', enabled: false, description: 'Create a new commit that undoes the changes of an existing commit.' },
          'git rm': { value: 'w', enabled: false, description: 'Remove tracked files from the working tree and the index.' },
          'git stash pop': { value: 'w', enabled: false, description: 'Apply the latest stash and drop it from the stash stack.' },
          'git stash push': { value: 'w', enabled: false, description: 'Save the current modified state onto a new stash entry.' },
          'git switch': { value: 'w', enabled: false, description: 'Switch branches (modern replacement for the branch half of checkout).' },
          'git tag <name>': { value: 'w', enabled: false, description: 'Create a new tag pointing at the current commit.' },
          'git branch -D': { value: 'd', enabled: false, description: 'Force-delete a local branch even if it has unmerged commits.' },
          'git checkout -- <path>': { value: 'd', enabled: false, description: 'Discard working-tree changes for the given path; uncommitted edits are lost.' },
          'git clean -f': { value: 'd', enabled: false, description: 'Force-delete untracked files from the working tree.' },
          'git filter-branch': { value: 'd', enabled: false, description: 'Rewrite branch history wholesale by applying filters; deprecated and dangerous.' },
          'git push --delete': { value: 'd', enabled: false, description: 'Delete a ref on the remote; removes the branch or tag for everyone.' },
          'git push --force': { value: 'd', enabled: false, description: 'Force-push, overwriting remote history. Use with extreme care.' },
          'git rebase -i': { value: 'd', enabled: false, description: 'Interactive rebase; reorder, squash, edit, or drop commits in local history.' },
          'git reset --hard': { value: 'd', enabled: false, description: 'Reset HEAD and working tree; discards all uncommitted changes.' },
          'git stash clear': { value: 'd', enabled: false, description: 'Delete every stash entry; the entire stash stack is wiped.' },
          'git stash drop': { value: 'd', enabled: false, description: 'Delete a single stash entry from the stash stack.' },
        },
      },
      // A keyValue override REPLACES the module's manifest default rather than
      // deep-merging into it, so this block reproduces tool.npm-suite's FULL
      // default allowedCommands map VERBATIM and then appends the sanctioned
      // version-bump command, mirroring the Project preset so all three presets
      // (Ticket Work, Project, Self Upgrade) grant the same set. Dropping any
      // reproduced entry would silently revoke it in Self Upgrade sessions.
      // Only the non-destructive `--no-git-tag-version` bump is added: it edits
      // package.json + package-lock.json only, with no git commit, tag, or publish.
      'tool.npm-suite': {
        allowedCommands: {
          'npm test': { value: "Run the project's test script.", enabled: true },
          'npm run lint': { value: 'Run the lint script if present.', enabled: true },
          'npm run typecheck': { value: 'Run the typecheck script if present.', enabled: true },
          'npm run build': { value: 'Build the project. Safe - produces artifacts in dist/ or build/ but does not modify source.', enabled: true },
          'npm ls': { value: 'List installed dependency tree. Read-only.', enabled: true },
          'npm outdated': { value: 'Show packages with newer versions available. Read-only.', enabled: true },
          'ng test': { value: 'Run Angular CLI tests.', enabled: true },
          'ng lint': { value: 'Run Angular CLI lint.', enabled: true },
          'ng build': { value: 'Build the Angular project. Safe - produces artifacts in dist/ but does not modify source.', enabled: true },
          'npm version <patch|minor|major> --no-git-tag-version': { value: 'Bump the version in package.json + package-lock.json only. The --no-git-tag-version form is mandatory: no git commit, no git tag, no publish; reversible and keeps the two version fields in sync.', enabled: true },
        },
      },
    },
    isDefault: false,
  },
  {
    // Fully-loaded, MODE-BASED divide-and-conquer profile. It enables
    // `mode.sardaukar`, the general-purpose divide-and-conquer modality, atop the
    // full Project SWT toolset (Jira + Bitbucket + testing + quality + sprint/board
    // queries), so it can flex to any task. `mode.sardaukar` is the only mode
    // here and is mutually exclusive with cd/support/ticket-work.
    name: 'Sardaukar',
    enabledIds: [
      ...BASELINE_IDS,
      'mode.sardaukar',
      'integration.atlassian-suite',
      'integration.bitbucket-pr-comments',
      'tool.ac-to-testing',
      'tool.playwright',
      'tool.qa-pr-learning',
      'tool.cross-ticket-isolation',
    ],
    settings: {
      'tool.lenses': { autoKickReviewOnColleagueBranch: true, autoKickPlanningOnFreshBranch: true },
      'integration.bitbucket-pr-comments': { logCommentsEnabled: true },
      // Sardaukar lets the team commit and push to the current branch. Because a
      // keyValue override REPLACES tool.git's default allowedCommands (it is not
      // merged), we ship the FULL default map here with only `git add`,
      // `git commit`, and `git push` flipped to enabled: true. This block is
      // byte-identical to the Self Upgrade preset's tool.git allowedCommands so
      // there is a single source of truth for which git commands are on.
      // protectedBranches is left unset so the current branch stays pushable.
      'tool.git': {
        allowedCommands: {
          'git blame': { value: 'r', enabled: true, description: 'Show who last modified each line of a file and in which commit.' },
          'git branch': { value: 'r', enabled: true, description: 'List local branches; mark the current branch with an asterisk.' },
          'git describe': { value: 'r', enabled: true, description: 'Produce a human-readable name for the current commit using the nearest tag.' },
          'git diff': { value: 'r', enabled: true, description: 'Show changes between commits, branches, working tree, etc.' },
          'git grep': { value: 'r', enabled: true, description: 'Search tracked files for a pattern; faster than plain grep over the repo.' },
          'git log': { value: 'r', enabled: true, description: 'Show commit history with messages, authors, and dates.' },
          'git ls-files': { value: 'r', enabled: true, description: 'List files tracked by the index; useful for scoping searches.' },
          'git reflog': { value: 'r', enabled: true, description: 'Show the local history of HEAD movements; lifeline for recovering lost commits.' },
          'git remote': { value: 'r', enabled: true, description: 'List configured remotes and their URLs.' },
          'git rev-parse': { value: 'r', enabled: true, description: 'Resolve a ref to its full SHA or show repo metadata paths.' },
          'git shortlog': { value: 'r', enabled: true, description: 'Summarize git log output grouped by author.' },
          'git show': { value: 'r', enabled: true, description: 'Display a commit, tag, or object along with its diff.' },
          'git stash list': { value: 'r', enabled: true, description: 'List stashed changesets currently saved on the stash stack.' },
          'git status': { value: 'r', enabled: true, description: 'Show working tree status: modified, staged, and untracked files.' },
          'git tag': { value: 'r', enabled: true, description: 'List existing tags in the repository.' },
          'git add': { value: 'w', enabled: true, description: 'Stage file contents for the next commit.' },
          'git apply': { value: 'w', enabled: false, description: 'Apply a patch to files and/or the index without committing.' },
          'git branch <name>': { value: 'w', enabled: false, description: 'Create a new local branch pointing at the current commit.' },
          'git cherry-pick': { value: 'w', enabled: false, description: 'Apply the changes from existing commits onto the current branch.' },
          'git checkout': { value: 'w', enabled: false, description: "Switch branches (non-destructive form). Use 'git checkout -- <path>' for file-restore, which is a separate d-category entry." },
          'git clone': { value: 'w', enabled: false, description: 'Clone a repository into a new directory.' },
          'git commit': { value: 'w', enabled: true, description: 'Record staged changes to the repository as a new commit.' },
          'git fetch': { value: 'w', enabled: false, description: 'Download objects and refs from a remote without merging.' },
          'git init': { value: 'w', enabled: false, description: 'Create an empty Git repository or reinitialize an existing one.' },
          'git merge': { value: 'w', enabled: false, description: 'Join two or more development histories together into the current branch.' },
          'git mv': { value: 'w', enabled: false, description: 'Move or rename a tracked file, directory, or symlink.' },
          'git pull': { value: 'w', enabled: false, description: 'Fetch from a remote and integrate the changes into the current branch.' },
          'git push': { value: 'w', enabled: true, description: "Update a remote ref using the local ref's commits." },
          'git rebase': { value: 'w', enabled: false, description: 'Reapply commits on top of another base tip (non-interactive). Rewrites local unpublished commits; recoverable via reflog.' },
          'git remote add': { value: 'w', enabled: false, description: 'Register a new remote repository under a short name.' },
          'git reset': { value: 'w', enabled: false, description: 'Move HEAD and optionally update the index; safe modes preserve the working tree.' },
          'git restore --staged': { value: 'w', enabled: false, description: 'Unstage paths from the index without touching the working tree.' },
          'git revert': { value: 'w', enabled: false, description: 'Create a new commit that undoes the changes of an existing commit.' },
          'git rm': { value: 'w', enabled: false, description: 'Remove tracked files from the working tree and the index.' },
          'git stash pop': { value: 'w', enabled: false, description: 'Apply the latest stash and drop it from the stash stack.' },
          'git stash push': { value: 'w', enabled: false, description: 'Save the current modified state onto a new stash entry.' },
          'git switch': { value: 'w', enabled: false, description: 'Switch branches (modern replacement for the branch half of checkout).' },
          'git tag <name>': { value: 'w', enabled: false, description: 'Create a new tag pointing at the current commit.' },
          'git branch -D': { value: 'd', enabled: false, description: 'Force-delete a local branch even if it has unmerged commits.' },
          'git checkout -- <path>': { value: 'd', enabled: false, description: 'Discard working-tree changes for the given path; uncommitted edits are lost.' },
          'git clean -f': { value: 'd', enabled: false, description: 'Force-delete untracked files from the working tree.' },
          'git filter-branch': { value: 'd', enabled: false, description: 'Rewrite branch history wholesale by applying filters; deprecated and dangerous.' },
          'git push --delete': { value: 'd', enabled: false, description: 'Delete a ref on the remote; removes the branch or tag for everyone.' },
          'git push --force': { value: 'd', enabled: false, description: 'Force-push, overwriting remote history. Use with extreme care.' },
          'git rebase -i': { value: 'd', enabled: false, description: 'Interactive rebase; reorder, squash, edit, or drop commits in local history.' },
          'git reset --hard': { value: 'd', enabled: false, description: 'Reset HEAD and working tree; discards all uncommitted changes.' },
          'git stash clear': { value: 'd', enabled: false, description: 'Delete every stash entry; the entire stash stack is wiped.' },
          'git stash drop': { value: 'd', enabled: false, description: 'Delete a single stash entry from the stash stack.' },
        },
      },
    },
    isDefault: false,
  },
];
