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

/** Render `<pct>%`, red at or above the fixed 85% threshold. */
function pctSegment(prefix, pct) {
  return pct >= 85 ? `${prefix}\u001b[31m${pct}%\u001b[0m` : `${prefix}${pct}%`;
}

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
  }

  writeUsageState(rawTokens, rawCtx, rawFh);

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
  process.stdout.write(line);
} catch {
  // Unreachable in practice — every step above handles its own failure. Degrade
  // to the shortest sensible line and exit 0 regardless.
  try {
    process.stdout.write(`[Ghola v${version}]`);
  } catch {
    // Even stdout is gone: emit nothing rather than throwing.
  }
}
process.exitCode = 0;
