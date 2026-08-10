# Parallel Verification

When this module is loaded, TPM may split an oversized verification pass across several verifiers running in parallel instead of handing the whole plate to one agent. Every agent reads this same fragment; role-specific framing is collected at the end.

This module is **not proactive**. It does not fire at session start. It applies on-demand, at the exact moment TPM is about to dispatch verification. With no verification pass in flight, this module sits quietly.

**Only TPM fans out.** Nothing in this module lets a subagent recruit help. `swe.md`'s "Hard Rules" (rule 8) and `qa.md`'s "Hard Rules" (rule 7) both forbid a subagent from using the Agent tool, and this module never relaxes them — per the preamble's cumulative-hard-rules rule it could not if it wanted to. A verifier that feels under-resourced finishes what it can, names the gap, and returns.

## Purpose, and the honest cost statement

**Fan-out trades tokens for wall-clock. It is never cheaper in total tokens.** A single verifier costs roughly `fixed-orientation-tax + sum-of-work`. A split costs `N × fixed-orientation-tax + sum-of-work + fan-in`. Every verifier re-pays the tax of orienting itself in the repo, re-reading shared context, and writing its own report; the actual checking work does not shrink, it only gets redistributed. The split is strictly more expensive and the operator gets the result sooner.

Say this plainly to the operator when they tune the settings, because an operator who believes this saves money will set `parameters.splitThreshold` far too low and get the worst of both: the multiplied fixed tax on a change small enough that one agent would have been done already. **Latency is the product. Spend is the price.**

## When TPM splits

TPM evaluates the split decision at the moment it is about to dispatch verification — not earlier, because the change set is not final until the SWEs have returned.

**Measure the change with ONE read-only git call**, combining:

```
git diff --name-only        # tracked, modified
git diff --shortstat        # changed-line volume
git status --porcelain      # REQUIRED - untracked and staged paths
```

`git status --porcelain` is not optional. `git diff --name-only` misses untracked new files, which is exactly what a new-module or new-directory change wave produces — the largest, most split-worthy waves are the ones a `--name-only`-only measurement reports as empty. All three reads are `r`-category and covered by `tool.git`'s factory allowlist.

### Triggers — split when ANY fires

- Changed files **>= `parameters.splitThreshold`**.
- **>= 400 changed lines** (insertions + deletions, from `--shortstat`).
- **>= 2 distinct change kinds** among {source, prose/`.md`, config/manifest/schema, scripts, tests}.
- **>= 3 independent SWE reports** to verify.
- **The operator asks.** An explicit request is a trigger on its own and needs no size justification.
- **A stakes surface is involved** — per `tpm.md`'s "Calibrate Brief Depth To Stakes", anything that can lose data or corrupt an operator-owned file, any security or guardrail surface — **AND** a size trigger fires at **half** its threshold.

### The floor — a single verifier is correct

Do **not** split when ALL of these hold:

- <= 4 changed files, **and**
- < 150 changed lines, **and**
- exactly one change kind, **and**
- <= 2 SWE reports.

**Why the floor exists:** every verifier re-pays the fixed orientation tax — read the assignment, run its own `git diff`, read surrounding code for context per `qa.md` step 3, compose a report. Below the floor that tax dominates the actual checking work, so `N × tax` is most of the bill and the split is pure overhead with no meaningful latency win: one agent would have finished before the fan-in even assembled.

**This section answers how WIDE a pass is, not how MANY passes there are.** If this is not the first verification round on the same work, read *Rounds — the depth axis* below **before** applying anything above: the question there is not whether to split, it is whether to run another round at all. A delta below the floor does not get a narrower split — it gets no dispatch.

### THE ANTI-TRIGGER — coupling beats count

**Never split a set of mutually coupled files, regardless of count or of which trigger fired.** This overrides every trigger above. Coupled means: the same module, a direct call relationship, or one interface and its implementers.

**Shipping the triggers without this anti-trigger is a regression, not an incomplete feature.** The case it protects is concrete: a 3-file security fix touching source + config + test trips the change-kinds trigger (three kinds) and the half-threshold stakes trigger (security surface) — a small, high-stakes, tightly-coupled change gets fanned out. That result is strictly worse on every axis. It costs more tokens, it is slower to a decision than one agent reading three files, and **the coupling is precisely what a partition hides**: the whole defect class in a security fix lives in the relationship between the check, its configuration, and the test that claims to prove it.

