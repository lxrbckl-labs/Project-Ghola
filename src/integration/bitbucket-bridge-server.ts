/**
 * Loopback HTTP bridge that lets a CLI agent (running inside the Ghola session
 * terminal) invoke host-side Atlassian operations. It serves both Bitbucket PR
 * ops (via `BitbucketPrClient`) and Jira operations — ticket details via the
 * injected `getTicket` fetcher and issue comments via `getComments`, both
 * READ-ONLY, plus exactly ONE Jira write: posting a comment via `postComment`.
 *
 * That single write is narrow on purpose. The bridge can add a comment to an
 * issue and nothing else — no issue creation, no transitions, no field edits,
 * and no editing or deleting of any existing comment. It is the plumbing for
 * the Jira Comment Write flow in `integration.atlassian-suite`, which is where
 * the actual authorization lives; agents are forbidden from Jira mutations by
 * their core hard rules unless that flow's `enableJiraCommentWrite` gate is on.
 *
 * THAT GATE IS ENFORCED HERE, NOT ONLY IN PROSE. The write is injected as a
 * RESOLVER (`PostCommentResolver`) rather than a bare function, and the resolver
 * is called on EVERY `/post-comment` request. When the gate is off it hands back
 * `undefined` and this file refuses the route outright — there is no function to
 * call, so an agent that ignores the module markdown still cannot post. Resolving
 * per request (rather than capturing a function once at activation) is what makes
 * flipping the setting off take effect immediately instead of at the next window
 * reload. The refusal is a 403 `capability-disabled` naming the setting, never a
 * bare 404 and never a silent success. Nothing about comment READING
 * (`/get-comments`) consults the gate.
 *
 * Neither product's API token ever leaves the extension host: the agent only
 * ever holds a per-session bearer token that authenticates it to THIS server,
 * and the server calls the host-side code on its behalf.
 *
 * BRIDGE COORDINATES FILE — why it exists:
 *   The server binds an EPHEMERAL port and mints a FRESH bearer token on every
 *   activation, but VS Code can only inject env into a terminal at creation
 *   time and can never mutate a live terminal's environment. So any
 *   extension-host restart (window reload, extension update, Remote-WSL
 *   reconnect, host crash) used to permanently orphan every already-running
 *   agent terminal: its snapshotted `GHOLA_BRIDGE_URL` / `GHOLA_BRIDGE_TOKEN`
 *   pointed at a port and token that no longer existed, and every subsequent
 *   bridge call failed forever with a bare `fetch failed`.
 *
 *   The fix is one level of indirection. The extension writes `{ url, token }`
 *   to a small JSON file at a path derived from the WORKSPACE (not from the
 *   random port), and rewrites it on every start. The launcher exports that
 *   PATH as `GHOLA_BRIDGE_FILE`. The path is stable across host restarts, so
 *   the terminal's snapshotted env stays valid forever and only the file's
 *   CONTENTS change. `bb-bridge.mjs` re-reads the file on every invocation.
 *
 *   The file holds the same loopback capability token the env var already
 *   carried — this RELOCATES a secret, it does not escalate one. Keep it that
 *   way: mode 0600, written outside the user's workspace folder (so it can
 *   never be committed), replaced atomically, never logged, and removed on
 *   dispose.
 *
 * TOKEN-SECRECY DISCIPLINE — read before extending:
 *   - The per-session bearer token (`token`) authenticates the agent to this
 *     bridge. It is compared with `crypto.timingSafeEqual` and is NEVER written
 *     into any HTTP response body or log line. The ONLY place it is persisted
 *     is the 0600 coordinates file described above.
 *   - The Bitbucket API token is owned entirely by `BitbucketPrClient`, and the
 *     Jira API token is owned entirely by the `getTicket` / `getComments` /
 *     `postComment` fetchers; this file never reads, receives, or forwards
 *     either token.
 *   - Raw upstream (Bitbucket / Jira) response bodies are never echoed here —
 *     only the client's / fetcher's own sanitized typed result shapes are
 *     serialized back.
 *   - The bridge binds to 127.0.0.1 only, rejects non-loopback peers with 403,
 *     and caps request bodies at 1 MB.
 *
 * Node builtins only — no npm dependencies, no `package.json` change.
 */

