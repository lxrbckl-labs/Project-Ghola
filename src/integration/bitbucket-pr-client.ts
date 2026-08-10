/**
 * Bitbucket Cloud PR-comments REST client. Powers the
 * `integration.bitbucket-pr-comments` module — list / reply / resolve
 * operations against an open pull request, fronted by the same Basic-auth
 * + 8 s timeout + sanitized error-mapping contract as
 * `src/integration/atlassian-client.ts`.
 *
 * Security contract — read before extending:
 *   - The constructor receives an `AtlassianBridge` (token source) and a
 *     workspace-slug accessor. Each operation reads the ORDERED Bitbucket token
 *     list via `bridge.getBitbucketTokens()` and runs a shared round-robin
 *     failover loop (`withBitbucketFailover`): the `Authorization: Basic
 *     <base64(email:token)>` header is rebuilt INSIDE each attempt from that
 *     attempt's token, so a token swap takes effect for every request in the
 *     operation (including a paginated list). Each request object falls out of
 *     scope when the call resolves. Tokens are NEVER logged, returned to the
 *     webview, embedded in error messages, stored on the instance, or otherwise
 *     echoed — the failover loop treats them as opaque strings.
 *   - Every public method returns a typed result shape — they never throw to
 *     the caller. Non-2xx responses and network failures are mapped to a
 *     sanitized `status: 'unauthorized' | 'forbidden' | 'not-found' |
 *     'rate-limited' | 'network-error' | 'unknown-error'` value with a
 *     user-facing `message` (429 carries `retryAfter`, never acted on).
 *     On a non-2xx response the message is enriched with Bitbucket's own
 *     `error.message` AND its per-field rejection reasons `error.fields` (its
 *     documented `{type:"error",error:{message,fields}}` shape) so callers see
 *     the real cause; that text is Bitbucket's, never the request headers or
 *     token. Network errors stay fully generic.
 *   - Every request runs under an 8 s `AbortController` timeout so a wedged
 *     network cannot hang the extension host.
 *
 * No new npm dependencies. Uses global `fetch` and Node's built-in `Buffer`
 * for base64, matching `atlassian-client.ts`.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { AtlassianBridge } from '../extension';
import { AtlassianClient, type PrLookupResult } from './atlassian-client';
import {
  withBitbucketFailover,
  withTransientRetry,
  parseRetryAfterSeconds,
} from './bitbucket-failover';

/** Per-request timeout. Mirrors `atlassian-client.ts` so a wedged network
 *  cannot hang the extension UI thread. */
const REQUEST_TIMEOUT_MS = 8000;

/** HTTP methods that CHANGE server state. Membership here is what makes a
 *  request's ambiguous failures `'indeterminate'` instead of a retryable
 *  `'network-error'`. Keyed on the METHOD rather than on the calling verb so a
 *  mixed operation is classified correctly per hop: `markPrReady` / `markPrDraft`
 *  issue a GET and then a PUT inside a single failover attempt, and only the PUT
 *  is unsafe to replay — the GET keeps its cheap retry. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE']);

/** Node/undici error codes that prove the request NEVER REACHED Bitbucket.
 *  Each one fails during DNS resolution or the TCP/TLS connect, i.e. before a
 *  single byte of the HTTP request could be written, so no write can possibly
 *  have been applied and a replay is provably safe even for a mutation.
 *
 *  Deliberately NARROW. Codes that can occur AFTER the request is on the wire
 *  are excluded on purpose — `ECONNRESET` and `EPIPE` most notably, since a peer
 *  that resets the connection while we wait for the response may well have
 *  processed the write first. When in doubt a code is left out: the cost of
 *  omitting a safe code is one avoidable manual check, while the cost of
 *  wrongly including an unsafe one is a duplicate comment on a live PR. */
const PREFLIGHT_ERROR_CODES = new Set([
  'ENOTFOUND',      // DNS: host never resolved.
  'EAI_AGAIN',      // DNS: temporary resolution failure.
  'ECONNREFUSED',   // TCP: connect actively refused, no session established.
  'EHOSTUNREACH',   // Routing: no path to host.
  'ENETUNREACH',    // Routing: no path to network.
]);

/** True when `err` is a connect/DNS-phase failure per `PREFLIGHT_ERROR_CODES`.
 *  Mirrors the code-extraction shape used in `scripts/bb-bridge.mjs`: undici
 *  wraps the real socket error, so the useful code lives on `err.cause.code`
 *  rather than `err.code`, and a dual-stack ("happy eyeballs") connect failure
 *  arrives as an AggregateError whose SUB-errors carry the codes while the
 *  AggregateError itself has none. Defaults to FALSE (i.e. treat as unsafe) for
 *  anything it cannot positively identify. */
function isPreflightFailure(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const cause = (err as { cause?: unknown }).cause;

  if (typeof cause === 'object' && cause !== null) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string') return PREFLIGHT_ERROR_CODES.has(code);
    const sub = (cause as { errors?: unknown }).errors;
    if (Array.isArray(sub)) {
      // EVERY leg must be a pre-flight failure. If even one arm of a dual-stack
      // attempt got far enough to fail some other way, the request may have
      // landed and the whole thing is unsafe to replay.
      const codes = sub
        .map((e) => (typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string'
          ? (e as { code: string }).code
          : ''))
        .filter(Boolean);
      return codes.length > 0 && codes.every((c) => PREFLIGHT_ERROR_CODES.has(c));
    }
  }

  const own = (err as { code?: unknown }).code;
  return typeof own === 'string' && PREFLIGHT_ERROR_CODES.has(own);
}

/** Bitbucket Cloud REST v2 base. Duplicated as a local constant rather than
 *  re-exported from `atlassian-client.ts` so the two clients evolve
 *  independently if the API ever forks (e.g. v3, server vs cloud). */
const BITBUCKET_BASE_URL = 'https://api.bitbucket.org/2.0';

/** Safety cap on pagination — Bitbucket PR threads rarely exceed this. When
 *  hit we still return `status: 'ok'` but flag truncation via `message`. */
const COMMENT_PAGE_CAP = 200;

/** Hard cap on the number of pages the comment walk may fetch, independent of
 *  `COMMENT_PAGE_CAP`. The comment cap alone does NOT bound the walk: deleted
 *  tombstones and comments that fail `normalizeComment` are skipped WITHOUT
 *  counting toward it, so a PR carrying thousands of deleted/bot-churned
 *  comments could walk arbitrarily many pages while `comments.length` crawls.
 *  At `pagelen=50` a full 200-comment result needs 4 pages; 20 leaves ample
 *  headroom for tombstone-heavy PRs while still terminating. */
const MAX_COMMENT_PAGES = 20;

/** Wall-clock budget for the ENTIRE paginated comment walk. Each page has its
 *  own 8 s `REQUEST_TIMEOUT_MS` and its own transient-retry budget, so without
 *  a walk-level bound the worst case multiplies out to minutes — far past any
 *  client's patience, which is exactly the failure this bound exists to stop.
 *  On expiry we return the pages we DID get as a successful, flagged-partial
 *  result rather than failing the whole call. */
const COMMENT_WALK_BUDGET_MS = 45000;

/** Byte bound on the PR-comment CAPTURE file (`capturePullRequestComments`).
 *
 *  ONE coherent bounding behavior, stated once so nothing later has to guess:
 *  the file is APPEND-ONLY — no record is ever edited, re-ordered, or
 *  selectively pruned — and the ONLY thing that ever removes data is a
 *  WHOLE-FILE ROTATION at this size. On the write that would cross the bound the
 *  current file is renamed to `<file>.1` (replacing any previous generation) and
 *  a fresh empty file starts. Two generations therefore bound total disk use at
 *  2x this value.
 *
 *  This deliberately does NOT inherit the contradictory pair the old prose
 *  logging settings carried (`integration.bitbucket-pr-comments`'s manifest said
 *  "append-only, never edit prior entries" while its `pr-monitor.md` said to
 *  prune on every write — the two cannot both hold). Rotation is the coherent
 *  reading: prior entries are never rewritten, and the bound is enforced by
 *  retiring a whole generation rather than by rewriting the live file. */
const CAPTURE_FILE_MAX_BYTES = 5 * 1024 * 1024;

/** Per-record body bound. A single CodeRabbit review comment can run to tens of
 *  kilobytes, and a handful of them would otherwise trip whole-file rotation on
 *  their own and retire an entire generation of dossier signal. The clamp is
 *  applied AFTER redaction so it can never bisect a secret and leave the tail of
 *  it unmatched. Truncation is marked inline so a reader is never misled into
 *  thinking they have the full body. */
const CAPTURE_BODY_MAX_CHARS = 8000;

/** Marker appended to a body clamped at `CAPTURE_BODY_MAX_CHARS`. */
const CAPTURE_BODY_TRUNCATION_MARKER = '\n…[body truncated by Ghola capture]';

/**
 * Best-effort redaction applied to every comment body BEFORE it is written to
 * the capture file.
 *
 * This exists because the capture file persists third-party prose to disk: a PR
 * comment is free text and a reviewer may have pasted a credential into one
 * (Bitbucket does not scrub them). Capturing that verbatim would copy someone
 * else's secret into a long-lived local file. Each pattern below either matches a
 * well-known credential FORMAT or a `key = value` assignment whose key names a
 * credential.
 *
 * It is a MITIGATION, NOT A GUARANTEE — an unrecognized credential format passes
 * through. Do not treat the capture file as safe to publish. Nothing here is ever
 * logged or echoed: redaction happens on the value in memory on its way to the
 * file, and no branch of this client prints a body.
 */
const CAPTURE_REDACTIONS: Array<{ pattern: RegExp; replacement: string }> = [
  // Whole PEM private-key blocks, including the armor.
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: '[redacted-private-key]' },
  // Atlassian API tokens (`ATATT`) and Connect tokens (`ATCTT`).
  { pattern: /(?<![A-Za-z0-9])AT[AC]TT3[A-Za-z0-9_=+/-]{20,}/g, replacement: '[redacted-token]' },
  // GitHub classic (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`) and fine-grained PATs.
  { pattern: /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/g, replacement: '[redacted-token]' },
  { pattern: /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/g, replacement: '[redacted-token]' },
  // Slack bot/user/app tokens.
  { pattern: /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/g, replacement: '[redacted-token]' },
  // AWS access key ids.
  { pattern: /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g, replacement: '[redacted-token]' },
  // OpenAI-style keys.
  { pattern: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g, replacement: '[redacted-token]' },
  // A pasted Authorization header — the scheme is kept, the credential is not.
  { pattern: /(?<![A-Za-z0-9])(Authorization\s*:\s*)(Bearer|Basic|Token)\s+[A-Za-z0-9._+/=-]{8,}/gi, replacement: '$1$2 [redacted]' },
  // `password=`, `API_KEY: "..."`, `DATABASE_PASSWORD=...`, `token = ...` and friends.
  //
  // The key is matched as a WHOLE identifier that carries a credential keyword as
  // one of its `_`/`-` separated parts, not as a bare keyword: `\b` does not fire
  // between `_` and a letter (`_` is a word character), so a leading `\b` here let
  // every `SCREAMING_SNAKE_CASE` key — the dominant convention for exactly the
  // pasted `.env` / compose blocks this pattern exists to catch — through in
  // plaintext. `(?:[A-Za-z0-9]+[_-])*` / `(?:[_-][A-Za-z0-9]+)*` bound the keyword
  // to whole parts, so `DATABASE_PASSWORD` and `STRIPE_SECRET_KEY` match while
  // `tokenizer` and `notapassword` still do not.
  //
  // The lookbehind excludes `_` (so it stays a whole-identifier boundary) but NOT
  // `-`: excluding `-` too would block every CLI-flag form (`--password=`,
  // `--api-key=`, `-token=`, `mysql -u root --password=... -h db`) since the
  // keyword there is only ever reached through a leading `-`.
  //
  // The value has a quoted and an unquoted form. An UNQUOTED value genuinely ends
  // at whitespace; a QUOTED one must run to its closing quote (or end of line if
  // the paste is unterminated), otherwise only the first word of a multi-word
  // secret is redacted and the tail is written verbatim.
  {
    pattern: /(?<![A-Za-z0-9_])((?:[A-Za-z0-9]+[_-])*(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|token)(?:[_-][A-Za-z0-9]+)*)(\s*[:=]\s*)(?:'[^'\n]{8,}'?|"[^"\n]{8,}"?|[^\s"',;]{8,})/gi,
    replacement: '$1$2[redacted]',
  },
];

