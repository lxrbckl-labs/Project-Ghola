// Two ICON-ONLY status-bar buttons that sit immediately to the right of the
// Ghola pill and open, in the operator's browser, the two things a ticket-work
// session is always about: the Jira ticket, and the branch's Bitbucket pull
// request.
//
// WHY A SEPARATE FILE FROM `mode-status-bar.ts`. That item renders ONE pill whose
// every segment is derived from state the extension host already holds
// synchronously (enabled modules, workspace folder, a local JSON file). These two
// buttons are a different kind of thing: they are ACTIONS, they are gated on a
// single modality, and one of them can only be resolved by an asynchronous
// Bitbucket lookup. Folding an async, cached, credential-gated network path into
// the pill's `refresh()` — documented there as "cheap and idempotent — safe to
// call on every relevant event" — would falsify that contract for the pill's own
// callers. So they live side by side and are wired independently.
//
// THE DATA SOURCES ARE THE EXISTING ONES, NOT NEW MACHINERY:
//
//   - TICKET KEY — derived from the CURRENT GIT BRANCH by the same rule
//     `scripts/ghola-boot-probe.sh` uses (`grep -oiE '[A-Z][A-Z0-9]+-[0-9]+'`,
//     first match, upper-cased). See `TICKET_KEY_PATTERN`. No Jira call is made
//     and none is needed: the key is a property of the branch name.
//   - JIRA BASE URL — the `integration.atlassian-suite::jiraBase` module setting,
//     whose own description in that module's manifest states the contract this
//     file implements verbatim: "Base URL used to form Jira ticket links:
//     <jiraBase>/browse/<KEY>. Trailing slashes are stripped automatically." It is
//     read through an injected accessor so this file never reaches into the
//     module-settings store itself. `boardUrl` is deliberately NOT used — it names
//     a BOARD, not the instance, and it is optional and empty by default.
//   - PR URL — the ONE value the host does not already hold. Nothing in the
//     extension host caches a PR for a branch, so it is resolved through the
//     SAME `BitbucketPrClient.findOpenPrForBranch` the `/find-pr` bridge route
//     already calls for the agent, injected as `FindPrForBranch`. It is
//     answer-cached per branch (see `PrCacheEntry`) so the repaint cadence below
//     never turns into a Bitbucket poll.
//
// THE BRANCH IS READ FROM `.git/HEAD`, NOT FROM `git rev-parse`. This runs on
// every repaint, and a repaint can be triggered by a debounced watcher in a fleet
// of 8+ concurrent sessions, so it must not spawn a subprocess. `HEAD` is a
// sub-100-byte file whose `ref: refs/heads/<branch>` line is the whole answer.
// `git remote get-url origin` IS spawned — but only from the async lookup path,
// and that path is gated by `maybeStartPrLookup`. It is NOT once per branch
// change: it runs on a branch change, AND again whenever a cached `none` passes
// `PR_ABSENT_RECHECK_MS` (5 min) or a cached `unknown` passes
// `PR_UNKNOWN_RECHECK_MS` (60 s), AND again if a lookup is abandoned by
// `PR_LOOKUP_MAX_INFLIGHT_MS`. Only a `found` answer never expires, so "once per
// branch" is the steady state of a healthy session with a PR, not the bound.

import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ModuleLoader } from '../modules/loader';
import { findRepoRoot } from '../session/team-identity';
import { MODE_STATUS_BAR_CONFIG_SECTION } from './mode-status-bar';

/**
 * The one modality these buttons appear in. Tested as an EXACT enabled-module id
 * rather than by string-matching `formatMode`'s output, because that output is a
 * comma-joined list (`ticket-work, support`) and a substring test on it would also
 * fire for a hypothetical future `mode.ticket-work-lite`.
 *
 * War Mode is not a `mode.*` module the loader toggles — it layers on top of the
 * modality from its own setting — so a `ticket-work + war` session still has
 * `mode.ticket-work` enabled here and still gets its buttons, which is correct:
 * War Mode forbids git WRITES, not reading a ticket.
 *
 * `mode.sardaukar` deliberately does NOT qualify. The operator's instruction is
 * "ticket-work only"; the boot probe's own gate is looser (it excludes only
 * `support`/`cd`/`self-upgrade`), and the narrower rule is the one that was asked
 * for.
 */
const TICKET_WORK_MODULE_ID = 'mode.ticket-work';

/**
 * `ghola.statusBar.enabled` — the SAME switch the Ghola pill obeys, composed from
 * the section that item exports so there is no second literal to drift. Turning
 * Ghola's status bar off must take the whole group with it, not leave two orphaned
 * glyphs behind.
 */
const STATUS_BAR_ENABLED_KEY = `${MODE_STATUS_BAR_CONFIG_SECTION}.enabled`;

/**
 * Priorities placing this pair immediately to the RIGHT of the Ghola pill, which
 * is `Left`/`100`. Higher priority = further left, so 99 then 98 puts Jira first
 * and the PR second, directly abutting the pill, and the three read as one group.
 */
