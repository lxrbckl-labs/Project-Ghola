#!/usr/bin/env node
// ghola-path-parity.mjs — parity checker for the host-path translation TRIPLICATE.
//
// WHAT THIS GUARDS
// ----------------
// One path-translation rule set ("rewrite a possibly-foreign absolute path into
// the running host's native form") is implemented THREE times in this repo:
//
//   1. scripts/ghola-boot-probe.sh   `translate_path()`   pure bash `case` globs
//   2. src/session/host-path.ts      `toNativeHostPath()` the extension host
//   3. scripts/ghola.mjs             `toNativeHostPath()` the standalone CLI
//
// The duplication is DELIBERATE, not an oversight. (1) must be pure bash with no
// subprocess (`cygpath -m /mnt/c/Users/x` returns a syntactically perfect,
// NONEXISTENT path, and the probe may never write to stderr or depend on PATH).
// (3) is invoked as `node scripts/ghola.mjs`, is not part of the esbuild bundle,
// and therefore cannot import from `src/`. So the rules cannot be centralized in
// one place, and today the ONLY thing keeping the three aligned is three
// keep-in-sync comments. Comments do not fail a build. This script does.
//
// A drift here is expensive and quiet: joining a `/mnt/c/...` value under win32
// `path` semantics yields the drive-relative `\mnt\c\...`, which `path.resolve`
// anchors to the current drive (`C:\mnt\c\...`) — a fabricated tree that reads as
// a perfectly legitimate Windows path. That is the exact bug all three
// implementations exist to prevent, and the failure mode of a divergence is one
// surface writing the ledger somewhere the other surfaces never look.
//
// HOW IT REACHES EACH IMPLEMENTATION (without modifying any of them)
// -----------------------------------------------------------------
//   bash — `translate_path` lives inside a script that runs a whole boot probe
//          when executed, so it cannot simply be sourced. The function's line
//          range is extracted (anchored on its `translate_path() {` header and
//          the next column-0 `}`) into a temp file, which is sourced in a
//          subshell. The probe body never runs.
//   ts   — host-path.ts imports `vscode` types and `../state/module-settings`
//          (which imports `vscode` for real), so plain Node cannot require it.
//          It is type-stripped with the esbuild ALREADY IN node_modules
//          (`transformSync`, no config change, nothing written to dist/) and
//          evaluated with a custom `require` that supplies stubs. The file
//          itself is read verbatim and never touched.
//   mjs  — scripts/ghola.mjs calls `main()` at import time, so it cannot be
//          imported either. Its `toNativeHostPath` is extracted by the same
//          anchored line-range technique as the bash one and evaluated with a
//          stubbed `process`/`fs`/`console`.
//
// FORCING THE PLATFORM
// --------------------
// All three branch on host platform and this repo lives on WSL, so the win32
// branches never run naturally — and they are the interesting ones. The bash
// implementation reads a cached `shell_os` global, so the harness simply assigns
// it before each call. The two JS implementations read `os.platform()` /
// `process.platform`, which the stubs above override.
//
// PURE TRANSFORM vs SURROUNDING ADOPT LOGIC (read before "fixing" a report)
// ------------------------------------------------------------------------
// `translate_path` is a PURE string function. The two JS functions are NOT: they
// end in an anti-fabrication gate that returns the ORIGINAL string unless
// `fs.existsSync(translated)` passes. The bash gate is external to the function
// (boot-probe blocks 8a/8b). Those two gates are intentionally shaped
// differently and this checker does NOT compare them:
//
//   * JS   — always translate, then adopt the translation only if it EXISTS.
//            i.e. prefer the translation, fall back to the original. Note that
//            the BARE RE-SLASH counts as a translation for this purpose: where
//            `translate_path` returns the re-slashed string unconditionally even
//            when no platform arm fired (`C:\Users\x` -> `C:/Users/x`), the JS
//            pair puts that spelling through the same existence gate, because a
//            backslash is a legal POSIX filename character and an unconditional
//            re-slash could therefore invent a path. That is KEEP-IN-SYNC
//            EXCEPTION 1, recorded in all three implementations; because this
//            script neutralizes the gate, the transforms compare EQUAL and the
//            case stays a real contract-pair check rather than an asymmetry.
//   * bash — 8a translates only when the stored value FAILS `-d`, and adopts the
//            result only when it PASSES `-d`; 8b adds a windows-only form
//            canonicalization for a path that already resolves.
//            i.e. prefer the original, fall back to the translation.
//
// Those differ only when BOTH forms resolve on the same host, which off win32
// requires a directory literally named `C:` and on win32 is exactly what block
// 8b exists to canonicalize. Reporting that as a bug would be crying wolf. So
// this script neutralizes the gate (stubbed `existsSync`) and compares the
// STRING TRANSFORMATION, which is the part that genuinely must agree. The
// GATE BEHAVIOR section at the end demonstrates the gate rather than judging it.
//
// PLATFORM MAPPING IS NOT 1:1 (also not a bug, also reported not failed)
// ---------------------------------------------------------------------
// bash models THREE platforms (`windows`, `wsl`, `unix`) and deliberately makes
// `unix` the identity so a plain Linux or macOS host is never rewritten. The JS
// implementations model TWO (`win32` vs everything else) and therefore apply the
// WSL rule on darwin and on non-WSL Linux. `windows/win32` and `wsl/linux` are
// contract pairs and any disagreement there is a FAILURE. `unix/darwin` has no
// shared contract, so differences there are reported as an ASYMMETRY.
//
// This is KEEP-IN-SYNC EXCEPTION 2, and it has been reviewed and ACCEPTED rather
// than fixed: teaching the JS pair a `unix` branch means giving it a WSL detector,
// i.e. a FOURTH copy of a rule set whose triplication is already the problem this
// script guards. The JS `existsSync` gate neutralizes the difference on any host
// with no `/mnt/<letter>` tree, which is every plain Linux and macOS host. The
// known residual is a plain-Linux host that genuinely mounts `/mnt/c`: there the
// JS pair would adopt `C:/Users/x` -> `/mnt/c/Users/x` where bash keeps
// `C:/Users/x`. Neither supported host (WSL, native Windows) is affected and the
// adopted path is one `existsSync` CONFIRMED, so the worst case is a disagreement
// about a real directory rather than a fabrication. The reasoning is recorded in
// all three implementations' keep-in-sync comments.
//
// USAGE
// -----
//   node scripts/ghola-path-parity.mjs
//
// Exits 0 when every contract pair agrees, 1 when any pair diverges (or when the
// two JS mirrors disagree with each other on ANY platform), 2 when an
// implementation could not be reached at all. Read-only with respect to the repo
// and the vault: the only thing it writes is the extracted-function scratch
// directory under the OS temp dir (the same convention the boot probe itself
// uses). That directory has a STABLE name and its three files are overwritten in
// place on every run, so nothing accumulates and nothing is ever deleted.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = path.join(REPO, 'scripts', 'ghola-boot-probe.sh');
const HOST_PATH_TS = path.join(REPO, 'src', 'session', 'host-path.ts');
const CLI_MJS = path.join(REPO, 'scripts', 'ghola.mjs');

