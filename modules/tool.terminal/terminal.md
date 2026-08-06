# Terminal Dispatch

When this module is loaded, agents can create, command, and read output from VS Code terminal instances. The extension manages terminal lifecycle via VS Code's Terminal API; agents interact through bridge routes. This enables cross-shell workflows (bash for WSL, PowerShell for Windows-side operations), human-in-the-loop commands (authentication prompts, interactive tools), and long-running background processes -- all without leaving the session. Every agent reads this same fragment; role-specific framing is collected at the end.

## Concepts

### Terminal Lifecycle

- **Create**: agent requests a named terminal with a specific shell type. The extension calls `vscode.window.createTerminal()` with the requested shell. The terminal is visible in VS Code's terminal panel.
- **Execute**: agent sends a command string. The extension uses Shell Integration (`terminal.shellIntegration.executeCommand()`) when available, falling back to `terminal.sendText()` + file-based output capture. The agent blocks until the command completes or times out.
- **Read**: on command completion, the bridge returns stdout, stderr (when capturable), exit code, and elapsed time.
- **Dispose**: agent explicitly disposes a terminal, or terminals auto-dispose on session end when `parameters.autoDisposeOnSessionEnd` is true.

### Human-in-the-Loop

The defining feature. When a command requires human intervention (interactive login, MFA prompt, manual confirmation, debugging in a live shell):

1. Agent sends the command with `waitForHuman: true`.
2. The extension sends the command to the terminal and shows a notification: "Terminal `<name>` is waiting for you."
3. The user works in the terminal -- types, responds to prompts, runs additional commands.
4. When done, the user signals completion: clicks "Done" in a status-bar button, or the extension detects the shell returned to the prompt via Shell Integration.
5. The bridge returns the combined output to the agent.

Timeout: `parameters.humanInterventionTimeoutMs` (default 5 minutes). On timeout, the bridge returns what it has with a `timedOut: true` flag -- the agent can decide to wait longer or proceed.

### Output Capture

Three tiers, best available:

1. **Shell Integration** (preferred): VS Code's Shell Integration API provides structured command output with exit codes. Works with bash, zsh, PowerShell, fish when shell integration is active.
2. **Script wrapper**: The extension wraps the command in a script that redirects output to a temp file and captures the exit code. More reliable than raw sendText but adds a small wrapper overhead.
3. **Raw sendText** (fallback): Fire-and-forget. The extension sends the command text and uses `onDidWriteTerminalData` to capture raw terminal output including ANSI escapes. Exit code may not be available. Used when shell integration is inactive and script wrapping is impractical.

The bridge response always reports which tier was used so the agent knows the reliability of the output.

## Bridge Routes

All routes are accessed through the Ghola bridge (the same loopback HTTP bridge that serves `/get-ticket`, `/find-pr`, etc.). The terminal routes are:

### `POST /terminal/create`

Create a new terminal instance.

- Body: `{ name: string, shell?: string, cwd?: string, env?: Record<string, string> }`
- `name` is required and must be unique among active terminals.
- `shell` defaults to `parameters.defaultShell`. Must be in the enabled set of `parameters.allowedShells`.
- `cwd` defaults to the workspace root.
- `env` merges with the terminal's inherited environment (agent-provided values win on conflict). Same secret-suppression rules as everywhere: never pass token/key/password values through `env`.
- Response: `{ status: "ok", terminalId: string }` or `{ status: "error", message: string }`.
- Refuses when `parameters.maxConcurrentTerminals` would be exceeded.

### `POST /terminal/exec`

Execute a command in an existing terminal.

- Body: `{ terminalId: string, command: string, waitForHuman?: boolean, timeoutMs?: number }`
- `waitForHuman` defaults to false. When true, uses the human-intervention flow.
- `timeoutMs` overrides `parameters.commandTimeoutMs` for this call.
- Response: `{ status: "ok", output: string, exitCode?: number, timedOut: boolean, captureTier: "shell-integration" | "script-wrapper" | "raw", elapsedMs: number }` or `{ status: "error", message: string }`.
- The bridge blocks until the command completes, the human signals done, or timeout.

### `GET /terminal/list`

List active terminals.

- Response: `{ terminals: Array<{ terminalId: string, name: string, shell: string, state: "idle" | "busy" | "waiting-for-human" }> }`.

### `POST /terminal/dispose`

Dispose a terminal.

- Body: `{ terminalId: string }`
- Response: `{ status: "ok" }` or `{ status: "error", message: string }`.
- Disposing a busy terminal cancels the pending exec (returns `{ status: "cancelled" }` to the waiting caller).

### `POST /terminal/signal`

Signal a waiting terminal (the programmatic equivalent of clicking "Done").

- Body: `{ terminalId: string }`
- Only meaningful when the terminal is in `waiting-for-human` state.

## Configurable: allowedShells

`parameters.allowedShells` is a key-value map controlling which shells agents may create. Per the preamble's parameter-allowlist rule, the enabled shells are the ONLY shells an agent may request. A request for a disabled or unlisted shell is refused with a message naming the setting.

Default enabled: `bash`, `powershell`, `pwsh`. Additional shells (`zsh`, `cmd`, `fish`) can be added by the operator in the Modules tab.

## Configurable: maxConcurrentTerminals

