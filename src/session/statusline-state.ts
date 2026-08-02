// The single source of truth for the per-session statusline state-file contract.
//
// WHAT THIS EXISTS TO FIX. Both statusline renderers (`scripts/ghola-statusline.sh`
// and `scripts/ghola-statusline.mjs`) already mirror their usage snapshot to
// `~/.ghola/usage-state.json` on every render. That path is UNKEYED, and the
// operator runs 8+ concurrent Claude Code sessions (`cmms0`..`cmms6`,
// `Project-Ghola`, ...) that all write it. A naive reader therefore shows
// whichever session rendered last, in EVERY window, while looking authoritative —
// which is worse than showing nothing. This module defines a per-repository key so
// each session gets its own file at `~/.ghola/statusline/state/<key>.json`, and a
// reader that can only ever be right about the window it is running in.
//
// THREE IMPLEMENTATIONS, ONE ALGORITHM. The key is computed here (TypeScript, the
// extension host), in `scripts/ghola-statusline.mjs` (JavaScript, the Node
// renderer), and in the embedded Python 3 inside `scripts/ghola-statusline.sh`.
// Drift between the three fails SILENTLY — the writer writes one path, the reader
// reads another, and the status-bar segment simply never appears. So every rule
// below is stated in language-agnostic terms and every step is chosen to be
// trivially reproducible in all three: ASCII-only case folding rather than
// `toLowerCase()`/`.lower()` (whose Unicode behaviour differs), a character class
// rather than a locale-aware transform, and sha256/hex, which all three have in
// their standard library. Do not "improve" a step here without changing the other
// two in the same commit.
//
// AGREEMENT BY CONSTRUCTION, NOT BY COINCIDENCE. `src/session/launcher.ts` exports
// the computed key into the session terminal as `GHOLA_STATE_KEY`. When that
// variable is present a renderer MUST use it verbatim and skip its own derivation.
// This is not belt-and-braces: the two derivations provably disagree in a case
// this fleet actually hits. `Launcher.resolveTerminalCwd` can open the terminal in
// the WSL-NATIVE CLONE of a `/mnt/c/...` workspace when `tool.fastpath-check` is
// enabled, so the renderer's `workspace.project_dir` walks up to a DIFFERENT git
// root than the workspace folder does, and the two sides would key on two
// different paths. The env var removes the disagreement rather than papering over
// it.
//
// THE READER OWNS STALENESS, not the writer — see `STATE_STALE_AFTER_MS`. And the
// reader NEVER THROWS: a missing file, an unreadable file, malformed JSON, or a
// field of the wrong type all degrade to "no data". A status bar must not be able
// to take down the extension host.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findRepoRoot } from './team-identity';

/**
 * The repo-root walk is REUSED from `team-identity.ts` rather than reimplemented,
 * and that is the point: `resolveTeamIdentity` walks up from the same workspace
 * folder to name the switchboard team, and a state key derived from a DIFFERENT
 * root than the one naming the window would be a second silent-disagreement
 * surface of exactly the kind this module exists to close. One walk, one answer.
 *
 * Two properties of that walk are load-bearing here and are documented at length
 * on `findRepoRoot` itself; they are restated because the `.mjs` and the `.sh`
 * must reimplement them:
 *
 *   - `.git` IS TESTED FOR EXISTENCE, NEVER FOR DIRECTORY-NESS. In a plain clone
 *     it is a directory, but in a linked worktree or a submodule it is a FILE
 *     holding a `gitdir:` pointer. An `isDirectory()` test walks straight past
 *     every worktree — that exact bug was found and fixed in `team-identity.ts`.
 *   - TRAILING SEPARATORS COME OFF FIRST, because `path.dirname('/a/b/')` is
 *     `/a`, not `/a/b`, so an untrimmed input skips a level of the walk.
 *
 * IT IS ALSO DELIBERATELY NOT CACHED, for a correctness reason worth mirroring
 * here: unlike an environment probe, whose answer cannot change inside one
 * process, the filesystem can — an operator running `git init` in a non-repo
 * workspace would otherwise be stuck with a stale "no repo" answer until a window
 * reload. The walk is a handful of `existsSync` stats on directories the OS dentry
 * cache already holds, and it runs at human frequency (a launch, a status-bar
 * refresh), so a cache would buy nothing measurable and cost that correctness.
 */
export { findRepoRoot };

/**
 * The environment variable `launcher.ts` exports into the session terminal.
 * Named here rather than spelled literally at both ends so the writer and any
 * future TypeScript reader cannot drift; the `.mjs`/`.sh` necessarily carry the
 * literal, and the spec is what binds them.
 */
