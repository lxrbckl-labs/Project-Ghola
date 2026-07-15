/**
 * Bitbucket Cloud PR-comments REST client. Powers the
 * `integration.bitbucket-pr-comments` module — list / reply / resolve
 * operations against an open pull request, fronted by the same Basic-auth
 * + 8 s timeout + sanitized error-mapping contract as
 * `src/integration/atlassian-client.ts`.
 *
 * Security contract — read before extending:
 *   - The constructor receives an `AtlassianBridge` (token source) and a
 *     workspace-slug accessor. Each request reads the Bitbucket token via
 *     `bridge.getBitbucketToken()`, builds the `Authorization: Basic
 *     <base64(email:token)>` header inside `request()`, and lets the request
 *     object fall out of scope when the call resolves. The token is NEVER
 *     logged, returned to the webview, embedded in error messages, stored on
 *     the instance, or otherwise echoed.
 *   - Every public method returns a typed result shape — they never throw to
 *     the caller. Non-2xx responses and network failures are mapped to a
 *     sanitized `status: 'unauthorized' | 'forbidden' | 'not-found' |
 *     'network-error' | 'unknown-error'` value with a generic, user-facing
 *     `message`. Raw response bodies never reach the message field.
 *   - Every request runs under an 8 s `AbortController` timeout so a wedged
 *     network cannot hang the extension host.
 *
 * No new npm dependencies. Uses global `fetch` and Node's built-in `Buffer`
 * for base64, matching `atlassian-client.ts`.
 */

import type { AtlassianBridge } from '../extension';
import { AtlassianClient, type PrLookupResult } from './atlassian-client';

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

/** Discriminator carried on every result shape returned by this client. */
export type BitbucketPrStatus =
  | 'ok'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
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
}

export interface PrReplyResult {
  status: BitbucketPrStatus;
  /** Returned by Bitbucket on a successful create. */
  commentId?: number;
  message?: string;
}

export interface PrResolveResult {
  status: BitbucketPrStatus;
  message?: string;
}

export interface PrReadyResult {
  status: BitbucketPrStatus;
  message?: string;
}

export interface PrDraftResult {
  status: BitbucketPrStatus;
  message?: string;
}

