#!/usr/bin/env node
// ghola-statusline.mjs — Claude Code statusLine hook for Project-Ghola.
//
// A NODE PORT of `scripts/ghola-statusline.sh` with a BYTE-IDENTICAL output
// contract. Both files are kept: the `.sh` remains in place for back-compat and
// for anyone whose settings already point at it.
//
// ── Why a Node port exists ───────────────────────────────────────────────
// The `.sh` renderer only works on the WSL host, for four stacked reasons that
// all bite on native Windows:
//   1. Its `statusLine.command` is a POSIX path that does not resolve on win32.
//   2. There is no Windows checkout of Project-Ghola any more (see CLAUDE.md).
//   3. `bash.exe` is not on the operator's Windows PATH (Git for Windows puts
//      only `...\Git\cmd\` there, not `...\Git\bin\`).
//   4. `python3` on Windows resolves to the Microsoft Store alias stub, not a
//      real interpreter, so the script's `python3` heredoc would die and the
//      line would silently degrade to version-only even under a working shell.
// `node` is the only interpreter healthy on BOTH supported hosts, and the VSIX
// already ships `scripts/` and `VERSION`, so this file needs no repo checkout.
//
// ── Behavior (identical to the .sh) ──────────────────────────────────────
//   - Emits exactly one line on stdout, with NO trailing newline.
//   - Always shows [Ghola v<version>].
//   - When the JSON payload on stdin carries context_window.total_input_tokens +
//     total_output_tokens and/or context_window.used_percentage and/or
//     rate_limits.five_hour.used_percentage, each of those segments is appended
//     independently — e.g. [Ghola v0.25.0 | 142k · 62% · 5h 41%] (the real
//     separator is U+2502, spelled literally below).
//   - Context % and 5h % render red (\033[31m) at >= 85%. No other color is
//     emitted; any other tint the operator sees is their terminal styling the
//     custom row, not this script.
//   - On ANY error it must NOT fail and must NOT print error text: it degrades
//     to [Ghola v<version>], or [Ghola vunknown] if VERSION is unreadable, or
//     to nothing at all in the (unreachable) worst case — and always exits 0.
//   - Mirrors the usage snapshot to ~/.ghola/usage-state.json for the
//     `tool.usage-observer` module (same location + shape as the .sh).
//   - ALSO mirrors it to the per-session, KEYED file
//     ~/.ghola/statusline/state/<key>.json, which the VS Code status bar reads.
//     The unkeyed file above is a single path shared by every concurrent
//     session, so it cannot be attributed to a window; the keyed one can. Both
//     writes happen, independently — see `writeKeyedState` for the key rules and
//     `src/session/statusline-state.ts` for the normative spec.
//
// ── Silent mode: hide the footer line WITHOUT losing the writes ──────────
// THIS SCRIPT IS THE WRITER OF THE TWO STATE FILES ABOVE, so deleting
// `statusLine` from ~/.claude/settings.json is the WRONG way to hide the footer
// line: the harness then never invokes us, nothing writes state, and the VS Code
// status-bar pill goes empty inside its 90-second staleness window
// (`STATE_STALE_AFTER_MS`) on BOTH hosts. To hide the line and keep the pill,
// silence the renderer instead — it still runs, still writes both files, and
// prints nothing:
//   - MARKER FILE `<homedir>/.ghola/statusline/silent` — if it EXISTS, print
//     nothing. Contents are irrelevant; existence is the whole signal and an
//     empty file is the expected form. It sits beside the staged renderer and the
//     VERSION stamp in that same directory, so it needs no new directory and no
//     new path-resolution rule; the home directory is resolved with the same
//     `os.homedir()` used for the state files.
//   - ENV VAR `GHOLA_STATUSLINE_SILENT`, CHECKED FIRST. `1`/`true`/`yes`
//     (case-insensitive, surrounding whitespace trimmed) means silent;
//     `0`/`false`/`no` means NOT silent and BEATS the marker file, so one session
//     can be un-silenced without deleting it. Unset, empty, whitespace-only, or
//     any unrecognized value is NO SIGNAL and defers to the marker file.
// A settings-file toggle is deliberately NOT the control surface: Ghola module
// settings live in VS Code's `globalState`, an opaque `Memento` with no on-disk
// representation, so a standalone script cannot read them at all. A marker file
// is the only thing both this renderer and the operator can see.
// SILENCE IS ABOUT STDOUT ONLY. Both state writes happen unconditionally and
// BEFORE the print gate. And a FAILED CHECK degrades to NOT SILENT, never the
// other way round: a permission error or a weird filesystem must not be able to
// blank the operator's footer, and it must not abort the render either.
// What the harness does with no output (Claude Code 2.1.220, read from the
// bundle, and consistent with the public docs' "produce no output cause the
// status line to go blank"): it `.trim()`s our stdout, drops blank lines, and
// treats an empty result as ABSENT — so printing nothing and printing a bare
// newline are indistinguishable to it. It then renders NO ROW AT ALL in the
// default TUI, and reserves the slot with a single space only in
// fullscreen/no-flicker mode, where the layout is fixed. That choice is the
// harness's, not ours; we simply write zero bytes.
//
// Portability: the VERSION path is derived from THIS FILE's own location, never
// from the cwd the harness runs us in, so one copy works from the repo, from the
// installed extension directory, and from the staged copy the extension writes
// to ~/.ghola/statusline/ (see `stageStatuslineRenderer` in src/extension.ts).
//
// Dependencies: node only. No npm packages, no `bash`, no `python3`, no `jq`.
// Installation: reference it from ~/.claude/settings.json —
//   WSL:     { "statusLine": { "type": "command",
//              "command": "node /home/<user>/.ghola/statusline/ghola-statusline.mjs" } }
//   Windows: { "statusLine": { "type": "command",
//              "command": "node C:/Users/<user>/.ghola/statusline/ghola-statusline.mjs" } }

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Last-resort net: a statusline that prints a stack trace breaks the operator's
// footer on every prompt. Registering a handler keeps Node from crash-printing,
// and leaves the exit code at 0. Everything below is already inside try/catch,
// so this should never fire.
process.on('uncaughtException', () => {
  process.exitCode = 0;
});
// The harness may close the pipe before we finish writing; EPIPE is not an error
// worth surfacing (or crashing over).
process.stdout.on('error', () => {});

