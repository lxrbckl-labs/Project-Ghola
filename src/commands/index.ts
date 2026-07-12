import * as path from 'path';
import * as vscode from 'vscode';
import type { ModuleLoader } from '../modules/loader';
import type { SessionLauncher } from '../session/launcher';
import type { SettingsPanel } from '../settings-panel/host';
import { registerCommitAndPushCommand } from './commitAndPush';
import { registerUpdateExtensionCommand } from './updateExtension';

export interface CommandDeps {
  loader: ModuleLoader;
  panel: SettingsPanel;
  session: SessionLauncher;
  resolveModulesDir(): string;
  logger: vscode.OutputChannel;
}

export function registerCommands(
  context: vscode.ExtensionContext,
  deps: CommandDeps,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('nomeda.openSettings', () => {
      deps.panel.open();
    }),
    vscode.commands.registerCommand('nomeda.openSession', async () => {
      try {
        // Compose + write the TPM, SWE, and QA prompts BEFORE creating the
        // terminal so all three files are on disk by the time the shell
        // evaluates `$(cat …)` in the default sessionCommand and by the time
        // TPM later spawns a subagent and reads $NOMEDA_SWE_PROMPT_FILE /
        // $NOMEDA_QA_PROMPT_FILE. Paths are the same well-known locations the
        // launcher exposes via NOMEDA_{TPM,SWE,QA}_PROMPT_FILE. Fail-closed:
        // if any write throws the terminal is never created.
        await deps.panel.writeAllAgentPromptFiles();
        await deps.session.launch();
        // War Mode: auto-open the War Room after launch when the mode is
        // enabled and its `autoOpenWarRoom` sub-toggle is on. Defensive —
        // getResolvedGholaSettings() returns null when mode.war is disabled,
        // so the optional chain short-circuits. Wrapped so a War Room hiccup
        // never breaks the RUN path (the session has already launched).
        try {
          if (deps.panel.getResolvedGholaSettings()?.autoOpenWarRoom) {
            deps.panel.revealWarRoom();
          }
        } catch (warRoomErr) {
          deps.logger.appendLine(
            `[command] ghola auto-open War Room skipped: ${(warRoomErr as Error).message}`,
          );
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Nomeda: failed to launch session — ${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand('nomeda.reloadModules', async () => {
      const dir = deps.resolveModulesDir();
      deps.logger.appendLine(`[command] reloading modules from ${dir}`);
      const handles = await deps.loader.discover(dir);
      vscode.window.setStatusBarMessage(
        `Nomeda: discovered ${handles.length} module${handles.length === 1 ? '' : 's'} in ${path.basename(dir)}/`,
        3000,
      );
    }),
    // Self-update: pull/rebuild/repackage/reinstall this extension from its git
    // checkout. Implemented in updateExtension.ts; returns its own disposable.
    registerUpdateExtensionCommand(context),
    // Commit-and-Push button: dispatches a one-shot Claude agent that commits
    // staged changes and pushes. Implemented in commitAndPush.ts.
    registerCommitAndPushCommand(context, deps),
  );
}
