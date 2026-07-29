import * as childProcess from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * A single Claude CLI alias registered with Ghola. The `alias` is the bash
 * alias name (e.g. `claude-1`) and `command` is the shell expansion it points
 * at (e.g. `CLAUDE_CONFIG_DIR=$HOME/.claude command claude`).
 *
 * The stored `command` is BASH-CANONICAL — that is the one authoring format,
 * on every platform. Non-bash hosts do not receive it verbatim; it is parsed
 * into a structured {envVars, binary, args} shape (see `parseBashCommand`) and
 * re-rendered into the host's own syntax. A command that does not match the
 * recognized shape is NOT guessed at: it is skipped with a named warning.
 *
 * NOTE: This interface is mirrored in `src/settings-panel/protocol.ts` so the
 * webview can stay isomorphic (no Node imports). If you change the shape here,
 * change it there too.
 */
export interface CliAlias {
  alias: string;
  command: string;
}

const OPEN_MARKER = '# >>> ghola-managed-aliases >>>';
const CLOSE_MARKER = '# <<< ghola-managed-aliases <<<';

/**
 * Sentinels written by builds from before the Project-Nomeda -> Project-Ghola
 * rename. A file carrying these is ADOPTED — the block is rewritten in place
 * with the current markers — rather than left orphaned while a second block is
 * appended below it. `#` is a comment in bash AND in PowerShell, so a single
 * marker pair serves both flavors.
 */
const LEGACY_OPEN_MARKER = '# >>> nomeda-managed-aliases >>>';
const LEGACY_CLOSE_MARKER = '# <<< nomeda-managed-aliases <<<';

/** Which shell dialect the managed block was rendered in. */
export type AliasFlavor = 'bash' | 'powershell';

/**
 * Outcome of one `syncAliasFile` run. `warnings` are actionable problems the
 * operator must see (a skipped alias, an unresolvable profile path); `notes`
 * are notable-but-fine events (a legacy block adopted, blocks consolidated,
 * the Windows target substituted). Both are surfaced as VS Code notifications
 * by `syncAliasFile` itself and returned here so a caller can also render them
 * in the settings panel.
 */
export interface AliasSyncResult {
  /** Absolute path of the file that was written. */
  file: string;
  /** Dialect the block was rendered in — decided by the host platform. */
  flavor: AliasFlavor;
  /** Alias names that made it into the managed block. */
  emitted: string[];
  /** Alias names deliberately omitted because their command could not be translated. */
  skipped: string[];
  warnings: string[];
  notes: string[];
}

/**
 * A bash-canonical simple command broken into its parts. `envVars` are the
 * leading `VAR=value` assignments, `binary` is the bare command name, and
 * `args` are the fixed arguments that follow it.
 */
export interface ParsedCommand {
  envVars: Array<{ name: string; value: string }>;
  binary: string;
  args: string[];
}

/**
 * Shell metacharacters that put a command outside the recognized simple-command
 * shape. Any of these means the stored string does something (piping,
 * chaining, substituting, redirecting, globbing) that cannot be mechanically
 * translated, so translation is refused rather than guessed at.
 */
