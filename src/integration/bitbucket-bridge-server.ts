/**
 * Loopback HTTP bridge that lets a CLI agent (running inside the Ghola session
 * terminal) invoke host-side Atlassian operations. It serves both Bitbucket PR
 * ops (via `BitbucketPrClient`) and Jira operations — ticket details via the
 * injected `getTicket` fetcher, issue comments via `getComments`, and an issue's
 * available workflow transitions via `getTransitions`, all three READ-ONLY, plus
 * exactly TWO Jira writes: posting a comment via `postComment` and moving an
 * issue along its workflow via `transitionIssue`.
 *
 * Those two writes are narrow on purpose, and they are the ONLY ones. The bridge
 * can add a comment to an issue and execute a transition id the caller supplies —
 * nothing else. No issue creation, no field edits, no assignment, and no editing
 * or deleting of any existing comment. Each write is the plumbing for a flow in
 * `integration.atlassian-suite`, which is where the actual authorization lives;
 * agents are forbidden from Jira mutations by their core hard rules unless the
 * matching flow's gate — `enableJiraCommentWrite` or `enableJiraTransition` — is
 * on.
 *
 * It ALSO serves two routes that touch NEITHER Atlassian product: reading the
 * operator's module settings (`/get-module-settings`, ungated — a read changes
 * nothing and it is what lets a caller echo the current value back before
 * proposing a change) and changing ONE scalar module setting
 * (`/set-module-setting`). That write is local to this extension's own
 * configuration and is gated exactly like the Jira writes below, through its own
 * separate setting (`tool.conversational-settings`'s `enableSettingsWrite`) and
 * its own gate file — plus a hardcoded refusal of any write targeting that
 * module itself, and an outright bar while an autonomous session mode is
 * running. See `settings-write-gate.ts`. `keyValue` table settings are OUT OF
 * SCOPE for now and are refused.
 *
 * NOTHING HERE CHOOSES A TRANSITION. `/transition` executes the `transitionId`
 * it is given and never derives one: no name matching, no closest-match
 * fallback, no defaulting to the first available. Reading the options
 * (`/get-transitions`) and picking one are separate steps on purpose, so the
 * choice is made where a human can see it.
 *
 * THOSE GATES ARE ENFORCED HERE, NOT ONLY IN PROSE. Each write is injected as a
 * RESOLVER (`PostCommentResolver` / `TransitionResolver`) rather than a bare
 * function, and the resolver is called on EVERY request to its route. When the
 * gate is off it hands back `undefined` and this file refuses the route outright
 * — there is no function to call, so an agent that ignores the module markdown
 * still cannot write. Resolving per request (rather than capturing a function
 * once at activation) is what makes flipping the setting off take effect
 * immediately instead of at the next window reload. The refusal is a 403
 * `capability-disabled` naming the setting, never a bare 404 and never a silent
 * success. The two gates are INDEPENDENT: neither route consults the other's
 * setting, and no read (`/get-comments`, `/get-transitions`) consults either.
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
 *     `getTransitions` / `postComment` / `transitionIssue` fetchers; this file
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
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import type { BitbucketPrClient } from './bitbucket-pr-client';
import type { RequestFailure } from './atlassian-client';
import type { TerminalManager } from '../terminal/terminal-manager';
import { JIRA_COMMENT_WRITE_DISABLED_MESSAGE } from './jira-comment-write-gate';
import { JIRA_TRANSITION_DISABLED_MESSAGE } from './jira-transition-gate';
import {
  SETTINGS_WRITE_AUTONOMOUS_MODE_MESSAGE,
  SETTINGS_WRITE_DISABLED_MESSAGE,
} from './settings-write-gate';

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

/** Host-side Jira comment POSTer injected by the extension. One of the two
 *  WRITES the Jira side of this bridge exposes, and it exists to serve the Jira
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

/** ONE transition Jira currently offers on an issue, on the wire. Mirrors
 *  `IssueTransition` in `atlassian-client.ts` field for field — `id` is what
 *  `/transition` takes, `name` is the transition's own label, and `toStatus` is
 *  the status it lands in. They stay separate here for the same reason they do
 *  there: a caller matching a target STATUS against a transition NAME presses the
 *  wrong button. */
export interface BridgeIssueTransition {
  id: string;
  name: string;
  toStatus: string;
  /** Jira's `hasScreen`, when it reported one. Never guessed. */
  hasScreen?: boolean;
  /** Names of fields the transition screen marks REQUIRED. Present only when
   *  there is at least one, so its presence means "this transition cannot be
   *  executed by a bare id POST" — which is the fact a caller needs BEFORE
   *  asking an operator to approve the move, not after a 400. */
  requiredFields?: string[];
}

