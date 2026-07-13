# Ghola Ledger

When this module is loaded, the session has access to the **ghola ledger** — the persistent, cross-session store of gholas (dedicated mission agents) that `mode.war` grows and reawakens. This module teaches the ledger's storage contract and the `ghola` CLI that is the only sanctioned way to read or write it. Every agent reads this same fragment; role-specific framing is collected at the end.

This module is **not proactive**. It sits quietly until a task touches ghola-mode territory — starting a mission, spawning or reawakening a ghola, checking the roster, or recording a debrief. `mode.war` is the module that actually drives mission orchestration; this module is the reference for the storage layer underneath it. A session can have this module loaded without `mode.war` active (e.g. to inspect the ledger from a non-mission session), but `mode.war` **requires** this module.

## Never touch ledger files directly

The ledger is plain markdown on disk, but agents do not read or write those files with `Read`/`Edit`/`Write`, and do not shell out to `cat`, `sed`, or hand-rolled scripts against them. **All ledger operations go through the `ghola` CLI**, invoked as:

```
node scripts/ghola.mjs <command> [subcommand] --flag value ...
```

The CLI serializes every write behind an advisory lockfile so concurrent gholas mutating the same subject never clobber each other's changes — a hand-edit bypasses that guarantee and can corrupt the ledger. Run `node scripts/ghola.mjs --help` for the live command list if anything below drifts from the installed script.

## Where the ledger lives

The ledger has one authoritative pointer and a resolution chain for where the actual data sits:

- **Authoritative pointer:** `<workspace>/.ghola/ledger-path` — a plain text file containing the absolute path to the ledger root, written by the CLI on first use. This is what the War Room's file-watcher reads to find the ledger; it has no other way to know where to look.
- **Preferred home:** the Obsidian vault, at a dedicated top-level `_Gholas/` directory (`<vault>/_Gholas/`). This is cross-session and cross-project — gholas persist independently of any one workspace being open.
- **Workspace-local fallback:** `<workspace>/.ghola/gholas/` when no Obsidian vault can be resolved. Ghola mode works fully with no vault present at all; the ledger just lives next to the workspace instead.
- **Resolution order the CLI applies:** `--vault <path>` flag > `GHOLA_VAULT` env > `SWT_OBSIDIAN_PATH` env > auto-discover a directory containing `.obsidian` > the workspace-local fallback. `--local` skips straight to the workspace-local fallback regardless of what would otherwise resolve. `--workspace <path>` overrides the workspace itself (default: cwd).

Do not guess or hardcode a ledger path in conversation or in a ghola brief — always resolve it through a `ghola` command (or read the pointer file) rather than assuming `_Gholas/` sits at a fixed location.

## Ledger layout

```
<ledger-root>/                       <vault>/_Gholas/  OR  <workspace>/.ghola/gholas/
  <subject>/                         one directory per subject (a ticket, a support app, a CD project)
    <ghola-slug>.md                  one file per ghola — frontmatter + accreted history
    _missions.md                     mission records for this subject (each carries an `integration` line)
    operating-notes.md               self-tuning per-subject playbook (scaffolded lazily)
    alerts.md                        per-subject attention items for the operator (ghola alert)
    ownership.md                     live file/dir ownership registry (claim/release)
    escalations.md                   decisions raised for operator sign-off
  _archive/<subject>/<ghola-slug>.md soft-archived gholas — moved here, never deleted
  _templates/<name>.md               saved mission templates (goal pattern + crew shape)
```

A **subject** is the scope a ghola belongs to — a ticket key, a support app name, a CD project name. Subjects are slugified (lowercased, non-alphanumerics collapsed to hyphens) before use as a directory name.

### Per-ghola file shape

Each ghola is one markdown file: YAML-ish frontmatter, then a body with a `## History` section.

```
---
id: reproducer
name: "Reproducer"
purpose: "Isolate the trigger for the CMMS-5412 crash"
subject: cmms-5412
state: active
model: sonnet
verification: passed
created: 2026-07-09T14:02:11.000Z
last_used: 2026-07-09T18:40:03.000Z
missions:
  - "M0001"
---

# Reproducer

## History

- 2026-07-09: spawned — Isolate the trigger for the CMMS-5412 crash
- 2026-07-09: reproduced on a fresh install; trigger is a null tenant-id on first login
```

- `state` is one of `active` (working now), `dormant` (instantiated, purpose known, cheap to reawaken), `archived` (soft-retired — file lives under `_archive/<subject>/`, never deleted).
- `missions` accretes every mission-id this ghola has worked under, so `ghola mission resume` can reconstruct the roster for a given mission.
- `## History` is a rolling **summary** of debrief-outs, not full transcripts — the ledger stays lean and fast to read even as a ghola accretes a long history.
- `verification` is a per-ghola sign-off flag (`pending` | `passed` | `failed`, set via `ghola verify`); a ghola whose `verification` is not `passed` is not eligible to be marked done or to contribute to declare-done.

