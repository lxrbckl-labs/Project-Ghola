# Statusline

**Status: live.** The Ghola statusline is the **Claude Code harness statusline** — the single line the harness renders at the bottom of the session, driven by the `statusLine.command` entry in `~/.claude/settings.json`. It is **not** a VS Code status-bar pill and is not produced by extension code in `src/`.

It is rendered by `scripts/ghola-statusline.sh`. On each refresh the harness runs that script, passing its JSON payload on stdin; the script reads the Ghola `VERSION` file (resolved relative to the script's own location, so it works regardless of cwd) and prints one line to stdout.

## What the statusline shows

The output is a single bracketed label:

```
[Ghola vX.Y.Z │ 142k · 62% · 5h 41%]
```

- **Version** — always present. Read from the repo's `VERSION` file, e.g. `v0.16.2`. If `VERSION` is unreadable it falls back to `vunknown`.
- **Cumulative tokens** — a compact figure such as `142k`, the sum of `context_window.total_input_tokens` + `total_output_tokens` from the payload. Appears only when both fields are present.
- **Context percent** — e.g. `62%`, from `context_window.used_percentage`. Appears only when that field is present. Renders red at or above 85%.
- **Rolling window percent** — e.g. `5h 41%`, from `rate_limits.five_hour.used_percentage`. Appears only when that field is present. Renders red at or above 85%.

Each segment is gated independently on its own source field — any one can appear without the others. Segments are joined with ` · ` (U+00B7); the ` │ ` (U+2502) separator between the version and the metrics appears only when at least one metric segment is present.

## Failure behavior

The script never fails and never prints error text. `VERSION` is read defensively, stdin is captured once, and all JSON parsing happens in a sandboxed `python3` block whose failures are swallowed. On any error the output degrades to `[Ghola vX.Y.Z]`, or `[Ghola vunknown]` if the version itself could not be read. There is no path on which the harness sees a crash or partial line.

## How it is wired

`~/.claude/settings.json` contains:

```json
{ "statusLine": { "type": "command",
                  "command": "/home/aarbuckle/projects/Project-Ghola/scripts/ghola-statusline.sh" } }
```

The script must be executable (`chmod +x`). Its only dependencies are `bash` and `python3` — `jq` is not assumed.

## Fixed behavior vs parameters

The current script has **no settings-file toggles**. It always renders whatever segments the payload provides, and the red threshold is fixed at 85%. The module's `parameters` (`showVersion`, `showCumulativeTokens`, `showContextPercent`, `showRollingWindowPercent`, `redThresholdPercent`, `fallbackToVersionOnly`) are **not** read by `ghola-statusline.sh` — they are forward-looking preferences that do not currently take effect. Today's behavior is: all-segments-always (each still gated on its data being present) and red-at-85. Changing what shows, or the threshold, is a script edit, not a settings change.

## What this module does NOT do

- Does **not** render a VS Code status-bar pill. The statusline is the harness line only.
- Does **not** track or compute tokens itself; it formats whatever the harness supplies on stdin.
- Does **not** talk to any external service, telemetry endpoint, or remote logger. All data is local to the active session's payload.

## Role-Specific Notes

The body above applies identically to every agent. The notes below frame how each role relates to the live statusline.

### TPM

The statusline is live. You can tell the user it is the harness line at the bottom of the session, rendered by `scripts/ghola-statusline.sh`, and describe its segments: version (always), cumulative tokens, context %, and 5-hour rolling-window % (each appearing when the harness payload provides it), with context % and 5h % turning red at 85% or above. If the user wants to change what shows or the red threshold, be honest that this is a **script edit** — the module's `parameters` are not currently honored by the script, so toggling them in the Modules tab will not change the display today.

### SWE

The renderer is `scripts/ghola-statusline.sh` — a self-contained bash + python3 script. If the user asks to change the segments, formatting, or red threshold, that is a direct edit to this script. There is no settings-file wiring to honor; the script ignores the module `parameters`. Keep ASCII quotes in shell/JSON and preserve the never-fail contract (every error path falls back silently) when editing.

### QA

There is a real rendered statusline to verify: pipe a sample harness payload into `scripts/ghola-statusline.sh` and confirm the output line. A full payload should yield `[Ghola vX.Y.Z │ <tokens> · <ctx>% · 5h <n>%]`; empty stdin should yield `[Ghola vX.Y.Z]`. Confirm the red (`\033[31m`) coloring appears only at percentages >= 85, and that the script exits 0 and prints no error text on malformed input.