// ── The shared case table ───────────────────────────────────────────────────
// Every adversarial input that has ever mattered here, in one place. The three
// implementations all claim to handle these identically; that claim is the whole
// point of the file. `label` exists only so the empty string and whitespace are
// visible in the report.
const CASES = [
  ['/mnt/c/Users/x', 'WSL drive mount, deepest common real case'],
  ['/mnt/c/', 'WSL drive mount, trailing slash (must not become C://)'],
  ['/mnt/c', 'WSL drive mount, bare (must not become C: with no root)'],
  ['/mnt/C/Users/x', 'WSL drive mount, uppercase letter'],
  ['/c/Users/x', 'MSYS drive form'],
  ['/c', 'MSYS drive form, bare'],
  ['C:/Users/x', 'native Windows, forward slashes'],
  ['C:\\Users\\x', 'native Windows, BACKSLASHES (the likeliest real input)'],
  ['\\mnt\\c\\Users\\x', 'WSL form spelled with backslashes'],
  ['C:', 'drive root, bare'],
  ['C:/', 'drive root, trailing slash'],
  ['c:/users/x', 'native Windows, lowercase drive letter'],
  ['D:/Vault', 'non-C drive'],
  ['D:\\Vault\\sub', 'non-C drive, backslashes'],
  ['/mnt/z/share', 'high drive letter'],
  ['C:foo', 'DRIVE-RELATIVE - ambiguous, must be refused'],
  ['//server/share', 'UNC - must pass through'],
  ['/mnt/wsl/x', 'real WSL mount, must NOT match'],
  ['/mnt/host/y', 'real WSL mount, must NOT match'],
  ['/mnt/cdrom', 'real Linux mount, must NOT match'],
  ['/mnt/data/disk', 'multi-char mount, must NOT match'],
  ['/mnt/d', 'legitimately-named Linux /mnt/d (indistinguishable from a drive)'],
  ['/mnt', 'mount root, no trailing slash'],
  ['/mnt/', 'mount root, trailing slash'],
  ['/home/user/x', 'ordinary POSIX path'],
  ['/', 'filesystem root'],
  ['', '(empty string)'],
  ['relative/path', '(relative path)'],
  ['./x', '(relative path, dot-prefixed)'],
  ['/mnt/c/Program Files/x', 'path containing a space'],
];

