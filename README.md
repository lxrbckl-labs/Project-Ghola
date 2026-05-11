# Nomeda

Modular multi-agent dev team for VS Code.

## Status

v0.2.x — modular architecture. Wired surfaces: extension activation, settings webview (General / Modules / Agents: TPM / SWE / QA), module loader with manifest validation, prompt composer (Session Manifest shape), session terminal launcher.

`Nomeda: Open Session` opens a PowerShell terminal and sends the configured `nomeda.sessionCommand` automatically on launch.

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
- Run `Nomeda: Open Session` to open a PowerShell terminal in the editor area with a session banner.
- Run `Nomeda: Reload Modules` to re-discover modules from the configured directory.

## Modules

By default Nomeda looks for modules under `<workspaceFolder>/modules/`. The path is configurable via `nomeda.modulesDir`.

Five modules ship in this repo: `core.preamble`, `core.tpm`, `core.swe`, `core.qa` (all enabled by default), and `tool.fastpath-check` (opt-in). Cores are enabled out of the box; `tool.fastpath-check` can be toggled on in the Modules tab.

## Architecture

- `src/manifest/` — module manifest types, JSON Schema, Ajv validator.
- `src/modules/` — discovery, enable/disable state, handles.
- `src/prompts/composer.ts` — composes the system prompt for an agent target from enabled modules.
- `src/settings-panel/` — webview host and webview UI.
- `src/session/launcher.ts` — opens a terminal in the editor area with a session banner.
