# Core Allocation

When this module is loaded, TPM has a single project-wide convention for sizing each dispatch — how many SWE slots to use, at what model tier, and how to scale up under priority pressure. The convention was previously inlined in TPM's core behavior; this module promotes it to a configurable policy so the performance/efficiency split, the difficulty-to-model mapping, and the high-priority posture can be tuned per project. The fragment is targeted at TPM only — SWE and QA do not make these decisions and are not asked to read this module.

This module is **not proactive**. It does not fire at session start. The rule applies on-demand, exactly when TPM is about to dispatch SWE work. Without an in-flight dispatch decision, this module sits quietly.

## The core pattern

The dispatch envelope is split into two pools:

- **Performance cores** handle the primary task — primary code work, complex logic, critical path. They are always dispatched FIRST. `parameters.performanceCores` sets the count.
- **Efficiency cores** handle side tasks when performance cores are busy — minor fixes, research passes, simple changes. They NEVER displace performance cores; a free performance core always wins over an efficiency core for any work that fits its scope. `parameters.efficiencyCores` sets the count.

Total concurrent SWE count never exceeds `parameters.performanceCores + parameters.efficiencyCores`. TPM does not silently exceed the envelope — if a task plainly needs more slots than the configured total, surface that to the user rather than over-dispatching.

High-priority tasks override the standard split per `parameters.highPriorityMode`. See "High-priority dispatch" below for the per-mode semantics.

## Model-by-difficulty mapping

`parameters.modelByDifficulty` is a user-controlled map keyed by tier name (`low`, `medium`, `high` by default), valued by model name. Each SWE assignment carries a declared difficulty; TPM looks the difficulty up in the map and dispatches at the named model.

The seeded defaults match the SWT convention: `low → haiku`, `medium → sonnet`, `high → opus`. The mapping is fully user-controlled:

- **Add new tiers** — e.g. `critical → opus-1m` for tasks that need the larger context window, `routine → haiku` for trivial fixes.
- **Rename tiers** — e.g. use `routine` instead of `low`, `standard` instead of `medium`, `complex` instead of `high`. TPM uses whatever keys the map contains; the names are not hardcoded.
- **Drop models** — set every tier to a single model name for uniform spend, or drop the `opus` tier entirely on cost-conscious projects.

If TPM is asked to dispatch at a difficulty tier not present in the map, surface the gap to the user ("`urgent` is not in `modelByDifficulty` — add the tier or pick an existing one") rather than picking silently.

## High-priority dispatch

Per `parameters.highPriorityMode`, TPM responds to a user-signaled high-priority task in one of three ways:

- **`all-hands`** (default): deploy EVERY slot on the same task — performance + efficiency cores all-in. All-hands-on-deck. Matches the SWT convention; appropriate when the user has explicitly raised the urgency and wants maximum parallelism.
- **`perf-only`**: deploy performance cores only; efficiency cores stay idle. Useful when the task is high-priority but does not parallelize well — extra efficiency-core SWEs would step on each other.
- **`normal`**: ignore the priority signal entirely; dispatch per the standard performance-first pattern. Useful when the user has signaled "high priority" rhetorically but the work plainly does not warrant extra slots.

The user's spoken priority is the trigger — TPM does not infer urgency from the task description alone. A task that is plainly large or complex does not become high-priority unless the user says so.

## Announcing the plan

Per `parameters.announceDispatchPlan`:

- **On** (default): before spawning SWEs, TPM tells the user the plan in one sentence. Example: "Putting SWE-1 and SWE-2 on the auth flow (Opus). SWE-3 is on standby for side tasks." The announcement names the SWE slots, the task scope, the model tier, and any standby slots. One sentence — not a paragraph.
- **Off**: dispatch silently. SWE returns still surface normally, but no upfront plan-line is emitted. Useful for users who find the announcements noisy or who already track dispatch via the status line.

The announcement is a trust-building line, not an audit log — its purpose is to let the user redirect before SWEs are spawned ("actually, put both on the auth flow, drop the side task"). Keep it short.

## What this module does NOT do

- Does NOT change SWE behavior — it's a TPM dispatch convention. SWE reads its assignment and works to it; the slot count and model choice are not visible to SWE.
- Does NOT enforce per-SWE timeouts or budget limits. If the user wants to cap individual SWE cost, that belongs in a different module.
- Does NOT track historical SWE-cost data. The module is policy, not telemetry — there is no logging, no aggregation, no reporting.

## Module-disabled vs feature-disabled

These are distinct states and must produce distinct behavior:

- **Module disabled** (no `tool.core-allocation` in the Session Manifest): TPM dispatches without the formal performance/efficiency split — uses internal defaults from its core behavior. The performance-first posture is preserved but the count, model mapping, and priority handling are not configurable.
- **Module enabled, `parameters.efficiencyCores: 0`**: TPM uses performance cores only; no secondary parallelism. The performance pool is unaffected; side tasks queue behind primary work instead of running concurrently.
- **Module enabled, `parameters.announceDispatchPlan` off**: silent dispatch. The split and model selection still apply; only the upfront plan-line is suppressed.

Do not merge these cases.

## Relationship to existing module sections

TPM's core behavior previously inlined the performance/efficiency convention as part of its standard dispatch posture. With this module loaded:

- The inline core rules become AUTHORITATIVE-RECEIVER for the policy this module defines — they cite this module rather than restating the rule. TPM uses this module's exact settings (`parameters.performanceCores`, `parameters.efficiencyCores`, `parameters.modelByDifficulty`, `parameters.highPriorityMode`, `parameters.announceDispatchPlan`) in preference to anything the core says inline.
- When this module is DISABLED, the inline core rules act as the fallback — they preserve the performance-first posture so the convention is not lost when this module is missing.
- When this module is ENABLED, the inline core rules defer to this module's exact settings.

This module does NOT modify the core; the deference is by convention. Future cleanup may prune the inline rules once this module is the established norm, but that is a separate concern — the inline rules stay in place as the safety net until then.

## Role-Specific Notes

### TPM

You are the policy-bearer. Before each dispatch, decide the slot count and model tier per the settings: read `parameters.performanceCores` and `parameters.efficiencyCores` to bound the envelope, declare each assignment's difficulty and look it up in `parameters.modelByDifficulty` to pick the model, and check `parameters.highPriorityMode` against the user's stated urgency. If `parameters.announceDispatchPlan` is on, surface the plan in one sentence before spawning. If a dispatch would exceed the envelope, would name an unmapped difficulty tier, or would deploy at a tier the user has not pre-approved, surface to the user rather than improvising.

### SWE

Not involved in allocation decisions. You receive an assignment with a model already selected; work it.

### QA

Not involved. Allocation is a TPM concern.
