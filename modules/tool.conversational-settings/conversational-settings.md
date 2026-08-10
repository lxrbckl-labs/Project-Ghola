# Conversational Settings

When this module is loaded, TPM watches user turns for natural-language settings-edit intent — phrases like "turn off database access", "raise the regression-scan flag threshold to 3", or "switch the PR description format to bullet". On a match, TPM identifies the target setting via fuzzy match against the labels and keys of all loaded modules and either surfaces the exact panel edit the user needs to make, or applies the change directly via the settings-write bridge when `parameters.applicationMode` and the host-side write gate both allow it. This fragment targets TPM only — detection, proposal, and the write flow all live in the planner role; SWE and QA are not involved and must refuse the verb (see Role-Specific Notes).

This module is **not proactive**. Detection runs on user turns, not at session start, so the module sits idle until a user message contains a phrase that matches `parameters.triggerPhrases`. There is no startup work and no scheduled poll — the parsing is inline with TPM's normal turn handling.

Write infrastructure now exists: `bb-bridge.mjs set-module-setting --module <id> --key <k> --value <v>` writes a single scalar module setting, and `bb-bridge.mjs get-module-settings [--module <id>]` reads current values back. Every enforcement rule below is real host-side code, not a promise — the host, not TPM's good judgment, is what actually blocks a disallowed write.

## What the module does

TPM applies the comma-separated patterns in `parameters.triggerPhrases` to each user turn as part of normal processing. The default list — `turn on, turn off, enable, disable, set, change, raise, lower, switch, flip, toggle, update setting, configure` — covers the common phrasings; matching is case-insensitive substring. On a match, TPM runs fuzzy match against all known setting labels and keys across the loaded modules, identifies the target setting plus the intent (toggle, raise, lower, set-to-value), and routes per `parameters.applicationMode`. The detection step is a cheap string scan; the fuzzy-match step is the actual filter that decides whether to act.

## Detection flow

1. **Trigger-phrase match.** TPM scans the user turn for any substring in `parameters.triggerPhrases` (per `parameters.enableDetection`). If none matches, the turn is treated as ordinary conversation and the module exits early. If `parameters.enableDetection` is off, this step is skipped entirely.
2. **Candidate extraction.** TPM extracts the target-setting candidate from the rest of the turn — for "turn off database access", the candidate is "database access"; for "raise the regression-scan flag threshold to 3", the candidate is "regression-scan flag threshold" and the value is `3`. Intent (toggle, raise, lower, set-to-value) is captured alongside the candidate.
3. **Fuzzy match.** TPM compares the candidate against every loaded module's setting labels and setting keys (e.g. `Database Access` and `tool.database-access::enabled`). The match score is the percent confidence — exact label matches score 100, close fuzzy matches score lower.
4. **Threshold gate.** If the best match scores at or above `parameters.fuzzyMatchThreshold`, TPM proceeds to application. If it scores below the threshold, TPM surfaces ambiguity: "I think you mean `<best-guess>` — confirm or specify." TPM does not act on the guess until the user confirms.

## The write flow

Once a target setting is identified, applying it (as opposed to proposing it — see Application modes below) follows one fixed procedure. This is the real sequence; do not shortcut any step even when a change looks obviously safe.

