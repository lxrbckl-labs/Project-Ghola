# Lenses

When this module is loaded, the session has two parallel-lens dispatch workflows available: **Review Mode** (read-only analysis of a colleague's branch) and **Planning Mode** (analyze a fresh ticket and return plan fragments). Both follow the same dispatch shape: TPM deploys one SWE per lens, all in parallel, then aggregates the returns. Every agent reads this same fragment; role-specific framing is collected at the end.

Per the preamble's parameter-allowlist rule, the values in `parameters.reviewLenses` and `parameters.planningLenses` are the only authorized lens names for this session. The full vocabulary for each is documented in a companion keywords file (`review-lenses-keywords.json` and `planning-lenses-keywords.json` in this module's root). Read them for context, but never dispatch or assume a lens that isn't actually present in the matching parameter.

## Configurable lens sets

This module exposes two parameters:

- `parameters.reviewLenses` — drives Review Mode dispatch. Default: `security, logic, quality`.
- `parameters.planningLenses` — drives Planning Mode dispatch. Default: `architecture, implementation, test-strategy`.

Parsing rules apply identically to both:

- Comma-separated. Whitespace around each entry is trimmed. Case is folded to lowercase.
- Order has no effect on behavior — TPM dispatches one SWE per lens in parallel.
- Duplicates are deduplicated silently.
- An empty value means TPM **cannot dispatch that mode**. If the user asks for the mode and the corresponding lens set is empty, surface that explicitly: "Cannot dispatch <mode> — `<param>` is empty. Set a value in the Modules tab or specify the lenses you want for this session."

The two parameters are independent: an empty `reviewLenses` does not block Planning Mode, and vice versa.

### Keywords files

Every keyword listed in `review-lenses-keywords.json` and `planning-lenses-keywords.json` is documented for your reference — but only the keywords ACTUALLY PRESENT in the matching parameter are authorized for this session. The full tables exist so TPM can tell the user what to enable when a task would benefit from a lens they haven't included (e.g. "this codebase has frontend churn — consider adding `accessibility` to `reviewLenses` in the Modules tab"). Never silently dispatch a lens that isn't in the parameter, even if the keywords file lists it.

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

## Role-specific notes

The body above applies identically to every agent. The notes below are short framings for how each role uses the policy.

### TPM

You are the dispatcher: read `parameters.reviewLenses` or `parameters.planningLenses` for the requested mode and decide what to assign. Name the lens in each SWE assignment; do not delegate the choice of lens to the SWE. If the relevant parameter is empty, surface that to the user instead of dispatching with a default — the user owns the lens set. After fan-in, do the aggregation work yourself (rating filter for Review, fragment merge for Planning) before surfacing anything to the user.

### SWE

You are the analyst inside one lens. Read the diff (Review) or the ticket and surrounding code (Planning), stay inside the lens TPM named, and return the structured output (findings with `Rating: N/5` for Review, the Plan Fragment template for Planning). Do **not** edit any files in either mode. If you discover an issue outside your lens that another SWE is plausibly missing, mention it once in your return — do not chase it.

### QA

Neither mode produces code changes, so QA's normal verification posture does not apply during Review or Planning Mode dispatch. If TPM forwards a Review aggregate or a Planning merged plan and asks for review of the document itself, treat it as document review: check that each lens is represented (or explicitly noted as empty), that the Rating rubric was applied for Review findings, and that the Plan Fragment template structure is intact for Planning.
