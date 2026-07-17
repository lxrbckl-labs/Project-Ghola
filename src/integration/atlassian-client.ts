/**
 * Atlassian REST client. Single source of truth for the Jira + Bitbucket Cloud
 * endpoints the extension needs to validate credentials and probe ticket / PR
 * existence for `mode.ticket-work`'s ticket and PR lookups.
 *
 * Security contract — read before extending:
 *   - The constructor receives `email` + (optionally) `jiraToken` and either a
 *     single `bitbucketToken` or an ordered `bitbucketTokens` list. Each token
 *     is only ever used to construct the `Authorization: Basic
 *     <base64(email:token)>` header for the matching product's outbound
 *     requests. Jira calls authenticate with the single `jiraToken` (never
 *     rotated); Bitbucket calls authenticate with one of the rotation-list
 *     tokens, selected per attempt by the shared failover loop. The two flows
 *     are kept strictly separate — Jira never rotates and never crosses into
 *     the Bitbucket token list.
 *   - This module NEVER logs, returns, embeds, or otherwise echoes either
 *     token, the auth header value, the raw request init, or response bodies
 *     that might contain credentials. Catch sites must mask any header named
 *     `authorization` before surfacing error context.
 *   - All public methods return a typed result shape — they never throw to the
 *     caller. Network errors and non-2xx responses are converted to the
 *     `failed` / empty-result variant with a user-readable `message`. When a
 *     product's token is missing, the corresponding method short-circuits to
 *     the same empty / `skipped` shape without making a request.
 *   - Every request runs under an 8 second timeout via `AbortController` so a
 *     wedged network cannot hang the extension host.
 *
 * No new npm dependencies. Uses global `fetch` (available in VS Code 1.85+,
 * which ships Electron with Node 18+) and Node's built-in `Buffer` for base64.
 */

import {
  withBitbucketFailover,
  withTransientRetry,
  parseRetryAfterSeconds,
} from './bitbucket-failover';
import { resolveBitbucketWorkspace } from './bitbucket-workspace';

/** Per-request timeout. Long enough to absorb a transient hiccup, short
 *  enough that a wedged network never blocks the extension UI thread.        */
const REQUEST_TIMEOUT_MS = 8000;

/** Result shape returned by validation probes. Mirrors the discriminated
 *  union exported from `extension.ts` as `AtlassianValidationResult`. */
export interface ProbeResult {
  status: 'ok' | 'failed' | 'skipped';
  message?: string;
  displayName?: string;
}

/** Structured failure discriminant produced by the internal `request()` helper
 *  and surfaced (via an optional `failure`) on the probe result shapes below,
 *  so a caller — and a future multi-token failover loop — can tell WHICH kind
 *  of failure occurred instead of only "something went wrong". A 2xx response
 *  (including a legitimately empty list = "no PR" / a 404 = "no ticket") is
 *  SUCCESS from these methods' perspective and never carries a failure. `kind`
 *  maps as:
 *    - `auth`      — 401 or 403 (the message preserves the 401-vs-403 hint);
 *    - `ratelimit` — 429 (`retryAfter` carries the `Retry-After` header if sent);
 *    - `network`   — fetch threw / timed out / was aborted (no response);
 *    - `error`     — any other non-2xx (e.g. 5xx, or an unexpected 404).
 */
export type RequestFailureKind = 'auth' | 'ratelimit' | 'network' | 'error';

export interface RequestFailure {
  kind: RequestFailureKind;
  /** HTTP status when the failure came from a response; `undefined` for a
   *  network / timeout failure where no response was received. */
  httpStatus?: number;
  /** Sanitized, user-facing message. Never contains a token or header value. */
  message: string;
  /** Raw `Retry-After` response header value on a 429, carried verbatim for a
   *  later phase to act on. Absent when the header was not sent. */
  retryAfter?: string;
}

/** Constructor options. Each product authenticates with its own token; either
 *  may be `undefined` (or empty) — the corresponding methods then short-circuit
 *  to a `'skipped'` / empty-result shape rather than firing a doomed request.
 *  `jiraBase` and `bitbucketWorkspace` follow the same rule. */
