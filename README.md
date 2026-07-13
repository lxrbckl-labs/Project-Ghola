# Ghola

Modular multi-agent dev team for VS Code.

## Installation

Prereqs: Node 20+ and npm, VS Code. Under Remote-WSL the extension installs on the WSL side — run these commands from your WSL shell.

```
git clone https://github.com/lxRbckl/Project-Ghola.git
cd Project-Ghola
npm ci
npm run install-local
```

`npm run install-local` builds the extension, packages a `ghola.vsix`, and installs it globally with `--force`. This installs Ghola **once** for your whole editor — it then works in **every** repo you open. You do not install it per-repo, and the bundled modules travel inside the extension.

If the `code` CLI is not on your PATH, run `npm run package` to produce `ghola.vsix`, then install it from the Extensions panel: click the "..." menu -> "Install from VSIX..." and select the generated file. To put `code` on your PATH under Remote-WSL, open the command palette in VS Code and run **Shell Command: Install 'code' command in PATH**.

After installing, reload VS Code (`Ctrl+Shift+P` -> "Developer: Reload Window"). Then run **Ghola: Open Settings** from the command palette to open the panel — the **Session** tab has the Play button (Open Session) and the **Update Extension** button next to it. The extension is `local.ghola`; modules are bundled into the VSIX, so it works in any repo you open.

