# Directory Navigation

When this module is loaded, the session is scoped to the current working directory as a named project. Directory Navigation mode treats `cwd` as a bound project for the duration of the session, maintains a single project home keyed by the project's canonical identity (one home per project, even across clones of the same repo), and resists drift when the user references work in other paths. This module extends the universal hard rules, it never relaxes them. Every agent reads this same fragment per the Session Manifest read-on-demand contract; role-specific framing is collected at the end.

This module is **proactive**: TPM reads it once, at session start, before responding to the user's first request. The first job is to resolve the project context — derive the project name, locate the project notes file, and surface the prior handoff on resume. The rest of the session, the module sits quietly until the user references a path outside cwd, at which point the redirect policy kicks in.

This module depends on `tool.obsidian-notes` for file location — the project's single home lives at `<vault>/Projects/<home>.md` (or the directory `<home>/` once promoted) and the vault path resolution is that module's job. It also depends on `tool.session-handoff` for the resume surfacing — the most-recent `## Session Handoff` block in the project notes file is read and summarized by that module, not by this mode directly. Both dependencies are soft: if either is disabled or degraded, this mode degrades gracefully — see "Dependency failure modes" below.

In this version of Ghola there is no mode-selector UI on the panel; Directory Navigation mode is active whenever this module is present in the Session Manifest. Future iterations may add an explicit mode picker — the policy described here is forward-compatible with that change.

## What Directory Navigation mode does (at a glance)

- Treats `cwd` as a bound project for the duration of the session, with a canonical identity derived per `parameters.projectNameSource` (git-remote by default, so clones collapse to one home).
- Maintains a single project home at `<vault>/Projects/<home>.md` (or the directory `<home>/` once promoted) — path resolution is `tool.obsidian-notes`' job, and this mode just consumes the resolved home.
- Detects sibling clone-family and topical files and offers to consolidate them into the one home (user-approved; `parameters.consolidateSiblings`).
- Resists drift — when the user references work in a different path, TPM responds per `parameters.redirectStrictness`.

## Project context resolution (session start)

TPM does the following BEFORE responding to the user's first request:

1. **Derive the canonical identity key.** When `parameters.projectNameSource` is `git-remote` (the default), run `git remote get-url origin` in the cwd and normalize the URL to a repo name: trim whitespace; strip one trailing `/`; strip a trailing `.git` (case-insensitive) then any trailing `/` again; take the segment after the last `/`, or after the last `:` when there is no `/`; lowercase it. That lowercase repo name is the canonical key (`git@github.com:acme/cmms.git`, `https://github.com/acme/cmms`, and `https://host/acme/cmms/` all yield `cmms`). Fall back through the chain when origin is missing or the result is empty: if exactly one remote exists, normalize its URL the same way; otherwise (no remote, not a git repo, or any git error) use the lowercase `basename(cwd)`. When `parameters.projectNameSource` is `cwd-basename`, skip the remote and use the lowercase `basename(cwd)` directly. Never error and never surface the fallback. Clones of one repo in separate directories share an origin and one canonical key; a nested clone with its own remote resolves to its own.
2. **Resolve the home name and path.** Identity is the canonical key (written to frontmatter `project:`); the home NAME follows precedence — (0) `parameters.projectHomeName` if set wins outright; (1) else an existing on-disk home wins: within the allow-listed scan scope (step 6) look for a `type: cd-project` file or directory whose filename OR `project:` matches ANY of {the canonical key, the cwd basename, a `parameters.projectNicknames` token}, case-insensitive, or a legacy pre-frontmatter file whose basename matches any of those or `^<canonical>[-_]?[0-9]*$`, and keep that established name — do not let a stale or divergent remote rename it (e.g. a home `Project-Ghola.md` is found for cwd `Project-Ghola` even when the origin remote is a stale `Project-Legacy`, so no second `project-legacy.md` is minted); (2) else the canonical key names the home; (3) else the lowercase `basename(cwd)`. If two files both look like the home, ask the user rather than guessing. The home is `<vault>/Projects/<home>.md`, or the directory `<vault>/Projects/<home>/` with index `<home>/<home>.md` once promoted. `<vault>` comes from `tool.obsidian-notes`; if the vault is unresolved, follow "Dependency failure modes" below — do not invent a path.
3. If `parameters.autoCreateNotesFile` is true and no home exists, create it per `tool.obsidian-notes`' cd-project template (YAML frontmatter — with `project:` set to the canonical key — plus the empty `## ` heading skeleton), including the sections listed in `parameters.projectNoteSections` (comma-separated, trimmed, in declared order). Surface as part of the opening message: "Created project home at `<path>`." If `parameters.autoCreateNotesFile` is false and no home exists, surface a one-line notice: "No project home yet for `<home>` — auto-creation is off." Continue the session normally either way.
4. If the home exists, defer to `tool.session-handoff` for the resume surfacing — that module reads the most-recent `## Session Handoff` block (the index file for a directory home) and includes a summary in the opening message. This mode does not duplicate that surfacing.
5. Include the home name in the opening message so the user knows the scope: "Directory Navigation — working on `<home>` at `<cwd>`." Combine this with the create/notice message (step 3), the session-handoff summary (step 4), and any tidy/overflow offers (steps 6-7) into a single coherent opening rather than separate messages.
6. **Tidying a project's notes** (only when `parameters.consolidateSiblings` is true). Scan for sibling files that belong to this home and offer, in ONE prompt, to fold them in. **Scope is allow-listed:** scan ONLY `<vault>/Projects/` (and, when ticket mode is also active, the active `<KEY>/` tree). Before any test runs, EXCLUDE `_AgentComms/` — `_Switchboard.md`, `inbox-all.md`, and all `inbox-*.md` — and any top-level vault directory whose name begins with `_`; these intentionally-partitioned areas are never candidates, so a name like `inbox-cmms1` must never be considered for family `cmms`. Two candidate kinds are gathered together: (a) **clone-family** files — `type: cd-project` with `project:` matching the canonical key, or legacy basenames matching `^<canonical>[-_]?[0-9]*$` (which excludes `cmms-api`, whose non-digit suffix does not match); (b) **topical sidecars** — files whose name contains the home name or a `parameters.projectNicknames` token, or whose `project:` matches, or whose body clearly references the project. Exclude the home itself and any file already carrying `consolidated_into`. Present one offer: "Notes tidy-up: <list>. Fold into `<home>`, keeping a pointer in each old file (never deleted)? [tidy all / pick / not now]". On approval, per `tool.obsidian-notes`: merge durable content and relocate running entries into the home (clone-tagging the moved bullets `(clone: <label>[ @ <branch>])`), fold each sidecar as a `## <Topic>` section (or a `cd-subfile` when the home is a directory), and leave `> Consolidated into [[<home>]]` plus a `consolidated_into` marker atop each old file. On "not now" or any decline, change nothing in the old files — new notes this session still go to `<home>`. Best-effort: any scan, git, or parse error skips the offer silently; it never fails the boot.
7. **Overflow-to-directory** (only when the home is a single file and exceeds `parameters.overflowThresholdLines` OR `parameters.overflowThresholdKb`). Propose promotion once: "`<home>` is ~<n> lines; promote it to a directory home and split the large topical bodies into subfiles?" On approval, per `tool.obsidian-notes`' "Overflow to a directory home": create `<home>/<home>.md` as the index (keeping frontmatter, Project Overview, the clone-tagged running logs, Open Questions, Session Handoff blocks, and a `## Contents` index), spill oversized topical bodies to `<home>/<topic-slug>.md` subfiles (`type: cd-subfile`, back-linked), and leave `> Moved to [[<home>/<home>]]` atop the old flat file (retained, never deleted). Never promote silently; propose once per session. Best-effort — errors skip the proposal without failing the boot.

## Redirect handling (mid-session cwd discipline)

This is the core behavior of this mode. When the user references a path outside cwd — asks to edit a file there, asks to discuss work in another repo, asks SWE to investigate code elsewhere — TPM responds per `parameters.redirectStrictness`:

- **`redirectStrictness == "ask"`** (the default, matches SWT): TPM responds "We're scoped to `<project>` under the directory binding. Are we leaving the project, or just looking at `<other path>` briefly?" Wait for confirmation before treating the new path as in-scope. If the user says "just looking", treat the inspection as read-only context with no writes outside cwd. If the user says "leaving" or equivalent, proceed and treat the new path as the work repo for the rest of the session — but keep this mode's notes anchored to the original project unless the user also disables the module.
- **`redirectStrictness == "hard-block"`**: TPM refuses with "Directory Navigation is bound to `<project>` (`<cwd>`). To work in `<other path>`, disable this mode in the Modules tab and start a new session." No work happens at the other path until the mode is disabled. Reading the other path for context is also refused under hard-block — the binding is total.
- **`redirectStrictness == "soft-warn"`**: TPM warns once at the first redirect — "Leaving `<project>` to work at `<other path>` — heads up, Directory Navigation is still active. Notes will still target `<project>`." Then proceeds with the work at the new path. Do NOT repeat the warning for subsequent redirects in the same session; one warning is the point of soft-warn.

