# Atlassian Suite

When this module is loaded, the session has a credential store with live API capability and an optional Source Control branch widget aimed at Atlassian-hosted projects (Jira + Bitbucket Cloud). The credentials sit in two places: the user's Atlassian email is a regular module setting (`email`), and API tokens (one for Jira, one for Bitbucket) are stored in VS Code SecretStorage under `nomeda.atlassianSuite.jiraToken` and `nomeda.atlassianSuite.bitbucketToken` respectively. TPM never reads the token values directly — they are held by the host and used for live API calls.

## Token model

Each product has its own independent token slot, managed from the Modules tab detail view (labeled "Jira" and "Bitbucket"). Each slot has Set/Replace/Clear flows and an independent validation result shown in the UI.

An Atlassian unified API token (generated at id.atlassian.com) works for both products — paste the same value into both slots. Or use a product-scoped token (e.g., a Bitbucket Workspace Token) in just the Bitbucket slot for blast-radius reduction.

## Current capabilities

- Stores the Atlassian email, Jira base URL (`jiraBase`), and Bitbucket workspace slug (`bitbucketWorkspace`) as regular module settings.
- Stores two independent API tokens in SecretStorage: `nomeda.atlassianSuite.jiraToken` (for Jira) and `nomeda.atlassianSuite.bitbucketToken` (for Bitbucket).
- **Validation probes** (run automatically after a token is set **or cleared**, and when the user triggers re-validation from the settings panel): Jira via `GET /rest/api/3/myself`, Bitbucket via `GET /2.0/workspaces/{slug}`. These confirm the token is accepted and extract the account display name for UI feedback. When a token is cleared, its product's probe returns `skipped` (not `failed`) because the missing-token check short-circuits before any request is made. They are not called by the branch widget.
- Toggles visibility of the Source Control branch widget via the `showWidget` setting. When on, the widget renders in the SCM sidebar and surfaces the current branch's ticket key plus one-click links to the Jira ticket and the Bitbucket branch/PR page.
- **Domain probes** (run by the widget on branch change, when the user presses Refresh, when a token is set or cleared — the widget subscribes to `onDidChangeValidation`, which fires after every set/clear — and when module settings are saved, e.g. `jiraBase` or `bitbucketWorkspace` change): `checkTicketExists` verifies ticket existence via the Jira token; `findOpenPrForBranch` looks up an open PR for the current branch via the Bitbucket token. These are independent of the validation probes.
- The Refresh button re-runs both domain probes (`checkTicketExists` + `findOpenPrForBranch`) — it does not re-run the validation probes.

## Parameter defaults

The composer only renders keys that are present in `userValues` — any parameter the user has never saved is absent from the Session Manifest. When a parameter is absent, the manifest shows `parameters: (defaults)` for this module rather than an explicit value, and the factory default applies:

- `email` absent (default `""`) — no email is available; API requests will fail authentication. The user must set this in the Modules tab.
- `jiraBase` absent (default `"https://herzog.atlassian.net"`) — the branch widget uses the default Jira base URL for ticket links. If the user's instance is at a different domain they must set this explicitly.
- `bitbucketWorkspace` absent (default `"herzog-technologies"`) — the widget uses the default workspace slug as its remote-URL fallback. If the user's workspace differs they must set this explicitly.
- `showWidget` absent (default `false`) — the branch widget is hidden. The user must toggle it on in the Modules tab to see it in the SCM sidebar.

## TPM rules

- When the user mentions a Jira ticket key (e.g. `CMMS-2650`) or a Bitbucket PR by branch name, you may mention that the Atlassian Suite module exists and that the branch widget surfaces a one-click ticket / PR link in the Source Control sidebar, and that ticket existence and open PR state can be verified via the live API integration.
- You may confirm that a Jira ticket key has been verified to exist or that an open PR for the current branch was found — but only when the host has surfaced that information through the widget. Do not fabricate or guess API results.
- Do NOT ask the user for the API token, suggest paths to retrieve it, or echo SecretStorage values. The token flow runs entirely through the panel and is invisible to TPM.
- Do NOT modify `jiraBase`, `bitbucketWorkspace`, `email`, or `showWidget` on the user's behalf — these are user-managed settings the user toggles from the Modules tab.

## What this module is for, in one line

Credential storage, independent per-product validation, and a live Source Control branch widget that verifies ticket existence (Jira) and open PR state (Bitbucket) against the Atlassian APIs.
