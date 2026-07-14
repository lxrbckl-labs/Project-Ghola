# Obsidian Notes

When this module is loaded, the agents have a durable knowledge base in the form of an Obsidian vault on disk. This module declares where that vault lives, how the vault path is resolved, and the write discipline that keeps notes consistent across roles — it extends the universal hard rules, it never relaxes them. Every agent reads this same fragment per the Session Manifest read-on-demand contract; role-specific framing is collected at the end.

This module is **proactive**: TPM reads it once, at session start, before responding to the user's first request. The first job is to read the resolved vault path. The second job, for the rest of the session, is to consolidate notes from SWE and QA into the right files. SWE and QA never write to the vault themselves — they report back to TPM and TPM writes.

## Configurable: vault location

`parameters.vaultPath` is the absolute path to the Obsidian vault root. It is the single source of truth for where the vault lives, and the agent never discovers the vault itself. There are exactly two ways the value gets there: the user types an absolute path into the Vault Path field, or the user clicks the host-side **Detect Vault** button in the Obsidian Notes panel, which scans for a directory containing a `.obsidian` marker and writes the first match into the setting. Both paths end at the same place — a value in `parameters.vaultPath` that the agent reads verbatim.

Vault resolution is therefore trivial for the agent — read `parameters.vaultPath` and branch on whether it is set:

- **`vaultPath` is set (non-empty).** Use it verbatim. Do not second-guess the path — however it got there, it is the path for this session. If it does not exist on disk, surface the failure to the user with a one-line instruction to fix `vaultPath` in the Modules tab (or re-run Detect Vault), and continue the session without notes (do not crash the session).
- **`vaultPath` is empty.** Obsidian notes are disabled for this session. TPM tells the user once: "No Obsidian vault set. Click Detect Vault in the Obsidian Notes panel to auto-detect it, or set Vault Path manually." Continue the session normally for everything else; this is not a fatal condition, it just means there are no notes this session.

A "session" here means a TPM-led run. The resolved vault path is held in session memory for the duration. The agent does not scan the disk, does not run `find`, and does not write the discovered path back into the manifest — vault detection is entirely host-side (the Detect Vault button), and the agent's only job is to read the setting.

## Vault structure conventions

The directory layout below is what this module expects to read from and write to. Each path is one **note type** with a fixed template and a frontmatter `type` (see "Note templates" and "Frontmatter schema" below); in each mode the structure is the same, what differs is which files are touched and when.

- `<vault>/<KEY>/<KEY>.md` — the **parent knowledge file** (frontmatter `type: project-knowledge`). Living, curated document about a project's architecture, conventions, gotchas, and key dependencies. One per project. Read it first when entering an existing project; update it when significant discoveries surface.
- `<vault>/<KEY>/<TICKET-ID>.md` — the **ticket notes** for ticket-work mode (frontmatter `type: ticket`). One per ticket. Holds work scoped to that ticket — the ticket summary, what was implemented, edge cases, QA findings, handoff state.
- `<vault>/Projects/<project-name>.md` — the **Directory Navigation project notes** (frontmatter `type: cd-project`), keyed by `<project-name>` derived per `mode.cd`'s `projectNameSource` setting — typically the cwd basename, but may be the git-remote basename when configured. One per project a Directory Navigation session has touched.
- `<vault>/Support/<APP>.md` — the **per-app knowledge file** for support mode (frontmatter `type: support-app`). One per app that `mode.support` has investigated with `parameters.knowledgeFilePerApp` enabled. Accumulates cross-session findings — known issues and their resolutions, gotchas, and investigation patterns — for that app. Only written when support mode is active AND the knowledge-file setting is on.
- In ad-hoc / unconstrained mode (no ticket, not directory-bound), **no notes are auto-written**. The vault is read-only by default in this mode. The user must say something equivalent to "log this to obsidian" before TPM writes anything — and when it does, the file still follows the template for its type.

### Naming and casing (deterministic)

Ticket notes and Directory Navigation notes live in two **deliberately separate namespaces**, keyed off two different identity sources, so the same repo worked both ways cannot land in one ambiguous place:

- **Ticket-work:** `<vault>/<KEY>/` where `<KEY>` is the Jira project key in UPPERCASE (everything before the first hyphen of the ticket id, uppercased — `mode.ticket-work` resolves it). The parent knowledge file is `<KEY>/<KEY>.md`; ticket files are `<KEY>/<TICKET-ID>.md`. `<TICKET-ID>` is the identifier as the user references it (e.g. `SWT-1234`).
- **Directory Navigation:** the project's single home under `<vault>/Projects/` — a file `Projects/<home>.md` or, once it outgrows a single file, a directory `Projects/<home>/` (see "Single home per project"). The home NAME and the home IDENTITY are separate: identity is the **canonical key** (the lowercase repo name from `git remote get-url origin`, `.git` stripped, basename fallback), written to frontmatter `project:` and used for matching; the home name (filename / `title`) follows a precedence that lets an established on-disk home keep its name. `mode.cd`'s `projectNameSource` selects `git-remote` (canonical, the default) or `cwd-basename`.

**Home-name + identity precedence (deterministic):** (0) an explicit `mode.cd` `parameters.projectHomeName` override wins outright; (1) else an existing on-disk home wins — a home is matched when its filename OR its frontmatter `project:` matches ANY of {the canonical key, the cwd basename, a `projectNicknames` token}, case-insensitive (plus the legacy basename regex `^<canonical>[-_]?[0-9]*$`); keep that established name — never auto-rename it, and never let a stale or divergent remote override it, so both its filename and its identity slug are kept; (2) else the canonical key names the home; (3) else the lowercase `basename(cwd)`. If two files both look like the home, TPM asks rather than guessing. Example: a directory renamed on disk to `Project-Ghola` whose origin remote still reads `.../Project-Legacy.git` (so the canonical key is the stale `project-legacy`) is still preserved by rule 1 via **cwd-basename affinity** — the existing home `Projects/Project-Ghola.md` matches the cwd basename `Project-Ghola` even though it matches neither the canonical key nor its own `project: project-ghola` slug against `project-legacy` — so the home stays `Project-Ghola` with `project: project-ghola`, and no second `project-legacy.md` is ever minted.

These namespaces never converge: one path is always under `<KEY>/`, the other always under `Projects/`. A repo worked both as a ticket and as a bound directory legitimately has both a `<KEY>/<KEY>.md` knowledge file and a `Projects/<home>.md` (or `Projects/<home>/`) home; the home MAY carry an optional `Related: [[<KEY>]]` wikilink when the user has mapped the two, but the paths are never duplicated and never merged. Given a ticket id you get exactly one path; given a cwd you get exactly one home.

## Single home per project

Each project has **exactly one home** under `Projects/`, in one of two shapes:

- a single file  `Projects/<home>.md`  (the default for small projects), or
- a directory    `Projects/<home>/`  with an index `Projects/<home>/<home>.md`  (once the project outgrows a single file — see "Overflow to a directory home").

Topical material about a project — build logs, design docs, brainstorms, sub-plans — does NOT get its own sibling file at the `Projects/` layer. It lives *inside* the project's one home: as a titled `##` section while the home is a single file, or as a subfile `Projects/<home>/<topic>.md` once the home is a directory. Sibling topical files at the `Projects/` layer (e.g. `Projects/<home>.md` next to `Projects/<home>-design.md`) are exactly the fragmentation this rule forbids; when TPM finds them it offers to fold them into the home (see "Tidying a project's notes" in `mode.cd`). This rule is amorphic — it holds for any project, with no hardcoded names. A home is tied together by its frontmatter `project` (the canonical identity key); the home's filename and `title` are its display name and need not equal that key.

### Clone families

Multiple working copies of one repo (clones in separate directories, often on different branches) share a single home. Their identity is the **canonical key** derived from `git remote get-url origin`, so clones with a common origin (e.g. `cmms0`, `cmms1`) collapse to one `cmms.md`, while a nested clone with its own remote (e.g. `cmms-api`) resolves to its own canonical and stays separate. Within the shared home:

- **Durable, project-wide knowledge is shared** — Project Overview and Open Questions describe the project, not a clone, and are written once (rewrite-in-place) regardless of which clone the session ran in.
- **Running and handoff entries are clone-tagged** — Sessions and Decisions bullets carry `(clone: <label> @ <branch>)` and handoff blocks carry `[clone: <label> @ <branch>]` on their heading (see "Date and bullet conventions"), so each entry's provenance is explicit in the shared file.
- The home's optional `clones` frontmatter field lists the known clone labels (basenames only) for the family.

