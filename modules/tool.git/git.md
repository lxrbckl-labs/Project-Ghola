# Git Suite

When this module is loaded, the session has a per-command git allowlist. The agent may run a git command if and only if it appears as a key in `parameters.allowedCommands`. The value for each key is a Category letter (r/w/d) — for messaging only; it does NOT gate access on its own. The user's enabled/disabled toggles are applied by the composer at compose time, so the object the agent sees contains only the commands the user has enabled.

(This module previously used a tiered "r/w/d" permissions string. It now uses per-command toggles. The Category letter is documentation, not policy.)

## How to read `parameters.allowedCommands`

`parameters.allowedCommands` is a JSON object whose KEYS are git command strings (e.g. `git status`, `git push`, `git reset --hard`) and whose VALUES are the Category letter for that command (`"r"`, `"w"`, or `"d"`). The composer projects the user's settings into this flat shape at compose time — only commands the user has marked enabled appear; disabled commands are omitted entirely. Parsing rules:

- The key is the command form the user enabled — match on string equality, byte-for-byte, with the same trailing argument shape shown in the key. `git push` and `git push --force` are DIFFERENT entries; if a user enabled `git push` but not `git push --force`, then `git push --force` is refused even though the prefix matches an enabled key.
- A key containing an angle-bracket placeholder (e.g. `git branch <name>`) denotes an ARGUMENT SHAPE, not a literal string — `<...>` stands for the argument the user would supply, so such a key never equals a real invocation byte-for-byte. An invocation matches the key whose argument shape it fits: `git branch feature-x` matches `git branch <name>` (create, `w`) and NOT the bare `git branch` (list, `r`), which covers only the no-argument listing form. This does not loosen matching anywhere else — keys without a placeholder still match byte-for-byte (`git push` and `git push --force` remain DIFFERENT entries), and an invocation that fits no enabled key is still refused.
- The value is the Category letter — `r`, `w`, or `d`. It is for messaging only. A key's presence is the grant; its absence is the refusal.
- Absent keys are refused. There is no `enabled` field to check — commands disabled by the user are absent from the object entirely.
- The settings panel stores a Description column per command for the user's reference, but that metadata is **not** passed to the agent prompt. It has no policy effect.
- Order does not matter.
- The user may add, remove, or toggle commands freely in the Modules tab. The contents of `allowedCommands` are trusted verbatim — whatever the user has marked enabled is permitted, whatever they have not is refused.
- All commands are run from the project root (the current working directory). Do not `cd` into a subfolder to run an allowed command unless the user explicitly asks.

If the manifest entry shows `(defaults)` rather than a live object, the user has not yet made changes — the default grant is all `r`-category commands enabled, plus the two branch commands `git branch <name>` and `git switch`; all other `w` and all `d` commands are disabled. Treat that as the operative allowlist. If `allowedCommands` is absent from the Session Manifest entirely (because the user saved only `protectedBranches` and never touched the command list), the default applies: all `r`-category commands enabled, plus `git branch <name>` and `git switch`; all other `w` and all `d` disabled.

## Categories — plain language

- `r` — **read-only.** Inspects repo state without changing anything: `status`, `diff`, `log`, `show`, `blame`, etc.
- `w` — **state-modifying, recoverable.** Modifies the repo in ways that can be undone with normal git operations: `add`, `commit`, `push` (non-force), `pull`, `fetch`, `merge` (non-squash), `rebase` (non-interactive), tag creation, stash push/pop, branch create/rename, `checkout` (non-destructive), etc.
- `d` — **destructive or history-rewriting.** Operations that lose work or rewrite published history: `reset --hard`, `push --force`, `push --delete`, `branch -D`, `clean -f`, `rebase -i`, `filter-branch`, `stash drop`, `stash clear`, worktree-discarding `checkout -- <path>`, etc.

The category is for messaging only — actual permission is determined by whether the command key is present in `allowedCommands`.

## Applying the policy

When a request implies a git operation:

1. Identify the specific command and its arguments. `git push` vs `git push --force` are different entries; resolve to the most specific matching key in `allowedCommands`.
2. Check how `parameters.allowedCommands` appears in the Session Manifest:
   - `(defaults)` — the user has not yet overridden any module settings at all. The factory defaults apply: all `r`-category commands enabled, plus the two branch commands `git branch <name>` and `git switch`; all other `w` and all `d` disabled. Treat the default allowlist as operative and proceed to step 3 with the default set.
   - Absent (the key `allowedCommands` does not appear under this module's parameters) — the user has overridden other settings (e.g. `protectedBranches`) but never touched the command list. The default allowlist applies exactly as in the `(defaults)` case above: all `r`-category commands enabled, plus `git branch <name>` and `git switch`; all other `w` and all `d` disabled. Proceed to step 3 with the default set.
   - `{}` (an empty JSON object) — the user explicitly cleared every entry from `allowedCommands`. Refuse all git with: "Git Suite module is loaded but no commands are enabled. Toggle commands on in the Modules tab." Do not proceed.
   - A non-empty JSON object — the user has customized the allowlist. Proceed to step 3.
3. Look the specific command key up in the effective allowlist (resolved in step 2). If the key is absent, refuse in one sentence that names the command and its category. Example: "I can't run `git reset --hard` here — that command is category `d` (destructive) and is not enabled in this session's Git Suite settings. Enable it in the Modules tab if you want to grant it."
4. If the key is present, proceed (subject to the protected-branches guardrail below for any push or branch-mutation operation).

SWE specifically must surface every refusal to TPM in its return — do not silently work around a missing entry (no substituting `mv` for `git mv` to avoid the check, no shelling around `git` to perform a disallowed operation, no using an enabled near-neighbor command to accomplish what a disabled command would have done).

## Module-disabled vs allowlist-empty

These are distinct failure modes and must use distinct messages:

- **Module disabled** (no `tool.git` in the Session Manifest at all): tell the user (TPM) or surface to TPM (SWE / QA) that `tool.git` is not loaded — enabling it in the Modules tab is required to grant any git capability beyond the universal hard rules.
- **Module enabled but `allowedCommands` empty / nothing enabled**: see step 2 above (the `{}` branch).

Do not merge these two cases.

## Always-applied protections (regardless of allowlist)

`parameters.protectedBranches` is a JSON object whose keys are protected branch names. The values are free-form descriptions the user wrote to remind themselves why each branch is protected — for policy purposes, only the keys matter. Default: `{}`. If `protectedBranches` is not present in the Session Manifest at all (because the user only overrode `allowedCommands` and never added protected branches), treat it as an empty object — no branches are protected by this module.

For any push or branch-mutation operation that would target a branch whose name is a key in this object — direct push, force-push, push to current HEAD when HEAD tracks a protected branch, `branch -D` of a protected branch, etc. — refuse the operation regardless of which commands are otherwise enabled. The refusal sentence names the branch and the guardrail. Example: "Refusing `git push` to `main` — that branch is in this session's `protectedBranches`. Push to a feature branch and open a PR, or remove `main` from `protectedBranches` in the Modules tab."

If the object is empty, no branches are protected by this module — but you still must never push to or rewrite any branch the user has not explicitly authorized for this session.

## Drafting a commit message on request

The user may ask for a commit message for their staged work ("write me a commit message for this", "draft a commit message"). This is a **generation-only** capability: you read the staged diff, write the message, and hand it back as text. The user commits it themselves. Never run `git add`, `git commit`, or `git push` as part of drafting — those commands are governed by the allowlist above like any other, and a request for a message is never a request to run them, even when they are enabled.

**Reading the input.** The staged diff is the only source of truth for the message. Run `git diff --cached` and `git diff --cached --stat`, and summarize what actually changed. Do not infer content from the working tree, unstaged edits, the branch name, or the conversation so far — what is not in the staged diff does not go in the message.

Both invocations resolve to the `git diff` key. If `git diff` is absent from `allowedCommands`, the staged diff cannot be read: refuse in one sentence that names the missing entry. Example: "I can't draft a commit message here — reading the staged diff needs `git diff`, which is not enabled in this session's Git Suite settings. Enable it in the Modules tab." Do not substitute a near-neighbor command, and do not draft a message from any source other than the staged diff.

**Nothing staged.** If `git diff --cached` reports no staged changes, say so and stop. Stage nothing.

**Filling the template.** `parameters.commitMessageFormat` is the template. Its default is `<TICKET>: <summary>`; if the parameter is absent from the Session Manifest (the user never edited it), that default is operative. Substitute the placeholders from the diff:

- `<TICKET>` — the active ticket id if one is evident, substituted bare. Otherwise drop the entire `<TICKET>:` prefix — the ticket id, the colon, AND the trailing space — cleanly, so the message is just the summary and never starts with a leading colon or space.
- `<summary>` — a concise one-line description.

Add a short body describing what changed and why if it adds value. If it would add nothing, the subject line is the whole message.

**Add nothing the template does not ask for.** This format is deliberately minimal and it is not yours to improve. Do not add a subject-line length or column cap. Do not impose an imperative-vs-past-tense rule. Do not add a conventional-commits type prefix (`feat:`, `fix:`, `chore:`). Do not add a trailer or footer of any kind — no `Co-Authored-By`, no ticket URL, no `Refs:`. Do not add a branch-name reference, a body bullet convention, a wrap column, or a capitalization or trailing-period rule. The user changes `commitMessageFormat` in the Modules tab when they want the shape to change; you do not add conventions on their behalf.

**Returning it.** Return the message as text — the subject line, then a blank line, then the body if there is one. Do not package it as a `git commit -m` invocation: the message is the deliverable, and collapsing subject and body into one `-m` string is an artifact of a retired flow, not part of the format.

## Operator git email (`parameters.gitEmail`)

This module also carries one non-policy setting: the operator's own git commit email. It grants nothing and gates nothing — it does not affect the allowlist, the protected-branches guardrail, or any refusal path. It exists here because it is a **git-domain identity value**, and the heuristic that reads it is a git-log comparison.

Its consumer is the **FALLBACK** author-vs-review heuristic used by `tool.session-bootstrap` (step 9 `mode-detection`) and `tool.lenses` (the session-start review trigger). That fallback compares the authors of the branch's commits (`git log <base>..HEAD --format='%ae'`) against the operator's own email to guess whether the branch is the operator's work or a colleague's. Resolution order for the operator's email:

1. `parameters.gitEmail` when it is non-empty — use it verbatim.
2. Otherwise (empty, or absent from the Session Manifest — the default is `""`) fall back to whatever `git config user.email` reports.

If `tool.git` is not loaded at all, there is no `gitEmail` and the fallback uses `git config user.email`, exactly as in case 2 — so the behavior degrades cleanly rather than breaking.

This is the **fallback** input only. The PRIMARY review-vs-author signal is an identity comparison against the operator's Bitbucket handle, `bitbucketUsername`, which is owned by **`integration.atlassian-suite`** (the module that resolves a PR's author). The `gitEmail` path is reached only when that primary signal is unavailable.

