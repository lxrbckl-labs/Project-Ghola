/**
 * Shared round-robin failover for multi-token Bitbucket requests.
 *
 * ONE in-memory rotation cursor is shared across BOTH Bitbucket request seams
 * (`atlassian-client.ts` and `bitbucket-pr-client.ts`) via this module, so a
 * token that succeeds on one seam is where the next Bitbucket request — on
 * either seam — starts. The cursor persists for the host-process lifetime; it
 * is NOT persisted across extension reloads (a fresh reload restarts at token
 * 0), which the feature contract explicitly allows. Jira has its own single
 * token and never touches this module.
 *
 * Policy (identical for every Bitbucket operation — this is the ONLY place it
 * lives, so both seams share one behavior):
 *   - Start at the shared cursor (modulo N).
 *   - Attempt the whole logical operation with tokens[cursor].
 *   - SUCCESS -> leave the cursor on THIS token (sticky) and return it. A
 *     genuine empty result (e.g. "no PR") is a SUCCESS and does NOT rotate —
 *     that decision is the caller's `isFailure` predicate, not this loop's.
 *   - FAILURE -> advance cursor = (cursor + 1) mod N and retry the next token.
 *   - CAP: at most N attempts (ONE full pass). If all N fail, return the LAST
 *     failure unchanged so its real cause still surfaces. No cooldown, no
 *     dead-marking, no waiting on Retry-After, no second pass, no infinite loop.
 *
 * Single-token subset: a one-element list makes exactly ONE attempt, so a
 * single-token user's observable behavior is identical to the pre-rotation code.
 *
 * Token VALUES are secrets: this module receives them only as opaque strings to
 * hand to the caller's `attempt` callback and NEVER logs, echoes, or stores
 * them. Only the integer cursor is retained between calls.
 */

/** Shared, in-memory rotation cursor. Module-private — mutated only through
 *  `withBitbucketFailover` so the sticky/advance policy lives in one place. */
let rotationCursor = 0;

/**
 * Read the shared cursor normalized into `[0, n)`. Exposed for diagnostics /
 * tests; production code goes through `withBitbucketFailover`.
 */
export function currentBitbucketCursor(n: number): number {
  if (n <= 0) return 0;
  return ((rotationCursor % n) + n) % n;
}

/** Reset the shared cursor to 0. Test-only seam; unused by production paths. */
export function resetBitbucketRotationCursor(): void {
  rotationCursor = 0;
}

/**
 * Run a logical Bitbucket operation with round-robin token failover.
 *
 * `tokenValues` is the ordered list of token VALUES (callers pass the full list;
 * an empty list means "no token" and MUST be handled by the caller's existing
 * short-circuit BEFORE reaching here). `attempt` runs the entire operation —
 * including any pagination — with the token it is handed, rebuilding auth from
 * that token so a swap takes effect for every request in the operation.
 * `isFailure` reports whether a returned result is a FAILURE that should rotate
 * (any non-2xx / network error); a success (including a genuine empty result)
 * returns `false` and sticks the cursor.
 */
export async function withBitbucketFailover<T>(
  tokenValues: string[],
  attempt: (token: string) => Promise<T>,
  isFailure: (result: T) => boolean,
): Promise<T> {
  const n = tokenValues.length;
  // Defensive guard — unreachable in practice because every seam short-circuits
  // an empty token list into its existing "no token" shape before calling here.
  if (n === 0) {
    throw new Error('withBitbucketFailover called with an empty token list');
  }

  const start = currentBitbucketCursor(n);
  let last!: T;
  for (let i = 0; i < n; i++) {
    const idx = (start + i) % n;
    last = await attempt(tokenValues[idx]);
    if (!isFailure(last)) {
      // Sticky: the next request (either seam) starts on this working token.
      rotationCursor = idx;
      return last;
    }
    // Failure: advance so the next attempt tries the following token.
  }
  // One full pass, every token failed. Following the advance-on-failure rule N
  // times lands the cursor back at `start`; persist it and return the LAST
  // failure so its Phase-0 kind / message / httpStatus still surfaces.
  rotationCursor = start;
  return last;
}

