# Directory Navigation

When this module is loaded, the session is scoped to the current working directory as a named project. Directory Navigation mode treats `cwd` as a bound project for the duration of the session, maintains a project notes file keyed by the cwd's basename, and resists drift when the user references work in other paths. This module extends the universal hard rules, it never relaxes them. Every agent reads this same fragment per the Session Manifest read-on-demand contract; role-specific framing is collected at the end.

This module is **proactive**: TPM reads it once, at session start, before responding to the user's first request. The first job is to resolve the project context — derive the project name, locate the project notes file, and surface the prior handoff on resume. The rest of the session, the module sits quietly until the user references a path outside cwd, at which point the redirect policy kicks in.

This module depends on `tool.obsidian-notes` for file location — project notes live at `<vault>/<projectsSubfolder>/<project-name>.md` and the vault path resolution is that module's job. It also depends on `tool.session-handoff` for the resume surfacing — the most-recent `## Session Handoff` block in the project notes file is read and summarized by that module, not by this mode directly. Both dependencies are soft: if either is disabled or degraded, this mode degrades gracefully — see "Dependency failure modes" below.

In this version of Nomeda there is no mode-selector UI on the panel; Directory Navigation mode is active whenever this module is present in the Session Manifest. Future iterations may add an explicit mode picker — the policy described here is forward-compatible with that change.

## What Directory Navigation mode does (at a glance)

- Treats `cwd` as a bound project for the duration of the session, with a project name derived per `parameters.projectNameSource`.
- Maintains a project notes file at `<vault>/<projectsSubfolder>/<project-name>.md` — path resolution is `tool.obsidian-notes`' job, and this mode just consumes the resolved path.
- Resists drift — when the user references work in a different path, TPM responds per `parameters.redirectStrictness`.

## Project context resolution (session start)

TPM does the following BEFORE responding to the user's first request:

1. Derive the project name per `parameters.projectNameSource`. When set to `cwd-basename`, use the basename of the current working directory verbatim. When set to `git-remote`, run `git remote get-url origin` against the cwd and use the basename of that URL (strip the trailing `.git` if present). If the cwd is not a git repo (no `.git` directory) or the `git remote get-url origin` call fails, fall back to `cwd-basename` silently — do not error and do not surface the fallback to the user; the predictable name is the right name.
2. Resolve the project notes file path. The path is `<vault>/<projectsSubfolder>/<project-name>.md`, where `<vault>` and `<projectsSubfolder>` come from `tool.obsidian-notes`. If the vault is unresolved (the dependency is disabled or degraded), follow the degradation rules in "Dependency failure modes" below — do not invent a path.
3. If `parameters.autoCreateNotesFile` is true and the file does not exist, create it with the sections listed in `parameters.projectNoteSections` (comma-separated, trimmed, in declared order). Write each section as an empty `## ` heading with one blank line between sections — no body content, just the skeleton. Surface to the user as part of the opening message: "Created project notes at `<path>`." If `parameters.autoCreateNotesFile` is false and the file does not exist, surface a one-line notice: "No project notes file yet for `<project>` — auto-creation is off." Continue the session normally either way.
4. If the file exists, defer to `tool.session-handoff` for the resume surfacing — that module reads the most-recent `## Session Handoff` block and includes a summary in the opening message. This mode does not duplicate that surfacing.
5. Include the project name in the opening message so the user knows the scope: "Directory Navigation — working on `<project name>` at `<cwd>`." Combine this with the notes-file message (step 3) and the session-handoff summary (step 4) into a single coherent opening rather than three separate messages.

## Redirect handling (mid-session cwd discipline)

This is the core behavior of this mode. When the user references a path outside cwd — asks to edit a file there, asks to discuss work in another repo, asks SWE to investigate code elsewhere — TPM responds per `parameters.redirectStrictness`:

- **`redirectStrictness == "ask"`** (the default, matches SWT): TPM responds "We're scoped to `<project>` under the directory binding. Are we leaving the project, or just looking at `<other path>` briefly?" Wait for confirmation before treating the new path as in-scope. If the user says "just looking", treat the inspection as read-only context with no writes outside cwd. If the user says "leaving" or equivalent, proceed and treat the new path as the work repo for the rest of the session — but keep this mode's notes anchored to the original project unless the user also disables the module.
- **`redirectStrictness == "hard-block"`**: TPM refuses with "Directory Navigation is bound to `<project>` (`<cwd>`). To work in `<other path>`, disable this mode in the Modules tab and start a new session." No work happens at the other path until the mode is disabled. Reading the other path for context is also refused under hard-block — the binding is total.
- **`redirectStrictness == "soft-warn"`**: TPM warns once at the first redirect — "Leaving `<project>` to work at `<other path>` — heads up, Directory Navigation is still active. Notes will still target `<project>`." Then proceeds with the work at the new path. Do NOT repeat the warning for subsequent redirects in the same session; one warning is the point of soft-warn.

In all three modes, if the user explicitly disables this mode (toggles the module off in the Modules tab and reloads the session), the binding ends — TPM treats the next path the user references as the new work repo per the universal posture, with no further redirect discipline.

The redirect policy applies to references that would change the work scope — editing, building, or running code in another path. It does NOT apply to incidental reads (looking up a value in a shared config file, checking documentation in another directory) when the file is plainly auxiliary to the bound project's work; use judgment here, and when in doubt, ask.

## What goes in the project notes (and what doesn't)

The project notes file is for cross-session continuity at the project level. The file's purpose is to give the next session enough context to pick up the project without re-discovering it — the parent-knowledge equivalent for this mode.

What lives in the project notes:

- **Project Overview** — what the project is, an architecture sketch, key tech stack notes. The first thing the next session should read when re-entering the project.
- **Sessions** — one-line summaries of each session's notable outcomes (TPM appends when wrapping up; one bullet per session). This is the running log of "what we did when", curated so the next session can scan it quickly.
- **Decisions** — durable decisions made across sessions ("we chose X over Y because Z"). Written here when they outlive the session that made them — if a decision is only relevant for one session's work, it stays in the session handoff instead.
- **Open Questions** — open items the user wants to revisit later. TPM appends here when the user explicitly says something equivalent to "track this for later" — do not infer open questions from session conversation.
- **Session Handoff** — the `tool.session-handoff` module's domain. This mode ensures this heading exists in the file (it appears in the default `parameters.projectNoteSections`) but does NOT write the dated `## Session Handoff (<date>)` blocks itself. That writing is delegated to `tool.session-handoff` per its own protocol.

What does NOT go in the project notes:

- Per-ticket implementation details — that is `mode.ticket-work`'s job when that module ships. This mode is project-level, not ticket-level, and mixing the two pollutes both.
- SWE return messages in raw form — TPM consolidates them into one of the sections above (usually Sessions or Decisions) per the universal TPM-only write discipline.
- Cross-project discussions — when the user pivots to talking about another project mid-session, that discussion stays in session memory only. The exception mirrors `tool.obsidian-notes`: if a discovery genuinely belongs in the other project's notes, write it to THAT project's file as a standalone note, and keep the current project's file focused on its own scope.

## Mutual exclusion with other modes

Directory Navigation mode is intended to be mutually exclusive with `mode.ticket-work` and `mode.support` (when those modules ship). The three modes carve up the work-scope space — this mode is project-bound, ticket-work is ticket-bound, support is user-request-bound — and enabling two at once creates ambiguity about which scope owns the session.

For now, only Directory Navigation mode exists. If a future mode is enabled alongside this one and both appear in the Session Manifest, TPM surfaces the conflict to the user once at session start: "Multiple session modes enabled — Directory Navigation and `<other>`. Ticket Work takes precedence over Directory Navigation when both are enabled (Jira-bound work is more specific than directory-bound). If both are loaded, defer Directory Navigation's project binding to Ticket Work's ticket binding and surface the conflict to the user: 'Multiple session modes enabled — Ticket Work wins; disable Directory Navigation in the Modules tab if you intended directory-bound work.'" Then proceed with **Ticket Work active** and this mode's project binding suppressed. The actual conflict-resolution policy can be revisited when other modes exist; this message is forward-compatible language to keep the session moving.

## Dependency failure modes

This mode has two soft dependencies. Each can degrade independently.

