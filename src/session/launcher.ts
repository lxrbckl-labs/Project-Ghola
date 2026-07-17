import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ModuleLoader } from '../modules/loader';
import type { ModuleHandle } from '../modules/handle';
import { readModuleSettings } from '../state/module-settings';
import { formatBanner } from './banner';
import { resolveAgentPromptFilePath } from './prompt-file';

/**
 * Milliseconds to wait between launching the CLI binary and sending the
 * trigger word/phrase as user input. Tuned for Claude Code's cold-start time
 * on a typical developer machine. If the CLI is slower to become ready on the
 * user's hardware, surface this as a configurable setting in a follow-up.
 */
const CLI_BOOT_DELAY_MS = 3000;

/** Module id whose enablement gates the WSL fast-path `cd`. */
const FASTPATH_MODULE_ID = 'tool.fastpath-check';

/**
 * `tool.obsidian-notes`. Its `vaultPath` setting is the single source of truth
 * for the Obsidian vault, used here to resolve the War Mode ledger root the
 * SAME way the extension host and the `ghola` CLI do.
 */
const OBSIDIAN_MODULE_ID = 'tool.obsidian-notes';

/**
 * `tool.self-upgrade`. When it is enabled and NO `mode.*` module is, the session
 * is a Self Upgrade session — its own non-ticket-scoped modality. The launcher
 * labels `GHOLA_MODE` as `self-upgrade` (not `unconstrained`) so the probe
 * suppresses ticket/Jira/notes probing and the banner's Mode row agrees.
 */
const SELF_UPGRADE_MODULE_ID = 'tool.self-upgrade';

/**
 * `mode.war` (War Mode). Not loader-toggleable — enablement is the
 * `mode.war::enabled` setting in the module-settings store, mirroring the
 * composer's gate (see `src/prompts/composer.ts` renderGholaEntry).
 */
const GHOLA_MODE_ID = 'mode.war';

/** Field key on `tool.fastpath-check` for an explicit user-supplied target directory. */
const FASTPATH_SETTING_KEY = 'fastpathDirectory';

/** Field key on `tool.fastpath-check` for the auto-cd-into-matching-repo toggle. */
const AUTO_CD_INTO_REPO_KEY = 'autoCdIntoRepo';

/**
 * Optional per-launch overrides. When omitted, `launch()` behaves exactly as the
 * default Sessions-tab play button: it creates the `Ghola Session` terminal,
 * writes the GHOLA_{TPM,SWE,QA}_PROMPT_FILE scaffolding, and sends the trigger
 * word as phase-2 input. `promptOverride` switches to a one-shot dispatch mode
 * (used by the Commit-and-Push button) that skips the agent-prompt-file
 * scaffolding and sends a self-contained prompt instead of the trigger word.
 */
interface LaunchOptions {
  /** Terminal name; defaults to the existing session terminal name. */
  terminalName?: string;
  /**
   * When set: skip the TPM/SWE/QA env-prompt-file scaffolding and send THIS
   * string as the phase-2 message instead of the configured trigger word.
   */
  promptOverride?: string;
}

export class SessionLauncher {
  constructor(
    private readonly loader: ModuleLoader,
    private readonly extensionPath: string,
    private readonly globalState: vscode.Memento,
    private readonly workspaceState: vscode.Memento,
    private readonly logger?: vscode.OutputChannel,
  ) {}

  /**
   * Loopback URL of the host-side Bitbucket bridge, when it started. Injected
   * into the session terminal env (never the banner/log) so the CLI agent can
   * reach the host-side `BitbucketPrClient`. Undefined when the bridge failed
   * to bind — in that case no bridge env is injected.
   */
  private bridgeUrl?: string;

  /**
   * Per-session bearer token authenticating the CLI agent to the bridge. SECRET
   * — it is injected into the terminal env ONLY and must never be written to
   * the banner, a log line, or any `sendText` payload.
   */
  private bridgeToken?: string;

