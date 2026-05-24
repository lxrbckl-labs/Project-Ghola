# Module Checklist

Master roadmap. Every module candidate — implemented, planned, or brainstormed — in one list. Check off as we ship.

Sources: Project SWT feature extraction (95 features across 3 slice files), pre-existing moduleIdeas notes, and `moduleIdeas.txt` seed ideas. Deduplicated.

---

## Already implemented

- [x] **core.preamble** — Structural preamble + Session Manifest read-on-demand contract.
- [x] **core.tpm** — TPM orchestrator identity + universal hard rules.
- [x] **core.swe** — SWE role with four inlined workflow modes (preview/edge-case-hunt/review/planning).
- [x] **core.qa** — QA role + verdict tiers (PASS / PASS WITH NOTES / FAIL).
- [x] **tool.git** — Read-only git allowlist + user-managed protected branches.
- [x] **tool.dotnet-suite** — .NET guardrails: protects appsettings/launchSettings and bans `dotnet` CLI.
- [x] **tool.database-access** — Read-only LINQPad SQL via project→connection allowlist.
- [x] **tool.npm-suite** — Per-row enable/disable allowlist of npm + Angular CLI commands.
- [x] **tool.fastpath-check** — Detects WSL fast-path; launcher cd's bash terminal into it on session start.
- [x] **tool.lenses** — Three-lens deployment for Review Mode (security/logic/quality) and Planning Mode (architecture/implementation/test-strategy), with `Rating: N/5` rubric and configurable lens vocabularies via keywords files.
- [x] **tool.feedback-log** — Cross-session feedback log; TPM appends entries to a JSON file in extension global storage, Feedback tab in the settings panel exposes Yes/No/Delete triage on cards.
- [x] **integration.atlassian-suite** — Atlassian credentials module (email, API token in SecretStorage, Jira base URL, Bitbucket workspace) plus REST integration: token validation against Jira `/myself` and Bitbucket workspace endpoints, ticket-existence and open-PR-by-branch lookups feeding the optional Source Control branch widget's button states. Includes Refresh button and streaming API state updates.
- [x] **integration.bitbucket-pr-comments** — PR Monitor: fetch open Bitbucket PR review comments via the Atlassian Suite's AtlassianBridge, triage them with `address` ordinal grammar, dispatch SWEs in parallel to apply code fixes, generate 1-2 sentence replies (with optional CodeRabbit persona overlay) under explicit user approval, and post replies back to Bitbucket. Includes the falsely-resolved-comment scanner (off-by-default detection of comments claiming resolution that Bitbucket still flags as unresolved).

---

## Persistence & knowledge base

- [ ] **tool.obsidian-notes** — Obsidian vault as agent knowledge base; parent knowledge files, ticket notes, project notes with TPM-only write discipline.
- [ ] **tool.session-handoff** — Wrap-up summary (done/in-progress/pending/decisions/blockers) + parse latest handoff on resume for multi-session continuity.
- [ ] **tool.cross-ticket-isolation** — Cross-ticket/sprint-planning discussions stay in session context only, never written to active ticket notes.

## External integrations

