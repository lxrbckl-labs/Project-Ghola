# Atlassian Suite

When this module is loaded, the session has a credential store with live API capability for Atlassian-hosted projects (Jira + Bitbucket Cloud). The credentials sit in two places: the user's Atlassian email is a regular module setting (`email`), and API tokens (one for Jira, one for Bitbucket) are stored in VS Code SecretStorage under `ghola.atlassianSuite.jiraToken` and `ghola.atlassianSuite.bitbucketToken` respectively. TPM never reads the token values directly — they are held by the host and used for live API calls.

## Token model

Each product has its own independent token slot, managed from the Modules tab detail view (labeled "Jira" and "Bitbucket"). Each slot has Set/Replace/Clear flows and an independent validation result shown in the UI.

An Atlassian unified API token (generated at id.atlassian.com) works for both products — paste the same value into both slots. Or use a product-scoped token (e.g., a Bitbucket Workspace Token) in just the Bitbucket slot for blast-radius reduction.

## Token Setup & Required Permissions

### What Ghola does with your credentials

Ghola touches Atlassian in exactly two ways, and the required permissions follow directly from that:

- **Jira — read only.** Ghola validates the token, then reads ticket summary, status, and description (ADF). It **never** creates, edits, transitions, or comments on a Jira issue.
- **Bitbucket — read plus a narrow set of writes.** Ghola reads the workspace (validation), open PRs for a branch, and PR comments/threads. It **writes** only three things, all against pull requests: reply to a comment, resolve a comment thread, and mark a draft PR ready-for-review (the "bridge" flip). It does **not** touch repository contents, pipelines, or any non-PR resource.

Every distinct REST call the extension makes:

| # | Method + endpoint | Purpose | R/W | Minimal scope |
| - | ----------------- | ------- | --- | ------------- |
| 1 | `GET {jiraBase}/rest/api/3/myself` | Jira token validation probe (also reads display name) | READ | `read:jira-user` |
| 2 | `GET {jiraBase}/rest/api/3/issue/{key}?fields=status` | Ticket-existence check | READ | `read:jira-work` |
| 3 | `GET {jiraBase}/rest/api/3/issue/{key}?fields=summary,status,description` | Ticket detail pull (summary/status/ADF) | READ | `read:jira-work` |
| 4 | `GET /2.0/workspaces/{slug}` | Bitbucket token validation probe | READ | `read:workspace:bitbucket` |
| 5 | `GET /2.0/repositories/{ws}/{repo}/pullrequests?q=source.branch.name="{branch}"&state=OPEN` | Find open PR for a branch | READ | `read:pullrequest:bitbucket` |
| 6 | `GET /2.0/repositories/{ws}/{repo}/pullrequests/{id}/comments?pagelen=50` (+`next` pagination) | List PR comments/threads | READ | `read:pullrequest:bitbucket` |
| 7 | `POST /2.0/repositories/{ws}/{repo}/pullrequests/{id}/comments` | Reply to a comment | WRITE | `write:pullrequest:bitbucket` |
| 8 | `PUT /2.0/repositories/{ws}/{repo}/pullrequests/{id}/comments/{cid}/resolve` | Resolve a comment thread | WRITE | `write:pullrequest:bitbucket` |
| 9 | `GET /2.0/repositories/{ws}/{repo}/pullrequests/{id}` | Read current title before the ready flip | READ | `read:pullrequest:bitbucket` |
| 10 | `PUT /2.0/repositories/{ws}/{repo}/pullrequests/{id}` with `{ title, draft: false }` | Mark a draft PR ready-for-review | WRITE | `write:pullrequest:bitbucket` |

(All Bitbucket paths are rooted at `https://api.bitbucket.org/2.0`.) There are **no pipeline calls** anywhere in the extension today, so `read:pipeline:bitbucket` is not exercised by any current code path. Guidance: include it anyway on a scoped token (see Option B below) for forward-compatibility — a planned pipeline-status/feedback capability will need it, and adding it now avoids regenerating the token later.

