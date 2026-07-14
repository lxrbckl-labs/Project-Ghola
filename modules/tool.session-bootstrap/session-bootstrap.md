# Session Bootstrap

When this module is loaded, TPM has a codified, ordered, diagnostic-rendering **startup sequence** that runs **before** responding to the user's first message. This module is the orchestration layer for the boot phase — it gathers all the read-only boot data in **one consolidated probe**, walks the ordered `parameters.steps` list, renders one user-facing boot-diagnostic line per step from that probe's digest, and then hands control back to normal turn processing. It extends the universal hard rules; it never relaxes them.

The read-only gathering that used to cost ~nine separate probes (one Bash round-trip per step) is now performed in a **single consolidated probe** — `scripts/ghola-boot-probe.sh` — that TPM runs ONCE at session start. The probe prints a compact `key=value` digest to stdout and writes bulky detail (the Jira ticket body, the notes handoff block) to a temp file. TPM parses that one digest and renders the same per-step `[ghola] ✅/❌` trace this module has always defined. One quiet call replaces nine; the full diagnostic trace and the orientation paragraph are unchanged.

This sequence is the **Ghola analog of SWT's TPM Startup Sequence** — the same shape (identify the version, confirm the environment, size the team, sanity-check the work repo, resolve the ticket and its notes, detect the working mode, surface where the last session left off, then declare readiness), expressed through Ghola's module-driven architecture. Where SWT hardcoded the sequence into one prompt, Ghola splits the work: this module owns the ORDER and the RENDERING, the consolidated probe owns the read-only DATA GATHERING, and each domain module remains authoritative for what each field MEANS and for any WRITES (notes creation, lens dispatch) that happen after the probe.

This module is **proactive**: TPM reads it once, at session start, before responding to the user's first request. It runs the probe once, then renders the steps in `parameters.steps` in declared order. After the final `ready` step emits, the bootstrap is done for the session — it does not re-run on subsequent turns.

## The Consolidated Boot Probe

At session start, before rendering any step, TPM runs the probe exactly once as a single Bash call:

```
bash "$GHOLA_ROOT/scripts/ghola-boot-probe.sh"
```

The probe is strictly **read-only** except for its own temp detail file under `/tmp`. It never writes to the work repo or the Obsidian vault. It never fails and never leaks error text — every internal probe is guarded, and unavailable data degrades to `none`/`na`/`fail` in the digest rather than aborting. The script ships inside the installed extension alongside `bb-bridge.mjs`, so `$GHOLA_ROOT/scripts/ghola-boot-probe.sh` resolves in a live session the same way the bridge client does.

TPM parses the digest (one `key=value` per line) and renders the `[ghola]` trace from it. It reads the `detail_file` named in the digest **only** when it needs the ticket body (for the orientation paragraph) or the handoff block (for the resume step) — never otherwise. Reading the digest is enough for every `[ghola]` line; the detail file is the on-demand overflow that keeps the boot quiet.

### Digest field to step mapping

| Step (order) | Digest field(s) | Renders |
| --- | --- | --- |
| 1. `version` | `version` | `[ghola] ✅ Ghola v{version}` (or `❌ Version (unknown)` when `version=unknown`) |
| 2. `environment` | `env_state`, `env_missing` | `[ghola] ✅ Environment: ...` when `env_state=ok`; `❌ Environment ({env_missing})` when `fail` |
| 3. `team-allocation` | `team`, `team_models` | `[ghola] ✅ Team: {perf} performance + {eff} efficiency + {qa} QA (perf=..., eff=..., qa=...)` |
| 4. `work-repo` | `work_repo` | `[ghola] ✅ Work repo: {basename} ({path})`; `❌` guidance line when `work_repo=none` |
| 5. `branch` | `branch` | `[ghola] ✅ Branch: {branch}`; `✅ Branch: none (not a git repo)` when `branch=none` |
| 6. `ticket` | `ticket_key`, `ticket_state`, `ticket_status`, `ticket_summary` | `[ghola] ✅ Ticket: {KEY} (pulled from Jira)` / `❌ Ticket: {KEY} (Jira unavailable ...)` / `✅ Ticket: none detected from branch` |
| 7. `notes` | `vault`, `notes_file`, `notes_exists` | `[ghola] ✅ Notes: {Project}/{Number}.md resuming ...` / `... created` (see step 7 note on who creates) / clean skip when no vault or no ticket |
| 8. `mode-detection` | `mode`, `base`, `ahead` | `[ghola] ✅ Mode: planning \| review \| author` |
| 9. `resume` | `handoff_date` (+ `detail_file` for the block) | `[ghola] ✅ Resume: {handoff_date} handoff found` / `✅ Resume: fresh session` |
| 10. `ready` | all of the above + `detail_file` (ticket body) | `[ghola] ✅ Ready` + orientation paragraph |