export interface AtlassianClientOptions {
  email: string;
  /** Jira API token. Undefined or empty → Jira methods skip without request.
   *  Jira uses a SINGLE token and never rotates. */
  jiraToken?: string;
  /** Legacy single Bitbucket API token. Undefined or empty → Bitbucket methods
   *  skip. Retained for back-compat: when `bitbucketTokens` is omitted, a
   *  non-empty value here becomes a one-element rotation list (exactly one
   *  attempt — identical to the pre-rotation single-token behavior). */
  bitbucketToken?: string;
  /** Ordered list of Bitbucket API token VALUES for round-robin failover. When
   *  provided (and non-empty), the Bitbucket methods try each token in turn via
   *  the shared failover loop; when omitted, they fall back to `bitbucketToken`.
   *  Empty entries are dropped. Jira is unaffected either way. */
  bitbucketTokens?: string[];
  jiraBase: string;
  bitbucketWorkspace: string;
}

/** Per-call return shape for `checkTicketExists`. `status` is the Jira issue
 *  status name (e.g. `"In Progress"`) when available. */
export interface TicketCheckResult {
  exists: boolean;
  status?: string;
  /** Present ONLY on a real request failure (auth / ratelimit / network / other
   *  non-2xx). A genuine "ticket does not exist" (HTTP 404) stays the plain
   *  `{ exists: false }` this method has always returned — that is success, not
   *  a failure. */
  failure?: RequestFailure;
}

/** Per-call return shape for `getTicketDetails`. Extends the `checkTicketExists`
 *  shape with `summary` and `description`. `description` is the raw ADF JSON
 *  tree (opaque here — the consumer in `adf-to-text.ts` walks it). `error`
 *  carries a sanitized failure message when the request fails for a reason
 *  other than 404 (which is reported as `exists: false`). */
export interface TicketDetailsResult {
  exists: boolean;
  status?: string;
  summary?: string;
  description?: unknown;
  error?: string;
}

/** Bitbucket pull-request lifecycle states. `findOpenPrForBranch` queries OPEN
 *  first and falls back to the closed states so a MERGED / DECLINED / SUPERSEDED
 *  PR (and its CodeRabbit comments) is still reachable instead of being reported
 *  as "no PR". */
export type BitbucketPrState = 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED';

/** Per-call return shape for `findOpenPrForBranch`. `prUrl === null` with no
 *  `failure` means no PR exists for the branch in ANY state (a 2xx response with
 *  an empty `values` array — the genuine "none" case). A real request failure
 *  instead carries `failure` so callers can tell it apart from "none". */
export interface PrLookupResult {
  prUrl: string | null;
  prTitle?: string;
  prId?: number;
  /** Lifecycle state of the PR that was found. `'OPEN'` when the open-state
   *  query matched; a closed state (`'MERGED'` / `'DECLINED'` / `'SUPERSEDED'`)
   *  when only the fallback query matched. Absent on the genuine no-PR case and
   *  on a request failure. Lets a caller say "found a MERGED PR #123" distinctly
   *  from "no PR at all". */
  prState?: BitbucketPrState;
  /** The PR author's Bitbucket `nickname` — the username-like handle best for
   *  case-insensitive matching against a configured Bitbucket username. Chosen
   *  over `account_id` / `uuid` (opaque, not user-recognizable) and over
   *  `display_name` (a free-form name, not a stable login) because `nickname` is
   *  the closest thing Bitbucket Cloud still exposes to the old `username` the
   *  GDPR-era API dropped. Present on a found PR (OPEN or the closed fallback)
   *  when the API returned an author handle; absent on the genuine no-PR case,
   *  on a request failure, and when the API omitted the field. */
  prAuthor?: string;
  /** The PR author's human-readable `display_name`, for surfacing in UI/log
   *  text. NOT used for matching (it is not a stable handle). Same presence
   *  rules as `prAuthor`. */
  prAuthorDisplay?: string;
  /** Present ONLY on a real request failure (auth / ratelimit / network / other
   *  non-2xx, including a 404 that means the workspace / repo slug is wrong). A
   *  genuine "no PR for the branch" stays `{ prUrl: null }` with no failure. */
  failure?: RequestFailure;
}

/** Minimal slice of Jira `/myself` that we read. */
interface JiraMyselfResponse {
  displayName?: string;
  emailAddress?: string;
}

/** Minimal slice of Bitbucket `/workspaces/<slug>` that we read. */
interface BitbucketWorkspaceResponse {
  name?: string;
  slug?: string;
}

