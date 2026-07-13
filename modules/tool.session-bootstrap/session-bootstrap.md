# Session Bootstrap

When this module is loaded, TPM has a codified, ordered, diagnostic-rendering **startup sequence** that runs **before** responding to the user's first message. This module is the orchestration layer for the boot phase — it walks the ordered `parameters.steps` list, delegates each domain step to the proactive module that owns it, emits one user-facing boot-diagnostic line per step, and then hands control back to normal turn processing. It extends the universal hard rules; it never relaxes them.

This sequence is the **Ghola analog of SWT's TPM Startup Sequence** — the same shape (identify the version, confirm the environment, size the team, sanity-check the work repo, resolve the ticket and its notes, detect the working mode, surface where the last session left off, then declare readiness), expressed through Ghola's module-driven architecture. Where SWT hardcoded the sequence into one prompt, Ghola splits the work: this module owns the ORDER and the RENDERING, and each domain step delegates to the proactive module that owns that domain.

This module is **proactive**: TPM reads it once, at session start, before responding to the user's first request. The steps in `parameters.steps` run in declared order. After the final `ready` step emits, the bootstrap is done for the session — it does not re-run on subsequent turns.

## Orchestrate, Don't Duplicate

This module **orchestrates**. It decides WHICH steps run, in WHAT order, and HOW each is reported in the boot diagnostics. It does **not** re-implement the domain logic that a delegated module already owns — the authority for WHAT each domain step does lives in that module's `.md` file, and this module reads it and lets it do its work.

- **`ticket` delegates to `mode.ticket-work`** — that module derives the Jira key from the branch name and pulls the ticket via `integration.atlassian-suite`. This module does not re-derive keys or call Jira itself.
- **`notes` delegates to `tool.obsidian-notes`** (vault discovery) and `mode.ticket-work` (per-ticket notes-file create/read).
- **`resume` delegates to `tool.session-handoff`** — that module surfaces the most-recent handoff and waits.
- **`mode-detection` hands off to `tool.lenses`** when the detected mode is planning or review and that module is enabled — its auto-detection triggers own the lens dispatch.
- **`team-allocation` delegates the dispatch-policy detail to `tool.core-allocation`** when enabled; without it, the step still reports the team shape straight from the `SWE_*`/`QA_*` env vars.

**Graceful degradation is the rule.** Where a delegated module is not enabled, the step still runs but degrades to a plain env/git report (or skips cleanly) and continues — it never blocks the sequence. Each per-step section below states its degraded form.

## The Environment Contract

The sequence consumes environment variables the launcher exports into the session terminal. Read them from your environment (expand via your shell, e.g. `$GHOLA_VERSION`); do not invent values a variable does not carry.

- **`GHOLA_VERSION`** — the extension semver, e.g. `0.4.0`. If unset, fall back: read `$GHOLA_ROOT/VERSION`, then `$GHOLA_ROOT/package.json` (the `version` field).
- **`GHOLA_BRANCH`** — the current git branch of the work repo (the terminal cwd), or `""` when cwd is not a git repo.
- **`GHOLA_ROOT`** — the absolute path of the Ghola installation (used to resolve module content paths and the version fallbacks).
- **`GHOLA_TPM_PROMPT_FILE`, `GHOLA_SWE_PROMPT_FILE`, `GHOLA_QA_PROMPT_FILE`** — the composed agent prompts on disk.
- **`SWE_PERFORMANCE_CORES`, `SWE_EFFICIENCY_CORES`, `SWE_AGENT_COUNT`, `QA_AGENT_COUNT`** — the team envelope.
- **`SWE_PERFORMANCE_MODEL`, `SWE_EFFICIENCY_MODEL`, `QA_MODEL`** — the per-pool default models.

## The Ordered Startup Sequence

TPM walks `parameters.steps` in declared order, running each step whose `enabled` flag is true. The seeded defaults are the ten steps below, in this order. Each step emits exactly one diagnostic line per `parameters.outputFormat` (see "Output Formats") before the next step runs.

**HARD RULE — never stall on a failed step.** The whole sequence runs before the first substantive response. When a step fails, print the `✗` line with a one-clause reason and CONTINUE to the next step. A broken step degrades what depends on it; it never blocks the rest of the sequence or the final greeting. This rule holds regardless of `parameters.failureBehavior` for the git/ticket/notes steps, whose downstream degrades gracefully by design.