/** Host-side Jira transition LIST result. `exists: false` means the issue was
 *  not found; `exists: true` with an EMPTY `transitions` array means the issue
 *  exists and currently offers no transitions to this account — a success, never
 *  to be reported as "not found". `error` is set only on a real failure
 *  (including a distinct `'Jira not configured'`). Same three-way contract as
 *  `GetCommentsResult`. */
export interface GetTransitionsResult {
  exists: boolean;
  transitions: BridgeIssueTransition[];
  error?: string;
}

/** Host-side Jira transition-list fetcher injected by the extension. A READ:
 *  same containment contract as `GetTicketFn` — the Jira token never leaves the
 *  extension host and only the sanitized shape above is serialized back. */
export type GetTransitionsFn = (key: string) => Promise<GetTransitionsResult>;

/** Host-side Jira transition result. `transitioned: true` means JIRA ACCEPTED
 *  THE REQUEST (it answers a successful transition with 204 and no body) — it is
 *  NOT a re-read of the issue and NOT a claim about the issue's current status,
 *  which a workflow post-function can change again the instant the transition
 *  lands. The shape therefore reports what was REQUESTED (`transitionId`) and
 *  carries no status field at all.
 *
 *  Note the deliberately ambiguous case, identical to `PostCommentResult`: a
 *  timeout mid-flight reports `transitioned: false` with an error even though the
 *  transition MAY have been applied, which is why nothing in this stack retries
 *  it — the caller surfaces the error and the operator checks the issue. */
export interface TransitionResult {
  transitioned: boolean;
  transitionId?: string;
  error?: string;
}

/** Host-side Jira transition executor injected by the extension. The SECOND and
 *  last write the Jira side of this bridge exposes, serving the transition flow
 *  in `integration.atlassian-suite` — that module carries the authorization, this
 *  type is only the plumbing. It EXECUTES the `transitionId` it is handed and
 *  never derives one. Same containment contract as the read fetchers. */
export type TransitionIssueFn = (key: string, transitionId: string) => Promise<TransitionResult>;

/**
 * Per-request supplier of the Jira transition executor, and the mechanism that
 * makes `integration.atlassian-suite`'s `enableJiraTransition` gate REAL rather
 * than advisory. Exactly the `PostCommentResolver` contract, applied to the
 * other capability — and deliberately a SEPARATE resolver reading a SEPARATE
 * setting, so neither gate can be opened by the other.
 *
 * The extension returns the executor only while the gate is open (module enabled
 * AND the setting affirmatively `true`) and `undefined` otherwise; see
 * `jira-transition-gate.ts` for the decision. This file treats `undefined` as
 * "capability withheld" and refuses `/transition` without touching Jira.
 *
 * Called on every request on purpose: a guardrail you must reload the window to
 * apply is a guardrail people forget to apply. A resolver that THROWS is also
 * treated as withheld — unknown is never permission.
 */
export type TransitionResolver = () => TransitionIssueFn | undefined;

/** One conversational module-setting write on the wire. */
export interface BridgeSettingWriteRequest {
  moduleId: string;
  fieldKey: string;
  /** Arrives as a STRING from the CLI; the host narrows it against the field's declared type. */
  value: unknown;
}

/**
 * Host-side result of a module-setting write. `status` mirrors the applier's own
 * three-way outcome so the wrapper can say the right thing:
 *   - `ok`        — persisted. `oldValue` / `newValue` are both populated.
 *   - `refused`   — the request was not acceptable (undeclared key, a table
 *                   setting, a value that failed validation, or a target on the
 *                   self-reference denylist). Retrying it unchanged cannot help.
 *   - `cancelled` — a `securitySensitive` field whose modal the operator
 *                   declined. Valid request, answered "no"; asking again is
 *                   legitimate.
 * `effect` carries the SPLIT-TIMING answer (see `state/module-settings.ts`):
 * `immediate` for a setting the host reads per request, `next-session` for one
 * an agent reads out of its composed manifest.
 */
export interface BridgeSettingWriteResult {
  status: 'ok' | 'refused' | 'cancelled';
  settingKey?: string;
  label?: string;
  oldValue?: unknown;
  newValue?: unknown;
  sensitive?: boolean;
  effect?: 'immediate' | 'next-session';
  message?: string;
}

