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
