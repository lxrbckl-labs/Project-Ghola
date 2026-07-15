#!/usr/bin/env node
//
// ghola.mjs — Phase 1 command layer for Ghola Mode (Project-Ghola).
//
// A self-contained Node CLI, invoked directly (no package.json script entry):
//   node scripts/ghola.mjs <command> [subcommand] --flag value ...
//
// It is the "spine" the design spec (Ghola-Mode-Design.md) describes: TPM
// drives all mission/ghola/ledger state through these terse commands instead
// of writing files itself, so bookkeeping stays cheap and the ledger stays
// the single source of truth. Pure ESM, Node builtins only (fs, path, os,
// process) — no npm dependencies.
//
// ── Ledger-root resolution (GLOBAL — never the work repo) ────────────────
// The ledger root is resolved GLOBALLY, identically to the extension host and
// the session launcher, so all three surfaces agree on one location. NOTHING
// is ever written to or read from the launched work repo (<workspace>/.ghola/
// is gone entirely). Resolution precedence:
//   1. GHOLA_LEDGER_ROOT env (set/non-empty) -> used verbatim. This is what the
//      launcher exports, so an in-session CLI resolves the exact same root the
//      host and launcher computed.
//   2. Else GHOLA_VAULT env (set/non-empty) -> <vault>/_Gholas/.
//   3. Else the home fallback -> <homedir>/.ghola/ledger/ (so War Mode works
//      even with no Obsidian vault and no launcher env at all).
// The resolved root is created with mkdir -p if it does not yet exist (it may
// be the home fallback, or a vault subdir that has never been written).
//
// ── Pointer file (convenience only) ──────────────────────────────────────
// A convenience copy of the ledger-root path is written INSIDE the ledger root
// itself at <ledger-root>/.ledger-path (trailing newline). It lives in the
// vault/home ledger, never the work repo. The extension host does NOT read it
// — the host resolves the ledger root globally the same way this CLI does — so
// it is retained purely as a human-readable breadcrumb. The write is
// content-idempotent (same path every run for a given root) so it deliberately
// happens outside the lock below; concurrent identical writes are harmless.
//
// ── Concurrency approach (CHOSEN: single advisory lockfile) ─────────────
// All ledger mutations for a given ledger root are serialized through one
// lockfile at <ledger-root>/.ghola.lock, acquired with create-exclusive
// (fs.openSync(path, 'wx')) plus randomized backoff. Each acquire stamps a
// UNIQUE NONCE into the lock file and release only unlinks the lock when it
// still reads back that exact nonce, so a process never deletes a lock some
// other process legitimately holds. A stale lock (older than 30s, assumed
// abandoned by a crashed process) is NOT blind-unlinked: it is stolen
// ATOMICALLY via renameSync to a unique temp path, so among racing contenders
// exactly one steal wins and proceeds while the losers retry — this serializes
// takeover and prevents two processes entering the critical section at once.
// This was chosen over bare atomic-rename alone
// because most mutations here are read-modify-write over a shared file
// (append a mission record, append a history bullet, flip a ghola's state)
// — an atomic rename only makes the final write step safe, it does not
// stop two processes from reading the same "before" state and clobbering
// each other's change. The lock makes the whole read-modify-write critical
// section atomic across processes; reads (ls, board, mission list/resume)
// are lock-free per the design spec.
//
// Within a locked section, content updates are written via a temp file in
// the same directory followed by fs.renameSync onto the final name (atomic,
// and never unlinks an existing file to get there). Moving a ghola between
// its subject dir and _archive/<subject>/ (retire/wake/groom) is done with
// fs.renameSync directly between the two paths — a real move, never an
// unlink-then-recreate — per the project's no-deletion rule. Every
// fs.unlinkSync in this file targets our own transient scratch files (the
// lockfile / its rename-steal temp, and atomicWriteFileSync's temp), created
// and destroyed within this script, never ledger content.
//
// ── Ledger layout (created on demand) ────────────────────────────────────
//   <ledger-root>/                       <vault>/_Gholas/ OR <homedir>/.ghola/ledger/
//     .ledger-path                       convenience copy of the root path
//     <subject>/
//       <ghola-slug>.md                  one file per ghola (frontmatter + body)
//       _missions.md                     mission records for this subject
//       operating-notes.md               self-tuning notes (scaffolded lazily)
//       control.json                     per-subject cooperative-control file
//       control.lock                     per-subject control-write lock
//     _archive/<subject>/<ghola-slug>.md soft-archived gholas (moved, not deleted)
//
// Run with --help (or no arguments) for the full command list.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

// ─────────────────────────────────────────────────────────────────────────
// Generic helpers
// ─────────────────────────────────────────────────────────────────────────

// GholaError is thrown (never process.exit()'d directly) so that a fail()
// call from inside a withLock() critical section unwinds normally through
// the pending `finally { releaseLock(...) }` before the process exits — a
// direct process.exit() there would skip that finally and strand the
// lockfile. Only the top-level handler at the bottom of this file turns a
// GholaError into a printed message + process.exit(1).
class GholaError extends Error {}

function fail(msg) {
  throw new GholaError(msg);
}

function nowIso() {
  return new Date().toISOString();
}

function todayDate() {
  return nowIso().slice(0, 10);
}

// Cap kept well under the OS filename limit (255 bytes) — slugs are ASCII
// (one byte per char after the replace below) and also get combined with a
// ".md" suffix and, for archived gholas, nested under an extra directory
// segment, so 100 chars leaves generous headroom in every usage site
// (subject/ghola/template names, --parent).
const SLUG_MAX_LEN = 100;

function slugify(s) {
  const slug = String(s)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LEN)
    .replace(/-+$/g, '');
  return slug || 'x';
}

function truncate(str, n) {
  const s = String(str || '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// Neutralizes newlines in a free-text CLI input before it is written into a
// single-line ledger field or bullet (mission goal/grounded-in/budget,
// progress note, operating note text, alert text, ghola purpose, debrief
// summary, fork --summary, ...). Without this, a value containing "\n## Mission
// ..." (or similar) could inject a phantom block/bullet/header into the
// ledger's line-oriented markdown structures. Multi-line is not a feature of
// these fields, so CR/LF/CRLF simply collapse to a single space.
function sanitizeLine(s) {
  return String(s == null ? '' : s).replace(/\r\n|\r|\n/g, ' ').trim();
}

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readFileOr(p, fallback) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

function atomicWriteFileSync(filePath, content) {
  ensureDirSync(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  // On success the temp is renamed away (nothing left to clean). If the write
  // or rename throws, the temp would otherwise leak - and the no-rm rule means
  // it never gets swept - so unlink OUR OWN scratch temp in a finally (never a
  // repo/ledger file; this is the CLI's transient write buffer). The success
  // path is untouched: renamed=true skips the cleanup.
  let renamed = false;
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // temp may never have been created (write threw first) - nothing to do
      }
    }
  }
}

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function printJson(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

// ─────────────────────────────────────────────────────────────────────────
// Argument parsing
// ─────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function requireFlag(flags, name, usage) {
  const v = flags[name];
  if (v === undefined || v === true) {
    fail(`--${name} is required. Usage: ${usage}`);
  }
  return v;
}

// ─────────────────────────────────────────────────────────────────────────
// Ledger-root resolution (GLOBAL — identical to the host + launcher)
// ─────────────────────────────────────────────────────────────────────────

// Resolves the ledger root and the vault it came from (or null), GLOBALLY per
// the contract shared by the extension host and the session launcher:
//   1. GHOLA_LEDGER_ROOT env (non-empty)  -> used verbatim (vault: null).
//   2. Else GHOLA_VAULT env (non-empty)   -> <vault>/_Gholas (vault: <vault>).
//   3. Else                               -> <homedir>/.ghola/ledger (vault: null).
// It NEVER resolves anything under the launched work repo. Nothing is
// auto-discovered here so the CLI can never drift from the host/launcher, which
// export GHOLA_LEDGER_ROOT/GHOLA_VAULT into the session env.
function resolveLedgerRoot() {
  const envRoot = process.env.GHOLA_LEDGER_ROOT;
  if (typeof envRoot === 'string' && envRoot.trim() !== '') {
    return { root: path.resolve(envRoot.trim()), vault: null };
  }
  const vaultEnv = process.env.GHOLA_VAULT;
  if (typeof vaultEnv === 'string' && vaultEnv.trim() !== '') {
    const vault = path.resolve(vaultEnv.trim());
    return { root: path.join(vault, '_Gholas'), vault };
  }
  return { root: path.join(os.homedir(), '.ghola', 'ledger'), vault: null };
}

// The resolution context shared by every command: the resolved vault (or null)
// and the ledger root that follows from it. The root is created with mkdir -p
// if absent (it may be the home fallback, or a never-written vault subdir).
function resolveContext() {
  const { root, vault } = resolveLedgerRoot();
  ensureDirSync(root);
  return { vault, root };
}

// ─────────────────────────────────────────────────────────────────────────
// Ledger paths (all keyed off the resolved ledger root)
// ─────────────────────────────────────────────────────────────────────────

// The cooperative kill-switch + resume + directive + declare-done control
// file. Shape: { awakenAll: boolean, requestedAt?: string, acknowledgedAt?:
// string, resumeMission?: string | null, resumeRequestedAt?: string,
// resumeAcknowledgedAt?: string, directive?: string | null,
// directiveRequestedAt?: string, directiveAcknowledgedAt?: string,
// declareDone?: string | null, declareDoneRequestedAt?: string,
// declareDoneAcknowledgedAt?: string }. Presence-absent means no control is
// active. The HOST (extension) writes awakenAll:true via the War Room's
// Awaken-All button, resumeMission:<id> via a per-mission Resume button,
// directive:<text> via the god-console, and declareDone:<mission-id> via the
// P4 Declare Done button; this CLI never sets any of those to an "active"
// value itself — it only reports status and, once TPM has acted (stood the
// mission down, reawakened the requested mission's crew, acted on the
// directive, or finished up and stood the crew down for declare-done),
// writes the corresponding ack fields (awakenAll:false+acknowledgedAt,
// resumeMission:null+resumeAcknowledgedAt,
// directive:null+directiveAcknowledgedAt, or
// declareDone:null+declareDoneAcknowledgedAt). All four protocols share this
// one file but are otherwise independent: acking one never disturbs any
// other's fields. Like every other ledger write in this file, updates are
// full-content overwrites via atomicWriteFileSync (temp+rename) — never a
// delete. control.json is now PER-SUBJECT under the ledger root
// (<ledger-root>/<subject>/control.json), living beside that subject's
// missions/gholas — never in the work repo.
function controlFilePath(root, subject) {
  return path.join(subjectDir(root, subject), 'control.json');
}

function localPointerPath(root) {
  return path.join(root, '.ledger-path');
}

function lockFilePath(root) {
  return path.join(root, '.ghola.lock');
}

// The control lock lives beside control.json in the subject's ledger dir
// (<ledger-root>/<subject>/control.lock), because control.json is a
// per-subject file that two independent writers touch: this CLI and the VS
// Code host. Both implement the IDENTICAL lock protocol on this exact path so
// their read-modify-write of control.json is serialized across processes (see
// withControlLock below).
function controlLockFilePath(root, subject) {
  return path.join(subjectDir(root, subject), 'control.lock');
}

function subjectDir(root, subject) {
  return path.join(root, subject);
}

function archiveSubjectDir(root, subject) {
  return path.join(root, '_archive', subject);
}

function gholaFilePath(root, subject, slug) {
  return path.join(subjectDir(root, subject), `${slug}.md`);
}

function archivedGholaFilePath(root, subject, slug) {
  return path.join(archiveSubjectDir(root, subject), `${slug}.md`);
}

function missionsFilePath(root, subject) {
  return path.join(subjectDir(root, subject), '_missions.md');
}

function notesFilePath(root, subject) {
  return path.join(subjectDir(root, subject), 'operating-notes.md');
}

function alertsFilePath(root, subject) {
  return path.join(subjectDir(root, subject), 'alerts.md');
}

// Phase 7 per-subject ledger files (auto-watched by the host, same subject
// directory as alerts.md). ownership.md tracks which ghola currently owns a
// given path (at most one live claim per path); escalations.md is an
// append-only log of escalations with an E-prefixed sequential id.
function ownershipFilePath(root, subject) {
  return path.join(subjectDir(root, subject), 'ownership.md');
}

function escalationsFilePath(root, subject) {
  return path.join(subjectDir(root, subject), 'escalations.md');
}

// Creates the ledger root and writes the convenience ledger-root pointer copy
// (<ledger-root>/.ledger-path) idempotently. No work-repo pointer is written —
// the host resolves the ledger root globally, the same way this CLI does.
function ensureLedger(ctx) {
  ensureDirSync(ctx.root);
  const desired = `${ctx.root}\n`;
  const localPointer = localPointerPath(ctx.root);
  if (readFileOr(localPointer, null) !== desired) atomicWriteFileSync(localPointer, desired);
  return ctx.root;
}

function listSubjects(root) {
  if (!fs.existsSync(root)) return [];
  // '_archive' holds soft-archived gholas (own subject-shaped subdirs, not a
  // subject itself); '_templates' (Phase 6) holds saved mission templates —
  // both are ledger-root siblings of real subject dirs, not subjects.
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== '_archive' && e.name !== '_templates' && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

// ─────────────────────────────────────────────────────────────────────────
// Lock (see concurrency note in header comment)
// ─────────────────────────────────────────────────────────────────────────

// Returns a release HANDLE { lockPath, nonce }, not a bare path: release is
// nonce-verified so we never delete a lock another process legitimately holds.
function acquireLock(root, { timeoutMs = 15000, staleMs = 30000 } = {}) {
  ensureDirSync(root);
  const lockPath = lockFilePath(root);
  // Unique per-acquire token stamped into the lock file; only a release that
  // still reads back this exact nonce may unlink the lock.
  const nonce = `${process.pid}-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, nonce);
      fs.closeSync(fd);
      return { lockPath, nonce };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          // Stale takeover WITHOUT a blind unlink: atomically steal the lock by
          // renaming it aside to a unique temp path. renameSync is atomic, so
          // among many contenders exactly ONE rename succeeds; the losers get
          // ENOENT (source already gone) and loop back to retry acquire. The
          // winner discards the stolen file and falls through to a normal
          // openSync('wx') acquire below (writing its OWN nonce). This serializes
          // takeover so only one process ever proceeds into the lock.
          const stealPath = `${lockPath}.steal-${process.pid}-${Math.random().toString(36).slice(2)}`;
          try {
            fs.renameSync(lockPath, stealPath);
            fs.unlinkSync(stealPath); // our own stolen transient lockfile, not ledger content
          } catch {
            // Lost the steal race (another contender renamed/released first) —
            // fall through and retry the acquire loop.
          }
          continue;
        }
      } catch {
        continue; // lock disappeared between EEXIST and stat; retry immediately
      }
      if (Date.now() - start > timeoutMs) {
        fail(`could not acquire ledger lock at ${lockPath} within ${timeoutMs}ms (another ghola command appears to be running)`);
      }
      sleepSync(30 + Math.floor(Math.random() * 50));
    }
  }
}

function releaseLock(handle) {
  if (!handle) return;
  const { lockPath, nonce } = handle;
  try {
    // Only unlink if the lock STILL carries OUR nonce. If it holds a different
    // nonce (someone stole it as stale and re-acquired) or is already gone, do
    // nothing — deleting it would strand another process's live lock.
    if (fs.readFileSync(lockPath, 'utf8') === nonce) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // already gone (e.g. stale-reclaimed by another process) — fine
  }
}

function withLock(root, fn) {
  const handle = acquireLock(root);
  try {
    return fn();
  } finally {
    releaseLock(handle);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Control lock (serializes control.json read-modify-write across the CLI and
// the VS Code host — both implement this EXACT protocol on control.lock)
// ─────────────────────────────────────────────────────────────────────────
//
// control.json is a full-file read-modify-OVERWRITE by two independent
// processes (this CLI's *-ack commands + the host's War Room buttons). Without
// a shared lock, concurrent writers read the same "before" state and clobber
// each other (a lost kill-switch, a lost resolve). This mirrors the ledger
// withLock semantics but on <ledger-root>/<subject>/control.lock. PINNED
// PROTOCOL (the host implements the identical one on the same file):
//   - Acquire: exclusive create (openSync 'wx'); on EEXIST retry with ~20ms
//     backoff up to a ~2000ms timeout. The lock file holds a UNIQUE NONCE
//     (pid-rand-timestamp). A STALE lock (mtime older than ~5000ms) is a
//     crashed holder and is taken over ATOMICALLY by renameSync-ing it aside to
//     a unique temp path (never a blind unlink): exactly one contender's rename
//     wins and re-acquires with its own nonce, the losers retry.
//   - Release: unlink the lock file in a finally ONLY IF it still contains OUR
//     nonce — never delete a lock another process legitimately re-acquired.
// This is a DIFFERENT file from the ledger .ghola.lock, so nesting a ledger
// withLock inside a withControlLock (as escalate --ack does) never
// double-acquires either lock and cannot deadlock.
// Returns a release HANDLE { lockPath, nonce } (same nonce+rename-steal
// protocol as acquireLock above); the host implements the identical protocol
// on this exact control.lock path.
function acquireControlLock(root, subject, { timeoutMs = 2000, staleMs = 5000, backoffMs = 20 } = {}) {
  const lockPath = controlLockFilePath(root, subject);
  ensureDirSync(path.dirname(lockPath));
  const nonce = `${process.pid}-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, nonce);
      fs.closeSync(fd);
      return { lockPath, nonce };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          // Atomic stale takeover (see acquireLock): rename-steal so exactly one
          // contender wins; losers get ENOENT and retry. Never a blind unlink.
          const stealPath = `${lockPath}.steal-${process.pid}-${Math.random().toString(36).slice(2)}`;
          try {
            fs.renameSync(lockPath, stealPath);
            fs.unlinkSync(stealPath); // our own stolen transient lockfile, not control content
          } catch {
            // Lost the steal race — fall through and retry the acquire loop.
          }
          continue;
        }
      } catch {
        continue; // lock disappeared between EEXIST and stat; retry immediately
      }
      if (Date.now() - start > timeoutMs) {
        fail(`could not acquire control lock at ${lockPath} within ${timeoutMs}ms (another writer appears to be updating control.json)`);
      }
      sleepSync(backoffMs);
    }
  }
}