export const STATE_KEY_ENV_VAR = 'GHOLA_STATE_KEY';

/**
 * The hash appended to every key. sha256/hex, first 8 characters — chosen because
 * it is one line in Node's `crypto`, one line in Python 3's `hashlib`, and needs
 * no dependency in any of the three implementations. 8 hex characters is 32 bits;
 * across a fleet of tens of repositories the collision probability is negligible,
 * and its only job is to separate two paths that the folding step below happens to
 * render identically.
 */
export const STATE_KEY_HASH_ALGORITHM = 'sha256';
export const STATE_KEY_HASH_LENGTH = 8;

/**
 * Every character outside this class is folded to `-`. The class is the intended
 * charset of the emitted key: safe in a filename on Windows, macOS, and Linux
 * alike, with no shell quoting required and no case-sensitivity trap (the body is
 * already lowercased before folding, so no uppercase can survive).
 */
const STATE_KEY_SAFE_CHARS = /[^a-z0-9._-]/g;

/**
 * Cap on the readable body of a key, applied BEFORE the edge-hyphen trim. Purely
 * cosmetic: uniqueness is carried by the hash, so truncation can never cause a
 * collision — it only keeps `<key>.json` inside every filesystem's per-component
 * name limit (255 bytes on ext4, 255 UTF-16 units on NTFS) with room to spare. The
 * TAIL is kept rather than the head because the tail is the part an operator can
 * recognise: the deeply nested `.../source/repos/cmms1/cmms-api` matters, the
 * `/mnt/c/users/aarbuckle` prefix shared by every one of them does not.
 */
const STATE_KEY_BODY_MAX_LENGTH = 100;

/**
 * Body substituted when folding leaves nothing at all — a path that is entirely
 * separators (`/`, `///`, `\\`). The hash still distinguishes those inputs from
 * each other, so this is a placeholder, not a bucket.
 */
const STATE_KEY_EMPTY_BODY = 'root';

/** Directory under the home directory that holds one JSON file per session key. */
const STATE_DIR_SEGMENTS = ['.ghola', 'statusline', 'state'];

/**
 * How long a snapshot stays FRESH. The reader owns this threshold, not the writer,
 * matching repo precedent (`scripts/ghola.mjs`'s `staleMs: 30000`,
 * `src/settings-panel/host.ts`'s `staleMs = 5000`, `tool.team-switchboard`'s
 * `staleAfterDays`) — one writer, several readers, each with its own idea of how
 * old is too old.
 *
 * NINETY SECONDS, AND DELIBERATELY NOT THIRTY. This was measured, not guessed:
 * sampling the state file every 5 seconds for 55 continuous seconds during active
 * agent work produced ZERO writes, with `updated` already 10s old at the first
 * sample and 65s old at the last. The cause is structural — Claude Code re-renders
 * its status line on ASSISTANT MESSAGES, not on a clock, so a single long agent
 * run emits no renders at all. A 30s threshold would blank the segment on a
 * perfectly healthy, busy session, which is the failure mode that looks most like
 * a bug. Do not "optimize" this down; if anything it wants to go up.
 */
export const STATE_STALE_AFTER_MS = 90_000;

/**
 * Above this value a `updated` field is interpreted as MILLISECONDS rather than
 * seconds. The contract is seconds (both renderers write `int(time.time())` /
 * `Math.floor(Date.now() / 1000)`), so this is reader-side leniency only, and it is
 * unambiguous: 1e11 seconds is the year 5138, 1e11 milliseconds is 1973. Without
 * it, a future writer that regressed to milliseconds would produce a far-future
 * timestamp, a negative age, and a segment that reads FRESH forever.
 */
const UPDATED_MILLISECONDS_THRESHOLD = 1e11;

/**
 * The on-disk shape of `<key>.json`, mirroring exactly what the two renderers
 * write.
 *
 * EVERY METRIC FIELD IS OPTIONAL, and that is the contract rather than laziness.
 * The renderers emit each key only when its source value was present in the
 * harness payload: `rate_limits` (and therefore `five_hour_pct`) appears only for
 * Pro/Max subscribers and only after the first API response of a session, and
 * `context_pct` can be absent independently of `session_tokens`. A reader must
 * gate each metric on its own presence; letting one missing field suppress the
 * others would blank the whole segment for every free-tier session.
 *
 * `updated` is EPOCH SECONDS.
 */
