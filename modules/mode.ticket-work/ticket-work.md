# Ticket Work

When this module is loaded, the session is scoped strictly to a single Jira ticket. Ticket Work mode treats that ticket as the bound unit of work for the duration of the session, maintains a per-ticket notes file keyed by the ticket id, and resists drift when the user references work on other tickets. This module extends the universal hard rules, it never relaxes them. Every agent reads this same fragment per the Session Manifest read-on-demand contract; role-specific framing is collected at the end.

This module is **proactive**: TPM reads it once, at session start, before responding to the user's first request. The first job is to resolve the ticket context — derive the ticket id, pull the ticket from Jira when `parameters.pullOnStart` is true, locate the per-ticket notes file, and surface the prior handoff on resume. The rest of the session, the module sits quietly until the user references a ticket other than the active one, at which point the cross-ticket policy kicks in.

This module depends on `integration.atlassian-suite` for Jira credentials, base URL, and the token — those stay behind the host and are never handled directly by the agent. The agent-facing ticket pull itself goes through `scripts/bb-bridge.mjs`'s `get-ticket` subcommand (a loopback bridge call into the host), not through any host-only Atlassian Suite method called directly by the agent — see ticket resolution step 4 below for the exact invocation. It also depends on `tool.obsidian-notes` for file location — per-ticket notes live at `<vault>/<ProjectName>/<TicketNumber>.md` and the vault path resolution is that module's job. And it depends on `tool.session-handoff` for the resume surfacing — the most-recent `## Session Handoff` block in the per-ticket notes file is read and summarized by that module, not by this mode directly. All three dependencies are soft: if any of them is disabled or degraded, this mode degrades gracefully — see "Dependency failure modes" below.

In this version of Ghola there is no mode-selector UI on the panel; Ticket Work mode is active whenever this module is present in the Session Manifest. Ticket Work is mutually exclusive with `mode.cd`, `mode.support`, and `mode.sardaukar` — only one session mode is active at a time. Future iterations may add an explicit mode picker — the policy described here is forward-compatible with that change.

## What Ticket Work mode does (at a glance)

- Treats a single Jira ticket as the bound unit of work for the duration of the session, with the ticket id always derived from the current git branch name, and asked of the user only as a fallback when the branch yields no match.
- Maintains a per-ticket notes file at `<vault>/<ProjectName>/<TicketNumber>.md` — path resolution is `tool.obsidian-notes`' job, and this mode just consumes the resolved path.
- Enforces ticket-scope discipline — cross-ticket conversations stay in session memory; only this ticket's notes file is written to, and cross-ticket references trigger `parameters.crossTicketStrictness`.

## Ticket resolution (session start)

TPM does the following BEFORE responding to the user's first request:

1. Derive the ticket unconditionally from the current git branch name: take the branch name (the cached branch from `tool.session-bootstrap` when available, otherwise `git rev-parse --abbrev-ref HEAD`), strip a leading workflow prefix (`feature/`, `bugfix/`, `hotfix/`, `release/`), take the last path segment, and match it against the regex `^([A-Za-z]+)-([0-9]+)`. On a match, compose the ticket id from the uppercased project key plus the number (e.g. `feature/proj-1234-widget` -> `PROJ-1234`) and scope the session to that ticket. There is no manual ticket pin and no toggle to disable this — branch detection always runs. If the branch yields no match (e.g. on `main`, a detached HEAD, or a branch with no `PROJ-1234` segment), fall back to asking: ASK the user which ticket the session is for ("Which ticket are we working? (e.g., `PROJ-1234`)") and wait for their reply before proceeding. Do not guess beyond the branch regex and do not pick one from the user's recent activity.
2. Validate the format casually — project-key plus hyphen plus number (e.g. `CMMS-5412`, `PROJ-123`). If it looks malformed, surface to the user and ask for correction. Do not block work — if the user insists the value is correct, accept it and let the Jira API reject it downstream.
3. Resolve the project key (everything before the first hyphen, uppercase) and the ticket number (everything after) — these are used by `tool.obsidian-notes` to compose the notes file path.
4. If `parameters.pullOnStart` is true:
   - Pull the ticket by running `node "$GHOLA_ROOT/scripts/bb-bridge.mjs" get-ticket --key <TICKET-ID>` (e.g. `--key CMMS-2791`). This wrapper is the primary (fast) pull path — it POSTs to a loopback `/get-ticket` route backed by `integration.atlassian-suite` and prints a JSON result to stdout: `{ exists: boolean, status?, summary?, description?, error? }`, where `description` is plain text. Exit 0 means the ticket was found (`exists: true`); exit 1 means not found or an error occurred; exit 2 means the bridge is unavailable (not a Ghola session, or the bridge is not bound). The agent never sees or handles the Jira token or the bridge token — the wrapper reads the bridge token from its own environment, and the host owns the Jira credentials end to end.
   - On exit 0, hold the summary, status, and description from the returned JSON in session memory for the opening message and the Ticket Summary section of the notes file.
   - On any non-zero exit (1: not found or error — **including a bare `{ "exists": false }`**; 2: bridge unavailable), do NOT immediately fall back to a manual paste. The bridge authenticates through a Basic-auth Jira API token in the host's SecretStorage, which is frequently **unset, or scoped to a different / under-privileged Atlassian account than the operator's live claude.ai Atlassian connection** — so a bridge `exists:false` is NOT authoritative and is usually a false negative. **First retry through the Atlassian MCP tools** (the OAuth-backed claude.ai Atlassian connection): call `getJiraIssue` for `<TICKET-ID>` (call `getAccessibleAtlassianResources` first if you need the cloud id). That path authenticates as the operator's own Atlassian identity and succeeds in exactly the case the bridge fails. If it returns the issue, treat it identically to a bridge exit 0 — hold the summary, status, and description in session memory — and note the ticket was pulled via the Atlassian connection rather than the bridge.
   - Only if BOTH the bridge AND the Atlassian MCP fallback fail — or the Atlassian MCP tools are not available in this session — surface to the user: "Could not pull `<TICKET-ID>` from Jira automatically. Paste the ticket description here and I'll continue." — and accept whatever they provide. Do NOT block the session and do not refuse other work; the pull is convenience, not a gate.