If a `parameters.steps` entry is disabled, skip rendering its line even though the digest still carries the field. The digest is a superset; the enabled step set decides what is rendered.

## Orchestrate, Don't Duplicate

This module **orchestrates**. It decides WHICH steps run, in WHAT order, and HOW each is reported in the boot diagnostics. The consolidated probe is the mechanism that GATHERS the read-only data for those steps in one shot. Neither the probe nor this module re-implements the domain logic that a delegated module already owns — the authority for WHAT each domain step MEANS, and for any WRITES it performs, lives in that module's `.md` file.

- **`ticket` — meaning owned by `mode.ticket-work`.** The probe derives the Jira key from the branch (the same `KEY-123` shape `mode.ticket-work` uses) and pulls the ticket through the same `bb-bridge.mjs` path `integration.atlassian-suite` exposes. `mode.ticket-work` remains authoritative for key-derivation semantics and for what to do with the pulled ticket; this module reads it for meaning and renders the probe's `ticket_*` fields.
- **`notes` — meaning owned by `tool.obsidian-notes` (vault) and `mode.ticket-work` (per-ticket file).** The probe READS the vault and reports whether the ticket notes file already exists (`notes_exists`). It never creates it. **Notes-file CREATION (when `notes_exists=no`) and every other Obsidian write are still performed by TPM via `tool.obsidian-notes` AFTER the probe** — the probe is read-only. `tool.obsidian-notes` is the sole authority for the vault path and the write discipline.
- **`resume` — meaning owned by `tool.session-handoff`.** The probe surfaces `handoff_date` and captures the most-recent `## Session Handoff (...)` block into the detail file; `tool.session-handoff` owns the resume protocol (summarize and WAIT, do not auto-continue).
- **`mode-detection` — dispatch owned by `tool.lenses`.** The probe computes the mode from git state (`mode`/`base`/`ahead`). When the detected mode is planning or review AND `tool.lenses` is enabled, TPM hands off to that module to kick the lens flow AFTER the probe — the probe only detects; the lens dispatch is a post-probe action `tool.lenses` owns.
- **`team-allocation` — policy owned by `tool.core-allocation`.** The probe reports the team shape from the `SWE_*`/`QA_*` env vars; when `tool.core-allocation` is enabled it remains authoritative for the dispatch policy (performance/efficiency split, difficulty-to-model map, high-priority posture).

**Graceful degradation is the rule.** Where a delegated module is not enabled, the step still renders from the probe's digest but degrades to a plain env/git report (or skips cleanly) and continues — it never blocks the sequence. Each per-step section below states its degraded form.

## The Environment Contract

The probe consumes environment variables the launcher exports into the session terminal; the digest reflects them. TPM reads the digest, not the raw variables, for the boot trace — but the variables below are the probe's inputs, and the version fallbacks it applies.