Because one home is shared across clones, two clones open in separate sessions can write the same home file with no cross-session lock — **last write wins**. This is accepted, not guarded: the running-log sections are append-only (low clobber risk) and the durable sections are curated and rarely co-edited. When two sessions race on the same home, the later write is authoritative and there is no merge; the write-serialization guarantee in "TPM-only write discipline" covers only the fan-out within a single TPM turn, not concurrent sessions.

`mode.cd` drives the boot-time detection and the (user-approved) consolidation of separate per-clone files into the one home; consolidated files keep a `> Consolidated into [[<home>]]` pointer and a `consolidated_into` frontmatter marker, and are never deleted.

### Topical sidecars

Separate topic files about one project that sit as siblings under `Projects/` (e.g. `Projects/Project-Ghola.md` alongside `Projects/Ghola-Mode-Build-Log.md` and `Projects/Ghola-Mode-Design.md`) violate the single-home rule. Their identity signal is **name affinity** to the home — the filename contains the home name or a configured nickname, or the frontmatter `project:` matches, or the body clearly references the project. `mode.cd` detects them at boot in the same "Tidying a project's notes" offer as clone families and, on approval, **folds** each into the home: as a titled `## <Topic>` section while the home is a single file, or as a `Projects/<home>/<topic-slug>.md` subfile once the home is a directory. Each folded file keeps a `> Consolidated into [[<home>]]` pointer and a `consolidated_into` marker, and is never deleted. Over-detection is acceptable because every candidate is user-vetoed before anything moves.

### Overflow to a directory home

A single-file home is promoted to a directory home when it exceeds `mode.cd`'s `parameters.overflowThresholdLines` (default 500) OR `parameters.overflowThresholdKb` (default 50), whichever trips first. An already-oversized home (e.g. a 1000+ line file) is simply a promotion candidate on the next boot — the check is `size > threshold`, evaluated the same whether the file just crossed or was always large; TPM proposes promotion once per session and never promotes silently.

Promotion is **additive** (TPM cannot delete):

- `Projects/<home>.md` becomes the index `Projects/<home>/<home>.md`. The index keeps the frontmatter and the cd-project **spine** — `## Project Overview`, the append-only running logs `## Sessions` and `## Decisions` (clone tags intact), `## Open Questions`, the `## Session Handoff` blocks — plus a new `## Contents` index of subfile links. Running-log sections never spill; they stay in the index so resume and clone-tagged history live in one place.
- Large topical bodies spill to `Projects/<home>/<topic-slug>.md` subfiles (`type: cd-subfile`). A non-spine `##` section that itself exceeds ~150 lines may also spill.
- The old flat `Projects/<home>.md` gets a `> Moved to [[<home>/<home>]]` pointer and a `consolidated_into` marker, and is left in place for the user to remove.

The subfile slug is deterministic: lowercase the sidecar's H1 or filename stem, strip a leading `<home>`/nickname prefix, replace non-alphanumerics with `-`, collapse repeats (`Ghola-Mode-Build-Log.md` -> `build-log.md`); collisions get `-2`, `-3`. Promotion composes with the single-home rule — one file-home becomes one directory-home, and subfiles live inside it, never as `Projects/` siblings.

**Archiving accumulated running logs.** A directory-home index can itself keep growing past the threshold when its append-only running logs — chiefly the `## Session Handoff` blocks — accumulate over many sessions. When the index exceeds the threshold and the overage is running-log history (not topical bodies, which spill as subfiles), archive the OLDER blocks into a `handoffs-archive.md` cd-subfile, keeping the spine and the recent blocks in the index. The retention window is deterministic: keep every `## Session Handoff` block dated within the current and prior two calendar months (the ~60-day default) in the index, and move everything older to the archive, oldest-first, verbatim. This is additive and never destructive — the blocks are relocated, not rewritten or deleted; the archive subfile is indexed from `## Contents` like any other subfile, and (when this is also the first promotion) the old flat file still gets its `> Moved to` pointer. Archiving is a size-management move on append-only content: the handoffs are still never edited or overwritten, only carried to a subfile once they age out of the retention window.

### Consolidation scope (what is never touched)

Detection and consolidation — clone-family, topical-sidecar, and overflow alike — apply ONLY to the project-notes surface: `Projects/` (cd-project homes and their subfiles) and the ticket-note trees `<KEY>/`. Some vault areas are partitioned ON PURPOSE and are **never scanned, never candidates, never folded**, and the exclusion is applied to the scan set *before* any affinity or basename test runs:

