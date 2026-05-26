/**
 * Pure URL/ticket-key helpers. Kept free of any `vscode` import so the logic
 * is trivial to reason about in isolation.
 */

/** Extract the first ticket key (e.g. CMMS-2650) from a branch name. */
export function extractTicketKey(branch: string | null | undefined): string | null {
  if (!branch) return null;
  const match = /([A-Z]{2,10}-\d+)/.exec(branch);
  return match ? match[1]! : null;
}

/** Build the Jira ticket URL. Returns null if either input is missing. */
export function buildTicketUrl(key: string | null, jiraBase: string): string | null {
  if (!key || !jiraBase) return null;
  const base = jiraBase.replace(/\/+$/, '');
  return `${base}/browse/${key}`;
}

/**
 * Extract the Bitbucket repo slug from a remote URL. Supports:
 *   - SSH: `git@bitbucket.org:workspace/repo.git`
 *   - HTTPS: `https://bitbucket.org/workspace/repo.git` (with or without .git)
 *   - HTTPS with embedded user: `https://user@bitbucket.org/workspace/repo.git`
 *
 * Returns `null` when the URL is missing, malformed, or not a Bitbucket Cloud
 * remote.
 */
export function extractBitbucketRepoSlug(remoteUrl: string | null | undefined): string | null {
  if (!remoteUrl) return null;

  const ssh = /^git@bitbucket\.org:([^/]+)\/(.+?)(?:\.git)?$/.exec(remoteUrl);
  if (ssh) return ssh[2]!;

  const https = /^https?:\/\/(?:[^@]+@)?bitbucket\.org\/([^/]+)\/(.+?)(?:\.git)?(?:\/|$)/.exec(
    remoteUrl,
  );
  if (https) return https[2]!;

  return null;
}

/**
 * Extract the Bitbucket workspace slug from a remote URL. Same URL shapes as
 * `extractBitbucketRepoSlug`. Returns null when the URL is missing or
 * malformed.
 */
export function extractBitbucketWorkspace(remoteUrl: string | null | undefined): string | null {
  if (!remoteUrl) return null;

  const ssh = /^git@bitbucket\.org:([^/]+)\/(.+?)(?:\.git)?$/.exec(remoteUrl);
  if (ssh) return ssh[1]!;

  const https = /^https?:\/\/(?:[^@]+@)?bitbucket\.org\/([^/]+)\/(.+?)(?:\.git)?(?:\/|$)/.exec(
    remoteUrl,
  );
  if (https) return https[1]!;

  return null;
}

/**
 * Build the Bitbucket Cloud branch URL. Parses `remoteUrl` to extract
 * workspace + repo. Returns null when no usable URL can be constructed.
 */
export function buildBitbucketBranchUrl(
  remoteUrl: string | null | undefined,
  branch: string | null | undefined,
  fallbackWorkspace: string,
): string | null {
  if (!branch) return null;

  const workspace = extractBitbucketWorkspace(remoteUrl);
  const repo = extractBitbucketRepoSlug(remoteUrl);
  if (workspace && repo) {
    return `https://bitbucket.org/${workspace}/${repo}/branch/${encodeURIComponent(branch)}`;
  }

  if (fallbackWorkspace) {
    return null;
  }

  return null;
}
