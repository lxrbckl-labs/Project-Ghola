/**
 * Bitbucket Cloud PR-comments REST client. Powers the
 * `integration.bitbucket-pr-comments` module — list / reply / resolve
 * operations against an open pull request, fronted by the same Basic-auth
 * + 8 s timeout + sanitized error-mapping contract as
 * `src/integration/atlassian-client.ts`.
 *
 * Security contract — read before extending:
 *   - The constructor receives an `AtlassianBridge` (token source) and a
 *     workspace-slug accessor. Each operation reads the ORDERED Bitbucket token
 *     list via `bridge.getBitbucketTokens()` and runs a shared round-robin
 *     failover loop (`withBitbucketFailover`): the `Authorization: Basic
 *     <base64(email:token)>` header is rebuilt INSIDE each attempt from that
 *     attempt's token, so a token swap takes effect for every request in the
 *     operation (including a paginated list). Each request object falls out of
 *     scope when the call resolves. Tokens are NEVER logged, returned to the
 *     webview, embedded in error messages, stored on the instance, or otherwise
 *     echoed — the failover loop treats them as opaque strings.
 *   - Every public method returns a typed result shape — they never throw to
 *     the caller. Non-2xx responses and network failures are mapped to a
 *     sanitized `status: 'unauthorized' | 'forbidden' | 'not-found' |
 *     'rate-limited' | 'network-error' | 'unknown-error'` value with a
 *     user-facing `message` (429 carries `retryAfter`, never acted on).
 *     On a non-2xx response the message is enriched with Bitbucket's own
 *     `error.message` (its documented `{type:"error",error:{message}}` shape)
 *     so callers see the real cause; that text is Bitbucket's, never the
 *     request headers or token. Network errors stay fully generic.
 *   - Every request runs under an 8 s `AbortController` timeout so a wedged
 *     network cannot hang the extension host.
 *
 * No new npm dependencies. Uses global `fetch` and Node's built-in `Buffer`
 * for base64, matching `atlassian-client.ts`.
 */

import type { AtlassianBridge } from '../extension';
import { AtlassianClient, type PrLookupResult } from './atlassian-client';
import {
  withBitbucketFailover,
  withTransientRetry,
  parseRetryAfterSeconds,
} from './bitbucket-failover';

/** Per-request timeout. Mirrors `atlassian-client.ts` so a wedged network
 *  cannot hang the extension UI thread. */
const REQUEST_TIMEOUT_MS = 8000;

/** Bitbucket Cloud REST v2 base. Duplicated as a local constant rather than
 *  re-exported from `atlassian-client.ts` so the two clients evolve
 *  independently if the API ever forks (e.g. v3, server vs cloud). */
const BITBUCKET_BASE_URL = 'https://api.bitbucket.org/2.0';

/** Safety cap on pagination — Bitbucket PR threads rarely exceed this. When
 *  hit we still return `status: 'ok'` but flag truncation via `message`. */
const COMMENT_PAGE_CAP = 200;

/** Discriminator carried on every result shape returned by this client.
 *  `'rate-limited'` maps a 429 distinctly (Phase 0 noted 429s previously fell
 *  into `'unknown-error'`), keeping this client's taxonomy consistent with
 *  `atlassian-client.ts`'s `RequestFailure` `'ratelimit'` kind. */
export type BitbucketPrStatus =
  | 'ok'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'rate-limited'
  | 'network-error'
  | 'unknown-error';

/** Normalized PR comment shape exposed to callers. Drops Bitbucket-internal
 *  fields that PR-comments callers do not need and flattens the `resolution`
 *  envelope into a single boolean. */
export interface PrComment {
  id: number;
  /** `null` for top-level threads, comment id for replies. */
  parentId: number | null;
  /** `'inline'` when the comment is anchored to a file/line, else `'general'`. */
  kind: 'inline' | 'general';
  author: { displayName: string; accountId: string };
  /** `.content.raw` — the markdown source the user typed. */
  body: string;
  /** Present only when `kind === 'inline'`. */
  inline?: { path: string; to: number; from?: number };
  /** Derived from `.resolution` — `null` on Bitbucket means unresolved. */
  resolved: boolean;
  /** ISO 8601 timestamp from `.created_on`. */
  createdAt: string;
  /** ISO 8601 timestamp from `.updated_on`. */
  updatedAt: string;
}

export interface PrCommentListResult {
  status: BitbucketPrStatus;
  /** Empty on any non-`'ok'` status. */
  comments: PrComment[];
  /** Sanitized, user-facing string. Also set on `'ok'` when truncation occurs. */
  message?: string;
  /** Raw `Retry-After` header value carried verbatim on a `'rate-limited'`
   *  (429) result. Carried, never acted on — a later phase may honor it. */
  retryAfter?: string;
}

