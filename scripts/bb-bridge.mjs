#!/usr/bin/env node
//
// bb-bridge.mjs — CLI-agent -> host bridge client for Bitbucket (Project-Ghola).
//
// The extension host runs a loopback-only HTTP server (the "bridge") so a
// CLI agent can drive Bitbucket PR actions (find a PR, list/resolve/reply to
// comments, mark ready) without ever holding Bitbucket credentials itself.
// This script is that client: it reads the bridge's address + bearer token
// from the environment, POSTs one JSON request, and prints the JSON result.
//
// SECURITY: GHOLA_BRIDGE_TOKEN is read from process.env ONLY. It is NEVER
// accepted as a CLI flag (flags land in shell history / process listings),
// NEVER printed (not in output, not in error messages, not in logs), and
// NEVER written anywhere by this script. The same applies to
// GHOLA_BRIDGE_URL's role as a capability address — only the Authorization
// header carries the token, once, per request.
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
//
// Exit codes:
//   0  bridge call succeeded (parsed result's status === 'ok'; for
//      get-ticket, parsed result's exists === true)
//   1  bridge call reached the server but failed (non-2xx HTTP, or a parsed
//      result whose status !== 'ok'; for get-ticket, exists !== true)
//   2  usage error: env not set, unknown subcommand, or a bad/missing
//      required argument — nothing was sent to the bridge
//
// Pure ESM, Node builtins + global fetch only (Node 20+) — no npm deps, so
// this ships as-is inside the VSIX with no install step.

import process from 'node:process';

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

// Fails loud + fast (exit 2) if the bridge isn't wired up — the common case
// being "this isn't running inside a Ghola session at all". Never logs the
// values, only whether they're present.
function ensureBridgeEnv() {
  const url = process.env.GHOLA_BRIDGE_URL;
  const token = process.env.GHOLA_BRIDGE_TOKEN;
  if (!url || !token) {
    console.error('bb-bridge: bridge unavailable (GHOLA_BRIDGE_URL/GHOLA_BRIDGE_TOKEN not set) — is this a Ghola session?');
    process.exit(2);
  }
  return { url, token };
}

function printJson(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

// POSTs `body` to `${GHOLA_BRIDGE_URL}${routePath}` with the bearer token and
// returns the parsed JSON response. Never returns on a bridge-level failure
// (network error, or non-2xx HTTP) — those print + exit(1) directly per the
// contract documented at the top of this file. Shared by postToBridge and
// postToBridgeExists, which differ only in how they judge "success" once a
// response body is in hand.
async function callBridge(routePath, body) {
  const { url, token } = ensureBridgeEnv();

  let res;
  try {
    res = await fetch(`${url}${routePath}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Network-level failure (bridge not listening, connection reset, ...) —
    // never printed alongside the token; err.message from fetch/undici does
    // not include request headers.
    console.error(`bb-bridge: request to ${routePath} failed: ${err && err.message ? err.message : err}`);
    process.exit(1);
  }

  const text = await res.text();
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

// ─────────────────────────────────────────────────────────────────────────
// Subcommands
// ─────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────

const HELP = `bb-bridge — CLI-agent bridge client for Bitbucket PR actions.

Reads GHOLA_BRIDGE_URL / GHOLA_BRIDGE_TOKEN from the environment (never as
flags) and POSTs one JSON request to the extension host's loopback bridge.

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

Exit codes: 0 ok, 1 bridge-level failure, 2 usage error (env/args).
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