import * as http from 'http';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import type { BitbucketPrClient } from './bitbucket-pr-client';
import type { RequestFailure } from './atlassian-client';
import type { TerminalManager } from '../terminal/terminal-manager';
import { JIRA_COMMENT_WRITE_DISABLED_MESSAGE } from './jira-comment-write-gate';

/** Hard cap on inbound request bodies. The agent's payloads are tiny JSON
 *  objects; anything larger is treated as abuse and rejected with 413. */
const MAX_BODY_BYTES = 1024 * 1024;

/** Loopback peer addresses we accept. Everything else gets a 403 so the bridge
 *  can never be driven from off-box even if the port is somehow reachable. */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Host-side Jira ticket fetch result. Mirrors the shared bridge contract: a
 *  client-level "ticket not found" is `{ exists: false }` (still HTTP 200), and
 *  `description` is PLAIN TEXT (ADF is converted host-side, never raw JSON). */
export interface GetTicketResult {
  exists: boolean;
  status?: string;
  summary?: string;
  description?: string;
  error?: string;
}

/** Host-side Jira ticket fetcher injected by the extension. Confines the Jira
 *  token to the extension host and returns only the sanitized shape above. */
export type GetTicketFn = (key: string) => Promise<GetTicketResult>;

/** One Jira comment on the wire. `body` is PLAIN TEXT — the ADF tree is
 *  converted host-side (same rule as `GetTicketResult.description`), so the
 *  agent never sees raw ADF JSON. */
export interface BridgeIssueComment {
  author: string;
  created: string;
  body: string;
}

/** Host-side Jira comment fetch result. `exists: false` means the issue was not
 *  found; `exists: true` with an EMPTY `comments` array means the issue exists
 *  and has no comments — a success, never to be reported as "not found".
 *  `error` is set only on a real failure (including a distinct
 *  `'Jira not configured'`). */
export interface GetCommentsResult {
  exists: boolean;
  comments: BridgeIssueComment[];
  error?: string;
  /** Non-fatal note on an OTHERWISE SUCCESSFUL read — currently only
   *  truncation. Deliberately NOT `error`: a partial-but-usable comment list is
   *  a result, not a failure, and populating `error` would make every consumer
   *  that checks it treat a usable answer as a broken one. */
  message?: string;
  /** True when the host's pagination walk stopped early (page cap or time
   *  budget), so `comments` is a PREFIX of the thread rather than all of it.
   *  Same field name and meaning as `PrCommentListResult.truncated` on the
   *  Bitbucket side, so both comment reads report truncation identically. */
  truncated?: boolean;
  /** The API-reported total for the thread when one was available, so a caller
   *  can render an honest "N of ~M". Undefined when absent — never guessed. */
  totalAvailable?: number;
}

/** Host-side Jira comment fetcher injected by the extension. Same containment
 *  contract as `GetTicketFn`: the Jira token never leaves the extension host and
 *  only the sanitized shape above is serialized back. */
export type GetCommentsFn = (key: string) => Promise<GetCommentsResult>;

/** Host-side Jira comment POST result. `posted: true` means Jira accepted the
 *  comment; anything else carries an `error`. Note the deliberately ambiguous
 *  case: a timeout mid-flight reports `posted: false` with an error even though
 *  the comment MAY have landed, which is why nothing in this stack retries a
 *  post — the caller surfaces the error and the operator checks the issue. */
export interface PostCommentResult {
  posted: boolean;
  id?: string;
  error?: string;
}

