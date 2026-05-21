# Project-Nomeda — Claude Code Context

## Canonical working tree

`/home/aarbuckle/projects/Project-Nomeda` is the **only** copy of this repo.
`/mnt/c/Users/aarbuckle/Project-Nomeda` was a frozen safety net that has been **deleted**.
If your `cwd` is anywhere under `/mnt/c/`, stop immediately and ask the user to
re-launch from `~/projects/Project-Nomeda`.

## Architecture — read-on-demand module contract

The composer emits `[core] + [preamble] + [Session Manifest]` per agent.
The Session Manifest lists enabled modules with `id`, `contentPath`, and
`parameters`. Agents **read module `.md` files on demand** via the Read tool
when a task hits a module's domain. Module content is **not** inlined at
compose time.

**Final five modules (post-pivot):**
- `core.preamble` — structural preamble (hardcoded in composer, not a fragment contribution)
- `core.tpm` — TPM role + universal hard rules
- `core.swe` — SWE role + universal hard rules + inlined workflow modes
- `core.qa` — QA role + universal hard rules
- `tool.fastpath-check` — proactive WSL fast-path detection (opt-in, `proactive: true`)

Cores (`core.preamble`, `core.tpm`, `core.swe`, `core.qa`) are **enabled by default**.
`tool.fastpath-check` is **opt-in** — users toggle it on in the Modules tab.

Retired modules (do not recreate): `reference.hello-nomeda`, `tool.wsl-migrate`,
`mode.preview`, `mode.edge-case-hunt`, `mode.review`, `mode.planning`.

## Build and dev workflow

- **Build:** `npm run build` (esbuild, ~150ms on WSL filesystem)
- **Dev:** `npm run dev` — runs esbuild watcher concurrently; press F5 in VS Code
  to launch the Extension Development Host
- **F5 preLaunchTask:** `"npm: build"` — defined in `.vscode/tasks.json`
- **tasks.json** invokes builds via `wsl npm run build` / `wsl npm run watch` so
  WSL's Linux esbuild binary is used (Windows-side VS Code preLaunch otherwise
  fails on missing `@esbuild/win32-x64`)
- **Fast iteration:** `Ctrl+R` inside the dev host reloads the extension after a
  rebuild; `Nomeda: Reload Modules` re-discovers modules without a full reload

## Hard rules for future Claude sessions in this repo

1. No destructive git (commit/push/add/checkout/branch/merge/reset/stash).
   Read-only git is fine.
2. No `rm` — report files that should be deleted to the user (TPM) instead.
3. No modifications to `package.json`, `tsconfig.json`, `esbuild.config.js`,
   `tasks.json`, or `launch.json` without explicit user approval.
4. Module work uses the Session Manifest read-on-demand contract above — do not
   inline module content into composed prompts.
5. `PromptFragment.section` and `order` fields are **retired** — do not add them
   to manifests or types.
6. Orphaned files `src/state/watcher.ts` and `src/status-bar.ts` are pending
   user deletion; do not modify or re-wire them.
7. Use ASCII quotes (`'` and `"`) in TypeScript / JavaScript source — never smart quotes (U+2018, U+2019, U+201C, U+201D); smart quotes break esbuild parsing. Run `bash scripts/check-smart-quotes.sh` to verify.
