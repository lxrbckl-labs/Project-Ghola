#!/usr/bin/env node
// ghola-statusline-parity.mjs - parity checker for the statusline STATE-KEY TRIPLICATE.
//
// WHAT THIS GUARDS
// ----------------
// One algorithm ("turn an absolute repo-root path into the name of this session's
// statusline state file") is implemented THREE times in this repo:
//
//   1. src/session/statusline-state.ts   TypeScript  the READER (status-bar pill)
//   2. scripts/ghola-statusline.mjs      JavaScript  a WRITER (Node renderer)
//   3. scripts/ghola-statusline.sh       Python 3    the other WRITER (embedded
//                                                    `python3` heredoc)
//
// DRIFT BETWEEN THEM FAILS SILENTLY. The writer writes `<key A>.json`, the reader
// opens `<key B>.json`, finds nothing, and the metrics segment simply never
// appears. There is no error, no log line, and nothing to grep. The operator sees
// a feature that "just stopped working" and has no thread to pull. That is a worse
// failure than a crash, and it is the entire reason this file exists.
//
// It is also load-bearing well beyond edge cases, though not for the reason an
// earlier draft of this comment gave. `GHOLA_STATE_KEY` IS set in the common
// case - any Ghola-launched session with a workspace folder open, since
// launcher.ts exports it (src/session/launcher.ts:445-446, the env var itself
// named by STATE_KEY_ENV_VAR in src/session/statusline-state.ts:81) - and both
// writers honor it verbatim there, skipping derivation on that path entirely.
// The launcher omits it only when no workspace folder is open, and that is when
// the writers fall back to their full derivation - re-slash, trailing-trim,
// ASCII case fold, sha256, fold, collapse, truncate, trim. The TS reader has no
// env-var branch at all (see TS ASYMMETRIES below), so it runs that same full
// derivation on every refresh regardless of which case the writers are in.
// Both branches occur for real in this fleet, so the vectors below have to hold
// for the derivation path and for the env-var-wins-verbatim path alike.
//
// The duplication is not an oversight and cannot be centralized. (3) must be
// Python because the `.sh` renderer already depends on `python3` for safe JSON
// parsing and may not assume `jq` or `node`. (2) is invoked as
// `node scripts/ghola-statusline.mjs`, is not part of the esbuild bundle, and
// therefore cannot import from `src/`. (1) is the extension host. So today the
// ONLY thing keeping the three aligned is three keep-in-sync comments. Comments do
// not fail a build. This script does.
//
// The three agreed when the feature shipped because three separate agents each ran
// vectors by hand, in a scratch directory that no longer exists. Nothing in the
// repo re-checked it until now.
//
// HOW IT REACHES EACH IMPLEMENTATION (without modifying any of them)
// -----------------------------------------------------------------
//   ts  - statusline-state.ts imports `./team-identity` for the repo-root walk and
//         is TypeScript, so plain Node cannot require it. Both files are
//         type-stripped with the esbuild ALREADY IN node_modules (`transformSync`,
//         no config change, nothing written to dist/) and evaluated with a custom
//         `require` that hands back the real `crypto`/`fs`/`os`/`path`. The files
//         are read verbatim and never touched.
//   mjs - ghola-statusline.mjs runs a whole render at import time, so it cannot be
//         imported. Its five key functions and five constants are extracted by
//         ANCHORED line ranges (function header -> next column-0 `}`) into one
//         scope and evaluated with `crypto`/`fs`/`path`/`process` supplied as
//         function parameters. The renderer body never runs.
//   sh  - the `python3` block is a quoted heredoc, and running it would parse a
//         payload AND WRITE TO THE OPERATOR'S REAL `~/.ghola/`. So the heredoc body
//         is sliced out of the shell script, and then only the constant lines and
//         `def` blocks are sliced out of THAT - the block's top-level statements
//         (payload parse, state-file write, silent-marker probe) are left behind
//         entirely. The result is a side-effect-free module, given a generated
//         driver, and run as `python3 <file> <cases.json>`.
//
// All three extractions are anchored on names, never on line numbers, so they
// survive edits above them and fail LOUDLY (exit 2, "UNREACHED") rather than
// silently grabbing the wrong text if something is renamed or reindented.
//
// WHAT IS COMPARED
// ----------------
//   * the four shared constants, by source literal (env var name, hash length,
//     body cap, empty-body placeholder);
//   * `normalize` -> `fold` -> `key` for every case in CASES, three ways;
//   * the baked-in NORMATIVE VECTORS, which are the source of truth: nine
//     independently computed input/key pairs plus hand-derivable expected bodies
//     for the adversarial cases. Three-way agreement alone is not enough - three
//     implementations can agree on the WRONG answer if someone "fixes" all three
//     together, and the vectors are what catches that;
//   * the structural INVARIANTS every key must satisfy, on every case;
//   * the RELATIONS between pairs of cases - which inputs must collide and which
//     must not. The lossy-fold pair (`/a/b_c` vs `/a/b-c`) is the case the hash
//     exists for, and the accented pair is a tripwire for a regression from the
//     explicit `[A-Z]` fold to `toLowerCase()`/`.lower()`;
//   * `resolveStateKey`, including `GHOLA_STATE_KEY`-wins-verbatim and the git-root
//     walk, against a scratch fixture tree.
//
// TS ASYMMETRIES (by design, not failures)
// ----------------------------------------
//   * `foldStateKeyBody` is module-private in the TS. Its output is recovered from
//     the key instead - `key.slice(0, -(hashLength + 1))` is exact, because
//     `deriveStateKey` is defined as `body + '-' + hash8`.
//   * TS `resolveStateKey` deliberately does NOT read `GHOLA_STATE_KEY`; the
//     extension host receives the key from `launcher.ts`, which is what exports the
//     variable in the first place. Only the two writers implement the env-var
//     precedence, so those rows are `n/a` for TS. The NAME of the variable is still
//     compared three ways, which is the part that can drift.
//
// USAGE
// -----
//   node scripts/ghola-statusline-parity.mjs
//
// Exits 0 when all three implementations agree with each other AND with the
// vectors, 1 on any mismatch, 2 when an implementation could not be reached at all
// (a coverage gap is never silently tolerated - an UNREACHED implementation means
// parity is UNVERIFIED, which is exactly the state this script exists to end).
//
// Read-only with respect to the repo, and it NEVER touches `~/.ghola`. The only
// things it writes are the extracted-source scratch files and the git-root fixture
// tree, under a STABLE directory in the OS temp dir (the same convention
// `ghola-path-parity.mjs` and the boot probe already use). Files are overwritten in
// place on every run, so nothing accumulates and nothing is ever deleted.
//
// THIS FILE IS ASCII-ONLY, deliberately. Non-ASCII test inputs are spelled with
// `\uXXXX` escapes. A UTF-8 character read back through a CP1252 codepage caused a
// real parse failure in this repo, and ASCII costs nothing.

