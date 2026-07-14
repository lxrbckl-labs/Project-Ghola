# Atlassian Suite Setup

To enable live Jira ticket pulls and Bitbucket PR-comment operations, you need one Atlassian API token (or two product-scoped tokens) plus a few settings below.

## Step 1 - Fill the settings (above)

- **Atlassian Email** - the email tied to your Atlassian account.
- **Jira Base URL** - default `https://herzog.atlassian.net`; change only if your instance lives elsewhere.
- **Bitbucket Workspace** - default `herzog-technologies`; change only if your workspace differs.

## Step 2 - Create the token

Go to: https://id.atlassian.com/manage-profile/security/api-tokens

**Option A - Simplest (full account access)**

- Click **Create API token** (no scopes).
- Paste the resulting value into both the Jira and Bitbucket slots below.

**Option B - Least privilege (scoped token)**

- Click **Create API token with scopes**.
- Select:

Required:
- [ ] Jira: `read:jira-work`
- [ ] Jira: `read:jira-user`
- [ ] Bitbucket: `read:workspace:bitbucket`
- [ ] Bitbucket: `read:repository:bitbucket`
- [ ] Bitbucket: `read:pullrequest:bitbucket`
- [ ] Bitbucket: `write:pullrequest:bitbucket`

Recommended (not used by any current feature, but avoids re-issuing the token later):
- [ ] `read:pipeline:bitbucket`
- [ ] `write:pipeline:bitbucket`
- [ ] `write:jira-work`

- Paste the token into both slots (or into each slot the token is scoped for).

## Step 3 - Set the tokens

Use the **Set Token** buttons below - one for the Jira slot, one for the Bitbucket slot. Tokens are stored encrypted in VS Code SecretStorage and persist across extension updates.

## Step 4 - Validate

Click **Validate** to confirm both tokens authenticate successfully.

## Fallback

If a unified Atlassian token will not authenticate against Bitbucket, create a **Bitbucket Workspace Access Token** instead (Bitbucket workspace settings -> Access tokens) with **Pull requests: Write**, **Repositories: Read**, and **Pipelines: Read**. Paste it into the Bitbucket slot only, leaving the Jira slot on your Atlassian API token.
