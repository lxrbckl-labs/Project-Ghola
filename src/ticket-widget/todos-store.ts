import * as vscode from 'vscode';
import { WORKSPACE_STATE_KEYS } from '../state/keys';

/**
 * Persistence layer for ticket-mode TODO lists. Thin workspace-state-backed
 * CRUD wrapper keyed by ticket id (e.g. "CMMS-2650"). Mirrors the shape of
 * `ConfigurationsStore` in `settings-panel/` — a single workspaceState key
 * holds the whole record, full-record writes on every mutation.
 *
 * Storage key:
 *   - `nomeda.ticketWork.todos` : Record<ticketId, TicketTodo[]>
 *
 * Two item provenances are tracked:
 *   - `ac-extract` — auto-extracted from the Jira description's acceptance
 *     criteria. Carries a `contentHash` so re-extracts can match items by
 *     normalized text and preserve user-toggled `done` state.
 *   - `manual` — user-added via the widget. Always preserved verbatim across
 *     re-extracts (no hash, no auto-removal).
 */

export interface TicketTodo {
  id: string;
  text: string;
  done: boolean;
  source: 'ac-extract' | 'manual';
  createdAt: string;
  contentHash?: string;
}

export type TicketTodosStore = Record<string, TicketTodo[]>;

export class TicketTodosStoreManager implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<{ ticketId: string }>();
  readonly onDidChange: vscode.Event<{ ticketId: string }> = this.emitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  getTodosForTicket(ticketId: string): TicketTodo[] {
    const all = this.readAll();
    const list = all[ticketId];
    return Array.isArray(list) ? list.map((t) => ({ ...t })) : [];
  }

  async setTodosForTicket(ticketId: string, todos: TicketTodo[]): Promise<void> {
    const all = this.readAll();
    all[ticketId] = todos.map((t) => ({ ...t }));
    await this.writeAll(all);
    this.emitter.fire({ ticketId });
  }

  async addManualTodo(ticketId: string, text: string): Promise<TicketTodo[]> {
    const all = this.readAll();
    const list = Array.isArray(all[ticketId]) ? [...all[ticketId]!] : [];
    const todo: TicketTodo = {
      id: makeId(),
      text,
      done: false,
      source: 'manual',
      createdAt: new Date().toISOString(),
    };
    list.push(todo);
    all[ticketId] = list;
    await this.writeAll(all);
    this.emitter.fire({ ticketId });
    return list.map((t) => ({ ...t }));
  }

  async removeTodo(ticketId: string, todoId: string): Promise<TicketTodo[]> {
    const all = this.readAll();
    const current = Array.isArray(all[ticketId]) ? all[ticketId]! : [];
    const next = current.filter((t) => t.id !== todoId);
    all[ticketId] = next;
    await this.writeAll(all);
    this.emitter.fire({ ticketId });
    return next.map((t) => ({ ...t }));
  }

  async toggleDone(ticketId: string, todoId: string): Promise<TicketTodo[]> {
    const all = this.readAll();
    const current = Array.isArray(all[ticketId]) ? all[ticketId]! : [];
    const next = current.map((t) => (t.id === todoId ? { ...t, done: !t.done } : { ...t }));
    all[ticketId] = next;
    await this.writeAll(all);
    this.emitter.fire({ ticketId });
    return next.map((t) => ({ ...t }));
  }

  /**
   * Merge a fresh AC extraction into the stored list.
   *
   *   - Manual items: preserved verbatim, always, regardless of extraction.
   *   - Existing ac-extract items: matched by contentHash against the new set.
   *     Hash still present -> kept with current `done` state. Hash gone (the
   *     description changed and the AC item was removed) -> dropped.
   *   - New ac-extract items (hash not in existing): appended at the end with
   *     `done` honoring the supplied `initialState` from the ADF taskItem (a
   *     pre-checked taskItem in the description starts as done).
   *
   * Order: existing kept items retain their original relative position; new
   * extracted items append at the end. Simple and predictable.
   */
  async mergeAcExtract(
    ticketId: string,
    extracted: Array<{ text: string; initialState: 'todo' | 'done' }>,
  ): Promise<TicketTodo[]> {
    const all = this.readAll();
    const current = Array.isArray(all[ticketId]) ? all[ticketId]! : [];

    const newHashed = extracted.map((e) => ({
      text: e.text,
      initialState: e.initialState,
      hash: hashText(e.text),
    }));
    const newHashes = new Set(newHashed.map((e) => e.hash));

    const kept: TicketTodo[] = [];
    const keptHashes = new Set<string>();
    for (const item of current) {
      if (item.source === 'manual') {
        kept.push({ ...item });
        continue;
      }
      // ac-extract: keep iff its hash is in the new set.
      if (item.contentHash && newHashes.has(item.contentHash)) {
        kept.push({ ...item });
        keptHashes.add(item.contentHash);
      }
      // else drop
    }

    for (const e of newHashed) {
      if (keptHashes.has(e.hash)) continue;
      kept.push({
        id: makeId(),
        text: e.text,
        done: e.initialState === 'done',
        source: 'ac-extract',
        createdAt: new Date().toISOString(),
        contentHash: e.hash,
      });
    }

    all[ticketId] = kept;
    await this.writeAll(all);
    this.emitter.fire({ ticketId });
    return kept.map((t) => ({ ...t }));
  }

  async clearTicket(ticketId: string): Promise<void> {
    const all = this.readAll();
    if (!(ticketId in all)) return;
    delete all[ticketId];
    await this.writeAll(all);
    this.emitter.fire({ ticketId });
  }

  listTicketIds(): string[] {
    const all = this.readAll();
    return Object.keys(all).filter((k) => Array.isArray(all[k]) && all[k]!.length > 0);
  }

  dispose(): void {
    this.emitter.dispose();
  }

  private readAll(): TicketTodosStore {
    const raw = this.context.workspaceState.get<TicketTodosStore>(WORKSPACE_STATE_KEYS.TICKET_WORK_TODOS, {});
    if (!raw || typeof raw !== 'object') return {};
    // Defensive shallow copy of the top-level record; arrays are copied on read paths.
    const out: TicketTodosStore = {};
    for (const k of Object.keys(raw)) {
      const v = raw[k];
      if (Array.isArray(v)) out[k] = v.map((t) => ({ ...t }));
    }
    return out;
  }

  private async writeAll(all: TicketTodosStore): Promise<void> {
    await this.context.workspaceState.update(WORKSPACE_STATE_KEYS.TICKET_WORK_TODOS, all);
  }
}

/**
 * RFC4122-shape v4-ish UUID. Not cryptographically strong (uses Math.random),
 * but stable enough for client-side ids in workspace state. Zero-dep by design.
 */
function makeId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Normalize text (trim, lowercase, collapse internal whitespace) and compute
 * an FNV-1a 32-bit hash as a zero-padded hex string. Zero-dep on purpose —
 * Node's `crypto` would work but adds a dependency footprint we don't need
 * for cache-key-style stability across re-extracts.
 */
function hashText(text: string): string {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < normalized.length; i++) {
    h ^= normalized.charCodeAt(i);
    // FNV prime 16777619; use Math.imul to stay in 32-bit signed range.
    h = Math.imul(h, 0x01000193);
  }
  // Coerce to unsigned 32-bit and zero-pad.
  return (h >>> 0).toString(16).padStart(8, '0');
}