- **`_AgentComms/`** — the cross-team switchboard (`_Switchboard.md`, `inbox-all.md`, and every `inbox-<team>.md` at the vault root). These are deliberately per-repo/per-team: every running agent instance needs its own inbox. A clone-family heuristic must NEVER decide that `inbox-cmms0` and `inbox-cmms1` are family `cmms` and merge them — per-team inboxes stay divided by design.
- **Any top-level vault directory whose name begins with `_`** is treated as an intentionally-partitioned area and skipped by the same rule (an allow-list posture: consolidation opts INTO `Projects/` and `<KEY>/`, rather than opting out of specific names). `Support/` is not under CD scope and is not consolidated today; it is a future-protection candidate if support notes ever grow a similar sibling problem.

The principle is amorphic: consolidation touches project knowledge and ticket notes only. Cross-team comms and any other intentionally-partitioned area are excluded regardless of name similarity.

## TPM-only write discipline

**Only TPM writes to Obsidian files.** SWE and QA never write to the vault, ever. This is the most important rule in this module and it is not negotiable.

The reason is concurrent-write safety. Multiple SWEs and a QA may run in parallel within a single TPM turn, and Obsidian files (the parent knowledge file especially) are shared across that fan-out. If two agents append to the same file concurrently, the result is interleaved garbage or a lost write. Funneling all writes through TPM serializes them.

The mechanics:

- SWE reports every change and finding in the standard return format. The one-sentence explanation, files-modified list, and any caveats are TPM's source material.
- QA reports findings in the verdict's Issues / Notes sections. Same source material, but from the review side.
- TPM consolidates both into the relevant notes file at the end of the turn (or sooner, if the turn is long and a checkpoint makes sense). TPM is the only role that calls Write or Edit against a path inside `<vault>/`.

If an agent other than TPM is about to write to a path under the resolved vault root, that is a bug. Stop and surface it. Reading vault files for context is fine for every role; writing is TPM-only.

## Note templates

**Whenever a notes file exists, it is fully templated.** There is no ad-hoc note structure: the moment TPM creates or writes to a file under the vault, that file carries the frontmatter (see "Frontmatter schema") and the fixed `##` skeleton for its type. Not every task needs a file — a one-line typo fix may warrant none, and ad-hoc mode auto-writes nothing — but any file that does exist is organized the same way every session. These four templates are the single authoritative source for that structure; the type sections below cite them rather than redefining them.

### `project-knowledge` — parent knowledge file

    ---
    title: SWT
    type: project-knowledge
    project: SWT
    created: 2026-07-13
    updated: 2026-07-13
    tags: [project, knowledge]
    ---

    # <ProjectName>

    ## Overview
    One paragraph: what this project is and the problem it solves.

    ## Architecture
    Major components, where they live, how they talk. Link source by path, do not paste code.

    ## Conventions
    Project-specific naming, layout, build flow not obvious from the source.

    ## Gotchas
    Known landmines, brittle areas, "looks wrong but is intentional" notes.

    ## Key Dependencies
    Dependencies and versions that materially shape the work.

    ## Tickets
    Append-only index: one [[TICKET-ID]] link per ticket note created under this project.

### `ticket` — ticket notes

    ---
    title: SWT-1234
    type: ticket
    project: SWT
    ticket: SWT-1234
    status: In Progress
    created: 2026-07-13
    updated: 2026-07-13
    tags: [ticket, SWT]
    ---

    # <TICKET-ID>

    Parent knowledge: [[<KEY>]]

    ## Ticket Summary
    What the ticket asks for, in TPM's words. Write-once from the Jira summary.

    ## Implementation Notes
    Append-only dated log: "- YYYY-MM-DD: decision / alternative considered / why."

    ## Changes Made
    Cumulative, one bullet per changed file path; update that file's bullet in place on re-change.

    ## Edge Cases
    Append-only standalone bullets flagged by SWE or QA.

    ## Testing Procedures
    Rewrite-in-place: the current best manual/automated verification steps.

    ## QA Findings
    Append-only dated block per QA pass: "- YYYY-MM-DD (QA PASS|FAIL):" with nested findings.

    ## Session Handoff
    Owned by tool.session-handoff. Dated "## Session Handoff (YYYY-MM-DD)" blocks are appended
    at the bottom of the file; this heading is the anchor, not written into directly.