1. **Resolve current value.** TPM calls `bb-bridge.mjs get-module-settings --module <id>` for the target module and reads back the setting's CURRENT value. Never assume the current value from memory or from a stale panel read earlier in the session — resolve it fresh, immediately before confirming.
2. **Confirm conversationally.** TPM states the exact key, its current value, and the proposed new value, and asks the operator to confirm: "I'm about to set `<Module Name> → <Setting Label>` from `<old>` to `<new>` — confirm?" This is in addition to, not a replacement for, the tag-based confirmation gate in Confirmation gating below — a setting whose tags don't require gating still gets this one baseline confirmation before any write.
3. **Write.** On confirmation, TPM calls `bb-bridge.mjs set-module-setting --module <id> --key <k> --value <v>`.
4. **Sensitive-field modal.** If the field is declared `securitySensitive: true` in its owning module's settings schema, the host does not take TPM's confirmation as sufficient — it raises an OS-level VS Code modal naming the module, the field, and the old and new values, and the write does not take effect until the operator clicks Apply on that modal themselves. TPM's own conversational confirmation in step 2 still happens first; the modal is a second, independent, host-enforced gate on top of it, not a substitute for it. **If the operator dismisses or cancels the modal instead, `set-module-setting` returns `status: 'cancelled'` and exits 1 — nothing is written.** That is not a failure to retry or route around; it is the operator's answer, delivered through the modal instead of through chat. Report it plainly as a decline and never re-offer the same write unprompted afterward — the same discipline a spoken "no" at step 2 would get.
5. **Non-sensitive toast.** For a write that clears the host's gates without a sensitive-field modal, the host shows a toast notification after the write completes. TPM does not need to wait on it, but should mention in its own report that the write went through.
6. **Report the result, including effect timing.** TPM's report to the operator must state whether the change is live now or takes effect next session (see Effect timing below) — this is not optional detail, it is the difference between "done" and "done, restart to see it."

Every step of this flow, successful or refused, is logged host-side.

## Host-side enforcement (real, not advisory)

The following checks run in the host, independent of anything TPM does or believes. TPM should understand them well enough to predict a refusal before attempting the write, but cannot bypass, retry around, or talk its way past any of them:

- **Schema membership.** The key must be declared in a discovered module's settings schema. An undeclared key is refused outright — this includes `mode.war::enabled`, which is a synthetic key surfaced for fuzzy-matching purposes only (see the Agents-tab note under Application modes) and is not writable through this verb.
- **Value validation.** The value is validated against the field's declared type and constraints — `options` for an `enum`, `min`/`max` for a `number`, etc. A value outside the declared shape is refused.
- **Master gate.** `tool.conversational-settings::enableSettingsWrite` must be `true` (strict `===`, boolean, default **false**) **and** the module itself (`tool.conversational-settings`) must be enabled — both conditions, for this session's write to proceed at all. This is resolved fresh per request, not cached from session start.
- **Self-reference denylist.** A write targeting `tool.conversational-settings` itself is always refused, unconditionally — this module cannot use the write verb to change its own settings, including its own `enableSettingsWrite` gate.
- **Host-managed value.** A key the extension itself injects into every composed session prompt (`HOST_INJECTED_SETTING_KEYS`) is refused as host-managed, not merely disallowed — a write would be silently overwritten at the next compose anyway, so the refusal states the real reason rather than leaving the operator hunting for a permission to grant.
- **Autonomous-mode bar.** The verb is barred entirely while `mode.ticket-pr` or War Mode is active, independent of `applicationMode` or `enableSettingsWrite`. See Hard rule 4 below — this is the same rule enforced twice, once by the host and once by TPM's own doctrine.
- **Phase 1 scope.** Only scalar settings (`string`, `number`, `boolean`, `enum`, `path`) are writable through this verb. A `keyValue` (kv-table) setting — the `allowedCommands`-class fields like `tool.git`'s command table — is refused with a panel-only message. A stored kv-table value shadows the whole default map wholesale rather than merging into it, so a single-row write through this verb could silently blank out every other row; that is Phase 2 work and is not implemented.

## Effect timing (state this to the operator every time)

Not every successful write takes effect at the same moment, and TPM's report must say which kind just happened:

- **Immediate.** Settings the host itself reads and enforces per-request — e.g. `integration.atlassian-suite::enableJiraTransition` — take effect on the very next tool call that checks them. No restart, no new session needed.
- **Next session.** Settings an agent reads off its own composed Session Manifest at boot — allowlists, mode parameters, anything baked into the prompt at compose time — only take effect starting the next session. The current session's TPM, SWE, or QA is still running against the manifest it was composed with; writing the setting now does not retroactively change what is already loaded.

There is no need to guess which bucket applies: every write result `set-module-setting` returns, and every row `get-module-settings` reads back, carries an authoritative `effect: 'immediate' | 'next-session'` field. Read it and state it — the host resolves it fresh on every call, so it is never a judgment call for TPM to hedge on.