### 1. `version`

Resolve the extension version from `$GHOLA_VERSION`. If unset, read `$GHOLA_ROOT/VERSION`, then `$GHOLA_ROOT/package.json`.

- Success: `[ghola] ✓ Ghola v{version}`
- Failure (no env var and no readable fallback): `[ghola] ✗ Version (unknown)`

### 2. `environment`

Confirm `$GHOLA_ROOT` is set and the three agent prompt files (`$GHOLA_TPM_PROMPT_FILE`, `$GHOLA_SWE_PROMPT_FILE`, `$GHOLA_QA_PROMPT_FILE`) resolve to readable paths.

- Success: `[ghola] ✓ Environment: GHOLA_ROOT set, agent prompt files resolved`
- Failure: `[ghola] ✗ Environment (GHOLA_ROOT unset)` or `[ghola] ✗ Environment (SWE prompt file missing)` — name the missing piece and continue.

### 3. `team-allocation`

Report the team shape from the `SWE_*`/`QA_*` env vars. When `tool.core-allocation` is enabled, delegate the dispatch-policy detail (performance/efficiency split, difficulty-to-model map, high-priority posture) to it — this step only reports the shape; the policy is that module's.

- Success: `[ghola] ✓ Team: {perf} performance + {eff} efficiency + {qa} QA (perf={SWE_PERFORMANCE_MODEL}, eff={SWE_EFFICIENCY_MODEL}, qa={QA_MODEL})` — where `{perf}` is `SWE_PERFORMANCE_CORES`, `{eff}` is `SWE_EFFICIENCY_CORES`, `{qa}` is `QA_AGENT_COUNT`.
- Degraded (an env var unset): substitute the core defaults (perf 2, eff 1, qa 1; perf `opus`, eff `sonnet`, qa `sonnet`) and report the shape anyway.

### 4. `work-repo`

Run `pwd` and check for a git work tree (`git rev-parse --is-inside-work-tree`).

- Repo found: `[ghola] ✓ Work repo: {basename} ({cwd})`
- Not a repo: `[ghola] ✗ Work repo: cwd is not a git repo ({cwd}) — open your checkout as the workspace folder, or tell me the path` and **continue**. The downstream `branch`, `ticket`, and `notes` steps then degrade (no branch, no ticket auto-detect, no per-ticket notes) rather than erroring.

### 5. `branch`

Prefer `$GHOLA_BRANCH`. If it is empty, fall back to `git rev-parse --abbrev-ref HEAD`.

- Branch resolved: `[ghola] ✓ Branch: {branch}`
- Not a git repo (from step 4): `[ghola] ✓ Branch: none (not a git repo)`

The resolved branch feeds the `ticket` step's branch-to-key detection, so the two stay consistent.

### 6. `ticket`

Delegate to `mode.ticket-work` when it is enabled: it derives the Jira key from the branch name (per its `autoDetectTicketFromBranch` logic) and pulls the ticket via `integration.atlassian-suite`. This step reports the outcome; it does not re-derive the key or call Jira itself.

- Pulled: `[ghola] ✓ Ticket: {KEY} (pulled from Jira)`
- Detected but Jira unavailable (integration off, credentials missing, network error, or 404): `[ghola] ✗ Ticket: {KEY} (Jira unavailable — paste the description)` and continue.
- No key derivable from the branch (e.g. on `main`, detached HEAD, or a branch with no `KEY-123` segment): `[ghola] ✓ Ticket: none detected from branch`
- `mode.ticket-work` not enabled: `[ghola] ✓ Ticket: (ticket-work module off)`

### 7. `notes`

Delegate to `tool.obsidian-notes` for vault discovery and to `mode.ticket-work` for the per-ticket notes-file create/read. This step reports what those modules did.

- Created: `[ghola] ✓ Notes: {Project}/{Number}.md created`
- Resuming an existing file: `[ghola] ✓ Notes: {Project}/{Number}.md resuming from {date}`
- No vault resolved, no ticket, or `tool.obsidian-notes` off: skip cleanly — emit nothing for this step, or `[ghola] ✓ Notes: (no vault)` / `[ghola] ✓ Notes: (no ticket)` when a visible marker is preferred. Never block on missing notes.