const SHELL_METACHARS = /[|&;<>()`\\*?{}\n\r]/;

/**
 * Command names that take their own `VAR=value` / nested-command arguments.
 * Treating one of these as the binary would silently drop the real invocation,
 * so they are refused outright.
 */
const UNSUPPORTED_WRAPPERS = new Set(['env', 'exec', 'eval', 'sudo', 'nohup', 'time', 'builtin']);

/**
 * Validate a single alias entry. Returns `null` when valid, otherwise a
 * human-readable error message describing the first violation found.
 *
 * Rules:
 *   - alias name must be non-empty and match `[A-Za-z0-9_][A-Za-z0-9_-]*`
 *     (no whitespace, no shell metacharacters — those would either break
 *     alias parsing or allow shell injection through the alias name itself —
 *     and no LEADING hyphen, see below).
 *   - command must be non-empty (an empty command is almost certainly a typo
 *     and would silently break the alias).
 *
 * Deliberately SYNTACTIC only, and deliberately platform-independent: the
 * registry is authored once and consumed on every platform, so an entry that a
 * non-bash host cannot render (e.g. an alias literally named "123", which is a
 * legal bash alias name but an illegal PowerShell function name) is still a
 * valid entry here — rejecting it at save time would block a WSL/bash operator
 * from saving a name that works fine on the platform they actually use.
 * `renderPowerShellBlock` enforces the additional PowerShell-identifier rule
 * itself and SKIPS (with a named warning) any entry that fails it, rather than
 * this function rejecting it up front.
 *
 * The one exception is a LEADING HYPHEN, which this function does reject
 * outright rather than leaving to a platform-specific renderer: bash's `alias`
 * builtin parses its argument list getopt-style, so `alias -x='...'` is read
 * as an attempt to pass the (nonexistent) `-x` OPTION to `alias` itself, not
 * as a `name=value` pair — confirmed empirically: `alias -x=1` fails with
 * "bash: alias: -x: invalid option" every time the rc file is sourced, even
 * though `-x` matches the pre-existing `[A-Za-z0-9_-]+` shape. This is a
 * bash-side breakage, not a rendering limitation the PowerShell path could
 * paper over, so it belongs in this platform-neutral validator rather than in
 * `renderPowerShellBlock`. A purely NUMERIC name (`123`) is deliberately still
 * accepted: unlike PowerShell (which parses `123` as a numeric literal token
 * and throws a parser error for the whole profile), bash's alias mechanism is
 * a lexical substitution on the first word of a simple command with no
 * identifier restriction, and `alias 123='...'` plus invoking `123` was
 * verified to work with no error. Tightening bash's rule to PowerShell's would
 * reject entries bash handles fine, so the line is drawn at "no leading
 * hyphen" and nothing more.
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
  if (name.startsWith('-')) {
    return `Alias name "${name}" cannot start with a hyphen: bash's "alias" builtin reads a leading-hyphen name as an option rather than a name=value pair, which fails every time your rc file is sourced. Rename it to start with a letter, digit, or underscore.`;
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
 * Split a bash-canonical simple command into whitespace-separated tokens,
 * resolving single and double quotes. Returns `null` when the input leaves the
 * recognized shape — an unterminated quote, a backslash escape, or any shell
 * metacharacter.
 */
function tokenize(input: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  for (const ch of input) {
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      // A backslash inside double quotes is an escape; refuse rather than
      // mis-render it.
      if (ch === '\\') return null;
      if (ch === '"') quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    if (SHELL_METACHARS.test(ch)) return null;
    current += ch;
    started = true;
  }
  if (quote !== null) return null;
  if (started) tokens.push(current);
  return tokens;
}

/**
 * Parse a bash-canonical simple command into {envVars, binary, args}.
 * Recognized shape:
 *
 *     [VAR=value ...] [command ] BINARY [arg ...]
 *
 * `${HOME}` is normalized to `$HOME` up front so the two spellings behave
 * identically. Returns `null` for anything outside the shape — the caller must
 * then skip the alias and warn, never fall back to emitting the raw string.
 */
export function parseBashCommand(command: string): ParsedCommand | null {
  const normalized = command.trim().replace(/\$\{HOME\}/g, () => '$HOME');
  const tokens = tokenize(normalized);
  if (!tokens || tokens.length === 0) return null;

  const envVars: Array<{ name: string; value: string }> = [];
  let index = 0;
  for (; index < tokens.length; index++) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(tokens[index]!);
    if (!match) break;
    envVars.push({ name: match[1]!, value: match[2]! });
  }

  // bash's `command` builtin is how the default registry entry avoids alias
  // recursion (`alias claude='... command claude'`). It carries no meaning
  // outside bash, so consume it here and let each renderer solve recursion its
  // own way.
  if (tokens[index] === 'command') index++;

  const binary = tokens[index];
  if (!binary) return null;
  if (UNSUPPORTED_WRAPPERS.has(binary)) return null;
  // Bare command name only. A stored absolute path is a bash-side path that
  // means nothing on another platform, so refuse it rather than translate it.
  if (!/^[A-Za-z0-9_.+-]+$/.test(binary)) return null;

  return { envVars, binary, args: tokens.slice(index + 1) };
}

/**
 * Render one parsed value as a PowerShell double-quoted string.
 *
 * `$HOME` (and the already-normalized `${HOME}`, and a leading `~`) becomes
 * PowerShell's own `${HOME}` automatic variable — the delimited spelling, so
 * the following character can never be swallowed into the variable name. Every
 * OTHER `$`, backtick, or double quote is refused: expanding an unknown bash
 * variable in PowerShell yields the empty string, which is exactly the kind of
 * silent wrongness this whole path exists to avoid.
 */
