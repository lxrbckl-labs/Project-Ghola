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

The whole line can be suppressed without disabling the renderer — see **Silent mode** below. That is the supported way to remove the footer row now that the same figures appear in the VS Code status-bar pill.

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

## Silent mode: hiding the footer line without losing the pill

> **Do NOT delete `statusLine` from `~/.claude/settings.json` to hide the line.** The renderer is also the **writer** of both state files above, including the keyed one the VS Code status-bar pill reads. Removing the `statusLine` entry stops the harness invoking the renderer at all, so nothing writes state, and the pill's context/5h/token figures go empty inside the reader's 90-second staleness window — on **both** hosts. Hiding the line and keeping the pill are the same script, so they need a switch inside it, not a config deletion.

The switch is **silent mode**: the renderer still runs on every refresh, still writes both state files, and prints **nothing**.

Two controls, in this precedence order:

1. **`GHOLA_STATUSLINE_SILENT`** (environment variable) — checked **first**.
   - `1`, `true`, `yes` (case-insensitive, surrounding whitespace trimmed) -> **silent**.
   - `0`, `false`, `no` -> **not silent**, and this *beats the marker file*, so a single session can be un-silenced without deleting it.
   - Unset, empty, whitespace-only, or any unrecognized value -> **no signal**; defer to the marker file. (Empty is deliberately absence rather than an explicit "not silent": `export GHOLA_STATUSLINE_SILENT=` is what a shell does when a variable is cleared, and treating that as an override would make the marker file unusable. A typo like `ture` also defers, so no misspelling can silence the line by accident — every ambiguous input errs toward *printing*.)
2. **`<homedir>/.ghola/statusline/silent`** (marker file) — if it **exists**, print nothing. **Contents are irrelevant**; existence is the entire signal and an empty file is the expected form. Even a marker whose text reads `false` still silences. It sits beside the staged renderer and the `VERSION` stamp in that same directory, so it needs no new directory and no new path-resolution rule; the home directory is resolved by exactly the same call that resolves the state files.

Silence is about **stdout only**. Both state writes happen unconditionally and *before* the print gate, so `tool.usage-observer` and the status-bar pill are unaffected — that is the whole point of the feature.

**A failed check degrades to NOT silent, never the reverse.** An unreadable marker directory, a permission error, a non-directory in the middle of the path, or (in the `.sh`) a `python3` that will not run all fall through to the normal line. A broken check must not be able to blank the operator's footer, and it must not abort the render either. Both renderers still exit 0 on every path.

### Operator commands

Silence (WSL / bash):

```bash
mkdir -p ~/.ghola/statusline && touch ~/.ghola/statusline/silent
```

Un-silence (WSL / bash) — this deletes a file, so it is the operator's call, not an agent's:

```bash
rm -f ~/.ghola/statusline/silent
```

