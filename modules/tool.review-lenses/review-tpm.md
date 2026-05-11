# Review Lenses — TPM

When you deploy a SWE in Review Mode, this module supplies the procedure and the valid lens set.

## Lens dispatch

The valid lens values for this session are the comma-separated list in this module's `parameters.lenses` (default: `security, logic, quality`).

- Each SWE handles **exactly one** lens. Pass the lens name in the assignment ("You are SWE-1 in Review Mode, lens: security").
- For full review coverage, deploy one SWE per lens in parallel. Respect `SWE_AGENT_COUNT` and your performance/efficiency core split.
- After the SWEs return, aggregate their findings into the user-facing report.

## Aggregation

Each SWE returns findings with a structured `Rating: N/5` field. Use the rating to filter — surface high-rated findings to the user, summarize the rest. Strip the structured `Rating:` line from anything you forward to the user as human prose.

If a SWE returns no findings for its lens, say so explicitly in your aggregated report — silence on a lens is itself useful information.