const JIRA_ITEM_PRIORITY = 99;
const PR_ITEM_PRIORITY = 98;

/**
 * Commands the two items point at. Registered with `commands.registerCommand`
 * ONLY — there is deliberately no `contributes.commands` entry in `package.json`.
 * A status-bar item's `command` resolves against the registry, not against the
 * contribution point, so these work exactly as an entry-backed command would; the
 * only thing a contribution would add is Command Palette visibility, which is
 * actively unwanted for two commands whose meaning depends on the current branch
 * and whose target is meaningless outside a ticket-work session.
 */
const OPEN_TICKET_COMMAND = 'ghola.openTicketInJira';
const OPEN_PR_COMMAND = 'ghola.openPullRequest';

/**
 * The ticket-key rule, character for character the boot probe's
 * `grep -oiE '[A-Z][A-Z0-9]+-[0-9]+'` with its `-i`: a letter, one or more
 * alphanumerics, a hyphen, one or more digits. FIRST match wins (the probe pipes
 * through `head -1`) and the result is upper-cased (the probe's `tr 'a-z' 'A-Z'`).
 *
 * IT IS COPIED RATHER THAN IMPROVED, and the known over-match is copied with it:
 * a branch named `fix-123` yields `FIX-123`. Tightening the pattern here would
 * make the pill's ticket and the agent's boot-digest ticket disagree on exactly
 * the branch names where a human would most want them to agree, and a button that
 * names a different key than the session's own banner is worse than one that
 * repeats the banner's over-match. The tooltip always spells the key out, so an
 * over-match is visible before the click rather than after it.
 */
const TICKET_KEY_PATTERN = /[a-z][a-z0-9]+-[0-9]+/i;

/**
 * Repaint cadence. This is a BRANCH-CHANGE DETECTOR, not a network poll: a git
 * checkout fires no extension-host event and no configuration change, so without
 * a clock the buttons would keep pointing at the previous branch's ticket until
 * something unrelated happened to repaint them — the silent-wrong-URL failure
 * this whole file is most obliged to avoid. Each tick costs one `readFileSync` of
 * `.git/HEAD`; the Bitbucket lookup is answer-cached and is NOT reached on a tick
 * that has a valid cached answer. Matches the Ghola pill's own 15s interval so
 * the two halves of the group never disagree about which branch this is.
 */
const BRANCH_POLL_INTERVAL_MS = 15_000;

/**
 * How long a definitive "there is no PR for this branch" is trusted before it is
 * re-asked. It has to expire: the operator opens a PR from the same branch mid-
 * session, and a `none` cached for the life of the window would leave the button
 * greyed out for the rest of the day with no way to correct it (the greyed button
 * is inert by requirement, so there is no click to refresh on). Five minutes is
 * one lookup per five minutes per window in the ONLY state that needs re-asking —
 * a found PR is cached permanently and a healthy session with a PR therefore makes
 * exactly one Bitbucket call for the life of the branch.
 */
const PR_ABSENT_RECHECK_MS = 300_000;

/**
 * How long a NON-ANSWER is trusted before it is re-asked. Much shorter than
 * `PR_ABSENT_RECHECK_MS` because the conditions that produce it — a network drop,
 * a rate limit, a token being rotated in the settings panel — resolve on a scale
 * of seconds, and until one does the button is showing the operator nothing
 * useful.
 */
const PR_UNKNOWN_RECHECK_MS = 60_000;

/**
 * Worst case for ONE HTTP request on the lookup path, and the innermost of the
 * three layers below. `atlassian-client.ts`'s `request()` wraps `requestOnce` in
 * `withTransientRetry` (`bitbucket-failover.ts`): up to `1 +
 * MAX_TRANSIENT_RETRIES` = 4 attempts, each bounded by its own
 * `REQUEST_TIMEOUT_MS` (8 s) `AbortController`, plus at most
 * `MAX_TOTAL_RETRY_WAIT_MS` (9 s) of backoff between them. 4x8 + 9 = 41 s — the
 * same figure `atlassian-client.ts`'s own `COMMENT_WALK_BUDGET_MS` note quotes.
 */
const PR_LOOKUP_REQUEST_WORST_CASE_MS = 41_000;

/**
 * Requests one branch lookup issues: `&state=OPEN`, then the closed-state
 * fallback. `AtlassianClient.findOpenPrForBranch` runs the second only when the
 * first came back clean with no match, so this is a ceiling, not a count.
 */
const PR_LOOKUP_REQUESTS_PER_LOOKUP = 2;

/**
 * Token-list length the in-flight bound is sized for.
 *
 * It has to be a GUESS rather than the live count: the token list lives in
 * secret storage behind the ASYNC `AtlassianBridge.getBitbucketTokens()`, and
 * the only Atlassian accessor injected into this class is the string-valued
 * `getAtlassianSetting`, which exposes no token count. Reading it here would
 * mean either a new accessor or making the guard async — both of which put a
 * `await` on the repaint path this file exists to keep synchronous.
 *
 * It is an ENGINEERING CEILING, NOT A LIMIT THE PRODUCT ENFORCES — nothing caps
 * how many Bitbucket tokens an operator may store. Over-running it is therefore
 * expected to happen eventually, and is survivable by design: see
 * `runPrLookup`, which accepts a late answer rather than discarding it.
 */
