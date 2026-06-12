import * as path from 'path';
import * as vscode from 'vscode';
import type { ModuleLoader } from '../modules/loader';
import type { SessionLauncher } from '../session/launcher';
import type { SettingsPanel } from '../settings-panel/host';
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
  );
}
