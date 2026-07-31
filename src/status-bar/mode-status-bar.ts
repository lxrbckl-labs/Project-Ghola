import * as vscode from 'vscode';
import type { ModuleLoader } from '../modules/loader';
import { formatMode } from '../session/banner';
import {
  formatTokenCount,
  readStatuslineStateForDirectory,
  statuslineStateDir,
  type StatuslineStateSnapshot,
} from '../session/statusline-state';
import { resolveTeamIdentity, type TeamIdentity } from '../session/team-identity';

/**
 * Config key gating the status-bar item's visibility. Mirrors the
 * `ghola.statusBar.enabled` property contributed in package.json.
 */
const STATUS_BAR_CONFIG_SECTION = 'ghola.statusBar';
const STATUS_BAR_ENABLED_KEY = 'ghola.statusBar.enabled';

/**
 * The one delimiter used throughout the visible label — between the IDENTITY
 * and the metrics group, and between two metrics alike: U+00B7 MIDDLE DOT, one
 * space either side. An earlier revision used a distinct glyph (U+2502 BOX
 * DRAWINGS LIGHT VERTICAL) for the identity/metrics boundary, on the theory
 * that the identity is a heading over the metrics as its contents; the
 * operator asked for one delimiter throughout instead, so `cmms1@win · 34k ·
 * 5h 3%` now reads as a flat sequence of peers rather than a heading plus
 * contents.
 */
const LABEL_SEPARATOR = ' · ';

/**
 * How often the state file is re-read on a timer.
 *
 * THIS IS NOT REDUNDANT WITH THE FILE WATCHER AND MUST NOT BE "SIMPLIFIED" AWAY.
 * A watcher only ever reports that a file CHANGED. The transition this segment
 * most needs to notice is a file that STOPPED changing — a Claude Code session
 * that ended, crashed, or was closed — and a file that stops being written
 * generates no event at all. Without a clock, a dead session's numbers sit in
 * the pill looking live indefinitely, which is precisely the
 * authoritative-but-wrong failure the whole keyed-state design exists to
 * prevent. The timer is therefore the PRIMARY refresh and the watcher is an
 * accelerator, not the other way round — reinforced by the fact that the state
 * directory can live on a filesystem whose watch events are unreliable (see the
 * same concession for the ledger watchers in `extension.ts`).
 *
 * 15 seconds is a sixth of `STATE_STALE_AFTER_MS` (90s), so the pill is never
 * more than ~15s behind the truth, at a cost of one `readFileSync` of a
 * sub-kilobyte file.
 */
const STATE_POLL_INTERVAL_MS = 15_000;

/**
 * Debounce on state-directory watch events. Matches `loader.watchManifests` and
 * the War Room ledger watchers, and matters more here than there: every one of
 * the operator's 8+ concurrent sessions writes into this one directory, so an
 * undebounced watcher would re-render this window's pill on every other
 * window's render.
 */
const STATE_WATCH_DEBOUNCE_MS = 250;

/**
 * Friendly display names for each raw mode token produced by `formatMode`.
 * Status-bar-tooltip-only cosmetics: the banner/boot trace keep the
 * lowercase-hyphenated tokens, so this map lives here rather than in `banner.ts`.
 */
const MODE_DISPLAY_NAMES: Record<string, string> = {
  'ticket-work': 'Ticket Work',
  support: 'Support',
  cd: 'Project',
  'self-upgrade': 'Self Upgrade',
  sardaukar: 'Sardaukar',
  unconstrained: 'Unconstrained',
  war: 'War',
};

/**
 * Title-case an unknown hyphenated token defensively (e.g. a future mode):
 * `foo-bar` -> `Foo Bar`. Keeps the status bar from ever showing a raw
 * lowercase-hyphenated token.
 */
function titleCaseToken(token: string): string {
  return token
    .split('-')
    .map((word) => (word.length === 0 ? word : word[0].toUpperCase() + word.slice(1)))
    .join(' ');
}

/**
 * Map a raw `formatMode` string to a capitalized, human-friendly form for the
 * status-bar tooltip. Splits on ` + ` (retained in case a future caller feeds
 * this a war-combined string) so a trailing marker would map independently,
 * maps each token via `MODE_DISPLAY_NAMES` (falling back to `titleCaseToken`
 * for unknown tokens), then rejoins with ` + `. Examples: `ticket-work` ->
 * `Ticket Work`, `cd` -> `Project`, `foo-bar` -> `Foo Bar`.
 */
function prettyMode(raw: string): string {
  return raw
    .split(' + ')
    .map((token) => MODE_DISPLAY_NAMES[token] ?? titleCaseToken(token))
    .join(' + ');
}

