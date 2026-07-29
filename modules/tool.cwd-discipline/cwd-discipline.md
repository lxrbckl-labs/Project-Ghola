# Cwd Discipline

When this module is loaded, the session has a single project-wide convention for keeping agents inside the user's current working directory. The rule was previously inlined as a universal hard rule in each of the cores (TPM, SWE, QA); this module promotes the convention to a configurable policy so the exception set, redirect handling, and mode-binding behavior can be tuned per project. Every agent reads this same fragment; TPM owns enforcement at the orchestration layer, and SWE and QA inherit the same posture when they read or write paths directly.

This module is **not proactive**. It does not fire at session start. The rule applies on-demand, exactly when an agent is about to read, write, edit, or delete a path. Without an in-flight file operation, this module sits quietly.

## The core rule

Agents stay in cwd. Reads, writes, edits, and deletes all default to the user's `cwd` (the working directory the session was launched from, or the directory the user has redirected to mid-session). Any operation on a path outside cwd is refused unless one of the documented exceptions below applies. The check is per-operation — not per-task and not per-assignment — so an agent that needs to touch two out-of-cwd paths must clear both individually.

The refusal message names the cwd and the attempted path so the user can see what was blocked: "Refused: `<attempted-path>` is outside cwd `<cwd>` and no exception matches. Add the path to Allowed Exception Paths, redirect the session, or disable Enforce Discipline in the Modules tab."

## Exception categories

There are four categories of exception. An operation that matches ANY of them is permitted; the categories do not stack and do not conflict.

### `allowedExceptionPaths`

`parameters.allowedExceptionPaths` is a user-managed map of absolute paths or path patterns to one-line rationales. An operation whose target path matches any enabled entry proceeds without challenge. The rationale is panel-only metadata — it is not passed to the agent and is not surfaced to the user during the operation — its purpose is to remind the user later why each exception was added so the list does not grow stale.

The seeded defaults authorize exactly what an enabled baseline module already requires, and nothing more:

- **The Obsidian vault** — `${tool.obsidian-notes:vaultPath}/**` and `${GHOLA_VAULT}/**`. Two keys, one directory: `tool.obsidian-notes` mandates the writes and its `vaultPath` parameter is the authoritative source, while `GHOLA_VAULT` is the host-native translation the launcher exports. The two spellings can differ across the WSL boundary, and `GHOLA_VAULT` is additionally absent whenever an operator has set `GHOLA_LEDGER_ROOT` (the launcher exports the vault only when the ledger resolved *through* it) — so keying on the parameter alone or on the env var alone leaves a live vault unauthorized. Both entries no-op when their source is unset, which is the correct behavior for a session with no vault.
- **The installed extension's module content** — `${GHOLA_ROOT}/modules/**`, **read-only**. This is the read-on-demand contract itself: every `contentPath` in the Session Manifest lives here, so every agent reads out of cwd on every module consult.
- **The bundled helper scripts** — `${GHOLA_ROOT}/scripts/**`, **execute and read only**. `tool.ghola-ledger` requires `node "$GHOLA_ROOT/scripts/ghola.mjs"`, the Bitbucket/Jira paths require `bb-bridge.mjs`, and `tool.session-bootstrap` runs `ghola-boot-probe.sh`. No module asks an agent to *write* under `${GHOLA_ROOT}`, and none may: that directory is the installed extension, editing it is self-modification, and Ghola's own source work happens in the work repo (cwd) instead. Treat a write under `${GHOLA_ROOT}` as refused even though these two entries would match the path.
- **The feedback log** — `${tool.feedback-log:feedbackFilePath}`, a single file (not a glob). `tool.feedback-log` injects this path from the extension's global storage and instructs TPM to write it with the `Write` tool.

Add project-specific exceptions as you encounter them; remove any seed whose module you do not run. Two things deliberately have no seed: Ghola's module settings live in VS Code's global/workspace state rather than in a settings file, and its credentials live in VS Code `SecretStorage` rather than in a secrets file — neither is a path, so neither needs an exception. The one secret-bearing *file* in a Ghola session is the bridge coordinates file at `GHOLA_BRIDGE_FILE`; it is denied outright by `tool.secrets-wrapper-pattern` and reached only through `bb-bridge.mjs`, so it must never be added here.

