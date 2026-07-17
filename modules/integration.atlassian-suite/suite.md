# Atlassian Suite

When this module is loaded, the session has a credential store with live API capability for Atlassian-hosted projects (Jira + Bitbucket Cloud). The credentials sit in two places: the user's Atlassian email is a regular module setting (`email`), and API tokens (one for Jira, one for Bitbucket) are stored in VS Code SecretStorage under `ghola.atlassianSuite.jiraToken` and `ghola.atlassianSuite.bitbucketToken` respectively. TPM never reads the token values directly — they are held by the host and used for live API calls.

## Token model

Each product has its own independent token slot, managed from the Modules tab detail view (labeled "Jira" and "Bitbucket"). Each slot has Set/Replace/Clear flows and an independent validation result shown in the UI.

**Two credentials by default — one per product** (they need different scopes, so keeping them separate is simplest). Both are Atlassian API tokens created at id.atlassian.com; both authenticate with HTTP Basic `email:token`.

- **Jira** — a classic Atlassian API token (id.atlassian.com → "Create API token", no scopes). Basic auth `email:token`. Confirmed working (`GET /rest/api/3/myself` returns 200).
- **Bitbucket** — an Atlassian **API token with scopes** (id.atlassian.com → "Create API token with scopes" → pick Bitbucket + the scopes below). Basic auth `email:token`, same as Jira. **Bitbucket App Passwords are deprecated** — no new ones can be created and existing ones stop working permanently on July 28, 2026, so the scoped API token is the only forward path. (A single scoped token carrying BOTH Jira and Bitbucket scopes can serve both slots; two tokens is just the simpler default.)

**Critical:** wherever a credential is entered (a curl prompt, the Set-Token dialog), it must be the API token — never the Atlassian account login password, which always returns 401 on API Basic auth.

## Token Setup & Required Permissions

### What Ghola does with your credentials

Ghola touches Atlassian in exactly two ways, and the required permissions follow directly from that:

- **Jira — read only.** Ghola validates the token, then reads ticket summary, status, and description (ADF). It **never** creates, edits, transitions, or comments on a Jira issue.
- **Bitbucket — read plus a narrow set of writes.** Ghola reads the workspace (validation), open PRs for a branch, and PR comments/threads. It **writes** only against pull requests: reply to a comment, resolve a comment thread, delete a comment, flip a PR between draft and ready-for-review (both directions), and create a pull request. It does **not** touch repository contents, pipelines, or any non-PR resource.

Every distinct REST call the extension makes:

| # | Method + endpoint | Purpose | R/W | Credential / permission needed |
| - | ----------------- | ------- | --- | ------------------------------- |
| 1 | `GET {jiraBase}/rest/api/3/myself` | Jira token validation probe (also reads display name) | READ | Jira: classic Atlassian API token |
| 2 | `GET {jiraBase}/rest/api/3/issue/{key}?fields=status` | Ticket-existence check | READ | Jira: classic Atlassian API token |
| 3 | `GET {jiraBase}/rest/api/3/issue/{key}?fields=summary,status,description` | Ticket detail pull (summary/status/ADF) | READ | Jira: classic Atlassian API token |
| 4 | `GET /2.0/workspaces/{slug}` | Bitbucket token validation probe | READ | `read:workspace:bitbucket` |
| 5 | `GET /2.0/repositories/{ws}/{repo}/pullrequests?q=source.branch.name="{branch}"&state=OPEN` | Find open PR for a branch | READ | `read:pullrequest:bitbucket` + `read:repository:bitbucket` |
| 6 | `GET /2.0/repositories/{ws}/{repo}/pullrequests/{id}/comments?pagelen=50` (+`next` pagination) | List PR comments/threads | READ | `read:pullrequest:bitbucket` |
| 7 | `POST /2.0/repositories/{ws}/{repo}/pullrequests/{id}/comments` | Reply to a comment | WRITE | `write:pullrequest:bitbucket` |
| 8 | `PUT /2.0/repositories/{ws}/{repo}/pullrequests/{id}/comments/{cid}/resolve` | Resolve a comment thread | WRITE | `write:pullrequest:bitbucket` |
| 9 | `GET /2.0/repositories/{ws}/{repo}/pullrequests/{id}` | Read current title before the ready flip | READ | `read:pullrequest:bitbucket` |
| 10 | `PUT /2.0/repositories/{ws}/{repo}/pullrequests/{id}` with `{ title, draft: false }` | Mark a draft PR ready-for-review | WRITE | `write:pullrequest:bitbucket` |
| 11 | `PUT /2.0/repositories/{ws}/{repo}/pullrequests/{id}` with `{ title, draft: true }` | Flip a ready PR back to draft | WRITE | `write:pullrequest:bitbucket` |
| 12 | `POST /2.0/repositories/{ws}/{repo}/pullrequests` with `{ title, source, destination, description, draft }` | Create a pull request | WRITE | `write:pullrequest:bitbucket` |
| 13 | `DELETE /2.0/repositories/{ws}/{repo}/pullrequests/{id}/comments/{cid}` | Delete a comment | WRITE | `write:pullrequest:bitbucket` |