/** Minimal slice of Jira `/issue/<key>` that we read. */
interface JiraIssueResponse {
  fields?: {
    status?: { name?: string };
    summary?: string;
    /** ADF document tree — opaque shape; walked by `adf-to-text.ts`. */
    description?: unknown;
  };
}

/** Minimal slice of the Bitbucket pull-request search response. `state` and
 *  `updated_on` back the state fallback and the deterministic multi-PR pick;
 *  `author` backs the author-vs-reviewer determination a boot-time step makes.
 *  Bitbucket's account object exposes `nickname` (the username-like handle a
 *  user picks — the closest thing to a login now that the GDPR-era API dropped
 *  the old `username` field) and `display_name` (their human-readable name). */
interface BitbucketPullRequest {
  id?: number;
  title?: string;
  state?: string;
  updated_on?: string;
  author?: { nickname?: string; display_name?: string };
  links?: { html?: { href?: string } };
}
interface BitbucketPullRequestListResponse {
  values?: BitbucketPullRequest[];
}

/** Narrow a raw Bitbucket `state` string to our `BitbucketPrState` union;
 *  `undefined` for anything unrecognized or missing. */
function normalizePrState(raw: string | undefined): BitbucketPrState | undefined {
  switch (raw) {
    case 'OPEN':
    case 'MERGED':
    case 'DECLINED':
    case 'SUPERSEDED':
      return raw;
    default:
      return undefined;
  }
}

/**
 * Atlassian REST client. One instance per validation / probe burst — cheap to
 * construct, holds the tokens only for the lifetime of the instance.
 *
 * Two products → two independent auth flows. Each public method passes
 * `'jira'` or `'bitbucket'` into `request()` so the correct token is read off
 * the instance when the header is built. There is no shared "current token"
 * field; the two flows never cross.
 */
export class AtlassianClient {
  private readonly email: string;
  private readonly jiraToken: string;
  /** Ordered, non-empty Bitbucket token VALUES the rotation loop cycles through.
   *  Built from `bitbucketTokens` when supplied, else from the legacy single
   *  `bitbucketToken`. An empty array means "no Bitbucket token" and the
   *  Bitbucket methods short-circuit exactly as before. */
  private readonly bitbucketTokens: string[];
  private readonly jiraBase: string;
  private readonly bitbucketWorkspace: string;

  constructor(opts: AtlassianClientOptions) {
    this.email = opts.email ?? '';
    this.jiraToken = opts.jiraToken ?? '';
    // Prefer the explicit list; fall back to the legacy single token. Drop empty
    // entries so a blank token never counts as a rotation attempt.
    const list =
      opts.bitbucketTokens && opts.bitbucketTokens.length > 0
        ? opts.bitbucketTokens
        : opts.bitbucketToken
          ? [opts.bitbucketToken]
          : [];
    this.bitbucketTokens = list.filter((t) => typeof t === 'string' && t !== '');
    this.jiraBase = (opts.jiraBase ?? '').replace(/\/+$/, '');
    this.bitbucketWorkspace = opts.bitbucketWorkspace ?? '';
  }

  // ─── Validation probes ────────────────────────────────────────────────

  /**
   * `GET ${jiraBase}/rest/api/3/myself`. Confirms the Jira token is accepted
   * by Jira and extracts the human display name for UI feedback.
   */
  async validateJira(): Promise<ProbeResult> {
    const missing = this.missingFor(['email', 'jiraToken', 'jiraBase']);
    if (missing) return { status: 'skipped', message: missing };

    const url = `${this.jiraBase}/rest/api/3/myself`;
    const res = await this.request(url, 'jira');
    if (!res.ok) return { status: 'failed', message: res.failure.message };

    const body = res.body as JiraMyselfResponse | undefined;
    const displayName = typeof body?.displayName === 'string' ? body.displayName : undefined;
    return { status: 'ok', displayName };
  }

  /**
   * `GET https://api.bitbucket.org/2.0/workspaces/${workspace}`. Confirms the
   * Bitbucket token has access to the configured workspace and surfaces its
   * display name. A 404 here usually means the workspace slug is wrong; we
   * report it as `failed` because it is just as actionable as a 401.
   */
  async validateBitbucket(): Promise<ProbeResult> {
    const missing = this.missingFor(['email', 'bitbucketToken', 'bitbucketWorkspace']);
    if (missing) return { status: 'skipped', message: missing };

    const url = `https://api.bitbucket.org/2.0/workspaces/${encodeURIComponent(this.bitbucketWorkspace)}`;
    // Round-robin across the token list: 'ok' on the first token that validates
    // (cursor sticks there), else the LAST failure after one full pass.
    const res = await withBitbucketFailover(
      this.bitbucketTokens,
      (token) => this.request(url, 'bitbucket', token),
      (r) => !r.ok,
    );
    if (!res.ok) return { status: 'failed', message: res.failure.message };

    const body = res.body as BitbucketWorkspaceResponse | undefined;
    const displayName =
      typeof body?.name === 'string'
        ? body.name
        : typeof body?.slug === 'string'
          ? body.slug
          : undefined;
    return { status: 'ok', displayName };
  }

