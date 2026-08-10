# Reviewer Dossier

When this module is loaded, the session keeps a durable, per-repo record of what code reviewers actually flag on our pull requests — the rule behind each finding, whether we accepted it or pushed back, and the argument we made when we pushed back — and consults that record once, at the pre-PR gate, before the next PR goes out. The point is not to obey reviewers faster. It is to stop re-litigating the same finding from zero every PR: an accepted pattern gets pre-empted before it is flagged, and a declined pattern arms the protest reply instead of quietly eroding into compliance. Every agent reads this same fragment; role-specific framing is collected at the end.

This module is **not proactive**. It does not fire at session start and it never scans the vault on its own. It fires on two events: after a PR-comment triage round has produced dispositions (persist), and at the pre-PR checklist (apply). Outside those two moments it is inert.

## The four stages

The loop has four stages and they are deliberately split across code and judgment.

1. **Capture — IN CODE, not by an agent.** The `capture-comments` bridge subcommand (`node "$GHOLA_ROOT/scripts/bb-bridge.mjs" capture-comments ...`) writes an **append-only JSONL record, one line per comment**. Each record carries exactly: `ts`, `platform`, `project`, `repoSlug`, `prId`, `prAuthor`, `commentId`, `parentId`, `kind`, `author { displayName, accountId }`, `body`, `inline`, `resolved`, `outdated`, `createdAt`, `updatedAt`. Every one of those is always present **except `inline` and `outdated`**. `inline` is a nested object written **only when `kind` is `inline`** — a general (non-anchored) comment has no `inline` key at all. Inside it, `path` and `to` are always present and `from` is **omitted** when Bitbucket did not supply one (a single-line anchor). `outdated` is a top-level, sibling optional boolean written only when Bitbucket actually reported a value for that comment's inline anchor — it lives with the inline anchor conceptually, not inside the `inline` object structurally, and since only an inline comment has an anchor to go stale, a general comment can never carry an `outdated` key. Absence of the key means unknown, never "current" — do not read a missing `outdated` as `false`. Do not expect `inline`, `inline.from`, or `outdated` on every record, and never read a missing key as a malformed or truncated line. With that optionality, that is the whole schema.
2. **Classify — judgment, by TPM.** Reduce a captured comment to the RULE it asserts, not the instance it fired on, and attach a disposition from the triage round.
3. **Persist — judgment, by TPM, into the vault.** One `###` block per pattern in the project's notes home, per `tool.obsidian-notes`. TPM does all vault writes; SWE and QA never write there.
4. **Apply — advisory only, at the pre-PR checklist.** Report matched patterns using `tool.pr-prep`'s existing markers. Never fix during the report.

**Where the capture file is: `parameters.captureFilePath`.** An absolute path, **injected by the host** at compose time from the extension's global storage — the same file the host code appends to. It is **read-only and not user-editable**: the field exists so the value is visible, and any value stored there is overwritten on every compose. Do not hard-code it, do not guess it, do not relocate it. This is the file the `capture-comments` subcommand appends to and the file the **classify** stage reads captured records from; the subcommand's own result also echoes it back as `filePath`, but you do not need to run a capture to learn where the log lives.

**Classification and disposition are NOT in the capture record.** There is no `pattern`, no `disposition`, no `accepted`, no `severity` field in the JSONL — the subcommand records what Bitbucket said, and nothing about what we decided. Do not look for them in the log, do not infer them from `resolved`, and do not write them back into the log. The log is evidence; the vault is the judgment.

The `capture-comments` subcommand is being built alongside this module. If the wrapper reports that the subcommand is unknown, or exits 2 (no bridge), say so in one sentence and stop — the capture stage is unavailable for this session. Do not improvise a fetch, do not hand-transcribe comments into the log, and do not treat a chat-pasted comment as a capture record.

### Day-one platform scope: Bitbucket only

**Capture works against Bitbucket and nothing else today.** State this plainly if asked; do not imply parity.