### Verbal redirect

Per `parameters.onRedirectMidSession`, the user can verbally redirect the session to a different path mid-session ("let's look at /other/path", "switch to ~/other-repo for a minute"). The new path becomes in-scope for the remainder of the session and is treated as the effective cwd for the operation in flight and every subsequent operation. The redirect is session-scoped — it does not persist across sessions and it does not modify `parameters.allowedExceptionPaths`. See "Redirect handling" below for the per-mode semantics.

### Mode bindings

Per `parameters.treatModeBindingsAsExceptions`, an active session mode that binds the agent to a specific path implicitly extends cwd discipline to include the bound path. `mode.cd` binds to a project directory at session start; `mode.support` pivots between mapped app paths during a support session. When the parameter is on, the bound path is treated as a transparent exception for the duration of the mode; when off, the user must add each mode-bound path to `parameters.allowedExceptionPaths` manually.

### Read-only git

Read-only git commands (`status`, `diff`, `log`, `blame`, `show`) are always permitted regardless of cwd discipline. They are informational, not state-changing, and the cwd rule is about preventing inadvertent state changes outside the user's intended scope. State-changing git commands remain governed by `tool.git` and the universal hard rules; this exception is for the read-only subset only.

## Path-pattern matching

`parameters.allowedExceptionPaths` keys may be written in any of four forms; the matching rule is whichever applies:

- **Absolute paths** (e.g. `/home/user/projects/shared-config`): matched verbatim against the operation's target path. A directory entry matches operations on the directory itself, not its contents — use a glob for recursive coverage.
- **Glob patterns** (e.g. `${GHOLA_ROOT}/scripts/**`): matched as a standard glob. `**` matches any depth; `*` matches a single path segment.
- **Environment variable references** (e.g. `${GHOLA_VAULT}`): expanded at runtime before matching. The expanded value is then itself treated as an absolute path or a glob per the rules above. An unset variable expands to the empty string and the entry is treated as a no-op for that operation.
- **Module-parameter references** (e.g. `${tool.obsidian-notes:vaultPath}`): `${<module-id>:<parameterName>}`, expanded from the named module's `parameters` block in your Session Manifest, which you already hold. The expanded value is then treated as an absolute path or a glob per the rules above. A module that is not in the manifest, a parameter that is not listed, and an empty parameter value all expand to the empty string, so the entry is a no-op — exactly like an unset environment variable. Use this form when the authoritative source for a path is a module setting rather than an env var; an entry keyed on an env var Ghola does not export is silently dead, which is how a mandated out-of-cwd write ends up with no resolvable authorization.

Both expanding forms fail CLOSED: they can only ever be a no-op, never a wildcard. An entry that expands to the empty string authorizes nothing and the operation falls through to the ordinary refusal.

No regex support in v0.1. If a user-supplied entry contains regex metacharacters they are matched literally (or as glob wildcards where applicable), not as regex.

## Redirect handling

Per `parameters.onRedirectMidSession`, TPM responds to a verbal redirect in one of three ways:

- **`accept`** (default): silent acceptance — the new path is in-scope for the remainder of the session and the operation in flight proceeds. This matches the existing universal posture and is the lowest-friction option.
- **`confirm`**: TPM responds "Redirecting to `<path>` — this is outside cwd. Confirm to proceed." and waits for user confirmation before treating the new path as in-scope. Once confirmed, the redirect is silent for the remainder of the session.
- **`refuse`**: TPM responds "Cwd discipline blocks the redirect. Disable the rule in the Modules tab or add the path to Allowed Exception Paths." and does not proceed. The user must disable `parameters.enforceDiscipline`, add the target to `parameters.allowedExceptionPaths`, or accept the refusal.