const PR_LOOKUP_TOKEN_COUNT_CEILING = 4;

/**
 * How long a lookup may hold `prLookupInFlight` before the flag is treated as
 * ABANDONED and a fresh lookup is allowed to start.
 *
 * The flag is cleared in `runPrLookup`'s `finally`, which is reached on every
 * path a promise SETTLES on — but not on a promise that never settles at all.
 * Without this bound, one wedged `findPrForBranch` pins the flag `true` for the
 * life of the window: `maybeStartPrLookup` returns early forever, the cache is
 * never refilled, and the PR button sits on "Looking up the pull request..."
 * with no click to recover from (the pending button is inert by requirement).
 * That is the same class of silent-stuck failure the `unknown` kind exists to
 * avoid, so it does not get to rely on the HTTP layer's timeout alone.
 *
 * THE BUDGET IS THREE LAYERS DEEP, AND THE MIDDLE ONE IS FAILOVER. The bound
 * here was 120 s, justified by counting only the outer two — "at most two
 * requests at ~41 s each". That omitted `withBitbucketFailover`, which sits
 * BETWEEN them and makes ONE FULL PASS over the TOKEN LIST
 * (`bitbucket-failover.ts`), so each of the two queries is up to N requests, not
 * one. Multi-token is a first-class supported config, so N is not 1. Composed:
 *
 *     PR_LOOKUP_REQUESTS_PER_LOOKUP x N x PR_LOOKUP_REQUEST_WORST_CASE_MS
 *
 * which is 82 s at N=1 (the only case 120 s covered), 164 s at N=2, 246 s at
 * N=3. At N>=2 the old bound fired BEFORE a healthy lookup could finish: the
 * guard superseded it, its answer was then discarded on the generation
 * mismatch, and no lookup ever survived its own window — the button pinned on
 * "Looking up the pull request..." permanently while spawning a subprocess and a
 * round trip every 120 s. Strictly worse than the wedged flag this bound exists
 * to break, which at least stopped calling.
 *
 * Expiring the flag does not cancel the old lookup (there is no handle to cancel
 * with); it only stops one stuck call from owning the button forever. The
 * generation counter in `runPrLookup` is what keeps an abandoned call from
 * writing its stale answer over a NEWER one — note "newer answer", not "newer
 * lookup": a late answer with nothing newer already filed is accepted, which is
 * what makes an under-sized bound survivable rather than fatal.
 */
const PR_LOOKUP_MAX_INFLIGHT_MS =
  PR_LOOKUP_REQUESTS_PER_LOOKUP *
  PR_LOOKUP_TOKEN_COUNT_CEILING *
  PR_LOOKUP_REQUEST_WORST_CASE_MS;

/** What a PR lookup concluded. THREE outcomes, and the third is the point. */
export type PrLookupKind =
  /** A pull request exists for the branch, in SOME state. `url` is present. */
  | 'found'
  /** Bitbucket answered, and there is no PR for this branch in any state. */
  | 'none'
  /**
   * NOBODY ANSWERED. A transport failure, a rate limit, an expired token, an
   * unconfigured workspace. This is the in-host counterpart of the boot probe's
   * `pr_state=bridge-down` / `bridge-slow`, and it exists for the same reason
   * those two do: it must never be collapsed into `none`. `none` asserts a fact
   * about Bitbucket; this asserts a fact about the lookup.
   */
  | 'unknown';

/** One PR lookup's conclusion. */
export interface PrLookupAnswer {
  readonly kind: PrLookupKind;
  /** Browser URL of the PR. Present only on `found`. */
  readonly url?: string;
  /** Bitbucket's PR number, for the tooltip. Present on `found` when returned. */
  readonly id?: number;
  /** `OPEN` / `MERGED` / `DECLINED` / `SUPERSEDED`. Present on `found` when returned. */
  readonly state?: string;
  /** Why nothing could be concluded. Present only on `unknown`; already sanitized. */
  readonly reason?: string;
}

/**
 * The injected lookup. Takes a Bitbucket repo slug and a branch; never throws
 * (the wiring in `extension.ts` converts every failure into an `unknown`).
 */
export type FindPrForBranch = (repoSlug: string, branch: string) => Promise<PrLookupAnswer>;

/** One cached lookup, and the inputs it was valid for. */
interface PrCacheEntry {
  /** Branch the answer describes. A different branch invalidates it outright. */
  readonly branch: string;
  /** `Date.now()` at which the answer arrived, for the per-kind expiry above. */
  readonly answeredAtMs: number;
  /**
   * Generation of the lookup that produced this answer. Generations are handed
   * out in START order, so a higher one always asked a MORE RECENT question —
   * which is what lets `runPrLookup` accept a late answer without letting it
   * overwrite a newer one. See `TicketLinkStatusBarItems.prLookupGeneration`.
   */
  readonly generation: number;
  readonly answer: PrLookupAnswer;
}

