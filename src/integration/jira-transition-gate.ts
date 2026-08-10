/**
 * HOST-SIDE enforcement of `integration.atlassian-suite`'s
 * `enableJiraTransition` gate — the outer gate on moving a Jira issue from one
 * workflow status to another.
 *
 * Why this file exists: a Jira TRANSITION is the archetype of the mutation the
 * agent cores forbid outright, and until now the honest answer to "can the
 * bridge transition an issue?" was "no, there is no such code". Adding the
 * capability at all is only safe if the authorization is enforced where the
 * capability lives. Prose does not enforce anything: the comment-write gate
 * spent its first life as module markdown that asked an agent to refuse, and an
 * agent that never read the module could write to Jira with the gate off. This
 * file is the same lesson applied BEFORE the capability ships — when the gate is
 * off the extension withholds the transition function itself, so the bridge
 * route has nothing to call and no request reaches Jira.
 *
 * FAIL CLOSED IS THE WHOLE POINT. Every function here is written so that the
 * ENABLED branch requires an affirmative `true` and every other outcome —
 * absent key, non-boolean value, missing settings map, module not enabled,
 * accessor throwing — falls through to DISABLED. There is deliberately no
 * manifest-default fallback (unlike `readAtlassianSetting`, which does fall
 * back so pre-populated string fields validate before a first save): a security
 * gate must not be enableable by editing a manifest default, and the declared
 * default is `false` anyway, so the fallback could only ever weaken this.
 *
 * DELIBERATELY A SECOND FILE, NOT A SHARED HELPER. This is a near-copy of
 * `jira-comment-write-gate.ts` and that duplication is the design, not an
 * oversight. A single gate parameterized over two capabilities is one careless
 * edit — a defaulted argument, a widened union, a "while I am here" refactor —
 * away from letting one setting open both doors. Two capabilities, two files,
 * two independent decisions. If you find yourself merging them, that is the
 * change this comment exists to stop.
 *
 * Pure and vscode-free on purpose. The caller injects the two reads as thunks,
 * which keeps this decision drivable in isolation (type-strip + call it) rather
 * than only reachable through a running extension host.
 */

/** Module id owning the gate. Matches `ATLASSIAN_MODULE_ID` in `extension.ts`. */
export const JIRA_TRANSITION_MODULE_ID = 'integration.atlassian-suite';

/** Field key of the gate setting inside that module's `contributes.settings`. */
export const JIRA_TRANSITION_FIELD_KEY = 'enableJiraTransition';

/**
 * Flat `moduleId::fieldKey` key the gate's value is stored under in the
 * module-settings map (see `state/module-settings.ts`).
 */
export const JIRA_TRANSITION_SETTING_KEY =
  `${JIRA_TRANSITION_MODULE_ID}::${JIRA_TRANSITION_FIELD_KEY}`;

/**
 * The refusal the bridge sends — and `bb-bridge.mjs` prints — when the route is
 * hit with the gate off. It names the module, the setting's storage key, and the
 * Modules-tab label so an operator reading a terminal knows exactly which
 * checkbox to tick, instead of staring at a generic 404 or a silent no-op.
 */
export const JIRA_TRANSITION_DISABLED_MESSAGE =
  'Jira issue transitions are disabled host-side: '
  + `\`${JIRA_TRANSITION_MODULE_ID}\`'s \`${JIRA_TRANSITION_FIELD_KEY}\` setting is not on, `
  + 'so the extension withheld the transition capability from this bridge and nothing was sent to Jira. '
  + 'The issue\'s status is unchanged. To enable it, turn on "Enable Jira Transition" on the '
  + 'Atlassian Suite module in Ghola\'s Modules tab (the module itself must also be enabled). '
  + 'Reading the available transitions (`get-transitions`) is unaffected and works either way.';

/** The two reads the gate decision needs, injected so this stays vscode-free. */
export interface JiraTransitionGateReaders {
  /**
   * Whether `integration.atlassian-suite` is currently ENABLED in this window.
   * `undefined` is the honest answer when the module loader has not discovered
   * modules yet (or the module is not installed) and, like `false`, closes the
   * gate.
   */
  isModuleEnabled: () => boolean | undefined;
  /** The flat `moduleId::fieldKey` module-settings map. */
  readSettings: () => Record<string, unknown> | undefined;
}

/**
 * Resolve the gate. Returns `true` ONLY when both conditions hold:
 *
 *   1. `integration.atlassian-suite` is enabled, AND
 *   2. its `enableJiraTransition` value is the boolean `true`.
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
export function isJiraTransitionEnabled(readers: JiraTransitionGateReaders): boolean {
  try {
    if (readers.isModuleEnabled() !== true) return false;
    const flat = readers.readSettings();
    if (flat === null || typeof flat !== 'object') return false;
    // Strict identity against `true`: the string 'true', 1, and every other
    // truthy-but-not-boolean value stored by a hand-edited or legacy state blob
    // resolve to DISABLED rather than being coerced into permission.
    return flat[JIRA_TRANSITION_SETTING_KEY] === true;
  } catch {
    return false;
  }
}
