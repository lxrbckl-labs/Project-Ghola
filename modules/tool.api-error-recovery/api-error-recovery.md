# API Error Recovery

When this module is loaded, TPM becomes **resilient to transient server-side API errors** while delegating work to subagents. Instead of surfacing a fleeting infrastructure hiccup as a dead stop, TPM checks Claude's service health, waits out an escalating backoff, and redeploys a fresh subagent with the SAME role prompt and the SAME task. This module authorizes that recovery loop and bounds it with a hard retry cap; it does not change what any agent was asked to do.

This module is **not proactive**. It does not fire at session start and it changes nothing while delegations are succeeding. It applies on-demand, exactly at the moment a delegated subagent terminates early or fails due to a transient API/infra error. With no such failure in flight, this module sits quietly.

## Trigger and classification

This module fires ONLY when a delegated SWE/QA subagent **terminates early or fails due to a transient server-side / infrastructure API error** — a failure of the platform, not of the task. It also covers the classifier/availability variant seen in practice: a model reported `temporarily unavailable` so auto mode cannot dispatch the subagent at all.

Default retriable signatures (from `parameters.retriableErrors`): HTTP `529` (Overloaded), `500`, `502`, `503`, `504`, `429`, and the text markers `Overloaded`, `API Error`, `terminated early due to an API error`, `overloaded_error`, and `temporarily unavailable`. A failure that matches one of these is a candidate for recovery.

**CRITICAL distinction — this is the line that must never blur.** This module covers ONLY transient API/infra failures. A **genuine task failure** — the agent ran, did the work, and the work failed; a real bug; a bad or impossible assignment; a test that legitimately fails; a permission denial — is **NOT retriable here** and must be reported normally. Redeploying a fresh agent against a genuine failure just burns attempts and, worse, can mask a real defect as "just overloaded." When a failure does not clearly match a transient signature, treat it as a genuine task failure and report it; do not stretch the classification to force a retry.

## Recovery procedure

On a qualifying transient failure, TPM runs this sequence:

1. **Check Claude status.** If `parameters.checkStatusPage` is on (default), TPM uses its web-fetch capability to GET `parameters.statusUrl` and read the incident indicator, then reports it to the user in ONE line — `Claude status: all systems operational` or `Claude status: INCIDENT - <description>`. The default URL is the Atlassian Statuspage summary endpoint, whose JSON exposes `status.indicator`, `status.description`, and an `incidents` array. If the status fetch itself fails, note that in one line and **proceed to retry anyway** — a failed status check must never block recovery.
2. **Back off.** Wait per `parameters.backoffSeconds` (default `5,15,45`): the first value is the wait before attempt 1, the second before attempt 2, and so on; if attempts exceed the listed values, the last value is reused. Escalating backoff gives a transient incident time to clear.
3. **Redeploy a fresh subagent.** Subagents are EPHEMERAL and cannot resume, so "retry" means **spawn a NEW subagent with the SAME injected role prompt and the SAME task assignment** — never a narrowed, widened, or otherwise altered task. For an overload or `429` failure, if `parameters.reduceConcurrencyOnOverload` is on (default) TPM reduces parallelism and staggers dispatch on redeploy — fewer simultaneous subagents to ease pressure during an incident; for other transient errors, or when the setting is off, it redeploys at the same concurrency.
4. **Cap and escalate.** Retry up to `parameters.maxRetries` (default 3) total attempts. If the delegation is still failing after the cap, **STOP — do not loop** — and surface to the user: the failure and its signature, the status findings, the attempts made, and a recommendation (wait and retry later, check https://status.claude.com). The cap is a hard safety stop, never ignored and never exceeded.

## Posture: `parameters.posture`

`parameters.posture` sets how TPM handles a qualifying failure. Per the preamble's parameter-authority rule this value is authoritative:

- **`autonomous`** (default): TPM checks status and retries automatically, posting one line per attempt as it goes. No approval gate between attempts, up to the cap.
- **`ask`**: TPM reports the failure and the status result, then WAITS for the user to approve before redeploying. Nothing is retried until the user says go.

## Settings

`parameters.*` are authoritative — do not default, infer, or substitute values that merely resemble them.

| Setting | Gates |
| --- | --- |
| `posture` | `autonomous` (check status + retry automatically) or `ask` (report, then wait for approval). |
| `maxRetries` | Hard cap on total retry attempts before TPM stops and escalates. Never looped past. |
| `backoffSeconds` | Comma-separated escalating wait (seconds) before each attempt; last value reused if attempts exceed the list. |
| `checkStatusPage` | Whether TPM fetches the status page on a qualifying failure before retrying. |
| `statusUrl` | Read-only URL GET for Claude service health; defaults to the Statuspage summary endpoint. |
| `retriableErrors` | The signatures (HTTP codes + text markers) that classify a failure as transient and retry-eligible; anything else is a genuine task failure. |
| `reduceConcurrencyOnOverload` | Whether an overload/429 prompts reduced parallelism and staggered dispatch on redeploy. |

## Safety floor (hard, non-relaxable)

These rules are cumulative with every other module's rules and hard rules. They are NOT relaxed by any posture setting — not even `autonomous`. Where any other rule is stricter, the stricter rule wins.

- **Transient failures only.** Retry ONLY a failure that matches a `parameters.retriableErrors` signature. NEVER auto-retry a genuine task failure, and never mask a real bug, bad assignment, or legitimate test failure as "just overloaded." When in doubt, treat it as genuine and report it.
- **Hard attempt cap.** Never exceed `parameters.maxRetries`, never infinite-loop, never ignore the cap. After the cap, stop and escalate to the user.
- **Same task, unchanged.** A retry re-runs the SAME assignment with the SAME injected role prompt, scope, and permissions. Retrying NEVER changes the task's scope, permissions, or what the agent was told to do — it must not quietly alter the assignment.
- **Never route around a guardrail.** Recovery must never weaken or bypass another module's guardrails or a hard rule. Rules are cumulative; the stricter one wins. A retry that would need relaxed permissions is not a retry — it is a new task and must be surfaced.
- **Read-only status access, no secrets.** The status check is read-only web access. Never put a token or secret on any command line and never echo credentials while fetching status.
- **Report everything.** Report every retry attempt and the final outcome. Never silently swallow a failure or a successful recovery — the audit trail must show what failed, what status showed, each attempt, and how it resolved.

## Module-disabled vs feature-disabled

These are distinct states and must produce distinct behavior:

- **Module disabled** (no `tool.api-error-recovery` in the Session Manifest): TPM has no sanctioned recovery loop. A transient API failure is surfaced to the user as a stop, exactly like any other failure; TPM does not check status, back off, or redeploy on its own initiative.
- **Module enabled, `parameters.posture` = `autonomous`** (default): TPM checks status, backs off, and redeploys a fresh subagent automatically, one line per attempt, up to `parameters.maxRetries`. Subject to the full safety floor.
- **Module enabled, `parameters.posture` = `ask`**: TPM checks status and reports the failure, then waits for user approval before each redeploy. Nothing is retried autonomously.

Do not merge these cases.

## Role-Specific Notes

The body above applies to the delegation lifecycle TPM owns. The notes below frame each role.

### TPM

You are the primary — the ONLY — actor for this module. You own delegation, so you own recovery. When a subagent you dispatched terminates early or fails, first CLASSIFY: does the failure match a `parameters.retriableErrors` signature (a transient server/infra error or a `temporarily unavailable` model), or is it a genuine task failure? Only a transient match enters this loop; a genuine failure you report normally and never retry here. On a transient match, run the recovery procedure: check Claude status (if `parameters.checkStatusPage`) and report it in one line, wait per `parameters.backoffSeconds`, then redeploy a FRESH subagent with the SAME role prompt and SAME task — reducing concurrency on an overload if `parameters.reduceConcurrencyOnOverload` is on — up to `parameters.maxRetries`, after which you STOP and escalate to the user with the failure, status findings, attempts, and a recommendation. Honor `parameters.posture`: under `ask`, report and wait for approval before each redeploy. A retry sequence must be **visible**, and your Brevity Contract already requires it: a failure is on its mandatory disclosure list, so the underlying error is never something you sit on. Disclose it, do not narrate it — post **one line per retry attempt and one line for the final outcome**, and nothing in between, since silence while an attempt is in flight is correct. For example: "SWE-2 hit a `529`; Claude status shows a minor incident; redeploying attempt 2/3 after 15s." That shape is both terse and fully disclosed. Never let recovery change the task's scope or permissions, never exceed the cap, and never silently swallow the failure.

### SWE

You do not run this module. If you hit a transient API/infra error mid-task, you simply terminate and let your failure surface — TPM classifies it and, if it is transient, redeploys a fresh you with the same assignment. You do not check status, retry yourself, or alter the task on the way down. A genuine task failure (a real bug, a blocked step, an impossible assignment) you report clearly and honestly so TPM does NOT mistake it for a transient error and retry it — mislabeling your own failure as "overloaded" would mask a real defect.

### QA

You do not run this module either. A transient API/infra error mid-verification means you terminate and report; TPM handles any redeploy. Keep your verdicts precise so TPM can tell a transient infrastructure failure apart from a genuine failed check — never dress up a real defect or a legitimately failing test as an "API error," because that would send a healthy retry against work that actually needs a fix.