/** Apply every `CAPTURE_REDACTIONS` pattern in order. Pure — returns a new
 *  string and never logs either the input or the output. */
function redactCapturedText(text: string): string {
  let out = text;
  for (const { pattern, replacement } of CAPTURE_REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Clamp a (already redacted) body to `CAPTURE_BODY_MAX_CHARS`, marking the cut
 *  so a reader can tell a clamped body from a short one. */
function clampCapturedBody(text: string): string {
  if (text.length <= CAPTURE_BODY_MAX_CHARS) return text;
  return text.slice(0, CAPTURE_BODY_MAX_CHARS) + CAPTURE_BODY_TRUNCATION_MARKER;
}

/**
 * The per-project dossier key — the field the old prose comment log lacked
 * entirely, which is why it could only ever be one global file for every project
 * on the machine.
 *
 * Derived from the repo slug the caller resolved: strip a trailing `.git`, take
 * the LAST path segment, lowercase it. That is deliberately the SAME derivation
 * `mode.ticket-pr` documents for producing the slug in the first place
 * (`git remote get-url origin` -> strip `.git` -> last path segment), so the two
 * agree by construction on a normal `--repo <slug>` call, and it stays correct if
 * a caller ever passes a `workspace/repo` or URL-shaped value instead of a bare
 * slug.
 *
 * The one place they can still diverge is CASE: a git remote may carry
 * mixed-case (`.../CMMS2.git`) while Bitbucket's canonical slug is lowercase.
 * Lowercasing here is what stops that from splitting one project's dossier into
 * two keys. `repoSlug` is still recorded verbatim alongside `project`, so nothing
 * is lost by normalizing.
 */
function deriveProjectKey(repoSlug: string): string {
  const trimmed = repoSlug.trim().replace(/\.git$/i, '');
  const segments = trimmed.split('/').filter((s) => s !== '');
  const last = segments.length > 0 ? segments[segments.length - 1]! : '';
  return last.toLowerCase();
}

/** Identity of a captured record for append-time de-duplication. Keyed on
 *  `updatedAt` as well as the ids so an EDITED comment captures again as a new
 *  record (an edit is real dossier signal) while an unchanged one, re-seen on a
 *  later sweep of the same PR, does not. */
function captureRecordKey(r: {
  project?: unknown;
  prId?: unknown;
  commentId?: unknown;
  updatedAt?: unknown;
}): string {
  return `${String(r.project ?? '')}|${String(r.prId ?? '')}|${String(r.commentId ?? '')}|${String(r.updatedAt ?? '')}`;
}

/** Discriminator carried on every result shape returned by this client.
 *  `'rate-limited'` maps a 429 distinctly (Phase 0 noted 429s previously fell
 *  into `'unknown-error'`), keeping this client's taxonomy consistent with
 *  `atlassian-client.ts`'s `RequestFailure` `'ratelimit'` kind.
 *
 *  `'indeterminate'` is NOT a failure keyword like the others — it is the
 *  explicit ABSENCE of knowledge. It means a MUTATING request (POST/PUT/DELETE)
 *  ended without a definitive answer from Bitbucket, so the write may or may not
 *  have been applied. It exists to stop this client from doing the one thing
 *  that is never safe in that situation: quietly replaying the write. Treat it
 *  as "go look at the PR", never as "it failed". */
export type BitbucketPrStatus =
  | 'ok'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'rate-limited'
  | 'network-error'
  | 'indeterminate'
  | 'unknown-error';

/** Normalized PR comment shape exposed to callers. Drops Bitbucket-internal
 *  fields that PR-comments callers do not need and flattens the `resolution`
 *  envelope into a single boolean. */
export interface PrComment {
  id: number;
  /** `null` for top-level threads, comment id for replies. */
  parentId: number | null;
  /** `'inline'` when the comment is anchored to a file/line, else `'general'`. */
  kind: 'inline' | 'general';
  author: { displayName: string; accountId: string };
  /** `.content.raw` — the markdown source the user typed. */
  body: string;
  /** Present only when `kind === 'inline'`. */
  inline?: { path: string; to: number; from?: number };
  /** Derived from `.resolution` — `null` on Bitbucket means unresolved. */
  resolved: boolean;
  /**
   * Whether Bitbucket considers this comment's anchor OUTDATED — i.e. the code
   * it was attached to has changed since it was written.
   *
   * PROVENANCE, because this field's status is unusual and acting on a guess
   * here deletes live review feedback. Read verbatim from `inline.outdated` on
   * the comment Bitbucket returned. That location is NOT in Bitbucket's formal
   * OpenAPI schema: the spec's `comment.inline` object declares only
   * `from` / `to` / `start_from` / `start_to` / `path` and is marked
   * `additionalProperties: false`. It IS in Atlassian's own published example
   * payload for a `pullrequest_comment` (the sample response embedded in the
   * `pullrequests/.../activity` endpoint description carries
   * `"inline": { "context_lines": "", "to": null, "path": "", "outdated": false,
   * "from": 211 }`), and Bitbucket users report reading it off the
   * single-comment GET. So the field is real and its name is established from
   * Atlassian's own material — but the SCHEMA does not promise it, and no live
   * authenticated call from this repo has ever confirmed it is present on the
   * paginated LIST response `listPullRequestComments` actually walks.
   *
   * ABSENT IS NOT `false`, exactly as `PrLookupResult.draft` is not. Three
   * distinct situations all produce `undefined` here and none of them means
   * "this comment is current":
   *   - the comment is GENERAL (no `inline` block at all), so Bitbucket has no
   *     anchor to call outdated and never will;
   *   - the comment is inline but the list serialization omitted the key;
   *   - Bitbucket sent something non-boolean.
   * A caller that reads `undefined` as "not outdated" is safe; a caller that
   * reads it as "known current" is fine too — but a caller that inverts it and
   * treats `!outdated` as "definitely still current" is NOT, and that is the
   * mistake that would delete a live comment. Only `outdated === true` is a
   * positive fact.
   */
  outdated?: boolean;
  /** ISO 8601 timestamp from `.created_on`. */
  createdAt: string;
  /** ISO 8601 timestamp from `.updated_on`. */
  updatedAt: string;
}

export interface PrCommentListResult {
  status: BitbucketPrStatus;
  /** Empty on any non-`'ok'` status. */
  comments: PrComment[];
  /** Sanitized, user-facing string. Also set on `'ok'` when truncation occurs. */
  message?: string;
  /** True when the walk stopped early (comment cap, page cap, or time budget)
   *  and `comments` is therefore a PREFIX of the PR's comments, not all of
   *  them. Always present on `'ok'` so a caller can branch on it without
   *  string-matching `message`. */
  truncated?: boolean;
  /** Bitbucket's own total comment count for this PR when the API reported it
   *  (`size`), so a caller can render an honest "N of M fetched". Undefined
   *  when Bitbucket omitted it — never guessed. Note this counts deleted
   *  tombstones too, so it can exceed the number of usable comments. */
  totalAvailable?: number;
  /** Raw `Retry-After` header value carried verbatim on a `'rate-limited'`
   *  (429) result. Carried, never acted on — a later phase may honor it. */
  retryAfter?: string;
}

/**
 * ONE line of the PR-comment capture file (JSON Lines: one complete JSON object
 * per line, newline-terminated, appended).
 *
 * THIS SHAPE IS A CONTRACT other modules read — do not drop or rename a field
 * without saying so. Every field is populated from data this client already
 * holds: all of `commentId` .. `updatedAt` come straight off `PrComment`, and
 * `prAuthor` comes from the same `pullrequests/{id}` object `find-pr` reads its
 * `prAuthor` from.
 *
 * What each field is FOR — the old prose log dropped most of these, which is why
 * it could not support a per-reviewer dossier:
 *   - `platform` is a literal `'bitbucket'` rather than an inferred value, so a
 *     future GitHub capture path writes `'github'` into the same file and a
 *     consumer can partition on it without guessing.
 *   - `project` is the per-project dossier key (see `deriveProjectKey`).
 *   - `author.accountId` is the STABLE reviewer key; `author.displayName` is the
 *     human label and can change. Both are kept — keying a dossier on a display
 *     name would merge or split reviewers on a rename.
 *   - `parentId` + `inline` are what make a nitpick locatable (which thread,
 *     which file, which line) instead of a free-floating string.
 *   - `resolved` is Bitbucket's real resolution boolean, never inferred from
 *     body text.
 *   - `outdated` is Bitbucket's `inline.outdated` marker and is OPTIONAL: it is
 *     written only when Bitbucket actually sent a boolean, so a record without
 *     the key means "unknown", not "current". It is the newest field on this
 *     shape; a consumer written against the older shape simply never sees it,
 *     which is why it was added as an optional rather than a required field.
 */
export interface PrCommentCaptureRecord {
  /** Capture time (when Ghola wrote this line), ISO 8601. NOT the comment's own
   *  timestamp — see `createdAt` / `updatedAt` for those. */
  ts: string;
  platform: 'bitbucket';
  /** Per-project dossier key. See `deriveProjectKey`. */
  project: string;
  /** The slug exactly as the caller supplied it, unnormalized. */
  repoSlug: string;
  prId: number;
  /** The PR author's Bitbucket `nickname` handle (falling back to their display
   *  name when Bitbucket omits the nickname), matching `find-pr`'s `prAuthor`.
   *  `''` when the PR read failed — the capture still proceeds. */
  prAuthor: string;
  commentId: number;
  parentId: number | null;
  kind: 'inline' | 'general';
  author: { displayName: string; accountId: string };
  /** Redacted (`redactCapturedText`) and clamped (`clampCapturedBody`) markdown
   *  source of the comment. */
  body: string;
  /** Present only when `kind === 'inline'`. */
  inline?: { path: string; to: number; from?: number };
  resolved: boolean;
  /** Bitbucket's `inline.outdated` marker, carried verbatim from `PrComment`.
   *  OMITTED FROM THE RECORD ENTIRELY when unknown rather than written as
   *  `false` — see `PrComment.outdated`. A dossier consumer must read a missing
   *  key as "not established", never as "the comment was current". */
  outdated?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Result of `capturePullRequestComments`. `status: 'ok'` means the file write
 *  completed; a non-ok status is the LIST read's own failure status (the capture
 *  never invents one). */
export interface PrCommentCaptureResult {
  status: BitbucketPrStatus;
  /** Absolute path of the capture file that was appended to. Safe to surface —
   *  it is a path under the extension's own global storage, not a secret. */
  filePath?: string;
  /** Records appended by THIS call. */
  captured?: number;
  /** Comments skipped because an identical record (same project + PR + comment
   *  + `updatedAt`) was already on file. */
  skipped?: number;
  /** Comments the list read returned, i.e. `captured + skipped`. */
  total?: number;
  /** The per-project dossier key these records were written under. */
  project?: string;
  /** True when the underlying comment LIST was truncated, so this capture covers
   *  only a prefix of the PR's comments. Mirrors `PrCommentListResult.truncated`
   *  so both reads report partiality identically. */
  truncated?: boolean;
  message?: string;
  /** Raw `Retry-After` on a `'rate-limited'` result; carried, never acted on. */
  retryAfter?: string;
}

export interface PrReplyResult {
  status: BitbucketPrStatus;
  /** Returned by Bitbucket on a successful create. */
  commentId?: number;
  message?: string;
  /** Raw `Retry-After` on a `'rate-limited'` result; carried, never acted on. */
  retryAfter?: string;
}

/** Result of creating a STANDALONE, top-level PR comment. Mirrors
 *  `PrReplyResult` field-for-field — the two operations differ only in whether
 *  a `parent` is sent, so their result shapes are deliberately identical and
 *  callers can log the created `commentId` the same way for both. */
export interface PrCommentCreateResult {
  status: BitbucketPrStatus;
  /** Returned by Bitbucket on a successful create. */
  commentId?: number;
  message?: string;
  /** Raw `Retry-After` on a `'rate-limited'` result; carried, never acted on. */
  retryAfter?: string;
}

export interface PrResolveResult {
  status: BitbucketPrStatus;
  message?: string;
  /** Raw `Retry-After` on a `'rate-limited'` result; carried, never acted on. */
  retryAfter?: string;
}

export interface PrDeleteResult {
  status: BitbucketPrStatus;
  message?: string;
  /** Raw `Retry-After` on a `'rate-limited'` result; carried, never acted on. */
  retryAfter?: string;
}

export interface PrReadyResult {
  status: BitbucketPrStatus;
  message?: string;
  /** Raw `Retry-After` on a `'rate-limited'` result; carried, never acted on. */
  retryAfter?: string;
}

export interface PrDraftResult {
  status: BitbucketPrStatus;
  message?: string;
  /** Raw `Retry-After` on a `'rate-limited'` result; carried, never acted on. */
  retryAfter?: string;
}

export interface PrCreateResult {
  status: BitbucketPrStatus;
  /** Numeric id Bitbucket assigns to the newly created PR. */
  prId?: number;
  /** Web (`links.html.href`) URL of the created PR, for the user to open. */
  url?: string;
  message?: string;
  /** Raw `Retry-After` on a `'rate-limited'` result; carried, never acted on. */
  retryAfter?: string;
}

/** Reviewer identity as sent to Bitbucket on `POST /pullrequests` and
 *  `PUT /pullrequests/{id}`.
 *
 *  UNVERIFIED — read before changing. We send `{ account_id }` because that is
 *  the identifier the settings panel stores (`tool.pr-prep`'s
 *  `defaultReviewers` table is keyed on it) and the one
 *  `searchWorkspaceMembers` has always returned. Bitbucket's OWN documented
 *  example for this field uses `{ "uuid": "{...}" }` instead, and no live
 *  authenticated call has ever confirmed that `account_id` is accepted here.
 *  If a live test comes back rejecting it, the fallback is deliberately small:
 *  widen this alias to `{ uuid: string }`, populate it from
 *  `WorkspaceMember.uuid` (already captured), and mirror the same key change in
 *  `parseReviewers` (`bitbucket-bridge-server.ts`) and `parseReviewersFlag`
 *  (`scripts/bb-bridge.mjs`). Do NOT change what `defaultReviewers` STORES —
 *  the operator's populated table is keyed on account_id and re-keying it would
 *  force a full re-populate. */
export type PrReviewer = { account_id: string };

export interface PrUpdateResult {
  status: BitbucketPrStatus;
  message?: string;
  /** Raw `Retry-After` on a `'rate-limited'` result; carried, never acted on. */
  retryAfter?: string;
}

export interface WorkspaceMember {
  accountId: string;
  /** Bitbucket's own `{...}`-braced user UUID, carried alongside `accountId`.
   *  Bitbucket's documented `reviewers` example on `POST /pullrequests` uses
   *  `{ "uuid": "{...}" }` rather than `{ "account_id": "..." }`; we send
   *  `account_id` (see `createPullRequest`) but capture the uuid here so the
   *  fallback is available without a second members call. `''` when Bitbucket
   *  omitted it. */
  uuid: string;
  displayName: string;
  avatarUrl: string;
}

export interface WorkspaceMemberResult {
  status: 'ok' | 'unauthorized' | 'forbidden' | 'not-found' | 'rate-limited' | 'network-error' | 'unknown-error';
  members?: WorkspaceMember[];
  message?: string;
}

/**
 * The Bitbucket identity of the API TOKEN this extension is calling with — i.e.
 * the account every comment posted through this client is authored by.
 *
 * WHY THIS EXISTS. Nothing else in the repo could answer "did WE write this
 * comment?". `PrComment.author` carries `{ displayName, accountId }`, while the
 * operator's `bitbucketUsername` setting is a NICKNAME — a different key space
 * with no join, and one that describes the OPERATOR rather than the token. Two
 * different people can be involved (the operator can configure a service
 * account's token), so matching on the setting answers a question nobody asked.
 * `accountId` below is in the SAME key space as `PrComment.author.accountId`,
 * so `comment.author.accountId === me.accountId` is a real equality test rather
 * than a heuristic.
 *
 * It establishes ownership ONLY. It authorizes nothing — no deletion gate reads
 * it, and knowing a comment is ours is not permission to remove it.
 */
export interface BitbucketCurrentUser {
  /** The Atlassian account id. `''` only if Bitbucket omitted it, which would
   *  make the identity unusable for the ownership join — check for empty before
   *  comparing, or every author with a missing account id matches. */
  accountId: string;
  /** Bitbucket's `nickname` handle. `''` when absent. This is the field the
   *  `bitbucketUsername` SETTING is in the same key space as — which is exactly
   *  why it is carried here and why the setting alone was never sufficient. */
  nickname: string;
  /** Free-form `display_name`, for showing a human who the token is. Never for
   *  matching — it is renameable. `''` when absent. */
  displayName: string;
  /** Bitbucket's own `{...}`-braced account uuid. Carried alongside (never in
   *  place of) `accountId` for the same reason `WorkspaceMember` carries it:
   *  some Bitbucket payloads identify an account by uuid, and re-fetching to
   *  learn it later would be a second API call. `''` when absent. */
  uuid: string;
}

/** Result of `getCurrentUser`. Mirrors `WorkspaceMemberResult` field for field
 *  (same narrowed status union — a GET never produces `'indeterminate'`, and
 *  this read carries no `retryAfter` for the same reason its neighbour does
 *  not). `user` is present only on `'ok'`. */
export interface BitbucketCurrentUserResult {
  status: 'ok' | 'unauthorized' | 'forbidden' | 'not-found' | 'rate-limited' | 'network-error' | 'unknown-error';
  user?: BitbucketCurrentUser;
  message?: string;
}

// ─── Minimal slices of the Bitbucket response shapes we read ──────────────

interface BitbucketUser {
  display_name?: string;
  account_id?: string;
}

interface BitbucketInline {
  path?: string;
  to?: number | null;
  from?: number | null;
  /** Bitbucket's own outdated marker for an inline anchor — see
   *  `PrComment.outdated` for the full provenance note and for why it is read as
   *  `boolean | undefined` rather than coerced to `false`. */
  outdated?: boolean;
}

interface BitbucketContent {
  raw?: string;
}

interface BitbucketResolution {
  // Presence is what matters; the inner fields (`user`, `date`) are unused.
  date?: string;
}

interface BitbucketComment {
  id?: number;
  parent?: { id?: number };
  user?: BitbucketUser;
  content?: BitbucketContent;
  inline?: BitbucketInline;
  resolution?: BitbucketResolution | null;
  deleted?: boolean;
  created_on?: string;
  updated_on?: string;
}

interface BitbucketCommentListResponse {
  values?: BitbucketComment[];
  next?: string;
  /** Bitbucket's total match count for the query (all pages). Optional: the
   *  API omits it on some paginated endpoints, so every read is guarded. */
  size?: number;
}

/** Minimal slice of `GET /pullrequests/{id}` we read before any PUT —
 *  Bitbucket's PUT treats the request as a full update, so we echo `title`
 *  back to avoid a spurious 400 when we clear the draft flag, and echo
 *  `description` / `draft` back on any PUT that does not itself set them, so a
 *  partial-looking update cannot silently blank the description or flip a draft
 *  PR to ready. */
interface BitbucketPullRequest {
  title?: string;
  description?: string;
  draft?: boolean;
  /** Read ONLY by `capturePullRequestComments`, which needs the PR author for
   *  its `prAuthor` field. `nickname` is the username-like handle (the same one
   *  `find-pr` surfaces as `prAuthor`); `display_name` is the free-form label.
   *  `buildEchoPayload` never touches this, so no PUT can echo it back. */
  author?: { nickname?: string; display_name?: string };
}

/** Minimal slice of the `POST /pullrequests` create response we read: the new
 *  PR's numeric `id` and the `links.html.href` web URL we hand back so the
 *  user can open the PR. */
interface BitbucketCreatedPullRequest {
  id?: number;
  links?: { html?: { href?: string } };
}

/** Minimal slice of `GET /workspaces/{workspace}/members` we read for the
 *  workspace member search. Each entry has a `user` with `account_id`, `uuid`,
 *  `display_name`, and `links.avatar.href`. */
interface BitbucketWorkspaceMember {
  user?: {
    account_id?: string;
    uuid?: string;
    display_name?: string;
    links?: { avatar?: { href?: string } };
  };
}

interface BitbucketWorkspaceMemberListResponse {
  values?: BitbucketWorkspaceMember[];
}

/** Minimal slice of `GET /2.0/user` we read. Bitbucket's OpenAPI spec types the
 *  response as its `account` schema (documenting `display_name` and `uuid`),
 *  which the `user` schema extends with `account_id` and `nickname`; both
 *  schemas are `additionalProperties: true`, and this reads only the four
 *  fields it needs. Every one is optional here because a partial serialization
 *  must degrade to an empty string, never to a thrown property access. */
interface BitbucketAccount {
  account_id?: string;
  nickname?: string;
  display_name?: string;
  uuid?: string;
}

/** Bitbucket's documented error envelope: `{ "type": "error", "error": {
 *  "message": "...", "fields": { "<field>": ["<reason>", ...] } } }`. We read
 *  `error.message` AND `error.fields` to enrich the sanitized status message on
 *  a non-2xx response.
 *
 *  `fields` is where the ACTUAL cause of a rejected write lives. A bad reviewer
 *  list, for instance, comes back as a 400 whose `error.message` is a generic
 *  validation blurb while `fields.reviewers` carries the real reason ("<name>
 *  is not a member of this repository"). Reading only `message` is what made
 *  those failures surface as a bare `unknown-error: 400 Bad Request`. */
interface BitbucketErrorEnvelope {
  error?: {
    message?: string;
    /** Per-field rejection reasons. Bitbucket sends an array of strings per
     *  field, but a bare string is tolerated here rather than assumed against. */
    fields?: Record<string, unknown>;
  };
}

/**
 * Bitbucket Cloud PR-comments client. Cheap to construct — holds no token
 * state; each operation re-reads the token list from the bridge so a cleared or
 * reordered list is honored without rebuilding the client.
 *
 * `email` is read from the same workspace-state field the rest of the
 * extension uses (`integration.atlassian-suite::email`) via the
 * `getAtlassianSetting` callback. The bridge supplies the ordered Bitbucket
 * token list via `getBitbucketTokens()` (a Phase 1 accessor — no new bridge
 * method is added here). The workspace slug is read the same way as `email`.
 */
export class BitbucketPrClient {
  /**
   * In-host mutex serializing PR-comment capture appends. See
   * `appendCaptureRecords` for why a read-modify-write on a shared file needs
   * one. Instance-scoped, which is sufficient because `extension.ts` builds
   * exactly one long-lived client and every bridge request routes through it.
   */
  private captureChain: Promise<void> = Promise.resolve();

  /**
   * Process-lifetime cache of the token's own Bitbucket identity. See
   * `getCurrentUser` for the full contract; the two invariants that matter are
   * that ONLY a `status: 'ok'` result is ever stored here, and that nothing
   * clears it — the account behind a token cannot change while the extension
   * host lives, and the answer is wanted once per eligibility check rather than
   * once per session.
   */
  private currentUserCache?: BitbucketCurrentUserResult;

  /**
   * The in-flight `getCurrentUser` call, so N concurrent callers make ONE
   * request instead of N. The bridge server handles overlapping requests
   * happily, so a per-comment eligibility check would otherwise fire a burst of
   * identical `/user` calls at an API that rate-limits. Cleared when the call
   * settles, which is also what makes a FAILURE retryable rather than sticky.
   */
  private currentUserInFlight?: Promise<BitbucketCurrentUserResult>;

  constructor(
    private readonly bridge: AtlassianBridge,
    private readonly getAtlassianSetting: (fieldKey: string) => string,
    /**
     * Absolute path of the PR-comment CAPTURE file, computed in `extension.ts`
     * from `context.globalStorageUri` — the same value the Session Manifest
     * injects for the agent, so host and agent point at one file.
     *
     * It is injected rather than derived here for the reason the old prose log
     * failed: that log's path was a RELATIVE string an agent had to guess at, so
     * it resolved against whatever cwd the agent happened to have (i.e. the work
     * repo). A host-resolved absolute path removes the guess entirely. Optional
     * only so a client constructed without it (a test, a future caller) still
     * compiles — `capturePullRequestComments` refuses rather than inventing a
     * fallback location.
     */
    private readonly prCommentCapturePath?: string,
  ) {}

  // ─── Public API ───────────────────────────────────────────────────────

  /**
   * Resolve the open PR for a branch. Thin convenience wrapper that proxies
   * to `AtlassianClient.findOpenPrForBranch` so PR-comments callers do not
   * reach across into `AtlassianClient` directly. The PR-comments flow needs
   * the PR id to scope every subsequent comments call, so co-locating the
   * lookup here keeps the agent-side caller graph clean.
   */
  async findOpenPrForBranch(repoSlug: string, branch: string): Promise<PrLookupResult> {
    const { email, workspace, tokens } = await this.readAuthContext();
    // Hand the full token list to `AtlassianClient`, which runs the SAME shared
    // failover loop (and shares the cursor) for its Bitbucket lookup.
    const client = new AtlassianClient({
      email,
      bitbucketTokens: tokens,
      jiraBase: '',
      bitbucketWorkspace: workspace,
    });
    return client.findOpenPrForBranch(repoSlug, branch);
  }

  /**
   * `GET /2.0/repositories/{workspace}/{repo_slug}/pullrequests/{pr_id}/comments`.
   *
   * Follows the `next` pagination link up to `COMMENT_PAGE_CAP` total
   * comments. Deleted comments are dropped (Bitbucket returns
   * `deleted: true` tombstones). Inline + general comments are returned in a
   * single array, each tagged with `kind`. Both resolved and unresolved
   * threads are included — the `resolved` flag lets the caller decide.
   */
  async listPullRequestComments(
    repoSlug: string,
    prId: number,
  ): Promise<PrCommentListResult> {
    if (!repoSlug || !Number.isFinite(prId)) {
      return { status: 'not-found', comments: [], message: 'Missing repo or PR id' };
    }
    const { email, workspace, tokens, missing } = await this.readAuthContext();
    if (missing) return { status: 'unauthorized', comments: [], message: missing };

    // The ENTIRE pagination walk runs inside the failover callback so a failed
    // page on token A restarts the whole list from page 1 on token B, with the
    // auth header rebuilt from token B for every page.
    return this.runWithFailover(email, tokens, async (auth): Promise<PrCommentListResult> => {
      const comments: PrComment[] = [];
      let nextUrl: string | undefined =
        `${BITBUCKET_BASE_URL}/repositories/${encodeURIComponent(workspace)}` +
        `/${encodeURIComponent(repoSlug)}/pullrequests/${encodeURIComponent(String(prId))}/comments?pagelen=50`;
      // Three independent stop conditions, each recorded separately so the
      // returned message names the ACTUAL reason the walk ended. Reporting
      // "hit the 200-comment cap" when we really ran out of time would send a
      // reader looking at the wrong knob.
      let stopReason: 'comment-cap' | 'page-cap' | 'time-budget' | undefined;
      let totalAvailable: number | undefined;
      let pages = 0;
      const deadline = Date.now() + COMMENT_WALK_BUDGET_MS;

      while (nextUrl) {
        // Checked BEFORE issuing the request, not after: starting a page we
        // know we are out of time for would overshoot the budget by a further
        // REQUEST_TIMEOUT_MS plus its retry budget.
        if (pages > 0 && Date.now() >= deadline) {
          stopReason = 'time-budget';
          break;
        }
        if (pages >= MAX_COMMENT_PAGES) {
          stopReason = 'page-cap';
          break;
        }
        const res = await this.request(nextUrl, 'GET', auth);
        if (!res.ok) return { status: res.status, comments: [], message: res.message, retryAfter: res.retryAfter };
        pages++;
        const body = res.body as BitbucketCommentListResponse | undefined;
        // Bitbucket repeats `size` on every page; take it from the first page
        // that reports it so an honest "N of M" survives a partial walk.
        if (totalAvailable === undefined && typeof body?.size === 'number' && Number.isFinite(body.size)) {
          totalAvailable = body.size;
        }
        const values = Array.isArray(body?.values) ? body!.values : [];
        for (const raw of values) {
          if (raw?.deleted === true) continue;
          const normalized = this.normalizeComment(raw);
          if (normalized) comments.push(normalized);
          if (comments.length >= COMMENT_PAGE_CAP) {
            stopReason = 'comment-cap';
            break;
          }
        }
        if (stopReason) break;
        nextUrl = typeof body?.next === 'string' ? body.next : undefined;
      }

      const result: PrCommentListResult = { status: 'ok', comments, truncated: stopReason !== undefined };
      if (stopReason) {
        const scope = totalAvailable !== undefined
          ? `${comments.length} of ~${totalAvailable} comments fetched`
          : `${comments.length} comments fetched`;
        const why = stopReason === 'comment-cap'
          ? `hit the ${COMMENT_PAGE_CAP}-comment cap`
          : stopReason === 'page-cap'
            ? `hit the ${MAX_COMMENT_PAGES}-page cap`
            : `ran out of the ${Math.round(COMMENT_WALK_BUDGET_MS / 1000)}s fetch budget after ${pages} page(s)`;
        // Kept character-for-character parallel with the truncation message in
        // `atlassian-client.ts` — same template, same `N of ~M` scope phrasing,
        // same trailing sentence — so the two comment reads speak one dialect.
        //
        // The trailing sentence deliberately does NOT claim WHICH comments were
        // dropped. An earlier revision of this line asserted "Newest comments
        // are included; older ones were omitted", which was an assumption about
        // Bitbucket's default comment ordering that had never been verified
        // against the API. A confident claim about which half of the data the
        // operator is missing is worse than no claim at all, because it is
        // acted upon. If the ordering is ever established, say it then.
        result.message = `Partial result — ${scope}; ${why}. The remaining comments were omitted.`;
      }
      if (totalAvailable !== undefined) result.totalAvailable = totalAvailable;
      return result;
    });
  }

  /**
   * CAPTURE a PR's comments to disk as JSON Lines — one
   * `PrCommentCaptureRecord` per comment — for the per-project reviewer dossier.
   *
   * This is stage one (capture) of "learn what each reviewer reliably nitpicks".
   * It is deliberately code, not prose: the capability it replaces was a set of
   * declared settings with no implementation behind them, so nothing was ever
   * written.
   *
   * WHAT IT DOES NOT DO, and why:
   *   - It does NOT re-fetch comments by some new path. It calls
   *     `listPullRequestComments` and normalizes through the same
   *     `normalizeComment`, so capture and the agent-facing `list-comments` can
   *     never disagree about what a comment IS.
   *   - It does NOT judge, filter, or interpret. EVERY comment the list returns
   *     is captured — agreed-with, disagreed-with, resolved, unresolved, bot,
   *     human. That is the whole point: the prose log this supersedes only ever
   *     recorded comments we protested, because the only code path that reached
   *     it was the protest reply, which silently inverted the training signal.
   *   - It does NOT mutate anything in Bitbucket. The only write is the local
   *     append below. It is still classified as a MUTATION end to end (it is
   *     absent from `RETRYABLE_ROUTES` in `scripts/bb-bridge.mjs`) so nothing
   *     replays it blindly.
   *
   * Append semantics, de-duplication, and the size bound are described on
   * `appendCaptureRecords` and `CAPTURE_FILE_MAX_BYTES`. Bodies are redacted and
   * clamped on the way in — see `redactCapturedText`.
   *
   * A truncated LIST yields a truncated CAPTURE, flagged rather than failed: a
   * prefix of a large PR's comments is real dossier signal, and discarding it
   * because it is incomplete would lose the most comment-heavy PRs, which are
   * exactly the ones worth learning from.
   */
  async capturePullRequestComments(args: {
    repoSlug: string;
    prId: number;
  }): Promise<PrCommentCaptureResult> {
    if (!args.repoSlug || !Number.isFinite(args.prId)) {
      return { status: 'not-found', message: 'Missing repo or PR id' };
    }
    const filePath = this.prCommentCapturePath;
    if (!filePath) {
      // Deliberately NOT a guessed default. Writing to a relative path is the
      // exact defect this path exists to avoid.
      return {
        status: 'unknown-error',
        message: 'No PR-comment capture path is configured host-side; nothing was written.',
      };
    }

    const listed = await this.listPullRequestComments(args.repoSlug, args.prId);
    if (listed.status !== 'ok') {
      // Surface the read's OWN failure verbatim. Capture never invents a status.
      return { status: listed.status, message: listed.message, retryAfter: listed.retryAfter };
    }

    const { email, workspace, tokens, missing } = await this.readAuthContext();
    if (missing) return { status: 'unauthorized', message: missing };

    // PR author — one extra GET, and NON-FATAL. The comments are already in
    // hand; losing the author handle degrades one field, and failing the whole
    // capture over it would throw away every comment we successfully read.
    const prUrl =
      `${BITBUCKET_BASE_URL}/repositories/${encodeURIComponent(workspace)}` +
      `/${encodeURIComponent(args.repoSlug)}/pullrequests/${encodeURIComponent(String(args.prId))}`;
    const authorLookup = await this.runWithFailover(
      email,
      tokens,
      async (auth): Promise<{ status: BitbucketPrStatus; handle: string }> => {
        const res = await this.request(prUrl, 'GET', auth);
        if (!res.ok) return { status: res.status, handle: '' };
        const pr = res.body as BitbucketPullRequest | undefined;
        const nickname = typeof pr?.author?.nickname === 'string' ? pr.author.nickname : '';
        const display = typeof pr?.author?.display_name === 'string' ? pr.author.display_name : '';
        return { status: 'ok', handle: nickname || display };
      },
    );
    const prAuthor = authorLookup.status === 'ok' ? authorLookup.handle : '';

    const ts = new Date().toISOString();
    const project = deriveProjectKey(args.repoSlug);
    const records: PrCommentCaptureRecord[] = listed.comments.map((c) => {
      const record: PrCommentCaptureRecord = {
        ts,
        platform: 'bitbucket',
        project,
        repoSlug: args.repoSlug,
        prId: args.prId,
        prAuthor,
        commentId: c.id,
        parentId: c.parentId,
        kind: c.kind,
        author: { displayName: c.author.displayName, accountId: c.author.accountId },
        // Redact BEFORE clamping so the clamp can never bisect a credential and
        // leave its tail behind unmatched.
        body: clampCapturedBody(redactCapturedText(c.body)),
        resolved: c.resolved,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      };
      if (c.inline) {
        record.inline = c.inline.from !== undefined
          ? { path: c.inline.path, to: c.inline.to, from: c.inline.from }
          : { path: c.inline.path, to: c.inline.to };
      }
      // Same conditional-assignment rule as the rest of this record: an unknown
      // outdated state leaves the key off the JSONL line entirely rather than
      // recording a `false` we did not observe.
      if (c.outdated !== undefined) record.outdated = c.outdated;
      return record;
    });

    const write = await this.appendCaptureRecords(filePath, records);
    if (!write.ok) {
      return { status: 'unknown-error', filePath, project, message: write.message };
    }

    // Assemble one message out of every non-fatal note this call produced, so a
    // partial list, a missing author, and a rotation are all visible at once
    // rather than the last one winning.
    const notes: string[] = [];
    if (listed.message) notes.push(listed.message);
    if (authorLookup.status !== 'ok') {
      notes.push('PR author could not be read, so `prAuthor` is empty on these records.');
    }
    if (write.rotated) {
      notes.push(`Capture file exceeded ${Math.round(CAPTURE_FILE_MAX_BYTES / (1024 * 1024))} MB and was rotated to ${path.basename(filePath)}.1 before this append.`);
    }
    if (write.note) notes.push(write.note);

    const result: PrCommentCaptureResult = {
      status: 'ok',
      filePath,
      project,
      captured: write.written,
      skipped: write.skipped,
      total: records.length,
      truncated: listed.truncated === true,
    };
    if (notes.length > 0) result.message = notes.join(' ');
    return result;
  }

  /**
   * `POST /2.0/repositories/{workspace}/{repo_slug}/pullrequests/{pr_id}/comments`
   * with `{ content: { raw }, parent: { id }, inline? }`.
   *
   * When `inline` is supplied the reply lands as an inline comment anchored
   * to the same file/line as the parent; without it the reply lands in the
   * general thread. Callers should echo the parent's `inline` block when
   * replying to inline comments to preserve thread anchoring in Bitbucket's
   * UI.
   */
  async replyToComment(args: {
    repoSlug: string;
    prId: number;
    parentId: number;
    body: string;
    inline?: { path: string; to: number; from?: number };
  }): Promise<PrReplyResult> {
    if (!args.repoSlug || !Number.isFinite(args.prId) || !Number.isFinite(args.parentId)) {
      return { status: 'not-found', message: 'Missing repo, PR id, or parent id' };
    }
    if (!args.body) {
      return { status: 'unknown-error', message: 'Reply body is empty' };
    }
    const { email, workspace, tokens, missing } = await this.readAuthContext();
    if (missing) return { status: 'unauthorized', message: missing };

    const url =
      `${BITBUCKET_BASE_URL}/repositories/${encodeURIComponent(workspace)}` +
      `/${encodeURIComponent(args.repoSlug)}/pullrequests/${encodeURIComponent(String(args.prId))}/comments`;
    const payload: {
      content: { raw: string };
      parent: { id: number };
      inline?: { path: string; to: number; from?: number };
    } = {
      content: { raw: args.body },
      parent: { id: args.parentId },
    };
    if (args.inline) {
      const inlinePayload: { path: string; to: number; from?: number } = {
        path: args.inline.path,
        to: args.inline.to,
      };
      if (args.inline.from !== undefined) inlinePayload.from = args.inline.from;
      payload.inline = inlinePayload;
    }

    return this.runWithFailover(email, tokens, async (auth): Promise<PrReplyResult> => {
      const res = await this.request(url, 'POST', auth, payload);
      if (!res.ok) return { status: res.status, message: res.message, retryAfter: res.retryAfter };
      const body = res.body as BitbucketComment | undefined;
      const id = typeof body?.id === 'number' ? body.id : undefined;
      return { status: 'ok', commentId: id };
    });
  }

  /**
   * `POST /2.0/repositories/{workspace}/{repo_slug}/pullrequests/{pr_id}/comments`
   * with `{ content: { raw } }` and NOTHING else.
   *
   * Creates a STANDALONE, top-level, general (non-inline) PR comment. This is
   * the exact mirror of `replyToComment` minus the two keys that change where
   * the comment lands: sending `parent` makes it a threaded reply, sending
   * `inline` makes it a file/line-anchored comment — so both are deliberately
   * omitted from the payload here. That top-level placement is what makes
   * bot-trigger comments (e.g. `@coderabbitai review`) actually fire, since
   * those bots only read top-level comments. Like the other writes this needs
   * the token to carry PR write permission (`write:pullrequest:bitbucket`, or
   * an App Password with "Pull requests: Write") — a 403 here means that scope
   * is missing, and its message carries Bitbucket's own reason text.
   */
  async createComment(args: {
    repoSlug: string;
    prId: number;
    body: string;
  }): Promise<PrCommentCreateResult> {
    if (!args.repoSlug || !Number.isFinite(args.prId)) {
      return { status: 'not-found', message: 'Missing repo or PR id' };
    }
    if (!args.body || !args.body.trim()) {
      return { status: 'unknown-error', message: 'Comment body is empty' };
    }
    const { email, workspace, tokens, missing } = await this.readAuthContext();
    if (missing) return { status: 'unauthorized', message: missing };

    const url =
      `${BITBUCKET_BASE_URL}/repositories/${encodeURIComponent(workspace)}` +
      `/${encodeURIComponent(args.repoSlug)}/pullrequests/${encodeURIComponent(String(args.prId))}/comments`;
    // No `parent` key and no `inline` key — including either one is precisely
    // what would turn this into a threaded reply / inline comment.
    const payload: { content: { raw: string } } = {
      content: { raw: args.body },
    };

    return this.runWithFailover(email, tokens, async (auth): Promise<PrCommentCreateResult> => {
      const res = await this.request(url, 'POST', auth, payload);
      if (!res.ok) return { status: res.status, message: res.message, retryAfter: res.retryAfter };
      const body = res.body as BitbucketComment | undefined;
      const id = typeof body?.id === 'number' ? body.id : undefined;
      return { status: 'ok', commentId: id };
    });
  }

  /**
   * `POST /2.0/repositories/{workspace}/{repo_slug}/pullrequests/{pr_id}/comments/{comment_id}/resolve`.
   *
   * Marks the comment thread resolved. Bitbucket Cloud resolves a comment
   * thread with `POST` to the `/resolve` endpoint (and reopens/unresolves it
   * with `DELETE` to the same endpoint — not implemented here). Bitbucket
   * returns the updated comment shape on success; we only surface the status to
   * the caller because the agent-side flow does not need the post-resolve body.
   * The write requires the token to carry PR write permission
   * (`write:pullrequest:bitbucket`, or an App Password with "Pull requests:
   * Write") — a 403 here means that scope is missing.
   */
  async resolveComment(args: {
    repoSlug: string;
    prId: number;
    commentId: number;
  }): Promise<PrResolveResult> {
    if (
      !args.repoSlug ||
      !Number.isFinite(args.prId) ||
      !Number.isFinite(args.commentId)
    ) {
      return { status: 'not-found', message: 'Missing repo, PR id, or comment id' };
    }
    const { email, workspace, tokens, missing } = await this.readAuthContext();
    if (missing) return { status: 'unauthorized', message: missing };

    const url =
      `${BITBUCKET_BASE_URL}/repositories/${encodeURIComponent(workspace)}` +
      `/${encodeURIComponent(args.repoSlug)}/pullrequests/${encodeURIComponent(String(args.prId))}` +
      `/comments/${encodeURIComponent(String(args.commentId))}/resolve`;

    return this.runWithFailover(email, tokens, async (auth): Promise<PrResolveResult> => {
      const res = await this.request(url, 'POST', auth);
      if (!res.ok) return { status: res.status, message: res.message, retryAfter: res.retryAfter };
      return { status: 'ok' };
    });
  }

  /**
   * `DELETE /2.0/repositories/{workspace}/{repo_slug}/pullrequests/{pr_id}/comments/{comment_id}`.
   *
   * Permanently deletes a PR comment. The exact mirror of `resolveComment`
   * except it targets the comment resource itself (no `/resolve` suffix) with
   * `DELETE` and sends no body. Bitbucket returns `204 No Content` on success,
   * which `request()` treats as a 2xx with an empty (`undefined`) body; we only
   * surface the status. Like the other writes this needs the token to carry PR
   * write permission (`write:pullrequest:bitbucket`, or an App Password with
   * "Pull requests: Write") — a 403 here means that scope is missing, and its
   * message now carries Bitbucket's own reason text.
   */
  async deleteComment(args: {
    repoSlug: string;
    prId: number;
    commentId: number;
  }): Promise<PrDeleteResult> {
    if (
      !args.repoSlug ||
      !Number.isFinite(args.prId) ||
      !Number.isFinite(args.commentId)
    ) {
      return { status: 'not-found', message: 'Missing repo, PR id, or comment id' };
    }
    const { email, workspace, tokens, missing } = await this.readAuthContext();
    if (missing) return { status: 'unauthorized', message: missing };

    const url =
      `${BITBUCKET_BASE_URL}/repositories/${encodeURIComponent(workspace)}` +
      `/${encodeURIComponent(args.repoSlug)}/pullrequests/${encodeURIComponent(String(args.prId))}` +
      `/comments/${encodeURIComponent(String(args.commentId))}`;

    return this.runWithFailover(email, tokens, async (auth): Promise<PrDeleteResult> => {
      const res = await this.request(url, 'DELETE', auth);
      if (!res.ok) return { status: res.status, message: res.message, retryAfter: res.retryAfter };
      return { status: 'ok' };
    });
  }

  /**
   * Flip a draft PR to ready-for-review by clearing its `draft` flag.
   *
   * `GET /2.0/repositories/{workspace}/{repo_slug}/pullrequests/{pr_id}` then
   * `PUT` the same URL with the current PR echoed back and `draft: false`. We
   * always GET-then-PUT for predictability, and echo `title` + `description`
   * back (via `buildEchoPayload`) because Bitbucket's PUT-pullrequest endpoint
   * treats the body as a full update: it can reject the request with a 400 when
   * `title` is omitted, and omitting `description` would clear it. Only the
   * status is surfaced — the post-update PR body is not needed by the agent flow.
   */
  async markPrReady(args: { repoSlug: string; prId: number }): Promise<PrReadyResult> {
    if (!args.repoSlug || !Number.isFinite(args.prId)) {
      return { status: 'not-found', message: 'Missing repo or PR id' };
    }
    const { email, workspace, tokens, missing } = await this.readAuthContext();
    if (missing) return { status: 'unauthorized', message: missing };

    const url =
      `${BITBUCKET_BASE_URL}/repositories/${encodeURIComponent(workspace)}` +
      `/${encodeURIComponent(args.repoSlug)}/pullrequests/${encodeURIComponent(String(args.prId))}`;

    // GET-then-PUT run inside ONE failover attempt so both requests use the same
    // token; if either fails, the whole ready-flip retries on the next token.
    return this.runWithFailover(email, tokens, async (auth): Promise<PrReadyResult> => {
      const getRes = await this.request(url, 'GET', auth);
      if (!getRes.ok) return { status: getRes.status, message: getRes.message, retryAfter: getRes.retryAfter };
      const current = getRes.body as BitbucketPullRequest | undefined;

      const putRes = await this.request(url, 'PUT', auth, this.buildEchoPayload(current, { draft: false }));
      if (!putRes.ok) return { status: putRes.status, message: putRes.message, retryAfter: putRes.retryAfter };
      return { status: 'ok' };
    });
  }

  /**
   * Flip a ready PR back to draft by setting its `draft` flag. The exact mirror
   * of `markPrReady`: `GET` the PR to echo its current `title` + `description`
   * back (Bitbucket's PUT-pullrequest endpoint treats the body as a full update
   * — it 400s when `title` is omitted and clears `description` when that is
   * omitted), then `PUT` that with `draft: true`. Only the status is surfaced.
   * Like the ready flip, this needs the `write:pullrequest:bitbucket` scope.
   */
  async markPrDraft(args: { repoSlug: string; prId: number }): Promise<PrDraftResult> {
    if (!args.repoSlug || !Number.isFinite(args.prId)) {
      return { status: 'not-found', message: 'Missing repo or PR id' };
    }
    const { email, workspace, tokens, missing } = await this.readAuthContext();
    if (missing) return { status: 'unauthorized', message: missing };

    const url =
      `${BITBUCKET_BASE_URL}/repositories/${encodeURIComponent(workspace)}` +
      `/${encodeURIComponent(args.repoSlug)}/pullrequests/${encodeURIComponent(String(args.prId))}`;

    // GET-then-PUT run inside ONE failover attempt so both requests use the same
    // token; if either fails, the whole draft-flip retries on the next token.
    return this.runWithFailover(email, tokens, async (auth): Promise<PrDraftResult> => {
      const getRes = await this.request(url, 'GET', auth);
      if (!getRes.ok) return { status: getRes.status, message: getRes.message, retryAfter: getRes.retryAfter };
      const current = getRes.body as BitbucketPullRequest | undefined;

      const putRes = await this.request(url, 'PUT', auth, this.buildEchoPayload(current, { draft: true }));
      if (!putRes.ok) return { status: putRes.status, message: putRes.message, retryAfter: putRes.retryAfter };
      return { status: 'ok' };
    });
  }

  /**
   * `POST /2.0/repositories/{workspace}/{repo_slug}/pullrequests` with
   * `{ title, source: { branch: { name } }, destination: { branch: { name } },
   *    description, draft }`.
   *
   * Creates a new pull request from `sourceBranch` into `targetBranch`. On
   * success returns the created PR's numeric `id` and its web URL
   * (`links.html.href`) so the caller can report/open it. Required inputs
   * (`repoSlug`, `title`, `sourceBranch`, `targetBranch`) are validated before
   * any request is made, mirroring `replyToComment`; a missing workspace /
   * token / credential is surfaced as `unauthorized` with a `Missing: ...`
   * message. The token is never echoed.
   *
   * `reviewers` is optional and omitted from the payload entirely when absent
   * or empty, so the no-reviewer create is byte-identical to what shipped
   * before. Its identity shape is `PrReviewer` — see that type for the
   * account_id-vs-uuid uncertainty and the one-line fallback. Note also that
   * Bitbucket fails the WHOLE create (400) rather than dropping one entry when
   * a reviewer is invalid — e.g. when the authenticated author appears in their
   * own reviewer list — so the per-field reason surfaced by
   * `extractErrorDetail` is what tells the caller which entry was rejected.
   */
  async createPullRequest(args: {
    repoSlug: string;
    title: string;
    sourceBranch: string;
    targetBranch: string;
    description?: string;
    draft?: boolean;
    /** See `PrReviewer` — the account_id-vs-uuid contract is unverified. */
    reviewers?: PrReviewer[];
  }): Promise<PrCreateResult> {
    if (!args.repoSlug || !args.title || !args.sourceBranch || !args.targetBranch) {
      const missingInputs: string[] = [];
      if (!args.repoSlug) missingInputs.push('repoSlug');
      if (!args.title) missingInputs.push('title');
      if (!args.sourceBranch) missingInputs.push('sourceBranch');
      if (!args.targetBranch) missingInputs.push('targetBranch');
      return { status: 'unauthorized', message: `Missing: ${missingInputs.join(', ')}` };
    }
    const { email, workspace, tokens, missing } = await this.readAuthContext();
    if (missing) return { status: 'unauthorized', message: missing };

    const url =
      `${BITBUCKET_BASE_URL}/repositories/${encodeURIComponent(workspace)}` +
      `/${encodeURIComponent(args.repoSlug)}/pullrequests`;
    const payload: {
      title: string;
      source: { branch: { name: string } };
      destination: { branch: { name: string } };
      description?: string;
      draft?: boolean;
      reviewers?: PrReviewer[];
    } = {
      title: args.title,
      source: { branch: { name: args.sourceBranch } },
      destination: { branch: { name: args.targetBranch } },
    };
    if (args.description !== undefined) payload.description = args.description;
    if (args.draft !== undefined) payload.draft = args.draft;
    if (Array.isArray(args.reviewers) && args.reviewers.length > 0) payload.reviewers = args.reviewers;

    return this.runWithFailover(email, tokens, async (auth): Promise<PrCreateResult> => {
      const res = await this.request(url, 'POST', auth, payload);
      if (!res.ok) return { status: res.status, message: res.message, retryAfter: res.retryAfter };
      const body = res.body as BitbucketCreatedPullRequest | undefined;
      const prId = typeof body?.id === 'number' ? body.id : undefined;
      const href = typeof body?.links?.html?.href === 'string' ? body.links.html.href : undefined;
      return { status: 'ok', prId, url: href };
    });
  }

  /**
   * `PUT /2.0/repositories/{workspace}/{repo_slug}/pullrequests/{pr_id}` with
   * the fields to update.
   *
   * Updates an existing pull request. Accepts any combination of `title`,
   * `description`, and `reviewers`; at least one must be provided. Bitbucket's
   * PUT-pullrequest endpoint treats the body as a full update and can reject
   * the request with a 400 when `title` is omitted, so this method GETs the
   * current PR first and echoes back EVERY field the caller did not supply —
   * `title`, `description`, and `draft` — the same pattern `markPrReady` /
   * `markPrDraft` use. Echoing all three is what makes `update-pr --reviewers`
   * alone safe: without it, a full-update PUT would blank the description and
   * flip a draft PR to ready-for-review as a side effect of setting reviewers.
   * If Bitbucket's PUT is in fact a partial update, echoing a field back to its
   * current value is a harmless no-op — so this is correct either way, which is
   * the point.
   *
   * `title` is only sent when a non-empty one is available (caller's, else the
   * GET's). An empty-string fallback would push a blank title onto the PR on
   * the very responses it was meant to protect against.
   *
   * This is a PUT (mutation): callers must NOT add `/update-pr` to
   * `RETRYABLE_ROUTES` in `bb-bridge.mjs`, and the `'indeterminate'` status is
   * handled the same way as the other write operations.
   */
  async updatePullRequest(args: {
    repoSlug: string;
    prId: number;
    title?: string;
    description?: string;
    /** See `PrReviewer` — the account_id-vs-uuid contract is unverified.
     *  REPLACES the PR's reviewer list wholesale; always pass the complete
     *  desired set, never a delta. */
    reviewers?: PrReviewer[];
  }): Promise<PrUpdateResult> {
    if (!args.repoSlug || !Number.isFinite(args.prId)) {
      return { status: 'not-found', message: 'Missing repo or PR id' };
    }
    const { email, workspace, tokens, missing } = await this.readAuthContext();
    if (missing) return { status: 'unauthorized', message: missing };

    const url =
      `${BITBUCKET_BASE_URL}/repositories/${encodeURIComponent(workspace)}` +
      `/${encodeURIComponent(args.repoSlug)}/pullrequests/${encodeURIComponent(String(args.prId))}`;

    // GET-then-PUT inside ONE failover attempt so both requests use the same
    // token; if either fails, the whole update retries on the next token.
    return this.runWithFailover(email, tokens, async (auth): Promise<PrUpdateResult> => {
      const getRes = await this.request(url, 'GET', auth);
      if (!getRes.ok) return { status: getRes.status, message: getRes.message, retryAfter: getRes.retryAfter };
      const current = getRes.body as BitbucketPullRequest | undefined;

      const payload = this.buildEchoPayload(current, {
        title: args.title,
        description: args.description,
      });
      if (Array.isArray(args.reviewers)) payload.reviewers = args.reviewers;

      const putRes = await this.request(url, 'PUT', auth, payload);
      if (!putRes.ok) return { status: putRes.status, message: putRes.message, retryAfter: putRes.retryAfter };
      return { status: 'ok' };
    });
  }

  /**
   * `GET /2.0/workspaces/{workspace}/members`.
   *
   * Returns workspace members (up to 100, one page). When `query` is provided,
   * filters results client-side by case-insensitive substring match on
   * `display_name`. This is a read-only GET, safe to retry on failure.
   *
   * When `workspace` is omitted, falls back to the configured
   * `bitbucketWorkspace` setting, the same way `findOpenPrForBranch` resolves
   * its workspace.
   */
  async searchWorkspaceMembers(args: {
    workspace: string;
    query?: string;
  }): Promise<WorkspaceMemberResult> {
    const { email, workspace: configuredWorkspace, tokens, missing } = await this.readAuthContext();
    if (missing) return { status: 'unauthorized', message: missing };
    const workspace = args.workspace || configuredWorkspace;
    if (!workspace) {
      return { status: 'not-found', message: 'Missing workspace' };
    }

    const url =
      `${BITBUCKET_BASE_URL}/workspaces/${encodeURIComponent(workspace)}/members?pagelen=100`;

    return this.runWithFailover(email, tokens, async (auth): Promise<WorkspaceMemberResult> => {
      const res = await this.request(url, 'GET', auth);
      // `'indeterminate'` is never produced for a GET — safe to narrow.
      if (!res.ok) return { status: res.status as WorkspaceMemberResult['status'], message: res.message };
      const body = res.body as BitbucketWorkspaceMemberListResponse | undefined;
      const values = Array.isArray(body?.values) ? body!.values : [];

      let members: WorkspaceMember[] = [];
      for (const entry of values) {
        const accountId = typeof entry?.user?.account_id === 'string' ? entry.user.account_id : '';
        // Captured alongside `accountId`, never in place of it: the reviewer
        // identity Bitbucket actually accepts on `POST /pullrequests` is
        // unverified (see `createPullRequest`), and re-fetching members just to
        // learn a uuid would be a second API call at the worst moment.
        const uuid = typeof entry?.user?.uuid === 'string' ? entry.user.uuid : '';
        const displayName = typeof entry?.user?.display_name === 'string' ? entry.user.display_name : '';
        const avatarUrl = typeof entry?.user?.links?.avatar?.href === 'string' ? entry.user.links.avatar.href : '';
        if (!accountId) continue;
        members.push({ accountId, uuid, displayName, avatarUrl });
      }

      if (args.query) {
        const q = args.query.toLowerCase();
        members = members.filter((m) => m.displayName.toLowerCase().includes(q));
      }

      return { status: 'ok', members };
    });
  }

  /**
   * `GET /2.0/user` — the Bitbucket identity of the API TOKEN we call with.
   *
   * This is the Bitbucket counterpart of `AtlassianClient.validateJira`'s
   * `/rest/api/3/myself` call, and until now the repo had no equivalent: there
   * was no way to learn WHO a comment posted through this client is authored
   * by, so "is this comment ours?" was unanswerable. See `BitbucketCurrentUser`
   * for why the `bitbucketUsername` setting could not answer it.
   *
   * Shape and plumbing are copied from `searchWorkspaceMembers` deliberately:
   * same `readAuthContext` short-circuit, same `runWithFailover(email, tokens,
   * ...)` wrapper, same single `this.request(url, 'GET', auth)`, same status
   * passthrough, same narrowing cast on the failure branch (a GET never yields
   * `'indeterminate'`).
   *
   * CACHING. The answer cannot change while this process lives — the tokens are
   * fixed strings and an Atlassian account id is immutable — while the caller
   * that wants it (a per-comment ownership check) would otherwise ask once per
   * comment. So:
   *   - a `'ok'` result is stored in `currentUserCache` and returned to every
   *     later caller without another request;
   *   - a FAILURE IS NEVER CACHED. An expired token, a rate limit, or a dropped
   *     link would otherwise poison the identity for the rest of the session and
   *     make every subsequent check fail for a reason that no longer applies.
   *     The next call retries from scratch;
   *   - concurrent callers share one in-flight promise (`currentUserInFlight`),
   *     which is cleared when it settles — so de-duplication never becomes a
   *     second, accidental cache of a failure.
   * There is no invalidation and no TTL, because there is nothing to
   * invalidate: a token swap means a new extension host, which means a new
   * client instance.
   *
   * TWO LIMITS, STATED RATHER THAN DISCOVERED LATER:
   *   1. WITH SEVERAL TOKENS CONFIGURED, THIS IS THE IDENTITY OF WHICHEVER
   *      TOKEN ANSWERED. `withBitbucketFailover` rotates across the whole token
   *      list, and nothing requires those tokens to belong to one account. The
   *      shared cursor is sticky, so in practice one token serves the whole
   *      session and the cached identity is the identity a write would also use
   *      — but that is a strong tendency, not a guarantee. Before anything acts
   *      on "this comment is mine" to DELETE, either confirm the operator runs a
   *      single token or key this per token.
   *   2. `/2.0/user` is a USER endpoint. Bitbucket's own docs note it is not
   *      supported for Access Tokens (repository / project / workspace tokens),
   *      which have no personal identity to return; it is documented for Basic
   *      auth and API tokens, which is what this client sends. A workspace-token
   *      setup would therefore see a 401/403 here while every other verb keeps
   *      working. That is a real configuration, so the failure is surfaced with
   *      its status rather than swallowed.
   *
   * UNVERIFIED AGAINST LIVE BITBUCKET. No authenticated call has been made from
   * this branch. The URL, the auth mechanism and the read scope
   * (`read:user:bitbucket`) come from Bitbucket's published OpenAPI spec; the
   * parsing is covered by a stubbed-fetch test, not by a real response.
   */
  async getCurrentUser(): Promise<BitbucketCurrentUserResult> {
    const cached = this.currentUserCache;
    if (cached) return cached;
    const inFlight = this.currentUserInFlight;
    if (inFlight) return inFlight;

    const run = this.fetchCurrentUser();
    this.currentUserInFlight = run;
    try {
      const result = await run;
      // ONLY a success is remembered. See the CACHING note above.
      if (result.status === 'ok') this.currentUserCache = result;
      return result;
    } finally {
      // Cleared on every path, including a throw. `fetchCurrentUser` returns a
      // typed result rather than throwing, but leaving a settled promise parked
      // here would silently turn a one-off failure into the sticky cache this
      // method exists to avoid.
      this.currentUserInFlight = undefined;
    }
  }

  /** The uncached read behind `getCurrentUser`. Split out so the caching policy
   *  above reads as policy and this reads as the request. */
  private async fetchCurrentUser(): Promise<BitbucketCurrentUserResult> {
    const { email, tokens, missing } = await this.readAuthContext();
    // `readAuthContext` also reports a missing `bitbucketWorkspace`, which this
    // call genuinely does not need — `/2.0/user` is not workspace-scoped. The
    // shared message is still surfaced verbatim rather than being re-derived:
    // an operator missing the workspace is misconfigured for every other verb
    // anyway, and inventing a second, subtly different "Missing: ..." string
    // here would make two reads disagree about the same settings.
    if (missing) return { status: 'unauthorized', message: missing };

    const url = `${BITBUCKET_BASE_URL}/user`;

    return this.runWithFailover(email, tokens, async (auth): Promise<BitbucketCurrentUserResult> => {
      const res = await this.request(url, 'GET', auth);
      // `'indeterminate'` is never produced for a GET — safe to narrow.
      if (!res.ok) return { status: res.status as BitbucketCurrentUserResult['status'], message: res.message };
      const body = res.body as BitbucketAccount | undefined;
      return {
        status: 'ok',
        user: {
          accountId: typeof body?.account_id === 'string' ? body.account_id : '',
          nickname: typeof body?.nickname === 'string' ? body.nickname : '',
          displayName: typeof body?.display_name === 'string' ? body.display_name : '',
          uuid: typeof body?.uuid === 'string' ? body.uuid : '',
        },
      };
    });
  }

  // ─── Internal: capture-file persistence ───────────────────────────────

  /**
   * Append `records` to the capture file as JSON Lines. Returns what actually
   * happened rather than throwing — every caller in this class returns typed
   * results, never exceptions.
   *
   * Three behaviors, in the order they run:
   *
   * 1. ROTATE. If the file already meets `CAPTURE_FILE_MAX_BYTES` it is renamed
   *    to `<file>.1` (replacing any previous generation) and this append starts a
   *    fresh file. This is the ONLY thing that ever removes captured data, and it
   *    retires a whole generation at once — no record is ever edited or
   *    selectively pruned. See `CAPTURE_FILE_MAX_BYTES`.
   *
   * 2. DE-DUPLICATE. The existing file is read and every parseable line's
   *    `captureRecordKey` collected; records already present are skipped. This is
   *    what makes re-capturing the same PR idempotent — a sweep that runs on
   *    every PR-monitor iteration would otherwise write the same comment once per
   *    iteration and drown the dossier in copies of whichever comment sat longest
   *    on the PR. It also means an operator re-running the verb after an
   *    ambiguous timeout cannot double-write, which is why the timeout advice for
   *    this route can say "re-running is safe" where every other write says the
   *    opposite. Unparseable lines are skipped, never rewritten.
   *
   *    NOTE the one gap, stated rather than hidden: de-duplication looks only at
   *    the LIVE file. Records that rotated into `<file>.1` are no longer seen, so
   *    a capture immediately after a rotation can re-append comments that are
   *    still present in the previous generation. That is a bounded, one-time
   *    duplication at a rotation boundary, and it is preferred to reading both
   *    generations on every single append.
   *
   * 3. APPEND. One `JSON.stringify` per record, newline-terminated, in one
   *    `appendFile` call so a partial write cannot interleave mid-record. The
   *    file is created 0600 (owner-only) because it holds third-party comment
   *    prose; the mode is honored on POSIX and is a no-op on Windows.
   */
  private appendCaptureRecords(
    filePath: string,
    records: PrCommentCaptureRecord[],
  ): Promise<{ ok: true; written: number; skipped: number; rotated: boolean; note?: string } | { ok: false; message: string }> {
    // Serialize through the instance chain. The body below is a
    // READ-MODIFY-WRITE (read the file to learn what is already captured, then
    // append what is not), so two captures running concurrently — the bridge's
    // HTTP server happily handles overlapping requests — would BOTH read the
    // pre-append file, both conclude the same records are new, and both write
    // them. Chaining is the same in-host mutex shape the settings panel uses for
    // its feedback-log read-modify-write, and for the same reason. It guards this
    // process against itself only; an out-of-band editor is not covered.
    const run = this.captureChain.then(() => this.appendCaptureRecordsUnlocked(filePath, records));
    // The chain must survive a rejection, or one failure would wedge every later
    // capture. `run` itself never rejects (the body catches), but chaining
    // defensively costs nothing.
    this.captureChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** The actual append. Only ever called from `appendCaptureRecords`, which owns
   *  the serialization. */
  private async appendCaptureRecordsUnlocked(
    filePath: string,
    records: PrCommentCaptureRecord[],
  ): Promise<{ ok: true; written: number; skipped: number; rotated: boolean; note?: string } | { ok: false; message: string }> {
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });

      let rotated = false;
      let note: string | undefined;
      let overSize = false;
      try {
        const stat = await fs.stat(filePath);
        overSize = stat.size >= CAPTURE_FILE_MAX_BYTES;
      } catch {
        // No file yet (or it is unstattable) — nothing to rotate. A genuinely
        // unwritable path surfaces below on the append.
      }
      if (overSize) {
        try {
          await fs.rename(filePath, `${filePath}.1`);
          rotated = true;
        } catch (err) {
          // A FAILED rotation is reported, never swallowed. Swallowing it would
          // leave the file over its bound and silently growing forever — the
          // exact unbounded-growth failure the bound exists to prevent — while
          // every capture kept reporting success. We still append (losing the
          // capture would be worse than exceeding the bound) and say so.
          note = `Capture file is over its ${Math.round(CAPTURE_FILE_MAX_BYTES / (1024 * 1024))} MB bound but could not be rotated `
            + `(${err instanceof Error ? err.message : String(err)}); it will keep growing until this is resolved.`;
        }
      }

      const seen = new Set<string>();
      if (!rotated) {
        try {
          const existing = await fs.readFile(filePath, 'utf-8');
          for (const line of existing.split('\n')) {
            const trimmed = line.trim();
            if (trimmed === '') continue;
            try {
              seen.add(captureRecordKey(JSON.parse(trimmed) as Record<string, unknown>));
            } catch {
              // A torn or hand-edited line tells us nothing about what is
              // already captured; skip it and leave it exactly where it is.
            }
          }
        } catch {
          // First capture — no file to read.
        }
      }

      const fresh = records.filter((r) => !seen.has(captureRecordKey(r)));
      if (fresh.length > 0) {
        const payload = fresh.map((r) => JSON.stringify(r)).join('\n') + '\n';
        await fs.appendFile(filePath, payload, { encoding: 'utf-8', mode: 0o600 });
      }
      return { ok: true, written: fresh.length, skipped: records.length - fresh.length, rotated, note };
    } catch (err) {
      // The path is extension-owned storage, not a secret, so naming it is the
      // actionable part. No record body is ever included in this message.
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `Could not write the PR-comment capture file at ${filePath}: ${detail}` };
    }
  }

  // ─── Internal: shape normalization ────────────────────────────────────

  /**
   * Convert a raw Bitbucket comment into our normalized `PrComment`. Returns
   * `undefined` for entries missing the required scalar fields (`id`,
   * `content.raw`) — those are unusable as PR-comment thread members and
   * silently dropped rather than surfaced as broken UI rows.
   */
  private normalizeComment(raw: BitbucketComment | undefined): PrComment | undefined {
    if (!raw || typeof raw.id !== 'number') return undefined;
    const bodyText = typeof raw.content?.raw === 'string' ? raw.content.raw : '';
    if (!bodyText) return undefined;

    const inlinePath = typeof raw.inline?.path === 'string' ? raw.inline.path : undefined;
    const inlineTo = typeof raw.inline?.to === 'number' ? raw.inline.to : undefined;
    const inlineFrom = typeof raw.inline?.from === 'number' ? raw.inline.from : undefined;
    const hasInline = inlinePath !== undefined && inlineTo !== undefined;
    // `undefined` unless Bitbucket sent a real boolean. Deliberately NOT
    // `raw.inline?.outdated === true` — that collapses "Bitbucket did not tell
    // us" into "this comment is current", which is the one direction of error
    // that ends with a live comment being deleted. See `PrComment.outdated`.
    // Read independently of `hasInline`: an anchor that has lost its `to` line
    // can still carry the marker, and dropping it because the comment failed
    // our own inline test would discard the very signal we came for.
    const outdated = typeof raw.inline?.outdated === 'boolean' ? raw.inline.outdated : undefined;

    const normalized: PrComment = {
      id: raw.id,
      parentId: typeof raw.parent?.id === 'number' ? raw.parent.id : null,
      kind: hasInline ? 'inline' : 'general',
      author: {
        displayName: typeof raw.user?.display_name === 'string' ? raw.user.display_name : '',
        accountId: typeof raw.user?.account_id === 'string' ? raw.user.account_id : '',
      },
      body: bodyText,
      inline: hasInline
        ? { path: inlinePath as string, to: inlineTo as number, from: inlineFrom }
        : undefined,
      resolved: raw.resolution != null,
      createdAt: typeof raw.created_on === 'string' ? raw.created_on : '',
      updatedAt: typeof raw.updated_on === 'string' ? raw.updated_on : '',
    };
    // Assigned conditionally so the key is ABSENT (not `undefined`) when we did
    // not learn it: `JSON.stringify` drops an absent key, and this shape is
    // serialized straight onto the bridge wire and into the capture file. A
    // literal `"outdated": null` or a silently-present `undefined` would give a
    // reader something to misread; nothing at all cannot be misread.
    if (outdated !== undefined) normalized.outdated = outdated;
    return normalized;
  }

  /**
   * Build the body for a `PUT /pullrequests/{id}` from the PR's CURRENT state
   * plus the fields this particular call means to change.
   *
   * Every PUT in this client is a GET-then-PUT, and the reason is this method:
   * Bitbucket's PUT-pullrequest endpoint treats the body as a FULL update, so
   * any field left out is a field the caller silently asked to clear. Echoing
   * `title`, `description`, and `draft` back from the GET is what stops a
   * reviewers-only update from blanking the description, and a ready/draft flip
   * from blanking the description too. If the endpoint turns out to be a
   * partial update after all, echoing a field back to its own value is a no-op
   * — so this is correct under either reading of the API, which is exactly why
   * it is done unconditionally rather than gated on knowing the answer.
   *
   * `title` is omitted entirely rather than sent as `''` when neither the
   * caller nor the GET supplies one: Bitbucket 400s on a missing title, and a
   * 400 changes nothing, whereas a blank title is a live edit to the PR.
   */
  private buildEchoPayload(
    current: BitbucketPullRequest | undefined,
    overrides: { title?: string; description?: string; draft?: boolean },
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    const title = overrides.title ?? (typeof current?.title === 'string' ? current.title : '');
    if (title) payload.title = title;
    payload.description = overrides.description
      ?? (typeof current?.description === 'string' ? current.description : '');
    const draft = overrides.draft ?? (typeof current?.draft === 'boolean' ? current.draft : undefined);
    if (draft !== undefined) payload.draft = draft;
    return payload;
  }

  // ─── Internal: auth + request ─────────────────────────────────────────

  /**
   * Read `email`, `bitbucketWorkspace`, and the ordered Bitbucket token LIST in
   * parallel. `tokens` is the rotation list (empty entries dropped) the failover
   * loop cycles through; an empty list means "no Bitbucket token" and yields a
   * `missing` string so the public methods short-circuit into the `unauthorized`
   * shape exactly as the single-token path did. When exactly one token is stored
   * the list has one element and every op makes exactly one attempt — identical
   * to the pre-rotation behavior.
   */
  private async readAuthContext(): Promise<{
    email: string;
    workspace: string;
    tokens: string[];
    missing?: string;
  }> {
    const email = this.getAtlassianSetting('email');
    const workspace = this.getAtlassianSetting('bitbucketWorkspace');
    const entries = await this.bridge.getBitbucketTokens();
    const tokens = entries
      .map((e) => e.value)
      .filter((v) => typeof v === 'string' && v !== '');
    const missingFields: string[] = [];
    if (!email) missingFields.push('email');
    if (!workspace) missingFields.push('bitbucketWorkspace');
    if (tokens.length === 0) missingFields.push('bitbucketToken');
    const missing = missingFields.length
      ? `Missing: ${missingFields.join(', ')}`
      : undefined;
    return { email, workspace, tokens, missing };
  }

  /**
   * Run a whole logical PR operation with round-robin token failover. Delegates
   * the shared cursor + one-full-pass policy to `withBitbucketFailover`, and
   * rebuilds the `Authorization` header from THIS attempt's token INSIDE the
   * callback — so a token swap takes effect for every request in `run`
   * (including a paginated `listPullRequestComments`, whose entire while-loop
   * runs inside `run` and therefore retries wholesale on the next token). A
   * result is a FAILURE (rotates) when its `status` is not `'ok'`; `'ok'`
   * (including a truncated-but-successful list) sticks the cursor. After one
   * full failed pass the LAST result is returned so its real status / message /
   * retryAfter still surfaces.
   */
  private runWithFailover<T extends { status: BitbucketPrStatus }>(
    email: string,
    tokens: string[],
    run: (auth: string) => Promise<T>,
  ): Promise<T> {
    return withBitbucketFailover(
      tokens,
      (token) => run(this.buildAuthHeader(email, token)),
      // `'indeterminate'` is reported as NOT-a-failure so the loop stops and
      // returns it verbatim. That is deliberate and is the second half of the
      // double-post fix: token rotation exists to answer "is this token
      // allowed?", which is the right question for a 401/403 and the WRONG one
      // for a write that may already have landed. Rotating here would replay the
      // entire operation — including, for `markPrReady` / `markPrDraft`, the
      // full-object PUT — against a live PR we have no confirmation about.
      //
      // Saying "not a failure" does NOT claim success: the caller still receives
      // `status: 'indeterminate'` plus its check-the-PR message and must surface
      // it. The only side effect is that the shared cursor sticks on this token,
      // which is harmless — the token's validity was never in question.
      (result) => result.status !== 'ok' && result.status !== 'indeterminate',
    );
  }

  /**
   * Build the `Authorization: Basic <base64(email:token)>` header value. The
   * returned string is consumed by `request()` and never logged or returned
   * to any caller — the token portion lives only inside the header value
   * passed into `fetch`.
   */
  private buildAuthHeader(email: string, token: string): string {
    return `Basic ${Buffer.from(`${email.trim()}:${token.trim()}`).toString('base64')}`;
  }

  /**
   * Combine a sanitized base message with Bitbucket's own error reason (when
   * one can be parsed from the response body) so callers see the real cause —
   * e.g. a scope-missing 403 or the 200-comments cap 400 — instead of only a
   * generic keyword. Returns the base unchanged when there is no usable detail.
   */
  private describeHttpError(base: string, text: string): string {
    const detail = this.extractErrorDetail(text);
    return detail ? `${base}: ${detail}` : base;
  }

  /**
   * Pull the human-readable reason out of a non-2xx response body. Prefers the
   * documented `{ "type": "error", "error": { "message": "...", "fields": {...} } }`
   * envelope, combining `message` with any per-field rejection reasons
   * (`reviewers: <name> is not a member of this repository`) so the caller sees
   * WHICH field Bitbucket refused and why — a 400 on a PR create with a bad
   * reviewer otherwise reads as a bare `unknown-error: 400 Bad Request`. Falls
   * back to a short slice of the raw text when the body is present but not that
   * shape. Defensive by contract: the body may be empty or non-JSON, so the
   * parse is wrapped in try/catch and this never throws out of `request()`. The
   * text is Bitbucket's own error output — it does not carry the request headers
   * or token — and both the field detail and the raw fallback are capped so a
   * large HTML error page or a long field list cannot bloat the surfaced message.
   */
  private extractErrorDetail(text: string): string | undefined {
    if (!text) return undefined;
    try {
      const parsed = JSON.parse(text) as BitbucketErrorEnvelope;
      const msg = typeof parsed?.error?.message === 'string' ? parsed.error.message.trim() : '';
      const fields = this.describeErrorFields(parsed?.error?.fields);
      // Either half alone is a usable answer; both together read as
      // "<generic validation blurb> (reviewers: <the real reason>)".
      if (msg && fields) return `${msg} (${fields})`;
      if (msg) return msg;
      if (fields) return fields;
    } catch {
      // Not JSON — fall through to the raw-text fallback below.
    }
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    return trimmed.length > 200 ? `${trimmed.slice(0, 200)}...` : trimmed;
  }

  /**
   * Flatten Bitbucket's `error.fields` map into `field: reason; field: reason`.
   * Each value is documented as an array of strings but is typed `unknown` and
   * handled defensively — an array is joined, a bare string is taken as-is, and
   * anything else is skipped rather than stringified into `[object Object]`.
   * Returns `undefined` when nothing usable is present, so the caller can fall
   * back to `error.message` alone. Capped at 200 characters for the same reason
   * the raw-text fallback is.
   */
  private describeErrorFields(fields: Record<string, unknown> | undefined): string | undefined {
    if (!fields || typeof fields !== 'object') return undefined;
    const parts: string[] = [];
    for (const [field, value] of Object.entries(fields)) {
      const reasons = Array.isArray(value)
        ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim())
        : typeof value === 'string' && value.trim() !== ''
          ? [value.trim()]
          : [];
      if (reasons.length === 0) continue;
      parts.push(`${field}: ${reasons.join(', ')}`);
    }
    if (parts.length === 0) return undefined;
    const joined = parts.join('; ');
    return joined.length > 200 ? `${joined.slice(0, 200)}...` : joined;
  }

  /**
   * Execute a request with the Basic-auth header, an 8 s timeout, and
   * JSON-body parsing. Returns a discriminated `{ ok, ... }` shape so callers
   * never see a thrown error.
   *
   * Token leak audit: the `Authorization` header value is set on the request
   * init object that lives only inside this function — it is never logged,
   * never embedded in an error message, and never re-emitted. Error paths
   * surface the mapped status keyword plus Bitbucket's OWN `error.message`
   * (extracted via `extractErrorDetail`) — that text is Bitbucket's response
   * body, which never echoes the request headers or token. Network errors stay
   * fully generic (no body to read).
   */
  private async request(
    url: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    auth: string,
    jsonBody?: unknown,
  ): Promise<
    | { ok: true; body: unknown }
    | { ok: false; status: BitbucketPrStatus; message: string; retryAfter?: string; httpStatus?: number }
  > {
    // Bounded transient retry on the SAME token (the auth header is captured by
    // the closure), composed UNDER `runWithFailover`'s token rotation: a
    // TRANSIENT failure (429 / network / 5xx) retries here with backoff; an auth
    // failure (401/403), a 404, or any other non-2xx returns at once so failover
    // can rotate on auth as before. `httpStatus` on the failure lets us tell a
    // retryable 5xx apart from a non-retryable 4xx that also maps to
    // `'unknown-error'`. The auth header is never logged during a retry.
    const mutating = MUTATING_METHODS.has(method);

    return withTransientRetry(
      () => this.requestOnce(url, method, auth, jsonBody),
      (r) => {
        if (r.ok) return { retry: false };
        if (r.status === 'rate-limited') {
          // Retried even for a mutation, and safely so: a 429 is a DEFINITIVE
          // response in which Bitbucket declined to process the request at all.
          // Nothing was applied, so a replay cannot duplicate anything.
          const secs = parseRetryAfterSeconds(r.retryAfter);
          return { retry: true, retryAfterMs: secs !== undefined ? secs * 1000 : undefined };
        }
        // `'indeterminate'` is only ever produced for a mutation, and is the one
        // status that must NEVER be replayed — that replay is the double-post.
        if (r.status === 'indeterminate') return { retry: false };
        // A surviving `'network-error'` on a mutation has already been proven
        // pre-flight by `requestOnce`, so it is safe to replay; on a read it is
        // safe by definition.
        if (r.status === 'network-error') return { retry: true };
        if (typeof r.httpStatus === 'number' && r.httpStatus >= 500) {
          // A 5xx on a READ is a transient server blip worth retrying. On a
          // MUTATION it is ambiguous in exactly the way a timeout is: a 500 can
          // follow a partially-applied write, and a 502/503/504 from a gateway
          // says nothing about whether the origin processed it. Do not replay.
          return { retry: !mutating };
        }
        return { retry: false };
      },
    );
  }

  /**
   * Perform ONE request attempt. A fresh `AbortController` / timeout is created
   * per call so every retry gets its own 8 s deadline. Same status mapping and
   * token-leak audit as before; additionally carries the raw `httpStatus` on the
   * failure branch so the retry classifier can distinguish a retryable 5xx from
   * a non-retryable 4xx (both otherwise map to `'unknown-error'`). `httpStatus`
   * is internal — the public result shapes never surface it.
   */
  private async requestOnce(
    url: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    auth: string,
    jsonBody?: unknown,
  ): Promise<
    | { ok: true; body: unknown }
    | { ok: false; status: BitbucketPrStatus; message: string; retryAfter?: string; httpStatus?: number }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = {
        // The header value is the only place the token appears in this
        // process after auth-context resolution — DO NOT add this object to
        // any log or error payload.
        Authorization: auth,
        Accept: 'application/json',
      };
      if (jsonBody !== undefined) headers['Content-Type'] = 'application/json';

      const response = await fetch(url, {
        method,
        headers,
        body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
        signal: controller.signal,
      });

      // A response body may be consumed only once, so read it here — before
      // the status branching — and reuse the text on both the error and the
      // 2xx paths. Empty bodies (e.g. a 204 No Content from DELETE) become ''.
      const text = await response.text();

      if (response.status === 401) {
        return { ok: false, status: 'unauthorized', httpStatus: 401, message: this.describeHttpError('401 Unauthorized — check token', text) };
      }
      if (response.status === 403) {
        return { ok: false, status: 'forbidden', httpStatus: 403, message: this.describeHttpError('403 Forbidden — token lacks access', text) };
      }
      if (response.status === 404) {
        return { ok: false, status: 'not-found', httpStatus: 404, message: this.describeHttpError('404 Not Found — check workspace / repo / PR id', text) };
      }
      if (response.status === 429) {
        // Rate limited. Map distinctly to `'rate-limited'` and capture
        // `Retry-After` verbatim (seconds or an HTTP-date) so it is not lost.
        // The transient-retry wrapper honors it (waiting on the SAME token);
        // if retries are exhausted the failover loop rotates like any failure.
        const retryAfter = response.headers.get('retry-after');
        const result: { ok: false; status: BitbucketPrStatus; message: string; retryAfter?: string; httpStatus?: number } = {
          ok: false,
          status: 'rate-limited',
          httpStatus: 429,
          message: this.describeHttpError('429 Too Many Requests — rate limited', text),
        };
        if (retryAfter) result.retryAfter = retryAfter;
        return result;
      }
      if (!response.ok) {
        // A 5xx on a MUTATION is ambiguous in the same way a timeout is: a 500
        // can follow a partially-applied write, and a 502/503/504 from a gateway
        // reports the GATEWAY's view while saying nothing about whether the
        // origin processed the request. Mapping it to `'indeterminate'` here —
        // rather than only suppressing the retry in the classifier — is what
        // also stops `runWithFailover` from rotating tokens and replaying the
        // whole operation. A 5xx on a READ stays `'unknown-error'` and keeps its
        // ordinary transient retry.
        if (MUTATING_METHODS.has(method) && response.status >= 500) {
          return {
            ok: false,
            status: 'indeterminate',
            httpStatus: response.status,
            message: this.describeHttpError(
              `${response.status} ${response.statusText || 'request failed'} — this write may or may not have been applied. `
              + 'CHECK THE PULL REQUEST before retrying',
              text,
            ),
          };
        }
        // Generic non-2xx (e.g. the 200-comments-per-PR cap comes back as a
        // 400, or a transient 5xx on a read). Surface status + statusText
        // enriched with Bitbucket's own reason, never the request headers or
        // token. The raw `httpStatus` lets the retry classifier retry a 5xx but
        // not a 4xx.
        return {
          ok: false,
          status: 'unknown-error',
          httpStatus: response.status,
          message: this.describeHttpError(`${response.status} ${response.statusText || 'request failed'}`, text),
        };
      }

      // 2xx: parse body as JSON. Empty bodies become `undefined`. A POST
      // /resolve or DELETE-comment (204 No Content) response is empty —
      // callers tolerate `undefined` because the discriminator alone tells
      // them the operation succeeded.
      let body: unknown = undefined;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = undefined;
        }
      }
      return { ok: true, body };
    } catch (err) {
      // Sanitized error mapping. We surface only the mapped status keyword
      // and a generic message — never the request init, URL, header value,
      // or raw error message text (Node's network errors can include the
      // remote host / port, which we treat as noisy but not sensitive; we
      // still suppress them to match `atlassian-client.ts`).
      const aborted =
        (err instanceof Error && err.name === 'AbortError') ||
        controller.signal.aborted;

      // For a READ, every transport failure is equivalent: nothing changed
      // server-side, so a replay is free and the message can say "try again".
      // For a MUTATION the distinction is the whole ballgame — see
      // `isPreflightFailure`. A connect-phase failure provably never delivered
      // the request, so it stays a retryable `network-error`; ANYTHING else
      // (most importantly a timeout, where the request WAS delivered and we
      // simply never heard back) is `'indeterminate'` and must not be replayed.
      if (!MUTATING_METHODS.has(method)) {
        return {
          ok: false,
          status: 'network-error',
          message: aborted ? 'Request timed out — try again' : 'Network error — try again',
        };
      }

      if (!aborted && isPreflightFailure(err)) {
        return {
          ok: false,
          status: 'network-error',
          message: 'Could not reach Bitbucket — the request was never sent, so nothing was changed. Safe to retry.',
        };
      }

      return {
        ok: false,
        status: 'indeterminate',
        message: aborted
          ? `No response from Bitbucket within ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s. `
            + 'The request WAS sent, so this write may or may not have been applied. '
            + 'CHECK THE PULL REQUEST before retrying — retrying blindly can duplicate it.'
          : 'The connection to Bitbucket failed after the request was sent. '
            + 'This write may or may not have been applied. '
            + 'CHECK THE PULL REQUEST before retrying — retrying blindly can duplicate it.',
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
