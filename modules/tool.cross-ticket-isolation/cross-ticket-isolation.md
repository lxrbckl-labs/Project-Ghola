# Cross-Ticket Isolation

When this module is loaded, the session has a single project-wide convention for handling content whose scope does not match the active ticket. The rule was previously inlined in `mode.ticket-work` (the Cross-ticket discipline section), in `tool.obsidian-notes` (the cross-ticket discussion mention), and in `tool.session-handoff` (the same). This module promotes that convention to a standalone, project-wide policy. Every agent reads this same fragment; TPM owns enforcement, and SWE and QA inherit the same posture when they surface findings that cross ticket boundaries.

This module is **not proactive**. It does not fire at session start. The rule applies on-demand, exactly when TPM is about to write to a per-ticket notes file — at that moment, the scope of the content is checked against the active ticket and the policy below decides what happens. Without an imminent notes write, this module sits quietly.

## The core rule

Cross-ticket discussions stay in session memory only. They are NEVER written to the active ticket's notes file.

The session is bound to a single ticket at a time — whichever ticket the active ticket-scoped mode (`mode.ticket-work` or `mode.ticket-pr`) currently binds, derived from the branch rather than a manual ticket pin (there is no `parameters.ticketId` — no ticket-scoped mode defines one). Rebinding that active ticket — an operator-requested move to a different ticket, such as a queued multi-ticket run advancing to its next ticket — changes which ticket is active; it is not itself a cross-write, and it is governed by the active mode's own rebind rules, not by this module. Every conversational pivot to another ticket — "speaking of CMMS-1234, that reminds me…", "this is similar to the bug we hit in CMMS-9999", "by the way, how is PROJ-42 going?" — is in-session context only. TPM may discuss the other ticket, reference its content, even reason about it for the duration of the message. But none of that discussion is persisted into the active ticket's notes file. The active ticket's notes are for the active ticket's work, and the boundary is total.

This applies regardless of how the cross-ticket content arrived — SWE returns that mention other tickets, user messages that pivot conversationally, QA verdicts that spot a related issue elsewhere. The same isolation rule covers all three sources.

## The exception

A discovery from the active session that genuinely belongs in ANOTHER ticket's notes can be written to THAT ticket's file. This is gated by `parameters.allowCrossTicketNoteWrite`.

Example: while working on TICKET-A, the user mentions a bug in TICKET-B's code path that came up incidentally. TPM may write a standalone note about that bug to TICKET-B's notes file — but never about it into TICKET-A's notes. The write goes to the scope it belongs to, not to the active scope.

The note written to the other ticket's file is **standalone** — a self-contained sentence or paragraph that makes sense to a reader who has no context of the active session. It is NOT a reference to "we were working on TICKET-A when we noticed this"; that framing leaks the active session's scope into the other ticket's file. The note reads as if it had been written during a TICKET-B session: "X behaves incorrectly when Y", not "noticed during TICKET-A work that X behaves incorrectly".

`parameters.promptBeforeCrossWrite` governs whether TPM asks before performing the cross-write. When on, TPM surfaces "This discovery seems to belong in TICKET-B — write to its notes file?" and waits for the user's call. When off, TPM writes the cross-ticket note directly without asking. When `parameters.allowCrossTicketNoteWrite` is off, this exception does not apply at all — TPM refuses cross-writes regardless of the prompt setting.

## Violation handling (`parameters.onIsolationViolation` semantics)

When TPM is about to write to the ACTIVE ticket's notes file and the content is about a non-active ticket, the behavior is determined by `parameters.onIsolationViolation`:

- **`refuse`** (default): TPM blocks the write and surfaces "Refusing to write cross-ticket content into TICKET-A's notes. Cross-ticket isolation is enforced; consider writing to TICKET-B's notes instead." The user can then choose to route the note to the correct scope, drop it, or override the policy.
- **`log-only`**: TPM writes the note anyway but prepends a `> [cross-ticket violation: from session on TICKET-A]` marker so the violation is visible in the notes file. Useful in trusted-but-noisy environments where the user wants awareness without friction, at the cost of mixed-scope notes.
- **`ask`**: TPM prompts "This content concerns TICKET-B but we're scoped to TICKET-A. Write to TICKET-A's notes anyway, write to TICKET-B's notes, or drop?" and waits for the user's call per occurrence.

