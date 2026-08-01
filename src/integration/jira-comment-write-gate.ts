/**
 * HOST-SIDE enforcement of `integration.atlassian-suite`'s
 * `enableJiraCommentWrite` gate — the outer gate on the suite's single Jira
 * write (posting a comment to an existing issue).
 *
 * Why this file exists: the gate used to be PROMPT-LEVEL only. The module's
 * markdown told the agent to refuse when the setting was off, and the code
 * cheerfully served `/post-comment` either way — so the guarantee the operator
 * approved rested entirely on an agent choosing to comply with prose. An agent
 * that never read the module (or read it and ignored it) could post a Jira
 * comment with the gate off. This module turns that suggestion into a real
 * refusal: when the gate is off the extension withholds the `postComment`
 * function itself, so the bridge route has nothing to call.
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
 * Pure and vscode-free on purpose. The caller injects the two reads as thunks,
 * which keeps this decision drivable in isolation (type-strip + call it) rather
 * than only reachable through a running extension host.
 */

/** Module id owning the gate. Matches `ATLASSIAN_MODULE_ID` in `extension.ts`. */
export const JIRA_COMMENT_WRITE_MODULE_ID = 'integration.atlassian-suite';

/** Field key of the gate setting inside that module's `contributes.settings`. */
export const JIRA_COMMENT_WRITE_FIELD_KEY = 'enableJiraCommentWrite';

/**
 * Flat `moduleId::fieldKey` key the gate's value is stored under in the
 * module-settings map (see `state/module-settings.ts`).
 */
export const JIRA_COMMENT_WRITE_SETTING_KEY =
  `${JIRA_COMMENT_WRITE_MODULE_ID}::${JIRA_COMMENT_WRITE_FIELD_KEY}`;

/**
 * The refusal the bridge sends — and `bb-bridge.mjs` prints — when the route is
 * hit with the gate off. It names the module, the setting's storage key, and the
 * Modules-tab label so an operator reading a terminal knows exactly which
 * checkbox to tick, instead of staring at a generic 404 or a silent no-op.
 */
export const JIRA_COMMENT_WRITE_DISABLED_MESSAGE =
  'Jira comment posting is disabled host-side: '
  + `\`${JIRA_COMMENT_WRITE_MODULE_ID}\`'s \`${JIRA_COMMENT_WRITE_FIELD_KEY}\` setting is not on, `
  + 'so the extension withheld the comment-write capability from this bridge and nothing was sent to Jira. '
  + 'To enable it, turn on "Enable Jira Comment Write" on the Atlassian Suite module in Ghola\'s '
  + 'Modules tab (the module itself must also be enabled). Comment READING (`get-comments`) is '
  + 'unaffected and works either way.';

/** The two reads the gate decision needs, injected so this stays vscode-free. */
export interface JiraCommentWriteGateReaders {
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
 *   2. its `enableJiraCommentWrite` value is the boolean `true`.
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
export function isJiraCommentWriteEnabled(readers: JiraCommentWriteGateReaders): boolean {
  try {
    if (readers.isModuleEnabled() !== true) return false;
    const flat = readers.readSettings();
    if (flat === null || typeof flat !== 'object') return false;
    // Strict identity against `true`: the string 'true', 1, and every other
    // truthy-but-not-boolean value stored by a hand-edited or legacy state blob
    // resolve to DISABLED rather than being coerced into permission.
    return flat[JIRA_COMMENT_WRITE_SETTING_KEY] === true;
  } catch {
    return false;
  }
}