  /**
   * Supply the bridge coordinates after construction. Called once at activation
   * only when the bridge bound successfully; if never called, launches proceed
   * with no bridge env and the CLI-side module fails loud.
   */
  setBridge(url: string, token: string): void {
    this.bridgeUrl = url;
    this.bridgeToken = token;
  }

  async launch(options?: LaunchOptions): Promise<void> {
    // One-shot dispatch mode: a caller (e.g. the Commit-and-Push button) wants a
    // self-contained prompt delivered to a fresh CLI, NOT a full TPM session.
    const promptOverride = options?.promptOverride;
    const oneShot = typeof promptOverride === 'string';

    const enabled = this.loader.getEnabled();
    const composedAgentIds = this.detectComposedAgentIds(enabled);

    const shellPath = this.pickShell();
    const shellArgs = this.pickShellArgs();
    const cwd = this.resolveTerminalCwd(enabled);

    // Read configuration fresh at every launch so edits made in VS Code
    // Settings between play-button clicks take effect without a reload.
    const cfg = vscode.workspace.getConfiguration('ghola');
    // Alias-first resolution: when the user has picked an entry from the
    // Sessions-tab alias dropdown (`selectedAlias`), launch that alias name
    // verbatim and rely on bash's alias lookup. Fall back to the raw
    // `cliCommand` string for back-compat with users who have not migrated
    // to the alias registry.
    const selectedAlias = cfg.get<string>('selectedAlias', '').trim();
    const cliCommand = (selectedAlias !== '' ? selectedAlias : cfg.get<string>('cliCommand', 'claude')).trim();
    const sessionCommand = cfg.get<string>('sessionCommand', 'initiate').trim();

    // Computed once and reused for both the env block below and the banner,
    // so the effective work dir's version/branch is never read twice.
    const version = this.readExtensionVersion();
    const effectiveDir = cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const branch = this.readGitBranch(effectiveDir);

    // Session modality string, mirroring banner.ts's formatMode: the enabled
    // `mode.*` module ids with the `mode.` prefix stripped, joined by ', '
    // (e.g. 'ticket-work', 'support', 'cd'). Precedence: `mode.*` modules win if
    // present; else `self-upgrade` when `tool.self-upgrade` is enabled (a Self
    // Upgrade session is its own non-ticket-scoped modality); else
    // 'unconstrained'. Kept identical to the banner's derivation so the env var
    // and the banner's Mode row never disagree.
    const modes = enabled
      .filter((h) => h.manifest.id.startsWith('mode.'))
      .map((h) => h.manifest.id.slice('mode.'.length));
    const selfUpgradeEnabled = enabled.some((h) => h.manifest.id === SELF_UPGRADE_MODULE_ID);
    const sessionMode =
      modes.length > 0 ? modes.join(', ') : selfUpgradeEnabled ? 'self-upgrade' : 'unconstrained';

    // Launcher-side hard block: a Self Upgrade session edits the Ghola sources
    // themselves, so it may ONLY run when the open work repo IS Project-Ghola.
    // If the session resolves to `self-upgrade` while some other repo is open,
    // refuse to launch outright — no terminal, no command. This is stronger than
    // the agent-side warn-and-refuse (which stays as a backstop for CLI-launched
    // sessions). The `!oneShot` guard explicitly excludes one-shot dispatch
    // (e.g. Commit-and-Push), which carries a `promptOverride` but does not
    // change modules and so can incidentally resolve `sessionMode` to
    // `self-upgrade`; only full TPM sessions are gated here.
    if (sessionMode === 'self-upgrade' && !oneShot && !this.isProjectGholaRepo(effectiveDir)) {
      const where = effectiveDir ?? '<no workspace open>';
      const message = `Self Upgrade can only run in the Project-Ghola repository. Open Project-Ghola as your workspace and relaunch (current: ${where}).`;
      this.logger?.appendLine(`[session] refusing Self Upgrade launch: not Project-Ghola (${where})`);
      void vscode.window.showErrorMessage(message);
      return;
    }

    // War Mode (`mode.war`) is NOT a loader-toggleable module — its enablement
    // is the `mode.war::enabled` setting (an Agents configuration). Read it from
    // the SAME module-settings store the composer gates off (see
    // PromptComposer.renderGholaEntry / host.isGholaEnabled), so the banner's
    // War-Mode indicator is true exactly when the composer injects mode.war.
    const warMode = this.readModuleSetting(GHOLA_MODE_ID, 'enabled') === true;

    const perfCores = cfg.get<number>('swe.performanceCores', 2);
    const effCores = cfg.get<number>('swe.efficiencyCores', 1);
    const perfModel = cfg.get<string>('swe.performanceCoresModel', 'opus');
    const effModel = cfg.get<string>('swe.efficiencyCoresModel', 'sonnet');
    const qaCount = cfg.get<number>('qa.count', 1);
    const qaModel = cfg.get<string>('qa.model', 'sonnet');

    const banner = formatBanner({
      enabledModules: enabled,
      warMode,
      composedAgentIds,
      version,
      cwd: effectiveDir,
      branch,
      team: { perfCores, effCores, perfModel, effModel, qaCount, qaModel },
      cliCommand,
      sessionCommand,
    });

    // Base env shared by all launches. The GHOLA_{TPM,SWE,QA}_PROMPT_FILE
    // scaffolding is only needed for a full TPM session that may spawn
    // subagents, so it is omitted in one-shot dispatch mode.
    const env: Record<string, string> = {
      GHOLA_ROOT: this.extensionPath,
      // Deterministic input for the startup sequence: the extension's own
      // semver, so the session can detect/report which Ghola build launched it.
      GHOLA_VERSION: version,
      // Deterministic input for the startup sequence: the current git branch
      // of the repo the terminal is opening in (empty string when the
      // effective work dir is not a git repo or git is unavailable).
      GHOLA_BRANCH: branch,
      // Carries the session modality (enabled mode.* modules, or
      // 'unconstrained') for the boot probe's mode-gating: the probe suppresses
      // the ticket-key Jira pull and ticket-notes lookup in non-ticket modes
      // (support, cd). Mirrors the banner's Mode row.
      GHOLA_MODE: sessionMode,
      SWE_PERFORMANCE_CORES: String(perfCores),
      SWE_EFFICIENCY_CORES: String(effCores),
      SWE_AGENT_COUNT: String(perfCores + effCores),
      SWE_PERFORMANCE_MODEL: perfModel,
      SWE_EFFICIENCY_MODEL: effModel,
      QA_AGENT_COUNT: String(qaCount),
      QA_MODEL: qaModel,
    };
    // War Mode ledger root, resolved GLOBALLY and identically to the extension
    // host and the `ghola` CLI (see resolveLedgerRoot). Exporting GHOLA_LEDGER_ROOT
    // (and GHOLA_VAULT when a vault resolved) means the in-session CLI resolves the
    // exact same ledger location this launcher and the host computed — no workspace
    // pointer, and no drift that would silently break War Mode.
    const ledger = this.resolveLedgerRoot();
    env.GHOLA_LEDGER_ROOT = ledger.root;
    if (ledger.vault) env.GHOLA_VAULT = ledger.vault;

    // Bridge coordinates go into the terminal env ONLY (never the banner, a log
    // line, or any sendText). The token is a per-session secret; keep it here.
    if (this.bridgeUrl) env.GHOLA_BRIDGE_URL = this.bridgeUrl;
    if (this.bridgeToken) env.GHOLA_BRIDGE_TOKEN = this.bridgeToken;
    if (!oneShot) {
      // Per-workspace paths written by SettingsPanel.writeAllAgentPromptFiles()
      // immediately before launch. Each path is stable across reopens of the
      // same workspace but unique across different workspaces, so two VS Code
      // windows hosting different folders cannot overwrite each other's
      // composed prompts. The SWE/QA files exist so TPM can read them via
      // its Read tool and inject the content into the prompt passed to the
      // Agent tool when spawning a SWE or QA subagent.
      env.GHOLA_TPM_PROMPT_FILE = resolveAgentPromptFilePath('tpm');
      env.GHOLA_SWE_PROMPT_FILE = resolveAgentPromptFilePath('swe');
      env.GHOLA_QA_PROMPT_FILE = resolveAgentPromptFilePath('qa');
    }

    // Singleton terminal: dispose any already-open terminal with the same name
    // (by name-match, so stale duplicates from prior builds are cleared too)
    // before creating a fresh one, so hitting run replaces the prior session
    // rather than stacking a second "Ghola Session" tab.
    const terminalName = options?.terminalName ?? 'Ghola Session';
    for (const t of vscode.window.terminals) {
      if (t.name === terminalName) {
        t.dispose();
      }
    }

    const terminal = vscode.window.createTerminal({
      name: terminalName,
      shellPath,
      shellArgs,
      cwd,
      location: { viewColumn: vscode.ViewColumn.Active },
      env,
    });

    // `show()` with preserveFocus left at its default (false) so the terminal
    // TAKES focus and becomes the active editor. This is load-bearing for the
    // pin below: `launch()` is typically invoked from the "Ghola" settings
    // webview's "Open Session" button, so that webview is the active editor at
    // this point. A previous `show(true)` (preserveFocus=true) revealed the
    // terminal without focusing it, leaving the settings webview active — so
    // `workbench.action.pinEditor` pinned the wrong tab ("Ghola" instead of
    // "Ghola Session"). Focusing the terminal makes IT the active editor so the
    // pin targets the correct tab.
    terminal.show();
    // Auto-pin genuine Ghola Sessions. This works ONLY because the terminal is
    // created with `location: { viewColumn: ViewColumn.Active }` above, which
    // makes it an editor-area terminal (a real, pinnable editor tab) rather than
    // a panel terminal; after `show()` focuses it, it is the active editor, so
    // `workbench.action.pinEditor` pins exactly this tab. COUPLING: if the
    // terminal `location` is ever moved to the panel, it stops being an editor
    // tab and this pin call silently no-ops. Kept immediately after `show()`
    // with no intervening awaits so nothing steals focus before we pin. Gated on
    // `!oneShot` so the transient one-shot 'Ghola Commit' terminal is never
    // pinned — only genuine sessions are. Fire-and-forget (`void` + swallowed
    // rejection, matching updateExtension.ts): pinning is non-critical cosmetics,
    // so a command failure must never abort `launch()` and leave the session
    // terminal open but never started.
    if (!oneShot) {
      void vscode.commands.executeCommand('workbench.action.pinEditor').then(undefined, () => {});
    }
    // Print the banner via the shell so it shows in the terminal buffer.
    this.printBanner(terminal, banner);

    // Two-phase launch:
    //   1) Send `cliCommand` (default: "claude") as a shell command. The
    //      terminal executes it and the CLI process starts.
    //   2) Wait CLI_BOOT_DELAY_MS for the CLI to be ready to accept stdin.
    //   3) Send the phase-2 message AS USER INPUT to the running CLI. By
    //      default this is `sessionCommand` (the trigger word, e.g. "initiate")
    //      whose meaning is defined by the user's CLI configuration. In
    //      one-shot dispatch mode it is `promptOverride` — a self-contained
    //      prompt sent verbatim instead of the trigger word.
    const phaseTwoMessage = oneShot ? promptOverride : sessionCommand;
    // Race-free trigger-word delivery: on bash (WSL/Linux) with a real CLI and a
    // non-empty trigger word, pass the word as the CLI's positional prompt arg so
    // `claude` submits it as turn 1 with no boot-delay race. One-shot dispatch, the
    // pwsh/Windows shell, and the no-CLI shell path all keep the timed phase-2
    // sendText below (a multi-KB one-shot prompt must never go on the command line).
    const isBashShell = shellPath === '/bin/bash' || shellPath === '/usr/bin/bash';
    const useArgPrompt = !oneShot && !!cliCommand && isBashShell && !!phaseTwoMessage;
    if (useArgPrompt) {
      terminal.sendText(`${cliCommand} ${this.shellQuote(phaseTwoMessage!)}`, true);
    } else if (cliCommand) {
      terminal.sendText(cliCommand, true);
      if (phaseTwoMessage) {
        setTimeout(() => {
          terminal.sendText(phaseTwoMessage, true);
        }, CLI_BOOT_DELAY_MS);
      }
    } else if (phaseTwoMessage) {
      // No CLI command configured — preserve the legacy "send phrase to shell"
      // behavior so a user with cliCommand="" can still run an arbitrary
      // one-shot command via the phase-2 message.
      terminal.sendText(phaseTwoMessage, true);
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
    // on every WSL distro Ghola targets; if it is missing, fall through to
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
   * Read the extension's own semver from its `package.json`, so the launched
   * session has a deterministic version string to key off during startup.
   * Falls back to `"unknown"` on any read/parse failure.
   */
  private readExtensionVersion(): string {
    try {
      const pkgPath = path.join(this.extensionPath, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
      return pkg.version ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Read the current git branch of the effective work dir, so the launched
   * session has a deterministic branch name to key off during startup.
   * Returns `""` when there is no dir, the dir is not a git repo, or git is
   * unavailable — never throws.
   */
  private readGitBranch(dir: string | undefined): string {
    if (!dir) return '';
    try {
      const result = childProcess.spawnSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf8',
      });
      if (result.status === 0 && typeof result.stdout === 'string') {
        return result.stdout.trim();
      }
      return '';
    } catch {
      return '';
    }
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

    // WSL-native git-repo workspace: nothing to translate. The fast-path's only
    // legitimate job is mapping a `/mnt/<drive>` (Windows-drive) workspace to its
    // WSL-native clone for speed; a workspace that is ALREADY WSL-native and is a
    // git repo is exactly where the code lives, so open the terminal in the repo
    // ROOT itself. This short-circuits the auto-cd / `isGitRepo(target)` logic
    // below, which could otherwise land on an in-tree subdir (a subdir passes
    // `git rev-parse --is-inside-work-tree` too) or a non-git parent.
    if (!workspacePath.startsWith('/mnt/') && this.isGitRepo(workspacePath)) {
      this.logger?.appendLine(
        `[session] fast-path: WSL-native git repo workspace ${workspacePath}; opening terminal there`,
      );
      return workspacePath;
    }

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

    // Never land the terminal on a non-git parent when a real repo dir is
    // known. The fast-path can resolve to a bare parent (e.g. an explicit
    // `fastpathDirectory` of `~/projects` whose auto-cd candidate is missing),
    // which opens the session in a dir that just contains many clones. Prefer
    // the fast-path target only when it is itself a git repo (this preserves
    // the legitimate `/mnt/c` -> WSL-native-clone translation, whose target IS
    // a repo); otherwise, if the workspace folder is a git repo, open there —
    // that is where the code actually lives.
    if (this.isGitRepo(target)) {
      this.logger?.appendLine(`[session] fast-path: opening terminal in ${target}`);
      return target;
    }
    if (this.isGitRepo(workspacePath)) {
      this.logger?.appendLine(
        `[session] fast-path: target ${target} is not a git repo; opening terminal in workspace folder ${workspacePath}`,
      );
      return workspacePath;
    }
    this.logger?.appendLine(`[session] fast-path: opening terminal in ${target}`);
    return target;
  }

  /**
   * True when `dir` is inside a git work tree (`git rev-parse
   * --is-inside-work-tree` succeeds). Used to keep the terminal from opening in
   * a non-git parent when a real repo dir is known. Never throws.
   */
  private isGitRepo(dir: string): boolean {
    try {
      const result = childProcess.spawnSync(
        'git',
        ['-C', dir, 'rev-parse', '--is-inside-work-tree'],
        { encoding: 'utf8' },
      );
      return result.status === 0 && typeof result.stdout === 'string' && result.stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  /**
   * True only when `dir` lives inside the Project-Ghola repository — i.e. the
   * git toplevel of `dir` has a `package.json` whose `name` is `"ghola"`.
   * Resolves the git root via `git rev-parse --show-toplevel` (the same spawnSync
   * approach used elsewhere in this file), then guarded reads/parses the root
   * `package.json`. Returns `false` on any failure (no dir, no git root, missing
   * or unparseable package.json, wrong name) — never throws.
   */
  private isProjectGholaRepo(dir: string | undefined): boolean {
    if (!dir) return false;
    try {
      const result = childProcess.spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
      });
      if (result.status !== 0 || typeof result.stdout !== 'string') return false;
      const toplevel = result.stdout.trim();
      if (toplevel === '') return false;
      const pkgPath = path.join(toplevel, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string };
      return pkg.name === 'ghola';
    } catch {
      return false;
    }
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
   * Resolve the War Mode ledger root GLOBALLY, with the SAME precedence the
   * `ghola` CLI (`scripts/ghola.mjs` resolveLedgerRoot) and the extension host
   * (`SettingsPanel.resolveLedgerRoot`) use, so all three surfaces always agree:
   *   1. GHOLA_LEDGER_ROOT env (non-empty)                 -> used verbatim.
   *   2. Else the `tool.obsidian-notes` `vaultPath` setting -> <vault>/_Gholas.
   *   3. Else                                               -> <homedir>/.ghola/ledger.
   * NEVER resolves under the launched work repo. Returns the resolved root plus
   * the vault it came from (or null) so the caller can also export GHOLA_VAULT.
   */
  private resolveLedgerRoot(): { root: string; vault: string | null } {
    const envRoot = process.env.GHOLA_LEDGER_ROOT;
    if (typeof envRoot === 'string' && envRoot.trim() !== '') {
      return { root: envRoot.trim(), vault: null };
    }
    const vaultSetting = this.readModuleSetting(OBSIDIAN_MODULE_ID, 'vaultPath');
    if (typeof vaultSetting === 'string' && vaultSetting.trim() !== '') {
      const vault = vaultSetting.trim();
      return { root: path.join(vault, '_Gholas'), vault };
    }
    return { root: path.join(os.homedir(), '.ghola', 'ledger'), vault: null };
  }

  /**
   * Read a single field from a module's persisted settings. Settings live in
   * the GLOBAL `ghola.moduleSettings` map (via `readModuleSettings`, which also
   * falls back to any not-yet-migrated per-workspace value) as a flat dictionary
   * keyed by `moduleId::fieldKey` — match that shape here so we stay in sync
   * without depending on the panel.
   */
  private readModuleSetting(moduleId: string, fieldKey: string): unknown {
    const flat = readModuleSettings(this.globalState, this.workspaceState);
    return flat[`${moduleId}::${fieldKey}`];
  }

  /** Expand a leading `~` or `~/` to the current user's home directory. */
  private expandHome(p: string): string {
    if (p === '~') return os.homedir();
    if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
    return p;
  }

  /**
   * Wrap a string as a single bash single-quoted token, escaping any embedded
   * single quote as '\'' so the CLI receives the value verbatim as one argument.
   * Only used on the bash trigger-word path; pwsh has its own timed sendText.
   */
  private shellQuote(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
  }

  private printBanner(terminal: vscode.Terminal, banner: string): void {
    // A shell-backed terminal echoes every command sent via sendText, so
    // emitting one echo per banner line surfaced six `echo "..."` command lines
    // to the user. Instead, send ONE self-clearing command per shell: clear
    // wipes the echoed command line, then a single printf/Write-Host renders the
    // whole banner, leaving only the banner text in the terminal buffer.
    const isWin = os.platform() === 'win32';
    const lines = banner.split('\n');
    if (isWin) {
      // pwsh: Clear-Host wipes the echoed command line; a single piped statement
      // then writes each banner line. Double-quotes are escaped as `" for pwsh.
      const arr = lines.map((l) => `"${l.replace(/"/g, '`"')}"`).join(',');
      terminal.sendText(`Clear-Host; @(${arr}) | ForEach-Object { Write-Host $_ }`, true);
    } else {
      // bash: clear wipes the echoed command line; a single printf renders every
      // banner line (%s\n per arg). Each line is single-quoted (via shellQuote)
      // so its contents pass through verbatim.
      const args = lines.map((l) => this.shellQuote(l)).join(' ');
      terminal.sendText(`clear; printf '%s\\n' ${args}`, true);
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