export interface PrReplyResult {
  status: BitbucketPrStatus;
  /** Returned by Bitbucket on a successful create. */
  commentId?: number;
  message?: string;
  /** Raw `Retry-After` on a `'rate-limited'` result; carried, never acted on. */
  retryAfter?: string;
}

/** Result of creating a STANDALONE, top-level PR comment. Mirrors
 *  `PrReplyResult` field-for-field — the two operations differ only in whether
 *  a `parent` is sent, so their result shapes are deliberately identical and
 *  callers can log the created `commentId` the same way for both. */
export interface PrCommentCreateResult {
  status: BitbucketPrStatus;
  /** Returned by Bitbucket on a successful create. */
  commentId?: number;
  message?: string;
  /** Raw `Retry-After` on a `'rate-limited'` result; carried, never acted on. */
  retryAfter?: string;
}

export interface PrResolveResult {
  status: BitbucketPrStatus;
  message?: string;
  /** Raw `Retry-After` on a `'rate-limited'` result; carried, never acted on. */
  retryAfter?: string;
}

export interface PrDeleteResult {
  status: BitbucketPrStatus;
  message?: string;
  /** Raw `Retry-After` on a `'rate-limited'` result; carried, never acted on. */
  retryAfter?: string;
}

export interface PrReadyResult {
  status: BitbucketPrStatus;
  message?: string;
  /** Raw `Retry-After` on a `'rate-limited'` result; carried, never acted on. */
  retryAfter?: string;
}

export interface PrDraftResult {
  status: BitbucketPrStatus;
  message?: string;
  /** Raw `Retry-After` on a `'rate-limited'` result; carried, never acted on. */
  retryAfter?: string;
}

export interface PrCreateResult {
  status: BitbucketPrStatus;
  /** Numeric id Bitbucket assigns to the newly created PR. */
  prId?: number;
  /** Web (`links.html.href`) URL of the created PR, for the user to open. */
  url?: string;
  message?: string;
  /** Raw `Retry-After` on a `'rate-limited'` result; carried, never acted on. */
  retryAfter?: string;
}

// ─── Minimal slices of the Bitbucket response shapes we read ──────────────

interface BitbucketUser {
  display_name?: string;
  account_id?: string;
}

interface BitbucketInline {
  path?: string;
  to?: number | null;
  from?: number | null;
}

interface BitbucketContent {
  raw?: string;
}

interface BitbucketResolution {
  // Presence is what matters; the inner fields (`user`, `date`) are unused.
  date?: string;
}

interface BitbucketComment {
  id?: number;
  parent?: { id?: number };
  user?: BitbucketUser;
  content?: BitbucketContent;
  inline?: BitbucketInline;
  resolution?: BitbucketResolution | null;
  deleted?: boolean;
  created_on?: string;
  updated_on?: string;
}

interface BitbucketCommentListResponse {
  values?: BitbucketComment[];
  next?: string;
}

/** Minimal slice of `GET /pullrequests/{id}` we read for the ready flip —
 *  Bitbucket's PUT treats the request as a full update, so we echo `title`
 *  back to avoid a spurious 400 when we clear the draft flag. */
interface BitbucketPullRequest {
  title?: string;
}

/** Minimal slice of the `POST /pullrequests` create response we read: the new
 *  PR's numeric `id` and the `links.html.href` web URL we hand back so the
 *  user can open the PR. */
interface BitbucketCreatedPullRequest {
  id?: number;
  links?: { html?: { href?: string } };
}

/** Bitbucket's documented error envelope: `{ "type": "error", "error": {
 *  "message": "..." } }`. We read only `error.message` to enrich the sanitized
 *  status message on a non-2xx response. */
interface BitbucketErrorEnvelope {
  error?: { message?: string };
}

/**
 * Bitbucket Cloud PR-comments client. Cheap to construct — holds no token
 * state; each operation re-reads the token list from the bridge so a cleared or
 * reordered list is honored without rebuilding the client.
 *
 * `email` is read from the same workspace-state field the rest of the
 * extension uses (`integration.atlassian-suite::email`) via the
 * `getAtlassianSetting` callback. The bridge supplies the ordered Bitbucket
 * token list via `getBitbucketTokens()` (a Phase 1 accessor — no new bridge
 * method is added here). The workspace slug is read the same way as `email`.
 */
export class BitbucketPrClient {
  constructor(
    private readonly bridge: AtlassianBridge,
    private readonly getAtlassianSetting: (fieldKey: string) => string,
  ) {}

  // ─── Public API ───────────────────────────────────────────────────────

  /**
   * Resolve the open PR for a branch. Thin convenience wrapper that proxies
   * to `AtlassianClient.findOpenPrForBranch` so PR-comments callers do not
   * reach across into `AtlassianClient` directly. The PR-comments flow needs
   * the PR id to scope every subsequent comments call, so co-locating the
   * lookup here keeps the agent-side caller graph clean.
   */
  async findOpenPrForBranch(repoSlug: string, branch: string): Promise<PrLookupResult> {
    const { email, workspace, tokens } = await this.readAuthContext();
    // Hand the full token list to `AtlassianClient`, which runs the SAME shared
    // failover loop (and shares the cursor) for its Bitbucket lookup.
    const client = new AtlassianClient({
      email,
      bitbucketTokens: tokens,
      jiraBase: '',
      bitbucketWorkspace: workspace,
    });
    return client.findOpenPrForBranch(repoSlug, branch);
  }