/**
 * Python's `round()` — round-half-to-EVEN — which is what the `.sh` uses via its
 * `python3` block. `Math.round` rounds half UP, so `used_percentage: 62.5` would
 * render `63%` here and `62%` there. Kept for exact output parity.
 */
function pyRound(x) {
  const floor = Math.floor(x);
  const frac = x - floor;
  if (frac > 0.5) return floor + 1;
  if (frac < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * The `.sh` gates each field on `isinstance(v, (int, float))`, and in Python
 * `bool` IS a subclass of `int` — so a payload carrying `used_percentage: true`
 * yields `1` there. Booleans are coerced the same way here rather than rejected,
 * so a malformed payload renders identically under both renderers. Returns
 * `undefined` for every non-numeric value (JSON.parse cannot produce NaN or
 * Infinity, so a returned number is always finite).
 */
function asPyNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return undefined;
}

/** `fmt_tokens` from the .sh: 999 -> "999", 142000 -> "142k", 1500000 -> "1.5M". */
function fmtTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1000000) return `${Math.floor(n / 1000)}k`;
  return `${(n / 1000000).toFixed(1)}M`;
}

/**
 * Read the Ghola version string, stripping ALL whitespace exactly as the .sh's
 * `tr -d '[:space:]'` does (POSIX space class, not JS `\s`, which is wider).
 * Returns `'unknown'` when no candidate yields a non-empty value.
 *
 * Candidate order mirrors the .sh, plus ONE addition for the staged layout:
 *   - `$GHOLA_DIR/VERSION` when GHOLA_DIR is set and non-empty (the .sh's
 *     `${GHOLA_DIR:-...}` override), and then nothing else — an explicit
 *     override is authoritative.
 *   - else `<scriptDir>/../VERSION` — the repo and installed-extension layout,
 *     where this file sits in `scripts/` beside a sibling `VERSION`.
 *   - else `<scriptDir>/VERSION` — the FLAT staged layout, where the extension
 *     copies this file and VERSION side by side into one directory. Tried second
 *     so the repo layout always wins and behavior there is unchanged.
 */
