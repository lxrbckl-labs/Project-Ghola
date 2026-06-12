import type * as vscode from 'vscode';
import { WORKSPACE_STATE_KEYS } from '../state/keys';
import type { NamedConfiguration } from './protocol';

/**
 * Persistence layer for named configuration presets. Mirrors the shape of
 * `ModuleState` — thin wrapper around a `vscode.Memento` (typically
 * `context.workspaceState`) with one in-memory representation per entry.
 *
 * Storage keys:
 *   - `nomeda.configurations`     : NamedConfiguration[]
 *   - `nomeda.activeConfigurationId` : string | null
 *
 * The store guarantees the single-default invariant: at most one entry has
 * `isDefault === true` at any time. `setDefault` zeros others atomically.
 */

export class ConfigurationsStore {
  constructor(private readonly memento: vscode.Memento) {}

  getAll(): NamedConfiguration[] {
    const raw = this.memento.get<NamedConfiguration[]>(WORKSPACE_STATE_KEYS.CONFIGURATIONS, []);
    return Array.isArray(raw) ? raw.map((c) => ({ ...c })) : [];
  }

  async setAll(list: NamedConfiguration[]): Promise<void> {
    await this.memento.update(WORKSPACE_STATE_KEYS.CONFIGURATIONS, list);
  }

  getActiveId(): string | null {
    const raw = this.memento.get<string | null>(WORKSPACE_STATE_KEYS.ACTIVE_CONFIGURATION_ID, null);
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  }

  async setActiveId(id: string | null): Promise<void> {
    await this.memento.update(WORKSPACE_STATE_KEYS.ACTIVE_CONFIGURATION_ID, id);
  }

  /**
   * Append a new configuration. Returns the persisted record (including its
   * generated id and createdAt timestamp). Does not change the active id —
   * callers decide whether to switch.
   */
  async add(
    name: string,
    enabledIds: string[],
    settings: Record<string, Record<string, unknown>>,
  ): Promise<NamedConfiguration> {
    const list = this.getAll();
    const next: NamedConfiguration = {
      id: makeId(),
      name,
      enabledIds: [...enabledIds],
      settings: deepClone(settings),
      isDefault: false,
      createdAt: Date.now(),
    };
    list.push(next);
    await this.setAll(list);
    return next;
  }

  /**
   * Append MANY configurations in a SINGLE `setAll` write (one atomic
   * `workspaceState.update`). Generates id + createdAt for each the same way
   * `add` does and forces `isDefault: false`. Preserves existing configs and
   * input order, and returns the created records. Used for all-or-nothing
   * seeding: if the write throws, no partial state is persisted.
   */
  async addMany(
    items: Array<{ name: string; enabledIds: string[]; settings: Record<string, Record<string, unknown>> }>,
  ): Promise<NamedConfiguration[]> {
    const created: NamedConfiguration[] = items.map((item) => ({
      id: makeId(),
      name: item.name,
      enabledIds: [...item.enabledIds],
      settings: deepClone(item.settings),
      isDefault: false,
      createdAt: Date.now(),
    }));
    await this.setAll([...this.getAll(), ...created]);
    return created;
  }

  async update(id: string, patch: Partial<Omit<NamedConfiguration, 'id'>>): Promise<void> {
    const list = this.getAll();
    const idx = list.findIndex((c) => c.id === id);
    if (idx === -1) return;
    const current = list[idx]!;
    list[idx] = {
      ...current,
      ...patch,
      // Deep-copy mutable substructures so callers cannot mutate stored data.
      enabledIds: patch.enabledIds ? [...patch.enabledIds] : current.enabledIds,
      settings: patch.settings ? deepClone(patch.settings) : current.settings,
      id: current.id,
    };
    await this.setAll(list);
  }

  async remove(id: string): Promise<void> {
    const list = this.getAll().filter((c) => c.id !== id);
    await this.setAll(list);
    if (this.getActiveId() === id) {
      await this.setActiveId(null);
    }
  }

  /**
   * Promote a single configuration to the default. Zeros `isDefault` on every
   * other entry atomically (single setAll write) to preserve the invariant.
   */
  async setDefault(id: string): Promise<void> {
    const list = this.getAll().map((c) => ({ ...c, isDefault: c.id === id }));
    await this.setAll(list);
  }

  findById(id: string): NamedConfiguration | undefined {
    return this.getAll().find((c) => c.id === id);
  }
}

function makeId(): string {
  // crypto.randomUUID is available in Node 14.17+ / Electron / modern VS Code hosts.
  // Fall back to a quick Math.random composite if missing.
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const seg = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `${seg()}-${seg()}-${seg()}-${seg()}`;
}

function deepClone<T>(v: T): T {
  // Settings dicts are small JSON-safe trees; structuredClone would be cleaner
  // but isn't universally available across VS Code Electron versions. The
  // JSON round-trip suffices for the values we store.
  return JSON.parse(JSON.stringify(v)) as T;
}