// `node:crypto` explicitly, NOT the global `crypto`: since Node 19 a global
// `crypto` exists and is the Web Crypto API, which has no `createHash`. All three
// implementations want the node builtin, so relying on the bare identifier would
// hand them the wrong object.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_TS = path.join(REPO, 'src', 'session', 'statusline-state.ts');
const TEAM_IDENTITY_TS = path.join(REPO, 'src', 'session', 'team-identity.ts');
const RENDERER_MJS = path.join(REPO, 'scripts', 'ghola-statusline.mjs');
const RENDERER_SH = path.join(REPO, 'scripts', 'ghola-statusline.sh');

// -- The normative vectors --------------------------------------------------
// THE SOURCE OF TRUTH. These nine input/key pairs were computed by hand, off the
// written spec in statusline-state.ts's header, and reproduced independently before
// being written down here. They are NOT derived from any of the three
// implementations at run time, which is the whole point: if all three drift the
// same way in one commit they still fail against these.
//
// `key` is the complete expected key. `body` is the expected FOLDED BODY only, used
// for the adversarial cases below where the 8 hex characters cannot be
// hand-verified but the readable half can. When both are absent a case is checked
// for three-way agreement and invariants alone.
const A100 = 'a'.repeat(100);
const B99 = 'b'.repeat(99);
const C99 = 'c'.repeat(99);

const CASES = [
  // ---- the nine normative vectors ----
  {
    input: '/home/aarbuckle/projects/Project-Ghola',
    key: 'home-aarbuckle-projects-project-ghola-c25f1c43',
    note: 'NORMATIVE - this repo, the everyday case',
  },
  {
    input: '/mnt/c/Users/aarbuckle/source/repos/cmms1',
    key: 'mnt-c-users-aarbuckle-source-repos-cmms1-208427f3',
    note: 'NORMATIVE - a /mnt/c workspace as WSL sees it',
  },
  {
    input: 'C:\\Users\\aarbuckle\\source\\repos\\cmms1',
    key: 'c-users-aarbuckle-source-repos-cmms1-beb399b9',
    note: 'NORMATIVE - the same tree as native Windows spells it',
  },
  {
    input: '/mnt/c/Users/aarbuckle/source/repos/cmms1/cmms-api',
    key: 'mnt-c-users-aarbuckle-source-repos-cmms1-cmms-api-f4329654',
    note: 'NORMATIVE - nested repo, must not collide with its parent',
  },
  {
    input: '/home/aarbuckle/projects/My Project',
    key: 'home-aarbuckle-projects-my-project-74c56692',
    note: 'NORMATIVE - space folds to a hyphen',
  },
  {
    input: '/home/aarbuckle/projects/Project-Ghola/',
    key: 'home-aarbuckle-projects-project-ghola-c25f1c43',
    note: 'NORMATIVE - trailing separator is trimmed before hashing',
  },
  {
    input: 'C:\\Users\\aarbuckle\\source\\repos\\cmms1\\',
    key: 'c-users-aarbuckle-source-repos-cmms1-beb399b9',
    note: 'NORMATIVE - trailing BACKslash, trimmed after re-slashing',
  },
  {
    input: '/',
    key: 'root-8a5edab2',
    note: 'NORMATIVE - filesystem root; body empties, placeholder takes over',
  },
  {
    input: '/home/aarbuckle/projects/a_b',
    key: 'home-aarbuckle-projects-a_b-d17581fb',
    note: 'NORMATIVE - underscore is IN the safe class and survives folding',
  },

  // ---- adversarial cases the nine do not reach ----
  {
    input: '',
    key: 'root-e3b0c442',
    note: 'EMPTY STRING - sha256("") is the well-known e3b0c442..., hand-checkable',
  },
  {
    input: '   ',
    body: 'root',
    note: 'whitespace only - folds away entirely, hashes as itself',
  },
  {
    input: '///',
    body: 'root',
    note: 'ALL SEPARATORS - the trailing trim must NOT empty this (step 2 keeps the pre-strip string)',
  },
  {
    input: '\\\\',
    body: 'root',
    note: 'two backslashes - re-slash to //, then the same all-separator rule',
  },
  {
    input: '\\',
    key: 'root-8a5edab2',
    note: 'ONE backslash - re-slashes to / and is therefore the SAME key as /',
  },
  {
    input: 'C:',
    body: 'c',
    note: 'BARE DRIVE - no separator at all; the colon folds away leaving one character',
  },
  {
    input: 'C:\\',
    body: 'c',
    note: 'bare drive with a trailing backslash - must equal the bare form',
  },
  {
    input: '/@#$%/',
    body: 'root',
    note: 'A SEGMENT THAT FOLDS TO NOTHING BUT HYPHENS - reaches the placeholder without being all-separator',
  },
  {
    input: '/@#$%/x',
    body: 'x',
    note: 'the same unsafe segment with a real one after it - collapses to a single hyphen, then trims',
  },
  {
    input: '/a//b///c',
    body: 'a-b-c',
    note: 'INTERIOR separator runs - collapse makes this share a body with /a/b-c',
  },
  {
    input: '/a/b_c',
    body: 'a-b_c',
    note: 'LOSSY-FOLD PAIR (1 of 2) - underscore is safe, so this body differs',
  },
  {
    input: '/a/b-c',
    body: 'a-b-c',
    note: 'LOSSY-FOLD PAIR (2 of 2) - see the RELATIONS section; the hash is what separates these',
  },
  {
    input: '/HOME/AARBUCKLE/PROJECTS/PROJECT-GHOLA',
    key: 'home-aarbuckle-projects-project-ghola-c25f1c43',
    note: 'ALL UPPERCASE - must be byte-identical to the mixed-case normative vector',
  },
  {
    input: '/home/aarbuckle/projects/caf\u00e9',
    body: 'home-aarbuckle-projects-caf',
    note: 'NON-ASCII - e-acute is outside the safe class and folds to a hyphen, which then trims off the end',
  },
  {
    input: '/home/aarbuckle/projects/CAF\u00c9',
    body: 'home-aarbuckle-projects-caf',
    note: 'NON-ASCII UPPERCASE - E-acute is NOT in [A-Z], so it survives the case fold and hashes differently',
  },
  {
    input: '/home/aarbuckle/projects/x...',
    body: 'home-aarbuckle-projects-x...',
    note: 'TRAILING DOTS - `.` is safe so they survive the body; the appended hash is what keeps the FILENAME from ending in a dot (silently stripped on Windows)',
  },
  {
    input: `/home/aarbuckle/projects/${'a'.repeat(120)}`,
    body: A100,
    note: 'TRUNCATION past 100 - the folded body is 145 chars; the LAST 100 are kept',
  },
  {
    input: `/x/y/${B99}`,
    body: B99,
    note: 'TRUNCATION LANDING EXACTLY ON A HYPHEN (leading) - the 100-char tail starts with the separator hyphen, which the post-truncation trim removes, leaving 99',
  },
  {
    input: `/x/y/${C99} `,
    body: C99,
    note: 'TRUNCATION LANDING EXACTLY ON A HYPHEN (trailing) - the trailing space folds to a hyphen that survives truncation and is trimmed off the END',
  },
  {
    input: 'z'.repeat(150),
    body: 'z'.repeat(100),
    note: 'no separators at all, over the cap - pure tail truncation',
  },
  {
    input: '/mnt/c/Users/aarbuckle/source/repos/cmms1/cmms-api/src/main/resources/very/deeply/nested/module/path/here',
    note: 'a realistic over-cap path - checked for agreement and invariants only',
  },

  // ---- former QUARANTINE cases, promoted after the \Z fix ----
  // Python's `$` in a non-MULTILINE pattern matches at the end of the string OR
  // immediately before a single trailing newline; JavaScript's `$` without `/m`
  // matches only at the very end. scripts/ghola-statusline.sh now anchors both
  // trailing-separator strips with `\Z` instead of `$`, which matches only the
  // absolute end in Python too, so all three implementations agree here.
  {
    input: '/home/aarbuckle/projects/x/\n',
    key: 'home-aarbuckle-projects-x-80f2c040',
    note: 'FORMERLY QUARANTINED - trailing separator run + ONE newline; python `\\Z` no longer matches before it, so this now agrees with JS/TS',
  },
  {
    input: '/home/aarbuckle/projects/x/\n\n',
    note: 'CONTROL - two trailing newlines; python `$` only ever looked past the LAST one, so all three already agreed here even before the fix',
  },
  {
    input: '/home/aarbuckle/projects/x/\r',
    note: 'CONTROL - carriage return is not special to either `$` or `\\Z`; all three agree',
  },
];

