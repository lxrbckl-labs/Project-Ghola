# Session Bootstrap

When this module is loaded, TPM has a codified session-start sequence that runs **before** responding to the user's first message. This module is the orchestration layer for the boot phase — it walks an ordered list of steps, dispatches the proactive-modules step out to every other enabled `proactive: true` module, emits user-facing boot diagnostics, and then hands control back to normal turn processing. It extends the universal hard rules; it never relaxes them.

This module is **proactive**: TPM reads it once, at session start, before responding to the user's first request. The steps in `parameters.steps` run in declared order. After the final step emits, the bootstrap is done for the session — it does not re-run on subsequent turns.

## What The Bootstrap Does

TPM walks `parameters.steps` in declared order, running each step whose `enabled` flag is true. Each step name maps to a behavior; the step's description is the one-line instruction TPM follows when running it.

The `proactive-modules` step is a **meta-step**: it consults every other enabled module with `proactive: true` in turn and lets each module do its own session-start work according to that module's content. This bootstrap module orchestrates the dispatch and reports per-step results; it does NOT re-implement what each proactive module already does. The authority for WHAT each proactive module does lives in that module's `.md` file. This module decides WHEN it runs (in which step) and HOW the user sees it reported.

Steps with no built-in behavior — i.e. custom steps the user has added to the kv-table — are run by interpreting the step's description as an instruction. See "Custom steps" below.

## The Default 5-Step Sequence

The seeded defaults match the standard 5-step boot convention. In declared order:

- **`config-load`** — read the active configuration file (typically the session configuration file or workspace state). Surface the loaded configuration's key shape (which sections are present, which feature flags are on). If the file is missing, treat it as a step failure and apply `parameters.failureBehavior`.
- **`team-allocation`** — compute the performance / efficiency / QA core counts from the loaded configuration. Surface the team shape in the form `"2 performance + 1 efficiency + 1 QA"` so the user sees the agent fan-out for this session. If the configuration does not declare team allocation, fall back to a sensible default and note it.
- **`branch-detection`** — run `git rev-parse --abbrev-ref HEAD` to detect the active branch and cache the name for downstream proactive modules. Check the base branch as well — per `tool.lenses`'s `triggerBaseBranch` if that module is loaded, or `main` as the fallback. Surface both the active branch and the base. If `git rev-parse` fails (not a git repo, detached HEAD), treat as step failure.
- **`proactive-modules`** — the meta-step. Walk every other enabled module with `proactive: true` in load order and consult its content per the module's session-start protocol. The conventional set, in load order: `tool.fastpath-check`, `tool.obsidian-notes`, `tool.setup-walkthrough`, an active session mode (`mode.cd`, `mode.ticket-work`, or `mode.support`), `tool.session-handoff`, and `tool.lenses` auto-detection triggers. Session-handoff runs AFTER the active session mode because the mode resolves the per-scope notes path (per-ticket for `mode.ticket-work`, per-project for `mode.cd`, per-app for `mode.support`) that session-handoff then reads from. The exact set is whatever is actually enabled — read the Session Manifest and consult each one. Each proactive module's own opening message (e.g. fastpath-check's `/mnt/c/...` advisory, obsidian-notes' vault discovery report) surfaces inside this step.
- **`ready`** — emit a single line signaling the boot phase is complete. Subsequent user messages are processed normally; the bootstrap does not run again for this session.

## Custom Steps

The kv-table lets users add project-specific steps beyond the default five. Each entry is a step name plus a one-line description; TPM runs the step by interpreting the description as an instruction. Examples:

- A step named `ci-status` with description `"Run gh run list --limit 5 and surface failing checks"` — TPM runs the gh CLI and reports.
- A step named `env-staleness` with description `"Warn if the local .env file is older than 7 days"` — TPM checks the file's mtime and emits a warning if applicable.

This is informal — TPM does whatever the description plainly implies, applying the same care it would to any user instruction. Custom steps are subject to the same `parameters.failureBehavior` and `parameters.outputFormat` as the default steps.

Disable individual steps via the kv-table's Enabled checkbox without deleting them. Reorder by editing the kv-table; declared order is run order.

## Output Formats

The format is controlled by `parameters.outputFormat`:

- **`detailed`** (default) — emit one line per step in the form `[nomeda] ✓ step-name — detail` on success, or `[nomeda] ✗ step-name — error reason` on failure. The `detail` is whatever the step produced (e.g. `[nomeda] ✓ branch-detection — feature/foo (base main)`). This is the most informative format.
- **`compact`** — emit a single line summarizing the entire boot phase, e.g. `Boot: 5/5 steps OK (312ms)` or `Boot: 4/5 steps OK, 1 failed (config-load)`. Useful when the per-step output is noise for an experienced user.
- **`silent`** — emit nothing. The steps still run and their side effects (cached branch name, surfaced advisories from proactive modules) still apply, but the user sees only TPM's first response. Note that proactive modules consulted in the `proactive-modules` step may still emit their own opening messages — `silent` controls the bootstrap's diagnostics, not the downstream modules.

## Failure Behavior

The behavior on step failure is controlled by `parameters.failureBehavior`:

- **`warn-and-continue`** (default) — on step failure, emit the failure marker per the output format and proceed to the next step. The session continues in a possibly-degraded state. This keeps sessions usable when a non-critical step fails.
- **`halt`** — on step failure, emit the warning and refuse to respond to the user's first message until the failure is resolved. Useful when a step is critical (e.g., `config-load` failing means nothing downstream is reliable). Surface the failure plus a one-line instruction for what the user needs to do.
- **`retry-once`** — on step failure, retry the step a second time. If it succeeds, proceed normally and note the retry in the diagnostics. If it fails again, fall back to `warn-and-continue` semantics — emit the failure marker and proceed.

## Timings

When `parameters.includeTimings` is true, append the elapsed wall time to each step's diagnostic line (`[nomeda] ✓ proactive-modules — 312ms` or, when there is also a step detail, `[nomeda] ✓ branch-detection — feature/foo (base main) — 48ms`). When false, omit timings entirely. The flag is intended for diagnosing slow boots; keep it off in normal use.

## Module-Disabled Vs Feature-Disabled

These are distinct configurations and must be treated separately:

- **Module disabled** (no `tool.session-bootstrap` in the Session Manifest): TPM does NOT run a coordinated boot sequence. Each proactive module still fires its own session-start work independently per its own content, but no orchestration layer ties them together and no user-facing boot diagnostic is emitted. The session proceeds with whatever opening messages each proactive module produces on its own.
- **Module enabled, all steps disabled in the kv-table**: the bootstrap runs but produces no work and emits no output. Equivalent to module-disabled from the user's perspective, but the orchestration framework is loaded — re-enabling a single step turns it back on without touching the module list.
- **Module enabled, only the `ready` step is enabled**: the bootstrap emits the `Ready` line and nothing else. Useful as a minimal "session started" signal without the diagnostic detail.
- **Module enabled, a step has no matching default behavior** (a custom step): TPM treats the step's description as an instruction and does its best to honor it. If the description is ambiguous, TPM may surface a question to the user before proceeding, or skip the step with a warning per `failureBehavior`.

Do not merge these cases.

## Sibling-Module Interaction

- **All `proactive: true` modules** — this module orchestrates them through the `proactive-modules` step. Their content remains authoritative for WHAT each does; this module decides WHEN (in which step) and HOW it is reported in the boot diagnostics. If a proactive module changes, no change to this module is needed — the meta-step picks up the new module automatically as long as it carries `proactive: true`.
- This module handles both orchestration and the user-facing output rendering.
- **`tool.statusline`** — independent. The statusline is a continuous display; the bootstrap is a one-time boot phase. No interaction.
- **`tool.mid-session-bootstrap`** — distinct from this module. Mid-session bootstrap fires when a ticket id is mentioned mid-session, not at session start; the two do not overlap.

## Role-Specific Notes

This module targets TPM only. SWE and QA are not involved in the boot sequence.

### TPM

You are the bootstrap orchestrator. At session start, before responding to the user's first message, read `parameters.steps` and run each enabled step in declared order. Emit per `parameters.outputFormat`; respect `parameters.failureBehavior` when a step fails; append timings per `parameters.includeTimings`. The `proactive-modules` step is the meta-step where you consult every other enabled `proactive: true` module — read each one's content and let it do its own session-start work, then report the result inside the bootstrap's diagnostic line for that step. Once the `ready` line is emitted, the bootstrap is done for the session; do not re-run it on subsequent turns. If the user's first message arrives before the boot phase completes (rare, but possible if a step is slow), still finish the bootstrap before responding — the diagnostics are part of the opening turn, not a separate output.
