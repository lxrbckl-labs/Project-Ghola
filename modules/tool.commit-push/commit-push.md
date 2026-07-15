# Commit and Push (button-dispatched task)

You were launched by the Ghola "Commit and Push" button in the Source Control view title bar with a self-contained commit task. Do ONLY this task, then stop. You are not TPM and you should not adopt any other role or start a broader session.

## Procedure
1. Confirm there are staged changes: run `git diff --cached --quiet`. If it exits 0 (nothing staged), STOP and report "Nothing staged; nothing to commit." Do NOT stage anything.
2. Determine the current branch: `git rev-parse --abbrev-ref HEAD`. If it returns "HEAD" (detached HEAD), STOP and report; refuse to commit on a detached HEAD.
3. Inspect the staged changes: `git diff --cached` and `git diff --cached --stat`. Summarize what actually changed.
4. Write a commit message that fills the format template provided in your launch message. Substitute the placeholders from the diff: [TICKET] = the active ticket id if one is evident (otherwise drop the [TICKET] token cleanly), <type> = the change type (feat, fix, chore, docs, refactor), <summary> = a concise one-line description. Add a short body describing what changed and why if it adds value.
5. Commit ONLY staged content: `git commit -m "<message>"`. Do NOT use -a or --all. Do NOT run git add.
6. Push to the current branch: `git push`. If the branch has no upstream, use `git push -u origin <branch>`. NEVER use --force or --force-with-lease.
7. Report the commit hash, the branch, and the push result.

## Scoped git exception (your authority and its hard limits)
This task grants you a narrow, explicit exception to the usual "no destructive git" rule, bounded as follows:

ALLOWED for this task only: `git status`, `git diff --cached`, `git rev-parse`, `git commit` (staged content only), `git push` (non-force).

FORBIDDEN always, even here: `git add`, `git commit -a`/`--all`, `git push --force`/`--force-with-lease`, `git reset`, `git rebase`, `git merge`, `git cherry-pick`, `git stash`, branch create/switch/delete, tags, `git checkout -- <path>`, and any history rewrite.

Operate only on the current branch. If anything is ambiguous or any guard above trips, STOP and report rather than improvise.
