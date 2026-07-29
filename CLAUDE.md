# Project-Ghola — Claude Code Context

## Canonical working tree

`/home/aarbuckle/projects/Project-Ghola` is the **only** copy of this repo.
`/mnt/c/Users/aarbuckle/Project-Ghola` was a frozen safety net that has been **deleted**.
If your `cwd` is anywhere under `/mnt/c/`, stop immediately and ask the user to
re-launch from `~/projects/Project-Ghola`.

## Architecture — read-on-demand module contract

The composer emits `[core] + [preamble] + [Session Manifest]` per agent.
The Session Manifest lists enabled modules with `id`, `contentPath`, and
`parameters`. Agents **read module `.md` files on demand** via the Read tool
when a task hits a module's domain. Module content is **not** inlined at
compose time.

**Two-layer prompt architecture:**
- **Cores** (`prompts/cores/`): `preamble.md`, `tpm.md`, `swe.md`, `qa.md` — hardcoded in the composer, always present, cannot be toggled.
- **Modules** (`modules/`): toggleable in the Modules tab. Includes `tool.*`, `mode.*`, and `integration.*` namespaces. See `modules/` for the full set.

Retired modules (do not recreate): `reference.hello-ghola`, `tool.wsl-migrate`,
`mode.preview`, `mode.edge-case-hunt`, `mode.review`, `mode.planning`,
`tool.untrusted-jira`, `tool.clipboard-image`.

## Build and dev workflow

- **Build:** `npm run build` (esbuild, ~150ms on WSL filesystem)
- **Dev:** `npm run dev` — runs esbuild watcher concurrently; press F5 in VS Code
  to launch the Extension Development Host
- **F5 preLaunchTask:** `"npm: build"` — defined in `.vscode/tasks.json`
- **tasks.json** runs `npm run build` / `npm run watch` as shell commands with
  `cwd: ${workspaceFolder}` — no `wsl` prefix needed (project runs in Remote-WSL)
- **Fast iteration:** `Ctrl+R` inside the dev host reloads the extension after a
  rebuild; `Ghola: Reload Modules` re-discovers modules without a full reload

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
6. Use ASCII quotes (`'` and `"`) in TypeScript / JavaScript source — never smart quotes (U+2018, U+2019, U+201C, U+201D); smart quotes break esbuild parsing. Verify with: `grep -rPn '[\x{2018}\x{2019}\x{201C}\x{201D}]' --include="*.ts" --include="*.json" src/ modules/`
7. Shell scripts here run under `set -euo pipefail`. Do NOT pipe a producer into
   an early-exiting consumer (`grep -q`, `head`, etc.): the consumer exits on
   the first match, the producer receives SIGPIPE (exit 141), and `pipefail`
   promotes that to a spurious pipeline failure. Capture the producer's output
   first (`out="$(cmd)"; grep -q ... <<<"$out"`) or use a full-reading consumer
   (`grep -c`). This caused a false "bad build" error in `scripts/reinstall.sh`'s
   VSIX verifier (fixed in v0.18.4).
