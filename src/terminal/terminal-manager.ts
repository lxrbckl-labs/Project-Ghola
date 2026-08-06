/**
 * Agent-dispatched terminal pool manager. Wraps VS Code's Terminal API so
 * bridge HTTP routes (wired by SWE-2 in `bitbucket-bridge-server.ts`) can
 * create, command, and read output from VS Code terminals on behalf of agents.
 *
 * This is a NEW, independent terminal pool for agent-dispatched work terminals
 * -- it does NOT touch the session terminal managed by `SessionLauncher` in
 * `src/session/launcher.ts`.
 *
 * Output capture uses a three-tier fallback:
 *   1. Shell Integration (VS Code 1.93+) -- preferred, gives exit code + clean output.
 *   2. Script wrapper -- redirects output to a temp file, parses exit code from a marker.
 *   3. Raw `onDidWriteTerminalData` -- proposed API, captures ANSI-laden output with no exit code.
 *
 * All public methods return result objects and never throw.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

// ─── Public interfaces ──────────────────────────────────────────────────────

export interface TerminalManagerConfig {
  maxConcurrentTerminals: number;
  defaultShell: string;
  allowedShells: string[];
  commandTimeoutMs: number;
  humanInterventionTimeoutMs: number;
  autoDisposeOnSessionEnd: boolean;
}

export interface CreateTerminalRequest {
  name: string;
  shell?: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface CreateResult {
  status: 'ok' | 'error';
  terminalId?: string;
  message?: string;
}

export interface ExecRequest {
  terminalId: string;
  command: string;
  waitForHuman?: boolean;
  timeoutMs?: number;
}

export interface ExecResult {
  status: 'ok' | 'error' | 'cancelled';
  output: string;
  exitCode: number | undefined;
  timedOut: boolean;
  captureTier: 'shell-integration' | 'script-wrapper' | 'raw';
  elapsedMs: number;
  message?: string;
}

export interface TerminalInfo {
  terminalId: string;
  name: string;
  shell: string;
  state: 'idle' | 'busy' | 'waiting-for-human';
}

// ─── Internal state ─────────────────────────────────────────────────────────

interface ManagedTerminal {
  terminalId: string;
  name: string;
  shell: string;
  terminal: vscode.Terminal;
  state: 'idle' | 'busy' | 'waiting-for-human';
  created: number;
  pendingResolve?: (result: ExecResult) => void;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Generate an 8-character random hex string for terminal IDs. */
function generateTerminalId(): string {
  return crypto.randomBytes(4).toString('hex');
}

/**
 * Resolve a shell name to an absolute path on win32. On non-win32 the OS
 * resolves the name from PATH, so the name is returned verbatim.
 */
function resolveShellPath(shell: string): string {
  if (os.platform() !== 'win32') return shell;

  const lower = shell.toLowerCase();
  if (lower === 'bash') {
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    if (fs.existsSync(gitBash)) return gitBash;
    // WSL bash: try the well-known location.
    const wslBash = 'C:\\Windows\\System32\\bash.exe';
    if (fs.existsSync(wslBash)) return wslBash;
    return shell;
  }
  if (lower === 'powershell') return 'powershell.exe';
  if (lower === 'pwsh') return 'pwsh.exe';
  return shell;
}

/**
 * Sleep helper for the script-wrapper polling loop. Returns a promise that
 * resolves after `ms` milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Determine whether a shell name is bash-like (for script-wrapper command
 * construction). Matches common bash paths and the bare name `bash`.
 */
function isBashLike(shell: string): boolean {
  const lower = shell.toLowerCase();
  return (
    lower === 'bash' ||
    lower.endsWith('/bash') ||
    lower.endsWith('/bash.exe') ||
    lower.endsWith('\\bash.exe')
  );
}

/**
 * Determine whether a shell name is PowerShell-like (for script-wrapper
 * command construction).
 */
function isPowerShellLike(shell: string): boolean {
  const lower = shell.toLowerCase();
  return (
    lower === 'powershell' ||
    lower === 'pwsh' ||
    lower.endsWith('/powershell') ||
    lower.endsWith('/pwsh') ||
    lower.endsWith('powershell.exe') ||
    lower.endsWith('pwsh.exe')
  );
}

// ─── TerminalManager ────────────────────────────────────────────────────────

export class TerminalManager implements vscode.Disposable {
  private config: TerminalManagerConfig;
  private terminals: Map<string, ManagedTerminal> = new Map();
  private disposables: vscode.Disposable[] = [];