function toPowerShellString(value: string): string | null {
  const withHome = value === '~' || value.startsWith('~/') ? `$HOME${value.slice(1)}` : value;
  const parts = withHome.split('$HOME');
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (/[$`"]/.test(part)) return null;
    // `$HOMEFOO` is bash for the variable HOMEFOO, not `$HOME` + "FOO" — an
    // identifier character straight after the split point means we misread it.
    if (i > 0 && /^[A-Za-z0-9_]/.test(part)) return null;
  }
  return `"${parts.join('${HOME}')}"`;
}

/**
 * Render the Ghola-managed alias block for bash. Each entry becomes a single
 * `alias <name>='<command>'` line. Single quotes inside the command are
 * escaped via the standard shell trick: close the quote, emit an escaped
 * literal single quote, reopen the quote (`'\''`).
 */
function renderBashBlock(aliases: CliAlias[]): string {
  const lines: string[] = [OPEN_MARKER];
  for (const entry of aliases) {
    const escaped = entry.command.replace(/'/g, `'\\''`);
    lines.push(`alias ${entry.alias}='${escaped}'`);
  }
  lines.push(CLOSE_MARKER);
  return lines.join('\n');
}

/**
 * Safe PowerShell function names, out of the wider charset `validateAlias`
 * already allows (`[A-Za-z0-9_-]+`, chosen to be bash-permissive).
 *
 * PowerShell parses an entire script into an AST before executing any of it,
 * so a function name the parser instead reads as a numeric literal (`123`,
 * `1e5`, `0x1F`) or an operator/parameter token (`-x`) does not just fail to
 * define THAT one alias — it throws a ParserError for the whole profile file,
 * silently disabling every other alias in the managed block plus anything the
 * operator hand-wrote outside it.
 *
 * PowerShell numeric literals and unary/binary operators always begin with a
 * digit or a hyphen, so requiring the first character to be a letter or
 * underscore rules out every one of those ambiguous tokens at once, without
 * having to special-case scientific notation or hex prefixes individually.
 * Anything not matching this pattern is rejected outright rather than
 * guessed at or auto-renamed.
 */
const POWERSHELL_FUNCTION_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * The escape hatch offered by every "Ghola cannot render this alias" message,
 * worded ONCE so the writer side and the pre-flight side cannot drift apart.
 *
 * A hand-written definition has to live OUTSIDE the managed block, because every
 * sync rewrites everything between the sentinels. That is why the launcher's
 * pre-flight scans the WHOLE profile (`readDefinedAliasNames`) rather than only
 * the managed spans: the previous managed-spans-only scan could not see a
 * definition placed where this very advice told the operator to put it, so
 * following our own advice earned a false "press Save" warning on every launch.
 */
function handDefineAdvice(alias: string): string {
  return `Alternatively, define ${alias} as a PowerShell function by hand in your profile, OUTSIDE Ghola's managed block — Ghola rewrites everything between the sentinel markers on every sync, so a definition inside them would be overwritten. Ghola's launch pre-flight reads your whole profile, so a hand-written definition satisfies it.`;
}

/**
 * One registry entry's PowerShell rendering, or the reason it has none. The
 * `reason` is a sentence fragment meant to follow a colon, so each caller can
 * frame it for its own context.
 */
type PowerShellAliasPlan =
  | { ok: true; binary: string; env: string[]; args: string[] }
  | { ok: false; reason: string };

/**
 * Decide whether `entry` can be rendered into the managed PowerShell block, and
 * if so pre-render its env and argument fragments.
 *
 * This is deliberately the SINGLE decision site for "can Ghola write this
 * alias". `renderPowerShellBlock` uses it to skip-and-warn at write time;
 * `SessionLauncher.checkCliCommandResolvable` uses it (through
 * `powerShellSkipReason`) at launch time to decide whether "press Save" is
 * honest advice. When those two answers were computed separately they disagreed:
 * the pre-flight told operators to press Save for an alias the writer had
 * deliberately refused to emit, which Save could never fix.
 */
function planPowerShellAlias(entry: CliAlias): PowerShellAliasPlan {
  // An entry can reach here UNVALIDATED. The writer path is gated by the
  // settings panel's `validateAlias` call, but the launcher's pre-flight reads
  // `ghola.cliAliases` straight out of VS Code settings, which an operator can
  // hand-edit past that gate. Re-run the validator so a malformed entry yields a
  // reason instead of throwing inside `parseBashCommand` — this function must be
  // total, because the pre-flight that calls it promises never to throw.
  const invalid = validateAlias(entry);
  if (invalid !== null) {
    return { ok: false, reason: `${invalid} Fix the entry in Ghola's CLI Aliases list.` };
  }
  if (!POWERSHELL_FUNCTION_NAME.test(entry.alias)) {
    return {
      ok: false,
      reason: `its name is not a safe PowerShell function name (PowerShell would parse it as a number or an operator, which throws a parse error for your ENTIRE profile, not just this alias). Rename it to start with a letter or underscore. ${handDefineAdvice(entry.alias)}`,
    };
  }
  const parsed = parseBashCommand(entry.command);
  if (!parsed) {
    return {
      ok: false,
      reason: `its command (${entry.command}) is not a plain "VAR=value ... command binary args" line, and Ghola will not guess at a translation. Simplify it to that shape. ${handDefineAdvice(entry.alias)}`,
    };
  }
  const untranslatableExpansion = `its command (${entry.command}) expands a shell variable other than $HOME, which PowerShell would silently expand to nothing. Only $HOME (or a leading ~) can be translated. ${handDefineAdvice(entry.alias)}`;
  const env: string[] = [];
  for (const variable of parsed.envVars) {
    const value = toPowerShellString(variable.value);
    if (value === null) return { ok: false, reason: untranslatableExpansion };
    // Four-space indent: these lines are emitted INSIDE the function's `try`.
    env.push(`    $gholaSaved['${variable.name}'] = $env:${variable.name}`);
    env.push(`    $env:${variable.name} = ${value}`);
  }
  const args: string[] = [];
  for (const arg of parsed.args) {
    const value = toPowerShellString(arg);
    if (value === null) return { ok: false, reason: untranslatableExpansion };
    args.push(value);
  }
  return { ok: true, binary: parsed.binary, env, args };
}

/**
 * Why the managed PowerShell block cannot carry `entry`, or `null` when it can.
 * The launcher's win32 pre-flight uses this so a warning about an unresolvable
 * alias names a remedy that can actually work — see `planPowerShellAlias`.
 */
export function powerShellSkipReason(entry: CliAlias): string | null {
  const plan = planPowerShellAlias(entry);
  return plan.ok ? null : plan.reason;
}

/**
 * Render the Ghola-managed alias block for PowerShell. Each entry becomes a
 * function, because that is the construct the launcher's pwsh shell can
 * actually invoke — a PowerShell `alias` cannot carry environment assignments
 * or arguments, so it could not express a registry entry at all.
 *
 * Each function:
 *   - snapshots every environment variable it is about to set and restores the
 *     snapshot in `finally`, so a session never leaks CLAUDE_CONFIG_DIR into
 *     the operator's interactive shell (there is no function-scoped `$env:`).
 *     The snapshot-and-set pairs are emitted INSIDE the `try`, so a throw or a
 *     Ctrl+C landing part-way through them still reaches the `finally` and still
 *     rolls back the variables already changed. (Outside the `try` — the earlier
 *     shape — an interrupt between two `$env:` assignments stranded a
 *     half-mutated environment in the operator's interactive shell with nothing
 *     left to restore it.) Recording each variable's old value BEFORE
 *     overwriting it is what makes the partial case safe: the worst outcome is
 *     restoring a variable to the value it already had;
 *   - restores each key under its OWN `try`/`catch` inside the `finally` loop,
 *     so one key that cannot be written (an oversized value, a policy-blocked
 *     name) cannot abandon the keys after it — the earlier single-statement loop
 *     would have left the rest of the environment permanently mutated;
 *   - resolves the binary with `Get-Command -CommandType Application`, which
 *     skips functions and aliases. That is the PowerShell equivalent of bash's
 *     `command` builtin and is what keeps `function claude { ... claude }` from
 *     recursing infinitely;
 *   - splats `@args` so flags the launcher appends (e.g.
 *     `--dangerously-skip-permissions`) and the trigger word reach the binary.
 *
 * An entry `planPowerShellAlias` refuses is omitted and named in `warnings`,
 * with that function's reason as the explanation.
 */
function renderPowerShellBlock(aliases: CliAlias[]): {
  text: string;
  emitted: string[];
  skipped: string[];
  warnings: string[];
} {
  const lines: string[] = [OPEN_MARKER];
  const emitted: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];

  for (const entry of aliases) {
    const plan = planPowerShellAlias(entry);
    if (!plan.ok) {
      skipped.push(entry.alias);
      warnings.push(
        `Alias "${entry.alias}" was NOT written to your PowerShell profile: ${plan.reason}`,
      );
      continue;
    }

    const invocation = ['& $gholaExe', ...plan.args, '@args'].join(' ');
    lines.push(`function ${entry.alias} {`);
    // Declared before the `try` so the `finally` can always see it, whatever
    // threw inside.
    lines.push('  $gholaSaved = @{}');
    lines.push('  try {');
    lines.push(...plan.env);
    lines.push(
      `    $gholaExe = (Get-Command '${plan.binary}' -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source`,
    );
    lines.push(`    ${invocation}`);
    lines.push('  }');
    lines.push('  finally {');
    lines.push('    foreach ($gholaKey in $gholaSaved.Keys) {');
    lines.push(
      "      try { [Environment]::SetEnvironmentVariable($gholaKey, $gholaSaved[$gholaKey], 'Process') }",
    );
    lines.push(
      '      catch { Write-Warning "Ghola could not restore the environment variable $gholaKey" }',
    );
    lines.push('    }');
    lines.push('  }');
    lines.push('}');
    emitted.push(entry.alias);
  }

  lines.push(CLOSE_MARKER);
  return { text: lines.join('\n'), emitted, skipped, warnings };
}