// -- Relations between cases ------------------------------------------------
// Which inputs MUST collide and which MUST NOT. An implementation can pass every
// individual vector and still be wrong about the relationships, and the
// relationships are where the design decisions actually live.
const RELATIONS = [
  {
    a: '/home/aarbuckle/projects/Project-Ghola',
    b: '/home/aarbuckle/projects/Project-Ghola/',
    want: 'same',
    why: 'a trailing separator is not a different repository',
  },
  {
    a: '/home/aarbuckle/projects/Project-Ghola',
    b: '/HOME/AARBUCKLE/PROJECTS/PROJECT-GHOLA',
    want: 'same',
    why: 'ASCII case is folded: NTFS is case-insensitive and the two sides of this contract can each see a different casing of one directory',
  },
  {
    a: '/',
    b: '\\',
    want: 'same',
    why: 'the re-slash happens BEFORE the trailing-run trim, so a lone backslash is the root',
  },
  {
    a: '/',
    b: '///',
    want: 'differ',
    why: 'an all-separator input is kept rather than emptied, so /// hashes as itself - if step 2 emptied it, these would collide',
  },
  {
    a: 'C:',
    b: 'C:\\',
    want: 'same',
    why: 'a bare drive and a drive root are the same place',
  },
  {
    a: '/a/b_c',
    b: '/a/b-c',
    want: 'differ',
    why: 'THE CASE THE HASH EXISTS FOR: folding is lossy and both of these fold toward the same shape, so only sha256 OF THE NORMALIZED PATH keeps them apart. Hashing the folded body instead would preserve this collision',
  },
  {
    a: '/a/b-c',
    b: '/a//b///c',
    want: 'differ',
    why: 'a second lossy-fold collision - IDENTICAL bodies (a-b-c), separated only by the hash',
  },
  {
    a: '/@#$%/',
    b: '/',
    want: 'differ',
    why: 'both land on the `root` placeholder body; the placeholder is a placeholder, not a bucket',
  },
  {
    a: '/mnt/c/Users/aarbuckle/source/repos/cmms1',
    b: 'C:\\Users\\aarbuckle\\source\\repos\\cmms1',
    want: 'differ',
    why: 'the WSL and Windows spellings of ONE directory key DIFFERENTLY. This is not a bug being tolerated - it is precisely why launcher.ts exports GHOLA_STATE_KEY so writer and reader agree by construction instead of by derivation',
  },
  {
    a: '/home/aarbuckle/projects/caf\u00e9',
    b: '/home/aarbuckle/projects/CAF\u00c9',
    want: 'differ',
    why: 'TRIPWIRE for the ASCII-only case fold. E-acute is outside [A-Z], so it survives normalization and these hash apart. A regression from the explicit [A-Z] class to toLowerCase()/.lower() would make them EQUAL in some languages and not others - the exact silent three-way drift this file guards',
  },
  {
    a: '',
    b: '/',
    want: 'differ',
    why: 'both fold to `root`; the empty string is not the filesystem root',
  },
  {
    a: `/x/y/${B99}`,
    b: `/x/y/${C99} `,
    want: 'differ',
    why: 'two different truncation edges, both yielding a 99-character body',
  },
];