/**
 * Host-side module-setting applier injected by the extension. It owns the schema
 * validation, the modal confirmation for a `securitySensitive` field, the write,
 * and the panel refresh; this file only carries the request and the result.
 */
export type ApplySettingWriteFn = (
  req: BridgeSettingWriteRequest,
) => Promise<BridgeSettingWriteResult>;

/**
 * WHY the settings-write capability was withheld. Unlike the two Jira gates,
 * this capability has TWO independent shut states with OPPOSITE remedies, so a
 * bare `undefined` cannot carry the answer:
 *   - `gate-off`        — `enableSettingsWrite` is not on (or the module is not
 *                         enabled). The operator has to go and tick a box.
 *   - `autonomous-mode` — the gate is ON and an autonomous session mode refused
 *                         anyway. Sending that operator to the box would send
 *                         them to a box that is already ticked.
 * See the two message constants in `settings-write-gate.ts`, whose header
 * requires the texts stay distinct.
 */
export type SettingsWriteWithheldReason = 'gate-off' | 'autonomous-mode';

/** The resolver's discriminated "no", carrying the reason above. */
export interface SettingsWriteWithheld {
  withheld: SettingsWriteWithheldReason;
}

/**
 * Per-request supplier of the module-setting applier, and the mechanism that
 * makes `tool.conversational-settings`'s `enableSettingsWrite` gate REAL rather
 * than advisory. The `PostCommentResolver` / `TransitionResolver` contract
 * applied to the third capability — and deliberately a SEPARATE resolver reading
 * a SEPARATE setting, so no gate can be opened by another.
 *
 * The extension returns the applier only while the gate is open (module enabled,
 * the setting affirmatively `true`, and no autonomous session mode running), and
 * a `SettingsWriteWithheld` naming the reason otherwise; see
 * `settings-write-gate.ts` for the decision.
 *
 * FAIL CLOSED: this file treats ANYTHING that is not a function as "capability
 * withheld" and refuses `/set-module-setting` without touching any setting. The
 * reason only chooses which refusal TEXT is sent — an unrecognized, absent, or
 * thrown answer is `gate-off`, never permission.
 *
 * Called on every request on purpose: a guardrail you must reload the window to
 * apply is a guardrail people forget to apply. A resolver that THROWS is also
 * treated as withheld — unknown is never permission.
 */
export type SettingsWriteResolver = () =>
  ApplySettingWriteFn | SettingsWriteWithheld | undefined;

/**
 * Host-side module-settings READER injected by the extension. Ungated on
 * purpose: reading changes nothing, it is how a caller echoes the current value
 * back to the operator before proposing a change, and withholding it would only
 * leave someone with the write gate off unable to see what the write would even
 * do. Returns the same shape for every module or for one named module.
 */
export type ReadModuleSettingsFn = (moduleId?: string) => unknown[];