The choice between the three is the user's call. `refuse` is the safest default; `ask` is the most interactive; `log-only` is the most permissive and should be used only when the user has accepted the trade-off of mixed-scope notes.

## Relationship to existing module sections

Both ticket-scoped modes (`mode.ticket-work` and `mode.ticket-pr`, each in a Cross-ticket discipline section) and `tool.obsidian-notes` / `tool.session-handoff` (the cross-ticket discussion mentions) have inlined this rule. With this module loaded:

- Those modules' inline sections become AUTHORITATIVE-RECEIVER for the policy this module defines — they cite this module rather than restating the rule. TPM uses this module's exact settings (`parameters.enforceIsolation`, `parameters.allowCrossTicketNoteWrite`, `parameters.promptBeforeCrossWrite`, `parameters.onIsolationViolation`) in preference to anything the consuming modules say inline.
- When this module is DISABLED, the inline sections in the consuming modules act as the fallback — they restate the rule independently so the discipline isn't lost when this module is missing.
- When this module is ENABLED, the inline sections defer to this module's exact settings.

This module does NOT modify the consuming modules' content; the deference is by convention. TPM checks for this module's presence in the Session Manifest and uses its policy in preference to the inlined fallbacks. Future cleanup work may prune the inline sections once this module is the established norm, but that's a separate concern — the inline sections stay in place as the safety net until then.

## Module-disabled vs feature-disabled

These are distinct states and must produce distinct behavior:

- **Module disabled** (no `tool.cross-ticket-isolation` in the Session Manifest): consuming modules fall back to their inline rules. Safety is preserved but not project-wide-uniform — each module restates its own version of the rule, and the exact behavior on violation is whatever the inline section specifies.
- **Module enabled, `parameters.enforceIsolation` off**: TPM may write cross-ticket content into the active ticket's notes file without challenge. The isolation rule is suspended entirely. NOT recommended outside one-off sessions where the user explicitly wants cross-ticket annotations.
- **Module enabled, `parameters.allowCrossTicketNoteWrite` off**: TPM cannot write to any non-active ticket's notes file even when the discovery genuinely belongs there. The strictest discipline — cross-ticket discoveries surface in session only and the user must manually route them to the right notes file outside the agent loop.

Do not merge these cases.

## Role-Specific Notes

The body above applies identically to every agent. The notes below are short framings for how each role uses the policy.

### TPM

You are the policy-bearer for this rule. Before any write to a notes file, check whether the content is about the active ticket — if yes, write normally; if no, route per `parameters.allowCrossTicketNoteWrite` and `parameters.promptBeforeCrossWrite`. Violations against the active ticket's file are handled per `parameters.onIsolationViolation`. When `parameters.enforceIsolation` is off, surface that to the user once when the first cross-ticket write occurs ("Cross-ticket isolation is off — writing TICKET-B content into TICKET-A's notes per the user's setting.") so the posture is visible. Cross-ticket DISCUSSION in your replies to the user is always fine — the isolation rule is about writes to notes files, not about what TPM may say in-session.

### SWE

You do NOT write to notes files (TPM-only writes per `tool.obsidian-notes`), so this rule applies indirectly to you. When your return includes findings about other tickets — for example, a regression you spot in TICKET-B's code path while implementing TICKET-A — mark them explicitly in your return: "cross-ticket: TICKET-B has a related issue at `<file:line>` — `<one-sentence explanation>`". The explicit tag lets TPM route the finding correctly per this module's settings rather than letting it slip silently into the active ticket's notes. Do NOT bury cross-ticket findings inside the per-file Changes Made section as if they were part of the active ticket's work; the explicit cross-ticket tag is the contract.

### QA

Same as SWE. Cross-ticket findings get flagged explicitly in your verdict so TPM can apply the routing rule. If your Issues or Notes section references a regression, related bug, or pattern that traces to a non-active ticket, tag it the same way: "cross-ticket: TICKET-B — `<finding>`". TPM will then route per `parameters.allowCrossTicketNoteWrite` and `parameters.promptBeforeCrossWrite`. If you spot that TPM has written cross-ticket content into the active ticket's notes file in violation of this rule, surface it in the verdict as a discipline finding regardless of how clean the work itself was — the isolation rule is the point of this module's safety story and silent violations defeat it.
