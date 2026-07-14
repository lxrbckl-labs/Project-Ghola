# Regression Scan

When this module is loaded, the session has a structured regression-scan gate. The scan greps the test directories in `parameters.testRoots` for references to the classes, methods, exported functions, and public types changed during the session, then reports which tests are most likely to be affected by the work. Every agent reads this same fragment; TPM owns the scan, SWE and QA findings feed it, and role-specific framing is collected at the end.

This module is **not proactive**. It does not fire at session start. It is the middle gate in the PR-handoff sequence: `tool.pr-prep`'s pre-PR checklist first (the quality gate), regression scan second (the test-impact survey), `tool.pr-prep`'s PR description third (the artifact). Running the scan before the description means the description reflects a clean scan. It fires when the user signals PR readiness (per `parameters.autoOfferOnSignal`) or when the user explicitly asks. Treat it as a handoff gesture, not a continuous check.

## What the scan does

The scan runs in three steps, all read-only:

- **Identify the changed symbols.** TPM reads `git diff` against the working tree (and consults session memory — SWE return messages list the files changed and the one-sentence explanation per file) and extracts the names of classes, methods, exported functions, and public types that were added, renamed, or removed. Only the categories listed in `parameters.scanSignals` are extracted; categories the user has disabled are skipped at the extraction step, not just filtered out of the output.
- **Grep the test directories.** For each extracted symbol, TPM runs one targeted grep against the directories named in `parameters.testRoots`, filtered to files matching `parameters.fileExtensions`. The grep is bounded by word boundaries so substring matches do not pollute the result set.
- **Aggregate and present.** Matches are collected and rendered per `parameters.runMode` — either a single summary table (`summary`) or a per-symbol walk (`perSymbol`). Symbols below `parameters.flagThreshold` are suppressed from the visible report; symbols with zero references are surfaced separately as a potential coverage gap.

## When to run the scan

Run the scan when:

- `tool.pr-prep`'s checklist half has just completed with no `✗` flags AND both modules are enabled AND `parameters.autoOfferOnSignal` is true. In that case TPM chains directly into the offer: "Want me to run the regression scan?" Wait for the user's go-ahead; the offer is the gate.
- The user signals PR readiness ("ready for PR", "create a PR", "ship this") AND `tool.pr-prep` is NOT enabled AND `parameters.autoOfferOnSignal` is true. The scan still stands on its own as a PR-handoff gate; offer the same way.
- The user explicitly asks ("run a regression scan", "check tests for breakage", "what tests touch this work"). Run without preamble.

Do **not** run the scan:

- After every code change or every session end. The scan is specifically the PR-handoff gate, not a continuous check.
- Immediately after `tool.pr-prep`'s checklist half when it returned `✗` flags. The user should address the flags first. They can still ask explicitly if they want the scan before addressing them.
- When the module is not loaded. Without this module, TPM does not offer a structured scan — the user runs `grep` or `rg` themselves if they want to check.

## Symbol extraction patterns

TPM extracts symbols from the diff based on what is enabled in `parameters.scanSignals`. The patterns are language-aware where the diff context makes the language obvious (file extension, project layout).

### `classes`

Identifiers introduced or renamed after a `class`, `interface`, `struct`, or `type` keyword in the diff. Language cues:

- TypeScript / JavaScript: `class Foo`, `interface Foo`.
- Python: `class Foo:`.
- C#: `class Foo`, `record Foo`, `struct Foo`.
- Go: `type Foo struct`, `type Foo interface`.
- Rust: `struct Foo`, `enum Foo`, `trait Foo`.
- Java: `class Foo`, `interface Foo`, `record Foo`.

### `methods`

Identifiers introduced or renamed inside a class body. Cues include `def`, `function`, `public`, `private`, `protected`, `static`, `async`, and access-modifier-leading patterns. Common method names (`get`, `set`, `init`, `toString`, `hashCode`, `equals`) tend to produce noisy matches — extract them but lower-rank them in the output so the user is not overwhelmed by incidental hits.

