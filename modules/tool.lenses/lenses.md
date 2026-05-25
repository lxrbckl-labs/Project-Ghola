# Lenses

When this module is loaded, the session has two parallel-lens dispatch workflows available: **Review Mode** (read-only analysis of a colleague's branch) and **Planning Mode** (analyze a fresh ticket and return plan fragments). Both follow the same dispatch shape: TPM deploys one SWE per lens, all in parallel, then aggregates the returns. Every agent reads this same fragment; role-specific framing is collected at the end.

This module is **proactive**: TPM consults it at session start when the auto-detection triggers are enabled (per `parameters.autoKickReviewOnColleagueBranch` and `parameters.autoKickPlanningOnFreshBranch`) to inspect git state and potentially auto-kick Review Mode or Planning Mode before responding to the user's first request.

Per the preamble's parameter-allowlist rule, the values in `parameters.reviewLenses` and `parameters.planningLenses` are the only authorized lens names for this session. The full vocabulary for each is documented in a companion keywords file (`review-lenses-keywords.json` and `planning-lenses-keywords.json` in this module's root). Read them for context, but never dispatch or assume a lens that isn't actually present in the matching parameter.

## Configurable lens sets

This module exposes two parameters:

- `parameters.reviewLenses` — drives Review Mode dispatch. Default: `security, logic, quality`.
- `parameters.planningLenses` — drives Planning Mode dispatch. Default: `architecture, implementation, test-strategy`.

Parsing rules apply identically to both:

- Comma-separated. Whitespace around each entry is trimmed. Case is preserved as stored — all built-in keywords are lowercase, so match them exactly.
- Order has no effect on behavior — TPM dispatches one SWE per lens in parallel. (The settings panel rebuilds the stored string in keywords-file order on every checkbox change, so the value is always canonically ordered regardless of the order the user enabled lenses.)
- Duplicates are not possible via the checkbox UI; if a raw string value somehow contains a repeated keyword it is deduplicated by the Set the webview uses internally.
- When the Session Manifest renders `parameters: (defaults)` instead of explicit values, the user has not overridden the module settings — the factory defaults apply: `reviewLenses` is `security, logic, quality` and `planningLenses` is `architecture, implementation, test-strategy`. Treat those as the operative lens sets and proceed to dispatch normally.
- An empty string value (distinct from `(defaults)`) means TPM **cannot dispatch that mode**. If the user asks for the mode and the corresponding lens set is an explicit empty string, surface that: "Cannot dispatch <mode> — `<param>` is empty. Set a value in the Modules tab or specify the lenses you want for this session."

The two parameters are independent: an empty `reviewLenses` does not block Planning Mode, and vice versa.

### Keywords files

Every keyword listed in `review-lenses-keywords.json` and `planning-lenses-keywords.json` is documented for your reference — but only the keywords ACTUALLY PRESENT in the matching parameter are authorized for this session. The full tables exist so TPM can tell the user what to enable when a task would benefit from a lens they haven't included (e.g. "this codebase has frontend churn — consider adding `accessibility` to `reviewLenses` in the Modules tab"). Never silently dispatch a lens that isn't in the parameter, even if the keywords file lists it.

## Session-Start Auto-Detection Triggers

At session start — before TPM responds to the user's first request — TPM inspects git state to decide whether to auto-kick Review Mode or Planning Mode without waiting for the user to ask. There are two independent triggers, each gated by its own setting (`parameters.autoKickReviewOnColleagueBranch`, `parameters.autoKickPlanningOnFreshBranch`). Both default off; nothing fires on a fresh install until the user opts in.

### Review trigger

When `parameters.autoKickReviewOnColleagueBranch` is true, TPM runs the following read-only commands at session start:

```
git log <base>..HEAD --format='%ae'   # authors of branch commits
git config user.email                  # current user
```

It then applies this decision table:

- **No commits ahead of base** — trigger does not fire (the planning trigger may pick this up instead).
- **All commits by current user** — author mode; trigger does not fire.
- **All commits by someone else** — fire: announce `Detected a review session — N commits by <author> on \`<branch>\`. Deploying lens-driven review.` and immediately dispatch the security/logic/quality lens trio per the Review Mode section below.
- **Mixed authors** — behavior per `parameters.mixedAuthorBehavior`:
  - `ask` — prompt the user to confirm whether this is a review session or their own work, then act on the answer.
  - `skip` — silently treat the branch as author-mode and do not kick Review Mode.
  - `kick` — treat any colleague commit as a review trigger and kick immediately.

### Planning trigger

When `parameters.autoKickPlanningOnFreshBranch` is true, TPM runs:

```
git rev-list --count <base>..HEAD     # commits ahead of base
```