/**
 * The git directory for a repo root: `<root>/.git` when that is a directory, and
 * the `gitdir:` target it points at when it is a FILE.
 *
 * The file case is not exotic here — it is how a linked WORKTREE and a SUBMODULE
 * both look, and `findRepoRoot` in `team-identity.ts` carries a long note about an
 * `isDirectory()` test having already walked straight past every worktree once in
 * this tree. That bug is not repeated: existence is tested, then the two shapes
 * are handled separately.
 *
 * Returns `undefined` on anything unreadable or unparseable. Never throws.
 */
function resolveGitDir(repoRoot: string): string | undefined {
  const dotGit = path.join(repoRoot, '.git');
  try {
    if (fs.statSync(dotGit).isDirectory()) return dotGit;
  } catch {
    return undefined;
  }
  try {
    const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (pointer === null) return undefined;
    const target = pointer[1]!.trim();
    // A worktree's pointer is normally absolute, but git accepts a relative one
    // and resolves it against the directory holding the `.git` file.
    return path.isAbsolute(target) ? target : path.resolve(repoRoot, target);
  } catch {
    return undefined;
  }
}

/**
 * The checked-out branch name, or `undefined` on a DETACHED HEAD, an unreadable
 * repo, or no repo at all.
 *
 * Detached HEAD returning `undefined` rather than the raw sha is deliberate and
 * matches `SessionLauncher.resolveRemoteControlSessionName`, which maps the
 * literal `HEAD` to `''` for the same reason: a sha carries no ticket key and is
 * not a branch a PR can be found for, so both buttons should say "nothing to open"
 * rather than search for a PR on a name that is not one.
 */