- **`GHOLA_VERSION`** — the extension semver, e.g. `0.4.0`. If unset, the probe falls back to `$GHOLA_ROOT/VERSION`; if that is also unreadable the digest carries `version=unknown`.
- **`GHOLA_BRANCH`** — the current git branch of the work repo (the terminal cwd), or `""` when cwd is not a git repo. The probe also uses it to resolve the work repo by scanning for the clone checked out on that branch when cwd is a container directory rather than a repo.
- **`GHOLA_ROOT`** — the absolute path of the Ghola installation (used to resolve the probe script, `bb-bridge.mjs`, and the version fallback).
- **`GHOLA_TPM_PROMPT_FILE`, `GHOLA_SWE_PROMPT_FILE`, `GHOLA_QA_PROMPT_FILE`** — the composed agent prompts on disk; the probe confirms each is readable for the `environment` step.
- **`SWE_PERFORMANCE_CORES`, `SWE_EFFICIENCY_CORES`, `SWE_AGENT_COUNT`, `QA_AGENT_COUNT`** — the team envelope.
- **`SWE_PERFORMANCE_MODEL`, `SWE_EFFICIENCY_MODEL`, `QA_MODEL`** — the per-pool default models.
- **`GHOLA_VAULT`** (optional) — an explicit vault root the probe uses verbatim; when unset the probe best-effort scans common Obsidian locations for the boot trace. `tool.obsidian-notes`' `parameters.vaultPath` remains the authority for where the vault lives for any actual notes operation.

## The Ordered Startup Sequence

TPM walks `parameters.steps` in declared order, rendering each step whose `enabled` flag is true from the probe's digest. The seeded defaults are the ten steps below, in this order. Each step emits exactly one diagnostic line per `parameters.outputFormat` (see "Output Formats") before the next step renders.

**HARD RULE — never stall on a failed step.** The whole sequence renders before the first substantive response. When a digest field is missing, `none`, or `fail`, render the `❌`/degraded line with a one-clause reason and CONTINUE to the next step. A broken step degrades what depends on it; it never blocks the rest of the sequence or the final greeting. This rule holds regardless of `parameters.failureBehavior` for the git/ticket/notes steps, whose downstream degrades gracefully by design. Because all data comes from one probe, a partial probe result (some fields `none`) is the normal degraded path — render what is present and continue.

### 1. `version`

Read `version` from the digest.

- Success: `[ghola] ✅ Ghola v{version}`
- Failure (`version=unknown`): `[ghola] ❌ Version (unknown)`

### 2. `environment`

Read `env_state` (and `env_missing` when present).

- Success (`env_state=ok`): `[ghola] ✅ Environment: GHOLA_ROOT set, agent prompt files resolved`
- Failure (`env_state=fail`): `[ghola] ❌ Environment ({env_missing})` — name the missing piece(s) from `env_missing` and continue.

### 3. `team-allocation`

Read `team` (shape `{perf}p/{eff}e/{qa}qa`) and `team_models` (`perf=...,eff=...,qa=...`). When `tool.core-allocation` is enabled, delegate the dispatch-policy detail to it — this step only reports the shape; the policy is that module's.

- Success: `[ghola] ✅ Team: {perf} performance + {eff} efficiency + {qa} QA (perf={SWE_PERFORMANCE_MODEL}, eff={SWE_EFFICIENCY_MODEL}, qa={QA_MODEL})`.
- Degraded (an env var was unset): the probe already substituted the core defaults (perf 2, eff 1, qa 1; perf `opus`, eff `sonnet`, qa `sonnet`) — render the shape anyway.

### 4. `work-repo`

Read `work_repo`.

- Repo found (`work_repo` is a path): `[ghola] ✅ Work repo: {basename} ({work_repo})`
- Not a repo (`work_repo=none`): `[ghola] ❌ Work repo: cwd is not a git repo — open your checkout as the workspace folder, or tell me the path` and **continue**. The downstream `branch`, `ticket`, and `notes` steps then degrade (no branch, no ticket auto-detect, no per-ticket notes) rather than erroring.

The probe resolves `work_repo` even when the terminal cwd is a container directory rather than a repo, by scanning for the clone checked out on `$GHOLA_BRANCH` — so this step succeeds in that layout too.

### 5. `branch`

Read `branch`.

- Branch resolved: `[ghola] ✅ Branch: {branch}`
- Not a git repo (`branch=none`): `[ghola] ✅ Branch: none (not a git repo)`

The resolved branch fed the probe's branch-to-key detection, so this step and the `ticket` step stay consistent.