// -- The four shared constants, compared by SOURCE LITERAL -----------------
// Two of them are module-private in the TypeScript and one is inlined rather than
// named in the Python, so they cannot all be read out of an evaluated scope. They
// are read out of the SOURCE instead, anchored on the declaration, which also means
// a rename fails loudly instead of being reported as a missing value.
const CONSTANTS = [
  {
    name: 'env var name',
    ts: /^export const STATE_KEY_ENV_VAR = '([^']*)';/,
    mjs: /^const STATE_KEY_ENV_VAR = '([^']*)';/,
    py: /^STATE_KEY_ENV_VAR = "([^"]*)"/,
  },
  {
    name: 'hash length',
    ts: /^export const STATE_KEY_HASH_LENGTH = (\d+);/,
    mjs: /^const STATE_KEY_HASH_LENGTH = (\d+);/,
    py: /^STATE_KEY_HASH_LENGTH = (\d+)/,
  },
  {
    name: 'body cap',
    ts: /^const STATE_KEY_BODY_MAX_LENGTH = (\d+);/,
    mjs: /^const STATE_KEY_BODY_MAX_LENGTH = (\d+);/,
    py: /^STATE_KEY_BODY_MAX_LENGTH = (\d+)/,
  },
  {
    name: 'empty body',
    ts: /^const STATE_KEY_EMPTY_BODY = '([^']*)';/,
    mjs: /^const STATE_KEY_EMPTY_BODY = '([^']*)';/,
    py: /^STATE_KEY_EMPTY_BODY = "([^"]*)"/,
  },
];

const out = [];
const say = (s = '') => out.push(s);

// -- Anchored source extraction --------------------------------------------

/** All lines of a file, cached so each source is read exactly once. */
const sourceCache = new Map();
function lines(file) {
  if (!sourceCache.has(file)) sourceCache.set(file, fs.readFileSync(file, 'utf8').split('\n'));
  return sourceCache.get(file);
}

/**
 * The single line matching `re`, with its first capture group. Throws when there is
 * no match or more than one - an ambiguous anchor is a broken anchor.
 */
function extractLiteral(src, re, what) {
  const hits = src.filter((l) => re.test(l));
  if (hits.length === 0) throw new Error(`${what}: no line matches ${re}`);
  if (hits.length > 1) throw new Error(`${what}: ${hits.length} lines match ${re} (ambiguous)`);
  return re.exec(hits[0])[1];
}

/**
 * A brace-delimited block: from the line matching `headerRe` through the next
 * column-0 `}`. Anchored on the header rather than on line numbers so it survives
 * edits above it. Same technique as `ghola-path-parity.mjs`.
 */
function extractBraceBlock(src, headerRe, what) {
  const start = src.findIndex((l) => headerRe.test(l));
  if (start === -1) throw new Error(`${what}: no line matches ${headerRe}`);
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === '}') return { text: src.slice(start, i + 1).join('\n'), first: start + 1, last: i + 1 };
  }
  throw new Error(`${what}: no closing column-0 '}' after line ${start + 1}`);
}

/**
 * A Python `def` block: from the `def` line through the last line before the next
 * line that is non-empty AND unindented. Python has no closing brace, so
 * indentation is the only available anchor; requiring the terminator to be at
 * column 0 is safe here because every extracted def is itself at column 0.
 */
function extractPyDef(src, name) {
  const start = src.findIndex((l) => l.startsWith(`def ${name}(`));
  if (start === -1) throw new Error(`python block: no 'def ${name}(' line`);
  let end = src.length;
  for (let i = start + 1; i < src.length; i++) {
    if (src[i].trim() !== '' && !/^\s/.test(src[i])) {
      end = i;
      break;
    }
  }
  return src.slice(start, end).join('\n').replace(/\s+$/, '');
}

/**
 * The body of the `<<'PY'` heredoc inside the shell renderer, as an array of lines.
 * Quoted heredoc, so what is on disk is exactly what `python3` receives - no shell
 * expansion to undo.
 */
function extractPythonBlock() {
  const src = lines(RENDERER_SH);
  const start = src.findIndex((l) => l.includes("python3 - <<'PY'"));
  if (start === -1) throw new Error(`${RENDERER_SH}: no "python3 - <<'PY'" heredoc opener`);
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === 'PY') return { body: src.slice(start + 1, i), first: start + 2, last: i };
  }
  throw new Error(`${RENDERER_SH}: heredoc opened at line ${start + 1} is never closed by a column-0 'PY'`);
}

// -- The request every implementation answers ------------------------------
// One shared batch so the three are driven over identical input in identical order.
// `resolves` exercises `resolveStateKey`: `env` is the GHOLA_STATE_KEY value (null =
// unset), `dir` is the starting directory (null = undefined).
function buildRequest(fixture) {
  return {
    inputs: CASES.map((c) => c.input),
    resolves: [
      { env: null, dir: path.join(fixture, 'repo', 'sub', 'deep'), note: 'walks up to the .git FILE (worktree form)' },
      { env: null, dir: path.join(fixture, 'repo'), note: 'the root itself, probed exactly once' },
      { env: null, dir: `${path.join(fixture, 'repo')}${path.sep}`, note: 'trailing separator comes off BEFORE the walk' },
      { env: null, dir: path.join(fixture, 'plain'), note: 'no .git above: falls back to the start directory' },
      { env: null, dir: '', note: 'empty: NO KEY, never a walk from the process cwd' },
      { env: null, dir: '   ', note: 'whitespace only: NO KEY' },
      { env: null, dir: null, note: 'undefined: NO KEY' },
      { env: 'literal-key-used-verbatim', dir: path.join(fixture, 'repo', 'sub', 'deep'), note: 'GHOLA_STATE_KEY WINS - verbatim, no folding, no hashing, no walk' },
      { env: '   ', dir: path.join(fixture, 'plain'), note: 'whitespace-only env is treated as ABSENT and the walk runs' },
    ],
  };
}