`parameters.maxConcurrentTerminals` (default 3, range 1-8) caps how many terminals can exist simultaneously. The cap prevents terminal sprawl -- agents that forget to dispose create resource pressure. When the cap is reached, `/terminal/create` returns an error naming the cap and suggesting disposal of an idle terminal.

## Configurable: commandTimeoutMs

`parameters.commandTimeoutMs` (default 120000 = 2 minutes) is the default timeout for non-human-intervention commands. A per-call `timeoutMs` in the exec body overrides it. Minimum 5 seconds, maximum 10 minutes.

## Configurable: humanInterventionTimeoutMs

`parameters.humanInterventionTimeoutMs` (default 300000 = 5 minutes) is the timeout for human-in-the-loop commands. Longer than `commandTimeoutMs` because humans need time to read, think, and type. Minimum 30 seconds, maximum 15 minutes.

## Hard Rules

1. **Never send credentials through terminal commands.** The same rule as everywhere: never echo tokens, passwords, API keys, or secrets. If a command needs authentication, use `waitForHuman: true` and let the operator type the credentials themselves.
2. **Terminal names must be descriptive.** Name terminals by purpose (`build-check`, `wsl-deploy`, `auth-flow`), not by number. The operator sees these names in VS Code's terminal panel.
3. **Dispose when done.** A terminal outliving its purpose wastes a slot against `maxConcurrentTerminals`. Dispose terminals when their task is complete -- do not leave them idle.
4. **Respect the allowlist.** Only request shells enabled in `parameters.allowedShells`. Never substitute, never default around a disabled shell.
5. **Human-intervention commands are BLOCKING.** When `waitForHuman: true`, the agent WAITS for the human to finish. Do not spawn additional terminals to work around a blocked one -- that defeats the purpose of human-in-the-loop.
6. **Audit trail.** Every command sent through a terminal is visible in the terminal panel. The operator can scroll back and see exactly what was run. Never rely on terminal commands being invisible.

## Cross-Platform Notes

- **WSL from Windows**: When the VS Code host is Windows but the work needs to happen in WSL, create a bash terminal -- VS Code's terminal will use the default WSL distro's bash. Alternatively, prefix commands with `wsl` in a PowerShell terminal.
- **PowerShell versions**: `powershell` is Windows PowerShell 5.x (Windows-only). `pwsh` is PowerShell Core 7.x (cross-platform). Prefer `pwsh` when available for consistency.
- **Shell Integration availability**: Shell Integration is automatic for bash, zsh, fish, and PowerShell in VS Code. It requires no configuration from the operator. `cmd.exe` does NOT support Shell Integration -- commands in cmd terminals always use the script-wrapper or raw fallback.
- **Path forms**: Commands in a bash terminal use Unix paths (`/home/...`). Commands in a PowerShell terminal use Windows paths (`C:\...`). The agent must use the right form for the terminal's shell.

## Use Cases

Examples of what this module enables (not an exhaustive list -- agents apply judgment):

- **Interactive authentication**: `gcloud auth login`, `az login`, `docker login` -- all require browser/MFA flow the agent cannot automate.
- **Build verification on a different platform**: Run `npm run build` in a bash terminal for WSL and `dotnet build` in a PowerShell terminal for Windows, in parallel.
- **Database CLI**: Open a `sqlcmd` or `psql` session where the operator can run exploratory queries while the agent watches the output.
- **Long-running processes**: Start a dev server in one terminal, run tests against it from another.
- **Deployment scripts**: Run deployment commands where the operator needs to approve each step.

## Module-disabled vs feature-disabled

- **Module disabled** (no `tool.terminal` in the Session Manifest): agents have NO terminal dispatch capability. They use the Bash tool from the Claude Code harness for shell commands, which is single-session and non-interactive.
- **Module enabled, all shells disabled in allowedShells**: agents cannot create any terminal (every shell request is refused). Functionally equivalent to module-disabled but the framework is loaded.
- **Module enabled, some shells disabled**: agents can only create terminals with enabled shells. A request for a disabled shell is refused with a message naming the setting and the disabled shell.

Do not merge these cases.

## Role-Specific Notes

The body above applies identically to every agent. The notes below are short framings for how each role uses the policy.

### TPM

You are the dispatcher. When a task needs terminal interaction -- a build on a different platform, an interactive login, a long-running process to monitor -- decide whether a terminal is warranted (vs the simpler Bash tool which handles most shell commands fine). Create terminals with descriptive names. For human-in-the-loop flows, brief the operator on what the terminal will ask for BEFORE sending the command -- do not surprise them with a login prompt. Dispose terminals when their task returns. Track active terminals against the `maxConcurrentTerminals` cap when planning parallel work.

### SWE

You use terminals when TPM's assignment calls for it, or when a task genuinely needs a persistent or interactive shell that the Bash tool cannot provide. Common cases: running a build in a specific shell environment, executing a command that requires human authentication first, or working in a terminal the operator is also using. Always dispose terminals you created before returning to TPM unless TPM's assignment says to leave them running. Report the terminal name and shell type in your return alongside any command output.

### QA

Terminals are available for verification work -- running builds, executing test suites, checking that a command produces the expected output in a specific shell environment. Same discipline: dispose when done, report terminal interactions in your verdict. If a SWE left a terminal running that should have been disposed, flag it.
