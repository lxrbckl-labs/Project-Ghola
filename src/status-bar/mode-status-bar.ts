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
 * The delimiter between PEER segments of the visible label — between this
 * window's IDENTITY and the session MODALITY, between the modality and the
 * metrics group, and between two metrics alike: U+00B7 MIDDLE DOT, one space
 * either side. An earlier revision used a distinct glyph (U+2502 BOX DRAWINGS
 * LIGHT VERTICAL) for the boundary before the metrics, on the theory that the
 * label's lead-in is a heading over the metrics as its contents; the operator
 * asked for one delimiter throughout instead, so everything after the product
 * name reads as a flat sequence of peers rather than a heading plus contents.
 *
 * The `Ghola` lead-in is the one thing not joined with this — see
 * `PRODUCT_SEPARATOR`.
 */
const LABEL_SEPARATOR = ' · ';

/**
 * The literal the visible label always leads with: the PRODUCT name, on every
 * host and in every repository.
 *
 * It is NOT this window's Team Switchboard identity and must never be conflated
 * with it. The two are now BOTH in the label and they say different things: this
 * literal names the product (always `Ghola`), and the first `LABEL_SEPARATOR`-
 * joined segment after it names the instance (`cmms2@win`) — see
 * `formatIdentitySegment`. An earlier revision made the identity itself the
 * lead-in, so this repo's window read `Ghola` and a native-Windows cmms clone read
 * `cmms2@win` with no product name anywhere; the operator asked instead for the
 * product name to stay put and the identity to be inserted after it, which is the
 * shape below.
 */
const PRODUCT_LABEL = 'Ghola';

/**
 * The delimiter between the product name and everything that describes this
 * window: a colon and one space, giving
 * `Ghola: cmms2@win · Ticket Work · 34k · 5h 3%`.
 *
 * This is the ONE boundary in the label that is not between peers, which is why
 * it does not use `LABEL_SEPARATOR`: `Ghola` names the product and what follows
 * says which instance this is and what it is currently for, so the name
 * introduces that description rather than standing beside it. Exactly one of
 * these appears in any label, and it is never conditional: the left side is a
 * literal, and while the identity segment on the right can be absent, the
 * modality behind it never is (see `refresh`), so something always follows the
 * colon.
 */
const PRODUCT_SEPARATOR = ': ';

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
 * Status-bar cosmetics for BOTH of this file's surfaces: the banner/boot trace
 * keep the lowercase-hyphenated tokens, so this map lives here rather than in
 * `banner.ts`. An earlier revision rendered the raw token in the VISIBLE LABEL and
 * the display form in the tooltip only; the operator asked for the display form in
 * the pill too, so that casing split is gone and both surfaces go through
 * `prettyMode`. This is the ONE such mapping in the tree — a second copy for the
 * label is exactly what must not be added, because two maps drift.
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
 * Delimiter between mode tokens in a `formatMode`-produced string, captured
 * (not just matched) so the exact delimiter text — and which of the two forms
 * it was — survives the split alongside the tokens; see `prettyMode`.
 *
 * `formatMode` (`banner.ts`) only ever joins multiple enabled `mode.*` modules
 * with `', '`, but `formatModeWithWar` can append `' + war'` on top of an
 * ALREADY comma-joined base (e.g. `'ticket-work, support + war'`), so a string
 * reaching `prettyMode` can carry both delimiters at once. Recognizing them
 * independently, rather than assuming a session ever uses only one, is what
 * this exists for.
 */
const MODE_TOKEN_DELIMITER = /(,\s*|\s\+\s)/;

/**
 * Map a raw `formatMode` string to a capitalized, human-friendly form for the
 * status bar — used by the visible LABEL and the TOOLTIP alike, from a single call
 * in `refresh`, so the two can never spell the modality differently. Splits on
 * `MODE_TOKEN_DELIMITER` — both the `', '` `formatMode` itself produces and the
 * `' + '` a war-combined string adds — so a multi-mode string maps EVERY token,
 * not just the first; maps each token via `MODE_DISPLAY_NAMES` (falling back to
 * `titleCaseToken` for unknown tokens); then rejoins using the delimiter text
 * captured at each split point, so a `', '`-joined input comes back `', '`-joined
 * and a `' + '`-joined input comes back `' + '`-joined rather than the two forms
 * being normalized into one. Examples: `ticket-work` -> `Ticket Work`, `cd` ->
 * `Project`, `foo-bar` -> `Foo Bar`, `ticket-work, support` ->
 * `Ticket Work, Support`.
 */
