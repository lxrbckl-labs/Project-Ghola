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
import { plainTextToAdf } from './adf-to-text';

/** Per-request timeout. Long enough to absorb a transient hiccup, short
 *  enough that a wedged network never blocks the extension UI thread.        */
const REQUEST_TIMEOUT_MS = 8000;

/** Page size for the Jira comment read. Jira caps `maxResults` server-side, so
 *  this is a request, not a guarantee — the loop follows `startAt` / `total`. */
const COMMENT_PAGE_SIZE = 100;

/** Hard cap on comment pages fetched per call (100 * 20 = 2000 comments). A
 *  runaway guard only: no real ticket approaches it, but it keeps a misbehaving
 *  or paging-ignorant server from spinning the loop forever. */
const MAX_COMMENT_PAGES = 20;

/** Wall-clock budget for the ENTIRE Jira comment pagination walk.
 *
 *  The page cap ALONE does not bound this walk in time. Each page is a
 *  `request()` call carrying its own transient-retry budget — up to 4 attempts
 *  at `REQUEST_TIMEOUT_MS` plus `MAX_TOTAL_RETRY_WAIT_MS` of backoff, ~41 s in
 *  the worst case — so 20 pages multiplies out to roughly 13.7 MINUTES. No
 *  client would ever wait that long, which is precisely how a healthy-but-slow
 *  read gets misreported as a dead bridge.
 *
 *  Mirrors `COMMENT_WALK_BUDGET_MS` in `bitbucket-pr-client.ts` and is
 *  deliberately the same 45 s: the two comment walks should fail the same way at
 *  the same scale, so an operator learns ONE model. On expiry we return the
 *  pages already fetched, flagged `truncated`, rather than failing the call. */
const COMMENT_WALK_BUDGET_MS = 45000;

/** Result shape returned by validation probes. Mirrors the discriminated
 *  union exported from `extension.ts` as `AtlassianValidationResult`. */