*Planned (not yet implemented) — table notes for scopes with no current REST call:*

- `read:pipeline:bitbucket` — a future `GET /2.0/repositories/{ws}/{repo}/pipelines/...` call for pipeline-status/feedback would require this scope. No such call exists in the codebase yet — this is forward-looking only, not a current REST call.
- `write:pipeline:bitbucket` — PLANNED, not yet implemented. A future `POST /2.0/repositories/{ws}/{repo}/pipelines/...` call to trigger/re-run a Bitbucket pipeline would require this scope. No such call exists anywhere in the codebase today; this is a CI write action, not exercised by any current code path.
- `write:jira-work` — PLANNED, not yet implemented. A future `POST {jiraBase}/rest/api/3/issue/{key}/comment` call to post a Jira comment would require this scope. No such call exists in the codebase today — Ghola's current hard rules keep Jira strictly read-only, so this scope would remain dormant until that policy changes.

None of these three scopes appears in the REST-call table above, because none of them is exercised by any call the extension makes today.

### Consolidated minimal scope set

- **Jira:** `read:jira-work`, `read:jira-user`
- **Bitbucket:** `read:workspace:bitbucket`, `read:repository:bitbucket`, `read:pullrequest:bitbucket`, `write:pullrequest:bitbucket`

`read:repository:bitbucket` is listed because `read:pullrequest:bitbucket` reads live inside a repository context; grant both. `write:pullrequest:bitbucket` is the single scope that enables all three Bitbucket writes (reply, resolve, mark-ready). No call in the codebase needs a scope outside this set.

### Two token strategies

**(A) One unrestricted Atlassian API token (simplest).** At id.atlassian.com → **Create API token** (no scopes selected). Paste the same value into **both** the Jira and Bitbucket slots. This authenticates every call above with zero scope bookkeeping.

**(B) A scoped Atlassian API token (least privilege).** At id.atlassian.com → **Create API token with scopes**, then grant:

**Required (exercised by current code paths):**
- Jira: `read:jira-work`, `read:jira-user`
- Bitbucket: `read:workspace:bitbucket`, `read:repository:bitbucket`, `read:pullrequest:bitbucket`, `write:pullrequest:bitbucket`

**Recommended, forward-looking (not required — no current code path uses these):**
- `read:pipeline:bitbucket` — no current code path exercises this scope, but granting it now future-proofs the token for a planned pipeline-status/feedback capability so you don't have to regenerate the token when that lands.
- `write:pipeline:bitbucket` — enables triggering/re-running Bitbucket pipelines from a session. Not exercised by any current code path (no pipeline-write calls exist anywhere in the extension today); it is a CI write action, granted now to future-proof for a planned pipeline-trigger capability.
- `write:jira-work` — enables the agent to POST comments on Jira tickets. Ghola's current hard rules make Jira **read-only**, so this scope is not used by any current code path and would remain dormant until that policy is changed; granting it now future-proofs the token for the planned Jira-commenting capability (matches a parked feature idea) so no token regen is needed later.

Paste it into both slots (or into each slot the token is scoped for).

### What the write scopes already cover

- `write:pullrequest:bitbucket` is not limited to reply/resolve/mark-ready — it is Bitbucket's single scope for all pull-request writes, including approving, requesting changes, declining, merging, and creating PRs. Any future PR-workflow feature (auto-approve, auto-merge, PR creation) needs **no additional scope** beyond what Ghola already requests.
- `write:jira-work` is not limited to posting comments — it is Jira's single scope for transitioning, creating, editing, and assigning issues, in addition to commenting. Any future Jira-write feature needs **no additional scope** beyond this one. Ghola's current hard rules keep Jira read-only, so all of this stays dormant until that policy changes.

### Deliberately excluded scopes (do not grant)

These are intentionally left off the token to minimize blast radius if it leaks. Don't add any of them without a concrete new feature that needs it:

| Scope | Reason excluded |
| ----- | ---------------- |
| `write:repository:bitbucket` (repo push) | Ghola pushes code via git, not the Bitbucket API; destructive git operations are forbidden by hard rule regardless. |
| `admin:repository:bitbucket` | High-privilege repo admin; no Ghola use case. |
| `admin:workspace:bitbucket` | High-privilege workspace admin; no Ghola use case. |
| `read:webhook`, `write:webhook` | Ghola has no webhook feature. |
| `read:issue:bitbucket` | Bitbucket's own issue tracker; Ghola uses Jira for issue tracking, not Bitbucket Issues. |
| JSM / service-desk scopes | Outside Ghola's domain — no service-desk feature. |
| Snippets scopes | Outside Ghola's domain — no snippets feature. |
| Runners scopes | Outside Ghola's domain — no pipeline-runner management feature. |
| `read:account`, `read:user:bitbucket` | Marginal identity reads beyond what validation needs; not used by any code path. |

### Non-secret settings (Modules tab)

Configure these in the module detail view before entering tokens:

- `email` — the Atlassian account email paired with the token (default `""`; required).
- `jiraBase` — Jira base URL (default `https://herzog.atlassian.net`).
- `bitbucketWorkspace` — Bitbucket workspace slug (default `herzog-technologies`).

### Entering tokens

Tokens are entered via the command palette, never as plain settings:

- **`Atlassian Suite: Set Jira API Token`** — stores the Jira token in SecretStorage.
- **`Atlassian Suite: Set Bitbucket API Token`** — stores the Bitbucket token in SecretStorage.

Values are written straight to VS Code SecretStorage and persist across same-extension-id updates. (`Atlassian Suite: Clear Jira/Bitbucket API Token` remove them.)

### Validation

Run **`Atlassian Suite: Validate Token`** to fire both probes: Jira `GET /rest/api/3/myself` and Bitbucket `GET /2.0/workspaces/{slug}`. A green result means the token is accepted and (for Bitbucket) can see the configured workspace. Common failure causes:

- **Wrong `bitbucketWorkspace` slug** — a 404 on the workspace probe; fix the slug in the Modules tab.
- **Missing Bitbucket scopes** — a 401/403 on the workspace or PR calls when using a scoped token; ensure the four Bitbucket scopes above are granted.
- **Wrong `jiraBase` or email** — a 401 on the Jira probe.

### Fallback: Bitbucket Workspace Access Token

If a unified Atlassian API token will not authenticate against Bitbucket, create a **Bitbucket Workspace Access Token** (Bitbucket workspace settings → **Access tokens**) with:

- **Pull requests: Write** (enables reply, resolve, mark-ready)
- **Repositories: Read**
- **Pipelines: Read** (recommended, forward-looking; no current code path calls it, but granting it avoids re-issuing this token when planned pipeline-status/feedback support lands)

Paste it into the **Bitbucket slot only**, leaving the Jira slot on the Atlassian API token.

### Persistence

Tokens live in SecretStorage keyed by the extension id (`local.ghola`). They survive version updates, but a future extension-id rename (publisher or name change) would orphan the stored secrets, requiring re-entry.

## Current capabilities

