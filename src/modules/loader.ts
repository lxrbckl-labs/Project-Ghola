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

  constructor(
    private readonly state: ModuleState,
    private readonly options: ModuleLoaderOptions = {},
  ) {}

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
    this.emitter.dispose();
  }

  private log(msg: string): void {
    this.options.logger?.appendLine(`[loader] ${msg}`);
  }
}
