#!/usr/bin/env node
//
// bb-bridge.mjs — CLI-agent -> host bridge client for Bitbucket (Project-Ghola).
//
// The extension host runs a loopback-only HTTP server (the "bridge") so a
// CLI agent can drive Bitbucket PR actions (find a PR, list/resolve/reply to
// comments, mark ready) without ever holding Bitbucket credentials itself.
// This script is that client: it resolves the bridge's address + bearer token,
// POSTs one JSON request, and prints the JSON result.
//
// CREDENTIAL RESOLUTION — precedence, and why it is in this order:
//   1. GHOLA_BRIDGE_FILE — path to a 0600 JSON file (`{ "url", "token" }`) the
//      extension REWRITES on every bridge start. Read fresh on EVERY invocation
//      and never cached. This is the durable channel: the extension host binds a
//      random port and mints a new token on each activation, but VS Code cannot
//      mutate a live terminal's environment, so before this file existed ANY
//      host restart (window reload, extension update, Remote-WSL reconnect,
//      host crash) permanently orphaned every already-running agent terminal —
//      its env still named a dead port. The FILE PATH is stable across
//      restarts; only the contents change. Re-reading per invocation is what
//      makes a long-lived session survive a reload.
//   2. GHOLA_BRIDGE_URL + GHOLA_BRIDGE_TOKEN — the legacy env pair, kept as a
//      backward-compatible fallback for terminals launched before the
//      coordinates file existed. Do not remove.
//   3. Neither available -> exit 2 ("is this a Ghola session?").
//
// SECURITY: the bearer token is read from process.env / the coordinates file
// ONLY. It is NEVER accepted as a CLI flag (flags land in shell history /
// process listings), NEVER printed (not in output, not in error messages, not
// in logs), and NEVER written anywhere by this script. The same applies to the
// bridge URL's role as a capability address — only the Authorization header
// carries the token, once, per request.
//
// Usage:
//   node scripts/bb-bridge.mjs find-pr       --repo <slug> --branch <name>
//   node scripts/bb-bridge.mjs list-comments --repo <slug> --pr <id>
//   node scripts/bb-bridge.mjs capture-comments --repo <slug> --pr <id>
//       (reads the same comments as list-comments and APPENDS one JSONL record
//        per comment to the host-resolved reviewer-dossier capture file; the
//        path is never a flag and never guessed CLI-side)
//   node scripts/bb-bridge.mjs resolve       --repo <slug> --pr <id> --comment <id>
//   node scripts/bb-bridge.mjs delete-comment --repo <slug> --pr <n> --comment <id>
//   node scripts/bb-bridge.mjs mark-ready    --repo <slug> --pr <id>
//   node scripts/bb-bridge.mjs to-draft      --repo <slug> --pr <id>
//   node scripts/bb-bridge.mjs create-comment --repo <slug> --pr <id> --body "<text>"
//   node scripts/bb-bridge.mjs create-pr     --repo <slug> --source <branch> --target <branch> \
//       --title <title> [--draft] [--reviewers '["id1","id2"]']
//       (description piped via stdin)
//   node scripts/bb-bridge.mjs update-pr     --repo <slug> --pr <id> \
//       [--reviewers '["id1","id2"]'] [--title "..."] [--description "..."]
//   node scripts/bb-bridge.mjs reply         --repo <slug> --pr <id> --parent <id> \
//       [--inline-path <p> --inline-to <n> [--inline-from <n>]]   (body piped via stdin)
//   node scripts/bb-bridge.mjs get-ticket    --key <KEY>
//   node scripts/bb-bridge.mjs get-comments  --key <ISSUE-KEY>
//   node scripts/bb-bridge.mjs post-comment  --key <ISSUE-KEY>
//       (comment body piped via stdin; requires the atlassian-suite
//        enableJiraCommentWrite gate, which the extension HOST enforces — with
//        it off the capability is withheld and this verb exits 1 with a
//        `capability-disabled` refusal, having sent nothing to Jira)
//   node scripts/bb-bridge.mjs get-transitions --key <ISSUE-KEY>
//       (READ-ONLY: the transitions Jira currently offers on the issue, each
//        with its id, its own name, and the status it moves to. Ungated —
//        it changes nothing. Read this to obtain a --transition-id; never
//        guess one)
//   node scripts/bb-bridge.mjs transition    --key <ISSUE-KEY> --transition-id <id>
//       (Jira WRITE: moves the issue along its workflow. Requires the
//        atlassian-suite enableJiraTransition gate, which the extension HOST
//        enforces — with it off the capability is withheld and this verb exits 1
//        with a `capability-disabled` refusal, having sent nothing to Jira and
//        leaving the issue's status untouched. The id must come from
//        get-transitions; this verb never matches on a status name)
//   node scripts/bb-bridge.mjs workspace-members [--workspace <slug>] [--query <search>] [--json]
//   node scripts/bb-bridge.mjs whoami
//       (READ-ONLY: the Bitbucket identity of the API TOKEN the extension host
//        calls with — accountId / nickname / displayName / uuid. Takes no flags.
//        Prints no credential: an account id is the same public identifier that
//        already appears on every comment list-comments returns)
//   node scripts/bb-bridge.mjs health
//       (liveness only — authenticated, but calls neither Jira nor Bitbucket)
//
// Exit codes:
//   0  bridge call succeeded (parsed result's status === 'ok'; for
//      get-ticket / get-comments, parsed result's exists === true — and for
//      get-comments an EMPTY `comments` array is still a success)
//   1  bridge call reached the server but failed (non-2xx HTTP, or a parsed
//      result whose status !== 'ok'; for get-ticket / get-comments,
//      exists !== true or an `error` was returned)
//   2  usage error: env not set, unknown subcommand, or a bad/missing
//      required argument — nothing was sent to the bridge
//
// Pure ESM, Node builtins + global fetch only (Node 20+) — no npm deps, so
// this ships as-is inside the VSIX with no install step.

import process from 'node:process';
import { readFileSync } from 'node:fs';

// ─────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────

// A usage problem (bad/missing arg, unknown subcommand) — always exit 2.
// Mirrors ghola.mjs's GholaError/fail() pattern: thrown, never
// process.exit()'d directly, so callers can't accidentally skip cleanup.
class UsageError extends Error {}

function usageFail(msg) {
  throw new UsageError(msg);
}

// ─────────────────────────────────────────────────────────────────────────
// Argument parsing (mirrors ghola.mjs's parseArgs/requireFlag)
// ─────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    }
  }
  return flags;
}

function requireFlag(flags, name, usage) {
  const v = flags[name];
  if (v === undefined || v === true) {
    usageFail(`--${name} is required. Usage: ${usage}`);
  }
  return v;
}

function requireNumberFlag(flags, name, usage) {
  const raw = requireFlag(flags, name, usage);
  const num = Number(raw);
  if (!Number.isFinite(num)) {
    usageFail(`--${name} must be a number (got '${raw}'). Usage: ${usage}`);
  }
  return num;
}

// Like requireNumberFlag but the flag itself is optional — absent returns
// undefined; present-but-unparseable is still a usage error.
function optionalNumberFlag(flags, name, usage) {
  const raw = flags[name];
  if (raw === undefined) return undefined;
  if (raw === true) {
    usageFail(`--${name} requires a value. Usage: ${usage}`);
  }
  const num = Number(raw);
  if (!Number.isFinite(num)) {
    usageFail(`--${name} must be a number (got '${raw}'). Usage: ${usage}`);
  }
  return num;
}