  constructor(config: TerminalManagerConfig) {
    this.config = { ...config };

    // Clean up terminals closed by the user via VS Code's UI.
    const closeListener = vscode.window.onDidCloseTerminal((closed) => {
      for (const [id, managed] of this.terminals) {
        if (managed.terminal === closed) {
          // If a pending exec is in flight, resolve it as cancelled.
          if (managed.pendingResolve) {
            managed.pendingResolve({
              status: 'cancelled',
              output: '',
              exitCode: undefined,
              timedOut: false,
              captureTier: 'raw',
              elapsedMs: Date.now() - managed.created,
              message: 'Terminal closed by user',
            });
            managed.pendingResolve = undefined;
          }
          this.terminals.delete(id);
          break;
        }
      }
    });
    this.disposables.push(closeListener);
  }

  // ── create ──────────────────────────────────────────────────────────────

  async create(req: CreateTerminalRequest): Promise<CreateResult> {
    try {
      // Validate shell.
      const shell = req.shell ?? this.config.defaultShell;
      if (!this.config.allowedShells.includes(shell)) {
        return {
          status: 'error',
          message: `Shell "${shell}" is not in the allowed list. Update the ghola.terminal.allowedShells setting to permit it. Allowed: ${this.config.allowedShells.join(', ')}`,
        };
      }

      // Check terminal cap.
      if (this.terminals.size >= this.config.maxConcurrentTerminals) {
        return {
          status: 'error',
          message: `Terminal pool is at capacity (${this.config.maxConcurrentTerminals}). Dispose an existing terminal first.`,
        };
      }

      // Validate name uniqueness among managed terminals.
      for (const managed of this.terminals.values()) {
        if (managed.name === req.name) {
          return {
            status: 'error',
            message: `A managed terminal named "${req.name}" already exists (id: ${managed.terminalId}). Choose a different name.`,
          };
        }
      }

      const terminalId = generateTerminalId();
      const resolvedShell = resolveShellPath(shell);

      const cwd =
        req.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

      const terminal = vscode.window.createTerminal({
        name: req.name,
        shellPath: resolvedShell,
        cwd,
        env: req.env,
      });

      // Show without stealing focus from the agent's active editor.
      terminal.show(true);

      this.terminals.set(terminalId, {
        terminalId,
        name: req.name,
        shell,
        terminal,
        state: 'idle',
        created: Date.now(),
      });

      return { status: 'ok', terminalId };
    } catch (err) {
      return {
        status: 'error',
        message: `Failed to create terminal: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ── exec ────────────────────────────────────────────────────────────────

  async exec(req: ExecRequest): Promise<ExecResult> {
    try {
      const managed = this.terminals.get(req.terminalId);
      if (!managed) {
        return {
          status: 'error',
          output: '',
          exitCode: undefined,
          timedOut: false,
          captureTier: 'raw',
          elapsedMs: 0,
          message: `No managed terminal with id "${req.terminalId}".`,
        };
      }
      if (managed.state === 'busy' || managed.state === 'waiting-for-human') {
        return {
          status: 'error',
          output: '',
          exitCode: undefined,
          timedOut: false,
          captureTier: 'raw',
          elapsedMs: 0,
          message: `Terminal "${managed.name}" is currently ${managed.state}. Wait for the current operation to complete.`,
        };
      }

      const startTime = Date.now();
      managed.state = req.waitForHuman ? 'waiting-for-human' : 'busy';

      const timeoutMs = req.timeoutMs ??
        (req.waitForHuman
          ? this.config.humanInterventionTimeoutMs
          : this.config.commandTimeoutMs);

      let result: ExecResult;
      try {
        if (req.waitForHuman) {
          result = await this.execHumanInLoop(managed, req.command, timeoutMs, startTime);
        } else {
          result = await this.execAutomatic(managed, req.command, timeoutMs, startTime);
        }
      } catch (err) {
        result = {
          status: 'error',
          output: '',
          exitCode: undefined,
          timedOut: false,
          captureTier: 'raw',
          elapsedMs: Date.now() - startTime,
          message: `Exec failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      managed.state = 'idle';
      managed.pendingResolve = undefined;
      return result;
    } catch (err) {
      return {
        status: 'error',
        output: '',
        exitCode: undefined,
        timedOut: false,
        captureTier: 'raw',
        elapsedMs: 0,
        message: `Exec failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ── list ────────────────────────────────────────────────────────────────

  list(): TerminalInfo[] {
    const result: TerminalInfo[] = [];
    for (const managed of this.terminals.values()) {
      result.push({
        terminalId: managed.terminalId,
        name: managed.name,
        shell: managed.shell,
        state: managed.state,
      });
    }
    return result;
  }

  // ── disposeTerminal ─────────────────────────────────────────────────────

  disposeTerminal(terminalId: string): { status: 'ok' } | { status: 'error'; message: string } {
    const managed = this.terminals.get(terminalId);
    if (!managed) {
      return { status: 'error', message: `No managed terminal with id "${terminalId}".` };
    }

    // Cancel any pending exec.
    if (managed.pendingResolve) {
      managed.pendingResolve({
        status: 'cancelled',
        output: '',
        exitCode: undefined,
        timedOut: false,
        captureTier: 'raw',
        elapsedMs: Date.now() - managed.created,
        message: 'Terminal disposed while command was pending.',
      });
      managed.pendingResolve = undefined;
    }

    managed.terminal.dispose();
    this.terminals.delete(terminalId);
    return { status: 'ok' };
  }

  // ── signal ──────────────────────────────────────────────────────────────

  signal(terminalId: string): { status: 'ok' } | { status: 'error'; message: string } {
    const managed = this.terminals.get(terminalId);
    if (!managed) {
      return { status: 'error', message: `No managed terminal with id "${terminalId}".` };
    }
    if (managed.state !== 'waiting-for-human') {
      return {
        status: 'error',
        message: `Terminal "${managed.name}" is in state "${managed.state}", not "waiting-for-human".`,
      };
    }
    if (managed.pendingResolve) {
      // The pending promise will be resolved by the exec flow; we signal it by
      // providing a result. The exec method's finally block sets state to idle.
      managed.pendingResolve({
        status: 'ok',
        output: '',
        exitCode: undefined,
        timedOut: false,
        captureTier: 'raw',
        elapsedMs: Date.now() - managed.created,
      });
      managed.pendingResolve = undefined;
    }
    return { status: 'ok' };
  }

  // ── dispose (vscode.Disposable) ─────────────────────────────────────────

  dispose(): void {
    for (const managed of this.terminals.values()) {
      if (managed.pendingResolve) {
        managed.pendingResolve({
          status: 'cancelled',
          output: '',
          exitCode: undefined,
          timedOut: false,
          captureTier: 'raw',
          elapsedMs: Date.now() - managed.created,
          message: 'Extension deactivated.',
        });
        managed.pendingResolve = undefined;
      }
      managed.terminal.dispose();
    }
    this.terminals.clear();

    while (this.disposables.length) this.disposables.pop()!.dispose();
  }

  // ── updateConfig ────────────────────────────────────────────────────────

  updateConfig(config: Partial<TerminalManagerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ── Private: automatic exec (non-human-in-the-loop) ─────────────────────

  private async execAutomatic(
    managed: ManagedTerminal,
    command: string,
    timeoutMs: number,
    startTime: number,
  ): Promise<ExecResult> {
    // Tier 1: Shell Integration
    const shellIntegration = managed.terminal.shellIntegration;
    if (shellIntegration) {
      return this.execViaShellIntegration(managed, shellIntegration, command, timeoutMs, startTime);
    }

    // Tier 2: Script wrapper (bash or PowerShell only)
    if (isBashLike(managed.shell) || isPowerShellLike(managed.shell)) {
      return this.execViaScriptWrapper(managed, command, timeoutMs, startTime);
    }

    // Tier 3: Raw sendText
    return this.execViaRawSendText(managed, command, timeoutMs, startTime);
  }

  // ── Tier 1: Shell Integration ───────────────────────────────────────────

  private async execViaShellIntegration(
    managed: ManagedTerminal,
    shellIntegration: vscode.TerminalShellIntegration,
    command: string,
    timeoutMs: number,
    startTime: number,
  ): Promise<ExecResult> {
    const execution = shellIntegration.executeCommand(command);
    const outputParts: string[] = [];
    let exitCode: number | undefined;

    const outputPromise = new Promise<void>(async (resolve) => {
      // Subscribe to end-of-execution to capture exit code.
      const endListener = vscode.window.onDidEndTerminalShellExecution((e) => {
        if (e.execution === execution) {
          exitCode = e.exitCode;
          endListener.dispose();
          resolve();
        }
      });
      managed.pendingResolve = (result) => {
        endListener.dispose();
        // Externally signalled -- resolve with whatever we have.
        resolve();
      };

      // Read from the async iterable.
      try {
        const stream = execution.read();
        for await (const data of stream) {
          outputParts.push(data);
        }
      } catch {
        // Stream may error if the terminal closes mid-read.
      }
    });

    const timedOut = await this.raceWithTimeout(outputPromise, timeoutMs);

    return {
      status: 'ok',
      output: outputParts.join(''),
      exitCode,
      timedOut,
      captureTier: 'shell-integration',
      elapsedMs: Date.now() - startTime,
    };
  }

  // ── Tier 2: Script wrapper ──────────────────────────────────────────────

  private async execViaScriptWrapper(
    managed: ManagedTerminal,
    command: string,
    timeoutMs: number,
    startTime: number,
  ): Promise<ExecResult> {
    const tmpDir = os.tmpdir();
    const outFile = path.join(tmpDir, `ghola-term-${managed.terminalId}.out`);

    // Clean up any stale output file from a prior run.
    try { fs.unlinkSync(outFile); } catch { /* no-op */ }

    let wrappedCommand: string;
    if (isBashLike(managed.shell)) {
      // Bash wrapper: capture stdout+stderr, append exit code marker.
      wrappedCommand =
        `{ ${command}; } > ${this.shellEscape(outFile)} 2>&1; echo "GHOLA_EXIT:$?" >> ${this.shellEscape(outFile)}`;
    } else {
      // PowerShell wrapper: capture all streams, append exit code marker.
      const psOutFile = outFile.replace(/\\/g, '\\\\');
      wrappedCommand =
        `& { ${command} } *> "${psOutFile}"; Add-Content "${psOutFile}" "GHOLA_EXIT:$LASTEXITCODE"`;
    }

    managed.terminal.sendText(wrappedCommand);

    // Poll for the marker in the output file.
    const pollIntervalMs = 200;
    let output = '';
    let exitCode: number | undefined;
    let timedOut = false;

    const pollPromise = new Promise<void>((resolve) => {
      managed.pendingResolve = () => resolve();

      const poll = async (): Promise<void> => {
        const elapsed = Date.now() - startTime;
        if (elapsed >= timeoutMs) {
          timedOut = true;
          resolve();
          return;
        }
        try {
          const contents = fs.readFileSync(outFile, 'utf8');
          const markerIndex = contents.lastIndexOf('GHOLA_EXIT:');
          if (markerIndex !== -1) {
            const markerLine = contents.slice(markerIndex);
            const match = /^GHOLA_EXIT:(-?\d+)/.exec(markerLine);
            if (match) {
              exitCode = parseInt(match[1], 10);
              // Strip the marker line from output.
              output = contents.slice(0, markerIndex).replace(/\n$/, '');
              resolve();
              return;
            }
          }
        } catch {
          // File may not exist yet.
        }
        await sleep(pollIntervalMs);
        void poll();
      };
      void poll();
    });

    await pollPromise;

    // Clean up temp file.
    try { fs.unlinkSync(outFile); } catch { /* no-op */ }

    return {
      status: 'ok',
      output,
      exitCode,
      timedOut,
      captureTier: 'script-wrapper',
      elapsedMs: Date.now() - startTime,
    };
  }

  // ── Tier 3: Raw sendText ────────────────────────────────────────────────

  private async execViaRawSendText(
    managed: ManagedTerminal,
    command: string,
    timeoutMs: number,
    startTime: number,
  ): Promise<ExecResult> {
    const outputParts: string[] = [];
    let dataListener: vscode.Disposable | undefined;

    // `onDidWriteTerminalData` is a proposed API. Check availability at runtime
    // so the extension does not crash on VS Code builds that do not expose it.
    const hasWriteEvent = typeof (vscode.window as Record<string, unknown>).onDidWriteTerminalData === 'function';

    // Heuristic: wait for output to stop flowing (no new data for 2 seconds
    // after the last write), or until the timeout expires.
    const quiesceMs = 2000;
    let lastWriteTime = Date.now();
    let timedOut = false;

    if (hasWriteEvent) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const onWrite = (vscode.window as any).onDidWriteTerminalData as (
        listener: (e: { terminal: vscode.Terminal; data: string }) => void,
      ) => vscode.Disposable;

      // Single listener captures output AND tracks quiesce timing.
      dataListener = onWrite((e) => {
        if (e.terminal === managed.terminal) {
          outputParts.push(e.data);
          lastWriteTime = Date.now();
        }
      });
    }

    managed.terminal.sendText(command);

    const waitPromise = new Promise<void>((resolve) => {
      managed.pendingResolve = () => resolve();

      const check = (): void => {
        const elapsed = Date.now() - startTime;
        if (elapsed >= timeoutMs) {
          timedOut = true;
          resolve();
          return;
        }
        const sinceLast = Date.now() - lastWriteTime;
        if (sinceLast >= quiesceMs) {
          resolve();
          return;
        }
        setTimeout(check, Math.min(500, quiesceMs - sinceLast));
      };

      // Start checking after the quiesce period.
      setTimeout(check, quiesceMs);
    });

    await waitPromise;

    dataListener?.dispose();

    return {
      status: 'ok',
      output: outputParts.join(''),
      exitCode: undefined,
      timedOut,
      captureTier: 'raw',
      elapsedMs: Date.now() - startTime,
    };
  }

  // ── Human-in-the-loop flow ──────────────────────────────────────────────

  private async execHumanInLoop(
    managed: ManagedTerminal,
    command: string,
    timeoutMs: number,
    startTime: number,
  ): Promise<ExecResult> {
    // Send the command.
    managed.terminal.sendText(command);

    // Try to capture output via shell integration if available, otherwise
    // fall back to onDidWriteTerminalData.
    const outputParts: string[] = [];
    let exitCode: number | undefined;
    let captureTier: ExecResult['captureTier'] = 'raw';
    const captureDisposables: vscode.Disposable[] = [];

    const shellIntegration = managed.terminal.shellIntegration;
    if (shellIntegration) {
      captureTier = 'shell-integration';
      // Listen for shell execution end events.
      const endListener = vscode.window.onDidEndTerminalShellExecution((e) => {
        if (e.terminal === managed.terminal) {
          exitCode = e.exitCode;
        }
      });
      captureDisposables.push(endListener);
    } else {
      const hasWriteEvent = typeof (vscode.window as Record<string, unknown>).onDidWriteTerminalData === 'function';
      if (hasWriteEvent) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const onWrite = (vscode.window as any).onDidWriteTerminalData as (
          listener: (e: { terminal: vscode.Terminal; data: string }) => void,
        ) => vscode.Disposable;
        const dataListener = onWrite((e) => {
          if (e.terminal === managed.terminal) {
            outputParts.push(e.data);
          }
        });
        captureDisposables.push(dataListener);
      }
    }

    // Show notification and wait for user action.
    const userDonePromise = vscode.window.showInformationMessage(
      `Terminal "${managed.name}" is waiting for you. Click Done when finished.`,
      'Done',
    );

    const waitPromise = new Promise<ExecResult>((resolve) => {
      let resolved = false;
      const finish = (timedOut: boolean, message?: string): void => {
        if (resolved) return;
        resolved = true;
        while (captureDisposables.length) captureDisposables.pop()!.dispose();
        resolve({
          status: 'ok',
          output: outputParts.join(''),
          exitCode,
          timedOut,
          captureTier,
          elapsedMs: Date.now() - startTime,
          message,
        });
      };

      // Programmatic signal via `signal()`.
      managed.pendingResolve = (result) => {
        if (resolved) return;
        resolved = true;
        while (captureDisposables.length) captureDisposables.pop()!.dispose();
        resolve({
          ...result,
          output: result.output || outputParts.join(''),
          captureTier,
          elapsedMs: Date.now() - startTime,
        });
      };

      // User clicks "Done" in the notification.
      void userDonePromise.then((choice) => {
        if (choice === 'Done') {
          finish(false);
        }
        // Dismissing the notification (undefined) is not treated as "done" --
        // the timeout or a signal() call will eventually resolve.
      });

      // Shell integration: command returned to prompt.
      if (shellIntegration) {
        const endListener = vscode.window.onDidEndTerminalShellExecution((e) => {
          if (e.terminal === managed.terminal) {
            exitCode = e.exitCode;
            endListener.dispose();
            finish(false);
          }
        });
        captureDisposables.push(endListener);
      }

      // Timeout.
      const timer = setTimeout(() => finish(true, 'Human intervention timed out.'), timeoutMs);
      captureDisposables.push(new vscode.Disposable(() => clearTimeout(timer)));
    });

    return waitPromise;
  }

  // ── Utilities ───────────────────────────────────────────────────────────

  /**
   * Race a promise against a timeout. Returns `true` if the timeout fired
   * first (i.e. the operation timed out), `false` if the promise resolved
   * before the timeout.
   */
  private raceWithTimeout(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(true);
        }
      }, timeoutMs);
      void promise.then(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(false);
        }
      });
    });
  }

  /**
   * Minimal shell-escape for file paths in bash commands: wraps in single
   * quotes with inner single quotes escaped as '\''.
   */
  private shellEscape(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
  }
}
