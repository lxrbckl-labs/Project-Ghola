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

## 2026-07-19 upgrade: Add ticket branch creation to Ticket Work profile
- Inspired by: user request (Ticket Work profile could not create a branch from a ticket)
- Files touched: src/settings-panel/built-in-configurations.ts, modules/mode.ticket-work/ticket-work.md, modules/mode.ticket-work/manifest.json
- Rationale: Ticket Work shipped no tool.git override so it inherited the read-only manifest default, and mode.ticket-work only derived a ticket key from an existing branch. Added a full-map tool.git allowedCommands override to the Ticket Work preset enabling only "git branch <name>" and "git switch" (48/48 key parity verified; bare "git checkout" left disabled to avoid granting the file-discarding "git checkout -- <path>" form), plus a user-invoked branch-creation workflow with round-trip-safe <prefix>/<KEY>-<slug> naming, allowlist deference, and confirm-before-create. Never automatic; existing branch-to-key derivation unchanged.
- Commit: 97470746b28e492852af7ef4dfb9ec79228b99f6

## 2026-07-19 upgrade: Add standalone top-level PR comment capability
- Inspired by: user request (bot triggers like "@coderabbitai review" were unreachable)
- Files touched: src/integration/bitbucket-pr-client.ts, src/integration/bitbucket-bridge-server.ts, scripts/bb-bridge.mjs, modules/integration.bitbucket-pr-comments/pr-monitor.md, modules/integration.bitbucket-pr-comments/manifest.json
- Rationale: The bridge could only post threaded replies because "reply" hard-requires --parent, so a top-level comment was impossible and CodeRabbit re-review triggers could not be issued. Added create-comment end to end (REST client method with a content-only payload type so parent/inline cannot be sent, bridge route, and CLI subcommand with empty-body validation) plus a documented Comment Verb with a rereview shorthand, an explicit ban on faking it as a reply inside a resolved thread, the existing requireUserApproval gate, and 403 / 200-comment-cap failure handling.
- Commit: 0b284975586e1de9e43da9dc582cbd1c74942425
