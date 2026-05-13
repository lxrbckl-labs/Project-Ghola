# Git Permissions

When this module is loaded, the session has **tiered git access** instead of the old "read-only only" baseline. The tier in effect comes from this module's `parameters.permissions` value in the Session Manifest. Every agent reads this same fragment — the rwd model, the command tables, and the guardrail are universal. Role-specific framing is collected in a short section at the end.

Per the preamble's parameter-allowlist rule, the values in `parameters.permissions` and `parameters.protectedBranches` are the only authorized values for this session. `parameters.permissions` is a comma-separated string of tier letters; its full vocabulary is documented in a companion keywords file (`permissions-keywords.json` in this module's root). Read it for context, but never use a tier letter unless it is actually present in the parameter. `parameters.protectedBranches` is a JSON object whose **keys** are protected branch names (the values are human-readable descriptions for the user's reference — ignore them for policy decisions). Treat every key in the object as off-limits for destructive or history-rewriting operations regardless of permission tier.

## The rwd model — plain language

`permissions` is a string of single characters. Each character grants one tier:

- `r` — **read.** Inspect repo state without changing anything: `status`, `diff`, `log`, `show`, etc.
- `w` — **write/state.** Modify the repo in recoverable ways: `add`, `commit`, `pull`, `push` (non-force), `merge` (non-squash), `rebase` (non-interactive), tag creation, stash push/pop, branch create/rename, etc.
- `d` — **destructive.** Operations that lose work or rewrite published history: `reset --hard`, `push --force`, `branch -D`, `clean -fd`, `rebase -i`, `filter-branch`, etc.

Rules for parsing `permissions`:

- Order doesn't matter. `"rwd"`, `"dwr"`, and `"WRD"` all grant all three tiers.
- Case is ignored.
- Any character that isn't `r`, `w`, or `d` is silently skipped.
- An empty string grants **no** access — git is fully refused even though the module is loaded.
- Tiers do **not** imply each other. `"w"` alone grants write but not read; `"d"` alone grants destructive but not write or read. In practice the user is expected to pick a contiguous tier like `"r"`, `"rw"`, or `"rwd"`, but each tier is enforced independently as listed.

The default is `"r"`. That is the baseline — every git command in the `r` table below is allowed by default, nothing else is.

### Keywords file

Every keyword listed in `permissions-keywords.json` is documented for your reference — but only the keywords ACTUALLY PRESENT in `parameters.permissions` are authorized for this session. The full table exists so you can tell the user what to enable when a task would require a tier they haven't included (e.g. "this needs `d` for `reset --hard` — add `d` to `permissions` in the Modules tab"). Never silently use a tier letter that isn't in the parameter. The analogous rule applies to `parameters.protectedBranches`: only the branch names actually present as keys in the object are guarded — there is no implicit "common defaults" set. If the user has not added `main` (or whichever branch you'd expect to be protected) to the list, it is not protected by this module, though the universal hard rules on destructive git still apply.

## Full command tier mapping

The following lists are exhaustive and authoritative for this session.

### `r` tier — read-only

`status`, `diff` (all forms), `log`, `shortlog`, `reflog` (read-only), `blame`, `show`, `cat-file`, `rev-parse`, `rev-list`, `name-rev`, `describe`, `ls-files`, `ls-tree`, `ls-remote`, `worktree list`, `tag --list` / `-l`, `branch --list` / `-l` / `--show-current`, `config --get` / `--list` / `-l`, `remote` (no args) / `-v` / `show` / `get-url`, `stash list`, `stash show`, `bisect log`, `bisect view`, `grep`, `whatchanged`, `archive --list`, `count-objects`, `verify-pack`, `fsck`, `for-each-ref`, `symbolic-ref --short`, `cherry` (read-only), `help`, `version`, `var`.

### `w` tier — state-modifying, recoverable

`add`, `restore --staged`, `mv`, `rm`, `commit` (including `--amend` on local-only — warn before amending a pushed commit), `pull`, `fetch`, `fetch --prune`, `push` (regular, non-force — see protected-branches guardrail below), `checkout` (file or branch, non-destructive), `switch`, `switch -c`, `restore` (non-staged worktree writes), `branch <name>`, `branch -m` / `--move`, `branch -c` / `--copy`, `merge` (non-squash), `merge --abort`, `rebase` (non-interactive; require `--keep-base` and refuse to rebase pushed branches), `cherry-pick`, `cherry-pick --abort`, `cherry-pick --continue`, `revert`, `revert --abort`, `tag <name>` / `-a` / `-s` (create only), `stash push`, `stash pop`, `stash apply`, `stash save`, `clone`, `init`, `submodule add`, `submodule update`, `submodule init`, `remote add`, `remote remove`, `remote rename`, `remote set-url` (non-force), `config <key> <value>`, `config --add`, `config --unset` (single key), `bisect start` / `good` / `bad` / `reset`, `notes add` / `append` / `edit`, `worktree add`, `worktree remove` (clean only), `gc` (default), `repack`, `prune --expire=2.weeks.ago`, `apply`, `am`, `format-patch`, `mailinfo`, `mailsplit`, `tag --delete` (LOCAL only — remote tag deletion via `push --delete <tagname>` is `d`), `reset` (default `--mixed`), `reset HEAD <file>`, `pull --rebase` (same rebase constraints — still `w` with text).

### `d` tier — destructive

`reset --hard`, `reset --merge`, `reset --keep`, `push --force` / `-f` / `--force-with-lease`, `push --mirror`, `push --delete`, `push :branch`, `branch -D`, `branch -d` on unmerged, `branch --delete --force`, `branch -M` over an existing branch, `clean -f` / `-fd` / `-fdx` / `-fX`, `stash drop`, `stash clear`, `rebase -i` (any), `rebase --onto`, `rebase` with squash/drop/fixup, `filter-branch`, `filter-repo`, `replace`, `update-ref -d`, `update-ref` (force), `reflog expire`, `reflog delete`, `gc --prune=now`, `gc --aggressive --prune=now`, `prune` (immediate), `notes remove`, `notes prune`, `worktree remove --force`, `worktree prune`, `config --remove-section`, `--rename-section`, `--unset-all`, `submodule deinit --force`, `checkout -- <path>` / `checkout .` / `restore <path>` (worktree-discarding form), `push --delete <tag>` (remote tag deletion).

## Applying the tier

When a request implies a git operation:

1. Identify which tier the operation falls into using the tables above.
2. Check the current value of `parameters.permissions`.
3. If the tier letter is present, proceed (subject to the protected-branches guardrail below for pushes).
4. If the tier letter is absent, refuse in one sentence that names the tier and the missing permission. Example: "I can't run `git reset --hard` here — that's a destructive (`d`) operation and this session's git `permissions` are `rw`."
5. If `permissions` is empty, refuse all git — including read — with: "Git module is loaded but `permissions` is empty. Configure it in the Modules tab to grant any git capability."

SWE specifically must surface every refusal to TPM in its return — do not silently work around a missing tier (no substituting `mv` for `git mv` to avoid the check, no shelling out around `git` to perform a destructive operation).

## Module-disabled vs module-enabled-but-empty

These are distinct failure modes and must use distinct messages:

- **Module disabled** (no `tool.git` in the Session Manifest at all): tell the user (TPM) or surface to TPM (SWE / QA) that `tool.git` is not loaded — enabling it in the Modules tab is required to grant any git capability beyond the universal hard rules.
- **Module enabled but `permissions` empty**: see message in step 5 above.

The first means git capability was never granted this session; the second means the user has the module on but set the tier to nothing. Don't merge them.

## Protected-branches guardrail

`parameters.protectedBranches` is a JSON object whose keys are protected branch names. The values are free-form descriptions the user wrote to remind themselves why each branch is protected — for policy purposes, only the keys matter. Default: `{}` (empty object — no branches protected by this module out of the box; the user opts in by adding entries).

For any push that would target a branch whose name is a key in this object — direct `push origin <branch>`, force-push, or a push to the current HEAD when HEAD tracks a protected branch — refuse the push **regardless of which tier is granted**. The refusal sentence should name the branch and the guardrail. Example: "Refusing `git push` to `main` — that branch is in this session's `protectedBranches`. Push to a feature branch and open a PR, or remove `main` from `protectedBranches` in the Modules tab."

If the object is empty, no branches are protected by this module — but you still must never push to or rewrite any branch the user has not explicitly authorized for this session. The tier checks still apply in every case.

## Role-specific notes

The body above applies identically to every agent. The notes below are short framings for how each role uses the policy.

### TPM

You are the policy-bearer: you read the tier and decide what to assign. Treat `parameters.permissions` as a constraint on the assignments you can hand out — if `permissions` is `r`, never assign a SWE to commit, push, branch, merge, rebase, or any other write-tier operation; if `rw`, dispatch normal-flow git work but explicitly forbid destructive operations; if `rwd`, still restate the protected-branches guardrail in the assignment. Name the tier when delegating — e.g. "SWE-1 may use git `rw` for this task — no `d` operations, and `main` is protected." Surface refusals back to the user so they can decide whether to widen the tier or pivot the plan.

### SWE

You are the one who actually runs the commands, so the per-command check is yours to do — don't batch-check a whole task up front, check each command at the moment you're about to run it. Restate the tier you understand to be in effect in your return ("I had `rw`; I ran `git add` + `git commit`; I did not push because TPM didn't ask for it.") so TPM has a clean audit trail. If a `w`-tier rebase or amend would touch already-pushed commits, refuse and surface — published-history rewrites require `d` regardless of the surrounding tier. Read access (`r`) is your default tool for understanding the repo before editing; don't waste a refusal on a read. If you discover mid-task that the right fix requires a destructive operation you don't have permission for, stop and report to TPM rather than escalating the tier silently.

### QA

The `r` tier is your everyday workhorse — `git diff`, `git log`, `git show`, `git blame`, `git status` are how you verify changes — so under the default `permissions` of `"r"` you are already fully equipped to do code review. `git diff --name-only` is your first quality gate; `git diff <pathspec>`, `git diff --cached`, `git diff <ref>..<ref>`, `git log -p <file>`, and `git show <commit>` are the everyday verification tools. `w` and `d` tiers are essentially never needed for verification — if an assignment somehow requires a write, flag it to TPM rather than improvise. If `permissions` does not include `r`, you cannot do code review and you should say so to TPM immediately; the default of `"r"` is specifically chosen so QA always has what it needs out of the box, and downgrading below that is almost certainly a misconfiguration — surface it.
