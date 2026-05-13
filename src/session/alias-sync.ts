import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

/**
 * A single Claude CLI alias registered with Nomeda. The `alias` is the bash
 * alias name (e.g. `claude-1`) and `command` is the shell expansion it points
 * at (e.g. `CLAUDE_CONFIG_DIR=$HOME/.claude command claude`).
 *
 * NOTE: This interface is mirrored in `src/settings-panel/protocol.ts` so the
 * webview can stay isomorphic (no Node imports). If you change the shape here,
 * change it there too.
 */
export interface CliAlias {
  alias: string;
  command: string;
}

const OPEN_MARKER = '# >>> nomeda-managed-aliases >>>';
const CLOSE_MARKER = '# <<< nomeda-managed-aliases <<<';

/**
 * Validate a single alias entry. Returns `null` when valid, otherwise a
 * human-readable error message describing the first violation found.
 *
 * Rules:
 *   - alias name must be non-empty and match `[A-Za-z0-9_-]+` (no whitespace,
 *     no shell metacharacters — those would either break alias parsing or
 *     allow shell injection through the alias name itself).
 *   - command must be non-empty (an empty command is almost certainly a typo
 *     and would silently break the alias).
 */
export function validateAlias(entry: CliAlias): string | null {
  if (!entry || typeof entry.alias !== 'string') {
    return 'Alias entry is missing the alias name.';
  }
  const name = entry.alias.trim();
  if (name === '') {
    return 'Alias name cannot be empty.';
  }
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return `Alias name "${name}" must contain only letters, digits, hyphens, and underscores (no whitespace or shell metacharacters).`;
  }
  if (typeof entry.command !== 'string') {
    return `Alias "${name}" is missing its command.`;
  }
  if (entry.command.trim() === '') {
    return `Alias "${name}" has an empty command.`;
  }
  return null;
}

/**
 * Render the Nomeda-managed alias block. Each entry becomes a single
 * `alias <name>='<command>'` line. Single quotes inside the command are
 * escaped via the standard shell trick: close the quote, emit an escaped
 * literal single quote, reopen the quote (`'\''`).
 */
function renderBlock(aliases: CliAlias[]): string {
  const lines: string[] = [OPEN_MARKER];
  for (const entry of aliases) {
    const escaped = entry.command.replace(/'/g, `'\\''`);
    lines.push(`alias ${entry.alias}='${escaped}'`);
  }
  lines.push(CLOSE_MARKER);
  return lines.join('\n');
}

/**
 * Return `existing` with the Nomeda-managed alias block replaced (if present)
 * or appended (if absent). All content outside the sentinel markers is
 * preserved verbatim — including trailing whitespace and blank lines — so
 * users can hand-edit anything in their rc file that Nomeda does not own.
 */
export function rewriteAliasBlock(existing: string, aliases: CliAlias[]): string {
  const block = renderBlock(aliases);
  const openIdx = existing.indexOf(OPEN_MARKER);
  const closeIdx = existing.indexOf(CLOSE_MARKER);

  if (openIdx !== -1 && closeIdx !== -1 && closeIdx > openIdx) {
    const before = existing.slice(0, openIdx);
    const after = existing.slice(closeIdx + CLOSE_MARKER.length);
    return before + block + after;
  }

  // No (well-formed) markers present — append. Guarantee a newline before the
  // opening marker when the existing file does not already end in one, and a
  // trailing newline after the closing marker.
  if (existing.length === 0) {
    return block + '\n';
  }
  const needsLeadingNewline = !existing.endsWith('\n');
  return existing + (needsLeadingNewline ? '\n' : '') + block + '\n';
}

/** Expand a leading `~` or `~/` to the current user's home directory. */
function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Read `aliasFilePath`, apply `rewriteAliasBlock`, and write the result back.
 * A missing file is treated as an empty string — the file (and any missing
 * parent directories) is created on write. The leading `~` / `~/` in the
 * path is expanded against `os.homedir()`.
 */
export async function syncAliasFile(
  aliasFilePath: string,
  aliases: CliAlias[],
): Promise<void> {
  const resolved = expandHome(aliasFilePath);
  let existing = '';
  try {
    existing = await fs.readFile(resolved, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
    // File does not exist yet — start from empty content.
  }
  const next = rewriteAliasBlock(existing, aliases);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, next, 'utf-8');
}
