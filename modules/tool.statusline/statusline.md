# Statusline

**Status: specification only, not yet wired.** This module captures the *intended* display preferences for a Nomeda VS Code status-bar entry, but no extension code currently renders it. There is no status-bar registration in `src/extension.ts` or anywhere else in `src/` that reads these settings, and none of the `show*` settings has a runtime consumer today. This fragment is a forward design contract, not a description of a live feature. When rendering code is eventually built, it should read the settings defined here; until then, the settings record preferences that nothing acts on.

**TPM must NOT tell the user a status-bar pill is live, and must NOT point at any extension code as its renderer.** That code does not exist. If the user asks whether the statusline is showing, the honest answer is that the module is a planned spec whose settings are captured but not yet rendered.

## What the statusline is intended to show

The design target is a single bracketed pill in the right-hand status bar:

```
[Nomeda vX.Y.Z │ 142k · 62% · 5h 41%]
```

The pill is specified as up to four independently-gated segments. Each of the `parameters` below is a captured preference for a future renderer, not a switch that changes anything today:

- **Version** (per `parameters.showVersion`): intended format `vX.Y.Z` (e.g. `v0.42.1`), sourced from the extension's `package.json` at activation.
- **Cumulative tokens** (per `parameters.showCumulativeTokens`): intended format a compact figure such as `142k`, summing input + output across every turn of the active session.
- **Context percent** (per `parameters.showContextPercent`): intended format `62%`, comparing conversation tokens against the active model's context window. Intended to turn red at or above `parameters.redThresholdPercent`.
- **Rolling window percent** (per `parameters.showRollingWindowPercent`): intended format `5h 41%`, reflecting the fraction of the 5-hour rolling rate-limit window consumed, when a runtime exposes that data.

The `│` and `·` separators are a styling concern for the eventual renderer; they would appear only between segments that are actually present.

## Intended conditional rendering

The spec calls for each segment to be gated independently; the four `show*` settings are not coupled. If a segment's setting is off, a future renderer would omit that segment from the pill entirely (no placeholder, no empty slot).

If a segment's **data source** were unavailable at render time (the runtime payload missing, unparseable, or not yet populated), the intended behavior follows `parameters.fallbackToVersionOnly`:

- **When `true`** (the default): all unavailable segments collapse but the version remains, producing the short form `[Nomeda vX.Y.Z]`. This would preserve a visible Nomeda surface even when token/context/rolling-window data is not yet flowing.
- **When `false`**: each unavailable segment renders empty individually. In the worst case (no runtime payload at all) the pill would be sparse, e.g. `[Nomeda vX.Y.Z]` with no metrics, or `[Nomeda]` if version is also unavailable.

A segment whose `show*` toggle is off is **not** considered "unavailable"; it is intentionally suppressed, and the fallback logic would not apply to it.

## Intended red threshold semantics

The spec has both **Context Percent** and **Rolling Window Percent** compare their numeric value against `parameters.redThresholdPercent`. At or above the threshold, a future renderer would color the segment's number red using a VS Code status-bar warning color token (e.g. `statusBarItem.warningForeground` / `statusBarItem.warningBackground`). Below the threshold, the segment would use default status-bar foreground styling.

The threshold value itself is never highlighted; only the live segment numbers that meet or exceed it. The threshold is specified to apply symmetrically to both percent segments; there is no separate per-segment threshold. A percent segment suppressed by its `show*` setting would run no threshold comparison.

## Intended sources of data

This module neither implements nor fetches these sources; they are listed so TPM can describe accurately what the statusline is *designed* to reflect, while being clear nothing renders them yet:

- **Version**: read from the extension's `package.json` at activation. Stable for the duration of the session.
- **Cumulative tokens**: summed from runtime turn metadata across the active session (input + output for every turn since session start).
- **Context percent**: ratio of conversation tokens to the active model's context window, computed per turn by the runtime.
- **Rolling window percent**: from the runtime's rate-limit-block payload, when present. May be absent early in a session, on accounts without a rolling-window quota, or when the runtime does not include the field in a given response.

## Module-disabled vs feature-disabled (intended states)

These are distinct states in the design and should not be conflated. All are conditional on a renderer existing; today none produces a visible pill because no renderer is wired:

- **Module disabled** (no `tool.statusline` in the Session Manifest): the entire statusline is out of scope. The user sees no Nomeda status-bar entry.
- **Module enabled, all `show*` settings off**: the pill would have no segments to render. Recommended future behavior is **suppress** (do not show an empty `[Nomeda]` pill) rather than render a bare label, since an empty pill conveys no information and adds visual noise. Flagged to future wiring as "suppress on no-segments-enabled."
- **Module enabled, runtime payload empty**: would degrade per `parameters.fallbackToVersionOnly` as described above.

## What this module does NOT do

- Does **not** render anything today. No extension code reads these settings and no status-bar pill is produced. The settings are captured preferences awaiting a renderer; this module is spec, not implementation.
- Does **not** track or report tokens itself; the design has it consume whatever a future runtime hook exposes via turn metadata and rate-limit-block payloads.
- Does **not** communicate with any external service, telemetry endpoint, or remote logger. Any data the eventual renderer surfaces would be local to the active session.

## Role-Specific Notes

The body above applies identically to every agent. The notes below frame how each role relates to the statusline spec.

### TPM

The statusline is a planned surface, not a live one. If the user asks what the statusline shows, explain that the four segments (Version, Cumulative Tokens, Context Percent, Rolling Window Percent) are the *intended* composition per the sections above, but that no extension code renders them yet, so there is no pill in the status bar today. Do NOT claim a pill is live and do NOT point the user at extension code as its renderer; none exists. If the user asks to change a segment preference, you can still point them at the Modules tab for `tool.statusline` and name the specific `show*` setting or `redThresholdPercent`, but be clear the setting records a preference a future renderer will honor, not a change they will see now.

### SWE

No interaction. There is no statusline renderer to feed or modify; the settings have no runtime consumer today. If spec-writing or wiring for this module is ever assigned, that is an explicit build task, not part of the normal workflow. No behavior change.

### QA

No interaction. There is no rendered statusline to verify. Treat any claim that a live pill exists as inaccurate until backing code lands. No behavior change.