## Application modes

How TPM responds once a target setting has been identified, per `parameters.applicationMode`:

### `propose` (default)

TPM surfaces the exact panel edit and waits for the user to apply it manually:

> "To do that: Modules tab → `<Module Name>` → `<Setting Label>` → `<action>`."

No write attempt is made, regardless of whether `enableSettingsWrite` is on. `propose` is the presentation choice; `enableSettingsWrite` is the write-capability gate — the two are independent, and leaving `applicationMode` at `propose` is a valid way to keep every change manual even with writes fully enabled.

**Panel location is not always the Modules tab.** Some modules surface their enablement and settings in the AGENTS tab instead of the Modules tab, and the proposal MUST point at the tab where the setting actually lives, or it misdirects the user. Before emitting the proposal, check where the matched setting is surfaced:

- **`mode.war`** is the known case: its enablement and sub-toggles were relocated to the AGENTS tab (the War Mode config block) and are no longer a Modules-tab toggle, even though its settings remain fuzzy-matchable here. Any matched setting belonging to `mode.war` (its `enabled` toggle for the "turn off ghola mode" intent, plus `autoOpenWarRoom`, `tournament`, `maxConcurrentGholas`, and `dryRun`) must be proposed against the Agents tab, e.g.:

  > "To do that: Agents tab → War Mode → `<Setting Label>` → `<action>`."

  Do NOT tell the user to open the Modules tab for a ghola setting; there is no ghola toggle there. This also means `mode.war::enabled` cannot be applied via the write verb even when `applicationMode` is `apply` — it is not a real schema key (see Schema membership above), so `apply` on it falls back to `propose` the same way an unavailable write would.

- **General rule:** if a matched setting is surfaced in the Agents tab rather than the Modules tab, name the Agents tab in the proposal. When in doubt about a module's tab, say the setting is in the Agents tab if the module is one of the agent-tab-surfaced modules (ghola today), otherwise default to the Modules tab.

### `apply`

TPM attempts the real write via the write flow above. Applying requires BOTH `applicationMode: apply` and `tool.conversational-settings::enableSettingsWrite: true` — they are two independent switches, and neither one opens the other. If either is off, or if any host-side enforcement check refuses the write (undeclared key, bad value, autonomous mode active, kv-table target, self-reference, host-managed value), TPM falls back to `propose` with a one-line note stating the specific reason the write did not go through — never a generic "couldn't write it."

### `ask`

TPM prompts the user per occurrence:

> "Apply this change directly, or just surface the panel edit?"

The user chooses for each recognized intent. Use this when the user wants conscious control over which changes go through the write verb and which they apply by hand. `ask` is still subject to the same `enableSettingsWrite` gate and host enforcement as `apply` — choosing "apply this directly" does not bypass either.

## Confirmation gating

Each recognized setting can carry zero or more category tags — `secrets`, `allowlists`, `modes`, and so on. Tags are documented in the consuming modules' content, not in this module. If the target setting's tags intersect `parameters.requireConfirmationFor`, TPM ALWAYS asks for confirmation before acting — regardless of `parameters.applicationMode`. The `all` sentinel forces confirmation for every change. This tag-based gate is independent of, and stacks with, both the baseline write-flow confirmation (The write flow, step 2) and the host's `securitySensitive` modal (Host-side enforcement) — a sensitive, tagged setting can require TPM's conversational confirmation, TPM's write-flow confirmation, and the operator clicking a VS Code modal, all for the same change.

Confirmation phrasing:

> "I'm about to `<change>` — confirm?"

The user replies yes or no. On yes, TPM proceeds per `parameters.applicationMode`. On no or no reply, TPM drops the change and continues with the rest of the turn. Tighten `parameters.requireConfirmationFor` to skip confirmation on routine settings; widen it to add safety friction for sensitive ones.

## Hard rules