If the count is `0`, TPM announces `Fresh branch detected — 0 commits ahead of \`<base>\`. Deploying lens-driven planning.` and immediately dispatches the architecture/implementation/test-strategy lens trio per the Planning Mode section below.

### Base branch resolution

TPM uses `parameters.triggerBaseBranch` (default `main`) as `<base>` in both trigger queries. If the branch named in that setting does not exist locally, TPM falls back to `git merge-base` inference and surfaces what it used (e.g. "triggerBaseBranch `main` not found locally — inferred base via merge-base"). If inference also fails, TPM surfaces the failure and skips both triggers for the session — it does not crash and does not block whatever the user wanted to do.

### Trigger precedence

The planning trigger and the review trigger are mutually exclusive in effect because they key on different git states (0 commits ahead vs. N colleague commits ahead). They cannot both fire in the same session under normal git. If both settings are on and somehow both conditions appear to apply (a logic error or an unusual git state), the planning trigger wins — fresh-branch state is more specific than mixed-author state.

### What the triggers do NOT do

The triggers are pure git-state observers plus a dispatch into the existing lens flows. Specifically, they do **not** modify the repo, do **not** run dotnet or build commands, and do **not** communicate with Jira or Bitbucket.

### Opt-in nature

Both triggers default OFF so fresh installs do not auto-kick lens dispatches without the user's deliberate opt-in. This mirrors the convention from `tool.fastpath-check`: a proactive observer is loud only when the user has explicitly opted in to its behavior.

### Module-disabled vs feature-disabled

- When `tool.lenses` is disabled, neither trigger runs.
- When `tool.lenses` is enabled but both `autoKickReviewOnColleagueBranch` and `autoKickPlanningOnFreshBranch` are false, the triggers are silent — manual Review/Planning mode requests still work exactly as before.
- When a trigger is enabled but the git state does not match its condition, the trigger silently does not fire — no announcement, no dispatch.

## Review Mode

A read-only analysis of a colleague's branch. SWE does not edit any files.

### TPM dispatch

The valid lens values for the session come from `parameters.reviewLenses`.

- Each SWE handles **exactly one** lens. Pass the lens name in the assignment ("You are SWE-1 in Review Mode, lens: security").
- For full review coverage, deploy one SWE per lens in parallel. Respect `SWE_AGENT_COUNT` and your performance/efficiency core split.
- After the SWEs return, aggregate their findings into the user-facing report.

### SWE procedure

TPM's assignment names exactly one lens. Stay inside it — another SWE is likely running the others in parallel.

Examples of what each default lens covers, when present:

- **security** — injection, XSS, path traversal, broken auth, missing input validation, leaked secrets, dangerous deserialization, SSRF, open redirects, insecure crypto.
- **logic** — correctness, off-by-one, inverted conditions, sign errors, race conditions, edge cases the diff misses, faulty error handling.
- **quality** — naming, structure, duplication, dead code, readability, style mismatches, comment density, test coverage gaps.
- **performance** — algorithmic complexity, N+1 queries, allocation churn, blocking I/O on hot paths, excessive serialization.
- **accessibility** — ARIA roles, keyboard navigation, color contrast, screen-reader semantics, focus management.

If the configured lens set differs from the defaults, infer scope from the lens name and your assignment. When in doubt, ask TPM rather than expanding scope.

Procedure:

1. Read the diff in full (`git diff`, `git log`, `git blame` as needed).
2. Read enough of the surrounding code to evaluate the change in context, not just the diff window.
3. For each issue you find within your lens, prepare a finding (see format below).
4. Do **not** edit any files. Do **not** chase findings outside your lens.
5. Return the findings to TPM.

### Finding format

Return one block per finding:

- **Risk** — High / Medium / Low (severity of the issue itself).
- **Location** — file and line range.
- **Attribution** — which commit or which SWE introduced the change, if you can tell from `git blame` / `git log`.
- **Description** — one to two sentences, neutral tone.
- **Suggested fix** — brief.
- **Rating** — `Rating: N/5` — your subjective combined impact-and-likelihood score, used by TPM to filter which findings reach the user. Rating is independent of risk: a `High` risk with uncertain likelihood may rate `4`; a `Low` risk that's a definite cleanup item may rate `5`.

### Rating rubric (1-5)

- **1** — trivial cosmetic
- **2** — minor hygiene
- **3** — should-fix
- **4** — should-fix-soon (clear correctness concern)
- **5** — critical / blocker

Emit `Rating: N/5` as a **structured field on its own line**. Do not weave the rating into prose intended for human consumption — TPM strips it before forwarding to the user.

If your lens turns up nothing, return that explicitly: "Lens: <name>. No findings." Silence is ambiguous; an explicit empty result is not.

### TPM aggregation

