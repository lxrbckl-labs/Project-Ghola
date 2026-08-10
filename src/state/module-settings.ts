import * as vscode from 'vscode';
import type { SettingsField, SettingsFieldType } from '../manifest/types';
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

// ─────────────────────────────────────────────────────────────────────────
// CONVERSATIONAL SETTINGS WRITE (phase 1 — scalar fields only)
//
// The primitive behind `tool.conversational-settings`: the operator asks TPM to
// change a module setting in chat, TPM calls the bridge, and the bridge calls
// this. Everything below is the VALIDATION half of that capability. The
// AUTHORIZATION half lives in `src/integration/settings-write-gate.ts` and is
// resolved by the bridge BEFORE any of this runs — nothing here consults a gate,
// and reaching this code is not permission to have reached it.
//
// TWO HONESTY NOTES that belong in code rather than only in a design doc:
//
//   1. "TPM-only" IS NOT ENFORCEABLE. There is exactly one bridge bearer token
//      per session and every subagent inherits it, so an SWE or QA that decides
//      to call `bb-bridge set-module-setting` is indistinguishable here from
//      TPM. The restriction is DOCTRINE, written in module prose and honored by
//      role discipline. Do not add a comment anywhere claiming this layer
//      enforces it, and do not build a feature that depends on it doing so.
//
//   2. EFFECT TIMING IS SPLIT, and the split is not cosmetic. A setting the HOST
//      reads per request (the `enableJira*` gates, this module's own write gate)
//      changes behavior on the very next call. A setting an AGENT reads from its
//      composed Session Manifest (allowlists, mode parameters, personas) is
//      baked into a prompt that was composed at session launch, so changing it
//      now changes nothing until the next session. `settingWriteEffect` below
//      reports which case a key falls into so the answer travels with the write
//      instead of living in someone's memory.
// ─────────────────────────────────────────────────────────────────────────

/** One conversational write request: a `moduleId::fieldKey` target and a value. */
export interface ModuleSettingWriteRequest {
  moduleId: string;
  fieldKey: string;
  /**
   * The requested value. Arrives from the CLI as a STRING in practice (flags
   * are strings), so `coerceSettingValue` narrows it against the field's
   * declared type; an already-typed value passes through unchanged.
   */
  value: unknown;
}

/** When a written value actually starts affecting behavior. */
export type ModuleSettingWriteEffect = 'immediate' | 'next-session';

/**
 * What the operator is being asked to approve, handed to the confirm callback
 * for a `securitySensitive` field. Contains everything a modal needs to name the
 * change precisely — module, human label, and both values.
 */
export interface ModuleSettingWritePreview {
  moduleId: string;
  fieldKey: string;
  settingKey: string;
  label: string;
  type: SettingsFieldType;
  /** The value in force before the write — the stored override, or the manifest default when there is none. */
  oldValue: unknown;
  newValue: unknown;
  effect: ModuleSettingWriteEffect;
}

/**
 * Operator-confirmation hook, injected so this file stays free of `vscode.window`
 * and the whole decision remains drivable in isolation. Called ONLY for a field
 * declaring `securitySensitive: true`, and AWAITED before anything is persisted.
 * Anything other than `true` refuses the write.
 */
export type ModuleSettingWriteConfirm = (
  preview: ModuleSettingWritePreview,
) => Promise<boolean>;

/**
 * Outcome of a write attempt. `status` separates the three things a caller has
 * to tell apart:
 *   - `written`   — persisted; `oldValue` / `newValue` are both populated.
 *   - `refused`   — the request itself was not acceptable (undeclared key, a
 *                   `keyValue` field, a value that failed validation). Nothing
 *                   was written and nothing will be written by retrying the same
 *                   request.
 *   - `cancelled` — the field was sensitive and the operator said no at the
 *                   modal. Deliberately NOT `refused`: the request was valid and
 *                   asking again is a legitimate thing to do.
 */
export interface ModuleSettingWriteResult {
  ok: boolean;
  status: 'written' | 'refused' | 'cancelled';
  moduleId: string;
  fieldKey: string;
  settingKey: string;
  /** True when the resolved field declares `securitySensitive: true`. False when the field never resolved. */
  sensitive: boolean;
  label?: string;
  type?: SettingsFieldType;
  oldValue?: unknown;
  newValue?: unknown;
  effect?: ModuleSettingWriteEffect;
  /** Operator-facing explanation. Always present on `refused` / `cancelled`. */
  message?: string;
}