/**
 * The label used when no switchboard identity can be resolved (no workspace
 * folder open, or a folder path with no basename). Just `Ghola` — with the
 * mode no longer in the visible text, a trailing `:` would have nothing left
 * to introduce.
 */
const NO_IDENTITY_LABEL = 'Ghola';

/**
 * One sentence explaining where the resolved identity came from, so an operator
 * who sees `cmms2@win` can discover from the tooltip that it is their Team
 * Switchboard name and why it carries an `@win`. Kept short deliberately — the
 * authority is `_AgentComms/_Switchboard.md`, not this string.
 */
function describeIdentity(identity: TeamIdentity): string {
  // An explicit override is the whole story: it is used verbatim, so describing
  // a strip or a qualifier would describe machinery that did not run. Name the
  // setting so the operator knows where the value came from, and disclose the
  // name they are overriding so a stale override is visible rather than silent.
  if (identity.overridden) {
    return (
      `Ghola team: ${identity.name} — set explicitly by the Team Switchboard ` +
      `'teamName' setting, used verbatim (auto-derived would be '${identity.teamName}').`
    );
  }
  // Say WHICH directory named the team. The repo root is the usual answer and is
  // what the roster records; the workspace folder appears only when no '.git'
  // was found at or above it.
  const source =
    identity.rootSource === 'git-root'
      ? `git repository root '${identity.basename}'`
      : `workspace folder '${identity.basename}' (no '.git' found above it)`;
  // Only claim the strip when it actually happened — a bare `cmms2`, and a
  // basename of exactly `Project-` (which keeps its name rather than strip to
  // nothing), must not be described as having had a prefix removed.
  const origin =
    identity.basename === identity.teamName ? source : `${source}, leading 'Project-' stripped`;
  // Three cases, not two: WSL is the incumbent and renders bare; another host
  // normally gains '@env'; and a host whose derived name ALREADY ends in a legal
  // qualifier keeps it rather than doubling it.
  const qualifier =
    identity.environment === 'wsl'
      ? 'this WSL host holds the unqualified name'
      : identity.qualified
        ? `'@${identity.environment}' marks this host, because the WSL clone holds the unqualified name`
        : "the name already carries its own '@' qualifier, so none was appended";
  const multiRoot =
    identity.folderCount > 1
      ? ` Multi-root workspace (${identity.folderCount} folders): the identity comes from the first.`
      : '';
  return `Ghola team: ${identity.name} — this window's Team Switchboard name, from ${origin}; ${qualifier}.${multiRoot}`;
}

/**
 * The metrics half of the visible label, INCLUDING its leading
 * `LABEL_SEPARATOR`, or `''` when there is nothing to show.
 *
 * `undefined` (no state key derivable) and `'stale'`/`'absent'` all render the
 * EMPTY STRING — no `—`, no `?`, and no separator either. That is a deliberate
 * choice about what an operator infers from a placeholder: a dash in a slot that
 * normally holds a number reads as "the readout is broken", whereas an absent
 * segment reads as "nothing is running here", and the second one is the truth.
 * It also matches the renderers' own documented degradation, which drops
 * segments rather than filling them.
 *
 * The two metrics are gated INDEPENDENTLY because they arrive from different
 * parts of the harness payload and neither implies the other: `five_hour_pct`
 * needs a Pro/Max `rate_limits` block and only exists after the session's first
 * API response, while `session_tokens` exists from the first render. Whichever
 * is present is shown; when neither is, the group and its separator vanish
 * together rather than leaving a dangling `·`.
 *
 * The token count goes through `formatTokenCount` — phase 1's port of the
 * renderers' `fmt_tokens` — and NOT through a local reimplementation, so the
 * pill and the terminal footer are incapable of disagreeing about one number.
 */
function formatMetricsSegment(snapshot: StatuslineStateSnapshot | undefined): string {
  if (snapshot === undefined || snapshot.status !== 'fresh') return '';
  const parts: string[] = [];
  if (snapshot.sessionTokens !== undefined) parts.push(formatTokenCount(snapshot.sessionTokens));
  if (snapshot.fiveHourPct !== undefined) parts.push(`5h ${snapshot.fiveHourPct}%`);
  if (parts.length === 0) return '';
  return `${LABEL_SEPARATOR}${parts.join(LABEL_SEPARATOR)}`;
}

/**
 * A coarse, human age: `12s`, `4m`, `3h`, `2d`. Floors at every tier and never
 * shows two units, because the only question the tooltip answers is "is this
 * number worth believing" and no precision beyond the leading unit changes the
 * answer.
 */