// -- Implementation 1: TypeScript ------------------------------------------
// Type-strip statusline-state.ts (and team-identity.ts, which it imports for the
// repo-root walk) with the in-tree esbuild, then evaluate with a `require` that
// hands back the real Node builtins. Nothing is written to dist/ and no config is
// touched. Note the deliberate asymmetries recorded in the header: the fold is
// private and is recovered from the key, and TS has no env-var branch.
async function loadTs() {
  const esbuild = await import('esbuild');
  const target = `node${process.versions.node.split('.')[0]}`;
  const evaluate = (file, requireFn) => {
    const { code } = esbuild.transformSync(fs.readFileSync(file, 'utf8'), {
      loader: 'ts',
      format: 'cjs',
      target,
      sourcefile: path.basename(file),
    });
    const mod = { exports: {} };
    new Function('exports', 'require', 'module', '__filename', '__dirname', code)(
      mod.exports,
      requireFn,
      mod,
      file,
      path.dirname(file),
    );
    return mod.exports;
  };
  const builtins = { crypto, fs, os, path };
  const builtinRequire = (spec) => {
    const key = spec.replace(/^node:/, '');
    if (key in builtins) return builtins[key];
    throw new Error(`unexpected import from team-identity.ts: ${spec}`);
  };
  const teamIdentity = evaluate(TEAM_IDENTITY_TS, builtinRequire);
  const mod = evaluate(STATE_TS, (spec) => {
    if (spec.includes('team-identity')) return teamIdentity;
    return builtinRequire(spec);
  });
  for (const fn of ['normalizeStateKeyPath', 'deriveStateKey', 'resolveStateKey']) {
    if (typeof mod[fn] !== 'function') throw new Error(`statusline-state.ts did not export ${fn}`);
  }
  return mod;
}

function runTs(mod, request, hashLength) {
  return {
    rows: request.inputs.map((input) => {
      const key = mod.deriveStateKey(input);
      return {
        normalized: mod.normalizeStateKeyPath(input),
        // The fold is module-private; the key is `body + '-' + hash8` by definition,
        // so slicing the hash off recovers it exactly.
        folded: key.slice(0, -(hashLength + 1)),
        key,
      };
    }),
    // TS has no GHOLA_STATE_KEY branch by design - see the header.
    resolves: request.resolves.map((r) =>
      r.env === null ? (mod.resolveStateKey(r.dir === null ? undefined : r.dir) ?? null) : undefined,
    ),
  };
}

// -- Implementation 2: the .mjs renderer ----------------------------------
// Extract the five constants and five functions by anchored range and evaluate them
// in one scope with `crypto`/`fs`/`path`/`process` shadowed by function parameters.
// The renderer's own top-level render call is never included, so it never runs.
function loadMjs() {
  const src = lines(RENDERER_MJS);
  const constNames = [
    'STATE_KEY_ENV_VAR',
    'STATE_KEY_HASH_LENGTH',
    'STATE_KEY_SAFE_CHARS',
    'STATE_KEY_BODY_MAX_LENGTH',
    'STATE_KEY_EMPTY_BODY',
    'MAX_ROOT_WALK_STEPS',
  ];
  const fnNames = [
    'normalizeStateKeyPath',
    'foldStateKeyBody',
    'deriveStateKey',
    'hasGitEntry',
    'findRepoRoot',
    'resolveStateKey',
  ];
  const pieces = [];
  for (const name of constNames) {
    const re = new RegExp(`^const ${name} = `);
    const line = src.find((l) => re.test(l));
    if (line === undefined) throw new Error(`${RENDERER_MJS}: no 'const ${name} = ' line`);
    pieces.push(line);
  }
  const spans = [];
  for (const name of fnNames) {
    const block = extractBraceBlock(src, new RegExp(`^function ${name}\\(`), RENDERER_MJS);
    spans.push(block);
    pieces.push(block.text);
  }
  const processStub = { env: {} };
  const factory = new Function(
    'crypto',
    'fs',
    'path',
    'process',
    `${pieces.join('\n')}\nreturn { normalizeStateKeyPath, foldStateKeyBody, deriveStateKey, resolveStateKey };`,
  );
  return {
    api: factory(crypto, fs, path, processStub),
    processStub,
    first: Math.min(...spans.map((s) => s.first)),
    last: Math.max(...spans.map((s) => s.last)),
  };
}

function runMjs(loaded, request) {
  const { api, processStub } = loaded;
  return {
    rows: request.inputs.map((input) => {
      const normalized = api.normalizeStateKeyPath(input);
      return { normalized, folded: api.foldStateKeyBody(normalized), key: api.deriveStateKey(input) };
    }),
    resolves: request.resolves.map((r) => {
      if (r.env === null) delete processStub.env.GHOLA_STATE_KEY;
      else processStub.env.GHOLA_STATE_KEY = r.env;
      return api.resolveStateKey(r.dir === null ? undefined : r.dir) ?? null;
    }),
  };
}