/**
 * Flat keys the EXTENSION HOST reads per request, so a write to one is in force
 * immediately rather than at the next session launch. Everything not listed is
 * reported as `next-session`, which is the safe direction to be wrong in: a
 * change announced as taking effect later and actually taking effect now
 * surprises nobody, while the reverse makes an operator believe a guardrail
 * moved when it has not.
 *
 * Kept as an explicit list rather than derived, because "does the host read
 * this?" is a fact about host code, not about the manifest — there is nothing in
 * a `SettingsField` that could answer it.
 */
const HOST_ENFORCED_SETTING_KEYS: ReadonlySet<string> = new Set([
  'integration.atlassian-suite::enableJiraCommentWrite',
  'integration.atlassian-suite::enableJiraTransition',
  'tool.conversational-settings::enableSettingsWrite',
  // tool.terminal's config is re-read from `moduleSettingsEmitter` in
  // extension.ts, so these are live for terminals created after the write.
  'tool.terminal::maxConcurrentTerminals',
  'tool.terminal::defaultShell',
  'tool.terminal::autoDisposeOnSessionEnd',
  'tool.terminal::commandTimeoutMs',
  'tool.terminal::humanInterventionTimeoutMs',
]);

/** See the EFFECT TIMING note at the top of this section. */
function settingWriteEffect(settingKey: string): ModuleSettingWriteEffect {
  return HOST_ENFORCED_SETTING_KEYS.has(settingKey) ? 'immediate' : 'next-session';
}

/** Scalar field types phase 1 accepts. `keyValue` is deliberately absent. */
const WRITABLE_SCALAR_TYPES: ReadonlySet<string> = new Set([
  'string',
  'number',
  'boolean',
  'enum',
  'path',
]);

/** Build a `refused` result without a resolved field. */
function refuse(
  req: ModuleSettingWriteRequest,
  settingKey: string,
  message: string,
): ModuleSettingWriteResult {
  return {
    ok: false,
    status: 'refused',
    moduleId: req.moduleId,
    fieldKey: req.fieldKey,
    settingKey,
    sensitive: false,
    message,
  };
}

/** Result of narrowing a requested value against a field's declared type. */
type CoercionOutcome =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

/**
 * Narrow a requested value to the field's declared type.
 *
 * THE COERCIONS ARE DELIBERATELY SMALL AND NAMED, because a permissive coercion
 * on a permission-bearing boolean is a security bug wearing convenience's
 * clothes. The CLI can only send strings, so a string form is accepted for every
 * type; nothing else is guessed.
 *
 *   boolean  'true'|'false'|'1'|'0'|'yes'|'no'|'on'|'off' (case/space-insensitive)
 *            and the real booleans. NOTHING ELSE — in particular a bare
 *            non-empty string is NOT truthy here, so a typo like `--value ture`
 *            is refused instead of quietly turning a gate ON.
 *   number   a real finite number, or a string that `Number()` maps to one.
 *            NaN and +/-Infinity are refused. '' is refused (Number('') === 0,
 *            which is the classic way an empty flag becomes a real setting).
 *            `min` / `max` are enforced INCLUSIVELY when declared.
 *   enum     an exact member of `options`. A case-insensitive match is accepted
 *            ONLY when it is unambiguous, and resolves to the manifest's own
 *            spelling, so what lands in storage is always a declared option.
 *   string   any string, INCLUDING the empty string (a legitimate "cleared but
 *   path     present" value under `mergeChangedModuleSettings` semantics). A
 *            non-string is refused rather than stringified.
 */
