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

That indirection matters: the installed extension directory is version-pinned (`local.ghola-0.25.0/...`), so a command pointing into it silently stops working at the next version bump — the tag just disappears from the footer with nothing to explain it. The staged path never changes, so the operator configures `statusLine.command` **once**. The staging is idempotent (it compares the stamp and the renderer bytes and does nothing when already current), never blocks or fails activation, and touches only those two files — `usage-state.json` and `ledger/` in the parent directory are never read or written by it.

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

## Side effect: the usage snapshot

On every render, when the payload carries a token count or a 5-hour figure, the renderer also writes a small snapshot to `~/.ghola/usage-state.json` (temp file then atomic rename). That file is the input to the **`tool.usage-observer`** module. Both renderers write the same location, the same keys, and the same key order, so switching between them is invisible to that module. A payload with no usage signal writes nothing, so an empty render never clobbers a good snapshot.

## Fixed behavior vs parameters

Neither renderer has **settings-file toggles**. Both always render whatever segments the payload provides, and the red threshold is fixed at 85%. The module's `parameters` (`showVersion`, `showCumulativeTokens`, `showContextPercent`, `showRollingWindowPercent`, `redThresholdPercent`, `fallbackToVersionOnly`) are **not read** by either renderer — they are forward-looking preferences that do not currently take effect. Today's behavior is: all-segments-always (each still gated on its data being present) and red-at-85. Changing what shows, or the threshold, is a renderer edit, not a settings change — and it must be made in **both** renderers to keep them byte-identical.

## What this module does NOT do

- **Installs nothing.** This module is **documentation only**. Enabling it does not create, modify, or remove the `statusLine` entry in `~/.claude/settings.json`, and disabling it does not turn the statusline off. That file is the operator's live harness config and no Ghola code writes it — the operator adds the line above by hand, once. (This has surprised us before: the reason the tag appears on WSL and not on Windows is simply that the WSL settings file has a `statusLine` key and the Windows one does not.) Renderer staging is likewise done by the extension on activation regardless of whether this module is enabled.
- Does **not** render a VS Code status-bar pill. The statusline is the harness line only. (The separate `Ghola: <mode>` item in the VS Code status bar is `src/status-bar/mode-status-bar.ts`, unrelated to this module.)
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

### QA

There is a real rendered statusline to verify: pipe a sample harness payload into `scripts/ghola-statusline.mjs` and confirm the output line. A full payload should yield `[Ghola vX.Y.Z │ <tokens> · <ctx>% · 5h <n>%]`; empty stdin should yield `[Ghola vX.Y.Z]`. Confirm the red (`\033[31m`) coloring appears only at percentages >= 85, that the renderer exits 0 and prints no error text on malformed input, and that piping the identical payload into `scripts/ghola-statusline.sh` produces the same bytes.

Two cautions. First, both renderers write `~/.ghola/usage-state.json` on any payload carrying a usage signal — override `HOME` to a scratch directory when running test payloads, or you will overwrite the operator's live snapshot. Second, staging is only exercised at extension activation, so verifying `<homedir>/.ghola/statusline/` requires an actual activation (a dev-host launch or a reinstall), not just a script run.
