# Mid-Session Bootstrap

When this module is loaded, TPM watches the conversation for ticket-id references in user turns and offers to retroactively activate ticket-work-mode behaviors when one appears. The module is the conversation-watcher for sessions that began ad-hoc but turned out to be ticket-bound — it lets the user opt into the Jira pull, the per-ticket notes file, and (optionally) the cross-ticket discipline without restarting the session. Every agent reads this same fragment; TPM owns detection and the bootstrap, and role-specific framing for SWE and QA is collected at the end.

This module is **not proactive**. Detection runs on user turns, not at session start, so the module sits idle until a user message contains something that matches `parameters.detectionPattern`. There is no startup work and no scheduled poll — the parsing is inline with TPM's normal turn handling.

## What the module does

TPM applies `parameters.detectionPattern` to each user turn as part of normal processing. The default pattern `[A-Z][A-Z0-9]+-\d+` matches the conventional project-key-plus-number shape (e.g. `CMMS-5412`, `PROJ-123`); custom patterns can be set in the Modules tab for teams with non-standard ticket formats. On the first match in an unscoped session, and per `parameters.autoOfferOnFirstMention`, TPM offers:

> "Looks like this relates to `<TICKET-ID>`. Want me to pull the ticket and set up notes?"

If the user accepts, TPM runs the bootstrap per `parameters.bootstrapScope` (see "Bootstrap scopes" below). If the user declines, TPM records the decision and does not re-offer for the same ticket id in the same session. If the user ignores the offer, TPM treats it as declined for that turn but may re-offer on a later mention of the same id (the offer is per-mention, the suppression is per-acceptance-or-explicit-decline).

The offer itself is a single sentence and never blocks the user's actual request — TPM still answers whatever the user asked about, with the offer appended as a separate paragraph.

## Bootstrap scopes

What each `parameters.bootstrapScope` value does when the user accepts the offer:

### `full` (default)

- Sets the active ticket id to the detected value in session memory. Does NOT update `mode.ticket-work::ticketId` in settings — that is a settings write the user does deliberately through the Modules tab, not a side effect of a bootstrap.
- Pulls the ticket via `integration.atlassian-suite`'s `getTicketDetails(<id>)` helper. Captures the summary, status, and description for the announcement and the notes file.
- Sets up the per-ticket notes file at `<vault>/<Project>/<TicketNumber>.md` via `tool.obsidian-notes`. If the file does not exist, creates it with `mode.ticket-work`'s `notesSections` default (or the value configured there, if `mode.ticket-work` is loaded).
- Surfaces any prior handoff via `tool.session-handoff` — reads the most-recent `## Session Handoff` block in the notes file and includes a summary in the announcement.
- Activates cross-ticket discipline for the remainder of the session — uses `mode.ticket-work`'s `crossTicketStrictness` setting if `mode.ticket-work` is loaded, or `ask` as the internal default if it is not.
- Announces: "Bootstrapped to `<TICKET-ID>`: `<summary>`. Notes at `<path>`."

### `notes-only`

- Pulls the ticket via `getTicketDetails` and sets up the per-ticket notes file (same as `full` for the Jira pull and the file creation).
- Does NOT enforce cross-ticket discipline — the user can still discuss other tickets without TPM challenging the references. The notes file exists for context continuity, but the session is not bound to the ticket.
- Announces: "Pulled `<TICKET-ID>` and set up notes. No scope binding."

### `lookup-only`

- Pulls the ticket via `getTicketDetails` to surface context.
- Does NOT write to any notes file — the file is neither created nor read.
- Does NOT change session scope — no cross-ticket discipline, no binding, no further behavior change for the rest of the session.
- Announces: "Looked up `<TICKET-ID>`: `<summary>`."

## Detection gates

TPM does NOT offer the bootstrap when any of the following apply:

- `parameters.skipWhenTicketModeActive` is true AND `mode.ticket-work` is enabled with a ticket id set. The user is already in a ticket session and the bootstrap would be redundant or scope-changing; the silent skip is the right behavior.
- `parameters.skipWhenCdModeActive` is true AND `mode.cd` is enabled (the user is in a directory-bound session; activating ticket-work behaviors mid-session would conflict with mode.cd's redirect discipline).
- The same ticket id has been offered (and accepted or declined) earlier in the same session. One offer per ticket id per session — re-mentions of an already-resolved id do not re-trigger.
- `parameters.autoOfferOnFirstMention` is false. Detection still runs internally so the user can ask "bootstrap me to that ticket" and TPM has the matched id ready, but no proactive offer is surfaced.
- The ticket id matches a known false-positive pattern the user has flagged. Not implemented in v0.1 — placeholder for a future enhancement where users can teach TPM that, e.g., `LOG4J-2` in their stack-trace conversations is not a Jira ticket.

When all gates pass, the offer is surfaced per the format in "What the module does".

## Cross-ticket bootstrap

When a SECOND distinct ticket id appears in a user turn after a prior bootstrap in the same session, TPM's response depends on `parameters.crossTicketBootstrap`:

### `ask` (default)

TPM responds:

> "Earlier we bootstrapped to `<PREV-TICKET>`. Looks like you mentioned `<NEW-TICKET>` — switch to it, or just look at it briefly?"

Three user responses TPM should recognize:

- **switch** (or equivalent — "yes, switch", "let's move to it", "make it the active ticket") — re-bootstrap as `full` to the new ticket. The previous ticket's scope is abandoned for this session.
- **look** (or equivalent — "just look", "quick look", "for context only") — run the new mention as `lookup-only`. The previous ticket remains the active scope.
- **ignore** (or equivalent — "no", "skip it", "never mind") — no action. The previous ticket remains the active scope and no Jira pull happens for the new mention.

### `switch`

TPM immediately re-bootstraps `full` to the new ticket without asking. The previous ticket's scope is abandoned. Surface: "Switched session scope from `<PREV-TICKET>` to `<NEW-TICKET>`." Tightens to this setting for users who routinely hop between tickets and find the `ask` prompt redundant.

### `ignore`

TPM silently skips the new mention. No offer, no announcement, no Jira pull. The previous ticket remains the active scope. Use this for users who reference other tickets in conversation frequently as cross-references but never want a mid-session re-bootstrap.

## Dependency chain

This module composes several others. Each dependency is required for some bootstrap scopes and optional for others.

- **`integration.atlassian-suite`** — required for `full`, `notes-only`, and `lookup-only`. All three scopes rely on the Jira pull for the ticket summary and status. When this integration is disabled or absent, TPM surfaces "Atlassian Suite is not loaded — cannot pull `<TICKET-ID>`. Set up the suite to enable mid-session bootstrap." and offers no fallback. The bootstrap is refused for this turn.
- **`tool.obsidian-notes`** — required for `full` and `notes-only`. Needed for the per-ticket notes file location and creation. When this tool is disabled, TPM offers to fall back to `lookup-only` mode for this bootstrap: "Obsidian Notes is not loaded — I can pull the ticket for context but cannot set up notes. Proceed as lookup-only?" If the user accepts, the bootstrap runs as `lookup-only`; if not, it is skipped entirely.
- **`mode.ticket-work`** — optional. Its settings inform `full`-scope behavior (specifically `crossTicketStrictness` and `notesSections`). When this mode is disabled, `full` scope still works but uses internal defaults — `ask` for cross-ticket strictness, and the same default `notesSections` value documented in `mode.ticket-work`'s manifest.
- **`tool.session-handoff`** — optional. Surfaces any prior handoff in the notes file as part of the `full`-scope announcement. When this module is disabled, the bootstrap skips the resume-surfacing step; the notes file is still created or read, but no `## Session Handoff` summary is included in the announcement.

## Module-disabled vs feature-disabled

These are distinct states and must produce distinct behavior:

- **Module disabled** (no `tool.mid-session-bootstrap` in the Session Manifest): TPM does NOT parse user turns for ticket ids. The user must manually configure `mode.ticket-work` and start a new session if they want ticket scope. Mid-session ticket references are treated as normal conversation with no offer.
- **Module enabled, `parameters.autoOfferOnFirstMention` off**: Detection still runs internally so the user can ask "bootstrap me to that ticket" and TPM has the matched id ready, but TPM does not proactively offer. The user owns the gesture.
- **Module enabled, `parameters.skipWhenTicketModeActive` on and ticket mode active**: Detection runs but the offer is silently suppressed, as documented in "Detection gates". The user can still ask explicitly, in which case TPM proceeds (the gate suppresses the auto-offer, not the user's explicit request).
- **Module enabled, all dependencies missing**: TPM still responds to detected ids — but with "I see `<TICKET-ID>` but the Atlassian Suite is not loaded — can't bootstrap." Do not silently fail; the user needs to know the offer would have fired but cannot.

Do not merge these cases.

## Role-Specific Notes

The body above applies identically to every agent. The notes below are short framings for how each role uses the policy.

### TPM

You own detection, the bootstrap offer, and the actual setup. Apply `parameters.detectionPattern` to each user turn as part of your normal processing — it is a cheap regex match, not a separate dispatch. Respect the gates per the "Detection gates" section: skip when ticket mode is active and `parameters.skipWhenTicketModeActive` is on, skip when the same id has already been offered this session, and skip the proactive offer when `parameters.autoOfferOnFirstMention` is off. When a bootstrap fires, you do the Jira pull via `integration.atlassian-suite`'s `getTicketDetails`, you do the notes setup via `tool.obsidian-notes`, and you do the announcement. You do NOT delegate detection to SWE — the regex match is yours, not a SWE task. When the cross-ticket-bootstrap path triggers, follow `parameters.crossTicketBootstrap` strictly: do not default to `ask` when the setting says `switch`, and do not default to `switch` when the setting says `ignore`. The whole point of the setting is the user's chosen friction level.

### SWE

You may receive assignments where the work repo's scope has SHIFTED mid-session due to a bootstrap that the user opted into. When TPM dispatches you in a post-bootstrap session, your assignment will explicitly mention the active ticket id; treat it as a fresh ticket session for scope purposes — your scope is that ticket only, the same way it would be in a `mode.ticket-work` session from the start. If your assignment does not mention an active ticket id but you can see ticket ids in the conversation history, do NOT assume one is active — TPM owns the bootstrap decision, and a mention without a bootstrap means the user has not committed to that scope.

### QA

Same as SWE. Your findings scope to the active ticket post-bootstrap, and TPM's assignment will make the active ticket id explicit when one is set. Cross-ticket observations during review are flagged to TPM in your verdict, not annotated into the active ticket's notes file — TPM decides whether they belong elsewhere. If you see a ticket id in the conversation that was never bootstrapped, do not treat it as in-scope; the bootstrap is the gate, not the mention.
