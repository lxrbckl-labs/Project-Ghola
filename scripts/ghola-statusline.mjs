#!/usr/bin/env node
// ghola-statusline.mjs — Claude Code statusLine hook for Project-Ghola.
//
// A NODE PORT of `scripts/ghola-statusline.sh` with a BYTE-IDENTICAL output
// contract. Both files are kept: the `.sh` remains in place for back-compat and
// for anyone whose settings already point at it.
//
// ── THIS FILE IS ALSO THE `.sh`'s FALLBACK WRITER ────────────────────────
// The `.sh` performs its two state writes INSIDE its `python3` heredoc, so a host
// with no usable `python3` wrote nothing at all — silently, exit 0, zero bytes, and
// with the footer blank by default the only symptom was a VS Code status-bar pill
// that emptied 90 seconds later. Its step 3a now detects that (its heredoc's last
// act is a one-byte report, so an EMPTY report proves the block never finished) and
// re-runs the render as `node <its own dir>/ghola-statusline.mjs`, piping in the
// payload it already captured and discarding the delegate's stdout.
// WHAT THAT MEANS FOR THIS FILE:
//   - It is resolved BY SIBLING PATH from the `.sh`. Renaming or moving it out of
//     `scripts/` silently disarms that fallback; the `.sh` just skips the attempt.
//   - Both state writes must stay unconditional and must stay driven purely by
//     stdin + the environment, because in that path nothing else configures them.
//   - `python3` remains the `.sh`'s PRIMARY parser and is not bypassed when `node`
//     is present, so the two renderers stay independently exercised and the
//     `python3` heredoc stays the live third implementation that
//     `scripts/ghola-statusline-parity.mjs` checks.
// Nothing in this file changed for it, and nothing here should special-case being
// invoked that way: the delegated run is an ordinary run.
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
//   - BY DEFAULT IT PRINTS NOTHING AT ALL — zero bytes, exit 0. Silent mode is
//     now the DEFAULT rather than an opt-in; see the silent-mode section below.
//     Everything in the next few bullets describes the line that is emitted only
//     when the operator explicitly asks for it back with
//     `GHOLA_STATUSLINE_SILENT=0`. THE STATE WRITES STILL HAPPEN ON EVERY RUN,
//     which is now this renderer's whole reason to exist.
//   - When un-silenced it emits exactly one line on stdout, with NO trailing
//     newline.
//   - That line is EXACTLY `[Ghola v<version>]`. Nothing else is ever appended:
//     there is no metrics group, no U+2502 separator, no U+00B7 join, and no
//     color of any kind. Any tint the operator sees is their terminal styling
//     the custom row, not this script.
//   - THE FOOTER RENDERS NO USAGE METRICS AT ALL. It used to close with a
//     metrics group — `[Ghola v0.25.0 | 62% · 5h 41%]` — carrying the context
//     percentage and the 5-hour rolling-window percentage, and before those an
//     absolute token count. All three are gone from the rendered line, in three
//     separate steps. The token figure went first: it was the same measurement
//     as the context percentage printed twice (`142k` alongside `62%` recovers
//     nothing the percentage does not already say) and the field behind it
//     (context_window.total_input_tokens + total_output_tokens) stopped meaning
//     "cumulative session spend" in Claude Code v2.1.132, where it became the
//     size of the CURRENT context window. The two percentages then went for a
//     different reason: the VS Code status-bar pill now displays the usage stats
//     (`Ghola: cmms2@win · Ticket Work · 34k · 5h 3%`), so the footer was
//     printing the same numbers a second time. It is reduced to a session
//     marker. THIS IS A DISPLAY DECISION ONLY, and the same change is made in
//     the `.sh`.
//   - EVERY VALUE IS STILL COMPUTED AND STILL WRITTEN. `session_tokens`,
//     `context_pct`, and `five_hour_pct` all still land in both state files
//     below, with the same key set, the same key order, and the same timestamp
//     they always had. That on-disk shape is a cross-module contract with
//     tool.usage-observer AND the feed the status-bar pill reads, so it must not
//     move when a rendered segment does. Beyond the silent-mode marker, those
//     two writes are now this renderer's ONLY purpose past printing the version
//     — which is exactly why the computations below have no visible consumer and
//     must not be "cleaned up" as dead code.
//   - On ANY error it must NOT fail and must NOT print error text: it prints
//     nothing (the default) and always exits 0. Un-silenced it degrades to
//     [Ghola v<version>], or [Ghola vunknown] if VERSION is unreadable.
//   - Mirrors the usage snapshot to ~/.ghola/usage-state.json for the
//     `tool.usage-observer` module (same location + shape as the .sh).
//   - ALSO mirrors it to the per-session, KEYED file
//     ~/.ghola/statusline/state/<key>.json, which the VS Code status bar reads.
//     The unkeyed file above is a single path shared by every concurrent
//     session, so it cannot be attributed to a window; the keyed one can. Both
//     writes happen, independently — see `writeKeyedState` for the key rules and
//     `src/session/statusline-state.ts` for the normative spec.
//
// ── Silent mode: THE DEFAULT. No footer line, and the writes still happen ─
// THE OPERATOR WANTS NO FOOTER ROW AT ALL, so silence is the DEFAULT and there is
// nothing to switch on to get it. What used to be the opt-in path is now the
// normal path, which is deliberate: it is already the tested path, and inverting
// one default keeps the change reversible instead of deleting the render.
// THIS SCRIPT IS THE WRITER OF THE TWO STATE FILES ABOVE, so deleting
// `statusLine` from ~/.claude/settings.json is STILL the WRONG way to get a blank
// footer even though the footer is now blank by default: the harness then never
// invokes us, nothing writes state, and the VS Code status-bar pill goes empty
// inside its 90-second staleness window (`STATE_STALE_AFTER_MS`) on BOTH hosts.
// The renderer must keep being invoked, keep running, and keep writing; it simply
// prints nothing. THE STATE WRITES ARE NOW THIS FILE'S PURPOSE — see the warning
// on `writeUsageState` / `writeKeyedState` about not "cleaning up" the
// computations that feed them.
// The controls, in precedence order:
//   - ENV VAR `GHOLA_STATUSLINE_SILENT`, CHECKED FIRST and the ONLY thing that can
//     change the outcome. `0`/`false`/`no` (case-insensitive, surrounding
//     whitespace trimmed) means NOT silent and is the escape hatch that puts the
//     bracket back for one session. `1`/`true`/`yes` means silent, which is what
//     would have happened anyway. Unset, empty, whitespace-only, or any
//     unrecognized value is NO SIGNAL and falls through to the default.
//   - MARKER FILE `<homedir>/.ghola/statusline/silent` — still probed, still
//     answers "silent" when it exists, and now REDUNDANT: it can only ever ask for
//     the behavior that already happens. It is kept rather than removed so an
//     operator who created one still gets exactly what they asked for, and so
//     `SILENT_BY_DEFAULT` below is the single line that restores a printing
//     default. Contents are irrelevant; existence is the whole signal.
// A settings-file toggle is deliberately NOT the control surface: Ghola module
// settings live in VS Code's `globalState`, an opaque `Memento` with no on-disk
// representation, so a standalone script cannot read them at all. An environment
// variable and a marker file are the only things both this renderer and the
// operator can see.
// SILENCE IS ABOUT STDOUT ONLY. Both state writes happen unconditionally and
// BEFORE the print gate.
// NOTE THE FAIL-SAFE DIRECTION INVERTED WITH THE DEFAULT. It used to be that a
// FAILED CHECK degraded to NOT SILENT, so a broken probe could never blank the
// footer. Now the safe direction is the other way: a failure yields NO SIGNAL,
// which falls through to the silent default, because printing a bracket the
// operator asked to be rid of is the wrong answer and there is no longer a footer
// to protect. A failure still never aborts the render and never suppresses a
// state write, which is the invariant that actually matters.
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