// -- Implementation 3: the embedded python3 block --------------------------
// Slice the heredoc out of the .sh, then slice ONLY the constants and defs out of
// the heredoc. Everything else in that block - the payload parse, the silent-marker
// probe, and crucially the WRITE TO ~/.ghola/statusline/state - is left behind, so
// running the extract cannot touch the operator's real state directory.
function runPython(tmpdir, request) {
  const block = extractPythonBlock();
  const constNames = [
    'STATE_KEY_ENV_VAR',
    'STATE_KEY_HASH_LENGTH',
    'STATE_KEY_BODY_MAX_LENGTH',
    'STATE_KEY_EMPTY_BODY',
    'MAX_ROOT_WALK_STEPS',
  ];
  const defNames = [
    'normalize_state_key_path',
    'fold_state_key_body',
    'derive_state_key',
    'has_git_entry',
    'find_repo_root',
    'resolve_state_key',
  ];
  const pieces = [
    '# Generated by scripts/ghola-statusline-parity.mjs.',
    '# Constants and defs EXTRACTED VERBATIM from the python3 heredoc in',
    '# scripts/ghola-statusline.sh. The heredoc\'s top-level statements - payload',
    '# parse, silent-marker probe, and the write to ~/.ghola/statusline/state - are',
    '# deliberately NOT included, so this file has no side effects at all.',
    'import hashlib, json, os, re, sys',
    '',
  ];
  for (const name of constNames) {
    const re = new RegExp(`^${name} = `);
    const line = block.body.find((l) => re.test(l));
    if (line === undefined) throw new Error(`python block: no '${name} = ' line`);
    pieces.push(line);
  }
  pieces.push('');
  for (const name of defNames) pieces.push(extractPyDef(block.body, name), '');

  // The driver. Kept to plain assignments and loops so it cannot mask a failure in
  // the extracted code, and underscore-prefixed so it cannot shadow anything above.
  pieces.push(
    '_req = json.load(open(sys.argv[1], encoding="utf-8"))',
    '_rows = []',
    'for _s in _req["inputs"]:',
    '    _n = normalize_state_key_path(_s)',
    '    _rows.append({"normalized": _n, "folded": fold_state_key_body(_n), "key": derive_state_key(_s)})',
    '_resolves = []',
    'for _r in _req["resolves"]:',
    '    if _r["env"] is None:',
    '        os.environ.pop(STATE_KEY_ENV_VAR, None)',
    '    else:',
    '        os.environ[STATE_KEY_ENV_VAR] = _r["env"]',
    '    _resolves.append(resolve_state_key(_r["dir"]))',
    'json.dump({"rows": _rows, "resolves": _resolves}, sys.stdout)',
    '',
  );

  const driver = path.join(tmpdir, 'statusline_state_key.py');
  const casesFile = path.join(tmpdir, 'cases.json');
  fs.writeFileSync(driver, pieces.join('\n'));
  // ensure_ascii by default in JSON.stringify? No - so escape non-ASCII explicitly.
  // Python's json.load handles \uXXXX, and an ASCII-only file cannot be mangled by
  // a codepage mismatch on the way through.
  fs.writeFileSync(casesFile, toAsciiJson(request));
  // An EXPLICIT, minimal environment: the real session almost certainly has
  // GHOLA_STATE_KEY-adjacent variables set, and inheriting them would make the
  // env-var rows depend on who ran the check.
  const raw = execFileSync('python3', [driver, casesFile], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C.UTF-8' },
  });
  return { ...JSON.parse(raw), first: block.first, last: block.last, driver };
}

/** JSON with every non-ASCII code unit escaped, so the wire stays 7-bit. */
function toAsciiJson(value) {
  return JSON.stringify(value).replace(/[\u0080-\uffff]/g, (c) =>
    `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

// -- Invariants ------------------------------------------------------------
// Structural properties every key must have regardless of input. These are what
// catch a change that keeps all three in step but breaks the CONTRACT with the
// filesystem (a leading hyphen that CLI tooling reads as an option flag, a name
// past a filesystem's component limit, a trailing dot that Windows strips).
const KEY_SHAPE = /^[a-z0-9._-]+-[0-9a-f]{8}$/;

function checkInvariants(input, folded, key, bodyMax) {
  const bad = [];
  if (folded.length === 0) bad.push('body is EMPTY (the placeholder should have taken over)');
  if (folded.length > bodyMax) bad.push(`body is ${folded.length} chars, over the ${bodyMax} cap`);
  if (folded.startsWith('-')) bad.push('body starts with a hyphen (reads as an option flag)');
  if (folded.endsWith('-')) bad.push('body ends with a hyphen');
  if (!KEY_SHAPE.test(key)) bad.push(`key does not match ${KEY_SHAPE}`);
  if (key.endsWith('.')) bad.push('key ends with a dot (silently stripped on Windows)');
  if (key !== `${folded}-${key.slice(folded.length + 1)}`) bad.push('key is not <body>-<hash>');
  void input;
  return bad;
}

// -- Report helpers -------------------------------------------------------
/** Every control character and every non-ASCII byte made visible; empty made loud. */
function show(s) {
  if (s === null || s === undefined) return '(none)';
  if (s === '') return "''";
  const escaped = s.replace(/[^\x20-\x7e]/g, (c) => {
    if (c === '\n') return '\\n';
    if (c === '\r') return '\\r';
    if (c === '\t') return '\\t';
    return `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
  return /^\s|\s$/.test(s) ? `'${escaped}'` : escaped;
}

/** Middle-elided, so a 150-character case cannot destroy the table layout. */
function abbrev(s, width = 44) {
  if (s.length <= width) return s;
  const head = Math.ceil((width - 3) / 2);
  return `${s.slice(0, head)}...${s.slice(s.length - (width - 3 - head))}`;
}

const pad = (s, w) => (s.length >= w ? s : s + ' '.repeat(w - s.length));

function table(rows, headers) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => `  ${cells.map((c, i) => pad(String(c), widths[i])).join('  ')}`.trimEnd();
  say(line(headers));
  say(`  ${widths.map((w) => '-'.repeat(w)).join('  ')}`);
  rows.forEach((r) => say(line(r)));
}

// -- Main ----------------------------------------------------------------
// Stable directory name, recreated if absent, files overwritten in place: nothing
// accumulates across runs and there is no cleanup step, so this script never
// deletes anything. Same convention as ghola-path-parity.mjs and the boot probe.
const tmpdir = path.join(os.tmpdir(), 'ghola-statusline-parity');
const fixture = path.join(tmpdir, 'fixture');
let exitCode = 0;
const failures = [];

