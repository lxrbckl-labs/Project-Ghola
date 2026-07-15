# Atlassian Suite Setup

You need **two credentials** — one for Jira, one for Bitbucket. They're different and not interchangeable.

## 1. Settings (above)

- **Atlassian Email** — the email you log into Atlassian with.
- **Jira Base URL** — leave as `https://herzog.atlassian.net` unless yours differs.
- **Bitbucket Workspace** — leave as `herzog-technologies` unless yours differs.

## 2. Jira token

1. Go to https://id.atlassian.com/manage-profile/security/api-tokens
2. **Create API token** → copy it.
3. Click **Set Jira API Token** and paste.

## 3. Bitbucket token

> Bitbucket **app passwords are being removed** (permanently July 28, 2026). Use an **API token with scopes** instead — same idea, just scoped.

1. Go to https://id.atlassian.com/manage-profile/security/api-tokens → **Create API token with scopes**.
2. Pick **Bitbucket**, then select these scopes:
   - `read:workspace:bitbucket`
   - `read:repository:bitbucket`
   - `read:pullrequest:bitbucket`
   - `write:pullrequest:bitbucket`
3. Copy it, click **Set Bitbucket API Token**, and paste.

## 4. Validate

Click **Validate** — both indicators should turn green. Done.

---

**Two things that trip people up:**

- Paste the **API token**, never your account **login password** (that always fails).
- Bitbucket needs the **`write:pullrequest:bitbucket`** scope — not just read. Without it, comments post but resolve / mark-ready / to-draft / create-PR fail with a 403. Token scopes can't be edited after creation, so if that happens, make a new one with the write scope and re-set it.

Credentials are stored encrypted in VS Code and persist across updates.

**Heads up — tokens expire.** Atlassian API tokens now require an expiry (up to 1 year, chosen at creation), so once a year you'll create a fresh one and re-paste it. You'll know renewal is due if Bitbucket/Jira calls start failing with 401/403; the last-4 digits shown on each token slot confirm the new one took.
