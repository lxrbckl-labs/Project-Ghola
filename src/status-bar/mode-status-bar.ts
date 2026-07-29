import * as vscode from 'vscode';
import type { ModuleLoader } from '../modules/loader';
import { formatMode, formatModeWithWar } from '../session/banner';
import { resolveTeamIdentity, type TeamIdentity } from '../session/team-identity';

/**
 * Config key gating the status-bar item's visibility. Mirrors the
 * `ghola.statusBar.enabled` property contributed in package.json.
 */
const STATUS_BAR_CONFIG_SECTION = 'ghola.statusBar';
const STATUS_BAR_ENABLED_KEY = 'ghola.statusBar.enabled';

/**
 * Friendly display names for each raw mode token produced by
 * `formatModeWithWar`. Status-bar-only cosmetics: the banner/boot trace keep the
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
 * Map a raw `formatModeWithWar` string to a capitalized, human-friendly form for
 * the status bar ONLY. Splits on ` + ` so a trailing ` + war` marker is mapped
 * independently, maps each token via `MODE_DISPLAY_NAMES` (falling back to
 * `titleCaseToken` for unknown tokens), then rejoins with ` + `. Examples:
 * `ticket-work` -> `Ticket Work`, `ticket-work + war` -> `Ticket Work + War`,
 * `cd` -> `Project`, `foo-bar` -> `Foo Bar`.
 */
function prettyMode(raw: string): string {
  return raw
    .split(' + ')
    .map((token) => MODE_DISPLAY_NAMES[token] ?? titleCaseToken(token))
    .join(' + ');
}

/**
 * Separator between the instance identity and the mode. Matches the ` · `
 * already used across the settings-panel webview's meta lines, so the status bar
 * reads like the rest of Ghola's UI.
 */
const LABEL_SEPARATOR = ' · ';

/**
 * The label used when no switchboard identity can be resolved (no workspace
 * folder open, or a folder path with no basename). Preserves the pre-identity
 * label exactly, so the degraded case is the historical one rather than an empty
 * or `undefined` identity.
 */
const NO_IDENTITY_PREFIX = 'Ghola:';

/**
 * One sentence explaining where the resolved identity came from, so an operator
 * who sees `cmms2@win` can discover from the tooltip that it is their Team
 * Switchboard name and why it carries an `@win`. Kept short deliberately — the
 * authority is `_AgentComms/_Switchboard.md`, not this string.
 */
function describeIdentity(identity: TeamIdentity): string {
  // Only claim the strip when it actually happened — a bare `cmms2`, and a
  // basename of exactly `Project-` (which keeps its name rather than strip to
  // nothing), must not be described as having had a prefix removed.
  const origin =
    identity.basename === identity.teamName
      ? `workspace folder '${identity.basename}'`
      : `workspace folder '${identity.basename}', leading 'Project-' stripped`;
  const qualifier = identity.qualified
    ? `'@${identity.environment}' marks this host, because the WSL clone holds the unqualified name`
    : 'this WSL host holds the unqualified name';
  const multiRoot =
    identity.folderCount > 1
      ? ` Multi-root workspace (${identity.folderCount} folders): the identity comes from the first.`
      : '';
  return `Ghola team: ${identity.name} — this window's Team Switchboard name, from ${origin}; ${qualifier}.${multiRoot}`;
}

/**
 * A native VS Code status-bar item showing WHICH Ghola instance this window is
 * (its Team Switchboard identity) plus the current session modality (mode) and
 * whether War Mode is active — e.g. `cmms2@win · Ticket Work + War`. The
 * identity is the part that discriminates: the operator runs 8+ windows across
 * two hosts, and every one of them on the same mode used to render a
 * byte-identical label. It reuses the banner's `formatModeWithWar` so the mode
 * half matches the launch banner and the composer byte-for-byte, takes the
 * War-Mode flag from an injected provider so it agrees with the same
 * `mode.war::enabled` source of truth the composer/launcher gate off, and takes
 * the identity from `session/team-identity.ts` so it agrees with the name the
 * agent registers in the switchboard roster.
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
  ) {
    // Left alignment with a priority that places it near the workspace/branch
    // context on the left cluster. Higher priority = further left.
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'ghola.openSettings';
    this.item.name = 'Ghola Mode';
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

    const enabledModules = this.loader.getEnabled();
    const warMode = this.getWarMode();
    const modeLabel = formatModeWithWar(enabledModules, warMode);

    // `workspaceFolders` is `undefined` with no folder open and may hold several
    // in a multi-root workspace; `resolveTeamIdentity` owns the first-folder
    // decision and returns `undefined` when there is nothing to derive from.
    const folders = vscode.workspace.workspaceFolders ?? [];
    const identity = resolveTeamIdentity(folders.map((folder) => folder.uri.fsPath));

    // War Mode gets a distinct flame icon so it stands out at a glance; other
    // sessions use the org icon. The `+ war` suffix is already in `modeLabel`.
    const icon = warMode ? '$(flame)' : '$(organization)';
    // Identity FIRST, because that is what distinguishes this window from the
    // other seven; the mode follows because it is genuinely useful. With no
    // identity to show, fall back to the historical `Ghola: <mode>` label.
    const prefix = identity ? `${identity.name}${LABEL_SEPARATOR}` : `${NO_IDENTITY_PREFIX} `;
    this.item.text = `${icon} ${prefix}${prettyMode(modeLabel)}`;
    const identityNote = identity
      ? describeIdentity(identity)
      : 'Ghola team: unknown — no workspace folder is open, so no Team Switchboard name can be derived.';
    this.item.tooltip = `${identityNote} Ghola mode: ${formatMode(enabledModules)}. War Mode: ${
      warMode ? 'on' : 'off'
    }. Click to open Ghola settings.`;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}

/** Config section this item cares about, for `onDidChangeConfiguration` filtering. */
export const MODE_STATUS_BAR_CONFIG_SECTION = STATUS_BAR_CONFIG_SECTION;
