import * as path from 'path';
import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { ModuleLoader } from './modules/loader';
import { ModuleState } from './modules/state';
import { PromptComposer } from './prompts/composer';
import { SessionLauncher } from './session/launcher';
import { SettingsPanel } from './settings-panel/host';

export function activate(context: vscode.ExtensionContext): void {
  const logger = vscode.window.createOutputChannel('Nomeda');
  context.subscriptions.push(logger);
  logger.appendLine('[nomeda] activating v0.0.1');

  const moduleState = new ModuleState(context.workspaceState);
  const loader = new ModuleLoader(moduleState, {
    defaultEnabledIds: ['core.preamble', 'core.tpm', 'core.swe', 'core.qa'],
    logger,
  });
  context.subscriptions.push({ dispose: () => loader.dispose() });

  const composer = new PromptComposer(loader, logger);

  const session = new SessionLauncher(loader, logger);
  const panel = new SettingsPanel(context, loader, composer, logger);
  context.subscriptions.push(panel);

  registerCommands(context, {
    loader,
    panel,
    session,
    resolveModulesDir: resolveModulesDirFn(context),
    logger,
  });

  // Initial discovery (best-effort).
  void loader.discover(resolveModulesDirFn(context)()).then((handles) => {
    logger.appendLine(`[nomeda] discovered ${handles.length} module(s)`);
  });

  // File watcher: re-discover and re-broadcast composed prompts whenever a
  // manifest.json is added, changed, or deleted (250 ms debounce).
  const watcherDisposable = loader.watchManifests(resolveModulesDirFn(context), () => {
    panel.broadcastComposedPrompts();
  });
  context.subscriptions.push(watcherDisposable);

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

function resolveModulesDirFn(context: vscode.ExtensionContext): () => string {
  return () => {
    const cfg = vscode.workspace.getConfiguration('nomeda');
    const rel = cfg.get<string>('modulesDir') ?? 'modules';
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? context.extensionPath;
    return path.isAbsolute(rel) ? rel : path.join(root, rel);
  };
}
