/**
 * HOST-SIDE enforcement of `tool.conversational-settings`'s `enableSettingsWrite`
 * gate — the outer gate on an AGENT changing the operator's module settings from
 * a conversation.
 *
 * Why this file exists: every other capability this extension exposes acts on
 * something OUTSIDE the extension — a Jira issue, a Bitbucket PR, a terminal.
 * This one acts on the extension's own configuration, which is where all the
 * other capabilities' gates are stored. That makes it the one write whose misuse
 * is self-amplifying, and it is the reason the authorization is enforced where
 * the capability lives rather than asked for in module markdown. With the gate
 * off the extension withholds the applier function itself, so the bridge route
 * has nothing to call and no setting is touched.
 *
 * FAIL CLOSED IS THE WHOLE POINT. Every function here is written so that the
 * PERMITTED branch requires an affirmative `true` and every other outcome —
 * absent key, non-boolean value, missing settings map, module not enabled,
 * accessor throwing — falls through to REFUSED. There is deliberately no
 * manifest-default fallback: a security gate must not be enableable by editing a
 * manifest default.
 *
 * DELIBERATELY A THIRD FILE, NOT A SHARED HELPER. This is a near-copy of
 * `jira-transition-gate.ts`, which is itself a near-copy of
 * `jira-comment-write-gate.ts`, and that duplication is the design. A single
 * gate parameterized over three capabilities is one careless edit — a defaulted
 * argument, a widened union, a "while I am here" refactor — away from letting
 * one setting open all three doors. Three capabilities, three files, three
 * independent decisions. If you find yourself merging them, that is the change
 * this comment exists to stop.
 *
 * WHAT THIS GATE DOES *NOT* DO — read before relying on it:
 *   - It does not, and cannot, restrict the write to TPM. There is ONE bridge
 *     bearer token per session and every subagent inherits it, so an SWE calling
 *     `bb-bridge set-module-setting` is indistinguishable here from TPM. The
 *     TPM-only rule is DOCTRINE, enforced by module prose and role discipline
 *     only. Anything built on the assumption that this layer enforces it is
 *     built on nothing.
 *   - It does not validate WHAT is being written. The writable surface is
 *     whatever the discovered manifests declare, and the value is checked
 *     against the declared type/options/bounds; see `applyModuleSettingWrite` in
 *     `state/module-settings.ts`. This file answers only "is this session
 *     allowed to write settings at all, and is this target off-limits".
 *
 * Pure and vscode-free on purpose. The caller injects the reads as thunks, which
 * keeps this decision drivable in isolation (type-strip + call it) rather than
 * only reachable through a running extension host.
 */

/** Module id owning the gate. */
export const SETTINGS_WRITE_MODULE_ID = 'tool.conversational-settings';

/** Field key of the gate setting inside that module's `contributes.settings`. */
export const SETTINGS_WRITE_FIELD_KEY = 'enableSettingsWrite';

/**
 * Flat `moduleId::fieldKey` key the gate's value is stored under in the
 * module-settings map (see `state/module-settings.ts`).
 */
export const SETTINGS_WRITE_SETTING_KEY =
  `${SETTINGS_WRITE_MODULE_ID}::${SETTINGS_WRITE_FIELD_KEY}`;

/**
 * Module id of the autonomous ticket->PR mode. Its presence is one half of the
 * autonomous-mode bar below.
 */
export const TICKET_PR_MODULE_ID = 'mode.ticket-pr';

/**
 * Flat key holding the War Mode toggle. War Mode is NOT a loader-toggleable
 * module — its enablement lives as this flat settings key (an Agents-tab
 * configuration), which is why it is read from the settings map here rather than
 * from the loader. Same read `extension.ts`, the composer, and the launcher use.
 */
export const WAR_MODE_SETTING_KEY = 'mode.war::enabled';

/**
 * The refusal the bridge sends — and `bb-bridge.mjs` prints — when the write
 * route is hit with the gate off. It names the module, the setting's storage
 * key, and the Modules-tab label so an operator reading a terminal knows exactly
 * which checkbox to tick.
 */
export const SETTINGS_WRITE_DISABLED_MESSAGE =
  'Conversational settings writes are disabled host-side: '
  + `\`${SETTINGS_WRITE_MODULE_ID}\`'s \`${SETTINGS_WRITE_FIELD_KEY}\` setting is not on, `
  + 'so the extension withheld the write capability from this bridge and NOTHING was changed. '
  + 'To enable it, turn on "Enable Settings Write" on the Conversational Settings module in '
  + "Ghola's Modules tab (the module itself must also be enabled). "
  + 'Reading settings (`get-module-settings`) is unaffected and works either way.';