/** A managed block found in the target file, as a `[start, end)` character span. */
interface ManagedSpan {
  start: number;
  end: number;
  legacy: boolean;
  /**
   * True for an ORPHANED OPENING MARKER — an opening sentinel with no closing
   * sentinel anywhere after it. The span then covers the marker text and NOTHING
   * else (`end === start + marker.length`), which is what makes handling it
   * incapable of destroying operator content. See `findManagedSpans`.
   */
  orphan: boolean;
}

/**
 * Every managed block in `existing`, current and legacy, in file order. A marker
 * pair counts when the closing marker appears AFTER its opening marker.
 *
 * AN OPENING MARKER WITH NO CLOSING MARKER AFTER IT IS NOT IGNORED — it is
 * reported as a ZERO-BODY span (`orphan: true`) covering the marker text alone.
 * That is the fix for a real content-loss path, and the choice of semantics is
 * the whole point, so it is written down here:
 *
 *   - IGNORING a half-pair (the previous behavior) is only safe until the next
 *     sync. With no well-formed pair to rewrite, `mergeManagedBlock` APPENDS a
 *     fresh block; on the SECOND sync the orphaned opening marker pairs with the
 *     NEW block's closing marker, and every line in between — the operator's
 *     hand-written aliases AND the block Ghola just wrote — falls inside one
 *     "managed" span and is replaced. `pre / OPEN / X / USER` loses `X` and
 *     `USER` on sync two. So "leave it strictly alone" cannot be right: the
 *     marker is a live landmine, and the file is not idempotent while it sits
 *     there.
 *   - Treating it as an UNTERMINATED BLOCK is right, but only if the block is
 *     closed at ZERO LENGTH. Ghola cannot know where the operator's half-deleted
 *     block ended, and every guess that claims bytes after the marker — to the
 *     end of the file, to the next blank line, to the last alias-looking line —
 *     can delete something the operator wrote. Claiming nothing cannot. So the
 *     span is the marker text and nothing more: the marker (Ghola's OWN sentinel,
 *     never operator content) is consumed, and every byte after it survives
 *     verbatim.
 *
 * The consequence is stated plainly in the note `mergeManagedBlock` emits: alias
 * lines Ghola wrote under the half-deleted marker are left BEHIND the new block
 * as ordinary text, where bash will still source them. That is deliberate. A
 * stale alias line the operator can see and delete is strictly better than
 * silently deleting a line they wrote, and it is the only way to keep the
 * zero-content-loss promise on a file whose true block boundary is unknowable.
 *
 * The returned spans are guaranteed DISJOINT, in ascending `start` order. The
 * two marker families are searched independently, so a hand-edited or
 * hand-migrated file can pair a legacy `nomeda` block that NESTS inside — or
 * STRADDLES the boundary of — a current `ghola` block. Whichever pair opens
 * first wins, and any pair overlapping it is dropped:
 *
 *   - a NESTED inner pair is just part of the outer block's body. Ghola owns
 *     that text and replaces it wholesale, so there is nothing left to remove
 *     separately.
 *   - a STRADDLING pair has no coherent "remove only this block" meaning at
 *     all: cutting it out would take the surviving block's own closing marker
 *     with it, leaving a half-pair behind.
 *
 * An orphan span participates in the same overlap filter, and being zero-body it
 * can only ever be dropped BY a real pair that encloses it, never the reverse —
 * an opening marker sitting inside another family's block is that block's body,
 * which Ghola replaces wholesale anyway.
 *
 * `mergeManagedBlock` DEPENDS on the disjointness guarantee — it walks the spans
 * in order and splices each one using its ORIGINAL character offsets, which is
 * only sound while the spans do not overlap.
 */