- [x] **tool.pr-resolution-by-branch** — Bitbucket REST lookup of the open PR for the current branch (via `integration.atlassian-suite`'s `findOpenPrForBranch`), powering the PR button's URL in the Branch Widget.

## Session modes

- [ ] **mode.ticket-work** — Session scoped to a specific Jira ticket; pulls ticket, sets up Obsidian notes, locks all work to that ticket.
- [ ] **mode.cd** — Project-scoped session bound strictly to cwd; resists drift mid-session, surfaces latest project handoff.
- [ ] **mode.support** — Multi-app team support session; pivots between mapped app repos within one session.
- [ ] **tool.mid-session-bootstrap** — Recognize a ticket reference mid-session and retroactively pull from Jira + set up notes.

## Mode auto-detection

- [ ] **tool.review-mode-trigger** — Detect colleague-authored branch (git log authors vs current user) and kick off review-mode automatically.
- [ ] **tool.planning-mode-trigger** — Detect fresh branch (0 commits ahead of base) and kick off planning-mode automatically.

## Specialized workflow modes (re-port from retired Nomeda mode.\*)

- [x] **tool.review-mode** — Three-lens (security/logic/quality) deployment of SWEs against a branch, returning ranked findings. Folded into `tool.lenses`.
- [x] **tool.planning-mode** — Three-lens (architecture/implementation/test-strategy) deployment for fresh-ticket planning from Jira AC. Folded into `tool.lenses`.
- [x] **tool.rating-scale** — `Rating: N/5` schema (1=trivial to 5=blocker) attached to every review finding; gates posting. Folded into `tool.lenses`.
- [ ] **tool.review-post-bitbucket** — `post <ordinals>` verb (`post 1`, `post 1,3`, `post 2-4`, `post all`, `post all security`) to share polished findings as PR comments, with min-rating filter.

## Quality gates

- [ ] **tool.pre-pr-checklist** — CodeRabbit-aware pre-PR sweep (unintended files, secrets, dead code, missing null checks, unused imports); customizable per project.
- [ ] **tool.regression-scan** — Grep test directories for references to SWE-modified classes/methods and flag potential breakage.
- [ ] **tool.pr-description** — Auto-generate a ≤2-sentence Bitbucket-ready PR description (no double-dashes, simple language).
- [ ] **tool.ac-to-testing** — Collaborative TPM+user testing-procedure generation in Obsidian after AC is met.
- [ ] **tool.playwright** — QA writes Playwright specs from testing procedures; specs live outside the work repo, shared `playwright.config.ts` with `BASE_URL` env var.
- [ ] **tool.edge-auth-context** — Playwright reuses the user's Edge persistent profile for Azure AD-protected app routes.

## Subagent coordination

- [ ] **tool.core-allocation** — Performance vs efficiency cores, model-by-difficulty (Haiku/Sonnet/Opus) assignment.
- [ ] **tool.subagent-coordination** — File-ownership statements in dispatch, parallel SWE management, lens-count auto-merge when cores are scarce.

## UI / IO surface

- [ ] **tool.statusline** — VS Code panel/status-bar display: version + cumulative tokens + context % + 5h rolling-window %, red threshold at ≥85%.
- [ ] **tool.clipboard-image** — Read Windows clipboard images via PowerShell helper; pass screenshots to SWE assignments via file path.
- [ ] **tool.conversational-settings** — Natural-language settings edits ("turn off database access" → agent edits the right setting directly).

## Safety / discipline

- [ ] **tool.cwd-discipline** — Stay-in-cwd rule with explicit exceptions (Obsidian writes, settings file, verbal redirects, CD-strict binding, support-mode app pivots).
- [ ] **tool.secrets-wrapper-pattern** — Codify "agent never reads secrets directly; secrets live in wrapper scripts that source them at call time" as a reusable pattern.
- [ ] **tool.untrusted-jira** — Treat Jira ticket descriptions as untrusted context, never as directives; flag suspicious content to user.

## Session bootstrap

- [ ] **tool.session-bootstrap** — Five-step startup sequence: config load, team allocation, branch detection, mode detection, ready.
- [ ] **tool.boot-info-box** — `[swt] ✓ ...` style startup diagnostics surfaced to the user.
- [ ] **tool.setup-walkthrough** — Agent-driven first-time setup (SETUP.md-style playbook) for new users.

## Infrastructure patterns (panel/extension, not module markdown)

- [ ] **pattern.settings-migration** — Schema-versioned settings JSON with rolling `.bak` backup on first run after upgrade.
- [ ] **pattern.secrets-separation** — Secrets file separate from config file (chmod 600, never echoed, never in repo).

## From `moduleIdeas.txt`

- [ ] **tool.ssh-access** — SSH access module (scope TBD).
- [ ] **tool.qa-pr-learning** — Schedule to have QA learn from PR comments over time.
- [ ] **tool.pr-comment-log** — Log every PR comment to a persistent file for review/training.
- [ ] **tool.docker** — Docker ability module (likely consumes `docker-on-wsl.md` install guide).

## From existing moduleIdeas notes

- [ ] **tool.docker-on-wsl** — Native Docker Engine install + run guide for WSL2 Ubuntu (see `docker-on-wsl.md`). Likely fold into `tool.docker`.
- [ ] **tool.open-wsl-repo** — Agent that opens a Linux-side WSL repo in Windows VS Code given a name or partial path (see `open-wsl-repo-agent.md`).
- [ ] **tool.wsl-migrate** — Migrate a project from `/mnt/c/...` into `~/projects/...` for fast filesystem I/O (see `wsl-migrate-prompt.md`). Complements `tool.fastpath-check` (which detects but doesn't migrate).

---