  // ─── Best-effort domain probes ────────────────────────────────────────

  /**
   * `GET ${jiraBase}/rest/api/3/issue/${key}?fields=status`. 200 → exists,
   * with the status name when present. 404 → missing. Anything else → missing
   * (best-effort; the UI uses URL-builder fallback so a probe failure never
   * blocks the user from clicking through).
   */
  async checkTicketExists(key: string): Promise<TicketCheckResult> {
    if (!key) return { exists: false };
    if (!this.email || !this.jiraToken || !this.jiraBase) return { exists: false };

    const url = `${this.jiraBase}/rest/api/3/issue/${encodeURIComponent(key)}?fields=status`;
    const res = await this.request(url, 'jira');
    if (!res.ok) {
      // A 404 is a genuine "ticket does not exist" — preserve the historical
      // plain `{ exists: false }` for it. Any other failure (auth / ratelimit /
      // network / 5xx) is propagated so a caller can tell it apart from a real
      // absence instead of being told the ticket simply is not there.
      if (res.failure.httpStatus === 404) return { exists: false };
      return { exists: false, failure: res.failure };
    }
    const body = res.body as JiraIssueResponse | undefined;
    const status = body?.fields?.status?.name;
    return { exists: true, status: typeof status === 'string' ? status : undefined };
  }

  /**
   * `GET ${jiraBase}/rest/api/3/issue/${key}?fields=summary,status,description`.
   * 200 → `{ exists: true }` with `status`, `summary`, and the raw ADF
   * `description` JSON tree (opaque here — the consumer in `adf-to-text.ts`
   * walks it). 404 → `{ exists: false }`. Any other failure (auth, network,
   * timeout, non-2xx) → `{ exists: false, error: <sanitized message> }`.
   * Never throws; same security and timeout contract as `checkTicketExists`.
   */
  async getTicketDetails(key: string): Promise<TicketDetailsResult> {
    if (!key) return { exists: false };
    if (!this.email || !this.jiraToken || !this.jiraBase) return { exists: false };

    const url = `${this.jiraBase}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status,description`;
    const res = await this.request(url, 'jira');
    if (!res.ok) {
      // A 404 means the ticket doesn't exist; anything else is a real failure
      // we forward as a sanitized `error`. The failure discriminant now carries
      // the HTTP status directly, so we no longer sniff the message prefix.
      if (res.failure.httpStatus === 404) return { exists: false };
      return { exists: false, error: res.failure.message || 'request failed' };
    }
    const body = res.body as JiraIssueResponse | undefined;
    const status = body?.fields?.status?.name;
    const summary = body?.fields?.summary;
    const description = body?.fields?.description;
    return {
      exists: true,
      status: typeof status === 'string' ? status : undefined,
      summary: typeof summary === 'string' ? summary : undefined,
      description,
    };
  }

