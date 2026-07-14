// Host-side auto-discovery of Support-mode app repo paths.
//
// Pure Node (NO `vscode` import) so it stays unit-testable and reusable off the
// extension host. Mirrors the SWT `deploy.sh` discovery: for each app key, scan
// a curated set of filesystem roots for a directory whose basename matches the
// key (case-insensitive) AND contains a `.git` subdir. The caller writes the
// found paths into the `mode.support` `appMap` setting.
//
// Discovery MUST never throw to the caller — the whole scan is wrapped so any
// failure degrades to "found nothing" with a short error string.

import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Outcome of a discovery scan. `found` maps each located app key to its
 * absolute repo path; `notFound` lists the keys that were requested but not
 * located; `scanned` is the number of directories visited (for logging/telemetry);
 * `error` is a short message set only when the scan hit an unexpected fault.
 */
export interface DiscoveryResult {
  found: Record<string, string>;
  notFound: string[];
  scanned: number;
  error?: string;
}

/** Depth cap for the recursive walk of each curated root. */
const CURATED_DEPTH_CAP = 4;

/** Hard stop for a runaway walk: never visit more than this many directories. */
const VISITED_CAP = 50000;

/**
 * Directory names pruned from the walk (never descended into). Matched
 * case-insensitively; a few are prefix matches (AppData*, Program Files*).
 */
function shouldPrune(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === 'node_modules') return true;
  if (lower === '.git') return true;
  if (lower === 'appdata' || lower.startsWith('appdata')) return true;
  if (name === '$Recycle.Bin' || lower === '$recycle.bin') return true;
  if (lower === 'windows') return true;
  if (lower.startsWith('program files')) return true;
  if (lower === 'system volume information') return true;
  return false;
}