// bash platform token <-> JS `platform()` value. `compare: true` marks a real
// contract pair; see the PLATFORM MAPPING note in the header for why
// `unix`/`darwin` is not one.
const GROUPS = [
  { label: 'windows / win32', bash: 'windows', js: 'win32', compare: true },
  { label: 'wsl / linux', bash: 'wsl', js: 'linux', compare: true },
  {
    label: 'unix / darwin',
    bash: 'unix',
    js: 'darwin',
    compare: false,
    note: 'bash `unix` is the identity by design; the JS pair has no `unix` branch and applies the WSL rule here.',
  },
];

const out = [];
const say = (s = '') => out.push(s);

// ── Anchored source extraction ──────────────────────────────────────────────
// Deliberately anchored on the function HEADER and the next column-0 `}` rather
// than on hardcoded line numbers, so the extraction survives edits above it and
// fails loudly (rather than silently grabbing the wrong text) if the function is
// renamed or reindented.
function extractBlock(file, headerRe) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex((l) => headerRe.test(l));
  if (start === -1) throw new Error(`${file}: no line matches ${headerRe}`);
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === '}') {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error(`${file}: no closing column-0 '}' after line ${start + 1}`);
  return {
    text: lines.slice(start, end + 1).join('\n') + '\n',
    firstLine: start + 1,
    lastLine: end + 1,
  };
}

// ── Implementation 1: bash `translate_path` ─────────────────────────────────
// Extract the function alone, source it in a subshell, and drive it over the
// full case table on all three platform tokens. Cases and results travel
// NUL-delimited so a backslash, a space, or the empty string cannot be mangled
// by shell word splitting or by a line-oriented parse.
function runBash(tmpdir) {
  const block = extractBlock(PROBE, /^translate_path\(\) \{$/);
  const fnFile = path.join(tmpdir, 'translate_path.sh');
  const casesFile = path.join(tmpdir, 'cases.nul');
  const runner = path.join(tmpdir, 'run.sh');
  fs.writeFileSync(fnFile, block.text);
  fs.writeFileSync(casesFile, CASES.map(([c]) => c + '\0').join(''));
  fs.writeFileSync(
    runner,
    [
      '#!/usr/bin/env bash',
      '# Generated by scripts/ghola-path-parity.mjs. Sources ONLY the extracted',
      '# translate_path function - the boot probe body never runs. No `set -e`,',
      '# matching the probe, which deliberately has none.',
      '. "$1" || exit 3',
      'for shell_os in windows wsl unix; do',
      '  while IFS= read -r -d \'\' c; do',
      '    printf \'%s\\0%s\\0\' "$shell_os" "$(translate_path "$c")"',
      '  done < "$2"',
      'done',
      '',
    ].join('\n'),
  );
  const raw = execFileSync('bash', [runner, fnFile, casesFile], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  const fields = raw.split('\0');
  if (fields.pop() !== '') throw new Error('bash harness output did not end on a NUL delimiter');
  const expected = 2 * 3 * CASES.length;
  if (fields.length !== expected) {
    throw new Error(`bash harness emitted ${fields.length} fields, expected ${expected}`);
  }
  const results = new Map();
  for (let i = 0, k = 0; i < fields.length; i += 2, k++) {
    const platform = fields[i];
    const caseIndex = k % CASES.length;
    results.set(`${platform}\u0000${CASES[caseIndex][0]}`, fields[i + 1]);
  }
  return { results, block };
}

// ── Implementation 2: TypeScript `toNativeHostPath` ─────────────────────────
// Type-strip host-path.ts with the in-tree esbuild and evaluate the result with
// a custom `require`. `os.platform` and `fs.existsSync` are read at CALL time by
// the implementation, so one module instance plus two mutable closure variables
// covers every platform and both gate states.
async function loadTs(control) {
  const esbuild = await import('esbuild');
  const src = fs.readFileSync(HOST_PATH_TS, 'utf8');
  const { code } = esbuild.transformSync(src, {
    loader: 'ts',
    format: 'cjs',
    target: `node${process.versions.node.split('.')[0]}`,
    sourcefile: 'host-path.ts',
  });
  const osStub = Object.assign({}, os, { platform: () => control.platform });
  const fsStub = { existsSync: () => control.gateOpen };
  const stubRequire = (spec) => {
    if (spec === 'fs' || spec === 'node:fs') return fsStub;
    if (spec === 'os' || spec === 'node:os') return osStub;
    if (spec === 'path' || spec === 'node:path') return path;
    // The only non-builtin import, and it is pulled in solely by
    // `resolveLedgerRoot` (which this checker never calls). It imports `vscode`
    // for real, so it must be stubbed or nothing loads under plain Node.
    if (spec.includes('module-settings')) return { readModuleSettings: () => ({}) };
    throw new Error(`host-path.ts requires an unexpected module: ${spec}`);
  };
  const mod = { exports: {} };
  new Function('exports', 'require', 'module', '__filename', '__dirname', code)(
    mod.exports,
    stubRequire,
    mod,
    HOST_PATH_TS,
    path.dirname(HOST_PATH_TS),
  );
  if (typeof mod.exports.toNativeHostPath !== 'function') {
    throw new Error('host-path.ts did not export a toNativeHostPath function');
  }
  return mod.exports.toNativeHostPath;
}

// ── Implementation 3: the ghola.mjs mirror ─────────────────────────────────
// ghola.mjs runs `main()` at import time, so the mirror is extracted by the same
// anchored-range technique used for bash and evaluated with `process`, `fs` and
// `console` shadowed by function parameters.
function loadMjs(control) {
  const block = extractBlock(CLI_MJS, /^function toNativeHostPath\(p\) \{$/);
  const processStub = Object.create(process, {
    platform: { get: () => control.platform, enumerable: true },
  });
  const fsStub = { existsSync: () => control.gateOpen };
  const consoleStub = { error: (m) => control.warnings.push(m) };
  const factory = new Function(
    'process',
    'fs',
    'console',
    `${block.text}\nreturn toNativeHostPath;`,
  );
  return { fn: factory(processStub, fsStub, consoleStub), block };
}

// ── Report helpers ─────────────────────────────────────────────────────────
const show = (s) => (s === '' ? "''" : s);
const pad = (s, w) => (s.length >= w ? s : s + ' '.repeat(w - s.length));

function table(rows, headers) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i]).length)),
  );
  const line = (cells) => '  ' + cells.map((c, i) => pad(String(c), widths[i])).join('  ').trimEnd();
  say(line(headers));
  say('  ' + widths.map((w) => '-'.repeat(w)).join('  '));
  rows.forEach((r) => say(line(r)));
}

