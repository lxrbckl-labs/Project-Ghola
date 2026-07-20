// Centralized resolver for composed agent prompt file paths.
//
// One file is written per agent (TPM, SWE, QA) at session launch. Each path
// is derived from a stable hash of the current workspace folder so two VS
// Code windows hosting different workspaces never write to (and read from)
// the same file. Within a single workspace the path is stable across reopens
// — repeated session launches overwrite the same files cleanly so the
// `$GHOLA_*_PROMPT_FILE` env vars stay valid for the lifetime of any
// terminal they were injected into.
//
// Both the writer (`SettingsPanel.writeAllAgentPromptFiles`) and the launcher
// (`SessionLauncher.launch`'s env-var construction) call this helper so they
// always agree on the same target paths.

import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/** The three composed-prompt agent targets emitted by Ghola at session boot. */
export type AgentTarget = 'tpm' | 'swe' | 'qa';

/**
 * Resolve the path of the composed prompt file for `agent` in the current
 * workspace.
 *
 * Filename pattern: `ghola-<agent>-prompt-<12 hex chars>.md` where the hex is
 * the first 12 chars of sha256(workspaceFolderPath). When no workspace is open
 * (developer fallback when running the extension host with no folder loaded)
 * the suffix is the literal `default` so the path remains stable.
 */
export function resolveAgentPromptFilePath(agent: AgentTarget): string {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const suffix = workspaceFolder ? shortHash(workspaceFolder) : 'default';
  return path.join(os.tmpdir(), `ghola-${agent}-prompt-${suffix}.md`);
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
 * path's hash is derived from the WORKSPACE FOLDER, which is exactly what makes
 * it stable across reopens — and exactly what makes it useless for telling two
 * concurrent sessions in the SAME workspace apart, since both resolve to the
 * identical hash. Anything needing per-run isolation must key on this value
 * instead, not on the prompt-file suffix.
 *
 * Random rather than timestamp-derived so two sessions launched inside the same
 * millisecond still differ. Four bytes (8 hex chars) is ample: the values only
 * need to be distinct among the handful of sessions alive at one time, not
 * globally unique forever.
 */
export function newSessionId(): string {
  return crypto.randomBytes(4).toString('hex');
}