function releaseControlLock(handle) {
  if (!handle) return;
  const { lockPath, nonce } = handle;
  try {
    // Only unlink if the lock STILL carries OUR nonce (see releaseLock).
    if (fs.readFileSync(lockPath, 'utf8') === nonce) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // already gone (e.g. stale-reclaimed by another process) — fine
  }
}

function withControlLock(root, subject, fn) {
  const handle = acquireControlLock(root, subject);
  try {
    return fn();
  } finally {
    releaseControlLock(handle);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Ghola file (YAML-ish frontmatter + markdown body)
// ─────────────────────────────────────────────────────────────────────────

function unquote(v) {
  if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return v;
}

function quoteYamlString(v) {
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: content };
  const [, yamlBlock, body] = m;
  const frontmatter = {};
  let currentKey = null;
  for (const rawLine of yamlBlock.split('\n')) {
    if (rawLine.trim() === '') continue;
    const listMatch = rawLine.match(/^\s*-\s*(.*)$/);
    if (listMatch && currentKey) {
      if (!Array.isArray(frontmatter[currentKey])) frontmatter[currentKey] = [];
      frontmatter[currentKey].push(unquote(listMatch[1].trim()));
      continue;
    }
    const kv = rawLine.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (kv) {
      const [, key, rawVal] = kv;
      currentKey = key;
      const val = rawVal.trim();
      if (val === '' || val === '[]') {
        frontmatter[key] = [];
      } else {
        frontmatter[key] = unquote(val);
      }
    }
  }
  return { frontmatter, body };
}

// Phase 6 adds three fields to every ghola's frontmatter:
//   generation  (int, default 1)                  — lineage depth; bumped by fork/--parent
//   parent      (ghola-slug string, or omitted)    — lineage source; omitted key means null
//   reliability (string "pass:N rework:M")         — track record, mutated by `record`
// Back-compat: gholas written before Phase 6 have none of these keys. The
// parser already tolerates missing keys (they simply aren't in the object);
// gholaToJson (below) is what supplies the generation:1 / parent:null /
// reliability:"pass:0 rework:0" defaults for those older rows, so nothing
// here needs to special-case old files.
const FRONTMATTER_FIELD_ORDER = ['id', 'name', 'purpose', 'subject', 'state', 'model', 'generation', 'parent', 'reliability', 'verification', 'created', 'last_used', 'missions'];
const QUOTED_FIELDS = new Set(['name', 'purpose', 'reliability']);
const DEFAULT_RELIABILITY = 'pass:0 rework:0';

// Parses a reliability string like "pass:3 rework:1" tolerantly — a missing
// or malformed value reads as pass:0 rework:0 rather than throwing, matching
// this file's general truncated/corrupt-data tolerance.
function parseReliability(str) {
  const m = String(str || '').match(/pass:(\d+)\s+rework:(\d+)/);
  if (m) return { pass: Number(m[1]), rework: Number(m[2]) };
  return { pass: 0, rework: 0 };
}

function formatReliability(rel) {
  return `pass:${rel.pass} rework:${rel.rework}`;
}

function serializeFrontmatter(fm) {
  const lines = ['---'];
  for (const key of FRONTMATTER_FIELD_ORDER) {
    if (!(key in fm)) continue;
    const val = fm[key];
    if (Array.isArray(val)) {
      if (val.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of val) lines.push(`  - ${quoteYamlString(item)}`);
      }
    } else if (QUOTED_FIELDS.has(key)) {
      lines.push(`${key}: ${quoteYamlString(val)}`);
    } else {
      lines.push(`${key}: ${val}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

function buildGholaContent(frontmatter, body) {
  const cleanBody = body.replace(/^\n+/, '').replace(/\s+$/, '');
  return `${serializeFrontmatter(frontmatter)}\n\n${cleanBody}\n`;
}

function readGholaFile(p) {
  return parseFrontmatter(fs.readFileSync(p, 'utf8'));
}

function writeGholaFile(p, frontmatter, body) {
  atomicWriteFileSync(p, buildGholaContent(frontmatter, body));
}

function locateGhola(root, subject, slug) {
  const active = gholaFilePath(root, subject, slug);
  if (fs.existsSync(active)) return { path: active, archived: false };
  const archived = archivedGholaFilePath(root, subject, slug);
  if (fs.existsSync(archived)) return { path: archived, archived: true };
  return null;
}

function collectGholas(root, subject) {
  const rows = [];
  for (const dir of [subjectDir(root, subject), archiveSubjectDir(root, subject)]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md') || f === '_missions.md' || f === 'operating-notes.md' || f === 'alerts.md' || f === 'ownership.md' || f === 'escalations.md') continue;
      const { frontmatter } = readGholaFile(path.join(dir, f));
      rows.push(frontmatter);
    }
  }
  rows.sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
  return rows;
}

function countsByState(rows) {
  const counts = { active: 0, dormant: 0, archived: 0, total: rows.length };
  for (const r of rows) {
    if (counts[r.state] !== undefined) counts[r.state]++;
  }
  return counts;
}

// Normalizes a ghola's frontmatter into a stable JSON shape for --json
// consumers (Phase 3's War Room webview). Same fields the text views show.
// Phase 6: generation/parent/reliability are always present here even for
// pre-Phase-6 ledger rows that never wrote those keys — this is the back-compat
// seam the header comment above promises (generation 1 / parent null /
// reliability "pass:0 rework:0" when the frontmatter doesn't have them).
function gholaToJson(fm) {
  return {
    id: fm.id ?? null,
    name: fm.name ?? null,
    purpose: fm.purpose ?? null,
    subject: fm.subject ?? null,
    state: fm.state ?? null,
    model: fm.model ?? null,
    generation: fm.generation !== undefined && fm.generation !== null && fm.generation !== '' ? Number(fm.generation) : 1,
    parent: fm.parent ?? null,
    reliability: fm.reliability ?? DEFAULT_RELIABILITY,
    verification: fm.verification ?? 'pending',
    created: fm.created ?? null,
    last_used: fm.last_used ?? null,
    missions: Array.isArray(fm.missions) ? fm.missions : [],
  };
}

// Compact "gen N · parent: X · pass:N rework:M" trailer used by the text (ls
// / board) views so a human glancing at the terminal sees lineage + track
// record too, not just the --json consumers. Not column-aligned on purpose
// (it's a trailing annotation, not a table column).
function lineageSuffix(g) {
  const parent = g.parent ? g.parent : 'none';
  return `  [gen ${g.generation} · parent: ${parent} · ${g.reliability} · verify: ${g.verification}]`;
}

// Appends "- bulletText" as the last item of the named markdown heading's
// section (creating the heading if absent). Shared by ghola `## History`
// bodies and `operating-notes.md`'s `## Notes` section.
function appendBulletUnderHeading(content, heading, bulletText) {
  const idx = content.indexOf(heading);
  if (idx === -1) {
    const trimmed = content.replace(/\s+$/, '');
    return `${trimmed}\n\n${heading}\n\n- ${bulletText}\n`;
  }
  const afterHeadingIdx = idx + heading.length;
  const rest = content.slice(afterHeadingIdx);
  const nextHeadingMatch = rest.match(/\n#{1,6} /);
  const sectionEnd = nextHeadingMatch ? afterHeadingIdx + nextHeadingMatch.index : content.length;
  const before = content.slice(0, sectionEnd).replace(/\s+$/, '');
  const after = content.slice(sectionEnd);
  return `${before}\n- ${bulletText}\n${after}`;
}

// Moves a ghola into the given state, relocating it between the subject dir
// and _archive/<subject>/ when the state crosses that boundary. Must be
// called from inside withLock(). Content is rewritten in place (atomic
// temp+rename) before any cross-directory move (a real rename, never a
// delete-then-recreate).
function setGholaState(root, subject, slug, newState) {
  const loc = locateGhola(root, subject, slug);
  if (!loc) fail(`ghola '${slug}' not found for subject '${subject}'`);
  const { frontmatter, body } = readGholaFile(loc.path);
  frontmatter.state = newState;
  if (newState === 'active') frontmatter.last_used = nowIso();
  atomicWriteFileSync(loc.path, buildGholaContent(frontmatter, body));
  const destPath = newState === 'archived'
    ? archivedGholaFilePath(root, subject, slug)
    : gholaFilePath(root, subject, slug);
  if (path.resolve(destPath) !== path.resolve(loc.path)) {
    ensureDirSync(path.dirname(destPath));
    fs.renameSync(loc.path, destPath);
  }
  return { from: loc.path, to: destPath, frontmatter };
}

// ─────────────────────────────────────────────────────────────────────────
// Missions file (_missions.md)
// ─────────────────────────────────────────────────────────────────────────

// Parses a single "## Mission ..." block, mirroring the host's
// parseMissionBlockSafe: a malformed header means the block is DROPPED (null
// returned) rather than fail()ing the whole command — one corrupt block must
// not brick `mission list`/`board`/`mission resume` for every other, valid
// mission on the same subject.
function parseMissionBlock(block) {
  const lines = block.split('\n');
  const header = lines[0];
  const hm = header.match(/^## Mission (\S+) \(([a-z]+)\) — (.+)$/);
  if (!hm) return null;
  const [, id, status, date] = hm;
  let goal = '';
  let groundedIn = '';
  let budget = '';
  let integration = '';
  const progress = [];
  let inProgress = false;
  for (const line of lines.slice(1)) {
    if (line.trim() === '### Progress') {
      inProgress = true;
      continue;
    }
    if (!inProgress) {
      const gm = line.match(/^- goal: (.*)$/);
      if (gm) {
        goal = gm[1];
        continue;
      }
      const grm = line.match(/^- grounded-in: (.*)$/);
      if (grm) {
        groundedIn = grm[1] === '(none)' ? '' : grm[1];
        continue;
      }
      const bm = line.match(/^- budget: (.*)$/);
      if (bm) {
        budget = bm[1] === '(none)' ? '' : bm[1];
        continue;
      }
      const im = line.match(/^- integration: (.*)$/);
      if (im) {
        integration = im[1] === '(none)' ? '' : im[1];
        continue;
      }
    } else {
      const pm = line.match(/^- (.*)$/);
      if (pm && pm[1] !== '(none yet)') progress.push(pm[1]);
    }
  }
  return { id, status, date, goal, groundedIn, budget, integration, progress };
}

function parseMissionsFile(content) {
  if (!content || !content.trim()) return [];
  return content
    .split(/\n(?=## Mission )/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map(parseMissionBlock)
    .filter(Boolean);
}

function serializeMissionBlock(m) {
  const lines = [];
  lines.push(`## Mission ${m.id} (${m.status}) — ${m.date}`);
  lines.push(`- goal: ${m.goal}`);
  lines.push(`- grounded-in: ${m.groundedIn || '(none)'}`);
  lines.push(`- budget: ${m.budget || '(none)'}`);
  // integration is absent (no line) until `integrate` sets it; once set it is
  // serialized after budget so the parser above can round-trip it.
  if (m.integration) lines.push(`- integration: ${m.integration}`);
  lines.push('');
  lines.push('### Progress');
  if (m.progress.length === 0) {
    lines.push('- (none yet)');
  } else {
    for (const p of m.progress) lines.push(`- ${p}`);
  }
  return lines.join('\n');
}

function serializeMissionsFile(missions) {
  return `${missions.map(serializeMissionBlock).join('\n\n')}\n`;
}

// FIX E: seed from max(existing parsed M-number) + 1 rather than
// rows.length + 1. length-based seeding is non-monotonic with gaps (deleting or
// renumbering a mission can regenerate a live id) — max+1 is gap-safe. Ids that
// don't match the M<digits> shape (custom --id values) don't participate in the
// max but are still honored by the collision forward-scan below. Zero-pad stays
// at 4 so M0001..M9999 keep their padding while M10000+ widen naturally.
function nextMissionId(missions) {
  const existing = new Set(missions.map((m) => m.id));
  let max = 0;
  for (const m of missions) {
    const mm = /^M(\d+)$/.exec(String(m.id));
    if (mm) max = Math.max(max, Number(mm[1]));
  }
  let n = max + 1;
  let id = `M${String(n).padStart(4, '0')}`;
  while (existing.has(id)) {
    n++;
    id = `M${String(n).padStart(4, '0')}`;
  }
  return id;
}

function missionToJson(m) {
  return {
    id: m.id,
    status: m.status,
    date: m.date,
    goal: m.goal,
    groundedIn: m.groundedIn || '',
    budget: m.budget || null,
    integration: m.integration || null,
    progress: m.progress,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Commands — mission *
// ─────────────────────────────────────────────────────────────────────────

function cmdMissionStart({ flags }) {
  const usage = 'ghola mission start --subject S --goal "..." [--grounded-in "..."] [--budget "..."] [--id ID]';
  const ctx = resolveContext(flags);
  const subject = slugify(requireFlag(flags, 'subject', usage));
  const goal = sanitizeLine(requireFlag(flags, 'goal', usage));
  const groundedIn = typeof flags['grounded-in'] === 'string' ? sanitizeLine(flags['grounded-in']) : '';
  const budget = typeof flags.budget === 'string' ? sanitizeLine(flags.budget) : '';
  ensureLedger(ctx);
  ensureDirSync(subjectDir(ctx.root, subject));
  const mFile = missionsFilePath(ctx.root, subject);
  let missionId;
  withLock(ctx.root, () => {
    const missions = parseMissionsFile(readFileOr(mFile, ''));
    if (typeof flags.id === 'string') {
      // --id feeds directly into the block HEADER line (not just a field), so
      // it gets the same newline-neutralization as the free-text fields below
      // — an embedded newline here would otherwise inject a phantom block.
      const requestedId = sanitizeLine(flags.id);
      // The id feeds the `## Mission (\S+) ...` header regex, which is
      // whitespace-delimited: a space (or other stray char) breaks that header
      // so the whole mission block is silently dropped on the next read. Refuse
      // anything outside the safe id charset with a clear error + nonzero exit.
      if (!/^[A-Za-z0-9._-]+$/.test(requestedId)) fail(`--id must match [A-Za-z0-9._-]+ (got '${requestedId}')`);
      if (missions.some((m) => m.id === requestedId)) fail(`mission id '${requestedId}' already exists for subject '${subject}'`);
      missionId = requestedId;
    } else {
      missionId = nextMissionId(missions);
    }
    missions.push({ id: missionId, status: 'open', date: todayDate(), goal, groundedIn, budget, progress: [] });
    atomicWriteFileSync(mFile, serializeMissionsFile(missions));
  });
  console.log(missionId);
}

function cmdMissionList({ flags }) {
  const usage = 'ghola mission list --subject S [--json]';
  const ctx = resolveContext(flags);
  const subject = slugify(requireFlag(flags, 'subject', usage));
  const missions = parseMissionsFile(readFileOr(missionsFilePath(ctx.root, subject), ''));
  if (flags.json) {
    printJson({ subject, missions: missions.map(missionToJson) });
    return;
  }
  if (missions.length === 0) {
    console.log(`no missions yet for subject '${subject}'`);
    return;
  }
  for (const m of missions) {
    const budgetSuffix = m.budget ? `  [budget: ${m.budget}]` : '';
    console.log(`${m.id}  (${m.status})  ${m.date}  ${m.goal}${budgetSuffix}`);
  }
}

function cmdMissionResume({ flags }) {
  const usage = 'ghola mission resume --subject S --id M [--json]';
  const ctx = resolveContext(flags);
  const subject = slugify(requireFlag(flags, 'subject', usage));
  const id = requireFlag(flags, 'id', usage);
  const missions = parseMissionsFile(readFileOr(missionsFilePath(ctx.root, subject), ''));
  const m = missions.find((x) => x.id === id);
  if (!m) fail(`mission '${id}' not found for subject '${subject}'`);
  const roster = collectGholas(ctx.root, subject).filter((g) => Array.isArray(g.missions) && g.missions.includes(id));
  if (flags.json) {
    printJson({ subject, mission: missionToJson(m), gholas: roster.map(gholaToJson) });
    return;
  }
  console.log(`Mission ${m.id} (${m.status}) — ${m.date}`);
  console.log(`goal:        ${m.goal}`);
  console.log(`grounded-in: ${m.groundedIn || '(none)'}`);
  console.log(`budget:      ${m.budget || '(none)'}`);
  if (m.progress.length) {
    console.log('progress:');
    for (const p of m.progress) console.log(`  - ${p}`);
  }
  console.log(`gholas (${roster.length}):`);
  for (const g of roster) console.log(`  - ${g.id} [${g.state}] ${g.purpose}`);
}

function cmdMissionDone({ flags }) {
  const usage = 'ghola mission done --subject S --id M [--force]';
  const ctx = resolveContext(flags);
  const subject = slugify(requireFlag(flags, 'subject', usage));
  const id = requireFlag(flags, 'id', usage);
  const force = !!flags.force;
  let overrodeIntegration = null; // the non-passed state we overrode, when --force
  withLock(ctx.root, () => {
    const mFile = missionsFilePath(ctx.root, subject);
    const missions = parseMissionsFile(readFileOr(mFile, ''));
    const m = missions.find((x) => x.id === id);
    if (!m) fail(`mission '${id}' not found for subject '${subject}'`);
    // FIX 6: gate on integration. An unset integration line reads as 'pending'.
    const integration = m.integration || 'pending';
    if (integration !== 'passed') {
      if (!force) {
        fail(`mission ${id}: integration is ${integration}; run 'ghola integrate --state passed' first, or pass --force to override`);
      }
      overrodeIntegration = integration;
    }
    m.status = 'done';
    m.progress.push(`${nowIso()}: marked done${overrodeIntegration ? ` (integration override: was ${overrodeIntegration})` : ''}`);
    atomicWriteFileSync(mFile, serializeMissionsFile(missions));
    // FIX 2 (Round 4): mission done NO LONGER touches escalations. The old
    // subject-wide sweep flipped EVERY pending escalation for the subject to
    // 'cancelled', but escalation records carry no mission id, so it wrongly
    // cancelled escalations belonging to OTHER live missions on the same
    // subject. Cancelling a specific stale escalation is now an explicit,
    // scoped operator action via 'escalate --cancel <id> --subject S'.
  });
  console.log(`mission ${id} marked done${overrodeIntegration ? ` (integration override: was ${overrodeIntegration})` : ''}`);
}

// Reverse of `mission done`: flips a done mission back to open so its active
// surface + gates apply again. Lock-serialized RMW of the mission block,
// mirroring how `mission done` sets status. Reopening also RESETS the mission's
// `integration` to unset (which reads back as 'pending' via the `|| 'pending'`
// gate in cmdMissionDone), because resuming a done mission is the mainline for
// doing MORE work on it and the integration gate must re-apply to that new work
// — otherwise the stale `passed` from the prior convergence would let the
// resumed work be re-closed immediately with no re-integration. Progress
// history is PRESERVED (only integration is reset). An already-open mission is
// a no-op success; a missing mission (or one that is neither done nor open) is
// a clear, non-zero error.
function cmdMissionReopen({ flags }) {
  const usage = 'ghola mission reopen --subject S --id M';
  const ctx = resolveContext(flags);
  const subject = slugify(requireFlag(flags, 'subject', usage));
  const id = requireFlag(flags, 'id', usage);
  let outcome;
  withLock(ctx.root, () => {
    const mFile = missionsFilePath(ctx.root, subject);
    const missions = parseMissionsFile(readFileOr(mFile, ''));
    const m = missions.find((x) => x.id === id);
    if (!m) fail(`mission '${id}' not found for subject '${subject}'`);
    if (m.status === 'open') {
      outcome = 'already-open';
      return;
    }
    if (m.status !== 'done') {
      fail(`mission '${id}' has status '${m.status}', not 'done'; only a done mission can be reopened`);
    }
    m.status = 'open';
    // Reset the integration gate so the resumed work must be re-integrated
    // before it can be re-declared-done. Empty round-trips back to 'pending'
    // (serializeMissionBlock omits the line; cmdMissionDone reads it as
    // `m.integration || 'pending'`). Progress history is deliberately kept.
    m.integration = '';
    m.progress.push(`${nowIso()}: reopened (done -> open); integration gate reset to pending (re-integrate before re-declaring done)`);
    atomicWriteFileSync(mFile, serializeMissionsFile(missions));
    outcome = 'reopened';
  });
  if (outcome === 'already-open') {
    console.log(`mission ${id} is already open (no change)`);
  } else {
    console.log(`mission ${id} reopened (done -> open)`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Commands — awaken (cooperative kill-switch control)
// ─────────────────────────────────────────────────────────────────────────

// Reads the control file (or a sane absent-default) without ever creating
// it — status checks must not have a write side effect. Covers the
// awaken-all fields, the Phase 5 resume fields, the Phase 6 god-console
// directive fields, and the P4 declare-done fields (see controlFilePath's
// header comment for the shared-file rationale — all four protocols share
// this one file and are otherwise independent).
// The "no control active" shape — used both when control.json is absent and
// when it exists but is unparseable or not a plain object (see readControl).
function noControlState(p) {
  return {
    path: p,
    exists: false,
    awakenAll: false,
    requestedAt: null,
    acknowledgedAt: null,
    resumeMission: null,
    resumeRequestedAt: null,
    resumeAcknowledgedAt: null,
    directive: null,
    directiveRequestedAt: null,
    directiveAcknowledgedAt: null,
    declareDone: null,
    declareDoneRequestedAt: null,
    declareDoneAcknowledgedAt: null,
    escalationResolve: [],
    escalationResolveRequestedAt: null,
    escalationResolveAcknowledgedAt: null,
  };
}

// Normalizes control.json's escalationResolve field into a clean ARRAY of
// { id, subject, decision } entries (decision restricted to "approve"|"deny").
// A queue (not a single object) lets the host enqueue several decisions,
// possibly across different subjects, without one clobbering another. Tolerant:
// each entry is validated independently so a single malformed entry is dropped
// rather than crashing the per-turn poll path.
// FIX 3 (back-compat): an OLD control.json where escalationResolve is the
// PRE-ARRAY single object { id, subject, decision } is coerced into a 1-element
// array so a pending resolve survives the upgrade rather than being silently
// dropped. A single object is wrapped and then run through the same per-entry
// validation below, so a 2-field legacy { id, decision } with NO subject still
// drops (it fails the subject check) - which is fine. Any other non-array,
// non-object value (null/absent/string/number) still reads as [].
function parseEscalationResolve(v) {
  const items = Array.isArray(v)
    ? v
    : (v && typeof v === 'object' ? [v] : []);
  const out = [];
  for (const e of items) {
    if (e && typeof e === 'object' && !Array.isArray(e)
        && typeof e.id === 'string'
        && typeof e.subject === 'string'
        && (e.decision === 'approve' || e.decision === 'deny')) {
      out.push({ id: e.id, subject: e.subject, decision: e.decision });
    }
  }
  return out;
}

function readControl(root, subject) {
  const p = controlFilePath(root, subject);
  const raw = readFileOr(p, null);
  if (raw === null) return noControlState(p);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt JSON on the per-turn poll path — treat as no control active
    // rather than throwing/fail()ing (mirrors the host's readControlState).
    return noControlState(p);
  }
  // A literal `null`, an array, or any non-object JSON value (e.g. a bare
  // string or number) parses successfully but has no fields to dereference —
  // treat it the same as a missing file instead of crashing on `parsed.foo`
  // (mirrors the host's readControlState guard exactly).
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return noControlState(p);
  }
  return {
    path: p,
    exists: true,
    // Strict boolean, matching the host's readControlState exactly: a corrupt/
    // hand-edited string like "false" (truthy in JS) must NOT read as true here
    // while the host reads it false - a divergent kill-switch view. Only a real
    // JSON boolean counts; anything else is false.
    awakenAll: typeof parsed.awakenAll === 'boolean' ? parsed.awakenAll : false,
    requestedAt: typeof parsed.requestedAt === 'string' ? parsed.requestedAt : null,
    acknowledgedAt: typeof parsed.acknowledgedAt === 'string' ? parsed.acknowledgedAt : null,
    resumeMission: typeof parsed.resumeMission === 'string' ? parsed.resumeMission : null,
    resumeRequestedAt: typeof parsed.resumeRequestedAt === 'string' ? parsed.resumeRequestedAt : null,
    resumeAcknowledgedAt: typeof parsed.resumeAcknowledgedAt === 'string' ? parsed.resumeAcknowledgedAt : null,
    directive: typeof parsed.directive === 'string' ? parsed.directive : null,
    directiveRequestedAt: typeof parsed.directiveRequestedAt === 'string' ? parsed.directiveRequestedAt : null,
    directiveAcknowledgedAt: typeof parsed.directiveAcknowledgedAt === 'string' ? parsed.directiveAcknowledgedAt : null,
    declareDone: typeof parsed.declareDone === 'string' ? parsed.declareDone : null,
    declareDoneRequestedAt: typeof parsed.declareDoneRequestedAt === 'string' ? parsed.declareDoneRequestedAt : null,
    declareDoneAcknowledgedAt: typeof parsed.declareDoneAcknowledgedAt === 'string' ? parsed.declareDoneAcknowledgedAt : null,
    escalationResolve: parseEscalationResolve(parsed.escalationResolve),
    escalationResolveRequestedAt: typeof parsed.escalationResolveRequestedAt === 'string' ? parsed.escalationResolveRequestedAt : null,
    escalationResolveAcknowledgedAt: typeof parsed.escalationResolveAcknowledgedAt === 'string' ? parsed.escalationResolveAcknowledgedAt : null,
  };
}

function cmdAwaken({ flags }) {
  const usage = 'ghola awaken --subject S --status | --ack [--json]';
  if (!flags.status && !flags.ack) {
    fail(`awaken requires --status or --ack. Usage: ${usage}`);
  }
  const ctx = resolveContext();
  const subject = slugify(requireFlag(flags, 'subject', usage));

  if (flags.ack) {
    // TPM calls this AFTER standing the whole team down. Only this command
    // may flip awakenAll back to false; the CLI never sets it true (that is
    // the host/human's job via the War Room button). The resume, directive,
    // and declare-done fields are independent protocols sharing this file —
    // preserve them untouched (all four protocols mutually preserve). The
    // read+mutate+write runs under the control lock so a concurrent host write
    // cannot clobber this stand-down ack (FIX A).
    withControlLock(ctx.root, subject, () => {
      const before = readControl(ctx.root, subject);
      const next = { awakenAll: false, acknowledgedAt: nowIso() };
      if (before.requestedAt) next.requestedAt = before.requestedAt;
      if (before.resumeMission !== null) next.resumeMission = before.resumeMission;
      if (before.resumeRequestedAt) next.resumeRequestedAt = before.resumeRequestedAt;
      if (before.resumeAcknowledgedAt) next.resumeAcknowledgedAt = before.resumeAcknowledgedAt;
      if (before.directive !== null) next.directive = before.directive;
      if (before.directiveRequestedAt) next.directiveRequestedAt = before.directiveRequestedAt;
      if (before.directiveAcknowledgedAt) next.directiveAcknowledgedAt = before.directiveAcknowledgedAt;
      if (before.declareDone !== null) next.declareDone = before.declareDone;
      if (before.declareDoneRequestedAt) next.declareDoneRequestedAt = before.declareDoneRequestedAt;
      if (before.declareDoneAcknowledgedAt) next.declareDoneAcknowledgedAt = before.declareDoneAcknowledgedAt;
      if (before.escalationResolve.length) next.escalationResolve = before.escalationResolve;
      if (before.escalationResolveRequestedAt) next.escalationResolveRequestedAt = before.escalationResolveRequestedAt;
      if (before.escalationResolveAcknowledgedAt) next.escalationResolveAcknowledgedAt = before.escalationResolveAcknowledgedAt;
      atomicWriteFileSync(controlFilePath(ctx.root, subject), `${JSON.stringify(next, null, 2)}\n`);
    });
    const state = readControl(ctx.root, subject);
    if (flags.json) {
      printJson(state);
    } else {
      console.log(`awaken: acknowledged stand-down (${state.path})`);
      console.log(`  awakenAll: ${state.awakenAll}`);
      console.log(`  requestedAt: ${state.requestedAt ?? '(none)'}`);
      console.log(`  acknowledgedAt: ${state.acknowledgedAt}`);
    }
    return;
  }

  // --status
  const state = readControl(ctx.root, subject);
  if (flags.json) {
    printJson(state);
    return;
  }
  if (!state.exists) {
    console.log(`awaken: no control active (no control file at ${state.path})`);
    return;
  }
  console.log(`awaken: control file at ${state.path}`);
  console.log(`  awakenAll: ${state.awakenAll}`);
  console.log(`  requestedAt: ${state.requestedAt ?? '(none)'}`);
  console.log(`  acknowledgedAt: ${state.acknowledgedAt ?? '(none)'}`);
}

// ─────────────────────────────────────────────────────────────────────────
// Commands — resume (cooperative per-mission reawaken control)
// ─────────────────────────────────────────────────────────────────────────

function cmdResume({ flags }) {
  const usage = 'ghola resume --subject S --status | --ack [--json]';
  if (!flags.status && !flags.ack) {
    fail(`resume requires --status or --ack. Usage: ${usage}`);
  }
  const ctx = resolveContext();
  const subject = slugify(requireFlag(flags, 'subject', usage));

  if (flags.ack) {
    // TPM calls this AFTER reawakening the requested mission's crew from the
    // ledger (mission resume + wake) and restoring mission context. Only this
    // command may clear resumeMission back to null; the CLI never sets it to
    // a non-null value itself (that is the host/button's job). The awaken-all,
    // directive, and declare-done fields are independent protocols sharing
    // this file — preserve them untouched (all four protocols mutually
    // preserve).
    // The read+mutate+write runs under the control lock so a concurrent host
    // write cannot clobber this resume ack (FIX A).
    withControlLock(ctx.root, subject, () => {
      const before = readControl(ctx.root, subject);
      const next = {
        awakenAll: before.awakenAll,
        resumeMission: null,
        resumeAcknowledgedAt: nowIso(),
      };
      if (before.requestedAt) next.requestedAt = before.requestedAt;
      if (before.acknowledgedAt) next.acknowledgedAt = before.acknowledgedAt;
      if (before.resumeRequestedAt) next.resumeRequestedAt = before.resumeRequestedAt;
      if (before.directive !== null) next.directive = before.directive;
      if (before.directiveRequestedAt) next.directiveRequestedAt = before.directiveRequestedAt;
      if (before.directiveAcknowledgedAt) next.directiveAcknowledgedAt = before.directiveAcknowledgedAt;
      if (before.declareDone !== null) next.declareDone = before.declareDone;
      if (before.declareDoneRequestedAt) next.declareDoneRequestedAt = before.declareDoneRequestedAt;
      if (before.declareDoneAcknowledgedAt) next.declareDoneAcknowledgedAt = before.declareDoneAcknowledgedAt;
      if (before.escalationResolve.length) next.escalationResolve = before.escalationResolve;
      if (before.escalationResolveRequestedAt) next.escalationResolveRequestedAt = before.escalationResolveRequestedAt;
      if (before.escalationResolveAcknowledgedAt) next.escalationResolveAcknowledgedAt = before.escalationResolveAcknowledgedAt;
      atomicWriteFileSync(controlFilePath(ctx.root, subject), `${JSON.stringify(next, null, 2)}\n`);
    });
    const state = readControl(ctx.root, subject);
    if (flags.json) {
      printJson(state);
    } else {
      console.log(`resume: acknowledged (${state.path})`);
      console.log(`  resumeMission: ${state.resumeMission ?? '(none)'}`);
      console.log(`  resumeRequestedAt: ${state.resumeRequestedAt ?? '(none)'}`);
      console.log(`  resumeAcknowledgedAt: ${state.resumeAcknowledgedAt}`);
    }
    return;
  }

  // --status
  const state = readControl(ctx.root, subject);
  if (flags.json) {
    printJson(state);
    return;
  }
  if (!state.exists || state.resumeMission === null) {
    console.log(`resume: no resume request pending (control file at ${state.path})`);
    return;
  }
  console.log(`resume: control file at ${state.path}`);
  console.log(`  resumeMission: ${state.resumeMission}`);
  console.log(`  resumeRequestedAt: ${state.resumeRequestedAt ?? '(none)'}`);
  console.log(`  resumeAcknowledgedAt: ${state.resumeAcknowledgedAt ?? '(none)'}`);
}

// ─────────────────────────────────────────────────────────────────────────
// Commands — directive (Phase 6 god-console control)
// ─────────────────────────────────────────────────────────────────────────

function cmdDirective({ flags }) {
  const usage = 'ghola directive --subject S --status | --ack [--json]';
  if (!flags.status && !flags.ack) {
    fail(`directive requires --status or --ack. Usage: ${usage}`);
  }
  const ctx = resolveContext();
  const subject = slugify(requireFlag(flags, 'subject', usage));

  if (flags.ack) {
    // TPM calls this AFTER acting on the operator's god-console directive
    // (e.g. narrowing the goal, waking a specific ghola, pausing). Only this
    // command may clear `directive` back to null; the CLI never sets it to a
    // non-null value itself (that is the host/god-console's job — it writes
    // {directive, directiveRequestedAt} while preserving every other field).
    // The awaken-all, resume, and declare-done fields are independent
    // protocols sharing this file — preserve them untouched (all four
    // protocols mutually preserve).
    // The read+mutate+write runs under the control lock so a concurrent host
    // write cannot clobber this directive ack (FIX A).
    withControlLock(ctx.root, subject, () => {
      const before = readControl(ctx.root, subject);
      const next = {
        awakenAll: before.awakenAll,
        directive: null,
        directiveAcknowledgedAt: nowIso(),
      };
      if (before.requestedAt) next.requestedAt = before.requestedAt;
      if (before.acknowledgedAt) next.acknowledgedAt = before.acknowledgedAt;
      if (before.resumeMission !== null) next.resumeMission = before.resumeMission;
      if (before.resumeRequestedAt) next.resumeRequestedAt = before.resumeRequestedAt;
      if (before.resumeAcknowledgedAt) next.resumeAcknowledgedAt = before.resumeAcknowledgedAt;
      if (before.directiveRequestedAt) next.directiveRequestedAt = before.directiveRequestedAt;
      if (before.declareDone !== null) next.declareDone = before.declareDone;
      if (before.declareDoneRequestedAt) next.declareDoneRequestedAt = before.declareDoneRequestedAt;
      if (before.declareDoneAcknowledgedAt) next.declareDoneAcknowledgedAt = before.declareDoneAcknowledgedAt;
      if (before.escalationResolve.length) next.escalationResolve = before.escalationResolve;
      if (before.escalationResolveRequestedAt) next.escalationResolveRequestedAt = before.escalationResolveRequestedAt;
      if (before.escalationResolveAcknowledgedAt) next.escalationResolveAcknowledgedAt = before.escalationResolveAcknowledgedAt;
      atomicWriteFileSync(controlFilePath(ctx.root, subject), `${JSON.stringify(next, null, 2)}\n`);
    });
    const state = readControl(ctx.root, subject);
    if (flags.json) {
      printJson(state);
    } else {
      console.log(`directive: acknowledged (${state.path})`);
      console.log(`  directive: ${state.directive ?? '(none)'}`);
      console.log(`  directiveRequestedAt: ${state.directiveRequestedAt ?? '(none)'}`);
      console.log(`  directiveAcknowledgedAt: ${state.directiveAcknowledgedAt}`);
    }
    return;
  }

  // --status
  const state = readControl(ctx.root, subject);
  if (flags.json) {
    printJson(state);
    return;
  }
  if (state.directive === null) {
    console.log(`directive: none pending (control file at ${state.path})`);
    return;
  }
  console.log(`directive: control file at ${state.path}`);
  console.log(`  directive: ${state.directive}`);
  console.log(`  directiveRequestedAt: ${state.directiveRequestedAt ?? '(none)'}`);
  console.log(`  directiveAcknowledgedAt: ${state.directiveAcknowledgedAt ?? '(none)'}`);
}

// ─────────────────────────────────────────────────────────────────────────
// Commands — declaredone (P4 human-converge control)
// ─────────────────────────────────────────────────────────────────────────

function cmdDeclareDone({ flags }) {
  const usage = 'ghola declaredone --subject S --status | --ack [--json]';
  if (!flags.status && !flags.ack) {
    fail(`declaredone requires --status or --ack. Usage: ${usage}`);
  }
  const ctx = resolveContext();
  const subject = slugify(requireFlag(flags, 'subject', usage));

  if (flags.ack) {
    // TPM calls this AFTER finishing up in response to the operator's P4
    // Declare Done action: marking the mission done (`mission done`),
    // standing the crew down (debrief each active/dormant ghola then set
    // dormant), and reporting completion to the operator. Only this command
    // may clear `declareDone` back to null; the CLI never sets it to a
    // non-null value itself (that is the host/Declare-Done-button's job — it
    // writes {declareDone, declareDoneRequestedAt} while preserving every
    // other field). The awaken-all, resume, and directive fields are
    // independent protocols sharing this file — preserve them untouched (all
    // four protocols mutually preserve).
    // The read+mutate+write runs under the control lock so a concurrent host
    // write cannot clobber this declaredone ack (FIX A).
    withControlLock(ctx.root, subject, () => {
      const before = readControl(ctx.root, subject);
      const next = {
        awakenAll: before.awakenAll,
        declareDone: null,
        declareDoneAcknowledgedAt: nowIso(),
      };
      if (before.requestedAt) next.requestedAt = before.requestedAt;
      if (before.acknowledgedAt) next.acknowledgedAt = before.acknowledgedAt;
      if (before.resumeMission !== null) next.resumeMission = before.resumeMission;
      if (before.resumeRequestedAt) next.resumeRequestedAt = before.resumeRequestedAt;
      if (before.resumeAcknowledgedAt) next.resumeAcknowledgedAt = before.resumeAcknowledgedAt;
      if (before.directive !== null) next.directive = before.directive;
      if (before.directiveRequestedAt) next.directiveRequestedAt = before.directiveRequestedAt;
      if (before.directiveAcknowledgedAt) next.directiveAcknowledgedAt = before.directiveAcknowledgedAt;
      if (before.declareDoneRequestedAt) next.declareDoneRequestedAt = before.declareDoneRequestedAt;
      if (before.escalationResolve.length) next.escalationResolve = before.escalationResolve;
      if (before.escalationResolveRequestedAt) next.escalationResolveRequestedAt = before.escalationResolveRequestedAt;
      if (before.escalationResolveAcknowledgedAt) next.escalationResolveAcknowledgedAt = before.escalationResolveAcknowledgedAt;
      atomicWriteFileSync(controlFilePath(ctx.root, subject), `${JSON.stringify(next, null, 2)}\n`);
    });
    const state = readControl(ctx.root, subject);
    if (flags.json) {
      printJson(state);
    } else {
      console.log(`declaredone: acknowledged (${state.path})`);
      console.log(`  declareDone: ${state.declareDone ?? '(none)'}`);
      console.log(`  declareDoneRequestedAt: ${state.declareDoneRequestedAt ?? '(none)'}`);
      console.log(`  declareDoneAcknowledgedAt: ${state.declareDoneAcknowledgedAt}`);
    }
    return;
  }

  // --status
  const state = readControl(ctx.root, subject);
  if (flags.json) {
    printJson(state);
    return;
  }
  if (state.declareDone === null) {
    console.log(`declaredone: none pending (control file at ${state.path})`);
    return;
  }
  console.log(`declaredone: control file at ${state.path}`);
  console.log(`  declareDone: ${state.declareDone}`);
  console.log(`  declareDoneRequestedAt: ${state.declareDoneRequestedAt ?? '(none)'}`);
  console.log(`  declareDoneAcknowledgedAt: ${state.declareDoneAcknowledgedAt ?? '(none)'}`);
}

// ─────────────────────────────────────────────────────────────────────────
// Commands — ghola lifecycle
// ─────────────────────────────────────────────────────────────────────────

function cmdSpawn({ flags }) {
  const usage = 'ghola spawn --subject S --name N --purpose "..." [--model opus|sonnet|haiku] [--mission M] [--parent P]';
  const ctx = resolveContext(flags);
  const subject = slugify(requireFlag(flags, 'subject', usage));
  // name is written verbatim (quoted) into frontmatter and into the body's
  // "# <name>" header — quoteYamlString does not escape raw newlines, so an
  // embedded newline here would otherwise corrupt the frontmatter block.
  const name = sanitizeLine(requireFlag(flags, 'name', usage));
  const purpose = sanitizeLine(requireFlag(flags, 'purpose', usage));
  const model = typeof flags.model === 'string' ? flags.model : 'sonnet';
  if (!['opus', 'sonnet', 'haiku'].includes(model)) fail(`--model must be one of opus|sonnet|haiku (got '${model}')`);
  // --mission ends up as a quoted `missions:` list item in frontmatter
  // (serializeFrontmatter quotes every array item regardless of field) — same
  // newline-corruption risk as name/purpose above.
  const missionId = typeof flags.mission === 'string' ? sanitizeLine(flags.mission) : '';
  const parentArg = typeof flags.parent === 'string' ? slugify(flags.parent) : null;
  const slug = slugify(name);
  ensureLedger(ctx);
  ensureDirSync(subjectDir(ctx.root, subject));
  withLock(ctx.root, () => {
    if (locateGhola(ctx.root, subject, slug)) {
      fail(`ghola '${slug}' already exists for subject '${subject}' (use 'wake' to reactivate it, or pick a different --name)`);
    }
    // Lineage (Phase 6): generation = parent's generation + 1 only when
    // --parent was given AND that ghola is actually found in this subject's
    // ledger; given-but-not-found still records the requested parent slug
    // (the operator's intent) but generation falls back to 1 rather than
    // failing the spawn outright.
    let generation = 1;
    if (parentArg) {
      const parentLoc = locateGhola(ctx.root, subject, parentArg);
      if (parentLoc) {
        const { frontmatter: parentFm } = readGholaFile(parentLoc.path);
        generation = (Number(parentFm.generation) || 1) + 1;
      } else {
        console.error(`ghola: warning: --parent '${parentArg}' not found for subject '${subject}' — recording it anyway, generation left at 1`);
      }
    }
    const ts = nowIso();
    const frontmatter = {
      id: slug,
      name,
      purpose,
      subject,
      state: 'active',
      model,
      generation,
      ...(parentArg ? { parent: parentArg } : {}),
      reliability: DEFAULT_RELIABILITY,
      verification: 'pending',
      created: ts,
      last_used: ts,
      missions: missionId ? [missionId] : [],
    };
    const body = `# ${name}\n\n## History\n\n- ${todayDate()}: spawned — ${purpose}\n`;
    writeGholaFile(gholaFilePath(ctx.root, subject, slug), frontmatter, body);
  });
  console.log(slug);
}

function cmdState({ flags, positional }) {
  const usage = 'ghola state --subject S --ghola G <active|dormant|archived>';
  const ctx = resolveContext(flags);
  const subject = slugify(requireFlag(flags, 'subject', usage));
  const gholaArg = requireFlag(flags, 'ghola', usage);
  const slug = slugify(gholaArg);
  const value = positional[0];
  if (!['active', 'dormant', 'archived'].includes(value)) {
    fail(`state value must be one of active|dormant|archived. Usage: ${usage}`);
  }
  const result = withLock(ctx.root, () => {
    const r = setGholaState(ctx.root, subject, slug, value);
    // FIX D: a transition to a NON-active state stands the ghola down, so free
    // any paths it still owns — matching debrief/retire/groom. A transition TO
    // active keeps its claims (nothing to release).
    if (value !== 'active') releaseAllForGholaLocked(ctx.root, subject, slug);
    return r;
  });
  console.log(`${slug}: state -> ${value} (${result.to})`);
}

function cmdDebrief({ flags }) {
  const usage = 'ghola debrief --subject S --ghola G --summary "..."';
  const ctx = resolveContext(flags);
  const subject = slugify(requireFlag(flags, 'subject', usage));
  const gholaArg = requireFlag(flags, 'ghola', usage);
  const slug = slugify(gholaArg);
  const summary = sanitizeLine(requireFlag(flags, 'summary', usage));
  withLock(ctx.root, () => {
    const loc = locateGhola(ctx.root, subject, slug);
    if (!loc) fail(`ghola '${slug}' not found for subject '${subject}'`);
    const { frontmatter, body } = readGholaFile(loc.path);
    frontmatter.last_used = nowIso();
    const newBody = appendBulletUnderHeading(body, '## History', `${todayDate()}: ${summary}`);
    atomicWriteFileSync(loc.path, buildGholaContent(frontmatter, newBody));
    // A debrief stands the ghola down (wraps up its work), so free any paths it
    // still owns — a stood-down ghola must not keep a live claim (FIX 1).
    releaseAllForGholaLocked(ctx.root, subject, slug);
  });
  console.log(`debriefed ${slug}`);
}

function cmdWake({ flags }) {
  const usage = 'ghola wake --subject S --ghola G';
  const ctx = resolveContext(flags);
  const subject = slugify(requireFlag(flags, 'subject', usage));
  const gholaArg = requireFlag(flags, 'ghola', usage);
  const slug = slugify(gholaArg);
  const result = withLock(ctx.root, () => setGholaState(ctx.root, subject, slug, 'active'));
  console.log(`${slug}: awake (${result.to})`);
}

function cmdRetire({ flags }) {
  const usage = 'ghola retire --subject S --ghola G';
  const ctx = resolveContext(flags);
  const subject = slugify(requireFlag(flags, 'subject', usage));
  const gholaArg = requireFlag(flags, 'ghola', usage);
  const slug = slugify(gholaArg);
  const result = withLock(ctx.root, () => {
    const r = setGholaState(ctx.root, subject, slug, 'archived');
    releaseAllForGholaLocked(ctx.root, subject, slug); // freed on retire (FIX 1)
    return r;
  });
  console.log(`${slug}: retired -> ${result.to}`);
}

function cmdGroom({ flags }) {
  const usage = 'ghola groom --subject S [--days 30]';
  const ctx = resolveContext(flags);
  const subject = slugify(requireFlag(flags, 'subject', usage));
  // A bare `--days` parses as boolean true (Number(true) === 1 would silently
  // groom idle>1d); reject it, and any non-integer, like the other required
  // numeric flags. Present -> must be a non-negative integer; absent -> 30.
  let days = 30;
  if (flags.days !== undefined) {
    if (flags.days === true || !/^\d+$/.test(String(flags.days))) {
      fail(`--days must be a non-negative integer (got '${flags.days === true ? '(bare flag)' : flags.days}')`);
    }
    days = Number(flags.days);
  }
  const archived = [];
  withLock(ctx.root, () => {
    const sDir = subjectDir(ctx.root, subject);
    if (!fs.existsSync(sDir)) return;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(sDir).filter((f) => f.endsWith('.md') && f !== '_missions.md' && f !== 'operating-notes.md' && f !== 'alerts.md' && f !== 'ownership.md' && f !== 'escalations.md');
    for (const f of files) {
      const p = path.join(sDir, f);
      const { frontmatter, body } = readGholaFile(p);
      if (frontmatter.state === 'archived') continue;
      const lastUsed = Date.parse(frontmatter.last_used || frontmatter.created || '');
      if (Number.isNaN(lastUsed) || lastUsed >= cutoff) continue;
      const slug = frontmatter.id || slugify(f.replace(/\.md$/, ''));
      frontmatter.state = 'archived';
      atomicWriteFileSync(p, buildGholaContent(frontmatter, body));
      const dest = archivedGholaFilePath(ctx.root, subject, slug);
      ensureDirSync(path.dirname(dest));
      fs.renameSync(p, dest);
      releaseAllForGholaLocked(ctx.root, subject, slug); // freed on archive (FIX 1)
      archived.push({ slug, idleDays: Math.floor((Date.now() - lastUsed) / 86400000) });
    }
  });
  if (archived.length === 0) {
    console.log(`groom: no gholas idle > ${days} days for subject '${subject}'`);
  } else {
    console.log(`groom: archived ${archived.length} idle ghola(s) for subject '${subject}':`);
    for (const a of archived) console.log(`  - ${a.slug} (idle ${a.idleDays}d)`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Commands — fork (second awakening / new generation) + record (track record)
// ─────────────────────────────────────────────────────────────────────────

// Best-effort one-line distillation of a source ghola's `## History` body,
// used by `fork` when the caller doesn't pass an explicit --summary. This is
// deliberately crude (it has no LLM access) — TPM is expected to pass its own
// distilled --summary in the normal case, since only the conditioning layer
// actually knows which lessons matter. This is just a non-empty fallback so
// the command never produces a blank "distilled lessons" line.
function autoDistillHistory(body) {
  const bullets = [];
  for (const rawLine of body.split('\n')) {
    const m = rawLine.match(/^-\s*(.*)$/);
    if (m) bullets.push(m[1]);
  }
  if (bullets.length === 0) return 'no recorded history';
  const recent = bullets.slice(-3);
  const joined = `${bullets.length} prior entr${bullets.length === 1 ? 'y' : 'ies'}; most recent: ${recent.join(' | ')}`;
  return truncate(joined, 220);
}

function cmdFork({ flags }) {
  const usage = 'ghola fork --subject S --from G --name N [--summary "distilled lessons..."]';
  const ctx = resolveContext(flags);
  const subject = slugify(requireFlag(flags, 'subject', usage));
  const fromArg = requireFlag(flags, 'from', usage);
  const fromSlug = slugify(fromArg);
  // Same reasoning as spawn's name: written verbatim (quoted) into frontmatter
  // and the body's "# <name>" header.
  const name = sanitizeLine(requireFlag(flags, 'name', usage));
  const newSlug = slugify(name);
  const providedSummary = typeof flags.summary === 'string' ? sanitizeLine(flags.summary) : null;
  ensureLedger(ctx);
  ensureDirSync(subjectDir(ctx.root, subject));
  let resultSlug;
  withLock(ctx.root, () => {
    const loc = locateGhola(ctx.root, subject, fromSlug);
    if (!loc) fail(`ghola '${fromSlug}' not found for subject '${subject}' (fork source must exist)`);
    if (locateGhola(ctx.root, subject, newSlug)) {
      fail(`ghola '${newSlug}' already exists for subject '${subject}' (pick a different --name)`);
    }
    const { frontmatter: sourceFm, body: sourceBody } = readGholaFile(loc.path);
    const sourceGeneration = Number(sourceFm.generation) || 1;
    const distilled = providedSummary || autoDistillHistory(sourceBody);
    const ts = nowIso();
    const newFrontmatter = {
      id: newSlug,
      name,
      purpose: sourceFm.purpose,
      subject,
      state: 'active',
      model: sourceFm.model || 'sonnet',
      generation: sourceGeneration + 1,
      parent: fromSlug,
      reliability: DEFAULT_RELIABILITY, // fresh reliability — a new generation starts its own track record
      verification: 'pending', // a new generation must be verified afresh
      created: ts,
      last_used: ts,
      missions: [],
    };
    const newBody = `# ${name}\n\n## History\n\n- ${todayDate()}: second awakening — forked from '${fromSlug}' (gen ${sourceGeneration} -> ${sourceGeneration + 1}). Distilled lessons carried forward: ${distilled}\n`;
    writeGholaFile(gholaFilePath(ctx.root, subject, newSlug), newFrontmatter, newBody);
    resultSlug = newSlug;
    // The source ghola at loc.path is never written to — fork only reads it.
  });
  console.log(resultSlug);
}

function cmdRecord({ flags }) {
  const usage = 'ghola record --subject S --ghola G --outcome pass|rework [--json]';
  const ctx = resolveContext(flags);
  const subject = slugify(requireFlag(flags, 'subject', usage));
  const gholaArg = requireFlag(flags, 'ghola', usage);
  const slug = slugify(gholaArg);
  const outcome = requireFlag(flags, 'outcome', usage);
  if (!['pass', 'rework'].includes(outcome)) fail(`--outcome must be one of pass|rework (got '${outcome}'). Usage: ${usage}`);
  let updatedFrontmatter;
  withLock(ctx.root, () => {
    const loc = locateGhola(ctx.root, subject, slug);
    if (!loc) fail(`ghola '${slug}' not found for subject '${subject}'`);
    const { frontmatter, body } = readGholaFile(loc.path);
    const rel = parseReliability(frontmatter.reliability);
    rel[outcome] += 1;
    frontmatter.reliability = formatReliability(rel);
    atomicWriteFileSync(loc.path, buildGholaContent(frontmatter, body));
    updatedFrontmatter = frontmatter;
  });
  if (flags.json) {
    printJson({ id: slug, outcome, reliability: updatedFrontmatter.reliability });
    return;
  }
  console.log(`${slug}: recorded ${outcome} -> reliability ${updatedFrontmatter.reliability}`);
}

// ─────────────────────────────────────────────────────────────────────────
// Commands — templates (recurring mission shapes)
// ─────────────────────────────────────────────────────────────────────────

function templatesDir(root) {
  return path.join(root, '_templates');
}

function templateFilePath(root, name) {
  return path.join(templatesDir(root), `${slugify(name)}.md`);
}

function cmdTemplateSave({ flags }) {
  const usage = 'ghola template save --subject S --name N --from-mission M';
  const ctx = resolveContext(flags);
  const subject = slugify(requireFlag(flags, 'subject', usage));
  const name = requireFlag(flags, 'name', usage);
  const missionId = requireFlag(flags, 'from-mission', usage);
  const missions = parseMissionsFile(readFileOr(missionsFilePath(ctx.root, subject), ''));
  const mission = missions.find((m) => m.id === missionId);
  if (!mission) fail(`mission '${missionId}' not found for subject '${subject}'`);
  const crew = collectGholas(ctx.root, subject).filter((g) => Array.isArray(g.missions) && g.missions.includes(missionId));
  ensureLedger(ctx);
  const slug = slugify(name);
  withLock(ctx.root, () => {
    ensureDirSync(templatesDir(ctx.root));
    const lines = [];
    lines.push(`# Template: ${name}`);
    lines.push('');
    lines.push(`Saved from mission ${mission.id} (subject: ${subject}) on ${todayDate()}.`);
    lines.push('');
    lines.push('## Goal pattern');
    lines.push('');
    lines.push(mission.goal);
    lines.push('');
    lines.push('## Crew');
    lines.push('');
    if (crew.length === 0) {
      lines.push('- (no gholas were tied to this mission at save time)');
    } else {
      for (const g of crew) lines.push(`- ${g.name || g.id} — ${g.purpose} [model: ${g.model || 'sonnet'}]`);
    }
    lines.push('');
    atomicWriteFileSync(templateFilePath(ctx.root, name), lines.join('\n'));
  });
  console.log(slug);
}

function cmdTemplateList({ flags }) {
  const ctx = resolveContext(flags);
  const dir = templatesDir(ctx.root);
  const names = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')).sort()
    : [];
  if (flags.json) {
    printJson({ templates: names });
    return;
  }
  if (names.length === 0) {
    console.log('no templates saved yet');
    return;
  }
  for (const n of names) console.log(n);
}

function cmdTemplateUse({ flags }) {
  const usage = 'ghola template use --name N [--json]';
  const ctx = resolveContext(flags);
  const name = requireFlag(flags, 'name', usage);
  const tPath = templateFilePath(ctx.root, name);
  const content = readFileOr(tPath, null);
  if (content === null) fail(`template '${slugify(name)}' not found (run 'ghola template list' to see what's saved)`);
  if (flags.json) {
    printJson({ name: slugify(name), content });
    return;
  }
  console.log(content);
}

// ─────────────────────────────────────────────────────────────────────────
// Commands — mission progress / operating notes
// ─────────────────────────────────────────────────────────────────────────

function cmdProgress({ flags }) {
  const usage = 'ghola progress --subject S --id M --note "..."';
  const ctx = resolveContext(flags);
  const subject = slugify(requireFlag(flags, 'subject', usage));
  const id = requireFlag(flags, 'id', usage);
  const note = sanitizeLine(requireFlag(flags, 'note', usage));
  withLock(ctx.root, () => {
    const mFile = missionsFilePath(ctx.root, subject);
    const missions = parseMissionsFile(readFileOr(mFile, ''));
    const m = missions.find((x) => x.id === id);
    if (!m) fail(`mission '${id}' not found for subject '${subject}'`);
    m.progress.push(`${nowIso()}: ${note}`);
    atomicWriteFileSync(mFile, serializeMissionsFile(missions));
  });
  console.log(`progress recorded on ${id}`);
}

function cmdNote({ flags }) {
  const usage = 'ghola note --subject S --text "..."';
  const ctx = resolveContext(flags);
  const subject = slugify(requireFlag(flags, 'subject', usage));
  const text = sanitizeLine(requireFlag(flags, 'text', usage));
  ensureLedger(ctx);
  ensureDirSync(subjectDir(ctx.root, subject));
  withLock(ctx.root, () => {
    const notesPath = notesFilePath(ctx.root, subject);
    let content = readFileOr(notesPath, null);
    if (content === null) {
      content = `# Operating Notes — ${subject}\n\nSelf-tuning notes: what works and what doesn't for this subject. Enhancements only — per the Ghola Mode design, these notes are the lowest-precedence layer and can never override core functionality, hard rules, or mode mechanics.\n\n## Notes\n`;
    }
    content = appendBulletUnderHeading(content, '## Notes', `${todayDate()}: ${text}`);
    atomicWriteFileSync(notesPath, content);
  });
  console.log('note recorded');
}

// ─────────────────────────────────────────────────────────────────────────
// Commands — alerts (per-subject, surfaced to the War Room)
// ─────────────────────────────────────────────────────────────────────────

// Tolerant parse of alerts.md's "- YYYY-MM-DD: text" bullets (same tolerant,
// line-scan approach as the rest of this file's parsers — a malformed or
// truncated line is simply skipped, never a crash). Ordering is file order,
// which is append-only, so this is newest-last (oldest bullet first, most
// recent alert is the bottom-most / last array entry).
function parseAlertsFile(content) {
  if (!content || !content.trim()) return [];
  const alerts = [];
  for (const rawLine of content.split('\n')) {
    const m = rawLine.match(/^-\s*(\d{4}-\d{2}-\d{2}):\s*(.*)$/);
    if (m) alerts.push({ date: m[1], text: m[2] });
  }
  return alerts;
}

function alertToJson(a) {
  return { text: a.text, date: a.date };
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 7 - ownership.md + escalations.md (per-subject, host-watched)
// ─────────────────────────────────────────────────────────────────────────

// ownership.md lines are "- <path> :: <ghola-slug> :: <iso8601>". Paths are
// stored VERBATIM (never slugified) and may themselves contain " :: ", so the
// ghola-slug and timestamp are peeled off the END and everything before is the
// path. Same tolerant line-scan as the other parsers: malformed lines skipped.
function parseOwnershipFile(content) {
  if (!content || !content.trim()) return [];
  const rows = [];
  for (const rawLine of content.split('\n')) {
    const m = rawLine.match(/^-\s+(.*)$/);
    if (!m) continue;
    const parts = m[1].split(' :: ');
    if (parts.length < 3) continue;
    const ts = parts.pop();
    const ghola = parts.pop();
    const p = parts.join(' :: ');
    if (!p || !ghola) continue;
    rows.push({ path: p, ghola, ts });
  }
  return rows;
}

function serializeOwnershipFile(subject, rows) {
  const lines = [`# Ownership - ${subject}`, ''];
  for (const r of rows) lines.push(`- ${r.path} :: ${r.ghola} :: ${r.ts}`);
  return `${lines.join('\n')}\n`;
}

function ownershipToJson(r) {
  return { path: r.path, ghola: r.ghola, at: r.ts };
}

// Reads a ghola's frontmatter `state` (active|dormant|archived), or null when
// the ghola file is absent or unreadable. Used by cmdClaim to decide whether an
// existing owner still actively holds a path (only an ACTIVE owner blocks a
// takeover; a dormant/archived/absent owner is stale and can be claimed over).
function gholaStateOrNull(root, subject, slug) {
  const loc = locateGhola(root, subject, slug);
  if (!loc) return null;
  try {
    return readGholaFile(loc.path).frontmatter.state || null;
  } catch {
    return null;
  }
}

// Removes every ownership.md line owned by `slug` for `subject`. Assumes the
// ledger lock is ALREADY held (called from inside an existing withLock in the
// lifecycle writers below; the advisory lockfile is not reentrant, so
// re-acquiring it there would deadlock). Returns the count removed.
function releaseAllForGholaLocked(root, subject, slug) {
  const p = ownershipFilePath(root, subject);
  const raw = readFileOr(p, null);
  if (raw === null) return 0;
  const rows = parseOwnershipFile(raw);
  const kept = rows.filter((r) => r.ghola !== slug);
  if (kept.length === rows.length) return 0;
  atomicWriteFileSync(p, serializeOwnershipFile(subject, kept));
  return rows.length - kept.length;
}

// The full set of statuses an escalations.md row may carry: pending (fresh),
// approved/denied (resolved by escalate --ack), cancelled (swept by mission
// done). A row bearing anything else is corrupt and is skipped on read (below).
const ESCALATION_STATUSES = new Set(['pending', 'approved', 'denied', 'cancelled']);

// escalations.md lines are
// "- <id> :: <status> :: <ghola-slug> :: <iso8601> :: <decision text>".
// id is E + 4-digit; status in {pending,approved,denied,cancelled}; the decision
// text is the remainder after the 4th " :: " (so it may itself contain "::").
function parseEscalationsFile(content) {
  if (!content || !content.trim()) return [];
  const rows = [];
  for (const rawLine of content.split('\n')) {
    const m = rawLine.match(/^-\s+(.*)$/);
    if (!m) continue;
    const parts = m[1].split(' :: ');
    if (parts.length < 5) continue;
    const [id, status, ghola, ts] = parts;
    // FIX E: accept 4-OR-MORE digits so E10000+ round-trips instead of being
    // silently dropped (E0001..E9999 stay zero-padded to 4; E10000 is 5 digits).
    if (!/^E\d{4,}$/.test(id)) continue;
    // Constrain status to the known set on READ: an unknown/corrupt status token
    // must not flow downstream (e.g. a bogus status treated as pending/terminal).
    // Skip the row entirely, consistent with the other malformed-line handling
    // in this file - tolerant, never a throw.
    if (!ESCALATION_STATUSES.has(status)) continue;
    const decision = parts.slice(4).join(' :: ');
    rows.push({ id, status, ghola, ts, decision });
  }
  return rows;
}

function serializeEscalationsFile(subject, rows) {
  const lines = [`# Escalations - ${subject}`, ''];
  for (const r of rows) lines.push(`- ${r.id} :: ${r.status} :: ${r.ghola} :: ${r.ts} :: ${r.decision}`);
  return `${lines.join('\n')}\n`;
}

function escalationToJson(r) {
  return { id: r.id, status: r.status, ghola: r.ghola, at: r.ts, decision: r.decision };
}

// Next E-prefixed id, mirroring nextMissionId's max+1 seed and collision-safe
// forward scan (FIX E). Zero-pad stays at 4 so E0001..E9999 keep their padding
// while E10000+ widen naturally; max+1 is gap-safe where rows.length+1 was not.
function nextEscalationId(rows) {
  const existing = new Set(rows.map((r) => r.id));
  let max = 0;
  for (const r of rows) {
    const mm = /^E(\d+)$/.exec(String(r.id));
    if (mm) max = Math.max(max, Number(mm[1]));
  }
  let n = max + 1;
  let id = `E${String(n).padStart(4, '0')}`;
  while (existing.has(id)) {
    n++;
    id = `E${String(n).padStart(4, '0')}`;
  }
  return id;
}

function cmdAlert({ flags }) {
  const usage = 'ghola alert --add "<text>" --subject S | ghola alert --list --subject S [--json]';
  if (!flags.add && !flags.list) {
    fail(`alert requires --add or --list. Usage: ${usage}`);
  }
  const ctx = resolveContext(flags);
  const subject = slugify(requireFlag(flags, 'subject', usage));

  if (flags.add) {
    const text = sanitizeLine(requireFlag(flags, 'add', usage));
    ensureLedger(ctx);
    ensureDirSync(subjectDir(ctx.root, subject));
    withLock(ctx.root, () => {
      const p = alertsFilePath(ctx.root, subject);
      let content = readFileOr(p, null);
      if (content === null) {
        content = `# Alerts — ${subject}\n\nAppend-only, dated bullets surfaced to the operator's War Room (a stuck ghola, goal-drift, a blocker, a budget nearing exhaustion). Newest-last: bullets accrete at the bottom, so the most recent alert is the last one in this section.\n\n## Alerts\n`;
      }
      content = appendBulletUnderHeading(content, '## Alerts', `${todayDate()}: ${text}`);
      atomicWriteFileSync(p, content);
    });
    console.log('alert recorded');
    return;
  }

  // --list
  const alerts = parseAlertsFile(readFileOr(alertsFilePath(ctx.root, subject), ''));
  if (flags.json) {
    printJson({ subject, alerts: alerts.map(alertToJson) });
    return;
  }
  if (alerts.length === 0) {
    console.log(`no alerts yet for subject '${subject}'`);
    return;
  }
  for (const a of alerts) console.log(`${a.date}  ${a.text}`);
}

// ─────────────────────────────────────────────────────────────────────────
// Commands - Phase 7 (verify / integrate / claim / release / escalate)
// ─────────────────────────────────────────────────────────────────────────

const PHASE7_STATES = ['pending', 'passed', 'failed'];

// Sets a ghola's frontmatter `verification` field (lock RMW). Pre-Phase-7
// gholas simply gain the key on first write; back-compat reads treat a missing
// key as 'pending' (see gholaToJson).
function cmdVerify({ flags }) {
  const usage = 'ghola verify --subject S --ghola G --state <pending|passed|failed>';
  const ctx = resolveContext(flags);
  const subject = slugify(requireFlag(flags, 'subject', usage));
  const slug = slugify(requireFlag(flags, 'ghola', usage));
  const state = requireFlag(flags, 'state', usage);
  if (!PHASE7_STATES.includes(state)) fail(`--state must be one of pending|passed|failed (got '${state}'). Usage: ${usage}`);
  withLock(ctx.root, () => {
    const loc = locateGhola(ctx.root, subject, slug);
    if (!loc) fail(`ghola '${slug}' not found for subject '${subject}'`);
    const { frontmatter, body } = readGholaFile(loc.path);
    frontmatter.verification = state;
    atomicWriteFileSync(loc.path, buildGholaContent(frontmatter, body));
  });
  if (flags.json) {
    printJson({ id: slug, verification: state });
    return;
  }
  console.log(`${slug}: verification -> ${state}`);
}

// Sets a mission block's `- integration:` line (lock RMW).
function cmdIntegrate({ flags }) {
  const usage = 'ghola integrate --subject S --mission M --state <pending|passed|failed>';
  const ctx = resolveContext(flags);
  const subject = slugify(requireFlag(flags, 'subject', usage));
  const id = requireFlag(flags, 'mission', usage);
  const state = requireFlag(flags, 'state', usage);
  if (!PHASE7_STATES.includes(state)) fail(`--state must be one of pending|passed|failed (got '${state}'). Usage: ${usage}`);
  withLock(ctx.root, () => {
    const mFile = missionsFilePath(ctx.root, subject);
    const missions = parseMissionsFile(readFileOr(mFile, ''));
    const m = missions.find((x) => x.id === id);
    if (!m) fail(`mission '${id}' not found for subject '${subject}'`);
    m.integration = state;
    atomicWriteFileSync(mFile, serializeMissionsFile(missions));
  });
  if (flags.json) {
    printJson({ mission: id, integration: state });
    return;
  }
  console.log(`mission ${id}: integration -> ${state}`);
}

// Adds an ownership.md line for (path, ghola). A path may be owned by at most
// one ACTIVE ghola: a claim on a path owned by a DIFFERENT ghola fails only
// when that owner is still active; if the owner is dormant/archived/absent the
// claim TAKES OVER the line (replacing owner + timestamp), because a stale
// owner must never permanently strand a path. Re-claiming one's own path is a
// no-op success.
function cmdClaim({ flags }) {
  const usage = 'ghola claim --subject S --ghola G --path P';
  const ctx = resolveContext(flags);
  const subject = slugify(requireFlag(flags, 'subject', usage));
  const slug = slugify(requireFlag(flags, 'ghola', usage));
  const claimPath = sanitizeLine(requireFlag(flags, 'path', usage));
  ensureLedger(ctx);
  ensureDirSync(subjectDir(ctx.root, subject));
  let tookOverFrom = null;
  withLock(ctx.root, () => {
    const p = ownershipFilePath(ctx.root, subject);
    const rows = parseOwnershipFile(readFileOr(p, ''));
    const existing = rows.find((r) => r.path === claimPath);
    if (existing) {
      if (existing.ghola === slug) return; // already ours - idempotent no-op
      const ownerState = gholaStateOrNull(ctx.root, subject, existing.ghola);
      if (ownerState === 'active') {
        fail(`path '${claimPath}' is already owned by active ghola '${existing.ghola}' for subject '${subject}' (that ghola must 'release' it first)`);
      }
      // Owner is dormant/archived/absent -> take over the line in place.
      tookOverFrom = { ghola: existing.ghola, state: ownerState || 'absent' };
      existing.ghola = slug;
      existing.ts = nowIso();
      atomicWriteFileSync(p, serializeOwnershipFile(subject, rows));
      return;
    }
    rows.push({ path: claimPath, ghola: slug, ts: nowIso() });
    atomicWriteFileSync(p, serializeOwnershipFile(subject, rows));
  });
  if (tookOverFrom) {
    console.log(`claimed ${claimPath} -> ${slug} (took over from ${tookOverFrom.state} ghola '${tookOverFrom.ghola}')`);
  } else {
    console.log(`claimed ${claimPath} -> ${slug}`);
  }
}

// Removes the ownership.md line for (path, ghola). A path with no matching
// live claim is an error (nothing to release).
function cmdRelease({ flags }) {
  const usage = 'ghola release --subject S --ghola G --path P';
  const ctx = resolveContext(flags);
  const subject = slugify(requireFlag(flags, 'subject', usage));
  const slug = slugify(requireFlag(flags, 'ghola', usage));
  const claimPath = sanitizeLine(requireFlag(flags, 'path', usage));
  withLock(ctx.root, () => {
    const p = ownershipFilePath(ctx.root, subject);
    const rows = parseOwnershipFile(readFileOr(p, ''));
    const idx = rows.findIndex((r) => r.path === claimPath && r.ghola === slug);
    if (idx === -1) fail(`no ownership claim on path '${claimPath}' by '${slug}' for subject '${subject}'`);
    rows.splice(idx, 1);
    atomicWriteFileSync(p, serializeOwnershipFile(subject, rows));
  });
  console.log(`released ${claimPath} from ${slug}`);
}

// escalate has four modes:
//   --add "<text>" --ghola G : append a pending escalation, print the new id.
//   --cancel <id>            : move that PENDING escalation to 'cancelled' in
//                              escalations.md (lock-serialized). An explicit,
//                              scoped replacement for the removed mission-done
//                              sweep (FIX 2): it touches ONLY the named id, so a
//                              TPM can cancel its own mission's stale escalation
//                              without disturbing escalations owned by other
//                              live missions on the same subject. A missing or
//                              non-pending id is a clear, non-zero error.
//   --status [--json]        : report this subject's pending control.json
//                              escalationResolve entries + list escalations.md.
//   --ack                    : apply the control.json escalationResolve entries
//                              whose subject matches --subject to escalations.md
//                              (flip each id's status to approved/denied); an
//                              entry whose id is missing from escalations.md is
//                              WARNED and SKIPPED (never fatal; this is what
//                              stops a stuck ack loop). Only the exact
//                              {id,subject,decision} tuples this ack processed
//                              are then removed from the queue (FIX 1: a tuple
//                              the operator FLIPPED after phase 2 read it
//                              survives to be re-processed with the latest
//                              decision; entries for OTHER subjects stay), and
//                              escalationResolveAcknowledgedAt is stamped.
//                              Independent of the awaken/resume/directive/
//                              declaredone protocols (their fields are preserved).
function cmdEscalate({ flags }) {
  const usage = 'ghola escalate --subject S --add "<text>" --ghola G | --cancel <id> | --status [--json] | --ack';
  const ctx = resolveContext(flags);
  const subject = slugify(requireFlag(flags, 'subject', usage));
  if (!flags.add && !flags.cancel && !flags.status && !flags.ack) {
    fail(`escalate requires --add, --cancel, --status, or --ack. Usage: ${usage}`);
  }

  if (flags.cancel) {
    // Scoped, explicit cancel of ONE pending escalation (replaces the removed
    // mission-done subject-wide sweep). Lock-serialized RMW of escalations.md.
    const id = requireFlag(flags, 'cancel', usage);
    ensureLedger(ctx);
    ensureDirSync(subjectDir(ctx.root, subject));
    let result = { kind: 'not-found' };
    withLock(ctx.root, () => {
      const p = escalationsFilePath(ctx.root, subject);
      const raw = readFileOr(p, null);
      if (raw === null) return;
      const rows = parseEscalationsFile(raw);
      const row = rows.find((r) => r.id === id);
      if (!row) return;
      if (row.status !== 'pending') {
        result = { kind: 'not-pending', status: row.status };
        return;
      }
      row.status = 'cancelled';
      atomicWriteFileSync(p, serializeEscalationsFile(subject, rows));
      result = { kind: 'cancelled' };
    });
    if (result.kind === 'cancelled') {
      console.log(`escalate: cancelled ${id} for subject '${subject}'`);
      return;
    }
    if (result.kind === 'not-pending') {
      fail(`escalate --cancel: escalation '${id}' is already ${result.status} (not pending) for subject '${subject}'; nothing cancelled`);
    }
    fail(`escalate --cancel: escalation '${id}' not found for subject '${subject}'; nothing cancelled`);
  }

  if (flags.add) {
    const text = sanitizeLine(requireFlag(flags, 'add', usage));
    // FIX C: whitespace-only text sanitizes to empty, which would serialize a
    // malformed escalations.md line the host parser silently drops (an
    // invisible, unresolvable escalation). Refuse it outright.
    if (!text) fail('escalation text cannot be empty');
    const slug = slugify(requireFlag(flags, 'ghola', usage));
    ensureLedger(ctx);
    ensureDirSync(subjectDir(ctx.root, subject));
    let newId;
    withLock(ctx.root, () => {
      const p = escalationsFilePath(ctx.root, subject);
      const rows = parseEscalationsFile(readFileOr(p, ''));
      newId = nextEscalationId(rows);
      rows.push({ id: newId, status: 'pending', ghola: slug, ts: nowIso(), decision: text });
      atomicWriteFileSync(p, serializeEscalationsFile(subject, rows));
    });
    console.log(newId);
    return;
  }

  if (flags.ack) {
    // TPM calls this AFTER the host/god-console has enqueued escalationResolve
    // decisions. This command applies EVERY queue entry for --subject to
    // escalations.md and drops those entries; a decision whose id is missing
    // from escalations.md is warned + skipped (not fatal) so it cannot wedge
    // the queue forever. Entries for other subjects are left untouched. The
    // awaken/resume/directive/declaredone fields share this control file and
    // are preserved untouched (all protocols mutually preserve).
    //
    // FIX (control-lock contention): the control lock and the ledger lock are
    // NEVER held at the same time. If control were held across the ledger apply
    // (ledger-lock budget ~15s), a single ack could hold the control lock long
    // past its 5s stale window and the host's 2s fail-open, reintroducing the
    // lost-write the control lock exists to prevent. So this is split into three
    // phases: (1) an UNLOCKED read to fail-fast when this subject has nothing
    // queued; (2) the escalations.md apply under the LEDGER lock ONLY, which
    // RE-READS control.json fresh so it applies the operator's LATEST decision
    // (FIX 1) and records the exact {id,subject,decision} tuples it processed;
    // (3) a short, fast control-lock RMW that RE-READS control.json fresh and
    // removes ONLY those exact processed tuples. Neither lock is ever nested
    // inside the other.
    const applied = [];
    const warned = []; // ids present in the queue but absent from escalations.md
    const skippedTerminal = []; // {id, status}: matched a NON-pending row (FIX B)
    // FIX 1: the exact {id,subject,decision} tuples this ack actually PROCESSED
    // in phase 2 (applied OR warned OR skipped-terminal). Phase 3 removes ONLY
    // these exact tuples from the fresh queue. A tuple the operator FLIPPED
    // (same id+subject, different decision) after phase 2 read it will NOT match,
    // so it is preserved (not applied-and-dropped) and re-processed on the next
    // ack ONLY IF the row is still pending. Once phase 2 has written the row to a
    // terminal state (approved/denied), a later reversal is NOT auto-applied: the
    // next ack sees a terminal row and warn+skips it, so the operator must re-open
    // or re-raise the escalation to change a resolved decision. Keyed by
    // pipe-joined fields (decision is part of the identity); '|' is printable and
    // cannot appear in any field - id is /^E\d{4,}$/, subject is slugified to
    // [a-z0-9-], decision is approve|deny - so it is collision-free and, unlike a
    // NUL separator, keeps the file plain-text to grep and other tooling.
    const tupleKey = (e) => `${e.id}|${e.subject}|${e.decision}`;
    const processedTuples = new Set();
    let remaining = [];

    // Phase 1 (NO lock): read control.json only to fail-fast when this subject
    // has no queued resolves at all. The AUTHORITATIVE decision read happens in
    // phase 2 (fresh, under the ledger lock); the AUTHORITATIVE removal happens
    // in phase 3 (fresh, under the control lock).
    const initial = readControl(ctx.root, subject);
    if (initial.escalationResolve.filter((e) => e.subject === subject).length === 0) {
      fail(`escalate --ack: no pending escalationResolve entries for subject '${subject}' in control.json`);
    }

    // Phase 2 (LEDGER lock ONLY - control lock NOT held): RE-READ control.json
    // fresh so the queue reflects any decision the operator flipped while this
    // command was blocked on the ledger lock, then apply each of THIS subject's
    // decisions to escalations.md. Even if the ledger lock is contended for its
    // full ~15s budget, the control lock is not held during that wait, so its
    // ~5s stale window and the host's 2s fail-open are never outlived.
    withLock(ctx.root, () => {
      const fresh2 = readControl(ctx.root, subject);
      const forSubject = fresh2.escalationResolve.filter((e) => e.subject === subject);
      const p = escalationsFilePath(ctx.root, subject);
      const rows = parseEscalationsFile(readFileOr(p, ''));
      let changed = false;
      for (const e of forSubject) {
        // Record the EXACT tuple we are about to process, regardless of outcome
        // (applied/warned/terminal). Phase 3 removes exactly these tuples; a tuple
        // the operator changes AFTER this read has a different decision and thus a
        // different key, so it will not be removed.
        processedTuples.add(tupleKey(e));
        const row = rows.find((r) => r.id === e.id);
        if (!row) {
          warned.push(e.id);
          continue;
        }
        // FIX B: only a PENDING row may be resolved. A row already cancelled,
        // approved, or denied is terminal - applying the queued decision would
        // resurrect/overwrite it, so warn + skip and leave the row exactly as it
        // is. The tuple is still recorded above so the queue entry is dropped in
        // phase 3 and the ack never wedges.
        if (row.status !== 'pending') {
          skippedTerminal.push({ id: e.id, status: row.status });
          continue;
        }
        row.status = e.decision === 'approve' ? 'approved' : 'denied';
        applied.push({ id: e.id, decision: e.decision });
        changed = true;
      }
      if (changed) atomicWriteFileSync(p, serializeEscalationsFile(subject, rows));
    });

    // Phase 3 (CONTROL lock ONLY - short, fast RMW): RE-READ control.json fresh
    // and remove ONLY the exact {id,subject,decision} tuples this ack processed.
    // Re-reading means any resolve the operator/host appended - OR FLIPPED - since
    // phase 2 is preserved: a flipped tuple has a different decision, so it does
    // not match a processed tuple and stays in the queue for the next ack. Other
    // subjects' entries are untouched, and the awaken/resume/directive/declaredone
    // fields are carried over from the FRESH read so a concurrent host write to
    // any of them wins.
    withControlLock(ctx.root, subject, () => {
      const fresh = readControl(ctx.root, subject);
      remaining = fresh.escalationResolve.filter((e) => !processedTuples.has(tupleKey(e)));
      const next = {
        awakenAll: fresh.awakenAll,
        escalationResolve: remaining,
        escalationResolveAcknowledgedAt: nowIso(),
      };
      if (fresh.requestedAt) next.requestedAt = fresh.requestedAt;
      if (fresh.acknowledgedAt) next.acknowledgedAt = fresh.acknowledgedAt;
      if (fresh.resumeMission !== null) next.resumeMission = fresh.resumeMission;
      if (fresh.resumeRequestedAt) next.resumeRequestedAt = fresh.resumeRequestedAt;
      if (fresh.resumeAcknowledgedAt) next.resumeAcknowledgedAt = fresh.resumeAcknowledgedAt;
      if (fresh.directive !== null) next.directive = fresh.directive;
      if (fresh.directiveRequestedAt) next.directiveRequestedAt = fresh.directiveRequestedAt;
      if (fresh.directiveAcknowledgedAt) next.directiveAcknowledgedAt = fresh.directiveAcknowledgedAt;
      if (fresh.declareDone !== null) next.declareDone = fresh.declareDone;
      if (fresh.declareDoneRequestedAt) next.declareDoneRequestedAt = fresh.declareDoneRequestedAt;
      if (fresh.declareDoneAcknowledgedAt) next.declareDoneAcknowledgedAt = fresh.declareDoneAcknowledgedAt;
      if (fresh.escalationResolveRequestedAt) next.escalationResolveRequestedAt = fresh.escalationResolveRequestedAt;
      atomicWriteFileSync(controlFilePath(ctx.root, subject), `${JSON.stringify(next, null, 2)}\n`);
    });
    for (const wid of warned) {
      console.error(`ghola: warning: escalate --ack: escalation '${wid}' not found in escalations.md for subject '${subject}'; skipped`);
    }
    for (const s of skippedTerminal) {
      console.error(`ghola: warning: escalate --ack: escalation '${s.id}' is already ${s.status} (not pending); skipped without change`);
    }
    const state = readControl(ctx.root, subject);
    if (flags.json) {
      printJson(state);
    } else {
      console.log(`escalate: acknowledged ${applied.length} resolve(s) for subject '${subject}' (${state.path})`);
      for (const a of applied) console.log(`  - ${a.id} -> ${a.decision === 'approve' ? 'approved' : 'denied'}`);
      if (warned.length) console.log(`  skipped (not found in escalations.md): ${warned.join(', ')}`);
      if (skippedTerminal.length) console.log(`  skipped (already terminal): ${skippedTerminal.map((s) => `${s.id} (${s.status})`).join(', ')}`);
      console.log(`  remaining escalationResolve entries: ${remaining.length}`);
      console.log(`  escalationResolveAcknowledgedAt: ${state.escalationResolveAcknowledgedAt}`);
    }
    return;
  }

  // --status
  const state = readControl(ctx.root, subject);
  const rows = parseEscalationsFile(readFileOr(escalationsFilePath(ctx.root, subject), ''));
  const pendingForSubject = state.escalationResolve.filter((e) => e.subject === subject);
  if (flags.json) {
    printJson({ subject, escalationResolve: pendingForSubject, escalations: rows.map(escalationToJson) });
    return;
  }
  if (pendingForSubject.length) {
    console.log(`escalate: ${pendingForSubject.length} pending resolve entr${pendingForSubject.length === 1 ? 'y' : 'ies'} for subject '${subject}':`);
    for (const e of pendingForSubject) console.log(`  - ${e.id} -> ${e.decision}`);
  } else {
    console.log(`escalate: no pending escalationResolve entries for subject '${subject}'`);
  }
  if (rows.length === 0) {
    console.log(`no escalations yet for subject '${subject}'`);
    return;
  }
  for (const r of rows) console.log(`${r.id}  (${r.status})  ${r.ghola}  ${r.ts}  ${r.decision}`);
}

// ─────────────────────────────────────────────────────────────────────────
// Commands — ls / board (read-only, lock-free)
// ─────────────────────────────────────────────────────────────────────────

function cmdLs({ flags }) {
  const usage = 'ghola ls --subject S [--json]';
  const ctx = resolveContext(flags);
  const subject = slugify(requireFlag(flags, 'subject', usage));
  const rows = collectGholas(ctx.root, subject);
  if (flags.json) {
    printJson({ subject, gholas: rows.map(gholaToJson), counts: countsByState(rows) });
    return;
  }
  if (rows.length === 0) {
    console.log(`no gholas yet for subject '${subject}'`);
    return;
  }
  console.log(`${'ID'.padEnd(22)}${'STATE'.padEnd(11)}${'MODEL'.padEnd(9)}${'LAST USED'.padEnd(12)}PURPOSE`);
  for (const g of rows) {
    const lastUsed = String(g.last_used || '').slice(0, 10);
    const gj = gholaToJson(g);
    console.log(`${String(g.id ?? 'unknown').padEnd(22)}${String(g.state ?? 'unknown').padEnd(11)}${String(g.model ?? 'unknown').padEnd(9)}${lastUsed.padEnd(12)}${truncate(g.purpose ?? 'unknown', 40)}${lineageSuffix(gj)}`);
  }
}

// Returns the missions to show on a subject board: the specific --id when
// given, else all open missions.
function shownMissions(root, subject, flags) {
  const missions = parseMissionsFile(readFileOr(missionsFilePath(root, subject), ''));
  if (flags.id) return { missions, shown: missions.filter((m) => m.id === flags.id) };
  return { missions, shown: missions.filter((m) => m.status === 'open') };
}

function subjectBoardData(root, subject, flags) {
  const { shown } = shownMissions(root, subject, flags);
  const roster = collectGholas(root, subject);
  const alerts = parseAlertsFile(readFileOr(alertsFilePath(root, subject), ''));
  const ownership = parseOwnershipFile(readFileOr(ownershipFilePath(root, subject), ''));
  const escalations = parseEscalationsFile(readFileOr(escalationsFilePath(root, subject), ''));
  return {
    scope: 'subject',
    ledgerRoot: root,
    subject,
    // missions[].integration and roster[].verification carry the Phase 7 state.
    missions: shown.map(missionToJson),
    roster: roster.map(gholaToJson),
    counts: countsByState(roster),
    alerts: alerts.map(alertToJson),
    ownership: ownership.map(ownershipToJson),
    escalations: escalations.map(escalationToJson),
  };
}

function renderBoardForSubject(root, subject, flags) {
  const width = 80;
  const rule = '='.repeat(width);
  const thin = '-'.repeat(width);
  const lines = [rule, ` WAR ROOM — subject: ${subject}`, rule];
  const { shown } = shownMissions(root, subject, flags);
  if (shown.length === 0) {
    lines.push(flags.id ? `(mission '${flags.id}' not found)` : '(no open missions)');
  }
  for (const m of shown) {
    lines.push(`Mission ${m.id} (${m.status}) — ${m.date}`);
    lines.push(`  goal:        ${m.goal}`);
    lines.push(`  grounded-in: ${m.groundedIn || '(none)'}`);
    lines.push(`  budget:      ${m.budget || '(none)'}`);
    lines.push(`  integration: ${m.integration || '(none)'}`);
    if (m.progress.length) {
      lines.push('  progress:');
      for (const p of m.progress.slice(-5)) lines.push(`    - ${p}`);
    }
    lines.push('');
  }
  const roster = collectGholas(root, subject);
  lines.push(`Roster (${roster.length} ghola${roster.length === 1 ? '' : 's'})`);
  lines.push(thin);
  lines.push(`  ${'ID'.padEnd(20)}${'STATE'.padEnd(11)}${'MODEL'.padEnd(9)}${'LAST USED'.padEnd(12)}PURPOSE`);
  for (const g of roster) {
    const lastUsed = String(g.last_used || '').slice(0, 10);
    lines.push(`  ${String(g.id ?? 'unknown').padEnd(20)}${String(g.state ?? 'unknown').padEnd(11)}${String(g.model ?? 'unknown').padEnd(9)}${lastUsed.padEnd(12)}${truncate(g.purpose ?? 'unknown', 30)}${lineageSuffix(gholaToJson(g))}`);
  }
  lines.push(thin);
  const counts = countsByState(roster);
  lines.push(`Ledger: ${counts.active} active, ${counts.dormant} dormant, ${counts.archived} archived (${roster.length} total)`);
  const alerts = parseAlertsFile(readFileOr(alertsFilePath(root, subject), ''));
  if (alerts.length) {
    lines.push(thin);
    lines.push(`Alerts (${alerts.length}, newest last):`);
    for (const a of alerts) lines.push(`  - ${a.date}: ${a.text}`);
  }
  const ownership = parseOwnershipFile(readFileOr(ownershipFilePath(root, subject), ''));
  if (ownership.length) {
    lines.push(thin);
    lines.push(`Ownership (${ownership.length}):`);
    for (const o of ownership) lines.push(`  - ${o.path} :: ${o.ghola}`);
  }
  const escalations = parseEscalationsFile(readFileOr(escalationsFilePath(root, subject), ''));
  if (escalations.length) {
    lines.push(thin);
    lines.push(`Escalations (${escalations.length}):`);
    for (const e of escalations) lines.push(`  - ${e.id} (${e.status}) ${e.ghola}: ${e.decision}`);
  }
  lines.push(rule);
  return lines.join('\n');
}

function allSubjectsBoardData(root) {
  const subjects = listSubjects(root);
  return {
    scope: 'all',
    ledgerRoot: root,
    subjects: subjects.map((s) => {
      const roster = collectGholas(root, s);
      const missions = parseMissionsFile(readFileOr(missionsFilePath(root, s), ''));
      return {
        subject: s,
        counts: countsByState(roster),
        openMissions: missions.filter((m) => m.status === 'open').length,
      };
    }),
  };
}

function renderBoardAll(root) {
  const width = 80;
  const rule = '='.repeat(width);
  const thin = '-'.repeat(width);
  const lines = [rule, ' WAR ROOM — all subjects', rule];
  const data = allSubjectsBoardData(root);
  if (data.subjects.length === 0) {
    lines.push('(no subjects yet — run `ghola mission start --subject <S> --goal "..."` to begin)');
  } else {
    lines.push(`${'SUBJECT'.padEnd(24)}${'ACTIVE'.padEnd(9)}${'DORMANT'.padEnd(10)}${'ARCHIVED'.padEnd(10)}OPEN MISSIONS`);
    lines.push(thin);
    for (const s of data.subjects) {
      lines.push(`${s.subject.padEnd(24)}${String(s.counts.active).padEnd(9)}${String(s.counts.dormant).padEnd(10)}${String(s.counts.archived).padEnd(10)}${s.openMissions}`);
    }
  }
  lines.push(rule);
  return lines.join('\n');
}

function cmdBoard({ flags }) {
  const ctx = resolveContext(flags);
  ensureLedger(ctx);
  const root = ctx.root;
  if (flags.subject) {
    const subject = slugify(flags.subject);
    if (flags.json) printJson(subjectBoardData(root, subject, flags));
    else console.log(renderBoardForSubject(root, subject, flags));
    return;
  }
  if (flags.id) {
    for (const s of listSubjects(root)) {
      const missions = parseMissionsFile(readFileOr(missionsFilePath(root, s), ''));
      if (missions.some((m) => m.id === flags.id)) {
        if (flags.json) printJson(subjectBoardData(root, s, flags));
        else console.log(renderBoardForSubject(root, s, flags));
        return;
      }
    }
    if (flags.json) printJson({ scope: 'subject', ledgerRoot: root, subject: null, missions: [], roster: [], counts: countsByState([]), alerts: [], ownership: [], escalations: [], error: `mission '${flags.id}' not found in any subject` });
    else console.log(`mission '${flags.id}' not found in any subject`);
    return;
  }
  if (flags.json) printJson(allSubjectsBoardData(root));
  else console.log(renderBoardAll(root));
}

// ─────────────────────────────────────────────────────────────────────────
// Commands — boot (read-only session-start orientation aggregate)
// ─────────────────────────────────────────────────────────────────────────

// Excerpts a subject's operating-notes.md WITHOUT dumping the whole file:
// reports existence, total line count, and the first `maxLines` lines as a
// short preview. Read-only — readFileOr degrades a missing file to null, so
// this never creates operating-notes.md (a fresh subject reads as absent).
function operatingNotesSummary(root, subject, maxLines = 15) {
  const p = notesFilePath(root, subject);
  const raw = readFileOr(p, null);
  if (raw === null) return { path: p, exists: false, lines: 0, excerpt: '', truncated: false, maxLines };
  const allLines = raw.split('\n');
  // Drop a single trailing empty line (from the file's final newline) so the
  // reported count reflects visible content, not the trailing blank.
  const totalLines = raw.endsWith('\n') ? allLines.length - 1 : allLines.length;
  return {
    path: p,
    exists: true,
    lines: totalLines,
    excerpt: allLines.slice(0, maxLines).join('\n'),
    truncated: totalLines > maxLines,
    maxLines,
  };
}

// Aggregates, for one --subject, the entire READ-ONLY orientation a War Mode
// session needs at start — cooperative-control state, the resolved ledger root,
// prior missions, existing crew, and an operating-notes excerpt — in ONE
// invocation, so mode-start costs a single node startup instead of the 3+ it
// took across separate awaken --status / ledger-root / mission list / ls /
// operating-notes calls. STRICTLY READ-ONLY: it reuses the same readers those
// standalone commands use (readControl, resolveContext, parseMissionsFile,
// collectGholas, notesFilePath) and never acks or mutates ledger content — no
// ensureLedger, no control write, no ghola/mission write. (resolveContext does
// mkdir -p the ledger ROOT so a home-fallback root exists to read from, but it
// writes no content.) It degrades cleanly on a fresh subject / missing control
// file (the normal case) to empty/none/clean sections and exits 0; it never
// throws for those.
function cmdBoot({ flags }) {
  const usage = 'ghola boot --subject S [--json]';
  const ctx = resolveContext();
  const subject = slugify(requireFlag(flags, 'subject', usage));

  // control — the same reader the awaken/resume/directive/declaredone/escalate
  // --status commands use, now per-subject under the ledger root
  // (<ledger-root>/<subject>/control.json). Absent, corrupt, or non-object
  // control.json all degrade to the "no control active" shape (exists:false);
  // never throws.
  const control = readControl(ctx.root, subject);

  // ledgerRoot — reuse resolveContext's resolution (identical to ls /
  // mission list). It always resolves to a path (vault-based, or the
  // <homedir>/.ghola/ledger fallback when no vault env is set); report whether
  // that directory currently exists on disk and whether it came from a vault.
  const ledgerRoot = { path: ctx.root, exists: fs.existsSync(ctx.root), fromVault: ctx.vault !== null };

  // missions — the same data `mission list --subject S` returns (empty for a
  // fresh subject: readFileOr degrades the missing _missions.md to '').
  const missions = parseMissionsFile(readFileOr(missionsFilePath(ctx.root, subject), ''));

  // gholas — the same data `ls --subject S` returns (empty for a fresh subject).
  const rows = collectGholas(ctx.root, subject);

  // operatingNotes — existence + short excerpt, never the whole file.
  const operatingNotes = operatingNotesSummary(ctx.root, subject);

  if (flags.json) {
    printJson({
      subject,
      control,
      ledgerRoot,
      missions: missions.map(missionToJson),
      gholas: rows.map(gholaToJson),
      counts: countsByState(rows),
      operatingNotes,
    });
    return;
  }

  // Text default — a compact, human-readable orientation block.
  console.log(`Boot orientation — subject: ${subject}`);
  console.log('='.repeat(60));

  if (!control.exists) {
    console.log(`Control: clean (no control file at ${control.path})`);
  } else {
    console.log(`Control: active (${control.path})`);
    const parts = [
      `awakenAll:${control.awakenAll}`,
      `resumeMission:${control.resumeMission ?? '(none)'}`,
      `directive:${control.directive ?? '(none)'}`,
      `declareDone:${control.declareDone ?? '(none)'}`,
      `escalationResolve:${control.escalationResolve.length}`,
    ];
    console.log(`  ${parts.join('  ')}`);
  }

  console.log(`Ledger root: ${ledgerRoot.path}${ledgerRoot.exists ? '' : ' (does not exist yet)'}`);

  if (missions.length === 0) {
    console.log('Missions: none');
  } else {
    console.log(`Missions (${missions.length}):`);
    for (const m of missions) {
      const budgetSuffix = m.budget ? `  [budget: ${m.budget}]` : '';
      console.log(`  ${m.id}  (${m.status})  ${m.date}  ${m.goal}${budgetSuffix}`);
    }
  }

  if (rows.length === 0) {
    console.log('Gholas: none');
  } else {
    const counts = countsByState(rows);
    console.log(`Gholas (${counts.active} active, ${counts.dormant} dormant, ${counts.archived} archived, ${counts.total} total):`);
    for (const g of rows) {
      console.log(`  ${String(g.id ?? 'unknown')} [${g.state ?? 'unknown'}] ${truncate(g.purpose ?? 'unknown', 40)}${lineageSuffix(gholaToJson(g))}`);
    }
  }

  if (!operatingNotes.exists) {
    console.log('Operating notes: absent');
  } else {
    const more = operatingNotes.truncated ? `, first ${operatingNotes.maxLines} shown` : '';
    console.log(`Operating notes: present (${operatingNotes.lines} line${operatingNotes.lines === 1 ? '' : 's'}${more}):`);
    for (const line of operatingNotes.excerpt.split('\n')) console.log(`  | ${line}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Help + dispatch
// ─────────────────────────────────────────────────────────────────────────

const HELP = `ghola — Ghola Mode command layer (reads/writes the _Gholas/ ledger)

Ledger-root resolution (GLOBAL — identical to the extension host + launcher;
NOTHING is ever written to or read from the launched work repo):
  1. GHOLA_LEDGER_ROOT env (non-empty)  -> used verbatim
  2. GHOLA_VAULT env (non-empty)        -> <vault>/_Gholas/
  3. otherwise                          -> <homedir>/.ghola/ledger/
A convenience copy of the root path is written to <ledger-root>/.ledger-path.
Per-subject cooperative control lives at <ledger-root>/<subject>/control.json.

Commands:
  mission start   --subject S --goal "..." [--grounded-in "..."] [--budget "..."] [--id ID]
                                                                             start a mission, prints its mission-id
  mission list    --subject S [--json]                                      list all missions for a subject
  mission resume  --subject S --id M [--json]                               print a mission record + its gholas
  mission done    --subject S --id M [--force]                              mark a mission done (refuses unless the
                                                                             mission's integration is 'passed';
                                                                             --force overrides. Does NOT touch
                                                                             escalations - cancel a specific stale
                                                                             one with 'escalate --cancel'.)
  mission reopen  --subject S --id M                                        flip a done mission back to open (active
                                                                             surface + gates re-apply; RESETS integration
                                                                             to pending so resumed work must re-integrate,
                                                                             progress history preserved. Already-open is a
                                                                             no-op; not-found -> clear non-zero error.)
  awaken          --subject S --status | --ack [--json]                     read/ack the kill-switch control file
                                                                             (<ledger-root>/<subject>/control.json; the
                                                                             CLI never sets awakenAll true — that is
                                                                             the host/human's job via the War Room
                                                                             button. --ack is called by TPM only
                                                                             after standing the whole team down.)
  resume          --subject S --status | --ack [--json]                     read/ack a per-mission resume request
                                                                             (same control.json, field resumeMission;
                                                                             the CLI never sets resumeMission to a
                                                                             mission id — that is the host's Resume
                                                                             button's job. --ack is called by TPM
                                                                             only after reawakening that mission's
                                                                             crew from the ledger. Independent of
                                                                             awaken's fields — neither ack disturbs
                                                                             the other's.)
  directive       --subject S --status | --ack [--json]                     read/ack the god-console directive field
                                                                             (same control.json, field directive; the
                                                                             CLI never sets directive to non-null —
                                                                             that is the host/god-console's job. --ack
                                                                             is called by TPM only after acting on the
                                                                             directive. Independent of awaken's,
                                                                             resume's, and declaredone's fields — no
                                                                             ack disturbs another protocol's fields;
                                                                             all four mutually preserve.)
  declaredone     --subject S --status | --ack [--json]                     read/ack the operator's P4 Declare Done
                                                                             field (same control.json, field
                                                                             declareDone: mission-id | null; the CLI
                                                                             never sets declareDone to non-null —
                                                                             that is the host/Declare-Done-button's
                                                                             job. --ack is called by TPM only after
                                                                             marking the mission done, standing the
                                                                             crew down, and reporting completion.
                                                                             Independent of awaken's, resume's, and
                                                                             directive's fields — all four protocols
                                                                             mutually preserve.)
  spawn           --subject S --name N --purpose "..." [--model M] [--mission M] [--parent P]
                                                                             create a new ghola, prints its slug.
                                                                             --parent sets generation = parent's
                                                                             generation + 1 (if found; else 1) and
                                                                             records parent = that slug
  fork            --subject S --from G --name N [--summary "..."]           second awakening: clean new generation
                                                                             from an existing ghola (copies purpose +
                                                                             model, generation = source + 1, parent =
                                                                             source, fresh reliability, distilled
                                                                             one-line lessons carried forward via
                                                                             --summary or an auto-distilled fallback).
                                                                             The source ghola is untouched. Prints
                                                                             the new slug.
  record          --subject S --ghola G --outcome pass|rework [--json]      increment that ghola's reliability
                                                                             counter ("pass:N rework:M")
  state           --subject S --ghola G <active|dormant|archived>           set a ghola's state directly
  debrief         --subject S --ghola G --summary "..."                     append to a ghola's History (accretion)
  progress        --subject S --id M --note "..."                          append a progress note to a mission
  note            --subject S --text "..."                                 append a self-tuning operating note
  alert           --add "..." --subject S | --list --subject S [--json]    append/list per-subject alerts.md bullets
                                                                             (newest-last; surfaced in 'board --json')
  verify          --subject S --ghola G --state <pending|passed|failed>    set a ghola's frontmatter verification state
  integrate       --subject S --mission M --state <pending|passed|failed>  set a mission's integration state
  claim           --subject S --ghola G --path P                          claim ownership of a path (fails if another
                                                                             ghola already owns it; own-path is a no-op)
  release         --subject S --ghola G --path P                          release a (path, ghola) ownership claim
  escalate        --subject S --add "..." --ghola G                        append a pending escalation, prints its id
  escalate        --subject S --cancel <id>                                move that PENDING escalation to cancelled
                                                                             (scoped: touches only that id; missing or
                                                                             non-pending id -> clear non-zero error)
  escalate        --subject S --status [--json]                            show this subject's pending
                                                                             escalationResolve queue entries + list
                                                                             escalations.md entries
  escalate        --subject S --ack                                        apply this subject's control.json
                                                                             escalationResolve entries to
                                                                             escalations.md (missing id -> warn +
                                                                             skip, not fatal), then drop only the exact
                                                                             {id,subject,decision} tuples processed (a
                                                                             flipped decision survives for the next
                                                                             ack; other subjects kept), preserve the
                                                                             other protocols
  template save   --subject S --name N --from-mission M                    save a mission's goal pattern + crew as a
                                                                             reusable template at
                                                                             <ledger-root>/_templates/<name>.md
  template list   [--json]                                                 list saved templates
  template use    --name N [--json]                                        print a saved template's contents (for
                                                                             TPM to instantiate a fresh mission+crew)
  wake            --subject S --ghola G                                    reactivate a ghola (resets last_used)
  retire          --subject S --ghola G                                    soft-archive a ghola (moved, not deleted)
  groom           --subject S [--days 30]                                  soft-archive gholas idle past N days
  ls              --subject S [--json]                                     list gholas: state, last_used, purpose,
                                                                             generation, parent, reliability
  board           [--subject S] [--id M] [--json]                          render the war-room (ASCII, or JSON;
                                                                             subject scope includes alerts; roster
                                                                             entries include generation/parent/
                                                                             reliability)
  boot            --subject S [--json]                                     read-only session-start orientation: one
                                                                             aggregate of control-file state, resolved
                                                                             ledger root, prior missions, existing crew,
                                                                             and an operating-notes excerpt (fresh
                                                                             subject -> clean/none sections). Reuses the
                                                                             --status / mission list / ls / notes
                                                                             readers; never writes or acks anything.
  --help                                                                    show this message
`;

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    console.log(HELP);
    process.exit(0);
  }
  const [command, ...rest] = argv;
  let commandArgs = rest;
  let subcommand = null;
  if (command === 'mission' || command === 'template') {
    subcommand = rest[0];
    commandArgs = rest.slice(1);
  }
  const parsed = parseArgs(commandArgs);

  const routes = {
    'mission:start': cmdMissionStart,
    'mission:list': cmdMissionList,
    'mission:resume': cmdMissionResume,
    'mission:done': cmdMissionDone,
    'mission:reopen': cmdMissionReopen,
    awaken: cmdAwaken,
    resume: cmdResume,
    directive: cmdDirective,
    declaredone: cmdDeclareDone,
    spawn: cmdSpawn,
    fork: cmdFork,
    record: cmdRecord,
    state: cmdState,
    debrief: cmdDebrief,
    progress: cmdProgress,
    note: cmdNote,
    alert: cmdAlert,
    verify: cmdVerify,
    integrate: cmdIntegrate,
    claim: cmdClaim,
    release: cmdRelease,
    escalate: cmdEscalate,
    'template:save': cmdTemplateSave,
    'template:list': cmdTemplateList,
    'template:use': cmdTemplateUse,
    wake: cmdWake,
    retire: cmdRetire,
    groom: cmdGroom,
    ls: cmdLs,
    board: cmdBoard,
    boot: cmdBoot,
  };

  const key = (command === 'mission' || command === 'template') ? `${command}:${subcommand}` : command;
  const handler = routes[key];
  if (!handler) {
    console.error(`ghola: unknown command '${argv.join(' ')}'\n`);
    console.log(HELP);
    process.exit(1);
  }
  handler(parsed);
}

try {
  main();
} catch (err) {
  if (err instanceof GholaError) {
    console.error(`ghola: error: ${err.message}`);
  } else {
    console.error(`ghola: unexpected error: ${err && err.stack ? err.stack : err}`);
  }
  process.exit(1);
}
