# Sprint and Board Queries (TPM playbook)

**Availability gate — read this before offering any query below.** This playbook calls `searchJiraIssuesUsingJql`, an **Atlassian MCP tool**. No configuration shipped in this repo provides that MCP server — nothing under `src/` or `scripts/` implements search, and `integration.atlassian-suite`'s own "Sprint and Board Queries" section is prose over the same not-yet-configured tool, not a second implementation of it. Before answering a sprint or board question, check whether `searchJiraIssuesUsingJql` is actually present as a callable tool in this session. If it is not, board and sprint queries are **UNAVAILABLE**: say so plainly ("this needs the Atlassian MCP server configured in your CLI, which isn't set up here") rather than attempting the flow, guessing at an answer, or falling back to `bb-bridge.mjs get-ticket` (which fetches one key at a time and cannot answer a board-scoped question). The playbook below is kept for the day the operator configures that MCP server — it is not deleted, but it is dormant until then.

**Never a source of `mode.ticket-pr` queue entries.** `mode.ticket-pr/ticket-pr.md`'s own rule ("Board and column queries are NOT available in this mode, and asking for one is not a queue") is authoritative there: that mode's ticket queue is an explicit, operator-supplied list of Jira keys, and a board or sprint query answered here — even on a session where the MCP tool happens to be present — is never itself a queue and must never be used to populate or extend one.

## Purpose
Answer natural language sprint and board questions by forming JQL and running it read only via `searchJiraIssuesUsingJql` (Atlassian MCP). This module requires `integration.atlassian-suite` for the live connection and credentials. Read `parameters.boardId` for the active board to scope queries; if it is empty, scope by project and `openSprints()` instead.

## The canonical query patterns
These are templates. Adapt field and status names to the project's actual workflow, since status names differ per board. Use `sprint in openSprints()` for the active sprint and `currentUser()` for "me".

- "what's in the current/active sprint" -> `sprint in openSprints()` (add `AND status != Done` unless `parameters.includeDoneInSprintView` is true), scoped to the board or project.
- "what's in progress" -> `sprint in openSprints() AND status = "In Progress"`.
- "what's assigned to me" / "my tickets" -> `sprint in openSprints() AND assignee = currentUser()`.
- "what's left to do" -> `sprint in openSprints() AND status NOT IN (Done, "In Review")` (or the project's not done statuses).
- "what's blocked" / blockers -> `sprint in openSprints() AND (status = Blocked OR flagged = Impediment OR labels = blocked)` (the exact fields vary by project; adapt).
- "what's done" -> `sprint in openSprints() AND status = Done`.
- "what is <person> working on" -> `sprint in openSprints() AND assignee = "<person>"`.

## How TPM answers
1. Recognize the sprint or board intent behind the question.
2. Form the JQL from the pattern above, adapting field and status names to the project's real workflow and scoping to `parameters.boardId` (or the project when boardId is empty).
3. Call `searchJiraIssuesUsingJql` with that JQL and the board or project scope.
4. Present results per `parameters.resultFormat`:
   - `table` -> columns for key, summary, status, assignee.
   - `grouped` -> grouped by status or by assignee.
   - `list` -> a plain list of key and summary.
5. Reference `parameters.boardUrl` in the answer if it is set, so the user can open the board.

## Guardrails
- READ ONLY: **this module** never creates, transitions, comments on, or otherwise modifies a ticket — answering a sprint or board question is a query and nothing else. Any Jira write that exists this session belongs to `integration.atlassian-suite` and its own separately-gated, operator-approved flows; none of them is ever reached from here, and seeing a ticket sitting in a stale column is context to report, not authorization to move it.
- If the board or sprint cannot be resolved (no `boardId`, no open sprint, or the MCP is unavailable), say so plainly and offer to run a plain project JQL instead.
- Sprint and board discussion is session context. Do not persist it to ticket notes.