export interface StatuslineUsageState {
  /** Epoch SECONDS at which the snapshot was written. */
  readonly updated?: number;
  /**
   * `context_window.total_input_tokens + total_output_tokens` — the size of the
   * CURRENT context window, NOT a cumulative total for the session. The name is a
   * misnomer as of Claude Code v2.1.132: the value drops when a compaction clears
   * the window and plateaus near the model's context ceiling instead of growing
   * for the life of the session. The key name is unchanged deliberately — it is a
   * cross-module contract shared verbatim by both renderers and
   * `tool.usage-observer` — so read the key, not its name.
   */
  readonly session_tokens?: number;
  /** Context-window usage, whole percent, already clamped at 0 by the writer. */
  readonly context_pct?: number;
  /** Five-hour rate-limit usage, whole percent, already clamped at 0. */
  readonly five_hour_pct?: number;
}

/** Whether a snapshot was found, and if so whether it is recent enough to trust. */
export type StatuslineStateStatus =
  /** File read, parsed, and `updated` within `staleAfterMs`. */
  | 'fresh'
  /** File read and parsed, but too old — or carrying no usable `updated` at all. */
  | 'stale'
  /** No file, unreadable file, unparseable file, or a payload that is not an object. */
  | 'absent';

/** A read result: the status, the age, and whichever metrics survived validation. */
export interface StatuslineStateSnapshot {
  /** The key this snapshot was read for. */
  readonly key: string;
  /** The exact file path consulted — carried so a tooltip can name it. */
  readonly filePath: string;
  /** Whether there is data, and whether it is fresh. */
  readonly status: StatuslineStateStatus;
  /** `updated` converted to epoch MILLISECONDS. Absent when it was missing/invalid. */
  readonly updatedAtMs?: number;
  /**
   * Age of the snapshot in milliseconds, clamped at 0. Absent when `updatedAtMs`
   * is. Clamped because a snapshot written by a native-Windows renderer whose
   * clock runs slightly ahead of the WSL host's would otherwise report a negative
   * age, and "in 3 seconds" is a worse tooltip than "just now".
   */
  readonly ageMs?: number;
  /**
   * Current context-window size in tokens, when present and valid — see
   * `session_tokens` above for why that name no longer describes it.
   *
   * THE VS CODE STATUS-BAR PILL RENDERS THIS, and it is now the only surface that
   * does: `mode-status-bar.ts` opens its metrics group with the figure abbreviated
   * through `formatTokenCount` below (`$(organization) Ghola: cmms2@win · Ticket Work · 34k · 5h 55%`). Both terminal
   * renderers still COMPUTE and WRITE the field but no longer print it, so the
   * pill is what keeps this field — and the abbreviation rule — live. It would be
   * carried here regardless of any display, because the on-disk shape is a
   * cross-module contract and dropping the field would make this reader a lossy
   * view of a shape it is supposed to mirror exactly; `tool.usage-observer`
   * consumes the field itself.
   */
  readonly sessionTokens?: number;
  /** Context-window percent, when present and valid. */
  readonly contextPct?: number;
  /** Five-hour-window percent, when present and valid. */
  readonly fiveHourPct?: number;
}

/** Injectable inputs to the reader; every one has a real default. */
export interface StatuslineStateReadOptions {
  /** Home directory. Injectable so the path build can be exercised off-host. */
  readonly homeDir?: string;
  /** "Now", epoch milliseconds. Injectable so staleness can be tested without waiting. */
  readonly nowMs?: number;
  /** Freshness threshold override; defaults to `STATE_STALE_AFTER_MS`. */
  readonly staleAfterMs?: number;
  /** File read, injectable so the reader can be exercised with no file on disk. */
  readonly readFile?: (filePath: string) => string;
}