/**
 * Refusal body sent when a gated write route (`/post-comment`, `/transition`,
 * `/set-module-setting`) is hit with the capability withheld. `status` is its own
 * value (not `unknown-error`) so the wrapper can print a tailored, actionable
 * refusal instead of a generic transport failure; each route supplies its own
 * operator-facing `message` naming the setting that is off.
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
  getTransitions: GetTransitionsFn,
  resolveTransition: TransitionResolver,
  resolveSettingsWrite: SettingsWriteResolver,
  readModuleSettingsForBridge: ReadModuleSettingsFn,
  coordinatesPath?: string,
  logger?: vscode.OutputChannel,
  terminalManager?: TerminalManager,
): Promise<BitbucketBridgeHandle | null> {
  return new Promise((resolve) => {
    const token = crypto.randomBytes(32).toString('hex');
    const expectedAuth = Buffer.from(`Bearer ${token}`);

    const server = http.createServer((req, res) => {
      handleRequest(
        req,
        res,
        client,
        getTicket,
        getComments,
        resolvePostComment,
        getTransitions,
        resolveTransition,
        resolveSettingsWrite,
        readModuleSettingsForBridge,
        expectedAuth,
        terminalManager,
      ).catch(() => {
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
  getTransitions: GetTransitionsFn,
  resolveTransition: TransitionResolver,
  resolveSettingsWrite: SettingsWriteResolver,
  readModuleSettingsForBridge: ReadModuleSettingsFn,
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

    // Jira TRANSITION LIST read. Handled here for the same reason as
    // `/get-ticket`: a missing / non-string / empty `key` is a caller error
    // (400), distinct from a valid key whose issue does not exist (200
    // `{ exists: false }`) and distinct again from an issue that exists and
    // currently offers zero transitions (200 `{ exists: true, transitions: [] }`)
    // — which is a SUCCESS, not an absence.
    //
    // This is a READ and it consults NO gate. Seeing which transitions exist
    // changes nothing in Jira, and gating it would only mean an operator with the
    // write gate off cannot even find out what the write would do.
    if (route === '/get-transitions') {
      const key = typeof args.key === 'string' ? args.key.trim() : '';
      if (!key) {
        sendJson(res, 400, { status: 'unknown-error', message: 'key must be a non-empty string' });
        return;
      }
      // The fetcher owns the Jira token and returns only a sanitized shape; we
      // never log the key's upstream response body or any token here.
      const transitions = await getTransitions(key);
      sendJson(res, 200, transitions);
      return;
    }

    // Jira TRANSITION — the second and last Jira WRITE this bridge serves, and
    // the plumbing behind the transition flow in `integration.atlassian-suite`.
    // Reaching this route is not by itself authorization: that flow is what
    // authorizes an agent to invoke it, and an operator who has not turned on its
    // `enableJiraTransition` setting does not merely lack a workflow that calls
    // the wrapper verb — the capability is WITHHELD below, so the verb cannot
    // work at all.
    //
    // THE GATE IS CHECKED FIRST, ahead of argument validation, so a withheld
    // capability refuses identically for a well-formed and a malformed call and
    // no work happens before the refusal. `resolveTransition` runs per request:
    // toggling the setting off takes effect on the very next call, no reload.
    // Both `undefined` and a THROWING resolver mean withheld — the enabled path
    // requires a resolver that affirmatively hands back a function. It reads its
    // OWN setting: `enableJiraCommentWrite` does not open this door.
    //
    // Two distinct caller errors, both 400 because both mean "you sent me
    // something unusable" rather than "Jira said no":
    //   - missing / non-string / empty `key`
    //   - missing / non-string / empty `transitionId`. The id is REQUIRED and is
    //     never derived here: this route does not match on a target status name,
    //     does not fall back to a closest match, and does not default to the
    //     first available transition. The caller reads `/get-transitions` and
    //     names one, so the choice is visible where it is made.
    // A well-formed request that Jira rejects (an id it does not currently offer,
    // a screen with mandatory fields, a missing issue) is a 200 with
    // `transitioned: false` plus an `error`, keeping "bad call" and "call failed"
    // separable.
    if (route === '/transition') {
      let transitionIssue: TransitionIssueFn | undefined;
      try {
        transitionIssue = resolveTransition();
      } catch {
        // A resolver that blew up tells us nothing about the operator's intent,
        // and "we could not tell" must never read as "go ahead".
        transitionIssue = undefined;
      }
      if (typeof transitionIssue !== 'function') {
        sendJson(res, 403, {
          status: CAPABILITY_DISABLED_STATUS,
          message: JIRA_TRANSITION_DISABLED_MESSAGE,
        });
        return;
      }
      const key = typeof args.key === 'string' ? args.key.trim() : '';
      if (!key) {
        sendJson(res, 400, { status: 'unknown-error', message: 'key must be a non-empty string' });
        return;
      }
      const transitionId = typeof args.transitionId === 'string' ? args.transitionId.trim() : '';
      if (!transitionId) {
        sendJson(res, 400, {
          status: 'unknown-error',
          message: 'transitionId must be a non-empty string (read it from get-transitions)',
        });
        return;
      }
      // The executor owns the Jira token and returns only a sanitized shape. The
      // result describes what was REQUESTED, never what the issue's status now
      // is — a 204 from Jira is acceptance, not a status read.
      const moved = await transitionIssue(key, transitionId);
      sendJson(res, 200, moved);
      return;
    }

    // Jira comment POST — one of the two Jira WRITES this bridge serves, and the
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

    // MODULE-SETTINGS READ. Ungated, and deliberately so — for the same reason
    // `/get-transitions` is: seeing what a setting currently IS changes nothing,
    // and withholding it would only leave an operator with the write gate off
    // unable to find out what a write would even do. It is also what makes the
    // echo-the-old-value confirmation possible ("Database Access allowlist is
    // currently X — change it to Y?") BEFORE a write is proposed.
    //
    // `moduleId` is OPTIONAL: absent means every discovered module. An unknown
    // module id is not an error — it yields an empty list, which is the honest
    // answer and keeps "no such module" from looking like a bridge failure.
    //
    // The reader summarizes `keyValue` tables to a row count rather than dumping
    // them; see `summarizeModuleSettings`.
    if (route === '/get-module-settings') {
      const moduleId = typeof args.moduleId === 'string' ? args.moduleId.trim() : '';
      const settings = readModuleSettingsForBridge(moduleId === '' ? undefined : moduleId);
      sendJson(res, 200, { status: 'ok', settings });
      return;
    }

    // MODULE-SETTINGS WRITE — the only write in this bridge that touches
    // Ghola's OWN configuration rather than an external system, and therefore
    // the only one whose misuse is self-amplifying: module settings are where
    // every other capability's gate is stored.
    //
    // THE GATE IS RESOLVED FIRST, ahead of argument validation, exactly as
    // `/transition` does, so a withheld capability refuses identically for a
    // well-formed and a malformed call and no work happens before the refusal.
    // `resolveSettingsWrite` runs per request: toggling the setting off — or
    // entering an autonomous session mode — takes effect on the very next call,
    // no reload. Anything that is not a function means withheld, a THROWING
    // resolver included. It reads its OWN setting; neither Jira gate opens this
    // door and this one opens neither of theirs.
    //
    // The refusal TEXT is chosen from the resolver's discriminated reason, and
    // the distinction is the whole point: the gate-off message tells the operator
    // to tick "Enable Settings Write", which is exactly the wrong instruction
    // when they already have and it was the AUTONOMOUS-MODE BAR that refused.
    //
    // Everything past the gate is the APPLIER's job, in `extension.ts` and
    // `state/module-settings.ts`: resolving `moduleId::fieldKey` against the
    // discovered manifests (an undeclared key is refused, which is what makes
    // `mode.war::enabled` structurally unwritable), refusing `keyValue` tables,
    // validating the value against the declared type/options/bounds, raising the
    // MODAL confirmation for a `securitySensitive` field and awaiting it, and
    // only then persisting. This file deliberately does none of that — a second
    // copy of the validation here would be a second thing to keep correct.
    //
    // A refused/cancelled request comes back as HTTP 200 with `status`
    // `refused` / `cancelled`, NOT as a 4xx: the call was well-formed at the
    // transport level and the answer is a real answer. Only a missing/empty
    // `moduleId` or `fieldKey` is a 400, because that is a caller error rather
    // than a decision.
    if (route === '/set-module-setting') {
      let resolved: ApplySettingWriteFn | SettingsWriteWithheld | undefined;
      try {
        resolved = resolveSettingsWrite();
      } catch {
        // A resolver that blew up tells us nothing about the operator's intent,
        // and "we could not tell" must never read as "go ahead".
        resolved = undefined;
      }
      if (typeof resolved !== 'function') {
        // Only an explicit `autonomous-mode` reason selects the other text.
        // Every other shape — `undefined`, a thrown resolver, an object this
        // build does not recognize — falls back to the gate-off message, which
        // is the conservative direction: it can be a slightly wrong explanation
        // but never a wrongly-granted write.
        const autonomous =
          typeof resolved === 'object'
          && resolved !== null
          && (resolved as SettingsWriteWithheld).withheld === 'autonomous-mode';
        sendJson(res, 403, {
          status: CAPABILITY_DISABLED_STATUS,
          message: autonomous
            ? SETTINGS_WRITE_AUTONOMOUS_MODE_MESSAGE
            : SETTINGS_WRITE_DISABLED_MESSAGE,
        });
        return;
      }
      const applySettingWrite: ApplySettingWriteFn = resolved;
      const moduleId = typeof args.moduleId === 'string' ? args.moduleId.trim() : '';
      if (!moduleId) {
        sendJson(res, 400, {
          status: 'unknown-error',
          message: 'moduleId must be a non-empty string',
        });
        return;
      }
      const fieldKey = typeof args.fieldKey === 'string' ? args.fieldKey.trim() : '';
      if (!fieldKey) {
        sendJson(res, 400, {
          status: 'unknown-error',
          message: 'fieldKey must be a non-empty string (read it from get-module-settings)',
        });
        return;
      }
      // `value` is passed through UNTOUCHED — no defaulting and no coercion
      // here. The applier narrows it against the field's declared type, and a
      // second, looser coercion at this layer is exactly how a typo'd boolean
      // becomes a permission grant.
      const written = await applySettingWrite({ moduleId, fieldKey, value: args.value });
      sendJson(res, 200, written);
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
      // prId?, prState?, draft?, prAuthor?, prAuthorDisplay?, failure? }`) with
      // NO `status` field — a successful
      // lookup and a "no PR" both come back shapeless from the wrapper's
      // perspective. The bb-bridge.mjs client judges success by
      // `status === 'ok'`, so we tag the response here to fit that taxonomy
      // (matching list-comments / reply / resolve / mark-ready) rather than
      // making the client special-case this route. A finite `prId` is the
      // found-a-PR signal the downstream pr-monitor / comment / mark-ready flows
      // depend on. The `...lookup` spread carries `prState` through verbatim, so
      // a caller sees "found a MERGED PR #123" (prState: 'MERGED') distinctly
      // from "no PR at all" (the not-found below) — a found-but-closed PR is
      // NEVER collapsed into not-found. The same spread carries `draft` through:
      // `true` / `false` when Bitbucket reported it, and ABSENT when it did not,
      // which means "unknown" and must not be read as "ready for review".
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
    case '/whoami':
      // READ-ONLY: `GET /2.0/user`, the Bitbucket identity of the API TOKEN the
      // host calls with. Takes no arguments — deliberately: there is nothing for
      // a caller to point this at, because the only account it can ever report
      // is the one behind the host's own credential.
      //
      // The result is `{ status, user?: { accountId, nickname, displayName,
      // uuid } }`. NO TOKEN IS EXPOSED BY THIS: an account id is a public
      // identifier that already appears on every comment `/list-comments`
      // returns; what crosses the bridge is who the token IS, never the token.
      //
      // It answers ownership and NOTHING ELSE. `comment.author.accountId ===
      // whoami.user.accountId` is a real equality test (same key space), but
      // establishing that a comment is ours is not authorization to touch it —
      // `/delete-comment` keeps its own gate and this route does not relax it.
      //
      // The host caches the answer for the process lifetime, so repeat calls are
      // free; a FAILED call is not cached and the next call retries.
      return client.getCurrentUser();
    case '/list-comments':
      // The returned `PrComment`s may each carry `outdated` — Bitbucket's
      // `inline.outdated` marker, carried through verbatim. It is ABSENT when we
      // did not learn it (a general comment has no anchor to be outdated, and
      // the list serialization may simply omit the key), and absent means
      // UNKNOWN. Only `outdated === true` is a positive fact; a missing key must
      // never be read as "this comment is still current".
      return client.listPullRequestComments(str(args.repoSlug), num(args.prId));
    case '/capture-comments':
      // Reads the SAME comments `/list-comments` does (it calls straight through
      // to `listPullRequestComments`) and appends one JSONL record per comment to
      // the host-resolved capture file for the per-project reviewer dossier.
      //
      // It touches NOTHING in Bitbucket — the only write is local — but it is
      // still a MUTATION for classification purposes and is deliberately absent
      // from `RETRYABLE_ROUTES` in `scripts/bb-bridge.mjs`, so no transport blip
      // replays it. The capture file path is NOT accepted from the caller and
      // never appears in the request: the client holds the host-resolved absolute
      // path, which is the whole point of injecting it at compose time.
      //
      // Each JSONL record may now carry an OPTIONAL `outdated` boolean (the same
      // `inline.outdated` marker `/list-comments` surfaces). It is written only
      // when Bitbucket sent one, so an older record and a record for a comment
      // whose state we could not establish look identical — both simply lack the
      // key, and both mean "unknown".
      return client.capturePullRequestComments({
        repoSlug: str(args.repoSlug),
        prId: num(args.prId),
      });
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
        reviewers: parseReviewers(args.reviewers),
      });
    case '/update-pr':
      return client.updatePullRequest({
        repoSlug: str(args.repoSlug),
        prId: num(args.prId),
        title: args.title !== undefined ? str(args.title) : undefined,
        description: args.description !== undefined ? str(args.description) : undefined,
        reviewers: parseReviewers(args.reviewers),
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

/** Parse the optional reviewers array from the request body. Returns undefined
 *  unless a well-formed array of `{ account_id: string }` objects is present.
 *  Silently drops entries that are missing `account_id` rather than failing the
 *  whole call, so a partly-valid list still attaches the usable reviewers. */
function parseReviewers(v: unknown): Array<{ account_id: string }> | undefined {
  if (!Array.isArray(v)) return undefined;
  const reviewers: Array<{ account_id: string }> = [];
  for (const entry of v) {
    if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).account_id === 'string') {
      reviewers.push({ account_id: (entry as Record<string, unknown>).account_id as string });
    }
  }
  return reviewers.length > 0 ? reviewers : undefined;
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