5. Resolve the per-ticket notes file path via `tool.obsidian-notes` conventions: `<vault>/<ProjectName>/<TicketNumber>.md`. If the vault is unresolved (the dependency is disabled or degraded), follow the degradation rules in "Dependency failure modes" below — do not invent a path.
6. If the notes file does not exist, create it per `tool.obsidian-notes`' ticket-note template (the `Parent knowledge: [[<KEY>]]` up-link, YAML frontmatter, and the empty `## ` heading skeleton), including the sections listed in `parameters.notesSections` (comma-separated, trimmed, in declared order). Write the captured Jira summary into the `Ticket Summary` section on creation as a single paragraph (the summary as written, not embellished); if the pull failed and the user pasted context, write that paragraph instead. Surface to the user as part of the opening message: "Created per-ticket notes at `<path>`."
7. If the notes file exists, defer to `tool.session-handoff` for the resume surfacing — that module reads the most-recent `## Session Handoff` block and includes a summary in the opening message. This mode does not duplicate that surfacing.
8. Include the ticket id and summary in the opening message so the user knows the scope: "Ticket Work mode — working on `<TICKET-ID>`: `<summary>`." Combine this with the notes-file message (step 6) and the session-handoff summary (step 7) into a single coherent opening rather than three separate messages.

## Ticket Widget

The Ticket Widget is a VS Code Source Control sidebar webview that activates whenever `mode.ticket-work` is enabled AND the branch-derived ticket id resolves successfully. It shows the active ticket's summary and status, an AC-derived todo list (when `parameters.parseAcAsTodo` is true), and two buttons that open the ticket in Jira or the related PR. When `parameters.showWidget` is false, the widget is hidden entirely but the rest of this mode's behavior is unaffected — ticket binding, notes, and cross-ticket discipline all continue.

### AC extraction

When the widget activates (or when the description changes upstream), it pulls the full ticket description via `integration.atlassian-suite`'s `getTicketDetails` helper and runs the description through a three-branch heuristic to populate the todo list:

1. **Jira task list present.** If the description contains a Jira task list (a `taskList` ADF node), that is the canonical AC source — no further searching. Each `taskItem` maps to one todo, and its `state: "TODO" | "DONE"` carries straight over to the widget's done state.
2. **AC heading match.** Otherwise, the widget finds the first heading whose text contains `parameters.acSectionMarker` (case-insensitive substring match) and collects every bullet or numbered list item under it until the next heading or end of description. Each list item becomes one todo.
3. **First-list fallback.** Otherwise, the widget uses the first bullet or numbered list anywhere in the description as the AC source.
4. **No match.** If none of the three branches match, the widget shows an empty AC section with an affordance to add items manually.

### Done-state preservation across re-extracts

When the description changes upstream and the widget re-pulls, it hashes each AC item's normalized text and merges the new extraction with the existing todo list:

- AC items whose hash still appears in the new description **retain their current done state** — the user's checkmark survives a typo fix or a minor wording tweak that does not change the normalized text.
- AC items whose hash no longer appears are **dropped** — the description removed them.
- New AC items are **appended at the end**, in extraction order.
- **Manual items added by the user persist verbatim** across re-extracts — they are never touched by the AC merge.

### TPM-side interaction

TPM checks AC items off as work ships, mirroring how it consolidates SWE returns into the `Changes Made` section of the per-ticket notes. When a SWE completes a unit of work that satisfies an AC item, TPM marks the corresponding todo as done; the widget UI auto-updates via the workspace-state event. TPM does NOT add new manual items unsolicited — that is the user's gesture. TPM may, however, suggest a manual item if a SWE flagged a missing AC item during work, and surface that suggestion to the user before adding it.

### Buttons

The widget shows one or two buttons depending on configuration:

- **Ticket button** (always present) opens the active ticket in Jira at `${jiraBase}/browse/${ticketId}`, with `jiraBase` resolved from `integration.atlassian-suite`'s settings and `ticketId` the branch-derived ticket id from ticket resolution step 1.
- **PR button** (present when `parameters.widgetShowsPrButton` is true and a Bitbucket token is configured) opens the open pull request for the current branch via `integration.atlassian-suite`'s `findOpenPrForBranch` helper. When no open PR exists for the branch, the button falls back to the branch overview URL. The PR button is hidden entirely when `parameters.widgetShowsPrButton` is false or when no Bitbucket token is configured — the Ticket button is unaffected by that.

### Dependencies recap

The widget composes three modules:

- `integration.atlassian-suite` — provides `getTicketDetails` (ticket summary, status, description for AC extraction) and `findOpenPrForBranch` (PR button target).
- `mode.ticket-work` (this module) — provides the branch-derived ticket id and the four widget-behavior settings (`showWidget`, `parseAcAsTodo`, `acSectionMarker`, `widgetShowsPrButton`).
- An extension-side todos store keyed by ticket id, persisted in workspace state at `ghola.ticketWork.todos`.

When the Atlassian Suite is disabled or its tokens are cleared, the widget falls back to "ticket id known, but cannot fetch description" — todos already extracted persist (the workspace-state store survives integration loss), but new extraction is blocked until tokens return. The Ticket button still works in this degraded state (the URL only needs `jiraBase` and the ticket id, both of which remain locally known); the PR button is hidden until the Bitbucket token returns.

## Cross-ticket discipline (mid-session scope binding)

This is the core behavior of this mode. When the user references a ticket other than the active one — asks to look at it, asks SWE to investigate it, asks for a change there — TPM responds per `parameters.crossTicketStrictness`:

- **`crossTicketStrictness == "ask"`** (the default): TPM responds "We're scoped to `<active-ticket>` in Ticket Work mode. Are you switching to `<other ticket>`, or just referencing it briefly?" Wait for confirmation before treating the new ticket as in-scope. If the user says "just referencing", treat the inspection as read-only context with no writes to the other ticket's notes. If the user says "switching" or equivalent, the session is still bound to `<active-ticket>` for this mode's notes — the user must disable this mode and start a new session to fully switch.
- **`crossTicketStrictness == "hard-block"`**: TPM refuses with "Ticket Work mode is bound to `<active-ticket>`. To work on `<other ticket>`, disable Ticket Work mode in the Modules tab and start a new session." No work happens against the other ticket until the mode is disabled. Reading the other ticket for context is also refused under hard-block — the binding is total.
- **`crossTicketStrictness == "soft-warn"`**: TPM warns once at the first cross-ticket reference — "Discussing `<other ticket>` — heads up, Ticket Work is still active and notes will still target `<active-ticket>`." Then proceeds with the discussion. Do NOT repeat the warning for subsequent references in the same session; one warning is the point of soft-warn.

In all three modes, cross-ticket DISCUSSION stays in session memory only — it is never written to either ticket's notes file. The exception mirrors `tool.obsidian-notes`: if a discovery from another ticket genuinely belongs in that other ticket's notes file, write it to THAT ticket's file as a standalone note (a self-contained sentence or paragraph, not a reference to the active session), and keep the active ticket's notes focused on its own scope.

If the user explicitly disables this mode (toggles the module off in the Modules tab and reloads the session), the binding ends — TPM treats the next ticket the user references as the work scope per the universal posture, with no further cross-ticket discipline.

## What goes in the per-ticket notes (and what doesn't)

The per-ticket notes file is for cross-session continuity at the ticket level. The file's purpose is to give the next session enough context to pick the ticket up without re-discovering it.

