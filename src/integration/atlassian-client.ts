/**
 * Atlassian REST client. Single source of truth for the Jira + Bitbucket Cloud
 * endpoints the extension needs to validate credentials and probe ticket / PR
 * existence for the SCM ticket widget.
 *
 * Security contract — read before extending:
 *   - The constructor receives `email` + (optionally) `jiraToken` and
 *     `bitbucketToken`. Each token is only ever used to construct the
 *     `Authorization: Basic <base64(email:token)>` header for the matching
 *     product's outbound requests. Jira calls authenticate with `jiraToken`;
 *     Bitbucket calls authenticate with `bitbucketToken`. The two flows are
 *     kept strictly separate — there is no shared "current token" field.
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

/** Constructor options. Each product authenticates with its own token; either
 *  may be `undefined` (or empty) — the corresponding methods then short-circuit
 *  to a `'skipped'` / empty-result shape rather than firing a doomed request.
 *  `jiraBase` and `bitbucketWorkspace` follow the same rule. */
export interface AtlassianClientOptions {
  email: string;
  /** Jira API token. Undefined or empty → Jira methods skip without request. */
  jiraToken?: string;
  /** Bitbucket API token. Undefined or empty → Bitbucket methods skip. */
  bitbucketToken?: string;
  jiraBase: string;
  bitbucketWorkspace: string;
}

/** Per-call return shape for `checkTicketExists`. `status` is the Jira issue
 *  status name (e.g. `"In Progress"`) when available. */
export interface TicketCheckResult {
  exists: boolean;
  status?: string;
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

/** Per-call return shape for `findOpenPrForBranch`. `prUrl === null` means
 *  no open PR exists for the branch (or the lookup failed — best effort). */
export interface PrLookupResult {
  prUrl: string | null;
  prTitle?: string;
  prId?: number;
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

/** Minimal slice of the Bitbucket pull-request search response. */
interface BitbucketPullRequest {
  id?: number;
  title?: string;
  links?: { html?: { href?: string } };
}
interface BitbucketPullRequestListResponse {
  values?: BitbucketPullRequest[];
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
  private readonly bitbucketToken: string;
  private readonly jiraBase: string;
  private readonly bitbucketWorkspace: string;

  constructor(opts: AtlassianClientOptions) {
    this.email = opts.email ?? '';
    this.jiraToken = opts.jiraToken ?? '';
    this.bitbucketToken = opts.bitbucketToken ?? '';
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
    if (!res.ok) return res.result; // already shaped as `failed` / `skipped`

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
    const res = await this.request(url, 'bitbucket');
    if (!res.ok) return res.result;

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
    if (!res.ok) return { exists: false };
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
      // `request()` only surfaces a `ProbeResult` shape — the only signal for
      // "missing" vs. "broken" is the message prefix it built. A 404 means the
      // ticket doesn't exist; anything else is a real failure we want to
      // forward as a sanitized `error`.
      const msg = res.result.message ?? '';
      if (msg.startsWith('404')) return { exists: false };
      return { exists: false, error: msg || 'request failed' };
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
   * `GET https://api.bitbucket.org/2.0/repositories/${workspace}/${repoSlug}/pullrequests?q=source.branch.name="${branch}"&state=OPEN`.
   * Returns the first open PR's HTML URL, title, and id. Returns
   * `{ prUrl: null }` when no PR exists or the lookup fails.
   */
  async findOpenPrForBranch(repoSlug: string, branch: string): Promise<PrLookupResult> {
    if (!repoSlug || !branch) return { prUrl: null };
    if (!this.email || !this.bitbucketToken || !this.bitbucketWorkspace) return { prUrl: null };

    // Bitbucket's `q=` is a BBQL expression — the branch name must be wrapped
    // in double-quotes inside the query string. `encodeURIComponent` handles
    // the URL-level escaping; the inner quotes stay as `%22`.
    const q = encodeURIComponent(`source.branch.name="${branch}"`);
    const url =
      `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(this.bitbucketWorkspace)}` +
      `/${encodeURIComponent(repoSlug)}/pullrequests?q=${q}&state=OPEN`;
    const res = await this.request(url, 'bitbucket');
    if (!res.ok) return { prUrl: null };

    const body = res.body as BitbucketPullRequestListResponse | undefined;
    const first = body?.values?.[0];
    const href = first?.links?.html?.href;
    if (!first || typeof href !== 'string') return { prUrl: null };
    return {
      prUrl: href,
      prTitle: typeof first.title === 'string' ? first.title : undefined,
      prId: typeof first.id === 'number' ? first.id : undefined,
    };
  }

  // ─── Internal: request + error mapping ────────────────────────────────

  /**
   * Execute a GET request with the Basic-auth header, an 8 s timeout, and
   * JSON-body parsing. Returns a normalized `{ ok, result?, body? }` shape so
   * callers never see a thrown error.
   *
   * The `product` parameter selects which token authenticates the request —
   * `'jira'` reads `this.jiraToken`, `'bitbucket'` reads `this.bitbucketToken`.
   * Public methods short-circuit before calling here when the relevant token
   * is empty, so by the time we reach this function the chosen token is
   * non-empty. The two-product separation is enforced by the parameter — there
   * is no fallback or cross-product behavior.
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
  ): Promise<
    | { ok: true; body: unknown }
    | { ok: false; result: ProbeResult }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const token = product === 'jira' ? this.jiraToken : this.bitbucketToken;
      const auth = Buffer.from(`${this.email}:${token}`).toString('base64');
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
          result: { status: 'failed', message: '401 Unauthorized — check token' },
        };
      }
      if (response.status === 403) {
        return {
          ok: false,
          result: { status: 'failed', message: '403 Forbidden — token lacks access' },
        };
      }
      if (response.status === 404) {
        return {
          ok: false,
          result: { status: 'failed', message: '404 Not Found — check workspace / base URL' },
        };
      }
      if (!response.ok) {
        return {
          ok: false,
          result: {
            status: 'failed',
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
          result: { status: 'failed', message: 'Request timed out — try again' },
        };
      }
      return {
        ok: false,
        result: { status: 'failed', message: 'Network error — try again' },
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
      const v =
        k === 'email' ? this.email
        : k === 'jiraToken' ? this.jiraToken
        : k === 'bitbucketToken' ? this.bitbucketToken
        : k === 'jiraBase' ? this.jiraBase
        : this.bitbucketWorkspace;
      if (!v) missing.push(k);
    }
    if (missing.length === 0) return undefined;
    return `Missing: ${missing.join(', ')}`;
  }
}
