import * as vscode from 'vscode';
import type { SettingsField } from '../manifest/types';
import type { ModuleHandle } from '../modules/handle';
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
 * Fold ONLY the named keys of `incoming` onto a copy of `base`, leaving every
 * other key of `base` exactly as it was.
 *
 * Why this exists: `globalState` is shared by every VS Code window on the
 * machine, but the settings panel's webview holds a SNAPSHOT of the map taken
 * when it last loaded settings. Writing that whole snapshot back (what
 * `saveSettings` did unconditionally before this helper) erases anything a
 * sibling window changed in the meantime — one blurred field in window B would
 * silently revert every edit made in window A. Passing `base` as a FRESH read
 * of the live map and restricting the copy to the keys the save actually
 * touched makes concurrent edits to DIFFERENT keys commutative, so neither
 * window can clobber the other.
 *
 * Per-key semantics (deliberately two distinct operations — conflating them
 * would either resurrect a cleared value or wipe an intentional empty):
 * - key present in `incoming`, including `''` -> stored verbatim, empty string included.
 * - key absent from `incoming`, or present with the value `undefined` -> DELETED
 *   from the merged map. This is how a cleared field arrives: the webview sets
 *   `undefined` (e.g. an emptied number input) and the postMessage JSON
 *   serialization then drops the key entirely, so both forms mean "cleared" and
 *   must behave identically.
 *
 * Pure — neither argument is mutated, and nothing is persisted; the caller
 * hands the result to `writeModuleSettings`.
 */
export function mergeChangedModuleSettings(
  base: Record<string, unknown>,
  incoming: Record<string, unknown>,
  changedKeys: readonly string[],
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const key of changedKeys) {
    const present =
      Object.prototype.hasOwnProperty.call(incoming, key) && incoming[key] !== undefined;
    if (present) merged[key] = incoming[key];
    else delete merged[key];
  }
  return merged;
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

/** Narrow to a non-null, non-array object - the shape every kv table and row has. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What one table's reconciliation produced. `next` is a fresh object; `stored` is never mutated. */
export interface KeyValueTableReconcileResult {
  /** The reconciled map. Equal in content to `stored` when nothing changed. */
  next: Record<string, unknown>;
  /** Manifest keys that were absent from `stored` and have been added, DISABLED. */
  added: string[];
  /** Stored keys whose `value` disagreed with the manifest and was corrected. */
  corrected: string[];
  /** Stored keys the manifest catalog does not declare. Reported, never touched. */
  unknown: string[];
}

/**
 * Reconcile ONE stored `keyValue` map against its manifest field's default
 * catalog. Pure: `stored` is not mutated and nothing is persisted.
 *
 * Why this is needed at all: a stored `keyValue` value SHADOWS the manifest
 * default outright rather than deep-merging into it - the composer's
 * `renderParameters` / `projectValueForAgent` iterate the stored object's own
 * keys and never consult `field.default`, and the panel renders
 * `state.settingsValues[key] ?? field.default`. So growing a manifest catalog
 * reaches fresh installs only; an operator who has ever saved the table keeps a
 * map frozen at the shape it had that day, and cannot see - let alone enable -
 * anything added since.
 *
 * Two independent operations, each gated on an explicit manifest declaration:
 *
 * - **Backfill**, gated on `optionalEnabled: true`. A manifest key missing from
 *   `stored` is added with `enabled: false`. The gate is what keeps this from
 *   ever widening a grant: on a table without an Enabled column, a key's mere
 *   presence IS the grant (see git.md: "A key's presence is the grant; its
 *   absence is the refusal"), so there is no way to add a row without granting
 *   it - and such a table is therefore skipped entirely.
 * - **Value correction**, gated on `valueReadonly: true` PLUS a non-empty
 *   `valueOptions`, with the manifest's value required to be a member of that
 *   list. Together those declare a closed vocabulary authored in the manifest
 *   (tool.git / tool.github's r|w|d Category), which is documentation and not
 *   policy - so rewriting it changes no permission. The `valueOptions` half of
 *   the gate is load-bearing: `valueReadonly` alone is also set on columns
 *   holding operator DATA (tool.pr-prep's `defaultReviewers` account IDs),
 *   where overwriting a stored value from the manifest would destroy real input.
 *
 * Never changes a stored row's `enabled`: corrected rows are rebuilt by
 * spreading the stored row and assigning `value` only, so `enabled` and
 * `description` carry over byte-for-byte. Never removes a stored key, including
 * one the manifest no longer declares - it may be a hand edit or a downgraded
 * install, and an undeclared key is refused anyway (the composer filters it),
 * so keeping it costs nothing while dropping it would destroy operator intent.
 *
 * Insertion order of the stored map is preserved (spread, then append), so the
 * operator's existing rows do not move; backfilled rows land at the end in
 * manifest order.
 *
 * Returns `null` when the field is not an eligible kv table at all (wrong type,
 * empty or non-object catalog, or neither gate open).
 */