/**
 * Normalize an absolute path into the exact string that is hashed and folded.
 * Pure: no I/O, no `process.cwd()`, no `os.platform()` — the same input yields the
 * same output on WSL and on native Windows, which is the entire requirement.
 *
 * Steps, IN ORDER (the order is part of the contract):
 *   1. Every `\` becomes `/`. A `C:\Users\...` workspace can be read by a WSL host
 *      and a `/mnt/c/...` one by a Windows host, and `path.sep` is whatever the
 *      READER happens to be running on, so the separator is normalized explicitly
 *      instead of trusted. Same reason `team-identity.ts` re-slashes.
 *   2. Trailing `/` runs come off, so `/a/b` and `/a/b/` are one key rather than
 *      two. An all-separator input is returned unchanged rather than emptied,
 *      matching `team-identity.ts`'s `trimTrailingSeparators`.
 *   3. ASCII case folding: `A`-`Z` -> `a`-`z`, and NOTHING ELSE is touched.
 *
 * WHY LOWERCASE AT ALL, AND WHY ASCII-ONLY. Case folding is the deliberate
 * decision here and it is the likeliest place a cross-platform mismatch could
 * hide, so it is spelled out: NTFS is case-insensitive and VS Code's `fsPath`
 * upper-cases the drive letter, while the Windows renderer receives
 * `workspace.project_dir` from the harness with whatever casing the harness chose.
 * `C:\Users\...` and `c:/users/...` are the SAME DIRECTORY, and two keys for one
 * directory is the exact bug being fixed. Folding case makes them agree.
 *
 * The cost is accepted knowingly: on a case-sensitive filesystem, two repositories
 * differing ONLY by case (`~/projects/Foo` and `~/projects/foo`) collide onto one
 * key. That layout does not exist in this fleet, it would be pathological if it
 * did, and the alternative failure — a Windows renderer and a WSL extension host
 * silently keying differently on the same repo — is both likelier and harder to
 * diagnose.
 *
 * ASCII-only, via an explicit `[A-Z]` class rather than `toLowerCase()`/`.lower()`,
 * because those diverge on non-ASCII input across the three languages this
 * algorithm lives in (`İ`, `ẛ`, and friends). Any non-ASCII character folds to `-`
 * in the next step anyway, so restricting the case fold costs nothing in the key
 * and buys exact three-way parity in the HASH.
 */
export function normalizeStateKeyPath(absolutePath: string): string {
  const slashed = absolutePath.replace(/\\/g, '/');
  const trimmed = slashed.replace(/\/+$/, '');
  const withRoot = trimmed.length > 0 ? trimmed : slashed;
  return withRoot.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

/**
 * The canonical key for one repository root: a readable, filesystem-safe rendering
 * of the path plus a hash that guarantees uniqueness.
 *
 * `<folded-body>-<sha256(normalized)[0:8]>`
 *
 * WHAT IS HASHED IS THE NORMALIZED PATH, NOT THE FOLDED BODY. That is the whole
 * reason the hash is here: folding is lossy (`/a/b_c` and `/a/b-c` both fold to
 * `a-b-c`), so hashing the folded body would preserve the collision it is meant to
 * break. Hashing the normalized form — which is the full path, with only separator
 * form, trailing separators, and ASCII case regularized — keeps every distinct
 * directory distinct.
 *
 * Deterministic and pure. Given the same string it returns the same key on every
 * platform, on every Node version, forever.
 */
export function deriveStateKey(absolutePath: string): string {
  const normalized = normalizeStateKeyPath(absolutePath);
  const hash = crypto
    .createHash(STATE_KEY_HASH_ALGORITHM)
    .update(normalized, 'utf8')
    .digest('hex')
    .slice(0, STATE_KEY_HASH_LENGTH);
  return `${foldStateKeyBody(normalized)}-${hash}`;
}

/**
 * The readable half of a key. Steps, IN ORDER:
 *   1. Fold every character outside `[a-z0-9._-]` to `-`. This is what turns the
 *      path separators into hyphens; it is not a separate rule.
 *   2. Collapse runs of `-` to one.
 *   3. Keep the LAST `STATE_KEY_BODY_MAX_LENGTH` characters if longer.
 *   4. Trim `-` from both ends. AFTER the truncation, because truncation can
 *      expose a hyphen at either edge, and an absolute path always folds to a
 *      leading one (`/home/...` -> `-home-...`). A leading hyphen in a filename is
 *      legal but reliably mistaken for an option flag by CLI tooling.
 *   5. Empty result becomes `STATE_KEY_EMPTY_BODY`.
 *
 * The body can therefore never start or end with `-`, and since `deriveStateKey`
 * always appends `-<hash>`, a key can never end with `.` either — which matters on
 * Windows, where trailing dots in a filename are silently stripped.
 */
function foldStateKeyBody(normalizedPath: string): string {
  const folded = normalizedPath.replace(STATE_KEY_SAFE_CHARS, '-').replace(/-+/g, '-');
  const capped =
    folded.length > STATE_KEY_BODY_MAX_LENGTH
      ? folded.slice(-STATE_KEY_BODY_MAX_LENGTH)
      : folded;
  const body = capped.replace(/^-+/, '').replace(/-+$/, '');
  return body.length > 0 ? body : STATE_KEY_EMPTY_BODY;
}

/**
 * The path a key is derived FROM, for a given starting directory: the nearest
 * ancestor holding a `.git` entry, or the starting directory itself when there is
 * none.
 *
 * The fallback is not arbitrary — it mirrors `resolveTeamIdentity`'s `gitRoot ??
 * workspaceFolderPath` exactly, so a workspace with no repository above it still
 * gets a stable, private key instead of sharing one. The renderers apply the same
 * fallback to `workspace.project_dir`.
 *
 * Returns `undefined` for an empty or whitespace-only input, and that guard is
 * load-bearing rather than defensive tidiness: `findRepoRoot('')` would probe
 * `.git` RELATIVE TO `process.cwd()`, making the answer depend on where the
 * extension host was started. A key must never depend on cwd.
 */
export function resolveStateKeyRoot(
  startPath: string | undefined,
  hasGitEntry?: (dir: string) => boolean,
): string | undefined {
  if (startPath === undefined || startPath.trim() === '') return undefined;
  const gitRoot =
    hasGitEntry === undefined ? findRepoRoot(startPath) : findRepoRoot(startPath, hasGitEntry);
  return gitRoot ?? startPath;
}

/**
 * `resolveStateKeyRoot` composed with `deriveStateKey` — the one call a caller
 * that has a directory (rather than a known root) wants. `undefined` propagates
 * from the guard above.
 */
export function resolveStateKey(
  startPath: string | undefined,
  hasGitEntry?: (dir: string) => boolean,
): string | undefined {
  const root = resolveStateKeyRoot(startPath, hasGitEntry);
  return root === undefined ? undefined : deriveStateKey(root);
}

/**
 * `<homeDir>/.ghola/statusline/state`. GLOBAL, never the work repo — the same
 * placement rule the renderers already follow for `usage-state.json`, so a state
 * file can never end up staged into somebody's commit.
 *
 * Exported (rather than kept private behind `statuslineStateFilePath`) because the
 * WRITER needs it too: a renderer must `mkdir -p` this directory before its atomic
 * temp-file-plus-rename. This module does no I/O of its own beyond reading.
 */
export function statuslineStateDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ...STATE_DIR_SEGMENTS);
}

