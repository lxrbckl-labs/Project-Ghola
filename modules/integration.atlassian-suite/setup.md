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

1. Bitbucket → **Personal settings → App passwords → Create app password**.
2. Check two boxes: **Pull requests: Write** and **Repositories: Read**.
3. Copy it, click **Set Bitbucket API Token**, and paste.

## 4. Validate

Click **Validate** — both indicators should turn green. Done.

---

**Two things that trip people up:**

- Paste the **token / app password**, never your account **login password** (that always fails).
- Bitbucket needs **Pull requests: Write** — not just Read. With Read only, comments post but resolve / mark-ready / to-draft / create-PR fail with a 403. App-password scopes can't be edited after creation, so if that happens, make a new one with Write checked and re-set it.

Credentials are stored encrypted in VS Code and persist across updates.