/**
 * The refusal when an autonomous session mode is active. Deliberately separate
 * text from the gate-off message: the operator has turned the capability ON and
 * still gets refused, so a message telling them to go and tick the box would
 * send them to a box that is already ticked.
 */
export const SETTINGS_WRITE_AUTONOMOUS_MODE_MESSAGE =
  'Conversational settings writes are refused because an AUTONOMOUS session mode is active '
  + `(\`${TICKET_PR_MODULE_ID}\` is enabled, or War Mode's \`${WAR_MODE_SETTING_KEY}\` is on). `
  + 'A hands-free mode must not be able to change the operator\'s configuration — including the '
  + 'gates that decide what it is allowed to do — so the capability is withheld outright and '
  + 'NOTHING was changed. Turn the autonomous mode off (or make the change in the Modules tab) '
  + 'and try again.';

/**
 * The refusal when the write targets `tool.conversational-settings` itself.
 * Named as its own export so the bridge, the applier, and any test can assert
 * the same string.
 */
export const SETTINGS_WRITE_SELF_REFERENCE_MESSAGE =
  `Writes to \`${SETTINGS_WRITE_MODULE_ID}\` are refused unconditionally. That module owns the `
  + 'gate on this very capability, so a write to it is a write to the permission to write — an '
  + 'agent that can widen its own authorization has no gate at all. This is the ONLY hardcoded '
  + 'refusal in the settings-write path; every other target is checked against the module '
  + "manifests. Change these settings in Ghola's Modules tab.";

/** The reads the gate decision needs, injected so this stays vscode-free. */
export interface SettingsWriteGateReaders {
  /**
   * Whether `tool.conversational-settings` is currently ENABLED in this window.
   * `undefined` is the honest answer when the module loader has not discovered
   * modules yet (or the module is not installed) and, like `false`, closes the
   * gate.
   */
  isModuleEnabled: () => boolean | undefined;
  /**
   * Whether `mode.ticket-pr` is currently ENABLED in this window. `undefined`
   * means "we do not know", which — unlike everywhere else in this file — is
   * treated as NOT active: refusing every write because the loader has not
   * finished discovering would make the capability unusable rather than safe,
   * and the primary gate above has already had to answer `true` to get here.
   */
  isTicketPrEnabled: () => boolean | undefined;
  /** The flat `moduleId::fieldKey` module-settings map. */
  readSettings: () => Record<string, unknown> | undefined;
}

/**
 * Resolve the primary gate. Returns `true` ONLY when both conditions hold:
 *
 *   1. `tool.conversational-settings` is enabled, AND
 *   2. its `enableSettingsWrite` value is the boolean `true`.
 *
 * Condition 1 is not redundant: module settings live in `globalState` while
 * module ENABLEMENT is per-workspace, so a stale `true` can easily outlive the
 * module being switched off in this window — and a gate that a disabled module's
 * leftover state can hold open is not a gate.
 *
 * Never throws. A reader that throws (corrupt state, disposed memento) is
 * treated exactly like "not enabled", because the one thing this function must
 * never do is answer "enabled" when it does not know.
 */
export function isSettingsWriteEnabled(readers: SettingsWriteGateReaders): boolean {
  try {
    if (readers.isModuleEnabled() !== true) return false;
    const flat = readers.readSettings();
    if (flat === null || typeof flat !== 'object') return false;
    // Strict identity against `true`: the string 'true', 1, and every other
    // truthy-but-not-boolean value stored by a hand-edited or legacy state blob
    // resolve to DISABLED rather than being coerced into permission.
    return flat[SETTINGS_WRITE_SETTING_KEY] === true;
  } catch {
    return false;
  }
}

/**
 * THE AUTONOMOUS-MODE BAR. `true` when a hands-free session mode is running, in
 * which case the write is refused no matter how the primary gate resolved.
 *
 * The rule is blunt on purpose and has no per-setting carve-out: a mode whose
 * whole point is that nobody is watching must not be able to change the
 * configuration that decides what it may do — including, recursively, the gates
 * on its own capabilities. Two independent signals, because the two modes are
 * enabled by two different mechanisms:
 *   - `mode.ticket-pr` is a normal loader-toggleable module.
 *   - War Mode is not a module at all; it is the `mode.war::enabled` flat
 *     settings key (an Agents-tab configuration), read the same way
 *     `extension.ts`, the composer, and the launcher read it.
 *
 * Never throws; a reader that throws is treated as ACTIVE (i.e. refuse), which
 * is the fail-closed direction for a bar.
 */
