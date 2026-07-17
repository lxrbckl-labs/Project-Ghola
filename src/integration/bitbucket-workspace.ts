/**
 * Bitbucket workspace resolver. Single source of truth for deciding WHICH
 * Bitbucket Cloud workspace slug the client should query.
 *
 * Why this exists: every Bitbucket branch / PR lookup is scoped to a workspace
 * segment in the API URL. If that slug is wrong (a renamed org, a typo, or a
 * stale default), every query runs against the wrong workspace and silently
 * finds NOTHING — a find-pr that reports "no PR" when a PR really exists. This
 * resolver makes the choice explicit and recoverable: an operator-configured
 * value always wins; otherwise the slug is recovered from the repo's own git
 * remote URL; otherwise the caller learns the workspace is unknown.
 *
 * Kept free of any `vscode` import, I/O, or dependency so the logic is a pure,
 * trivially testable function. Mirrors the URL shapes handled by the ticket
 * widget's `url-builder`; reimplemented here (rather than imported) to keep this
 * integration module self-contained.
 */

/**
 * Extract the workspace slug from a Bitbucket Cloud remote URL. Supports:
 *   - SSH: `git@bitbucket.org:workspace/repo.git`
 *   - HTTPS: `https://bitbucket.org/workspace/repo.git` (with or without .git)
 *   - HTTPS with embedded user: `https://user@bitbucket.org/workspace/repo.git`
 *
 * Returns the workspace segment (the path element immediately after the host /
 * after the `:`), or `null` when the URL is missing, malformed, or not a
 * Bitbucket Cloud remote. Never throws.
 */
export function parseBitbucketWorkspaceFromRemote(url: string | null | undefined): string | null {
  if (!url) return null;

  const trimmed = url.trim();
  if (!trimmed) return null;

  const ssh = /^git@bitbucket\.org:([^/]+)\/(.+?)(?:\.git)?$/.exec(trimmed);
  if (ssh) {
    const workspace = ssh[1]!.trim();
    return workspace || null;
  }

  const https = /^https?:\/\/(?:[^@]+@)?bitbucket\.org\/([^/]+)\/(.+?)(?:\.git)?(?:\/|$)/.exec(
    trimmed,
  );
  if (https) {
    const workspace = https[1]!.trim();
    return workspace || null;
  }

  return null;
}

/** Where the resolved workspace slug came from. `'none'` means neither the
 *  configured setting nor the git remote yielded a usable slug — the caller
 *  should surface a clear "workspace unknown" configuration error rather than
 *  querying a blank workspace. */
export type BitbucketWorkspaceSource = 'configured' | 'git-remote' | 'none';

export interface ResolvedBitbucketWorkspace {
  workspace: string;
  source: BitbucketWorkspaceSource;
}

/**
 * Resolve the Bitbucket workspace slug to use for API requests, in priority
 * order:
 *   1. `configured` — the operator's saved `bitbucketWorkspace` setting. When it
 *      is a non-empty (trimmed) string it always wins.
 *   2. `gitRemoteUrl` — recovered from the repo's own Bitbucket remote when no
 *      value was configured.
 *   3. Neither available -> an empty workspace with `source: 'none'`.
 *
 * Pure and total: never throws. Any parse failure falls through to the next
 * tier and ultimately to the `'none'` result.
 */
export function resolveBitbucketWorkspace(
  configured: string | undefined | null,
  gitRemoteUrl?: string,
): ResolvedBitbucketWorkspace {
  if (typeof configured === 'string') {
    const trimmed = configured.trim();
    if (trimmed) {
      return { workspace: trimmed, source: 'configured' };
    }
  }

  const fromRemote = parseBitbucketWorkspaceFromRemote(gitRemoteUrl);
  if (fromRemote) {
    return { workspace: fromRemote, source: 'git-remote' };
  }

  return { workspace: '', source: 'none' };
}