export function reconcileKeyValueTable(
  stored: Record<string, unknown>,
  field: SettingsField,
): KeyValueTableReconcileResult | null {
  if (field.type !== 'keyValue') return null;
  const catalog = field.default;
  if (!isPlainObject(catalog)) return null;
  const catalogKeys = Object.keys(catalog);
  if (catalogKeys.length === 0) return null;

  const mayBackfill = field.optionalEnabled === true;
  const valueOptions = field.valueOptions;
  const mayCorrectValues =
    field.valueReadonly === true && Array.isArray(valueOptions) && valueOptions.length > 0;
  if (!mayBackfill && !mayCorrectValues) return null;

  const next: Record<string, unknown> = { ...stored };
  const added: string[] = [];
  const corrected: string[] = [];
  const unknown: string[] = [];

  for (const key of Object.keys(stored)) {
    if (!Object.prototype.hasOwnProperty.call(catalog, key)) unknown.push(key);
  }

  for (const key of catalogKeys) {
    const manifestRow = catalog[key];
    if (!isPlainObject(manifestRow)) continue; // unrecognized catalog shape - leave the table alone
    const manifestValue = (manifestRow as KeyValueEntry).value;
    const storedRow = stored[key];

    if (storedRow === undefined) {
      if (!mayBackfill) continue;
      // Built field-by-field in manifest column order. `enabled: false` is
      // unconditional - a migration that silently granted a command the
      // operator never enabled would be worse than the invisibility it fixes.
      const row: Record<string, unknown> = {};
      if (typeof manifestValue === 'string') row.value = manifestValue;
      row.enabled = false;
      const manifestDescription = (manifestRow as KeyValueEntry).description;
      if (field.optionalDescription === true && typeof manifestDescription === 'string') {
        row.description = manifestDescription;
      }
      next[key] = row;
      added.push(key);
      continue;
    }

    if (!mayCorrectValues) continue;
    if (!isPlainObject(storedRow)) continue; // e.g. a pre-rich-shape string row - do not guess
    if (typeof manifestValue !== 'string') continue;
    if (!valueOptions!.includes(manifestValue)) continue;
    const row = storedRow as KeyValueEntry;
    if (row.value === manifestValue) continue;
    // Spread-then-assign: `enabled` and the operator's `description` survive
    // verbatim; only the manifest-owned category letter moves.
    next[key] = { ...row, value: manifestValue };
    corrected.push(key);
  }

  return { next, added, corrected, unknown };
}

