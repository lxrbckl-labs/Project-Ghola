# Session Handoff

When this module is loaded, the agents have a session-bookend protocol: TPM writes a structured wrap-up to the active notes file at session end, and TPM reads the most-recent wrap-up at session start so the user can pick up where they left off. This module extends the universal hard rules, it never relaxes them. Every agent reads this same fragment per the Session Manifest read-on-demand contract; role-specific framing is collected at the end.

This module is **proactive**: TPM reads it once, at session start, before responding to the user's first request. The first job is to surface the most-recent handoff (when `parameters.surfaceOnResume` is true). The rest of the session, the module sits quietly until a wrap-up signal appears.

This module depends on `tool.obsidian-notes` for file location — handoffs are written into the active notes file resolved by that module (per-ticket notes in ticket-work mode, per-project notes in Directory Navigation mode). The dependency is soft: if Obsidian Notes is disabled or its vault is unresolved, this module degrades gracefully — see "Dependency on Obsidian Notes" below.

## What a session handoff looks like

A session handoff is a dated markdown block appended to the bottom of the active notes file — the file whose location and structure `tool.obsidian-notes` defines — under that file's `Session Handoff` anchor heading. This module owns the block's shape; `tool.obsidian-notes` owns the surrounding file. The shape:

```markdown
## Session Handoff (<date>)

### Completed
- [What was finished this session]

### In Progress
- [What was started but not finished]

### Pending
- [What still needs to be done]

### Decisions
- [Key decisions and their rationale]

### Blockers
- [Anything blocking progress]
```

The date in the heading uses `parameters.dateFormat`. The sub-sections present in the block — and the order they appear in — come from `parameters.sectionsToInclude` (comma-separated, trimmed, case-folded for the section name). Each session adds a **new** `## Session Handoff (...)` block; TPM never overwrites or rewrites a previous block, even on the same date — multiple wrap-ups in one day produce multiple blocks in chronological order.