function findManagedSpans(existing: string): ManagedSpan[] {
  const families: Array<{ open: string; close: string; legacy: boolean }> = [
    { open: OPEN_MARKER, close: CLOSE_MARKER, legacy: false },
    { open: LEGACY_OPEN_MARKER, close: LEGACY_CLOSE_MARKER, legacy: true },
  ];
  const spans: ManagedSpan[] = [];
  for (const family of families) {
    let from = 0;
    for (;;) {
      const openIdx = existing.indexOf(family.open, from);
      if (openIdx === -1) break;
      const afterOpen = openIdx + family.open.length;
      const closeIdx = existing.indexOf(family.close, afterOpen);
      if (closeIdx === -1) {
        // Unterminated opening marker: no closing marker anywhere after it. Claim
        // the marker text and not one byte more (see the semantics note above),
        // then keep scanning — `indexOf` searched forward, so every remaining
        // opening marker of this family is unterminated too, and each one is its
        // own landmine to defuse.
        spans.push({ start: openIdx, end: afterOpen, legacy: family.legacy, orphan: true });
        from = afterOpen;
        continue;
      }
      const end = closeIdx + family.close.length;
      spans.push({ start: openIdx, end, legacy: family.legacy, orphan: false });
      from = end;
    }
  }
  spans.sort((a, b) => a.start - b.start);

  // Outermost-wins overlap filter. The list is sorted by `start` and every
  // ACCEPTED span ends at or before the next accepted span's start, so testing
  // each candidate against the last accepted span alone is enough to reject
  // every overlap — a candidate that clears the last accepted span cannot
  // overlap an earlier one.
  const disjoint: ManagedSpan[] = [];
  for (const span of spans) {
    const previous = disjoint[disjoint.length - 1];
    if (previous && span.start < previous.end) continue;
    disjoint.push(span);
  }
  return disjoint;
}

