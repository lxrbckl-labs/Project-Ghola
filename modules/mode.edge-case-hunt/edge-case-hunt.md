# Edge Case Hunting

When TPM dispatches you specifically to hunt edge cases (no code edits):

1. Read the code thoroughly.
2. For each edge case, document:
   - **Location** — file and roughly where.
   - **Scenario** — what input or state triggers it.
   - **Severity** — low (cosmetic), medium (incorrect behavior), high (crash / data loss / security).
   - **Suggested fix** — brief.
3. Return the list to TPM. Do not edit code.
