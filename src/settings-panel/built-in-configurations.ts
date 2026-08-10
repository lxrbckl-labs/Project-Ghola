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
  'tool.parallel-verification',
  'tool.session-bootstrap',
  'tool.session-handoff',
  'tool.obsidian-notes',
  'tool.statusline',
  'tool.conversational-settings',
  'tool.fastpath-check',
  'tool.feedback-log',
  'tool.open-wsl-repo',
  'tool.database-access',
  'tool.git',
  'tool.regression-scan',
  'tool.pr-prep',
  'tool.terminal',
  'tool.time',
  'tool.ghola-ledger',
  // Personalization (name / persona / persona intensity) plus one session-hygiene
  // setting, the compaction-proposal threshold (compactProposalThresholdPct) -
  // not personalization itself. The operator's identity handles used for
  // review-vs-author detection are NOT here: as of
  // tool.operator-profile 0.3.0 `bitbucketUsername` and `jiraAccountId` belong
  // to integration.atlassian-suite and `gitEmail` belongs to tool.git.
  // `gitEmail` is therefore reachable in every preset (tool.git is in this
  // baseline); the two Atlassian handles are reachable only in the presets that
  // also enable integration.atlassian-suite (Ticket Work and Sardaukar). That
  // is deliberate, not a gap - a session without the suite has no PR-lookup
  // probe, so it can never resolve a `pr_author` to compare the handle against,
  // and the git-based fallback is the only path available to it regardless.
  'tool.operator-profile',
];

/**
 * The module set applied to a workspace on first run (fresh-install default),
 * intentionally kept identical to the "Project" preset so a new install
 * loads a coherent set that matches a visible preset.
 */
export const DEFAULT_ENABLED_IDS: string[] = [...BASELINE_IDS, 'mode.cd', 'tool.team-switchboard'];