function coerceSettingValue(field: SettingsField, raw: unknown): CoercionOutcome {
  switch (field.type) {
    case 'boolean': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      if (typeof raw === 'string') {
        const t = raw.trim().toLowerCase();
        if (t === 'true' || t === '1' || t === 'yes' || t === 'on') return { ok: true, value: true };
        if (t === 'false' || t === '0' || t === 'no' || t === 'off') return { ok: true, value: false };
      }
      return {
        ok: false,
        message: 'this is a boolean setting; the value must be one of true/false, 1/0, yes/no, on/off',
      };
    }
    case 'number': {
      let n: number;
      if (typeof raw === 'number') {
        n = raw;
      } else if (typeof raw === 'string' && raw.trim() !== '') {
        n = Number(raw.trim());
      } else {
        return { ok: false, message: 'this is a number setting; the value must be a number' };
      }
      if (!Number.isFinite(n)) {
        return { ok: false, message: 'this is a number setting; the value must be a finite number' };
      }
      if (typeof field.min === 'number' && n < field.min) {
        return { ok: false, message: `value ${n} is below this setting's minimum of ${field.min}` };
      }
      if (typeof field.max === 'number' && n > field.max) {
        return { ok: false, message: `value ${n} is above this setting's maximum of ${field.max}` };
      }
      return { ok: true, value: n };
    }
    case 'enum': {
      const options = Array.isArray(field.options) ? field.options : [];
      if (options.length === 0) {
        return { ok: false, message: 'this enum setting declares no options, so no value is valid' };
      }
      if (typeof raw !== 'string') {
        return { ok: false, message: `this is an enum setting; the value must be one of: ${options.join(', ')}` };
      }
      const exact = options.find((o) => o === raw);
      if (exact !== undefined) return { ok: true, value: exact };
      // Case-insensitive fallback, accepted ONLY when a single option matches —
      // an ambiguous match is refused rather than resolved by list order.
      const lowered = raw.trim().toLowerCase();
      const near = options.filter((o) => o.toLowerCase() === lowered);
      if (near.length === 1) return { ok: true, value: near[0] };
      return {
        ok: false,
        message: `'${raw}' is not one of this setting's options: ${options.join(', ')}`,
      };
    }
    case 'string':
    case 'path': {
      if (typeof raw !== 'string') {
        return { ok: false, message: `this is a ${field.type} setting; the value must be a string` };
      }
      return { ok: true, value: raw };
    }
    default:
      // Unreachable for the five scalar types the caller already filtered on;
      // present so a NEW SettingsFieldType is refused by default rather than
      // silently written through un-validated.
      return { ok: false, message: `settings of type '${field.type}' cannot be written conversationally` };
  }
}

/**
 * Apply ONE conversational write to ONE scalar module setting.
 *
 * RESOLUTION IS AGAINST THE DISCOVERED MODULE SCHEMAS, AND AN UNDECLARED KEY IS
 * REFUSED. That is load-bearing and is not a tidiness check — do not "fix" it by
 * falling back to writing whatever key was asked for:
 *
 *   - It structurally blocks `mode.war::enabled`. War Mode is NOT a
 *     loader-toggleable module; its enablement lives as a flat settings key that
 *     NO manifest declares (see `prompts/composer.ts` and the Agents-tab
 *     handling in `settings-panel/host.ts`). Because no `contributes.settings`
 *     entry exists for it, this function cannot resolve it and refuses — so a
 *     conversational request can never switch a whole session modality on. That
 *     refusal is a DESIGNED property of schema resolution, not an accident of
 *     it, and any change that lets an unknown key through re-opens it.
 *   - It bounds the blast radius generally: the writable surface is exactly the
 *     set of fields some module author declared, with the type, options, and
 *     bounds they declared. Nothing can invent a key.
 *
 * `keyValue` fields are OUT OF PHASE 1 and refused explicitly. The reason is
 * mechanical, not squeamish: a stored kv value SHADOWS the manifest default map
 * wholesale rather than deep-merging into it (see `reconcileKeyValueTable`'s
 * header), so writing a single row into a table the operator has never saved
 * would replace the entire default catalog with that one row — silently revoking
 * the other ~55 entries of, say, `tool.git::allowedCommands`. Phase 2 needs
 * seed-from-default logic before a one-row write is safe.
 *
 * THE WRITE ITSELF USES A FRESH READ, twice. `globalState` is shared by every VS
 * Code window on the machine, so the map is re-read immediately before the merge
 * and only the ONE key is folded on (`mergeChangedModuleSettings`) — a sibling
 * window's concurrent edit to a different key survives. The second read matters
 * more here than in the panel: a `securitySensitive` field's modal can sit
 * unanswered for minutes, and the map read before the modal is stale by the time
 * it is dismissed.
 *
 * Never throws for a bad REQUEST — those come back as `refused`. A genuine
 * persistence failure (a broken Memento) still propagates, because a write that
 * did not happen must not report success.
 */