  /**
   * `GET /2.0/repositories/{workspace}/{repo_slug}/pullrequests/{pr_id}/comments`.
   *
   * Follows the `next` pagination link up to `COMMENT_PAGE_CAP` total
   * comments. Deleted comments are dropped (Bitbucket returns
   * `deleted: true` tombstones). Inline + general comments are returned in a
   * single array, each tagged with `kind`. Both resolved and unresolved
   * threads are included — the `resolved` flag lets the caller decide.
   */
  async listPullRequestComments(
    repoSlug: string,
    prId: number,
  ): Promise<PrCommentListResult> {
    if (!repoSlug || !Number.isFinite(prId)) {
      return { status: 'not-found', comments: [], message: 'Missing repo or PR id' };
    }
    const { email, workspace, tokens, missing } = await this.readAuthContext();
    if (missing) return { status: 'unauthorized', comments: [], message: missing };

    // The ENTIRE pagination walk runs inside the failover callback so a failed
    // page on token A restarts the whole list from page 1 on token B, with the
    // auth header rebuilt from token B for every page.
    return this.runWithFailover(email, tokens, async (auth): Promise<PrCommentListResult> => {
      const comments: PrComment[] = [];
      let nextUrl: string | undefined =
        `${BITBUCKET_BASE_URL}/repositories/${encodeURIComponent(workspace)}` +
        `/${encodeURIComponent(repoSlug)}/pullrequests/${encodeURIComponent(String(prId))}/comments?pagelen=50`;
      let truncated = false;

      while (nextUrl) {
        const res = await this.request(nextUrl, 'GET', auth);
        if (!res.ok) return { status: res.status, comments: [], message: res.message, retryAfter: res.retryAfter };
        const body = res.body as BitbucketCommentListResponse | undefined;
        const values = Array.isArray(body?.values) ? body!.values : [];
        for (const raw of values) {
          if (raw?.deleted === true) continue;
          const normalized = this.normalizeComment(raw);
          if (normalized) comments.push(normalized);
          if (comments.length >= COMMENT_PAGE_CAP) {
            truncated = true;
            break;
          }
        }
        if (truncated) break;
        nextUrl = typeof body?.next === 'string' ? body.next : undefined;
      }

      const result: PrCommentListResult = { status: 'ok', comments };
      if (truncated) {
        result.message = `Truncated at ${COMMENT_PAGE_CAP} comments — older comments omitted`;
      }
      return result;
    });
  }

  /**
   * `POST /2.0/repositories/{workspace}/{repo_slug}/pullrequests/{pr_id}/comments`
   * with `{ content: { raw }, parent: { id }, inline? }`.
   *
   * When `inline` is supplied the reply lands as an inline comment anchored
   * to the same file/line as the parent; without it the reply lands in the
   * general thread. Callers should echo the parent's `inline` block when
   * replying to inline comments to preserve thread anchoring in Bitbucket's
   * UI.
   */
  async replyToComment(args: {
    repoSlug: string;
    prId: number;
    parentId: number;
    body: string;
    inline?: { path: string; to: number; from?: number };
  }): Promise<PrReplyResult> {
    if (!args.repoSlug || !Number.isFinite(args.prId) || !Number.isFinite(args.parentId)) {
      return { status: 'not-found', message: 'Missing repo, PR id, or parent id' };
    }
    if (!args.body) {
      return { status: 'unknown-error', message: 'Reply body is empty' };
    }
    const { email, workspace, tokens, missing } = await this.readAuthContext();
    if (missing) return { status: 'unauthorized', message: missing };

    const url =
      `${BITBUCKET_BASE_URL}/repositories/${encodeURIComponent(workspace)}` +
      `/${encodeURIComponent(args.repoSlug)}/pullrequests/${encodeURIComponent(String(args.prId))}/comments`;
    const payload: {
      content: { raw: string };
      parent: { id: number };
      inline?: { path: string; to: number; from?: number };
    } = {
      content: { raw: args.body },
      parent: { id: args.parentId },
    };
    if (args.inline) {
      const inlinePayload: { path: string; to: number; from?: number } = {
        path: args.inline.path,
        to: args.inline.to,
      };
      if (args.inline.from !== undefined) inlinePayload.from = args.inline.from;
      payload.inline = inlinePayload;
    }

    return this.runWithFailover(email, tokens, async (auth): Promise<PrReplyResult> => {
      const res = await this.request(url, 'POST', auth, payload);
      if (!res.ok) return { status: res.status, message: res.message, retryAfter: res.retryAfter };
      const body = res.body as BitbucketComment | undefined;
      const id = typeof body?.id === 'number' ? body.id : undefined;
      return { status: 'ok', commentId: id };
    });
  }

