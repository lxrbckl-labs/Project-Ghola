import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

// State file shape (written by a future TPM core module — read-only here):
// {
//   "session_id": "...",
//   "agents": {
//     "tpm":   { "status": "active", "last_heartbeat": 1715258234, "instance": null },
//     "swe-1": { "status": "active", "last_heartbeat": 1715258230, "instance": 1 },
//     "swe-2": { "status": "idle",   "last_heartbeat": null,       "instance": 2 },
//     "qa":    { "status": "idle",   "last_heartbeat": null,       "instance": null }
//   }
// }

export type AgentStatus = 'active' | 'idle' | 'stalled' | 'error';

export interface AgentStateEntry {
  status: AgentStatus;
  last_heartbeat: number | null;
  instance: number | null;
}

export interface SessionState {
  session_id: string | null;
  agents: Record<string, AgentStateEntry>;
}

const STALL_THRESHOLD_SECONDS = 30;

const EMPTY_STATE: SessionState = {
  session_id: null,
  agents: {
    tpm: { status: 'idle', last_heartbeat: null, instance: null },
    'swe-1': { status: 'idle', last_heartbeat: null, instance: 1 },
    'swe-2': { status: 'idle', last_heartbeat: null, instance: 2 },
    'swe-3': { status: 'idle', last_heartbeat: null, instance: 3 },
    qa: { status: 'idle', last_heartbeat: null, instance: null },
  },
};

export class StateWatcher implements vscode.Disposable {
  private watcher?: vscode.FileSystemWatcher;
  private current: SessionState = EMPTY_STATE;
  private readonly emitter = new vscode.EventEmitter<SessionState>();
  readonly onDidChange = this.emitter.event;
  private staleTimer?: NodeJS.Timeout;

  constructor(
    private readonly absoluteStatePath: string,
    private readonly logger?: vscode.OutputChannel,
  ) {}

  start(): void {
    const dir = path.dirname(this.absoluteStatePath);
    const file = path.basename(this.absoluteStatePath);
    const pattern = new vscode.RelativePattern(dir, file);
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.watcher.onDidCreate(() => this.refresh());
    this.watcher.onDidChange(() => this.refresh());
    this.watcher.onDidDelete(() => this.applyState(EMPTY_STATE));

    // Re-evaluate stalled state every 5s without any file change.
    this.staleTimer = setInterval(() => this.applyState(this.current), 5000);

    void this.refresh();
  }

  getState(): SessionState {
    return this.computeStalled(this.current);
  }

  private async refresh(): Promise<void> {
    try {
      const raw = await fs.readFile(this.absoluteStatePath, 'utf-8');
      const parsed = JSON.parse(raw) as SessionState;
      if (!parsed || typeof parsed !== 'object' || !parsed.agents) {
        this.applyState(EMPTY_STATE);
        return;
      }
      this.applyState(parsed);
    } catch (err) {
      const msg = (err as NodeJS.ErrnoException).code === 'ENOENT'
        ? undefined
        : (err as Error).message;
      if (msg) this.logger?.appendLine(`[state] read failed: ${msg}`);
      this.applyState(EMPTY_STATE);
    }
  }

  private applyState(state: SessionState): void {
    this.current = state;
    this.emitter.fire(this.computeStalled(state));
  }

  private computeStalled(state: SessionState): SessionState {
    const nowSec = Math.floor(Date.now() / 1000);
    const next: SessionState = {
      session_id: state.session_id,
      agents: {},
    };
    for (const [id, entry] of Object.entries(state.agents)) {
      let status = entry.status;
      if (
        status === 'active' &&
        entry.last_heartbeat != null &&
        nowSec - entry.last_heartbeat > STALL_THRESHOLD_SECONDS
      ) {
        status = 'stalled';
      }
      next.agents[id] = { ...entry, status };
    }
    return next;
  }

  dispose(): void {
    this.watcher?.dispose();
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.emitter.dispose();
  }
}
