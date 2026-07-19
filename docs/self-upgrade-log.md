# Self Upgrade Ledger

Last processed Claude version: none (no changelog fold yet)

## 2026-07-19 upgrade: Enable PR Monitor delete-comment in Ticket Work mode
- Inspired by: user request (direct feature enablement, not a Claude changelog fold)
- Files touched: src/settings-panel/built-in-configurations.ts
- Rationale: Enabled PR Monitor's existing, confirmation-gated delete-comment capability for Ticket Work sessions via a Ticket Work preset override (deleteCommentEnabled: true), leaving the module manifest default false for all other presets and the per-delete confirmation gate unchanged.
- Commit: 4e28bfb06779c712d2583c32f3768c5e0ea5f098
