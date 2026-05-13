// Centralized resolver for composed agent prompt file paths.
//
// One file is written per agent (TPM, SWE, QA) at session launch. Each path
// is derived from a stable hash of the current workspace folder so two VS
// Code windows hosting different workspaces never write to (and read from)
// the same file. Within a single workspace the path is stable across reopens
// — repeated session launches overwrite the same files cleanly so the
// `$NOMEDA_*_PROMPT_FILE` env vars stay valid for the lifetime of any
// terminal they were injected into.
//
// Both the writer (`SettingsPanel.writeAllAgentPromptFiles`) and the launcher
// (`SessionLauncher.launch`'s env-var construction) call this helper so they
// always agree on the same target paths.

import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/** The three composed-prompt agent targets emitted by Nomeda at session boot. */
export type AgentTarget = 'tpm' | 'swe' | 'qa';

/**
 * Resolve the path of the composed prompt file for `agent` in the current
 * workspace.
 *
 * Filename pattern: `nomeda-<agent>-prompt-<12 hex chars>.md` where the hex is
 * the first 12 chars of sha256(workspaceFolderPath). When no workspace is open
 * (developer fallback when running the extension host with no folder loaded)
 * the suffix is the literal `default` so the path remains stable.
 */
export function resolveAgentPromptFilePath(agent: AgentTarget): string {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const suffix = workspaceFolder ? shortHash(workspaceFolder) : 'default';
  return path.join(os.tmpdir(), `nomeda-${agent}-prompt-${suffix}.md`);
}

/** First 12 hex chars of sha256(input). Plenty of entropy for collision-free workspace separation. */
function shortHash(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 12);
}
