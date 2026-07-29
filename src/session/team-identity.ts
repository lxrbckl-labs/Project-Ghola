// Local derivation of this instance's Team Switchboard identity.
//
// The operator runs 8+ concurrent VS Code windows against clones named
// `cmms0`..`cmms6`, `Project-Ghola`, `Project-Steersman`, `Project-Mandrake`,
// split across a WSL host and a native-Windows host. Anything that renders only
// the session MODE is byte-identical in every one of those windows, so this
// module supplies the discriminator: the same per-instance name the agent
// registers in the shared switchboard roster.
//
// AUTHORITY: the canonical rule is the `## Identity` section (and its
// `### Environment delineation` subsection) of `_AgentComms/_Switchboard.md` in
// the operator's Obsidian vault, mirrored in `modules/tool.team-switchboard/
// team-switchboard.md`. This module is a LOCAL, PURE re-implementation of that
// rule — it performs NO vault I/O. It never reads, creates, or writes the
// roster or any inbox; the agent does that when the operator asks for it. The
// only filesystem read here is `/proc/version`, for WSL detection.
//
// KNOWN, DELIBERATE GAP — the `#N` suffix. The protocol also disambiguates two
// clones of ONE repo at two different paths with an integer suffix
// (`Ghola#2`, `Ghola#3`). That number is assigned by ROSTER REGISTRATION ORDER,
// which is not derivable from local state — computing it would require reading
// the roster, i.e. the vault I/O this module exists to avoid. So a name here is
// never suffixed, and two same-named clones inside the same environment render
// identically. That is the narrower collision; the cross-OS one (which the
// protocol calls out as having already caused two environments to read each
// other's mail) is the one this module resolves.
//
// NOT A FOURTH PATH-TRANSLATION COPY. `src/session/host-path.ts` documents, as
// KEEP-IN-SYNC EXCEPTION 2, that it deliberately does NOT carry a WSL detector,
// so as not to add a fourth copy of the path rule set. `detectHostEnvironment`
// below is not that: it answers "which environment am I" for NAMING only and
// must not be wired into path translation, whose three-way parity is enforced
// by `scripts/ghola-path-parity.mjs`.

import * as fs from 'fs';
import * as os from 'os';

/**
 * The environment qualifier vocabulary, verbatim from the protocol's
 * "Environment delineation": `<Team>@<env>` where `<env>` is exactly one of
 * these four. No other value is legal, so this is a closed union rather than a
 * string.
 */
export type HostEnvironment = 'wsl' | 'win' | 'mac' | 'linux';

/**
 * The leading prefix stripped from a project basename, lowercased for the
 * case-insensitive compare. PREFIX ONLY: `Project-Ghola` -> `Ghola` and
 * `project-foo` -> `foo`, but `My-Project-Thing` keeps its whole name.
 */
const PROJECT_PREFIX = 'project-';

/**
 * Memoized environment. The answer cannot change inside one extension-host
 * process, and `ModeStatusBarItem.refresh()` is documented as cheap and safe to
 * call on every relevant event — so the `/proc/version` read happens at most
 * once per window rather than once per repaint.
 */
let cachedEnvironment: HostEnvironment | undefined;

/**
 * Which environment this extension host is running in, per the protocol's
 * "Detect your own environment; never ask and never assume."
 *
 * The protocol is written for a shell (`uname -s` beginning `MINGW`/`MSYS`/
 * `CYGWIN` means `win`); this runs in the extension host, where the equivalent
 * and more direct signal is `os.platform()` — `win32` IS the native-Windows
 * host, with no MSYS shell in between. `darwin` -> `mac`. Everything else is
 * Linux-kernel, and WSL is distinguished from plain Linux by `/proc/version`
 * containing `microsoft` case-insensitively.
 *
 * `/proc/version` is read as a FILE via `fs`, never through a pipe. In bash that
 * matters because a producer piped into an early-exiting consumer takes SIGPIPE
 * and `pipefail` promotes it to a spurious failure (see `CLAUDE.md` rule 7 and
 * `bridge_down_last` in `scripts/ghola-boot-probe.sh`); here there is no shell
 * to get it wrong, and `readFileSync` is the direct form the rule asks for.
 *
 * Fails to `linux`, not to `wsl`: an unreadable/absent `/proc/version` means we
 * have no evidence of a WSL kernel, and `linux` is qualified, so the failure
 * mode is a MORE distinct label rather than one that silently collides with the
 * WSL incumbent's name.
 */
export function detectHostEnvironment(): HostEnvironment {
  if (cachedEnvironment !== undefined) return cachedEnvironment;
  cachedEnvironment = computeHostEnvironment();
  return cachedEnvironment;
}

function computeHostEnvironment(): HostEnvironment {
  const platform = os.platform();
  if (platform === 'win32') return 'win';
  if (platform === 'darwin') return 'mac';
  try {
    // The protocol's test is `microsoft` (case-insensitive). `shell_platform` in
    // `scripts/ghola-boot-probe.sh` matches the broader `microsoft|wsl`; both
    // hit this machine's `microsoft-standard-WSL2` kernel string, and the
    // protocol's narrower wording is what governs a NAME, so it is what is
    // implemented here.
    return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8')) ? 'wsl' : 'linux';
  } catch {
    return 'linux';
  }
}