/** Host-side Jira comment POSTer injected by the extension. This is the only
 *  WRITE the Jira side of this bridge exposes, and it exists to serve the Jira
 *  Comment Write flow in `integration.atlassian-suite` — that module carries
 *  the authorization, this type is only the plumbing. Same containment contract as
 *  the read fetchers: the Jira token never leaves the extension host. */
export type PostCommentFn = (key: string, body: string) => Promise<PostCommentResult>;

/**
 * Per-request supplier of the Jira comment POSTer, and the mechanism that makes
 * `integration.atlassian-suite`'s `enableJiraCommentWrite` gate REAL rather than
 * advisory.
 *
 * The extension returns the poster only while the gate is open (module enabled
 * AND the setting affirmatively `true`) and `undefined` otherwise; see
 * `jira-comment-write-gate.ts` for the decision. This file treats `undefined` as
 * "capability withheld" and refuses `/post-comment` without touching Jira.
 *
 * Called on every request on purpose: a guardrail you must reload the window to
 * apply is a guardrail people forget to apply. A resolver that THROWS is also
 * treated as withheld — unknown is never permission.
 */
export type PostCommentResolver = () => PostCommentFn | undefined;

/**
 * Refusal body sent when `/post-comment` is hit with the capability withheld.
 * `status` is its own value (not `unknown-error`) so the wrapper can print a
 * tailored, actionable refusal instead of a generic transport failure; the
 * caller supplies the operator-facing `message`.
 */
const CAPABILITY_DISABLED_STATUS = 'capability-disabled';

/** Handle returned to the caller so it can inject the env and dispose the
 *  server on extension shutdown. */
export interface BitbucketBridgeHandle {
  url: string;
  token: string;
  /**
   * Absolute path of the coordinates file, when the caller asked for one. This
   * is the value the launcher exports as `GHOLA_BRIDGE_FILE`; it is a PATH, not
   * a secret, and is safe to log. Undefined when no `coordinatesPath` was
   * supplied.
   */
  coordinatesPath?: string;
  dispose(): void;
}

/** Mode for the coordinates file: owner read/write only. Set explicitly at
 *  create time AND re-asserted with `chmod`, because `writeFileSync`'s `mode`
 *  is masked by the process umask and is ignored entirely when the file already
 *  exists (e.g. left behind by an older build that wrote it 0644). */
const COORDINATES_FILE_MODE = 0o600;

/**
 * Start the loopback bridge. Resolves to a handle carrying the bound `url` and
 * the per-session `token`, or `null` when the server fails to bind — in which
 * case the caller injects no env and the CLI-side module fails loud rather than
 * silently talking to a phantom bridge.
 *
 * The returned promise resolves only AFTER the server is actually listening, so
 * the random port (`server.address().port`) is guaranteed known by then. This
 * matters: `listen()` binds asynchronously, so reading `server.address()`
 * synchronously would return `null` and yield a bridge with no usable url.
 *
 * `coordinatesPath`, when supplied, is an absolute path OUTSIDE the user's
 * workspace folder (the caller derives it from `context.storageUri`) where the
 * live `{ url, token }` is written 0600 and rewritten on every start. See the
 * BRIDGE COORDINATES FILE note at the top of this file for why. A failure to
 * write it is logged and otherwise ignored: the bridge still runs and the
 * legacy env-var path still works, so a read-only storage dir degrades to the
 * old behavior rather than killing the bridge.
 */
