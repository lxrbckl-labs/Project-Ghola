# Session Bootstrap

When this module is loaded, TPM has a codified, ordered, diagnostic-rendering **startup sequence** that runs **before** responding to the user's first message. This module is the orchestration layer for the boot phase — it gathers all the read-only boot data in **one consolidated probe**, walks the ordered `parameters.steps` list, renders one user-facing boot-diagnostic line per step from that probe's digest, and then hands control back to normal turn processing. It extends the universal hard rules; it never relaxes them.

The read-only gathering that used to cost ~nine separate probes (one Bash round-trip per step) is now performed in a **single consolidated probe** — `scripts/ghola-boot-probe.sh` — that TPM runs ONCE at session start. The probe prints a compact `key=value` digest to stdout and writes bulky detail (the Jira ticket body, the notes handoff block) to a temp file. TPM parses that one digest and renders the same per-step `[ghola] ✅/❌` trace this module has always defined. One quiet call replaces nine; the full diagnostic trace and the one-line orientation greeting are unchanged.

This sequence is the **Ghola analog of SWT's TPM Startup Sequence** — the same shape (identify the version, confirm the environment, size the team, sanity-check the work repo, resolve the ticket and its notes, detect the working mode, surface where the last session left off, then declare readiness), expressed through Ghola's module-driven architecture. Where SWT hardcoded the sequence into one prompt, Ghola splits the work: this module owns the ORDER and the RENDERING, the consolidated probe owns the read-only DATA GATHERING, and each domain module remains authoritative for what each field MEANS and for any WRITES (notes creation, lens dispatch) that happen after the probe.

This module is **proactive**: TPM reads it once, at session start, before responding to the user's first request. It runs the probe once, then renders the steps in `parameters.steps` in declared order. After the final `ready` step emits, the bootstrap is done for the session — it does not re-run on subsequent turns.

## The Consolidated Boot Probe

At session start, before rendering any step, TPM runs the probe exactly once as a single Bash call:

```
bash "$GHOLA_ROOT/scripts/ghola-boot-probe.sh"
```

The probe is strictly **read-only** except for its own temp detail file under `/tmp`. It never writes to the work repo or the Obsidian vault. It never fails and never leaks error text — every internal probe is guarded, and unavailable data degrades to `none`/`na`/`fail` in the digest rather than aborting. The script ships inside the installed extension alongside `bb-bridge.mjs`, so `$GHOLA_ROOT/scripts/ghola-boot-probe.sh` resolves in a live session the same way the bridge client does.

TPM parses the digest (one `key=value` per line) and renders the `[ghola]` trace from it. It reads the `detail_file` named in the digest **only** when it needs the handoff block (for the resume step) or, rarely, a ticket fact the one-line greeting needs that the digest did not already carry — never otherwise. Reading the digest is enough for every `[ghola]` line and for the greeting; the detail file is the on-demand overflow that keeps the boot quiet.

### Digest field to step mapping

