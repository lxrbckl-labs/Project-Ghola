import * as vscode from 'vscode';
import type { SessionState } from './state/watcher';

export class NomedaStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'nomeda.openSettings';
    this.item.text = '$(pulse) Nomeda · idle';
    this.item.tooltip = 'Nomeda — click to open settings';
    this.item.show();
  }

  update(state: SessionState): void {
    const segments: string[] = [];

    const tpm = state.agents['tpm'];
    if (tpm) segments.push(`TPM${this.dot(tpm.status)}`);

    const sweEntries = Object.entries(state.agents)
      .filter(([id]) => id.startsWith('swe'))
      .sort(([a], [b]) => a.localeCompare(b));
    if (sweEntries.length > 0) {
      const activeCount = sweEntries.filter(([, v]) => v.status === 'active').length;
      const total = sweEntries.length;
      const stalled = sweEntries.some(([, v]) => v.status === 'stalled');
      const marker = stalled ? this.dot('stalled') : '';
      segments.push(`SWE ${activeCount}/${total}${marker}`);
    }

    const qa = state.agents['qa'];
    if (qa) segments.push(`QA${this.dot(qa.status)}`);

    if (segments.length === 0) {
      this.item.text = '$(pulse) Nomeda · idle';
      return;
    }
    this.item.text = `$(pulse) Nomeda · ${segments.join(' · ')}`;
  }

  private dot(status: string): string {
    switch (status) {
      case 'active':
        return ' $(circle-filled)';
      case 'stalled':
        return ' $(warning)';
      case 'error':
        return ' $(error)';
      case 'idle':
      default:
        return ' $(circle-outline)';
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