/** `<stateDir>/<key>.json`. */
export function statuslineStateFilePath(key: string, homeDir: string = os.homedir()): string {
  return path.join(statuslineStateDir(homeDir), `${key}.json`);
}

/**
 * Read and validate one session's snapshot. NEVER THROWS, for any input, in any
 * filesystem state — every failure lands on `status: 'absent'` with no metrics.
 *
 * Validation is per-field and independent: a garbage `five_hour_pct` removes only
 * `fiveHourPct` and leaves `contextPct` intact, because the two arrive from
 * different parts of the harness payload and one being absent says nothing about
 * the other.
 */
export function readStatuslineState(
  key: string,
  options: StatuslineStateReadOptions = {},
): StatuslineStateSnapshot {
  const filePath = statuslineStateFilePath(key, options.homeDir ?? os.homedir());
  const parsed = parseStateFile(filePath, options.readFile);
  if (parsed === undefined) return { key, filePath, status: 'absent' };

  const updatedAtMs = readUpdatedAtMs(parsed.updated);
  const nowMs = options.nowMs ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? STATE_STALE_AFTER_MS;
  // A snapshot with no usable timestamp reads STALE rather than fresh or absent:
  // the metrics are real and worth showing, but nothing here can vouch for their
  // age, and a caller that renders unvouched data as current would be asserting
  // something it does not know.
  const ageMs = updatedAtMs === undefined ? undefined : Math.max(0, nowMs - updatedAtMs);
  const status: StatuslineStateStatus = ageMs !== undefined && ageMs <= staleAfterMs ? 'fresh' : 'stale';

  return {
    key,
    filePath,
    status,
    updatedAtMs,
    ageMs,
    // Each metric is validated on its own and can be `undefined` independently of
    // the others; see `StatuslineUsageState` for why that is the contract rather
    // than a degenerate case.
    sessionTokens: readCount(parsed.session_tokens),
    contextPct: readPercent(parsed.context_pct),
    fiveHourPct: readPercent(parsed.five_hour_pct),
  };
}

/**
 * `readStatuslineState` for a caller that has a directory rather than a key.
 * Returns `undefined` only when no key could be derived at all (see
 * `resolveStateKeyRoot`); every other failure is a normal `'absent'` snapshot.
 */
