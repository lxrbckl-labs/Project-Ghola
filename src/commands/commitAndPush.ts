import * as path from 'path';
import * as vscode from 'vscode';
import { readModuleSettings } from '../state/module-settings';
import type { CommandDeps } from './index';

/** Module id whose enablement gates the Commit-and-Push button. */
const COMMIT_PUSH_MODULE_ID = 'tool.commit-push';

/** Workspace-state flat key for the user-configurable commit message template. */
const COMMIT_MESSAGE_FORMAT_KEY = `${COMMIT_PUSH_MODULE_ID}::commitMessageFormat`;

/**
 * Default commit message format. MUST match the manifest default that the
 * commit-push module ships so the fallback (used when the user has never edited
 * the setting) is identical to the documented out-of-the-box behavior.
 */
const DEFAULT_COMMIT_MESSAGE_FORMAT = '[TICKET] <type>: <summary>';

/**
 * Register the `ghola.commitAndPush` command. Dispatches a one-shot Claude
 * agent into a dedicated terminal that reads the module's procedure file and
 * commits the already-staged changes on the current branch, then pushes.
 * Returns the disposable so the caller can push it onto context.subscriptions.
 */
export function registerCommitAndPushCommand(
  context: vscode.ExtensionContext,
  deps: CommandDeps,
): vscode.Disposable {
  return vscode.commands.registerCommand('ghola.commitAndPush', async () => {
    try {
      // Guard: refuse when the module is disabled. The view's `when` clause
      // normally hides the button, but the command can still be invoked from
      // the palette, so we re-check here.
      if (deps.loader.find(COMMIT_PUSH_MODULE_ID)?.isEnabled !== true) {
        vscode.window.showWarningMessage(
          'Ghola: Commit and Push module is disabled. Enable it in the Modules tab.',
        );
        return;
      }

      // Read the format template from the flat module-settings dictionary,
      // falling back to the shipped default when unset or non-string.
      const flat = readModuleSettings(context.globalState, context.workspaceState);
      const fmt =
        (typeof flat[COMMIT_MESSAGE_FORMAT_KEY] === 'string'
          ? (flat[COMMIT_MESSAGE_FORMAT_KEY] as string)
          : undefined) ?? DEFAULT_COMMIT_MESSAGE_FORMAT;

      // Sanitize defensively so the template stays single-line and cannot break
      // out of the prompt line it is embedded in.
      const sanitizedFmt = fmt.replace(/[\r\n]+/g, ' ').trim();

      // Resolve the absolute path to the module's procedure file. resolveModulesDir
      // is a function returning the current modules dir.
      const mdPath = path.join(deps.resolveModulesDir(), COMMIT_PUSH_MODULE_ID, 'commit-push.md');

      // Build the self-contained prompt. The template is embedded as plain
      // descriptive text, never interpolated into a shell command.
      const prompt =
        `[Ghola Commit Task] Read the procedure file at ${mdPath} and follow it EXACTLY, then stop. ` +
        `Commit message format template: ${sanitizedFmt} ` +
        `Rules: commit ONLY what is already staged (do not run git add), on the CURRENT branch, then push. ` +
        `Never force-push, branch, reset, rebase, or stash. If nothing is staged, do nothing and report.`;

      await deps.session.launch({ terminalName: 'Ghola Commit', promptOverride: prompt });
    } catch (err) {
      vscode.window.showErrorMessage(
        `Ghola: failed to dispatch commit and push — ${(err as Error).message}`,
      );
    }
  });
}