| Step (order) | Digest field(s) | Renders |
| --- | --- | --- |
| (context) | `session_mode` | Not its own step — the modality (`ticket-work` / `support` / `cd` / `self-upgrade` / `unconstrained`) that gates the `ticket` and `notes` steps; in `support`/`cd`/`self-upgrade` the probe reports `ticket_state=skipped` and those steps render a clean mode-appropriate skip |
| 1. `version` | `version` | `[ghola] ✅ Ghola v{version}` (or `❌ Version (unknown)` when `version=unknown`) |
| 2. `environment` | `env_state`, `env_missing` | `[ghola] ✅ Environment: ...` when `env_state=ok`; `❌ Environment ({env_missing})` when `fail` |
| 3. `team-allocation` | `team`, `team_models` | `[ghola] ✅ Team: {perf} performance + {eff} efficiency + {qa} QA (perf=..., eff=..., qa=...)` |
| 4. `work-repo` | `work_repo`, `self_upgrade_repo` | `[ghola] ✅ Work repo: {basename} ({path})` (in `support` mode render `[ghola] ✅ Launch dir: {basename} ({work_repo}) — support routes via the app map` instead, since support is not cwd-bound); `❌` guidance line when `work_repo=none`. In a self-upgrade session the probe also emits `self_upgrade_repo` (`ok`/`wrong`), rendered here as a Self Upgrade guard line: `✅ Self Upgrade: Project-Ghola repo confirmed` when `ok`, or `❌ Self Upgrade: requires the Project-Ghola repo — current work repo is {work_repo}. cd to Project-Ghola and relaunch.` when `wrong` |
| 5. `branch` | `branch` | `[ghola] ✅ Branch: {branch}`; `✅ Branch: none (not a git repo)` when `branch=none` |
| 6. `ticket` | `ticket_key`, `ticket_state`, `ticket_status`, `ticket_summary`, `session_mode` | `[ghola] ✅ Ticket: {KEY} (pulled from Jira)` / `❌ Ticket: {KEY} (Jira unavailable ...)` / `✅ Ticket: none detected from branch` / `✅ Ticket: n/a ({mode} mode — not ticket-scoped)` when `ticket_state=skipped` (in a self-upgrade session: `✅ Ticket: n/a (self-upgrade — not ticket-scoped)`) |
| 7. `notes` | `vault`, `notes_file`, `notes_exists`, `session_mode` | `[ghola] ✅ Notes: {Project}/{Number}.md resuming ...` / `... created` (see step 7 note on who creates) / clean skip when no vault or no ticket / `✅ Notes: ({session_mode} mode — surface owned by mode.{session_mode})` when `ticket_state=skipped` (in a self-upgrade session: `✅ Notes: (self-upgrade — not ticket-scoped)`) |
| 8. `mode-detection` | `mode`, `base`, `ahead`, `session_mode` | `[ghola] ✅ Dev mode: planning \| review \| author` — a git dev-mode (author/planning/review) trace, meaningful only in ticket-scoped sessions. Labeled `Dev mode:` (not `Mode:`) to disambiguate from the banner's `Mode` row, which shows the modality. **OMITTED entirely** (no line, no skip placeholder) when `session_mode` is `support`, `cd`, or `self-upgrade`, where a git dev-mode is not applicable; rendered as usual for `ticket-work`, `unconstrained`, and War Mode / Sardaukar sessions |
| 9. `resume` | `handoff_date` (+ `detail_file` for the block) | `[ghola] ✅ Resume: {handoff_date} handoff found` / `✅ Resume: fresh session` |
| 10. `ready` | all of the above + `now` | `[ghola] ✅ Ready` + one-line greeting (`now` supplies the current date/time — no separate `date` call) |

If a `parameters.steps` entry is disabled, skip rendering its line even though the digest still carries the field. The digest is a superset; the enabled step set decides what is rendered.

The probe also reports `now=` — the current date and time — so the boot phase needs no separate `date` command. Feed `now` into the one-line greeting's salutation and any date reasoning (see the mapping table's `now` → `ready` row).

## Parallel-Wave Execution

Claude Code runs multiple tool calls issued in a SINGLE assistant message **concurrently**. The boot phase must exploit this: issue independent probes and reads **together in one message** so they run in parallel. This is a **timing optimization only** — every tool result still returns in full, so **no context is lost**. The team boots with identical knowledge, just faster. Do NOT drop any gathering step to save a call; **parallelize, don't delete.**

Gather the boot data in **dependency-respecting waves**. A wave is one assistant message carrying multiple tool calls that run concurrently; a later wave runs only once an earlier wave's results are needed as input.