function formatSnapshotAge(ageMs: number): string {
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * The metric values in prose, for the tooltip. Includes `contextPct`, which the
 * visible label omits for want of horizontal room — the tooltip has room, and
 * the percentage is the more actionable of the two context figures. Each value
 * is gated on its own presence, exactly as in `formatMetricsSegment`.
 */
function describeMetricValues(snapshot: StatuslineStateSnapshot): string {
  const parts: string[] = [];
  if (snapshot.sessionTokens !== undefined) {
    parts.push(`${formatTokenCount(snapshot.sessionTokens)} context tokens`);
  }
  if (snapshot.contextPct !== undefined) parts.push(`${snapshot.contextPct}% of the context window`);
  if (snapshot.fiveHourPct !== undefined) parts.push(`${snapshot.fiveHourPct}% of the 5-hour window`);
  return parts.join(', ');
}

/**
 * The tooltip lines for the metrics, one per line so the file path gets a line
 * of its own rather than being buried mid-paragraph.
 *
 * THE DIAGNOSTIC LINE IS THE POINT OF THIS FUNCTION. The state key is computed
 * independently in three languages (here, `ghola-statusline.mjs`, and the
 * embedded Python in `ghola-statusline.sh`), and the failure mode of any drift
 * between them is SILENT: the writer writes one path, this reader reads another,
 * and the segment simply never appears. Naming the key and the exact file this
 * window is looking for turns that from an hour of guessing into one `ls`.
 */
function describeSessionMetrics(snapshot: StatuslineStateSnapshot | undefined): readonly string[] {
  // No key at all. There is no file path to name, so there is no diagnostic
  // line either — the reason IS the diagnosis.
  if (snapshot === undefined) {
    return [
      'Session metrics: unavailable — no workspace folder is open, so no session state key can be derived.',
    ];
  }
  const diagnostic = `State key: ${snapshot.key} — ${snapshot.filePath}`;
  if (snapshot.status === 'absent') {
    return [
      'Session metrics: none — no live Claude Code session has rendered a status line for this instance yet.',
      diagnostic,
    ];
  }
  const values = describeMetricValues(snapshot);
  if (snapshot.status === 'stale') {
    // No `ageMs` means the snapshot carried no usable `updated` field at all;
    // phase 1 classifies that as stale precisely because nothing can vouch for
    // its age, so say that rather than inventing a duration.
    const age =
      snapshot.ageMs === undefined
        ? 'timestamp missing'
        : `last seen ${formatSnapshotAge(snapshot.ageMs)} ago`;
    const trailer = values === '' ? '' : `; last known ${values}`;
    return [`Session metrics: ${age} (stale)${trailer}.`, diagnostic];
  }
  // Fresh but empty is reachable: a file written before the first API response
  // can hold nothing but `updated`.
  return [
    values === ''
      ? 'Session metrics: a fresh snapshot exists but carries no usable values yet.'
      : `Session metrics: ${values}.`,
    diagnostic,
  ];
}

/**
 * A native VS Code status-bar item showing WHICH Ghola instance this window is
 * (its Team Switchboard identity) — e.g. `cmms2@win`. The identity is the part
 * that discriminates: the operator runs 8+ windows across two hosts, and every
 * one of them on the same mode used to render a byte-identical label. Takes
 * the identity from `session/team-identity.ts` so it agrees with the name the
 * agent registers in the switchboard roster.
 *
 * The session mode (and War Mode) is no longer part of the visible text —
 * horizontal space in the bar is scarce and the mode is already shown in the
 * Ghola settings panel — but War Mode still gets a distinct `$(flame)` icon in
 * place of the org icon, and both the mode and an explicit War Mode statement
 * live in the tooltip. The War-Mode flag comes from an injected provider so it
 * agrees with the same `mode.war::enabled` source of truth the
 * composer/launcher gate off.
 *
 * After the identity comes this session's LIVE USAGE — the Claude Code context
 * size and the 5-hour rate-limit percentage — read from the per-repository state
 * file that `session/statusline-state.ts` defines and both statusline renderers
 * write. The key is derived from THIS window's workspace folder (its git root,
 * the same input that names the identity), never from the extension host's own
 * environment and never by picking up "whatever state file exists": in a fleet
 * of 8+ concurrent sessions, a segment that shows another window's numbers while
 * looking authoritative is worse than one that shows nothing.
 *
 * The item lives on the Left, near the workspace/branch context, and opens the
 * Ghola settings panel on click. Callers wire `refresh()` to loader changes,
 * module-settings changes, and the `ghola.statusBar` config toggle; the metrics
 * keep themselves current via this class's own watcher and timer.
 */
export class ModeStatusBarItem implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  /**
   * Watcher on `<homedir>/.ghola/statusline/state/*.json` — an ACCELERATOR on
   * top of `statePollTimer`, so the pill reacts within ~250ms of a render
   * instead of within 15s. Created lazily on the first enabled `refresh()` and
   * torn down whenever the item hides.
   */
  private stateWatcher: vscode.FileSystemWatcher | undefined;

  /** Pending debounce for `stateWatcher`; cleared on teardown so it cannot outlive it. */
  private stateWatchDebounce: ReturnType<typeof setTimeout> | undefined;

  /**
   * The PRIMARY refresh — see `STATE_POLL_INTERVAL_MS` for why a watcher alone
   * is insufficient. An interval that outlived its item would keep a whole
   * window's disposed status bar alive, so it is cleared both when the item
   * hides and in `dispose()`.
   */
  private statePollTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly loader: ModuleLoader,
    /**
     * Resolves the War-Mode flag from the same `mode.war::enabled`
     * module-setting the composer/launcher/banner read — passed in so this
     * class never invents its own war-detection path.
     */
    private readonly getWarMode: () => boolean,
    /**
     * Resolves the operator's `tool.team-switchboard::teamName` override, which
     * the module doc calls "the canonical team name for this session". Injected
     * for exactly the reason `getWarMode` is: the value lives in the
     * `globalState` Memento, reachable only via `readModuleSettings`, and
     * neither this class nor the pure `team-identity` module should reach into
     * extension state. `undefined` (or the empty default) means auto-derive.
     */
    private readonly getTeamNameOverride: () => string | undefined,
  ) {
    // Left alignment with a priority that places it near the workspace/branch
    // context on the left cluster. Higher priority = further left.
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'ghola.openSettings';
    this.item.name = 'Ghola';
    this.applyBackground();
  }

  /**
   * Give the item an amber pill. VS Code's `StatusBarItem.backgroundColor`
   * only accepts `statusBarItem.errorBackground` or `statusBarItem.warningBackground`
   * (arbitrary colors are rejected) — `warningBackground` is the amber one, which
   * is what the operator means by "yellow". Paired with `warningForeground` so
   * the text stays legible against the amber fill in both light and dark themes;
   * VS Code may still override the foreground itself to guarantee contrast, but
   * setting it explicitly keeps the intent visible here rather than relying on
   * that fallback. Called from the constructor and from every `refresh()` so the
   * styling can never be dropped by a future edit that reassigns `text` without
   * reasserting it.
   */
  private applyBackground(): void {
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
  }

  /**
   * Recompute the label, tooltip, and visibility from current loader/war state
   * and the `ghola.statusBar.enabled` config. Cheap and idempotent — safe to
   * call on every relevant event.
   */
  refresh(): void {
    const enabled = vscode.workspace
      .getConfiguration()
      .get<boolean>(STATUS_BAR_ENABLED_KEY, true);
    if (!enabled) {
      // A hidden item has nothing to keep current, and a 15s interval ticking
      // against an invisible pill is a leak the operator can neither see nor
      // stop. Tracking restarts on the next enabled refresh, which the
      // `ghola.statusBar` config subscription in `extension.ts` guarantees will
      // happen the moment the setting is turned back on.
      this.stopStateTracking();
      this.item.hide();
      return;
    }

    this.startStateTracking();
    this.applyBackground();

    const enabledModules = this.loader.getEnabled();
    const warMode = this.getWarMode();

    // `workspaceFolders` is `undefined` with no folder open and may hold several
    // in a multi-root workspace; `resolveTeamIdentity` owns the first-folder
    // decision, the walk up to the git repository root that actually names the
    // team, and returns `undefined` when there is nothing to derive from.
    const folders = vscode.workspace.workspaceFolders ?? [];
    const identity = resolveTeamIdentity(
      folders.map((folder) => folder.uri.fsPath),
      { teamNameOverride: this.getTeamNameOverride() },
    );

    // War Mode gets a distinct flame icon so it stands out at a glance; other
    // sessions use the org icon. This is now the ONLY war signal in the visible
    // text — the `+ War` suffix moved to the tooltip below.
    const icon = warMode ? '$(flame)' : '$(organization)';
    // Identity is the whole visible label now: the mode is genuinely useful but
    // is already shown in the Ghola settings panel, and the bar has no
    // horizontal room to spare. With no identity to show, fall back to the
    // historical `Ghola` label.
    const label = identity ? identity.name : NO_IDENTITY_LABEL;
    // The state key comes from the SAME `folders` array `resolveTeamIdentity`
    // just consumed — `resolveStateKeyRoot` walks to the git root with the very
    // same `findRepoRoot`, so the identity in this label and the metrics beside
    // it provably describe one repository. Deliberately NOT read from
    // `process.env.GHOLA_STATE_KEY`: the launcher exports that INTO session
    // terminals, and the extension host's own copy is either absent or, worse,
    // inherited from whichever terminal happened to launch this window.
    const snapshot = readStatuslineStateForDirectory(folders[0]?.uri.fsPath);
    this.item.text = `${icon} ${label}${formatMetricsSegment(snapshot)}`;
    const identityNote = identity
      ? describeIdentity(identity)
      : 'Ghola team: unknown — no workspace folder is open, so no Team Switchboard name can be derived.';
    // The mode moved out of the visible text but not out of existence — it and
    // an explicit War Mode statement live in the tooltip instead. War Mode is
    // spelled out (not just the flame icon) because it carries a CRITICAL
    // SAFETY floor forbidding all git writes, and that is not self-explanatory
    // to someone who has not memorized what the flame means.
    const warNote = warMode
      ? 'War Mode: ON — all git writes (commit, push, tag, etc.) are forbidden this session.'
      : 'War Mode: off.';
    // The metrics get their own line(s) rather than being appended to the
    // narrative, so the state file path — which is long, and is the one string
    // an operator diagnosing a missing segment needs to copy — is readable
    // instead of buried mid-paragraph.
    this.item.tooltip = [
      `${identityNote} Ghola mode: ${prettyMode(formatMode(enabledModules))}. ${warNote} Click to open Ghola settings.`,
      ...describeSessionMetrics(snapshot),
    ].join('\n');
    this.item.show();
  }

  /**
   * Begin keeping the metrics current. IDEMPOTENT — `refresh()` calls it on
   * every paint, and the timer's callback is `refresh()`, so a non-idempotent
   * version would multiply its own interval on every tick.
   *
   * BOTH mechanisms are required and they cover different transitions: the
   * watcher catches a render (fresh numbers arriving), the timer catches the
   * ABSENCE of renders (numbers going stale, which emits no event). See
   * `STATE_POLL_INTERVAL_MS`.
   *
   * The state directory is a fixed, global path, so the watcher is valid for the
   * life of the window even before the directory exists (the renderers
   * `mkdir -p` it on first write) and regardless of whether a workspace folder
   * is open — a folder added to an empty window is picked up by the next tick
   * without any extra subscription.
   */
  private startStateTracking(): void {
    if (this.statePollTimer === undefined) {
      this.statePollTimer = setInterval(() => this.refresh(), STATE_POLL_INTERVAL_MS);
    }
    if (this.stateWatcher !== undefined) return;
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(statuslineStateDir(), '*.json'),
    );
    const schedule = (): void => {
      if (this.stateWatchDebounce !== undefined) clearTimeout(this.stateWatchDebounce);
      this.stateWatchDebounce = setTimeout(() => {
        this.stateWatchDebounce = undefined;
        this.refresh();
      }, STATE_WATCH_DEBOUNCE_MS);
    };
    // The per-event disposables are intentionally dropped: disposing the watcher
    // disposes its own listeners, which is the pattern the ledger watchers in
    // `extension.ts` already follow.
    watcher.onDidCreate(schedule);
    watcher.onDidChange(schedule);
    watcher.onDidDelete(schedule);
    this.stateWatcher = watcher;
  }

  /**
   * Tear down every asynchronous thing this item owns. Called from `refresh()`
   * when the item hides and from `dispose()`; safe to call when nothing is
   * running, and leaves the fields `undefined` so `startStateTracking` can
   * cleanly re-establish them.
   */
  private stopStateTracking(): void {
    if (this.statePollTimer !== undefined) {
      clearInterval(this.statePollTimer);
      this.statePollTimer = undefined;
    }
    if (this.stateWatchDebounce !== undefined) {
      clearTimeout(this.stateWatchDebounce);
      this.stateWatchDebounce = undefined;
    }
    this.stateWatcher?.dispose();
    this.stateWatcher = undefined;
  }

  dispose(): void {
    // Before the item, so a debounce or a tick can never fire `refresh()`
    // against a disposed StatusBarItem.
    this.stopStateTracking();
    this.item.dispose();
  }
}

/** Config section this item cares about, for `onDidChangeConfiguration` filtering. */
export const MODE_STATUS_BAR_CONFIG_SECTION = STATUS_BAR_CONFIG_SECTION;