// Parse an optional --reviewers flag whose value is a JSON array of account ID
// strings, e.g. '["id1","id2"]'. Maps each string to `{ account_id: id }` for
// the Bitbucket API. Returns undefined when absent, empty, or the JSON is a
// zero-length array — never included in the payload in those cases so the call
// stays backwards compatible. A parse failure or a non-array JSON value is a
// usage error (exit 2) — it means the caller got the quoting wrong and should
// know immediately rather than silently dropping reviewers.
function parseReviewersFlag(flags, usage) {
  const raw = flags['reviewers'];
  if (raw === undefined) return undefined;
  if (raw === true) {
    usageFail(`--reviewers requires a JSON array value. Usage: ${usage}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    usageFail(`--reviewers must be valid JSON (got '${raw}'). Usage: ${usage}`);
  }
  if (!Array.isArray(parsed)) {
    usageFail(`--reviewers must be a JSON array (got ${typeof parsed}). Usage: ${usage}`);
  }
  const reviewers = [];
  for (const entry of parsed) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      usageFail(`--reviewers array entries must be non-empty strings (got ${JSON.stringify(entry)}). Usage: ${usage}`);
    }
    reviewers.push({ account_id: entry });
  }
  return reviewers.length > 0 ? reviewers : undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// stdin (reply's comment body — never a flag, to dodge shell-escaping pain
// on long/multi-line text; the agent pipes it via heredoc)
// ─────────────────────────────────────────────────────────────────────────

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => {
      // Heredocs conventionally add exactly one trailing newline; strip just
      // that one so a single-line body round-trips byte-for-byte while a
      // deliberately blank trailing line is still preserved.
      resolve(data.replace(/\n$/, ''));
    });
    process.stdin.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Bridge env + HTTP call
// ─────────────────────────────────────────────────────────────────────────

// ROUTES THAT MAY BE RETRIED. This set is the ONLY thing that makes a request
// retryable, and it is deliberately an explicit allowlist rather than a
// "mutations" denylist: a future route added to the bridge is NOT retryable
// until someone consciously adds it here, so forgetting to classify a new verb
// fails safe.
//
// DO NOT ADD A MUTATION TO THIS SET. /post-comment, /transition, /reply,
// /create-comment, /create-pr, /update-pr, /delete-comment, /resolve, /mark-ready
// and /to-draft all WRITE to
// the operator's live Jira / Bitbucket. A transport timeout on a write is
// AMBIGUOUS — the server may have applied it before the connection dropped — so
// retrying one risks a duplicate comment or a duplicate PR on a ticket other
// people are reading. Every route below is a pure read whose worst case on
// replay is a wasted API call.
//
// /transition IS THE NEWEST ONE AND THE EASIEST TO MISCLASSIFY, because its
// sibling /get-transitions IS in this set and the two read as a pair. They are
// not a pair: listing the transitions changes nothing, and EXECUTING one changes
// the issue's workflow status — which notifies watchers, trips automation rules,
// and can move the issue somewhere a second POST cannot undo. A replayed
// transition is not a harmless duplicate; it can move the ticket AGAIN.
//
// /capture-comments IS ABSENT ON PURPOSE and is the one route where that needs
// saying out loud, because it LOOKS like a read: it calls the same Bitbucket
// comments walk /list-comments does and changes nothing in Bitbucket. It is a
// mutation anyway — it APPENDS records to the reviewer-dossier capture file on
// disk — and a blind replay of an append is exactly the duplicate-record problem
// this allowlist exists to prevent. (The host-side append de-duplicates on
// project+PR+comment+updatedAt, so a DELIBERATE operator re-run is safe; that is
// a deliberate act with a human looking at the result, not an automatic replay,
// and it is not a reason to move this route into the allowlist.)
const RETRYABLE_ROUTES = new Set([
  '/health',
  '/get-ticket',
  '/get-comments',
  '/get-transitions',
  '/find-pr',
  '/list-comments',
  '/terminal/list',
  '/workspace-members',
  // /whoami is a single Bitbucket GET (/2.0/user) that changes nothing. A
  // replay costs one wasted API call and cannot duplicate anything, which is
  // the bar this allowlist sets. The host caches a SUCCESSFUL answer for its
  // process lifetime, so in practice a replay usually never reaches Bitbucket
  // at all — but that caching is a host-side optimization and is emphatically
  // NOT the reason this route is here: it is here because it is a pure read.
  '/whoami',
]);

// Per-attempt request timeouts, in THREE READ TIERS plus the mutation bound.
// The tier is chosen by ROUTE, and the only thing that makes a tier correct is
// that it sits ABOVE THE HOST'S WORST CASE for that route: a client bound set
// below the host's own ceiling loses a race it can never win, and then reports
// the loss as a dead bridge. Writes get a looser, non-overridable bound because
// aborting a write in flight makes its outcome ambiguous, which is exactly what
// we are trying to avoid. Before any of this existed there was NO timeout on
// this hop at all — a wedged bridge hung the caller forever.
//
// TIER 1 — FAST READS: routes the host answers WITHOUT any upstream call. Today
// that is `/health` alone. 3s is generous for a loopback hop with no Atlassian
// request behind it: a bridge that has not answered in 3s is wedged, not slow.
// Kept deliberately tight because the worst case is
// 2 * READ_TIMEOUT_MS + RETRY_DELAY_MS (~6.25s) and scripts/ghola-boot-probe.sh
// runs reads on the session's critical boot path.
//
// DO NOT ADD A ROUTE HERE THAT MAKES AN UPSTREAM CALL. That was the original
// defect and it is easy to re-introduce, because "it is only one call" sounds
// like it belongs in the fast tier. One CALL is not one ATTEMPT — see
// RETRY_BUDGET_READ_TIMEOUT_MS.
const READ_TIMEOUT_MS = 3000;
const MUTATION_TIMEOUT_MS = 30000;

// /terminal/exec can block for up to humanInterventionTimeoutMs (default 300s,
// max 900s) when --wait-for-human is set. The connection stays open the entire
// time, so the client timeout must be at least as generous. 960s covers the
// manifest's maximum humanInterventionTimeoutMs (900s) plus transport slack.
const TERMINAL_EXEC_TIMEOUT_MS = 960000;

// ─── Host-side worst case, mirrored ─────────────────────────────────────
//
// These MIRROR constants in src/ (this is a standalone script and deliberately
// imports nothing from there). They exist so the tiers below are DERIVED
// arithmetic instead of round numbers someone guessed at. If a src/ value
// changes, change its mirror here and the tiers recompute:
//
//   HOST_REQUEST_TIMEOUT_MS   = REQUEST_TIMEOUT_MS        (atlassian-client.ts,
//                                                          bitbucket-pr-client.ts)
//   HOST_MAX_REQUEST_ATTEMPTS = 1 + MAX_TRANSIENT_RETRIES (bitbucket-failover.ts)
//   HOST_MAX_RETRY_WAIT_MS    = MAX_TOTAL_RETRY_WAIT_MS   (bitbucket-failover.ts)
const HOST_REQUEST_TIMEOUT_MS = 8000;
const HOST_MAX_REQUEST_ATTEMPTS = 4;
const HOST_MAX_RETRY_WAIT_MS = 9000;

// Ceiling for ONE logical host-side upstream request. Every attempt may burn its
// full 8s deadline, and `withTransientRetry` may sleep its ENTIRE 9s budget
// between them — a 429's `Retry-After` is honored verbatim and can be far larger
// than the 400/800/1600ms exponential fallback, so the 9s budget, not the
// backoff series, is what caps the sleeping. 4 * 8000 + 9000 = 41000 ms.
const HOST_REQUEST_CEILING_MS = HOST_MAX_REQUEST_ATTEMPTS * HOST_REQUEST_TIMEOUT_MS
  + HOST_MAX_RETRY_WAIT_MS;

// Loopback + JSON + event-loop slack. NOT "headroom" in the pick-a-margin sense:
// HOST_REQUEST_CEILING_MS is an exact arithmetic bound on the upstream work, so
// the only thing left to cover is this process talking to 127.0.0.1 and the host
// scheduling the work. 5s is lavish for that.
const TRANSPORT_SLACK_MS = 5000;

// TIER 2 — SLOW READS: routes whose host-side work is a PAGINATED WALK, not a
// single upstream call, and which therefore must NOT be judged by
// READ_TIMEOUT_MS.
//
// This existed as a latent defect for as long as list-comments has: every read
// shared the 3s bound, even though only /health answers without touching
// Atlassian at all, while /list-comments walks up to 20 pages of the Bitbucket
// comments API back to back — each page with its own 8s host-side timeout and its
// own transient-retry budget. On a small PR the walk is one page and finishes
// inside 3s, so the bug stayed invisible; on a large PR (hundreds of CodeRabbit
// comments, 4+ pages) the walk legitimately needs 10s+ and the CLIENT gave up at
// 3s while the host was still working correctly. The host then finished into a
// closed socket and the operator was told the bridge was "unreachable" — see
// describeTransport.
//
// CORRECTION — an earlier version of this comment asserted that "/find-pr,
// /get-ticket and /get-comments are ONE upstream request each (~300ms)" and used
// that to justify leaving them in the fast tier. The nominal latency was right
// and the CONCLUSION was wrong, which is worse than being simply wrong: it read
// as a considered decision and so nobody re-derived it. ~300ms is the SUCCESS
// case. The bound has to cover the FAILURE case, and every one of those routes
// wraps its upstream call in the host's transient-retry loop, whose ceiling is
// 41s per request — see RETRY_BUDGET_READ_TIMEOUT_MS below, which is the tier
// that assertion should have produced.
//
// SIZING — the value must stay comfortably ABOVE the host's WORST CASE, not
// above its nominal budget, or the client still loses the race it was widened to
// win. Both paginated walks bound themselves with a 45s wall clock
// (COMMENT_WALK_BUDGET_MS, defined identically in bitbucket-pr-client.ts and
// atlassian-client.ts), but that deadline is checked BEFORE each page, so the
// true ceiling is 45s plus one final page running its full retry budget
// (4 attempts x 8s + 9s of backoff = 41s) — about 86s.
//
// 120s leaves ~34s of genuine headroom over that 86s. The earlier 90s cleared it
// by only 4s, which is not a margin, it is a coincidence. This costs nothing in
// the normal case: it is a CEILING, not a wait, and a healthy walk returns in
// about a second. If either COMMENT_WALK_BUDGET_MS or the per-request retry
// budget grows, redo this arithmetic.
const SLOW_READ_TIMEOUT_MS = 120000;

// Routes whose host-side work is a PAGINATED WALK. Both comment reads paginate
// and both were previously judged at READ_TIMEOUT_MS: `/list-comments` is the
// one that visibly broke, and `/get-comments` carries the identical defect over
// Jira's startAt/total pagination (up to 20 pages) — it simply had not met a
// long enough Jira thread yet. They are listed together deliberately: these two
// fail the same way at the same scale and should be reasoned about as one class.
const SLOW_READ_ROUTES = new Set(['/list-comments', '/get-comments']);

// THE MUTATION THAT PAGINATES. /capture-comments is not in RETRYABLE_ROUTES (it
// writes the dossier capture file), so without a case of its own it would be
// judged at MUTATION_TIMEOUT_MS — 30s — while its host-side work is the ENTIRE
// /list-comments walk that needed 120s, plus one `pullrequests/{id}` GET for the
// PR author, plus the local append. That is the same "a bound below the host's
// worst case aborts work the host is doing correctly" defect the three read tiers
// above were built to end, and it would arrive pre-broken on a brand-new route.
//
// Derived, not guessed: the walk's own bound (SLOW_READ_TIMEOUT_MS) plus one
// further full-retry-budget request for the author GET. 120000 + 41000 = 161s.
//
// NOT overridable from GHOLA_BRIDGE_TIMEOUT_MS — it is a write, and the env knob
// is reads-only for the reasons documented at TIMEOUT_ENV_VAR.
const CAPTURE_TIMEOUT_MS = SLOW_READ_TIMEOUT_MS + HOST_REQUEST_CEILING_MS;

// TIER 3 — RETRY-BUDGET READS: ONE logical host-side call, with NO pagination,
// but a call that carries the FULL transient-retry budget — so its ceiling is
// tens of seconds, not the ~300ms a nominal round trip costs.
//
// This is the tier whose ABSENCE made a healthy, deliberately-backing-off host
// get reported as a wedged one. `/find-pr` and `/get-ticket` were both judged at
// READ_TIMEOUT_MS on the grounds that each is "one upstream call", which
// conflated ONE CALL with ONE ATTEMPT. The arithmetic, at ONE Bitbucket token:
//
//   one upstream request   4 attempts * 8s + 9s of backoff        =  41s
//                          (HOST_REQUEST_CEILING_MS; withTransientRetry
//                           in bitbucket-failover.ts)
//   /get-ticket            1 request, single Jira token, no
//                          rotation (Jira never rotates)          =  41s
//   one Bitbucket query    41s * N configured tokens
//                          (withBitbucketFailover makes ONE FULL
//                           PASS: up to N attempts, each a whole
//                           request with its own retry budget)     =  41s * N
//   /find-pr               up to TWO queries — the `state=OPEN`
//                          match, then the MERGED/DECLINED/
//                          SUPERSEDED fallback that fires when
//                          OPEN is genuinely empty
//                          (findOpenPrForBranch, atlassian-client.ts) = 82s * N
//
// 82s at N=1 — more than 27x the 3s bound these routes used to be judged
// against. The observed failure was exactly that ratio: a rate-limited /find-pr
// was aborted at 3s, replayed once, and abandoned at ~6.25s while the host was
// still correctly honoring Bitbucket's Retry-After, and the operator was told the
// bridge was unreachable and to relaunch the session.
//
// WHY THIS DOES NOT SCALE WITH THE TOKEN COUNT: it cannot, and should not. The
// Bitbucket token COUNT lives in the host's secret storage and is never sent over
// this bridge (`/health` returns `{ status: 'ok' }` and nothing more), so this
// client has no way to learn N — and adding a field for it would publish a shape
// of the operator's credential configuration to the CLI side to compute a timeout
// constant, which is a bad trade. The tier therefore covers the SINGLE-TOKEN
// worst case exactly, which is the overwhelmingly common configuration, and a
// multi-token operator whose lookup genuinely exhausts every token widens it with
// GHOLA_BRIDGE_TIMEOUT_MS. The timeout message names both the knob and the
// multi-token multiplier so that case is self-diagnosing rather than mysterious.
const RETRY_BUDGET_READ_TIMEOUT_MS = 2 * HOST_REQUEST_CEILING_MS + TRANSPORT_SLACK_MS;

// Routes that are ONE logical host-side call carrying a FULL retry budget.
// `/find-pr` is the worst case (two queries x N tokens); `/get-ticket` shares the
// identical per-request arithmetic against Jira's single token. They are listed
// together for the same reason the two paginated reads are: they fail the same
// way for the same reason and should be reasoned about as one class.
//
// CLASSIFYING A NEW ROUTE: if the host wraps its work in `withTransientRetry`
// and/or `withBitbucketFailover` but does NOT paginate, it belongs here. If it
// ALSO paginates it belongs in SLOW_READ_ROUTES instead, whose bound already
// includes one final page running its full retry budget. Only a route that
// touches neither Atlassian product belongs in the fast tier.
//
// `/get-transitions` is classified by that rule, not by how it looks: it is one
// Jira GET, wrapped in `withTransientRetry` (the host calls it through
// `request`, exactly as `/get-ticket` does) and it does NOT paginate — Jira
// returns every available transition in one response. Same arithmetic as
// `/get-ticket`, single Jira token, no rotation. It is emphatically NOT a fast-
// tier route: "it's just a list of buttons, it'll be instant" is the same
// reasoning that put `/find-pr` and `/get-ticket` on the 3s bound and got a
// healthy, deliberately-backing-off host reported as a dead bridge.
//
// `/whoami` is classified by that same rule and it is worth spelling out,
// because it is the route most likely to look like a fast-tier one: it is a
// single `GET /2.0/user`, it returns four short strings, and the host caches the
// answer — so the overwhelmingly common case is microseconds. None of that is
// the question. The FIRST call of a session is a real Bitbucket request wrapped
// in `withTransientRetry` and `withBitbucketFailover`, with no pagination, which
// is exactly the definition of this tier: 41s per request, times the configured
// token count. Judging it at 3s would abort a host that is correctly honoring a
// 429 — the same mistake, on a brand-new route, that this tier was created to
// end. The cache makes the SECOND call fast; a timeout tier has to survive the
// first.
const RETRY_BUDGET_READ_ROUTES = new Set([
  '/find-pr',
  '/get-ticket',
  '/get-transitions',
  '/workspace-members',
  '/whoami',
]);

// Escape hatch for a pathologically large PR or a slow link. Clamped to a sane
// range so a typo like `5` (ms) cannot make every call fail instantly. Not a
// flag: this is an operator knob, and the flag surface here is reserved for
// request arguments.
//
// READS ONLY — this is a safety boundary, not a convenience. The override is
// meant to be exported into a shell for the duration of some work on a big PR,
// and an env var that lives in a shell profile applies to every later command in
// that session. Letting it widen MUTATION_TIMEOUT_MS would mean an operator who
// set it once to get `list-comments` to finish had silently also given every
// subsequent comment POST a five-minute deadline — stretching the exact window
// in which a write's outcome is unknowable, on the exact routes where that
// ambiguity is most expensive. Writes therefore stay pinned at
// MUTATION_TIMEOUT_MS and cannot be widened from the environment at all.
const TIMEOUT_ENV_VAR = 'GHOLA_BRIDGE_TIMEOUT_MS';
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 600000;

// Resolves the per-attempt timeout for a route: the route's own default,
// overridable from the environment for READ routes only. An unusable override
// warns (so a typo is not silently ignored) and falls back rather than failing
// the call.
function timeoutForRoute(routePath) {
  // /terminal/exec is a special case: it can block for the duration of
  // human-intervention (up to 900s), far exceeding the standard mutation
  // deadline. Handle it before the retryable check.
  if (routePath === '/terminal/exec') return TERMINAL_EXEC_TIMEOUT_MS;

  // /capture-comments is likewise handled before the retryable check: it is a
  // write, so the check below would pin it at MUTATION_TIMEOUT_MS, which is far
  // under the paginated walk it performs. See CAPTURE_TIMEOUT_MS.
  if (routePath === '/capture-comments') return CAPTURE_TIMEOUT_MS;

  const isRead = RETRYABLE_ROUTES.has(routePath);
  if (!isRead) {
    // Mutation: fixed, non-overridable. Deliberately returns BEFORE consulting
    // the env var, so setting it cannot affect a write even by accident.
    return MUTATION_TIMEOUT_MS;
  }

  // Tier selection. SLOW_READ_ROUTES is tested FIRST and the sets are kept
  // disjoint: `/get-comments` paginates AND carries a per-page retry budget, and
  // its 120s bound already accounts for both, so it must never be demoted to the
  // 87s retry-budget tier by a future edit that adds it to the second set.
  let base = READ_TIMEOUT_MS;
  if (SLOW_READ_ROUTES.has(routePath)) {
    base = SLOW_READ_TIMEOUT_MS;
  } else if (RETRY_BUDGET_READ_ROUTES.has(routePath)) {
    base = RETRY_BUDGET_READ_TIMEOUT_MS;
  }
  const raw = process.env[TIMEOUT_ENV_VAR];
  if (raw === undefined || raw === '') return base;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < MIN_TIMEOUT_MS || parsed > MAX_TIMEOUT_MS) {
    console.error(
      `bb-bridge: ignoring ${TIMEOUT_ENV_VAR}='${raw}' — must be a number between `
      + `${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} (ms); using the ${base}ms default for ${routePath}.`,
    );
    return base;
  }
  return parsed;
}

// Pause between the first attempt and the single retry, for retryable routes.
const RETRY_DELAY_MS = 250;

// Stable, greppable markers embedded in every transport-level failure message.
// scripts/ghola-boot-probe.sh matches on these to tell "the bridge is down"
// apart from "there is no ticket in this branch" / "this is not a Bitbucket
// repo", which used to be indistinguishable because the probe discarded stderr.
// Changing these strings requires updating that probe's grep.
const MARKER_UNREACHABLE = 'bridge-unreachable';
const MARKER_UNAVAILABLE = 'bridge-unavailable';

// A FOURTH, deliberately DISTINCT classification: the bridge was alive, accepted
// the connection, and is (as far as we know) still working — we simply stopped
// waiting. This is NOT a bridge-unreachable condition and must never carry that
// marker, because "unreachable" tells the operator to relaunch the session,
// which is useless advice when the bridge is healthy and the real answer is
// "the PR is big, allow more time".
//
// Emitting `bridge-unreachable` here is precisely what made this class of
// failure recur: `list-comments` on a large PR reported the bridge as dead while
// `health` and `find-pr` answered instantly on the same bridge and the same
// token, an obvious contradiction that sent debugging in the wrong direction
// more than once.
//
// Carried by BOTH non-fast read tiers: the paginated walks (SLOW_READ_ROUTES) and
// the retry-budget reads (RETRY_BUDGET_READ_ROUTES). Do NOT use it for a fast
// route — on `/health` a deadline really does mean a wedged host, and that is the
// one place `bridge-unreachable` is the honest answer.
//
// BOOT-PROBE CONTRACT — READ THIS BEFORE CHANGING EITHER SET. An earlier version
// of this comment recorded that the marker "cannot appear on the boot path"
// because the probe only calls `get-ticket` and `find-pr` and neither was a slow
// route. Adding RETRY_BUDGET_READ_ROUTES made that FALSE: both boot-path routes
// now emit this marker on a deadline. scripts/ghola-boot-probe.sh has since
// learned this third marker, so the current two-file contract is:
//   `bridge-unreachable` / `bridge-unavailable` -> `bridge_down_last()` latches
//     `bridge_state="down"` and the boot path reports `ticket_state="bridge-down"`
//     / `pr_state="bridge-down"` (ghola-boot-probe.sh:65-68, 410, 473).
//   `bridge-timeout` -> `bridge_slow_last()` greps for it and latches
//     `bridge_state="upstream-slow"` (unless a prior call already set `down`,
//     which outranks it), and the boot path reports `ticket_state="bridge-slow"`
//     / `pr_state="bridge-slow"` (ghola-boot-probe.sh:90-95, 416, 478).
// A throttled boot lookup no longer degrades to `pr_state=na` / `ticket_state=
// unavailable`; that was the risk this contract exists to prevent. It still
// matters that these are three DISTINCT verdicts with opposite remedies:
// `bridge-down` means the transport is dead and relaunching the session is real,
// actionable advice; `bridge-slow` means the bridge is healthy and the only
// honest answer is "wait" — a relaunch is useless there. Neither may ever be
// read as an absence: a `bridge-down` or `bridge-slow` ticket/PR lookup was
// never answered, so "no ticket" / "no PR" was never established. Keep both
// marker sets and both files in sync when either changes.
const MARKER_TIMEOUT = 'bridge-timeout';

// Resolves the bridge address + bearer token per the precedence documented at
// the top of this file. Fails loud + fast (exit 2) if the bridge isn't wired up
// at all — the common case being "this isn't running inside a Ghola session".
// Never logs either value, only whether they're present.
function resolveBridge() {
  // 1. Coordinates file — read FRESH every invocation, never cached, so a
  //    restarted extension host (new port, new token) is picked up immediately.
  const file = process.env.GHOLA_BRIDGE_FILE;
  if (file) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed && typeof parsed.url === 'string' && parsed.url
        && typeof parsed.token === 'string' && parsed.token) {
        return { url: parsed.url, token: parsed.token };
      }
      // Present but unusable (truncated write, older/newer schema) — fall
      // through to the env pair rather than dying, and say so WITHOUT echoing
      // any of the file's contents.
      console.error(`bb-bridge: ${file} did not contain a usable url+token; falling back to GHOLA_BRIDGE_URL/GHOLA_BRIDGE_TOKEN`);
    } catch {
      // Missing / unreadable / not JSON. Same fall-through. The error object is
      // deliberately not printed: it can carry file contents on some paths.
      console.error(`bb-bridge: could not read bridge coordinates from ${file}; falling back to GHOLA_BRIDGE_URL/GHOLA_BRIDGE_TOKEN`);
    }
  }

  // 2. Legacy env pair.
  const url = process.env.GHOLA_BRIDGE_URL;
  const token = process.env.GHOLA_BRIDGE_TOKEN;
  if (url && token) {
    return { url, token };
  }

  // 3. Nothing at all.
  console.error(`bb-bridge: ${MARKER_UNAVAILABLE} — no bridge coordinates (GHOLA_BRIDGE_FILE unset/unreadable and GHOLA_BRIDGE_URL/GHOLA_BRIDGE_TOKEN not set) — is this a Ghola session?`);
  process.exit(2);
}

