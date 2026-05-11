import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { validateManifest } from '../manifest/validator';
import type { ModuleHandle } from './handle';
import type { ModuleState } from './state';

export interface ModuleLoaderOptions {
  /** Modules whose ids are listed here are enabled by default on first run. */
  defaultEnabledIds?: string[];
  /** Channel for diagnostic logs. */
  logger?: vscode.OutputChannel;
}

export class ModuleLoader {
  private handles: ModuleHandle[] = [];
  private readonly emitter = new vscode.EventEmitter<ModuleHandle[]>();
  readonly onDidChange = this.emitter.event;

  /** Active file-system watcher, if one has been attached via watchManifests(). */
  private watcher: vscode.FileSystemWatcher | undefined;
  /** Pending debounce timer handle. */
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly state: ModuleState,
    private readonly options: ModuleLoaderOptions = {},
  ) {}

  /**
   * Create a file-system watcher on a recursive manifest.json glob relative to
   * the workspace root and wire a 250 ms debounced re-discover + re-broadcast
   * on add / change / delete events.  Call once at activation; the returned
   * disposable (or the loader's own dispose()) tears it down.
   *
   * @param resolveModulesDir  Callback that returns the current modules dir at
   *   call time (matches the `resolveModulesDirFn` closure used in extension.ts).
   * @param onRefresh  Called after each debounced discover so the host can
   *   re-broadcast composed prompts to the webview.
   */
  watchManifests(
    resolveModulesDir: () => string,
    onRefresh?: () => void,
  ): vscode.Disposable {
    const pattern = new vscode.RelativePattern(
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
        vscode.env.appRoot, // safe fallback — watcher just won't fire
      '**/manifest.json',
    );
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const schedule = () => {
      if (this.debounceTimer !== undefined) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = undefined;
        void this.discover(resolveModulesDir()).then(() => {
          onRefresh?.();
        });
      }, 250);
    };

    this.watcher.onDidCreate(schedule);
    this.watcher.onDidChange(schedule);
    this.watcher.onDidDelete(schedule);

    return { dispose: () => this.disposeWatcher() };
  }

  async discover(modulesDir: string): Promise<ModuleHandle[]> {
    this.handles = [];
    let entries: import('fs').Dirent[] = [];
    try {
      entries = await fs.readdir(modulesDir, { withFileTypes: true });
    } catch (err) {
      this.log(`module dir not found or unreadable: ${modulesDir} (${(err as Error).message})`);
      this.emitter.fire(this.handles);
      return this.handles;
    }

    const enabledIds = new Set(this.state.getEnabledIds());
    const seenFirstRun = this.state.isFirstRun();

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const moduleRoot = path.join(modulesDir, entry.name);
      const manifestPath = path.join(moduleRoot, 'manifest.json');
      let raw: string;
      try {
        raw = await fs.readFile(manifestPath, 'utf-8');
      } catch {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        this.log(`invalid JSON in ${manifestPath}: ${(err as Error).message}`);
        continue;
      }

      const result = validateManifest(parsed);
      if (!result.ok) {
        this.log(`manifest validation failed (${manifestPath}):\n  - ${result.errors.join('\n  - ')}`);
        continue;
      }

      const manifest = result.manifest;
      const defaultEnabled = this.options.defaultEnabledIds ?? [];
      const isEnabled = enabledIds.has(manifest.id) ||
        (seenFirstRun && defaultEnabled.includes(manifest.id));

      this.handles.push({ manifest, rootPath: moduleRoot, isEnabled });
    }

    // Prune stale enabled IDs: any ID in workspaceState that no longer exists
    // on disk is removed.  Runs on every discover() to prevent unbounded
    // accumulation of orphaned IDs when modules are deleted or renamed.
    const liveIds = new Set(this.handles.map((h) => h.manifest.id));
    const currentEnabled = this.state.getEnabledIds();
    const prunedEnabled = currentEnabled.filter((id) => liveIds.has(id));
    if (prunedEnabled.length !== currentEnabled.length) {
      await this.state.setEnabledIds(prunedEnabled);
    }

    // Persist first-run state (even if empty) so toggling-all-off is honored on next reload.
    if (seenFirstRun) {
      const initial = this.handles.filter((h) => h.isEnabled).map((h) => h.manifest.id);
      await this.state.setEnabledIds(initial);
    }

    this.emitter.fire(this.handles);
    return this.handles;
  }

  getAll(): ModuleHandle[] {
    return [...this.handles];
  }

  getEnabled(): ModuleHandle[] {
    return this.handles.filter((h) => h.isEnabled);
  }

  find(id: string): ModuleHandle | undefined {
    return this.handles.find((h) => h.manifest.id === id);
  }

  async enable(id: string): Promise<void> {
    await this.state.enable(id);
    const handle = this.find(id);
    if (handle) handle.isEnabled = true;
    this.emitter.fire(this.handles);
  }

  async disable(id: string): Promise<void> {
    await this.state.disable(id);
    const handle = this.find(id);
    if (handle) handle.isEnabled = false;
    this.emitter.fire(this.handles);
  }

  dispose(): void {
    this.disposeWatcher();
    this.emitter.dispose();
  }

  private disposeWatcher(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.watcher?.dispose();
    this.watcher = undefined;
  }

  private log(msg: string): void {
    this.options.logger?.appendLine(`[loader] ${msg}`);
  }
}
