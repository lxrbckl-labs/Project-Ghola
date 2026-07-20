import type * as vscode from 'vscode';
import { WORKSPACE_STATE_KEYS } from '../state/keys';

export class ModuleState {
  constructor(private readonly memento: vscode.Memento) {}

  getEnabledIds(): string[] {
    const raw = this.memento.get<string[]>(WORKSPACE_STATE_KEYS.ENABLED_MODULES, []);
    return Array.isArray(raw) ? [...raw] : [];
  }

  async setEnabledIds(ids: string[]): Promise<void> {
    const unique = Array.from(new Set(ids));
    await this.memento.update(WORKSPACE_STATE_KEYS.ENABLED_MODULES, unique);
    await this.memento.update(WORKSPACE_STATE_KEYS.ENABLED_MODULES_INITIALIZED, true);
  }

  async enable(id: string): Promise<void> {
    const current = new Set(this.getEnabledIds());
    current.add(id);
    await this.setEnabledIds([...current]);
  }

  async disable(id: string): Promise<void> {
    const current = new Set(this.getEnabledIds());
    current.delete(id);
    await this.setEnabledIds([...current]);
  }

  isEnabled(id: string): boolean {
    return this.getEnabledIds().includes(id);
  }

  /** True the first time the loader runs in a workspace (defaults can be applied). */
  isFirstRun(): boolean {
    return this.memento.get<boolean>(WORKSPACE_STATE_KEYS.ENABLED_MODULES_INITIALIZED, false) === false;
  }
}

/** Module id backfilled by `migrateCommitPushEnabled`. */
const COMMIT_PUSH_MODULE_ID = 'tool.commit-push';

/**
 * One-time migration: add `tool.commit-push` to the stored enabled-modules list
 * of a workspace that was ALREADY initialized before the module joined
 * DEFAULT_ENABLED_IDS.
 *
 * Why this is needed: DEFAULT_ENABLED_IDS is consulted only on a workspace's
 * FIRST run (see `ModuleLoader.discover`: `seenFirstRun && defaultEnabled
 * .includes(id)`), and `isFirstRun()` flips false permanently on the first
 * `setEnabledIds`. `tool.commit-push` was added to the defaults in v0.18.5
 * (d2f4858), so every workspace initialized on an earlier Ghola silently lacks
 * it forever — the Source Control title-bar wand button never appears and the
 * operator has to discover and toggle the module by hand, per repo.
 *
 * Deliberate-opt-out limitation — READ THIS BEFORE CHANGING ANYTHING: the
 * stored representation is a plain enabled-id ARRAY with no negative entries
 * and no version stamp, so "this workspace predates the default" and "the
 * operator deliberately unticked it" are byte-for-byte identical states. They
 * genuinely cannot be told apart. The conservatism we can actually offer is
 * therefore temporal, matching `migrateGitBranchCommandsEnabled`: the
 * persisted marker makes this run at most ONCE per workspace, so an operator
 * who unticks `tool.commit-push` after this version keeps it unticked through
 * every later update, reload, and activation. The single unavoidable cost is
 * one re-enable for someone who had already opted out before upgrading — a
 * one-click undo, weighed against a permanently missing button.
 *
 * Two further guards narrow that cost: a first-run workspace is skipped
 * outright (the defaults already cover it), and an EMPTY stored list is
 * skipped because the loader persists first-run state "even if empty" so that
 * toggling every module off is honored — an empty list is an unambiguous
 * deliberate all-off state, and adding to it would be plainly wrong.
 *
 * Additive-only: it never removes or reorders an existing id. If the module is
 * not present on disk, `discover()`'s stale-id prune drops the added id again
 * on the same activation, so the backfill cannot leave an orphan behind.
 *
 * Never throws — activation must not depend on it.
 */
export async function migrateCommitPushEnabled(
  state: ModuleState,
  workspaceState: vscode.Memento,
  logger: vscode.OutputChannel,
): Promise<void> {
  try {
    if (workspaceState.get<boolean>(WORKSPACE_STATE_KEYS.COMMIT_PUSH_BACKFILL_MIGRATION) === true) {
      return; // already run once in this workspace - respect any later opt-out
    }
    const outcome = await backfillCommitPushEnabled(state);
    // Marked on EVERY non-throwing path, including the no-ops, so the migration
    // can never re-run and re-enable a module the operator has since turned off.
    await workspaceState.update(WORKSPACE_STATE_KEYS.COMMIT_PUSH_BACKFILL_MIGRATION, true);
    logger.appendLine(`[ghola] commit-push backfill migration: ${outcome}`);
  } catch (err) {
    // Marker intentionally NOT set: a failed run is allowed to retry on the
    // next activation.
    logger.appendLine(`[ghola] commit-push backfill migration failed (non-fatal): ${err}`);
  }
}

/**
 * Perform the backfill. Returns a human-readable description of what happened
 * for the caller to log. Every return path is a legitimate outcome; problems
 * are signalled by throwing, which the caller catches.
 */
async function backfillCommitPushEnabled(state: ModuleState): Promise<string> {
  if (state.isFirstRun()) {
    // Nothing stored yet. DEFAULT_ENABLED_IDS is about to be applied by
    // discover() and already contains the module; writing here would flip
    // ENABLED_MODULES_INITIALIZED early and suppress every other default.
    return 'no-op (first run; DEFAULT_ENABLED_IDS already covers tool.commit-push)';
  }
  const current = state.getEnabledIds();
  if (current.length === 0) {
    return 'no-op (stored enabled list is empty; treating it as a deliberate all-off state)';
  }
  if (current.includes(COMMIT_PUSH_MODULE_ID)) {
    return 'no-op (tool.commit-push already enabled)';
  }
  await state.setEnabledIds([...current, COMMIT_PUSH_MODULE_ID]);
  return 'enabled tool.commit-push (workspace was initialized before it joined the defaults)';
}