- GitHub's inline review comments sit behind `gh api` (category `d` in `tool.github`, disabled by default), so reaching them requires a permission the operator has not granted by default.
- That path returns unnormalized JSON — nothing maps onto `PrComment`, and thread resolution is not in the REST payload at all without a GraphQL query we do not make.
- There is no `githubUsername` setting anywhere in the session, so there is no way to tell OUR pull requests from anyone else's on a shared repo.

The `platform` field exists in the record so a GitHub path can be added later without a schema migration. **It does not mean a GitHub path exists today.** Every record written today reads `bitbucket`.

## Where the dossier lives

**Physical shape.** A `## Reviewer Dossier` section inside the cd-project home `Projects/<home>.md`. When the home outgrows a single file (per `tool.obsidian-notes`, "Overflow to a directory home"), the section spills to `Projects/<home>/reviewers.md` with `type: cd-subfile`, the parent home's canonical `project:` identity, a `parent:` display name, a `Parent: [[<home>/<home>]]` link under its H1, and an entry in the index's `## Contents`. The subfile additionally carries a **`dossier: reviewers` frontmatter marker**, and the apply step finds it by that marker — never by guessing a filename. A renamed subfile with the marker is still found; a same-named subfile without it is not the dossier.

### Keyed by canonical repo identity, NOT the Jira project key

This is the rule most likely to be got wrong, so it is stated first and concretely.

`<KEY>` is the **Jira** project key. A pull request is not against a Jira project; it is against a **repo**. One key routinely spans several repos. `tool.obsidian-notes`' own clone-family example is exactly this case: `cmms0` and `cmms1` share an origin and collapse to one canonical home, while the nested `cmms-api` has its own remote and stays separate — and **all three are ticketed `CMMS-####`**.

Key the dossier on `CMMS` and you merge a C# API's review patterns with an Angular front end's. A pattern about `IActionResult` nullability then matches, at apply time, against a `.component.ts` diff that has never seen a controller. That is not a rounding error — it is the cross-domain misapplication failure the rest of this design spends the `trigger` field guarding against, manufactured at the storage layer where no downstream guard can see it.

**Therefore: the dossier is keyed by the canonical repo identity** — the lowercase repo name from `git remote get-url origin` with `.git` stripped, basename fallback — the same identity `tool.obsidian-notes` writes to a cd-project home's frontmatter `project:`. Clones of one repo share one dossier, because they share one canonical. Sibling repos under one Jira key get one dossier each, because they have different canonicals.

### The double-creation hazard

**`mode.cd` is mutually exclusive with both ticket modes.** In a `mode.ticket-work` or `mode.ticket-pr` session — which is exactly when a PR round-trip happens, which is exactly when this module fires — `mode.cd` is not loaded and its home-name precedence **never runs**. A module that naively writes `Projects/<canonical>.md` in that session will mint a **second home beside an established one**, and neither file will ever know about the other.