### `exported-functions`

Top-level identifiers exported via `export function`, `export const`, `module.exports`, `pub fn`, `func` (Go), or equivalent. Skip identifiers that are clearly private (leading underscore, `private` keyword, no `export`).

### `public-types`

Exported `interface`, `type`, `enum`, `union`, and `struct` declarations. Same export-visibility rule as functions.

If extraction yields zero symbols, report that and stop — do not run greps with an empty target set.

## Grep approach

The grep mechanics are simple but specific:

- Prefer `rg` (ripgrep) when available — it is faster than `grep -rn` and respects `.gitignore`, which keeps generated test fixtures out of the result. Fall back to `grep -rn` when `rg` is not on the path. The agent runs the grep via the Bash tool; this module contributes only the markdown, not scan code.
- Scope every grep to the directories matching `parameters.testRoots` AND files with extensions matching `parameters.fileExtensions`. Walking the whole repo is wasted work and produces noise from production code.
- Bound every pattern with word boundaries (`\bFooClass\b`) so `FooClass` does not match `FooClassBuilder` or `MyFooClass`. Word boundaries matter more on short or generic identifiers (`Foo`, `User`, `Item`) than on long unique ones.
- Run one grep per symbol, batched at the presentation step. Do NOT combine symbols into a single `(Foo|Bar|Baz)` alternation regex — the output needs to be keyed by symbol for either `runMode`, and a combined regex loses that.

## Findings format

Use exactly the structure for the configured `parameters.runMode`. Do not invent new shapes mid-run.

### `summary` mode (default)

```
Regression Scan Results

Found N tests referencing symbols changed this session:

| Symbol               | Test file                          | Line |
|---------------------|-----------------------------------|------|
| FooClass            | tests/foo.test.ts                 | 12   |
| FooClass            | tests/integration/foo-flow.test.ts | 45   |
| barMethod           | tests/foo.test.ts                 | 88   |
| bazFunction         | tests/utils.test.ts               | 7    |

Recommended: re-run tests/foo.test.ts and tests/utils.test.ts before PR.
```

The recommendation line lists the distinct test files (deduplicated) sorted by reference count, descending. It is a recommendation, not an instruction — the user runs the tests themselves.

### `perSymbol` mode

```
Regression Scan — Per-Symbol Walk

FooClass (modified in src/foo.ts)
  - tests/foo.test.ts:12
  - tests/integration/foo-flow.test.ts:45

barMethod (modified in src/foo.ts)
  - tests/foo.test.ts:88

bazFunction (added in src/utils.ts)
  - tests/utils.test.ts:7
```

Each symbol gets its own block in the order symbols were extracted. The parenthetical indicates the source file the symbol came from and whether it was added, modified, renamed, or removed — useful when investigating one suspected breakage in depth.

### Threshold and zero-reference handling (both modes)

- Symbols with a reference count below `parameters.flagThreshold` are omitted from the visible table or walk. Surface them in a one-line footer: "3 additional symbols had references below the flag threshold."
- Symbols with **zero** references are listed separately at the bottom under "Symbols with no test coverage detected: `<list>`". This surfaces potential testing gaps without claiming they are regressions — there is a difference between "no test references this symbol" and "this symbol is broken".

## What the scan does NOT do

These boundaries are deliberate. Do not extend them silently.

- The scan does NOT run the tests. It reports references; the user runs the tests.
- The scan does NOT modify any file. The entire operation is read-only — `git diff`, `git status`, `rg` / `grep -rn`.
- The scan does NOT enforce a "must add tests" policy. It surfaces information; the user judges what to do with it.
- The scan does NOT search production code for references to modified symbols. That is a different concern (impact analysis) and out of scope for v1. If the user asks for that, surface that it is a separate task.

## Module-disabled vs feature-disabled

These are distinct states and must produce distinct behavior:

- **Module disabled** (no `tool.regression-scan` in the Session Manifest): TPM does NOT offer or run the regression scan. The user runs `grep` or `rg` themselves if they want to check tests. Do not pretend the scan exists.
- **Module enabled, `parameters.autoOfferOnSignal` off**: the scan exists but TPM does not auto-offer on PR signals or after the checklist completes. The scan runs only when the user explicitly asks.
- **Module enabled, every category in `parameters.scanSignals` disabled** (empty or unrecognized values only): when the user invokes the scan, respond: "no symbol categories enabled — regression scan has nothing to look for. Enable some in the Modules tab." Do not silently pass an empty scan.
- **Module enabled, no directories match `parameters.testRoots`**: respond: "no test directories found matching the configured Test Roots. Update the setting in the Modules tab or accept that this project has no tests to scan." Do not fall back to scanning the whole repo.

Do not merge these cases.

## Sibling-module interaction

This module composes cleanly with `tool.pr-prep`, whose two halves are the rest of the PR-handoff sequence.

### `tool.pr-prep`'s checklist half

When both modules are enabled and the checklist half completes with no `✗` flags, TPM chains into the regression-scan offer per `parameters.autoOfferOnSignal`. When the checklist half surfaced `✗` flags, TPM does NOT auto-offer the scan — the user should address the flags first. The user can still ask explicitly ("run the scan anyway") and TPM runs it, noting once: "The checklist still has open flags — confirm you want the scan results before addressing them?"

### `tool.pr-prep`'s description half

The ideal sequence is checklist → scan → description, because the scan can surface tests that need updating, which the description should mention. When `tool.pr-prep` and the regression scan are enabled and configured to auto-offer, TPM chains them in that order. If the scan flags a test the user needs to update, the description draft should reflect that ("…and updates `tests/foo.test.ts` to cover the new null check"). The user always has the final say on the description; the scan output is one more input, not a directive.

### SWE return messages

The symbols list comes from SWE return data (files changed plus one-sentence explanations) merged with `git diff`. SWEs do not need to enumerate class or method names explicitly — TPM extracts them from the diff. SWEs DO need to call out renames specifically: when a symbol is renamed, TPM must scan tests for BOTH the old and the new name (the blast radius of a rename), and the diff alone makes the old name harder to find. A SWE one-liner like "renamed `OldFooClass` to `FooClass` in `src/foo.ts`" is gold.

## Role-Specific Notes

The body above applies identically to every agent. The notes below are short framings for how each role contributes.

### TPM

You own the scan. You build the symbol list from SWE returns plus `git diff`. You run the greps via the Bash tool. You present findings per `parameters.runMode`. You do NOT instruct SWE or QA to run greps on your behalf — the regression scan is a TPM-level synthesis, and dispatching SWE to do what TPM should do itself wastes a round-trip. You apply `parameters.flagThreshold` before presenting, and you surface zero-reference symbols as a coverage observation, not a regression. You never run the tests themselves; the scan reports references and recommends which tests to re-run.

### SWE

Your standard return is the primary input. Be specific about which symbols you added, renamed, or removed — vague returns ("refactored some classes") produce vague scan target sets. If you renamed a symbol, call out BOTH the old and new name in the return so TPM can scan tests for the old name too (renames are the case where the diff is least helpful, because the deletion of the old name and the addition of the new name look like two unrelated changes). If you deleted a symbol, say so explicitly — deleted symbols that still have test references are the highest-value signal the scan produces. Do not run the scan yourself; just feed TPM the information.

### QA

Your verdict often references specific test files you read during review. If you noticed a test that was not running but should have been (a `.skip`, a missing import, an orphaned file), surface it in the verdict. TPM can incorporate that into the regression-scan output as an annotation ("QA flagged `tests/legacy.test.ts` as orphaned — confirm it is still relevant before relying on the scan result for that area"). Do not run the scan yourself — it is a TPM-level synthesis that runs after QA's verdict, not during review.
