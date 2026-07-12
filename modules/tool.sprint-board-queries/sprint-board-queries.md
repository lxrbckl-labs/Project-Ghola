# Sprint and Board Queries (TPM playbook)

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
- READ ONLY: never create, transition, comment on, or otherwise modify a ticket. Jira stays read only, per the base rules.
- If the board or sprint cannot be resolved (no `boardId`, no open sprint, or the MCP is unavailable), say so plainly and offer to run a plain project JQL instead.
- Sprint and board discussion is session context. Do not persist it to ticket notes.