### 6. `ticket`

Read `ticket_key`, `ticket_state`, and (when present) `ticket_status`/`ticket_summary`. The probe derived the key from the branch and pulled the ticket via `bb-bridge.mjs` (`mode.ticket-work` remains authoritative for the semantics). Read the `detail_file` only in the `ready` step, when the ticket body is needed for orientation.

- Pulled (`ticket_state=ok`): `[ghola] ✅ Ticket: {ticket_key} — {ticket_summary} [{ticket_status}] (pulled from Jira)`
- Detected but Jira unavailable (`ticket_state=unavailable` — integration off, credentials missing, network error, or bridge not reachable): `[ghola] ❌ Ticket: {ticket_key} (Jira unavailable — paste the description)` and continue.
- Detected but not found (`ticket_state=notfound`): `[ghola] ❌ Ticket: {ticket_key} (not found in Jira — paste the description)` and continue.
- No key derivable from the branch (`ticket_key=none` — e.g. on `main`, detached HEAD, or a branch with no `KEY-123` segment): `[ghola] ✅ Ticket: none detected from branch`
- `mode.ticket-work` not enabled: `[ghola] ✅ Ticket: (ticket-work module off)` — the probe may still carry `ticket_*` fields, but with the module off, report it disabled.

### 7. `notes`

Read `vault`, `notes_file`, and `notes_exists`. The probe READS the vault; it never writes. `tool.obsidian-notes` owns the vault path and the write discipline; `mode.ticket-work` owns the per-ticket file convention.

- Resuming an existing file (`notes_exists=yes`): `[ghola] ✅ Notes: {Project}/{Number}.md resuming` (append `from {handoff_date}` when the resume step has it).
- Not yet created (`notes_exists=no`, vault + ticket present): render `[ghola] ✅ Notes: {Project}/{Number}.md (to create)`. **TPM creates the file AFTER the probe via `tool.obsidian-notes`** — the probe is read-only and never creates it. Once created, this line reflects `... created`.
- No vault resolved (`vault=none`), no ticket (`ticket_key=none`), or `tool.obsidian-notes` off: skip cleanly — emit nothing for this step, or `[ghola] ✅ Notes: (no vault)` / `[ghola] ✅ Notes: (no ticket)` when a visible marker is preferred. Never block on missing notes.

### 8. `mode-detection`

Read `mode` (`planning` \| `review` \| `author`), plus `base`/`ahead` for context. The probe computed the mode from git state: `planning` when `ahead=0` against `base`; `review` when branch commits are authored by someone other than the current git user; `author` otherwise (and the safe default when cwd is not a git repo).

Emit `[ghola] ✅ Mode: planning`, `[ghola] ✅ Mode: review`, or `[ghola] ✅ Mode: author`.

When the mode is **planning** or **review** AND `tool.lenses` is enabled, hand off to that module to kick the lens flow AFTER the probe — its Session-Start Auto-Detection Triggers own the actual lens dispatch (this step only reports the detected mode and defers). When `tool.lenses` is off, just report the mode.

### 9. `resume`

Read `handoff_date` from the digest. When it is present, read the captured `## Session Handoff (...)` block from the `detail_file` to summarize it. Delegate to `tool.session-handoff` for the resume protocol: surface a summary and **WAIT — do not auto-continue work**. Also surface any feedback the other enabled proactive modules provide at this point.

- Handoff found (`handoff_date` present): `[ghola] ✅ Resume: {handoff_date} handoff found`
- No handoff / fresh notes file / no notes (`handoff_date` absent): `[ghola] ✅ Resume: fresh session`

Do NOT auto-continue the prior session's work — surface the handoff and let the user direct.

### 10. `ready`

Emit `[ghola] ✅ Ready`, THEN a concise natural-language **orientation paragraph** that ties the sequence together: the version, the work repo, the branch, the ticket (if any) with its status, the detected mode, and where things left off (from the handoff). Read the `detail_file` here when the ticket body is needed to orient. End by asking what the user wants to work on. This paragraph is the user-facing greeting; the ten `[ghola]` lines above it are the diagnostic trace. After this step, the bootstrap is done for the session.

