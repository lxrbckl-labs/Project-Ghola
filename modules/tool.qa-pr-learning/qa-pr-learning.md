# QA PR Learning

When this module is loaded, QA's review behavior gains a learning loop that draws on the persistent comment log produced by `integration.bitbucket-pr-comments`. Past reviewer patterns — colleagues who consistently flag compound `.Where()` predicates, recurring requests for null checks on async returns, CodeRabbit catches that show up over and over in this repo — become inputs to QA's own findings, surfaced proactively during reviews rather than rediscovered from scratch each time.

This module is **not proactive**. It does not fire at session start. QA consults the log on-demand at review time, exactly when it is about to produce a verdict on a SWE return. Without an active review, this module sits quietly. The fragment targets QA only — SWE and TPM do not consume it directly.

## What QA learns from

The source of truth is the persistent comment log written by `integration.bitbucket-pr-comments` when its `logCommentsEnabled` setting is on. Each log entry is one JSON line with fields: `ts` (ISO timestamp), `prId`, `commentId`, `author`, `body`, `verb` (`address` or `post`), `isReply` (boolean), and optionally `lens` and `replyTo` for posted findings and replies respectively.

- `ts` — ISO timestamp when the comment was first observed
- `prId` — the PR the comment belongs to
- `commentId` — the unique comment id
- `author` — who wrote the comment
- `body` — the comment text
- `verb` — the action that produced this entry (`address` or `post`)
- `isReply` — whether the comment is a reply on an existing thread
- `lens` — optional; present on `post` entries to record the lens that produced the finding
- `replyTo` — optional; present on reply entries to record the parent comment id

QA reads the file at `parameters.logSourcePath`. When that parameter is empty (the default), QA defers to the canonical path configured in `integration.bitbucket-pr-comments::logFilePath` — that integration owns the writer, and this module is a read-only consumer of the same file.

When `tool.reviewer-dossier` is loaded, `parameters.logSourcePath` may instead point at that module's dossier — the curated, already-classified per-project record of recurring review patterns — rather than the raw comment log. **This requires the operator to explicitly set `logSourcePath` to the dossier location; loading `tool.reviewer-dossier` does not do this automatically, and the parameter's default remains `""`.** While `logSourcePath` is empty, this module defers to `integration.bitbucket-pr-comments::logFilePath` regardless of whether `tool.reviewer-dossier` is also loaded — and that path is a settings surface with no writer behind it by default, so an operator who enables the dossier module but never points `logSourcePath` at it is reading a legacy path nothing writes, with no indication anything is wrong: the activation gate below fails silently by design, and this module does not tell the user the loop is inactive. When `logSourcePath` IS set to the dossier, QA reads learned patterns directly from the dossier's existing classification and disposition instead of re-deriving them from raw comment bodies; the dossier's structure is documented by `tool.reviewer-dossier`, not by the `ts`/`prId`/`commentId`/... schema above, which still applies whenever `logSourcePath` points at the raw log. Either way this module stays a read-only consumer — it never writes to the dossier.

## Pattern extraction modes

The behavior of the learning loop is determined by `parameters.patternExtractionMode`:

### `recurring-themes` (default)

QA groups comment bodies by topic via keyword and simple-NLP buckets — null-check, naming, error-handling, performance, security, style. A theme that appears in ≥3 distinct comments becomes a "learned pattern" QA surfaces during review. This is the most generally useful mode because it produces team-shaped guidance ("this team consistently flags X") rather than person-shaped or phrase-shaped guidance.

### `author-styles`

QA indexes the log by `author`. Each colleague's recurring concerns become a per-author pattern set, and during review QA cross-references which authors typically catch which issues in this repo. Useful when a team has a strong reviewer culture and QA wants to anticipate the specific kinds of feedback known reviewers will produce.

### `literal-quotes`

QA stores specific phrasings from past comments and surfaces them as exemplars when drafting verdict text — for example, "phrasing similar to: `Consider extracting this into a guard clause`." Useful when the team has a recognizable house voice and QA's verdicts should align with it stylistically.

QA applies exactly one mode per session — whichever `parameters.patternExtractionMode` is set to. It does not blend modes.

### Mode availability when the source is the dossier

The three modes above are described against the raw comment log. When `logSourcePath` points at the `tool.reviewer-dossier` dossier instead, they are **not** equally available, because the dossier's record shape (`tool.reviewer-dossier`, "The record shape") is pattern-keyed and deliberately holds no raw comment text or per-reviewer index:

- **`recurring-themes`** is the only mode with a real source in the dossier. Each `###` block already IS a theme — the dossier has done the grouping in advance, by pattern rather than by keyword bucket — so against a dossier source this mode reads the existing pattern blocks directly instead of deriving buckets from comment bodies. This is the mode to use when `logSourcePath` points at the dossier.
- **`author-styles`** has no source in the dossier. The dossier has no `author` field to index by. Reviewer identity survives only as the `seen-by` attribute (normalized `slug@platform`) attached to individual evidence lines inside a pattern block, not as a top-level key — and `tool.reviewer-dossier` keeps it that way deliberately ("Pattern is the primary key; reviewer is an attribute"): keying by reviewer silently splits one accumulating pattern into two whenever an identity string changes (a Bitbucket account id, a GitHub handle, a bot's display name after a version bump), and neither half ever reaches the dossier's `acceptThreshold`. Do not reconstruct a per-author index by scanning `seen-by` across pattern blocks — that reintroduces the exact failure the dossier's design exists to avoid. If `author-styles` is selected while `logSourcePath` points at the dossier, treat it the same as a corrupted/unreadable log (see "Module-disabled vs feature-disabled" below): log the mismatch once, and proceed without learning for the remainder of the session.
- **`literal-quotes`** has no source in the dossier either. The dossier deliberately stores no raw comment bodies — only a curated `pattern` statement and a two-line `example`, neither of which is a verbatim phrasing to quote. Raw bodies live in the `capture-comments` JSONL that `tool.reviewer-dossier` writes, and pointing `logSourcePath` at the dossier means QA is not reading that file. Same treatment as `author-styles`: unavailable against a dossier source, logged once, no learning for the session rather than a fabricated substitute.

In short: against a dossier source, only `recurring-themes` is meaningful. `author-styles` and `literal-quotes` have nothing to read there.

## Activation gate

QA only activates the learning loop when the log has at least `parameters.minLogEntriesToActivate` entries. Below the threshold, QA reverts to its non-learning behavior — review based solely on the in-session diff and SWE return — and the user is NOT told the learning loop is inactive. The threshold check is silent; log it once when first crossed if visibility is needed, but otherwise leave it implicit.

The threshold exists because pattern extraction on too few entries produces noise rather than signal. Default 10 is conservative; teams in established repos can lower it for faster activation, and teams that want stricter signal can raise it.

### Eligibility precedence when the source is the dossier

This module's own gates — `recurring-themes`' ≥3-distinct-comments rule and `parameters.minLogEntriesToActivate` — are raw-log gates. They decide when a pattern earns attention while QA is deriving it from scratch out of uncurated comment bodies. They are not a second, competing eligibility model once `logSourcePath` points at the `tool.reviewer-dossier` dossier, because the dossier already carries its own, stricter one.

**When the source is the dossier, `tool.reviewer-dossier`'s eligibility rules are authoritative, not this module's.** See that module's "Eligibility for pre-emption" and "The disposition rule" for the actual mechanics (`acceptThreshold` across distinct PRs, the `declineVetoDays` veto, the mandatory `trigger` match, the `(op)`/`(sentry)` severity cap) — they are deliberately not restated here, so this file cannot drift out of sync with the file that owns them. In particular:

- A pattern the dossier vetoes (a `declined` or `accepted-under-protest` evidence line within `declineVetoDays`) is not a learned pattern for QA's purposes, no matter how many raw occurrences would otherwise satisfy `recurring-themes`' ≥3-comment count. The veto is a veto, not a weighting: a decline the team made on purpose must not resurface here just because a different module's raw count found it plausible.
- `parameters.minLogEntriesToActivate` still gates whether the learning loop bothers consulting the dossier at all (there must be enough dossier content to be worth reading), but it never substitutes for, lowers, or overrides the dossier's own per-pattern eligibility. A dossier with far more than `minLogEntriesToActivate` evidence lines but zero patterns at `acceptThreshold` yields zero learned patterns, not a fallback to raw counting.

Two eligibility models over one data set with no stated precedence is exactly the cargo-culting failure the dossier's disposition design exists to prevent — this rule is that precedence.

## How learned patterns appear in verdicts

The behavior is determined by `parameters.surfaceLearnedPatterns`:

- **`true`** (default): QA verdict entries cite the source explicitly. Example: "Learned pattern: null checks on async returns are flagged in 4 prior PRs (CMMS-1234, CMMS-2456, CMMS-3567, CMMS-4678)." The citation makes the lineage of the finding visible to the user and to future reviewers reading the verdict.
- **`false`**: QA internalizes the patterns without citation. Findings still benefit from the learning loop, but the verdict reads naturally and the learning is invisible. Useful for established teams that already share the context and find the citations noisy.

The choice does not affect what QA flags — only how the flag is phrased. The same pattern fires either way.

## What QA does NOT learn

The learning loop has scope limits, and the following are explicitly out of scope:

- **Secrets, tokens, or credentials** accidentally posted in comment bodies. When `tool.secrets-wrapper-pattern` is enabled, its filter applies before QA reads the log entries — secret-shaped values are scrubbed at that boundary, not by this module.
- **Personal opinions or off-topic discussion** in comments. Pattern extraction is bounded to review-related content; chat-style threads, social asides, and non-review remarks are excluded from the buckets.
- **Comments older than what the log actually retains.** `integration.bitbucket-pr-comments::logRetentionDays` is a legacy setting for a pruning design that was never implemented — nothing enforces it, and no automatic deletion of the log occurs. The log's actual bound is the coded `capture-comments` path's size-based rotation (documented in `tool.reviewer-dossier`); entries that rotate out of that file are the ones this module no longer sees.

## Module-disabled vs feature-disabled

These are distinct states and must produce distinct behavior:

- **Module disabled** (no `tool.qa-pr-learning` in the Session Manifest): QA reviews are based solely on the in-session diff and the SWE return. No learning loop. No log reads. QA behaves as it would in any session without this module.
- **Module enabled, `parameters.learningEnabled` off**: same effect as module disabled. QA does not read the log. The master switch is the gate, and turning it off cleanly disables the loop without removing the module.
- **Module enabled, log unavailable or below the threshold**: QA reviews without learning. No surfacing, no citation. The fallback is silent — the user is not told the loop is inactive on this review unless the threshold is being crossed for the first time and visibility is wanted.
- **Module enabled, log corrupted or unreadable** (file present but parse fails): QA logs the failure once to the session output and proceeds without learning for the remainder of the session. Do not retry on every review; the failure is sticky until the user fixes the log.

Do not merge these cases.

## Sibling-module interaction

- **`integration.bitbucket-pr-comments`** (required upstream): produces the log this module consumes. When that module's `logCommentsEnabled` is off, the log is empty (or contains only legacy entries from a prior session) and this module's learning loop sits below the activation threshold. The two modules form a writer/reader pair: bitbucket-pr-comments writes, this module reads, and neither modifies the other's file ownership.
- **`tool.secrets-wrapper-pattern`**: filters secret-shaped values out of log entries before QA reads them. When enabled, QA's pattern extraction operates on the scrubbed view; when disabled, raw comment bodies flow through unchanged. The filter is a boundary, not a transform owned by this module.
- **`tool.reviewer-dossier`**: an alternate source for `parameters.logSourcePath`. When loaded, the dossier can substitute for the raw comment log as a curated, already-classified reference; pointing `logSourcePath` at it means QA reads its existing patterns directly rather than deriving them from raw comment lines. This module never writes to the dossier, in either configuration.

## Role-Specific Notes

### QA

You are the consumer. At each review, before producing your verdict, consult the log at `parameters.logSourcePath` (or the canonical path from `integration.bitbucket-pr-comments::logFilePath` when the parameter is empty), apply `parameters.patternExtractionMode`, and let learned patterns inform your findings. Cite them per `parameters.surfaceLearnedPatterns` — explicit citations when on, internal use only when off. Respect the activation gate: if the log is below `parameters.minLogEntriesToActivate`, revert silently to non-learning behavior. The log is READ-ONLY for you — you never write to it, never edit entries, never rotate or prune the file. Writing is the writer module's job; you only read.

### TPM

You have no direct interaction with this module. You orchestrate QA dispatches; the learning loop happens inside QA's review behavior. Do not duplicate this content in your QA assignments — QA's own copy of the module carries the rule, and restating it in the assignment is noise. If the user asks whether the learning loop is active, you can check the module's `learningEnabled` parameter and the log's entry count, but the moment-to-moment behavior is QA's, not yours.

### SWE

You have no interaction with this module. Learned patterns surface in QA verdicts, which you receive after your work is reviewed — at that point the lineage may be visible as cited patterns (per `parameters.surfaceLearnedPatterns`), but you do not consult the log yourself and you do not need to anticipate the loop's behavior when producing your work.