export function startBitbucketBridge(
  client: BitbucketPrClient,
  getTicket: GetTicketFn,
  getComments: GetCommentsFn,
  resolvePostComment: PostCommentResolver,
  coordinatesPath?: string,
  logger?: vscode.OutputChannel,
  terminalManager?: TerminalManager,
): Promise<BitbucketBridgeHandle | null> {
  return new Promise((resolve) => {
    const token = crypto.randomBytes(32).toString('hex');
    const expectedAuth = Buffer.from(`Bearer ${token}`);

    const server = http.createServer((req, res) => {
      handleRequest(req, res, client, getTicket, getComments, resolvePostComment, expectedAuth, terminalManager).catch(() => {
        // Defensive: handleRequest already wraps its own body in try/catch, but a
        // failure before/around that (or in the catch itself) must never leak.
        sendJson(res, 500, { status: 'unknown-error', message: 'bridge error' });
      });
    });

    // Bind errors surface asynchronously via the 'error' event (a synchronous
    // try/catch around listen() would never see them). Resolve null on the
    // first error so the caller injects no bridge env.
    let settled = false;
    server.once('error', (err) => {
      if (settled) return;
      settled = true;
      logger?.appendLine(`[bb-bridge] failed to bind loopback server: ${describeError(err)}`);
      resolve(null);
    });

    // The listen callback is the 'listening' listener: by the time it fires the
    // port is bound and `server.address()` returns the real port.
    server.listen(0, '127.0.0.1', () => {
      if (settled) return;
      settled = true;
      const address = server.address();
      if (!address || typeof address === 'string') {
        logger?.appendLine('[bb-bridge] server bound but returned no port; not starting bridge');
        try {
          server.close();
        } catch {
          /* best-effort */
        }
        resolve(null);
        return;
      }

      const url = `http://127.0.0.1:${address.port}`;
      logger?.appendLine(`[bb-bridge] listening on ${url}`);

      // Rewritten on EVERY start so the file always reflects the live server.
      // The url is logged above (it is an address, not a secret); the token is
      // written to the file and nowhere else.
      if (coordinatesPath) {
        writeCoordinatesFile(coordinatesPath, url, token, logger);
      }

      resolve({
        url,
        token,
        coordinatesPath,
        dispose: () => {
          try {
            server.close();
          } catch {
            /* best-effort */
          }
          // Clean up the runtime file this function created. It is the
          // extension's own artifact, never a user file. A failed unlink must
          // not break disposal — a stale file is harmless because every start
          // rewrites it, and bb-bridge falls back to the env vars if the
          // contents no longer parse.
          if (coordinatesPath) {
            try {
              fs.unlinkSync(coordinatesPath);
            } catch {
              /* best-effort */
            }
          }
        },
      });
    });
  });
}

/**
 * Write `{ url, token }` to the coordinates file with mode 0600, creating the
 * containing directory if absent. Returns true on success.
 *
 * Written to a sibling temp file and `rename`d into place so the swap is
 * ATOMIC: an agent invoking `bb-bridge.mjs` at the exact moment the extension
 * host restarts either reads the whole old file or the whole new one, never a
 * truncated/absent one (which would silently fall back to the stale env vars —
 * precisely the bug this file exists to fix). `rename` also replaces a symlink
 * rather than following it, so a pre-existing symlink at the path cannot
 * redirect the token somewhere world-readable.
 *
 * Never logs the token — only the path and, on failure, the error message.
 */
function writeCoordinatesFile(
  filePath: string,
  url: string,
  token: string,
  logger?: vscode.OutputChannel,
): boolean {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify({ url, token }), {
      encoding: 'utf8',
      mode: COORDINATES_FILE_MODE,
    });
    // `mode` above is masked by the umask, so assert the mode explicitly.
    fs.chmodSync(tempPath, COORDINATES_FILE_MODE);
    fs.renameSync(tempPath, filePath);
    logger?.appendLine(`[bb-bridge] wrote bridge coordinates to ${filePath}`);
    return true;
  } catch (err) {
    // Best-effort cleanup of the temp file so a failed write does not leave a
    // token-bearing orphan behind.
    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* best-effort */
    }
    logger?.appendLine(`[bb-bridge] could not write bridge coordinates: ${describeError(err)}`);
    return false;
  }
}

/**
 * Core request handler. Enforces the shared bridge protocol: POST-only,
 * loopback-only, bearer-authenticated, 1 MB body cap, JSON body, route ->
 * client method. Bridge-level problems map to HTTP 4xx/5xx; client-level
 * non-ok statuses are returned verbatim inside a 200 (the client's own
 * `status` field carries ok/error). Never leaks the bearer/Bitbucket token or
 * raw upstream bodies.
 */