function readVersion(scriptDir) {
  const envDir = process.env.GHOLA_DIR;
  const candidates =
    typeof envDir === 'string' && envDir !== ''
      ? [path.join(envDir, 'VERSION')]
      : [path.join(scriptDir, '..', 'VERSION'), path.join(scriptDir, 'VERSION')];
  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, 'utf8').replace(/[ \t\n\v\f\r]/g, '');
      if (raw !== '') return raw;
    } catch {
      // Unreadable / absent / a directory — fall through to the next candidate.
    }
  }
  return 'unknown';
}

/** Read the whole harness payload from stdin. Returns '' on any failure. */
function readPayload() {
  try {
    // fd 0 rather than '/dev/stdin' so this works on win32 too. A TTY stdin with
    // no redirect can raise EAGAIN, which lands in the catch and renders
    // version-only; the .sh's `cat` would instead block for EOF. That divergence
    // is interactive-only — the harness always pipes JSON.
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Best-effort snapshot for `tool.usage-observer`. GLOBAL location (~/.ghola/),
 * never the work repo. Same path, same key set, and same key ORDER as the .sh
 * writes, because that file is a documented cross-module contract.
 *
 * Written only when there is an actual usage signal (tokens or the 5h figure),
 * so an empty payload never clobbers a good snapshot — note that a context
 * percentage ALONE deliberately does not trigger a write, matching the .sh.
 *
 * Atomic: write a temp file, then rename over the target, so a reader never sees
 * a half-written file. The temp name carries our PID, which the .sh's fixed
 * `.tmp` does not: two concurrent renders sharing one temp name can have the
 * second truncate the file the first is about to rename into place, publishing a
 * torn snapshot. Readers only ever open `usage-state.json`, so the temp name is
 * not part of the contract.
 */
function writeUsageState(tokens, contextPct, fiveHourPct) {
  if (tokens === undefined && fiveHourPct === undefined) return;
  let tmpPath;
  try {
    const stateDir = path.join(os.homedir(), '.ghola');
    fs.mkdirSync(stateDir, { recursive: true });
    const statePath = path.join(stateDir, 'usage-state.json');
    const obj = { updated: Math.floor(Date.now() / 1000) };
    if (tokens !== undefined) obj.session_tokens = tokens;
    if (contextPct !== undefined) obj.context_pct = contextPct;
    if (fiveHourPct !== undefined) obj.five_hour_pct = fiveHourPct;
    tmpPath = `${statePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(obj));
    fs.renameSync(tmpPath, statePath);
    tmpPath = undefined;
  } catch {
    // A filesystem fault here can never break the status line.
    if (tmpPath !== undefined) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Nothing more to do; leaving one stray temp file is the harmless case.
      }
    }
  }
}

// ── Per-session state key ───────────────────────────────────────────────────
// THE SAME ALGORITHM LIVES IN THREE PLACES: here, in the `python3` block inside
// `scripts/ghola-statusline.sh`, and in `src/session/statusline-state.ts`, which
// is the NORMATIVE spec and carries the full reasoning for every step. Drift
// fails SILENTLY — the writer writes one path, the status bar reads another, and
// the segment simply never appears — so nothing below may be "improved" without
// changing the other two in the same commit. The rules are deliberately chosen to
// be trivially reproducible in all three languages: an explicit `[A-Z]` case fold
// rather than `toLowerCase()`/`.lower()` (whose Unicode behavior differs between
// them), a character class rather than any locale-aware transform, and
// sha256/hex, which all three have in their standard library.
const STATE_KEY_ENV_VAR = 'GHOLA_STATE_KEY';
const STATE_KEY_HASH_LENGTH = 8;
const STATE_KEY_SAFE_CHARS = /[^a-z0-9._-]/g;
const STATE_KEY_BODY_MAX_LENGTH = 100;
const STATE_KEY_EMPTY_BODY = 'root';
/** Belt-and-braces bound on the root walk; `path.dirname` already terminates. */
const MAX_ROOT_WALK_STEPS = 64;

/**
 * The exact string that gets hashed and folded. Steps, IN ORDER: re-slash, drop
 * trailing `/` runs (an all-separator input survives unchanged rather than
 * emptying), then ASCII-ONLY case folding. NTFS is case-insensitive and the two
 * sides of this contract can each see a different casing of the same directory,
 * so case is folded; it is folded via `[A-Z]` rather than `toLowerCase()` because
 * that is the only spelling the three implementations agree on for non-ASCII.
 */
function normalizeStateKeyPath(absolutePath) {
  const slashed = absolutePath.replace(/\\/g, '/');
  const trimmed = slashed.replace(/\/+$/, '');
  const withRoot = trimmed.length > 0 ? trimmed : slashed;
  return withRoot.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

/**
 * The readable half of the key. Fold everything outside `[a-z0-9._-]` to `-`,
 * collapse runs, keep the LAST 100 characters (the tail is the recognizable
 * part), then trim edge hyphens — AFTER truncation, because truncation can expose
 * one, and an absolute path always folds to a leading one.
 */
function foldStateKeyBody(normalizedPath) {
  const folded = normalizedPath.replace(STATE_KEY_SAFE_CHARS, '-').replace(/-+/g, '-');
  const capped =
    folded.length > STATE_KEY_BODY_MAX_LENGTH
      ? folded.slice(-STATE_KEY_BODY_MAX_LENGTH)
      : folded;
  const body = capped.replace(/^-+/, '').replace(/-+$/, '');
  return body.length > 0 ? body : STATE_KEY_EMPTY_BODY;
}

/**
 * `<folded-body>-<sha256(normalized)[0:8]>`. WHAT IS HASHED IS THE NORMALIZED
 * PATH, NOT THE FOLDED BODY — folding is lossy (`/a/b_c` and `/a/b-c` both fold
 * to `a-b-c`), so hashing the body would preserve the very collision the hash
 * exists to break.
 */
function deriveStateKey(absolutePath) {
  const normalized = normalizeStateKeyPath(absolutePath);
  const hash = crypto
    .createHash('sha256')
    .update(normalized, 'utf8')
    .digest('hex')
    .slice(0, STATE_KEY_HASH_LENGTH);
  return `${foldStateKeyBody(normalized)}-${hash}`;
}

/** `.git` EXISTS — never `isDirectory()`; it is a FILE in a worktree or submodule. */
function hasGitEntry(dir) {
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

/**
 * Nearest ancestor of `startPath` (inclusive) holding a `.git` entry, or
 * `undefined`. Trailing separators come off FIRST because `path.dirname('/a/b/')`
 * is `/a`, not `/a/b`, so an untrimmed input skips a level. Never cached: unlike
 * an environment probe, the filesystem can change under us (`git init`), and the
 * walk is a handful of stats the OS dentry cache already holds.
 */
function findRepoRoot(startPath) {
  const trimmed = startPath.replace(/[\\/]+$/, '');
  let current = trimmed.length > 0 ? trimmed : startPath;
  for (let step = 0; step < MAX_ROOT_WALK_STEPS; step += 1) {
    if (hasGitEntry(current)) return current;
    const parent = path.dirname(current);
    // `path.dirname` is its own fixed point at the top of the tree, so equality is
    // the "out of parents" signal. Compared before assignment so the root itself
    // is probed exactly once.
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/**
 * This session's key, or `undefined` when none can be derived.
 *
 * `GHOLA_STATE_KEY` WINS AND IS USED VERBATIM — no normalization, no folding, no
 * hashing, no walk. `src/session/launcher.ts` exports it, computed from the VS
 * Code workspace folder's git root, and that is not defensive duplication: the
 * two derivations provably disagree when the terminal is opened in the WSL-native
 * clone of a `/mnt/c/...` workspace, because `project_dir` then walks up to a
 * DIFFERENT root than the workspace folder does. The env var makes writer and
 * reader agree by construction; the walk below survives only as the fallback for
 * a session that Ghola did not launch. (Whitespace-only is treated as absent: it
 * is not a key, and honoring it would write a file no reader ever opens.)
 *
 * An empty or whitespace-only `project_dir` yields NO KEY rather than a walk from
 * nowhere — `hasGitEntry('')` probes `.git` relative to the cwd the harness
 * happened to run us in, and a key must never depend on cwd.
 */
function resolveStateKey(projectDir) {
  const envKey = process.env[STATE_KEY_ENV_VAR];
  if (typeof envKey === 'string' && envKey.trim() !== '') return envKey;
  if (typeof projectDir !== 'string' || projectDir.trim() === '') return undefined;
  return deriveStateKey(findRepoRoot(projectDir) ?? projectDir);
}

/**
 * The PER-SESSION snapshot, at `~/.ghola/statusline/state/<key>.json`. Read by
 * the VS Code status bar (`src/status-bar/mode-status-bar.ts`) for the window it
 * is running in — which is the whole point, and the reason this is a second write
 * rather than a replacement for `writeUsageState` above: that file's unkeyed path
 * is a documented cross-module contract with `tool.usage-observer` and is left
 * exactly as it was. The two functions are kept separate, duplication and all,
 * because their gates and their audiences differ and neither should be able to
 * change the other by accident.
 *
 * Same shape, same key ORDER, and the same epoch-SECONDS `updated` as the unkeyed
 * file, so a reader written for one can read the other. It is also BYTE-IDENTICAL
 * to what the `.sh` writes here, which the unkeyed file is not: Python's
 * `json.dump` defaults to `", "`/`": "` separators where `JSON.stringify` emits
 * none, so the `.sh` passes `separators=(",", ":")` for this file only. Nothing
 * reads bytes rather than parsed JSON, but it makes the two renderers diffable.
 *
 * The gate is DELIBERATELY WIDER than the unkeyed one: any of the three metrics
 * present is enough, where the unkeyed write ignores a context percentage that
 * arrives without a token count. The status bar's job is to show context %, so
 * dropping a ctx-only payload would blank it for no reason. A payload with NO
 * metric at all still writes nothing, so an empty render can never clobber a good
 * snapshot with a bare timestamp — and the writer never gates on AGE, because
 * staleness belongs to the reader (`STATE_STALE_AFTER_MS`).
 */
function writeKeyedState(key, tokens, contextPct, fiveHourPct) {
  if (key === undefined) return;
  if (tokens === undefined && contextPct === undefined && fiveHourPct === undefined) return;
  let tmpPath;
  try {
    const stateDir = path.join(os.homedir(), '.ghola', 'statusline', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const statePath = path.join(stateDir, `${key}.json`);
    const obj = { updated: Math.floor(Date.now() / 1000) };
    if (tokens !== undefined) obj.session_tokens = tokens;
    if (contextPct !== undefined) obj.context_pct = contextPct;
    if (fiveHourPct !== undefined) obj.five_hour_pct = fiveHourPct;
    // PID in the temp name, exactly as above: a fixed `.tmp` lets the second of
    // two concurrent renders truncate the file the first is about to rename into
    // place, publishing a torn snapshot.
    tmpPath = `${statePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(obj));
    fs.renameSync(tmpPath, statePath);
    tmpPath = undefined;
  } catch {
    // A filesystem fault here can never break the status line.
    if (tmpPath !== undefined) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Nothing more to do; leaving one stray temp file is the harmless case.
      }
    }
  }
}