  /**
   * `POST /2.0/repositories/{workspace}/{repo_slug}/pullrequests/{pr_id}/comments`
   * with `{ content: { raw } }` and NOTHING else.
   *
   * Creates a STANDALONE, top-level, general (non-inline) PR comment. This is
   * the exact mirror of `replyToComment` minus the two keys that change where
   * the comment lands: sending `parent` makes it a threaded reply, sending
   * `inline` makes it a file/line-anchored comment — so both are deliberately
   * omitted from the payload here. That top-level placement is what makes
   * bot-trigger comments (e.g. `@coderabbitai review`) actually fire, since
   * those bots only read top-level comments. Like the other writes this needs
   * the token to carry PR write permission (`write:pullrequest:bitbucket`, or
   * an App Password with "Pull requests: Write") — a 403 here means that scope
   * is missing, and its message carries Bitbucket's own reason text.
   */
  async createComment(args: {
    repoSlug: string;
    prId: number;
    body: string;
  }): Promise<PrCommentCreateResult> {
    if (!args.repoSlug || !Number.isFinite(args.prId)) {
      return { status: 'not-found', message: 'Missing repo or PR id' };
    }
    if (!args.body || !args.body.trim()) {
      return { status: 'unknown-error', message: 'Comment body is empty' };
    }
    const { email, workspace, tokens, missing } = await this.readAuthContext();
    if (missing) return { status: 'unauthorized', message: missing };

    const url =
      `${BITBUCKET_BASE_URL}/repositories/${encodeURIComponent(workspace)}` +
      `/${encodeURIComponent(args.repoSlug)}/pullrequests/${encodeURIComponent(String(args.prId))}/comments`;
    // No `parent` key and no `inline` key — including either one is precisely
    // what would turn this into a threaded reply / inline comment.
    const payload: { content: { raw: string } } = {
      content: { raw: args.body },
    };

    return this.runWithFailover(email, tokens, async (auth): Promise<PrCommentCreateResult> => {
      const res = await this.request(url, 'POST', auth, payload);
      if (!res.ok) return { status: res.status, message: res.message, retryAfter: res.retryAfter };
      const body = res.body as BitbucketComment | undefined;
      const id = typeof body?.id === 'number' ? body.id : undefined;
      return { status: 'ok', commentId: id };
    });
  }

  /**
   * `POST /2.0/repositories/{workspace}/{repo_slug}/pullrequests/{pr_id}/comments/{comment_id}/resolve`.
   *
   * Marks the comment thread resolved. Bitbucket Cloud resolves a comment
   * thread with `POST` to the `/resolve` endpoint (and reopens/unresolves it
   * with `DELETE` to the same endpoint — not implemented here). Bitbucket
   * returns the updated comment shape on success; we only surface the status to
   * the caller because the agent-side flow does not need the post-resolve body.
   * The write requires the token to carry PR write permission
   * (`write:pullrequest:bitbucket`, or an App Password with "Pull requests:
   * Write") — a 403 here means that scope is missing.
   */
  async resolveComment(args: {
    repoSlug: string;
    prId: number;
    commentId: number;
  }): Promise<PrResolveResult> {
    if (
      !args.repoSlug ||
      !Number.isFinite(args.prId) ||
      !Number.isFinite(args.commentId)
    ) {
      return { status: 'not-found', message: 'Missing repo, PR id, or comment id' };
    }
    const { email, workspace, tokens, missing } = await this.readAuthContext();
    if (missing) return { status: 'unauthorized', message: missing };

    const url =
      `${BITBUCKET_BASE_URL}/repositories/${encodeURIComponent(workspace)}` +
      `/${encodeURIComponent(args.repoSlug)}/pullrequests/${encodeURIComponent(String(args.prId))}` +
      `/comments/${encodeURIComponent(String(args.commentId))}/resolve`;

    return this.runWithFailover(email, tokens, async (auth): Promise<PrResolveResult> => {
      const res = await this.request(url, 'POST', auth);
      if (!res.ok) return { status: res.status, message: res.message, retryAfter: res.retryAfter };
      return { status: 'ok' };
    });
  }