function prettyMode(raw: string): string {
  // `String.split` with ONE capturing group returns tokens and delimiters
  // interleaved (token, delimiter, token, delimiter, ..., token), so even
  // indices are text to map and odd indices are the delimiter to pass through
  // unchanged — that alternation is what lets each delimiter occurrence keep
  // its own original text instead of every gap being normalized to one form.
  return raw
    .split(MODE_TOKEN_DELIMITER)
    .map((piece, index) => (index % 2 === 0 ? MODE_DISPLAY_NAMES[piece] ?? titleCaseToken(piece) : piece))
    .join('');
}

/**
 * One sentence NAMING the resolved identity and explaining where it came from, so
 * an operator can learn on one hover which of their windows this is, that the name
 * is their Team Switchboard name, and why it carries an `@win`. The label now
 * shows the name too (see `formatIdentitySegment`), so this line no longer has to
 * be the only place the identity appears — but it is still the ONLY place the
 * DERIVATION is explained, which is the part a bare name on a pill cannot convey,
 * so it must not be shortened to a gloss now that it has company. Still
 * deliberately one sentence, though: the authority is
 * `_AgentComms/_Switchboard.md`, not this string.
 */
function describeIdentity(identity: TeamIdentity): string {
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
 * The identity segment of the visible label — this window's Team Switchboard name
 * followed by its TRAILING `LABEL_SEPARATOR` — or `''` when no identity resolves.
 *
 * THE SEPARATOR TRAILS HERE where `formatMetricsSegment`'s leads, and the side is
 * not arbitrary: an optional segment must carry its separator on the side facing
 * an UNCONDITIONAL neighbour, or dropping the segment strands a `·`. The metrics
 * sit after the modality, so their separator leads; the identity sits before the
 * modality — which is never absent (see `refresh`) — so its separator trails.
 * Either way the segment and its separator vanish as one unit, which is what makes
 * every present/absent combination separator-clean.
 *
 * NOTHING IS RENDERED WHEN NOTHING RESOLVES, and in particular there is NO
 * `'Ghola'` FALLBACK. One existed while the identity was the label's lead-in, and
 * it must not come back now that the literal product name precedes this segment:
 * `Project-Ghola` strips to `Ghola` (see `deriveTeamName`), so a `Ghola` fallback
 * would render `Ghola: Ghola · ...` — byte-identical to the genuine label of THIS
 * repo's window. A window with no folder open would then be indistinguishable from
 * the one repository whose real derived name it had borrowed, which is worse than
 * showing no name at all. Omitting the segment says "nothing could be derived"
 * without asserting a false name, and matches how the metrics already degrade.
 * `describeIdentity`'s absent-identity counterpart in `refresh` says so in words,
 * where there is room to explain why.
 */
function formatIdentitySegment(identity: TeamIdentity | undefined): string {
  if (identity === undefined) return '';
  return `${identity.name}${LABEL_SEPARATOR}`;
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
 * The separator that attaches this group to what precedes it is this function's
 * own PREFIX — owned by the group as a whole, never by either metric — which is
 * the same "an optional segment owns the separator on the side facing an
 * unconditional neighbour" rule `formatIdentitySegment` follows in the mirror
 * direction, and mirrors the renderers' rule besides. So dropping a metric cannot
 * leave a doubled, leading, or trailing separator behind: one metric emits no
 * inner `·` at all, and zero metrics take the prefix with them.
 *
 * The token count goes through `formatTokenCount` and NOT through a local
 * reimplementation. That function is now the ONLY `k`/`M` abbreviation rule left
 * in the tree — the renderers' `fmt_tokens`/`fmtTokens` were deleted when the
 * terminal footer stopped printing a token segment — so this pill is the one
 * surface that renders an absolute token figure, and `contextPct` is left to the
 * tooltip, which has the room to say what the percentage is OF.
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
 * The metric values in prose, for the tooltip. Leads with the same absolute token
 * figure the visible label already shows, then adds `contextPct`, which the label
 * omits for want of horizontal room — the tooltip has room, and the percentage is
 * the more actionable of the two context figures. Each value is gated on its own
 * presence, exactly as in `formatMetricsSegment`.
 *
 * Returns `''` when no metric survived; every caller handles that case explicitly
 * rather than rendering an empty clause.
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
  // can hold nothing but `updated`. "No usable values" is exact rather than loose
  // — every metric this tooltip can print is gated in `describeMetricValues`, so
  // an empty `values` means the snapshot carried no token figure AND neither
  // percentage, not merely that one preferred field was missing.
  return [
    values === ''
      ? 'Session metrics: a fresh snapshot exists but carries no usable values yet.'
      : `Session metrics: ${values}.`,
    diagnostic,
  ];
}

/**
 * A native VS Code status-bar item naming the product, WHICH INSTANCE this window
 * is, and what this session is FOR —
 * `$(organization) Ghola: cmms2@win · Ticket Work · 34k · 5h 55%`.
 *
 * The lead-in is the LITERAL product name (`PRODUCT_LABEL`), byte-identical on
 * every host and in every repository.
 *
 * Immediately after it, as the first `LABEL_SEPARATOR`-joined segment, comes this
 * window's Team Switchboard IDENTITY (`Ghola` here, `cmms2@win` on a
 * native-Windows cmms clone), resolved from `session/team-identity.ts` so it agrees
 * with the name the agent registers in the switchboard roster. It is what makes the
 * pill discriminating: the operator runs 8+ windows across two hosts, and without
 * it every window on the same mode renders an identical label. An earlier revision
 * had the identity REPLACE the product name; this shape keeps both, so the pill
 * says what it is and which one it is. When no identity resolves the segment is
 * omitted outright rather than filled with a placeholder — see
 * `formatIdentitySegment` for why a `Ghola` fallback specifically is a collision
 * and not a convenience.
 *
 * Then comes this session's MODALITY — the
 * `ticket-work`/`support`/`cd`/`self-upgrade`/`unconstrained` vocabulary from
 * `formatMode`, display-cased through `prettyMode` (`Ticket Work`, `Project`).
 * Unlike the identity and the metrics it is never absent: it comes from the enabled
 * modules in this extension host, not from a file another process may or may not
 * have written and not from a workspace folder that may not be open, so
 * `Ghola: <modality>` is the label's irreducible core and every other segment is
 * optional around it.
 *
 * War Mode is NOT spelled out in the visible text — it gets a distinct `$(flame)`
 * icon in place of the org icon, and an explicit statement in the tooltip, which
 * is where there is room to say what it forbids. The War-Mode flag comes from an
 * injected provider so it agrees with the same `mode.war::enabled` source of
 * truth the composer/launcher gate off.
 *
 * After the modality comes this session's LIVE USAGE — the Claude Code context
 * size and the 5-hour rate-limit percentage — read from the per-repository state
 * file that `session/statusline-state.ts` defines and both statusline renderers
 * write. The key is derived from THIS window's workspace folder (its git root, the
 * same input that names the identity beside it), never from the extension
 * host's own environment and never by picking up "whatever state file exists": in
 * a fleet of 8+ concurrent sessions, a segment that shows another window's numbers
 * while looking authoritative is worse than one that shows nothing.
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
    // team, and returns `undefined` when there is nothing to derive from. ONE
    // resolution feeds BOTH surfaces — the label segment below and the tooltip's
    // explanation of it — so the pill can never name one instance while its hover
    // explains another.
    const folders = vscode.workspace.workspaceFolders ?? [];
    const identity = resolveTeamIdentity(folders.map((folder) => folder.uri.fsPath));

    // War Mode gets a distinct flame icon so it stands out at a glance; other
    // sessions use the org icon. This is the ONLY war signal in the visible text
    // — the `+ war` suffix `formatModeWithWar` would add is deliberately not used
    // here, so the modality segment stays one token wide and the flame is not
    // said twice.
    const icon = warMode ? '$(flame)' : '$(organization)';
    // The DISPLAY-CASED modality (`Ticket Work`, `Project`), not the raw
    // lowercase-hyphenated `formatMode` token the banner, the boot trace,
    // `GHOLA_MODE`, and the module ids speak: an earlier revision put the raw token
    // in the pill so it would be greppable, and the operator asked for the readable
    // form the tooltip already showed. Cased ONCE, through the single
    // `prettyMode`/`MODE_DISPLAY_NAMES` mapping, and shared with the tooltip below,
    // so there is no second mapping to drift and the two surfaces cannot name
    // different modes.
    const modeDisplay = prettyMode(formatMode(enabledModules));
    // The state key comes from the SAME `folders` array `resolveTeamIdentity`
    // just consumed — `resolveStateKeyRoot` walks to the git root with the very
    // same `findRepoRoot`, so the identity in this label and the metrics beside
    // it provably describe one repository. Deliberately NOT read from
    // `process.env.GHOLA_STATE_KEY`: the launcher exports that INTO session
    // terminals, and the extension host's own copy is either absent or, worse,
    // inherited from whichever terminal happened to launch this window.
    const snapshot = readStatuslineStateForDirectory(folders[0]?.uri.fsPath);
    // `<icon> Ghola: <modality>` is the unconditional core — a literal and a
    // modality that is never absent — and the two optional groups attach to it from
    // opposite sides, each owning the separator that joins it: the identity segment
    // brings its own TRAILING `LABEL_SEPARATOR` or is the empty string, the metrics
    // segment brings its own LEADING one or is the empty string. So nothing here
    // needs to know which neighbours are present, and no separator is ever left
    // dangling — not with no folder open, not with nothing running, not with both.
    this.item.text =
      `${icon} ${PRODUCT_LABEL}${PRODUCT_SEPARATOR}${formatIdentitySegment(identity)}` +
      `${modeDisplay}${formatMetricsSegment(snapshot)}`;
    // The no-identity branch is where the tooltip EARNS the label's silence: the
    // label expresses "nothing could be derived" by omitting its segment, which is
    // unambiguous but says nothing about why, and this sentence is where the reason
    // lives. Keep the two consistent — a placeholder in the label would make this
    // line contradict it.
    const identityNote = identity
      ? describeIdentity(identity)
      : 'Ghola team: unknown — no workspace folder is open, so no Team Switchboard name can be derived.';
    // War Mode is spelled out (not just the flame icon) because it carries a
    // CRITICAL SAFETY floor forbidding all git writes, and that is not
    // self-explanatory to someone who has not memorized what the flame means.
    const warNote = warMode
      ? 'War Mode: ON — all git writes (commit, push, tag, etc.) are forbidden this session.'
      : 'War Mode: off.';
    // The metrics get their own line(s) rather than being appended to the
    // narrative, so the state file path — which is long, and is the one string
    // an operator diagnosing a missing segment needs to copy — is readable
    // instead of buried mid-paragraph.
    // The mode line is KEPT even though the label now shows the very same
    // display-cased string, for the same reason `describeMetricValues` re-states the
    // token figure the label already shows: this tooltip is deliberately a COMPLETE
    // account of the window — which instance it is, what it is for, what it is
    // using — and a complete account that drops the modality because it happens to
    // be legible elsewhere stops standing on its own. It is no longer a GLOSS of an
    // opaque token (`cd` -> `Project`); that justification died with the raw token
    // in the label, and the honest one is redundancy for the sake of a self-contained
    // readout. The same argument now covers the identity line, which the label also
    // duplicates: the pill NAMES the instance, this tooltip EXPLAINS the name, and
    // neither is a reason to drop the other.
    this.item.tooltip = [
      `${identityNote} Ghola mode: ${modeDisplay}. ${warNote} Click to open Ghola settings.`,
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
