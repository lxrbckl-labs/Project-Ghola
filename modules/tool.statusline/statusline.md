# Statusline

**Status: live.** The Ghola statusline is the **Claude Code harness statusline** — the single line the harness renders at the bottom of the session, driven by the `statusLine.command` entry in `~/.claude/settings.json`. It is **not** a VS Code status-bar pill and is not produced by extension code in `src/`.

Two renderers exist and they have a **byte-identical output contract**:

- **`scripts/ghola-statusline.mjs`** — the current renderer. Node, built-ins only. Works on **both** supported hosts (WSL and native Windows). This is what a `statusLine.command` should point at.
- **`scripts/ghola-statusline.sh`** — the original. bash + `python3`, therefore **WSL-only** in practice. Retained unchanged for back-compat; nothing needs to migrate off it on WSL.

On each refresh the harness runs the configured renderer, passing its JSON payload on stdin; the renderer reads the Ghola `VERSION` file (resolved relative to the renderer's own location, so it works regardless of cwd) and prints one line to stdout with no trailing newline.

## What the statusline shows

The output is a single bracketed label:

```
[Ghola vX.Y.Z │ 142k · 62% · 5h 41%]
```

- **Version** — always present. Read from the `VERSION` file beside the renderer, e.g. `v0.25.0`. If `VERSION` is unreadable it falls back to `vunknown`.
- **Cumulative tokens** — a compact figure such as `142k`, the sum of `context_window.total_input_tokens` + `total_output_tokens` from the payload. Appears only when both fields are present.
- **Context percent** — e.g. `62%`, from `context_window.used_percentage`. Appears only when that field is present. Renders red at or above 85%.
- **Rolling window percent** — e.g. `5h 41%`, from `rate_limits.five_hour.used_percentage`. Appears only when that field is present. Renders red at or above 85%.

Each segment is gated independently on its own source field — any one can appear without the others. Segments are joined with ` · ` (U+00B7); the ` │ ` (U+2502) separator between the version and the metrics appears only when at least one metric segment is present. Red is the ONLY color emitted (`\033[31m`, reset with `\033[0m`); any other tint on the row is the terminal's own styling of a custom statusline, not ours.

## Failure behavior

Neither renderer ever fails and neither ever prints error text. `VERSION` is read defensively, stdin is captured once, and all JSON parsing is wrapped. On any error the output degrades to `[Ghola vX.Y.Z]`, or `[Ghola vunknown]` if the version itself could not be read, and the exit code is always 0. There is no path on which the harness sees a crash, a stack trace, or a partial line.

## How it is wired

The renderer is staged to a **version-stable** location. On every activation the extension copies `scripts/ghola-statusline.mjs` and a `VERSION` stamp into:

```
<homedir>/.ghola/statusline/
```

That indirection matters: the installed extension directory is version-pinned (`local.ghola-0.25.0/...`), so a command pointing into it silently stops working at the next version bump — the tag just disappears from the footer with nothing to explain it. The staged path never changes, so the operator configures `statusLine.command` **once**. The staging is idempotent (it compares the stamp and the renderer bytes and does nothing when already current), never blocks or fails activation, and touches only those two files — `usage-state.json` and `ledger/` in the parent directory, and the `state/` subdirectory the renderers write, are never read or written by it.

`~/.claude/settings.json` on **WSL**:

```json
{ "statusLine": { "type": "command",
                  "command": "node /home/aarbuckle/.ghola/statusline/ghola-statusline.mjs" } }
```

`%USERPROFILE%\.claude\settings.json` on **native Windows** (forward slashes so no JSON backslash escaping is needed):

```json
{ "statusLine": { "type": "command",
                  "command": "node C:/Users/aarbuckle/.ghola/statusline/ghola-statusline.mjs" } }
```

Substitute the real home directory on each host. The `node <path>` form is used on both platforms deliberately: it works whether or not the file carries an exec bit, and a `.mjs` cannot be launched by shebang on win32 at all.

**Dependencies: `node` only.** The `.mjs` renderer needs no npm packages, no `bash`, no `python3`, and no `jq`. That is the whole reason it exists — on the operator's Windows host `bash.exe` is not on PATH (Git for Windows only puts `...\Git\cmd\` there, not `...\Git\bin\`) and `python3` resolves to the Microsoft Store alias stub rather than a real interpreter, so the legacy `.sh` renderer would fail there twice over even if its POSIX command path resolved. The legacy `.sh` still requires `bash` + `python3` and must be `chmod +x`; it is fine on WSL and unusable on win32.

The renderer resolves `VERSION` from its own directory: `<dir>/../VERSION` (the repo and installed-extension layout, where it sits in `scripts/`) and then `<dir>/VERSION` (the flat staged layout). A non-empty `GHOLA_DIR` environment variable overrides both and is used as the sole location.

## Side effect: two usage snapshots

On every render the renderer mirrors the numbers it just displayed into **two** files, both under `~/.ghola/`, never the work repo, and both written atomically (temp file then rename, with the renderer's PID in the temp name so concurrent renders cannot tear each other's write). Both writes happen on every render; neither is conditional on the other.

**1. `~/.ghola/usage-state.json` — unkeyed, for `tool.usage-observer`.** Written when the payload carries a token count or a 5-hour figure. This is a **cross-module contract**: both renderers write the same location, the same keys, and the same key order, so switching between them is invisible to that module. A payload with no usage signal writes nothing, so an empty render never clobbers a good snapshot. One path, shared by every session — which is exactly why it cannot serve the status bar (see below).

**2. `~/.ghola/statusline/state/<key>.json` — keyed per session, for the VS Code status bar.** Same shape and same key order as the unkeyed file:

```json
{"updated": 1785421479, "session_tokens": 299949, "context_pct": 30, "five_hour_pct": 11}
```

`updated` is epoch **seconds**. Every metric field is optional and gated on its own source value being present — `five_hour_pct` requires a Pro/Max `rate_limits` block and only appears after the first API response, and `context_pct` can be absent independently of `session_tokens`, so a reader must gate each metric separately rather than letting one missing field blank the segment. The write gate here is slightly **wider** than the unkeyed one: any single metric is enough, where the unkeyed write ignores a context percentage that arrives with no token count. A payload with no metric at all still writes nothing.

The keyed file exists because the unkeyed one **cannot be attributed to a window**. With 8+ concurrent sessions all writing one path, a status bar reading it would show whichever session rendered last, in every window, while looking authoritative. The key is per repository root, so each session gets its own file and the reader can only ever be right about the window it is running in.

### The key

`GHOLA_STATE_KEY`, when present and non-empty in the environment, **is the key, used verbatim** — no normalization, no folding, no hashing, and no git-root walk. `src/session/launcher.ts` exports it into every Ghola-launched session, computed from the VS Code workspace folder's git root. That is not belt-and-braces: the terminal can be opened in the WSL-native clone of a `/mnt/c/...` workspace, in which case the renderer's own walk would reach a *different* root than the workspace folder does and the two sides would key on two different paths. The env var makes writer and reader agree by construction.

Without it, the renderer derives the key from the payload's `workspace.project_dir`: walk up (inclusive) to the nearest ancestor holding a `.git` **entry** (existence, never `isDirectory` — it is a *file* in a worktree or submodule), falling back to the starting directory when there is none, then `<folded-path>-<sha256(normalized-path)[0:8]>`. An empty or whitespace-only `project_dir` produces **no key and no keyed write** rather than a walk that would resolve `.git` against the harness's cwd.

**`src/session/statusline-state.ts` is the normative spec** for all of it — every step, in order, with the reasoning. Do not restate the algorithm anywhere else and do not change a step in one place: it is implemented **three** times (that file, `ghola-statusline.mjs`, and the `python3` block in `ghola-statusline.sh`) and drift fails **silently**, because the writer writes one path while the reader reads another and the status-bar segment simply never appears.

**Staleness belongs to the reader, not the writer.** The renderers never gate on age; they write whenever they render. The reader treats a snapshot older than **90 seconds** (`STATE_STALE_AFTER_MS`) as stale. That threshold is deliberately not 30s: the harness re-renders on assistant messages rather than on a clock, so a single long agent run legitimately emits no writes for a minute or more, and a tighter threshold would blank the segment on a perfectly healthy session.

## Fixed behavior vs parameters

Neither renderer has **settings-file toggles**. Both always render whatever segments the payload provides, and the red threshold is fixed at 85%. The module's `parameters` (`showVersion`, `showCumulativeTokens`, `showContextPercent`, `showRollingWindowPercent`, `redThresholdPercent`, `fallbackToVersionOnly`) are **not read** by either renderer — they are forward-looking preferences that do not currently take effect. Today's behavior is: all-segments-always (each still gated on its data being present) and red-at-85. Changing what shows, or the threshold, is a renderer edit, not a settings change — and it must be made in **both** renderers to keep them byte-identical.

## What this module does NOT do

- **Installs nothing.** This module is **documentation only**. Enabling it does not create, modify, or remove the `statusLine` entry in `~/.claude/settings.json`, and disabling it does not turn the statusline off. That file is the operator's live harness config and no Ghola code writes it — the operator adds the line above by hand, once. (This has surprised us before: the reason the tag appears on WSL and not on Windows is simply that the WSL settings file has a `statusLine` key and the Windows one does not.) Renderer staging is likewise done by the extension on activation regardless of whether this module is enabled.
- Does **not** render a VS Code status-bar pill. The statusline is the harness line only. The separate `Ghola: <mode>` item in the VS Code status bar is `src/status-bar/mode-status-bar.ts`; it is a **reader** of the keyed state file described above, so the two surfaces share data and can show the same context and 5-hour figures, but nothing in this module draws that item and the renderers know nothing about it beyond the file they write.
- Does **not** track or compute tokens itself; it formats whatever the harness supplies on stdin.
- Does **not** talk to any external service, telemetry endpoint, or remote logger. All data is local to the active session's payload.

## Role-Specific Notes

The body above applies identically to every agent. The notes below frame how each role relates to the live statusline.

### TPM

The statusline is live. You can tell the user it is the harness line at the bottom of the session, rendered by `scripts/ghola-statusline.mjs` (the `.sh` is the WSL-only original, kept for back-compat), and describe its segments: version (always), cumulative tokens, context %, and 5-hour rolling-window % (each appearing when the harness payload provides it), with context % and 5h % turning red at 85% or above.

Two honesty points to keep straight:

- If the user wants to change what shows or the red threshold, that is a **renderer edit** — the module's `parameters` are not honored, so toggling them in the Modules tab changes nothing today.
- If the tag is **missing** on a host, the cause is almost always that the host's `~/.claude/settings.json` has no `statusLine` key. Ghola never writes that file; give the user the per-platform line from *How it is wired* to paste. Do not describe this module as something that installs or removes the statusline.

### SWE

There are two renderers and they must stay byte-identical: `scripts/ghola-statusline.mjs` (Node, cross-platform, the one operators point at) and `scripts/ghola-statusline.sh` (bash + `python3`, WSL-only, back-compat). A change to segments, formatting, or the red threshold is a direct edit to **both**, verified by piping the same payloads into each and diffing the bytes — including the empty, partial, and malformed-JSON payloads, not just the happy path.

Watch for the traps that make parity non-obvious: Python's `round()` is round-half-to-EVEN (`62.5` -> `62`) where `Math.round` is half-up, Python's `int()` truncates toward zero, and Python's `isinstance(x, int)` accepts `bool`. The `.mjs` mirrors all three deliberately. Preserve the never-fail contract on both (every error path degrades silently and exits 0), keep ASCII quotes in code, and leave the `│` / `·` output characters exactly as they are — those are content. `~/.ghola/usage-state.json` is a cross-module contract with `tool.usage-observer`: same path, same keys, same key order, atomic write.

The state-key algorithm makes it a **triplicate**, not a pair: the third copy is `src/session/statusline-state.ts`, which is the normative spec, and a change to any step must land in all three in the same commit. Its own traps are recorded there and are easy to get wrong from memory — ASCII-only case folding via an explicit `[A-Z]` class (never `toLowerCase()`/`.lower()`, which diverge on non-ASCII between the three languages), hashing the *normalized path* rather than the folded body (folding is lossy, so hashing the body would preserve the collision the hash exists to break), edge-hyphen trimming *after* truncation, and `.git` tested for existence rather than directory-ness. Note also that Python's `json.dump` defaults to `", "`/`": "` separators where `JSON.stringify` emits none, so the keyed write passes `separators=(",", ":")`; the unkeyed write does not and the two renderers' `usage-state.json` therefore differ by whitespace, which is harmless because every reader parses rather than compares.

### QA

There is a real rendered statusline to verify: pipe a sample harness payload into `scripts/ghola-statusline.mjs` and confirm the output line. A full payload should yield `[Ghola vX.Y.Z │ <tokens> · <ctx>% · 5h <n>%]`; empty stdin should yield `[Ghola vX.Y.Z]`. Confirm the red (`\033[31m`) coloring appears only at percentages >= 85, that the renderer exits 0 and prints no error text on malformed input, and that piping the identical payload into `scripts/ghola-statusline.sh` produces the same bytes.

Two cautions. First, both renderers write `~/.ghola/usage-state.json` **and** `~/.ghola/statusline/state/<key>.json` on any payload carrying a usage signal — override `HOME` to a scratch directory when running test payloads, or you will overwrite the operator's live snapshots. Second, staging is only exercised at extension activation, so verifying `<homedir>/.ghola/statusline/` requires an actual activation (a dev-host launch or a reinstall), not just a script run.

The keyed file is worth checking on its own terms, because a wrong key fails **silently** — the file lands somewhere real and the status-bar segment simply never appears. Set `GHOLA_STATE_KEY` and confirm it is honored verbatim with no derivation; unset it and confirm the key is derived from `workspace.project_dir` and matches what `src/session/statusline-state.ts` computes for the same path; confirm a blank `project_dir` writes nothing at all rather than keying off the cwd. Both renderers must produce the **same filename and the same bytes** for the same payload (modulo `updated`, which is epoch seconds and can cross a boundary between two processes).