export interface ProbeResult {
  status: 'ok' | 'failed' | 'skipped';
  message?: string;
  displayName?: string;
  /** Present ONLY on a real request failure (auth / ratelimit / network / other
   *  non-2xx). A `'skipped'` probe (missing credentials) stays the plain
   *  `{ status: 'skipped', message }` this method has always returned — that is
   *  a precondition gap, not a request failure. */
  failure?: RequestFailure;
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
  /** Set when the probe never ran because a precondition was unmet — an empty
   *  key, or Jira not being configured at all. Purely ADDITIVE: `exists` is
   *  still `false` in those cases, so every historical caller that only reads
   *  `exists` behaves exactly as before. It exists so "no credentials" cannot
   *  masquerade as "no ticket" — the same distinction `getIssueComments` and
   *  `getTicketDetails` draw. A request that actually ran and failed reports
   *  `failure`, not `error`. */
  error?: string;
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

/** One Jira issue comment, as returned by `getIssueComments`. `body` is the raw
 *  ADF JSON tree (opaque here — the consumer in `adf-to-text.ts` walks it), the
 *  same contract `TicketDetailsResult.description` follows. */
export interface IssueComment {
  /** `author.displayName` when Jira sent one; `''` for an anonymous / app
   *  comment where the field is absent, so the wire shape stays a string. */
  author: string;
  /** ISO-8601 creation timestamp verbatim from Jira; `''` when absent. */
  created: string;
  /** ADF document tree for the comment body. */
  body: unknown;
}

/** Per-call return shape for `getIssueComments`. A found issue with ZERO
 *  comments is `{ exists: true, comments: [] }` — that is SUCCESS, not a
 *  failure, and callers must not collapse it into "not found". `error` is set
 *  ONLY on a real failure (unconfigured Jira, auth, ratelimit, network, or a
 *  non-404 non-2xx); a genuine 404 is the plain `{ exists: false, comments: [] }`. */
export interface IssueCommentsResult {
  exists: boolean;
  comments: IssueComment[];
  error?: string;
  /** Non-fatal, user-facing note on an OTHERWISE SUCCESSFUL read — currently
   *  only truncation. Kept separate from `error` so a partial-but-usable result
   *  is never mistaken for a failed one. Mirrors `PrCommentListResult.message`. */
  message?: string;
  /** True when the pagination walk stopped early (page cap or time budget), so
   *  `comments` is a PREFIX of the issue's comments rather than all of them.
   *  Before this existed the walk could silently hit `MAX_COMMENT_PAGES` and
   *  return a partial thread that every caller read as complete — a partial
   *  answer indistinguishable from a whole one is the worst kind of failure,
   *  because nothing looks wrong. Mirrors `PrCommentListResult.truncated`. */
  truncated?: boolean;
  /** Jira's own `total` for the thread when it reported one, so a caller can
   *  render an honest "N of M fetched". Undefined when absent — never guessed. */
  totalAvailable?: number;
}

/** Result shape for `postIssueComment` — the ONE Jira write path in the
 *  extension, and only reachable when the operator has turned on
 *  `integration.atlassian-suite`'s `enableJiraCommentWrite` setting.
 *
 *  `posted: true` means Jira accepted the comment and returned its id. Any
 *  other outcome sets `error`, and `posted` is then FALSE-but-uncertain in
 *  exactly one case worth calling out: a network drop or timeout after the
 *  request left the host. The comment may or may not exist on the issue. That
 *  ambiguity is why `postIssueComment` never retries — see the method doc. */
export interface PostCommentResult {
  posted: boolean;
  /** Jira's id for the created comment; present only when `posted` is true. */
  id?: string;
  error?: string;
}

/** ONE workflow transition Jira currently offers on an issue, as returned by
 *  `getIssueTransitions`.
 *
 *  The three required fields are the whole contract a caller needs to CHOOSE:
 *  `id` is what `transitionIssue` executes, `name` is the transition's own label
 *  (the verb on the button — e.g. `"Start Review"`), and `toStatus` is the
 *  status the issue lands in (e.g. `"In Review"`). They are kept separate on
 *  purpose: a transition's name and its destination are frequently different
 *  words, and a caller matching a target STATUS against a transition NAME is how
 *  the wrong button gets pressed.
 *
 *  NOTHING IN THIS CLIENT PICKS A TRANSITION. This shape exists so the caller can
 *  see every option and name one by `id`; there is deliberately no fuzzy match,
 *  no closest-match fallback, and no "first available" default anywhere below. */
export interface IssueTransition {
  /** Jira's transition id — the value `transitionIssue` takes. A STRING: Jira
   *  reports these as numeric strings and they must not be coerced to numbers. */
  id: string;
  /** The transition's own name, verbatim from Jira; `''` when absent. */
  name: string;
  /** `to.name` — the status the issue would end up in; `''` when absent. */
  toStatus: string;
  /** Jira's `hasScreen`: the transition pops a transition SCREEN in the UI.
   *  Undefined when Jira did not report it — never guessed. A screen alone does
   *  not mean the transition will fail from the API; `requiredFields` is the
   *  field that actually predicts that. */
  hasScreen?: boolean;
  /** Names (falling back to field ids) of fields the transition screen marks
   *  REQUIRED, read from the `expand=transitions.fields` metadata. Populated only
   *  when at least one such field exists, so its presence is the signal: a
   *  transition listed here cannot be executed by a bare id POST and needs a
   *  human in Jira. Detected BEFORE the operator is asked to approve anything, so
   *  the ask can say "this one needs fields filled in" rather than discovering it
   *  as a 400 halfway through. */
  requiredFields?: string[];
}

/** Per-call return shape for `getIssueTransitions`. A found issue with ZERO
 *  available transitions is `{ exists: true, transitions: [] }` — that is
 *  SUCCESS (the issue is in a terminal status, or this account may not move it),
 *  never "not found". `error` is set ONLY on a real failure (unconfigured Jira,
 *  auth, ratelimit, network, or a non-404 non-2xx); a genuine 404 is the plain
 *  `{ exists: false, transitions: [] }`. Same three-way distinction
 *  `getIssueComments` draws, for the same reason. */
export interface IssueTransitionsResult {
  exists: boolean;
  transitions: IssueTransition[];
  error?: string;
}

/** Result shape for `transitionIssue` — the SECOND (and only other) Jira write
 *  in the extension, reachable only when the operator has turned on
 *  `integration.atlassian-suite`'s `enableJiraTransition` setting.
 *
 *  READ `transitioned` NARROWLY: it means JIRA ACCEPTED THE REQUEST (a 2xx —
 *  Jira answers a successful transition with 204 No Content and no body). It is
 *  NOT a re-read of the issue and NOT a claim about the issue's current status.
 *  A workflow post-function can move the issue on again the instant the
 *  transition lands, so the only honest thing this shape reports is WHAT WAS
 *  REQUESTED — hence `transitionId` echoing the id that was executed, and
 *  deliberately no `status` / `newStatus` field. A caller that needs the
 *  resulting status must go and read it.
 *
 *  Any other outcome sets `error`, and `transitioned` is then FALSE-but-uncertain
 *  in exactly one case worth calling out: a network drop or timeout after the
 *  request left the host. The transition may or may not have been applied. That
 *  ambiguity is why `transitionIssue` never retries — see the method doc. */
export interface TransitionIssueResult {
  transitioned: boolean;
  /** The transition id that was REQUESTED, echoed back so a caller (or a log
   *  line) records which button was pressed. Present whenever a request was
   *  actually made, including on a failure. */
  transitionId?: string;
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
  /** Whether the found PR is a DRAFT (`true`) or ready for review (`false`).
   *  Read verbatim from the `draft` boolean on the PR row Bitbucket returned for
   *  the branch query — the same field `bitbucket-pr-client.ts` sets via
   *  `markPrReady` / `markPrDraft` and echoes back on every PUT.
   *
   *  ABSENT IS NOT `false`. Bitbucket's pull-request LIST endpoint returns a
   *  partial serialization of each PR, so `draft` can simply not be in the
   *  response; it is also absent on the genuine no-PR case and on a request
   *  failure. `undefined` therefore means "we did not learn whether this PR is a
   *  draft", and a caller must not read it as "it is ready" — that would let a
   *  draft PR be reported as ready-for-review on nothing more than a missing
   *  field. Same never-guessed rule as `prState` and `totalAvailable`. */
  draft?: boolean;
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

/** Minimal slice of Jira `/issue/<key>/comment` that we read. The page carries
 *  the comments under a `comments` array plus the standard `startAt` / `total`
 *  pagination counters. */
interface JiraCommentResponse {
  author?: { displayName?: string };
  created?: string;
  /** ADF document tree — opaque shape; walked by `adf-to-text.ts`. */
  body?: unknown;
}
interface JiraCommentsPageResponse {
  comments?: JiraCommentResponse[];
  startAt?: number;
  total?: number;
}

/** Minimal slice of Jira `/issue/<key>/transitions?expand=transitions.fields`.
 *  `fields` is the per-transition screen metadata the expand adds: a map of
 *  field id -> metadata, of which we read only `required` and the human `name`.
 *  It is absent entirely when the transition has no screen. */
interface JiraTransitionFieldMeta {
  required?: boolean;
  name?: string;
}
interface JiraTransitionResponse {
  id?: string;
  name?: string;
  to?: { name?: string };
  hasScreen?: boolean;
  fields?: Record<string, JiraTransitionFieldMeta>;
}
interface JiraTransitionsResponse {
  transitions?: JiraTransitionResponse[];
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
  /** Bitbucket's own draft flag. OPTIONAL because the list endpoint returns a
   *  partial serialization and may omit it — see `PrLookupResult.draft`. */
  draft?: boolean;
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
    if (!res.ok) return { status: 'failed', message: res.failure.message, failure: res.failure };

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
    if (!res.ok) return { status: 'failed', message: res.failure.message, failure: res.failure };

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
   *
   * The two preconditions that stop the probe before it ever fires — an empty
   * key, and Jira not being configured — still return `exists: false`, but now
   * carry an explanatory `error` so a reader can tell them apart from a real
   * "this ticket is not in Jira". Same wording as `getIssueComments` and
   * `getTicketDetails` use for the identical case.
   */
  async checkTicketExists(key: string): Promise<TicketCheckResult> {
    if (!key) return { exists: false, error: 'issue key is required' };
    if (!this.email || !this.jiraToken || !this.jiraBase) {
      return { exists: false, error: 'Jira not configured' };
    }

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
   *
   * Three outcomes callers MUST keep distinct — collapsing them is a defect
   * that has already cost real debugging time (an agent reported "ticket not
   * found" when the truth was that Jira had never been configured):
   *   - `{ exists: true, ... }`             — the ticket was fetched.
   *   - `{ exists: false }` with no `error` — genuine 404, the ticket is not there.
   *   - any `error`                         — a real failure. An unconfigured
   *     Jira reports `'Jira not configured'` (the same wording
   *     `getIssueComments` uses), so "no credentials" never masquerades as
   *     "no ticket".
   */
  async getTicketDetails(key: string): Promise<TicketDetailsResult> {
    if (!key) return { exists: false, error: 'issue key is required' };
    if (!this.email || !this.jiraToken || !this.jiraBase) {
      return { exists: false, error: 'Jira not configured' };
    }

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
   * `GET ${jiraBase}/rest/api/3/issue/${key}/comment`. 200 → `{ exists: true }`
   * with one `IssueComment` per comment in Jira's own (oldest-first) order;
   * each carries `author`, `created`, and the raw ADF `body` tree (opaque here
   * — the consumer in `adf-to-text.ts` walks it). 404 → `{ exists: false }`.
   *
   * Three cases callers MUST keep distinct, because collapsing them has
   * historically produced a bogus "ticket not found":
   *   - `{ exists: true, comments: [] }`  — the issue exists and simply has no
   *     comments. This is SUCCESS.
   *   - `{ exists: false }` with no `error` — genuine 404, the issue is not there.
   *   - any `error` — a real failure (unconfigured Jira, auth, ratelimit,
   *     network, other non-2xx). Unlike `getTicketDetails`, an unconfigured Jira
   *     reports `'Jira not configured'` here rather than a bare `exists: false`,
   *     so "no credentials" never masquerades as "no ticket".
   *
   * Paginates over `startAt` / `total` so a long thread is not silently
   * truncated, with a hard page cap as a runaway guard. Never throws; same
   * security and timeout contract as `getTicketDetails`.
   */
  async getIssueComments(key: string): Promise<IssueCommentsResult> {
    if (!key) return { exists: false, comments: [], error: 'issue key is required' };
    if (!this.email || !this.jiraToken || !this.jiraBase) {
      return { exists: false, comments: [], error: 'Jira not configured' };
    }

    const base = `${this.jiraBase}/rest/api/3/issue/${encodeURIComponent(key)}/comment`;
    const comments: IssueComment[] = [];
    let startAt = 0;
    let stopReason: 'page-cap' | 'time-budget' | undefined;
    let totalAvailable: number | undefined;
    let pagesFetched = 0;
    const deadline = Date.now() + COMMENT_WALK_BUDGET_MS;

    for (let page = 0; page < MAX_COMMENT_PAGES; page++) {
      // Checked BEFORE issuing the request: starting a page we already know we
      // are out of time for would overshoot the budget by that page's full
      // worst case (~41 s) instead of returning promptly with what we have.
      if (page > 0 && Date.now() >= deadline) {
        stopReason = 'time-budget';
        break;
      }
      const url = `${base}?startAt=${startAt}&maxResults=${COMMENT_PAGE_SIZE}`;
      const res = await this.request(url, 'jira');
      if (!res.ok) {
        // A 404 means the issue doesn't exist; anything else is a real failure
        // we forward as a sanitized `error`. Same discriminant `getTicketDetails`
        // uses — the HTTP status, never a message prefix sniff.
        if (res.failure.httpStatus === 404) return { exists: false, comments: [] };
        return { exists: false, comments: [], error: res.failure.message || 'request failed' };
      }

      const body = res.body as JiraCommentsPageResponse | undefined;
      const page1 = Array.isArray(body?.comments) ? body.comments : [];
      for (const raw of page1) {
        comments.push({
          author: typeof raw?.author?.displayName === 'string' ? raw.author.displayName : '',
          created: typeof raw?.created === 'string' ? raw.created : '',
          body: raw?.body,
        });
      }

      // Stop when Jira reports we have them all, or when a page came back empty
      // (defensive: a server that ignores `startAt` would otherwise loop until
      // the page cap without ever making progress).
      const total = typeof body?.total === 'number' ? body.total : undefined;
      if (totalAvailable === undefined && total !== undefined) totalAvailable = total;
      pagesFetched++;
      if (page1.length === 0) break;
      if (total !== undefined && comments.length >= total) break;
      startAt += page1.length;
      // Falling out of the loop having exhausted every iteration means the cap
      // stopped us mid-thread — distinct from the two clean breaks above, which
      // both mean we genuinely reached the end.
      if (page === MAX_COMMENT_PAGES - 1) stopReason = 'page-cap';
    }

    const result: IssueCommentsResult = { exists: true, comments };
    if (stopReason) {
      result.truncated = true;
      // Kept character-for-character parallel with the truncation message in
      // `bitbucket-pr-client.ts`: same `Partial result — <scope>; <why>.`
      // template, same `N of ~M` scope phrasing, same trailing sentence. An
      // operator hitting the cap on a Jira thread and on a PR should read the
      // same sentence, not two dialects of the same fact.
      //
      // The `~` is honest for both: the total is read from the FIRST page, and a
      // thread someone is actively commenting on can grow underneath a walk that
      // is still in progress.
      const scope = totalAvailable !== undefined
        ? `${comments.length} of ~${totalAvailable} comments fetched`
        : `${comments.length} comments fetched`;
      const why = stopReason === 'page-cap'
        ? `hit the ${MAX_COMMENT_PAGES}-page cap`
        : `ran out of the ${Math.round(COMMENT_WALK_BUDGET_MS / 1000)}s fetch budget after ${pagesFetched} page(s)`;
      // Deliberately `message`, NOT `error`. This is a SUCCESSFUL partial read,
      // and `error` is the failure channel every consumer of this shape checks —
      // populating it here would flip a usable result into an apparent failure.
      result.message = `Partial result — ${scope}; ${why}. The remaining comments were omitted.`;
    }
    if (totalAvailable !== undefined) result.totalAvailable = totalAvailable;
    return result;
  }

  /**
   * `POST ${jiraBase}/rest/api/3/issue/${key}/comment` — add a comment to an
   * issue. This is the extension's ONLY Jira mutation. Every other Jira path
   * here is a read, and this one exists solely to serve
   * `integration.atlassian-suite`'s Jira Comment Write flow; with that module's
   * `enableJiraCommentWrite` gate off nothing reaches this method.
   *
   * `bodyText` is PLAIN TEXT. Jira demands an ADF document, so the text is
   * wrapped by `plainTextToAdf` — paragraphs on blank lines, no markdown
   * interpretation (see that function's doc for the deliberate limits).
   * An empty / whitespace-only body is rejected here rather than posted, since
   * Jira would either 400 or create a meaningless empty comment.
   *
   * **Deliberately NEVER retried.** This calls `requestOnce` directly instead of
   * `request`, bypassing the transient-retry wrapper the read paths use. A POST
   * that times out or drops mid-flight is AMBIGUOUS — Jira may well have
   * created the comment before the connection died — so a retry risks posting
   * the same comment twice on a ticket other people are reading. One attempt,
   * then an honest error the operator can check and decide about. Do not
   * "improve" this by adding a retry.
   *
   * Never throws; same timeout and token-leak contract as the read paths.
   */
  async postIssueComment(key: string, bodyText: string): Promise<PostCommentResult> {
    if (!key || !key.trim()) return { posted: false, error: 'issue key is required' };
    if (typeof bodyText !== 'string' || bodyText.trim() === '') {
      return { posted: false, error: 'comment body is required' };
    }
    if (!this.email || !this.jiraToken || !this.jiraBase) {
      return { posted: false, error: 'Jira not configured' };
    }

    const url = `${this.jiraBase}/rest/api/3/issue/${encodeURIComponent(key.trim())}/comment`;
    const payload = { body: plainTextToAdf(bodyText) };

    // Single attempt, no retry wrapper — see the method doc.
    const res = await this.requestOnce(url, this.jiraToken, payload);
    if (!res.ok) {
      // A 404 here is a missing issue rather than a bad base URL, but it is
      // still just a failure to post — there is no `exists` channel on this
      // shape, so it is reported as a plain error with Jira's own status text.
      return { posted: false, error: res.failure.message || 'request failed' };
    }

    const body = res.body as { id?: unknown } | undefined;
    return {
      posted: true,
      ...(typeof body?.id === 'string' ? { id: body.id } : {}),
    };
  }

  /**
   * `GET ${jiraBase}/rest/api/3/issue/${key}/transitions?expand=transitions.fields`
   * — the transitions Jira will currently accept on this issue FOR THIS ACCOUNT.
   * A READ: it changes nothing, so it goes through `request` and keeps the same
   * transient-retry budget every other read here has.
   *
   * Three outcomes callers MUST keep distinct, exactly as `getIssueComments`
   * does:
   *   - `{ exists: true, transitions: [] }` — the issue exists and offers no
   *     transitions (terminal status, or this account may not move it). SUCCESS.
   *   - `{ exists: false, transitions: [] }` with no `error` — genuine 404.
   *   - any `error` — a real failure, with `'Jira not configured'` for the
   *     no-credentials case so it never masquerades as "no ticket".
   *
   * WHY `expand=transitions.fields`: without it the response says nothing about
   * whether a transition's screen demands mandatory fields, and the only way to
   * find out is to attempt the transition and read the 400. That is the worst
   * possible moment to discover it — the operator has already been asked to
   * approve a move that was never going to work. With the expand, `requiredFields`
   * is populated here and the caller can say so BEFORE asking.
   *
   * THIS METHOD DOES NOT CHOOSE. It reports what Jira offers, in Jira's own
   * order, and stops. Matching a target status name, handling ambiguity when two
   * transitions land in the same status, and deciding what to do when none match
   * are all the CALLER's job. There is no fuzzy matching and no default pick here
   * — a client that guesses which button to press turns an operator-approved
   * "move it to In Review" into an unreviewable action at a distance.
   *
   * Never throws; same security and timeout contract as the other reads.
   */
  async getIssueTransitions(key: string): Promise<IssueTransitionsResult> {
    if (!key || !key.trim()) return { exists: false, transitions: [], error: 'issue key is required' };
    if (!this.email || !this.jiraToken || !this.jiraBase) {
      return { exists: false, transitions: [], error: 'Jira not configured' };
    }

    const url =
      `${this.jiraBase}/rest/api/3/issue/${encodeURIComponent(key.trim())}` +
      '/transitions?expand=transitions.fields';
    const res = await this.request(url, 'jira');
    if (!res.ok) {
      // Same discriminant the other reads use — the HTTP status, never a message
      // prefix sniff. A 404 is a missing issue; everything else is a failure.
      if (res.failure.httpStatus === 404) return { exists: false, transitions: [] };
      return { exists: false, transitions: [], error: res.failure.message || 'request failed' };
    }

    const body = res.body as JiraTransitionsResponse | undefined;
    const raw = Array.isArray(body?.transitions) ? body!.transitions! : [];
    const transitions: IssueTransition[] = [];
    for (const t of raw) {
      // A transition with no id is unusable — it is precisely the thing
      // `transitionIssue` needs — so it is dropped rather than surfaced as an
      // option the caller cannot act on.
      const id = typeof t?.id === 'string' ? t.id : undefined;
      if (!id) continue;
      const entry: IssueTransition = {
        id,
        name: typeof t.name === 'string' ? t.name : '',
        toStatus: typeof t.to?.name === 'string' ? t.to.name : '',
      };
      if (typeof t.hasScreen === 'boolean') entry.hasScreen = t.hasScreen;
      const fields = t.fields;
      if (fields && typeof fields === 'object') {
        const required: string[] = [];
        for (const [fieldId, meta] of Object.entries(fields)) {
          if (meta?.required !== true) continue;
          // Prefer the human name; fall back to the raw field id so a required
          // field is never reported as an empty string.
          required.push(typeof meta.name === 'string' && meta.name !== '' ? meta.name : fieldId);
        }
        // Set only when non-empty: presence IS the signal (see the field's doc),
        // so an empty array here would read as "checked, and there are some".
        if (required.length > 0) entry.requiredFields = required;
      }
      transitions.push(entry);
    }
    return { exists: true, transitions };
  }

  /**
   * `POST ${jiraBase}/rest/api/3/issue/${key}/transitions` with
   * `{ transition: { id } }` — move an issue along its workflow. This is the
   * extension's SECOND Jira mutation (the first is `postIssueComment`) and it
   * exists solely to serve `integration.atlassian-suite`'s transition flow; with
   * that module's `enableJiraTransition` gate off nothing reaches this method.
   *
   * `transitionId` MUST come from `getIssueTransitions`. This method executes the
   * id it is handed and never derives one: no name matching, no closest match, no
   * falling back to the first available transition. An id Jira does not currently
   * offer comes back as its own 400 rather than being quietly adjusted into
   * something that works.
   *
   * **Deliberately NEVER retried.** Like `postIssueComment` it calls `requestOnce`
   * directly, bypassing the transient-retry wrapper the reads use, for the same
   * reason: a POST that times out or drops mid-flight is AMBIGUOUS — Jira may
   * have applied the transition before the connection died. A blind replay can
   * move the issue a second time (workflows with a loop, or an id that is valid
   * again from the new status), and status changes are what notify a whole team.
   * One attempt, then an honest error a human checks. Do not add a retry.
   *
   * A SUCCESSFUL RESPONSE IS 204 NO CONTENT AND PROVES ONLY THAT JIRA ACCEPTED
   * THE REQUEST. It is not a status read — post-functions and automation rules
   * can move the issue again immediately — so the result describes what was
   * REQUESTED (`transitionId`) and never asserts what the issue's status now is.
   *
   * Never throws; same timeout and token-leak contract as the read paths.
   */
  async transitionIssue(key: string, transitionId: string): Promise<TransitionIssueResult> {
    if (!key || !key.trim()) return { transitioned: false, error: 'issue key is required' };
    if (typeof transitionId !== 'string' || transitionId.trim() === '') {
      return { transitioned: false, error: 'transition id is required' };
    }
    if (!this.email || !this.jiraToken || !this.jiraBase) {
      return { transitioned: false, error: 'Jira not configured' };
    }

    const id = transitionId.trim();
    const url = `${this.jiraBase}/rest/api/3/issue/${encodeURIComponent(key.trim())}/transitions`;
    const payload = { transition: { id } };

    // Single attempt, no retry wrapper — see the method doc.
    const res = await this.requestOnce(url, this.jiraToken, payload, 'transition');
    if (!res.ok) {
      // No `exists` channel on this shape, so a 404 (missing issue) and a 400
      // (id not currently offered / mandatory fields on the screen) both surface
      // as a plain error carrying Jira's own status text.
      return { transitioned: false, transitionId: id, error: res.failure.message || 'request failed' };
    }
    // 204 No Content — there is no body to read, and deliberately nothing here
    // claims what the issue's status became.
    return { transitioned: true, transitionId: id };
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
    // Missing email / token is NOT a confirmed "no PR" — it is an UNCHECKED
    // absence. A bare `{ prUrl: null }` would tell the caller "Bitbucket
    // confirmed there is no PR", which is false when we never asked. Surface
    // the gap via `failure` so callers can distinguish the two.
    if (!this.email || this.bitbucketTokens.length === 0) {
      const missing: string[] = [];
      if (!this.email) missing.push('email');
      if (this.bitbucketTokens.length === 0) missing.push('bitbucketToken');
      return {
        prUrl: null,
        failure: { kind: 'auth', message: `Missing: ${missing.join(', ')}` },
      };
    }

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
      // Draft flag straight off the PR row. Guarded on `typeof === 'boolean'`
      // like every other field here, so a response that omits `draft` yields
      // `undefined` ("unknown") rather than a fabricated `false` ("ready").
      draft: typeof pr.draft === 'boolean' ? pr.draft : undefined,
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
   *
   * `jsonBody`, when supplied, switches the verb to POST and sends the value as
   * a JSON request body. Omitting it keeps the historical GET behavior byte for
   * byte, so every existing read path is unaffected. Note that BOTH callers that
   * pass a body (`postIssueComment`, `transitionIssue`) deliberately call this
   * method directly rather than going through `request`, because `request` layers
   * on transient retries — safe for a GET, a double-write hazard for a POST.
   *
   * `mutation` names WHICH write is in flight, and exists only so the
   * ambiguous-outcome message in the catch below can describe the right thing.
   * It defaults to `'comment'` so the historical call site and its exact wording
   * are unchanged. A generic "the request may or may not have been applied" was
   * the alternative and it is worse: the whole value of that message is telling
   * the reader precisely what to go and look at.
   */
  private async requestOnce(
    url: string,
    token: string,
    jsonBody?: unknown,
    mutation: 'comment' | 'transition' = 'comment',
  ): Promise<
    | { ok: true; body: unknown }
    | { ok: false; failure: RequestFailure }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const auth = Buffer.from(`${this.email.trim()}:${token.trim()}`).toString('base64');
      const response = await fetch(url, {
        method: jsonBody !== undefined ? 'POST' : 'GET',
        headers: {
          // The header value is the only place the token appears in this
          // process after construction — DO NOT add this object to any log
          // or error payload.
          Authorization: `Basic ${auth}`,
          Accept: 'application/json',
          ...(jsonBody !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
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

      // A body means this was a POST (see the `jsonBody` note on this method):
      // one of the two Jira mutations, `postIssueComment` or `transitionIssue`.
      // Its outcome after a timeout or a mid-flight drop is INDETERMINATE — Jira
      // may have applied it before we stopped listening.
      //
      // No machine will replay it: both callers call this method directly to stay
      // out of `withTransientRetry`, and Jira's single token never touches
      // `withBitbucketFailover`. The remaining risk is the HUMAN, and it was this
      // message: "try again" is the one instruction guaranteed to produce the
      // duplicate that all that care was taken to prevent. It is worse here than
      // anywhere else, because `integration.atlassian-suite` has the operator
      // approve the exact action first — so re-running feels pre-authorized and
      // the second write is indistinguishable from the first.
      //
      // The two writes name DIFFERENT things to go and check, because "check the
      // issue" is useless advice if the reader does not know what they are
      // looking for: a comment that may be there twice, or a status that may
      // already have moved.
      //
      // Reads are untouched and keep their "try again" wording byte for byte: a
      // GET that timed out changed nothing and is genuinely safe to repeat.
      if (jsonBody !== undefined) {
        const outcome = mutation === 'transition'
          ? {
            lower: 'the transition may or may not have been applied.',
            upper: 'The transition may or may not have been applied.',
            advice: 'CHECK THE ISSUE\'S STATUS before retrying — retrying blindly can move it twice.',
          }
          : {
            lower: 'the comment may or may not have been posted.',
            upper: 'The comment may or may not have been posted.',
            advice: 'CHECK THE ISSUE before retrying — retrying blindly can post it twice.',
          };
        return {
          ok: false,
          failure: {
            kind: 'network',
            message: aborted
              ? `No response from Jira within ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s. `
                + `The request WAS sent, so ${outcome.lower} `
                + outcome.advice
              : 'The connection to Jira failed after the request was sent. '
                + `${outcome.upper} `
                + outcome.advice,
          },
        };
      }

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