### 8. `mode-detection`

Detect the working mode from git state, using `<base>` = `main` by default (infer via `git merge-base` when `main` is not local; ask the user only when inference also fails):

- **planning** — 0 commits ahead of base (`git rev-list --count <base>..HEAD` is `0`).
- **review** — branch commits authored by someone other than the current git user (`git log <base>..HEAD --format=%ae` versus `git config user.email`).
- **author** — your own commits ahead of base.

Emit `[ghola] ✓ Mode: planning`, `[ghola] ✓ Mode: review`, or `[ghola] ✓ Mode: author`.

When the mode is **planning** or **review** AND `tool.lenses` is enabled, hand off to that module to kick the lens flow — its Session-Start Auto-Detection Triggers own the actual lens dispatch (this step only detects the mode and defers). When `tool.lenses` is off, just report the mode. When cwd is not a git repo (step 4 failed), report `[ghola] ✓ Mode: author` as the safe default (no branch state to analyze) or skip cleanly.

### 9. `resume`

Delegate to `tool.session-handoff`: it resolves the active notes file, finds the most-recent `## Session Handoff (...)` block, surfaces a summary, and **waits — it does not auto-continue work**. Also surface any feedback the other enabled proactive modules provide at this point.

- Handoff found: `[ghola] ✓ Resume: {date} handoff found`
- No handoff / fresh notes file / no notes: `[ghola] ✓ Resume: fresh session`

Do NOT auto-continue the prior session's work — surface the handoff and let the user direct.

### 10. `ready`

Emit `[ghola] ✓ Ready`, THEN a concise natural-language **orientation paragraph** that ties the sequence together: the version, the work repo, the branch, the ticket (if any) with its status, the detected mode, and where things left off (from the handoff). End by asking what the user wants to work on. This paragraph is the user-facing greeting; the ten `[ghola]` lines above it are the diagnostic trace. After this step, the bootstrap is done for the session.

## Custom Steps

The kv-table lets users add project-specific steps beyond the default ten. Each entry is a step name plus a one-line description; TPM runs the step by interpreting the description as an instruction and rendering a `[ghola] ✓/✗` line for it in sequence. Examples:

- A step named `ci-status` with description `"Run gh run list --limit 5 and surface failing checks"` — TPM runs the gh CLI and reports.
- A step named `env-staleness` with description `"Warn if the local .env file is older than 7 days"` — TPM checks the file's mtime and emits a warning if applicable.

This is informal — TPM does whatever the description plainly implies, applying the same care it would to any user instruction, and the same never-stall rule applies. Custom steps are subject to the same `parameters.failureBehavior` and `parameters.outputFormat` as the default steps.

Disable individual steps via the kv-table's Enabled checkbox without deleting them. Reorder by editing the kv-table; declared order is run order.

## Output Formats

The format is controlled by `parameters.outputFormat`:

- **`detailed`** (default) — emit one line per step in the shared contract shape: `[ghola] ✓ <desc>` on success, or `[ghola] ✗ <desc> (<reason>)` on failure. This is the most informative format and the one every per-step section above is written for.
- **`compact`** — emit a single line summarizing the entire boot phase, e.g. `Boot: 10/10 steps OK` or `Boot: 9/10 steps OK, 1 failed (ticket)`. Useful when the per-step trace is noise for an experienced user. The final orientation paragraph (step 10) still prints.
- **`silent`** — emit no `[ghola]` diagnostic lines. The steps still run and their side effects (resolved branch, discovered vault, created notes file, surfaced handoff) still apply; the user sees only the orientation paragraph. Note that delegated modules consulted inside a step may still emit their own opening messages — `silent` controls this bootstrap's diagnostics, not the downstream modules.

## Failure Behavior

The behavior on step failure is controlled by `parameters.failureBehavior`. Note that the **never-stall hard rule always wins** for the git/ticket/notes steps, whose downstream degrades gracefully — those steps print their `✗` line and continue regardless of this setting.

