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
//   node scripts/bb-bridge.mjs resolve       --repo <slug> --pr <id> --comment <id>
//   node scripts/bb-bridge.mjs delete-comment --repo <slug> --pr <n> --comment <id>
//   node scripts/bb-bridge.mjs mark-ready    --repo <slug> --pr <id>
//   node scripts/bb-bridge.mjs to-draft      --repo <slug> --pr <id>
//   node scripts/bb-bridge.mjs create-comment --repo <slug> --pr <id> --body "<text>"
//   node scripts/bb-bridge.mjs create-pr     --repo <slug> --source <branch> --target <branch> \
//       --title <title> [--draft]   (description piped via stdin)
//   node scripts/bb-bridge.mjs reply         --repo <slug> --pr <id> --parent <id> \
//       [--inline-path <p> --inline-to <n> [--inline-from <n>]]   (body piped via stdin)
//   node scripts/bb-bridge.mjs get-ticket    --key <KEY>
//   node scripts/bb-bridge.mjs get-comments  --key <ISSUE-KEY>
//   node scripts/bb-bridge.mjs post-comment  --key <ISSUE-KEY>
//       (comment body piped via stdin; requires integration.jira-comment-write)
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
// DO NOT ADD A MUTATION TO THIS SET. /post-comment, /reply, /create-comment,
// /create-pr, /delete-comment, /resolve, /mark-ready and /to-draft all WRITE to
// the operator's live Jira / Bitbucket. A transport timeout on a write is
// AMBIGUOUS — the server may have applied it before the connection dropped — so
// retrying one risks a duplicate comment or a duplicate PR on a ticket other
// people are reading. Every route below is a pure read whose worst case on
// replay is a wasted API call.
const RETRYABLE_ROUTES = new Set([
  '/health',
  '/get-ticket',
  '/get-comments',
  '/find-pr',
  '/list-comments',
]);

// Per-attempt request timeouts. Reads get a tight bound so a hung bridge cannot
// stall a boot probe; writes get a looser one because aborting a write in
// flight makes its outcome ambiguous, which is exactly what we are trying to
// avoid. Before this, there was NO timeout on this hop at all — a wedged bridge
// hung the caller forever.
// 3s is generous for a loopback hop: a bridge that has not answered in 3s is
// wedged, not slow. Kept deliberately tight because the WORST case is
// 2 * READ_TIMEOUT_MS + RETRY_DELAY_MS (~6.25s) and scripts/ghola-boot-probe.sh
// runs reads on the session's critical boot path.
const READ_TIMEOUT_MS = 3000;
const MUTATION_TIMEOUT_MS = 30000;

// Pause between the first attempt and the single retry, for retryable routes.
const RETRY_DELAY_MS = 250;

// Stable, greppable markers embedded in every transport-level failure message.
// scripts/ghola-boot-probe.sh matches on these to tell "the bridge is down"
// apart from "there is no ticket in this branch" / "this is not a Bitbucket
// repo", which used to be indistinguishable because the probe discarded stderr.
// Changing these strings requires updating that probe's grep.
const MARKER_UNREACHABLE = 'bridge-unreachable';
const MARKER_UNAVAILABLE = 'bridge-unavailable';

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
function describeTransport(url, routePath, err) {
  const code = transportCode(err);
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
  const timeoutMs = retryable ? READ_TIMEOUT_MS : MUTATION_TIMEOUT_MS;
  const maxAttempts = retryable ? 2 : 1;

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
      if (attempt < maxAttempts && isRetryableTransport(err)) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      // Transport-level failure. The message names the specific cause and the
      // remedy; the token is never interpolated into it on any branch.
      console.error(`bb-bridge: ${describeTransport(url, routePath, err)}`);
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
    console.error(`bb-bridge: ${describeTransport(url, routePath, err)}`);
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
    process.exit(0);
  } else {
    console.error(`bb-bridge: ${routePath} did not return status 'ok'`);
    process.exit(1);
  }
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
  await postToBridge('/find-pr', { repoSlug, branch });
}

async function cmdListComments(flags) {
  const usage = 'bb-bridge list-comments --repo <slug> --pr <id>';
  const repoSlug = requireFlag(flags, 'repo', usage);
  const prId = requireNumberFlag(flags, 'pr', usage);
  await postToBridge('/list-comments', { repoSlug, prId });
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
    + '--title <title> [--draft]  (description piped via stdin)';
  const repoSlug = requireFlag(flags, 'repo', usage);
  const sourceBranch = requireFlag(flags, 'source', usage);
  const targetBranch = requireFlag(flags, 'target', usage);
  const title = requireFlag(flags, 'title', usage);
  // --draft is a bare boolean flag: present -> true (parseArgs sets it to the
  // literal `true` when no value follows), absent -> false.
  const draft = flags['draft'] === true;

  // The description is multi-line, so it is piped via stdin (mirrors cmdReply)
  // rather than passed as a flag to dodge shell-escaping pain.
  const description = await readStdin();
  await postToBridge('/create-pr', {
    repoSlug,
    title,
    sourceBranch,
    targetBranch,
    description,
    draft,
  });
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
// by their core hard rules; the `integration.jira-comment-write` module is what
// contributes the capability, and it requires the operator to have seen and
// approved the exact comment text first. If that module is not enabled, this
// verb is not to be invoked.
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
  node scripts/bb-bridge.mjs resolve       --repo <slug> --pr <id> --comment <id>
  node scripts/bb-bridge.mjs delete-comment --repo <slug> --pr <n> --comment <id>
  node scripts/bb-bridge.mjs mark-ready    --repo <slug> --pr <id>
  node scripts/bb-bridge.mjs to-draft      --repo <slug> --pr <id>
  node scripts/bb-bridge.mjs create-comment --repo <slug> --pr <id> --body "<text>"
                                            (standalone top-level comment; no --parent)
  node scripts/bb-bridge.mjs create-pr     --repo <slug> --source <branch> --target <branch> \\
      --title <title> [--draft]         (description is read from stdin)
  node scripts/bb-bridge.mjs reply         --repo <slug> --pr <id> --parent <id> \\
      [--inline-path <p> --inline-to <n> [--inline-from <n>]]
                                            (reply body is read from stdin)
  node scripts/bb-bridge.mjs get-ticket    --key <KEY>
  node scripts/bb-bridge.mjs get-comments  --key <ISSUE-KEY>
                                            (read-only; zero comments still exits 0)
  node scripts/bb-bridge.mjs post-comment  --key <ISSUE-KEY>
                                            (comment body read from stdin)
                                            (Jira WRITE — requires the
                                             integration.jira-comment-write
                                             module and operator approval of
                                             the exact text; never auto-retry)
  node scripts/bb-bridge.mjs health
                                            (liveness only: authenticated, but
                                             calls neither Jira nor Bitbucket —
                                             use it to tell "bridge is dead"
                                             apart from "Atlassian said no")

Exit codes: 0 ok, 1 bridge-level failure, 2 usage error (env/args).

Read verbs (health, get-ticket, get-comments, find-pr, list-comments) get one
automatic retry on a transient transport error. Write verbs NEVER retry: a
timeout on a write is ambiguous and a replay could double-post.
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
    resolve: cmdResolve,
    'delete-comment': cmdDeleteComment,
    'mark-ready': cmdMarkReady,
    'to-draft': cmdToDraft,
    'create-comment': cmdCreateComment,
    'create-pr': cmdCreatePr,
    reply: cmdReply,
    'get-ticket': cmdGetTicket,
    'get-comments': cmdGetComments,
    'post-comment': cmdPostComment,
    health: cmdHealth,
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