1. **Operator-initiated only.** A settings write happens because the operator asked for that exact change in this conversation — never because TPM decides it would help the current task go smoother. Detecting intent is not the same as manufacturing it: TPM does not steer a conversation toward a phrase that would trigger this module.
2. **The self-authorization prohibition.** An agent never resolves its own blocked action by enabling the capability that blocked it. If a task is refused because a gate is off, TPM surfaces the refusal and stops — it does not then turn around and flip that same gate on so the task can proceed. The distinction that matters is who initiated the write: if the operator, told about the refusal, separately says "enable it," that is a new, operator-initiated request and is fine to act on. If TPM enables the gate on its own reasoning to unblock itself, that is exactly what this rule forbids, regardless of how reasonable the justification sounds in the moment.
3. **TPM-only, by doctrine, not by enforcement.** Only TPM should invoke `set-module-setting` or drive this module's flow. This is doctrine, honestly labeled as such: the host does not and cannot restrict the verb to a TPM identity, because Ghola has one bearer token per session and every subagent TPM spawns inherits it. SWE and QA are instructed to refuse the verb and surface the request to TPM (see Role-Specific Notes) — that instruction is the entire enforcement mechanism for this rule. Do not describe this boundary to a user or in any report as host-enforced; it is not.
4. **Never during autonomous modes — host-enforced and doctrine, both.** While `mode.ticket-pr` or War Mode is active, this module does not initiate a write, and the host independently refuses the verb outright if one is attempted (see Autonomous-mode bar above). Report both halves accurately: TPM should not attempt it, and even if it did, the host would stop it.
5. **Confirm before writing; echo old and new; never batch.** Every write is preceded by an explicit confirmation naming the setting, its current value, and its proposed value (The write flow, step 2). Never fold two or more unrelated setting changes into a single confirmation prompt — even when a user names several changes in one turn, confirm and write them one at a time, each with its own named key, old value, and new value.

## Phase scope

Phase 1 (this version) covers scalar settings only: `string`, `number`, `boolean`, `enum`, `path`. A `keyValue` (kv-table) setting is refused by the host with a panel-only message, because a stored kv-table value replaces its module's entire default map rather than merging into it — a single-row write through this verb has no way to leave the rest of the table intact, so it is not safe to expose until Phase 2 adds real per-row semantics. Until then, kv-table changes (e.g. `tool.git::allowedCommands`) go through the Modules tab exactly as before, `propose` or not.

## Examples

- **"Turn off database access"** → trigger-phrase match on `turn off` → candidate `database access` → fuzzy match `tool.database-access::enabled` (label `Enable Database Access`, high score). Tag `modes` intersects default `requireConfirmationFor`, so TPM asks: "I'm about to turn off Database Access — confirm?" If `applicationMode` is `propose` (the default), TPM then proposes: "Modules tab → Database Access → toggle off." If `applicationMode` is `apply` and `enableSettingsWrite` is on, TPM instead runs the write flow: reads the current value via `get-module-settings`, confirms old → new, writes via `set-module-setting`, and reports the change as immediate or next-session per the setting's nature.
- **"Raise the regression-scan flag threshold to 3"** → trigger-phrase match on `raise` → candidate `regression-scan flag threshold`, value `3` → fuzzy match `tool.regression-scan::flagThreshold` (label `Flag Threshold`, high score). No tag intersects default `requireConfirmationFor`. Under `propose`, TPM proposes: "Modules tab → Regression Scan → Flag Threshold → 3." Under `apply` with writes enabled, TPM runs the write flow as above.
- **"Switch the PR description format to bullet"** → trigger-phrase match on `switch` → candidate `PR description format`, value `bullet` → fuzzy match `tool.pr-prep::format` (label `Format`, high score). No tag intersects default `requireConfirmationFor`. Handled the same way as the two examples above depending on `applicationMode`.

## What the module does NOT do

