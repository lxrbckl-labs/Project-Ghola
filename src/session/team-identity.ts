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
//
// THE NAME COMES FROM THE GIT REPOSITORY ROOT, NOT THE WORKSPACE FOLDER. The
// first cut of this module used the workspace folder's basename, which is wrong
// for the layout that motivated it: the native-Windows clones are opened at
// `...\source\repos\cmms1\cmms-api` and `...\source\repos\cmms2\cmms-api`, so
// both windows produced `cmms-api@win` — byte-identical, i.e. exactly the
// collision the qualifier was added to stop. `.git` lives at `...\cmms1`, and
// the roster's `Repo path` column records that same repo root, so walking up to
// it yields `cmms1@win` / `cmms2@win`: distinct AND in agreement with the
// roster. WSL is unaffected — `/home/aarbuckle/projects/Project-Ghola` is both
// the workspace folder and the repo root, so the walk terminates on its first
// probe with the same answer it gave before.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The environment qualifier vocabulary, verbatim from the protocol's
 * "Environment delineation": `<Team>@<env>` where `<env>` is exactly one of
 * these four. No other value is legal, so this is a closed union rather than a
 * string.
 */
export type HostEnvironment = 'wsl' | 'win' | 'mac' | 'linux';

/**
 * The same four tokens as a value list, used ONLY by the idempotence guard in
 * `qualify` — a name that already ends in a legal qualifier never gets a second
 * one. Kept adjacent to the type so the two cannot drift.
 */
const HOST_ENVIRONMENTS: readonly HostEnvironment[] = ['wsl', 'win', 'mac', 'linux'];

/**
 * The leading prefix stripped from a project basename, lowercased for the
 * case-insensitive compare. PREFIX ONLY: `Project-Ghola` -> `Ghola` and
 * `project-foo` -> `foo`, but `My-Project-Thing` keeps its whole name.
 */
const PROJECT_PREFIX = 'project-';

/**
 * Hard bound on the repo-root walk. `path.dirname` is a fixed point at the
 * filesystem root (`/` -> `/`, `C:\` -> `C:\`, and `.` -> `.` for a path this
 * host cannot parse), so the walk already terminates on its own; this is the
 * belt-and-braces stop that guarantees it, because a status-bar repaint must
 * never be the thing that spins. 64 is far past any real checkout depth.
 */
const MAX_ROOT_WALK_STEPS = 64;

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

/**
 * True when `dir` holds a `.git` entry, i.e. `dir` is a repository root.
 *
 * EXISTENCE, NOT DIRECTORY-NESS. In a plain clone `.git` is a directory, but in
 * a linked worktree or a submodule it is a FILE holding a `gitdir:` pointer —
 * both are equally the root of a working tree, so a `statSync().isDirectory()`
 * test would silently walk straight past every worktree. `existsSync` accepts
 * either, which is also what `support-discovery.ts`/`updateExtension.ts` do.
 *
 * Swallows errors to `false`: a permission-denied parent on the way up is
 * evidence of nothing, and a status-bar refresh must not throw.
 */