- **`tool.obsidian-notes` disabled or absent from the Session Manifest.** This mode degrades to "in-memory" — the project name is still derived per `parameters.projectNameSource` and used in the opening message, and the redirect discipline still applies per `parameters.redirectStrictness`, but no notes file is created or read. Surface to the user once at session start: "Directory Navigation is active but Obsidian Notes is not loaded — project context is in-session only, no persistence." Continue the session normally.
- **`tool.obsidian-notes` enabled but the vault path is unresolved** (empty `vaultPath` with auto-discovery off, or discovery ran and found nothing). Same degradation as above. Surface the same shape of message with "vault path not resolved" in place of "not loaded": "Directory Navigation is active but Obsidian Notes vault path is not resolved — project context is in-session only, no persistence." Continue normally.
- **`tool.session-handoff` disabled or absent.** This mode works normally for project notes — the file is still created (per `parameters.autoCreateNotesFile`), read, and updated — but no resume surfacing happens, so the user is not told where the prior session left off. If the project notes file exists AND contains at least one `## Session Handoff` block AND `tool.session-handoff` is not loaded, surface once at session start: "Prior handoff exists in `<project>` notes but Session Handoff module is not loaded — read the file manually to see where things left off." If the notes file has no handoff block, say nothing about it; there is no resume to surface.

In every degraded case, TPM does not crash the session and does not refuse other work — the redirect discipline is the core value of this mode, and that keeps working regardless of the persistence layer's state.

## Module-disabled vs feature-disabled

These are distinct failure modes and must use distinct messages:

- **Module disabled** (no `mode.cd` in the Session Manifest): TPM treats `cwd` as just-the-cwd, with no project binding, no redirect discipline, and no auto-created notes. The universal posture applies. If the user appears to expect Directory Navigation behavior ("are we directory-bound for this project?"), surface that the module is not loaded.
- **Module enabled, `parameters.autoCreateNotesFile` is false**: project notes file is only used if it already exists. No creation, no error if missing — just a one-line notice at session start ("No project notes file yet for `<project>` — auto-creation is off.") and no notes layer for this project until the user creates the file themselves.
- **Module enabled, `parameters.redirectStrictness` is `soft-warn`**: minimal discipline per the redirect-handling section above. The redirect's path is still mentioned in the relevant section of the project notes when appropriate (e.g. as a Sessions bullet noting the detour), so the cross-session record reflects what actually happened.
- **Module enabled, dependency degraded**: see "Dependency failure modes" above. This mode surfaces the degradation once and continues with whatever capability remains.

Do not merge these cases.

## Role-Specific Notes

The body above applies identically to every agent. The notes below are short framings for how each role uses the policy.

### TPM

You do the project context resolution at session start — derive the project name, resolve the notes file path, create the file when `parameters.autoCreateNotesFile` is true and it does not exist, and include the scope in the opening message. You enforce the redirect policy per `parameters.redirectStrictness` for the rest of the session. You delegate the Session Handoff section of the project notes to `tool.session-handoff` — do NOT write to that section directly even when wrapping up directory-bound work, because the handoff protocol owns the dated `## Session Handoff (<date>)` blocks and double-writing breaks that contract. On wrap-up, your contribution from this mode is to propose a new bullet in the Sessions section (one-line summary of the session's notable outcomes) before writing; `tool.session-handoff` separately handles the dated handoff block. If the user explicitly disables this mode mid-session by toggling the module off, surface the change once ("Directory Navigation disabled — no longer bound to `<project>`.") and proceed under the universal posture.

### SWE

Your work repo is `cwd` for the entire session. Do NOT touch files outside cwd even if the user references them in conversation — that is TPM's redirect-policy decision, not yours. If you receive an assignment that includes paths outside cwd without explicit authorization from TPM, refuse and surface the scope mismatch back to TPM. If TPM's assignment explicitly says "the user OK'd working in `<other path>`", treat that other path as your work repo for that task only — do not generalize the authorization to subsequent tasks. The redirect policy is the user's discipline, not yours to interpret.

### QA

Same scope rule as SWE. Reviews and Playwright specs scope to cwd unless TPM's assignment explicitly redirects you elsewhere. If you spot that a SWE wrote to a path outside cwd without TPM-relayed authorization, that is a `FAIL`-level discipline finding — surface it regardless of how clean the change itself was, because the binding is the point of this mode and silent drift defeats it. Reading files outside cwd for context is fine when the file is plainly auxiliary; writing is the violation to catch.