export interface PrCreateResult {
  status: BitbucketPrStatus;
  /** Numeric id Bitbucket assigns to the newly created PR. */
  prId?: number;
  /** Web (`links.html.href`) URL of the created PR, for the user to open. */
  url?: string;
  message?: string;
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

/**
 * Bitbucket Cloud PR-comments client. Cheap to construct — holds no token
 * state; each request re-reads the token from the bridge so a cleared token
 * is honored without rebuilding the client.
 *
 * `email` is read from the same workspace-state field the rest of the
 * extension uses (`integration.atlassian-suite::email`) via the
 * `getAtlassianSetting` callback. The bridge supplies the Bitbucket token.
 * The workspace slug is read the same way as `email`. We deliberately do not
 * widen `AtlassianBridge` with new methods — the existing `getJiraToken` /
 * `getBitbucketToken` contract stays minimal and per-product.
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
    const { email, workspace, token } = await this.readAuthContext();
    const client = new AtlassianClient({
      email,
      bitbucketToken: token,
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
    const { email, workspace, token, missing } = await this.readAuthContext();
    if (missing) return { status: 'unauthorized', comments: [], message: missing };

    const auth = this.buildAuthHeader(email, token);
    const comments: PrComment[] = [];
    let nextUrl: string | undefined =
      `${BITBUCKET_BASE_URL}/repositories/${encodeURIComponent(workspace)}` +
      `/${encodeURIComponent(repoSlug)}/pullrequests/${encodeURIComponent(String(prId))}/comments?pagelen=50`;
    let truncated = false;

    while (nextUrl) {
      const res = await this.request(nextUrl, 'GET', auth);
      if (!res.ok) return { status: res.status, comments: [], message: res.message };
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
    const { email, workspace, token, missing } = await this.readAuthContext();
    if (missing) return { status: 'unauthorized', message: missing };

    const auth = this.buildAuthHeader(email, token);
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

    const res = await this.request(url, 'POST', auth, payload);
    if (!res.ok) return { status: res.status, message: res.message };
    const body = res.body as BitbucketComment | undefined;
    const id = typeof body?.id === 'number' ? body.id : undefined;
    return { status: 'ok', commentId: id };
  }

  /**
   * `PUT /2.0/repositories/{workspace}/{repo_slug}/pullrequests/{pr_id}/comments/{comment_id}/resolve`.
   *
   * Marks the comment thread resolved. Bitbucket returns the updated comment
   * shape on success; we only surface the status to the caller because the
   * agent-side flow does not need the post-resolve body.
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
    const { email, workspace, token, missing } = await this.readAuthContext();
    if (missing) return { status: 'unauthorized', message: missing };

    const auth = this.buildAuthHeader(email, token);
    const url =
      `${BITBUCKET_BASE_URL}/repositories/${encodeURIComponent(workspace)}` +
      `/${encodeURIComponent(args.repoSlug)}/pullrequests/${encodeURIComponent(String(args.prId))}` +
      `/comments/${encodeURIComponent(String(args.commentId))}/resolve`;

    const res = await this.request(url, 'PUT', auth);
    if (!res.ok) return { status: res.status, message: res.message };
    return { status: 'ok' };
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
    const { email, workspace, token, missing } = await this.readAuthContext();
    if (missing) return { status: 'unauthorized', message: missing };

    const auth = this.buildAuthHeader(email, token);
    const url =
      `${BITBUCKET_BASE_URL}/repositories/${encodeURIComponent(workspace)}` +
      `/${encodeURIComponent(args.repoSlug)}/pullrequests/${encodeURIComponent(String(args.prId))}`;

    const getRes = await this.request(url, 'GET', auth);
    if (!getRes.ok) return { status: getRes.status, message: getRes.message };
    const current = getRes.body as BitbucketPullRequest | undefined;
    const title = typeof current?.title === 'string' ? current.title : '';

    const putRes = await this.request(url, 'PUT', auth, { title, draft: false });
    if (!putRes.ok) return { status: putRes.status, message: putRes.message };
    return { status: 'ok' };
  }

  /**
   * Flip a ready PR back to draft by setting its `draft` flag. The exact mirror
   * of `markPrReady`: `GET` the PR to echo its current `title` back (Bitbucket's
   * PUT-pullrequest endpoint treats the body as a full update and 400s when
   * `title` is omitted), then `PUT` `{ title, draft: true }`. Only the status is
   * surfaced. Like the ready flip, this is a `Pull requests: Write` action.
   */
  async markPrDraft(args: { repoSlug: string; prId: number }): Promise<PrDraftResult> {
    if (!args.repoSlug || !Number.isFinite(args.prId)) {
      return { status: 'not-found', message: 'Missing repo or PR id' };
    }
    const { email, workspace, token, missing } = await this.readAuthContext();
    if (missing) return { status: 'unauthorized', message: missing };

    const auth = this.buildAuthHeader(email, token);
    const url =
      `${BITBUCKET_BASE_URL}/repositories/${encodeURIComponent(workspace)}` +
      `/${encodeURIComponent(args.repoSlug)}/pullrequests/${encodeURIComponent(String(args.prId))}`;

    const getRes = await this.request(url, 'GET', auth);
    if (!getRes.ok) return { status: getRes.status, message: getRes.message };
    const current = getRes.body as BitbucketPullRequest | undefined;
    const title = typeof current?.title === 'string' ? current.title : '';

    const putRes = await this.request(url, 'PUT', auth, { title, draft: true });
    if (!putRes.ok) return { status: putRes.status, message: putRes.message };
    return { status: 'ok' };
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
    const { email, workspace, token, missing } = await this.readAuthContext();
    if (missing) return { status: 'unauthorized', message: missing };

    const auth = this.buildAuthHeader(email, token);
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

    const res = await this.request(url, 'POST', auth, payload);
    if (!res.ok) return { status: res.status, message: res.message };
    const body = res.body as BitbucketCreatedPullRequest | undefined;
    const prId = typeof body?.id === 'number' ? body.id : undefined;
    const href = typeof body?.links?.html?.href === 'string' ? body.links.html.href : undefined;
    return { status: 'ok', prId, url: href };
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
   * Read `email`, `bitbucketWorkspace`, and the stored Bitbucket token in
   * parallel. When any required value is empty we return a `missing` string
   * naming the offenders so the public methods can short-circuit into the
   * `unauthorized` shape with an explanatory message.
   */
  private async readAuthContext(): Promise<{
    email: string;
    workspace: string;
    token: string;
    missing?: string;
  }> {
    const email = this.getAtlassianSetting('email');
    const workspace = this.getAtlassianSetting('bitbucketWorkspace');
    const token = (await this.bridge.getBitbucketToken()) ?? '';
    const missingFields: string[] = [];
    if (!email) missingFields.push('email');
    if (!workspace) missingFields.push('bitbucketWorkspace');
    if (!token) missingFields.push('bitbucketToken');
    const missing = missingFields.length
      ? `Missing: ${missingFields.join(', ')}`
      : undefined;
    return { email, workspace, token, missing };
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
   * Execute a request with the Basic-auth header, an 8 s timeout, and
   * JSON-body parsing. Returns a discriminated `{ ok, ... }` shape so callers
   * never see a thrown error.
   *
   * Token leak audit: the `Authorization` header value is set on the request
   * init object that lives only inside this function — it is never logged,
   * never embedded in an error message, and never re-emitted. Error paths
   * surface only the mapped status keyword and a sanitized, user-facing
   * message; the raw response body is intentionally discarded.
   */
  private async request(
    url: string,
    method: 'GET' | 'POST' | 'PUT',
    auth: string,
    jsonBody?: unknown,
  ): Promise<
    | { ok: true; body: unknown }
    | { ok: false; status: BitbucketPrStatus; message: string }
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

      if (response.status === 401) {
        return { ok: false, status: 'unauthorized', message: '401 Unauthorized — check token' };
      }
      if (response.status === 403) {
        return { ok: false, status: 'forbidden', message: '403 Forbidden — token lacks access' };
      }
      if (response.status === 404) {
        return { ok: false, status: 'not-found', message: '404 Not Found — check workspace / repo / PR id' };
      }
      if (!response.ok) {
        // Generic non-2xx — surface only status + statusText, never the body.
        return {
          ok: false,
          status: 'unknown-error',
          message: `${response.status} ${response.statusText || 'request failed'}`,
        };
      }

      // 2xx: parse body as JSON. Empty bodies become `undefined`. A PUT
      // /resolve response may be empty in some Bitbucket configurations —
      // callers tolerate `undefined` because the discriminator alone tells
      // them the operation succeeded.
      const text = await response.text();
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