Beyond the per-ghola files, two per-subject ledger files back the concurrency and escalation machinery: `ownership.md` holds the live file/dir ownership registry that `ghola claim` / `ghola release` mutate (the runtime collision guard, which fails a claim on a path another active ghola already owns), and `escalations.md` holds decisions raised for operator sign-off via `ghola escalate` (each escalation carries a `status` of `pending`, `approved`, `denied`, or `cancelled` — `cancelled` being one TPM retired via `ghola escalate --cancel <id>` when its mission closed, as distinct from a ruling the operator made). Each mission record in `_missions.md` also carries an `integration` line (`pending` | `passed` | `failed`, set via `ghola integrate`) recording the mission-level integration-checkpoint outcome, alongside its goal, grounding, budget, and progress.

### Subject-locked reuse

A ghola only ever serves the subject it was spawned under. A new subject always grows fresh gholas — never reassign an existing ghola across subjects, even if its purpose sounds like a good fit. This is the **reuse-vs-regrow** check: before spawning, look at what already exists for the subject; only spawn new when nothing fits.

## The debrief-in / debrief-out accretion discipline

This is the mechanism that makes reawakening a ghola cheaper and better-informed than growing a fresh one:

- **Brief-in** (whenever a ghola is instantiated OR reawakened): its sub-purpose, the mission goal, context on what's done and what's needed, who else is in play, and done-criteria. On a reawaken, also include a **delta** — what has changed since this ghola last went dormant.
- **Brief-out** (whenever a ghola goes dormant, whether by finishing its slice or being deliberately paused): a `ghola debrief` call recording the result and final state. This appends to the ghola's `## History` — it IS the accretion mechanism. Skipping the debrief on dormancy means the next reawaken starts from a stale or empty history instead of a fuller one.

Always debrief a ghola before its state moves away from `active` (`ghola debrief` first, then `ghola state ... dormant` or `ghola retire`) so the history entry lands before the state change.

## `ghola` CLI command reference

Global flags, accepted by every command:

| Flag | Effect |
|------|--------|
| `--vault <path>` | Override vault discovery; ledger goes to `<vault>/_Gholas/`. |
| `--workspace <path>` | Override the workspace (default: cwd); the pointer file and workspace-local fallback both live here. |
| `--local` | Force the workspace-local ledger, skipping vault resolution entirely. |

Commands:

| Command | Flags | Effect |
|---------|-------|--------|
| `mission start` | `--subject S --goal "..." [--grounded-in "..."] [--budget "..."] [--id ID]` | Starts a mission for a subject; prints its mission-id. |
| `mission list` | `--subject S [--json]` | Lists all missions recorded for a subject. |
| `mission resume` | `--subject S --id M [--json]` | Prints a mission record plus the gholas that worked it. |
| `mission done` | `--subject S --id M [--force]` | Marks a mission done. **Refuses unless the mission's `integration` is `passed`** (the integration gate). `--force` overrides that refusal (rare; explain the bypass in a `progress` note). |
| `mission reopen` | `--subject S --id M` | Reopens a mission previously marked done (`done` -> `open`), restoring it as the active mission (header, integration gate, Declare-Done) so a resumed mission can be worked visibly and converged again. **Resets the mission's `integration` back to `pending`** (progress history preserved) so the resumed work must be re-integrated (`ghola integrate --state passed`) before it can be re-declared-done. |
| `spawn` | `--subject S --name N --purpose "..." [--model opus\|sonnet\|haiku] [--mission M] [--parent P]` | Creates a new ghola in state `active`; prints its slug. `--parent` sets generation = parent's generation + 1 (if found; else 1) and records `parent` = that slug. |
| `fork` | `--subject S --from G --name N [--summary "..."]` | Second awakening: clean new generation from an existing ghola (copies purpose + model, generation = source + 1, parent = source, fresh reliability, distilled lessons carried forward). Source ghola is untouched; prints the new slug. |
| `record` | `--subject S --ghola G --outcome pass\|rework [--json]` | Increments that ghola's reliability counter (`pass:N rework:M`). |
| `verify` | `--subject S --ghola G --state pending\|passed\|failed` | Sets a ghola's `verification` frontmatter (build+typecheck green plus an adversarial check); a ghola not `passed` is not done-eligible. |
| `integrate` | `--subject S --mission M --state pending\|passed\|failed` | Sets the mission-level integration-checkpoint outcome on the mission's `integration` line (whole combined-diff pass); declare-done is gated on `passed`. |
| `state` | `--subject S --ghola G <active\|dormant\|archived>` | Sets a ghola's state directly, relocating it to/from `_archive/` as needed. |
| `claim` | `--subject S --ghola G --path P` | Records a file/dir ownership claim in `ownership.md`; **fails if another active ghola already owns that path** (the runtime collision guard). |
| `release` | `--subject S --ghola G --path P` | Releases a previously-claimed path in `ownership.md`, freeing it for another ghola to claim. |
| `debrief` | `--subject S --ghola G --summary "..."` | Appends a summary line to a ghola's `## History` (the accretion mechanism). |
| `progress` | `--subject S --id M --note "..."` | Appends a progress note to a mission record. |
| `note` | `--subject S --text "..."` | Appends a self-tuning line to the subject's `operating-notes.md`. |
| `alert` | `--add "..." --subject S \| --list --subject S [--json]` | Appends/lists per-subject `alerts.md` bullets (newest-last; surfaced in `board --json`). |
| `awaken` | `--status \| --ack [--workspace <path>] [--json]` | Reads/acks the Awaken-All kill-switch field in `<workspace>/.ghola/control.json` (`awakenAll`). The CLI never sets it true — only the host's War Room button does; `--ack` is for TPM to call after standing the whole team down. |
| `resume` | `--status \| --ack [--workspace <path>] [--json]` | Reads/acks a per-mission resume request (same control.json, field `resumeMission`). The CLI never sets it to a mission id — that's the host's Resume button's job; `--ack` is for TPM to call after reawakening that mission's crew. |
| `directive` | `--status \| --ack [--workspace <path>] [--json]` | Reads/acks the god-console directive field (same control.json, field `directive`). The CLI never sets it non-null — that's the host/god-console's job; `--ack` is for TPM to call after acting on the directive. |
| `declaredone` | `--status \| --ack [--workspace <path>] [--json]` | Reads/acks the operator's P4 Declare Done field (same control.json, field `declareDone`: mission-id or `null`). The CLI never sets it non-null — that's the host/Declare-Done-button's job; `--ack` is for TPM to call after marking the mission done, standing the crew down, and reporting completion. |
| `escalate` | `--add "..." --subject S --ghola G \| --cancel ID --subject S \| --status [--json] \| --ack --subject S [--workspace <path>]` | Appends a gated decision needing operator sign-off to `escalations.md`; `--cancel ID` cancels one specific pending escalation (its status becomes `cancelled`); or reads/acks the operator's Approve/Deny (control.json field `escalationResolve`: a **queue**, an array of `{ id, subject, decision }` entries, empty array or `null` when nothing is pending). The CLI never writes the decision; that is the War Room's Approve/Deny. `--ack` is **subject-scoped** and drains that subject's whole resolved queue, for TPM to call after acting on the rulings. |
| `template save` | `--subject S --name N --from-mission M` | Saves a mission's goal pattern + crew as a reusable template at `<ledger-root>/_templates/<name>.md`. |
| `template list` | `[--json]` | Lists saved templates. |
| `template use` | `--name N [--json]` | Prints a saved template's contents (for TPM to instantiate a fresh mission + crew from it). |
| `wake` | `--subject S --ghola G` | Reactivates a ghola (sets `state: active`, resets `last_used`). |
| `retire` | `--subject S --ghola G` | Soft-archives a ghola — moved into `_archive/<subject>/`, never deleted. |
| `groom` | `--subject S [--days 30]` | Soft-archives every ghola in the subject idle past N days (default 30). |
| `ls` | `--subject S [--json]` | Lists a subject's gholas — id, state, model, last-used, purpose, generation, parent, reliability. **This is the reuse-vs-regrow lookup** — always run it before spawning. |
| `board` | `[--subject S] [--id M] [--json]` | Renders the war-room view (ASCII by default; `--json` mirrors the same data the War Room webview shows, plus extra fields — the host actually builds the webview's payload by parsing the ledger files directly, not by shelling out to `board --json`). With no `--subject`/`--id`, shows a summary across all subjects; subject scope includes alerts and roster generation/parent/reliability. |

The `--vault`/`--workspace`/`--local` global flags above are accepted by every command, not just `mission`/`spawn`/etc. — including `awaken`, `resume`, `directive`, `declaredone`, and `escalate`, which key off `<workspace>/.ghola/control.json` rather than the ledger root. `--json` is available on `ls`, `board`, `alert --list`, `record`, `awaken`, `resume`, `directive`, `declaredone`, `escalate`, `template list`, `template use`, and `mission list`/`mission resume` (the only `mission` subcommands that honor it — `mission start`, `mission done`, and `mission reopen` do not) — use it when you need to parse the result programmatically rather than read it as prose.

## Role-Specific Notes

The body above applies identically to every agent. TPM is the primary driver of the CLI (it owns mission lifecycle and roster decisions per `mode.war`); SWE and QA use it read-only in the ordinary case (checking `ghola ls`/`ghola board` for context) unless a mission brief explicitly assigns ledger-writing responsibility to them. Regardless of role: never write to a ledger file except through a `ghola` command.