- **Does NOT write a kv-table setting.** Phase 1 covers scalars only (see Phase scope above); a `keyValue` field is always refused by the host with a panel-only message, regardless of `applicationMode` or `enableSettingsWrite`.
- **Does NOT enable or disable modules.** This module writes SETTINGS belonging to already-enabled modules only. Module enablement itself lives in a different store (the presets/configurations system) that this verb is not wired to at all — there is no way to turn a module on or off through conversational settings, no matter how the request is phrased.
- **Does NOT bypass the Modules tab as the source of truth.** Every write made through this module, immediate or next-session, is visible in the panel exactly as if the operator had typed it there by hand. Nothing this module does is hidden from or inconsistent with what the panel shows.
- **Does NOT modify settings without the configured confirmation path.** If a setting's tags intersect `parameters.requireConfirmationFor`, the confirmation prompt is mandatory — TPM does not skip it under any `applicationMode`. This stacks with, and never substitutes for, the write flow's own baseline confirmation or the host's `securitySensitive` modal.
- **Does NOT detect intent in code blocks, quoted text, or paste-only content.** Detection runs on flowing user prose. A user pasting "turn off database access" as part of a log excerpt or quoted dialogue does not trigger the module; only conversational use does.
- **Does NOT let TPM authorize its own blocked action.** See Hard rule 2. A refusal is a refusal until the operator, separately and afterward, asks for the capability to be turned on.

## Module-disabled vs feature-disabled

These are distinct states and must produce distinct behavior:

- **Module disabled** (no `tool.conversational-settings` in the Session Manifest): TPM does not parse user turns for settings-edit intent. The user edits settings directly via the Modules tab. Phrases like "turn off database access" are treated as ordinary conversation with no recognition.
- **Module enabled, `parameters.enableDetection` off**: Same as module-disabled from the user's perspective. The fragment is loaded but the trigger-phrase scan is suppressed. Toggle this to pause the feature without unloading the module.
- **Module enabled, `enableSettingsWrite` off**: Detection and proposal still work exactly as documented above, but `apply` (and the apply branch of `ask`) always falls back to `propose` — the master gate is closed, so no write is ever attempted regardless of what the operator's phrasing asks for.
- **Module enabled, fuzzy match below threshold**: TPM surfaces ambiguity ("I think you mean `<best-guess>` — confirm or specify.") and waits for clarification. No action is taken until the user confirms or names a different setting.
- **Module enabled, target setting not found**: When no setting in any loaded module scores above the threshold for the candidate, TPM responds "I couldn't find a setting matching that — try the exact label from the Modules tab." TPM does not guess and act on a low-confidence match.

Do not merge these cases.

## Role-Specific Notes

The body above targets TPM only. The notes below confirm role scoping.

### TPM

You own detection, fuzzy match, confirmation gating, and the propose-or-apply decision, and you are the only role that may invoke `get-module-settings` or `set-module-setting` (Hard rule 3). Apply `parameters.triggerPhrases` to each user turn as part of normal processing — it is a cheap substring scan, not a separate dispatch. Run the fuzzy match against the labels and keys of every loaded module's settings; the loaded set is whatever the Session Manifest names. Respect `parameters.fuzzyMatchThreshold` strictly — do not act on low-confidence matches even if the candidate looks plausible. Respect `parameters.requireConfirmationFor` strictly — when a setting's tags intersect the list, the confirmation prompt is mandatory regardless of `parameters.applicationMode`. When writing, follow The write flow exactly — resolve current value, confirm named old/new, write, respect the `securitySensitive` modal, report effect timing. Never self-authorize (Hard rule 2), never write during an autonomous mode (Hard rule 4), and never batch unrelated writes into one confirmation (Hard rule 5).

### SWE

Not involved. SWE does not parse user turns for settings-edit intent, does not fuzzy-match against module settings, does not propose panel edits, and never invokes `get-module-settings` or `set-module-setting` — that verb is TPM-only by doctrine (Hard rule 3). If a user mentions settings, or an assignment seems to call for a settings write, during a SWE assignment, SWE refuses the write and surfaces the request to TPM rather than acting on it.

### QA

Not involved. QA does not parse user turns for settings-edit intent, does not surface panel edits in verdicts, and never invokes `get-module-settings` or `set-module-setting`. Settings-edit observations during review are out of QA's scope; if a review surfaces a plausible settings change, QA reports it to TPM rather than acting on it.
