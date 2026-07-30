import * as vscode from 'vscode';
import type { ModuleLoader } from '../modules/loader';
import { formatMode } from '../session/banner';
import { resolveTeamIdentity, type TeamIdentity } from '../session/team-identity';

/**
 * Config key gating the status-bar item's visibility. Mirrors the
 * `ghola.statusBar.enabled` property contributed in package.json.
 */
const STATUS_BAR_CONFIG_SECTION = 'ghola.statusBar';
const STATUS_BAR_ENABLED_KEY = 'ghola.statusBar.enabled';

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
 * The item lives on the Left, near the workspace/branch context, and opens the
 * Ghola settings panel on click. Callers wire `refresh()` to loader changes,
 * module-settings changes, and the `ghola.statusBar` config toggle.
 */
export class ModeStatusBarItem implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

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
      this.item.hide();
      return;
    }

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
    this.item.text = `${icon} ${label}`;
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
    this.item.tooltip = `${identityNote} Ghola mode: ${prettyMode(formatMode(enabledModules))}. ${warNote} Click to open Ghola settings.`;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}

/** Config section this item cares about, for `onDidChangeConfiguration` filtering. */
export const MODE_STATUS_BAR_CONFIG_SECTION = STATUS_BAR_CONFIG_SECTION;
