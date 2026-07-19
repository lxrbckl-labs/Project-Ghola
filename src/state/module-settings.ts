import * as vscode from 'vscode';
import { WORKSPACE_STATE_KEYS } from './keys';

/**
 * Centralized access to the flat `moduleId::fieldKey` module-settings map.
 *
 * Historically this map lived in `workspaceState` (per-workspace), which meant
 * every field value — Atlassian email, Obsidian vault path, operator persona,
 * PR-reply instructions, etc. — had to be re-entered in each workspace and was
 * wiped whenever a configuration preset was applied. As of the global-settings
 * change the map lives in `globalState`, so those field values are entered ONCE
 * and follow the operator across every workspace on this machine.
 *
 * Scope note: this covers module field VALUES only. Module ENABLEMENT (the
 * presets/configurations system) intentionally stays per-workspace so different
 * repos can still light up different module sets. Tokens are unaffected — they
 * live in SecretStorage, which is already global.
 *
 * The same key string is reused across both stores; `globalState` and
 * `workspaceState` are separate Memento namespaces, so there is no collision.
 */
const MODULE_SETTINGS_KEY = WORKSPACE_STATE_KEYS.MODULE_SETTINGS;

/**
 * The effective module-settings map. `globalState` is the source of truth; any
 * not-yet-migrated per-workspace value is used only as a fallback (global wins
 * on any overlap), so reads stay correct even before `migrateModuleSettingsToGlobal`
 * has run for a given workspace.
 */
export function readModuleSettings(
  globalState: vscode.Memento,
  workspaceState: vscode.Memento,
): Record<string, unknown> {
  const legacy = workspaceState.get<Record<string, unknown>>(MODULE_SETTINGS_KEY, {});
  const global = globalState.get<Record<string, unknown>>(MODULE_SETTINGS_KEY, {});
  return { ...legacy, ...global };
}

/** Persist the full module-settings map GLOBALLY. */
export async function writeModuleSettings(
  globalState: vscode.Memento,
  values: Record<string, unknown>,
): Promise<void> {
  await globalState.update(MODULE_SETTINGS_KEY, values);
}

/**
 * One-time, idempotent migration: fold any legacy per-workspace settings into
 * the global store (fill-if-absent, so an older per-workspace value never
 * clobbers a value the operator has already set globally), then clear the
 * per-workspace copy so global becomes the sole source of truth. A no-op once
 * the workspace copy is gone.
 */
export async function migrateModuleSettingsToGlobal(
  globalState: vscode.Memento,
  workspaceState: vscode.Memento,
): Promise<void> {
  const legacy = workspaceState.get<Record<string, unknown>>(MODULE_SETTINGS_KEY);
  if (legacy === undefined) return; // already migrated / nothing stored
  const global = globalState.get<Record<string, unknown>>(MODULE_SETTINGS_KEY, {});
  await globalState.update(MODULE_SETTINGS_KEY, { ...legacy, ...global });
  await workspaceState.update(MODULE_SETTINGS_KEY, undefined);
}

/** Flat-map key holding the operator's `tool.git` allowed-commands override. */
const GIT_ALLOWED_COMMANDS_KEY = 'tool.git::allowedCommands';

/**
 * The two branch-creation commands the flip targets. `git branch <name>`
 * creates the branch and `git switch` enters it; together they are the
 * create-then-switch pair. Nothing else is touched - notably `git checkout`
 * stays as stored, because its `git checkout -- <path>` form discards
 * uncommitted work.
 */
const GIT_BRANCH_COMMAND_KEYS = ['git branch <name>', 'git switch'] as const;

/**
 * Storage shape of one row of a `keyValue` field declared with
 * `optionalEnabled: true` (see `SettingsField` and the composer's
 * `projectValueForAgent`). Fields are optional because the map is operator
 * data that may predate any given column.
 */
interface KeyValueEntry {
  value?: unknown;
  enabled?: unknown;
  description?: unknown;
}

/**
 * One-time migration: enable `git branch <name>` and `git switch` inside an
 * ALREADY-STORED `tool.git::allowedCommands` map.
 *
 * Why this is needed: a `keyValue` override REPLACES the module manifest's
 * default map wholesale rather than deep-merging into it (see the composer's
 * `renderParameters`). So flipping those two commands on in `tool.git`'s
 * manifest default reaches fresh installs only - an operator who has ever
 * saved the allowed-commands table has a complete 48-key map in `globalState`
 * that shadows the default forever. This nudges that stored map once.
 *
 * Deliberate-opt-out guarantee: the migration is guarded by a persisted
 * marker, so it runs at most ONCE per machine. An operator who later unticks
 * either command in the Modules tab keeps it unticked - a subsequent update,
 * reload, or activation will not re-enable it, because the marker is already
 * set and the function returns before reading any settings.
 *
 * Flip-only: it never adds a key that is absent (in that case the manifest
 * default already governs), never removes or reorders a key, and never
 * touches any other key's `enabled`, `value`, or `description`.
 *
 * Never throws - activation must not depend on it.
 */
export async function migrateGitBranchCommandsEnabled(
  globalState: vscode.Memento,
  workspaceState: vscode.Memento,
  logger: vscode.OutputChannel,
): Promise<void> {
  try {
    if (globalState.get<boolean>(WORKSPACE_STATE_KEYS.GIT_BRANCH_COMMANDS_MIGRATION) === true) {
      return; // already run once - respect any later opt-out
    }
    const outcome = await flipStoredGitBranchCommands(globalState, workspaceState);
    // Marked on EVERY non-throwing path, including the no-ops, so the
    // migration can never re-run and re-enable a command the operator has
    // since turned off.
    await globalState.update(WORKSPACE_STATE_KEYS.GIT_BRANCH_COMMANDS_MIGRATION, true);
    logger.appendLine(`[ghola] git branch-command migration: ${outcome}`);
  } catch (err) {
    // Marker intentionally NOT set: a failed run is allowed to retry on the
    // next activation.
    logger.appendLine(`[ghola] git branch-command migration failed (non-fatal): ${err}`);
  }
}

/**
 * Perform the flip. Returns a human-readable description of what happened for
 * the caller to log. Every return path is a legitimate outcome; problems are
 * signalled by throwing, which the caller catches.
 */
async function flipStoredGitBranchCommands(
  globalState: vscode.Memento,
  workspaceState: vscode.Memento,
): Promise<string> {
  const flat = readModuleSettings(globalState, workspaceState);
  const stored = flat[GIT_ALLOWED_COMMANDS_KEY];
  if (stored === undefined) {
    return 'no-op (no stored allowedCommands override; the manifest default governs)';
  }
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return 'no-op (stored allowedCommands is not a plain object; left untouched)';
  }

  // Spread preserves insertion order, and reassigning an existing key keeps
  // its position, so the operator's row order survives intact.
  const next: Record<string, unknown> = { ...(stored as Record<string, unknown>) };
  const flipped: string[] = [];
  for (const key of GIT_BRANCH_COMMAND_KEYS) {
    const entry = next[key];
    if (entry === undefined) continue; // absent: never add it
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const row = entry as KeyValueEntry;
    if (row.enabled === true) continue; // already enabled
    // Spread the existing row so `value` and `description` carry over verbatim.
    next[key] = { ...row, enabled: true };
    flipped.push(key);
  }

  if (flipped.length === 0) {
    return 'no-op (target commands absent from the stored map, or already enabled)';
  }

  await writeModuleSettings(globalState, { ...flat, [GIT_ALLOWED_COMMANDS_KEY]: next });
  return `enabled ${flipped.length} command(s) in the stored allowedCommands map: ${flipped.join(', ')}`;
}