/** Render `<pct>%`, red at or above the fixed 85% threshold. */
function pctSegment(prefix, pct) {
  return pct >= 85 ? `${prefix}\u001b[31m${pct}%\u001b[0m` : `${prefix}${pct}%`;
}

// ── Silent mode ─────────────────────────────────────────────────────────────
// THE SAME RULES LIVE IN `scripts/ghola-statusline.sh` — same marker path, same
// environment variable, same precedence, same truthiness sets — and must stay
// identical. See this file's header for the full rationale, including why the
// control surface is a marker file rather than a module setting. Every constant
// below is chosen to be trivially reproducible in bash: explicit ASCII token
// lists, an explicit `[A-Z]` case fold, and a POSIX whitespace class.
const SILENT_ENV_VAR = 'GHOLA_STATUSLINE_SILENT';
/** `<homedir>/.ghola/statusline/silent`, spelled as segments so both hosts agree. */
const SILENT_MARKER_SEGMENTS = ['.ghola', 'statusline', 'silent'];
const SILENT_ENV_TRUE_VALUES = ['1', 'true', 'yes'];
const SILENT_ENV_FALSE_VALUES = ['0', 'false', 'no'];
/** POSIX `[:space:]`, not JS `\s`, which is wider — matching `readVersion`. */
const POSIX_SPACE_LEADING = /^[ \t\n\v\f\r]+/;
const POSIX_SPACE_TRAILING = /[ \t\n\v\f\r]+$/;

