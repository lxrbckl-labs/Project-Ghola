import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ModuleLoader } from '../modules/loader';
import type { ModuleHandle } from '../modules/handle';
import { formatBanner } from './banner';
import { resolveAgentPromptFilePath } from './prompt-file';

/**
 * Milliseconds to wait between launching the CLI binary and sending the
 * trigger word/phrase as user input. Tuned for Claude Code's cold-start time
 * on a typical developer machine. If the CLI is slower to become ready on the
 * user's hardware, surface this as a configurable setting in a follow-up.
 */
const CLI_BOOT_DELAY_MS = 3000;

/** Workspace-state key where the panel persists flat `moduleId::fieldKey` values. */
const MODULE_SETTINGS_KEY = 'nomeda.moduleSettings';

/** Module id whose enablement gates the WSL fast-path `cd`. */
const FASTPATH_MODULE_ID = 'tool.fastpath-check';

/** Field key on `tool.fastpath-check` for an explicit user-supplied target directory. */
const FASTPATH_SETTING_KEY = 'fastpathDirectory';

/** Field key on `tool.fastpath-check` for the auto-cd-into-matching-repo toggle. */
const AUTO_CD_INTO_REPO_KEY = 'autoCdIntoRepo';

export class SessionLauncher {
  constructor(
    private readonly loader: ModuleLoader,
    private readonly extensionPath: string,
    private readonly workspaceState: vscode.Memento,
    private readonly logger?: vscode.OutputChannel,
  ) {}

  async launch(): Promise<void> {
    const enabled = this.loader.getEnabled();
    const composedAgentIds = this.detectComposedAgentIds(enabled);
    const banner = formatBanner({ enabledModules: enabled, composedAgentIds });

    const shellPath = this.pickShell();
    const shellArgs = this.pickShellArgs();
    const cwd = this.resolveTerminalCwd(enabled);

    // Read configuration fresh at every launch so edits made in VS Code
    // Settings between play-button clicks take effect without a reload.
    const cfg = vscode.workspace.getConfiguration('nomeda');
    // Alias-first resolution: when the user has picked an entry from the
    // Sessions-tab alias dropdown (`selectedAlias`), launch that alias name
    // verbatim and rely on bash's alias lookup. Fall back to the raw
    // `cliCommand` string for back-compat with users who have not migrated
    // to the alias registry.
    const selectedAlias = cfg.get<string>('selectedAlias', '').trim();
    const cliCommand = (selectedAlias !== '' ? selectedAlias : cfg.get<string>('cliCommand', 'claude')).trim();
    const sessionCommand = cfg.get<string>('sessionCommand', 'initiate').trim();

    const terminal = vscode.window.createTerminal({
      name: 'Nomeda Session',
      shellPath,
      shellArgs,
      cwd,
      location: { viewColumn: vscode.ViewColumn.Active },
      env: {
        NOMEDA_ROOT: this.extensionPath,
        // Per-workspace paths written by SettingsPanel.writeAllAgentPromptFiles()
        // immediately before launch. Each path is stable across reopens of the
        // same workspace but unique across different workspaces, so two VS Code
        // windows hosting different folders cannot overwrite each other's
        // composed prompts. The SWE/QA files exist so TPM can read them via
        // its Read tool and inject the content into the prompt passed to the
        // Agent tool when spawning a SWE or QA subagent.
        NOMEDA_TPM_PROMPT_FILE: resolveAgentPromptFilePath('tpm'),
        NOMEDA_SWE_PROMPT_FILE: resolveAgentPromptFilePath('swe'),
        NOMEDA_QA_PROMPT_FILE: resolveAgentPromptFilePath('qa'),
        SWE_PERFORMANCE_CORES: String(cfg.get<number>('swe.performanceCores', 2)),
        SWE_EFFICIENCY_CORES: String(cfg.get<number>('swe.efficiencyCores', 1)),
        SWE_AGENT_COUNT: String(
          cfg.get<number>('swe.performanceCores', 2) + cfg.get<number>('swe.efficiencyCores', 1),
        ),
        SWE_PERFORMANCE_MODEL: cfg.get<string>('swe.performanceCoresModel', 'opus'),
        SWE_EFFICIENCY_MODEL: cfg.get<string>('swe.efficiencyCoresModel', 'sonnet'),
        QA_AGENT_COUNT: String(cfg.get<number>('qa.count', 1)),
      },
    });

    terminal.show(true);
    // Print the banner via the shell so it shows in the terminal buffer.
    this.printBanner(terminal, banner);

    // Two-phase launch:
    //   1) Send `cliCommand` (default: "claude") as a shell command. The
    //      terminal executes it and the CLI process starts.
    //   2) Wait CLI_BOOT_DELAY_MS for the CLI to be ready to accept stdin.
    //   3) Send `sessionCommand` (default: "initiate") AS USER INPUT to the
    //      running CLI. The user's CLI configuration (e.g. CLAUDE.md or user
    //      memory) defines what that trigger word does — typically reading
    //      $NOMEDA_TPM_PROMPT_FILE and adopting the TPM role.
    if (cliCommand) {
      terminal.sendText(cliCommand, true);
      if (sessionCommand) {
        setTimeout(() => {
          terminal.sendText(sessionCommand, true);
        }, CLI_BOOT_DELAY_MS);
      }
    } else if (sessionCommand) {
      // No CLI command configured — preserve the legacy "send phrase to shell"
      // behavior so a user with cliCommand="" can still run an arbitrary
      // one-shot command via sessionCommand.
      terminal.sendText(sessionCommand, true);
    }

    this.logger?.appendLine(`[session] launched terminal with shell: ${shellPath ?? '<default>'}`);
  }