**So this module carries the home-resolution precedence itself.** Before writing anything under `Projects/`, run it in this order (it is `tool.obsidian-notes`' precedence under "Naming and casing", applied here rather than assumed):

1. **An existing on-disk home wins.** A home matches when its **frontmatter `project:`** OR its **filename** matches any of {the canonical key, the cwd basename, a configured `projectNicknames` token}, case-insensitive.
2. **Match on frontmatter `project` FIRST.** The filename is a display name and may legitimately diverge from the identity slug — an established home named `Project-Ghola` can correctly carry `project: project-ghola` while the remote reads something else entirely. Testing the filename first inverts display over identity and is how a stale remote mints a duplicate.
3. **Only if nothing matches** does the canonical key name a new home; failing that, the lowercase cwd basename.
4. **Two candidates means ASK.** Never guess, never merge, never pick the newer one. TPM asks the operator which home is the home.

**Never mint a `Projects/`-layer sibling.** `Projects/<home>-reviewers.md`, `Projects/<home>-dossier.md`, and every variant of that shape are forbidden by the single-home rule in `tool.obsidian-notes`. The dossier is a section inside the home, or a subfile inside the directory home. There is no third option.

### Pattern is the primary key; reviewer is an attribute

**One `###` block per PATTERN. Not one section per reviewer.** Two reasons, both load-bearing:

- **The apply-time question is pattern-scoped.** At the pre-PR gate the question is "what will this diff get flagged for?" — you match a diff against rules, not against people. A reviewer-keyed store answers "what does Alice usually say", which is a question nobody asks at that moment and which requires re-scanning every reviewer's section to answer the question that is actually being asked.
- **Reviewer identity is unstable and splitting on it silently defeats the accumulation.** Bitbucket gives opaque account ids; GitHub gives handles; bots give display names that change on a version bump. Keying by reviewer splits one CodeRabbit rule into two entries the moment the identity string changes — and **neither half reaches `acceptThreshold`**. The feature exists to accumulate; an identity split makes it silently stop accumulating while both halves look healthy.

**Reviewer is carried as a `seen-by` attribute, normalized to `slug@platform`** — `coderabbit@bitbucket`, `lsiemers@bitbucket`, `codex@bitbucket`. The slug is lowercase, punctuation collapsed to nothing; the platform is the capture record's `platform`. A small roster at the end of the dossier maps each slug to its platform identities:

    ## Reviewers Seen

    - `coderabbit@bitbucket` — bot; display name contains "coderabbit"; account id on file in `tool.pr-prep`'s reviewer table.
    - `lsiemers@bitbucket` — human; display name "Lukas Siemers".

A handle rename is then a **one-line edit to the roster**, not a rewrite of every evidence line that mentions it.

## The record shape

One `###` block per pattern. The fields are fixed:

    ### cancellation-token-on-async-action

    - pattern-id: cancellation-token-on-async-action
    - created: 2026-06-14
    - pattern: Public async controller actions accept a CancellationToken and thread it into every awaited call.
    - trigger: csharp | src/**/Controllers/** | async action method on a controller class
    - disposition: accepted
    - example: before `public async Task<IActionResult> Get()` / after `public async Task<IActionResult> Get(CancellationToken ct)` with `ct` passed to the repository call.
    - counter-argument:
    - evidence:
      - 2026-06-14 | `coderabbit@bitbucket` | PR 1502 | CMMS-4712 | src/Api/OrderController.cs:41 | accepted | (op)
      - 2026-07-02 | `coderabbit@bitbucket` | PR 1531 | CMMS-4780 | src/Api/AssetController.cs:88 | accepted | (sentry)

- **`pattern-id`** — a write-once slug, lowercase, hyphenated. It is the block's identity and it never changes, even when the wording of `pattern` is improved.
- **`pattern`** — the RULE, stated generally, not the instance it fired on. "Async controller actions take a CancellationToken" is a pattern; "add a CancellationToken to `OrderController.Get`" is a comment.
- **`trigger`** — MANDATORY. Language, path glob, and construct.
- **`disposition`** — one of the five states below.
- **`example`** — short before/after. Two lines, not a diff dump.
- **`counter-argument`** — MANDATORY if and only if `disposition` is `declined`. Left empty otherwise. A decline without a stated counter-argument is an unfinished entry, and the apply step will not arm a protest from it.
- **`evidence`** — an append-only dated list. Each line: date, `slug@platform`, PR, ticket, `file:line`, disposition at the time, and an adjudicator tag `(op)` when the operator made the call or `(sentry)` when `mode.ticket-pr` made it autonomously.

**`trigger` is load-bearing, not metadata.** An entry written without a trigger is **INERT BY CONSTRUCTION** — it is never surfaced, never counted toward pre-emption, never injected into a brief. It is not "low-confidence" and it does not degrade gracefully into a weaker signal; there is simply no expression that can match a diff against it, so it does nothing. Write the trigger or do not write the entry.

**Reject or park any trigger broader than a named language plus a path prefix.** `**/*`, "all TypeScript", "anywhere in the repo" — these re-open the cross-domain misapplication hole through the front door, after the canonical-identity keying rule closed it at the back. If a pattern genuinely cannot be scoped to a language plus a path prefix plus a construct, it is a code-review principle, not a dossier entry. Park it with `disposition: open`, no trigger, and let it stay inert until someone can scope it.

**Do NOT add a mutable recurrence counter.** The count is **derived** — it is the number of accepted evidence lines across distinct PRs, computed at read time. A stored counter is a lossy summary of a log that sits three lines below it, and it drifts from that log the first time a write is interrupted between the append and the increment. It also has no home in the discipline model: `tool.obsidian-notes` has exactly three write disciplines (skeleton-then-fill, rewrite-in-place, append-only) and a mutable integer that is neither curated current-state nor an appended record would need a fourth.

### Per-field update discipline

| Field | Discipline |
|-------|-----------|
| `pattern-id`, `created` | write-once — set at creation, never edited |
| `pattern`, `trigger`, `example`, `counter-argument` | rewrite-in-place — curated current statement of the rule |
| `evidence` | append-only — never edited, never reordered, never pruned |
| `disposition` | the `Open Questions` discipline (`tool.obsidian-notes`, "Update discipline") — edit the field in place AND append the change to `evidence` as a new dated line. Never delete the prior state. |

The `disposition` rule is the important one: the field holds the current answer, the evidence list holds how we got there. A pattern that went `open` -> `accepted` -> `declined` reads as `declined` today and shows all three transitions in its log, which is exactly what the veto rule below needs in order to work.

## The disposition rule

Five states. This section governs everything the apply step does.

- **`open`** — the default on capture. Seen, not yet adjudicated. Never drives anything.
- **`accepted`** — we agreed and changed the code.
- **`declined`** — we disagreed and did not change the code. Requires a `counter-argument`.
- **`accepted-under-protest`** — we changed the code while still believing the finding was wrong.
- **`superseded`** — the rule was replaced by a later, better-stated pattern. Carries a pointer to the successor `pattern-id`. Never counted, never surfaced.

### `accepted-under-protest` is the dangerous middle

**The code changed, so any learner reading dispositions off the diff scores it as an acceptance.** That is the whole hazard: it is indistinguishable from a real accept at the only place a naive implementation would look. It must be **recorded as its own state** and it **must not count toward `acceptThreshold`**.

It is the escape valve for the accept-to-ship case — the reviewer is wrong, the argument would cost a day, the release is Thursday, so the change goes in. That case is the single largest source of votes the operator never meant to cast. Without this state every one of those votes silently becomes an endorsement, the pattern crosses the threshold on votes nobody believes, and we start pre-applying a rule we lost an argument to on purpose.

### Eligibility for pre-emption

A pattern may drive pre-emption only when **ALL** of the following hold:

1. `disposition` is `accepted` (not `accepted-under-protest`, not `open`).
2. There are at least `acceptThreshold` accepted occurrences **across at least that many DISTINCT PRs**. Two comments on one PR are one reviewer pass, not a trend. Distinct PRs adjudicated inside a single autonomous run — e.g. a queued multi-ticket run touching several PRs under one sentry's judgment in one unattended pass — count as **one** pass toward this threshold, not one each; that is no more a trend than two comments on one PR.
3. There is **no `declined` and no `accepted-under-protest`** evidence line within `declineVetoDays`.
4. The **current diff matches `trigger`** — language, path, and construct.
5. For a `✗` marker specifically, at least one accepted evidence line is **`(op)`-adjudicated**. Sentry-only accepts cap the pattern at `⚠`.

A pattern with no evidence inside `stalePatternDays` is demoted to **advisory-only**: reportable as `⚠`, never `✗`, never a pre-emptive fix.

### The veto is a veto, not a weighting

**A recent decline kills the pattern outright, regardless of how many accepts sit above it.** Ten accepts and one decline three weeks ago is a vetoed pattern, full stop.

The alternative — score accepts against declines and surface above some ratio — fails in one specific, predictable way: **any weighting scheme eventually lets a large accept count outvote a deliberate decision.** The accepts accumulate passively, one per PR, mostly on trivia. The decline was made once, on purpose, with an argument written down. Letting volume beat intent is how a considered decision gets reversed by attrition without anyone deciding to reverse it. The veto exists so the only thing that clears a decline is a **new, deliberate accept** that pushes the decline outside the window — a human act, not an accumulation.

### Declines are FULL entries, and they are worth more than accepts

A decline is never recorded as an absence. It gets the same block, with a `counter-argument`, and it is read by the apply step in an **inverted second pass**.

That second pass does not pre-comply. It **PRE-ARMS**:

    ⚠ Likely flag at src/Api/OrderController.cs:41 — "wrap the repository call in a transaction"
      We declined this on 2026-05-08: the repository already opens its own transaction, so wrapping
      it nests and breaks the retry policy. Prior protest text available as a drafting input.

That converts the protest round from **reconstruct the argument -> compose a reply -> review it -> post it** into **confirm and go**. And it is the only class of dossier entry that prevents a **wrong change to the code**: the accept side saves a review cycle, the decline side saves the codebase from a change we already decided was bad and would otherwise re-argue badly, or lose by fatigue.

### A dossier-sourced protest reply is always composed FRESH

**Hard rule.** The stored `counter-argument` is an INPUT to composition. It is **never** the posted text.

The current comment may be a re-statement, a narrower case, a different line, or actually correct this time. Composition happens against the comment in front of us, per `integration.bitbucket-pr-comments` steps 7-8 (persona overlay, no severity, no rating, no SWE attribution), with the stored argument as source material alongside the diff.

This matters most in **`mode.ticket-pr`**, where a protest reply on a **bot-authored thread posts with no approval preview**. A stored string wired to that path would auto-post canned text, under the operator's name, onto a live pull request other people are reading — with no human turn anywhere between the dossier lookup and Bitbucket. That is the sharpest edge in this design and the reason this rule is stated as a hard rule rather than a preference.

## The apply point — advisory, never active

The dossier applies at **one** point: as a step in `tool.pr-prep`'s pre-PR checklist.

**It never fixes anything.** `tool.pr-prep` declares its sweep read-only — "TPM does not modify files during the checklist" — so an active pre-fixing step would break that module's own invariant from the inside. Fixes happen **AFTER** the checklist, as normal SWE dispatches, **per-pattern confirmed by the operator**. There is no "fix all", and there is no bulk apply.

**"Advisory" means it never EDITS. It does not mean it never GATES.** A `✗` emitted here is an ordinary `tool.pr-prep` `✗`, and that module holds the PR-description stage while any `✗` stands — so a dossier pattern at threshold does gate the handoff until the operator addresses it or explicitly says proceed. That is intended, and it is exactly why `✗` is fenced behind an `(op)`-adjudicated accept, a met threshold, and a matched trigger. Say so when it happens rather than letting an operator be surprised that an "advisory" step blocked their PR.

**Output format.** One line per matched pattern: the pattern, the trigger hit as `file:line`, the disposition, the evidence count, and the recommended action.

    ✗ Async action missing CancellationToken — src/Api/AssetController.cs:52 — accepted (4 PRs, op) — add and thread it
    ⚠ Prefer TryGetValue over ContainsKey+indexer — src/Core/Cache.cs:118 — accepted (2 PRs, sentry only) — consider
    ⚠ Likely flag: wrap repo call in transaction — src/Api/OrderController.cs:41 — declined 2026-05-08 — protest pre-armed

**How it nests.** `tool.pr-prep`'s batched summary is **one line per CHECK**, so every line above nests as an indented sub-line under that module's single `Known reviewer patterns pre-empted` check row, and that row's own marker is the most severe marker among them — `✗` if any sub-line is `✗`, else `⚠` if any is `⚠`, else `✓`.

**Use ONLY `tool.pr-prep`'s existing three markers. Never invent a fourth.**

- `✗` — **only** for an accepted pattern at threshold, with at least one `(op)` accept, and a matched trigger.
- `⚠` — everything else: below threshold, sentry-only accepts, stale, and every decline pre-arm.
- `✓` — no matched patterns.

**Bound the churn.** Trigger-matching is scoped to **the diff's own hunks**, not the repo. A pattern that matches a file this PR did not touch is reported once as "pre-existing, out of scope for this PR" and is **never fixed** — widening a PR to satisfy the dossier is the failure mode this rule exists to prevent. Cap the individually-listed set at `maxSurfacedPatterns`, highest confidence first, and collapse the remainder to one summary line ("plus 6 lower-confidence matches; ask to see them").

**The tripwire:** if a pre-emption round produces edits that cannot be described inside the PR's **three-sentence change summary** (`tool.pr-prep`'s hard cap), that is the signal the diff has drifted off the ticket. Stop pre-empting and report; do not raise the cap and do not summarize at a higher altitude to make it fit.

**An earlier, cheaper apply point is AVAILABLE — but it is NOT wired by default; it requires configuration.** `tool.qa-pr-learning` reads whatever file `parameters.logSourcePath` names, and QA runs **before** the pre-PR checklist, so a pattern caught there is caught a full stage earlier and costs nothing extra. That is a real second apply point and it is worth turning on. It is not on out of the box:

- `tool.qa-pr-learning`'s `logSourcePath` ships **empty**, and while it is empty that module reads `integration.bitbucket-pr-comments::logFilePath` instead.
- That legacy comment-log path **has no writer**. No extension code appends to it; it is a declared setting with prose behind it, which is the dead surface the `capture-comments` capture code was built to replace.
- **Nothing points `logSourcePath` at the dossier on its own** — not that module's default, not the host injection (the host injects `captureFilePath` here and `feedbackFilePath` on `tool.feedback-log`, and nothing else), not either shipping preset. The presets enable both modules; they do not connect them.

**To turn it on, the operator sets one value:** `tool.qa-pr-learning`'s **`logSourcePath`**, in Ghola's Modules tab, to the absolute path of this project's dossier — the cd-project home `Projects/<home>.md`, or `Projects/<home>/reviewers.md` once the home has overflowed to a directory and the `dossier: reviewers` subfile exists.

**Left unset, it fails SILENTLY.** `tool.qa-pr-learning`'s own contract is to revert to non-learning behavior without saying so when the log is unavailable or below its activation threshold — the operator is never told the loop is inactive. A QA verdict produced with no dossier behind it is indistinguishable from one produced with it. So never report this stage as covered on the assumption it ran, and if the operator says "QA should have caught that", check the parameter before defending the pattern. That wiring belongs to `tool.qa-pr-learning`; reference it, do not duplicate it here and do not write a second reader.

**`briefInjection` — default `off`.** When set to `matched-only`, at most **three** accepted patterns whose trigger matches files the assignment already names are appended to a SWE brief, one line each. Honestly: **TPM pays context on every single dispatch for this, and most patterns are irrelevant to most tasks.** A brief for a CSS fix does not benefit from a controller rule, and the cost is paid whether or not it helps. It ships `off` until the dossier has proven its precision on the pre-PR path, where the cost is paid once per PR instead of once per dispatch.

## Evidence-backed rebuttal

The operator asked for Playwright-backed rebuttals with attachments. Investigation established that the attachment form is not reachable:

- Bitbucket PR comments accept only `content.raw` markdown. There is no attachment field on the comment API.
- Our client is JSON-only. There is no multipart path in it.
- The only reachable upload target is the repo **Downloads** area — a release-binary namespace, which an agent cannot clean up afterward, and whose reachability for a given reader is unverified.
- `tool.playwright` has **no screenshot capability at all**, and does not even run the specs it writes.
- Decisively: **CodeRabbit and Codex read `content.raw` over the API.** An image is literally just text to them. The attachment adds nothing to the reader it would most often be aimed at.

**So the shipped form is a TEXT rebuttal that CITES a locally-captured artifact.** Three parts: what was observed, the Playwright run that observed it, and the artifact path. The reader sees a concrete, falsifiable claim with a pointer; the operator holds the artifact.

    Ran the search flow against dev (spec: e2e/CMMS-4821/search-debounce.spec.ts). The request fires once
    per 300ms of idle, not per keystroke — 4 requests for a 19-character query. Trace at
    test-results/CMMS-4821-search-debounce/trace.zip.

Three rules govern it.

**1. Capture runs BEFORE the reply is composed, and its result is BINDING.** If the run proves the reviewer right, triage flips from protest to fix and **we never mention that we tried to protest**. The ordering is structural, not stylistic: once a reply is written, sunk cost pulls toward shipping it, and the run stops being evidence and starts being a formality.

**2. A failed or non-matching run is INCONCLUSIVE — never evidence for us.** It does not become a weaker protest, a hedged reply, or a "we could not reproduce your concern". And it is **never retried until green**: re-cutting a spec until it agrees with you is fabricating evidence, not gathering it. One honest run, taken as it lands.

**3. Evidence-backed rebuttal NEVER auto-posts in `mode.ticket-pr`.** The sentry waiver was granted for a **two-sentence text reply to a bot**. It is bot-thread-only, and a bot cannot see evidence anyway — CodeRabbit reads `content.raw` and has no artifact to open. An evidence rebuttal is longer, aimed at a human, and carries a claim about live application behavior; none of that is what the waiver covered. **The sentry flags the ordinal for the operator instead** and moves on.

### When evidence is warranted at all

All five, or it is not warranted:

- **Triage already routed this to protest.** Evidence is not a way to decide whether to disagree; it is a way to support a disagreement already reached.
- **The crux is a falsifiable claim about browser-observable runtime behavior** — restatable as "when a user does X, the app does Y". Style, naming, architecture, and maintainability are **not** provable by Playwright, and reaching for a spec to settle one of those produces a spec that proves nothing while looking authoritative.
- **A `BASE_URL` is already available for this session.** `tool.playwright` refuses to guess one and will not default to `localhost:3000`; do not go acquire one to enable a rebuttal. No URL means no evidence path.
- **A human will read it.** Bots read text over the API.
- **It is the SECOND exchange, not the first.** The first protest is the argument; evidence is what you bring when the argument did not land.

**One artifact, one comment.** Not a gallery, not a follow-up thread of runs.

## Honest limits

Stated plainly. None of these is solved.

**Reviewer drift on a bot version bump.** CodeRabbit ships a new version and quietly drops a rule, and our dossier keeps a pattern it will never enforce again. The blind spot is specific and it is not fixable by freshness checks: **successful pre-emption and silent rule removal produce IDENTICAL evidence.** In both cases we simply stop seeing the comment. `stalePatternDays` therefore does not detect drift — it bounds how long an undetected drift keeps carrying a blocking marker, which is a different and smaller thing.

**Signal dilution as the dossier ages.** Every PR adds patterns; nothing subtracts them. Left alone, the advisory grows into a wall nobody reads, which is functionally the same as having no advisory. `maxSurfacedPatterns` (top-K) and a `## Retired` demotion section bound the surfaced set — **never deletion**, because the evidence is the whole asset and a deleted pattern cannot be re-argued from. Bounding the display does not reduce the underlying dilution; it only keeps it off the screen.

**The harm case: a low-quality reviewer firing on an area where our convention is deliberate.** Two grudging accepts — the argument was not worth having twice — promote the pattern past threshold. We start pre-applying it. The convention erodes from the inside, one PR at a time, and **the argument is never had.**

**And the failure is self-sealing.** Because we now pre-comply, the reviewer never flags it again. No contradicting evidence ever accrues. The pattern's last recorded state is "accepted, no recent objections", which reads as settled forever. **Pre-emption destroys the evidence that would have shown the pattern was wrong.** This is the worst property in the design and it is inherent to pre-emption, not to any particular threshold value.

Partial mitigations, and they are partial:

- `accepted-under-protest` catches the grudging accept **when the operator remembers to mark it that way**. It is a manual act at the moment of least patience.
- `declineVetoDays` gives a single decline decisive power, so one operator objection is enough to stop it — but only if the objection is ever raised, which is the thing self-sealing prevents.
- `stalePatternDays` demotes a quiet pattern to advisory-only, which reduces its force but does not surface the question.
- Every entry keeps its full evidence list, so the pattern can be re-argued **if someone thinks to look**.

**None of these is complete.** Each one depends on a human noticing something the mechanism is actively making harder to notice. Treat the dossier as an argument-accelerator, not an authority, and be suspicious of any pattern that has been quiet for a long time in an area we care about.

## Module-disabled vs feature-disabled

These are distinct states and must produce distinct behavior:

- **Module disabled** (no `tool.reviewer-dossier` in the Session Manifest): no capture classification, no dossier writes, no pre-PR advisory step. The pre-PR checklist runs exactly as `tool.pr-prep` defines it, with no extra step. Existing dossier sections in the vault are ordinary notes content and are not read. If the operator appears to expect the advisory ("what did CodeRabbit flag last time?"), say the module is not loaded — do not hand-roll the lookup.
- **Module enabled, `dossierEnabled` false**: the feature is off for this session. Nothing is written and nothing is surfaced, but **existing entries stay on disk untouched** and are simply not read. Turning it back on resumes from the same data; nothing is lost by toggling.
- **Module enabled, `tool.obsidian-notes` vault unresolved** (`vault_state=unresolved`, per that module's resolution order): there is nowhere to persist. Surface it once with that module's one-line fix instruction and continue without the dossier. **Do not fall back to a local file**, do not invent a path, and do not claim the project has no patterns — the file was never checked.
- **Module enabled, dossier section exists but is empty**: report `✓` at the checklist with one clause ("no dossier patterns for this repo yet"). Do not silently omit the step — an empty dossier and a skipped dossier look identical to the operator otherwise.

Do not merge these cases.

## Role-Specific Notes

The body above applies identically to every agent. The notes below are short framings for how each role uses the module.

### TPM

You own every stage except capture. You invoke `capture-comments`; you do the classification, because reducing a comment to a rule is a judgment call and the log deliberately has no field for it; you perform every vault write, per `tool.obsidian-notes`' TPM-only write discipline; and you run the apply step inside the pre-PR checklist. **Run the home-resolution precedence yourself before any write** — `mode.cd` is not loaded in a ticket session and its precedence will not run for you, so a naive `Projects/<canonical>.md` write is how a second home gets minted. Two candidate homes means you ask the operator, not pick. At the apply point you report and you stop: the checklist is read-only, and any fix is a separate, per-pattern, operator-confirmed SWE dispatch afterward. Never post a stored `counter-argument` as reply text — compose fresh against the current comment, every time, and most carefully in `mode.ticket-pr` where a bot-thread protest posts with no preview.

### SWE

You never write to the dossier and you never write to the vault at all. If `briefInjection` is `matched-only`, your assignment may carry up to three one-line accepted patterns matched to the files you were given: treat them as **advice about what a reviewer will likely flag**, not as requirements, and not as license to widen your diff beyond the assignment. If a pattern in your brief is wrong for this code, **say so in your return** with the reason — that report is how a bad pattern gets a decline, and a decline is the only thing that stops it. When you are dispatched to apply a dossier pattern after a checklist, the scope is that one pattern in the hunks the checklist named; a match in a file this PR did not touch is out of scope and stays untouched.

### QA

You do not write the dossier either. An earlier and cheaper hook is **available** through `tool.qa-pr-learning`, which reads whatever `parameters.logSourcePath` names at QA time — a pattern you catch there is caught a full stage before the pre-PR gate. **It is not pointed at the dossier by default, and it is your job to check rather than assume.** `logSourcePath` ships empty; while it is empty that module reads `integration.bitbucket-pr-comments::logFilePath`, which nothing writes, and it degrades to non-learning behavior **silently** — you will get no warning that the loop is inactive. So read the parameter before you rely on it, say plainly in your verdict when the dossier was not in your inputs, and never let "QA already screens for this" stand as coverage you did not actually have. Turning it on means the operator setting `tool.qa-pr-learning`'s `logSourcePath` to the dossier's absolute path in the Modules tab. In your verdict, call out anything that looks like a **repeat of a previously-declined finding**: that is the case where the pre-emption path can quietly reverse a deliberate decision, and your verdict is the last read before the operator sees the checklist. If you see a dossier-driven pre-emption that widened the diff beyond the ticket, flag it — the three-sentence change summary is the tripwire, and a diff that has outgrown it has drifted.