The choice between the three is the user's call. `accept` is the existing default; `confirm` adds one round-trip of friction in exchange for visibility; `refuse` is the strictest and is appropriate only when the project policy is that out-of-cwd work requires an explicit Modules-tab change.

## Relationship to existing module sections

The cwd discipline was previously inlined in the cores — TPM's, SWE's, and QA's universal hard rules each restated some form of "stay in the user's cwd." With this module loaded:

- The cores' inline rules become AUTHORITATIVE-RECEIVER for the policy this module defines — they cite this module rather than restating the rule. TPM uses this module's exact settings (`parameters.enforceDiscipline`, `parameters.allowedExceptionPaths`, `parameters.onRedirectMidSession`, `parameters.treatModeBindingsAsExceptions`) in preference to anything the cores say inline.
- When this module is DISABLED, the cores' inline rules act as the fallback — they restate the rule independently so the discipline is not lost when this module is missing.
- When this module is ENABLED, the cores' inline rules defer to this module's exact settings.

This module does NOT modify the cores; the deference is by convention. TPM checks for this module's presence in the Session Manifest and uses its policy in preference to the inlined fallbacks. Future cleanup work may prune the inline rules once this module is the established norm, but that is a separate concern — the inline rules stay in place as the safety net until then.

The cores' inline fallback is intentionally narrower than this module's full policy — when this module is disabled, only the basic cwd guard plus read-only git remains; the verbal-redirect, mode-binding, and allowedExceptionPaths exception categories require this module to be loaded.

## Module-disabled vs feature-disabled

These are distinct states and must produce distinct behavior:

- **Module disabled** (no `tool.cwd-discipline` in the Session Manifest): the cores' inline cwd hard rules act as the fallback. Strict cwd by default; exceptions are whatever each core inlines (typically Obsidian writes, settings writes, and verbal redirects, restated per-core).
- **Module enabled, `parameters.enforceDiscipline` off**: agents may freely read/write any path the OS permits. The exception list is moot, redirect handling is moot, mode bindings are moot — every operation proceeds. NOT recommended outside controlled environments.
- **Module enabled, exception path matches**: the operation proceeds without challenge. No prompt, no confirmation, no log entry by default.
- **Module enabled, no exception matches, no redirect in flight**: the operation is refused with a message naming the cwd and the attempted path. The user can add the path to `parameters.allowedExceptionPaths`, redirect the session verbally (subject to `parameters.onRedirectMidSession`), or disable the rule.

Do not merge these cases.

## Role-Specific Notes

The body above applies identically to every agent. The notes below are short framings for how each role uses the policy.

### TPM

You orchestrate cwd discipline. Before dispatching any SWE or QA assignment that involves an out-of-cwd path, verify the path matches an entry in `parameters.allowedExceptionPaths`, or activate the relevant redirect or mode-binding so the SWE / QA does not hit a refusal mid-task. Surface refusals to the user clearly: name the attempted path, name the cwd, and offer the three resolutions (add an exception, redirect, disable the rule). When `parameters.enforceDiscipline` is off, surface that to the user once when the first operation runs ("Cwd discipline is off — agents may freely access any path. Modules tab to re-enable.") so the posture is visible.

### SWE

You operate in cwd by default. If TPM's assignment names a path outside cwd, treat that as authorized by TPM — an exception, redirect, or mode binding has been resolved upstream and you do not need to re-check the policy at your level. If you find yourself wanting to touch an out-of-cwd path that is NOT named in your assignment (for example, a config file in a sibling repo that would make the task easier), surface to TPM rather than acting unilaterally. The cwd rule is per-operation, and silent compliance with an unnamed out-of-cwd touch defeats the discipline.

### QA

Same framing as SWE. Your review scope follows cwd by default — if a finding requires examining a file outside cwd, treat that as a TPM-resolved authorization the same way SWE does. If you spot that a SWE touched an out-of-cwd path that was not named in their assignment and not covered by an exception, surface that in the verdict as a discipline finding regardless of how clean the change itself was — the cwd rule exists precisely to catch that pattern, and a clean code change does not redeem a violated scope boundary.