// ── Main ───────────────────────────────────────────────────────────────────
// Stable name, recreated-if-absent, files overwritten in place: no accumulation
// across runs and no cleanup step, so this script never deletes anything.
const tmpdir = path.join(os.tmpdir(), 'ghola-path-parity');
fs.mkdirSync(tmpdir, { recursive: true });
let exitCode = 0;

try {
  const control = { platform: 'linux', gateOpen: true, warnings: [] };

  let bash = null;
  let bashErr = null;
  try {
    bash = runBash(tmpdir);
  } catch (err) {
    bashErr = err;
  }

  let ts = null;
  let tsErr = null;
  try {
    ts = await loadTs(control);
  } catch (err) {
    tsErr = err;
  }

  let mjs = null;
  let mjsErr = null;
  try {
    mjs = loadMjs(control);
  } catch (err) {
    mjsErr = err;
  }

  say('ghola-path-parity - host-path translation triplicate parity check');
  say(`repo: ${REPO}`);
  say(`real host: node ${process.version} on ${process.platform} (all platforms below are FORCED)`);
  say();
  say('REACHABILITY');
  table(
    [
      [
        'bash',
        'scripts/ghola-boot-probe.sh',
        'translate_path',
        bash
          ? `REACHED (lines ${bash.block.firstLine}-${bash.block.lastLine}, extracted + sourced)`
          : `UNREACHED (${bashErr.message})`,
      ],
      [
        'ts',
        'src/session/host-path.ts',
        'toNativeHostPath',
        ts ? 'REACHED (esbuild transformSync + stubbed os/fs)' : `UNREACHED (${tsErr.message})`,
      ],
      [
        'mjs',
        'scripts/ghola.mjs',
        'toNativeHostPath',
        mjs
          ? `REACHED (lines ${mjs.block.firstLine}-${mjs.block.lastLine}, extracted + stubbed process/fs)`
          : `UNREACHED (${mjsErr.message})`,
      ],
    ],
    ['impl', 'file', 'function', 'status'],
  );

  if (!bash || !ts || !mjs) {
    say();
    say('FATAL: at least one implementation could not be reached; parity is UNVERIFIED.');
    say('Coverage gaps are never silently tolerated - fix the harness or the source.');
    exitCode = 2;
  } else {
    const failures = [];
    const asymmetries = [];

    control.gateOpen = true; // neutralize the anti-fabrication gate: pure transform
    for (const group of GROUPS) {
      const rows = [];
      for (const [input, label] of CASES) {
        control.platform = group.js;
        const b = bash.results.get(`${group.bash}\u0000${input}`);
        const t = ts(input);
        const m = mjs.fn(input);

        // The two JS mirrors are hand-maintained copies of each other. They have
        // no excuse to differ on ANY platform, so this check is unconditional.
        if (t !== m) {
          failures.push({
            kind: 'JS MIRROR',
            group: group.label,
            input,
            label,
            detail: `ts=${show(t)} mjs=${show(m)}`,
          });
        }
        const agree = b === t && b === m;
        let mark;
        if (agree) mark = 'ok';
        else if (group.compare) {
          mark = 'DIVERGE';
          failures.push({
            kind: 'PARITY',
            group: group.label,
            input,
            label,
            detail: `bash=${show(b)} ts=${show(t)} mjs=${show(m)}`,
          });
        } else {
          mark = 'asym';
          asymmetries.push({ group: group.label, input, b, t, m });
        }
        rows.push([show(input), show(b), show(t), show(m), mark, label]);
      }
      say();
      say(
        `PLATFORM GROUP: ${group.label}${group.compare ? '  (contract pair - must agree)' : '  (no shared contract - differences are reported, not failed)'}`,
      );
      if (group.note) say(`  note: ${group.note}`);
      table(rows, ['input', 'bash', 'ts', 'mjs', '', 'case']);
    }

    // Demonstrate, without judging, the gate that surrounds the JS transform.
    say();
    say('GATE BEHAVIOR (surrounding logic - shown for understanding, NOT compared)');
    say('  The JS pair ends in `if (!existsSync(translated)) return original`. Forcing that');
    say('  check to fail shows the anti-fabrication guard: the caller gets the ORIGINAL');
    say('  string back, un-re-slashed. `translate_path` has no such check inside it - the');
    say('  equivalent gate lives in boot-probe blocks 8a/8b, which try the STORED value');
    say('  first and adopt a translation only if it passes `-d`. Same intent, mirrored');
    say('  preference order; they can only disagree when both forms resolve at once.');
    control.gateOpen = false;
    const gateRows = [];
    for (const input of ['/mnt/c/Users/x', 'C:/Users/x', '/c/Users/x']) {
      for (const group of GROUPS) {
        control.platform = group.js;
        gateRows.push([
          show(input),
          group.js,
          show(bash.results.get(`${group.bash}\u0000${input}`)),
          show(ts(input)),
          show(mjs.fn(input)),
        ]);
      }
    }
    table(gateRows, ['input', 'js platform', 'bash (no gate)', 'ts (gate shut)', 'mjs (gate shut)']);
    control.gateOpen = true;

    if (asymmetries.length > 0) {
      say();
      say(`KNOWN ASYMMETRIES (${asymmetries.length}) - informational, do not affect exit status`);
      for (const a of asymmetries) {
        say(`  [${a.group}] ${show(a.input)}: bash=${show(a.b)} js=${show(a.t)}`);
      }
    }

    say();
    if (failures.length === 0) {
      say(`PARITY OK - ${CASES.length} cases x ${GROUPS.length} platform groups, no contract-pair divergence.`);
    } else {
      exitCode = 1;
      say(`PARITY FAILURES (${failures.length}) - the triplicate has DRIFTED`);
      for (const f of failures) {
        say(`  [${f.kind}] ${f.group}  input ${show(f.input)}  (${f.label})`);
        say(`      ${f.detail}`);
      }
      say();
      say('Each failure is a real difference in the STRING TRANSFORMATION, not a');
      say('difference in the surrounding adopt gate. Reconcile the rule sets in');
      say('scripts/ghola-boot-probe.sh, src/session/host-path.ts and scripts/ghola.mjs,');
      say('or - if a difference is intentional - record it in all three keep-in-sync');
      say('comments AND add it to GROUPS/asymmetry handling here so it stops failing.');
    }
  }
} catch (err) {
  say(`ghola-path-parity: harness error: ${err && err.stack ? err.stack : err}`);
  exitCode = 2;
}

// `process.exitCode` rather than `process.exit()` so stdout is fully flushed even
// when the report is being piped into a file or a pager.
process.stdout.write(out.join('\n') + '\n');
process.exitCode = exitCode;