  /**
   * `DELETE /2.0/repositories/{workspace}/{repo_slug}/pullrequests/{pr_id}/comments/{comment_id}`.
   *
   * Permanently deletes a PR comment. The exact mirror of `resolveComment`
   * except it targets the comment resource itself (no `/resolve` suffix) with
   * `DELETE` and sends no body. Bitbucket returns `204 No Content` on success,
   * which `request()` treats as a 2xx with an empty (`undefined`) body; we only
   * surface the status. Like the other writes this needs the token to carry PR
   * write permission (`write:pullrequest:bitbucket`, or an App Password with
   * "Pull requests: Write") — a 403 here means that scope is missing, and its
   * message now carries Bitbucket's own reason text.
   */
  async deleteComment(args: {
    repoSlug: string;
    prId: number;
    commentId: number;
  }): Promise<PrDeleteResult> {
    if (
      !args.repoSlug ||
      !Number.isFinite(args.prId) ||
      !Number.isFinite(args.commentId)
    ) {
      return { status: 'not-found', message: 'Missing repo, PR id, or comment id' };
    }
    const { email, workspace, tokens, missing } = await this.readAuthContext();
    if (missing) return { status: 'unauthorized', message: missing };

    const url =
      `${BITBUCKET_BASE_URL}/repositories/${encodeURIComponent(workspace)}` +
      `/${encodeURIComponent(args.repoSlug)}/pullrequests/${encodeURIComponent(String(args.prId))}` +
      `/comments/${encodeURIComponent(String(args.commentId))}`;

    return this.runWithFailover(email, tokens, async (auth): Promise<PrDeleteResult> => {
      const res = await this.request(url, 'DELETE', auth);
      if (!res.ok) return { status: res.status, message: res.message, retryAfter: res.retryAfter };
      return { status: 'ok' };
    });
  }

  /**
   * Flip a draft PR to ready-for-review by clearing its `draft` flag.
   *
   * `GET /2.0/repositories/{workspace}/{repo_slug}/pullrequests/{pr_id}` then
   * `PUT` the same URL with `{ title, draft: false }`. We always GET-then-PUT
   * for predictability, and echo the current `title` back because Bitbucket's
   * PUT-pullrequest endpoint treats the body as a full update and can reject
   * the request with a 400 when `title` is omitted. Only the status is
   * surfaced — the post-update PR body is not needed by the agent flow.
   */
  async markPrReady(args: { repoSlug: string; prId: number }): Promise<PrReadyResult> {
    if (!args.repoSlug || !Number.isFinite(args.prId)) {
      return { status: 'not-found', message: 'Missing repo or PR id' };
    }
    const { email, workspace, tokens, missing } = await this.readAuthContext();
    if (missing) return { status: 'unauthorized', message: missing };

    const url =
      `${BITBUCKET_BASE_URL}/repositories/${encodeURIComponent(workspace)}` +
      `/${encodeURIComponent(args.repoSlug)}/pullrequests/${encodeURIComponent(String(args.prId))}`;

    // GET-then-PUT run inside ONE failover attempt so both requests use the same
    // token; if either fails, the whole ready-flip retries on the next token.
    return this.runWithFailover(email, tokens, async (auth): Promise<PrReadyResult> => {
      const getRes = await this.request(url, 'GET', auth);
      if (!getRes.ok) return { status: getRes.status, message: getRes.message, retryAfter: getRes.retryAfter };
      const current = getRes.body as BitbucketPullRequest | undefined;
      const title = typeof current?.title === 'string' ? current.title : '';

      const putRes = await this.request(url, 'PUT', auth, { title, draft: false });
      if (!putRes.ok) return { status: putRes.status, message: putRes.message, retryAfter: putRes.retryAfter };
      return { status: 'ok' };
    });
  }

  /**
   * Flip a ready PR back to draft by setting its `draft` flag. The exact mirror
   * of `markPrReady`: `GET` the PR to echo its current `title` back (Bitbucket's
   * PUT-pullrequest endpoint treats the body as a full update and 400s when
   * `title` is omitted), then `PUT` `{ title, draft: true }`. Only the status is
   * surfaced. Like the ready flip, this needs the `write:pullrequest:bitbucket` scope.
   */
  async markPrDraft(args: { repoSlug: string; prId: number }): Promise<PrDraftResult> {
    if (!args.repoSlug || !Number.isFinite(args.prId)) {
      return { status: 'not-found', message: 'Missing repo or PR id' };
    }
    const { email, workspace, tokens, missing } = await this.readAuthContext();
    if (missing) return { status: 'unauthorized', message: missing };

    const url =
      `${BITBUCKET_BASE_URL}/repositories/${encodeURIComponent(workspace)}` +
      `/${encodeURIComponent(args.repoSlug)}/pullrequests/${encodeURIComponent(String(args.prId))}`;

    // GET-then-PUT run inside ONE failover attempt so both requests use the same
    // token; if either fails, the whole draft-flip retries on the next token.
    return this.runWithFailover(email, tokens, async (auth): Promise<PrDraftResult> => {
      const getRes = await this.request(url, 'GET', auth);
      if (!getRes.ok) return { status: getRes.status, message: getRes.message, retryAfter: getRes.retryAfter };
      const current = getRes.body as BitbucketPullRequest | undefined;
      const title = typeof current?.title === 'string' ? current.title : '';

      const putRes = await this.request(url, 'PUT', auth, { title, draft: true });
      if (!putRes.ok) return { status: putRes.status, message: putRes.message, retryAfter: putRes.retryAfter };
      return { status: 'ok' };
    });
  }