async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  client: BitbucketPrClient,
  getTicket: GetTicketFn,
  getComments: GetCommentsFn,
  resolvePostComment: PostCommentResolver,
  expectedAuth: Buffer,
  terminalManager?: TerminalManager,
): Promise<void> {
  try {
    // Loopback-only: reject any non-local peer before doing any work.
    const remote = req.socket.remoteAddress ?? '';
    if (!LOOPBACK_ADDRESSES.has(remote)) {
      sendJson(res, 403, { status: 'forbidden', message: 'forbidden' });
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { status: 'unknown-error', message: 'method not allowed' });
      return;
    }

    // Bearer auth via constant-time compare. Length-guard first so
    // `timingSafeEqual` never throws on a mismatched-length buffer.
    const provided = Buffer.from(req.headers['authorization'] ?? '');
    if (provided.length !== expectedAuth.length || !crypto.timingSafeEqual(provided, expectedAuth)) {
      // The bearer token is compared via `expectedAuth` only; it is never
      // logged or echoed on this or any other path.
      sendJson(res, 401, { status: 'unauthorized', message: 'unauthorized' });
      return;
    }

    const body = await readBody(req);
    if (body === null) {
      sendJson(res, 413, { status: 'unknown-error', message: 'payload too large' });
      return;
    }

    let parsed: unknown;
    try {
      parsed = body.length === 0 ? {} : JSON.parse(body);
    } catch {
      sendJson(res, 400, { status: 'unknown-error', message: 'invalid JSON body' });
      return;
    }
    const args = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;

    const route = (req.url ?? '').split('?')[0];

    // Jira ticket read is handled here (not in `dispatch`) because it needs its
    // own 400-on-bad-key path: a missing / non-string / empty `key` is a
    // caller error, distinct from a valid key whose ticket simply does not
    // exist (which the fetcher returns as a 200 `{ exists: false }`).
    if (route === '/get-ticket') {
      const key = typeof args.key === 'string' ? args.key.trim() : '';
      if (!key) {
        sendJson(res, 400, { status: 'unknown-error', message: 'key must be a non-empty string' });
        return;
      }
      // The fetcher owns the Jira token and returns only a sanitized shape; we
      // never log the key's upstream response body or any token here.
      const ticket = await getTicket(key);
      sendJson(res, 200, ticket);
      return;
    }

    // Jira comment read. Handled here for the same reason as `/get-ticket`: a
    // missing / non-string / empty `key` is a caller error (400), distinct from
    // a valid key whose issue does not exist (200 `{ exists: false }`) and
    // distinct again from an issue that exists with zero comments (200
    // `{ exists: true, comments: [] }`) — which is a SUCCESS, not an absence.
    if (route === '/get-comments') {
      const key = typeof args.key === 'string' ? args.key.trim() : '';
      if (!key) {
        sendJson(res, 400, { status: 'unknown-error', message: 'key must be a non-empty string' });
        return;
      }
      // The fetcher owns the Jira token and returns only a sanitized shape (ADF
      // already flattened to text); no token or raw upstream body is logged here.
      const comments = await getComments(key);
      sendJson(res, 200, comments);
      return;
    }

    // Jira comment POST — the single Jira WRITE this bridge serves, and the
    // plumbing behind the Jira Comment Write flow in
    // `integration.atlassian-suite`. Reaching this route is not by itself
    // authorization: that flow is what authorizes an agent to invoke it, and an
    // operator who has not turned on its `enableJiraCommentWrite` setting does
    // not merely lack a workflow that calls the wrapper verb — the capability is
    // WITHHELD below, so the verb cannot work at all.
    //
    // THE GATE IS CHECKED FIRST, ahead of argument validation, so a withheld
    // capability refuses identically for a well-formed and a malformed call and
    // no work happens before the refusal. `resolvePostComment` runs per request:
    // toggling the setting off takes effect on the very next call, no reload.
    // Both `undefined` and a THROWING resolver mean withheld — the enabled path
    // requires a resolver that affirmatively hands back a function.
    //
    // Two distinct caller errors, both 400 because both mean "you sent me
    // something unusable" rather than "Jira said no":
    //   - missing / non-string / empty `key`
    //   - missing / non-string / empty-or-whitespace-only `body` — posting a
    //     blank comment to a ticket other people read is never the intent, so
    //     it is refused here rather than forwarded.
    // A well-formed request that Jira rejects is a 200 with `posted: false`
    // plus an `error`, keeping "bad call" and "call failed" separable.
    if (route === '/post-comment') {
      let postComment: PostCommentFn | undefined;
      try {
        postComment = resolvePostComment();
      } catch {
        // A resolver that blew up tells us nothing about the operator's intent,
        // and "we could not tell" must never read as "go ahead".
        postComment = undefined;
      }
      if (typeof postComment !== 'function') {
        sendJson(res, 403, {
          status: CAPABILITY_DISABLED_STATUS,
          message: JIRA_COMMENT_WRITE_DISABLED_MESSAGE,
        });
        return;
      }
      const key = typeof args.key === 'string' ? args.key.trim() : '';
      if (!key) {
        sendJson(res, 400, { status: 'unknown-error', message: 'key must be a non-empty string' });
        return;
      }
      const body = typeof args.body === 'string' ? args.body : '';
      if (body.trim() === '') {
        sendJson(res, 400, { status: 'unknown-error', message: 'body must be a non-empty string' });
        return;
      }
      // The poster owns the Jira token and returns only a sanitized shape. The
      // comment body is NOT logged here: it is operator-approved content, but
      // this file's contract is that request payloads never reach a log line.
      const posted = await postComment(key, body);
      sendJson(res, 200, posted);
      return;
    }

    // Workspace member search. The client defaults `workspace` to the
    // configured `bitbucketWorkspace` setting when the caller omits it.
    if (route === '/workspace-members') {
      const workspace = typeof args.workspace === 'string' ? args.workspace : '';
      const query = typeof args.query === 'string' ? args.query : undefined;
      const result = await client.searchWorkspaceMembers({ workspace, query });
      sendJson(res, 200, result);
      return;
    }

    // ── Terminal routes ────────────────────────────────────────────────
    // Handled here (not in `dispatch`) because they need the optional
    // `terminalManager` injected at bridge start. When the manager is
    // absent (`tool.terminal` not loaded), every terminal route returns
    // 404 so the agent gets an explicit signal rather than a bare
    // `not found` from the catch-all at the bottom.

    if (route === '/terminal/create') {
      if (!terminalManager) {
        sendJson(res, 404, { error: 'Terminal dispatch not available' });
        return;
      }
      try {
        const result = await terminalManager.create(args as {
          name: string;
          shell?: string;
          cwd?: string;
          env?: Record<string, string>;
        });
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : 'terminal create failed' });
      }
      return;
    }

    if (route === '/terminal/exec') {
      if (!terminalManager) {
        sendJson(res, 404, { error: 'Terminal dispatch not available' });
        return;
      }
      try {
        const result = await terminalManager.exec(args as {
          terminalId: string;
          command: string;
          waitForHuman?: boolean;
          timeoutMs?: number;
        });
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : 'terminal exec failed' });
      }
      return;
    }

    if (route === '/terminal/list') {
      if (!terminalManager) {
        sendJson(res, 404, { error: 'Terminal dispatch not available' });
        return;
      }
      try {
        const terminals = terminalManager.list();
        sendJson(res, 200, { terminals });
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : 'terminal list failed' });
      }
      return;
    }

    if (route === '/terminal/dispose') {
      if (!terminalManager) {
        sendJson(res, 404, { error: 'Terminal dispatch not available' });
        return;
      }
      try {
        const terminalId = typeof args.terminalId === 'string' ? args.terminalId : '';
        const result = terminalManager.disposeTerminal(terminalId);
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : 'terminal dispose failed' });
      }
      return;
    }

    if (route === '/terminal/signal') {
      if (!terminalManager) {
        sendJson(res, 404, { error: 'Terminal dispatch not available' });
        return;
      }
      try {
        const terminalId = typeof args.terminalId === 'string' ? args.terminalId : '';
        const result = terminalManager.signal(terminalId);
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : 'terminal signal failed' });
      }
      return;
    }

    const result = await dispatch(route, args, client);
    if (result === undefined) {
      sendJson(res, 404, { status: 'unknown-error', message: 'not found' });
      return;
    }
    sendJson(res, 200, result);
  } catch {
    // Internal handler failure: never leak the underlying error text.
    sendJson(res, 500, { status: 'unknown-error', message: 'bridge error' });
  }
}

