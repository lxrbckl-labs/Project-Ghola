// LINQPad connection discovery for the Settings panel.
//
// On a Windows-WSL host LINQPad stores per-user connection definitions in an
// XML file at `%APPDATA%/LINQPad/ConnectionsV2.xml`. This module resolves a
// candidate path (in priority order) and parses the XML into a flat list of
// display-name strings the webview can show in a quick-pick.
//
// Resolution order:
//   1. `override` argument (caller-passed, typically the
//      `ghola.linqpadConnectionsPath` VS Code config value, if non-empty).
//   2. `$APPDATA/LINQPad/ConnectionsV2.xml` — present when VS Code is running
//      under Windows (or under a WSL distro that has APPDATA propagated).
//   3. `/mnt/c/Users/$USER/AppData/Roaming/LINQPad/ConnectionsV2.xml` — the
//      common WSL→Windows mapping when the WSL user matches the Windows
//      profile name.
//   4. Iterate `/mnt/c/Users/*` and accept the first profile that has a
//      readable LINQPad XML.
//   5. Use `wslvar USERPROFILE` to resolve the Windows user profile dir, then
//      join `AppData/Roaming/LINQPad/ConnectionsV2.xml`.
//
// On native macOS/Linux (no `/mnt/c` and no APPDATA), nothing is probed and
// status is reported as `not-installed`.
//
// Parsing strategy:
//   The XML is read as raw text and scanned with regex for `<Server>`,
//   `<Database>`, and `<DisplayName>` element bodies on a per-connection
//   basis. Element bodies may be empty (self-closing) — those connections are
//   skipped if no usable display string can be assembled.
//
// Display-name priority (per locked decisions):
//   server + database  →  "server.database"
//   server only        →  "server"
//   else               →  DisplayName

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

export interface LinqpadResolveResult {
  /** Resolved absolute path. Empty string when nothing was found. */
  path: string;
  /** `ok` when the file exists and is readable; `not-installed` otherwise. */
  status: 'ok' | 'not-installed';
  /** Optional human-readable error explaining why status === 'not-installed'. */
  error?: string;
}

export interface LinqpadReadResult {
  connections: string[];
}

/**
 * Resolve a usable ConnectionsV2.xml path. The first candidate that exists
 * and is readable wins. Returns status='not-installed' with an error message
 * when no candidate succeeds.
 */
export function resolveLinqpadConnectionsPath(
  override?: string,
): LinqpadResolveResult {
  const candidates: string[] = [];

  if (override && override.trim().length > 0) {
    candidates.push(override.trim());
  }

  const appdata = process.env.APPDATA;
  if (appdata && appdata.length > 0) {
    candidates.push(path.join(appdata, 'LINQPad', 'ConnectionsV2.xml'));
  }

  const wslUser = process.env.USER || process.env.LOGNAME;
  if (wslUser) {
    candidates.push(
      path.join('/mnt/c/Users', wslUser, 'AppData', 'Roaming', 'LINQPad', 'ConnectionsV2.xml'),
    );
  }

  // Iterate /mnt/c/Users/* (when present) for any profile that has the file.
  try {
    if (fs.existsSync('/mnt/c/Users')) {
      const entries = fs.readdirSync('/mnt/c/Users', { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        // Skip well-known non-profile directories.
        if (ent.name === 'Public' || ent.name === 'Default' || ent.name.startsWith('Default')) {
          continue;
        }
        candidates.push(
          path.join('/mnt/c/Users', ent.name, 'AppData', 'Roaming', 'LINQPad', 'ConnectionsV2.xml'),
        );
      }
    }
  } catch {
    // Permission errors enumerating /mnt/c/Users — fall through to wslvar.
  }

  // Fallback: `wslvar USERPROFILE` returns a Windows-style path like
  // `C:\Users\name`; convert to `/mnt/c/Users/name` and append the rest.
  try {
    const wslvar = spawnSync('wslvar', ['USERPROFILE'], { encoding: 'utf-8' });
    if (wslvar.status === 0 && typeof wslvar.stdout === 'string') {
      const trimmed = wslvar.stdout.trim();
      if (trimmed.length > 0) {
        const mnt = winPathToMnt(trimmed);
        if (mnt) {
          candidates.push(path.join(mnt, 'AppData', 'Roaming', 'LINQPad', 'ConnectionsV2.xml'));
        }
      }
    }
  } catch {
    // wslvar not on PATH (e.g. native Linux/macOS); ignore.
  }

  // Deduplicate while preserving order.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const c of candidates) {
    if (!seen.has(c)) {
      seen.add(c);
      unique.push(c);
    }
  }

  for (const candidate of unique) {
    try {
      if (fs.existsSync(candidate)) {
        fs.accessSync(candidate, fs.constants.R_OK);
        return { path: candidate, status: 'ok' };
      }
    } catch {
      // Unreadable — keep trying.
    }
  }

  return {
    path: '',
    status: 'not-installed',
    error:
      unique.length === 0
        ? 'No candidate LINQPad ConnectionsV2.xml path could be derived for this host.'
        : `Tried ${unique.length} candidate path(s); none existed or were readable.`,
  };
}

/**
 * Read a ConnectionsV2.xml file and extract connection display strings.
 * Returns an empty list (not an error) if the file parses but contains zero
 * usable entries. Throws on filesystem failure so callers can distinguish.
 */
export function readLinqpadConnections(filePath: string): LinqpadReadResult {
  const raw = fs.readFileSync(filePath, 'utf-8');

  // Match each <Connection> element body. LINQPad nests metadata inside; we
  // only care about Server, Database, and DisplayName.
  const connectionBlocks = raw.match(/<Connection[\s\S]*?<\/Connection>/g) ?? [];

  const out: string[] = [];
  for (const block of connectionBlocks) {
    const server = extractElementText(block, 'Server');
    const database = extractElementText(block, 'Database');
    const displayName = extractElementText(block, 'DisplayName');

    let label: string | undefined;
    if (server && database) {
      label = `${server}.${database}`;
    } else if (server) {
      label = server;
    } else if (displayName) {
      label = displayName;
    }
    if (label) out.push(label);
  }

  // Deduplicate while keeping discovery order.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const v of out) {
    if (!seen.has(v)) {
      seen.add(v);
      unique.push(v);
    }
  }
  return { connections: unique };
}

/** Extract the text body of `<Tag>...</Tag>` inside a chunk. Returns undefined if absent or empty. */
function extractElementText(block: string, tag: string): string | undefined {
  // Skip self-closing form first — `<Tag />` carries no text.
  const selfClosing = new RegExp(`<${tag}\\s*/>`, 'i');
  if (selfClosing.test(block)) return undefined;
  const open = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const m = block.match(open);
  if (!m) return undefined;
  const inner = (m[1] ?? '').trim();
  return inner.length > 0 ? decodeXmlEntities(inner) : undefined;
}

/** Minimal XML entity decode for the subset LINQPad writes. */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** Convert a Windows path like `C:\Users\name` to the WSL mount form. */
function winPathToMnt(winPath: string): string | undefined {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath);
  if (!m) return undefined;
  const drive = m[1]!.toLowerCase();
  const rest = m[2]!.replace(/\\/g, '/');
  return `/mnt/${drive}/${rest}`;
}