  /**
   * `POST /2.0/repositories/{workspace}/{repo_slug}/pullrequests` with
   * `{ title, source: { branch: { name } }, destination: { branch: { name } },
   *    description, draft }`.
   *
   * Creates a new pull request from `sourceBranch` into `targetBranch`. On
   * success returns the created PR's numeric `id` and its web URL
   * (`links.html.href`) so the caller can report/open it. Required inputs
   * (`repoSlug`, `title`, `sourceBranch`, `targetBranch`) are validated before
   * any request is made, mirroring `replyToComment`; a missing workspace /
   * token / credential is surfaced as `unauthorized` with a `Missing: ...`
   * message. The token is never echoed.
   */
  async createPullRequest(args: {
    repoSlug: string;
    title: string;
    sourceBranch: string;
    targetBranch: string;
    description?: string;
    draft?: boolean;
  }): Promise<PrCreateResult> {
    if (!args.repoSlug || !args.title || !args.sourceBranch || !args.targetBranch) {
      const missingInputs: string[] = [];
      if (!args.repoSlug) missingInputs.push('repoSlug');
      if (!args.title) missingInputs.push('title');
      if (!args.sourceBranch) missingInputs.push('sourceBranch');
      if (!args.targetBranch) missingInputs.push('targetBranch');
      return { status: 'unauthorized', message: `Missing: ${missingInputs.join(', ')}` };
    }
    const { email, workspace, tokens, missing } = await this.readAuthContext();
    if (missing) return { status: 'unauthorized', message: missing };

    const url =
      `${BITBUCKET_BASE_URL}/repositories/${encodeURIComponent(workspace)}` +
      `/${encodeURIComponent(args.repoSlug)}/pullrequests`;
    const payload: {
      title: string;
      source: { branch: { name: string } };
      destination: { branch: { name: string } };
      description?: string;
      draft?: boolean;
    } = {
      title: args.title,
      source: { branch: { name: args.sourceBranch } },
      destination: { branch: { name: args.targetBranch } },
    };
    if (args.description !== undefined) payload.description = args.description;
    if (args.draft !== undefined) payload.draft = args.draft;

    return this.runWithFailover(email, tokens, async (auth): Promise<PrCreateResult> => {
      const res = await this.request(url, 'POST', auth, payload);
      if (!res.ok) return { status: res.status, message: res.message, retryAfter: res.retryAfter };
      const body = res.body as BitbucketCreatedPullRequest | undefined;
      const prId = typeof body?.id === 'number' ? body.id : undefined;
      const href = typeof body?.links?.html?.href === 'string' ? body.links.html.href : undefined;
      return { status: 'ok', prId, url: href };
    });
  }

  // ─── Internal: shape normalization ────────────────────────────────────

  /**
   * Convert a raw Bitbucket comment into our normalized `PrComment`. Returns
   * `undefined` for entries missing the required scalar fields (`id`,
   * `content.raw`) — those are unusable as PR-comment thread members and
   * silently dropped rather than surfaced as broken UI rows.
   */
  private normalizeComment(raw: BitbucketComment | undefined): PrComment | undefined {
    if (!raw || typeof raw.id !== 'number') return undefined;
    const bodyText = typeof raw.content?.raw === 'string' ? raw.content.raw : '';
    if (!bodyText) return undefined;

    const inlinePath = typeof raw.inline?.path === 'string' ? raw.inline.path : undefined;
    const inlineTo = typeof raw.inline?.to === 'number' ? raw.inline.to : undefined;
    const inlineFrom = typeof raw.inline?.from === 'number' ? raw.inline.from : undefined;
    const hasInline = inlinePath !== undefined && inlineTo !== undefined;

    return {
      id: raw.id,
      parentId: typeof raw.parent?.id === 'number' ? raw.parent.id : null,
      kind: hasInline ? 'inline' : 'general',
      author: {
        displayName: typeof raw.user?.display_name === 'string' ? raw.user.display_name : '',
        accountId: typeof raw.user?.account_id === 'string' ? raw.user.account_id : '',
      },
      body: bodyText,
      inline: hasInline
        ? { path: inlinePath as string, to: inlineTo as number, from: inlineFrom }
        : undefined,
      resolved: raw.resolution != null,
      createdAt: typeof raw.created_on === 'string' ? raw.created_on : '',
      updatedAt: typeof raw.updated_on === 'string' ? raw.updated_on : '',
    };
  }

  // ─── Internal: auth + request ─────────────────────────────────────────