// NOTE: there is no `fmtTokens` here any more, and no `pctSegment` either. The
// `k`/`M` abbreviation existed only to render the token segment, and `pctSegment`
// only to render the two percentages with their red-at-85 tint; both went with the
// segments they formatted rather than being left behind as dead code. `session_tokens`,
// `context_pct`, and `five_hour_pct` are all still COMPUTED below and still written
// into both state files, because that on-disk shape is a cross-module contract with
// `tool.usage-observer` and with the VS Code status bar that outlived the display.
// The abbreviation rule the pill needs lives on in `formatTokenCount` in
// `src/session/statusline-state.ts` — that function is live and has a caller, because
// the pill DOES render an absolute token figure (`Ghola: cmms2@win · Ticket Work ·
// 34k · 5h 3%`); this footer is the surface that stopped. The `.sh`'s `fmt_tokens`
// and its two percentage branches were removed in the same changes as this file's.

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

// NOTE: there is no `pctSegment` here any more either. It rendered `<pct>%` with the
// fixed red-at-85 tint for the two percentage segments; with those segments gone it had
// no caller, and the red escape it emitted was the only color this renderer ever
// produced. Nothing below writes an ANSI sequence.

// ── Silent mode ─────────────────────────────────────────────────────────────
// THE SAME RULES LIVE IN `scripts/ghola-statusline.sh` — same marker path, same
// environment variable, same precedence, same truthiness sets — and must stay
// identical. See this file's header for the full rationale, including why the
// control surface is a marker file rather than a module setting. Every constant
// below is chosen to be trivially reproducible in bash: explicit ASCII token
// lists, an explicit `[A-Z]` case fold, and a POSIX whitespace class.
const SILENT_ENV_VAR = 'GHOLA_STATUSLINE_SILENT';
/**
 * SILENCE IS THE DEFAULT. With no environment override and no marker file, this is
 * the answer, so the renderer emits zero bytes on an ordinary invocation while
 * still performing both state writes.
 *
 * It is a named constant rather than a bare `true` in `resolveSilent` because it is
 * the ONE line an operator (or a future agent) flips to restore a printing footer,
 * and because it is the thing the `.sh`'s `_SILENT_BY_DEFAULT` has to agree with.
 * The rendering code it gates is deliberately left intact for the same reason.
 */
