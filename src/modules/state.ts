import type * as vscode from 'vscode';

const ENABLED_KEY = 'nomeda.enabledModules';
const FIRST_RUN_DONE_KEY = 'nomeda.enabledModules.initialized';

export class ModuleState {
  constructor(private readonly memento: vscode.Memento) {}

  getEnabledIds(): string[] {
    const raw = this.memento.get<string[]>(ENABLED_KEY, []);
    return Array.isArray(raw) ? [...raw] : [];
  }

  async setEnabledIds(ids: string[]): Promise<void> {
    const unique = Array.from(new Set(ids));
    await this.memento.update(ENABLED_KEY, unique);
    await this.memento.update(FIRST_RUN_DONE_KEY, true);
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
    return this.memento.get<boolean>(FIRST_RUN_DONE_KEY, false) === false;
  }
}
