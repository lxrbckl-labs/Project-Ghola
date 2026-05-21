/**
 * Pure URL/ticket-key helpers for the Source Control branch widget. Kept free
 * of any `vscode` import so the logic is trivial to reason about in isolation
 * and easy to swap in unit tests if/when a test harness lands.
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
 * remote. Shared by `buildBitbucketBranchUrl` (renders the fallback branch URL)
 * and the SCM widget provider (passes the slug into the live PR-lookup API).
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
 * malformed. Used by the SCM widget provider to feed the workspace into the
 * Bitbucket pull-request lookup API when the user has not separately set the
 * `bitbucketWorkspace` module setting.
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
 * Build the Bitbucket Cloud branch URL.
 *
 * Parses `remoteUrl` to extract workspace + repo via the shared helpers above.
 *
 * If parsing fails and `fallbackWorkspace` is set, returns null — a URL built
 * without a repo slug is a guaranteed 404, so no URL is better than a broken
 * one. Returns null when no usable URL can be constructed.
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

  // Fallback: we have a workspace but no repo slug — a URL without the slug
  // is a guaranteed 404, so return null to let the consumer hide/disable the
  // button rather than send the user to a broken link.
  if (fallbackWorkspace) {
    return null;
  }

  return null;
}