export function isAutonomousModeActive(readers: SettingsWriteGateReaders): boolean {
  try {
    if (readers.isTicketPrEnabled() === true) return true;
    const flat = readers.readSettings();
    if (flat === null || typeof flat !== 'object') return false;
    return flat[WAR_MODE_SETTING_KEY] === true;
  } catch {
    // Unknown is not permission for a BAR — the safe answer here is the
    // restrictive one, which is the mirror image of `isSettingsWriteEnabled`
    // returning false on the same failure.
    return true;
  }
}

/**
 * THE SELF-REFERENCE DENYLIST. The one and only hardcoded target refusal in this
 * capability.
 *
 * `tool.conversational-settings` owns `enableSettingsWrite`, so letting a write
 * touch that module means an agent can turn its own gate on (or widen the
 * detection/confirmation settings that shape how the operator is asked). A gate
 * an agent can edit is decoration. Everything else is allowed on the strength of
 * schema validation alone — resist the urge to grow this into a general blocklist,
 * because a list of "dangerous modules" is a list somebody has to keep correct
 * forever, and the day it falls behind it reads as protection that is not there.
 */
export function isSelfReferentialSettingsWrite(moduleId: string): boolean {
  return typeof moduleId === 'string' && moduleId.trim() === SETTINGS_WRITE_MODULE_ID;
}

/**
 * HOST-INJECTED KEYS. Settings whose value the HOST writes into the composed
 * Session Manifest on every compose, so whatever is stored under them is
 * overwritten before any agent ever sees it.
 *
 * NOT a second security denylist, and deliberately not folded into the one
 * above: this refusal is about TRUTHFULNESS, not authorization. The self-
 * reference rule refuses a write that would be honored and must not be; this one
 * refuses a write that would be ACCEPTED, persisted, reported as written — and
 * then silently discarded at the next compose, which is a lie told to the
 * operator by a success message. Refusing beats writing a value nothing reads.
 *
 * Entries are FLAT `moduleId::fieldKey` keys, because the fact being encoded is
 * per-FIELD (`tool.reviewer-dossier`'s other settings are ordinary and writable).
 * Membership is a fact about host code — `settings-panel/host.ts` injects these
 * at compose time — exactly like `HOST_ENFORCED_SETTING_KEYS` in
 * `state/module-settings.ts`; nothing in a `SettingsField` could answer it, which
 * is why it is a list here rather than a manifest flag.
 *
 * `tool.feedback-log::feedbackFilePath` is the other host-injected path and is
 * deliberately ABSENT: `tool.feedback-log`'s manifest declares no
 * `contributes.settings` at all, so `applyModuleSettingWrite` already refuses it
 * under the undeclared-key rule. Adding it here would be a redundant entry that
 * reads as the only thing stopping the write. Should that module ever declare a
 * settings schema, add it.
 */
export const HOST_INJECTED_SETTING_KEYS: readonly string[] = [
  'tool.reviewer-dossier::captureFilePath',
];

/**
 * The refusal when the write targets a host-injected key. Says the value is
 * host-managed rather than forbidden, because that is the accurate reason and it
 * stops an operator hunting for a permission they can grant.
 */
export const SETTINGS_WRITE_HOST_INJECTED_MESSAGE =
  'That setting is HOST-MANAGED: the extension injects its value into every composed session '
  + 'prompt, so anything written here would be overwritten at the next compose and read by '
  + 'nobody. The write was refused rather than accepted-then-discarded, and NOTHING was changed. '
  + 'Its manifest description says the same thing ("not user-editable"); the field exists so the '
  + 'value is VISIBLE in the Modules tab, not so it can be set.';

/**
 * Whether a `moduleId` / `fieldKey` pair names a host-injected key. Mirrors
 * `isSelfReferentialSettingsWrite`'s shape, trimming both halves so the same
 * whitespace tolerance applies here as at the applier.
 */
export function isHostInjectedSettingWrite(moduleId: string, fieldKey: string): boolean {
  if (typeof moduleId !== 'string' || typeof fieldKey !== 'string') return false;
  return HOST_INJECTED_SETTING_KEYS.includes(`${moduleId.trim()}::${fieldKey.trim()}`);
}