/**
 * One-time migration: reconcile every stored `keyValue` settings map against
 * the catalog its module manifest currently declares - backfilling keys the
 * operator's stored map predates (always DISABLED) and correcting stale
 * closed-vocabulary value letters. See `reconcileKeyValueTable` for the exact
 * rules and the gates that keep each operation from widening a grant.
 *
 * Written generically rather than as a per-module special case on purpose: the
 * shadowing problem is a property of how `keyValue` settings are stored, not of
 * `tool.git`, and it recurs on every future catalog change to any module. The
 * blast radius is bounded by the two manifest gates, so a module whose value
 * column holds operator data is skipped rather than trusted.
 *
 * Deliberate-opt-out guarantee, matching `migrateGitBranchCommandsEnabled`: a
 * persisted marker makes this run at most ONCE per machine. An operator who
 * later unticks a backfilled row, or deletes it outright, keeps that choice - a
 * later activation returns before reading any settings.
 *
 * Never throws - activation must not depend on it.
 *
 * ORDERING: this rewrites the same `ghola.moduleSettings` globalState key that
 * `migrateModuleSettingsToGlobal` and `migrateGitBranchCommandsEnabled` write,
 * so it must be CHAINED after both rather than fired independently, exactly as
 * those two are chained to each other. It also needs discovered module handles,
 * so it can only run once `loader.discover()` has resolved. `activate()`
 * satisfies both by awaiting the `settingsMigrations` promise inside the
 * `loader.discover().then(...)` block, immediately before calling this.
 */
export async function reconcileStoredKeyValueTables(
  globalState: vscode.Memento,
  workspaceState: vscode.Memento,
  modules: readonly ModuleHandle[],
  logger: vscode.OutputChannel,
): Promise<void> {
  try {
    if (globalState.get<boolean>(WORKSPACE_STATE_KEYS.KV_TABLE_RECONCILE_MIGRATION) === true) {
      return; // already run once - respect any later opt-out
    }
    const outcome = await reconcileAllStoredKeyValueTables(
      globalState,
      workspaceState,
      modules,
      logger,
    );
    // Marked on EVERY non-throwing path, including the no-ops, so the pass can
    // never re-run and resurrect a row the operator has since deleted.
    await globalState.update(WORKSPACE_STATE_KEYS.KV_TABLE_RECONCILE_MIGRATION, true);
    logger.appendLine(`[ghola] kv-table reconciliation: ${outcome}`);
  } catch (err) {
    // Marker intentionally NOT set: a failed run is allowed to retry on the
    // next activation.
    logger.appendLine(`[ghola] kv-table reconciliation failed (non-fatal): ${err}`);
  }
}

/**
 * Walk every discovered module's settings schema, reconcile each stored kv
 * table, and persist once if anything changed. Returns a human-readable summary
 * for the caller to log. Every return path is a legitimate outcome; problems are
 * signalled by throwing, which the caller catches.
 *
 * All discovered modules are walked, not just the enabled ones: a disabled
 * module's stored map drifts identically, and the operator would hit the stale
 * table the moment they re-enable it.
 */
async function reconcileAllStoredKeyValueTables(
  globalState: vscode.Memento,
  workspaceState: vscode.Memento,
  modules: readonly ModuleHandle[],
  logger: vscode.OutputChannel,
): Promise<string> {
  const flat = readModuleSettings(globalState, workspaceState);
  const next: Record<string, unknown> = { ...flat };
  const summary: string[] = [];

  for (const handle of modules) {
    const schema = handle.manifest.contributes?.settings;
    if (!schema) continue;
    for (const fieldKey of Object.keys(schema)) {
      const flatKey = `${handle.manifest.id}::${fieldKey}`;
      const stored = flat[flatKey];
      // No stored override: the manifest default already governs, and adding
      // one here would convert a defaulted field into an override for no gain.
      if (stored === undefined) continue;
      if (!isPlainObject(stored)) continue;
      const result = reconcileKeyValueTable(stored, schema[fieldKey]);
      if (result === null) continue;
      if (result.unknown.length > 0) {
        logger.appendLine(
          `[ghola] kv-table reconciliation: ${flatKey} holds ${result.unknown.length} stored key(s) the manifest does not declare, left untouched: ${result.unknown.join(', ')}`,
        );
      }
      if (result.added.length === 0 && result.corrected.length === 0) continue;
      next[flatKey] = result.next;
      summary.push(
        `${flatKey} (+${result.added.length} backfilled disabled, ${result.corrected.length} value(s) corrected)`,
      );
    }
  }

  if (summary.length === 0) {
    return 'no-op (no stored kv table differs from its manifest catalog)';
  }

  await writeModuleSettings(globalState, next);
  return `reconciled ${summary.length} table(s): ${summary.join('; ')}`;
}