- **Wave 1 — resolve prerequisites.** A single `echo` that resolves ONLY the concrete-path arguments later steps need: `$GHOLA_ROOT` (for the probe location and for the module `.md` paths) and `$GHOLA_TPM_PROMPT_FILE` if not already resolved. This wave must precede Wave 2 because everything downstream needs `$GHOLA_ROOT`. Do NOT additionally echo team/version/env state the probe already reports (`SWE_AGENT_COUNT`, `SWE_PERFORMANCE_CORES`, `SWE_EFFICIENCY_CORES`, `QA_AGENT_COUNT`, `GHOLA_VERSION`, `GHOLA_BRANCH`, env/team/version/branch/ticket, etc.) — those are all **probe-reported** in Wave 2, so re-echoing them here is duplicate work, not extra context. This wave resolves paths, never state.
- **Wave 2 — gather in parallel.** In ONE message, run the boot probe (`bash "$GHOLA_ROOT/scripts/ghola-boot-probe.sh"`) AND the reads of all remaining proactive module `.md` files, together. These are mutually independent — the probe gathers repo/ticket/env/time state while the reads gather module meaning — so they run concurrently.
- **Wave 3 — dependent follow-ups in parallel.** ALL of Wave 3's probe-dependent steps go in ONE assistant message together, issued as multiple tool calls in that single message so they run **at once**: the `detail_file` read (its path comes from the probe digest; its content feeds the handoff block for resume, and any ticket fact the greeting needs that the digest lacked), the read of any mode-specific module content still needed (e.g. `tool.ghola-ledger`), AND the mode-specific post-probe command a delegated module requires (e.g. War Mode's `node "$GHOLA_ROOT/scripts/ghola.mjs" boot --subject <s>`, keyed by the probe's ticket subject). These all depend only on the probe's output (Wave 2), NOT on each other, so they belong in the same concurrent wave. Do NOT run the `detail_file` read and the `ghola boot` command as separate sequential messages — batch them into one message.

**Ordering rule (the one constraint):** never place a tool call in the same wave as a call it depends on. If step B needs step A's output as an argument, A goes in an earlier wave; within a wave, all calls must be mutually independent. This is what guarantees nothing runs on stale or missing input.

The waves describe HOW the read-only data is gathered — faster, in parallel — and change nothing about the step semantics: the `[ghola] ✅/❌` trace still renders after gathering completes, in declared `parameters.steps` order, per `parameters.outputFormat`. Never-stall, graceful degradation, output formats, and failure behavior are all unchanged. Because the probe now reports `now=`, do NOT run a separate `date` command at boot — read the time from the digest.

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
- **`GHOLA_MODE`** — the session modality string (`ticket-work` / `support` / `cd` / `self-upgrade` / `unconstrained`), exported by the launcher and consumed by the probe to gate ticket/Jira work. Precedence: the enabled `mode.*` module ids (with the `mode.` prefix stripped) win if present; else `self-upgrade` when `tool.self-upgrade` is enabled with no session mode; else `unconstrained`. When the mode contains `support`, `cd`, or `self-upgrade` — a non-ticket mode — the probe suppresses the ticket-key Jira pull and the ticket-notes lookup (that mode owns its own work surface; `self-upgrade` only ever operates on the Project-Ghola repo itself); `ticket-work`, `unconstrained`, and a war-only mode string behave as ticket-scoped. A `self-upgrade` session additionally makes the probe emit `self_upgrade_repo` (`ok`/`wrong`) confirming the work repo IS Project-Ghola (its `package.json` name is `ghola`). Unset degrades to `unconstrained`.
- **`GHOLA_ROOT`** — the absolute path of the Ghola installation (used to resolve the probe script, `bb-bridge.mjs`, and the version fallback).
- **`GHOLA_TPM_PROMPT_FILE`, `GHOLA_SWE_PROMPT_FILE`, `GHOLA_QA_PROMPT_FILE`** — the composed agent prompts on disk; the probe confirms each is readable for the `environment` step.
- **`SWE_PERFORMANCE_CORES`, `SWE_EFFICIENCY_CORES`, `SWE_AGENT_COUNT`, `QA_AGENT_COUNT`** — the team envelope.
- **`SWE_PERFORMANCE_MODEL`, `SWE_EFFICIENCY_MODEL`, `QA_MODEL`** — the per-pool default models.
- **`GHOLA_VAULT`** (optional) — an explicit vault root the probe uses verbatim; when unset the probe best-effort scans common Obsidian locations for the boot trace. `tool.obsidian-notes`' `parameters.vaultPath` remains the authority for where the vault lives for any actual notes operation.

## The Ordered Startup Sequence

TPM walks `parameters.steps` in declared order, rendering each step whose `enabled` flag is true from the probe's digest. The seeded defaults are the ten steps below, in this order. Each step emits exactly one diagnostic line per `parameters.outputFormat` (see "Output Formats") before the next step renders.