  private pickShell(): string | undefined {
    if (os.platform() === 'win32') {
      // Prefer PowerShell 7+ (pwsh.exe); fall back to Windows PowerShell 5.1 if pwsh is not on PATH.
      const found = childProcess.spawnSync('where', ['pwsh.exe'], { encoding: 'utf8' });
      return found.status === 0 ? 'pwsh.exe' : 'powershell.exe';
    }
    // WSL / native Linux / macOS: prefer bash explicitly so the session is
    // predictable regardless of the user's login shell. /bin/bash is present
    // on every WSL distro Nomeda targets; if it is missing, fall through to
    // VS Code's default shell.
    if (fs.existsSync('/bin/bash')) return '/bin/bash';
    if (fs.existsSync('/usr/bin/bash')) return '/usr/bin/bash';
    return undefined;
  }

  private pickShellArgs(): string[] | undefined {
    if (os.platform() === 'win32') {
      return ['-NoLogo'];
    }
    return undefined;
  }

  /**
   * Choose the terminal's initial working directory.
   *
   * When `tool.fastpath-check` is enabled in the active configuration, prefer
   * the fast-path target (either the user-supplied `fastpathDirectory` setting
   * or the computed WSL-native equivalent of a `/mnt/c/...` workspace). When
   * the module is disabled, or resolution fails, return `undefined` so VS Code
   * falls back to the workspace folder — matches the historical behavior.
   */
  private resolveTerminalCwd(enabled: ModuleHandle[]): string | undefined {
    const fastpathEnabled = enabled.some((h) => h.manifest.id === FASTPATH_MODULE_ID);
    if (!fastpathEnabled) return undefined;

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      this.logger?.appendLine('[session] fast-path: no workspace folder open, skipping cd');
      return undefined;
    }
    if (folders.length > 1) {
      this.logger?.appendLine(
        `[session] fast-path: multi-root workspace detected (${folders.length} folders); using the first — multi-root resolution is a follow-up`,
      );
    }
    const workspacePath = folders[0]!.uri.fsPath;