  /**
   * Read `email`, `bitbucketWorkspace`, and the ordered Bitbucket token LIST in
   * parallel. `tokens` is the rotation list (empty entries dropped) the failover
   * loop cycles through; an empty list means "no Bitbucket token" and yields a
   * `missing` string so the public methods short-circuit into the `unauthorized`
   * shape exactly as the single-token path did. When exactly one token is stored
   * the list has one element and every op makes exactly one attempt — identical
   * to the pre-rotation behavior.
   */
  private async readAuthContext(): Promise<{
    email: string;
    workspace: string;
    tokens: string[];
    missing?: string;
  }> {
    const email = this.getAtlassianSetting('email');
    const workspace = this.getAtlassianSetting('bitbucketWorkspace');
    const entries = await this.bridge.getBitbucketTokens();
    const tokens = entries
      .map((e) => e.value)
      .filter((v) => typeof v === 'string' && v !== '');
    const missingFields: string[] = [];
    if (!email) missingFields.push('email');
    if (!workspace) missingFields.push('bitbucketWorkspace');
    if (tokens.length === 0) missingFields.push('bitbucketToken');
    const missing = missingFields.length
      ? `Missing: ${missingFields.join(', ')}`
      : undefined;
    return { email, workspace, tokens, missing };
  }

  /**
   * Run a whole logical PR operation with round-robin token failover. Delegates
   * the shared cursor + one-full-pass policy to `withBitbucketFailover`, and
   * rebuilds the `Authorization` header from THIS attempt's token INSIDE the
   * callback — so a token swap takes effect for every request in `run`
   * (including a paginated `listPullRequestComments`, whose entire while-loop
   * runs inside `run` and therefore retries wholesale on the next token). A
   * result is a FAILURE (rotates) when its `status` is not `'ok'`; `'ok'`
   * (including a truncated-but-successful list) sticks the cursor. After one
   * full failed pass the LAST result is returned so its real status / message /
   * retryAfter still surfaces.
   */
  private runWithFailover<T extends { status: BitbucketPrStatus }>(
    email: string,
    tokens: string[],
    run: (auth: string) => Promise<T>,
  ): Promise<T> {
    return withBitbucketFailover(
      tokens,
      (token) => run(this.buildAuthHeader(email, token)),
      (result) => result.status !== 'ok',
    );
  }

  /**
   * Build the `Authorization: Basic <base64(email:token)>` header value. The
   * returned string is consumed by `request()` and never logged or returned
   * to any caller — the token portion lives only inside the header value
   * passed into `fetch`.
   */
  private buildAuthHeader(email: string, token: string): string {
    return `Basic ${Buffer.from(`${email.trim()}:${token.trim()}`).toString('base64')}`;
  }

  /**
   * Combine a sanitized base message with Bitbucket's own error reason (when
   * one can be parsed from the response body) so callers see the real cause —
   * e.g. a scope-missing 403 or the 200-comments cap 400 — instead of only a
   * generic keyword. Returns the base unchanged when there is no usable detail.
   */
  private describeHttpError(base: string, text: string): string {
    const detail = this.extractErrorDetail(text);
    return detail ? `${base}: ${detail}` : base;
  }

  /**
   * Pull the human-readable reason out of a non-2xx response body. Prefers the
   * documented `{ "type": "error", "error": { "message": "..." } }` envelope;
   * falls back to a short slice of the raw text when the body is present but
   * not that shape. Defensive by contract: the body may be empty or non-JSON,
   * so the parse is wrapped in try/catch and this never throws out of
   * `request()`. The text is Bitbucket's own error output — it does not carry
   * the request headers or token — and the raw fallback is capped so a large
   * HTML error page cannot bloat the surfaced message.
   */
  private extractErrorDetail(text: string): string | undefined {
    if (!text) return undefined;
    try {
      const parsed = JSON.parse(text) as BitbucketErrorEnvelope;
      const msg = parsed?.error?.message;
      if (typeof msg === 'string' && msg.trim()) return msg.trim();
    } catch {
      // Not JSON — fall through to the raw-text fallback below.
    }
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    return trimmed.length > 200 ? `${trimmed.slice(0, 200)}...` : trimmed;
  }

  /**
   * Execute a request with the Basic-auth header, an 8 s timeout, and
   * JSON-body parsing. Returns a discriminated `{ ok, ... }` shape so callers
   * never see a thrown error.
   *
   * Token leak audit: the `Authorization` header value is set on the request
   * init object that lives only inside this function — it is never logged,
   * never embedded in an error message, and never re-emitted. Error paths
   * surface the mapped status keyword plus Bitbucket's OWN `error.message`
   * (extracted via `extractErrorDetail`) — that text is Bitbucket's response
   * body, which never echoes the request headers or token. Network errors stay
   * fully generic (no body to read).
   */
  private async request(
    url: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    auth: string,
    jsonBody?: unknown,
  ): Promise<
    | { ok: true; body: unknown }
    | { ok: false; status: BitbucketPrStatus; message: string; retryAfter?: string; httpStatus?: number }
  > {
    // Bounded transient retry on the SAME token (the auth header is captured by
    // the closure), composed UNDER `runWithFailover`'s token rotation: a
    // TRANSIENT failure (429 / network / 5xx) retries here with backoff; an auth
    // failure (401/403), a 404, or any other non-2xx returns at once so failover
    // can rotate on auth as before. `httpStatus` on the failure lets us tell a
    // retryable 5xx apart from a non-retryable 4xx that also maps to
    // `'unknown-error'`. The auth header is never logged during a retry.
    return withTransientRetry(
      () => this.requestOnce(url, method, auth, jsonBody),
      (r) => {
        if (r.ok) return { retry: false };
        if (r.status === 'rate-limited') {
          const secs = parseRetryAfterSeconds(r.retryAfter);
          return { retry: true, retryAfterMs: secs !== undefined ? secs * 1000 : undefined };
        }
        if (r.status === 'network-error') return { retry: true };
        if (typeof r.httpStatus === 'number' && r.httpStatus >= 500) return { retry: true };
        return { retry: false };
      },
    );
  }

