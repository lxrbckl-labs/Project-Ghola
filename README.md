# Nomeda

Modular multi-agent dev team for VS Code.

## Status

v0.0.1 — foundation scaffold. Wired surfaces: extension activation, settings webview (General / Modules / Agents / Sessions), module loader with manifest validation, prompt composer, status bar, agent state watcher, session terminal launcher. The reference module `hello-nomeda` exercises every contribution point.

No agent CLI is invoked yet; `Nomeda: Open Session` opens a PowerShell terminal with a boot banner so the user can launch their CLI manually.

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

By default Nomeda looks for modules under `<workspaceFolder>/.nomeda/modules/`. The path is configurable via `nomeda.modulesDir`.

A reference module lives at `modules/hello-nomeda/` in this repo. To exercise it inside the dev host, copy or symlink that folder into your test workspace's `.nomeda/modules/` directory and reload.

## Architecture

- `src/manifest/` — module manifest types, JSON Schema, Ajv validator.
- `src/modules/` — discovery, enable/disable state, handles.
- `src/prompts/composer.ts` — composes the system prompt for an agent target from enabled modules.
- `src/state/watcher.ts` — read-only file watcher for `.nomeda/state.json` agent heartbeats.
- `src/settings-panel/` — webview host and webview UI.
- `src/session/launcher.ts` — opens a terminal in the editor area with a session banner.
