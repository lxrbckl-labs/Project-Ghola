# Atlassian Suite Setup

To enable live Jira ticket pulls and Bitbucket PR-comment operations, you need **two separate credentials** - one for Jira, one for Bitbucket - plus a few settings below. A single Atlassian token does **not** work for both products; Jira and Bitbucket authenticate differently, and this was confirmed by live testing (the Atlassian API token returns 401 against Bitbucket).

> **CRITICAL:** wherever you are prompted for a credential (a curl command, the Ghola "Set Token" dialog), paste the **API token / app password** - **never your Atlassian account login password**. The account password always returns 401 on API Basic auth. This tripped us up during setup - don't repeat it.

## Step 1 - Fill the settings (above)

- **Atlassian Email** - the email tied to your Atlassian account.
- **Jira Base URL** - default `https://herzog.atlassian.net`; change only if your instance lives elsewhere.
- **Bitbucket Workspace** - default `herzog-technologies`; change only if your workspace differs.

## Step 2 - Jira: create a classic Atlassian API token

Go to: https://id.atlassian.com/manage-profile/security/api-tokens

- Click **Create API token** (the classic, unscoped kind - there is no scope selection). It carries full access to your Atlassian account, so treat it like a password.
- Basic auth is `email:token`. This was confirmed working: `GET /rest/api/3/myself` returns 200.
- Use the **Set Jira API Token** command below to paste it into the Jira slot.

## Step 3 - Bitbucket: create an App Password

Go to: Bitbucket -> **Personal settings** -> **App passwords** -> **Create app password**

This is a **Bitbucket App Password**, not an Atlassian API token - the two are different credential types issued from different places, and the Atlassian token will not authenticate against Bitbucket.

Check these permissions:
- **Pull requests: Write** - **required for resolve, mark-ready, to-draft, and create-pr.** This is the one people get wrong (see the trap below), so make sure it is checked, not just "Pull requests: Read".
- **Repositories: Read**
- **Pipelines: Read** (optional; forward-looking for a planned pipeline-status feature - no current code path uses it)

> **The read-vs-write trap (confirmed by live testing):** Bitbucket puts *adding/replying to comments* under **Pull requests: Read**, but *resolving a comment thread*, *marking a PR ready*, *flipping a PR back to draft*, and *creating a PR* all require **Pull requests: Write**. So a token with only Read scope is misleading - replies post fine, then `resolve` / `mark ready` / `to draft` / `create pr` all come back **403 forbidden ("token lacks access")**. If you ever see that pattern - comments post but a resolve/ready/draft/create fails with 403 - the token is missing **Pull requests: Write**. Fix it by regenerating the app password with that box checked and re-setting it via **Set Bitbucket API Token** (Bitbucket app-password scopes are fixed at creation; you cannot add a scope to an existing one).

- Basic auth is `email:app_password`. If authentication fails using your email, try your Bitbucket **username** instead - some accounts require it.
- Use the **Set Bitbucket API Token** command below to paste it into the Bitbucket slot.

## Step 4 - Validate

Click **Validate** to confirm both credentials authenticate successfully - the Jira and Bitbucket indicators should both go green.

## Persistence

Both credentials are stored encrypted in VS Code SecretStorage and persist across extension updates.