Silence (native Windows / PowerShell):

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.ghola\statusline" | Out-Null
New-Item -ItemType File -Force -Path "$env:USERPROFILE\.ghola\statusline\silent" | Out-Null
```

Un-silence (native Windows / PowerShell):

```powershell
Remove-Item -Force -ErrorAction SilentlyContinue "$env:USERPROFILE\.ghola\statusline\silent"
```

The two hosts have **separate** home directories and therefore **separate** markers: silencing WSL does not silence native Windows. Each host's marker governs the renderer that host's `~/.claude/settings.json` points at.

**The marker only works once the host is running a renderer that knows about it.** `statusLine.command` points at the *staged* copy in `<homedir>/.ghola/statusline/`, which the extension refreshes on activation by comparing bytes. Until that re-staging happens (a dev-host launch or a reinstall), the marker sits there being ignored by the older staged renderer and the footer keeps printing. This is not a silent-mode quirk — it is the same one-activation lag every renderer change has — but it is the likeliest reason a freshly created marker appears to do nothing.

Per-session override, without touching the marker (bash / PowerShell):

```bash
GHOLA_STATUSLINE_SILENT=1 claude   # force silent for this session
GHOLA_STATUSLINE_SILENT=0 claude   # force the line back on, marker or not
```

```powershell
$env:GHOLA_STATUSLINE_SILENT = "1"; claude
$env:GHOLA_STATUSLINE_SILENT = "0"; claude
```

### What the harness does with no output

Claude Code `.trim()`s the renderer's stdout, drops blank lines, and treats an empty result as **absent** — so printing nothing and printing a bare newline are indistinguishable to it. It then renders **no row at all** in the default TUI; only in fullscreen / no-flicker mode does it reserve the slot with a single space, because there the layout is fixed. That choice is the harness's, not the renderer's: the script writes zero bytes and has no further lever. Determined by reading the status-line component and its command executor in the Claude Code 2.1.220 bundle, and consistent with the public docs' "Scripts that exit with non-zero codes or produce no output cause the status line to go blank". Note the harness only uses the output at all when the exit code is 0, which both renderers always are.

## Fixed behavior vs parameters

Neither renderer has **settings-file toggles**, and the six declared settings are **inert**. Both renderers always render whatever segments the payload provides, and the red threshold is fixed at 85%. `showVersion`, `showCumulativeTokens`, `showContextPercent`, `showRollingWindowPercent`, `redThresholdPercent`, and `fallbackToVersionOnly` have **zero references** in either renderer.

**They are not merely unimplemented — they are unimplementable as written.** Ghola module settings live in VS Code's `globalState`, an opaque `Memento` with no on-disk representation. The renderers are standalone scripts that the Claude Code harness executes *outside* the extension host, so there is nothing for them to read. Wiring these toggles would first require exporting them to a file or an environment variable. Each setting's `description` in `manifest.json` now says so explicitly, because the Modules tab renders that text directly beneath the control — which is where the misleading impression was being created, and therefore where the correction has to live. This document is the secondary record; the manifest is the primary one.

They are kept rather than deleted: removing a declared setting can strand a stored value, and whether to drop them is the operator's call.

Today's behavior is: all-segments-always (each still gated on its data being present) and red-at-85. Changing what shows, or the threshold, is a renderer edit, not a settings change — and it must be made in **both** renderers to keep them byte-identical. **Silent mode is the one exception to "no runtime configuration"**, and it is deliberately controlled by a marker file and an environment variable rather than a module setting, precisely because those are the only two things a standalone script can actually see.

## What this module does NOT do

- **Installs nothing.** This module is **documentation only**. Enabling it does not create, modify, or remove the `statusLine` entry in `~/.claude/settings.json`, and disabling it does not turn the statusline off. That file is the operator's live harness config and no Ghola code writes it — the operator adds the line above by hand, once. (This has surprised us before: the reason the tag appears on WSL and not on Windows is simply that the WSL settings file has a `statusLine` key and the Windows one does not.) Renderer staging is likewise done by the extension on activation regardless of whether this module is enabled.
- **Does not control silent mode either.** Toggling this module on or off has no effect on the marker file, and no Ghola code creates or deletes `<homedir>/.ghola/statusline/silent`. Silencing and un-silencing are operator actions on that file (or on the environment variable) — un-silencing in particular is a file *deletion*, so an agent should hand the operator the command rather than run it.
- Does **not** render a VS Code status-bar pill. The statusline is the harness line only. The separate `Ghola: <mode>` item in the VS Code status bar is `src/status-bar/mode-status-bar.ts`; it is a **reader** of the keyed state file described above, so the two surfaces share data and can show the same context and 5-hour figures, but nothing in this module draws that item and the renderers know nothing about it beyond the file they write.
- Does **not** track or compute tokens itself; it formats whatever the harness supplies on stdin.
- Does **not** talk to any external service, telemetry endpoint, or remote logger. All data is local to the active session's payload.

## Role-Specific Notes

The body above applies identically to every agent. The notes below frame how each role relates to the live statusline.

### TPM

The statusline is live. You can tell the user it is the harness line at the bottom of the session, rendered by `scripts/ghola-statusline.mjs` (the `.sh` is the WSL-only original, kept for back-compat), and describe its segments: version (always), cumulative tokens, context %, and 5-hour rolling-window % (each appearing when the harness payload provides it), with context % and 5h % turning red at 85% or above.

Three honesty points to keep straight:

- If the user wants to change what shows or the red threshold, that is a **renderer edit** — the module's six `parameters` are not honored and *cannot* be, so toggling them in the Modules tab changes nothing today. Say so plainly rather than letting the user believe a toggle did something.
- If the tag is **missing** on a host, the cause is almost always that the host's `~/.claude/settings.json` has no `statusLine` key. Ghola never writes that file; give the user the per-platform line from *How it is wired* to paste. Do not describe this module as something that installs or removes the statusline.
- If the user wants the footer line **gone**, do not suggest deleting `statusLine` from `~/.claude/settings.json`. The renderer is the writer of the state files the status-bar pill reads, so that would also blank the pill within 90 seconds. Give them the marker-file command from *Silent mode* instead, and tell them the pill keeps working.

### SWE

There are two renderers and they must stay byte-identical: `scripts/ghola-statusline.mjs` (Node, cross-platform, the one operators point at) and `scripts/ghola-statusline.sh` (bash + `python3`, WSL-only, back-compat). A change to segments, formatting, or the red threshold is a direct edit to **both**, verified by piping the same payloads into each and diffing the bytes — including the empty, partial, and malformed-JSON payloads, not just the happy path.

**Silent mode is part of that pair contract.** Same marker path, same environment variable, same precedence, same truthiness sets, in both files — and both must gate **only** stdout, never the state writes, which happen earlier and unconditionally. In the `.mjs` the flag is resolved once at module scope so the last-resort `catch` fallback honors it too; in the `.sh` the marker probe lives inside the `python3` block (so the home directory is resolved by the same `expanduser` that resolves the state files) and is reported to bash as a fourth pipe-separated field, while the environment override is normalized in pure bash so it survives a `python3` that will not run. Every failure path must answer **not silent**, and neither file may grow a `set` line to get there.

Watch for the traps that make parity non-obvious: Python's `round()` is round-half-to-EVEN (`62.5` -> `62`) where `Math.round` is half-up, Python's `int()` truncates toward zero, and Python's `isinstance(x, int)` accepts `bool`. The `.mjs` mirrors all three deliberately. Preserve the never-fail contract on both (every error path degrades silently and exits 0), keep ASCII quotes in code, and leave the `│` / `·` output characters exactly as they are — those are content. `~/.ghola/usage-state.json` is a cross-module contract with `tool.usage-observer`: same path, same keys, same key order, atomic write.

The state-key algorithm makes it a **triplicate**, not a pair: the third copy is `src/session/statusline-state.ts`, which is the normative spec, and a change to any step must land in all three in the same commit. Its own traps are recorded there and are easy to get wrong from memory — ASCII-only case folding via an explicit `[A-Z]` class (never `toLowerCase()`/`.lower()`, which diverge on non-ASCII between the three languages), hashing the *normalized path* rather than the folded body (folding is lossy, so hashing the body would preserve the collision the hash exists to break), edge-hyphen trimming *after* truncation, and `.git` tested for existence rather than directory-ness. Note also that Python's `json.dump` defaults to `", "`/`": "` separators where `JSON.stringify` emits none, so the keyed write passes `separators=(",", ":")`; the unkeyed write does not and the two renderers' `usage-state.json` therefore differ by whitespace, which is harmless because every reader parses rather than compares.

### QA

There is a real rendered statusline to verify: pipe a sample harness payload into `scripts/ghola-statusline.mjs` and confirm the output line. A full payload should yield `[Ghola vX.Y.Z │ <tokens> · <ctx>% · 5h <n>%]`; empty stdin should yield `[Ghola vX.Y.Z]`. Confirm the red (`\033[31m`) coloring appears only at percentages >= 85, that the renderer exits 0 and prints no error text on malformed input, and that piping the identical payload into `scripts/ghola-statusline.sh` produces the same bytes.

Silent mode needs its own four checks, in both renderers, under a redirected `HOME`: marker absent (prints), marker present (zero bytes on stdout), `GHOLA_STATUSLINE_SILENT=1` with no marker (zero bytes), and `GHOLA_STATUSLINE_SILENT=0` **with** the marker present (prints — the explicit override must beat the file). Then prove the part that matters: with the marker present and stdout empty, **both state files must still be created**. And prove the fail-safe direction: make the marker path unreadable (a non-directory partway along it, or mode `000` on its parent) and confirm the line still prints and the exit code is still 0 — a check failure must never suppress output. **Never create `~/.ghola/statusline/silent` in the operator's real home**; that would silence their live footer without them asking.

Two further cautions. First, both renderers write `~/.ghola/usage-state.json` **and** `~/.ghola/statusline/state/<key>.json` on any payload carrying a usage signal — override `HOME` to a scratch directory when running test payloads, or you will overwrite the operator's live snapshots. Second, staging is only exercised at extension activation, so verifying `<homedir>/.ghola/statusline/` requires an actual activation (a dev-host launch or a reinstall), not just a script run. Note that the extension's staging step copies only the renderer and the `VERSION` stamp, so it neither creates nor removes a marker sitting in that same directory.

The keyed file is worth checking on its own terms, because a wrong key fails **silently** — the file lands somewhere real and the status-bar segment simply never appears. Set `GHOLA_STATE_KEY` and confirm it is honored verbatim with no derivation; unset it and confirm the key is derived from `workspace.project_dir` and matches what `src/session/statusline-state.ts` computes for the same path; confirm a blank `project_dir` writes nothing at all rather than keying off the cwd. Both renderers must produce the **same filename and the same bytes** for the same payload (modulo `updated`, which is epoch seconds and can cross a boundary between two processes).