/**
 * Route table. Returns the client's typed result for a known route, or
 * `undefined` for an unknown route (caller emits 404). Coerces the loosely
 * typed JSON args into the shapes each client method expects; the client
 * itself validates and returns a typed `not-found` shape for bad values.
 */
async function dispatch(
  route: string,
  args: Record<string, unknown>,
  client: BitbucketPrClient,
): Promise<unknown> {
  switch (route) {
    case '/health':
      // Pure liveness probe. Reached only AFTER the bearer check in
      // `handleRequest`, so it is NOT an unauthenticated endpoint — but it
      // deliberately touches NEITHER Atlassian product: it answers "is this
      // bridge process alive and is my token still the right one?" without
      // spending a Jira/Bitbucket API call or requiring any credential to be
      // configured. That separation is the point: before this route existed,
      // the only way to test liveness was to make a real API call, so "bridge
      // is dead" and "Atlassian rejected us" were indistinguishable.
      return { status: 'ok' };
    case '/find-pr': {
      // `findOpenPrForBranch` returns `PrLookupResult` (`{ prUrl, prTitle?,
      // prId?, prState?, failure? }`) with NO `status` field — a successful
      // lookup and a "no PR" both come back shapeless from the wrapper's
      // perspective. The bb-bridge.mjs client judges success by
      // `status === 'ok'`, so we tag the response here to fit that taxonomy
      // (matching list-comments / reply / resolve / mark-ready) rather than
      // making the client special-case this route. A finite `prId` is the
      // found-a-PR signal the downstream pr-monitor / comment / mark-ready flows
      // depend on. The `...lookup` spread carries `prState` through verbatim, so
      // a caller sees "found a MERGED PR #123" (prState: 'MERGED') distinctly
      // from "no PR at all" (the not-found below) — a found-but-closed PR is
      // NEVER collapsed into not-found.
      const branch = str(args.branch);
      const lookup = await client.findOpenPrForBranch(str(args.repoSlug), branch);
      if (typeof lookup.prId === 'number' && Number.isFinite(lookup.prId)) {
        return { status: 'ok', ...lookup };
      }
      // A real request failure (expired token, missing scope, wrong workspace /
      // repo slug, rate limit, network) must surface its TRUE cause — never get
      // flattened into the "no open PR" not-found below, which would send the
      // user chasing a nonexistent PR instead of the real auth/lookup problem.
      if (lookup.failure) {
        return { status: findPrFailureStatus(lookup.failure), message: lookup.failure.message };
      }
      return { status: 'not-found', message: `No open PR for branch ${branch}` };
    }
    case '/list-comments':
      return client.listPullRequestComments(str(args.repoSlug), num(args.prId));
    case '/reply':
      return client.replyToComment({
        repoSlug: str(args.repoSlug),
        prId: num(args.prId),
        parentId: num(args.parentId),
        body: str(args.body),
        inline: parseInline(args.inline),
      });
    case '/resolve':
      return client.resolveComment({
        repoSlug: str(args.repoSlug),
        prId: num(args.prId),
        commentId: num(args.commentId),
      });
    case '/create-comment':
      // Standalone, top-level comment: deliberately passes NO `parentId` and no
      // `inline` anchor (unlike `/reply` above) — either one would thread or
      // anchor the comment instead of posting it at the top level.
      return client.createComment({
        repoSlug: str(args.repoSlug),
        prId: num(args.prId),
        body: str(args.body),
      });
    case '/delete-comment':
      return client.deleteComment({
        repoSlug: str(args.repoSlug),
        prId: num(args.prId),
        commentId: num(args.commentId),
      });
    case '/mark-ready':
      return client.markPrReady({
        repoSlug: str(args.repoSlug),
        prId: num(args.prId),
      });
    case '/to-draft':
      return client.markPrDraft({
        repoSlug: str(args.repoSlug),
        prId: num(args.prId),
      });
    case '/create-pr':
      return client.createPullRequest({
        repoSlug: str(args.repoSlug),
        title: str(args.title),
        sourceBranch: str(args.sourceBranch),
        targetBranch: str(args.targetBranch),
        description: str(args.description),
        draft: bool(args.draft),
      });
    default:
      return undefined;
  }
}