/**
 * The environment override: `true` (silent), `false` (explicitly NOT silent, and
 * therefore beating the marker file), or `undefined` for NO SIGNAL.
 *
 * Unset, empty, whitespace-only, and unrecognized values all yield `undefined`
 * rather than `false`, and that distinction is load-bearing: `export
 * GHOLA_STATUSLINE_SILENT=` is absence, not an instruction, and treating it as an
 * explicit "not silent" would make the marker file unusable in any shell that
 * exports the variable empty. Only the three literal words in
 * `SILENT_ENV_FALSE_VALUES` override the marker. An unrecognized value (a typo)
 * also defers, so a mistyped `ture` can never silence the line by accident —
 * every ambiguous input errs toward PRINTING.
 *
 * Case folding is `[A-Z]`-explicit rather than `toLowerCase()` for the same
 * reason the state key folds that way: it is the only spelling this file and the
 * `.sh`'s `case` globs agree on for non-ASCII input.
 */
function readSilentEnvOverride() {
  const raw = process.env[SILENT_ENV_VAR];
  if (typeof raw !== 'string') return undefined;
  const value = raw
    .replace(POSIX_SPACE_LEADING, '')
    .replace(POSIX_SPACE_TRAILING, '')
    .replace(/[A-Z]/g, (character) => character.toLowerCase());
  if (SILENT_ENV_TRUE_VALUES.includes(value)) return true;
  if (SILENT_ENV_FALSE_VALUES.includes(value)) return false;
  return undefined;
}

