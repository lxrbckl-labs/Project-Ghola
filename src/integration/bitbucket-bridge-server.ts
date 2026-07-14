/**
 * Loopback HTTP bridge that lets a CLI agent (running inside the Ghola session
 * terminal) invoke host-side Atlassian operations. It serves both Bitbucket PR
 * ops (via `BitbucketPrClient`) and Jira ticket reads (via the injected
 * `getTicket` fetcher). Neither product's API token ever leaves the extension
 * host: the agent only ever holds a per-session bearer token that authenticates
 * it to THIS server, and the server calls the host-side code on its behalf.
 *
 * TOKEN-SECRECY DISCIPLINE — read before extending:
 *   - The per-session bearer token (`token`) authenticates the agent to this
 *     bridge. It is compared with `crypto.timingSafeEqual` and is NEVER written
 *     into any HTTP response body or log line.
 *   - The Bitbucket API token is owned entirely by `BitbucketPrClient`, and the
 *     Jira API token is owned entirely by the `getTicket` fetcher; this file
 *     never reads, receives, or forwards either token.
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
import type * as vscode from 'vscode';
import type { BitbucketPrClient } from './bitbucket-pr-client';

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

/** Handle returned to the caller so it can inject the env and dispose the
 *  server on extension shutdown. */
export interface BitbucketBridgeHandle {
  url: string;
  token: string;
  dispose(): void;
}

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
 */
export function startBitbucketBridge(
  client: BitbucketPrClient,
  getTicket: GetTicketFn,
  logger?: vscode.OutputChannel,
): Promise<BitbucketBridgeHandle | null> {
  return new Promise((resolve) => {
    const token = crypto.randomBytes(32).toString('hex');
    const expectedAuth = Buffer.from(`Bearer ${token}`);

    const server = http.createServer((req, res) => {
      handleRequest(req, res, client, getTicket, expectedAuth).catch(() => {
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

      resolve({
        url,
        token,
        dispose: () => {
          try {
            server.close();
          } catch {
            /* best-effort */
          }
        },
      });
    });
  });
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
  expectedAuth: Buffer,
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
    case '/find-pr':
      return client.findOpenPrForBranch(str(args.repoSlug), str(args.branch));
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
    case '/mark-ready':
      return client.markPrReady({
        repoSlug: str(args.repoSlug),
        prId: num(args.prId),
      });
    default:
      return undefined;
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
