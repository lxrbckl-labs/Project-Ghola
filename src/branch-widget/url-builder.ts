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
 * Build the Bitbucket Cloud branch URL.
 *
 * Parses `remoteUrl` to extract workspace + repo. Supports:
 *   - SSH: git@bitbucket.org:workspace/repo.git
 *   - HTTPS: https://bitbucket.org/workspace/repo.git (with or without .git)
 *   - HTTPS with embedded user: https://user@bitbucket.org/workspace/repo.git
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

  // Try SSH form first.
  const ssh = /^git@bitbucket\.org:([^/]+)\/(.+?)(?:\.git)?$/.exec(remoteUrl ?? '');
  if (ssh) {
    return `https://bitbucket.org/${ssh[1]}/${ssh[2]}/branch/${encodeURIComponent(branch)}`;
  }

  // Try HTTPS form.
  const https = /^https?:\/\/(?:[^@]+@)?bitbucket\.org\/([^/]+)\/(.+?)(?:\.git)?(?:\/|$)/.exec(
    remoteUrl ?? '',
  );
  if (https) {
    return `https://bitbucket.org/${https[1]}/${https[2]}/branch/${encodeURIComponent(branch)}`;
  }

  // Fallback: we have a workspace but no repo slug — a URL without the slug
  // is a guaranteed 404, so return null to let the consumer hide/disable the
  // button rather than send the user to a broken link.
  if (fallbackWorkspace) {
    return null;
  }

  return null;
}