  /**
   * Find the PR for a branch. Queries the exact-branch BBQL match
   * (`source.branch.name="${branch}"`) against `state=OPEN` FIRST; if that
   * returns no match it falls back to the closed states
   * (`MERGED` / `DECLINED` / `SUPERSEDED`) for the SAME branch, so a merged /
   * closed PR (and its CodeRabbit comments) stays reachable instead of being
   * reported as "no PR". The caller-facing default is unchanged — the OPEN PR
   * wins when present; the fallback only fires when OPEN is genuinely empty.
   *
   * Returns the found PR's HTML URL, title, id, and `prState`. A 2xx response
   * with an empty `values` array in EVERY state is the genuine "no PR" case and
   * returns `{ prUrl: null }` (the same success shape as before). A real request
   * failure (auth / ratelimit / network / other non-2xx) returns
   * `{ prUrl: null, failure }` so the caller can tell a failed lookup apart from
   * a truly absent PR; a 404 (or an unresolvable workspace) is surfaced as a
   * DISTINCT workspace-misconfiguration failure rather than a bare not-found.
   */
  async findOpenPrForBranch(repoSlug: string, branch: string): Promise<PrLookupResult> {
    if (!repoSlug || !branch) return { prUrl: null };
    // Missing email / token is "not configured" — skip silently exactly as
    // before (a genuine no-PR success, not a failure).
    if (!this.email || this.bitbucketTokens.length === 0) return { prUrl: null };

    // Resolve the workspace from the configured value. We do not have a git
    // remote URL cheaply available in this REST client, so pass `undefined`;
    // `source: 'none'` then means "no workspace configured at all", which is a
    // config problem worth surfacing distinctly rather than a silent no-PR.
    const resolved = resolveBitbucketWorkspace(this.bitbucketWorkspace, undefined);
    if (resolved.source === 'none' || !resolved.workspace) {
      return { prUrl: null, failure: this.workspaceMisconfigFailure(this.bitbucketWorkspace) };
    }
    const workspace = resolved.workspace;

    // OPEN first — the historical behavior and the caller-facing default.
    const open = await this.queryPrsForBranch(workspace, repoSlug, branch, '&state=OPEN');
    if (!open.ok) return { prUrl: null, failure: this.mapLookupFailure(open.failure, workspace) };
    const openPick = this.pickPr(open.values);
    if (openPick) return this.toLookupResult(openPick, 'OPEN');

    // No OPEN match — fall back to the closed states for the same branch so a
    // merged / declined / superseded PR is still found. Bitbucket accepts
    // repeated `state` params, so one query covers all three.
    const closed = await this.queryPrsForBranch(
      workspace,
      repoSlug,
      branch,
      '&state=MERGED&state=DECLINED&state=SUPERSEDED',
    );
    if (!closed.ok) return { prUrl: null, failure: this.mapLookupFailure(closed.failure, workspace) };
    const closedPick = this.pickPr(closed.values);
    if (closedPick) return this.toLookupResult(closedPick, normalizePrState(closedPick.state));

    // 2xx with no matching PR in ANY state is the genuine "none" case — the same
    // no-PR success this method has always returned.
    return { prUrl: null };
  }

  /**
   * Run the exact-branch PR query for a given `state` param string, round-robin
   * across the token list (a 2xx — including an empty `values` — is SUCCESS and
   * sticks the cursor; any failure rotates to the next token, last failure
   * returned after one full pass). Returns the parsed `values` on success or the
   * `RequestFailure` on failure. The BBQL match is UNCHANGED — only the `state`
   * params vary between the OPEN and the closed-states calls.
   */
  private async queryPrsForBranch(
    workspace: string,
    repoSlug: string,
    branch: string,
    stateParams: string,
  ): Promise<{ ok: true; values: BitbucketPullRequest[] } | { ok: false; failure: RequestFailure }> {
    // Bitbucket's `q=` is a BBQL expression — the branch name must be wrapped in
    // double-quotes inside the query string. `encodeURIComponent` handles the
    // URL-level escaping; the inner quotes stay as `%22`.
    const q = encodeURIComponent(`source.branch.name="${branch}"`);
    const url =
      `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(workspace)}` +
      `/${encodeURIComponent(repoSlug)}/pullrequests?q=${q}${stateParams}`;
    const res = await withBitbucketFailover(
      this.bitbucketTokens,
      (token) => this.request(url, 'bitbucket', token),
      (r) => !r.ok,
    );
    if (!res.ok) return { ok: false, failure: res.failure };
    const body = res.body as BitbucketPullRequestListResponse | undefined;
    const values = Array.isArray(body?.values) ? body!.values! : [];
    return { ok: true, values };
  }

  /**
   * Deterministically pick ONE PR when a branch has multiple in the queried
   * state(s) (rare, but possible — e.g. a reopened + a superseded PR). Newest by
   * `updated_on` wins; ties or missing timestamps break by the higher `id`. This
   * replaces a blind `values[0]`, whose order Bitbucket does not guarantee.
   */
  private pickPr(values: BitbucketPullRequest[]): BitbucketPullRequest | undefined {
    if (values.length === 0) return undefined;
    if (values.length === 1) return values[0];
    return [...values].sort((a, b) => {
      const at = a.updated_on ? Date.parse(a.updated_on) : NaN;
      const bt = b.updated_on ? Date.parse(b.updated_on) : NaN;
      const av = Number.isFinite(at) ? at : -Infinity;
      const bv = Number.isFinite(bt) ? bt : -Infinity;
      if (av !== bv) return bv - av;
      const ai = typeof a.id === 'number' ? a.id : -Infinity;
      const bi = typeof b.id === 'number' ? b.id : -Infinity;
      return bi - ai;
    })[0];
  }