// Extracts the OS-level error code from a fetch rejection. undici wraps the
// socket error, so the useful code lives on `err.cause.code`, not `err.code`
// and never in `err.message` (which is the famously opaque bare 'fetch
// failed'). Checks both, plus undici's own UND_ERR_* codes.
function transportCode(err) {
  if (!err) return '';
  const cause = err.cause;
  if (cause && typeof cause.code === 'string') return cause.code;
  // Dual-stack ("happy eyeballs") connect failures arrive as an AggregateError
  // whose SUB-errors carry the codes; the AggregateError itself has none. A
  // 127.0.0.1 literal normally dodges this, but a future coordinates file
  // naming `localhost` would hit it, and losing the code there would put us
  // right back at a bare 'fetch failed'. Prefer a definitive ECONNREFUSED over
  // whatever the other family reported.
  if (cause && Array.isArray(cause.errors)) {
    const codes = cause.errors.map((e) => (e && typeof e.code === 'string' ? e.code : '')).filter(Boolean);
    if (codes.includes('ECONNREFUSED')) return 'ECONNREFUSED';
    if (codes.length > 0) return codes[0];
  }
  if (typeof err.code === 'string') return err.code;
  // AbortSignal.timeout() rejects with a DOMException named 'TimeoutError'
  // which carries no `code` at all.
  if (err.name === 'TimeoutError') return 'ETIMEDOUT';
  return '';
}

