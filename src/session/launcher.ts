import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ModuleLoader } from '../modules/loader';
import type { ModuleHandle } from '../modules/handle';
import { readModuleSettings } from '../state/module-settings';
import {
  parseBashCommand,
  powerShellSkipReason,
  readDefinedAliasNames,
  type CliAlias,
} from './alias-sync';
import { resolveLedgerRoot } from './host-path';
import { newSessionId, resolveAgentPromptFilePath } from './prompt-file';

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
 * `tool.self-upgrade`. When it is enabled and NO `mode.*` module is, the session
 * is a Self Upgrade session — its own non-ticket-scoped modality. The launcher
 * labels `GHOLA_MODE` as `self-upgrade` (not `unconstrained`) so the probe
 * suppresses ticket/Jira/notes probing and the banner's Mode row agrees.
 */
const SELF_UPGRADE_MODULE_ID = 'tool.self-upgrade';

/** Field key on `tool.fastpath-check` for an explicit user-supplied target directory. */
const FASTPATH_SETTING_KEY = 'fastpathDirectory';

/** Field key on `tool.fastpath-check` for the auto-cd-into-matching-repo toggle. */
const AUTO_CD_INTO_REPO_KEY = 'autoCdIntoRepo';

/**
 * Last link in the Remote Control session-name chain. Reached only when every
 * earlier candidate (the operator's override, the git branch, the repo folder
 * name) normalizes to the empty string — which is exactly why it exists: the
 * name handed to `--remote-control` must NEVER be empty. See
 * `resolveRemoteControlSessionName`.
 */
const REMOTE_CONTROL_FALLBACK_NAME = 'ghola-session';

/**
 * Cap on the normalized Remote Control session name. Branch names are unbounded
 * and routinely long (`feature/CMMS-2861-automated-testing---incidents-`); 80
 * characters keeps a real branch fully readable in a phone-sized session list
 * while stopping a pathological branch from dominating the command line. The cap
 * is applied AFTER normalization so it counts the characters actually emitted.
 */
const REMOTE_CONTROL_NAME_MAX_LENGTH = 80;

/**
 * Environment variables whose presence disables Claude Code's Remote Control
 * outright. Host-observable (unlike the plan/OAuth/org-toggle requirements), so
 * they are the part of the gating `checkRemoteControlGating` can honestly
 * pre-flight.
 */
const REMOTE_CONTROL_BLOCKING_ENV_VARS = [
  'DISABLE_TELEMETRY',
  'DO_NOT_TRACK',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'DISABLE_GROWTHBOOK',
];

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

/**
 * Whether the configured CLI command is known to launch Claude Code — the gate
 * every CLAUDE-SPECIFIC launch flag has to pass before it may be appended.
 *
 * `known: true` carries the evidence (`binary`, and `via` naming where the
 * answer came from) so a log line can say WHY the flag was appended. `known:
 * false` carries a `reason` phrased to follow "because ...", so the operator is
 * told what Ghola could not resolve rather than just that something was off.
 */