function hasGitEntryOnDisk(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

/**
 * The nearest ancestor of `startPath` (inclusive) that holds a `.git` entry, or
 * `undefined` when there is none up to the filesystem root.
 *
 * NOT CACHED, deliberately. The walk is a handful of `existsSync` stats — one
 * for a workspace folder that IS the repo root (the WSL case), two for the
 * nested `cmms1/cmms-api` case — on directories the OS dentry cache already
 * holds, and `refresh()` runs at human frequency (a module toggle, a settings
 * save, a `ghola.statusBar` config change), not per repaint. A cache would buy
 * nothing measurable and would cost correctness: unlike `cachedEnvironment`
 * above, whose answer CANNOT change inside one process, the filesystem can — an
 * operator running `git init` in a non-repo workspace would be stuck with the
 * stale "no repo" answer until a window reload.
 *
 * `hasGit` is injectable so the walk itself can be exercised against a layout
 * this host does not have.
 */
export function findRepoRoot(
  startPath: string,
  hasGit: (dir: string) => boolean = hasGitEntryOnDisk,
): string | undefined {
  let current = trimTrailingSeparators(startPath);
  for (let step = 0; step < MAX_ROOT_WALK_STEPS; step += 1) {
    if (hasGit(current)) return current;
    const parent = path.dirname(current);
    // `path.dirname` is its own fixed point at the top of the tree, so equality
    // is the "we have run out of parents" signal. Compared before assignment so
    // the root itself is probed exactly once, never twice.
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/**
 * Trailing separators would make `path.dirname` skip a level (`dirname('/a/b/')`
 * is `/a`, not `/a/b`), so they come off first. `repoBasename` tolerates them
 * for the same reason; VS Code's `fsPath` does not produce them, but a value
 * that reaches here from elsewhere might. `/` alone is left as `/` rather than
 * reduced to the empty string.
 */
function trimTrailingSeparators(candidate: string): string {
  const trimmed = candidate.replace(/[\\/]+$/, '');
  return trimmed.length > 0 ? trimmed : candidate;
}

/**
 * Append the `@<env>` qualifier — unless `teamName` already ends in one of the
 * four legal qualifiers, in which case it is returned untouched.
 *
 * THE IDEMPOTENCE IS THE POINT. It makes `cmms1@win@win` unrepresentable no
 * matter where the name came from — pathologically, a repo directory literally
 * named `cmms1@win`, which renders `cmms1@win` rather than gaining a second
 * qualifier. This does not change WHICH environments qualify — that decision
 * stays in `resolveTeamIdentity`.
 */
function qualify(teamName: string, environment: HostEnvironment): string {
  const lower = teamName.toLowerCase();
  const alreadyQualified = HOST_ENVIRONMENTS.some((env) => lower.endsWith(`@${env}`));
  return alreadyQualified ? teamName : `${teamName}@${environment}`;
}

/** Where the path that named the team came from. */
export type TeamIdentityRootSource = 'git-root' | 'workspace-folder';

/** A resolved identity plus everything the tooltip needs to explain it. */
export interface TeamIdentity {
  /** The rendered switchboard name — `Ghola`, `cmms2@win`. */
  readonly name: string;
  /**
   * The unqualified team name: `repoPath`'s basename with a leading `Project-`
   * stripped, before any `@env`. It is `name` minus the qualifier, carried
   * separately so a tooltip can report the strip (`basename !== teamName`)
   * independently of the qualifier, and so `qualified` below can be computed as
   * `name !== teamName` rather than by re-testing the suffix.
   *
   * NO CALLER RENDERS THE BARE NAME AS AN IDENTITY any more, and one used to: the
   * Remote Control session-name derivation in `session/launcher.ts` took
   * `teamName`, which is exactly what made the WSL and the native-Windows copy of
   * one clone register under a single Remote Control name. It takes `name` now.
   * `teamName` survives as the strip's own report of itself, for the tooltip and
   * for `qualified` — not as a name anything shows.
   */
  readonly teamName: string;
  /**
   * `repoPath`'s own basename, BEFORE the `Project-` strip — carried so a
   * tooltip can name the directory the name came from, and can tell whether a
   * strip happened at all (`basename !== teamName`) rather than claiming one
   * unconditionally.
   */
  readonly basename: string;
  /**
   * The path the name was derived from: the git repository root when one was
   * found at or above the workspace folder, otherwise the workspace folder
   * itself. This is the path the switchboard roster records as `Repo path`.
   */
  readonly repoPath: string;
  /** The first open workspace folder — the path the walk STARTED from. */
  readonly workspaceFolderPath: string;
  /** Whether `repoPath` is a discovered repo root or the workspace-folder fallback. */
  readonly rootSource: TeamIdentityRootSource;
  /** This host's environment. */
  readonly environment: HostEnvironment;
  /** True when `@env` was appended, i.e. this host is not the incumbent. */
  readonly qualified: boolean;
  /** How many workspace folders were open; > 1 means the first one was used. */
  readonly folderCount: number;
}

/** Injectable inputs to `resolveTeamIdentity`; every one has a real default. */
export interface TeamIdentityOptions {
  /**
   * This host's environment. Injectable so the derivation can be exercised for a
   * host we are not currently running on.
   */
  readonly environment?: HostEnvironment;
  /** The `.git` probe, injectable for the same reason as `environment`. */
  readonly hasGitEntry?: (dir: string) => boolean;
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
 * Returns `undefined` when no folder is open, or when nothing along the way
 * yields a basename — callers fall back to their pre-identity label rather than
 * render an empty or `undefined` name.
 */
export function resolveTeamIdentity(
  workspaceFolderPaths: readonly string[],
  options: TeamIdentityOptions = {},
): TeamIdentity | undefined {
  const workspaceFolderPath = workspaceFolderPaths[0];
  if (workspaceFolderPath === undefined || workspaceFolderPath.trim() === '') return undefined;
  const environment = options.environment ?? detectHostEnvironment();

  // THE REPO ROOT NAMES THE TEAM, not the folder the operator happened to open —
  // see the header note for why (`cmms1/cmms-api` and `cmms2/cmms-api` both
  // reduce to `cmms-api` otherwise). A root that yields no basename (a repo at
  // the filesystem root) cannot name a team, so it is treated as no root at all
  // and the workspace folder is used instead — the same fallback a non-repo
  // workspace takes, which keeps a folder with no `.git` anywhere above it as
  // usable as it was before this walk existed.
  const gitRoot = findRepoRoot(workspaceFolderPath, options.hasGitEntry ?? hasGitEntryOnDisk);
  const usableGitRoot =
    gitRoot !== undefined && repoBasename(gitRoot) !== undefined ? gitRoot : undefined;
  const repoPath = usableGitRoot ?? workspaceFolderPath;
  const rootSource: TeamIdentityRootSource =
    usableGitRoot === undefined ? 'workspace-folder' : 'git-root';

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
  //
  // DERIVATION IS THE ONLY RULE — there is deliberately no operator override.
  // `tool.team-switchboard` once declared a `teamName` setting that was honoured
  // verbatim here, and it was removed: module settings live in VS Code's
  // `globalState` (`readModuleSettings` merges with global winning, and
  // `writeModuleSettings` writes global ONLY — there is no per-workspace write
  // path), which is per-extension and shared by every window on the machine. So
  // one override would have renamed ALL of the operator's concurrent windows at
  // once, collapsing the very discriminator this module exists to supply. A
  // derived name cannot do that, because it is a function of each window's own
  // repo path. The Remote Control session-name derivation in
  // `session/launcher.ts` reached the same conclusion independently and has
  // never consulted an override.
  const name = environment === 'wsl' ? teamName : qualify(teamName, environment);
  return {
    name,
    teamName,
    basename,
    repoPath,
    workspaceFolderPath,
    rootSource,
    environment,
    // True exactly when this call appended a qualifier — false on WSL, and false
    // when the derived name already carried one of its own (a directory literally
    // named `cmms1@win`), which `qualify` passes through untouched.
    qualified: name !== teamName,
    folderCount: workspaceFolderPaths.length,
  };
}