export async function applyModuleSettingWrite(
  globalState: vscode.Memento,
  workspaceState: vscode.Memento,
  modules: readonly ModuleHandle[],
  req: ModuleSettingWriteRequest,
  confirm?: ModuleSettingWriteConfirm,
): Promise<ModuleSettingWriteResult> {
  const moduleId = typeof req.moduleId === 'string' ? req.moduleId.trim() : '';
  const fieldKey = typeof req.fieldKey === 'string' ? req.fieldKey.trim() : '';
  const settingKey = `${moduleId}::${fieldKey}`;

  if (moduleId === '' || fieldKey === '') {
    return refuse(req, settingKey, 'both a module id and a field key are required');
  }

  const handle = modules.find((m) => m.manifest.id === moduleId);
  if (!handle) {
    return refuse(
      req,
      settingKey,
      `no module with id '${moduleId}' is installed, so it declares no settings to write`,
    );
  }

  const field = handle.manifest.contributes?.settings?.[fieldKey];
  if (!field) {
    // The undeclared-key refusal. See the header: this is what keeps
    // `mode.war::enabled` (and any other flat key no manifest declares)
    // structurally unwritable from a conversation.
    return refuse(
      req,
      settingKey,
      `'${moduleId}' declares no setting called '${fieldKey}'. Only settings a module's `
      + 'manifest declares can be written; a flat key that no manifest declares (such as the '
      + 'War Mode toggle) is not writable this way and must be changed in the settings panel.',
    );
  }

  if (field.type === 'keyValue') {
    return refuse(
      req,
      settingKey,
      `'${field.label}' is a key/value table. Table settings are PANEL-ONLY for now — open `
      + "Ghola's Modules tab and edit the table there. (A stored table replaces the module's "
      + 'entire default map rather than merging into it, so writing one row here would silently '
      + 'drop every other entry.)',
    );
  }

  if (!WRITABLE_SCALAR_TYPES.has(field.type)) {
    return refuse(
      req,
      settingKey,
      `settings of type '${field.type}' cannot be written conversationally`,
    );
  }

  const coerced = coerceSettingValue(field, req.value);
  if (!coerced.ok) {
    return refuse(req, settingKey, `'${field.label}': ${coerced.message}`);
  }

  const sensitive = field.securitySensitive === true;
  const effect = settingWriteEffect(settingKey);
  // The value IN FORCE, which is the stored override when there is one and the
  // manifest default otherwise — the panel resolves it the same way
  // (`settingsValues[key] ?? field.default`). Reporting a bare `undefined` for a
  // defaulted field would tell the operator the setting is unset when it is very
  // much in effect.
  const before = readModuleSettings(globalState, workspaceState);
  const oldValue = Object.prototype.hasOwnProperty.call(before, settingKey)
    ? before[settingKey]
    : field.default;

  if (sensitive) {
    const approved = confirm
      ? await confirm({
        moduleId,
        fieldKey,
        settingKey,
        label: field.label,
        type: field.type,
        oldValue,
        newValue: coerced.value,
        effect,
      })
      // No confirm hook wired means no way to ask, and "we could not ask" must
      // never read as "the operator said yes" — same fail-closed rule the
      // capability gates follow.
      : false;
    if (approved !== true) {
      return {
        ok: false,
        status: 'cancelled',
        moduleId,
        fieldKey,
        settingKey,
        sensitive: true,
        label: field.label,
        type: field.type,
        oldValue,
        newValue: coerced.value,
        effect,
        message: confirm
          ? `The operator declined the change to '${field.label}'. Nothing was written.`
          : `'${field.label}' requires an operator confirmation and no confirmation channel is `
            + 'available, so the write was refused.',
      };
    }
  }

  // FRESH read again, deliberately not reusing `before`: the modal above may
  // have been open for minutes, and a sibling window's save in that window must
  // not be rolled back by this one.
  const live = readModuleSettings(globalState, workspaceState);
  const next = mergeChangedModuleSettings(live, { [settingKey]: coerced.value }, [settingKey]);
  await writeModuleSettings(globalState, next);

  return {
    ok: true,
    status: 'written',
    moduleId,
    fieldKey,
    settingKey,
    sensitive,
    label: field.label,
    type: field.type,
    oldValue,
    newValue: coerced.value,
    effect,
  };
}