- Stores the Atlassian email, Jira base URL (`jiraBase`), and Bitbucket workspace slug (`bitbucketWorkspace`) as regular module settings.
- Stores two independent API tokens in SecretStorage: `ghola.atlassianSuite.jiraToken` (for Jira) and `ghola.atlassianSuite.bitbucketToken` (for Bitbucket).
- **Validation probes** (run automatically after a token is set **or cleared**, and when the user triggers re-validation from the settings panel): Jira via `GET /rest/api/3/myself`, Bitbucket via `GET /2.0/workspaces/{slug}`. These confirm the token is accepted and extract the account display name for UI feedback. When a token is cleared, its product's probe returns `skipped` (not `failed`) because the missing-token check short-circuits before any request is made.
- The Ticket Widget (owned by `mode.ticket-work`, registered as `gholaTicketWidget`) consumes this module's probes and credentials to surface ticket and PR state in the UI.
- **Domain probes** (run by consumer modules such as the Ticket Widget in `mode.ticket-work`, when a token is set or cleared — via `onDidChangeValidation` — and when module settings such as `jiraBase` or `bitbucketWorkspace` are saved): `checkTicketExists` verifies ticket existence via the Jira token; `findOpenPrForBranch` looks up an open PR for the current branch via the Bitbucket token. These are independent of the validation probes.
- `getTicketDetails(key)` — fetches `?fields=summary,status,description` from `${jiraBase}/rest/api/3/issue/${key}` and returns `{ exists: boolean, status?: string, summary?: string, description?: unknown (ADF JSON tree), error?: string }`. Used by `mode.ticket-work` for ticket pulls and by `tool.ac-to-testing` for AC extraction from descriptions.
- `adfExtractAcceptanceCriteria(adf, headingMarker)` — pure helper that walks an ADF (Atlassian Document Format) JSON tree and extracts a list of acceptance-criteria items using a three-branch heuristic: first taskList in the doc, then the first list following a heading whose text matches headingMarker (case-insensitive), then the first bullet/ordered list as fallback. Returns `{ items: AcItem[], source: 'taskList' | 'ac-heading-list' | 'first-list' | 'none' }`. Used by `tool.ac-to-testing` and `mode.ticket-work`'s Ticket Widget for AC extraction.
- The Refresh button re-runs both domain probes (`checkTicketExists` + `findOpenPrForBranch`) — it does not re-run the validation probes.

## AtlassianBridge surface

The `AtlassianBridge` is the host-side interface that consumer modules use to access Atlassian credentials and validation state without ever handling raw tokens themselves. Surface:

- `isJiraTokenSet()`, `isBitbucketTokenSet()` — boolean checks.
- `getJiraToken()`, `getBitbucketToken()` — token retrieval (used internally by Atlassian client helpers; agents NEVER call these directly per `tool.secrets-wrapper-pattern`).
- `validate()`, `getLastValidation()`, `onDidChangeValidation` — probe orchestration + event.
- `onDidChangeAtlassianTokenStatus` — event fired when token status changes.

Consumed by `integration.bitbucket-pr-comments` (for Bitbucket REST writes) and the host-side ticket widget. The bridge keeps secret-pattern compliance — secrets are only ever read inside wrapper-style calls (AtlassianClient + BitbucketPrClient), never echoed back to agents.

## Parameter defaults

The composer only renders keys that are present in `userValues` — any parameter the user has never saved is absent from the Session Manifest. When a parameter is absent, the manifest shows `parameters: (defaults)` for this module rather than an explicit value, and the factory default applies:

- `email` absent (default `""`) — no email is available; API requests will fail authentication. The user must set this in the Modules tab.
- `jiraBase` absent (default `"https://herzog.atlassian.net"`) — used as the default Jira base URL for ticket links. If the user's instance is at a different domain they must set this explicitly.
- `bitbucketWorkspace` absent (default `"herzog-technologies"`) — used as the default workspace slug for remote-URL fallback. If the user's workspace differs they must set this explicitly.

## TPM rules

- When the user mentions a Jira ticket key (e.g. `CMMS-2650`) or a Bitbucket PR by branch name, you may mention that the Atlassian Suite module exists and that its API integration verifies ticket existence and PR state (consumed by the Ticket Widget in `mode.ticket-work`).
- You may confirm that a Jira ticket key has been verified to exist or that an open PR for the current branch was found — but only when the host has surfaced that information through the widget. Do not fabricate or guess API results.
- Do NOT ask the user for the API token, suggest paths to retrieve it, or echo SecretStorage values. The token flow runs entirely through the panel and is invisible to TPM.
- Do NOT modify `jiraBase`, `bitbucketWorkspace`, or `email` on the user's behalf — these are user-managed settings the user configures from the Modules tab.

## What this module is for, in one line

Credential storage, independent per-product validation, and live Jira/Bitbucket API probes that consumer modules use to verify ticket existence and open PR state.