A proactive session-mode module may contribute one additional `[ghola]` diagnostic line of its own, OR substitute the rendering of a step whose default line doesn't fit that mode, sourced from that module's Wave-3 post-probe check and rendered in trace order at the position that module specifies; this bootstrap stays agnostic about its content and simply leaves room for the addition or substitution in the sequence.

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

This step's fixed-core line may be SUBSTITUTED in place by a proactive session-mode module whose crew model is not a fixed-core allocation: such a module renders its own crew line at this position instead of the `Team:` line above (per "A proactive session-mode module may contribute one additional `[ghola]` line OR substitute the rendering of a step" in "The Ordered Startup Sequence"). When a mode substitutes here, render its line, not both — the substitution replaces the fixed-core `Team:` line, it does not sit beside it. This bootstrap stays agnostic about which mode substitutes and what its crew line says.

### 4. `work-repo`

Read `work_repo`.

- Repo found (`work_repo` is a path): `[ghola] ✅ Work repo: {basename} ({work_repo})`. In **support** mode the launch cwd is not a bound work surface — support routes work via the app map, not this directory — so render it as `[ghola] ✅ Launch dir: {basename} ({work_repo}) — support routes via the app map` instead of `Work repo:`. Keep the normal `Work repo:` rendering for every other mode (ticket-work, cd, self-upgrade, unconstrained, war); cd and self-upgrade ARE genuinely cwd/Ghola-bound.
- Not a repo (`work_repo=none`): `[ghola] ❌ Work repo: cwd is not a git repo — open your checkout as the workspace folder, or tell me the path` and **continue**. The downstream `branch`, `ticket`, and `notes` steps then degrade (no branch, no ticket auto-detect, no per-ticket notes) rather than erroring.

The probe resolves `work_repo` even when the terminal cwd is a container directory rather than a repo, by scanning for the clone checked out on `$GHOLA_BRANCH` — so this step succeeds in that layout too.

**Self Upgrade repo guard.** In a self-upgrade session (`session_mode=self-upgrade`) the probe also emits `self_upgrade_repo`, because Self Upgrade only ever operates on the Project-Ghola repo itself. Render a Self Upgrade guard line here, right after the work-repo line (this field is present ONLY in a self-upgrade session — omit the line otherwise):

