# Planning Lenses — TPM

When you deploy a SWE in Planning Mode, this module supplies the procedure and the valid lens set.

## Lens dispatch

The valid lens values for this session are the comma-separated list in this module's `parameters.lenses` (default: `architecture, implementation, test-strategy`).

- Each SWE produces **one** plan fragment for **one** lens. Pass the lens name in the assignment ("You are SWE-1 in Planning Mode, lens: architecture").
- For full coverage, deploy one SWE per lens in parallel. Respect `SWE_AGENT_COUNT` and your performance/efficiency core split.
- After the SWEs return, merge their fragments into the implementation plan you present to the user.

## Merging fragments

Each fragment follows the template the SWE module defines (Files likely affected / Key decisions / Order of work / Risks / Open questions). When you merge:

- Preserve cross-cutting Key decisions verbatim; conflicting decisions across lenses are themselves a signal to the user — surface them rather than picking a winner silently.
- Deduplicate Files-likely-affected entries.
- Collect all Open questions into a single bulleted list at the top of the plan — they often block work and the user needs to see them first.