    const target = this.resolveFastpathTarget(workspacePath);
    if (!target) {
      this.logger?.appendLine(
        `[session] fast-path: no target resolved for ${workspacePath}, falling back to workspace folder`,
      );
      return undefined;
    }
    if (!fs.existsSync(target)) {
      this.logger?.appendLine(
        `[session] fast-path: target ${target} does not exist, falling back to workspace folder`,
      );
      return undefined;
    }
    this.logger?.appendLine(`[session] fast-path: opening terminal in ${target}`);
    return target;
  }

  /**
   * Resolve the fast-path target directory in this order:
   *   1. Honor an explicit non-empty `fastpathDirectory` setting on
   *      `tool.fastpath-check` if the user has set one.
   *   2. Else compute: if the workspace lives at `/mnt/<letter>/Users/<user>/<rest>`
   *      translate to `/home/<currentUser>/projects/<basename(rest)>`. If the
   *      workspace is already WSL-native, the workspace path itself is the
   *      fast path (no translation needed).
   *   3. Else return `undefined` — caller falls back to workspace folder.
   *
   * Returns an absolute path (or undefined). Existence is verified by the caller.
   */
  private resolveFastpathTarget(workspacePath: string): string | undefined {
    // (1) Explicit user-supplied parent dir.
    const explicit = this.readModuleSetting(FASTPATH_MODULE_ID, FASTPATH_SETTING_KEY);
    if (typeof explicit === 'string' && explicit.trim() !== '') {
      const expandedExplicit = this.expandHome(explicit.trim());

      // (1a) Auto-cd-into-matching-repo: if the parent contains a subdirectory
      // matching the workspace basename, prefer that — it's the actual repo, not
      // the parent.
      const autoCd = this.readModuleSetting(FASTPATH_MODULE_ID, AUTO_CD_INTO_REPO_KEY);
      // Default-true semantics: explicit `false` opts out; anything else (true,
      // undefined, unset) keeps the auto-cd behavior on.
      if (autoCd !== false) {
        const basename = path.basename(workspacePath);
        const candidate = path.join(expandedExplicit, basename);
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }

      return expandedExplicit;
    }

    // (2) Workspace already on a WSL-native path → the path itself is fast.
    if (workspacePath.startsWith('/home/') || workspacePath.startsWith(os.homedir())) {
      return workspacePath;
    }

    // (2b) `/mnt/<letter>/Users/<user>/<rest>` → `<homedir>/projects/<basename(rest)>`.
    const mntMatch = workspacePath.match(/^\/mnt\/[a-zA-Z]\/Users\/[^/]+\/(.+)$/);
    if (mntMatch && mntMatch[1]) {
      const rest = mntMatch[1];
      const base = path.basename(rest);
      return path.join(os.homedir(), 'projects', base);
    }

    return undefined;
  }

  /**
   * Read a single field from a module's persisted settings. The panel stores
   * settings under workspace-state key `nomeda.moduleSettings` as a flat
   * dictionary keyed by `moduleId::fieldKey` — match that shape here so we
   * stay in sync without depending on the panel.
   */
  private readModuleSetting(moduleId: string, fieldKey: string): unknown {
    const flat = this.workspaceState.get<Record<string, unknown>>(MODULE_SETTINGS_KEY, {});
    return flat[`${moduleId}::${fieldKey}`];
  }

  /** Expand a leading `~` or `~/` to the current user's home directory. */
  private expandHome(p: string): string {
    if (p === '~') return os.homedir();
    if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
    return p;
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
      for (const f of h.manifest.contributes?.promptFragments ?? []) {
        // `target: "all"` is a fan-out marker rather than a real agent id —
        // expand it to the three built-in agents so the banner reflects the
        // actual recipients of the fragment.
        if (f.target === 'all') {
          set.add('tpm');
          set.add('swe');
          set.add('qa');
        } else {
          set.add(f.target);
        }
      }
    }
    if (set.size === 0) {
      // Default skeleton — keeps the banner informative even with no modules.
      ['tpm', 'swe', 'qa'].forEach((id) => set.add(id));
    }
    return [...set].sort();
  }
}