When the active home is a shared clone family (see `mode.cd`) and `parameters.cloneTagHeading` is true, the heading also carries a clone suffix — `## Session Handoff (<date>) [clone: <label> @ <branch>]` — where the label and branch come as clone context supplied by `mode.cd` (the clone's `basename(cwd)` and its current branch). The suffix is appended AFTER the `(<date>)`, never inside it, so the block shape is otherwise unchanged. When `parameters.cloneTagHeading` is false, or no clone context is supplied, the heading is the plain `## Session Handoff (<date>)`. This module still owns the heading; `mode.cd` only supplies the clone context it appends.

If a sub-section listed in `parameters.sectionsToInclude` has no content for this session, write `- (none)` under it rather than omitting the heading. Empty sections are signal ("we did not have any blockers this session"); missing sections look like the wrap-up was rushed.

## When to write a handoff

A handoff is a session-bookend operation, not a per-turn log. TPM writes a handoff in exactly these situations:

- **The user signals they are wrapping up.** Phrases like "wrap up", "we're done for now", "ttyl", "log the session", "let's stop here", "write a handoff" all count. When TPM hears one, it proposes the handoff content to the user, waits for confirmation or corrections, then writes.
- **`parameters.wrapUpTrigger` is `auto-on-quiet` AND the conversation has gone stale.** Ghola does not have a true idle-detect, so "stale" here means the most recent turn read like a natural stopping point (a delivered result, no follow-up question, no further direction) and enough conversational distance has passed that TPM is reasonably confident the user is done. In this mode TPM proactively proposes a wrap-up — "looks like we're done here; want me to write a handoff?" — and waits. It never writes silently.
- **The user explicitly asks for one** ("write a handoff", "log the session to obsidian", equivalent). Same propose-then-write flow.

TPM does **not** write a handoff:

- On every turn, or after every successful change, or after every code review.
- When the user pivots to a new topic mid-session — that is not a wrap-up, that is a topic change, and the running notes (per `tool.obsidian-notes`) cover it.
- Silently. Always propose the content first, even when the user explicitly asks for a handoff; this is the user's last chance to correct the framing of what was completed, decided, or left in progress.

## What goes in each section

The default `parameters.sectionsToInclude` covers the five most common sub-sections. Guidance for each:

- **Completed** — what was finished this session. Be specific: file paths touched, module ids shipped, decisions reached, investigations closed. "Updated the manifest" is noise; "added `tool.session-handoff/manifest.json` with four settings and proactive: true" is signal. The next session reads this to know what is already done, so vague entries waste time.
- **In Progress** — what was started but not finished. The SWE half-way through an edit, a module that builds but does not ship, an investigation that is mid-stream. Include enough context that the next session can pick up without re-discovering — file paths, the current line of thinking, what the next concrete step looks like.
- **Pending** — what still needs to happen for this unit of work. Include a "next action" when one is obvious. Pending is about future work; In Progress is about work already started — keep the two distinct so the next session knows what to resume versus what to start.
- **Decisions** — key calls made this session and their rationale, especially "we chose X over Y because Z" entries. These are the highest-leverage section of the handoff because future-you would otherwise have to re-derive them; if you skip nothing else, do not skip this.
- **Blockers** — anything stopping progress: missing access, an upstream change, a build failure, a question waiting on the user. If a blocker is on the user's side, name it clearly so the user can act on it before the next session.

When `parameters.sectionsToInclude` is customized — a user adds a section name not in this list, or removes one — TPM still writes the listed sections in the order given. For custom sections without guidance above, TPM applies the same principle: specific content, no filler, `- (none)` when empty.

## Resume protocol

When `parameters.surfaceOnResume` is true, TPM does the following at session start, before responding to the user's first request:

1. Resolve the active notes file via `tool.obsidian-notes` (per-ticket notes for ticket-work mode, per-project notes for Directory Navigation mode, no notes file in ad-hoc mode).
2. Read the file. Find the **most-recent** session handoff block — match on the `## Session Handoff (` heading prefix (so any ` [clone: ...]` suffix a clone-family home appends is tolerated) and take the last such block in document order, since handoffs are appended chronologically.
3. Surface it to the user as part of the opening message. Format: "Picking up from `<date>` — last handoff says X is done, Y is in-progress, Z is pending. Want to continue from there?" Summarize the key bullets; do not paste the whole block verbatim unless the user asks for it.
4. If the notes file does not exist, or exists but contains no `## Session Handoff` block, surface that — "no prior handoff for this notes file; treating as a fresh session." — and proceed normally.
5. **Do not auto-continue work.** Surface the handoff and wait for the user's direction. The user may want to continue, may want to pivot, or may want to revisit a decision — TPM's job is to give them the context, not to make the call.

When `parameters.surfaceOnResume` is false, TPM skips the entire resume protocol. Wrap-up writes still happen at session end per the trigger; only the resume-surfacing is suppressed.

In ad-hoc mode (no ticket, not CD), there is no active notes file and therefore no handoff to surface — skip the resume protocol entirely and proceed.

## Scope: handoffs follow the active unit of work

Handoffs scope to the active unit of work — the ticket in ticket-work mode, the bound project in Directory Navigation mode. They live in the notes file for that scope and they summarize the session's work on that scope.

**Cross-scope discussion stays out of the handoff.** When the user pivots to discussing another ticket mid-session, that discussion is in session memory and is not written to either ticket's handoff. The exception is the same one in `tool.obsidian-notes`: if a discovery from another scope genuinely belongs in that other scope's notes, write it to THAT scope's file as a standalone note (not as a handoff entry, just a note), and keep the current session's handoff focused on its own scope.

If the session spans two units of work — the user started on ticket A and pivoted to ticket B for real work, not just discussion — write two handoffs, one to each scope's notes file, each summarizing that scope's portion of the session. Do not merge them into one.

## Dependency on Obsidian Notes

This module needs a resolved vault path to do its writes and reads, and it gets that from `tool.obsidian-notes`. The dependency is soft, with three degradation modes:

- **`tool.obsidian-notes` is disabled or absent from the Session Manifest.** No handoff writes happen this session. No resume surfacing. TPM tells the user once at session start — "Session Handoff is loaded but Obsidian Notes is not; handoffs will not persist this session." — and continues normally. Do not attempt to write to disk on TPM's own; this module never picks its own vault path.
- **`tool.obsidian-notes` is enabled but the vault path is unresolved** (empty `vaultPath` with auto-discovery off, or discovery ran and found nothing). Same graceful degradation. TPM mentions it once and continues.
- **`tool.obsidian-notes` is enabled, the vault is resolved, but the project or ticket notes file does not exist yet.** On write, create it (the write goes through `tool.obsidian-notes`' normal write path, which handles creation). On resume, treat as a fresh session — there is no prior handoff to surface.

In every degraded case, TPM does not crash the session and does not refuse other work — handoffs are useful, not essential, and the session continues with handoff behavior disabled.

## Module-disabled vs feature-disabled

These are distinct failure modes and must use distinct messages:

- **Module disabled** (no `tool.session-handoff` in the Session Manifest): TPM does not manage handoffs at all this session. No resume surfacing, no wrap-up offers, no writes. If the user explicitly asks for a handoff, surface that the module is not loaded.
- **Module enabled but `parameters.surfaceOnResume` is false**: no resume surfacing, but wrap-up writes still happen per `parameters.wrapUpTrigger`. The user opted out of resume-surfacing specifically, not out of handoffs.
- **Module enabled but the Obsidian dependency is degraded**: see "Dependency on Obsidian Notes" above. TPM surfaces the degradation once and continues.

Do not merge these cases.

## Role-Specific Notes

The body above applies identically to every agent. The notes below are short framings for how each role uses the policy.

### TPM

You are the only role that reads or writes handoffs. On session start with this module loaded, run the resume protocol if `parameters.surfaceOnResume` is true — read the active notes file resolved by `tool.obsidian-notes`, locate the most-recent `## Session Handoff` block, and include the summary in your opening message before responding to the user's first request. Throughout the session, watch for wrap-up signals from the user (per "When to write a handoff"); when `parameters.wrapUpTrigger` is `auto-on-quiet`, also watch for stale-conversation cues and proactively propose a wrap-up. When wrapping up, draft the handoff content from session memory plus the SWE and QA returns you consolidated this session, propose it to the user, accept corrections, then write it through `tool.obsidian-notes`' write path. Append a new `## Session Handoff (<date>)` block — never overwrite, never rewrite a prior block, even on the same date. When `mode.cd` supplies clone context and `parameters.cloneTagHeading` is true, append the ` [clone: <label> @ <branch>]` suffix to that heading. Date format comes from `parameters.dateFormat`; sub-section list and order comes from `parameters.sectionsToInclude`. If the Obsidian dependency is degraded, follow the messages in "Dependency on Obsidian Notes" — surface the degradation once at session start and continue.

### SWE

You never write handoffs. Not the resume surface, not the wrap-up block, nothing. If the user (or anyone) asks you to "log the session" or "write the handoff" or equivalent, refuse and surface to TPM — handoff writes are TPM-exclusive for the same concurrent-write reason that all vault writes are TPM-exclusive in `tool.obsidian-notes`. Your job is to deliver content (file-by-file changes, findings, caveats) in your standard return format; TPM consolidates that content into the handoff at wrap-up time. The more complete your return is, the better the handoff TPM can write.

### QA

Same write discipline as SWE: handoffs are TPM-only. Your findings feed TPM's handoff via the verdict's Issues and Notes sections — that is your contribution to the wrap-up. If you spot that a SWE attempted to write a handoff block to a notes file, that is a `FAIL`-level discipline finding regardless of how clean the content was — the write funnel exists to prevent concurrent-write damage, and "this particular write was fine" is not the right frame. Reading a prior handoff for context during review is fine; writing one is not your role.
