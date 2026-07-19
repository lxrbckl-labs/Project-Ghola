# Self Upgrade Ledger

Last processed Claude version: none (no changelog fold yet)

## 2026-07-19 upgrade: Enable PR Monitor delete-comment in Ticket Work mode
- Inspired by: user request (direct feature enablement, not a Claude changelog fold)
- Files touched: src/settings-panel/built-in-configurations.ts
- Rationale: Enabled PR Monitor's existing, confirmation-gated delete-comment capability for Ticket Work sessions via a Ticket Work preset override (deleteCommentEnabled: true), leaving the module manifest default false for all other presets and the per-delete confirmation gate unchanged.
- Commit: 4e28bfb06779c712d2583c32f3768c5e0ea5f098

## 2026-07-19 upgrade: Default PR Monitor delete-comment to enabled
- Inspired by: user request (existing sessions did not pick up the v0.23.1 preset-only enablement)
- Files touched: modules/integration.bitbucket-pr-comments/manifest.json, modules/integration.bitbucket-pr-comments/pr-monitor.md
- Rationale: v0.23.1 enabled delete only via the Ticket Work preset override, which does not reach already-configured sessions; flipping the module manifest default to true makes delete available by default in sessions that do not override it, still gated by the mandatory per-delete confirmation. pr-monitor.md default-value docs updated to match.
- Commit: 9f4e701f39e5e5f0f21376b2b20757f27d2b9444