/**
 * The SWT session-mode presets, seeded in array order. All carry
 * `isDefault: false` so none auto-applies on startup. Deliberately UNCOUNTED in
 * this sentence — it read "four" while the array held five, and a number here
 * goes stale every time a mode is added.
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
      'tool.reviewer-dossier',
      'tool.ac-to-testing',
      'tool.playwright',
      'tool.cross-ticket-isolation',
    ],
    settings: {
      'tool.lenses': { autoKickReviewOnColleagueBranch: true, autoKickPlanningOnFreshBranch: true },
      // `logCommentsEnabled` is deliberately absent: the legacy comment log it
      // names has no writer at all (see `pr-monitor.md` - superseded by the coded
      // `capture-comments` path), so pinning it on promised a log nobody writes.
      // The manifest default is `false`, which is what this preset now inherits.
      'integration.bitbucket-pr-comments': { markReadyEnabled: true, toDraftEnabled: true, deleteCommentEnabled: true },
      // Ticket Work needs to cut a fresh branch for the ticket it is starting.
      // Because a keyValue override REPLACES tool.git's default allowedCommands
      // (it is not merged), we ship the FULL default map here with only
      // `git branch <name>` and `git switch` flipped to enabled: true - the
      // create-then-switch pair. `git checkout` is deliberately left disabled:
      // its `git checkout -- <path>` form discards uncommitted working-tree
      // edits, and we do not want to grant that side effect just to make a
      // branch. Every write/destructive command stays off, so Ticket Work can
      // create and enter a branch but cannot stage, commit, push, or rewrite.
      // Descriptions are panel-only metadata (never passed to the agent) and
      // are copied from tool.git's default with its em-dashes rewritten to
      // ASCII to satisfy the source ASCII rule.
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
          'git add': { value: 'w', enabled: false, description: 'Stage file contents for the next commit.' },
          'git apply': { value: 'w', enabled: false, description: 'Apply a patch to files and/or the index without committing.' },
          'git branch <name>': { value: 'w', enabled: true, description: 'Create a new local branch pointing at the current commit.' },
          'git cherry-pick': { value: 'w', enabled: false, description: 'Apply the changes from existing commits onto the current branch.' },
          'git checkout': { value: 'w', enabled: false, description: "Switch branches (non-destructive form). Use 'git checkout -- <path>' for file-restore, which is a separate d-category entry." },
          'git clone': { value: 'w', enabled: false, description: 'Clone a repository into a new directory.' },
          'git commit': { value: 'w', enabled: false, description: 'Record staged changes to the repository as a new commit.' },
          'git fetch': { value: 'w', enabled: false, description: 'Download objects and refs from a remote without merging.' },
          'git init': { value: 'w', enabled: false, description: 'Create an empty Git repository or reinitialize an existing one.' },
          'git merge': { value: 'w', enabled: false, description: 'Join two or more development histories together into the current branch.' },
          'git mv': { value: 'w', enabled: false, description: 'Move or rename a tracked file, directory, or symlink.' },
          'git pull': { value: 'w', enabled: false, description: 'Fetch from a remote and integrate the changes into the current branch.' },
          'git push': { value: 'w', enabled: false, description: "Update a remote ref using the local ref's commits." },
          'git rebase': { value: 'w', enabled: false, description: 'Reapply commits on top of another base tip (non-interactive). Rewrites local unpublished commits; recoverable via reflog.' },
          'git remote add': { value: 'w', enabled: false, description: 'Register a new remote repository under a short name.' },
          'git reset': { value: 'w', enabled: false, description: 'Move HEAD and optionally update the index; safe modes preserve the working tree.' },
          'git restore --staged': { value: 'w', enabled: false, description: 'Unstage paths from the index without touching the working tree.' },
          'git revert': { value: 'w', enabled: false, description: 'Create a new commit that undoes the changes of an existing commit.' },
          'git rm --cached': { value: 'w', enabled: false, description: 'Stop tracking a file; removes it from the index only and leaves it on disk. Nothing is lost.' },
          'git stash pop': { value: 'w', enabled: false, description: 'Apply the latest stash and drop it from the stash stack.' },
          'git stash push': { value: 'w', enabled: false, description: 'Save the current modified state onto a new stash entry.' },
          'git switch': { value: 'w', enabled: true, description: 'Switch branches (modern replacement for the branch half of checkout).' },
          'git tag <name>': { value: 'w', enabled: false, description: 'Create a new tag pointing at the current commit.' },
          'git branch -D': { value: 'd', enabled: false, description: 'Force-delete a local branch even if it has unmerged commits.' },
          'git branch -d': { value: 'd', enabled: false, description: "Delete a local branch only when it is fully merged; git refuses while it still holds unmerged commits. Its own key: 'git branch -D' force-deletes and grants nothing here, and the read-only 'git branch' listing key grants neither." },
          'git checkout -- <path>': { value: 'd', enabled: false, description: 'Discard working-tree changes for the given path; uncommitted edits are lost.' },
          'git checkout -f': { value: 'd', enabled: false, description: "Switch branches while throwing away uncommitted working-tree changes; those edits are lost. Same flag as 'git checkout --force'; neither the plain 'git checkout' key nor the path-scoped 'git checkout -- <path>' key grants it." },
          'git clean -f': { value: 'd', enabled: false, description: 'Force-delete untracked files from the working tree.' },
          'git commit --amend': { value: 'd', enabled: false, description: "Replace the previous commit with a new one, rewriting it; the original is discarded, and amending an already-pushed commit needs a force-push to publish. Not granted by the plain 'git commit' key." },
          'git filter-branch': { value: 'd', enabled: false, description: 'Rewrite branch history wholesale by applying filters; deprecated and dangerous.' },
          'git push --delete': { value: 'd', enabled: false, description: 'Delete a ref on the remote; removes the branch or tag for everyone.' },
          'git push --force': { value: 'd', enabled: false, description: 'Force-push, overwriting remote history. Use with extreme care.' },
          'git rebase -i': { value: 'd', enabled: false, description: 'Interactive rebase; reorder, squash, edit, or drop commits in local history.' },
          'git reset --hard': { value: 'd', enabled: false, description: 'Reset HEAD and working tree; discards all uncommitted changes.' },
          'git rm': { value: 'd', enabled: false, description: "Remove tracked files from the index AND delete them from the working tree. Refuses on a file with uncommitted modifications; 'git rm -f' and 'git rm --cached' are separate entries and are not granted by this one." },
          'git rm -f': { value: 'd', enabled: false, description: "Force-remove tracked files; deletes them even when they carry uncommitted modifications, so those edits are lost. Strictly more destructive than 'git rm'." },
          'git stash clear': { value: 'd', enabled: false, description: 'Delete every stash entry; the entire stash stack is wiped.' },
          'git stash drop': { value: 'd', enabled: false, description: 'Delete a single stash entry from the stash stack.' },
          'git switch --discard-changes': { value: 'd', enabled: false, description: "Switch branches and throw local modifications away; uncommitted work is silently lost. One flag, three spellings: 'git switch -f', 'git switch --force', and 'git switch --discard-changes' all resolve to this entry and none of them is granted by the plain 'git switch' key." },
          'git switch --merge': { value: 'd', enabled: false, description: "Switch branches and three-way merge local modifications into the destination; a real merge that can leave conflict markers in uncommitted work. Same flag as 'git switch -m'; not granted by the plain 'git switch' key, and reachable even when 'git merge' is disabled." },
          'git switch -C <name>': { value: 'd', enabled: false, description: "Force-create a branch and switch to it; when a branch of that name already exists it is reset onto HEAD and the commits unique to it are dropped. Same flag as 'git switch --force-create'; the plain 'git switch' key covers only the safe lowercase '-c' create form and does not grant this one." },
        },
      },
      // A keyValue override REPLACES the module's manifest default rather than
      // deep-merging into it, so this block reproduces tool.npm-suite's FULL
      // default allowedCommands map VERBATIM and then appends the sanctioned
      // version-bump command, mirroring the Project preset so all three presets
      // (Ticket Work, Project, Self Upgrade) grant the same set. Dropping any
      // reproduced entry would silently revoke it in Ticket Work sessions.
      // Only the non-destructive `--no-git-tag-version` bump is added: it edits
      // package.json + package-lock.json only, with no git commit, tag, or publish.
      // Manifest em-dashes are rewritten to ASCII here to satisfy the source rule.
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
    // Ticket PR: a ticket-scoped session pointed at the branch's OPEN PULL
    // REQUEST - read the review comments, triage them, apply and verify the
    // fixes, and answer the threads - rather than at building the ticket from
    // scratch the way Ticket Work does.
    //
    // (`NamedConfiguration` carries no `description` field and the seeding path
    // in extension.ts only copies name/enabledIds/settings, so the one-line
    // description of this preset lives here as a comment rather than as a
    // dropped property.)
    //
    // Cloned from Ticket Work above with `mode.ticket-work` swapped for
    // `mode.ticket-pr`. Exactly ONE mode is listed, which matters:
    // `mode.ticket-pr` declares `mode.ticket-work` in its
    // `mutuallyExclusiveWith`, so a preset naming both would silently lose the
    // later one to `resolveConfigurationConflicts`' first-listed-wins rule.
    // `tool.pr-prep` and `tool.git` arrive via BASELINE_IDS and
    // `integration.bitbucket-pr-comments` is listed explicitly - together the
    // PR stack this mode's `requires` asks for, present in the preset itself so
    // the panel shows them enabled rather than having them pulled in silently.
    name: 'Ticket PR',
    enabledIds: [
      ...BASELINE_IDS,
      'mode.ticket-pr',
      'integration.atlassian-suite',
      'integration.bitbucket-pr-comments',
      'tool.qa-pr-learning',
      'tool.reviewer-dossier',
      'tool.ac-to-testing',
      'tool.playwright',
      'tool.cross-ticket-isolation',
    ],
    settings: {
      // Every value below is `mode.ticket-pr`'s MANIFEST DEFAULT, copied verbatim.
      // The composer now resolves a module's declared schema defaults into the
      // Session Manifest on its own, so this block is no longer load-bearing for
      // visibility - it exists for stability: pinning the values here keeps this
      // preset's behavior fixed and auditable in the panel even if the manifest's
      // declared defaults are ever tuned for other presets or a fresh install.
      //
      // Because these are copies, they can drift: change a default in
      // `modules/mode.ticket-pr/manifest.json` and this block silently keeps
      // pinning the old one. Keep the two in sync by hand whenever the manifest's
      // declared defaults change.
      'mode.ticket-pr': {
        pullOnStart: true,
        crossTicketStrictness: 'ask',
        notesSections: 'Ticket Summary, Implementation Notes, Changes Made, Edge Cases, Testing Procedures, QA Findings, Session Handoff',
        offerPrCreationWhenAbsent: true,
        autoResolveBotThreads: true,
        autoCommitAndPush: true,
        maxAutonomousIterations: 10,
        maxTicketsPerRun: 3,
        reviewStatusNames: 'In Review, Code Review, Peer Review',
        statusReportVerbosity: 'summary',
      },
      'tool.lenses': { autoKickReviewOnColleagueBranch: true, autoKickPlanningOnFreshBranch: true },
      // `logCommentsEnabled` is deliberately absent: the legacy comment log it
      // names has no writer at all (see `pr-monitor.md` - superseded by the coded
      // `capture-comments` path), so pinning it on promised a log nobody writes.
      // The manifest default is `false`, which is what this preset now inherits.
      'integration.bitbucket-pr-comments': { markReadyEnabled: true, toDraftEnabled: true, deleteCommentEnabled: true },
      // Ticket PR lands fixes on the PR's own branch and pushes them, so unlike
      // Ticket Work it needs the commit path: `mode.ticket-pr`'s "Commit and
      // push" section states outright that its authority comes from this
      // allowlist and that the mode CANNOT push without `git commit` and
      // `git push` in it. Because a keyValue override REPLACES tool.git's
      // default allowedCommands (it is not merged), we ship the FULL default map
      // here with `git add`, `git commit`, `git push`, `git switch`, and `git rm`
      // flipped to enabled: true. `git rm` is enabled here (and only here) because
      // this is the mode where the operator authorized it; it carries tool.git's
      // `d` category (it deletes tracked files from the working tree, not just
      // from the index), so it is the ONE destructive command enabled anywhere in
      // these presets. Its two siblings - `git rm -f` (strictly more destructive)
      // and `git rm --cached` (index-only, nothing lost) - are separate keys and
      // neither is granted by this one, so both stay off. `git branch <name>` is
      // deliberately NOT enabled - the branch and its PR already exist in this
      // mode, so there is nothing to create, only something to switch onto.
      // Every other destructive command stays off, `git push --force` included.
      // protectedBranches is left at its default so tool.git's own guard, not
      // this preset, decides where a push may land. Descriptions are panel-only
      // metadata (never passed to the agent) and are copied from tool.git's
      // default with its em-dashes rewritten to ASCII to satisfy the source
      // ASCII rule.
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
          'git rm --cached': { value: 'w', enabled: false, description: 'Stop tracking a file; removes it from the index only and leaves it on disk. Nothing is lost.' },
          'git stash pop': { value: 'w', enabled: false, description: 'Apply the latest stash and drop it from the stash stack.' },
          'git stash push': { value: 'w', enabled: false, description: 'Save the current modified state onto a new stash entry.' },
          'git switch': { value: 'w', enabled: true, description: 'Switch branches (modern replacement for the branch half of checkout).' },
          'git tag <name>': { value: 'w', enabled: false, description: 'Create a new tag pointing at the current commit.' },
          'git branch -D': { value: 'd', enabled: false, description: 'Force-delete a local branch even if it has unmerged commits.' },
          'git branch -d': { value: 'd', enabled: false, description: "Delete a local branch only when it is fully merged; git refuses while it still holds unmerged commits. Its own key: 'git branch -D' force-deletes and grants nothing here, and the read-only 'git branch' listing key grants neither." },
          'git checkout -- <path>': { value: 'd', enabled: false, description: 'Discard working-tree changes for the given path; uncommitted edits are lost.' },
          'git checkout -f': { value: 'd', enabled: false, description: "Switch branches while throwing away uncommitted working-tree changes; those edits are lost. Same flag as 'git checkout --force'; neither the plain 'git checkout' key nor the path-scoped 'git checkout -- <path>' key grants it." },
          'git clean -f': { value: 'd', enabled: false, description: 'Force-delete untracked files from the working tree.' },
          'git commit --amend': { value: 'd', enabled: false, description: "Replace the previous commit with a new one, rewriting it; the original is discarded, and amending an already-pushed commit needs a force-push to publish. Not granted by the plain 'git commit' key." },
          'git filter-branch': { value: 'd', enabled: false, description: 'Rewrite branch history wholesale by applying filters; deprecated and dangerous.' },
          'git push --delete': { value: 'd', enabled: false, description: 'Delete a ref on the remote; removes the branch or tag for everyone.' },
          'git push --force': { value: 'd', enabled: false, description: 'Force-push, overwriting remote history. Use with extreme care.' },
          'git rebase -i': { value: 'd', enabled: false, description: 'Interactive rebase; reorder, squash, edit, or drop commits in local history.' },
          'git reset --hard': { value: 'd', enabled: false, description: 'Reset HEAD and working tree; discards all uncommitted changes.' },
          'git rm': { value: 'd', enabled: true, description: "Remove tracked files from the index AND delete them from the working tree. Refuses on a file with uncommitted modifications; 'git rm -f' and 'git rm --cached' are separate entries and are not granted by this one." },
          'git rm -f': { value: 'd', enabled: false, description: "Force-remove tracked files; deletes them even when they carry uncommitted modifications, so those edits are lost. Strictly more destructive than 'git rm'." },
          'git stash clear': { value: 'd', enabled: false, description: 'Delete every stash entry; the entire stash stack is wiped.' },
          'git stash drop': { value: 'd', enabled: false, description: 'Delete a single stash entry from the stash stack.' },
          'git switch --discard-changes': { value: 'd', enabled: false, description: "Switch branches and throw local modifications away; uncommitted work is silently lost. One flag, three spellings: 'git switch -f', 'git switch --force', and 'git switch --discard-changes' all resolve to this entry and none of them is granted by the plain 'git switch' key." },
          'git switch --merge': { value: 'd', enabled: false, description: "Switch branches and three-way merge local modifications into the destination; a real merge that can leave conflict markers in uncommitted work. Same flag as 'git switch -m'; not granted by the plain 'git switch' key, and reachable even when 'git merge' is disabled." },
          'git switch -C <name>': { value: 'd', enabled: false, description: "Force-create a branch and switch to it; when a branch of that name already exists it is reset onto HEAD and the commits unique to it are dropped. Same flag as 'git switch --force-create'; the plain 'git switch' key covers only the safe lowercase '-c' create form and does not grant this one." },
        },
      },
      // A keyValue override REPLACES the module's manifest default rather than
      // deep-merging into it, so this block reproduces tool.npm-suite's FULL
      // default allowedCommands map VERBATIM and then appends the sanctioned
      // version-bump command, mirroring the other presets so they all grant the
      // same set. Dropping any reproduced entry would silently revoke it in
      // Ticket PR sessions. Only the non-destructive `--no-git-tag-version` bump
      // is added: it edits package.json + package-lock.json only, with no git
      // commit, tag, or publish. Manifest em-dashes are rewritten to ASCII here
      // to satisfy the source rule.
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
    // Empty settings so `mode.support` inherits its manifest defaults wholesale.
    // The composer resolves a module's declared schema defaults at compose time
    // and layers stored overrides on top, so leaving this empty surfaces the full
    // default set (appMap included) in the Session Manifest rather than hiding
    // fields behind a partial override. Consistent with the CD preset.
    settings: {},
    isDefault: false,
  },
  {
    name: 'Self Upgrade',
    enabledIds: [...BASELINE_IDS, 'tool.self-upgrade', 'tool.github'],
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
          'git rm --cached': { value: 'w', enabled: false, description: 'Stop tracking a file; removes it from the index only and leaves it on disk. Nothing is lost.' },
          'git stash pop': { value: 'w', enabled: false, description: 'Apply the latest stash and drop it from the stash stack.' },
          'git stash push': { value: 'w', enabled: false, description: 'Save the current modified state onto a new stash entry.' },
          'git switch': { value: 'w', enabled: false, description: 'Switch branches (modern replacement for the branch half of checkout).' },
          'git tag <name>': { value: 'w', enabled: false, description: 'Create a new tag pointing at the current commit.' },
          'git branch -D': { value: 'd', enabled: false, description: 'Force-delete a local branch even if it has unmerged commits.' },
          'git branch -d': { value: 'd', enabled: false, description: "Delete a local branch only when it is fully merged; git refuses while it still holds unmerged commits. Its own key: 'git branch -D' force-deletes and grants nothing here, and the read-only 'git branch' listing key grants neither." },
          'git checkout -- <path>': { value: 'd', enabled: false, description: 'Discard working-tree changes for the given path; uncommitted edits are lost.' },
          'git checkout -f': { value: 'd', enabled: false, description: "Switch branches while throwing away uncommitted working-tree changes; those edits are lost. Same flag as 'git checkout --force'; neither the plain 'git checkout' key nor the path-scoped 'git checkout -- <path>' key grants it." },
          'git clean -f': { value: 'd', enabled: false, description: 'Force-delete untracked files from the working tree.' },
          'git commit --amend': { value: 'd', enabled: false, description: "Replace the previous commit with a new one, rewriting it; the original is discarded, and amending an already-pushed commit needs a force-push to publish. Not granted by the plain 'git commit' key." },
          'git filter-branch': { value: 'd', enabled: false, description: 'Rewrite branch history wholesale by applying filters; deprecated and dangerous.' },
          'git push --delete': { value: 'd', enabled: false, description: 'Delete a ref on the remote; removes the branch or tag for everyone.' },
          'git push --force': { value: 'd', enabled: false, description: 'Force-push, overwriting remote history. Use with extreme care.' },
          'git rebase -i': { value: 'd', enabled: false, description: 'Interactive rebase; reorder, squash, edit, or drop commits in local history.' },
          'git reset --hard': { value: 'd', enabled: false, description: 'Reset HEAD and working tree; discards all uncommitted changes.' },
          'git rm': { value: 'd', enabled: false, description: "Remove tracked files from the index AND delete them from the working tree. Refuses on a file with uncommitted modifications; 'git rm -f' and 'git rm --cached' are separate entries and are not granted by this one." },
          'git rm -f': { value: 'd', enabled: false, description: "Force-remove tracked files; deletes them even when they carry uncommitted modifications, so those edits are lost. Strictly more destructive than 'git rm'." },
          'git stash clear': { value: 'd', enabled: false, description: 'Delete every stash entry; the entire stash stack is wiped.' },
          'git stash drop': { value: 'd', enabled: false, description: 'Delete a single stash entry from the stash stack.' },
          'git switch --discard-changes': { value: 'd', enabled: false, description: "Switch branches and throw local modifications away; uncommitted work is silently lost. One flag, three spellings: 'git switch -f', 'git switch --force', and 'git switch --discard-changes' all resolve to this entry and none of them is granted by the plain 'git switch' key." },
          'git switch --merge': { value: 'd', enabled: false, description: "Switch branches and three-way merge local modifications into the destination; a real merge that can leave conflict markers in uncommitted work. Same flag as 'git switch -m'; not granted by the plain 'git switch' key, and reachable even when 'git merge' is disabled." },
          'git switch -C <name>': { value: 'd', enabled: false, description: "Force-create a branch and switch to it; when a branch of that name already exists it is reset onto HEAD and the commits unique to it are dropped. Same flag as 'git switch --force-create'; the plain 'git switch' key covers only the safe lowercase '-c' create form and does not grant this one." },
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
      // Manifest em-dashes are rewritten to ASCII here to satisfy the source rule.
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
          'git rm --cached': { value: 'w', enabled: false, description: 'Stop tracking a file; removes it from the index only and leaves it on disk. Nothing is lost.' },
          'git stash pop': { value: 'w', enabled: false, description: 'Apply the latest stash and drop it from the stash stack.' },
          'git stash push': { value: 'w', enabled: false, description: 'Save the current modified state onto a new stash entry.' },
          'git switch': { value: 'w', enabled: false, description: 'Switch branches (modern replacement for the branch half of checkout).' },
          'git tag <name>': { value: 'w', enabled: false, description: 'Create a new tag pointing at the current commit.' },
          'git branch -D': { value: 'd', enabled: false, description: 'Force-delete a local branch even if it has unmerged commits.' },
          'git branch -d': { value: 'd', enabled: false, description: "Delete a local branch only when it is fully merged; git refuses while it still holds unmerged commits. Its own key: 'git branch -D' force-deletes and grants nothing here, and the read-only 'git branch' listing key grants neither." },
          'git checkout -- <path>': { value: 'd', enabled: false, description: 'Discard working-tree changes for the given path; uncommitted edits are lost.' },
          'git checkout -f': { value: 'd', enabled: false, description: "Switch branches while throwing away uncommitted working-tree changes; those edits are lost. Same flag as 'git checkout --force'; neither the plain 'git checkout' key nor the path-scoped 'git checkout -- <path>' key grants it." },
          'git clean -f': { value: 'd', enabled: false, description: 'Force-delete untracked files from the working tree.' },
          'git commit --amend': { value: 'd', enabled: false, description: "Replace the previous commit with a new one, rewriting it; the original is discarded, and amending an already-pushed commit needs a force-push to publish. Not granted by the plain 'git commit' key." },
          'git filter-branch': { value: 'd', enabled: false, description: 'Rewrite branch history wholesale by applying filters; deprecated and dangerous.' },
          'git push --delete': { value: 'd', enabled: false, description: 'Delete a ref on the remote; removes the branch or tag for everyone.' },
          'git push --force': { value: 'd', enabled: false, description: 'Force-push, overwriting remote history. Use with extreme care.' },
          'git rebase -i': { value: 'd', enabled: false, description: 'Interactive rebase; reorder, squash, edit, or drop commits in local history.' },
          'git reset --hard': { value: 'd', enabled: false, description: 'Reset HEAD and working tree; discards all uncommitted changes.' },
          'git rm': { value: 'd', enabled: false, description: "Remove tracked files from the index AND delete them from the working tree. Refuses on a file with uncommitted modifications; 'git rm -f' and 'git rm --cached' are separate entries and are not granted by this one." },
          'git rm -f': { value: 'd', enabled: false, description: "Force-remove tracked files; deletes them even when they carry uncommitted modifications, so those edits are lost. Strictly more destructive than 'git rm'." },
          'git stash clear': { value: 'd', enabled: false, description: 'Delete every stash entry; the entire stash stack is wiped.' },
          'git stash drop': { value: 'd', enabled: false, description: 'Delete a single stash entry from the stash stack.' },
          'git switch --discard-changes': { value: 'd', enabled: false, description: "Switch branches and throw local modifications away; uncommitted work is silently lost. One flag, three spellings: 'git switch -f', 'git switch --force', and 'git switch --discard-changes' all resolve to this entry and none of them is granted by the plain 'git switch' key." },
          'git switch --merge': { value: 'd', enabled: false, description: "Switch branches and three-way merge local modifications into the destination; a real merge that can leave conflict markers in uncommitted work. Same flag as 'git switch -m'; not granted by the plain 'git switch' key, and reachable even when 'git merge' is disabled." },
          'git switch -C <name>': { value: 'd', enabled: false, description: "Force-create a branch and switch to it; when a branch of that name already exists it is reset onto HEAD and the commits unique to it are dropped. Same flag as 'git switch --force-create'; the plain 'git switch' key covers only the safe lowercase '-c' create form and does not grant this one." },
        },
      },
    },
    isDefault: false,
  },
];