  /** Shape a picked PR into the `PrLookupResult`. A row without a usable HTML
   *  href is treated as no-PR (we cannot link to it) — preserving the historical
   *  behavior where a value with no href returned `{ prUrl: null }`. */
  private toLookupResult(pr: BitbucketPullRequest, state: BitbucketPrState | undefined): PrLookupResult {
    const href = pr.links?.html?.href;
    if (typeof href !== 'string') return { prUrl: null };
    return {
      prUrl: href,
      prTitle: typeof pr.title === 'string' ? pr.title : undefined,
      prId: typeof pr.id === 'number' ? pr.id : undefined,
      prState: state,
      // Author handle for the author-vs-reviewer boot check. `nickname` is the
      // matchable username-like handle; `display_name` is the human label.
      prAuthor: typeof pr.author?.nickname === 'string' ? pr.author.nickname : undefined,
      prAuthorDisplay:
        typeof pr.author?.display_name === 'string' ? pr.author.display_name : undefined,
    };
  }

  /** Map a lookup `RequestFailure` for the caller. A 404 means the workspace /
   *  repo slug is wrong, so rewrite it into the DISTINCT, actionable
   *  workspace-misconfiguration message; every other failure passes through
   *  unchanged so its Phase-0 kind / message / retryAfter still surface. */
  private mapLookupFailure(failure: RequestFailure, workspace: string): RequestFailure {
    if (failure.httpStatus === 404) return this.workspaceMisconfigFailure(workspace);
    return failure;
  }

  /** Build the workspace-misconfiguration failure. Kept as one helper so the
   *  "empty workspace" and "404 from the query" paths surface identical text. */
  private workspaceMisconfigFailure(workspace: string): RequestFailure {
    return {
      kind: 'error',
      httpStatus: 404,
      message:
        `Bitbucket workspace may be misconfigured (tried '${workspace || ''}') ` +
        `— check the bitbucketWorkspace setting`,
    };
  }

  // ─── Internal: request + error mapping ────────────────────────────────

  /**
   * Execute a GET request with the Basic-auth header, an 8 s timeout, and
   * JSON-body parsing. Returns a normalized `{ ok, result?, body? }` shape so
   * callers never see a thrown error.
   *
   * The `product` parameter selects which token authenticates the request —
   * `'jira'` reads `this.jiraToken`; `'bitbucket'` uses the explicit
   * `bitbucketToken` the failover loop hands in per attempt (so a token swap
   * takes effect on this exact request). Public methods short-circuit before
   * calling here when the relevant token is empty, so by the time we reach this
   * function the chosen token is non-empty. The two-product separation is
   * enforced by the parameter — there is no fallback or cross-product behavior.
   *
   * Token leak audit: the `Authorization` header value is set on the request
   * init object that lives only inside this function and is never logged.
   * Error paths capture only `url`, `status`, `statusText`, and the error
   * message text from the AbortError / network failure — none of which can
   * contain either token.
   */
  private async request(
    url: string,
    product: 'jira' | 'bitbucket',
    bitbucketToken?: string,
  ): Promise<
    | { ok: true; body: unknown }
    | { ok: false; failure: RequestFailure }
  > {
    // Select the token here (never inside the retried attempt) so it is read
    // once and the two-product separation stays enforced by the parameter.
    const token = product === 'jira' ? this.jiraToken : (bitbucketToken ?? '');
    // Bounded transient retry on the SAME token, composed UNDER the outer token
    // rotation: a TRANSIENT failure (429 / network / 5xx) retries here with
    // backoff; an auth failure (401/403), a 404, or any other non-2xx returns at
    // once so `withBitbucketFailover` can rotate on auth exactly as before. The
    // token is never logged during a retry — each attempt only passes it into
    // `requestOnce`, which builds the header locally.
    return withTransientRetry(
      () => this.requestOnce(url, token),
      (r) => {
        if (r.ok) return { retry: false };
        const f = r.failure;
        if (f.kind === 'ratelimit') {
          const secs = parseRetryAfterSeconds(f.retryAfter);
          return { retry: true, retryAfterMs: secs !== undefined ? secs * 1000 : undefined };
        }
        if (f.kind === 'network') return { retry: true };
        if (f.kind === 'error' && typeof f.httpStatus === 'number' && f.httpStatus >= 500) {
          return { retry: true };
        }
        return { retry: false };
      },
    );
  }

