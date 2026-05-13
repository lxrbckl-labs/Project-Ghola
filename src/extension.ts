import * as path from 'path';
import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { ModuleLoader } from './modules/loader';
import { ModuleState } from './modules/state';
import { PromptComposer } from './prompts/composer';
import { SessionLauncher } from './session/launcher';
import { ConfigurationsStore } from './settings-panel/configurations-store';
import { SettingsPanel } from './settings-panel/host';

export function activate(context: vscode.ExtensionContext): void {
  const logger = vscode.window.createOutputChannel('Nomeda');
  context.subscriptions.push(logger);
  logger.appendLine('[nomeda] activating v0.0.1');

  const moduleState = new ModuleState(context.workspaceState);
  const loader = new ModuleLoader(moduleState, {
    // Cores live in prompts/cores/ and are not modules. The IDs listed here are
    // the modules enabled on first run so the session boots with the same
    // baseline capabilities the cores used to ship inline.
    defaultEnabledIds: [
      'tool.git',
      'tool.dotnet-suite',
      'tool.npm-suite',
      'tool.database-access',
      'tool.lenses',
    ],
    logger,
  });
  context.subscriptions.push({ dispose: () => loader.dispose() });

  // Cores ship with the extension and are read from the extension install path,
  // never the workspace. Always resolve relative to context.extensionPath.
  const coresPath = path.join(context.extensionPath, 'prompts', 'cores');
  const composer = new PromptComposer(loader, coresPath, logger);

  const session = new SessionLauncher(loader, context.extensionPath, context.workspaceState, logger);
  const configurationsStore = new ConfigurationsStore(context.workspaceState);
  const resolveModulesDir = resolveModulesDirFn(context);
  const panel = new SettingsPanel(
    context,
    loader,
    composer,
    configurationsStore,
    resolveModulesDir,
    logger,
  );
  context.subscriptions.push(panel);

  registerCommands(context, {
    loader,
    panel,
    session,
    resolveModulesDir,
    logger,
  });

  // Initial discovery (best-effort). After discover() resolves we apply any
  // user-flagged default configuration so the workspace boots into the same
  // preset they last marked as default. The dev-mode openSettings call below
  // intentionally runs after this chain so the panel renders with the applied
  // configuration in place.
  void loader.discover(resolveModulesDirFn(context)()).then(async (handles) => {
    logger.appendLine(`[nomeda] discovered ${handles.length} module(s)`);
    await panel.applyDefaultOnStartup();
    if (context.extensionMode === vscode.ExtensionMode.Development) {
      vscode.commands.executeCommand('nomeda.openSettings');
    }
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

  // Dev-mode convenience auto-open lives inside the discover().then() block
  // above so it runs after applyDefaultOnStartup completes.
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