// Best available human detail when no code could be extracted. Deliberately
// prefers `err.cause.message` over `err.message`: on a fetch rejection the OUTER
// message is the useless literal 'fetch failed' (the exact string Defect 2 was
// filed about) while the cause carries the real text, e.g. 'bad port'. Neither
// ever contains request headers, so no token can leak through here.
function transportDetail(err) {
  if (!err) return 'unknown error';
  if (err.cause && err.cause.message) return err.cause.message;
  if (err.message) return err.message;
  return String(err);
}

// True only for codes where a replay could plausibly succeed. ECONNREFUSED is
// deliberately EXCLUDED: nothing is listening on that port, and a retry a
// quarter-second later will be refused identically — retrying it would only add
// latency to the boot probe's fast-fail path.
// True for the codes that mean "we hit our own deadline", as distinct from "the
// connection broke". Kept separate from isRetryableTransport because the two
// answer different questions: this one asks whether WE gave up, not whether a
// replay could help.
function isTimeoutTransport(err) {
  switch (transportCode(err)) {
    case 'ETIMEDOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT':
      return true;
    default:
      return false;
  }
}

function isRetryableTransport(err) {
  switch (transportCode(err)) {
    case 'ECONNRESET':
    case 'ETIMEDOUT':
    case 'EPIPE':
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT':
    case 'UND_ERR_SOCKET':
      return true;
    default:
      return false;
  }
}