/**
 * Return `existing` with `block` installed as the one and only Ghola-managed
 * block. All content outside the sentinel markers is preserved verbatim —
 * including trailing whitespace and blank lines — so users can hand-edit
 * anything in their rc file that Ghola does not own.
 *
 * The FIRST WELL-FORMED managed block found (current or legacy) is rewritten in
 * place, so the block keeps the position the operator's file already gave it. Any
 * further managed block is a duplicate and its text is removed, which is what
 * makes a legacy block get adopted rather than orphaned, and what makes a second
 * run idempotent instead of stacking blocks.
 *
 * ORPHANED OPENING MARKERS (`orphan` spans — see `findManagedSpans`) are removed
 * on exactly the same footing as a duplicate, and only ONE of them is ever
 * promoted to `keep`: the case where the file has no well-formed block at all, so
 * the half-pair is the only thing marking where the block used to live. Preferring
 * a well-formed span over an orphan is what keeps the "block stays where the
 * operator's file put it" promise on a file that carries both. Because an orphan
 * span is zero-body, removing or rewriting one only ever consumes the marker text
 * itself — never a byte the operator wrote.
 *
 * WHY THE SPLICE IS ONE FORWARD WALK rather than back-to-front removals plus a
 * final substitution: `keep` is no longer guaranteed to be `spans[0]`, so a
 * removal can land BEFORE it, and any scheme that mixes already-shifted text with
 * `keep`'s ORIGINAL offsets would slice at the wrong place and silently destroy
 * operator content. Walking the disjoint spans in ascending order and copying the
 * gaps between them uses each original offset exactly once, against the original
 * string, so no offset is ever stale.
 *
 * "Outside the sentinel markers" means outside the DISJOINT spans
 * `findManagedSpans` returns. That distinction is what keeps the preservation
 * promise honest on a hand-edited file whose legacy and current marker pairs
 * nest or interleave: the overlap filter resolves each region to one outermost
 * span, and text beyond the block being rewritten — up to and including the
 * now-orphaned half of an overlapping legacy pair — survives verbatim.
 */
function mergeManagedBlock(existing: string, block: string): { text: string; notes: string[] } {
  const notes: string[] = [];
  const spans = findManagedSpans(existing);

  if (spans.length === 0) {
    // No (well-formed) markers present — append. Guarantee a newline before the
    // opening marker when the existing file does not already end in one, and a
    // trailing newline after the closing marker.
    if (existing.length === 0) {
      return { text: block + '\n', notes };
    }
    const needsLeadingNewline = !existing.endsWith('\n');
    return { text: existing + (needsLeadingNewline ? '\n' : '') + block + '\n', notes };
  }

  // A well-formed block wins `keep` over an orphaned marker wherever the file has
  // one, so the block does not migrate to wherever a half-deleted marker happens
  // to sit. With no well-formed block anywhere, the first orphan is the best
  // available record of where the block used to live, so it becomes `keep`.
  const blocks = spans.filter((span) => !span.orphan);
  const keep = blocks[0] ?? spans[0]!;
  const orphans = spans.filter((span) => span.orphan);
  const duplicates = blocks.filter((span) => span !== keep);
  if (keep.legacy && !keep.orphan) {
    notes.push(
      'Adopted the legacy "nomeda-managed-aliases" block already in this file and re-marked it with the current "ghola-managed-aliases" sentinels.',
    );
  }
  if (duplicates.length > 0) {
    const legacyExtras = duplicates.filter((span) => span.legacy).length;
    notes.push(
      `Consolidated ${blocks.length} Ghola-managed alias blocks into one, removing ${duplicates.length} duplicate${duplicates.length === 1 ? '' : 's'}${legacyExtras > 0 ? ` (${legacyExtras} of them legacy "nomeda-managed-aliases")` : ''}.`,
    );
  }
  if (orphans.length > 0) {
    notes.push(
      `Repaired ${orphans.length} unterminated Ghola alias marker${orphans.length === 1 ? '' : 's'} in this file (an opening sentinel with no matching closing sentinel, usually a half-finished hand edit). Left alone it would have paired with the NEXT sync's closing sentinel and swallowed everything in between. Nothing that followed the marker was removed, so if Ghola-written alias lines were stranded under it they are still in the file BELOW the managed block, where they would override it — delete those by hand.`,
    );
  }

  // ONE FORWARD WALK over the disjoint, ascending spans: copy the gap before each
  // span, then emit the replacement block for `keep` and nothing for every other
  // span. Every offset used is an ORIGINAL offset read against `existing`, which
  // is what makes this correct now that `keep` may sit AFTER a span being removed
  // (see the header note) — the earlier back-to-front removal plus a final
  // `text.slice(keep.end)` mixed shifted text with original offsets and would
  // slice into real operator content.
  //
  // Probing `existing` for the trailing newline of a removed span is the same
  // reason: `end` is an original offset, so the original string is the one that
  // can answer "was this span followed by a newline in the file we read".
  let text = '';
  let cursor = 0;
  for (const span of spans) {
    text += existing.slice(cursor, span.start);
    if (span === keep) {
      text += block;
      cursor = span.end;
      continue;
    }
    let end = span.end;
    if (existing[end] === '\n') end += 1;
    cursor = end;
  }
  return { text: text + existing.slice(cursor), notes };
}

