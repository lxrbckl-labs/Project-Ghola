# Obsidian Notes

When this module is loaded, the agents have a durable knowledge base in the form of an Obsidian vault on disk. This module declares where that vault lives, how to find it if the user hasn't told you, and the write discipline that keeps notes consistent across roles — it extends the universal hard rules, it never relaxes them. Every agent reads this same fragment per the Session Manifest read-on-demand contract; role-specific framing is collected at the end.

This module is **proactive**: TPM reads it once, at session start, before responding to the user's first request. The first job is to resolve the vault path. The second job, for the rest of the session, is to consolidate notes from SWE and QA into the right files. SWE and QA never write to the vault themselves — they report back to TPM and TPM writes.

## Configurable: vault location

`parameters.vaultPath` is the explicit absolute path to the Obsidian vault root. `parameters.autoDiscoverVault` controls what happens when that path is empty. The two settings interact in three modes:

- **`vaultPath` is set (non-empty).** Use it verbatim. Do not run discovery. Do not second-guess the path — if the user typed it in, it is the path for this session. If it does not exist on disk, surface the failure to the user with a one-line instruction to fix `vaultPath` in the Modules tab, and continue the session without notes (do not crash the session and do not silently fall back to discovery).
- **`vaultPath` is empty AND `autoDiscoverVault` is true.** Run the discovery protocol below. Report the chosen path to the user. Use it for the session.
- **`vaultPath` is empty AND `autoDiscoverVault` is false.** Refuse all notes operations for the session with: "Cannot manage Obsidian notes: vault path is empty and auto-discovery is off. Set Vault Path in the Modules tab or enable Auto-Discover Vault." Continue the session normally for everything else; this is not a fatal condition, it just means there are no notes this session.

A "session" here means a TPM-led run. The resolved vault path is held in session memory for the duration, and on a clean single-vault discovery (or after the user picks from a multi-vault set) TPM writes that path back to the `vaultPath` setting's `default` value in `modules/tool.obsidian-notes/manifest.json` so the Modules tab reflects the discovery on the next render. This is a soft-persistence mechanism — see the caveat below for its limits. The module is forward-compatible with future runtime-write infrastructure (the proposal-gated MCP write-tool work is the right end-state); when that exists, this paragraph will change.

### Persistence caveat

The writeback only updates the manifest's `default`. The panel reads a saved value first and the manifest `default` second, so:

- If the user has previously saved a value to `vaultPath` via the Modules tab — even an empty string — that saved value wins forever and the manifest update has no visible effect for that user. Soft persistence is only visible to users who have never touched the field.
- This couples user-specific state (one developer's vault location) to module configuration (a file that would ship with the module if it were ever published). Acceptable in a single-user dev repo; fragile if the module is shared. Treat the writeback as a convenience for the current developer, not as durable configuration. The forward-compatible path remains a proper runtime-write API.

## Discovery protocol

When `vaultPath` is empty and `autoDiscoverVault` is true, TPM does the following at session start, before doing any other startup work:

1. Build the candidate-root list. Start with the built-in defaults and append anything in `parameters.searchRoots` (comma-separated, trimmed):
   - `~/Documents/Obsidian/`
   - `~/Obsidian/`
   - `/mnt/c/Users/<user>/Documents/Obsidian/`
   - `/mnt/c/Users/<user>/Obsidian/`
   - Plus each absolute path in `parameters.searchRoots`.
2. For each candidate root that exists on disk, use `find <root> -maxdepth 3 -type d -name .obsidian 2>/dev/null` to locate vault markers. A vault is the parent directory of any `.obsidian/` folder. Depth-limit the search — vaults are conventionally near the top of these roots and deeper sweeps are slow and noisy.
3. Deduplicate by absolute path. The result is the set of candidate vaults.
4. **Zero vaults found.** Surface to the user: "No Obsidian vault found in the standard locations. Set Vault Path in the Modules tab to your vault's absolute path, or add the parent directory to Additional Search Roots." Continue the session without notes — do not refuse to do work.
5. **Exactly one vault found.** Report it to the user as part of the opening message ("Using Obsidian vault at `<path>`."). Use it for the session. Then write the discovered absolute path back to `modules/tool.obsidian-notes/manifest.json` using the Edit tool — old_string `"default": ""` and new_string `"default": "<path>"`, scoped to the `vaultPath` setting's block so the match is unique. The manifest file watcher (250ms debounced) picks up the change and the Modules tab re-renders with the new default within that window. See the Persistence caveat under "Configurable: vault location" for what this writeback does and does not guarantee.
6. **Multiple vaults found.** Report all of them to the user and ask which to use. Do not pick silently — the user's vault choice is meaningful and a wrong guess pollutes notes. Continue the session without notes until the user replies. Once the user picks, use the chosen path for the session AND perform the same manifest writeback described in step 5 against the picked path; the writeback is part of the same opening flow, just deferred until the user replies.

Writeback only happens on the clean single-vault path (step 5) or after a user pick from a multi-vault set (step 6). Steps 4 (zero vaults found) and the explicit-`vaultPath` cases never trigger a writeback — there is nothing to persist in the zero-vault case, and an explicit `vaultPath` is already what the user typed in.

## Vault structure conventions

The directory layout below is what this module expects to read from and write to. In each mode, the structure is the same; what differs is which files are touched and when.

- `<vault>/<ProjectName>/<ProjectName>.md` — the **parent knowledge file** for the project. Living document about architecture, conventions, gotchas, and key dependencies. One per project. Read it first when entering an existing project; update it when significant discoveries surface.
- `<vault>/<ProjectName>/<TicketNumber>.md` — the **per-ticket notes** for ticket-work mode. One per ticket. Holds work scoped to that ticket — the ticket summary, what was implemented, edge cases, QA findings, handoff state.
- `<vault>/<parameters.projectsSubfolder>/<project-name>.md` — the **Directory Navigation mode project notes**, keyed by `<project-name>` derived per `mode.cd`'s `projectNameSource` setting — typically the cwd basename, but may be the git-remote basename when configured. One per project a Directory Navigation mode session has touched. Default subfolder is `Projects`.
- In ad-hoc / unconstrained mode (no ticket, not directory-bound), **no notes are auto-written**. The vault is read-only by default in this mode. The user must say something equivalent to "log this to obsidian" before TPM writes anything.

`<ProjectName>` is taken from the project context — usually the ticket project key or the repo name. `<TicketNumber>` is the ticket identifier as the user references it (e.g. `SWT-1234`). If TPM is unsure which project name to use, ask the user once rather than guessing.

## TPM-only write discipline

**Only TPM writes to Obsidian files.** SWE and QA never write to the vault, ever. This is the most important rule in this module and it is not negotiable.

The reason is concurrent-write safety. Multiple SWEs and a QA may run in parallel within a single TPM turn, and Obsidian files (the parent knowledge file especially) are shared across that fan-out. If two agents append to the same file concurrently, the result is interleaved garbage or a lost write. Funneling all writes through TPM serializes them.

The mechanics:

- SWE reports every change and finding in the standard return format. The one-sentence explanation, files-modified list, and any caveats are TPM's source material.
- QA reports findings in the verdict's Issues / Notes sections. Same source material, but from the review side.
- TPM consolidates both into the relevant notes file at the end of the turn (or sooner, if the turn is long and a checkpoint makes sense). TPM is the only role that calls Write or Edit against a path inside `<vault>/`.

If an agent other than TPM is about to write to a path under the resolved vault root, that is a bug. Stop and surface it. Reading vault files for context is fine for every role; writing is TPM-only.

## Parent knowledge file

The parent knowledge file (`<vault>/<ProjectName>/<ProjectName>.md`) is the long-lived memory for a project. It is the first file to read when entering an existing project and the last file to update at the end of a significant turn.

What goes in it:

- High-level architecture sketch — major components, where they live, how they talk.
- Conventions specific to this project — naming, layout, build flow, anything not obvious from the source.
- Gotchas — known landmines, brittle areas, "this looks wrong but is intentional" notes.
- Key dependencies and their versions, when they materially shape the work.

What does NOT go in it:

- Per-ticket implementation detail — that belongs in the per-ticket notes.
- Speculative future plans — only write what is true now.
- Verbose code dumps — link to source files by path; do not copy them in.

Update the parent knowledge file when a significant discovery surfaces — a new convention, a non-obvious gotcha, a structural change. Not for every minor detail; this is a curated document, not a log. If TPM is unsure whether something rises to "significant," err on the side of leaving it out and revisiting next turn.

## Per-ticket and per-project notes

Per-ticket files (ticket-work mode) and per-project files (Directory Navigation mode) are the working notes for a unit of work. Sections that may appear, in roughly the order they show up in the work:

- **Ticket Summary** — what the ticket asks for, in TPM's own words. Always present in ticket-work mode.
- **Implementation Notes** — running notes during execution. Decisions, alternatives considered, why one path was taken over another.
- **Changes Made** — the SWE's file-by-file summary, consolidated into the notes from return messages.
- **Edge Cases** — things the SWE or QA flagged that warrant attention even if they did not block the work.
- **Testing Procedures** — how the change was (or should be) verified. Manual steps, build/test commands, what to look for.
- **QA Findings** — the QA verdict's Issues and Notes sections, consolidated.
- **Session Handoff** — open threads, blocked items, what the next session needs to pick up. Written at the end of the turn when the work is not complete.

Not every section appears in every ticket — they are conditional on the work done. A read-only investigation may have only Implementation Notes and Session Handoff. A small typo fix may not warrant a notes file at all.

**Cross-ticket discussion stays in session context only.** When the user talks about ticket A while working on ticket B, that conversation is in-session memory and is not written to either ticket's notes file. The exception is when a discovery from ticket A genuinely belongs in ticket A's notes — in that case, write the discovery to ticket A's file as a self-contained note, not as a reference to the ticket B conversation.

## Module-disabled vs feature-disabled

These are distinct failure modes and must use distinct messages:

- **Module disabled** (no `tool.obsidian-notes` in the Session Manifest): TPM does NOT manage Obsidian notes for this session. No discovery, no reads, no writes. Knowledge persistence falls back to in-session memory only. If the user appears to expect notes behavior ("did you log that to obsidian?"), surface that the module is not loaded.
- **Module enabled, `vaultPath` empty, `autoDiscoverVault` false**: refuse notes operations with the message above ("Cannot manage Obsidian notes: vault path is empty and auto-discovery is off..."). Continue the session normally for everything else.
- **Module enabled, discovery runs and finds nothing**: surface the failure with the one-line instruction from the discovery protocol and continue the session without notes. Do not crash and do not refuse the entire session — notes are useful, not essential.
- **Module enabled, `vaultPath` is set but the path does not exist on disk**: surface the failure with a one-line instruction to fix `vaultPath` and continue the session without notes. Do not silently fall back to discovery — the user told you a path and a path that does not exist is a configuration mistake to flag, not to paper over.

Do not merge these cases.

## Role-Specific Notes

The body above applies identically to every agent. The notes below are short framings for how each role uses the policy.

### TPM

You are the policy-bearer for this module: you do the discovery, you do all the writes, you consolidate SWE and QA reports into the notes. On every session start with this module loaded, read `parameters.vaultPath` first — if it is set, use it; if it is empty AND `parameters.autoDiscoverVault` is true, run the discovery protocol before touching any other startup work; if it is empty AND auto-discovery is off, fire the refusal message and move on. Surface the chosen path (or the failure) to the user as part of your opening message so they know what the session is using. The manifest writeback on a single-vault discovery (or a user-picked single result) is part of this same opening turn — do it immediately, in the same flow that reports the path; do not defer it to later in the session, and do not wait for the user to ask. During the turn, consolidate SWE and QA returns into the relevant notes file yourself — do not delegate writes to a SWE even if the file is small, and do not tell QA to "just add it to the notes." The write funnel is the point of this module.

### SWE

You never write to Obsidian. Not the parent knowledge file, not per-ticket notes, not Directory Navigation mode project notes — TPM does all of that from your return message. Include every change and finding in your one-sentence explanation, files-modified list, and any caveats; that is TPM's source material for the notes consolidation. If you encounter a path under the resolved vault root in an assignment, you may READ it for context (the parent knowledge file is often genuinely useful before starting work in an existing project), but you must not Write or Edit against it. If a task seems to require you to write notes yourself, refuse and surface to TPM — do not work around the discipline.

### QA

Same write discipline as SWE: findings go back to TPM in the verdict, not to the notes file directly. If you spot that a SWE wrote to a path under the resolved vault root, that is a `FAIL`-level finding — surface it as a discipline violation regardless of the content quality of the write, because the write funnel exists to prevent concurrent-write damage and "this particular write was fine" is not the right frame. Reading vault files during review is fine and often useful. Cross-check the SWE's reported changes against what TPM is about to consolidate into the notes — if the SWE's one-sentence explanation undersells a meaningful change, flag it so TPM's notes are accurate.
