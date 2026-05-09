import * as path from 'path';
import * as vscode from 'vscode';
import type { ModuleLoader } from '../modules/loader';
import type { SessionLauncher } from '../session/launcher';
import type { SettingsPanel } from '../settings-panel/host';

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
  );
}
