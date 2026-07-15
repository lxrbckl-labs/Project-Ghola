import * as vscode from 'vscode';
import type { ModuleLoader } from '../modules/loader';
import { formatMode, formatModeWithWar } from '../session/banner';

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
 * A native VS Code status-bar item showing the current Ghola session modality
 * (mode) and whether War Mode is active — e.g. `Ghola: ticket-work + war`. It
 * reuses the banner's `formatModeWithWar` so the label matches the launch
 * banner and the composer byte-for-byte, and takes the War-Mode flag from an
 * injected provider so it agrees with the same `mode.war::enabled` source of
 * truth the composer/launcher gate off.
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

    // War Mode gets a distinct flame icon so it stands out at a glance; other
    // sessions use the org icon. The `+ war` suffix is already in `modeLabel`.
    const icon = warMode ? '$(flame)' : '$(organization)';
    this.item.text = `${icon} Ghola: ${prettyMode(modeLabel)}`;
    this.item.tooltip = `Ghola mode: ${formatMode(enabledModules)}. War Mode: ${
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