/** Map a PR-lookup `RequestFailure` onto the bridge's wire-status vocabulary so
 *  the CLI client (and a human reading the JSON) sees the true cause instead of
 *  a blanket `not-found`. Mirrors the `BitbucketPrStatus` keywords the other
 *  routes already emit, adding `rate-limited` for a 429. The `message` carried
 *  alongside is the client's own sanitized text — never a token or header. */
function findPrFailureStatus(failure: RequestFailure): string {
  switch (failure.kind) {
    case 'auth':
      return failure.httpStatus === 403 ? 'forbidden' : 'unauthorized';
    case 'ratelimit':
      return 'rate-limited';
    case 'network':
      return 'network-error';
    default:
      return 'unknown-error';
  }
}

/** Coerce an unknown JSON value to a string, defaulting to '' so the client's
 *  own non-empty validation fires rather than a type error here. */
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Coerce an unknown JSON value to a number, defaulting to NaN so the client's
 *  own `Number.isFinite` validation fires. */
function num(v: unknown): number {
  return typeof v === 'number' ? v : NaN;
}

/** Coerce an unknown JSON value to a boolean, defaulting to false so an absent
 *  or non-boolean `draft` flag lands as a non-draft create. */
function bool(v: unknown): boolean {
  return v === true;
}

/** Parse the optional inline anchor for a reply. Returns undefined unless a
 *  well-formed `{ path, to, from? }` object is present. */
function parseInline(v: unknown): { path: string; to: number; from?: number } | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const obj = v as Record<string, unknown>;
  if (typeof obj.path !== 'string' || typeof obj.to !== 'number') return undefined;
  const inline: { path: string; to: number; from?: number } = { path: obj.path, to: obj.to };
  if (typeof obj.from === 'number') inline.from = obj.from;
  return inline;
}

/**
 * Read the request body with a hard 1 MB cap. Resolves to the decoded string,
 * or `null` when the cap is exceeded (caller emits 413). Destroys the socket
 * on overflow so a hostile client cannot keep streaming.
 */
function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overflowed = false;
    req.on('data', (chunk: Buffer) => {
      if (overflowed) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        overflowed = true;
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!overflowed) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => {
      if (!overflowed) resolve(null);
    });
  });
}

/** Serialize a JSON result with a fixed status code. Swallows write errors so a
 *  client that hung up mid-response cannot surface an unhandled throw. */
function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  try {
    if (res.headersSent) return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  } catch {
    /* best-effort — the socket may already be gone */
  }
}

/** Best-effort, non-sensitive description of a bind error for the log. */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