/**
 * Return `existing` with the bash-flavored Ghola-managed alias block replaced
 * (if present) or appended (if absent). Kept as the bash-only entry point; the
 * platform decision lives in `syncAliasFile`.
 */
export function rewriteAliasBlock(existing: string, aliases: CliAlias[]): string {
  return mergeManagedBlock(existing, renderBashBlock(aliases)).text;
}

/** Expand a leading `~` or `~/` to the current user's home directory. */
function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Memoized answer from `queryPowerShellProfile`. `undefined` = not asked yet,
 * `null` = asked and no shell answered.
 */
let cachedProfilePath: string | null | undefined;

/**
 * Ask PowerShell itself where its CurrentUserAllHosts profile lives, rather
 * than guessing at `Documents\PowerShell\profile.ps1`. Only PowerShell knows
 * the answer: the Documents folder is a redirectable known folder (OneDrive
 * moves it), and pwsh 7 and Windows PowerShell 5.1 use different subdirectories.
 *
 * Candidate order matches `SessionLauncher.pickShell()` — pwsh.exe first, then
 * powershell.exe — so the file written here is the profile of the shell the
 * session will actually be launched in. Returns `null` when neither answers.
 */
function queryPowerShellProfile(): string | null {
  if (cachedProfilePath !== undefined) return cachedProfilePath;
  cachedProfilePath = null;
  for (const shell of ['pwsh.exe', 'powershell.exe']) {
    try {
      const result = childProcess.spawnSync(
        shell,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PROFILE.CurrentUserAllHosts'],
        { encoding: 'utf8' },
      );
      if (result.status === 0 && typeof result.stdout === 'string') {
        const answer = result.stdout.trim();
        if (answer !== '') {
          cachedProfilePath = answer;
          break;
        }
      }
    } catch {
      // Shell not installed or not on PATH — try the next candidate.
    }
  }
  return cachedProfilePath;
}

/**
 * Decide which file the managed block goes into on a Windows host.
 *
 * `ghola.aliasFile` defaults to `~/.bashrc`, which on native Windows is a file
 * nothing ever sources — writing there is the whole reason `claude-2` came back
 * as CommandNotFoundException. So: honor the setting when the operator has
 * pointed it at a `.ps1` file, otherwise substitute the real PowerShell profile
 * and say so.
 */
function resolvePowerShellAliasFile(configured: string): {
  file: string;
  warnings: string[];
  notes: string[];
} {
  const warnings: string[] = [];
  const notes: string[] = [];
  const trimmed = configured.trim();
  if (/\.ps1$/i.test(trimmed)) {
    return { file: expandHome(trimmed), warnings, notes };
  }
  const profile = queryPowerShellProfile();
  if (profile !== null) {
    notes.push(
      `Windows host: ghola.aliasFile ("${trimmed}") is a bash rc path that PowerShell never reads, so the managed block went to your PowerShell profile instead (${profile}). Set ghola.aliasFile to a .ps1 path to choose a different file.`,
    );
    return { file: profile, warnings, notes };
  }
  const fallback = path.join(os.homedir(), 'Documents', 'PowerShell', 'profile.ps1');
  warnings.push(
    `Neither pwsh.exe nor powershell.exe answered when asked for its profile path, so the managed alias block was written to ${fallback}. If your PowerShell profile is somewhere else, set ghola.aliasFile to that .ps1 path and save again.`,
  );
  return { file: fallback, warnings, notes };
}

/**
 * Resolve the file the managed block lives in for THIS host: the configured
 * path on bash platforms, the PowerShell profile on win32.
 */
function resolveAliasFile(aliasFilePath: string): { file: string; warnings: string[]; notes: string[] } {
  if (os.platform() === 'win32') {
    return resolvePowerShellAliasFile(aliasFilePath);
  }
  return { file: expandHome(aliasFilePath), warnings: [], notes: [] };
}