// Turns an opaque transport failure into a specific, ACTIONABLE line. Every
// branch names the concrete remedy, because the failure this replaces printed
// only undici's 'fetch failed' and sent three separate debugging sessions
// chasing three different wrong theories.
//
// `url` is a loopback address (http://127.0.0.1:PORT) and is safe to print. The
// bearer token is NEVER interpolated here, on any branch.
function describeTransport(url, routePath, err, timeoutMs) {
  const code = transportCode(err);

  // Handled BEFORE the switch so a slow route can never fall into the
  // ETIMEDOUT branch below, which speaks in "the host may be wedged" terms that
  // are simply wrong here: we know this route paginates, and we know the bridge
  // was answering when we opened the connection.
  // A MUTATION that exceeded the client deadline is the most dangerous message
  // in this file to get wrong. The request reached a live bridge and was
  // forwarded upstream; we stopped listening, but the write may well have
  // landed. The generic ETIMEDOUT branch below would call this
  // `bridge-unreachable` and advise relaunching the session — advice that is
  // both wrong (the bridge is fine) and unsafe, because the natural next step
  // after "relaunch and retry" is to re-run the write and duplicate it.
  //
  // This is the client-side mirror of the host-side `'indeterminate'` status,
  // and it exists because the client can give up BEFORE the host ever produces
  // that status. Both must say the same thing: check first, then decide.
  // /capture-comments is a write, so it must NOT get the generic
  // `bridge-unreachable` treatment — but it must not get the generic MUTATION
  // message either, and this is the one place that distinction is worth its own
  // branch. That message says the write "was forwarded to Atlassian" and tells
  // the reader to go look at the pull request. Both halves are false here:
  // nothing was written to Bitbucket, the write is a local append to the capture
  // file, and the PR will look identical either way. Worse, its central advice —
  // "DO NOT re-run this command" — is wrong for this one route, because the
  // host-side append de-duplicates. Handled before the generic mutation branch
  // below so it cannot fall through into that advice.
  if (routePath === '/capture-comments' && isTimeoutTransport(err)) {
    const secs = Math.round(timeoutMs / 1000);
    return `${MARKER_TIMEOUT}: ${routePath} did not finish within ${secs}s (${code}).\n`
      + 'This is NOT a dead bridge, and NOTHING was written to Bitbucket — this verb only READS\n'
      + 'the PR comments (walking the Bitbucket comments API page by page, exactly as\n'
      + 'list-comments does) and appends them to a LOCAL capture file. A PR with a large number\n'
      + 'of comments can legitimately outrun the deadline, and the host very likely finished the\n'
      + 'capture after this client stopped waiting.\n'
      + 'Fix: RE-RUNNING THIS COMMAND IS SAFE. The append de-duplicates on\n'
      + 'project + PR + comment + updatedAt, so a comment already captured is skipped rather\n'
      + 'than written twice. (This is the one write verb that says so — every other one is\n'
      + 'ambiguous on a timeout and must not be replayed.)\n'
      + 'Confirm the bridge is healthy first with `bb-bridge health`; if that succeeds, the\n'
      + 'bridge is fine and relaunching the session will NOT help.';
  }

  if (!RETRYABLE_ROUTES.has(routePath) && isTimeoutTransport(err)) {
    const secs = Math.round(timeoutMs / 1000);
    return `${MARKER_TIMEOUT}: ${routePath} did not answer within ${secs}s (${code}).\n`
      + 'This is a WRITE and its outcome is UNKNOWN — the bridge is alive and the request was\n'
      + 'forwarded to Atlassian, so it may or may not have been applied.\n'
      + 'DO NOT simply re-run this command: if the write did land, a retry duplicates it.\n'
      + 'Fix: check the pull request (or issue) in Atlassian first. Act only on what you see there.';
  }

  if (SLOW_READ_ROUTES.has(routePath) && isTimeoutTransport(err)) {
    const secs = Math.round(timeoutMs / 1000);
    // Name the RIGHT product. `/get-comments` reads Jira and `/list-comments`
    // reads Bitbucket; a message that confidently names the wrong system sends
    // the reader to check the wrong place, which is the same misattribution
    // failure as calling a healthy bridge unreachable, just quieter.
    const src = routePath === '/get-comments'
      ? { api: 'Jira comments API', scale: 'an issue with a long comment thread' }
      : { api: 'Bitbucket comments API', scale: 'a PR with a large number of comments (CodeRabbit-heavy reviews especially)' };
    return `${MARKER_TIMEOUT}: ${routePath} did not finish within ${secs}s (${code}).\n`
      + `This is NOT a dead bridge — the connection was accepted, and this route walks the\n`
      + `${src.api} page by page, so ${src.scale}\n`
      + 'can legitimately outrun the deadline. The host very likely completed the work after\n'
      + 'this client stopped waiting.\n'
      + 'Fix: re-run with a longer deadline by prefixing it to THIS ONE command:\n'
      + `  ${TIMEOUT_ENV_VAR}=300000 node scripts/bb-bridge.mjs ${routePath.slice(1)} ...\n`
      + 'Prefer the prefix over `export`. The override affects read routes only — writes are\n'
      + 'pinned to their own fixed deadline and cannot be widened this way — but an exported\n'
      + 'value silently outlives the command you set it for.\n'
      + 'Confirm the bridge is healthy first with `bb-bridge health` — if that succeeds, the\n'
      + 'bridge is fine and relaunching the session will NOT help.';
  }

  // Same reasoning as the slow-read branch, different cause: here the host is not
  // walking pages, it is WAITING — honoring an upstream Retry-After or backing off
  // a 5xx, on purpose, exactly as designed. The generic ETIMEDOUT branch below
  // would call that a possibly-wedged extension host and tell the operator to
  // relaunch the session, which is wrong twice over: it is false (the host is
  // healthy and mid-backoff) and it is expensive (a relaunch discards session
  // context and does not clear a rate limit).
  //
  // The last two lines matter as much as the classification. This route's silence
  // is NOT evidence of absence: a `/find-pr` that never answered has NOT told us
  // there is no PR, and reading it that way is how a genuinely open PR got
  // reported as "No open PR for branch" and cost a team real debugging time.
  if (RETRY_BUDGET_READ_ROUTES.has(routePath) && isTimeoutTransport(err)) {
    const secs = Math.round(timeoutMs / 1000);
    // Name the right product and the right shape of work, for the same reason the
    // slow-read branch does: a message that confidently describes the wrong
    // upstream sends the reader to check the wrong place.
    //
    // `/get-transitions` is grouped with `/get-ticket` and NOT allowed to fall
    // into the Bitbucket branch by default: it is a Jira read, and the default
    // branch would confidently tell the reader to go and check Bitbucket's rate
    // limiting for a call that never touched Bitbucket. Its `absence` line is the
    // one that matters most here — a silent `/get-transitions` has NOT
    // established that the issue offers no transitions, and reading it that way
    // would let a caller conclude a move is impossible when it simply was never
    // answered.
    const src = (routePath === '/get-ticket' || routePath === '/get-transitions')
      ? {
        api: 'Jira',
        work: routePath === '/get-transitions'
          ? 'a single available-transitions read'
          : 'a single issue read',
        // Jira authenticates with ONE token and never rotates, so the ceiling
        // here is exactly one request's retry budget — no token multiplier.
        scale: 'Jira uses a single token and never rotates, so one request\'s retry\nbudget is the whole ceiling',
        absence: routePath === '/get-transitions'
          ? 'that the issue has no available transitions'
          : 'that the ticket does not exist',
      }
      // `/whoami` needs its own entry for the reason the Jira routes do, in the
      // opposite direction: it IS a Bitbucket route, so the product name below
      // is already right, but the default branch's `work` and `absence` text is
      // written for `/find-pr` and would describe this call as "up to two
      // pull-request queries" and then warn the reader not to conclude "there is
      // no PR for this branch" — for a call that never mentioned a PR. Naming
      // the right product is only half of not misleading someone.
      : routePath === '/whoami'
        ? {
          api: 'Bitbucket',
          work: 'a single current-user read',
          scale: 'a multi-token Bitbucket setup multiplies the worst case by the\nnumber of configured tokens, so it can legitimately need considerably more',
          // The absence to refuse is an IDENTITY one. A silent /whoami has not
          // established that the token is anonymous or that ownership cannot be
          // determined — and a caller that read it that way would conclude no
          // comment is ours, which is the safe direction here but is still a
          // conclusion drawn from nothing.
          absence: 'that the token has no Bitbucket identity',
        }
        : {
          api: 'Bitbucket',
          work: 'up to two pull-request queries',
          scale: 'a multi-token Bitbucket setup multiplies the worst case by the\nnumber of configured tokens, so it can legitimately need considerably more',
          absence: 'that there is no PR for this branch',
        };
    return `${MARKER_TIMEOUT}: ${routePath} did not answer within ${secs}s (${code}).\n`
      + 'This is NOT a dead or wedged bridge and NOT a reason to relaunch the session — the\n'
      + `connection was accepted. ${routePath} is ${src.work} against ${src.api}, and the host\n`
      + `retries a rate-limited (HTTP 429) or 5xx response up to 4 times while honoring\n`
      + `${src.api}'s Retry-After, so a deadline here almost always means THE UPSTREAM IS\n`
      + 'THROTTLING US and the host is deliberately backing off. It is healthy, and it very\n'
      + 'likely completed the lookup after this client stopped waiting.\n'
      + 'Fix: wait for the throttling to clear and re-run. If you need an answer now, give THIS\n'
      + `ONE command a longer deadline (${src.scale}):\n`
      + `  ${TIMEOUT_ENV_VAR}=300000 node scripts/bb-bridge.mjs ${routePath.slice(1)} ...\n`
      + 'Prefer the prefix over `export` — an exported value silently outlives the command you\n'
      + 'set it for. Confirm with `bb-bridge health` (it answers without calling Atlassian): if\n'
      + 'that succeeds, the bridge is fine.\n'
      + `DO NOT CONCLUDE ${src.absence}. Nothing was answered, so nothing was\n`
      + 'ruled out — this result is "unknown", never an absence.';
  }

  switch (code) {
    case 'ECONNREFUSED':
      return `${MARKER_UNREACHABLE}: nothing is listening at ${url} (ECONNREFUSED).\n`
        + 'The extension host has probably restarted (window reload, extension update, '
        + 'Remote-WSL reconnect, or a host crash), which moves the bridge to a new port '
        + 'and mints a new token.\n'
        + 'Fix: relaunch the Ghola session from Ghola\'s settings panel. If this terminal '
        + 'predates GHOLA_BRIDGE_FILE it cannot self-heal and MUST be relaunched.';
    case 'ECONNRESET':
    case 'EPIPE':
    // undici reports a socket torn down mid-request as its own UND_ERR_SOCKET
    // rather than the raw ECONNRESET, so it belongs in this same branch — it is
    // the identical situation from the operator's point of view.
    case 'UND_ERR_SOCKET':
      return `${MARKER_UNREACHABLE}: the bridge at ${url} closed the connection mid-request (${code}).\n`
        + 'The extension host most likely shut down or reloaded while this call was in flight.\n'
        + 'Fix: run `bb-bridge health` to confirm, and relaunch the Ghola session if it also fails.';
    case 'ETIMEDOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT':
      return `${MARKER_UNREACHABLE}: no response from the bridge at ${url} within the timeout (${code}).\n`
        + 'The bridge accepted the connection but did not answer — the extension host may be '
        + 'wedged, or an upstream Atlassian call is hanging.\n'
        + 'Fix: run `bb-bridge health` (it answers without calling Atlassian) to tell those two apart.';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `${MARKER_UNREACHABLE}: ${url} is unreachable (${code}).\n`
        + 'The bridge is loopback-only, so this normally means the loopback interface is not '
        + 'usable from this shell — e.g. the agent is running in a different network namespace '
        + 'or container from the extension host.\n'
        + 'Fix: run the agent in the same environment as the VS Code extension host.';
    case 'ENOTFOUND':
      return `${MARKER_UNREACHABLE}: could not resolve the bridge host in ${url} (ENOTFOUND).\n`
        + 'The coordinates are malformed — the bridge should always be a 127.0.0.1 address.\n'
        + 'Fix: relaunch the Ghola session from Ghola\'s settings panel to rewrite them.';
    default: {
      // Unknown cause: still say WHERE and WHICH route, and still carry the
      // marker so the boot probe classifies it as a bridge problem. Uses the
      // CAUSE's message (see transportDetail) so this never degrades back into
      // printing a bare 'fetch failed'.
      const detail = code ? `${code}: ${transportDetail(err)}` : transportDetail(err);
      return `${MARKER_UNREACHABLE}: request to ${routePath} at ${url} failed (${detail}).\n`
        + 'The bridge is loopback-only, so this is a local transport problem, not an Atlassian one.\n'
        + 'Fix: run `bb-bridge health` to check whether the bridge is alive; if it also fails, '
        + 'relaunch the Ghola session from Ghola\'s settings panel.';
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printJson(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

// Surfaces a PARTIAL read on stderr. A truncated result exits 0 — it is a
// success and must stay one — but that means the only trace of its
// incompleteness is a field in a JSON blob the reader may well skim. Both
// paginated reads (/list-comments, /get-comments) can truncate, and both route
// through here, so the warning is identical for either. Says WARNING, never
// "error": the data is usable and the caller should proceed with it, just
// knowingly.
function warnIfTruncated(parsed) {
  if (!parsed || parsed.truncated !== true) return;
  const detail = typeof parsed.message === 'string' && parsed.message
    ? parsed.message
    : 'the fetch stopped early, so this is only part of the thread.';
  console.error(`bb-bridge: WARNING — PARTIAL RESULT. ${detail}`);
}

// POSTs `body` to `<resolved bridge url>${routePath}` with the bearer token and
// returns the parsed JSON response. Never returns on a bridge-level failure
// (network error, or non-2xx HTTP) — those print + exit(1) directly per the
// contract documented at the top of this file. Shared by postToBridge and
// postToBridgeExists, which differ only in how they judge "success" once a
// response body is in hand.
async function callBridge(routePath, body) {
  const { url, token } = resolveBridge();

  // Retryability is derived from the ROUTE, not from a caller-supplied flag, so
  // no call site can accidentally opt a mutation into being replayed. See
  // RETRYABLE_ROUTES.
  const retryable = RETRYABLE_ROUTES.has(routePath);
  const timeoutMs = timeoutForRoute(routePath);
  const maxAttempts = retryable ? 2 : 1;
  // Routes where a deadline WE set is never a transient blip, so the single
  // client-side replay must be suppressed for that one cause. Both non-fast read
  // tiers qualify — see the retry decision in the catch block below.
  const noReplayOnDeadline = SLOW_READ_ROUTES.has(routePath)
    || RETRY_BUDGET_READ_ROUTES.has(routePath);

  const payload = JSON.stringify(body);
  let res;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch(`${url}${routePath}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
      break;
    } catch (err) {
      // One retry, and only for a route that is safe to replay AND a code that
      // could plausibly succeed on replay.
      //
      // A DEADLINE EXCEEDED on a slow or retry-budget route is deliberately
      // excluded: unlike a reset socket, it is not a blip. On a slow route it
      // means the host's paginated walk genuinely needed longer than we allowed;
      // on a retry-budget route it means the host is mid-backoff against a
      // throttling upstream. Either way, replaying makes the host redo the
      // identical work against a second copy of the same deadline — doubling the
      // wait to reach the same failure. Worse on a retry-budget route: the replay
      // fires a FRESH round of requests at an upstream that has already told us it
      // is rate-limited, spending someone else's 429 budget to learn nothing.
      // Fail once, and tell the operator which knob to turn.
      const deadlineExceeded = isTimeoutTransport(err);
      if (attempt < maxAttempts && isRetryableTransport(err)
        && !(noReplayOnDeadline && deadlineExceeded)) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      // Transport-level failure. The message names the specific cause and the
      // remedy; the token is never interpolated into it on any branch.
      console.error(`bb-bridge: ${describeTransport(url, routePath, err, timeoutMs)}`);
      process.exit(1);
    }
  }

  // Reading the body is a SECOND chance to fail: headers can arrive fine and the
  // socket still die mid-body (or the per-attempt timeout can fire while the
  // body streams). Left unguarded this surfaced as the generic
  // "unexpected error" + stack dump from main()'s catch, which reads like a bug
  // in this script rather than a dead bridge. Never retried here regardless of
  // route — the server has already acted on the request.
  let text;
  try {
    text = await res.text();
  } catch (err) {
    console.error(`bb-bridge: ${describeTransport(url, routePath, err, timeoutMs)}`);
    process.exit(1);
  }

  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    const message = (parsed && typeof parsed.message === 'string')
      ? parsed.message
      : (text ? text.slice(0, 200) : res.statusText || 'bridge error');
    // A host-side CAPABILITY GATE refusal, not a failure. Two routes can produce
    // it — `/post-comment` and `/transition` — because the extension withholds
    // each Jira write function unless its OWN integration.atlassian-suite setting
    // (enableJiraCommentWrite / enableJiraTransition) is on. This branch is
    // deliberately route-agnostic: it prints the server's message, which names the
    // specific setting, rather than hardcoding which capability was refused. It
    // must not be reported through the generic
    // `bridge-error` line below: that line reads like a dead bridge or a bad
    // token and sends the reader off checking transport, when the real answer is
    // "the operator has not enabled this and no request was ever made". The
    // server's own message names the module, the setting, and the Modules-tab
    // label, so it is printed verbatim as the actionable part.
    if (parsed && parsed.status === 'capability-disabled') {
      printJson({ status: 'capability-disabled', httpStatus: res.status, message });
      console.error(
        `bb-bridge: ${routePath} REFUSED — this capability is disabled host-side. Nothing was sent to Atlassian.\n`
        + `bb-bridge: ${message}\n`
        + 'bb-bridge: Retrying cannot help; the setting has to be turned on first.',
      );
      process.exit(1);
    }
    printJson({ status: 'bridge-error', httpStatus: res.status, message });
    process.exit(1);
  }

  return parsed;
}

// POSTs to the bridge, prints the JSON result to stdout, and exits 0 when
// the parsed result's status === 'ok', else 1. Never returns for a
// bridge-level failure (it exits directly) — callers just `await` it and
// fall off the end on success.
async function postToBridge(routePath, body) {
  const parsed = await callBridge(routePath, body);
  printJson(parsed);
  if (parsed && parsed.status === 'ok') {
    warnIfTruncated(parsed);
    process.exit(0);
  }
  // `indeterminate` means a WRITE ended without a definitive answer from
  // Bitbucket — it may or may not have been applied. It exits 1 like any other
  // non-ok status (it is emphatically not a success), but it must never be
  // reported with the generic line below: "did not return status 'ok'" reads as
  // "it failed", and acting on that by re-running the command is precisely how
  // a duplicate comment gets posted. Say the honest thing instead.
  if (parsed && parsed.status === 'indeterminate') {
    const detail = typeof parsed.message === 'string' && parsed.message ? parsed.message : '';
    console.error(
      `bb-bridge: ${routePath} returned an INDETERMINATE result — the write may or may not have been applied.\n`
      + (detail ? `bb-bridge: ${detail}\n` : '')
      + 'bb-bridge: DO NOT simply re-run this command. Check the pull request in Bitbucket first;\n'
      + 'bb-bridge: if the change is already there, the write succeeded and a retry would duplicate it.',
    );
    process.exit(1);
  }
  console.error(`bb-bridge: ${routePath} did not return status 'ok'`);
  process.exit(1);
}

// Same shape as postToBridge, but for endpoints (get-ticket) whose success
// signal is `exists === true` rather than `status === 'ok'` — e.g. "ticket
// not found" is a legitimate, well-formed response the agent needs to fall
// back on, not a bridge-level error.
async function postToBridgeExists(routePath, body) {
  const parsed = await callBridge(routePath, body);
  printJson(parsed);
  if (parsed && parsed.exists === true) {
    process.exit(0);
  } else {
    console.error(`bb-bridge: ${routePath} did not find the resource (exists !== true)`);
    process.exit(1);
  }
}

// Same shape again, but for LIST endpoints (get-comments) where an empty list
// is a legitimate success. Deliberately NOT postToBridgeExists: that helper
// judges only `exists`, which is right for a single resource but would here be
// asked to carry a second meaning. It is also deliberately not postToBridge —
// there is no `status` field on this response.
//
// The three outcomes must stay distinct:
//   - exists === true                 -> exit 0, EVEN when `comments` is empty.
//     "Issue found, zero comments" is an answer, not a failure.
//   - exists === false, no `error`    -> exit 1, the issue genuinely is not there.
//   - `error` present                 -> exit 1, a real failure (e.g. Jira not
//     configured), reported with the server's own message rather than being
//     flattened into a misleading "not found".
async function postToBridgeList(routePath, body, listKey) {
  const parsed = await callBridge(routePath, body);
  printJson(parsed);
  if (parsed && parsed.exists === true) {
    warnIfTruncated(parsed);
    process.exit(0);
  }
  const reason = (parsed && typeof parsed.error === 'string' && parsed.error)
    ? parsed.error
    : 'the resource was not found (exists !== true)';
  console.error(`bb-bridge: ${routePath} returned no ${listKey}: ${reason}`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────
// Subcommands
// ─────────────────────────────────────────────────────────────────────────

// Liveness probe. Takes no flags and calls NEITHER Jira nor Bitbucket — it only
// answers "is a bridge listening at my coordinates, and is my bearer token still
// the one it expects?". That is the question every other verb used to conflate
// with "did Atlassian answer?", which is why a dead bridge and an expired
// Atlassian token produced the same unhelpful failure.
//
// Reading the exit code: 0 = bridge alive and token accepted. 1 = reached
// something but it refused or is not answering (a 401 here means the token is
// stale — relaunch the session). 2 = no coordinates at all, i.e. not a Ghola
// session. It is idempotent and side-effect-free, so it is in RETRYABLE_ROUTES.
async function cmdHealth() {
  await postToBridge('/health', {});
}

async function cmdFindPr(flags) {
  const usage = 'bb-bridge find-pr --repo <slug> --branch <name>';
  const repoSlug = requireFlag(flags, 'repo', usage);
  const branch = requireFlag(flags, 'branch', usage);
  // The printed JSON carries `prState` on a found PR ('OPEN' when the open-state
  // query matched, else 'MERGED' / 'DECLINED' / 'SUPERSEDED' from the fallback),
  // so a found-but-closed PR (status 'ok' + prState !== 'OPEN', e.g. a merged PR
  // still carrying CodeRabbit comments) is distinct from a genuine "no PR at
  // all" (status 'not-found'). A workspace-misconfiguration lookup surfaces its
  // own status/message rather than a bare not-found. A found PR also carries
  // `prAuthor` (the author's Bitbucket nickname handle, for case-insensitive
  // matching against the configured Bitbucket username) and `prAuthorDisplay`
  // (their display name), so a boot-time step can tell author mode from review
  // mode; both flow through untouched via the bridge's `...lookup` spread.
  //
  // A found PR may also carry `draft` (true = still a draft, false = ready for
  // review). It is ABSENT when Bitbucket's list response omitted it, and absent
  // means UNKNOWN — never read a missing `draft` as "ready", or a draft PR gets
  // reported as review-ready on nothing but a missing field.
  await postToBridge('/find-pr', { repoSlug, branch });
}

// Each comment in the printed JSON may carry an OPTIONAL `outdated` boolean —
// Bitbucket's `inline.outdated` marker, meaning the code the comment was
// anchored to has since changed.
//
// ABSENT MEANS UNKNOWN, NOT `false`. The key is omitted entirely for a general
// (non-inline) comment, which has no anchor and can never be outdated, and also
// whenever Bitbucket's list response simply did not include it. Only
// `outdated: true` is a positive fact; reading a missing key as "this comment is
// still current" turns "we did not ask" into "we checked", and that inversion is
// how a live review comment would get deleted.
async function cmdListComments(flags) {
  const usage = 'bb-bridge list-comments --repo <slug> --pr <id>';
  const repoSlug = requireFlag(flags, 'repo', usage);
  const prId = requireNumberFlag(flags, 'pr', usage);
  await postToBridge('/list-comments', { repoSlug, prId });
}

// Print the Bitbucket identity of the API TOKEN the extension host calls with.
// Pure read — retryable. Takes NO flags: there is nothing to point it at, since
// the only account it can report is the one behind the host's own credential.
//
// This is the answer to "did WE write this comment?", and it is the only place
// that answer can come from. `list-comments` gives each comment an
// `author.accountId`; this gives ours. Compare those two — they are the same key
// space, so it is an equality test, not a heuristic. Do NOT compare against the
// configured Bitbucket USERNAME instead: that setting is a nickname, it lives in
// a different key space from `accountId`, and it describes the OPERATOR rather
// than the token (a service-account token makes those two different people).
//
// KNOWING A COMMENT IS OURS IS NOT PERMISSION TO DELETE IT. This verb reports an
// identity and authorizes nothing; `delete-comment` keeps its own gate, and this
// route does not touch it.
//
// PRINTS NO CREDENTIAL. `accountId` / `nickname` / `displayName` / `uuid` are
// the same public identifiers that already appear on every comment
// `list-comments` returns. The token itself never crosses the bridge in either
// direction.
//
// The host caches a SUCCESSFUL answer for its process lifetime, so repeat calls
// cost nothing; a failed call is not cached, so re-running after fixing a token
// really does retry.
async function cmdWhoami() {
  await postToBridge('/whoami', {});
}

// CAPTURE a PR's comments into the reviewer-dossier capture file. Same two
// arguments as `list-comments` because it reads exactly the same thing — the
// difference is entirely in what the HOST does with the result.
//
// Notice what is NOT a flag: the capture file's path. It is resolved host-side
// and injected into the agent's Session Manifest at compose time, so there is
// nothing here for a caller to point at a different file — and nothing for an
// agent to guess, which is what went wrong with the prose-only comment log this
// replaces (a RELATIVE default path that resolved against whatever cwd the agent
// happened to have, i.e. into the work repo).
//
// The result carries `filePath`, `project`, `captured`, `skipped`, `total` and
// `truncated`. `skipped` is not a failure: it counts comments already on file
// from an earlier capture, so a re-run of a PR that has not changed correctly
// reports `captured: 0`.
//
// This is a WRITE (to disk) and so is NOT in RETRYABLE_ROUTES — see the note
// there. It still exits 0 / 1 through postToBridge like every other verb, and a
// partial capture arrives as status 'ok' with truncated: true plus the standard
// PARTIAL RESULT warning on stderr.
async function cmdCaptureComments(flags) {
  const usage = 'bb-bridge capture-comments --repo <slug> --pr <id>';
  const repoSlug = requireFlag(flags, 'repo', usage);
  const prId = requireNumberFlag(flags, 'pr', usage);
  await postToBridge('/capture-comments', { repoSlug, prId });
}

async function cmdResolve(flags) {
  const usage = 'bb-bridge resolve --repo <slug> --pr <id> --comment <id>';
  const repoSlug = requireFlag(flags, 'repo', usage);
  const prId = requireNumberFlag(flags, 'pr', usage);
  const commentId = requireNumberFlag(flags, 'comment', usage);
  await postToBridge('/resolve', { repoSlug, prId, commentId });
}

async function cmdDeleteComment(flags) {
  const usage = 'bb-bridge delete-comment --repo <slug> --pr <n> --comment <id>';
  const repoSlug = requireFlag(flags, 'repo', usage);
  const prId = requireNumberFlag(flags, 'pr', usage);
  const commentId = requireNumberFlag(flags, 'comment', usage);
  await postToBridge('/delete-comment', { repoSlug, prId, commentId });
}

async function cmdMarkReady(flags) {
  const usage = 'bb-bridge mark-ready --repo <slug> --pr <id>';
  const repoSlug = requireFlag(flags, 'repo', usage);
  const prId = requireNumberFlag(flags, 'pr', usage);
  await postToBridge('/mark-ready', { repoSlug, prId });
}

async function cmdToDraft(flags) {
  const usage = 'bb-bridge to-draft --repo <slug> --pr <id>';
  const repoSlug = requireFlag(flags, 'repo', usage);
  const prId = requireNumberFlag(flags, 'pr', usage);
  await postToBridge('/to-draft', { repoSlug, prId });
}

async function cmdReply(flags) {
  const usage = 'bb-bridge reply --repo <slug> --pr <id> --parent <id> '
    + '[--inline-path <p> --inline-to <n> [--inline-from <n>]]  (body piped via stdin)';
  const repoSlug = requireFlag(flags, 'repo', usage);
  const prId = requireNumberFlag(flags, 'pr', usage);
  const parentId = requireNumberFlag(flags, 'parent', usage);

  const inlinePath = typeof flags['inline-path'] === 'string' ? flags['inline-path'] : undefined;
  const inlineTo = optionalNumberFlag(flags, 'inline-to', usage);
  const inlineFrom = optionalNumberFlag(flags, 'inline-from', usage);

  let inline;
  if (inlinePath !== undefined && inlineTo !== undefined) {
    inline = { path: inlinePath, to: inlineTo };
    if (inlineFrom !== undefined) inline.from = inlineFrom;
  }

  const body = await readStdin();
  const payload = { repoSlug, prId, parentId, body };
  if (inline) payload.inline = inline;
  await postToBridge('/reply', payload);
}

// Standalone, TOP-LEVEL PR comment. Deliberately does NOT accept or require
// --parent (that is cmdReply's job, which threads under an existing comment)
// and offers no inline file/line anchoring. The body arrives as a --body flag
// rather than via stdin because the canonical use is a short bot trigger
// (e.g. `@coderabbitai review`) that a caller wants on one line.
async function cmdCreateComment(flags) {
  const usage = 'bb-bridge create-comment --repo <slug> --pr <id> --body "<text>"';
  const repoSlug = requireFlag(flags, 'repo', usage);
  const prId = requireNumberFlag(flags, 'pr', usage);
  const body = requireFlag(flags, 'body', usage);
  // A whitespace-only body would otherwise post a blank comment (or be rejected
  // opaquely by Bitbucket); fail explicitly here instead, mirroring cmdGetTicket.
  if (body.trim() === '') {
    usageFail(`--body must not be empty. Usage: ${usage}`);
  }
  await postToBridge('/create-comment', { repoSlug, prId, body });
}

async function cmdCreatePr(flags) {
  const usage = 'bb-bridge create-pr --repo <slug> --source <branch> --target <branch> '
    + '--title <title> [--draft] [--reviewers \'["id1","id2"]\']  (description piped via stdin)';
  const repoSlug = requireFlag(flags, 'repo', usage);
  const sourceBranch = requireFlag(flags, 'source', usage);
  const targetBranch = requireFlag(flags, 'target', usage);
  const title = requireFlag(flags, 'title', usage);
  // --draft is a bare boolean flag: present -> true (parseArgs sets it to the
  // literal `true` when no value follows), absent -> false.
  const draft = flags['draft'] === true;

  // --reviewers is an optional JSON array of account ID strings. Each is mapped
  // to `{ account_id: id }` for the Bitbucket API. Absent or empty -> omitted
  // from the payload (backwards compatible).
  const reviewers = parseReviewersFlag(flags, usage);

  // The description is multi-line, so it is piped via stdin (mirrors cmdReply)
  // rather than passed as a flag to dodge shell-escaping pain.
  const description = await readStdin();
  const payload = {
    repoSlug,
    title,
    sourceBranch,
    targetBranch,
    description,
    draft,
  };
  if (reviewers) payload.reviewers = reviewers;
  await postToBridge('/create-pr', payload);
}

// Update an existing PR. Accepts any combination of --title, --description, and
// --reviewers; at least one must be supplied. Note the contrast with create-pr,
// which reads its description from stdin: here --description is a plain string
// flag and there is no stdin path. This is a PUT (mutation), so it is NOT added
// to RETRYABLE_ROUTES and `indeterminate` is handled the same way as other writes.
async function cmdUpdatePr(flags) {
  const usage = 'bb-bridge update-pr --repo <slug> --pr <id> '
    + '[--reviewers \'["id1","id2"]\'] [--title "..."] [--description "..."]';
  const repoSlug = requireFlag(flags, 'repo', usage);
  const prId = requireNumberFlag(flags, 'pr', usage);

  const reviewers = parseReviewersFlag(flags, usage);
  const title = typeof flags['title'] === 'string' ? flags['title'] : undefined;
  const description = typeof flags['description'] === 'string' ? flags['description'] : undefined;

  if (reviewers === undefined && title === undefined && description === undefined) {
    usageFail('At least one of --reviewers, --title, or --description must be provided. '
      + `Usage: ${usage}`);
  }

  const payload = { repoSlug, prId };
  if (reviewers) payload.reviewers = reviewers;
  if (title !== undefined) payload.title = title;
  if (description !== undefined) payload.description = description;
  await postToBridge('/update-pr', payload);
}

async function cmdGetTicket(flags) {
  const usage = 'bb-bridge get-ticket --key <KEY>';
  const key = requireFlag(flags, 'key', usage);
  if (key.trim() === '') {
    usageFail(`--key must not be empty. Usage: ${usage}`);
  }
  await postToBridgeExists('/get-ticket', { key });
}

// Read a Jira issue's comments. READ-ONLY — there is no comment-posting verb
// here and Jira mutations stay forbidden. The printed JSON carries
// `comments: [{ author, created, body }]` with `body` already flattened from
// ADF to plain text host-side. An issue with zero comments prints
// `{ exists: true, comments: [] }` and exits 0; treat that as "no comments
// yet", never as "ticket not found".
async function cmdGetComments(flags) {
  const usage = 'bb-bridge get-comments --key <ISSUE-KEY>';
  const key = requireFlag(flags, 'key', usage);
  if (key.trim() === '') {
    usageFail(`--key must not be empty. Usage: ${usage}`);
  }
  await postToBridgeList('/get-comments', { key }, 'comments');
}

// Post a comment to a Jira issue. This is the ONE Jira WRITE this wrapper has,
// and the only ticketing-system mutation anywhere in it.
//
// Authorization is NOT this script's job and must not be inferred from the
// verb's mere existence. Agents are forbidden from mutating ticketing systems
// by their core hard rules; the Jira Comment Write flow in
// `integration.atlassian-suite` is what contributes the capability, and only
// when the operator has turned on its `enableJiraCommentWrite` setting (which
// defaults to off). It then further requires the operator to have seen and
// approved the exact comment text. With that gate off, this verb is not to be
// invoked — and as of the host-side enforcement it also CANNOT work: the
// extension withholds the comment-write function from the bridge, so the route
// answers 403 `capability-disabled` and this verb exits 1 without Jira ever
// being contacted (see the `capability-disabled` branch in callBridge).
//
// The BODY IS READ FROM STDIN, never a --body flag, matching `reply` and
// `create-pr`. That is a security property, not a style choice: a flag value
// lands in shell history and is visible in `ps` output to every other user on
// the box, and a comment body may quote internal discussion. (`create-comment`
// uses a flag deliberately, but only because its canonical payload is a short
// public bot trigger like `@coderabbitai review`.)
//
// Success is judged on `posted`, not `status` — the bridge returns
// `{ posted, id?, error? }` here, so neither postToBridge (wants `status`) nor
// postToBridgeExists (wants `exists`) fits.
//
// NEVER auto-retry a failure from this verb. A timeout is ambiguous: Jira may
// have created the comment before the connection dropped, so a blind retry can
// double-post onto a ticket colleagues are reading. Surface the error, let a
// human look at the issue, and only then decide.
async function cmdPostComment(flags) {
  const usage = 'bb-bridge post-comment --key <ISSUE-KEY>   (comment body piped via stdin)';
  const key = requireFlag(flags, 'key', usage);
  if (key.trim() === '') {
    usageFail(`--key must not be empty. Usage: ${usage}`);
  }
  const body = await readStdin();
  // Refuse a blank body locally rather than round-tripping it: posting an empty
  // comment to a shared ticket is never the intent. The bridge enforces this
  // too; catching it here gives a usage error (exit 2) instead of a bridge one.
  if (body.trim() === '') {
    usageFail(`comment body (stdin) must not be empty. Usage: ${usage}`);
  }

  const parsed = await callBridge('/post-comment', { key, body });
  printJson(parsed);
  if (parsed && parsed.posted === true) {
    process.exit(0);
  }
  const reason = (parsed && typeof parsed.error === 'string' && parsed.error)
    ? parsed.error
    : 'the comment was not posted (posted !== true)';
  console.error(
    `bb-bridge: /post-comment failed: ${reason}\n`
    + 'bb-bridge: DO NOT blindly retry — if this was a timeout the comment may '
    + 'already exist. Check the issue first.',
  );
  process.exit(1);
}

// Read the transitions Jira currently offers on an issue. READ-ONLY and
// UNGATED: it tells you what a move WOULD be, it does not make one, and the
// `enableJiraTransition` gate has no bearing on it. The printed JSON carries
// `transitions: [{ id, name, toStatus, hasScreen?, requiredFields? }]`.
//
// THIS IS WHERE A --transition-id COMES FROM. The `transition` verb executes an
// id and never derives one — no status-name matching, no closest match, no
// "first available" default — so an id that was not read from here was guessed,
// and a guessed transition moves someone's ticket to the wrong place.
//
// Read `name` and `toStatus` as DIFFERENT things: the transition's own label
// ("Start Review") and the status it lands in ("In Review") are frequently
// different words, and matching a target status against a transition name is how
// the wrong button gets pressed. `requiredFields`, when present, means the
// transition's screen demands values this bridge cannot supply — that one needs
// a human in Jira, and knowing so BEFORE asking an operator to approve the move
// is the reason the host requests the field metadata at all.
//
// An issue with zero available transitions prints `{ exists: true,
// transitions: [] }` and exits 0; treat that as "this issue cannot be moved from
// here (by this account)", never as "ticket not found".
async function cmdGetTransitions(flags) {
  const usage = 'bb-bridge get-transitions --key <ISSUE-KEY>';
  const key = requireFlag(flags, 'key', usage);
  if (key.trim() === '') {
    usageFail(`--key must not be empty. Usage: ${usage}`);
  }
  await postToBridgeList('/get-transitions', { key }, 'transitions');
}

// Move a Jira issue along its workflow. This is a Jira WRITE — the second and
// last ticketing-system mutation in this wrapper.
//
// Authorization is NOT this script's job and must not be inferred from the
// verb's mere existence. Agents are forbidden from mutating ticketing systems by
// their core hard rules; the transition flow in `integration.atlassian-suite` is
// what contributes the capability, and only when the operator has turned on its
// `enableJiraTransition` setting (which defaults to off). With that gate off,
// this verb is not to be invoked — and it also CANNOT work: the extension
// withholds the transition function from the bridge, so the route answers 403
// `capability-disabled` and this verb exits 1 without Jira ever being contacted
// and without the issue's status changing (see the `capability-disabled` branch
// in callBridge).
//
// --transition-id IS MANDATORY AND MUST COME FROM get-transitions. Nothing in
// this script, the bridge, or the host client picks a transition: there is no
// name matching, no closest-match fallback, and no defaulting to the first
// available option anywhere in the path. Choosing is the caller's job precisely
// so the choice is visible.
//
// Success is judged on `transitioned`, not `status` — the bridge returns
// `{ transitioned, transitionId?, error? }` here, so neither postToBridge (wants
// `status`) nor postToBridgeExists (wants `exists`) fits.
//
// AND `transitioned: true` MEANS JIRA ACCEPTED THE REQUEST, not that the issue's
// status is now what was asked for. Jira answers a successful transition with
// 204 and no body, and a workflow post-function or automation rule can move the
// issue on again immediately. Nothing here re-reads the issue, so nothing here
// claims what its status became.
//
// NEVER auto-retry a failure from this verb. A timeout is ambiguous: Jira may
// have applied the transition before the connection dropped, and a blind retry
// can move the ticket a second time. Surface the error, let a human look at the
// issue, and only then decide.
async function cmdTransition(flags) {
  const usage = 'bb-bridge transition --key <ISSUE-KEY> --transition-id <id>';
  const key = requireFlag(flags, 'key', usage);
  if (key.trim() === '') {
    usageFail(`--key must not be empty. Usage: ${usage}`);
  }
  const transitionId = requireFlag(flags, 'transition-id', usage);
  if (String(transitionId).trim() === '') {
    usageFail(`--transition-id must not be empty. Usage: ${usage}`);
  }

  const parsed = await callBridge('/transition', { key, transitionId: String(transitionId) });
  printJson(parsed);
  if (parsed && parsed.transitioned === true) {
    process.exit(0);
  }
  const reason = (parsed && typeof parsed.error === 'string' && parsed.error)
    ? parsed.error
    : 'the transition was not applied (transitioned !== true)';
  console.error(
    `bb-bridge: /transition failed: ${reason}\n`
    + 'bb-bridge: DO NOT blindly retry — if this was a timeout the issue may '
    + 'already have moved. Check the issue\'s status first.',
  );
  process.exit(1);
}

// Workspace member search. Pure read — retryable. Default output: one line per
// member as `<displayName> (<accountId>)`. --json prints the raw bridge response.
// --workspace is optional: the bridge defaults to the configured bitbucketWorkspace.
async function cmdWorkspaceMembers(flags) {
  const usage = 'bb-bridge workspace-members [--workspace <slug>] [--query <search>] [--json]';
  const payload = {};
  if (typeof flags.workspace === 'string') payload.workspace = flags.workspace;
  if (typeof flags.query === 'string') payload.query = flags.query;
  const parsed = await callBridge('/workspace-members', payload);
  if (flags.json === true) {
    printJson(parsed);
  } else if (parsed && parsed.status === 'ok' && Array.isArray(parsed.members)) {
    for (const m of parsed.members) {
      console.log(`${m.displayName} (${m.accountId})`);
    }
  } else {
    printJson(parsed);
  }
  if (parsed && parsed.status === 'ok') {
    process.exit(0);
  }
  console.error(`bb-bridge: /workspace-members did not return status 'ok'`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────
// Terminal subcommands
// ─────────────────────────────────────────────────────────────────────────

// Create a new managed terminal. Prints the terminalId on success.
async function cmdTerminalCreate(flags) {
  const usage = 'bb-bridge terminal-create --name <name> [--shell <shell>] [--cwd <path>]';
  const name = requireFlag(flags, 'name', usage);
  const payload = { name };
  if (typeof flags.shell === 'string') payload.shell = flags.shell;
  if (typeof flags.cwd === 'string') payload.cwd = flags.cwd;
  const parsed = await callBridge('/terminal/create', payload);
  printJson(parsed);
  if (parsed && parsed.status === 'ok') {
    process.exit(0);
  }
  console.error(`bb-bridge: /terminal/create failed: ${parsed && parsed.message || 'unknown error'}`);
  process.exit(1);
}

// Execute a command in a managed terminal. This can block for a long time
// (up to humanInterventionTimeoutMs) when --wait-for-human is set, so the
// fetch timeout is set generously. NOT retryable — it is a mutation /
// long-running command.
async function cmdTerminalExec(flags) {
  const usage = 'bb-bridge terminal-exec --id <terminalId> --command <command> [--wait-for-human] [--timeout <ms>]';
  const terminalId = requireFlag(flags, 'id', usage);
  const command = requireFlag(flags, 'command', usage);
  const payload = { terminalId, command };
  if (flags['wait-for-human'] === true) payload.waitForHuman = true;
  const timeoutMs = optionalNumberFlag(flags, 'timeout', usage);
  if (timeoutMs !== undefined) payload.timeoutMs = timeoutMs;
  const parsed = await callBridge('/terminal/exec', payload);
  printJson(parsed);
  if (parsed && parsed.status === 'ok') {
    process.exit(0);
  }
  console.error(`bb-bridge: /terminal/exec failed: ${parsed && parsed.message || 'unknown error'}`);
  process.exit(1);
}

// List all managed terminals and their state.
async function cmdTerminalList() {
  const parsed = await callBridge('/terminal/list', {});
  printJson(parsed);
  if (parsed && Array.isArray(parsed.terminals)) {
    process.exit(0);
  }
  console.error('bb-bridge: /terminal/list did not return a terminals array');
  process.exit(1);
}

// Dispose (close) a managed terminal by id.
async function cmdTerminalDispose(flags) {
  const usage = 'bb-bridge terminal-dispose --id <terminalId>';
  const terminalId = requireFlag(flags, 'id', usage);
  const parsed = await callBridge('/terminal/dispose', { terminalId });
  printJson(parsed);
  if (parsed && parsed.status === 'ok') {
    process.exit(0);
  }
  console.error(`bb-bridge: /terminal/dispose failed: ${parsed && parsed.message || 'unknown error'}`);
  process.exit(1);
}

// Send a signal to a managed terminal (e.g. to acknowledge human intervention).
async function cmdTerminalSignal(flags) {
  const usage = 'bb-bridge terminal-signal --id <terminalId>';
  const terminalId = requireFlag(flags, 'id', usage);
  const parsed = await callBridge('/terminal/signal', { terminalId });
  printJson(parsed);
  if (parsed && parsed.status === 'ok') {
    process.exit(0);
  }
  console.error(`bb-bridge: /terminal/signal failed: ${parsed && parsed.message || 'unknown error'}`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────

const HELP = `bb-bridge — CLI-agent bridge client for Bitbucket PR actions.

Resolves the bridge's coordinates (never as flags) and POSTs one JSON request to
the extension host's loopback bridge. Coordinates come from GHOLA_BRIDGE_FILE
(a 0600 JSON file the extension rewrites on every start, re-read on every
invocation so a reloaded extension host is picked up automatically), falling
back to the legacy GHOLA_BRIDGE_URL / GHOLA_BRIDGE_TOKEN env pair.

Usage:
  node scripts/bb-bridge.mjs find-pr       --repo <slug> --branch <name>
  node scripts/bb-bridge.mjs list-comments --repo <slug> --pr <id>
  node scripts/bb-bridge.mjs capture-comments --repo <slug> --pr <id>
                                            (reads the same comments as
                                             list-comments and APPENDS one JSONL
                                             record per comment — every comment,
                                             agreed or disagreed, bot or human —
                                             to the reviewer-dossier capture
                                             file. The path is resolved by the
                                             extension host and injected into the
                                             Session Manifest; it is never a flag
                                             and must never be guessed. Writes to
                                             DISK only — nothing is sent to
                                             Bitbucket. Re-running is safe: the
                                             append de-duplicates on
                                             project+PR+comment+updatedAt.)
  node scripts/bb-bridge.mjs resolve       --repo <slug> --pr <id> --comment <id>
  node scripts/bb-bridge.mjs delete-comment --repo <slug> --pr <n> --comment <id>
  node scripts/bb-bridge.mjs mark-ready    --repo <slug> --pr <id>
  node scripts/bb-bridge.mjs to-draft      --repo <slug> --pr <id>
  node scripts/bb-bridge.mjs create-comment --repo <slug> --pr <id> --body "<text>"
                                            (standalone top-level comment; no --parent)
  node scripts/bb-bridge.mjs create-pr     --repo <slug> --source <branch> --target <branch> \\
      --title <title> [--draft] [--reviewers '["id1","id2"]']
                                            (description is read from stdin;
                                             --reviewers is a JSON array of
                                             Bitbucket account ID strings)
  node scripts/bb-bridge.mjs update-pr     --repo <slug> --pr <id> \\
      [--reviewers '["id1","id2"]'] [--title "..."] [--description "..."]
                                            (update an existing PR; at least one
                                             of --reviewers, --title, or
                                             --description must be provided;
                                             this is a PUT/mutation — never
                                             auto-retried)
  node scripts/bb-bridge.mjs reply         --repo <slug> --pr <id> --parent <id> \\
      [--inline-path <p> --inline-to <n> [--inline-from <n>]]
                                            (reply body is read from stdin)
  node scripts/bb-bridge.mjs get-ticket    --key <KEY>
  node scripts/bb-bridge.mjs get-comments  --key <ISSUE-KEY>
                                            (read-only; zero comments still exits 0)
  node scripts/bb-bridge.mjs post-comment  --key <ISSUE-KEY>
                                            (comment body read from stdin)
                                            (Jira WRITE — requires the Atlassian
                                             Suite module's "Enable Jira Comment
                                             Write" setting to be on, plus
                                             operator approval of the exact
                                             text; never auto-retry)
  node scripts/bb-bridge.mjs get-transitions --key <ISSUE-KEY>
                                            (read-only and ungated; prints
                                             transitions: [{ id, name, toStatus,
                                             hasScreen?, requiredFields? }].
                                             THE ONLY SOURCE OF A VALID
                                             --transition-id. name and toStatus
                                             are different things — match on the
                                             one you mean. requiredFields means
                                             the move needs a human in Jira.
                                             Zero transitions still exits 0)
  node scripts/bb-bridge.mjs transition    --key <ISSUE-KEY> --transition-id <id>
                                            (Jira WRITE — requires the Atlassian
                                             Suite module's "Enable Jira
                                             Transition" setting to be on. The id
                                             MUST come from get-transitions;
                                             nothing in this path matches on a
                                             status name or picks a default.
                                             transitioned: true means Jira
                                             ACCEPTED the request (204), not that
                                             the status is now what you asked
                                             for; never auto-retry)
  node scripts/bb-bridge.mjs workspace-members [--workspace <slug>] [--query <search>] [--json]
                                            (list workspace members; defaults to
                                             configured bitbucketWorkspace;
                                             --json prints raw bridge response)
  node scripts/bb-bridge.mjs whoami
                                            (read-only; no flags. Prints the
                                             Bitbucket identity of the API TOKEN
                                             the host calls with:
                                             { accountId, nickname, displayName,
                                             uuid }. accountId is the SAME key
                                             space as each comment's
                                             author.accountId from list-comments,
                                             so comparing the two is how you tell
                                             whether a comment is ours — the
                                             configured Bitbucket username is a
                                             nickname and will not join. Knowing
                                             a comment is ours authorizes
                                             nothing; delete keeps its own gate.
                                             No credential is printed)
  node scripts/bb-bridge.mjs health
                                            (liveness only: authenticated, but
                                             calls neither Jira nor Bitbucket —
                                             use it to tell "bridge is dead"
                                             apart from "Atlassian said no")
  node scripts/bb-bridge.mjs terminal-create --name <name> [--shell <shell>] [--cwd <path>]
                                            (create a managed terminal)
  node scripts/bb-bridge.mjs terminal-exec   --id <terminalId> --command <command>
                                             [--wait-for-human] [--timeout <ms>]
                                            (execute a command; can block for a
                                             long time with --wait-for-human)
  node scripts/bb-bridge.mjs terminal-list
                                            (list managed terminals)
  node scripts/bb-bridge.mjs terminal-dispose --id <terminalId>
                                            (close a managed terminal)
  node scripts/bb-bridge.mjs terminal-signal  --id <terminalId>
                                            (signal a terminal, e.g. acknowledge
                                             human intervention)

Exit codes: 0 ok, 1 bridge-level failure, 2 usage error (env/args).

Read verbs (health, get-ticket, get-comments, get-transitions, find-pr,
list-comments, workspace-members, whoami) get one automatic retry on a transient
transport error. Write
verbs NEVER retry: a timeout on a write is ambiguous and a replay could
double-post — or, for transition, move the ticket a second time.

Timeouts come in three read tiers, each set above the HOST's worst case for that
route (a bound below it would abort work the host is still doing correctly):
  3s    health — answers without calling Atlassian at all, so anything slower
        means a wedged bridge.
  87s   find-pr, get-ticket, get-transitions, workspace-members, whoami — one
        logical upstream call, but the
        host retries a 429/5xx up to 4 times honoring Retry-After (41s per
        request; find-pr may run two queries, and a multi-token Bitbucket setup
        multiplies that by the token count).
  120s  list-comments (Bitbucket), get-comments (Jira) — each walks its API page
        by page, so a long thread legitimately needs longer.
capture-comments is a WRITE (to a local file) but performs the list-comments walk
plus one PR read, so it gets its own 161s bound rather than the 30s write bound.
Other writes are pinned at 30s and cannot be widened. Override the read budgets with
GHOLA_BRIDGE_TIMEOUT_MS (1000-600000 ms); prefer prefixing it to one command over
exporting it. These are CEILINGS, not waits — a healthy call still returns in
well under a second.

A deadline on any of those non-health reads is reported as 'bridge-timeout',
NOT 'bridge-unreachable' — the bridge is alive and the fix is more time (or
waiting out a rate limit), never a session relaunch. Treat a 'bridge-timeout' on
find-pr / get-ticket / get-transitions as UNKNOWN, never as an absence: nothing
answered, so "no PR" / "no ticket" / "no available transitions" was not
established. A large PR may also come back as a
successful PARTIAL result: status 'ok' with truncated: true and a message saying
how many of how many comments were fetched. Treat that as real data, not as a
failure.

list-comments (and each capture-comments record) may carry an OPTIONAL
'outdated' boolean per comment — Bitbucket's inline.outdated marker, meaning the
code the comment was anchored to has since changed. The key is ABSENT when it
was not established: a general comment has no anchor and can never be outdated,
and the list response may simply omit it. Absent means UNKNOWN, never false —
only outdated: true is a positive fact.
`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    console.log(HELP);
    process.exit(0);
  }

  const [subcommand, ...rest] = argv;
  const routes = {
    'find-pr': cmdFindPr,
    'list-comments': cmdListComments,
    'capture-comments': cmdCaptureComments,
    resolve: cmdResolve,
    'delete-comment': cmdDeleteComment,
    'mark-ready': cmdMarkReady,
    'to-draft': cmdToDraft,
    'create-comment': cmdCreateComment,
    'create-pr': cmdCreatePr,
    'update-pr': cmdUpdatePr,
    reply: cmdReply,
    'get-ticket': cmdGetTicket,
    'get-comments': cmdGetComments,
    'post-comment': cmdPostComment,
    'get-transitions': cmdGetTransitions,
    transition: cmdTransition,
    'workspace-members': cmdWorkspaceMembers,
    whoami: cmdWhoami,
    health: cmdHealth,
    'terminal-create': cmdTerminalCreate,
    'terminal-exec': cmdTerminalExec,
    'terminal-list': cmdTerminalList,
    'terminal-dispose': cmdTerminalDispose,
    'terminal-signal': cmdTerminalSignal,
  };
  const handler = routes[subcommand];
  if (!handler) {
    usageFail(`unknown subcommand '${subcommand}'. Run with --help for usage.`);
  }

  const flags = parseArgs(rest);
  await handler(flags);
}

main().catch((err) => {
  if (err instanceof UsageError) {
    console.error(`bb-bridge: ${err.message}`);
    process.exit(2);
  }
  console.error(`bb-bridge: unexpected error: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