/**
 * Whether the marker file exists. ANY failure answers `false` — i.e. NOT silent —
 * because the only safe direction for a broken check is to print. `existsSync`
 * already swallows its own errors, so the try/catch is for `os.homedir()`, which
 * can throw when no home directory can be determined at all.
 */
function hasSilentMarker() {
  try {
    return fs.existsSync(path.join(os.homedir(), ...SILENT_MARKER_SEGMENTS));
  } catch {
    return false;
  }
}

/** Environment override first, marker file second, print by default. */
function resolveSilent() {
  const override = readSilentEnvOverride();
  if (override !== undefined) return override;
  return hasSilentMarker();
}

// Resolved BEFORE the main block, at module scope, so the last-resort fallback in
// the `catch` at the bottom can honor it too — a silenced renderer that starts
// shouting `[Ghola vunknown]` the moment something goes wrong would be worse than
// no silent mode at all. `resolveSilent` cannot throw (both halves swallow their
// own failures), so evaluating it outside the try is safe.
const silent = resolveSilent();

let version = 'unknown';
try {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  version = readVersion(scriptDir);

  const payload = readPayload();

  // Raw numeric values (or undefined) mirrored into the usage-state file; the
  // display strings are derived from them for the status line itself.
  let rawTokens;
  let rawCtx;
  let rawFh;
  let projectDir;
  let tokensStr = '';
  let pct;
  let fiveHourPct;

  if (payload.trim() !== '') {
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // Malformed JSON -> every segment stays empty, version-only output.
    }
    const root = parsed !== null && typeof parsed === 'object' ? parsed : undefined;
    try {
      const cw = root?.context_window;
      if (cw !== null && typeof cw === 'object') {
        const ti = asPyNumber(cw.total_input_tokens);
        const to = asPyNumber(cw.total_output_tokens);
        const up = asPyNumber(cw.used_percentage);
        if (ti !== undefined && to !== undefined) {
          // `int()` in the .sh truncates toward zero before summing.
          const total = Math.trunc(ti) + Math.trunc(to);
          if (total >= 0) {
            tokensStr = fmtTokens(total);
            rawTokens = total;
          }
        }
        if (up !== undefined) {
          pct = Math.max(0, pyRound(up));
          rawCtx = pct;
        }
      }
    } catch {
      // Matches the .sh's per-block `except`: a fault reading the context window
      // never prevents the rate-limit block below from contributing.
    }
    try {
      const fh = root?.rate_limits?.five_hour;
      if (fh !== null && typeof fh === 'object') {
        const fhUp = asPyNumber(fh.used_percentage);
        if (fhUp !== undefined) {
          fiveHourPct = Math.max(0, pyRound(fhUp));
          rawFh = fiveHourPct;
        }
      }
    } catch {
      // Same isolation as above.
    }
    try {
      // Only consulted when GHOLA_STATE_KEY is absent, but read unconditionally so
      // the parse stays in its own isolated block like the two above.
      const ws = root?.workspace;
      if (ws !== null && typeof ws === 'object' && typeof ws.project_dir === 'string') {
        projectDir = ws.project_dir;
      }
    } catch {
      // Same isolation as above.
    }
  }

  writeUsageState(rawTokens, rawCtx, rawFh);
  writeKeyedState(resolveStateKey(projectDir), rawTokens, rawCtx, rawFh);

  // Each segment is independent — gated on its own source field being present.
  // Segments joined with ' · ' (U+00B7); the ' | ' separator below is U+2502 and
  // appears only when at least one segment is present.
  const parts = [];
  if (tokensStr !== '') parts.push(tokensStr);
  if (pct !== undefined) parts.push(pctSegment('', pct));
  if (fiveHourPct !== undefined) parts.push(pctSegment('5h ', fiveHourPct));

  const line =
    parts.length > 0
      ? `[Ghola v${version} \u2502 ${parts.join(' \u00b7 ')}]`
      : `[Ghola v${version}]`;
  // THE ONLY THING SILENT MODE SUPPRESSES. Both state writes above already
  // happened, unconditionally, which is the entire point: the status-bar pill
  // keeps its data while the footer row disappears. Zero bytes are written rather
  // than a newline — the harness normalizes the two to the same "absent" anyway,
  // but writing nothing is the honest spelling of printing nothing.
  if (!silent) process.stdout.write(line);
} catch {
  // Unreachable in practice — every step above handles its own failure. Degrade
  // to the shortest sensible line and exit 0 regardless — but stay silent if we
  // were asked to be, because a fallback that ignored the flag would put the
  // footer back at exactly the least convenient moment.
  try {
    if (!silent) process.stdout.write(`[Ghola v${version}]`);
  } catch {
    // Even stdout is gone: emit nothing rather than throwing.
  }
}
process.exitCode = 0;