/**
 * Alias names the host's alias file DEFINES — anywhere in it. Used by the
 * launcher as its Windows pre-flight check: a PowerShell function exists only if
 * the profile defines it, so this is a real answer rather than a guess. Returns
 * `[]` when the file is missing or unreadable — never throws, so a pre-flight
 * can never break a launch.
 *
 * Scanning the WHOLE file rather than only `findManagedSpans`'s spans is the
 * point, not an oversight. `planPowerShellAlias` refuses to render some entries
 * and tells the operator (via `handDefineAdvice`) to define that name by hand
 * outside the managed block — the only place a hand-written definition survives
 * a sync. A managed-spans-only scan structurally could not see that definition,
 * so an operator who followed Ghola's own advice was told, on every single
 * launch, to "press Save on the CLI Aliases list" — which would never write the
 * alias, because Ghola had deliberately refused to render it. The question the
 * pre-flight actually asks is "will this shell resolve this name from this
 * file", and the answer does not depend on which side of the sentinels the
 * definition sits on.
 *
 * Recognized definition forms: bash `alias name=`, PowerShell `function name`
 * (brace on the same line or the next), and PowerShell `Set-Alias`/`New-Alias`.
 * Matching is case-insensitive because PowerShell keywords and cmdlet names are,
 * and leading indentation is allowed because a hand-written definition may be
 * nested inside an `if`. Over-matching here only ever SUPPRESSES a warning,
 * which is the same fail-open direction the rest of this pre-flight takes (see
 * `SessionLauncher.isOnWindowsPath`): a warning the operator cannot act on is
 * worse than a missing one.
 */
export async function readDefinedAliasNames(aliasFilePath: string): Promise<string[]> {
  const resolved = resolveAliasFile(aliasFilePath).file;
  let existing = '';
  try {
    existing = await fs.readFile(resolved, 'utf-8');
  } catch {
    return [];
  }
  const names: string[] = [];
  const definition =
    /^[ \t]*(?:alias[ \t]+([A-Za-z0-9_-]+)=|function[ \t]+([A-Za-z0-9_-]+)[ \t]*(?:\{|$)|(?:Set-Alias|New-Alias)[ \t]+(?:-Name[ \t]+)?['"]?([A-Za-z0-9_-]+)['"]?)/gim;
  for (const match of existing.matchAll(definition)) {
    const name = match[1] ?? match[2] ?? match[3];
    if (name) names.push(name);
  }
  return names;
}

/**
 * Read the host's alias file, install the Ghola-managed block for `aliases` in
 * the dialect that host's shell understands, and write the result back. A
 * missing file is treated as an empty string — the file (and any missing
 * parent directories) is created on write. The leading `~` / `~/` in the path
 * is expanded against `os.homedir()`.
 *
 * Platform split: only `os.platform() === 'win32'` takes the PowerShell path.
 * Every other host (WSL, native Linux, macOS) goes through `renderBashBlock` +
 * `mergeManagedBlock`, which is the historical behavior character for
 * character.
 *
 * Warnings and notes are shown as VS Code notifications here, at the same
 * side-effecting boundary that does the file write, so an alias that could not
 * be translated is never silently dropped.
 */
export async function syncAliasFile(
  aliasFilePath: string,
  aliases: CliAlias[],
): Promise<AliasSyncResult> {
  const warnings: string[] = [];
  const notes: string[] = [];
  const target = resolveAliasFile(aliasFilePath);
  warnings.push(...target.warnings);
  notes.push(...target.notes);

  let existing = '';
  let fileExisted = true;
  try {
    existing = await fs.readFile(target.file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
    // File does not exist yet — start from empty content.
    fileExisted = false;
  }

  let flavor: AliasFlavor;
  let block: string;
  let emitted: string[];
  let skipped: string[] = [];
  if (os.platform() === 'win32') {
    flavor = 'powershell';
    const rendered = renderPowerShellBlock(aliases);
    block = rendered.text;
    emitted = rendered.emitted;
    skipped = rendered.skipped;
    warnings.push(...rendered.warnings);
    // Only worth saying when the profile is brand new: a profile Ghola just
    // created is exactly the case where a Restricted execution policy would
    // silently stop the aliases from ever loading.
    if (!fileExisted && emitted.length > 0) {
      notes.push(
        'PowerShell only loads your profile when the execution policy allows it, and this profile was just created. If an alias is still not found in a NEW terminal, run "Get-ExecutionPolicy -Scope CurrentUser" and, if it reports Restricted, "Set-ExecutionPolicy -Scope CurrentUser RemoteSigned".',
      );
    }
  } else {
    flavor = 'bash';
    block = renderBashBlock(aliases);
    emitted = aliases.map((entry) => entry.alias);
  }

  const merged = mergeManagedBlock(existing, block);
  notes.push(...merged.notes);
  await fs.mkdir(path.dirname(target.file), { recursive: true });
  await fs.writeFile(target.file, merged.text, 'utf-8');

  if (warnings.length > 0) {
    void vscode.window.showWarningMessage(`Ghola CLI aliases: ${warnings.join(' ')}`);
  } else if (notes.length > 0) {
    void vscode.window.showInformationMessage(`Ghola CLI aliases: ${notes.join(' ')}`);
  }
  return { file: target.file, flavor, emitted, skipped, warnings, notes };
}