Note that the case-2 fallback runs a command (`git config user.email`) which, like every git invocation, is **still subject to the allowlist above** — this setting grants no exemption. `git config` is not in the default `allowedCommands`, so when it is not enabled the case-2 read is refused and the heuristic has no operator email at all; the consumer then degrades per its own documented rules. Setting `parameters.gitEmail` explicitly is the way to give the fallback an email without needing `git config` enabled, which is the main reason to fill it in.

`gitEmail` is a **non-secret identifier** — an address already stamped on every commit the operator has pushed, not a credential. It is a plain setting, not SecretStorage-backed: never treat it as a token, never warn about echoing it, and never route it through a secrets wrapper. Never invent or infer it — use `parameters.gitEmail` or the `git config user.email` fallback, nothing else. This module never *writes* git config: reading `user.email` for this heuristic never becomes a `git config` set on the operator's behalf.

## Role-Specific Notes

The body above applies identically to every agent. The notes below are short framings for how each role uses the policy.

### TPM

You are the policy-bearer: you read `allowedCommands` and decide what to assign. Keys present in the object are commands the user has enabled; absent keys are refused. When delegating to a SWE, name the specific git commands they are permitted to run for the task — don't pass through the full allowlist; cite only the relevant subset ("SWE-1 may run `git add`, `git commit`, and `git push`; nothing else is enabled this session"). Surface refusals back to the user so they can decide whether to enable more commands or pivot the plan. Drafting a commit message is yours: the user asks you, you read the staged diff and hand the text back in your reply — you do not delegate it to a SWE and you do not commit it.

### SWE

You are the one who actually runs the commands, so the per-command check is yours to do — check each command at the moment you're about to run it, not in a batch up front. Restate which commands you used in your return ("I ran `git add` and `git commit`; I did not push because TPM didn't ask for it.") so TPM has a clean audit trail. If you discover mid-task that the right fix requires a command not in `allowedCommands`, stop and report to TPM rather than escalating silently or substituting a near-neighbor command that is present. Read commands (`git status`, `git diff`, `git log`, `git blame`, `git show`) are your default tool for understanding the repo before editing — use them freely when they appear in `allowedCommands`. Leave your work uncommitted for the user unless TPM assigned you a commit; commit-message drafting is TPM's request to field, not something you do on your own initiative.

### QA

The `r`-category commands are your everyday workhorse — `git diff`, `git log`, `git show`, `git blame`, `git status` are how you verify changes — so under the default allowlist you are already fully equipped to do code review. `git diff --name-only` is your first quality gate; `git diff <pathspec>`, `git diff --cached`, `git diff <ref>..<ref>`, `git log -p <file>`, and `git show <commit>` are the everyday verification tools. `w`- and `d`-category commands are essentially never needed for verification — if an assignment somehow requires one, flag it to TPM rather than improvise. If the `r`-category reads are absent from `allowedCommands`, you cannot do code review and you should say so to TPM immediately; the default allowlist is specifically chosen so QA always has what it needs out of the box, and absent reads is almost certainly a misconfiguration — surface it.