**Note:** If you plan to use the in-app **Update Extension** button, set the `ghola.repoPath` setting to the absolute path of your `Project-Ghola` clone (VS Code Settings -> search "ghola.repoPath"). This is required when running an installed VSIX — the extension cannot infer the repo location on its own. Set it in **User** settings (not workspace settings) so it applies in every repo and is not accidentally committed as a machine-specific path. See [In-app update](#in-app-update-easy-path) for full details.

## Updating

### In-app update (easy path)

Open the Settings Panel, go to the **Session** tab, and click **Update Extension**. You can also run `Ghola: Update Extension` from the command palette. This runs `scripts/reinstall.sh`, which fetches the upstream remote, compares the installed version against the remote `package.json`, skips if already up to date, otherwise `git pull --ff-only`, rebuilds, repackages, and reinstalls — then offers to reload the window.

Prerequisites for in-app update:

- The repo was cloned and `npm ci` was run (Node 20+ and npm required).
- The `code` CLI is on your PATH.
- A git upstream is configured.
- **`ghola.repoPath` setting** — set this to the absolute path of your `Project-Ghola` clone. This is required when running an installed VSIX (the extension cannot infer the repo location). If the setting is empty and the extension is running directly from the dev checkout, it falls back to detecting the extension's own directory.

### Manual update (fallback)

Pull the latest source and re-run the local install:

```
git pull
npm run install-local
```

### How updates propagate

There is no marketplace. A `git push` updates the source repository only — it does not touch anyone's already-installed extension. Agent instructions (the `prompts/cores/*.md` and module `.md` files) are snapshotted into the VSIX at package time and read from the installed copy at session-compose time. To receive instruction or code changes, use the in-app **Update Extension** button or run `git pull` then `npm run install-local` manually. Updates are detected by version number — maintainers must bump `version` in `package.json` on meaningful changes for the in-app updater (and users) to see that a newer build is available.

## Troubleshooting

- **`code` not found.** The `install-local` and update scripts use the `code` CLI to install the VSIX. If it is missing, install it via **Shell Command: Install 'code' command in PATH** (see Installation), or use the `npm run package` + Install-from-VSIX fallback.
- **Extension installs but never activates ("stuck on loading").** On a corporate or proxied network, watch the `npm ci` output for esbuild / native-binary download failures: a partial install leaves the build with no compiled output, so the packaged `.vsix` has no entry point. Re-run the install on a working network so the build actually produces `dist/extension.js`.
- **`vsce` warnings during `npm run package`.** Packaging warnings (e.g. missing repository field) are non-fatal — the `ghola.vsix` still installs.
- **Update reports "already up to date" but you expected changes.** Updates are keyed on the `version` in `package.json`; a maintainer must bump it for the updater to act. See [How updates propagate](#how-updates-propagate).
- **In-app update fails to find the repo.** When running an installed VSIX, set `ghola.repoPath` to the absolute path of your clone (see [In-app update](#in-app-update-easy-path)).
- **Changes not visible after an update.** Reload the window (`Ctrl+Shift+P` -> "Developer: Reload Window") — the update prompt offers this for you on success.

## Status

Active development — modular architecture. Wired surfaces: extension activation, settings webview (General / Modules / Agents: TPM / SWE / QA), module loader with manifest validation, prompt composer (Session Manifest shape), session terminal launcher.

`Ghola: Open Session` opens a terminal (bash on WSL/non-Windows hosts, PowerShell fallback on Windows), cd's into the WSL fast-path directory when `tool.fastpath-check` is enabled, and sends `ghola.sessionCommand` automatically on launch.

## Build

Requires Node 20+ and npm.

```
npm install
npm run build
```

The build emits `dist/extension.js` (Node CJS, extension host) and `dist/webview.js` (browser IIFE, settings panel).

## Dev loop

Run `npm install` once to install dependencies including the `concurrently` dev tool. Then run `npm run dev` to start the esbuild file watcher in the background; it prints a reminder to press F5 in VS Code to launch the Extension Development Host. After the host opens, use `Ctrl+R` inside the host window to reload the extension after a rebuild. For the fastest iteration on module content (manifests, prompt fragments) without a full reload, run `Ghola: Reload Modules` from the command palette.

## Run

Open this folder in VS Code and press F5 to launch the Extension Development Host. In the dev host:

- Run `Ghola: Open Settings` to open the settings webview.
- Run `Ghola: Open Session` to open a terminal (bash on WSL, PowerShell on Windows) in the editor area with a session banner.
- Run `Ghola: Reload Modules` to re-discover modules from the configured directory.

## Modules

By default Ghola loads its modules from the installed extension itself — they are bundled into the VSIX and are available in any repo you open. The `ghola.modulesDir` setting is an optional override: set it to an absolute path, or a path relative to the workspace root, to load modules from a custom directory instead.

Four core prompt files live in `prompts/cores/` (preamble, TPM, SWE, QA) — these define agent roles and universal hard rules, are always active, and are not toggleable. A library of toggleable modules lives in `modules/` (see that directory for the full list); modules are managed via the Modules tab and contribute prompt fragments, settings, and optional proactive session-start behavior. Most tool modules default to enabled; integrations, alternate session modes, and select tools are opt-in.

## Session flow

When the user clicks **Ghola: Open Session** (the play button), the following pipeline runs:

1. **Compose.** The prompt composer walks every enabled module and builds the TPM prompt: core files from `prompts/cores/` first, then a Session Manifest block listing each enabled module's `id`, `contentPath`, and `parameters` (setting values from the Modules tab, substituted at compose time). Proactive modules are annotated `[proactive — consult at session start]` in the manifest. Disabled modules are omitted entirely — the agent never sees them.

2. **Write.** The composed prompt is written to a deterministic temp file. Its path is exported as `$GHOLA_TPM_PROMPT_FILE` in the terminal environment so the CLI can read it. SWE and QA prompts are composed the same way and available for subagent dispatch.

3. **Launch.** A terminal opens (bash on WSL, PowerShell on Windows), cd'd into the WSL fast-path directory when `tool.fastpath-check` is enabled. The configured CLI command (default: `claude`) starts, and after a short delay the configured session command (default: `initiate`) is sent as user input.

4. **Boot.** The CLI reads `$GHOLA_TPM_PROMPT_FILE`, adopts the TPM role, and executes its startup sequence — consulting proactive modules, resolving session context, and greeting the user.

5. **On-demand reading.** The agent now has the Session Manifest but not the module content itself. When a task hits a module's domain, the agent reads the module's `.md` file from `modules/` via the Read tool. This keeps the initial prompt compact while giving the agent access to the full module library as needed.

The Modules tab is effectively the brain editor: toggling a module on adds it to the Session Manifest; toggling it off removes it. Settings changes flow into the `parameters` block at compose time. The next session always reflects the current panel state.

## Architecture

- `prompts/cores/` — hardcoded core prompts (preamble, TPM, SWE, QA): agent roles, universal hard rules, and the structural meta-prompt; always active.
- `src/manifest/` — module manifest types, JSON Schema, Ajv validator.
- `src/modules/` — discovery, enable/disable state, handles.
- `src/prompts/composer.ts` — composes the system prompt for an agent target from enabled modules.
- `src/settings-panel/` — webview host and webview UI.
- `src/session/launcher.ts` — opens a terminal in the editor area with a session banner.
- `src/session/prompt-file.ts` — writes the composed prompt to a temp file and exposes its path to the session environment.
