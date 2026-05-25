import type * as vscode from 'vscode';
import { WORKSPACE_STATE_KEYS } from '../state/keys';

export class ModuleState {
  constructor(private readonly memento: vscode.Memento) {}

  getEnabledIds(): string[] {
    const raw = this.memento.get<string[]>(WORKSPACE_STATE_KEYS.ENABLED_MODULES, []);
    return Array.isArray(raw) ? [...raw] : [];
  }

  async setEnabledIds(ids: string[]): Promise<void> {
    const unique = Array.from(new Set(ids));
    await this.memento.update(WORKSPACE_STATE_KEYS.ENABLED_MODULES, unique);
    await this.memento.update(WORKSPACE_STATE_KEYS.ENABLED_MODULES_INITIALIZED, true);
  }

  async enable(id: string): Promise<void> {
    const current = new Set(this.getEnabledIds());
    current.add(id);
    await this.setEnabledIds([...current]);
  }

  async disable(id: string): Promise<void> {
    const current = new Set(this.getEnabledIds());
    current.delete(id);
    await this.setEnabledIds([...current]);
  }

  isEnabled(id: string): boolean {
    return this.getEnabledIds().includes(id);
  }

  /** True the first time the loader runs in a workspace (defaults can be applied). */
  isFirstRun(): boolean {
    return this.memento.get<boolean>(WORKSPACE_STATE_KEYS.ENABLED_MODULES_INITIALIZED, false) === false;
  }
}