/** True when `dir` contains a `.git` entry (repo root). */
function hasGit(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

/**
 * Return the newest "recency" score for a candidate repo dir: the most-recent
 * commit epoch (seconds) via `git log -1 --format=%ct`, falling back to the
 * directory's mtime (ms) when git is unavailable or errors. Higher wins in a
 * multi-match tie-break. The two scales differ (s vs ms) but each app's
 * candidates are scored consistently within a single scan, so relative ordering
 * holds for the common case; git-scored candidates simply sort together and
 * mtime-scored candidates sort together.
 */
function recencyScore(dir: string): number {
  try {
    const out = execFileSync('git', ['-C', dir, 'log', '-1', '--format=%ct'], {
      timeout: 2000,
      encoding: 'utf8',
    });
    const ct = parseInt(out.trim(), 10);
    if (!Number.isNaN(ct)) return ct;
  } catch {
    // fall through to mtime
  }
  try {
    return fs.statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

/** Curated scan roots that exist on this machine (missing ones skipped). */
function curatedRoots(): string[] {
  const roots: string[] = [];
  const push = (p: string): void => {
    try {
      if (p && fs.existsSync(p)) roots.push(p);
    } catch {
      // ignore unreadable candidate
    }
  };

  const home = os.homedir();
  push(home);
  push(path.join(home, 'projects'));

  // Windows-side roots, only when /mnt/c is mounted (WSL). Never assume it exists.
  const mntC = '/mnt/c';
  let mntCExists = false;
  try {
    mntCExists = fs.existsSync(mntC);
  } catch {
    mntCExists = false;
  }
  if (mntCExists) {
    // Add every non-system user under /mnt/c/Users so we don't hardcode a name.
    const usersDir = path.join(mntC, 'Users');
    try {
      if (fs.existsSync(usersDir)) {
        for (const ent of fs.readdirSync(usersDir, { withFileTypes: true })) {
          if (!ent.isDirectory()) continue;
          const name = ent.name;
          const lower = name.toLowerCase();
          // Skip system / default profiles.
          if (
            lower === 'public' ||
            lower === 'default' ||
            lower === 'default user' ||
            lower === 'all users' ||
            name.startsWith('.')
          ) {
            continue;
          }
          push(path.join(usersDir, name));
        }
      }
    } catch {
      // ignore unreadable Users dir
    }
    push(path.join(mntC, 'dev'));
    push(path.join(mntC, 'Projects'));
    push(path.join(mntC, 'Source'));
  }

  // De-dup while preserving order.
  return [...new Set(roots)];
}

/**
 * Discover local repo paths for the given app keys. Returns a DiscoveryResult;
 * never throws — any fault is captured in `error` with everything reported as
 * not-found. Curated roots are walked (depth-capped) first; app keys still
 * missing after that fall back to a time-boxed `find` over /mnt/c when present.
 */
export async function discoverAppPaths(appKeys: string[]): Promise<DiscoveryResult> {
  const keys = [...new Set(appKeys.filter((k) => typeof k === 'string' && k.trim().length > 0))];
  let scanned = 0;

  try {
    // Per-app candidate lists; we tie-break the winner by recency at the end.
    const candidates = new Map<string, string[]>();
    for (const k of keys) candidates.set(k.toLowerCase(), []);
    const keyByLower = new Map<string, string>();
    for (const k of keys) keyByLower.set(k.toLowerCase(), k);

    // ─── Curated recursive walk (await-based, depth-capped) ───────────────
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (scanned >= VISITED_CAP) return;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      scanned++;
      for (const ent of entries) {
        if (scanned >= VISITED_CAP) return;
        if (!ent.isDirectory()) continue;
        const name = ent.name;
        if (shouldPrune(name)) continue;
        const child = path.join(dir, name);
        const lower = name.toLowerCase();
        const matchKey = candidates.has(lower) ? lower : undefined;
        if (matchKey && hasGit(child)) {
          candidates.get(matchKey)!.push(child);
          // A matched repo is a leaf for our purposes — do not descend into it.
          continue;
        }
        if (depth < CURATED_DEPTH_CAP) {
          await walk(child, depth + 1);
        }
      }
    };

    for (const root of curatedRoots()) {
      if (scanned >= VISITED_CAP) break;
      await walk(root, 0);
    }

    // ─── Fallback: `find` over /mnt/c for keys still unmatched ─────────────
    let mntCExists = false;
    try {
      mntCExists = fs.existsSync('/mnt/c');
    } catch {
      mntCExists = false;
    }
    const stillMissing = keys.filter((k) => candidates.get(k.toLowerCase())!.length === 0);
    if (mntCExists && stillMissing.length > 0) {
      const pruneArgs = [
        '(',
        '-iname', 'node_modules',
        '-o', '-iname', '.git',
        '-o', '-iname', 'AppData*',
        '-o', '-iname', '$Recycle.Bin',
        '-o', '-iname', 'Windows',
        '-o', '-iname', 'Program Files*',
        '-o', '-iname', 'System Volume Information',
        ')', '-prune',
      ];
      for (const key of stillMissing) {
        try {
          const { stdout } = await execFileAsync(
            'find',
            [
              '/mnt/c',
              '-maxdepth', '6',
              ...pruneArgs,
              '-o',
              '-type', 'd', '-iname', key, '-print',
            ],
            { timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
          );
          for (const line of stdout.split('\n')) {
            const dir = line.trim();
            if (!dir) continue;
            if (path.basename(dir).toLowerCase() !== key.toLowerCase()) continue;
            if (hasGit(dir)) candidates.get(key.toLowerCase())!.push(dir);
          }
        } catch {
          // timeout / error / find-missing -> treat as not-found for this app
        }
      }
    }

    // ─── Resolve winners (most-recent commit / mtime wins) ────────────────
    const found: Record<string, string> = {};
    for (const [lower, list] of candidates.entries()) {
      if (list.length === 0) continue;
      const uniq = [...new Set(list)];
      let best = uniq[0]!;
      let bestScore = recencyScore(best);
      for (let i = 1; i < uniq.length; i++) {
        const s = recencyScore(uniq[i]!);
        if (s > bestScore) {
          bestScore = s;
          best = uniq[i]!;
        }
      }
      found[keyByLower.get(lower) ?? lower] = best;
    }

    const notFound = keys.filter((k) => !(k in found));
    return { found, notFound, scanned };
  } catch (err) {
    return {
      found: {},
      notFound: keys,
      scanned,
      error: (err as Error)?.message ?? 'discovery failed',
    };
  }
}
