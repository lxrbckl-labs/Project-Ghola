// Host-side auto-discovery of an Obsidian vault directory.
//
// Pure Node (NO `vscode` import) so it stays unit-testable and reusable off the
// extension host. Mirrors `support-discovery.ts`: scan a curated set of
// filesystem roots (depth-capped, noise-pruned) for a directory that contains a
// `.obsidian/` marker. The vault is the PARENT directory of that marker. The
// caller writes the chosen path into the `tool.obsidian-notes` `vaultPath`
// setting.
//
// Discovery MUST never throw to the caller — the whole scan is wrapped so any
// failure degrades to "found nothing" with a short error string.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Outcome of a vault discovery scan. `vaultPath` is the chosen vault (most
 * recently modified when several match, or the sole match), or null when none
 * were found; `candidates` lists every located vault (absolute, deduped);
 * `scanned` is the number of directories visited (for logging/telemetry);
 * `error` is a short message set only when the scan hit an unexpected fault.
 */
export interface VaultDiscoveryResult {
  vaultPath: string | null;
  candidates: string[];
  scanned: number;
  error?: string;
}

/** Depth cap for the recursive walk — vaults sit near the top of these roots. */
const CURATED_DEPTH_CAP = 3;

/** Hard stop for a runaway walk: never visit more than this many directories. */
const VISITED_CAP = 20000;

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

/** True when `dir` contains a `.obsidian` entry (vault root marker). */
function hasObsidianMarker(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, '.obsidian'));
  } catch {
    return false;
  }
}

/** Directory mtime (ms) for recency tie-break; 0 when unreadable. */
function mtimeScore(dir: string): number {
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
  push(path.join(home, 'Documents', 'Obsidian'));
  push(home);
  push(path.join(home, 'Documents'));
  // macOS iCloud Obsidian container.
  push(path.join(home, 'Library', 'Mobile Documents', 'iCloud~md~obsidian', 'Documents'));

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
          push(path.join(usersDir, name, 'Documents', 'Obsidian'));
          push(path.join(usersDir, name, 'Documents'));
        }
      }
    } catch {
      // ignore unreadable Users dir
    }
  }

  // De-dup while preserving order.
  return [...new Set(roots)];
}

/**
 * Discover a local Obsidian vault. Returns a VaultDiscoveryResult; never throws
 * — any fault is captured in `error` with nothing found. Curated roots are
 * walked (depth-capped, noise-pruned); a directory that contains a `.obsidian/`
 * marker is recorded as a candidate vault and is NOT descended into. When
 * several vaults are found, the most-recently-modified wins as `vaultPath`
 * while the full `candidates` list is still returned.
 */
export async function discoverObsidianVault(): Promise<VaultDiscoveryResult> {
  let scanned = 0;

  try {
    const found = new Set<string>();

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
      // A vault marker directly on this dir makes it a vault; do not descend.
      if (hasObsidianMarker(dir)) {
        found.add(path.resolve(dir));
        return;
      }
      for (const ent of entries) {
        if (scanned >= VISITED_CAP) return;
        if (!ent.isDirectory()) continue;
        const name = ent.name;
        if (shouldPrune(name)) continue;
        const child = path.join(dir, name);
        if (depth < CURATED_DEPTH_CAP) {
          await walk(child, depth + 1);
        }
      }
    };

    for (const root of curatedRoots()) {
      if (scanned >= VISITED_CAP) break;
      await walk(root, 0);
    }

    const candidates = [...found];
    if (candidates.length === 0) {
      return { vaultPath: null, candidates: [], scanned };
    }

    // ─── Choose the winner (most-recent mtime wins) ───────────────────────
    let best = candidates[0]!;
    let bestScore = mtimeScore(best);
    for (let i = 1; i < candidates.length; i++) {
      const s = mtimeScore(candidates[i]!);
      if (s > bestScore) {
        bestScore = s;
        best = candidates[i]!;
      }
    }

    return { vaultPath: best, candidates, scanned };
  } catch (err) {
    return {
      vaultPath: null,
      candidates: [],
      scanned,
      error: (err as Error)?.message ?? 'vault discovery failed',
    };
  }
}