const SILENT_BY_DEFAULT = true;
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
 * explicit "not silent" would put the bracket back in every shell that exports the
 * variable empty. Only the three literal words in `SILENT_ENV_FALSE_VALUES` turn
 * the line back on; an unrecognized value (a typo such as `flase`) defers to the
 * default, so a misspelling can never resurrect the footer by accident. Every
 * ambiguous input now errs toward SILENCE, which is the inverse of what it used to
 * do and follows the default rather than contradicting it.
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
 * Whether the marker file exists. ANY failure answers `false` — meaning only "this
 * probe contributes nothing", NOT "print": the default below decides that, and it
 * is silent. `existsSync` already swallows its own errors, so the try/catch is for
 * `os.homedir()`, which can throw when no home directory can be determined at all.
 * A broken probe therefore cannot change the outcome in either direction, which is
 * the property that survived the default inversion.
 */
function hasSilentMarker() {
  try {
    return fs.existsSync(path.join(os.homedir(), ...SILENT_MARKER_SEGMENTS));
  } catch {
    return false;
  }
}

/**
 * Environment override first, marker file second, SILENT by default.
 *
 * The override is the only thing that can change the answer, because the other two
 * terms both say "silent": `GHOLA_STATUSLINE_SILENT=0` is the escape hatch that
 * puts the bracket back, and everything else — marker present, marker absent, probe
 * broken, variable unset — resolves to silence. The marker is still consulted so a
 * marker the operator already created keeps meaning what it said.
 */
function resolveSilent() {
  const override = readSilentEnvOverride();
  if (override !== undefined) return override;
  return hasSilentMarker() || SILENT_BY_DEFAULT;
}

// Resolved BEFORE the main block, at module scope, so the last-resort fallback in
// the `catch` at the bottom can honor it too — a silenced renderer that starts
// shouting `[Ghola vunknown]` the moment something goes wrong would be worse than
// no silent mode at all, and now that silence is the DEFAULT that fallback is the
// path a broken render actually takes. `resolveSilent` cannot throw (both halves
// swallow their own failures), so evaluating it outside the try is safe. Expect
// `true` here on an ordinary invocation.
const silent = resolveSilent();

let version = 'unknown';
try {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  version = readVersion(scriptDir);

  const payload = readPayload();

  // Raw numeric values (or undefined) mirrored into the two state files. ALL THREE
  // ARE WRITE-ONLY NOW: `rawTokens`, `rawCtx`, and `rawFh` feed `session_tokens`,
  // `context_pct`, and `five_hour_pct` in both state files and NONE of them is
  // displayed. The rendered line is the version and nothing else, so the parsing
  // below exists purely to keep those two writes fed — the status-bar pill reads the
  // keyed one, and blanking it is the failure this arrangement is built to avoid.
  // There are deliberately no separate `pct`/`fiveHourPct` display locals any more;
  // the rounded values land straight in the raw fields the writes consume.
  let rawTokens;
  let rawCtx;
  let rawFh;
  let projectDir;

  if (payload.trim() !== '') {
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // Malformed JSON -> every metric stays undefined, so nothing is written and
      // the line is the same version-only output every other path produces.
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
          // Captured for the two state writes only — the `>= 0` gate is kept
          // because `readCount` on the reader side rejects a negative anyway, and
          // writing one would only put a value on disk that nothing will accept.
          if (total >= 0) rawTokens = total;
        }
        if (up !== undefined) {
          // Rounded and clamped exactly as before, and for the same reason the .sh
          // still does it: this is the value that goes ON DISK as `context_pct`, and
          // the status-bar pill's reader expects the same integer it always got.
          rawCtx = Math.max(0, pyRound(up));
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
          // Same as `rawCtx` above: rounded for the on-disk `five_hour_pct`, not for
          // any rendered text.
          rawFh = Math.max(0, pyRound(fhUp));
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

  // THE BRACKET CARRIES THE VERSION AND NOTHING ELSE. There is no metrics group to
  // build, so there is no parts array, no U+2502 separator introducing it, and no
  // U+00B7 joining its members - all three went together, which is the only way to
  // remove a segment without stranding the punctuation that framed it. A single
  // literal is therefore the whole render: no branch can leave a trailing separator,
  // an empty group, or a doubled space inside the bracket, because none of those
  // characters is emitted on any path. The two state writes ABOVE are unaffected and
  // still carry all three metrics; see the header of this file for why that split
  // exists.
  const line = `[Ghola v${version}]`;
  // THE ONLY THING SILENT MODE SUPPRESSES, and on an ordinary invocation it
  // suppresses it — this branch is NOT taken unless the operator set
  // `GHOLA_STATUSLINE_SILENT=0`. The line above is built either way and is NOT dead
  // code: it is the escape hatch's whole output. Both state writes above already
  // happened, unconditionally, which is the entire point: the status-bar pill keeps
  // its data while the footer row is gone. Zero bytes are written rather than a
  // newline — the harness normalizes the two to the same "absent" anyway, but
  // writing nothing is the honest spelling of printing nothing.
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