When the anti-trigger fires against a trigger, the anti-trigger wins and TPM dispatches one verifier. Say so in one clause when announcing.

### What is NOT measurable from inside an agent

**An agent cannot observe its own elapsed wall-clock time or its own token spend, and it certainly cannot project what a hypothetical serial agent would have spent.** Those numbers exist only outside the agent, after the fact.

**Never write or infer a trigger that references wall-clock or token cost.** "Split if this would take more than ten minutes" and "split if this would exceed 100k tokens" are unimplementable — an agent asked to evaluate them will hallucinate a number and act on it. The file-count, line-count, kind-count and report-count proxies above exist *because* of this limit; they are deliberately crude, mechanically checkable stand-ins.

Flag this to anyone extending the module: **this is the most likely way a future implementer gets it wrong**, because the operator's own framing of the problem ("that QA run took 15 minutes and 110k tokens") is stated in exactly the units an agent cannot measure.

## The fast pre-slice — gate before you fan out

Before dispatching the expensive slices, run the cheap mechanical checks **once, centrally**: build, typecheck, and any lint or parity gate the repo declares (in this repo, `npm run build` plus whatever `tool.npm-suite`'s `allowedCommands` exposes).

- These are **whole-repo** checks. Every slice would otherwise duplicate them, `N` times, for one answer.
- They are the **fastest path to a first FAIL**. A broken build is a verdict, available in seconds, with no verifier spawned at all.
- **If the pre-slice fails, report it immediately and do NOT dispatch the fan-out.** Verifying correctness against a tree that does not compile is wasted work: the verifiers cannot trust anything they read, and the fix will change the diff they were reading. Get it green, then fan out.

The pre-slice is also the answer to time-to-first-signal, which a pure fan-out otherwise makes **worse**. A serial reviewer surfaces a defect the moment it hits one; a fan-out delays every finding until slices return, so the operator's first signal arrives later than it would have. Running the mechanical gate centrally restores an early signal that a fan-out would have deferred.

## Slice axes

`parameters.sliceAxis` selects the partition. **Never mix the two axes in one fan-out** — a mixed mandate produces overlapping ownership and two verifiers issuing contradictory findings against the same line, which is the exact failure the ownership discipline in `tpm.md`'s "File Conflict Prevention" exists to prevent.

### by-file (default)

Each verifier owns a disjoint set of changed files and runs the full checklist against every file it owns.

**Seed the partition from the SWE ownership statement TPM already wrote at dispatch time.** That partition is already guaranteed disjoint by `tpm.md`'s "File Conflict Prevention" ("parallel SWE ownership is always disjoint"), and the same section already establishes split-by-file as the cleanest collision profile. Verification therefore inherits a proven partition **for free** rather than inventing a new one and re-deriving its disjointness.

**Residual slice.** Files owned by no SWE — drive-by edits, generated files, anything that appeared in `git status --porcelain` but in nobody's assignment — go into an explicit **residual slice** with a named owner. They are never dropped, never assumed harmless, and never quietly folded into whichever slice looks closest. A file nobody was assigned is exactly the file nobody has read.

### by-check-type (narrow fallback)

Each verifier runs one class of check across the whole diff. Use it only when the file count is small but the check surface is wide.

**Guard rule, non-negotiable:** `qa.md`'s "7. Verdict Tiers" guarantees the step-4 checklist runs **in full against every changed file** no matter how brief the output. A by-file split preserves that guarantee per file automatically. A by-check-type split **silently breaks it** unless the dispatched check types, taken together, cover **all eight** dimensions of `qa.md`'s "4. Review Checklist" — correctness, edge cases, error handling, security, style, scope, side effects, test impact. If the slice count is too small to cover all eight, either merge dimensions into fewer slices so every dimension still has an owner (the same fold-down move `tool.lenses` uses under "Merging lenses when cores are short"), or fall back to `by-file`. **Dropping a dimension to fit the slot count is a silent lowering of the QA bar and is forbidden.**

## Who staffs a slice

- **QA agents first**, up to `QA_AGENT_COUNT`.
- **Then SWE overflow** in Verification Mode, when `parameters.sweVerifierOverflow` is on. Draw from the **efficiency pool first**, then performance cores. Never exceed `SWE_AGENT_COUNT`.
- **Total verifiers never exceed `parameters.maxSlices`**, including the whole-picture verifier when `parameters.wholePictureSlice` is on.
- **If fix work is queued, verification overflow YIELDS.** A SWE slot that could be closing a known defect is worth more than a second opinion on code already read. Verification never starves the critical path.
- When `parameters.sweVerifierOverflow` is off, TPM narrows the split to the QA cap or falls back to a single verifier. It does not exceed the cap and it does not silently drop slices.

**`QA_AGENT_COUNT` defaults to 1** (max 5; set at **Agents tab -> QA -> Configuration**). On a stock install the QA half of any fan-out therefore degenerates to a single QA plus SWE overflow. When TPM decides to split and finds only one QA slot, **say so once, to the operator**, in one clause — e.g. "splitting 3 ways; `QA_AGENT_COUNT=1` so 2 slices are SWE verifiers." Once per session, not per dispatch.

**This module declares no QA-count setting of its own.** That number already exists in the environment and in the Agents tab; a second source of truth for it would be a defect, not a convenience. Read the existing one.

## Verification Mode — the SWE brief

This module contributes a workflow mode exactly as `tool.lenses` contributes Review Mode and Planning Mode. **No core edit is needed:** `swe.md`'s "Session Manifest Meta-Rule" already obliges an SWE to read a module TPM names in its assignment and treat its parameters as authoritative. TPM names `tool.parallel-verification` and the mode; the SWE reads this file.

Every verification-slice brief carries **six mandatory elements**. A brief missing any of them is malformed and the verifier should ask rather than guess.

**1. The read-only mandate.** State it verbatim:

```
MODE: Verification. STRICTLY READ-ONLY. Do not invoke Edit or Write.
```

Plus: **a verifier never fixes what it finds — not a typo, not a one-character bug, not inside its own slice.**

**Justify this, do not merely assert it.** An SWE core is optimized to fix: `swe.md`'s "2. Implement" tells it to use Edit and Write and keep changes minimal, and its "4. Watch for Edge Cases" tells it that an in-scope edge case is something it fixes. A bare prohibition fights that instinct and will lose to it eventually. The real reason is structural: **`N` verifiers read one shared working tree concurrently, so any write by one verifier invalidates every peer's ground truth mid-run and changes the diff the fan-in coverage check will recompute.** A peer that read the file five seconds earlier is now reviewing text that no longer exists; the coverage invariant in the ledger section will see a path that mutated during verification and cannot tell a helpful typo fix from a corrupted run. That makes read-only a **correctness requirement of the fan-out, not etiquette** — which is the framing that will actually hold under pressure.

**2. The slice's file list, verbatim and exhaustive, plus the FULL disjointness statement.** Name every peer slice and what it owns — `tpm.md`'s "File Conflict Prevention" pattern: every worker sees the whole statement, not just its own line, so it can recognize a stray and refuse it. E.g. "Slice A owns `src/auth/`. Slice B owns `src/api/`. Slice C is whole-picture. Disjoint."

**3. The checklist by reference.** Run **`prompts/cores/qa.md` step 4's eight dimensions** against every file in the slice — correctness, edge cases, error handling, security, style, scope, side effects, test impact. Explicitly **NOT** the SWE core's lighter edge-case scan at `swe.md`'s "4. Watch for Edge Cases", which is a seven-category list aimed at code the SWE is writing, not a verification checklist. **Name the source in the brief.** Naming it is what stops an SWE substituting its own habit and returning a thinner review that reads like a complete one.

**4. The verdict vocabulary.** `PASS` / `PASS WITH NOTES` / `FAIL`, and `qa.md`'s "7. Verdict Tiers" tie-break: **torn between NOTES and FAIL means FAIL.** The slice returns exactly one verdict plus its one-sentence reason.

**5. The mandatory `### Not Checked` section** — see the ledger section below. Rendered always, including on a clean `PASS`.

**6. Its slice id, the total slice count, and the fact that a whole-picture verifier exists** (when `parameters.wholePictureSlice` is on). A verifier that can see a gap at its boundary and does not know anyone else is covering it will silently expand scope to fill it — which breaks disjointness, duplicates work, and produces the overlapping findings the fan-in has to untangle. Telling it the shape of the whole dispatch is what keeps it in its lane.

**Every slice also receives the full file list of the WHOLE change**, even though it owns only part. This is deliberate: a verifier that can see a suspected cross-boundary issue should be able to **name it as a pointer without chasing it**. The precedent is `lenses.md`'s "SWE" role note (under "Role-Specific Notes") — "mention it once in your return — do not chase it." One clause, into the return, and then back to its own files. TPM routes it; the whole-picture verifier or a tie-break slice does the chasing.

## Fan-in — TPM adjudicates, and PASS is DERIVED, never authored

**TPM is the only agent that can do fan-in.** It is the only one holding the pre-dispatch partition, so it is the only one that can check coverage against it. And a final-QA adjudicator — one agent reading everything to bless the result — would reintroduce the exact serial bottleneck the fan-out removes.

**Rules:**

- **Session verdict = the WORST slice verdict**, on the order `PASS > PASS WITH NOTES > FAIL`. One `FAIL` anywhere is a session `FAIL`. TPM **may not average** slice verdicts and **may not overrule a slice's FAIL upward**. It **may** escalate downward — a set of individually-acceptable notes that compose into a real problem is TPM's call to make stricter, never looser.
- **TPM signs the verdict and lists `slice-id -> verdict` beneath it.** The derivation is visible, so the operator can check the arithmetic.

**This is the structural answer to "splitting the work splits the accountability."** No agent can issue a session `PASS` — a slice can only report on its own files, and TPM only derives. Because the session verdict is computed rather than authored, there is no seam for accountability to fall through, and exactly one named agent (TPM) owns the derivation and signs it.

- **Conflicts.** When two slices contradict each other, TPM does **NOT** resolve it by reading the code. `tpm.md`'s "Delegate, Don't Investigate" forbids TPM investigating; that rule does not lapse because the question is small. **Dispatch ONE tie-break verifier** whose slice is the **union of the disputed files**, at the **higher of the two disputing slices' models**. Until it returns, the session verdict is **`FAIL-pending`** — never `PASS`, and never quietly held while TPM decides which slice sounded more confident.
- **A duplicate finding at the same `file:line` from two slices means the partition leaked.** TPM dedupes the finding **and** records the leak — a path reached two verifiers, so the axis was wrong for this change. Report it in one clause; it is the signal that tells the operator to adjust `parameters.sliceAxis` or that the anti-trigger should have fired.
- **The verdict line always carries the shape of the evidence.** Write `PASS (3 slices, by-file) - 2 gaps unresolved`, not `PASS`. The risk this counters is **verdict inflation**: "3/3 PASS" reads to a busy operator scanning eight sessions as a *stronger* result than one PASS from one agent that read everything, when it is in fact a weaker one — three partial reads, none of which saw the whole change. The evidence shape in the line is what stops the count from doing rhetorical work it has not earned.

## The Not-Checked ledger

This is the load-bearing part of the design. Everything above is optimization; this is what keeps a split from losing coverage.

**Every slice ends with a `### Not Checked` section** listing what it did not verify **and the reason** — the shape from `qa.md`'s "6. Report Findings", where a bare "could not verify" is insufficient because the reason is what tells TPM whether to care. **Rendered even on a clean PASS.**

**This is the ONE exception to the drop-empty-headings rule in `qa.md`'s "6. Report Findings".** State that explicitly in the brief, because otherwise the brevity rule deletes exactly the thing this design depends on: a verifier optimizing for a short report will drop the empty heading, and an absent ledger is indistinguishable from a ledger that says "nothing." On a genuinely complete slice the section reads `### Not Checked` / `- Nothing outside this slice's file list.` — one line, and the invariant survives.

**Four rules:**

**1. Coverage invariant, checked mechanically.** After fan-in, TPM re-runs `git diff --name-only` + `git status --porcelain` and asserts that **every changed path appears in exactly ONE slice's covered list**.
   - A path in **zero** slices is an **unchecked file** — a **FAIL condition, not a note**. It does not matter how small the file is or how confident TPM is that it is trivial; nobody read it.
   - A path in **two or more** slices is the partition leak from the fan-in rules above.
   - A file whose content **mutated during verification** should be impossible if the read-only mandate held. Its appearance is itself a finding: either a verifier wrote, or something outside the dispatch is touching the tree. Report it, do not absorb it.

**2. Gaps aggregate, they never dissolve.** A gap named by slice A clears **only** when another slice explicitly claims it checked that exact thing. **TPM cannot clear a gap by judgment** — not by reasoning that it is probably fine, not by noting that the file passed elsewhere, not because the report reads cleaner without it. Surviving gaps reach the operator **verbatim**, with their reasons attached, under an `Unverified` heading.

**3. Verdict downgrade on gap.** **A session cannot be `PASS` while an unresolved gap touches a changed file.** The ceiling is `PASS WITH NOTES`. This is the enforcement mechanism for rule 2: because dropping a gap now *changes the verdict*, dropping one becomes **detectable** instead of invisible. A ledger that only informed would be dropped under context pressure; a ledger that moves the verdict cannot be.

**4. This is TPM's existing rule, not a new one.** `tpm.md`'s "Brevity Is Never Omission" already forbids compressing an open or unconfirmed finding out of a report, and says explicitly that the brevity rules govern the **explanation** of a finding and never its **existence**. The merge behavior above is an application of that rule to a fan-out, not a competing rule bolted onto the Brevity Contract. If a TPM ever feels the ledger fighting the Brevity Contract, the conflict is imaginary and `tpm.md`'s "Brevity Is Never Omission" already settled it.

## Rounds — the depth axis, and how a verification pass stops

Everything above partitions **one** pass. This section governs the decision that comes after a pass returns: whether there is another one.

**Splitting addresses width. It never addresses depth.** A pass too big for one agent is a width problem and fan-out is the right instrument. A *sequence* of shrinking verification rounds — each spawning a fresh agent, each returning less than the last — is a **depth** problem, and fan-out makes it strictly worse: every round re-pays the whole fixed orientation tax of a dispatch for a shrinking amount of real checking work. **Reaching for the split when the actual failure is round count is the most expensive available mistake**, because it looks like the module being used correctly.

### The round budget

**Before dispatching round N+1, TPM states two things out loud:** (a) exactly what changed since round N, and (b) why that delta cannot be verified inside the existing floor. One clause each, in the operator-facing line. A round that cannot state (a) is re-reading work already verified; a round that cannot state (b) is a round that did not need an agent.

**If the delta is below the single-agent floor above, do not spawn a round at all.** The floor is not advice about splitting only — it is the boundary below which *dispatch itself* stops paying for itself. Splitting a one-paragraph check across agents is slower than reading the paragraph; so is spawning one agent to read it.

Below the floor there are exactly two moves, and the choice between them is not TPM's preference — it is set by what the delta requires:

- **Verify it inline** when the delta is already in TPM's context — a paragraph a subagent just returned, a line TPM itself wrote into a brief. Checking text you are already holding is not investigation.
- **Hand it to the operator as a note** when verifying it would require reading source, running a command, or gathering data. That is investigation, and `tpm.md`'s "Delegate, Don't Investigate" still binds — see *TPM does not run the census* below. "It's small" is not an exemption; small is the reason not to spawn a round, not a licence for TPM to go read the tree.

**`parameters.maxSlices` does not bound any of this.** That ceiling is hard and it already counts the whole-picture verifier inside it — but it is **per pass**. A follow-up round is a new pass and gets the ceiling again, so nothing in the slice rules prevents four rounds of three slices. The round budget in this section is the only thing that does.

### Diminishing returns is a STOP signal, not a continue signal

**When each successive round returns fewer and less severe findings, that convergence is the evidence that the work is done.** It is not evidence that one more pass will finally catch the last thing. Read in the wrong direction it becomes a ratchet: the shrinking output feels like proof the process is working, so the process runs again.

**The rule: after two consecutive rounds that produce no finding above the reporting bar, verification is complete.** Whatever is left is handed to the operator as notes, under the `Unverified` heading if it touches a changed file. It is not chased with another agent.

**Recognize the shape, not the numbers.** The observed pattern was six findings, then four, then one, then a single paragraph — four rounds, four fresh agents, minutes each. Those digits are not a threshold and must never be written as one; what makes the shape diagnostic is that *each round was smaller than the last and none of them changed the verdict*. A sequence that descends like that has already told you its answer.

### Set the reporting bar AT DISPATCH, never after

**Every verification dispatch names, in the brief, what counts as a FAIL for that pass.** For example: "Fail only for a factual error, a contradiction between documents, or a broken gate. Anything stylistic returns as a note." The bar is enforced at the verifier's end, which is where it belongs — the verifier is the agent deciding what to put in its report.

**A bar set afterwards is not a bar.** If TPM decides what counts only after seeing the findings, it is filtering by judgment on material it has already read, and every borderline item becomes arguable. That is the mechanism by which a round's output gets relitigated into another round: the finding was neither accepted nor dismissed, so it survives to be re-checked. Set it up front and the round returns a decision instead of a negotiation.

This does not weaken the fan-in rules. TPM may still escalate **downward** (`PASS WITH NOTES` -> `FAIL`) when notes compose into a real problem; it may never overrule a slice's `FAIL` upward, and a bar set at dispatch is not a route to doing so.

### Disputes are settled at the ROOT, not the arithmetic

The fan-in rules already say a contradiction between slices is resolved by **dispatching one tie-break verifier**, never by TPM reading the code. This says what that verifier is **for**.

**When two verifiers disagree about a quantity, the overwhelmingly likely cause is two correct numbers over different, unstated populations — not one agent being wrong.** So the tie-break verifier's mandate is **not** to recompute the number. It is to **name the population each number is over**, and the fix that ships is making the population explicit in the prose or the code. Correcting the digit alone is not a fix.

**State the failure mode plainly, because it is the expensive one:** correcting only the arithmetic leaves the ambiguity exactly where it was, so the next reader re-derives the same disagreement and the dispute regenerates. That is how one dispute consumed four rounds — every round corrected the number, no round named the population. The tell is a set of near-synonyms doing load-bearing work without definitions: "branches carrying a copy", "peer branches", and "distinct segments" are three different sets, and a document that uses all three without saying which is meant will produce a fresh dispute on every read. **A tie-break brief that asks "which number is right?" is malformed. The question is "over what?"**

**A verifier's flag is a CLAIM, not a finding, until something independent confirms it.** A false alarm costs a full round to settle — and the flag note itself can describe a wrong mechanism, which sends the tie-break chasing the wrong thing. So a flag must carry **the evidence that lets the next reader confirm or dismiss it without re-deriving it**: the file and line, the exact text or value observed, and what the flagger expected instead. A flag that carries only a conclusion is a request for someone else to do the work twice.

### TPM does not run the census

**When verification needs data gathered — a count, an inventory, a sweep across refs or files — TPM delegates it** (`tpm.md`'s "Delegate, Don't Investigate") rather than running the commands itself. Two reasons, both observed in the field:

- **TPM's context is the scarcest resource in the session.** A census consumes it to produce a result a cheap ephemeral agent could have returned in one line. What TPM spends on gathering, it no longer has for adjudicating.
- **Ad-hoc commands are how an out-of-allowlist command gets run.** TPM reaching for a one-off invocation mid-adjudication is precisely the moment the allowlist check gets skipped.

**`tool.git`'s `allowedCommands` binds TPM exactly as it binds every subagent.** `git.md:3` grants the command if and only if it appears as a key, and `git.md`'s "Role-Specific Notes" says the body applies identically to every agent — there is no TPM exemption anywhere in it. **"Read-only and harmless" is not the test.** The test is whether the command is enabled. `git for-each-ref` and `git cat-file` are both pure reads and both absent from the factory allowlist; running them is a violation with or without a good reason, and noticing afterwards does not convert it into one.

The one measurement this module does authorize TPM to run itself is the combined split-decision read under *When TPM splits* — `git diff --name-only`, `git diff --shortstat`, `git status --porcelain` — and the identical re-read for the coverage invariant at fan-in. Those are named, bounded, allowlisted, and required for a decision only TPM can make. **They are the exhaustive list, not an example of a category.**

### Verification never silently blocks an outward-facing deliverable

**When TPM knows others are waiting on a push, a release, or a handoff, it does not quietly serialize verification in front of it.** It surfaces the trade in one short message and lets the **operator** decide. Four things, one clause each:

- what is **verified green right now**,
- what is **still outstanding**,
- the realistic **worst case of shipping without it**,
- what the **follow-up would cost** if the operator ships and verifies after.

**This is the operator's call, not TPM's.** TPM's failure here is not choosing wrong — it is choosing **silently**. An unfinished verification standing between someone else and their unblock is exactly the class of thing `tpm.md`'s "Brevity Is Never Omission" requires be stated the moment it is known: it is blocked work, and blocked work is disclosed immediately, not at the end.

**The honest counterweight, because this rule is the easiest one here to misread as a licence to skip verification.** It is not. It permits **surfacing a trade-off**. It never permits:

- **downgrading a `FAIL`** — the fan-in rule that TPM may not overrule a slice's `FAIL` upward is unchanged, and operator pressure is not a new exception to it,
- **suppressing a finding** — `tpm.md`'s "Brevity Is Never Omission" still forbids compressing an open or unconfirmed finding out of a report,
- **presenting an unverified result as verified** — an unverified claim reported as done is a false report, and shipping under time pressure is when that is most tempting.

**The Not-Checked ledger ships with the deliverable.** If the operator elects to ship before verification completes, the surviving gaps go out with it, verbatim, with their reasons. The operator is entitled to decide to accept unverified work; nobody is entitled to hide from them that it is unverified.

**And check whether there is a trade to surface at all before assuming there is.** Sometimes there genuinely is nothing left to divide — one pass over three prose deltas in three files is not a fan-out candidate, and cross-document consistency is the one thing a partition cannot check. The bottleneck in that case is not the size of the pass; it is that verification was placed in front of the deliverable at all. Name the real bottleneck. **"I can't split this" and "this doesn't need to block your push" are different sentences, and the second one is usually the one the operator needed.**

## What this module does NOT do

- **Does NOT let a subagent spawn anything.** `swe.md`'s and `qa.md`'s "Hard Rules" (NO SPAWNING SUBAGENTS) stand unmodified. Only TPM fans out; a verifier that wants help returns and says so.
- **Does NOT lower the QA bar.** The eight-dimension checklist of `qa.md`'s "4. Review Checklist" still runs in full against every changed file, per `qa.md`'s "7. Verdict Tiers" closing line. The work is redistributed, never reduced.
- **Does NOT replace QA with SWEs.** QA agents staff slices first; SWE overflow is what happens after the QA cap is reached, and it yields to queued fix work.
- **Does NOT save tokens.** See the cost statement at the top. It costs more and it finishes sooner.
- **Does NOT decide the verdict on TPM's behalf.** The session verdict is derived from slice verdicts by a fixed rule; the module supplies the rule, not the judgment.

## Honest limitations

These are real. Do not soften them when reporting to the operator.

**A by-file split structurally cannot see:**

- An interface changed in one slice with its implementer in another.
- Two independently-added duplicate helpers, one per slice, each locally reasonable.
- Architectural drift that is only visible across the whole change.
- A security property that emerges from composition — each half safe, the pair not.

The "side effects / cross-module coupling" item in `qa.md`'s "4. Review Checklist" is **definitionally unsliceable**: it asks whether a change breaks something the diff does not touch, which is a question about the whole. **So a by-file split degrades one of the eight dimensions by construction.** That is a known cost of the design, not a bug to be fixed later.

**The `wholePictureSlice` verifier mitigates this; it does not eliminate it.** It reads the full diff and runs **ONLY** the cross-cutting items — side effects, cross-file consistency, scope, duplication. It is **explicitly forbidden from re-doing per-file correctness**, which would expand it into a full serial review and erase the entire benefit of the split: at that point the session pays for `N` slices plus a complete serial pass.

**Residual risk, stated plainly:** the whole-picture verifier is a **lower-resolution reader** than a single serial QA that read every file deeply. It skims for shape, not for detail. **A subtle cross-file defect is genuinely more likely to escape under this design than under a single thorough serial review.** That is the honest price of the latency gain, and the operator should know they are paying it.

**Thoroughness is not automatically improved.** Three agents each checking 3 files is the *same total checklist work* as one agent checking 9. The genuine gains are **attention density** (a verifier holding 3 files reasons about each more carefully than one holding 9) and **freedom from late-context pressure** (the ninth file in a long serial review is read with a fuller, more fatigued context than the first). Both are real and both are **modest**. Do not sell the split as a quality improvement. **Latency is what is being bought.**

## Module-disabled vs feature-disabled

These are distinct states and must produce distinct behavior:

- **Module disabled** (no `tool.parallel-verification` in the Session Manifest): TPM dispatches verification as a single agent, always, at any change size. No split triggers, no ledger, no Verification Mode. This is the pre-module behavior and it is a valid way to run.
- **Module enabled, `parameters.splitThreshold` set very high**: the file-count trigger effectively never fires, but the other triggers (line count, change kinds, SWE reports, operator request, stakes) still do. To suppress splitting entirely, disable the module — do not try to starve it with settings.
- **Module enabled, `parameters.sweVerifierOverflow` off**: fan-out is capped at `QA_AGENT_COUNT`. On a stock install (`QA_AGENT_COUNT=1`) that means no fan-out is possible at all; TPM says so once and dispatches a single verifier.
- **Module enabled, `parameters.wholePictureSlice` off**: slices still run and the ledger still applies, but nothing reads the diff as a whole. The by-file blind spots above become unmitigated. Surface that in the verdict line when it matters.
- **Module enabled, but the anti-trigger fires**: single verifier, no split, and TPM says which anti-trigger applied. This is the module working, not the module idle.

Do not merge these cases.

## Role-Specific Notes

The body above applies identically to every agent. The notes below are short framings for how each role uses the policy.

### TPM

You are the only agent that fans out and the only agent that adjudicates. At dispatch time: measure the change with the one combined git read, apply the triggers, apply the floor, then apply the anti-trigger — which overrides everything above it. Run the fast pre-slice before spawning anything and stop there if it fails. Seed the partition from the SWE ownership statement you already wrote, put unowned paths in an explicit residual slice, and give every verifier the full disjointness statement plus the whole change's file list. Staff QA first, overflow to SWE Verification Mode within `parameters.maxSlices`, and yield overflow to queued fix work. At fan-in, derive the verdict as the worst slice verdict — never average, never overrule a `FAIL` upward — run the coverage invariant against fresh git output, dispatch a tie-break verifier for any contradiction rather than reading the code yourself, and carry surviving gaps to the operator verbatim. Announce the shape in one line; the full briefs go in the subagent prompts, not in front of the operator.

Depth is a separate decision from width: before dispatching another round, state what changed since the last one and why it cannot be verified inside the existing floor, and stop once two consecutive rounds return nothing above the bar you set at dispatch. When two slices disagree on a number, dispatch a tie-break verifier to name the population each side counted rather than to recompute the digit, and never run the census yourself — delegate data-gathering the same way you delegate everything else. If someone outside the session is waiting on the deliverable, surface what is verified, what is outstanding, the worst case of shipping now, and the cost of verifying after — in one message, without downgrading a `FAIL` or hiding a gap — and let the operator decide.

### SWE

TPM may deploy you in **Verification Mode**. When it does, you are read-only for the entire assignment — no `Edit`, no `Write`, no fixing anything you find, including inside your own slice, including a one-character bug. That is not politeness: your peers are reading the same working tree right now and any write of yours invalidates their ground truth and the coverage check. Run `qa.md` step 4's eight dimensions against every file in your slice — not the lighter edge-case scan in your own core. Return one verdict (`PASS` / `PASS WITH NOTES` / `FAIL`, `FAIL` when torn), your findings, and a `### Not Checked` section with reasons, rendered even when you pass clean. Each finding is a claim until TPM or a tie-break verifier independently confirms it, so carry the evidence that lets them do that without re-deriving it: the file and line, the exact text or value you saw, and what you expected instead — a conclusion with no evidence just makes someone else do your work twice. If you spot something outside your slice, mention it once and do not chase it. You do not spawn helpers; if the slice is too big, say so and return.

### QA

You staff verification slices first, before any SWE overflow. When TPM gives you a slice, your normal workflow applies unchanged except in scope: your file list is the slice, not the whole diff, and your step-2 file-list verification is against the slice's list plus the whole-change list TPM gave you for context — a changed file that appears in neither is a discrepancy to flag, exactly as your core requires. Your `### Not Checked` section is mandatory and survives the drop-empty-headings rule; it is the one heading you render even with nothing under it. You do not issue the session verdict — TPM derives it from yours and its peers'. Do not soften your slice verdict on the assumption that another slice will catch it, and do not widen your scope to cover a gap you can see: name the gap in the ledger and let TPM route it.
