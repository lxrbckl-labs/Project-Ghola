// A small status-bar item that shows a record icon when a session log is being
// captured. Sits at Left alignment, priority 97 — immediately right of the PR
// button — with an amber background matching the Ghola pill. Clicking it opens
// the log file in the editor.

import * as vscode from 'vscode';

/** Command id for opening the session log file. Registered internally. */
const OPEN_SESSION_LOG_COMMAND = 'ghola.openSessionLog';

/**
 * A right-aligned status-bar item that shows `$(record)` with an amber background
 * while a session log is being recorded. Clicking the item opens the log file.
 *
 * Created once during activation and shown/hidden by the session launcher as
 * recording starts and stops.
 */
export class SessionRecordStatusBarItem implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly commandDisposable: vscode.Disposable;
  private logFilePath: string | undefined;

  constructor() {
    // Left-aligned, priority 97 — immediately right of the PR button (98)
    // and part of the Ghola pill group.
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      97,
    );
    this.item.name = 'Ghola Session Log';
    this.item.text = '$(pulse)';
    this.item.tooltip = 'Session log recording';
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.item.color = new vscode.ThemeColor('statusBarItem.warningForeground');

    // Register the command that opens the log file in the editor.
    this.commandDisposable = vscode.commands.registerCommand(OPEN_SESSION_LOG_COMMAND, () => {
      if (this.logFilePath === undefined) return;
      void vscode.workspace.openTextDocument(vscode.Uri.file(this.logFilePath)).then(
        (doc) => vscode.window.showTextDocument(doc),
      );
    });
  }

  /**
   * Show the record icon and wire it to open the given log file on click.
   * Called by the session launcher when recording begins.
   */
  show(logFilePath: string): void {
    this.logFilePath = logFilePath;
    this.item.tooltip = `Recording session log: ${logFilePath}`;
    this.item.command = OPEN_SESSION_LOG_COMMAND;
    this.item.show();
  }

  /** Hide the record icon. Called when recording stops. */
  hide(): void {
    this.item.hide();
  }

  dispose(): void {
    this.commandDisposable.dispose();
    this.item.dispose();
  }
}
