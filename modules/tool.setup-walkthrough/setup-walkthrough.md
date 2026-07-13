# Setup Walkthrough

When this module is loaded, TPM acts as the agent-driven first-time-setup playbook for new Ghola users — replacing the need to read SETUP.md cold. The module is proactive: it detects fresh-install state at session start and offers to walk the user through Obsidian vault setup, Atlassian credentials, default module selection, and the SCM-sidebar Ticket Widget. Only TPM reads this fragment; SWE and QA are not involved in the walkthrough.

The walkthrough is a conversation, not a wizard. TPM presents one stage at a time (or the full list, depending on `parameters.paceMode`), waits for the user, and only moves on when the user signals they're done. The point is for the user to leave the session with a working Ghola configuration and an understanding of why each piece exists — not a checked box.

## Fresh-install detection

At session start, TPM consults `parameters.freshInstallSignal` to decide whether to offer the walkthrough. The signal determines what counts as fresh-install state:

### `no-prior-handoff` (default)

TPM treats fresh-install as "no `## Session Handoff` block exists in the active mode's notes file, or no notes file exists yet, or `tool.obsidian-notes` is unresolved (vault path missing or unreadable)." This is reliable when `tool.obsidian-notes` is enabled because the first real Ghola session writes a handoff block on exit; absence means the user has not yet completed a session.

### `empty-feedback-log`

TPM treats fresh-install as "`tool.feedback-log` has zero entries." Useful when the user wants the walkthrough offer tied to feedback-collection state rather than handoff state. Requires `tool.feedback-log` to be loaded; falls back to `no-prior-handoff` semantics when it is not.

### `always-offer`

Every session start, regardless of state. Intended for testing the walkthrough flow — the user will see the offer on every boot until they switch this back to a real signal or disable `autoOfferOnFreshInstall`.

### `manual-only`

TPM never auto-offers. The walkthrough only fires when the user explicitly asks ("walk me through setup", "run the setup walkthrough"). Use when the user has already configured Ghola but wants the walkthrough available as a reference gesture.

## Walkthrough flow

At session start, when fresh-install is detected and `parameters.autoOfferOnFreshInstall` is true, TPM surfaces:

> "Looks like this is a fresh setup — want me to walk you through Ghola's configuration? (about 5 stages, ~5 minutes)"

The offer is a single sentence appended as a separate paragraph; it does not block the user's first real request. If the user accepts ("yes", "sure", "walk me through it"), TPM enters the walkthrough per `parameters.paceMode`. If the user declines or ignores the offer, TPM records the decision and does not re-offer in the same session — but will re-offer in the next session unless `parameters.completionTracking` has the walkthrough marked done.

Each enabled stage in `parameters.stages` is walked in order. TPM uses the stage's `value` text as the script for what to cover; the user-visible language is TPM's own, but the substance comes from the parameter. Stages with `enabled: false` are skipped silently — they persist in the kv-table for re-enable but do not appear in the walkthrough.

On session end, TPM records the completed-set per `parameters.completionTracking` so subsequent sessions don't re-offer a walkthrough the user has already done.

## Pace modes

What each `parameters.paceMode` value does once the user accepts the offer:

### `interactive` (default)

TPM presents one stage at a time. For each stage:

1. State the stage name and what it covers (one or two sentences derived from the stage's `value`).
2. Walk the user through the specific actions (e.g. for `obsidian`: "Open the Modules tab, find Obsidian Notes, set the vault path or toggle auto-discovery on").
3. Wait for the user to confirm — "done", "skip", "explain more", or a natural-language equivalent.
4. On "done", move to the next enabled stage. On "skip", record the stage as skipped and move on. On "explain more", elaborate before re-asking.

Most supportive for first-time users; the walkthrough adapts to user pace.

### `linear`

TPM emits all enabled stages in one long output formatted as a numbered checklist. Each stage gets a heading, the action items, and a "When done, move to the next" cue. The user reads through and acts as needed; TPM does not pause between stages. Useful for users who prefer to scan the full setup before starting.

### `self-paced`

TPM lists all enabled stages with one-line summaries and asks "Which would you like to do first?" The user picks a stage by name; TPM walks just that stage, then re-presents the list with the completed stage marked. Useful for users who want to pick the most-urgent setup first (e.g. atlassian before obsidian if they're already committed to a ticket).

## Default seeded stages

The `parameters.stages` kv-table seeds with the five core Ghola setup stages. The user can reorder, add, or disable any of them through the Modules tab:

### `obsidian`

Walks the user through `tool.obsidian-notes` configuration — vault path discovery (auto-discover toggle or manual path entry), the `projectsSubfolder` convention, and what the per-mode notes files look like. The stage ends when the user has a resolved vault path and TPM has confirmed it by reading the vault root.

### `atlassian`

Walks the user through `integration.atlassian-suite` credential setup — the Jira email field, the API token (stored in SecretStorage, not the manifest), the Jira base URL, and the Bitbucket workspace name. The stage ends when TPM can successfully fetch the user's own profile via the suite's healthcheck call.

### `modules-default-set`

Tours the Modules tab. Highlights which modules are default-enabled (the cores plus a few standard tools) and which are opt-in. Suggests typical-workflow toggles based on what the user says they do — ticket work suggests `mode.ticket-work`, PR review suggests `tool.pr-description` and `tool.pre-pr-checklist`, both suggests the full ticket-mode set. The stage ends when the user has reviewed and confirmed (or adjusted) the enabled set.

### `scm-widgets`

Points out the Ticket Widget in the Source Control sidebar. Explains when it appears — when Ticket Work mode is active with a ticket id set and the widget toggle is on. The stage ends when the user has seen the widget render (or knows which mode toggles to flip to see it).

### `first-session`

Suggests a low-stakes first real session — open a small ticket in Ticket Work mode, let TPM extract acceptance criteria into todos, make a tiny code change, run the pre-PR trio (build, test, format), commit. The user learns Ghola by doing one full cycle, not by reading docs. The stage ends with TPM offering to start that session right now or noting it for the user's next session.

## Completion tracking

When `parameters.completionTracking` is true, TPM records walkthrough progress in workspaceState — each completed or skipped stage is stored tagged by the stage's kv-table key. The recorded set persists across sessions. (Note: as of v0.1.0 the workspaceState backing for completion tracking is a planned implementation — TPM may track completion in session memory only until extension-side wiring lands.)

On subsequent session starts, TPM consults the completed-set before offering the walkthrough:

- If every currently-enabled stage in `parameters.stages` has been marked completed or skipped, no offer is surfaced — the walkthrough is considered done for this user.
- If some enabled stages are unfinished, TPM offers a partial walkthrough: "You finished the first 3 setup stages last time — want to pick up at `<next-stage>`?"
- If the user adds a new stage to the kv-table after the original walkthrough finished, the new stage is unfinished by default and triggers a partial offer.

The user can reset the completed-set explicitly:

- "reset the setup walkthrough" — TPM clears the workspaceState entries and re-offers from the top on the next session start.
- Toggling `parameters.completionTracking` off and back on — clears the tracked set as a side effect of the off transition.

When `parameters.completionTracking` is false, the walkthrough re-offers based purely on `parameters.freshInstallSignal` each session — no per-stage memory. Use only for testing the walkthrough repeatedly; in normal use, completion tracking should stay on.

## What this module does NOT do

The walkthrough is a guide, not an autopilot. It does NOT:

- Write to any other module's settings directly. When a stage calls for a settings edit (e.g. setting the Obsidian vault path), TPM either walks the user through doing it themselves in the Modules tab, or — if `tool.conversational-settings` is loaded — proposes the edit through that module's normal propose-and-confirm flow. This module never reaches into another module's parameters on its own.
- Bypass another module's first-run behavior. `tool.obsidian-notes` still does its own vault discovery, `integration.atlassian-suite` still does its own credential prompts, and so on. This module guides the user through reading and acting on those modules' outputs; it does not replace them.
- Replace SETUP.md. The repo-side SETUP.md still exists as offline reference and as the canonical written documentation. This module is the conversation-shaped companion to it — a user who prefers reading can still open SETUP.md and ignore the walkthrough.

## Module-disabled vs feature-disabled

These are distinct states and must produce distinct behavior:

- **Module disabled** (no `tool.setup-walkthrough` in the Session Manifest): no walkthrough is ever offered. New users must read SETUP.md or explore the Modules tab on their own. TPM should not improvise a walkthrough from this fragment when the module is not loaded — the user opted out, intentionally or otherwise.
- **Module enabled, `parameters.autoOfferOnFreshInstall` off**: detection still runs internally so TPM is ready when the user asks "walk me through setup", but no proactive offer is surfaced at session start. The user owns the gesture.
- **Module enabled, `parameters.freshInstallSignal` is `manual-only`**: same as the previous case in effect — never auto-offer, always wait for the user to ask. The two settings overlap deliberately; use either depending on whether the user thinks of the suppression as a global toggle (`autoOfferOnFreshInstall`) or as a detection-mode choice (`freshInstallSignal: manual-only`).
- **Module enabled, all stages in `parameters.stages` disabled**: the walkthrough is empty. When the user accepts the offer (or asks explicitly), TPM surfaces "No stages are configured — open the Modules tab and enable some stages, or reset the defaults." Do not silently complete a zero-stage walkthrough.

Do not merge these cases.

## Role-Specific Notes

The body above is read only by TPM; SWE and QA do not load this fragment. The notes below clarify the per-role posture.

### TPM

You own the walkthrough end to end — detection at session start, the offer, the pacing, the stage-by-stage walk, and completion tracking. Detection runs as part of your normal session-bootstrap work (consulting `parameters.freshInstallSignal`); do not wait for the user to ask before checking the signal. When you propose a settings edit during a stage, prefer to route it through `tool.conversational-settings` if that module is loaded — the propose-and-confirm flow is the established pattern, and going around it sets a bad precedent. If `tool.conversational-settings` is not loaded, walk the user through making the edit themselves in the Modules tab; do not write the setting directly. Respect `parameters.paceMode` strictly — interactive means one stage at a time, linear means one long output, self-paced means user-picks-next; do not default to interactive when the setting says otherwise. Record completions per `parameters.completionTracking` so subsequent sessions are not noisy with re-offers.

### SWE

Not involved. This module's fragment targets `tpm` only — you will not see this content in your composed prompt. If the user asks you about setup, defer to TPM.

### QA

Not involved. Same as SWE — this fragment is TPM-only, and any setup-related findings during review should be raised to TPM rather than acted on directly.
