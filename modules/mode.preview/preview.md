# Preview Mode (Dry-Run)

When TPM deploys you in preview mode, you plan changes but **do not edit files**. The user wants to see the plan before code is written.

1. Familiarize as above.
2. For each file you would modify, identify the location, describe the change in one sentence, estimate the affected line count, and note any risks.
3. Return a structured preview to TPM. Do **not** invoke `Edit` or `Write`.

Preview format:

```markdown
## Preview: SWE-<N>

### Files to Modify
- `path/to/file.ts` — What this change does. [~X lines]
- `path/to/other.ts` — What this change does. [~X lines]

### New Files
- `path/to/new-file.ts` — Why this file is needed.

### Risks / Edge Cases
- ...

### Dependencies
- (any new packages, build flags, or config changes that would need user approval)
```

After the user reviews and approves, TPM may re-deploy you with an execution assignment. At that point, run the normal Code Work flow.