## Custom Steps

The kv-table lets users add project-specific steps beyond the default ten. Each entry is a step name plus a one-line description; TPM runs the step by interpreting the description as an instruction and rendering a `[ghola] ✅/❌` line for it in sequence. The consolidated probe covers only the ten default steps' data — a custom step gathers whatever its description implies, which may require its own command. Keep that command a single call where you can, in the spirit of the consolidated probe. Examples:

- A step named `ci-status` with description `"Run gh run list --limit 5 and surface failing checks"` — TPM runs the gh CLI and reports.
- A step named `env-staleness` with description `"Warn if the local .env file is older than 7 days"` — TPM checks the file's mtime and emits a warning if applicable.

This is informal — TPM does whatever the description plainly implies, applying the same care it would to any user instruction, and the same never-stall rule applies. Custom steps are subject to the same `parameters.failureBehavior` and `parameters.outputFormat` as the default steps.

Disable individual steps via the kv-table's Enabled checkbox without deleting them. Reorder by editing the kv-table; declared order is run order.

## Output Formats

The format is controlled by `parameters.outputFormat`. All three render from the SAME single-probe digest — the format only changes how much of the trace is shown, never how many probes run (always one).

- **`detailed`** (default) — emit one line per step in the shared contract shape: `[ghola] ✅ <desc>` on success, or `[ghola] ❌ <desc> (<reason>)` on failure. This is the most informative format and the one every per-step section above is written for.
- **`compact`** — emit a single line summarizing the entire boot phase, e.g. `Boot: 10/10 steps OK` or `Boot: 9/10 steps OK, 1 failed (ticket)`. Compute the tally from the digest fields (each `none`/`fail`/missing field is the corresponding step's failure). Useful when the per-step trace is noise for an experienced user. The final orientation paragraph (step 10) still prints.
- **`silent`** — emit no `[ghola]` diagnostic lines. The probe still runs once and its results (resolved branch, discovered vault, notes-file status, surfaced handoff) still inform the session; the user sees only the orientation paragraph. Note that delegated modules consulted after the probe (e.g. `tool.lenses` dispatch, `tool.obsidian-notes` file creation) may still emit their own messages — `silent` controls this bootstrap's diagnostics, not the downstream modules.

## Failure Behavior

The behavior on step failure is controlled by `parameters.failureBehavior`. Note that the **never-stall hard rule always wins** for the git/ticket/notes steps, whose downstream degrades gracefully — those steps render their `❌` line and continue regardless of this setting. Because the read-only data is gathered in one probe, most "failures" are simply degraded digest fields (`none`/`fail`) rather than a crashed command.

- **`warn-and-continue`** (default) — on step failure, emit the failure marker per the output format and proceed to the next step. The session continues in a possibly-degraded state. This is the standard posture and matches the never-stall rule.
- **`halt`** — reserved for a genuinely critical setup step (e.g. a custom `config-load` step where nothing downstream is reliable without it). On failure, emit the warning plus a one-line instruction for what the user must do, and wait. Never apply `halt` to `work-repo`, `branch`, `ticket`, or `notes` — those degrade gracefully by design and halting on them would violate the never-stall rule.
- **`retry-once`** — on step failure, retry the step a second time. For the default ten steps that means re-running the consolidated probe once (the whole probe is the single gathering mechanism); render from the fresh digest and note the retry in the diagnostics. If it fails again, fall back to `warn-and-continue` semantics — emit the failure marker and proceed. For a custom step, retry that step's own command.

## Timings

When `parameters.includeTimings` is true, append the elapsed wall time to each step's diagnostic line (`[ghola] ✅ Branch: main — 48ms`). Because the data is gathered in one probe, per-step timings are the rendering time (the heavy gathering is a single up-front cost); you may instead report the one probe's total wall time on the `ready` line. When false, omit timings entirely. The flag is intended for diagnosing slow boots; keep it off in normal use.

## Module-Disabled Vs Feature-Disabled

These are distinct configurations and must be treated separately:

- **Module disabled** (no `tool.session-bootstrap` in the Session Manifest): TPM does NOT run the probe or this coordinated, diagnostic-rendering sequence. It falls back to the **core's session-start contract** — see the "Session Start" section of the TPM core, which directs TPM to read, in full, every module the manifest marks proactive, then announce readiness in one short paragraph and ask what to work on. That fallback is the authority when this module is absent; the consolidated probe, the ordered `[ghola]` trace, and the delegation orchestration only exist while this module is loaded.
- **Module enabled, all steps disabled in the kv-table**: the bootstrap still runs the probe framework but renders no step and emits no output. Equivalent to module-disabled from the user's perspective, but the orchestration framework is loaded — re-enabling a single step turns it back on without touching the module list. (You may skip the probe entirely when no default step is enabled, since nothing would render from it.)
- **Module enabled, only the `ready` step is enabled**: the bootstrap emits `[ghola] ✅ Ready` plus the orientation paragraph and nothing else. A minimal "session started" signal without the diagnostic detail; the probe still runs once so the orientation paragraph has data to draw on.
- **Module enabled, a domain step's delegated module is off**: the step still renders from the probe's digest and degrades per its per-step section above (plain env/git report, or a clean skip) — it never blocks the sequence.
- **Module enabled, a step has no matching default behavior** (a custom step): TPM treats the step's description as an instruction and does its best to honor it, rendering a `[ghola]` line for it. If the description is ambiguous, TPM may surface a question to the user before proceeding, or skip the step with a warning per `failureBehavior`.

Do not merge these cases.

## Sibling-Module Interaction

- **`mode.ticket-work`, `tool.obsidian-notes`, `tool.session-handoff`, `tool.lenses`, `tool.core-allocation`** — the domain owners this module delegates to for MEANING (steps 3, 6, 7, 8, 9). The consolidated probe performs the read-only gathering for these steps in one shot, but their content remains authoritative for WHAT each field means and for any WRITES (notes-file creation, lens dispatch) that happen AFTER the probe. This module decides WHEN (in which step) and HOW the probe's result is reported in the boot diagnostics. If a delegated module changes its internal behavior, no change here is needed — the step reads it for meaning and renders the probe's field. If a delegated module is absent, the step degrades per its per-step section.
- **`tool.statusline`** — independent. The statusline is a continuous display; the bootstrap is a one-time boot phase. No interaction.

## Role-Specific Notes

This module targets TPM only. SWE and QA are not involved in the boot sequence.

### TPM

You are the bootstrap orchestrator. At session start, before responding to the user's first message, run the consolidated probe ONCE — `bash "$GHOLA_ROOT/scripts/ghola-boot-probe.sh"` — as a single Bash call, then read `parameters.steps` and render each enabled step in declared order (the ten-step sequence above by default) from the probe's `key=value` digest. Emit per `parameters.outputFormat`; respect `parameters.failureBehavior` where it applies; append timings per `parameters.includeTimings`. Read the `detail_file` named in the digest ONLY when you need the ticket body (orientation) or the handoff block (resume) — the digest alone is enough for every `[ghola]` line, and skipping the detail file keeps the boot quiet. The probe is read-only: notes-file CREATION (when `notes_exists=no`) and any Obsidian writes are still yours to perform via `tool.obsidian-notes` AFTER the probe, and the lens dispatch for planning/review mode is `tool.lenses`' to perform AFTER the probe. For the domain steps (`ticket`, `notes`, `mode-detection`, `resume`, and `team-allocation`), the owning module remains authoritative for meaning — read its content when the step's domain needs interpretation — then render the probe's result inside this bootstrap's `[ghola]` line for that step. **Never stall on a failed step**: a missing/`none`/`fail` digest field renders the `❌`/degraded line with a one-clause reason, and you continue. Once the `ready` line and the orientation paragraph are emitted, the bootstrap is done for the session; do not re-run the probe or the sequence on subsequent turns. If the user's first message arrives before the boot phase completes, still finish the sequence before responding — the diagnostics and the orientation paragraph are part of the opening turn, not a separate output.