function readGitBranch(repoRoot: string): string | undefined {
  const gitDir = resolveGitDir(repoRoot);
  if (gitDir === undefined) return undefined;
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (ref === null) return undefined;
    const branch = ref[1]!.trim();
    return branch.length > 0 ? branch : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Jira key a branch name carries, upper-cased, or `undefined`. See
 * `TICKET_KEY_PATTERN` for why this rule is the boot probe's rather than a better
 * one.
 */
export function ticketKeyFromBranch(branch: string | undefined): string | undefined {
  if (branch === undefined) return undefined;
  const match = TICKET_KEY_PATTERN.exec(branch);
  return match === null ? undefined : match[0].toUpperCase();
}

/**
 * `<jiraBase>/browse/<KEY>`, with trailing slashes stripped from the base exactly
 * as the `jiraBase` setting's own description promises. Returns `undefined` when
 * either half is missing, so a caller can never build `undefined/browse/KEY` and
 * open it.
 *
 * The key is NOT `encodeURIComponent`d, and that is safe by construction rather
 * than by omission: `TICKET_KEY_PATTERN` admits only `[A-Za-z0-9-]`, every
 * character of which is URL-safe. Encoding it would be harmless but would suggest
 * the input is untrusted, which it is not — it came from this machine's own branch
 * name through a closed character class.
 */
export function buildJiraBrowseUrl(
  jiraBase: string | undefined,
  ticketKey: string | undefined,
): string | undefined {
  if (ticketKey === undefined) return undefined;
  const base = (jiraBase ?? '').trim().replace(/\/+$/, '');
  if (base === '') return undefined;
  return `${base}/browse/${ticketKey}`;
}

/**
 * The Bitbucket repo slug from an `origin` remote URL: everything after the last
 * `/` or `:`, with a `.git` suffix removed. Character for character the boot
 * probe's `sed -E 's#\.git$##; s#.*[/:]##'`, so the extension host and the probe
 * cannot query two different repositories for one branch.
 */
export function repoSlugFromRemoteUrl(remoteUrl: string): string {
  const withoutSuffix = remoteUrl.trim().replace(/\.git$/, '');
  const lastSeparator = Math.max(withoutSuffix.lastIndexOf('/'), withoutSuffix.lastIndexOf(':'));
  return lastSeparator < 0 ? withoutSuffix : withoutSuffix.slice(lastSeparator + 1);
}

/**
 * `git remote get-url origin` for a repo root, or `''`. The ONE subprocess this
 * file spawns, and it is reached only from `runPrLookup`.
 *
 * NEITHER "ONCE PER BRANCH CHANGE" NOR "OFF THE REPAINT PATH" — both were
 * claimed here and both are false. This file's header holds the real cadence: a
 * branch change, an expired `none` (`PR_ABSENT_RECHECK_MS`), an expired
 * `unknown` (`PR_UNKNOWN_RECHECK_MS`), and a lookup abandoned by
 * `PR_LOOKUP_MAX_INFLIGHT_MS` each reach this call.
 *
 * And it runs INSIDE `refresh()`'s own call stack. `runPrLookup` is `async`, but
 * everything before its first `await` executes synchronously in its caller, and
 * this call sits before that `await`; `maybeStartPrLookup` invokes it with
 * `void`, not `await`. So the chain
 * `refresh()` -> `renderPr()` -> `maybeStartPrLookup()` -> `runPrLookup()` puts
 * this BLOCKING `spawnSync` on the repaint path that the 15 s
 * `BRANCH_POLL_INTERVAL_MS` clock drives. What keeps that from being a
 * subprocess per tick is the cadence gate in `maybeStartPrLookup`, not the
 * `async` keyword.
 *
 * Never throws, mirroring `SessionLauncher.readGitBranch`.
 */
function readOriginUrl(repoRoot: string): string {
  try {
    const result = childProcess.spawnSync(
      'git',
      ['-C', repoRoot, 'remote', 'get-url', 'origin'],
      { encoding: 'utf8' },
    );
    return result.status === 0 && typeof result.stdout === 'string' ? result.stdout.trim() : '';
  } catch {
    return '';
  }
}

/**
 * Two icon-only status-bar buttons for a ticket-work session: `$(issues)` opening
 * `<jiraBase>/browse/<KEY>`, and `$(git-pull-request)` opening the branch's
 * Bitbucket pull request.
 *
 * VISIBILITY IS ALL-OR-NOTHING ON THE MODALITY. Both appear in ticket-work and
 * neither appears anywhere else. Inside ticket-work they are ALWAYS BOTH PRESENT —
 * a button that vanishes when its target is missing makes the status bar's width
 * jitter and leaves the operator unable to tell "no PR" from "the feature broke".
 *
 * PRESENT-BUT-INERT IS THE DEGRADED STATE, NOT HIDDEN. VS Code has no disabled
 * state for a `StatusBarItem`, so it is approximated exactly the way the operator
 * specified: the item stays visible, its `command` is CLEARED so a click does
 * nothing at all, and its foreground is dimmed to the theme's `disabledForeground`.
 * Every inert state carries a tooltip that says WHY it is inert, because a dimmed
 * glyph that a click does not answer is otherwise indistinguishable from a bug.
 *
 * NEITHER BUTTON TAKES A BACKGROUND COLOR, unlike the amber Ghola pill beside it.
 * The dim/normal contrast IS the entire signal for whether a button will do
 * anything, and a colored chip behind the glyph competes with it; adjacency and
 * matching alignment already group the three visually. Do not "finish the look" by
 * adding `statusBarItem.warningBackground` here without checking that
 * `disabledForeground` still reads as obviously dimmed against it.
 */
export class TicketLinkStatusBarItems implements vscode.Disposable {
  private readonly jiraItem: vscode.StatusBarItem;
  private readonly prItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  /**
   * The URLs the two registered commands open. Set by `refresh()` and read by the
   * command bodies, so a command can never re-derive a target and reach a
   * different answer than the tooltip the operator just read.
   */
  private jiraUrl: string | undefined;
  private prUrl: string | undefined;

  /** Latest PR answer and the branch it describes. See `PrCacheEntry`. */
  private prCache: PrCacheEntry | undefined;

  /**
   * Guards against a second lookup being started while one is in flight. Without
   * it the repaint that a completed lookup triggers could race a poll tick and
   * stack calls on a slow network.
   *
   * Bounded by `PR_LOOKUP_MAX_INFLIGHT_MS` — a lookup that never settles must
   * not own this flag for the life of the window.
   */
  private prLookupInFlight = false;

  /**
   * `Date.now()` at which the in-flight lookup started. ONE job: the wall-clock
   * guard in `maybeStartPrLookup` reads it as an age against
   * `PR_LOOKUP_MAX_INFLIGHT_MS`. It deliberately no longer doubles as the
   * generation stamp — that is `prLookupGeneration`'s job now.
   */
  private prLookupStartedAtMs = 0;

  /**
   * Monotonic lookup counter, incremented once per START. Each `runPrLookup`
   * carries the value it was started with and compares it against this field
   * (am I still the current lookup?) and against the cache entry's own
   * `generation` (has anything NEWER already answered?).
   *
   * A COUNTER, NOT A TIMESTAMP, so uniqueness is structural. The previous
   * timestamp stamp argued uniqueness from the in-flight bound — "a start can
   * only happen `PR_LOOKUP_MAX_INFLIGHT_MS` after the one it supersedes" — which
   * is not the real reason it held: a start can also follow a SETTLE with no
   * wait at all, because `runPrLookup` calls `refresh()` the moment it files an
   * answer and a branch change on that same repaint starts the next lookup
   * immediately. `++` needs no such argument.
   */
  private prLookupGeneration = 0;

  /** See `BRANCH_POLL_INTERVAL_MS`. Cleared whenever the items hide, and on dispose. */
  private branchPollTimer: ReturnType<typeof setInterval> | undefined;

  /** Set in `dispose()` so an in-flight lookup's completion cannot repaint a dead item. */
  private disposed = false;

  constructor(
    private readonly loader: ModuleLoader,
    /**
     * Reads one `integration.atlassian-suite` setting. Injected rather than read
     * directly so this class never opens the module-settings store itself and
     * cannot disagree with the accessor every other Atlassian consumer in
     * `extension.ts` already shares.
     */
    private readonly getAtlassianSetting: (fieldKey: string) => string,
    /** The Bitbucket PR lookup. See `FindPrForBranch`. */
    private readonly findPrForBranch: FindPrForBranch,
  ) {
    this.jiraItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      JIRA_ITEM_PRIORITY,
    );
    this.jiraItem.name = 'Ghola Ticket';
    // Icon-only in the pill, so the label the screen reader announces is the only
    // place the words live for a non-sighted operator. Restated on every repaint
    // alongside the tooltip so the two can never describe different targets.
    this.jiraItem.text = '$(issues)';

    this.prItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      PR_ITEM_PRIORITY,
    );
    this.prItem.name = 'Ghola Pull Request';
    this.prItem.text = '$(git-pull-request)';

    this.disposables.push(
      vscode.commands.registerCommand(OPEN_TICKET_COMMAND, () => this.openUrl(this.jiraUrl)),
      vscode.commands.registerCommand(OPEN_PR_COMMAND, () => this.openUrl(this.prUrl)),
    );
  }

  /**
   * Open a resolved URL externally, or do nothing. The `undefined` branch is
   * belt-and-braces rather than reachable through the pill: an item with no target
   * has already had its `command` cleared, so there is nothing to click. It exists
   * because a command in the registry can be invoked by id from anywhere.
   */
  private openUrl(url: string | undefined): void {
    if (url === undefined) return;
    void vscode.env.openExternal(vscode.Uri.parse(url));
  }

  /**
   * Recompute both buttons from the current modality, branch, settings, and cached
   * PR answer. Synchronous and cheap: at most one `statSync` plus one small
   * `readFileSync`. The Bitbucket lookup it may START is asynchronous and repaints
   * again on completion.
   */
  refresh(): void {
    if (this.disposed) return;

    const enabled = vscode.workspace.getConfiguration().get<boolean>(STATUS_BAR_ENABLED_KEY, true);
    const ticketWork = this.loader
      .getEnabled()
      .some((handle) => handle.manifest.id === TICKET_WORK_MODULE_ID);
    if (!enabled || !ticketWork) {
      // Nothing to keep current, so the branch clock stops with the buttons — the
      // same rule `ModeStatusBarItem.refresh()` applies to its own timer, and for
      // the same reason: an interval ticking against an invisible item is a leak
      // the operator can neither see nor stop.
      this.stopBranchTracking();
      this.jiraItem.hide();
      this.prItem.hide();
      return;
    }

    this.startBranchTracking();

    // `workspaceFolders` is `undefined` with no folder open and may hold several
    // in a multi-root workspace. The first-folder collapse and the walk to the git
    // root are the SAME ones the Ghola pill's identity and state key already make,
    // so the buttons cannot describe a different repository than the pill beside
    // them names.
    const folders = vscode.workspace.workspaceFolders ?? [];
    const workspacePath = folders[0]?.uri.fsPath;
    const repoRoot = workspacePath === undefined ? undefined : findRepoRoot(workspacePath);
    const branch = repoRoot === undefined ? undefined : readGitBranch(repoRoot);

    this.renderJira(branch);
    this.renderPr(repoRoot, branch);
  }

  /**
   * The Jira button. Active when the branch carries a key AND a Jira base URL is
   * configured; present-but-inert, with the reason spelled out, otherwise.
   */
  private renderJira(branch: string | undefined): void {
    const ticketKey = ticketKeyFromBranch(branch);
    const jiraBase = this.getAtlassianSetting('jiraBase');
    const url = buildJiraBrowseUrl(jiraBase, ticketKey);
    this.jiraUrl = url;

    if (url !== undefined && ticketKey !== undefined) {
      // The URL goes in the tooltip, on its own line. A button that opens the
      // WRONG page is a silent failure — the operator lands somewhere plausible
      // and never notices — so the exact target is made checkable BEFORE the
      // click rather than only afterwards in the address bar.
      this.activate(this.jiraItem, OPEN_TICKET_COMMAND, `Open ${ticketKey} in Jira`, [
        `Open ${ticketKey} in Jira`,
        url,
      ]);
    } else if (ticketKey === undefined) {
      this.deactivate(
        this.jiraItem,
        'No Jira ticket in this branch',
        branch === undefined
          ? [
              'No Jira ticket to open — this window has no git branch (no folder open, no repository, or a detached HEAD).',
            ]
          : [
              `No Jira ticket to open — the branch '${branch}' carries no <PROJECT>-<NUMBER> key.`,
            ],
      );
    } else {
      this.deactivate(this.jiraItem, 'Jira base URL is not configured', [
        `No Jira link for ${ticketKey} — the Atlassian Suite "Jira Base URL" setting is empty.`,
        'Set it in Ghola settings > Modules > Atlassian Suite to enable this button.',
      ]);
    }
    this.jiraItem.show();
  }

  /**
   * The PR button. Active whenever a PR EXISTS FOR THE BRANCH IN ANY STATE — open,
   * merged, declined, superseded. State is reported in the tooltip and never gates
   * the click: a merged PR is still the page the operator wants when they ask for
   * "the PR for this branch", and `AtlassianClient.findOpenPrForBranch` already
   * falls back to the closed states for exactly that reason.
   *
   * Every non-`found` state renders present-but-inert, and the three of them use
   * DIFFERENT tooltips on purpose — see `PrLookupKind` for why a non-answer must
   * never be worded as an absence.
   */
  private renderPr(repoRoot: string | undefined, branch: string | undefined): void {
    if (branch === undefined) {
      this.prUrl = undefined;
      this.deactivate(this.prItem, 'No branch to find a pull request for', [
        'No pull request to open — this window has no git branch (no folder open, no repository, or a detached HEAD).',
      ]);
      this.prItem.show();
      return;
    }

    this.maybeStartPrLookup(repoRoot, branch);

    const cached = this.prCache?.branch === branch ? this.prCache : undefined;
    if (cached === undefined) {
      // No answer yet for THIS branch. Not an absence — the lookup kicked off
      // above has simply not returned, and it repaints when it does.
      this.prUrl = undefined;
      this.deactivate(this.prItem, 'Looking up the pull request', [
        `Looking up the pull request for '${branch}'...`,
      ]);
      this.prItem.show();
      return;
    }

    const answer = cached.answer;
    if (answer.kind === 'found' && answer.url !== undefined) {
      this.prUrl = answer.url;
      // Bitbucket returned the id and state on every real hit; both are optional
      // in `PrLookupResult`, so the label degrades rather than printing
      // `PR #undefined`.
      const label = answer.id === undefined ? 'PR' : `PR #${answer.id}`;
      const state = answer.state === undefined ? '' : ` (${answer.state})`;
      this.activate(
        this.prItem,
        OPEN_PR_COMMAND,
        `Open ${label} in Bitbucket`,
        [`Open ${label}${state} in Bitbucket`, answer.url],
      );
    } else if (answer.kind === 'none') {
      this.prUrl = undefined;
      this.deactivate(this.prItem, 'No pull request for this branch', [
        'No pull request for this branch.',
        `Bitbucket has no pull request for '${branch}' in any state, so this button does nothing.`,
      ]);
    } else {
      this.prUrl = undefined;
      // The wording NEVER says "no PR". Nothing was ruled out; the lookup failed.
      this.deactivate(this.prItem, 'Pull-request lookup did not answer', [
        `Could not check for a pull request on '${branch}' — this does NOT mean there is none.`,
        answer.reason === undefined ? 'The lookup did not answer.' : `Reason: ${answer.reason}`,
        'Ghola retries on its own; the button activates as soon as a lookup succeeds.',
      ]);
    }
    this.prItem.show();
  }

  /**
   * Give an item a working command, the default foreground, and a tooltip. The
   * `color` is reset to `undefined` explicitly — an item that was inert on the
   * previous repaint is still carrying `disabledForeground`, and the whole
   * present-but-inert convention collapses if a re-activated button stays dim.
   */
  private activate(
    item: vscode.StatusBarItem,
    command: string,
    accessibleLabel: string,
    tooltipLines: readonly string[],
  ): void {
    item.command = command;
    item.color = undefined;
    item.tooltip = tooltipLines.join('\n');
    item.accessibilityInformation = { label: accessibleLabel };
  }

  /**
   * VS Code's closest thing to a disabled status-bar item: still visible, no
   * command at all so a click is genuinely inert (not "runs and silently does
   * nothing"), and dimmed with the theme's own `disabledForeground` so it reads as
   * unavailable in light and dark alike.
   */
  private deactivate(
    item: vscode.StatusBarItem,
    accessibleLabel: string,
    tooltipLines: readonly string[],
  ): void {
    item.command = undefined;
    item.color = new vscode.ThemeColor('disabledForeground');
    item.tooltip = tooltipLines.join('\n');
    item.accessibilityInformation = { label: accessibleLabel };
  }

  /**
   * Start a Bitbucket lookup only when the cached answer cannot serve this branch.
   *
   * THIS IS THE GATE THAT KEEPS THE REPAINT CLOCK FROM BECOMING A BITBUCKET POLL.
   * `refresh()` runs every 15 seconds and on every module/settings/config event; a
   * lookup runs only when the branch changed, or when the cached answer's own
   * per-kind lifetime expired. A `found` answer never expires — a PR's URL does not
   * change, in any state — so the steady state of a healthy ticket-work session is
   * exactly ONE Bitbucket call per branch.
   *
   * The in-flight guard is WALL-CLOCK BOUNDED rather than absolute: see
   * `PR_LOOKUP_MAX_INFLIGHT_MS` for why a lookup that never settles must not be
   * able to pin the button on its pending caption forever.
   */
  private maybeStartPrLookup(repoRoot: string | undefined, branch: string): void {
    if (repoRoot === undefined) return;
    if (this.prLookupInFlight && Date.now() - this.prLookupStartedAtMs < PR_LOOKUP_MAX_INFLIGHT_MS) {
      return;
    }
    const cached = this.prCache;
    if (cached !== undefined && cached.branch === branch) {
      const ageMs = Date.now() - cached.answeredAtMs;
      if (cached.answer.kind === 'found') return;
      if (cached.answer.kind === 'none' && ageMs < PR_ABSENT_RECHECK_MS) return;
      if (cached.answer.kind === 'unknown' && ageMs < PR_UNKNOWN_RECHECK_MS) return;
    }
    this.prLookupInFlight = true;
    this.prLookupStartedAtMs = Date.now();
    this.prLookupGeneration += 1;
    void this.runPrLookup(repoRoot, branch, this.prLookupGeneration);
  }

  /**
   * Resolve the slug, ask Bitbucket, cache whatever came back, repaint.
   *
   * The result is cached against the branch it was ASKED FOR, not against whatever
   * branch is checked out when it lands: a checkout during the round trip would
   * otherwise file an answer about the old branch under the new one, which is the
   * silent-wrong-URL failure in its purest form. The mismatched entry is simply
   * stale on the next repaint and is re-asked.
   *
   * `generation` is this call's identity. A lookup that outlived
   * `PR_LOOKUP_MAX_INFLIGHT_MS` and was superseded still runs to completion (it
   * cannot be cancelled), so it must not clear the in-flight flag that now
   * belongs to its successor — that write stays conditional on still being the
   * current generation.
   *
   * THE CACHE WRITE IS NOT CONDITIONAL ON THE SAME THING, AND THAT IS THE POINT.
   * It used to be, and the result was a livelock: whenever a healthy lookup took
   * longer than the in-flight bound (see `PR_LOOKUP_MAX_INFLIGHT_MS` for how the
   * old bound under-counted), every lookup was superseded before it settled and
   * every answer was then thrown away, so the button never left its pending
   * caption while still paying for a subprocess and a round trip per window. A
   * LATE ANSWER IS STILL AN ANSWER — with nothing newer filed it is the best
   * information the host has, and the alternative is showing nothing forever. So
   * the only thing that discards it is a STRICTLY NEWER answer already in the
   * cache, which is exactly the case where it would be a regression to write.
   *
   * That also covers the checkout-during-the-round-trip case unchanged: a newer
   * lookup for a newer branch has a higher generation, so its entry wins; and an
   * older branch's answer that does land is filed against the branch it ASKED
   * FOR, so `renderPr` reads it as a miss and re-asks on the next repaint.
   */
  private async runPrLookup(repoRoot: string, branch: string, generation: number): Promise<void> {
    let answer: PrLookupAnswer;
    try {
      const slug = repoSlugFromRemoteUrl(readOriginUrl(repoRoot));
      answer =
        slug === ''
          ? {
              kind: 'unknown',
              reason: "no 'origin' remote, so the Bitbucket repository slug is unknown",
            }
          : await this.findPrForBranch(slug, branch);
    } catch (error) {
      // `findPrForBranch` is contracted not to throw, so this is the last line of
      // defense rather than an expected path. A status bar must not be able to
      // leave an unhandled rejection in the extension host.
      answer = { kind: 'unknown', reason: error instanceof Error ? error.message : String(error) };
    } finally {
      if (this.prLookupGeneration === generation) this.prLookupInFlight = false;
    }
    if (this.disposed) return;
    // A strictly newer lookup has already filed its answer, so this one is stale
    // by construction and would be a downgrade to write. Anything else — current
    // generation, or superseded but first to answer — lands.
    if (this.prCache !== undefined && this.prCache.generation > generation) return;
    this.prCache = { branch, answeredAtMs: Date.now(), generation, answer };
    this.refresh();
  }

  /**
   * Begin watching for branch changes. IDEMPOTENT — `refresh()` calls it on every
   * paint and the timer's callback is `refresh()`, so a non-idempotent version
   * would multiply its own interval on every tick.
   */
  private startBranchTracking(): void {
    if (this.branchPollTimer !== undefined) return;
    this.branchPollTimer = setInterval(() => this.refresh(), BRANCH_POLL_INTERVAL_MS);
  }

  /** Stop the clock. Safe when nothing is running; leaves the field re-startable. */
  private stopBranchTracking(): void {
    if (this.branchPollTimer === undefined) return;
    clearInterval(this.branchPollTimer);
    this.branchPollTimer = undefined;
  }

  dispose(): void {
    // Set FIRST so a tick, or an in-flight lookup landing after this point, cannot
    // repaint a disposed item.
    this.disposed = true;
    this.stopBranchTracking();
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
    this.jiraItem.dispose();
    this.prItem.dispose();
  }
}