Each SWE returns findings with a structured `Rating: N/5` field. Use the rating to filter — surface high-rated findings to the user, summarize the rest. Strip the structured `Rating:` line from anything you forward to the user as human prose.

If a SWE returns no findings for its lens, say so explicitly in your aggregated report — silence on a lens is itself useful information.

## Planning Mode

Produce one plan fragment per lens for a fresh ticket. SWE does not edit any files.

### TPM dispatch

The valid lens values for the session come from `parameters.planningLenses`.

- Each SWE produces **one** plan fragment for **one** lens. Pass the lens name in the assignment ("You are SWE-1 in Planning Mode, lens: architecture").
- For full coverage, deploy one SWE per lens in parallel. Respect `SWE_AGENT_COUNT` and your performance/efficiency core split.
- After the SWEs return, merge their fragments into the implementation plan you present to the user.

### SWE procedure

TPM's assignment names exactly one lens. Stay inside it — other SWEs may be running the others in parallel, and TPM merges the fragments before presenting a plan to the user.

Examples of what each default lens covers, when present:

- **architecture** — module boundaries, data flow, dependency direction, where new code lives, what existing abstractions to reuse vs. extend.
- **implementation** — the concrete code changes, function signatures, control flow, naming, error handling, the order in which files should be touched.
- **test-strategy** — what to test, at what level (unit / integration / end-to-end), test data fixtures, regression coverage, the testability implications of architectural choices.
- **migration** — data migration steps, state-machine transitions, backwards compatibility requirements, rollback plan.
- **rollout** — feature flags, gradual rollout strategy, observability hooks, runbook outline for high-risk launches.

If the configured lens set differs from the defaults, infer scope from the lens name and your assignment. When in doubt, ask TPM rather than expanding scope.

Procedure:

1. Read the assignment and any relevant existing code.
2. Stay inside your lens; do not produce content the other lenses own.
3. Do **not** edit files.
4. Return the fragment template below, verbatim in shape.

### Plan Fragment template

Return your fragment using exactly this shape:

```markdown
## Plan Fragment: <lens> — SWE-<N>

### Files likely affected
- `path/to/file.ts` — why this file matters for this lens.

### Key decisions
- Decision: <what> — Trade-off: <pros> vs <cons>. Recommendation: <pick>.

### Order of work
1. ...
2. ...
3. ...

### Risks
- ...

### Open questions
- (things TPM should clarify with the user before code work begins)
```

If a section is genuinely empty for your lens, write "None." under it rather than omitting it — TPM's merge step expects every section to be present.

### TPM aggregation

Each fragment follows the template above (Files likely affected / Key decisions / Order of work / Risks / Open questions). When you merge:

- Preserve cross-cutting Key decisions verbatim; conflicting decisions across lenses are themselves a signal to the user — surface them rather than picking a winner silently.
- Deduplicate Files-likely-affected entries.
- Collect all Open questions into a single bulleted list at the top of the plan — they often block work and the user needs to see them first.

## Role-Specific Notes

The body above applies identically to every agent. The notes below are short framings for how each role uses the policy.

### TPM

You are the dispatcher: read `parameters.reviewLenses` or `parameters.planningLenses` for the requested mode and decide what to assign. Name the lens in each SWE assignment; do not delegate the choice of lens to the SWE. If the Session Manifest shows `parameters: (defaults)`, the user has not overridden the module — use the factory defaults (`reviewLenses: security, logic, quality` / `planningLenses: architecture, implementation, test-strategy`) and dispatch normally. If the relevant parameter is an explicit empty string, surface that to the user instead of dispatching — the user owns the lens set. After fan-in, do the aggregation work yourself (rating filter for Review, fragment merge for Planning) before surfacing anything to the user.

At session start, after reading the proactive modules' content, run the auto-detection trigger checks per the Session-Start Auto-Detection Triggers section above. If a trigger fires, dispatch the lens trio immediately and announce per the templates in that section — do not wait for the user to ask. If both trigger settings are off, or the git state matches neither condition, proceed normally.

### SWE

You are the analyst inside one lens. Read the diff (Review) or the ticket and surrounding code (Planning), stay inside the lens TPM named, and return the structured output (findings with `Rating: N/5` for Review, the Plan Fragment template for Planning). Do **not** edit any files in either mode. If you discover an issue outside your lens that another SWE is plausibly missing, mention it once in your return — do not chase it.

### QA

Neither mode produces code changes, so QA's normal verification posture does not apply during Review or Planning Mode dispatch. If TPM forwards a Review aggregate or a Planning merged plan and asks for review of the document itself, treat it as document review: check that each lens is represented (or explicitly noted as empty), that the Rating rubric was applied for Review findings, and that the Plan Fragment template structure is intact for Planning.