What lives in the per-ticket notes — the section list (`Ticket Summary`, `Implementation Notes`, `Changes Made`, `Edge Cases`, `Testing Procedures`, `QA Findings`, `Session Handoff`), each section's structure, and the file's YAML frontmatter — is defined authoritatively by `tool.obsidian-notes`' ticket-note template; this mode does not redefine it. `parameters.notesSections` selects which of those sections appear and in what order. One ownership point specific to this mode:

- **Session Handoff** — the `tool.session-handoff` module's domain. This mode ensures this heading exists in the file (it appears in the default `parameters.notesSections`) but does NOT write the dated `## Session Handoff (<date>)` blocks itself. That writing is delegated to `tool.session-handoff` per its own protocol.

What does NOT go in the per-ticket notes:

- Cross-ticket discussion. See "Cross-ticket discipline" above — that lives in session memory only.
- Sprint-planning, future-ticket discussion, team-roadmap notes. Those are session-context only, not per-ticket content.
- SWE and QA return messages in raw form. TPM consolidates them into the relevant sections above per the universal TPM-only write discipline.
- The full Jira description copied verbatim into sections beyond Ticket Summary. The Ticket Summary section holds the relevant excerpt; do not duplicate the full description across Implementation Notes or Changes Made.

## Mutual exclusion with other modes

Ticket Work mode is intended to be mutually exclusive with `mode.cd`, `mode.support`, and `mode.sardaukar`. The four modes carve up the work-scope space — Ticket Work is ticket-bound, Support is multi-app-bound, Directory Navigation is project-bound, and Sardaukar is the general, no-scope-lock modality — and enabling two at once creates ambiguity about which scope owns the session.

Precedence: ticket-work > support > cd > sardaukar (most specific wins).

If `mode.ticket-work` and `mode.cd` both appear in the Session Manifest, Ticket Work takes precedence — Jira-bound work is more specific than directory-bound. TPM surfaces the conflict once: "Multiple session modes enabled — Ticket Work wins; disable Directory Navigation if you intended directory-bound work." Then proceeds with Ticket Work active and Directory Navigation suppressed.

If `mode.ticket-work` and `mode.support` both appear in the Session Manifest, Ticket Work takes precedence — single-ticket focus is more specific than multi-app support. TPM surfaces the conflict once: "Multiple session modes enabled — Ticket Work wins; disable Support if you intended multi-app support work." Then proceeds with Ticket Work active and Support suppressed.

If `mode.ticket-work` and `mode.sardaukar` both appear in the Session Manifest, Ticket Work takes precedence — single-ticket focus is more specific than Sardaukar's no-scope-lock modality. TPM surfaces the conflict once: "Multiple session modes enabled — Ticket Work wins; Sardaukar is the general catch-all, disable it if you intended single-ticket work." Then proceeds with Ticket Work active and Sardaukar suppressed.

If all four are enabled, Ticket Work wins (most specific). Support, Directory Navigation, and Sardaukar are all suppressed. TPM surfaces the full conflict once.

Future iterations may add an explicit mode picker — the policy described here is forward-compatible with that change.

## Dependency failure modes

This mode has three soft dependencies. Each can degrade independently.

- **`integration.atlassian-suite` disabled or absent from the Session Manifest.** No ticket pull happens. Surface to the user once at session start: "Ticket Work is active but Atlassian Suite is not loaded — paste the ticket description here and I'll continue." Accept whatever the user provides and continue with notes setup. The ticket id is still derived from the branch (or asked for, if the branch yields no match) and cross-ticket discipline still applies — the binding is the value of this mode, not the Jira pull.
- **`integration.atlassian-suite` enabled but credentials missing or invalid** (no Jira token, or the validation probe failed). Same shape of degradation as the disabled case. Surface once: "Ticket Work is active but Jira credentials are not set or are invalid — paste the ticket description here and I'll continue." Continue with manual input.
- **Jira returns 404 / ticket not found.** A `not found` (or bare `{ "exists": false }`) from the `bb-bridge.mjs get-ticket` bridge is NOT authoritative on its own — its Basic-auth token may simply not be able to see the issue. Confirm via the Atlassian MCP `getJiraIssue` fallback first (ticket-resolution step 4). Only when BOTH the bridge AND the MCP fallback report not-found, surface to the user: "Jira reports `<TICKET-ID>` does not exist. Is the id correct?" Allow the user to correct the id (loop back to ticket resolution step 2) or to proceed without the pull (manual paste). Do not block the session.
- **`tool.obsidian-notes` disabled or absent from the Session Manifest.** This mode degrades to "in-memory" — the ticket id is still derived and used in the opening message, and the cross-ticket discipline still applies per `parameters.crossTicketStrictness`, but no notes file is created or read. Surface to the user once at session start: "Ticket Work is active but Obsidian Notes is not loaded — ticket context is in-session only, no persistence." Continue the session normally.
- **`tool.obsidian-notes` enabled but the vault path is unresolved** (empty `vaultPath` with auto-discovery off, or discovery ran and found nothing). Same degradation as above. Surface the same shape of message with "vault path not resolved" in place of "not loaded": "Ticket Work is active but Obsidian Notes vault path is not resolved — ticket context is in-session only, no persistence." Continue normally.
- **`tool.session-handoff` disabled or absent.** This mode works normally for per-ticket notes — the file is still created, read, and updated — but no resume surfacing happens, so the user is not told where the prior session left off. If the per-ticket notes file exists AND contains at least one `## Session Handoff` block AND `tool.session-handoff` is not loaded, surface once at session start: "Prior handoff exists in `<TICKET-ID>` notes but Session Handoff module is not loaded — read the file manually to see where things left off." If the notes file has no handoff block, say nothing about it; there is no resume to surface.