  /**
   * Perform ONE request attempt. A fresh `AbortController` / timeout is created
   * per call so every retry gets its own 8 s deadline. Same status mapping and
   * token-leak audit as before; additionally carries the raw `httpStatus` on the
   * failure branch so the retry classifier can distinguish a retryable 5xx from
   * a non-retryable 4xx (both otherwise map to `'unknown-error'`). `httpStatus`
   * is internal — the public result shapes never surface it.
   */
  private async requestOnce(
    url: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    auth: string,
    jsonBody?: unknown,
  ): Promise<
    | { ok: true; body: unknown }
    | { ok: false; status: BitbucketPrStatus; message: string; retryAfter?: string; httpStatus?: number }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = {
        // The header value is the only place the token appears in this
        // process after auth-context resolution — DO NOT add this object to
        // any log or error payload.
        Authorization: auth,
        Accept: 'application/json',
      };
      if (jsonBody !== undefined) headers['Content-Type'] = 'application/json';

      const response = await fetch(url, {
        method,
        headers,
        body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
        signal: controller.signal,
      });

      // A response body may be consumed only once, so read it here — before
      // the status branching — and reuse the text on both the error and the
      // 2xx paths. Empty bodies (e.g. a 204 No Content from DELETE) become ''.
      const text = await response.text();

      if (response.status === 401) {
        return { ok: false, status: 'unauthorized', httpStatus: 401, message: this.describeHttpError('401 Unauthorized — check token', text) };
      }
      if (response.status === 403) {
        return { ok: false, status: 'forbidden', httpStatus: 403, message: this.describeHttpError('403 Forbidden — token lacks access', text) };
      }
      if (response.status === 404) {
        return { ok: false, status: 'not-found', httpStatus: 404, message: this.describeHttpError('404 Not Found — check workspace / repo / PR id', text) };
      }
      if (response.status === 429) {
        // Rate limited. Map distinctly to `'rate-limited'` and capture
        // `Retry-After` verbatim (seconds or an HTTP-date) so it is not lost.
        // The transient-retry wrapper honors it (waiting on the SAME token);
        // if retries are exhausted the failover loop rotates like any failure.
        const retryAfter = response.headers.get('retry-after');
        const result: { ok: false; status: BitbucketPrStatus; message: string; retryAfter?: string; httpStatus?: number } = {
          ok: false,
          status: 'rate-limited',
          httpStatus: 429,
          message: this.describeHttpError('429 Too Many Requests — rate limited', text),
        };
        if (retryAfter) result.retryAfter = retryAfter;
        return result;
      }
      if (!response.ok) {
        // Generic non-2xx (e.g. the 200-comments-per-PR cap comes back as a
        // 400, or a transient 5xx). Surface status + statusText enriched with
        // Bitbucket's own reason, never the request headers or token. The raw
        // `httpStatus` lets the retry classifier retry a 5xx but not a 4xx.
        return {
          ok: false,
          status: 'unknown-error',
          httpStatus: response.status,
          message: this.describeHttpError(`${response.status} ${response.statusText || 'request failed'}`, text),
        };
      }

      // 2xx: parse body as JSON. Empty bodies become `undefined`. A POST
      // /resolve or DELETE-comment (204 No Content) response is empty —
      // callers tolerate `undefined` because the discriminator alone tells
      // them the operation succeeded.
      let body: unknown = undefined;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = undefined;
        }
      }
      return { ok: true, body };
    } catch (err) {
      // Sanitized error mapping. We surface only the mapped status keyword
      // and a generic message — never the request init, URL, header value,
      // or raw error message text (Node's network errors can include the
      // remote host / port, which we treat as noisy but not sensitive; we
      // still suppress them to match `atlassian-client.ts`).
      const aborted =
        (err instanceof Error && err.name === 'AbortError') ||
        controller.signal.aborted;
      if (aborted) {
        return { ok: false, status: 'network-error', message: 'Request timed out — try again' };
      }
      return { ok: false, status: 'network-error', message: 'Network error — try again' };
    } finally {
      clearTimeout(timer);
    }
  }
}