### `cd-project` — Directory Navigation project home

    ---
    title: Project-Ghola          # home display name (= filename basename)
    type: cd-project
    project: project-ghola        # canonical identity key (lowercase); matching keys on this
    clones: [cmms0, cmms1]        # optional, clone families only (basenames); omit otherwise
    created: 2026-07-13
    updated: 2026-07-13
    tags: [cd-project]
    ---

    # <home>

    ## Project Overview
    What the project is, an architecture sketch, key tech stack. First thing to read on re-entry.

    ## Sessions
    Append-only dated bullets, clone-tagged when a clone family:
    "- YYYY-MM-DD (clone: cmms0 @ feature/login): notable outcomes of the session."

    ## Decisions
    Append-only bullets, clone-tagged when a clone family:
    "- YYYY-MM-DD (clone: cmms0 @ feature/login): decision and rationale."

    ## Open Questions
    Mutable list: append when raised; on resolution edit the bullet in place to append
    " -- resolved YYYY-MM-DD: <answer>" (never delete -- preserve the record).

    ## Contents
    Present only once the home is a directory: append-only [[<home>/<topic-slug>]] links to subfiles.

    ## Session Handoff
    Owned by tool.session-handoff. Dated blocks appended at the bottom; clone-tagged in the heading
    as "## Session Handoff (YYYY-MM-DD) [clone: cmms0 @ feature/login]" for clone families.

### `cd-subfile` — a topical subfile inside a directory home

    ---
    title: Build Log
    type: cd-subfile
    project: project-ghola        # same canonical identity as the parent home
    parent: Project-Ghola         # the home's display name
    created: 2026-07-13
    updated: 2026-07-13
    tags: [cd-subfile]
    ---

    # Build Log

    Parent: [[Project-Ghola/Project-Ghola]]

    <topical body -- build log, design doc, brainstorm, or sub-plan for this project>

### `support-app` — per-app knowledge file

    ---
    title: CMMS
    type: support-app
    app: CMMS
    created: 2026-07-13
    updated: 2026-07-13
    tags: [support, CMMS]
    ---

    # <APP>

    ## Overview
    What the app is, its role, where the repo lives.

    ## Architecture and Dependencies
    Non-obvious structure; upstream/downstream services it talks to.

    ## Known issues and resolutions
    Append-only dated log of past support issues and how each was resolved:
    "- YYYY-MM-DD: issue class / symptom -> the fix that worked."

    ## Gotchas and Quirks
    Append-only curated bullets; prune only when proven wrong.

    ## Investigation Patterns
    Append-only bullets: recurring issue class -> fastest path to confirm it.

    ## Related Apps
    Append-only [[APP]] wikilinks for cross-app findings.

### Applying a template to a pre-existing file