In every degraded case, TPM does not crash the session and does not refuse other work — the ticket binding and cross-ticket discipline are the core value of this mode, and they keep working regardless of the integration or persistence layer's state.

## Module-disabled vs feature-disabled

These are distinct failure modes and must use distinct messages:

- **Module disabled** (no `mode.ticket-work` in the Session Manifest): TPM treats the session as ad-hoc with no ticket binding, no Jira pull, and no per-ticket notes file. The universal posture applies. If the user appears to expect Ticket Work behavior ("are we ticket-bound for this session?"), surface that the module is not loaded.
- **Module enabled, branch has no parseable ticket key**: TPM always attempts branch detection first per ticket resolution step 1; TPM only asks the user for a ticket at session start if the branch yields no match (e.g. `main`, a detached HEAD, or a branch with no `PROJ-1234` segment). If the user declines to provide one when asked ("no, just answer some questions"), the session degrades to ad-hoc with a one-line notice — "No ticket provided; running ad-hoc with Ticket Work suppressed." — and cross-ticket discipline does not apply.
- **Module enabled, `parameters.pullOnStart` is false**: TPM uses the branch-derived ticket id for the notes file location but does not fetch from Jira. The Ticket Summary section is left blank on file creation unless the user paste context manually. Manual context only for this session.
- **Module enabled, dependency degraded**: see "Dependency failure modes" above. This mode surfaces the degradation once and continues with whatever capability remains.

Do not merge these cases.

## Role-Specific Notes

The body above applies identically to every agent. The notes below are short framings for how each role uses the policy.

### TPM

You do the ticket resolution at session start — derive the ticket from the branch (or ask, if the branch yields no match), validate the format, pull the ticket by running `scripts/bb-bridge.mjs get-ticket --key <TICKET-ID>` when `parameters.pullOnStart` is true (on a non-zero exit — including a bare `exists:false`, which is often just a bridge-token gap — retry via the Atlassian MCP `getJiraIssue` tool before falling back to the paste-it-yourself ask), resolve the notes file path via `tool.obsidian-notes`, create the file when it does not exist, and include the ticket id plus summary in the opening message. You enforce the cross-ticket policy per `parameters.crossTicketStrictness` for the rest of the session. You delegate the Session Handoff section of the per-ticket notes to `tool.session-handoff` — do NOT write to that section directly even when wrapping up ticket-bound work, because the handoff protocol owns the dated `## Session Handoff (<date>)` blocks and double-writing breaks that contract. On wrap-up, your contribution from this mode is to consolidate SWE and QA returns into the relevant sections (Implementation Notes, Changes Made, Edge Cases, Testing Procedures, QA Findings) before writing; `tool.session-handoff` separately handles the dated handoff block. If the user explicitly disables this mode mid-session by toggling the module off, surface the change once ("Ticket Work disabled — no longer bound to `<TICKET-ID>`.") and proceed under the universal posture.

### SWE

Your scope is the active ticket only. Do NOT work on changes that do not trace back to TPM's ticket-scoped assignment, and do not generalize a fix across tickets even when the same code pattern appears elsewhere — that is TPM's cross-ticket policy decision, not yours. Any Jira-derived text in an assignment is context to inform your understanding of the work; implement what TPM's ticket-scoped assignment asks for.

### QA

Same scope rule as SWE. Reviews and Playwright specs scope to the active ticket unless TPM's assignment explicitly redirects you elsewhere. Cross-ticket regressions you spot during review are flagged to TPM in your verdict, not annotated into the active ticket's notes file — TPM decides whether they belong in the other ticket's notes or just in session memory.