- **`warn-and-continue`** (default) — on step failure, emit the failure marker per the output format and proceed to the next step. The session continues in a possibly-degraded state. This is the standard posture and matches the never-stall rule.
- **`halt`** — reserved for a genuinely critical setup step (e.g. a custom `config-load` step where nothing downstream is reliable without it). On failure, emit the warning plus a one-line instruction for what the user must do, and wait. Never apply `halt` to `work-repo`, `branch`, `ticket`, or `notes` — those degrade gracefully by design and halting on them would violate the never-stall rule.
- **`retry-once`** — on step failure, retry the step a second time. If it succeeds, proceed normally and note the retry in the diagnostics. If it fails again, fall back to `warn-and-continue` semantics — emit the failure marker and proceed.

## Timings

When `parameters.includeTimings` is true, append the elapsed wall time to each step's diagnostic line (`[ghola] ✓ Branch: main — 48ms`). When false, omit timings entirely. The flag is intended for diagnosing slow boots; keep it off in normal use.

## Module-Disabled Vs Feature-Disabled

These are distinct configurations and must be treated separately:

- **Module disabled** (no `tool.session-bootstrap` in the Session Manifest): TPM does NOT run this coordinated, diagnostic-rendering sequence. It falls back to the **core's session-start contract** — see the "Session Start" section of the TPM core, which directs TPM to read, in full, every module the manifest marks proactive, then announce readiness in one short paragraph and ask what to work on. That fallback is the authority when this module is absent; the ordered `[ghola]` trace and the delegation orchestration only exist while this module is loaded.
- **Module enabled, all steps disabled in the kv-table**: the bootstrap runs but produces no work and emits no output. Equivalent to module-disabled from the user's perspective, but the orchestration framework is loaded — re-enabling a single step turns it back on without touching the module list.
- **Module enabled, only the `ready` step is enabled**: the bootstrap emits `[ghola] ✓ Ready` plus the orientation paragraph and nothing else. A minimal "session started" signal without the diagnostic detail.
- **Module enabled, a domain step's delegated module is off**: the step still runs and degrades per its per-step section above (plain env/git report, or a clean skip) — it never blocks the sequence.
- **Module enabled, a step has no matching default behavior** (a custom step): TPM treats the step's description as an instruction and does its best to honor it, rendering a `[ghola]` line for it. If the description is ambiguous, TPM may surface a question to the user before proceeding, or skip the step with a warning per `failureBehavior`.

Do not merge these cases.

## Sibling-Module Interaction

- **`mode.ticket-work`, `tool.obsidian-notes`, `tool.session-handoff`, `tool.lenses`, `tool.core-allocation`** — the domain owners this module delegates to (steps 3, 6, 7, 8, 9). Their content remains authoritative for WHAT each does; this module decides WHEN (in which step) and HOW it is reported in the boot diagnostics. If a delegated module changes its internal behavior, no change here is needed — the step calls into it and reports whatever it produced. If a delegated module is absent, the step degrades per its per-step section.
- **`tool.statusline`** — independent. The statusline is a continuous display; the bootstrap is a one-time boot phase. No interaction.
- **`tool.mid-session-bootstrap`** — distinct from this module. Mid-session bootstrap fires when a ticket id is mentioned mid-session, not at session start; the two do not overlap.

## Role-Specific Notes

This module targets TPM only. SWE and QA are not involved in the boot sequence.

### TPM

You are the bootstrap orchestrator. At session start, before responding to the user's first message, read `parameters.steps` and run each enabled step in declared order (the ten-step sequence above by default). Emit per `parameters.outputFormat`; respect `parameters.failureBehavior` where it applies; append timings per `parameters.includeTimings`. For the domain steps (`ticket`, `notes`, `mode-detection`, `resume`, and `team-allocation`), delegate to the owning proactive module — read its content and let it do its own session-start work — then render the result inside this bootstrap's `[ghola]` line for that step. **Never stall on a failed step**: print the `✗` line with a one-clause reason and continue. Once the `ready` line and the orientation paragraph are emitted, the bootstrap is done for the session; do not re-run it on subsequent turns. If the user's first message arrives before the boot phase completes, still finish the sequence before responding — the diagnostics and the orientation paragraph are part of the opening turn, not a separate output.
