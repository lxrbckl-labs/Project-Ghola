# Conversational Settings

When this module is loaded, TPM watches user turns for natural-language settings-edit intent — phrases like "turn off database access", "raise the regression-scan flag threshold to 3", or "switch the PR description format to bullet". On a match, TPM identifies the target setting via fuzzy match against the labels and keys of all loaded modules and either surfaces the exact panel edit the user needs to make or applies the change directly when write infrastructure is available. This fragment targets TPM only — detection and proposal live in the planner role; SWE and QA are not involved.

This module is **not proactive**. Detection runs on user turns, not at session start, so the module sits idle until a user message contains a phrase that matches `parameters.triggerPhrases`. There is no startup work and no scheduled poll — the parsing is inline with TPM's normal turn handling.

Write infrastructure (an MCP settings-write tool or a panel-side message bridge) is forthcoming. Until it lands, the current behavior is propose-only by default — TPM tells the user the exact panel edit to make, and the user applies it via the Modules tab. When the write API lands, this module's content can be updated to apply changes directly under `apply` mode without further manifest changes.

## What the module does

TPM applies the comma-separated patterns in `parameters.triggerPhrases` to each user turn as part of normal processing. The default list — `turn on, turn off, enable, disable, set, change, raise, lower, switch, flip, toggle, update setting, configure` — covers the common phrasings; matching is case-insensitive substring. On a match, TPM runs fuzzy match against all known setting labels and keys across the loaded modules, identifies the target setting plus the intent (toggle, raise, lower, set-to-value), and routes per `parameters.applicationMode`. The detection step is a cheap string scan; the fuzzy-match step is the actual filter that decides whether to act.

## Detection flow

1. **Trigger-phrase match.** TPM scans the user turn for any substring in `parameters.triggerPhrases` (per `parameters.enableDetection`). If none matches, the turn is treated as ordinary conversation and the module exits early. If `parameters.enableDetection` is off, this step is skipped entirely.
2. **Candidate extraction.** TPM extracts the target-setting candidate from the rest of the turn — for "turn off database access", the candidate is "database access"; for "raise the regression-scan flag threshold to 3", the candidate is "regression-scan flag threshold" and the value is `3`. Intent (toggle, raise, lower, set-to-value) is captured alongside the candidate.
3. **Fuzzy match.** TPM compares the candidate against every loaded module's setting labels and setting keys (e.g. `Database Access` and `tool.database-access::enabled`). The match score is the percent confidence — exact label matches score 100, close fuzzy matches score lower.
4. **Threshold gate.** If the best match scores at or above `parameters.fuzzyMatchThreshold`, TPM proceeds to application. If it scores below the threshold, TPM surfaces ambiguity: "I think you mean `<best-guess>` — confirm or specify." TPM does not act on the guess until the user confirms.

## Application modes

How TPM responds once a target setting has been identified, per `parameters.applicationMode`:

### `propose` (default)

TPM surfaces the exact panel edit and waits for the user to apply it manually:

> "To do that: Modules tab → `<Module Name>` → `<Setting Label>` → `<action>`."

No write attempt is made. This is the current default because the settings-write API does not exist yet — every recognized change becomes a proposal the user follows by hand.

**Panel location is not always the Modules tab.** Some modules surface their enablement and settings in the AGENTS tab instead of the Modules tab, and the proposal MUST point at the tab where the setting actually lives, or it misdirects the user. Before emitting the proposal, check where the matched setting is surfaced:

- **`mode.war`** is the known case: its enablement and sub-toggles were relocated to the AGENTS tab (the War Mode config block) and are no longer a Modules-tab toggle, even though its settings remain fuzzy-matchable here. Any matched setting belonging to `mode.war` (its `enabled` toggle for the "turn off ghola mode" intent, plus `autoOpenWarRoom`, `tournament`, `maxConcurrentGholas`, and `dryRun`) must be proposed against the Agents tab, e.g.:

  > "To do that: Agents tab → War Mode → `<Setting Label>` → `<action>`."

  Do NOT tell the user to open the Modules tab for a ghola setting; there is no ghola toggle there.

- **General rule:** if a matched setting is surfaced in the Agents tab rather than the Modules tab, name the Agents tab in the proposal. When in doubt about a module's tab, say the setting is in the Agents tab if the module is one of the agent-tab-surfaced modules (ghola today), otherwise default to the Modules tab.

### `apply`