try {
  fs.mkdirSync(path.join(fixture, 'repo', 'sub', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'plain'), { recursive: true });
  // A `.git` FILE, not a directory - the linked-worktree/submodule form. All three
  // walks must test for EXISTENCE, never for directory-ness; an isDirectory() test
  // walks straight past every worktree, which is a bug that was already found and
  // fixed once in team-identity.ts.
  fs.writeFileSync(path.join(fixture, 'repo', '.git'), 'gitdir: /nonexistent/worktree/fixture\n');

  const request = buildRequest(fixture);

  let ts = null;
  let tsErr = null;
  try {
    ts = await loadTs();
  } catch (err) {
    tsErr = err;
  }

  let mjs = null;
  let mjsErr = null;
  try {
    mjs = loadMjs();
  } catch (err) {
    mjsErr = err;
  }

  let py = null;
  let pyErr = null;
  try {
    py = runPython(tmpdir, request);
  } catch (err) {
    pyErr = err;
  }

  say('ghola-statusline-parity - statusline state-key triplicate parity check');
  say(`repo: ${REPO}`);
  say(`host: node ${process.version} on ${process.platform}`);
  say(`scratch: ${tmpdir}  (extracted sources + git-root fixture; never ~/.ghola)`);
  say();
  say('REACHABILITY');
  table(
    [
      [
        'ts',
        'src/session/statusline-state.ts',
        ts ? 'REACHED (esbuild transformSync, + team-identity.ts for the walk)' : `UNREACHED (${tsErr.message})`,
      ],
      [
        'mjs',
        'scripts/ghola-statusline.mjs',
        mjs
          ? `REACHED (lines ${mjs.first}-${mjs.last} extracted; renderer body never runs)`
          : `UNREACHED (${mjsErr.message})`,
      ],
      [
        'py',
        'scripts/ghola-statusline.sh',
        py
          ? `REACHED (heredoc lines ${py.first}-${py.last}; defs only, no state write)`
          : `UNREACHED (${pyErr.message})`,
      ],
    ],
    ['impl', 'file', 'status'],
  );

  if (!ts || !mjs || !py) {
    say();
    say('FATAL: at least one implementation could not be reached; parity is UNVERIFIED.');
    say('An UNREACHED implementation is the exact state this script exists to end, so it');
    say('is never tolerated silently. Fix the anchor in this harness, or the source.');
    exitCode = 2;
  } else {
    // ---- constants, by source literal ----
    const tsSrc = lines(STATE_TS);
    const mjsSrc = lines(RENDERER_MJS);
    const pySrc = extractPythonBlock().body;
    const constRows = [];
    let bodyMax = 100;
    let hashLength = 8;
    for (const c of CONSTANTS) {
      const values = {};
      for (const [impl, src, what] of [
        ['ts', tsSrc, STATE_TS],
        ['mjs', mjsSrc, RENDERER_MJS],
        ['py', pySrc, 'python block'],
      ]) {
        try {
          values[impl] = extractLiteral(src, c[impl], what);
        } catch (err) {
          values[impl] = null;
          failures.push({ kind: 'CONSTANT', where: `${c.name} / ${impl}`, detail: err.message });
        }
      }
      const agree = values.ts !== null && values.ts === values.mjs && values.ts === values.py;
      if (!agree && values.ts !== null && values.mjs !== null && values.py !== null) {
        failures.push({
          kind: 'CONSTANT',
          where: c.name,
          detail: `ts=${show(values.ts)} mjs=${show(values.mjs)} py=${show(values.py)}`,
        });
      }
      if (agree && c.name === 'body cap') bodyMax = Number(values.ts);
      if (agree && c.name === 'hash length') hashLength = Number(values.ts);
      constRows.push([c.name, show(values.ts), show(values.mjs), show(values.py), agree ? 'ok' : 'DIVERGE']);
    }
    say();
    say('SHARED CONSTANTS (read from source, not from an evaluated scope)');
    table(constRows, ['constant', 'ts', 'mjs', 'py', '']);

    // ---- the case table, three ways, against the vectors ----
    const tsRun = runTs(ts, request, hashLength);
    const mjsRun = runMjs(mjs, request);
    const keysByInput = new Map();
    const caseRows = [];

    for (let i = 0; i < CASES.length; i++) {
      const c = CASES[i];
      const r = { ts: tsRun.rows[i], mjs: mjsRun.rows[i], py: py.rows[i] };
      const marks = [];

      // Three-way agreement, per stage, so a report names the stage that drifted.
      for (const stage of ['normalized', 'folded', 'key']) {
        if (!(r.ts[stage] === r.mjs[stage] && r.ts[stage] === r.py[stage])) {
          marks.push('DRIFT');
          failures.push({
            kind: 'THREE-WAY DRIFT',
            where: `${stage}  input ${show(c.input)}`,
            note: c.note,
            detail: `ts=${show(r.ts[stage])}\n      mjs=${show(r.mjs[stage])}\n      py=${show(r.py[stage])}`,
          });
        }
      }

      // The vectors. Three implementations agreeing on a wrong answer is a real
      // failure mode - somebody "fixes" all three in one commit - and this is the
      // only thing that catches it.
      if (c.key !== undefined && r.ts.key !== c.key) {
        marks.push('VECTOR');
        failures.push({
          kind: 'VECTOR',
          where: `input ${show(c.input)}`,
          note: c.note,
          detail: `expected key ${show(c.key)}\n      actual   key ${show(r.ts.key)}`,
        });
      }
      if (c.body !== undefined && r.ts.folded !== c.body) {
        marks.push('BODY');
        failures.push({
          kind: 'VECTOR BODY',
          where: `input ${show(c.input)}`,
          note: c.note,
          detail: `expected body ${show(abbrev(c.body, 60))}\n      actual   body ${show(abbrev(r.ts.folded, 60))}`,
        });
      }

      // Invariants are checked on the TS result only, and that is complete rather
      // than partial: the three-way check above has already run, so a violation
      // present in only one or two implementations is reported as DRIFT, and one
      // present in all three is reported here. Re-checking all three would only
      // triplicate the same message.
      const bad = checkInvariants(c.input, r.ts.folded, r.ts.key, bodyMax);
      if (bad.length > 0) {
        marks.push('INVARIANT');
        for (const b of bad) {
          failures.push({ kind: 'INVARIANT', where: `input ${show(c.input)}`, note: c.note, detail: b });
        }
      }

      keysByInput.set(c.input, r.ts.key);
      caseRows.push([
        abbrev(show(c.input)),
        String(r.ts.folded.length),
        abbrev(show(r.ts.key), 58),
        marks.length === 0 ? (c.key !== undefined ? 'ok/vec' : c.body !== undefined ? 'ok/body' : 'ok') : marks.join('+'),
      ]);
    }

    say();
    say(`CASES (${CASES.length}) - each checked three ways, against its vector, and for invariants`);
    say('  `ok/vec` = full key vector matched; `ok/body` = expected folded body matched;');
    say('  `ok` = three-way agreement and invariants only. `len` is the folded body length.');
    table(caseRows, ['input', 'len', 'key (all three agree unless marked)', '']);

    say();
    say('CASE NOTES');
    for (const c of CASES) say(`  ${abbrev(show(c.input), 40).padEnd(42)} ${c.note}`);

    // ---- relations ----
    const relRows = [];
    for (const rel of RELATIONS) {
      const ka = keysByInput.get(rel.a);
      const kb = keysByInput.get(rel.b);
      if (ka === undefined || kb === undefined) {
        failures.push({
          kind: 'RELATION',
          where: `${show(rel.a)} vs ${show(rel.b)}`,
          detail: 'one side is not in CASES, so it was never derived',
        });
        continue;
      }
      const same = ka === kb;
      const ok = rel.want === 'same' ? same : !same;
      if (!ok) {
        failures.push({
          kind: 'RELATION',
          where: `${show(rel.a)} vs ${show(rel.b)}`,
          note: rel.why,
          detail: `expected these keys to ${rel.want.toUpperCase()}, got\n      a=${show(ka)}\n      b=${show(kb)}`,
        });
      }
      relRows.push([abbrev(show(rel.a), 34), abbrev(show(rel.b), 34), rel.want, ok ? 'ok' : 'FAIL']);
    }
    say();
    say(`RELATIONS (${RELATIONS.length}) - which inputs must collide and which must not`);
    table(relRows, ['a', 'b', 'must', '']);
    say();
    for (const rel of RELATIONS) {
      say(`  ${show(rel.a)} ${rel.want === 'same' ? '==' : '!='} ${show(rel.b)}`);
      say(`      ${rel.why}`);
    }

    // ---- resolveStateKey: env-var precedence and the git-root walk ----
    const resolveRows = [];
    for (let i = 0; i < request.resolves.length; i++) {
      const r = request.resolves[i];
      const v = { ts: tsRun.resolves[i], mjs: mjsRun.resolves[i], py: py.resolves[i] };
      // TS has no env branch (see the header), so it is only compared on env-unset
      // rows; `undefined` is this harness's marker for "not applicable".
      const comparable = v.ts === undefined ? [v.mjs, v.py] : [v.ts, v.mjs, v.py];
      const agree = comparable.every((x) => x === comparable[0]);
      if (!agree) {
        failures.push({
          kind: 'RESOLVE',
          where: `env=${show(r.env)} dir=${show(r.dir)}`,
          note: r.note,
          detail: `ts=${v.ts === undefined ? 'n/a' : show(v.ts)}\n      mjs=${show(v.mjs)}\n      py=${show(v.py)}`,
        });
      }
      if (r.env !== null && r.env.trim() !== '' && v.mjs !== r.env) {
        failures.push({
          kind: 'RESOLVE',
          where: `env=${show(r.env)} dir=${show(r.dir)}`,
          note: 'GHOLA_STATE_KEY must be used VERBATIM',
          detail: `expected ${show(r.env)}, got ${show(v.mjs)}`,
        });
      }
      resolveRows.push([
        show(r.env),
        abbrev(show(r.dir), 40),
        v.ts === undefined ? 'n/a' : abbrev(show(v.ts), 30),
        abbrev(show(v.mjs), 30),
        agree ? 'ok' : 'DIVERGE',
      ]);
    }
    say();
    say('resolveStateKey - GHOLA_STATE_KEY precedence and the git-root walk');
    say(`  fixture: ${fixture}  (repo/.git is a FILE, i.e. the worktree form)`);
    table(resolveRows, ['GHOLA_STATE_KEY', 'start dir', 'ts', 'mjs (= py)', '']);
    for (let i = 0; i < request.resolves.length; i++) {
      say(`  ${show(request.resolves[i].env).padEnd(28)} ${request.resolves[i].note}`);
    }

    say();
    if (failures.length === 0) {
      say(
        `PARITY OK - ${CASES.length} cases x 3 implementations x 3 stages, ${CONSTANTS.length} constants, ` +
          `${RELATIONS.length} relations, ${request.resolves.length} resolve cases. No drift.`,
      );
      say('All three implementations agree with each other AND with the baked-in vectors.');
    } else {
      exitCode = 1;
      say(`PARITY FAILURES (${failures.length}) - THE TRIPLICATE HAS DRIFTED`);
      say();
      for (const f of failures) {
        say(`  [${f.kind}] ${f.where}`);
        if (f.note) say(`      case: ${f.note}`);
        say(`      ${f.detail}`);
        say();
      }
      say('Reconcile src/session/statusline-state.ts (the NORMATIVE spec),');
      say('scripts/ghola-statusline.mjs, and the python3 block in');
      say('scripts/ghola-statusline.sh - all three in the same commit. A VECTOR failure');
      say('means the answer itself changed, not just that the three disagree: if that was');
      say('intended, the vectors in this file must be recomputed and the reason recorded.');
      say('Until this exits 0, every keyed state file on disk is suspect: a writer may be');
      say('writing where the status bar never looks, and that failure is INVISIBLE at runtime.');
    }
  }
} catch (err) {
  say(`ghola-statusline-parity: harness error: ${err && err.stack ? err.stack : err}`);
  exitCode = 2;
}

// `process.exitCode` rather than `process.exit()` so stdout is fully flushed even
// when the report is piped into a file or a pager.
process.stdout.write(`${out.join('\n')}\n`);
process.exitCode = exitCode;
