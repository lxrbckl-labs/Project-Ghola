import * as path from 'path';
import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { ModuleLoader } from './modules/loader';
import { ModuleState } from './modules/state';
import { PromptComposer } from './prompts/composer';
import { SessionLauncher } from './session/launcher';
import { SettingsPanel } from './settings-panel/host';
import { StateWatcher } from './state/watcher';
import { NomedaStatusBar } from './status-bar';

export function activate(context: vscode.ExtensionContext): void {
  const logger = vscode.window.createOutputChannel('Nomeda');
  context.subscriptions.push(logger);
  logger.appendLine('[nomeda] activating v0.0.1');

  const moduleState = new ModuleState(context.workspaceState);
  const loader = new ModuleLoader(moduleState, {
    defaultEnabledIds: ['reference.hello-nomeda', 'core.tpm', 'core.swe', 'core.qa'],
    logger,
  });
  context.subscriptions.push({ dispose: () => loader.dispose() });

  const composer = new PromptComposer(loader, logger);

  const stateFileAbs = resolveStateFile();
  const watcher = new StateWatcher(stateFileAbs, logger);
  context.subscriptions.push(watcher);

  const statusBar = new NomedaStatusBar();
  context.subscriptions.push(statusBar);
  context.subscriptions.push(watcher.onDidChange((s) => statusBar.update(s)));

  const session = new SessionLauncher(loader, composer, logger);
  const panel = new SettingsPanel(context, loader, composer, watcher, logger);
  context.subscriptions.push(panel);

  registerCommands(context, {
    loader,
    panel,
    session,
    resolveModulesDir: resolveModulesDirFn(),
    logger,
  });

  watcher.start();

  // Initial discovery (best-effort).
  void loader.discover(resolveModulesDirFn()()).then((handles) => {
    logger.appendLine(`[nomeda] discovered ${handles.length} module(s)`);
  });

  // React to config changes that affect paths.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('nomeda.modulesDir')) {
        void vscode.commands.executeCommand('nomeda.reloadModules');
      }
    }),
  );
}

export function deactivate(): void {
  // No-op; subscriptions handle cleanup.
}

function resolveStateFile(): string {
  const cfg = vscode.workspace.getConfiguration('nomeda');
  const rel = cfg.get<string>('stateFile') ?? '.nomeda/state.json';
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  return path.isAbsolute(rel) ? rel : path.join(root, rel);
}

function resolveModulesDirFn(): () => string {
  return () => {
    const cfg = vscode.workspace.getConfiguration('nomeda');
    const rel = cfg.get<string>('modulesDir') ?? '.nomeda/modules';
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    return path.isAbsolute(rel) ? rel : path.join(root, rel);
  };
}