/**
 * The team name for one repo path: the basename with a leading `Project-`
 * stripped case-insensitively, PREFIX ONLY, with the remainder keeping its own
 * casing (`Project-Ghola` -> `Ghola`, `project-foo` -> `foo`, `cmms2` ->
 * `cmms2`, `My-Project-Thing` -> `My-Project-Thing`).
 *
 * Returns `undefined` only when the path yields no basename at all (empty
 * string, `/`), so a caller can fall back rather than render nothing.
 *
 * Backslashes are folded to `/` before splitting, for the same reason
 * `toNativeHostPath` re-slashes: this value can be a foreign-form path (a
 * `C:\Users\...` workspace read by a WSL host, or the reverse), and
 * `path.basename` only understands the separator of the host it is running on.
 * A basename of exactly `Project-` strips to nothing, so the UNSTRIPPED
 * basename is kept in that case — the one rule here that can produce an empty
 * string is also the one place it is refused.
 */
export function deriveTeamName(repoPath: string): string | undefined {
  const basename = repoBasename(repoPath);
  return basename === undefined ? undefined : stripProjectPrefix(basename);
}

/**
 * Last non-empty path segment, or `undefined` when there is none. Tolerates
 * trailing separators and either slash form; see `deriveTeamName` for why the
 * re-slash is here rather than a `path.basename` call.
 */
function repoBasename(repoPath: string): string | undefined {
  return repoPath
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0)
    .pop();
}

/** The `Project-` strip itself. Returns `basename` unchanged when it does not apply. */
function stripProjectPrefix(basename: string): string {
  if (!basename.toLowerCase().startsWith(PROJECT_PREFIX)) return basename;
  const stripped = basename.slice(PROJECT_PREFIX.length);
  return stripped.length > 0 ? stripped : basename;
}

/** A resolved identity plus everything the tooltip needs to explain it. */
export interface TeamIdentity {
  /** The rendered switchboard name — `Ghola`, `cmms2@win`. */
  readonly name: string;
  /** The unqualified team name, before any `@env` was appended. */
  readonly teamName: string;
  /**
   * The workspace folder's own basename, BEFORE the `Project-` strip — carried
   * so a tooltip can name the folder the operator actually opened, and can tell
   * whether a strip happened at all (`basename !== teamName`) rather than
   * claiming one unconditionally.
   */
  readonly basename: string;
  /** The repo path the name was derived from. */
  readonly repoPath: string;
  /** This host's environment. */
  readonly environment: HostEnvironment;
  /** True when `@env` was appended, i.e. this host is not the incumbent. */
  readonly qualified: boolean;
  /** How many workspace folders were open; > 1 means the first one was used. */
  readonly folderCount: number;
}

/**
 * Resolve this instance's switchboard identity from the open workspace folders.
 *
 * MULTI-ROOT: the FIRST folder wins. Not an arbitrary pick — (a) the switchboard
 * roster has exactly one `Repo path` column per team, so a set of folders has to
 * collapse to one path no matter what, and the agent registering that row will
 * collapse it the same way; (b) VS Code's first folder is the workspace's
 * primary root, and every other Ghola surface that needs "the repo" already
 * takes it (`session/prompt-file.ts`, `session/launcher.ts`,
 * `extension.ts`) — a status bar naming a DIFFERENT folder than the session the
 * operator launches from that window would be worse than no name. The count is
 * carried on the result so the tooltip can disclose that a choice was made.
 *
 * Returns `undefined` when no folder is open, or when the first folder yields no
 * basename — callers fall back to their pre-identity label rather than render an
 * empty or `undefined` name.
 *
 * `environment` is injectable so the derivation can be exercised for a host we
 * are not currently running on.
 */
export function resolveTeamIdentity(
  repoPaths: readonly string[],
  environment: HostEnvironment = detectHostEnvironment(),
): TeamIdentity | undefined {
  const repoPath = repoPaths[0];
  if (repoPath === undefined || repoPath.trim() === '') return undefined;
  const basename = repoBasename(repoPath);
  if (basename === undefined) return undefined;
  const teamName = stripProjectPrefix(basename);

  // THE INCUMBENT KEEPS ITS NAME. The protocol gives the unqualified `<Team>`
  // (and its inbox, with all of its history) to whichever environment
  // registered first, and qualifies every later arrival. That incumbent is not
  // locally derivable in general — it is a roster fact — but for THIS fleet it
  // is known and fixed: every clone in the roster started life in WSL
  // (`/home/aarbuckle/projects/...`), and native Windows is the newcomer. So
  // WSL renders bare and every other environment renders qualified. `linux`
  // is qualified for the same reason `win`/`mac` are: it is not the incumbent,
  // and a plain-Linux host that quietly borrowed the WSL name would reproduce
  // exactly the two-agents-one-inbox failure the qualifier was added to stop.
  const qualified = environment !== 'wsl';
  return {
    name: qualified ? `${teamName}@${environment}` : teamName,
    teamName,
    basename,
    repoPath,
    environment,
    qualified,
    folderCount: repoPaths.length,
  };
}