TPM attempts to apply the change via the future settings-write API. If the API is unavailable (today's state), TPM falls back to `propose` with a one-line note: "Settings-write infrastructure isn't loaded yet — surfacing the panel edit instead." When the write API lands, the fallback line disappears and the apply path becomes a direct write.

### `ask`

TPM prompts the user per occurrence:

> "Apply this change directly, or just surface the panel edit?"

The user chooses for each recognized intent. Use this when the user wants conscious control over which changes go through the write API and which they apply by hand.

## Confirmation gating

Each recognized setting can carry zero or more category tags — `secrets`, `allowlists`, `modes`, and so on. Tags are documented in the consuming modules' content, not in this module. If the target setting's tags intersect `parameters.requireConfirmationFor`, TPM ALWAYS asks for confirmation before acting — regardless of `parameters.applicationMode`. The `all` sentinel forces confirmation for every change.

Confirmation phrasing:

> "I'm about to `<change>` — confirm?"

The user replies yes or no. On yes, TPM proceeds per `parameters.applicationMode`. On no or no reply, TPM drops the change and continues with the rest of the turn. Tighten `parameters.requireConfirmationFor` to skip confirmation on routine settings; widen it to add safety friction for sensitive ones.

## Examples

- **"Turn off database access"** → trigger-phrase match on `turn off` → candidate `database access` → fuzzy match `tool.database-access::enabled` (label `Enable Database Access`, high score). Tag `modes` intersects default `requireConfirmationFor`, so TPM asks: "I'm about to turn off Database Access — confirm?" On confirm, TPM proposes: "Modules tab → Database Access → toggle off."
- **"Raise the regression-scan flag threshold to 3"** → trigger-phrase match on `raise` → candidate `regression-scan flag threshold`, value `3` → fuzzy match `tool.regression-scan::flagThreshold` (label `Flag Threshold`, high score). No tag intersects default `requireConfirmationFor`. TPM proposes: "Modules tab → Regression Scan → Flag Threshold → 3."
- **"Switch the PR description format to bullet"** → trigger-phrase match on `switch` → candidate `PR description format`, value `bullet` → fuzzy match `tool.pr-description::format` (label `Format`, high score). No tag intersects default `requireConfirmationFor`. TPM proposes: "Modules tab → PR Description → Format → bullet."

## What the module does NOT do

- **Does NOT write to any setting today.** Write infrastructure is pending. Every change is SURFACED for the user to apply via the Modules tab. The `apply` mode is forward-compatible plumbing; it falls back to `propose` until the write API lands.
- **Does NOT modify settings without the configured confirmation path.** If a setting's tags intersect `parameters.requireConfirmationFor`, the confirmation prompt is mandatory — TPM does not skip it under any `applicationMode`.
- **Does NOT detect intent in code blocks, quoted text, or paste-only content.** Detection runs on flowing user prose. A user pasting "turn off database access" as part of a log excerpt or quoted dialogue does not trigger the module; only conversational use does.

## Module-disabled vs feature-disabled

These are distinct states and must produce distinct behavior:

- **Module disabled** (no `tool.conversational-settings` in the Session Manifest): TPM does not parse user turns for settings-edit intent. The user edits settings directly via the Modules tab. Phrases like "turn off database access" are treated as ordinary conversation with no recognition.
- **Module enabled, `parameters.enableDetection` off**: Same as module-disabled from the user's perspective. The fragment is loaded but the trigger-phrase scan is suppressed. Toggle this to pause the feature without unloading the module.
- **Module enabled, fuzzy match below threshold**: TPM surfaces ambiguity ("I think you mean `<best-guess>` — confirm or specify.") and waits for clarification. No action is taken until the user confirms or names a different setting.
- **Module enabled, target setting not found**: When no setting in any loaded module scores above the threshold for the candidate, TPM responds "I couldn't find a setting matching that — try the exact label from the Modules tab." TPM does not guess and act on a low-confidence match.

Do not merge these cases.

## Role-Specific Notes

The body above targets TPM only. The notes below confirm role scoping.

### TPM

You own detection, fuzzy match, confirmation gating, and the propose-or-apply decision. Apply `parameters.triggerPhrases` to each user turn as part of normal processing — it is a cheap substring scan, not a separate dispatch. Run the fuzzy match against the labels and keys of every loaded module's settings; the loaded set is whatever the Session Manifest names. Respect `parameters.fuzzyMatchThreshold` strictly — do not act on low-confidence matches even if the candidate looks plausible. Respect `parameters.requireConfirmationFor` strictly — when a setting's tags intersect the list, the confirmation prompt is mandatory regardless of `parameters.applicationMode`. You do NOT write settings yourself today — write infrastructure is pending. The `propose` path is the default and the `apply` path falls back to `propose` until the write API lands; when it lands, this module's content will be updated to enable direct apply.

### SWE

Not involved. SWE does not parse user turns for settings-edit intent, does not fuzzy-match against module settings, and does not propose panel edits. If a user mentions settings during a SWE assignment, the relevant target is TPM, not SWE.

### QA

Not involved. QA does not parse user turns for settings-edit intent and does not surface panel edits in verdicts. Settings-edit observations during review are out of QA's scope.
