import * as childProcess from 'child_process';
import * as os from 'os';
import * as vscode from 'vscode';
import type { ModuleLoader } from '../modules/loader';
import type { ModuleHandle } from '../modules/handle';
import { formatBanner } from './banner';

export class SessionLauncher {
  constructor(
    private readonly loader: ModuleLoader,
    private readonly extensionPath: string,
    private readonly logger?: vscode.OutputChannel,
  ) {}

  async launch(): Promise<void> {
    const enabled = this.loader.getEnabled();
    const composedAgentIds = this.detectComposedAgentIds(enabled);
    const banner = formatBanner({ enabledModules: enabled, composedAgentIds });

    const shellPath = this.pickShell();
    const shellArgs = this.pickShellArgs();

    const cfg = vscode.workspace.getConfiguration('nomeda');
    const terminal = vscode.window.createTerminal({
      name: 'Nomeda Session',
      shellPath,
      shellArgs,
      location: { viewColumn: vscode.ViewColumn.Active },
      env: {
        NOMEDA_ROOT: this.extensionPath,
        SWE_PERFORMANCE_CORES: String(cfg.get<number>('swe.performanceCores', 2)),
        SWE_EFFICIENCY_CORES: String(cfg.get<number>('swe.efficiencyCores', 1)),
        SWE_AGENT_COUNT: String(
          cfg.get<number>('swe.performanceCores', 2) + cfg.get<number>('swe.efficiencyCores', 1),
        ),
        QA_AGENT_COUNT: String(cfg.get<number>('qa.count', 1)),
      },
    });

    terminal.show(true);
    // Print the banner via the shell so it shows in the terminal buffer.
    this.printBanner(terminal, banner);
    const phrase = cfg.get<string>('sessionCommand', '').trim();
    if (phrase) {
      terminal.sendText(phrase, true);
    }
    this.logger?.appendLine(`[session] launched terminal with shell: ${shellPath ?? '<default>'}`);
  }

  private pickShell(): string | undefined {
    if (os.platform() === 'win32') {
      // Prefer PowerShell 7+ (pwsh.exe); fall back to Windows PowerShell 5.1 if pwsh is not on PATH.
      const found = childProcess.spawnSync('where', ['pwsh.exe'], { encoding: 'utf8' });
      return found.status === 0 ? 'pwsh.exe' : 'powershell.exe';
    }
    return undefined; // VS Code's default shell on macOS/Linux.
  }

  private pickShellArgs(): string[] | undefined {
    if (os.platform() === 'win32') {
      return ['-NoLogo'];
    }
    return undefined;
  }

  private printBanner(terminal: vscode.Terminal, banner: string): void {
    // sendText with shouldExecute=false would type into the prompt; we instead
    // push the banner via echo so it appears as terminal output.
    const isWin = os.platform() === 'win32';
    const lines = banner.split('\n');
    for (const line of lines) {
      const escaped = line.replace(/"/g, '`"');
      const cmd = isWin ? `Write-Host "${escaped}"` : `echo "${line.replace(/"/g, '\\"')}"`;
      terminal.sendText(cmd, true);
    }
  }

  /**
   * Pure, synchronous detection of agent ids represented by enabled modules.
   * Used for the banner only; does NOT invoke the composer.
   */
  private detectComposedAgentIds(enabled: ModuleHandle[]): string[] {
    const set = new Set<string>();
    for (const h of enabled) {
      for (const a of h.manifest.contributes?.agents ?? []) set.add(a.id);
      for (const f of h.manifest.contributes?.promptFragments ?? []) set.add(f.target);
    }
    if (set.size === 0) {
      // Default skeleton — keeps the banner informative even with no modules.
      ['tpm', 'swe', 'qa'].forEach((id) => set.add(id));
    }
    return [...set].sort();
  }
}
