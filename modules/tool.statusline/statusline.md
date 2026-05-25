# Statusline

When this module is loaded, the Nomeda extension is authorized to render a single status-bar entry in VS Code summarizing the active session. This fragment is the **configuration contract** for that display — it defines which segments are surfaced and under what conditions. The rendering itself is performed by extension-side code (status-bar registration in `src/extension.ts` and adjacent files); this module does not implement the render, it only declares the policy the renderer reads.

## What the statusline shows

The full possible composition is a single bracketed pill in the right-hand status bar:

```
[Nomeda vX.Y.Z │ 142k · 62% · 5h 41%]
```

The pill is composed of up to four independently-gated segments:

- **Version** (per `parameters.showVersion`) — rendered as `vX.Y.Z` (e.g. `v0.42.1`). Sourced from the extension's `package.json` at activation.
- **Cumulative tokens** (per `parameters.showCumulativeTokens`) — rendered as a compact figure such as `142k`. Sums input + output across every turn of the active session.
- **Context percent** (per `parameters.showContextPercent`) — rendered as `62%`. Compares conversation tokens against the active model's context window. Turns red at or above `parameters.redThresholdPercent`.
- **Rolling window percent** (per `parameters.showRollingWindowPercent`) — rendered as `5h 41%`. Reflects the fraction of the 5-hour rolling rate-limit window consumed, when the runtime exposes that data. Turns red at or above `parameters.redThresholdPercent`.

The `│` and `·` separators are styling concerns owned by the renderer; they appear only between segments that are actually present.

## Conditional rendering

Each segment renders independently — the four `show*` settings are not coupled. If a segment's setting is off, that segment is omitted from the pill entirely (no placeholder, no empty slot).

If a segment's **data source** is unavailable at render time (the runtime payload is missing, unparseable, or has not yet populated the relevant field), behavior follows `parameters.fallbackToVersionOnly`:

- **When `true`** (the default): all unavailable segments collapse but the version remains, producing the short form `[Nomeda vX.Y.Z]`. This preserves a visible Nomeda surface even when token/context/rolling-window data is not yet flowing.
- **When `false`**: each unavailable segment renders empty individually. In the worst case (no runtime payload at all) the pill is sparse — e.g. `[Nomeda vX.Y.Z]` with no metrics, or `[Nomeda]` if version is also unavailable.

A segment whose `show*` toggle is off is **not** considered "unavailable" — it is intentionally suppressed and the fallback logic does not apply to it.

## Red threshold semantics

Both **Context Percent** and **Rolling Window Percent** compare their numeric value against `parameters.redThresholdPercent`. At or above the threshold, the segment's number renders in red using the VS Code status-bar warning color token (`statusBarItem.warningForeground` / `statusBarItem.warningBackground`, depending on the renderer's choice). Below the threshold, the segment uses default status-bar foreground styling.

The threshold value itself is never highlighted — only the live segment numbers that meet or exceed it. The threshold applies symmetrically to both percent segments; there is no separate per-segment threshold.

If a percent segment is suppressed by its `show*` setting, the threshold comparison does not run for it (no hidden coloring side-effects).

## Sources of data

This module references but does not implement the underlying data sources. They are listed here so TPM can answer the user accurately when asked what the statusline reflects:

- **Version** — read from the extension's `package.json` at activation. Stable for the duration of the session.
- **Cumulative tokens** — summed from runtime turn metadata across the active session (input + output for every turn since session start).
- **Context percent** — ratio of conversation tokens to the active model's context window, computed by the runtime and exposed per turn.
- **Rolling window percent** — from the runtime's rate-limit-block payload, when present. May be absent early in a session, on accounts without a rolling-window quota, or when the runtime does not include the field in a given response.

The renderer is responsible for reading these sources; this module does not fetch or cache them.

## Module-disabled vs feature-disabled

These are distinct states and should not be conflated:

- **Module disabled** (no `tool.statusline` in the Session Manifest): the entire statusline is hidden. The user sees no Nomeda status-bar entry at all.
- **Module enabled, all `show*` settings off**: the pill has no segments to render. Recommended renderer behavior is **suppress** (do not show an empty `[Nomeda]` pill) rather than render a bare label — an empty pill conveys no information and adds visual noise. Flag this case to future wiring as "suppress on no-segments-enabled."
- **Module enabled, runtime payload empty**: degrades per `parameters.fallbackToVersionOnly` as described above.

## What this module does NOT do

- Does **not** modify the rendered statusline at runtime — the extension's status-bar registration code reads these settings and renders accordingly. This module is policy, not implementation.
- Does **not** track or report tokens itself — it consumes whatever the runtime exposes via turn metadata and rate-limit-block payloads.
- Does **not** communicate with any external service, telemetry endpoint, or remote logger. All data surfaced is local to the active session.

## Role-Specific Notes

The body above applies identically to every agent. The notes below frame how each role relates to the statusline policy.

### TPM

You are the source of the Nomeda surface the user sees in the status bar. When the user asks what the statusline shows, refer to the four segments — Version, Cumulative Tokens, Context Percent, Rolling Window Percent — and what each represents per the sections above. When the user asks how to hide or change a segment, point them at the Modules tab for `tool.statusline` and name the specific `show*` setting or `redThresholdPercent`. You do not write to the statusline yourself; extension code reads this module's settings and renders accordingly.

### SWE

Your work contributes to the cumulative-token count (via your turn's input + output) but you do not interact with the statusline directly. No behavior change in your normal workflow — the statusline is observation-only from your perspective.

### QA

Same as SWE. Your review turns contribute to the cumulative-token count but you do not interact with the statusline directly. No behavior change.