export function readStatuslineStateForDirectory(
  startPath: string | undefined,
  options: StatuslineStateReadOptions & { readonly hasGitEntry?: (dir: string) => boolean } = {},
): StatuslineStateSnapshot | undefined {
  const key = resolveStateKey(startPath, options.hasGitEntry);
  return key === undefined ? undefined : readStatuslineState(key, options);
}

/**
 * Read + JSON.parse, reduced to "an object, or nothing". Swallows every error
 * class the same way on purpose: ENOENT (no session has rendered yet) is the
 * COMMON case, not an exceptional one, and is indistinguishable to a status bar
 * from EACCES or a truncated write.
 *
 * A non-object payload (`null`, `42`, `"x"`, `[]`) is rejected here rather than
 * field-by-field below. Note `typeof null === 'object'`, hence the explicit test.
 */
function parseStateFile(
  filePath: string,
  readFile: ((filePath: string) => string) | undefined,
): StatuslineUsageState | undefined {
  try {
    const raw = readFile === undefined ? fs.readFileSync(filePath, 'utf8') : readFile(filePath);
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as StatuslineUsageState;
  } catch {
    return undefined;
  }
}

/**
 * `updated` in epoch MILLISECONDS, or `undefined` when it is missing or unusable.
 * Non-positive values are rejected outright: `0` is 1970, which is never a real
 * write and is what a writer bug or a zero-filled field looks like.
 */
function readUpdatedAtMs(updated: unknown): number | undefined {
  if (typeof updated !== 'number' || !Number.isFinite(updated) || updated <= 0) return undefined;
  return updated > UPDATED_MILLISECONDS_THRESHOLD ? updated : updated * 1000;
}

/** A non-negative count, or `undefined`. The writers gate on `total >= 0` too. */
function readCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/**
 * A whole-percent value, or `undefined`. Rounded and clamped at 0 exactly as both
 * renderers do before writing (`int(round(up))` / `Math.max(0, pyRound(up))`), so a
 * value that reaches this reader without having gone through a renderer cannot
 * display differently here than in the terminal footer. Deliberately NOT clamped
 * at 100 — neither renderer does, and inventing a ceiling would hide a real
 * overage.
 */
function readPercent(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, pyRound(value));
}

/**
 * Python's `round()` — round-half-to-EVEN — copied from `pyRound` in
 * `scripts/ghola-statusline.mjs`, which carries it so the Node renderer matches
 * the `.sh`'s `python3` block. `Math.round` rounds half UP, so `62.5` would be
 * `63` here and `62` in both renderers.
 *
 * In practice the writers store integers, so this is a no-op on every file Ghola
 * itself produces. It is here anyway because the alternative is a rounding rule
 * that differs from the two renderers' by design, which is exactly the kind of
 * quiet three-way divergence this module exists to prevent.
 */
function pyRound(value: number): number {
  const floor = Math.floor(value);
  const frac = value - floor;
  if (frac > 0.5) return floor + 1;
  if (frac < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Abbreviate a token count for display:
 *
 *   n < 1000        -> the digits             (999      -> '999')
 *   n < 1_000_000   -> floor(n / 1000) + 'k'  (238_400  -> '238k')
 *   otherwise       -> (n / 1e6, 1 decimal) + 'M'  (1_500_000 -> '1.5M')
 *
 * THE SOLE REMAINING IMPLEMENTATION OF THIS RULE, and no longer a copy of anything.
 * It began as a port of `fmt_tokens` from `scripts/ghola-statusline.sh` (mirrored in
 * `scripts/ghola-statusline.mjs` as `fmtTokens`) and was kept deliberately in step
 * with both, so that the status bar and the terminal footer could not disagree about
 * one number. Both of those helpers have since been DELETED, and they are not coming
 * back: neither renderer prints a token segment any more, so neither formats tokens
 * for display at all. There is therefore nothing left for this to stay in step with,
 * and it has exactly one caller — `formatMetricsSegment` in
 * `src/status-bar/mode-status-bar.ts`, which renders the VS Code status-bar pill. A
 * change to the tiers below now moves the pill and nothing else.
 *
 * Note the `k` tier FLOORS while the `M` tier ROUNDS to one decimal. That asymmetry
 * came from `fmt_tokens`; it is preserved, not corrected, so the digits read the same
 * as they historically did.
 *
 * Returns `''` for a non-finite input — unreachable via `readStatuslineState`, which
 * validates first, but this is exported and a caller may not have.
 */
export function formatTokenCount(count: number): string {
  if (!Number.isFinite(count)) return '';
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${Math.floor(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}