  /**
   * Perform ONE request attempt. A fresh `AbortController` / timeout is created
   * per call so every retry gets its own 8 s deadline. Same status mapping and
   * token-leak audit as before — the `Authorization` header value is the only
   * place the token appears and is never logged or added to an error payload.
   */
  private async requestOnce(
    url: string,
    token: string,
  ): Promise<
    | { ok: true; body: unknown }
    | { ok: false; failure: RequestFailure }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const auth = Buffer.from(`${this.email.trim()}:${token.trim()}`).toString('base64');
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          // The header value is the only place the token appears in this
          // process after construction — DO NOT add this object to any log
          // or error payload.
          Authorization: `Basic ${auth}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });

      if (response.status === 401) {
        return {
          ok: false,
          failure: { kind: 'auth', httpStatus: 401, message: '401 Unauthorized — check token' },
        };
      }
      if (response.status === 403) {
        return {
          ok: false,
          failure: { kind: 'auth', httpStatus: 403, message: '403 Forbidden — token lacks access' },
        };
      }
      if (response.status === 404) {
        return {
          ok: false,
          failure: { kind: 'error', httpStatus: 404, message: '404 Not Found — check workspace / base URL' },
        };
      }
      if (response.status === 429) {
        // Rate limited. Capture `Retry-After` verbatim (seconds or an HTTP-date)
        // for a later phase to act on; Phase 0 only carries it, never waits.
        const retryAfter = response.headers.get('retry-after');
        const failure: RequestFailure = {
          kind: 'ratelimit',
          httpStatus: 429,
          message: '429 Too Many Requests — rate limited',
        };
        if (retryAfter) failure.retryAfter = retryAfter;
        return { ok: false, failure };
      }
      if (!response.ok) {
        return {
          ok: false,
          failure: {
            kind: 'error',
            httpStatus: response.status,
            message: `${response.status} ${response.statusText || 'request failed'}`,
          },
        };
      }

      // 2xx: parse body as JSON. Empty bodies become `undefined`.
      const text = await response.text();
      let body: unknown = undefined;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          // Non-JSON 2xx response — treat as ok with no body. The callers
          // that need a body will gracefully degrade because the shape
          // check below is null-safe.
          body = undefined;
        }
      }
      return { ok: true, body };
    } catch (err) {
      // Sanitized error mapping. We surface only the error name and a generic
      // message — never the request init, the URL's auth query (we don't put
      // tokens in URLs anyway), or any header value.
      const aborted =
        (err instanceof Error && err.name === 'AbortError') ||
        controller.signal.aborted;
      if (aborted) {
        return {
          ok: false,
          failure: { kind: 'network', message: 'Request timed out — try again' },
        };
      }
      return {
        ok: false,
        failure: { kind: 'network', message: 'Network error — try again' },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Returns a human-readable `"Missing: …"` string if any required field is
   * empty, otherwise `undefined`. Used by validation probes to short-circuit
   * into the `'skipped'` shape with an explanatory message. The field names
   * surfaced here ("jiraToken", "bitbucketToken", …) match the constructor
   * option keys so the message is greppable back to the call site.
   */
  private missingFor(
    required: ReadonlyArray<'email' | 'jiraToken' | 'bitbucketToken' | 'jiraBase' | 'bitbucketWorkspace'>,
  ): string | undefined {
    const missing: string[] = [];
    for (const k of required) {
      // `bitbucketToken` presence is now "at least one token in the rotation
      // list"; the key name is kept so the surfaced message stays greppable.
      const v =
        k === 'email' ? this.email
        : k === 'jiraToken' ? this.jiraToken
        : k === 'bitbucketToken' ? (this.bitbucketTokens.length > 0 ? 'set' : '')
        : k === 'jiraBase' ? this.jiraBase
        : this.bitbucketWorkspace;
      if (!v) missing.push(k);
    }
    if (missing.length === 0) return undefined;
    return `Missing: ${missing.join(', ')}`;
  }
}