type ClaudeCliIdentity =
  | { known: true; binary: string; via: string }
  | { known: false; reason: string };

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
   * Path of the bridge COORDINATES FILE — a 0600 JSON file, outside the
   * workspace, holding the live `{ url, token }`. This path (not a secret; the
   * file's contents are) is what makes a session survive an extension-host
   * restart: `bridgeUrl` / `bridgeToken` are snapshotted into the terminal env
   * at creation and VS Code can never mutate a live terminal's environment, so
   * a reload that rotates the port + token orphans the terminal forever. The
   * coordinates PATH is derived from the workspace, so it is stable across
   * restarts; only the file's contents change, and `bb-bridge.mjs` re-reads it
   * on every invocation.
   */
  private bridgeFile?: string;

  /**
   * Supply the bridge coordinates after construction. Called once at activation
   * only when the bridge bound successfully; if never called, launches proceed
   * with no bridge env and the CLI-side module fails loud.
   */
  setBridge(url: string, token: string, coordinatesFile?: string): void {
    this.bridgeUrl = url;
    this.bridgeToken = token;
    this.bridgeFile = coordinatesFile;
  }

  async launch(options?: LaunchOptions): Promise<void> {
    // One-shot dispatch mode: a caller (e.g. the Commit-and-Push button) wants a
    // self-contained prompt delivered to a fresh CLI, NOT a full TPM session.
    const promptOverride = options?.promptOverride;
    const oneShot = typeof promptOverride === 'string';

    const enabled = this.loader.getEnabled();

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

    // Permission mode the session launches Claude Code in, so the user does not
    // have to press Shift+Tab. Read the same way as cliCommand/sessionCommand.
    //
    // `--dangerously-skip-permissions` is a CLAUDE-SPECIFIC flag, so it does need
    // a gate: appending it to a foreign binary would make the launch fail. But
    // the gate used to be `cliCommand.includes('claude')` — a substring test on a
    // string that is, in the alias-first world, usually an alias NAME rather than
    // a binary. An operator whose alias is `cc`, `csession`, or `work` therefore
    // got NO permission flag while the settings UI still showed bypassPermissions:
    // the chosen setting and the emitted command line diverged silently.
    //
    // `identifyClaudeCli` replaces the substring test with an actual resolution
    // (alias name -> registered expansion -> binary), and the branches below
    // decide what happens when the answer is genuinely unknowable. Every future
    // Claude-specific flag must reuse `claudeCli` rather than re-deriving its own
    // guess from `cliCommand`, or it inherits exactly this blind spot.
    //
    // `permFlag` carries its OWN leading space so it can be spliced directly
    // after `${cliCommand}` at the emission sites (empty string = no flag).
    const permissionMode = cfg.get<string>('permissionMode', 'bypassPermissions');
    const claudeCli = this.identifyClaudeCli(cliCommand, cfg);
    let permFlag = '';
    // 'off' (and any unexpected value) -> no flag, current manual-approve behavior.
    if (permissionMode === 'bypassPermissions') {
      if (claudeCli.known) {
        permFlag = ' --dangerously-skip-permissions';
      } else if (this.isExplicitlyConfigured(cfg, 'permissionMode')) {
        // Unknowable command, but the operator WROTE this setting, so there is a
        // real choice to honor. Honor it. The trade: a flag a non-Claude binary
        // rejects makes that binary print its usage and exit — loud, visible in
        // the terminal, and fixable by setting permissionMode to "off". Dropping
        // the flag the operator asked for is invisible and looks exactly like
        // Ghola working correctly, which is the failure being fixed here.
        permFlag = ' --dangerously-skip-permissions';
        this.logger?.appendLine(
          `[session] permissionMode=bypassPermissions honored on a BEST-EFFORT basis because ${claudeCli.reason}. --dangerously-skip-permissions was appended anyway because ghola.permissionMode is a value you set explicitly. If the command rejects the flag, register it in Ghola's CLI Aliases so Ghola can resolve its binary, or set ghola.permissionMode to "off".`,
        );
      } else if (cliCommand !== '') {
        // Nothing of the operator's to honor: bypassPermissions is only the
        // DEFAULT here, and the command is not recognizably Claude Code. Skip the
        // flag so a foreign CLI still launches — but never silently. A missing
        // permission flag with no explanation is the exact defect this block
        // exists to prevent, so it gets the same non-blocking warning treatment
        // as a failed CLI pre-flight.
        const message = `Ghola Session: launched WITHOUT --dangerously-skip-permissions because ${claudeCli.reason}, and ghola.permissionMode is still at its default rather than a value you chose. Register the command in Ghola's CLI Aliases so Ghola can resolve its binary, or set ghola.permissionMode explicitly to have the flag passed regardless.`;
        this.logger?.appendLine(`[session] ${message}`);
        void vscode.window.showWarningMessage(message);
      }
    }

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

    // Pre-flight the resolved CLI command so a command the shell cannot resolve
    // produces an actionable message instead of a CommandNotFoundException
    // followed by the trigger word being typed into a shell with no CLI in it.
    // Returns [] on non-win32 by design — see checkCliCommandResolvable.
    const cliProblems = await this.checkCliCommandResolvable(cliCommand, cfg);
    if (cliProblems.length > 0) {
      this.logger?.appendLine(`[session] CLI pre-flight failed: ${cliProblems.join(' | ')}`);
      void vscode.window.showWarningMessage(`Ghola Session: ${cliProblems.join(' ')}`);
    }

    // Remote Control: `--remote-control <name>` starts the interactive session
    // with Remote Control enabled, so the operator can steer this local session
    // from a phone or from claude.ai/code. It composes cleanly with
    // `--dangerously-skip-permissions`. It is MANDATORY — every session launch
    // gets it, with no setting to turn it off.
    //
    // This is a second CLAUDE-SPECIFIC flag, so it goes through the SAME
    // `claudeCli` gate `permFlag` uses — the comment on the permission block says
    // every future Claude-specific flag must reuse `claudeCli` rather than
    // re-deriving its own guess from `cliCommand`, and this is that future flag.
    //
    // WHY THE THREE-WAY OUTCOME COLLAPSES TO TWO HERE, structurally rather than by
    // preference: Remote Control is MANDATORY. There is no `ghola.remoteControl`
    // setting to consult any more — the flag is not opt-in, so permFlag's third
    // case ("the setting is merely sitting at its packaged default and the command
    // is not recognizably Claude") has no analogue: there is no setting whose
    // default-vs-chosen status could distinguish two launches, and therefore
    // nothing to ask the operator to change. That leaves known -> append, and
    // unknown -> append BEST-EFFORT with a log line. The log line is the whole
    // remedy surface, which is why it names the CLI-alias registration that would
    // let Ghola resolve the binary instead of guessing at it.
    //
    // The flag itself is safe to append blind: `--remote-control <name>` is
    // ACCEPTED and non-fatal even when Remote Control is disabled by environment
    // (verified against a kill-switch variable), so a machine that cannot bring
    // Remote Control up still launches normally. What is NOT established is how an
    // INTERACTIVE session degrades when Remote Control is unavailable — that was
    // only ever probed non-interactively — so `checkRemoteControlGating` below
    // stays as the operator-facing warning for the observable half of the gating.
    //
    // `oneShot` is excluded deliberately, and mandatory does not change that
    // reasoning: the Commit-and-Push terminal is a transient single-prompt
    // dispatch, and registering it as a steerable remote session would leave a
    // phantom entry there is nothing to steer.
    let remoteControlName = '';
    if (!oneShot && cliCommand !== '') {
      remoteControlName = this.resolveRemoteControlSessionName(cfg, effectiveDir, branch);
      if (claudeCli.known) {
        this.logger?.appendLine(
          `[session] Remote Control: --remote-control ${remoteControlName} (identified as Claude Code via ${claudeCli.via})`,
        );
      } else {
        this.logger?.appendLine(
          `[session] Remote Control appended on a BEST-EFFORT basis because ${claudeCli.reason}. --remote-control ${remoteControlName} went on the command line anyway because Remote Control is mandatory and there is no setting left to drop it. If the command turns out not to be Claude Code and rejects the flag, register it in Ghola's CLI Aliases so Ghola can resolve its binary.`,
        );
      }
      // Non-blocking, exactly like the permission-mode warning above: a launch is
      // never withheld over gating Ghola can only partly observe. Deliberately
      // kept OUT of `cliProblems` — that list gates the phase-2 send, and Remote
      // Control being unavailable has no bearing on whether the CLI can start.
      const gatingProblems = this.checkRemoteControlGating(cliCommand, cfg);
      if (gatingProblems.length > 0) {
        this.logger?.appendLine(
          `[session] Remote Control pre-flight: ${gatingProblems.join(' | ')}`,
        );
        void vscode.window.showWarningMessage(`Ghola Session: ${gatingProblems.join(' ')}`);
      }
    }

    const perfCores = cfg.get<number>('swe.performanceCores', 2);
    const effCores = cfg.get<number>('swe.efficiencyCores', 1);
    const perfModel = cfg.get<string>('swe.performanceCoresModel', 'opus');
    const effModel = cfg.get<string>('swe.efficiencyCoresModel', 'sonnet');
    const qaCount = cfg.get<number>('qa.count', 1);
    const qaModel = cfg.get<string>('qa.model', 'sonnet');

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
      // Fresh identifier per LAUNCH, so two sessions opened concurrently in the
      // SAME repo hold different values. Modules that produce per-run output key
      // on this to keep concurrent runs apart: `tool.playwright` nests each
      // run's test-results/, playwright-report/, videos/, and Edge profile under
      // it. Deliberately NOT derived from the workspace path or the extension-host
      // instance — those are what the composed-prompt-file suffix is keyed on, and
      // both are constant for the life of the window, so two LAUNCHES in one
      // window share them. See `newSessionId` in prompt-file.ts.
      GHOLA_SESSION_ID: newSessionId(),
      SWE_PERFORMANCE_CORES: String(perfCores),
      SWE_EFFICIENCY_CORES: String(effCores),
      SWE_AGENT_COUNT: String(perfCores + effCores),
      SWE_PERFORMANCE_MODEL: perfModel,
      SWE_EFFICIENCY_MODEL: effModel,
      QA_AGENT_COUNT: String(qaCount),
      QA_MODEL: qaModel,
    };
    // War Mode ledger root, resolved GLOBALLY through the SHARED resolver in
    // `host-path.ts` — the same one the settings panel's War Room reader and the
    // activation-time ledger watchers use, so writer and watcher can never
    // disagree. Exporting GHOLA_LEDGER_ROOT (and GHOLA_VAULT when a vault
    // resolved) means the in-session CLI resolves the exact same ledger location
    // this launcher and the host computed — no workspace pointer, and no drift
    // that would silently break War Mode. Both values are already in the host's
    // NATIVE path form (the resolver normalizes the vault before joining), so the
    // CLI's `path.resolve` cannot re-anchor a foreign `/mnt/<drive>` path onto
    // the current drive.
    const ledger = resolveLedgerRoot(this.globalState, this.workspaceState, (m) =>
      this.logger?.appendLine(`[session] ${m}`),
    );
    env.GHOLA_LEDGER_ROOT = ledger.root;
    if (ledger.vault) env.GHOLA_VAULT = ledger.vault;

    // Bridge coordinates go into the terminal env ONLY (never the banner, a log
    // line, or any sendText). The token is a per-session secret; keep it here.
    //
    // GHOLA_BRIDGE_FILE is the PREFERRED channel and is what bb-bridge.mjs reads
    // first: the path is stable across extension-host restarts, so a terminal
    // launched today keeps working after tomorrow's window reload rotates the
    // bridge's port and token. GHOLA_BRIDGE_URL / GHOLA_BRIDGE_TOKEN are kept
    // alongside it, unchanged, as the backward-compatible fallback for terminals
    // launched before the coordinates file existed — do not remove them.
    if (this.bridgeFile) env.GHOLA_BRIDGE_FILE = this.bridgeFile;
    if (this.bridgeUrl) env.GHOLA_BRIDGE_URL = this.bridgeUrl;
    if (this.bridgeToken) env.GHOLA_BRIDGE_TOKEN = this.bridgeToken;
    if (!oneShot) {
      // Paths written by SettingsPanel.writeAllAgentPromptFiles() immediately
      // before launch. Keyed on the workspace folder AND this extension-host
      // instance (see resolveAgentPromptFilePath), so neither two windows on
      // different folders NOR two windows/profiles on the SAME folder can
      // overwrite each other's composed prompts while an agent is reading them.
      // Resolving here rather than accepting the writer's return value is safe
      // precisely because both sides key on process-scoped inputs. The SWE/QA
      // files exist so TPM can read them via its Read tool and inject the
      // content into the prompt passed to the Agent tool when spawning a SWE or
      // QA subagent.
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

    // Auto-pin genuine Ghola Sessions. ARM the pin BEFORE `show()` so we never
    // miss the activation event it triggers (see pinSessionTerminal for the race
    // this closes). Gated on `!oneShot` so the transient one-shot 'Ghola Commit'
    // terminal is never pinned — only genuine sessions are.
    if (!oneShot) {
      this.pinSessionTerminal(terminal);
    }
    // `show()` with preserveFocus left at its default (false) so the terminal
    // TAKES focus and becomes the active editor. A previous `show(true)`
    // (preserveFocus=true) revealed the terminal without focusing it, leaving
    // the launching "Ghola" settings webview active — so the pin landed on the
    // wrong tab. Focusing the terminal makes IT the active editor, but only
    // asynchronously (see pinSessionTerminal), which is why the pin is wired to
    // the activation event rather than fired inline here.
    terminal.show();

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
    // Race-free trigger-word delivery: on bash (WSL/Linux) or PowerShell
    // (Windows) with a real CLI and a non-empty trigger word, pass the word as
    // the CLI's positional prompt arg so `claude` submits it as turn 1 with no
    // boot-delay race — and so nothing is ever typed after a command the shell
    // could not resolve. Each shell gets its own quoting (bash escapes an
    // embedded single quote as '\'', PowerShell by doubling it). One-shot
    // dispatch and the no-CLI shell path keep the timed phase-2 sendText below
    // (a multi-KB one-shot prompt must never go on the command line).
    //
    // An UNDEFINED `shellPath` on a non-win32 host counts as bash-equivalent, and
    // that closes the last Enter-key gap. `pickShell()` returns undefined there
    // only when NEITHER /bin/bash NOR /usr/bin/bash exists (a zsh- or fish-only
    // box), in which case VS Code falls back to the user's default profile — some
    // POSIX shell (zsh, fish, sh, dash), every one of which accepts the POSIX
    // single-quoted token `shellQuote` emits, including its '\'' escape (the
    // adjacent-token concatenation that trick relies on is POSIX word-joining, and
    // fish reproduces it too). Without this, that host alone fell through to the
    // timed two-phase send, where the trigger word arrives as terminal input and
    // waits for a manual Enter. NOT widened to cover a hypothetical `cmd.exe`:
    // neither quoter models cmd's quoting, and `pickShell()` cannot return it
    // anyway (win32 always resolves to pwsh.exe or powershell.exe), so the
    // platform guard keeps the undefined case POSIX-only by construction.
    const isBashShell =
      shellPath === '/bin/bash' ||
      shellPath === '/usr/bin/bash' ||
      (shellPath === undefined && os.platform() !== 'win32');
    const isPwshShell = shellPath === 'pwsh.exe' || shellPath === 'powershell.exe';
    // `--remote-control` carries its OWN leading space, following `permFlag`'s
    // convention above so the flags compose by plain concatenation after
    // `${cliCommand}` (empty string = no flag).
    //
    // The name is ALWAYS present and ALWAYS routed through the same quoter as the
    // trigger word, so a branch full of `/` and `-` arrives as ONE token on both
    // shells. This is the whole point of the design: `--remote-control [name]`
    // takes an OPTIONAL value, so `claude --remote-control 'initiate'` binds
    // `initiate` as the SESSION NAME, the trigger word vanishes, and the session
    // boots un-initiated. Supplying the value ourselves satisfies the option
    // before the positional prompt is ever parsed, which keeps the trigger word
    // unambiguously the prompt — hence the flag stays BEFORE `${quoted}`.
    // `resolveRemoteControlSessionName` cannot return an empty string, so the only
    // way `remoteControlName` is empty here is the block above having declined to
    // resolve one at all: a one-shot dispatch, or no CLI command configured. There
    // is no longer a Remote-Control-is-off case — the flag is mandatory — so this
    // ternary now encodes exactly those two exclusions and nothing else.
    const remoteFlag =
      remoteControlName === ''
        ? ''
        : ` --remote-control ${isPwshShell ? this.pwshQuote(remoteControlName) : this.shellQuote(remoteControlName)}`;
    const useArgPrompt = !oneShot && !!cliCommand && (isBashShell || isPwshShell) && !!phaseTwoMessage;
    if (useArgPrompt) {
      const quoted = isPwshShell
        ? this.pwshQuote(phaseTwoMessage!)
        : this.shellQuote(phaseTwoMessage!);
      terminal.sendText(`${cliCommand}${permFlag}${remoteFlag} ${quoted}`, true);
    } else if (cliCommand) {
      terminal.sendText(`${cliCommand}${permFlag}${remoteFlag}`, true);
      // Only arm the blind timer when pre-flight found nothing wrong. When the
      // CLI plainly cannot start, the phase-2 message would land in the shell as
      // a bogus command rather than as CLI input, so hold it back and say why.
      if (phaseTwoMessage && cliProblems.length === 0) {
        setTimeout(() => {
          terminal.sendText(phaseTwoMessage, true);
        }, CLI_BOOT_DELAY_MS);
      } else if (phaseTwoMessage) {
        this.logger?.appendLine(
          '[session] holding back the phase-2 message: the CLI command failed pre-flight, so it would be typed into a shell with no CLI running',
        );
      }
    } else if (phaseTwoMessage) {
      // No CLI command configured — preserve the legacy "send phrase to shell"
      // behavior so a user with cliCommand="" can still run an arbitrary
      // one-shot command via the phase-2 message.
      terminal.sendText(phaseTwoMessage, true);
    }

    this.logger?.appendLine(`[session] launched terminal with shell: ${shellPath ?? '<default>'}`);
  }

  /**
   * Pin the freshly-created session terminal's editor tab, deterministically.
   *
   * ROOT CAUSE this closes: `terminal.show()` reveals and focuses the terminal,
   * but VS Code promotes it to the ACTIVE editor asynchronously. Firing
   * `workbench.action.pinEditor` in the same synchronous tick (the previous
   * behavior) pins whatever editor was active BEFORE the terminal took over —
   * typically the "Ghola" settings webview that invoked `launch()` — so the
   * session tab came up unpinned. That async-activation race, NOT the
   * already-fixed `show(true)` preserveFocus bug, is why the pin kept landing on
   * the wrong tab.
   *
   * Instead of guessing a delay, we wait for `onDidChangeActiveTerminal` to
   * confirm THIS terminal is the active terminal, then — on the next tick, once
   * the editor group has settled — verify the active editor tab really is a
   * terminal before pinning exactly that tab. The `TabInputTerminal` check is a
   * belt-and-suspenders guard that makes it impossible to pin a non-terminal tab
   * (the exact failure this bug reproduced).
   *
   * COUPLING: this works only because the terminal is created with
   * `location: { viewColumn: ViewColumn.Active }`, making it an editor-area
   * terminal (a real, pinnable editor tab). If the terminal `location` ever
   * moves to the panel, it stops being an editor tab and the guard below
   * correctly declines to pin.
   *
   * Fire-and-forget: pinning is non-critical cosmetics, so every failure path is
   * swallowed and never aborts the launch.
   */
  private pinSessionTerminal(terminal: vscode.Terminal): void {
    const disposables: vscode.Disposable[] = [];
    const dispose = (): void => {
      while (disposables.length) disposables.pop()!.dispose();
    };
    const pinNow = (): void => {
      if (vscode.window.activeTerminal !== terminal) return;
      const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
      if (!(activeTab?.input instanceof vscode.TabInputTerminal)) return;
      void vscode.commands.executeCommand('workbench.action.pinEditor').then(undefined, () => {});
      dispose();
    };
    // Pin once VS Code reports this terminal as active. Deferred one tick so the
    // editor group has settled and the active tab reflects the terminal.
    disposables.push(
      vscode.window.onDidChangeActiveTerminal(() => {
        if (vscode.window.activeTerminal === terminal) setTimeout(pinNow, 0);
      }),
    );
    // Cover the case where the terminal is already active by the time we
    // subscribe (no further change event would fire).
    if (vscode.window.activeTerminal === terminal) setTimeout(pinNow, 0);
    // Safety net: never leave the listener dangling if the terminal never
    // becomes active (e.g. the user clicked away during CLI boot).
    const timer = setTimeout(dispose, 10000);
    disposables.push(new vscode.Disposable(() => clearTimeout(timer)));
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

  /**
   * Wrap a string as a single PowerShell single-quoted token. PowerShell's
   * literal-string escape for an embedded single quote is to DOUBLE it (`''`) —
   * bash's `'\''` trick would be passed through verbatim and corrupt the value.
   * Only used on the pwsh trigger-word path.
   */
  private pwshQuote(s: string): string {
    return `'${s.replace(/'/g, "''")}'`;
  }

  /**
   * Resolve the Remote Control session name. **Never returns an empty string** —
   * that is this function's entire contract, because `--remote-control [name]`
   * takes an OPTIONAL value, so an empty or omitted name lets the CLI bind the
   * positional trigger word as the session name and the session boots
   * un-initiated.
   *
   * The chain, first non-empty normalized candidate wins:
   *
   *   1. `ghola.remoteControlSessionName` — an explicit override always wins.
   *   2. The current git BRANCH, reused from the value already resolved for
   *      `GHOLA_BRANCH` rather than shelling out to git a second time. This is
   *      the default because a branch is what actually distinguishes concurrent
   *      sessions: Claude Code's own `--remote-control-session-name-prefix`
   *      defaults to the HOSTNAME, which makes eight sessions on one machine
   *      indistinguishable from a phone.
   *   3. The effective working directory's BASENAME — the repo folder name. This
   *      is what covers the two explicit edge cases: a DETACHED HEAD (where
   *      `git rev-parse --abbrev-ref HEAD` prints the literal `HEAD`, which names
   *      no branch) and a NON-GIT workspace (where `readGitBranch` returns `''`).
   *   4. `REMOTE_CONTROL_FALLBACK_NAME` — a static constant, reached when there is
   *      no workspace at all or when every earlier candidate normalizes away.
   *
   * Emptiness is impossible STRUCTURALLY, not probabilistically: the last
   * candidate is a literal that normalizes to itself, and the loop returns the
   * first candidate that normalizes non-empty, so the loop cannot fall through
   * for any input. The trailing return is unreachable and exists only so the
   * signature is total without relying on that argument.
   */
  private resolveRemoteControlSessionName(
    cfg: vscode.WorkspaceConfiguration,
    dir: string | undefined,
    branch: string,
  ): string {
    const candidates = [
      cfg.get<string>('remoteControlSessionName', ''),
      branch === 'HEAD' ? '' : branch,
      dir ? path.basename(dir) : '',
      REMOTE_CONTROL_FALLBACK_NAME,
    ];
    for (const candidate of candidates) {
      const normalized = this.normalizeRemoteControlName(candidate);
      if (normalized !== '') return normalized;
    }
    return REMOTE_CONTROL_FALLBACK_NAME;
  }

  /**
   * Normalize one session-name candidate, returning `''` when nothing usable is
   * left (which is how `resolveRemoteControlSessionName` advances its chain).
   *
   * Each rule earns its place:
   *
   *   - Control characters are stripped. They would be quoted faithfully and then
   *     corrupt the terminal's own rendering of the command line.
   *   - Whitespace and BOTH path separators collapse to `-`. Quoting already makes
   *     `/` safe for the shell, so this is not a shell-safety measure: whether the
   *     Remote Control service accepts a `/` in a session name is not observable
   *     from here, and `feature-CMMS-2861-...` stays every bit as recognizable to
   *     the operator as `feature/CMMS-2861-...`. Runs of `-` are deliberately NOT
   *     collapsed — a branch with `---` in it keeps it, so the name still matches
   *     what `git branch` prints.
   *   - LEADING dashes are removed, and this one is a correctness requirement
   *     rather than cosmetics: an option with an optional value treats a following
   *     token that begins with `-` as the NEXT OPTION, not as its value, so
   *     `--remote-control '-wip'` would leave the option valueless and re-expose
   *     the exact trap the explicit name exists to prevent.
   *   - Trailing dashes are removed so a name never reads as truncated; the cap is
   *     re-trimmed for the same reason after it cuts.
   */
  private normalizeRemoteControlName(raw: string): string {
    const cleaned = raw
      .replace(/[\u0000-\u001f\u007f]+/g, '')
      .replace(/[\s/\\]+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '');
    if (cleaned.length <= REMOTE_CONTROL_NAME_MAX_LENGTH) return cleaned;
    return cleaned.slice(0, REMOTE_CONTROL_NAME_MAX_LENGTH).replace(/-+$/, '');
  }

  /**
   * Decide whether `cliCommand` launches Claude Code, so a Claude-SPECIFIC launch
   * flag can be appended to it. This is the single decision site for that
   * question — the reason the old `cliCommand.includes('claude')` test had to go.
   *
   * WHY A SUBSTRING TEST IS THE WRONG INSTRUMENT. Since alias-first resolution
   * landed, `cliCommand` is normally an entry from `ghola.cliAliases` — an alias
   * NAME, chosen by the operator, that says nothing about the binary behind it.
   * `csession` runs Claude Code; `claude-tools` might not. The substring test got
   * both backwards and, worse, got the first one wrong SILENTLY.
   *
   * The two tiers below are ordered by how much they actually know:
   *
   *   1. REGISTRY RESOLUTION (real evidence). When the command is a registered
   *      alias, `ghola.cliAliases` holds its bash-canonical expansion, and
   *      `parseBashCommand` already knows how to reduce that to {envVars, binary,
   *      args}. Test the BINARY, strictly: basename, minus any Windows executable
   *      extension, equal to `claude`. This is what makes `cc`, `csession`, and
   *      `work` resolve correctly instead of failing the old substring test.
   *   2. NAME PATTERN (the pre-existing signal, kept verbatim). If tier 1 does not
   *      answer — the command is not registered, or its expansion is not a plain
   *      simple command Ghola will parse — fall back to the old
   *      `includes('claude')` test on the whole command string. Keeping it, rather
   *      than replacing it with something stricter, is deliberate: it makes the
   *      set of commands recognized here a strict SUPERSET of what HEAD
   *      recognized, so no working configuration (a hand-written `claude-2` alias
   *      that was never registered, `claude.exe`, `/usr/local/bin/claude`) can
   *      lose a flag it used to get.
   *
   * When neither tier answers the command is genuinely UNKNOWABLE from here: it
   * could be a shell function or a wrapper script that execs `claude`, and this
   * process cannot see inside either (see `checkCliCommandResolvable` for why an
   * interactive-shell probe is not available). The `reason` returned says which
   * of those it was; the caller decides between honoring the operator's explicit
   * setting and warning that it could not.
   */
  private identifyClaudeCli(
    cliCommand: string,
    cfg: vscode.WorkspaceConfiguration,
  ): ClaudeCliIdentity {
    const command = cliCommand.trim();
    if (command === '') {
      return { known: false, reason: 'no CLI command is configured' };
    }

    // (1) Registry resolution.
    const aliases = cfg.get<CliAlias[]>('cliAliases', []);
    const registered = aliases.find((entry) => entry?.alias === command);
    const parsed = registered ? parseBashCommand(registered.command) : null;
    if (parsed && this.isClaudeBinaryName(parsed.binary)) {
      return {
        known: true,
        binary: parsed.binary,
        via: `the registered expansion of alias "${command}"`,
      };
    }

    // (2) Name pattern — HEAD's test, unchanged, on the whole command string.
    if (command.toLowerCase().includes('claude')) {
      return { known: true, binary: command, via: 'the configured CLI command itself' };
    }

    if (registered && !parsed) {
      return {
        known: false,
        reason: `alias "${command}" is registered in Ghola's CLI Aliases but its expansion (${registered.command}) is not a plain "VAR=value ... binary args" command, so Ghola cannot tell which binary it runs`,
      };
    }
    if (parsed) {
      return {
        known: false,
        reason: `alias "${command}" is registered in Ghola's CLI Aliases and expands to the binary "${parsed.binary}", which is not Claude Code's "claude"`,
      };
    }
    return {
      known: false,
      reason: `"${command}" does not name Claude Code's "claude" binary and is not registered in Ghola's CLI Aliases, so Ghola cannot resolve which binary it runs`,
    };
  }

  /**
   * True when `binary` names Claude Code's own executable. Applied only to a
   * binary `parseBashCommand` resolved out of a registered alias, which is why it
   * can afford to be strict where the name-pattern tier cannot: take the
   * basename (either separator, so a Windows path works too), drop a Windows
   * executable extension, and require exactly `claude`.
   */
  private isClaudeBinaryName(binary: string): boolean {
    const base = binary.split(/[\\/]/).pop() ?? '';
    return base.toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/, '') === 'claude';
  }

  /**
   * True when `key` under the `ghola` section holds a value the OPERATOR wrote,
   * as opposed to the packaged default. Every scope VS Code lets a user write is
   * checked (user, remote, workspace, folder), including a language-scoped
   * override, because any of them is an explicit choice.
   *
   * This distinction exists so a Claude-specific flag can tell "the operator asked
   * for this" apart from "this happens to be the default". It does NOT change what
   * any setting means or what it defaults to: `cfg.get` remains the only reader of
   * the effective value.
   */
  private isExplicitlyConfigured(cfg: vscode.WorkspaceConfiguration, key: string): boolean {
    const inspected = cfg.inspect<unknown>(key);
    if (!inspected) return false;
    return (
      inspected.globalValue !== undefined ||
      inspected.workspaceValue !== undefined ||
      inspected.workspaceFolderValue !== undefined ||
      inspected.globalLanguageValue !== undefined ||
      inspected.workspaceLanguageValue !== undefined ||
      inspected.workspaceFolderLanguageValue !== undefined
    );
  }

  /**
   * Pre-flight the resolved CLI command and return a list of actionable problems
   * (empty = nothing detectably wrong). Never throws.
   *
   * HONEST SCOPE — this check only runs on win32, and that is deliberate:
   *
   *   - On bash hosts the command is usually an ALIAS, and an alias is not on
   *     PATH. The only real test is `command -v <name>` inside the interactive
   *     shell that sourced the rc file, which the extension host cannot run
   *     synchronously (a non-interactive `bash -c` does not source ~/.bashrc, so
   *     it would report "missing" for every working alias). A host-side check
   *     there would be nothing but false alarms, so bash gets no check at all —
   *     it does not need one either, because the bash path delivers the trigger
   *     word as a positional argument, so a failed command types nothing after
   *     itself.
   *   - On win32 the answer IS knowable. PowerShell never sources a shell rc
   *     file; a Ghola alias exists only as a function in the PowerShell profile,
   *     and a plain binary exists only if it is on PATH. Both are checkable from
   *     here.
   *
   * TELL THE OPERATOR THE SAME STORY THE WRITER DOES. Two things make that work,
   * and neither is optional:
   *
   *   - the profile scan (`readDefinedAliasNames`) covers the WHOLE file, not
   *     just Ghola's managed spans, because `renderPowerShellBlock`'s own skip
   *     warnings tell the operator to hand-define an untranslatable alias
   *     OUTSIDE the managed block. A managed-spans-only scan warned forever about
   *     an alias the operator had already fixed exactly as instructed.
   *   - when nothing defines the name, the remedy offered depends on
   *     `powerShellSkipReason`. "Press Save" is only honest for an entry the
   *     alias sync would actually emit; for one it refuses, Save is a no-op and
   *     saying otherwise sends the operator round a loop that cannot terminate.
   *
   * The stakes are higher than a stray notification: on the one-shot
   * Commit-and-Push path (`promptOverride` set, so `useArgPrompt` is false) a
   * non-empty return here HOLDS BACK the phase-2 prompt with nothing but an
   * output-channel line, so a false positive silently does nothing at all.
   */
  private async checkCliCommandResolvable(
    cliCommand: string,
    cfg: vscode.WorkspaceConfiguration,
  ): Promise<string[]> {
    if (cliCommand === '' || os.platform() !== 'win32') return [];

    const aliases = cfg.get<CliAlias[]>('cliAliases', []);
    const registered = aliases.find((entry) => entry?.alias === cliCommand);
    if (registered) {
      let defined: string[] = [];
      try {
        defined = await readDefinedAliasNames(cfg.get<string>('aliasFile', '~/.bashrc'));
      } catch (err) {
        // Cannot read the profile — say nothing rather than raise a false alarm.
        this.logger?.appendLine(
          `[session] CLI pre-flight: could not read the PowerShell profile (${(err as Error).message})`,
        );
        return [];
      }
      if (defined.includes(cliCommand)) return [];
      // Nothing in the profile defines the name. Which remedy is honest depends
      // on whether the alias sync can render this entry at all.
      const skipReason = powerShellSkipReason(registered);
      if (skipReason !== null) {
        return [
          `"${cliCommand}" is registered in Ghola's CLI Aliases but nothing in your PowerShell profile defines it, and pressing Save will not change that because Ghola cannot translate this entry: ${skipReason}`,
        ];
      }
      return [
        `"${cliCommand}" is registered in Ghola's CLI Aliases but nothing in your PowerShell profile defines it, so PowerShell cannot run it. Open Ghola's settings and press Save on the CLI Aliases list to write the managed PowerShell block, then relaunch.`,
      ];
    }

    if (!this.isOnWindowsPath(cliCommand)) {
      return [
        `"${cliCommand}" was not found on PATH, so PowerShell cannot run it. Install the CLI, or register it in Ghola's CLI Aliases and pick it in the Sessions tab.`,
      ];
    }
    return [];
  }

  /**
   * True when the first token of `command` resolves on the Windows PATH.
   * Returns `true` when the probe itself could not run — an unknown answer must
   * never turn into a warning the operator cannot act on. Never throws.
   *
   * BOTH failure channels have to fail OPEN, which is why `result.error` gets its
   * own early return rather than being folded into the status check.
   * `spawnSync` reports most spawn failures (ENOENT on `where` itself, EACCES,
   * EMFILE, a spawn blocked by policy) by POPULATING `result.error` and
   * returning normally — it does not throw, so the `catch` below never sees
   * them. Treating a populated `error` as part of the answer would make the
   * probe report "not on PATH" for a question it never actually asked, and emit
   * a warning about the operator's CLI that no change to their PATH could clear.
   */
  private isOnWindowsPath(command: string): boolean {
    const binary = command.trim().split(/\s+/)[0];
    if (!binary) return true;
    try {
      const result = childProcess.spawnSync('where', [binary], { encoding: 'utf8' });
      if (result.error) return true;
      return result.status === 0;
    } catch {
      return true;
    }
  }

  /**
   * Pre-flight the part of Claude Code's Remote Control gating that is actually
   * OBSERVABLE from the extension host, returning a list of actionable problems
   * (empty = nothing detectably wrong). Never throws. Called on every launch that
   * gets the flag (i.e. every non-one-shot launch with a CLI command); the caller
   * warns and launches anyway.
   *
   * INFORMATION, NOT A GATE. Remote Control is mandatory, so a problem found here
   * cannot be "fixed" by turning something off in Ghola — the operator has no such
   * switch. What is left is genuinely actionable elsewhere: the variable to unset
   * and the layer to unset it in. Every message below therefore reports the
   * environment fact plus its layer-specific remedy, states that the session
   * launched regardless, and never mentions a Ghola setting. These strings are also
   * deliberately kept out of `cliProblems`: that list gates the phase-2 trigger-word
   * send, and Remote Control being unavailable says nothing about whether the CLI
   * can start.
   *
   * Follows `checkCliCommandResolvable`'s doctrine: check only what is knowable,
   * fail OPEN on anything unanswerable, and offer a remedy that can actually work.
   *
   * WHAT IT CHECKS — the two conditions Ghola can see:
   *
   *   - the four kill-switch variables in `REMOTE_CONTROL_BLOCKING_ENV_VARS`, whose
   *     mere presence disables Remote Control outright;
   *   - `ANTHROPIC_BASE_URL` pointing somewhere that is not Anthropic.
   *
   * across the three places a session's environment actually comes from, merged in
   * the SAME precedence order the session will see:
   *
   *   1. `process.env` — the extension host's environment, which the terminal
   *      inherits.
   *   2. `terminal.integrated.env.<platform>` — VS Code layers this over the
   *      inherited environment for every terminal it creates. A `null` value there
   *      DELETES the variable, so a null is treated as "not set" (and is offered
   *      below as the remedy).
   *   3. The selected alias's `VAR=value` prefixes, parsed by the same
   *      `parseBashCommand` the alias renderers use. These are set at invocation
   *      time and so win over both layers above — and they are precisely the case a
   *      host-side `process.env` check alone would MISS, because the variable never
   *      exists in this process at all.
   *
   * WHAT IT DELIBERATELY DOES NOT CHECK. Remote Control also requires a
   * Pro/Max/Team/Enterprise plan authenticated via OAuth rather than an API key,
   * and on Team/Enterprise an organization-level toggle. NONE of that is
   * host-observable — there is no local artifact this process could read that would
   * answer it truthfully — so no probe is attempted. Guessing would produce exactly
   * the warning-nobody-can-act-on that `isOnWindowsPath`'s fail-open comment
   * argues against. That gating is documented in
   * `ghola.remoteControlSessionName`'s `markdownDescription` instead — now the only
   * Remote Control setting there is — so a feature that silently does not come up
   * is at least explained on the one control the operator still has.
   */
  private checkRemoteControlGating(
    cliCommand: string,
    cfg: vscode.WorkspaceConfiguration,
  ): string[] {
    try {
      const platform = os.platform();
      const platformKey = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'osx' : 'linux';

      // Merged view: value `null` means "explicitly deleted for the terminal".
      // `source` names WHERE the variable came from and `remedy` says how to undo
      // it THERE — three layers need three different instructions, and a remedy
      // aimed at the wrong layer is a remedy that cannot work.
      const merged = new Map<string, { value: string | null; source: string; remedy: string }>();
      for (const [name, value] of Object.entries(process.env)) {
        if (typeof value === 'string') {
          merged.set(name, {
            value,
            source: 'the environment VS Code was started in',
            remedy: `Unset it where it is exported (a shell rc file, or your desktop session), or add "${name}": null to terminal.integrated.env.${platformKey} to drop it for terminals only`,
          });
        }
      }
      const terminalEnv =
        vscode.workspace
          .getConfiguration('terminal.integrated')
          .get<Record<string, string | null>>(`env.${platformKey}`) ?? {};
      for (const [name, value] of Object.entries(terminalEnv)) {
        merged.set(name, {
          value: typeof value === 'string' ? value : null,
          source: `terminal.integrated.env.${platformKey}`,
          remedy: `Remove that entry from terminal.integrated.env.${platformKey}, or set its value to null`,
        });
      }
      const aliases = cfg.get<CliAlias[]>('cliAliases', []);
      const registered = aliases.find((entry) => entry?.alias === cliCommand);
      const parsed = registered ? parseBashCommand(registered.command) : null;
      for (const { name, value } of parsed?.envVars ?? []) {
        merged.set(name, {
          value,
          source: `the "${cliCommand}" entry in Ghola's CLI Aliases`,
          remedy: `Delete the ${name}= prefix from that alias's command in Ghola's CLI Aliases and press Save`,
        });
      }

      const problems: string[] = [];
      for (const name of REMOTE_CONTROL_BLOCKING_ENV_VARS) {
        const hit = merged.get(name);
        // Fail open on anything not unambiguously set: absent, deleted by a null in
        // terminal.integrated.env, or present but empty.
        if (!hit || hit.value === null || hit.value.trim() === '') continue;
        problems.push(
          `Remote Control is disabled whenever ${name} is set, and it is set in ${hit.source}. This session still launched with --remote-control (the flag is accepted either way), but you will not be able to steer it remotely while ${name} is set. ${hit.remedy}, then relaunch.`,
        );
      }

      const baseUrl = merged.get('ANTHROPIC_BASE_URL');
      if (baseUrl && baseUrl.value !== null && baseUrl.value.trim() !== '') {
        const host = this.readUrlHost(baseUrl.value.trim());
        // `null` = the host was never determined (an unexpanded `$VAR`, or a value
        // that is not a URL at all). Fail open: a warning about a host this process
        // never resolved is a warning the operator cannot act on. Only the NAME of
        // the host is ever reported, never the URL, so a credential embedded in it
        // cannot leak into a notification or the output channel.
        if (host !== null && host !== 'anthropic.com' && !host.endsWith('.anthropic.com')) {
          problems.push(
            `Remote Control requires a first-party Anthropic endpoint, and ANTHROPIC_BASE_URL in ${baseUrl.source} points at ${host}. This session still launched with --remote-control (the flag is accepted either way), but you will not be able to steer it remotely until ANTHROPIC_BASE_URL is Anthropic's own endpoint or gone entirely. ${baseUrl.remedy}, then relaunch.`,
          );
        }
      }
      return problems;
    } catch (err) {
      this.logger?.appendLine(
        `[session] Remote Control pre-flight: skipped (${(err as Error).message})`,
      );
      return [];
    }
  }

  /**
   * Lowercased hostname of `value`, or `null` when it cannot be determined —
   * which is the signal the caller uses to stay silent. A value holding `$` or a
   * backtick is a shell expansion this process cannot resolve (`$MY_PROXY/v1`
   * parses as a perfectly valid but entirely fictional URL), so it is refused
   * before `URL` gets a chance to answer confidently about nothing.
   */
  private readUrlHost(value: string): string | null {
    if (value.includes('$') || value.includes('`')) return null;
    try {
      return new URL(value).hostname.toLowerCase();
    } catch {
      return null;
    }
  }
}