(All Bitbucket paths are rooted at `https://api.bitbucket.org/2.0`.) There are **no pipeline calls** anywhere in the extension today. `Pipelines: Read` is not required by any current code path — it is only worth granting as forward-looking prep for a planned pipeline-status/feedback capability (see below).

### Jira: classic Atlassian API token

Created at id.atlassian.com → **Create API token**. This is the classic token type with no scope selection at all, and it carries **full account access**. Basic auth is `email:token`. Confirmed working: `GET /rest/api/3/myself` returns 200.

Ghola stays read-only against Jira not because the token is limited (it isn't — a classic token could create, edit, transition, and comment on issues), but because of Ghola's own hard rule keeping Jira interactions read-only. A future Jira-commenting feature would need no new credential, just a policy change — it would already work with this token.

### Bitbucket: API token with scopes

Created at id.atlassian.com → **Create API token with scopes** → pick **Bitbucket**. (Bitbucket App Passwords are deprecated — permanently removed July 28, 2026 — so scoped API tokens are the only path.) Basic auth is `email:token`, identical to the Jira token; the difference is entirely in the scopes selected at creation.

Scopes to grant:

- **`write:pullrequest:bitbucket`** — required for all PR writes: reply, resolve, mark-ready, to-draft, create-pr, delete-comment. **Watch the read-vs-write trap:** *adding/replying to comments* is permitted under the READ pullrequest scope, but *resolving a thread* (endpoint 8), *the ready/draft flips* (10, 11), *create-pr* (12), and *deleting a comment* (13) all need the WRITE scope. A read-only token therefore posts replies fine but 403s on resolve/mark-ready/to-draft/create-pr/delete-comment — if you see that pattern, the token is missing `write:pullrequest:bitbucket` (see setup.md).
- **`read:pullrequest:bitbucket`** — required to list/read PRs and their comments.
- **`read:repository:bitbucket`** — required for the branch-PR-lookup call.
- **`read:workspace:bitbucket`** — required for the token-validation probe (`GET /2.0/workspaces/{slug}`); without it, Validate's Bitbucket indicator fails red even when PR operations would succeed.

### Deliberately excluded scopes (do not grant)

When selecting scopes on the API-token creation screen, leave these unchecked to minimize blast radius if the credential leaks. Don't add any of them without a concrete new feature that needs it:

| Scope | Reason excluded |
| ----- | ---------------- |
| `write:repository:bitbucket` (repo push) | Ghola pushes code via git, not the Bitbucket API; destructive git operations are forbidden by hard rule regardless. |
| `admin:repository:bitbucket` | High-privilege repo admin; no Ghola use case. |
| workspace-membership / account scopes | Identity/membership management beyond what validation needs; not used by any code path. |
| webhook scopes | Ghola has no webhook feature. |
| Bitbucket issue scopes | Bitbucket's own issue tracker; Ghola uses Jira for issue tracking, not Bitbucket Issues. |
| project-write / snippet / runner scopes | Outside Ghola's domain — no corresponding feature. |

### Non-secret settings (Modules tab)

Configure these in the module detail view before entering tokens:

- `email` — the Atlassian account email paired with the token (default `""`; required).
- `jiraBase` — Jira base URL (default `https://herzog.atlassian.net`).
- `bitbucketWorkspace` — Bitbucket workspace slug (default `herzog-technologies`).

### Entering tokens

Tokens are entered via the command palette, never as plain settings:

- **`Atlassian Suite: Set Jira API Token`** — stores the Jira classic API token in SecretStorage.
- **`Atlassian Suite: Set Bitbucket API Token`** — stores the Bitbucket API token (scoped) in SecretStorage.

**Critical:** paste the API token into these prompts — **never the Atlassian account login password**. The account password always returns 401 on API Basic auth; this is a real gotcha that has tripped up setup before.

Values are written straight to VS Code SecretStorage and persist across same-extension-id updates. (`Atlassian Suite: Clear Jira/Bitbucket API Token` remove them.)

### Validation

Run **`Atlassian Suite: Validate Token`** to fire both probes: Jira `GET /rest/api/3/myself` and Bitbucket `GET /2.0/workspaces/{slug}`. A green result means the credential is accepted and (for Bitbucket) can see the configured workspace. Common failure causes:

- **Wrong `bitbucketWorkspace` slug** — a 404 on the workspace probe; fix the slug in the Modules tab.
- **Missing Bitbucket token scopes** — a 401/403 on the workspace or PR calls; ensure `write:pullrequest:bitbucket`, `read:pullrequest:bitbucket`, and `read:repository:bitbucket` are granted.
- **Wrong `jiraBase` or email** — a 401 on the Jira probe.
- **Account password pasted instead of the API token** — always 401; re-issue the credential and paste that instead.

### Persistence

Both credentials live in SecretStorage keyed by the extension id (`local.ghola`). They survive version updates, but a future extension-id rename (publisher or name change) would orphan the stored secrets, requiring re-entry.

## Current capabilities

- Stores the Atlassian email, Jira base URL (`jiraBase`), and Bitbucket workspace slug (`bitbucketWorkspace`) as regular module settings.
- Stores two independent API tokens in SecretStorage: `ghola.atlassianSuite.jiraToken` (for Jira) and `ghola.atlassianSuite.bitbucketToken` (for Bitbucket).
- **Validation probes** (run automatically after a token is set **or cleared**, and when the user triggers re-validation from the settings panel): Jira via `GET /rest/api/3/myself`, Bitbucket via `GET /2.0/workspaces/{slug}`. These confirm the token is accepted and extract the account display name for UI feedback. When a token is cleared, its product's probe returns `skipped` (not `failed`) because the missing-token check short-circuits before any request is made.
- `mode.ticket-work` consumes this module's probes and credentials to surface ticket and PR state.
- **Domain probes** (run by consumer modules such as `mode.ticket-work`, when a token is set or cleared — via `onDidChangeValidation` — and when module settings such as `jiraBase` or `bitbucketWorkspace` are saved): `checkTicketExists` verifies ticket existence via the Jira token; `findOpenPrForBranch` looks up an open PR for the current branch via the Bitbucket token. These are independent of the validation probes.
- `getTicketDetails(key)` — fetches `?fields=summary,status,description` from `${jiraBase}/rest/api/3/issue/${key}` and returns `{ exists: boolean, status?: string, summary?: string, description?: unknown (ADF JSON tree), error?: string }`. Used by `mode.ticket-work` for ticket pulls and by `tool.ac-to-testing` for AC extraction from descriptions.
- `adfExtractAcceptanceCriteria(adf, headingMarker)` — pure helper that walks an ADF (Atlassian Document Format) JSON tree and extracts a list of acceptance-criteria items using a three-branch heuristic: first taskList in the doc, then the first list following a heading whose text matches headingMarker (case-insensitive), then the first bullet/ordered list as fallback. Returns `{ items: AcItem[], source: 'taskList' | 'ac-heading-list' | 'first-list' | 'none' }`. Used by `tool.ac-to-testing` and `mode.ticket-work` for AC extraction.
- The Refresh button re-runs both domain probes (`checkTicketExists` + `findOpenPrForBranch`) — it does not re-run the validation probes.

## AtlassianBridge surface

The `AtlassianBridge` is the host-side interface that consumer modules use to access Atlassian credentials and validation state without ever handling raw tokens themselves. Surface:

- `isJiraTokenSet()`, `isBitbucketTokenSet()` — boolean checks.
- `getJiraToken()`, `getBitbucketToken()` — token retrieval (used internally by Atlassian client helpers; agents NEVER call these directly per `tool.secrets-wrapper-pattern`).
- `validate()`, `getLastValidation()`, `onDidChangeValidation` — probe orchestration + event.
- `onDidChangeAtlassianTokenStatus` — event fired when token status changes.

Consumed by `integration.bitbucket-pr-comments` (for Bitbucket REST writes) and `mode.ticket-work`. The bridge keeps secret-pattern compliance — secrets are only ever read inside wrapper-style calls (AtlassianClient + BitbucketPrClient), never echoed back to agents.

## Parameter defaults

The composer only renders keys that are present in `userValues` — any parameter the user has never saved is absent from the Session Manifest. When a parameter is absent, the manifest shows `parameters: (defaults)` for this module rather than an explicit value, and the factory default applies:

- `email` absent (default `""`) — no email is available; API requests will fail authentication. The user must set this in the Modules tab.
- `jiraBase` absent (default `"https://herzog.atlassian.net"`) — used as the default Jira base URL for ticket links. If the user's instance is at a different domain they must set this explicitly.
- `bitbucketWorkspace` absent (default `"herzog-technologies"`) — used as the default workspace slug for remote-URL fallback. If the user's workspace differs they must set this explicitly.

## TPM rules

- When the user mentions a Jira ticket key (e.g. `CMMS-2650`) or a Bitbucket PR by branch name, you may mention that the Atlassian Suite module exists and that its API integration verifies ticket existence and PR state (consumed by `mode.ticket-work`).
- You may confirm that a Jira ticket key has been verified to exist or that an open PR for the current branch was found — but only when the host has surfaced that information through the widget. Do not fabricate or guess API results.
- Do NOT ask the user for the API token, suggest paths to retrieve it, or echo SecretStorage values. The token flow runs entirely through the panel and is invisible to TPM.
- Do NOT modify `jiraBase`, `bitbucketWorkspace`, or `email` on the user's behalf — these are user-managed settings the user configures from the Modules tab.

## What this module is for, in one line

Credential storage, independent per-product validation, and live Jira/Bitbucket API probes that consumer modules use to verify ticket existence and open PR state — plus a TPM playbook for answering sprint and board questions over the same Jira connection.

## Sprint and Board Queries

This suite also answers natural language sprint and board questions. It builds on the Jira connection and credentials established above: it forms JQL and runs it read only via `searchJiraIssuesUsingJql` (Atlassian MCP). Read `parameters.boardId` for the active board to scope queries; if it is empty, scope by project and `openSprints()` instead.

### The canonical query patterns

These are templates. Adapt field and status names to the project's actual workflow, since status names differ per board. Use `sprint in openSprints()` for the active sprint and `currentUser()` for "me".

- "what's in the current/active sprint" -> `sprint in openSprints()` (add `AND status != Done` unless `parameters.includeDoneInSprintView` is true), scoped to the board or project.
- "what's in progress" -> `sprint in openSprints() AND status = "In Progress"`.
- "what's assigned to me" / "my tickets" -> `sprint in openSprints() AND assignee = currentUser()`.
- "what's left to do" -> `sprint in openSprints() AND status NOT IN (Done, "In Review")` (or the project's not done statuses).
- "what's blocked" / blockers -> `sprint in openSprints() AND (status = Blocked OR flagged = Impediment OR labels = blocked)` (the exact fields vary by project; adapt).
- "what's done" -> `sprint in openSprints() AND status = Done`.
- "what is <person> working on" -> `sprint in openSprints() AND assignee = "<person>"`.

### How TPM answers

1. Recognize the sprint or board intent behind the question.
2. Form the JQL from the pattern above, adapting field and status names to the project's real workflow and scoping to `parameters.boardId` (or the project when boardId is empty).
3. Call `searchJiraIssuesUsingJql` with that JQL and the board or project scope.
4. Present results per `parameters.resultFormat`:
   - `table` -> columns for key, summary, status, assignee.
   - `grouped` -> grouped by status or by assignee.
   - `list` -> a plain list of key and summary.
5. Reference `parameters.boardUrl` in the answer if it is set, so the user can open the board.

### Guardrails

- READ ONLY: never create, transition, comment on, or otherwise modify a ticket. Jira stays read only, per the base rules.
- If the board or sprint cannot be resolved (no `boardId`, no open sprint, or the MCP is unavailable), say so plainly and offer to run a plain project JQL instead.
- Sprint and board discussion is session context. Do not persist it to ticket notes.

## Create PR

This suite owns Bitbucket pull-request **creation**. It is the outbound bookend of the PR lifecycle: `tool.pr-prep` builds the checklist + description BEFORE, this verb opens the PR, and `integration.bitbucket-pr-comments` handles everything AFTER (address comments, resolve threads, mark ready). Creating a PR is a Bitbucket API write — it goes through the same loopback bridge + `bb-bridge.mjs` wrapper the comment writes use, so the Bitbucket token never crosses the agent boundary. It is **not** a local git write, so it is allowed behind the confirmation gate below, exactly like `mark ready`.

### Triggers

Invoke this flow when the user types one of: `create pr`, `create a pull request`, `open a pr`.

### Flow

1. **Resolve repo slug.** `git remote get-url origin`, strip a trailing `.git`, take the last path segment. If parsing fails, ask the user.
2. **Resolve source branch.** The current branch (`git rev-parse --abbrev-ref HEAD`). This is the PR's source.
3. **Resolve target branch.** Read `parameters.defaultTargetBranch`. If it is empty, ASK the user which branch the PR should target — do not guess.
4. **Resolve title.** Default from the ticket key + summary when one is available this session (e.g. `CMMS-2650: Fix null deref in ImportJob`); otherwise ask the user for a title.
5. **Resolve description.** Prefer a `tool.pr-prep`-generated description if one exists this session. Otherwise ask the user to provide one (or generate a draft for their review). The description is piped via stdin, so multi-line markdown is fine.
6. **Resolve draft state.** Read `parameters.createAsDraft` — when true the PR is created as a draft (the usual path; pairs with the later `mark ready` flip once review prep is done).

### Confirmation gate

Creating a PR is a Bitbucket write, so it carries the same discipline as `mark ready`. Before doing anything, show intent plainly:

- repo slug
- `source -> target` (the two branches)
- title
- draft: yes/no
- the full description that will be posted

Then require the user to type `ok` (or explicitly cancel). **Never auto-create** — there is no bypass for this gate.

### Execute

On `ok`, invoke the wrapper with the description piped via stdin:

```bash
node "$GHOLA_ROOT/scripts/bb-bridge.mjs" create-pr \
  --repo <slug> --source <branch> --target <branch> --title <title> [--draft] <<'EOF'
<the PR description, multi-line markdown>
EOF
```

Add `--draft` only when the resolved draft state is true; omit it for a non-draft PR. The description is NOT a flag — pipe it via the heredoc, mirroring the `reply` subcommand.

### Report

On success the wrapper's JSON result carries the created PR's `prId` and `url` — report both so the user can open it. Surface any failure loudly per the Failure Handling taxonomy in `integration.bitbucket-pr-comments` (reference it; do not duplicate it here): a `Missing: ...` `unauthorized` from an empty repo/title/branch pre-check or an unset email/workspace/token, `network-error` on timeout, `not-found` (404), `forbidden` (403), or `unknown-error` (`"<code> <statusText>"`, e.g. a `400` when the source branch has no commits ahead of target, or a `409` when a PR already exists). Do not treat anything other than a clean `status: 'ok'` as success.

### Lifecycle

`create pr` pairs with `tool.pr-prep` (checklist + description generation) BEFORE and `integration.bitbucket-pr-comments` (address comments / resolve / mark ready) AFTER — together they cover the full PR lifecycle. PR *creation* lives here in the suite; the post-creation lifecycle lives in `integration.bitbucket-pr-comments`.

### Hard rules

- **No token echo.** The Bitbucket token stays behind the AtlassianBridge; the bridge's own bearer token is read from the environment by the wrapper. Never echo either, never pass a token as a flag.
- **Confirmation required.** Always show intent and wait for `ok`. Never auto-create; the gate is not configurable off.
- **Read-only git still applies.** Creating a PR is a Bitbucket API write, not a git write — allowed behind the gate, like `mark ready`. This does not loosen the no-destructive-git rule for local git in any way.