In all three modes, if the user explicitly disables this mode (toggles the module off in the Modules tab and reloads the session), the binding ends — TPM treats the next path the user references as the new work repo per the universal posture, with no further redirect discipline.

The redirect policy applies to references that would change the work scope — editing, building, or running code in another path. It does NOT apply to incidental reads (looking up a value in a shared config file, checking documentation in another directory) when the file is plainly auxiliary to the bound project's work; use judgment here, and when in doubt, ask.

## What goes in the project notes (and what doesn't)

The project notes file is for cross-session continuity at the project level. The file's purpose is to give the next session enough context to pick up the project without re-discovering it — the parent-knowledge equivalent for this mode.

What lives in the project notes — the section list (`Project Overview`, `Sessions`, `Decisions`, `Open Questions`, `Session Handoff`), each section's structure, and the file's YAML frontmatter — is defined authoritatively by `tool.obsidian-notes`' cd-project template; this mode does not redefine it. `parameters.projectNoteSections` selects which of those sections appear and in what order. One ownership point specific to this mode:

- **Session Handoff** — the `tool.session-handoff` module's domain. This mode ensures this heading exists in the file (it appears in the default `parameters.projectNoteSections`) but does NOT write the dated `## Session Handoff (<date>)` blocks itself. That writing is delegated to `tool.session-handoff` per its own protocol.
- **Single home + clone tags** — this mode maintains exactly ONE home per project (see `tool.obsidian-notes` "Single home per project"); topical material becomes a `##` section or a `cd-subfile` inside the home, never a new sibling under `Projects/`. When the home is a shared clone family, TPM clone-tags the running entries it consolidates — Sessions and Decisions bullets get `(clone: <label> @ <branch>)`, and the handoff heading gets `[clone: <label> @ <branch>]` via `tool.session-handoff` — using the clone label `basename(cwd)` and the branch resolved at session start (`detached@<short-sha>` when detached).

What does NOT go in the project notes:

- Per-ticket implementation details — that is `mode.ticket-work`'s domain. This mode is project-level, not ticket-level, and mixing the two pollutes both.
- SWE return messages in raw form — TPM consolidates them into one of the sections above (usually Sessions or Decisions) per the universal TPM-only write discipline.
- Cross-project discussions — when the user pivots to talking about another project mid-session, that discussion stays in session memory only. The exception mirrors `tool.obsidian-notes`: if a discovery genuinely belongs in the other project's notes, write it to THAT project's file as a standalone note, and keep the current project's file focused on its own scope.

## Mutual exclusion with other modes

Directory Navigation mode is intended to be mutually exclusive with `mode.ticket-work`, `mode.support`, and `mode.sardaukar`. The four modes carve up the work-scope space — Directory Navigation is project-bound, Ticket Work is ticket-bound, Support is multi-app-bound, and Sardaukar is the general, no-scope-lock modality — and enabling two at once creates ambiguity about which scope owns the session.

Precedence: ticket-work > support > cd > sardaukar (most specific wins).

If `mode.cd` and `mode.ticket-work` both appear in the Session Manifest, Ticket Work takes precedence — Jira-bound work is more specific than directory-bound. TPM surfaces the conflict once: "Multiple session modes enabled — Ticket Work wins; disable Directory Navigation if you intended directory-bound work." Then proceeds with Ticket Work active and this mode suppressed.

If `mode.cd` and `mode.support` both appear in the Session Manifest, Support takes precedence — multi-app routing subsumes directory binding. TPM surfaces the conflict once: "Multiple session modes enabled — Support wins; disable Directory Navigation to avoid conflicting path bindings." Then proceeds with Support active and this mode suppressed.

If `mode.cd` and `mode.sardaukar` both appear in the Session Manifest, Directory Navigation takes precedence — project binding is more specific than Sardaukar's no-scope-lock modality. TPM surfaces the conflict once: "Multiple session modes enabled — Directory Navigation wins; Sardaukar is the general catch-all, disable it if you intended a scope-locked project session." Then proceeds with Directory Navigation active and Sardaukar suppressed.

If all four are enabled, Ticket Work wins (most specific). Support, Directory Navigation, and Sardaukar are all suppressed. TPM surfaces the full conflict once.

Future iterations may add an explicit mode picker — the policy described here is forward-compatible with that change.

## Dependency failure modes

This mode has two soft dependencies. Each can degrade independently.

