# Nomeda

Modular multi-agent dev team for VS Code.

## Status

Active development — modular architecture. Wired surfaces: extension activation, settings webview (General / Modules / Agents: TPM / SWE / QA), module loader with manifest validation, prompt composer (Session Manifest shape), session terminal launcher.

`Nomeda: Open Session` opens a terminal (bash on WSL/non-Windows hosts, PowerShell fallback on Windows), cd's into the WSL fast-path directory when `tool.fastpath-check` is enabled, and sends `nomeda.sessionCommand` automatically on launch.

## Build

Requires Node 20+ and npm.

```
npm install
npm run build
```

The build emits `dist/extension.js` (Node CJS, extension host) and `dist/webview.js` (browser IIFE, settings panel).

## Dev loop

Run `npm install` once to install dependencies including the `concurrently` dev tool. Then run `npm run dev` to start the esbuild file watcher in the background; it prints a reminder to press F5 in VS Code to launch the Extension Development Host. After the host opens, use `Ctrl+R` inside the host window to reload the extension after a rebuild. For the fastest iteration on module content (manifests, prompt fragments) without a full reload, run `Nomeda: Reload Modules` from the command palette.

## Run

Open this folder in VS Code and press F5 to launch the Extension Development Host. In the dev host:

- Run `Nomeda: Open Settings` to open the settings webview.
- Run `Nomeda: Open Session` to open a terminal (bash on WSL, PowerShell on Windows) in the editor area with a session banner.
- Run `Nomeda: Reload Modules` to re-discover modules from the configured directory.

## Modules

By default Nomeda looks for modules under `<workspaceFolder>/modules/`. The path is configurable via `nomeda.modulesDir`.

Four core prompt files live in `prompts/cores/` (preamble, TPM, SWE, QA) — these define agent roles and universal hard rules, are always active, and are not toggleable. A library of toggleable modules lives in `modules/` (see that directory for the full list); modules are managed via the Modules tab and contribute prompt fragments, settings, and optional proactive session-start behavior. Most tool modules default to enabled; integrations, alternate session modes, and select tools are opt-in.

## Session flow

When the user clicks **Nomeda: Open Session** (the play button), the following pipeline runs:

1. **Compose.** The prompt composer walks every enabled module and builds the TPM prompt: core files from `prompts/cores/` first, then a Session Manifest block listing each enabled module's `id`, `contentPath`, and `parameters` (setting values from the Modules tab, substituted at compose time). Proactive modules are annotated `[proactive — consult at session start]` in the manifest. Disabled modules are omitted entirely — the agent never sees them.

2. **Write.** The composed prompt is written to a deterministic temp file. Its path is exported as `$NOMEDA_TPM_PROMPT_FILE` in the terminal environment so the CLI can read it. SWE and QA prompts are composed the same way and available for subagent dispatch.

3. **Launch.** A terminal opens (bash on WSL, PowerShell on Windows), cd'd into the WSL fast-path directory when `tool.fastpath-check` is enabled. The configured CLI command (default: `claude`) starts, and after a short delay the configured session command (default: `initiate`) is sent as user input.

4. **Boot.** The CLI reads `$NOMEDA_TPM_PROMPT_FILE`, adopts the TPM role, and executes its startup sequence — consulting proactive modules, resolving session context, and greeting the user.

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
