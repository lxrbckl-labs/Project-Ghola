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

## Pattern extraction modes

The behavior of the learning loop is determined by `parameters.patternExtractionMode`:

### `recurring-themes` (default)

QA groups comment bodies by topic via keyword and simple-NLP buckets — null-check, naming, error-handling, performance, security, style. A theme that appears in ≥3 distinct comments becomes a "learned pattern" QA surfaces during review. This is the most generally useful mode because it produces team-shaped guidance ("this team consistently flags X") rather than person-shaped or phrase-shaped guidance.

### `author-styles`

QA indexes the log by `author`. Each colleague's recurring concerns become a per-author pattern set, and during review QA cross-references which authors typically catch which issues in this repo. Useful when a team has a strong reviewer culture and QA wants to anticipate the specific kinds of feedback known reviewers will produce.

### `literal-quotes`

QA stores specific phrasings from past comments and surfaces them as exemplars when drafting verdict text — for example, "phrasing similar to: `Consider extracting this into a guard clause`." Useful when the team has a recognizable house voice and QA's verdicts should align with it stylistically.

QA applies exactly one mode per session — whichever `parameters.patternExtractionMode` is set to. It does not blend modes.

## Activation gate

QA only activates the learning loop when the log has at least `parameters.minLogEntriesToActivate` entries. Below the threshold, QA reverts to its non-learning behavior — review based solely on the in-session diff and SWE return — and the user is NOT told the learning loop is inactive. The threshold check is silent; log it once when first crossed if visibility is needed, but otherwise leave it implicit.

The threshold exists because pattern extraction on too few entries produces noise rather than signal. Default 10 is conservative; teams in established repos can lower it for faster activation, and teams that want stricter signal can raise it.

## How learned patterns appear in verdicts

The behavior is determined by `parameters.surfaceLearnedPatterns`:

- **`true`** (default): QA verdict entries cite the source explicitly. Example: "Learned pattern: null checks on async returns are flagged in 4 prior PRs (CMMS-1234, CMMS-2456, CMMS-3567, CMMS-4678)." The citation makes the lineage of the finding visible to the user and to future reviewers reading the verdict.
- **`false`**: QA internalizes the patterns without citation. Findings still benefit from the learning loop, but the verdict reads naturally and the learning is invisible. Useful for established teams that already share the context and find the citations noisy.

The choice does not affect what QA flags — only how the flag is phrased. The same pattern fires either way.

## What QA does NOT learn

The learning loop has scope limits, and the following are explicitly out of scope:

- **Secrets, tokens, or credentials** accidentally posted in comment bodies. When `tool.secrets-wrapper-pattern` is enabled, its filter applies before QA reads the log entries — secret-shaped values are scrubbed at that boundary, not by this module.
- **Personal opinions or off-topic discussion** in comments. Pattern extraction is bounded to review-related content; chat-style threads, social asides, and non-review remarks are excluded from the buckets.
- **Comments older than the log's retention window**, set by `integration.bitbucket-pr-comments::logRetentionDays`. Once entries roll off the writer's retention, this module no longer sees them — that retention boundary is the writer's, not the reader's.

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

## Role-Specific Notes

### QA

You are the consumer. At each review, before producing your verdict, consult the log at `parameters.logSourcePath` (or the canonical path from `integration.bitbucket-pr-comments::logFilePath` when the parameter is empty), apply `parameters.patternExtractionMode`, and let learned patterns inform your findings. Cite them per `parameters.surfaceLearnedPatterns` — explicit citations when on, internal use only when off. Respect the activation gate: if the log is below `parameters.minLogEntriesToActivate`, revert silently to non-learning behavior. The log is READ-ONLY for you — you never write to it, never edit entries, never rotate or prune the file. Writing is the writer module's job; you only read.

### TPM

You have no direct interaction with this module. You orchestrate QA dispatches; the learning loop happens inside QA's review behavior. Do not duplicate this content in your QA assignments — QA's own copy of the module carries the rule, and restating it in the assignment is noise. If the user asks whether the learning loop is active, you can check the module's `learningEnabled` parameter and the log's entry count, but the moment-to-moment behavior is QA's, not yours.

### SWE

You have no interaction with this module. Learned patterns surface in QA verdicts, which you receive after your work is reviewed — at that point the lineage may be visible as cited patterns (per `parameters.surfaceLearnedPatterns`), but you do not consult the log yourself and you do not need to anticipate the loop's behavior when producing your work.