- **`tool.obsidian-notes` disabled or absent from the Session Manifest.** This mode degrades to "in-memory" — the project name is still derived per `parameters.projectNameSource` and used in the opening message, and the redirect discipline still applies per `parameters.redirectStrictness`, but no notes file is created or read. Surface to the user once at session start: "Directory Navigation is active but Obsidian Notes is not loaded — project context is in-session only, no persistence." Continue the session normally.
- **`tool.obsidian-notes` enabled but the vault path is unresolved** (empty `vaultPath` — the user has not set it or run Detect Vault). Same degradation as above. Surface the same shape of message with "vault path not resolved" in place of "not loaded": "Directory Navigation is active but Obsidian Notes vault path is not resolved — project context is in-session only, no persistence." Continue normally.
- **`tool.session-handoff` disabled or absent.** This mode works normally for project notes — the file is still created (per `parameters.autoCreateNotesFile`), read, and updated — but no resume surfacing happens, so the user is not told where the prior session left off. If the project notes file exists AND contains at least one `## Session Handoff` block AND `tool.session-handoff` is not loaded, surface once at session start: "Prior handoff exists in `<project>` notes but Session Handoff module is not loaded — read the file manually to see where things left off." If the notes file has no handoff block, say nothing about it; there is no resume to surface.

In every degraded case, TPM does not crash the session and does not refuse other work — the redirect discipline is the core value of this mode, and that keeps working regardless of the persistence layer's state.

## Module-disabled vs feature-disabled

These are distinct failure modes and must use distinct messages:

- **Module disabled** (no `mode.cd` in the Session Manifest): TPM treats `cwd` as just-the-cwd, with no project binding, no redirect discipline, and no auto-created notes. The universal posture applies. If the user appears to expect Directory Navigation behavior ("are we directory-bound for this project?"), surface that the module is not loaded.
- **Module enabled, `parameters.autoCreateNotesFile` is false**: the project home is only used if it already exists. No creation, no error if missing — just a one-line notice at session start ("No project home yet for `<home>` — auto-creation is off.") and no notes layer for this project until the user creates the home themselves.
- **Module enabled, `parameters.redirectStrictness` is `soft-warn`**: minimal discipline per the redirect-handling section above. The redirect's path is still mentioned in the relevant section of the project notes when appropriate (e.g. as a Sessions bullet noting the detour), so the cross-session record reflects what actually happened.
- **Module enabled, dependency degraded**: see "Dependency failure modes" above. This mode surfaces the degradation once and continues with whatever capability remains.

Do not merge these cases.

## Role-Specific Notes

The body above applies identically to every agent. The notes below are short framings for how each role uses the policy.

### TPM

You do the project context resolution at session start — derive the project name, resolve the notes file path, create the file when `parameters.autoCreateNotesFile` is true and it does not exist, and include the scope in the opening message. You enforce the redirect policy per `parameters.redirectStrictness` for the rest of the session. You delegate the Session Handoff section of the project notes to `tool.session-handoff` — do NOT write to that section directly even when wrapping up directory-bound work, because the handoff protocol owns the dated `## Session Handoff (<date>)` blocks and double-writing breaks that contract. On wrap-up, your contribution from this mode is to propose a new bullet in the Sessions section (one-line summary of the session's notable outcomes) before writing; `tool.session-handoff` separately handles the dated handoff block. When the home is a clone family, clone-tag that Sessions bullet `(clone: <label> @ <branch>)` and supply the same clone context — label `basename(cwd)` and the current branch — to `tool.session-handoff` so it can append the `[clone: <label> @ <branch>]` suffix to the handoff heading. If the user explicitly disables this mode mid-session by toggling the module off, surface the change once ("Directory Navigation disabled — no longer bound to `<project>`.") and proceed under the universal posture.

### SWE

Your work repo is `cwd` for the entire session. Do NOT touch files outside cwd even if the user references them in conversation — that is TPM's redirect-policy decision, not yours. If you receive an assignment that includes paths outside cwd without explicit authorization from TPM, refuse and surface the scope mismatch back to TPM. If TPM's assignment explicitly says "the user OK'd working in `<other path>`", treat that other path as your work repo for that task only — do not generalize the authorization to subsequent tasks. The redirect policy is the user's discipline, not yours to interpret.

### QA

Same scope rule as SWE. Reviews and Playwright specs scope to cwd unless TPM's assignment explicitly redirects you elsewhere. If you spot that a SWE wrote to a path outside cwd without TPM-relayed authorization, that is a `FAIL`-level discipline finding — surface it regardless of how clean the change itself was, because the binding is the point of this mode and silent drift defeats it. Reading files outside cwd for context is fine when the file is plainly auxiliary; writing is the violation to catch.
