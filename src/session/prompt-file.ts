// Centralized resolver for composed agent prompt file paths.
//
// One file is written per agent (TPM, SWE, QA) at session launch. Each path
// carries TWO suffix segments:
//
//   1. A stable hash of the current workspace folder, so two VS Code windows
//      hosting different workspaces never write to (and read from) the same
//      file, and so `ls`-ing the temp dir still groups a workspace's files
//      together.
//   2. A per-EXTENSION-HOST-INSTANCE token (see `instanceToken`), so two VS
//      Code windows hosting the SAME workspace — a second window, a second VS
//      Code profile, a different configuration preset — never do either.
//
// Segment 2 exists because segment 1 alone is identical for every session in a
// workspace, and `SettingsPanel.writeAllAgentPromptFiles` overwrites its target
// files unconditionally with no locking: launching a second session in the same
// repo silently rewrote the first session's TPM/SWE/QA prompts underneath a
// still-running agent. The token closes that.
//
// Both the writer (`SettingsPanel.writeAllAgentPromptFiles`) and the launcher
// (`SessionLauncher.launch`'s env-var construction) call this helper so they
// always agree on the same target paths. That agreement is what makes the
// instance token safe: both callers live in the SAME extension-host process, so
// they observe the same token value, and the only consumers of these paths read
// them back out of the `$GHOLA_*_PROMPT_FILE` env vars the launcher injected
// (the boot probe, `tool.session-bootstrap`, and TPM's subagent-prompt
// injection all do exactly that — nothing re-derives the path).

import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/** The three composed-prompt agent targets emitted by Ghola at session boot. */
export type AgentTarget = 'tpm' | 'swe' | 'qa';

/**
 * Random token identifying THIS extension-host instance, minted once when this
 * module is first loaded and constant for the life of the process.
 *
 * Why a process-scoped token rather than a per-launch one: the two producers of
 * the path (the panel's writer and the launcher's env block) are separate calls
 * with no shared parameter between them — the writer runs first, the launcher
 * re-resolves afterwards — so anything that changed value between those two
 * calls would hand the terminal an env var pointing at a file that was never
 * written. A process-scoped token is the strongest key both producers can agree
 * on without plumbing paths through `ghola.openSession`. It is sufficient in
 * practice because a single extension host hosts at most ONE live session
 * terminal (`launch()` disposes any same-named terminal before creating a new
 * one), while the collisions the operator actually hits are between separate
 * windows/profiles — separate processes, hence separate tokens.
 *
 * Random rather than `process.pid`: PIDs are recycled, and a terminal outlives
 * the extension host that spawned it (VS Code keeps terminals across a window
 * reload), so a recycled PID could name the file of a still-running session.
 * Four bytes matches `newSessionId` and is ample for the handful of hosts alive
 * at one time.
 */
const instanceToken = crypto.randomBytes(4).toString('hex');

/**
 * Resolve the path of the composed prompt file for `agent` in the current
 * workspace, for this extension-host instance.
 *
 * Filename pattern: `ghola-<agent>-prompt-<12 hex chars>-<8 hex chars>.md`,
 * where the first group is the first 12 chars of sha256(workspaceFolderPath)
 * and the second is `instanceToken`. When no workspace is open (developer
 * fallback when running the extension host with no folder loaded) the workspace
 * group is the literal `default`.
 *
 * BACK-COMPAT: the old pattern had no `-<8 hex chars>` group, so a session
 * still running against an old-style path is inherently safe — the new name can
 * never resolve to the old file, nothing overwrites it, and (per Ghola's
 * no-deletions rule) nothing removes it either. Its `$GHOLA_*_PROMPT_FILE` env
 * vars stay valid for as long as that terminal lives.
 *
 * TEMP-DIR GROWTH: because the paths are no longer overwritten across
 * processes, each extension-host instance leaves three files behind. Growth is
 * therefore bounded by "3 x windows opened", not by launches, and the names are
 * bounded-length and prefix-greppable (`ghola-*-prompt-*`). Reaping is
 * deliberately left to the OS temp-dir policy and to the operator — Ghola never
 * deletes files.
 */
export function resolveAgentPromptFilePath(agent: AgentTarget): string {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const workspaceKey = workspaceFolder ? shortHash(workspaceFolder) : 'default';
  return path.join(os.tmpdir(), `ghola-${agent}-prompt-${workspaceKey}-${instanceToken}.md`);
}

/** First 12 hex chars of sha256(input). Plenty of entropy for collision-free workspace separation. */
function shortHash(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 12);
}

/**
 * Generate a fresh per-SESSION identifier, exported by the launcher as
 * `GHOLA_SESSION_ID`.
 *
 * Note the deliberate contrast with `resolveAgentPromptFilePath` above. That
 * path is keyed on the WORKSPACE FOLDER plus this extension-host INSTANCE —
 * both of which are stable for the life of the process, which is exactly what
 * lets the writer and the launcher agree on one path, and exactly what makes
 * the path useless for telling two LAUNCHES apart within one window. Anything
 * needing per-run isolation must key on this value instead, not on the
 * prompt-file suffix.
 *
 * Random rather than timestamp-derived so two sessions launched inside the same
 * millisecond still differ. Four bytes (8 hex chars) is ample: the values only
 * need to be distinct among the handful of sessions alive at one time, not
 * globally unique forever.
 */
export function newSessionId(): string {
  return crypto.randomBytes(4).toString('hex');
}
