# Subagent Coordination

When this module is loaded, TPM has a single project-wide convention for dispatching multiple SWEs in parallel without file collisions. The pattern was previously inlined in TPM's core behavior — this module promotes the convention to a configurable policy so the ownership-declaration requirement, coordination style, lens auto-merge threshold, and collision-reporting posture can be tuned per project. Only TPM reads this fragment; SWE and QA inherit the discipline indirectly through TPM's assignments.

This module is **not proactive**. It does not fire at session start. The policy applies on-demand, exactly when TPM is about to dispatch parallel SWEs. Without a parallel-dispatch in flight, this module sits quietly.

## The core rules

When dispatching multiple SWEs in parallel, TPM follows these rules:

- Every assignment in a parallel dispatch carries an explicit file-ownership statement per `parameters.requireFileOwnership`.
- File ownership is disjoint per `parameters.allowSharedFileWrites` (default: disjoint).
- Work splits follow `parameters.coordinationStyle` (default: split-by-file).
- Lens-driven workflows (Review Mode, Planning Mode via `tool.lenses`) auto-merge their lens count when concurrent-core capacity is short, per `parameters.lensAutoMergeBelowCores`.
- File collisions observed during dispatch are surfaced per `parameters.reportCollisions`.

The rules apply per-dispatch, not per-session — a serial follow-up dispatch starts fresh, with its own ownership declaration.

## File-ownership statement format

When `parameters.requireFileOwnership` is on, every SWE assignment in a parallel dispatch includes one of these statements. The statement names each subagent, the path or scope they own, and asserts disjointness:

- "SWE-1 owns `src/auth/`. SWE-2 owns `src/api/`. SWE-3 owns `src/db/`. Disjoint."
- "SWE-1 owns the `manifest.json` edits. SWE-2 owns the content `.md` edits. SWE-3 owns the `schema.json` mirror. Disjoint."
- "SWE-1 owns ALL files in the work repo. SWE-2 and SWE-3 are on standby." (the degenerate one-worker case is still a valid ownership statement)

The statement is part of the assignment text the SWE receives — not metadata, not a separate channel. Each SWE sees the full ownership statement so they know what their peers are touching and can refuse to stray.

## Coordination styles

Per `parameters.coordinationStyle`, TPM splits work across parallel SWEs using one of three patterns:

### `split-by-file` (default)

Each SWE owns a set of FILES — distinct files, or distinct directories whose contents do not overlap. This is the cleanest collision profile because the unit of ownership matches the unit of write. Recommended for any task where the file boundaries are stable and known up front.

### `split-by-module`

Each SWE owns a MODULE FOLDER (e.g. `modules/<X>/`). Good for module-shaped work where each module has its own manifest plus content pair and the SWEs are building or editing modules in parallel. The split is effectively still per-file because each module folder is self-contained, but the framing is module-centric and the assignment names the module rather than enumerating files.

### `split-by-feature`

Each SWE owns a FEATURE thread — works when features map cleanly to file boundaries. Riskier than `split-by-file` because file boundaries are not always feature boundaries: two features may legitimately touch the same shared helper. Use only when the feature-to-file mapping has been audited.

The choice between the three is TPM's call based on the shape of the task. The default `split-by-file` is the safest and is the right answer when in doubt.

## Lens auto-merge

Per `parameters.lensAutoMergeBelowCores`, TPM auto-merges lens count when concurrent-core capacity is short:

- The canonical lens trios from `tool.lenses` (security / logic / quality for Review Mode, architecture / implementation / test-strategy for Planning Mode) want 3 concurrent SWEs.
- If concurrent-core capacity is below `parameters.lensAutoMergeBelowCores`, TPM merges lens content into fewer SWEs — for example, merging security + logic into a single SWE running both lenses if only 2 cores are available.
- The setting value is the threshold: when available cores are LESS THAN the threshold, merge. Default 3 means: if fewer than 3 cores are available, merge lenses down to fit.
- Lens-merging mechanics (which lenses combine well, what the merged-lens prompt looks like) are documented in `tool.lenses`' own content; this setting controls only WHEN the merging behavior is activated.

Merging is preferable to refusing the workflow — a 2-SWE Review with merged lenses is still more rigorous than a single-SWE Review, and the user can disable auto-merge by raising the threshold above the actual core count if they want strict 1-lens-per-SWE.

## Collision handling

Per `parameters.reportCollisions`, TPM responds to observed file collisions in one of two ways:

- **On** (default): TPM reports any observed collision in its return. Format: "Collision detected: SWE-1 and SWE-2 both wrote `src/foo.ts`. Last-write wins; user review recommended." The user sees the collision and can re-run the affected SWE or merge by hand.
- **Off**: collisions are silent. Latter write wins, no surface. Appropriate only in fully-controlled scripted workflows where the user has accepted the trade-off.