Older notes files predate these templates and may have no frontmatter or a different set of headings. Migration is **additive and never destructive**: on the next write to such a file, add the frontmatter block only if it is absent (fill `created` from the file's earliest known date, otherwise today), and append any missing skeleton headings without reordering, rewriting, or deleting existing content. Never rewrite a historical body to match the template — only add what is missing.

## Frontmatter schema

When `parameters.writeFrontmatter` is true (the default), every notes file opens with a YAML frontmatter block. All types share `title`, `type`, `created`, `updated`, and `tags`; each type adds a few fields, as shown in the templates above:

- **`project-knowledge`** adds `project` (the `<KEY>`).
- **`ticket`** adds `project`, `ticket` (the `<TICKET-ID>`), and `status` (the Jira status).
- **`cd-project`** adds `project` (the canonical identity key) and, for clone families only, an optional `clones` list (clone basenames only — branches are volatile and live in the body tags, not here).
- **`cd-subfile`** adds `project` (the parent home's canonical identity) and `parent` (the home's display name).
- **`support-app`** adds `app` (the `<APP>`).

For `cd-project` and `cd-subfile`, `project` is the **canonical identity** (lowercase, used for matching and consolidation) while `title` is the **display name** (the home's filename) — the two may differ (see "Naming and casing"). A file that has been folded into a home carries a `consolidated_into: <canonical>` marker in its frontmatter so future detection skips it; TPM never removes such files (it cannot delete), it only leaves the marker and a pointer.

Two fields have strict rules:

- **`created` is write-once.** It is set to the current date when the file is first created and is never edited again.
- **`updated` is bumped on every write.** Whenever TPM writes to the file, it sets `updated` to the current date as part of the same edit. This is part of the write path and is not optional.

Both dates use `YYYY-MM-DD`, matching the running-note and handoff date format. `tags` is a YAML flow list (`[a, b]`). When `parameters.writeFrontmatter` is false, the skeleton and all other conventions still apply; only the frontmatter block is omitted.

## Wikilink conventions

Notes interlink with a single deterministic rule: **each child links up to its parent, and the parent keeps an append-only index of its children.** Nothing else is auto-linked.

- **Ticket note -> knowledge file.** Every ticket note carries exactly one `Parent knowledge: [[<KEY>]]` line directly under its H1. `<KEY>` is the knowledge file's basename, guaranteed by the naming rule.
- **Knowledge file -> ticket notes.** The knowledge file's **Tickets** section holds an append-only `- [[<TICKET-ID>]]` bullet, added when a ticket note is created under that project. Never reorder or remove these.
- **Related tickets.** A cross-ticket standalone note (written per `tool.cross-ticket-isolation`) MAY reference `[[<OTHER-TICKET>]]` inline, but stays self-contained — no active-session scope leaks into the other ticket's file.
- **CD project -> knowledge file.** A `cd-project` note MAY carry an optional `Related: [[<KEY>]]` line, but only when the user has mapped that directory to a Jira project; by default a directory-scoped note has no such link.
- **Directory home internals.** Once a home is a directory, each `cd-subfile` carries exactly one `Parent: [[<home>/<home>]]` line under its H1 (path form, because the old flat file and the index share the basename `<home>.md`), and the index's **Contents** section holds append-only `- [[<home>/<topic-slug>]]` links to the subfiles.
- **Consolidation pointers.** A file folded into a home keeps `> Consolidated into [[<home>]]` at its top; a flat home promoted to a directory leaves `> Moved to [[<home>/<home>]]` at the top of the old flat file. Both pointers are additive and the old files are retained, never deleted.
- **Support -> support.** The **Related Apps** section links `[[<OTHER-APP>]]` for cross-app findings.

## Update discipline

Each section is written in exactly one of three disciplines, so notes neither bloat without bound nor silently lose history:

- **skeleton-then-fill** — the heading is written empty at file creation and filled in once work produces content.
- **rewrite-in-place** — a curated current-state view; TPM edits it in place rather than accumulating entries, so it cannot bloat.
- **append-only** — dated or standalone bullets that are never rewritten, so history is preserved while each entry stays lean.

| Note type | Section | Discipline |
|-----------|---------|-----------|
| project-knowledge | Overview / Architecture / Conventions / Gotchas / Key Dependencies | rewrite-in-place |
| project-knowledge | Tickets | append-only (wikilinks) |
| ticket | Ticket Summary | write-once |
| ticket | Implementation Notes | append-only (dated) |
| ticket | Changes Made | cumulative-by-file (append per new file; edit that file's bullet in place on re-change) |
| ticket | Edge Cases | append-only |
| ticket | Testing Procedures | rewrite-in-place |
| ticket | QA Findings | append-only (dated blocks) |
| ticket / cd-project | Session Handoff | append-only dated blocks (owned by tool.session-handoff) |
| cd-project | Project Overview | rewrite-in-place |
| cd-project | Sessions | append-only (dated, clone-tagged for clone families) |
| cd-project | Decisions | append-only (dated, clone-tagged for clone families) |
| cd-project | Open Questions | mutable: append on raise, edit in place to resolve (never delete) |
| cd-project | Contents | append-only (subfile wikilinks; directory homes only) |
| cd-subfile | body | rewrite-in-place (curated topical content) |
| support-app | Overview / Architecture and Dependencies | rewrite-in-place |
| support-app | Known issues and resolutions | append-only (dated) |
| support-app | Gotchas and Quirks / Investigation Patterns / Related Apps | append-only |

Curated sections (rewrite-in-place, write-once) hold the current truth and never grow into a log; running-log sections (append-only) preserve the full history but as lean dated bullets. The parent knowledge file is entirely curated — it is a curated document, not a log. Session Handoff blocks stay append-only even under overflow archiving (see "Overflow to a directory home"): when a directory-home index ages its oldest handoffs out into `handoffs-archive.md`, that is a size-management relocation, not a rewrite — the blocks move verbatim and are never overwritten.

## Date and bullet conventions

- **Dates** use `YYYY-MM-DD` everywhere — running-note entries, dated bullets, and the handoff heading (which draws the same format from `tool.session-handoff`'s `dateFormat`).
- **Bullets** are hyphen (`-`) bullets, one level, with detail nested one indent under a dated parent bullet.
- **Dated running entries** (Implementation Notes, CD Sessions, CD Decisions) read `- YYYY-MM-DD: <entry>`.
- **Clone tags** mark which working copy an entry came from in a shared clone-family home: append `(clone: <label> @ <branch>)` inside the dated running bullet — `- YYYY-MM-DD (clone: cmms0 @ feature/login): <entry>` — where `<label>` is the clone's `basename(cwd)` and `<branch>` is its current branch (`detached@<short-sha>` when detached). A migrated historical entry whose branch is unknown uses the label alone: `- YYYY-MM-DD (clone: cmms0): <entry>`.
- **Handoff headings** in a clone-family home carry the same tag in brackets: `## Session Handoff (YYYY-MM-DD) [clone: cmms0 @ feature/login]`. The heading is owned by `tool.session-handoff` (which appends the suffix from clone context `mode.cd` supplies); its resume matcher keys on the `## Session Handoff (` prefix so the suffix is tolerated.
- **QA Findings** use a dated parent bullet with nested findings:

        - 2026-07-13 (QA FAIL):
          - Null tenant-id on first login still crashes; repro at src/auth/login.ts:88

- **Ordering** is newest-last (chronological), matching both the handoff blocks and the ghola ledger's history convention.

## Parent knowledge file

The parent knowledge file (`<vault>/<KEY>/<KEY>.md`, `type: project-knowledge`) is the long-lived memory for a project. It is the first file to read when entering an existing project and the last file to update at the end of a significant turn. Its skeleton is the `project-knowledge` template under "Note templates"; the sections and what each holds:

- **Overview** — one paragraph: what this project is and the problem it solves.
- **Architecture** — major components, where they live, how they talk. Link source by path; do not paste code.
- **Conventions** — project-specific naming, layout, build flow, anything not obvious from the source.
- **Gotchas** — known landmines, brittle areas, "this looks wrong but is intentional" notes.
- **Key Dependencies** — dependencies and their versions, when they materially shape the work.
- **Tickets** — an append-only index of `[[TICKET-ID]]` links, one per ticket note created under this project (see "Wikilink conventions").

What does NOT go in it:

- Per-ticket implementation detail — that belongs in the ticket notes.
- Speculative future plans — only write what is true now.
- Verbose code dumps — link to source files by path; do not copy them in.

Every section here is **rewrite-in-place** (curated current state), never a dated log — see "Update discipline". Update the file when a significant discovery surfaces — a new convention, a non-obvious gotcha, a structural change. Not for every minor detail; this is a curated document, not a log. If TPM is unsure whether something rises to "significant," err on the side of leaving it out and revisiting next turn.

## Ticket and project notes

Ticket notes (ticket-work mode) and Directory Navigation project notes (`mode.cd`) are the working notes for a unit of work. They are **distinct note types with distinct templates** — do not give one the other's sections.

### Ticket notes

Ticket notes (`type: ticket`) follow the `ticket` template under "Note templates". The section order is fixed and matches `mode.ticket-work`'s `notesSections` default; the sections and what each holds:

- **Ticket Summary** — what the ticket asks for, in TPM's own words. Write-once from the Jira summary.
- **Implementation Notes** — an append-only dated log of decisions, alternatives considered, why one path was taken over another.
- **Changes Made** — the file-by-file summary, consolidated from SWE return messages: one bullet per changed file, updated in place when that file changes again.
- **Edge Cases** — append-only bullets the SWE or QA flagged that warrant attention even if they did not block the work.
- **Testing Procedures** — rewrite-in-place: the current best manual/automated verification steps.
- **QA Findings** — the QA verdict's Issues and Notes, consolidated as an append-only dated block per QA pass.
- **Session Handoff** — an anchor heading only; the dated `## Session Handoff (<date>)` blocks under it are owned and written by `tool.session-handoff`. This module does not duplicate that block's shape — see that module for it.

### Directory Navigation project notes

Directory Navigation project notes (`type: cd-project`) follow the `cd-project` template under "Note templates". The section order matches `mode.cd`'s `projectNoteSections` default; the sections and what each holds:

- **Project Overview** — what the project is, an architecture sketch, key tech stack. The first thing the next session reads on re-entry.
- **Sessions** — append-only dated bullets, one per session, summarizing that session's notable outcomes.
- **Decisions** — append-only bullets, each a dated decision and its rationale.
- **Open Questions** — a mutable list: append when raised, and on resolution edit the bullet in place to append the answer rather than deleting it.
- **Session Handoff** — an anchor heading only; the dated blocks under it are owned by `tool.session-handoff`, as above.

Not every section carries content every turn, but the skeleton is always written in full on file creation (empty headings), so the structure is identical across sessions — see "Update discipline". A one-line typo fix may not warrant a notes file at all; but when a file exists, it always follows its template.

**Cross-ticket discussion stays in session context only.** When the user talks about ticket A while working on ticket B, that conversation is in-session memory and is not written to either ticket's notes file. The exception is when a discovery from ticket A genuinely belongs in ticket A's notes — in that case, write the discovery to ticket A's file as a self-contained note, not as a reference to the ticket B conversation. When `tool.cross-ticket-isolation` is loaded, its settings are authoritative for this routing and this paragraph defers to it.

## Module-disabled vs feature-disabled

These are distinct failure modes and must use distinct messages:

- **Module disabled** (no `tool.obsidian-notes` in the Session Manifest): TPM does NOT manage Obsidian notes for this session. No reads, no writes. Knowledge persistence falls back to in-session memory only. If the user appears to expect notes behavior ("did you log that to obsidian?"), surface that the module is not loaded.
- **Module enabled, `vaultPath` empty**: Obsidian notes are disabled for the session. Tell the user once ("No Obsidian vault set. Click Detect Vault in the Obsidian Notes panel to auto-detect it, or set Vault Path manually.") and continue the session normally for everything else.
- **Module enabled, `vaultPath` is set but the path does not exist on disk**: surface the failure with a one-line instruction to fix `vaultPath` (or re-run Detect Vault) and continue the session without notes. The user (or the Detect Vault button) supplied a path, and a path that does not exist is a configuration mistake to flag, not to paper over.

Do not merge these cases.

## Role-Specific Notes

The body above applies identically to every agent. The notes below are short framings for how each role uses the policy.

### TPM

You are the policy-bearer for this module: you do all the writes and you consolidate SWE and QA reports into the notes. You do NOT discover the vault — vault detection is host-side (the Detect Vault button writes the path into the setting). On every session start with this module loaded, read `parameters.vaultPath`: if it is set, use it verbatim; if it is empty, tell the user once ("No Obsidian vault set. Click Detect Vault in the Obsidian Notes panel to auto-detect it, or set Vault Path manually.") and run the rest of the session without notes. Surface the resolved path (or the empty-vault notice) to the user as part of your opening message so they know what the session is using. Never scan the disk, run `find`, or write a discovered path back into the manifest — that mechanism is retired. During the turn, consolidate SWE and QA returns into the relevant notes file yourself — do not delegate writes to a SWE even if the file is small, and do not tell QA to "just add it to the notes." The write funnel is the point of this module.

### SWE

You never write to Obsidian. Not the parent knowledge file, not per-ticket notes, not Directory Navigation mode project notes — TPM does all of that from your return message. Include every change and finding in your one-sentence explanation, files-modified list, and any caveats; that is TPM's source material for the notes consolidation. If you encounter a path under the resolved vault root in an assignment, you may READ it for context (the parent knowledge file is often genuinely useful before starting work in an existing project), but you must not Write or Edit against it. If a task seems to require you to write notes yourself, refuse and surface to TPM — do not work around the discipline.

### QA

Same write discipline as SWE: findings go back to TPM in the verdict, not to the notes file directly. If you spot that a SWE wrote to a path under the resolved vault root, that is a `FAIL`-level finding — surface it as a discipline violation regardless of the content quality of the write, because the write funnel exists to prevent concurrent-write damage and "this particular write was fine" is not the right frame. Reading vault files during review is fine and often useful. Cross-check the SWE's reported changes against what TPM is about to consolidate into the notes — if the SWE's one-sentence explanation undersells a meaningful change, flag it so TPM's notes are accurate.