// ─── Transient retry (429 / network / 5xx) ──────────────────────────────────
//
// Bounded, SAME-token retry applied INSIDE each request() seam and composed
// UNDER the token-rotation loop above. The two layers are complementary:
//   - TRANSIENT failures (HTTP 429, network/timeout/abort, 5xx) are the server
//     asking us to slow down or a blip on the wire — the SAME token will likely
//     work if we wait and try again, so we retry HERE with backoff.
//   - AUTH failures (401/403) and genuine non-2xx (404, other 4xx) are NOT
//     transient — retrying the same token cannot help, so we return at once and
//     let `withBitbucketFailover` rotate to the next token (auth) or the caller
//     surface the honest result (404).
// Because retry lives below failover, the outer loop keeps its one-full-pass cap
// while each per-token attempt gets its own small, time-boxed retry budget.

/** Max retries AFTER the first attempt (so up to 4 total attempts per request). */
const MAX_TRANSIENT_RETRIES = 3;
/** Exponential backoff base: 400ms, 800ms, 1600ms for retries 0/1/2. */
const BASE_BACKOFF_MS = 400;
/** Hard cap on the TOTAL time this retry loop may sleep, so a wedged upstream
 *  (or a large `Retry-After`) can never hang the extension UI. If honoring the
 *  next wait would exceed this budget we stop and return the last failure. */
const MAX_TOTAL_RETRY_WAIT_MS = 9000;

/** Per-result decision handed back by a seam's classifier. `retry: false` (a
 *  success, an auth failure, a 404, any other 4xx) returns immediately;
 *  `retry: true` retries the SAME token after a wait. `retryAfterMs`, when set,
 *  is the server-directed wait parsed from a 429 `Retry-After`; when absent the
 *  loop falls back to exponential backoff for that attempt. */
export interface TransientDecision {
  retry: boolean;
  retryAfterMs?: number;
}

/** `setTimeout`-backed sleep. Isolated so the retry loop reads cleanly and a
 *  test can stub it if needed. */
function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse a `Retry-After` header value into whole seconds. Bitbucket sends the
 * delta-seconds form (e.g. `"30"`); the HTTP spec also allows an HTTP-date, so
 * we handle both: a bare integer is seconds; anything else is tried as a date
 * and converted to seconds-from-now (clamped at 0). Returns `undefined` when the
 * value is absent or unparseable, in which case the caller uses exponential
 * backoff. Never throws.
 */
export function parseRetryAfterSeconds(retryAfter: string | undefined): number | undefined {
  if (!retryAfter) return undefined;
  const trimmed = retryAfter.trim();
  if (/^\d+$/.test(trimmed)) {
    const secs = Number(trimmed);
    return Number.isFinite(secs) ? secs : undefined;
  }
  const when = Date.parse(trimmed);
  if (Number.isFinite(when)) {
    const deltaMs = when - Date.now();
    return deltaMs > 0 ? Math.ceil(deltaMs / 1000) : 0;
  }
  return undefined;
}

/**
 * Run a single logical request with bounded transient retry. `attempt` performs
 * ONE request (it must build its own timeout / abort controller each call, so
 * every retry gets a fresh deadline). `classify` inspects the returned result
 * and says whether it is a transient failure worth retrying on the SAME token,
 * plus any server-directed wait. Successes and non-transient failures return
 * unchanged on the first pass, so the shape and semantics the callers already
 * rely on are preserved exactly; only genuinely transient failures cost extra
 * attempts. The token is opaque to this loop (the seam captures it) — nothing
 * here logs or echoes it.
 */
export async function withTransientRetry<T>(
  attempt: () => Promise<T>,
  classify: (result: T) => TransientDecision,
): Promise<T> {
  let result = await attempt();
  let waitedMs = 0;
  for (let i = 0; i < MAX_TRANSIENT_RETRIES; i++) {
    const decision = classify(result);
    if (!decision.retry) return result;
    const backoff = BASE_BACKOFF_MS * 2 ** i; // 400, 800, 1600
    const delay = decision.retryAfterMs !== undefined ? decision.retryAfterMs : backoff;
    // A non-positive or budget-blowing wait ends the loop: returning the last
    // (still-failing) result keeps the honest failure and guarantees the total
    // added latency stays under MAX_TOTAL_RETRY_WAIT_MS so the UI cannot hang.
    if (delay <= 0 || waitedMs + delay > MAX_TOTAL_RETRY_WAIT_MS) return result;
    await delayMs(delay);
    waitedMs += delay;
    result = await attempt();
  }
  return result;
}