On is the safer default; off is for the narrow case where the user has prior knowledge that any apparent collision is benign.

## What this module does NOT do

- Does NOT prevent collisions at the OS level — this module relies on TPM's declarative ownership statements and per-SWE compliance. There is no filesystem lock, no transactional commit, no rollback.
- Does NOT auto-merge SWE output diffs. If two SWEs write the same file and `parameters.allowSharedFileWrites` is on, the latter write wins; TPM does not attempt a textual merge.
- Does NOT track SWE history or token cost. Concurrent-core capacity is the only resource the policy reasons about, and that comes from the user's hardware (performance + efficiency cores), not from any tracking this module performs.

These omissions are deliberate. The module is a coordination convention, not an execution engine.

## Module-disabled vs feature-disabled

These are distinct states and must produce distinct behavior:

- **Module disabled** (no `tool.subagent-coordination` in the Session Manifest): TPM dispatches without explicit ownership declarations. Risks file collisions but matches "minimal-ceremony" workflows where the user trusts TPM to keep parallel SWEs apart without paperwork.
- **Module enabled, `parameters.requireFileOwnership` off**: same as disabled for the ownership-declaration concern — TPM may dispatch in parallel without naming who owns what. The other settings (`allowSharedFileWrites`, `coordinationStyle`, `lensAutoMergeBelowCores`, `reportCollisions`) still apply.
- **Module enabled, `parameters.allowSharedFileWrites` on**: explicit opt-in to multi-SWE file editing. Ownership statements may name the same file under multiple SWEs; the latter-write-wins resolution still applies and `reportCollisions` still surfaces the overlap if on.

Do not merge these cases.

## Relationship to existing module sections

TPM's core behavior previously inlined the parallel-dispatch coordination patterns — the file-ownership-statement format, the disjoint-by-default rule, the lens auto-merge below available cores. With this module loaded:

- The TPM core's inline rules become AUTHORITATIVE-RECEIVER for the policy this module defines — they cite this module rather than restating the rule. TPM uses this module's exact settings (`parameters.requireFileOwnership`, `parameters.allowSharedFileWrites`, `parameters.coordinationStyle`, `parameters.lensAutoMergeBelowCores`, `parameters.reportCollisions`) in preference to anything the core says inline.
- When this module is DISABLED, the core's inline rules act as the fallback — they restate the coordination patterns independently so the discipline is not lost when this module is missing.
- When this module is ENABLED, the core's inline rules defer to this module's exact settings.

This module does NOT modify the TPM core; the deference is by convention. TPM checks for this module's presence in the Session Manifest and uses its policy in preference to the inlined fallbacks. Future cleanup work may prune the inline rules once this module is the established norm, but that is a separate concern — the inline rules stay in place as the safety net until then.

## Role-Specific Notes

This module's content fragment targets TPM only. The notes below frame how each role intersects with the policy in practice.

### TPM

You are the policy-bearer. Before every parallel dispatch:

1. Declare ownership per `parameters.requireFileOwnership` — every SWE assignment carries an explicit ownership statement naming each subagent's scope and asserting disjointness (unless `parameters.allowSharedFileWrites` is on).
2. Split per `parameters.coordinationStyle` — `split-by-file` by default, `split-by-module` for module-shaped work, `split-by-feature` only when the feature-to-file mapping has been audited.
3. Merge lenses per `parameters.lensAutoMergeBelowCores` — if a lens-driven workflow would need more concurrent SWEs than the threshold allows, merge lens content into fewer SWEs rather than refusing the workflow.
4. Surface collisions per `parameters.reportCollisions` — if you observe two SWEs writing the same file, name the file, name the SWEs, and recommend user review (unless `reportCollisions` is off).

When `parameters.requireFileOwnership` is off, surface that to the user once when the first parallel dispatch runs ("File-ownership declarations are off — parallel SWEs will be dispatched without explicit scope. Modules tab to re-enable.") so the posture is visible.

### SWE

Your job is to stay in your owned scope. The ownership statement in the assignment is binding: if TPM says "SWE-1 owns `src/foo/`", do not touch `src/bar/` even if you find a related issue there. Report cross-scope findings to TPM rather than acting on them — silent compliance with an unowned touch defeats the discipline and risks colliding with a peer SWE working `src/bar/` in parallel. The ownership statement is the contract; respecting it is your responsibility.

### QA

You are not involved in dispatch coordination, but during review you may notice that a SWE strayed out of declared ownership — for example, the SWE's diff touches files outside the scope named in their assignment. Flag this in the verdict as a discipline finding regardless of how clean the change itself was. The ownership rule exists precisely to catch that pattern, and a clean code change does not redeem a violated coordination boundary.