- Confirmed (`self_upgrade_repo=ok` — the work repo's `package.json` name is `ghola`): `[ghola] ✅ Self Upgrade: Project-Ghola repo confirmed`
- Wrong repo (`self_upgrade_repo=wrong` — self-upgrade session, but the work repo is NOT Project-Ghola): `[ghola] ❌ Self Upgrade: requires the Project-Ghola repo — current work repo is {work_repo}. cd to Project-Ghola and relaunch.` This is a prominent guard: the self-upgrade workflow itself refuses to Detect/apply/commit outside Project-Ghola (see `tool.self-upgrade`'s Project-Ghola precondition), so surface it clearly, then continue the sequence (never stall).

### 5. `branch`

Read `branch`.

- Branch resolved: `[ghola] ✅ Branch: {branch}`
- Not a git repo (`branch=none`): `[ghola] ✅ Branch: none (not a git repo)`

The resolved branch fed the probe's branch-to-key detection, so this step and the `ticket` step stay consistent.

### 6. `ticket`

Read `ticket_key`, `ticket_state`, and (when present) `ticket_status`/`ticket_summary`, plus `session_mode`. The probe derived the key from the branch and pulled the ticket via `bb-bridge.mjs` (`mode.ticket-work` remains authoritative for the semantics), EXCEPT in a non-ticket mode (see the skipped case below), where it derives the informational key but performs no Jira pull. Read the `detail_file` only in the `ready` step, when the ticket body is needed for orientation.

- Pulled (`ticket_state=ok`): `[ghola] ✅ Ticket: {ticket_key} — {ticket_summary} [{ticket_status}] (pulled from Jira)`
- Detected but Jira unavailable (`ticket_state=unavailable` — integration off, credentials missing, network error, or bridge not reachable): `[ghola] ❌ Ticket: {ticket_key} (Jira unavailable — paste the description)` and continue.
- Detected but not found (`ticket_state=notfound`): `[ghola] ❌ Ticket: {ticket_key} (not found in Jira — paste the description)` and continue.
- No key derivable from the branch (`ticket_key=none` — e.g. on `main`, detached HEAD, or a branch with no `KEY-123` segment): `[ghola] ✅ Ticket: none detected from branch`
- Mode-gated skip (`ticket_state=skipped` — `session_mode` is `support`, `cd`, or `self-upgrade`): `[ghola] ✅ Ticket: n/a ({session_mode} mode — not ticket-scoped)` (a self-upgrade session renders `[ghola] ✅ Ticket: n/a (self-upgrade — not ticket-scoped)`). This is a CLEAN skip, not a failure — render `✅`, never `❌`. The session is not ticket-scoped, so the probe made no Jira call; the work surface belongs to that mode's own module (`mode.support`'s app map/knowledge files, `mode.cd`'s project notes) or, for self-upgrade, the Project-Ghola repo itself, and the bootstrap defers to it rather than reporting a missing ticket. The branch may still carry a `ticket_key` (informational) — you may append it (`... — branch carries {ticket_key}`) but do not treat it as a session ticket.
- `mode.ticket-work` not enabled: `[ghola] ✅ Ticket: (ticket-work module off)` — the probe may still carry `ticket_*` fields, but with the module off, report it disabled.

### 7. `notes`

Read `vault`, `notes_file`, `notes_exists`, and `session_mode`. The probe READS the vault; it never writes. `tool.obsidian-notes` owns the vault path and the write discipline; `mode.ticket-work` owns the per-ticket file convention.

- Resuming an existing file (`notes_exists=yes`): `[ghola] ✅ Notes: {Project}/{Number}.md resuming` (append `from {handoff_date}` when the resume step has it).
- Not yet created (`notes_exists=no`, vault + ticket present): render `[ghola] ✅ Notes: {Project}/{Number}.md (to create)`. **TPM creates the file AFTER the probe via `tool.obsidian-notes`** — the probe is read-only and never creates it. Once created, this line reflects `... created`.
- Mode-gated skip (`ticket_state=skipped` — `session_mode` is `support`, `cd`, or `self-upgrade`): `[ghola] ✅ Notes: ({session_mode} mode — surface owned by mode.{session_mode})`; a self-upgrade session (no `mode.self-upgrade` module — it is a tool) renders `[ghola] ✅ Notes: (self-upgrade — not ticket-scoped)`. The neutral "surface owned by" wording is correct for both `support` (whose surface is its app map) and `cd` (whose surface is the project notes `Projects/<name>.md`). This is a CLEAN skip, not a failure — render `✅`, never `❌`, and never report a missing ticket-notes file. In a non-ticket mode the probe does NOT guess a ticket-notes path (`notes_exists=no`, `notes_file=none`) because that mode owns its own work surface: `mode.support` uses `Support/<APP>.md` (its app map / knowledge files), `mode.cd` uses `Projects/<basename>.md`, and self-upgrade operates on the Project-Ghola repo itself. The bootstrap defers to that mode's module for the notes surface; `vault` is still resolved and emitted (mode-agnostic).
- No vault resolved (`vault=none`), no ticket (`ticket_key=none`), or `tool.obsidian-notes` off: skip cleanly — emit nothing for this step, or `[ghola] ✅ Notes: (no vault)` / `[ghola] ✅ Notes: (no ticket)` when a visible marker is preferred. Never block on missing notes.

### 8. `mode-detection`

Read `mode` (`planning` \| `review` \| `author`), plus `base`/`ahead` for context, and `session_mode` to decide applicability. The probe computed the mode from git state: `planning` when `ahead=0` against `base`; `review` when branch commits are authored by someone other than the current git user; `author` otherwise (and the safe default when cwd is not a git repo).

**Applicability — omit for non-ticket modes.** This is a git DEVELOPMENT mode (author/planning/review), a ticket-development concept that drives lens auto-kick and similar ticket-work flows. It is meaningless in the three non-ticket-scoped modalities, so when `session_mode` is `support`, `cd`, or `self-upgrade`, **OMIT this trace line entirely** — do not render a `Dev mode:` line and do not render a skip placeholder; the step simply does not apply. For `ticket-work`, `unconstrained`, and War Mode / Sardaukar sessions, render it exactly as below (the git planning/review/author detection is still meaningful there, e.g. for lens dispatch).

The line is labeled **`Dev mode:`** — not `Mode:` — to disambiguate it from the banner's `Mode` row: the banner `Mode` row shows the session modality (`ticket-work`), while this line shows the git dev-mode (`author`/`planning`/`review`). When applicable, emit `[ghola] ✅ Dev mode: planning`, `[ghola] ✅ Dev mode: review`, or `[ghola] ✅ Dev mode: author` (e.g. `[ghola] ✅ Dev mode: author (31 commits ahead of dev)`).

When the mode is **planning** or **review** AND `tool.lenses` is enabled, hand off to that module to kick the lens flow AFTER the probe — its Session-Start Auto-Detection Triggers own the actual lens dispatch (this step only reports the detected mode and defers). When `tool.lenses` is off, just report the mode.

### 9. `resume`

Read `handoff_date` from the digest. When it is present, read the captured `## Session Handoff (...)` block from the `detail_file` to summarize it. Delegate to `tool.session-handoff` for the resume protocol: surface a summary and **WAIT — do not auto-continue work**. Also surface any feedback the other enabled proactive modules provide at this point.

- Handoff found (`handoff_date` present): `[ghola] ✅ Resume: {handoff_date} handoff found`
- No handoff / fresh notes file / no notes (`handoff_date` absent): `[ghola] ✅ Resume: fresh session`

Do NOT auto-continue the prior session's work — surface the handoff and let the user direct.

### 10. `ready`

Emit `[ghola] ✅ Ready`, THEN a **single one-line greeting** — one sentence plus a short closing question, and nothing more. This one line is the user-facing greeting; the ten `[ghola]` lines above it are the diagnostic trace, and the greeting must NOT repeat them. Everything factual (version, work repo, branch, team, dev mode, resume state) is already in the trace directly above, so the greeting does not restate it. **Do NOT** render a multi-paragraph brief, do NOT re-narrate any `[ghola]` trace line, do NOT explain what the mode does, do NOT list sub-toggles, and do NOT summarize the ticket's AC. The greeting is only: a time salutation, an optional operator name, ONE short mode-appropriate context clause, and a short mode-appropriate ask. If the user wants detail, they ask for it.

**Greeting format:** `{TimeSalutation}[, {userName}] — {mode context clause}. {mode ask}`

- **`{TimeSalutation}`** — derived from the probe's `now` field (see "Time-aware salutation" below): Good morning / Good afternoon / Good evening.
- **`[, {userName}]`** — the Operator Profile name when `tool.operator-profile` provides a non-empty name; OMIT the name AND its comma when there is no name, giving `Good evening — {context}. {ask}`.
- **`{mode context clause}`** — ONE short clause, mode-appropriate, drawn from boot data already gathered. At most ~2 facts (e.g. ticket status + fresh/resume). Do NOT restate the work repo, branch, or version — they are in the trace.
- **`{mode ask}`** — a short, mode-appropriate closing question.

Per-mode context clause + ask (the guide; the TPM fills in the live values):

| Mode | context clause | ask | Example |
| --- | --- | --- | --- |
| ticket-work | `{KEY} ({status}, {fresh \| resuming from <date>})` | `What's the goal?` (or `What do you want to work on?`) | `Good evening, Alex — CMMS-2791 (In Progress, author mode). What's the goal?` |
| ticket-work + War Mode | prefix the ticket-work context with `⚔️ War Mode, ` | `What's the mission?` | `Good evening, Alex — ⚔️ War Mode, CMMS-2791 (In Progress, fresh). What's the mission?` |
| support | `Support — {N} of {M} apps mapped` (or `{APP} auto-wired` when relevant) | `Which app has the issue?` | `Good afternoon, Alex — Support — 3 of 4 apps mapped. Which app has the issue?` |
| cd | `{project} project` (+ `resuming from <date>` if a handoff exists) | `What are we working on?` | `Good morning, Alex — cmms0 project. What are we working on?` |
| self-upgrade | `Self Upgrade (Project-Ghola)` | `Run the upgrade check?` | `Good evening, Alex — Self Upgrade (Project-Ghola). Run the upgrade check?` |
| sardaukar | `Sardaukar — {repo basename}` | `What are we doing?` | `Good evening, Alex — Sardaukar — cmms0. What are we doing?` |
| unconstrained | `{repo basename}` (or omit the clause) | `What do you want to work on?` | `Good evening, Alex — cmms0. What do you want to work on?` |

For **self-upgrade**, when the Project-Ghola repo guard is `wrong` (see step 4's Self Upgrade guard), the greeting instead surfaces the guard refusal (Self Upgrade only runs in Project-Ghola — cd there and relaunch) in place of the normal `Run the upgrade check?` ask — keep that refusal behavior.

The greeting is ONE line: it may wrap in the terminal, but it is a single sentence plus a question — no paragraphs, no bullet lists, no mode explanations, no AC summaries, no sub-toggle dumps. A proactive mode module contributes only its context clause and ask (per its own fragment) — it does not reopen the paragraph. Read the `detail_file` here ONLY if a fact the one context clause needs is genuinely not already in the digest (rare — the digest carries the ticket status) — never to compose a brief. After this step, the bootstrap is done for the session.

**Time-aware salutation.** Derive the greeting's salutation from the probe's `now` field (format `YYYY-MM-DD HH:MM TZ (Weekday)`) — parse the hour (the `HH` in 24-hour form) and use **Good morning** for hour < 12, **Good afternoon** for hour 12–16, and **Good evening** for hour >= 17. Never hardcode a fixed salutation (a hardcoded "Good morning" at 19:29 is a bug); it must track the actual time in `now`. When `tool.operator-profile` is loaded and provides a non-empty user name, the salutation addresses the operator by name (e.g. `Good evening, Alex — ...`); otherwise use no name (just the time salutation, e.g. `Good evening — ...`). This works even when `tool.operator-profile` is absent: in that case there is no configured name, so the salutation is time-only with no name. See `tool.operator-profile` for the name/persona details when it is loaded.

## Custom Steps

The kv-table lets users add project-specific steps beyond the default ten. Each entry is a step name plus a one-line description; TPM runs the step by interpreting the description as an instruction and rendering a `[ghola] ✅/❌` line for it in sequence. The consolidated probe covers only the ten default steps' data — a custom step gathers whatever its description implies, which may require its own command. Keep that command a single call where you can, in the spirit of the consolidated probe. Examples:

- A step named `ci-status` with description `"Run gh run list --limit 5 and surface failing checks"` — TPM runs the gh CLI and reports.
- A step named `env-staleness` with description `"Warn if the local .env file is older than 7 days"` — TPM checks the file's mtime and emits a warning if applicable.

This is informal — TPM does whatever the description plainly implies, applying the same care it would to any user instruction, and the same never-stall rule applies. Custom steps are subject to the same `parameters.failureBehavior` and `parameters.outputFormat` as the default steps.

Disable individual steps via the kv-table's Enabled checkbox without deleting them. Reorder by editing the kv-table; declared order is run order.

## Output Formats

The format is controlled by `parameters.outputFormat`. All three render from the SAME single-probe digest — the format only changes how much of the trace is shown, never how many probes run (always one).

- **`detailed`** (default) — emit one line per step in the shared contract shape: `[ghola] ✅ <desc>` on success, or `[ghola] ❌ <desc> (<reason>)` on failure. This is the most informative format and the one every per-step section above is written for.
- **`compact`** — emit a single line summarizing the entire boot phase, e.g. `Boot: 10/10 steps OK` or `Boot: 9/10 steps OK, 1 failed (ticket)`. Compute the tally from the digest fields (each `none`/`fail`/missing field is the corresponding step's failure). Useful when the per-step trace is noise for an experienced user. The final one-line greeting (step 10) still prints.
- **`silent`** — emit no `[ghola]` diagnostic lines. The probe still runs once and its results (resolved branch, discovered vault, notes-file status, surfaced handoff) still inform the session; the user sees only the one-line greeting. Note that delegated modules consulted after the probe (e.g. `tool.lenses` dispatch, `tool.obsidian-notes` file creation) may still emit their own messages — `silent` controls this bootstrap's diagnostics, not the downstream modules.

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
- **Module enabled, only the `ready` step is enabled**: the bootstrap emits `[ghola] ✅ Ready` plus the one-line greeting and nothing else. A minimal "session started" signal without the diagnostic detail; the probe still runs once so the greeting has data to draw on.
- **Module enabled, a domain step's delegated module is off**: the step still renders from the probe's digest and degrades per its per-step section above (plain env/git report, or a clean skip) — it never blocks the sequence.
- **Module enabled, a step has no matching default behavior** (a custom step): TPM treats the step's description as an instruction and does its best to honor it, rendering a `[ghola]` line for it. If the description is ambiguous, TPM may surface a question to the user before proceeding, or skip the step with a warning per `failureBehavior`.

Do not merge these cases.

## Sibling-Module Interaction

- **`mode.ticket-work`, `tool.obsidian-notes`, `tool.session-handoff`, `tool.lenses`, `tool.core-allocation`** — the domain owners this module delegates to for MEANING (steps 3, 6, 7, 8, 9). The consolidated probe performs the read-only gathering for these steps in one shot, but their content remains authoritative for WHAT each field means and for any WRITES (notes-file creation, lens dispatch) that happen AFTER the probe. This module decides WHEN (in which step) and HOW the probe's result is reported in the boot diagnostics. If a delegated module changes its internal behavior, no change here is needed — the step reads it for meaning and renders the probe's field. If a delegated module is absent, the step degrades per its per-step section.
- **`tool.statusline`** — independent. The statusline is a continuous display; the bootstrap is a one-time boot phase. No interaction.

## Role-Specific Notes

This module targets TPM only. SWE and QA are not involved in the boot sequence.

### TPM

You are the bootstrap orchestrator. At session start, before responding to the user's first message, gather the read-only boot data in **dependency-respecting waves** (see "Parallel-Wave Execution"): a Wave-1 `echo` resolving ONLY `$GHOLA_ROOT` (and any unresolved prompt path) — not team/version/env, which the probe reports — then in ONE message run the consolidated probe (`bash "$GHOLA_ROOT/scripts/ghola-boot-probe.sh"`) alongside the reads of the remaining proactive module `.md` files, then in ONE message ALL the probe-dependent follow-ups together as multiple concurrent tool calls: the `detail_file` read, the read of any mode-specific module content still needed (e.g. `tool.ghola-ledger`), AND the mode-specific post-probe command (e.g. War Mode's `node "$GHOLA_ROOT/scripts/ghola.mjs" boot --subject <s>`). Do NOT split Wave 3 into a separate detail-read message and a separate `ghola boot` message — they depend only on the probe's output, not on each other, so batch them into the same message. The probe still runs exactly ONCE; batching it with the independent reads only makes the gathering concurrent, losing no context. The digest now includes `now=` for the current date/time — do NOT run a separate `date`. Then read `parameters.steps` and render each enabled step in declared order (the ten-step sequence above by default) from the probe's `key=value` digest. Emit per `parameters.outputFormat`; respect `parameters.failureBehavior` where it applies; append timings per `parameters.includeTimings`. Read the `detail_file` named in the digest ONLY when you need the handoff block (resume), or rarely a ticket fact the one-line greeting needs that the digest lacked — the digest alone is enough for every `[ghola]` line and for the greeting, and skipping the detail file keeps the boot quiet. The probe is read-only: notes-file CREATION (when `notes_exists=no`) and any Obsidian writes are still yours to perform via `tool.obsidian-notes` AFTER the probe, and the lens dispatch for planning/review mode is `tool.lenses`' to perform AFTER the probe. For the domain steps (`ticket`, `notes`, `mode-detection`, `resume`, and `team-allocation`), the owning module remains authoritative for meaning — read its content when the step's domain needs interpretation — then render the probe's result inside this bootstrap's `[ghola]` line for that step. **Never stall on a failed step**: a missing/`none`/`fail` digest field renders the `❌`/degraded line with a one-clause reason, and you continue. Once the `ready` line and the one-line greeting are emitted, the bootstrap is done for the session; do not re-run the probe or the sequence on subsequent turns. If the user's first message arrives before the boot phase completes, still finish the sequence before responding — the diagnostics and the one-line greeting are part of the opening turn, not a separate output.
