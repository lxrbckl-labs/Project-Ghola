import * as childProcess from 'child_process';
import * as os from 'os';
import * as vscode from 'vscode';
import type { ModuleLoader } from '../modules/loader';
import type { PromptComposer } from '../prompts/composer';
import { formatBanner } from './banner';

export class SessionLauncher {
  constructor(
    private readonly loader: ModuleLoader,
    private readonly composer: PromptComposer,
    private readonly logger?: vscode.OutputChannel,
  ) {}

  async launch(): Promise<void> {
    const enabled = this.loader.getEnabled();
    const composedAgentIds = await this.detectComposedAgentIds(enabled);
    const banner = formatBanner({ enabledModules: enabled, composedAgentIds });

    const shellPath = this.pickShell();
    const shellArgs = this.pickShellArgs();

    const terminal = vscode.window.createTerminal({
      name: 'Nomeda Session',
      shellPath,
      shellArgs,
      location: { viewColumn: vscode.ViewColumn.Active },
    });

    terminal.show(true);
    // Print the banner via the shell so it shows in the terminal buffer.
    this.printBanner(terminal, banner);
    const phrase = vscode.workspace.getConfiguration('nomeda').get<string>('sessionCommand', '').trim();
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

  private async detectComposedAgentIds(enabled: { manifest: { contributes?: { agents?: { id: string }[]; promptFragments?: { target: string }[] } } }[]): Promise<string[]> {
    const set = new Set<string>();
    for (const h of enabled) {
      for (const a of h.manifest.contributes?.agents ?? []) set.add(a.id);
      for (const f of h.manifest.contributes?.promptFragments ?? []) set.add(f.target);
    }
    if (set.size === 0) {
      // Default skeleton — keeps the banner informative even with no modules.
      ['tpm', 'swe', 'qa'].forEach((id) => set.add(id));
    }
    // Quietly verify composer doesn't throw for any of these.
    for (const id of [...set]) {
      try {
        await this.composer.compose(id);
      } catch {
        // ignore; banner is best-effort.
      }
    }
    return [...set].sort();
  }
}
