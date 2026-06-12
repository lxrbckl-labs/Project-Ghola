# Atlassian Suite

When this module is loaded, the session has a credential store with live API capability for Atlassian-hosted projects (Jira + Bitbucket Cloud). The credentials sit in two places: the user's Atlassian email is a regular module setting (`email`), and API tokens (one for Jira, one for Bitbucket) are stored in VS Code SecretStorage under `nomeda.atlassianSuite.jiraToken` and `nomeda.atlassianSuite.bitbucketToken` respectively. TPM never reads the token values directly — they are held by the host and used for live API calls.

## Token model

Each product has its own independent token slot, managed from the Modules tab detail view (labeled "Jira" and "Bitbucket"). Each slot has Set/Replace/Clear flows and an independent validation result shown in the UI.

An Atlassian unified API token (generated at id.atlassian.com) works for both products — paste the same value into both slots. Or use a product-scoped token (e.g., a Bitbucket Workspace Token) in just the Bitbucket slot for blast-radius reduction.

## Current capabilities

- Stores the Atlassian email, Jira base URL (`jiraBase`), and Bitbucket workspace slug (`bitbucketWorkspace`) as regular module settings.
- Stores two independent API tokens in SecretStorage: `nomeda.atlassianSuite.jiraToken` (for Jira) and `nomeda.atlassianSuite.bitbucketToken` (for Bitbucket).
- **Validation probes** (run automatically after a token is set **or cleared**, and when the user triggers re-validation from the settings panel): Jira via `GET /rest/api/3/myself`, Bitbucket via `GET /2.0/workspaces/{slug}`. These confirm the token is accepted and extract the account display name for UI feedback. When a token is cleared, its product's probe returns `skipped` (not `failed`) because the missing-token check short-circuits before any request is made.
- The Ticket Widget (owned by `mode.ticket-work`, registered as `nomedaTicketWidget`) consumes this module's probes and credentials to surface ticket and PR state in the UI.
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