/** One setting as reported by the conversational READ path. */
export interface ModuleSettingSummary {
  moduleId: string;
  moduleName: string;
  fieldKey: string;
  settingKey: string;
  label: string;
  type: SettingsFieldType;
  description?: string;
  /** Whether the owning module is enabled in THIS window (enablement is per-workspace). */
  moduleEnabled: boolean;
  /** The value in force: the stored override, else the manifest default. */
  value: unknown;
  /** True when no override is stored and `value` is therefore the manifest default. */
  isDefault: boolean;
  /** Whether `applyModuleSettingWrite` would accept this field at all (phase 1: scalars only). */
  writable: boolean;
  sensitive: boolean;
  /** Declared options, for an `enum`. */
  options?: string[];
  min?: number;
  max?: number;
  effect: ModuleSettingWriteEffect;
}

/**
 * Enumerate module settings for the conversational READ path, optionally
 * narrowed to one module. Pure and side-effect free — this is what makes the
 * echo-the-old-value confirmation possible before a write is proposed.
 *
 * `keyValue` tables are LISTED but their contents are NOT dumped: `value` is
 * replaced by a small `{ kind, entryCount, enabledCount }` summary. A table like
 * `tool.git::allowedCommands` is ~55 rich rows, and pouring that into an agent's
 * context to answer "what is this setting?" costs more than it tells. They are
 * reported with `writable: false`, which is the phase-1 truth.
 */
export function summarizeModuleSettings(
  globalState: vscode.Memento,
  workspaceState: vscode.Memento,
  modules: readonly ModuleHandle[],
  moduleId?: string,
): ModuleSettingSummary[] {
  const flat = readModuleSettings(globalState, workspaceState);
  const wanted = typeof moduleId === 'string' && moduleId.trim() !== ''
    ? moduleId.trim()
    : undefined;
  const out: ModuleSettingSummary[] = [];

  for (const handle of modules) {
    if (wanted !== undefined && handle.manifest.id !== wanted) continue;
    const schema = handle.manifest.contributes?.settings;
    if (!schema) continue;
    for (const fieldKey of Object.keys(schema)) {
      const field = schema[fieldKey];
      const settingKey = `${handle.manifest.id}::${fieldKey}`;
      const stored = Object.prototype.hasOwnProperty.call(flat, settingKey);
      const isKv = field.type === 'keyValue';
      const raw = stored ? flat[settingKey] : field.default;
      out.push({
        moduleId: handle.manifest.id,
        moduleName: handle.manifest.name,
        fieldKey,
        settingKey,
        label: field.label,
        type: field.type,
        ...(field.description !== undefined ? { description: field.description } : {}),
        moduleEnabled: handle.isEnabled,
        value: isKv ? summarizeKeyValueTable(raw) : raw,
        isDefault: !stored,
        writable: WRITABLE_SCALAR_TYPES.has(field.type),
        sensitive: field.securitySensitive === true,
        ...(Array.isArray(field.options) ? { options: field.options } : {}),
        ...(typeof field.min === 'number' ? { min: field.min } : {}),
        ...(typeof field.max === 'number' ? { max: field.max } : {}),
        effect: settingWriteEffect(settingKey),
      });
    }
  }
  return out;
}

/** Row-count summary of a kv table, so the read path never dumps a 55-row map. */
function summarizeKeyValueTable(raw: unknown): {
  kind: 'keyValue';
  entryCount: number;
  enabledCount: number;
} {
  if (!isPlainObject(raw)) return { kind: 'keyValue', entryCount: 0, enabledCount: 0 };
  const keys = Object.keys(raw);
  let enabled = 0;
  for (const key of keys) {
    const row = raw[key];
    // A table without an Enabled column grants by PRESENCE (see git.md), so a
    // row with no `enabled` field counts as enabled rather than as off.
    if (!isPlainObject(row) || (row as KeyValueEntry).enabled !== false) enabled += 1;
  }
  return { kind: 'keyValue', entryCount: keys.length, enabledCount: enabled };
}
