# PR Monitor

When this module is loaded, the session can fetch open review comments on the current branch's Bitbucket pull request, triage them with the user, dispatch SWEs to apply code fixes, and post generated replies back to Bitbucket. The flow is round-trip: read comments, fix code, reply, optionally resolve. TPM never authors the code or the public reply text on its own — SWEs produce the fixes and the reply-generation step produces the reply, all under explicit user approval.

Invoke this module when the user types a trigger from the grammar below, or proactively offer it at session start if you observe that the current branch has an open PR with unresolved comments. Do not auto-fetch on session start; offer the module and wait for the user to opt in. The module is designed to fail loudly rather than silently: every API failure, every staleness condition, every refused write surfaces in chat so the user knows exactly what state Bitbucket is in.

## Dependency

This module requires `integration.atlassian-suite` to be enabled with a Bitbucket token set. The Atlassian Suite owns the per-product token slots (`ghola.atlassianSuite.bitbucketToken`) and the AtlassianBridge that this module's host-side client uses to authenticate. Reusing the bridge means the user is never re-prompted for credentials, and tokens never appear in this module's surfaces — they stay in SecretStorage where the suite put them.

If `integration.atlassian-suite` is not loaded, or its Bitbucket token slot is empty, refuse the trigger in one sentence that names the suite and the slot, and point the user at the Modules tab. Do not attempt to fall back to a different auth mechanism or to prompt the user for a token in chat — the suite owns that surface end-to-end.

The `bitbucketWorkspace` setting on the suite is also consulted by the client when the local git remote cannot be parsed; it is not an input this module exposes directly.

## Capabilities

TPM invokes every Bitbucket PR-comment operation by shelling out to a wrapper script that talks to a loopback HTTP bridge server the extension host runs:

```
node "$GHOLA_ROOT/scripts/bb-bridge.mjs" <subcommand> [flags]
```

The wrapper prints the operation's JSON result to stdout and exits non-zero on failure — loud, never silent. Internally the bridge server authenticates through the AtlassianBridge / `integration.atlassian-suite` credentials exactly as before, so the Bitbucket token still never crosses the agent boundary. The agent also never sees the bridge server's own bearer token: the wrapper reads `GHOLA_BRIDGE_TOKEN` from its environment. Never echo it in chat or logs, and never pass it as a flag — this is the same secrets discipline the module already applies to the Bitbucket token itself.

Five subcommands are available:

- `find-pr --repo <slug> --branch <name>` — resolves the open PR id for the current branch.
- `list-comments --repo <slug> --pr <id>` — fetches all PR comments (resolved + unresolved, inline + general); this is the `address comments` snapshot source. Each comment carries: `id`, `parentId` (`null` for top-level thread starters), `kind` (`'inline'`/`'general'`), `author` (`{ displayName, accountId }`), `body`, `inline?` (`{ path, to, from? }`), `resolved`, `createdAt`, `updatedAt`.
- `reply --repo <slug> --pr <id> --parent <commentId> [--inline-path <p> --inline-to <n> --inline-from <n>]` — posts a reply threaded under an existing comment. The reply body is NOT a flag — it is piped via STDIN (see the heredoc pattern below). Supply the `--inline-*` flags when replying to an inline comment so the reply lands on the same file/line thread; omit them for general comments.
- `resolve --repo <slug> --pr <id> --comment <id>` — marks a comment thread resolved.
- `mark-ready --repo <slug> --pr <id>` — marks a DRAFT PR ready for review. This is a Bitbucket write; see "Mark Ready Verb" below for the confirmation gate that guards it.

Repo slug comes from `git remote get-url origin` (strip `.git`, take the last path segment). PR id comes from `find-pr`.

> PR *creation* is owned by `integration.atlassian-suite` (the `create pr` verb, which uses the same bridge via `bb-bridge.mjs create-pr`). This module handles the post-creation lifecycle only — read/reply/resolve comments and mark a draft PR ready.

### Posting a reply (stdin body)

Reply bodies are multi-line, so they are piped into the wrapper via a heredoc rather than passed as a flag:

```bash
node "$GHOLA_ROOT/scripts/bb-bridge.mjs" reply --repo my-repo --pr 42 --parent 9876 <<'EOF'
Fixed by extracting the validation into validateInput() -- see src/Foo.ts:88.
EOF
```

For an inline reply, add the `--inline-*` flags before the heredoc:

```bash
node "$GHOLA_ROOT/scripts/bb-bridge.mjs" reply --repo my-repo --pr 42 --parent 9876 \
  --inline-path src/Foo.ts --inline-to 88 <<'EOF'
Fixed by extracting the validation into validateInput() -- see src/Foo.ts:88.
EOF
```

### Missing bridge

Exit code 2 from the wrapper means the bridge server is unavailable — this is not a Ghola session, or the extension host is not running the loopback server. Surface this to the user in one sentence and stop. Do not retry and do not fall back to any other auth path.

If the wrapper script itself is missing or `node` fails to launch it, refuse the trigger in one sentence and surface the failure to the user rather than improvising a workaround.

## Trigger Grammar

The user invokes this flow by typing one of:

- `address comments` / `address` — full triage of all open unresolved comments.
- `address <ordinals>` — `address 1`, `address 1, 3-5`, etc. Picks individual ordinals from the current snapshot.
- `address all` — every comment in the snapshot (TPM still asks per-action what to do).
- `address all <author-substring>` — filter by comment author display name (case-insensitive substring match; e.g., `address all coderabbit`).
- `mark ready` / `ready for review` — marks the current branch's draft PR ready for review via the `mark-ready` bridge subcommand. This is a Bitbucket write; see "Mark Ready Verb" below for the confirmation gate and the `markReadyEnabled` setting that gate it.
- `resolve <ordinals>` — `resolve 1`, `resolve 1, 3`, `resolve 2-4`, `resolve all`. Resolves comment threads from the current snapshot (same ordinal grammar as `address`/`post`). This is a Bitbucket write; see "Resolve Ordinals Verb" below for the confirmation gate that guards it.

Ambiguous gestures (`address that one`, `address the rest`) should be confirmed with the user, not guessed. When the user references an ordinal that isn't in the current snapshot, ask whether they meant to refresh the snapshot first.

Ordinal expressions allow ranges (`1-3`), comma-separated lists (`1, 4, 7`), and combinations (`1, 3-5, 9`). Whitespace inside the expression is forgiven. Out-of-range ordinals are reported back to the user with the valid range, not silently dropped.

## Repo Slug Resolution

Repo slug comes from `git remote get-url origin` (strip `.git`, take last path segment). If parsing fails, ask the user.

The workspace is not part of the slug — it lives on the Atlassian Suite as `bitbucketWorkspace` and the client appends it automatically.

## Snapshot Lifecycle

A snapshot is the list of comments returned by the most recent `list-comments` bridge call, with its ordinals assigned. The snapshot persists for the rest of the session unless:

- The user types `address comments` again — refreshes the snapshot, reassigns ordinals from 1.
- The user types `address comments refresh` — explicit refresh without auto-running triage.
- The session ends — snapshots are not persisted across sessions in v1.

Within a snapshot, ordinals are stable. If the user resolves comments 1, 2, and 5 in a batch, ordinal 3 still refers to the same comment the next time they type `address 3`.

## Round-Trip Flow

1. **PR resolution.** Resolve the open PR for the current branch via `find-pr --repo <slug> --branch <name>`. Repo slug comes from `git remote get-url origin` (strip `.git`, take the last path segment). The bridge returns `values[0]` from Bitbucket's response — the first PR in whatever order Bitbucket returns (no explicit sort is requested). In practice this is the most recently created open PR for the branch, but no sort order is enforced. No matches -> ask the user.
2. **Fetch.** Call `list-comments --repo <slug> --pr <id>`. The bridge filters out deleted comments, any comment missing a numeric `id`, and any comment with an empty body before returning. Include resolved + unresolved in the snapshot (mark them visually).
3. **Number + present.** Assign globally stable ordinals across the session. Group by file/thread. Print in chat:
   ```
   [1] inline - src/Foo.cs:42 - @coderabbit - unresolved
       "<comment body, truncated to ~120 chars>"
   [2] general - @reviewer-name - unresolved
       "..."
   ```
4. **Triage.** For each picked ordinal, TPM offers a default action and asks the user to confirm or override:
   - **Code fix** (default for actionable comments)
   - **Manual reply** (user provides the text)
   - **Dismiss** (no action; flagged in audit)
5. **Dispatch SWEs.** For code-fix ordinals, deploy SWEs in parallel respecting `SWE_AGENT_COUNT`. Each assignment carries the comment's body verbatim, `file:line`, the PR id, and the dependency that this is a PR-comment fix (so the SWE knows to keep the change scoped to the comment).
6. **Generate replies.** After SWEs return, write each reply using `parameters.replyInstruction`. 1-2 sentences. Never include severity/rating/SWE attribution.

   **CodeRabbit persona overlay.** If the parent comment's author display name contains "coderabbit" (case-insensitive), prepend the `parameters.coderabbitReplyPersona` instruction onto the `parameters.replyInstruction` before generating the reply. The persona shapes voice/tone; the instruction shapes content. If `parameters.coderabbitReplyPersona` is empty, treat CodeRabbit replies the same as any other (no overlay).
7. **Approve + post.** Show all generated replies in one block. User confirms with `ok / revise N: <change> / cancel`. On `ok`, post each via the `reply` subcommand, piping the reply body via stdin (per the heredoc pattern in Capabilities), passing the comment's own `.id` as `--parent` (not its `.parentId` field — that is the comment's parent, which is `null` for top-level threads) and the parent comment's `inline` block (if any) as `--inline-path`/`--inline-to`/`--inline-from` so the reply lands on the correct thread.
8. **Flag falsely-resolved comments.** If `parameters.flagFalselyResolved` is enabled, scan each unresolved comment (and the text of its latest reply, if any) for phrases that claim resolution — e.g., "resolved", "fixed", "done", "addressed", "handled", "taken care of". For each match, list the comment with its `file:line` location and a short excerpt of the claim phrase. Do not call `resolve` automatically; the user reviews the list and resolves manually. If `parameters.flagFalselyResolved` is disabled, skip this scan entirely.

## Failure Handling

Every bridge subcommand's result surfaces two things: the wrapper's process exit code (zero on success, non-zero on failure) and, on failure, a JSON body on stdout carrying a `status` field plus a `message`. The taxonomy below documents `status` values as they map onto the wrapper's output — treat "the client returns" and "the wrapper reports" as the same thing; the wrapper is a thin pass-through onto the same host-side response shape.

- Exit code 2 -> the bridge server itself is unavailable (not a Ghola session, or the extension host isn't running the loopback server). This is not a Bitbucket error and there is no `status` field to inspect. Surface it to the user in one sentence — "the Bitbucket bridge isn't available in this session" — and stop; do not retry, do not fall back to another auth path.
- Per-comment post failure -> tell the user, leave audit untouched, continue the batch. No silent retries (could double-post on timeouts). User retries via `address <ordinal>` again.
- `status: 'network-error'` -> the bridge could not reach Bitbucket's API: either the 8-second AbortController timeout fired (message "Request timed out — try again") or a lower-level network error occurred (message "Network error — try again"). Surface the message to the user and suggest retrying. Do not retry automatically — on a timeout the request may have reached the server and a retry could double-post.
- `status: 'not-found'` with `message` starting "Missing repo" -> the bridge detected that `--repo` is empty or `--pr` / `--comment` / `--parent` is not a finite number before making any request. This is a call-site gap, not a Bitbucket error. Surface the message to the user so they can check repo-slug resolution and PR-id lookup.
- `status: 'unknown-error'` with `message` "Reply body is empty" -> the bridge detected an empty reply body (stdin) before making any request in `reply`. Surface the message and ask the user to provide reply text before retrying.
- `status: 'unauthorized'` with `message` starting "Missing:" -> the bridge detected that `email`, `bitbucketWorkspace`, or `bitbucketToken` is unset before making any request. Cancel the batch and tell the user which fields are missing (the message names them) — this is a configuration gap, not a token-rejection; point the user at the Atlassian Suite settings to fill in the missing values.
- 401 / 403 from the API (`status: 'unauthorized'` with message "401 Unauthorized..." or `status: 'forbidden'`) -> cancel the batch, point the user at the Atlassian Suite's Set Token button. Do not echo the token, do not suggest the user paste it into chat.
- 404 on the PR id -> the PR may have been merged or closed since the snapshot was taken. Refresh the snapshot via a fresh `address comments` rather than retrying the stale id.
- 429 (rate limit) -> maps to `status: 'unknown-error'` with a `message` of the form `"<status-code> <statusText>"` (e.g. "429 Too Many Requests") or `"429 request failed"` when statusText is absent. Detect this by checking `status === 'unknown-error' && message.startsWith('429 ')` (note the trailing space — avoids false positives from other codes that might begin with the digits "429"). Stop the batch, tell the user what completed, and recommend they retry after a short pause. Do not implement automatic backoff in this module's flow; that belongs in the bridge.
- 5xx / other non-2xx -> all HTTP errors not explicitly handled (400, 409, 422, 500, 502, 503, etc.) map to `status: 'unknown-error'` with a sanitized `message` of the form `"<status-code> <statusText>"`. Surface `message` to the user so they can see the raw code; do not retry automatically. This applies to `mark-ready` too — a `400` from `mark-ready` (e.g. the PR is already ready) should be surfaced loudly rather than treated as success.
- Snapshot staleness: if a comment in the snapshot has been deleted/resolved upstream between fetch and post, the bridge returns `not-found` — surface this to the user and continue.

## Hard Rules

- **No auto-posting.** Every reply requires explicit `ok` confirmation. `address all` still gates on the generate + approve step.
- **No token echo.** Neither secret ever appears in chat, logs, or error messages: the Bitbucket token stays behind the AtlassianBridge on the host side, and the bridge server's own bearer token (`GHOLA_BRIDGE_TOKEN`) is read from the environment by the `bb-bridge.mjs` wrapper and never surfaced to or handled by the agent. Never echo either token, and never pass a token as a flag.
- **No git writes / no Jira writes.** Read-only git only (local git — `git commit`, `git push`, etc.). This module never touches Jira. This is a separate concern from `mark ready` below: marking a PR ready is a Bitbucket API write, not a local git write, and is allowed — but only behind the explicit confirmation gate and the `markReadyEnabled` setting.
- **`mark ready` requires explicit confirmation.** Same discipline as reply posting: show intent (repo, PR id, branch), require the user to type `ok`, never auto-run. Refuse the verb outright if `parameters.markReadyEnabled` is false.
- **`resolve <ordinals>` requires explicit confirmation.** Like reply and mark-ready, resolving a thread is a Bitbucket write: show intent (the selected threads), require the user to type `ok`, never auto-run. `resolve all` still gates on this confirmation. It never auto-resolves.
- **No new code in the work repo outside what SWEs are dispatched to do.** TPM does not author code in this flow; SWEs do.
- **Generated reply must not include severity, rating, attribution, or any Ghola-internal filter metadata.** It's a public Bitbucket comment.
- **Don't replace the user's words in manual replies.** When the user supplies reply text, post it verbatim (no generation step).
- **No batching across PRs.** A single `address` invocation operates on one PR at a time. If the user wants to address comments on a different PR, end the current batch and start a fresh one.
- **No reordering of the snapshot mid-batch.** Once ordinals are assigned, they remain stable until a fresh `address comments` refresh. Do not renumber after a partial post.

## Post Ordinals Verb

`post <ordinals>` is the outbound twin of `address <ordinals>`: where `address` reads inbound review comments, triages them, and posts replies, `post` reads SWE Review Mode findings, polishes them, and publishes the selected ones as inline Bitbucket PR comments via the AtlassianBridge. The findings source is the most recent `tool.lenses`-driven Review Mode dispatch held in session memory; this verb does not initiate a new review on its own.

### Grammar

The ordinal grammar mirrors `address` exactly, so a user fluent in one is fluent in both:

- `post 1` — post just finding #1.
- `post 1, 3` — post #1 and #3.
- `post 2-4` — post the range.
- `post all` — post every finding whose Rating meets `parameters.minRatingToPost`.
- `post all security` — post every finding in the security lens above the threshold.
- `post all logic` / `post all quality` — same, per lens.

`post all <lens>` is shorthand for selecting all findings whose lens token matches the named token (case-insensitive). Ranges (`1-3`), comma-separated lists (`1, 4, 7`), and combinations (`1, 3-5, 9`) all parse the same way as in `address`. Out-of-range ordinals are reported back with the valid range, not silently dropped.

### Source of Findings

TPM reads the most recent Review Mode dispatch from session memory. Each finding carries:

- `lens` — `security`, `logic`, or `quality` (per `tool.lenses`).
- `file:line` reference — present when the SWE produced one; absent for summary-level findings.
- `description` — the SWE's raw finding text.
- `Rating: N/5` — the SWE's severity field per `tool.lenses`; this is what `parameters.minRatingToPost` gates against.
- `suggested fix` — optional, when the SWE included one.

If no Review Mode has run this session, TPM responds: "No Review Mode findings in session memory. Run a review first (via tool.lenses) before posting." Do not invent findings, do not re-run the review automatically, do not paraphrase from prior chat context.

### Post Flow

For each selected finding:

1. **Filter by rating.** If the user said `post all` or `post all <lens>`, drop findings whose Rating is below `parameters.minRatingToPost`. Explicit ordinals (`post 1, 3`) bypass the filter — the user named the finding by ordinal, so trust them.
2. **Polish.** Apply `parameters.postPolishPrompt` to the raw finding to produce a PR-ready comment. The default prompt produces 1-2 sentence, file-line-anchored, no-hedging, no-double-dashes text.
3. **Approve.** When `parameters.requireUserApproval` is true, present the polished comments in one block and gate on the verb `ok / revise N: <change> / cancel`. The user can revise specific entries by ordinal before approving the batch (same pattern as the `address` approve step). When `parameters.requireUserApproval` is false, skip this step — TPM posts immediately after polishing.
4. **Place.** Per `parameters.postCommentLocation`:
   - `inline-when-possible` — place inline at the file:line cited in the finding when one is parseable; fall back to the PR overview otherwise.
   - `inline-only` — refuse to post if no file:line is parseable; surface the refusal per ordinal so the user knows which findings were skipped.
   - `overview-only` — always post to the PR overview, regardless of any file:line in the finding.
5. **Post.** Use the same `reply` bridge subcommand the `address` verb uses to post replies. Do not introduce new infrastructure — invoke `node "$GHOLA_ROOT/scripts/bb-bridge.mjs" reply` with the polished comment text piped via stdin and the resolved target placement. For inline placement, supply `--inline-path`/`--inline-to` parsed from the finding's `file:line`. For overview placement, omit the `--inline-*` flags so the comment lands as a general PR comment.
6. **Report.** After posting, TPM reports each posted comment id back to the user as audit trail, in the same shape as the `address` post-batch summary.

### Symmetry With The Address Verb

`address <ordinals>` is inbound (read inbound review comments, triage, reply); `post <ordinals>` is outbound (read SWE findings, polish, post). They share the ordinal grammar, the user-approval gate, and the same `bb-bridge.mjs` wrapper's `reply` subcommand as the write path. This module owns both halves of the PR-comment workflow — there is no separate "post" module.

### Dependency On tool.lenses

The Review Mode findings source is `tool.lenses`, which provides the security / logic / quality lens dispatch and the `Rating: N/5` schema. If `tool.lenses` is disabled or no review has run this session, `post <ordinals>` has nothing to post — TPM surfaces this per the message in the Source of Findings section above. Do not attempt to source findings from any other module or from free-form chat history.

### Module-Disabled Vs Feature-Disabled

- When `parameters.postOrdinalsEnabled` is false, refuse the verb in one sentence: "Post Ordinals is disabled in the Modules tab. Enable it to publish Review Mode findings." The `address <ordinals>` verb is unaffected — only the outbound half is gated.
- When `parameters.requireUserApproval` is false, no approval gate fires — TPM posts immediately after polishing. This is the scripted-bulk-workflow path; the safety gate exists for a reason and on is strongly recommended.

## Comment Logging

When `parameters.logCommentsEnabled` is true, PR comments seen during the `address <ordinals>` workflow are appended to a JSON log file at `parameters.logFilePath`. Each entry records: `ts` (ISO timestamp), PR id, comment id, author, body, lens (if applicable), the verb that triggered the fetch (`address` or `post`), and an `isReply: true|false` flag. The log is a passive side effect on top of the existing fetch; the address and post workflows behave identically whether logging is on or off.

**What gets logged is gated by `parameters.logIncludeReplies`.** This setting decides whether the agent's own POSTED replies are logged alongside the inbound comments it READ:

- **When on (default):** log inbound comments AND the replies the agent posts (the full round-trip, i.e. every entry regardless of its `isReply` flag). This is the current behavior and gives the fullest downstream training signal.
- **When off:** log ONLY inbound comments (`isReply: false`). Skip writing a log entry for any reply the agent itself posts via the `reply` subcommand; do not append the `isReply: true` entry. This keeps the log a pure record of what colleagues said, with the agent's own outbound replies excluded. The address/post workflow is otherwise unchanged; only the reply-side log write is suppressed.

Consult `parameters.logIncludeReplies` at the moment you would write a reply's log entry: if it is off, skip that write.

### Entry Shape

JSON lines (one JSON object per line) for easy streaming/grep. Sample:

```json
{"ts": "2026-05-25T14:32:11Z", "prId": "1234", "commentId": "9876", "author": "alice@example.com", "body": "Consider extracting...", "verb": "address", "isReply": false}
{"ts": "2026-05-25T14:32:42Z", "prId": "1234", "commentId": "9876", "replyTo": "9876", "author": "self", "body": "Done in commit abc123", "verb": "address", "isReply": true}
```

The second (`isReply: true`) line is written only when `parameters.logIncludeReplies` is on. When it is off, only the inbound (`isReply: false`) lines are recorded.

### Path Resolution

`parameters.logFilePath` resolves per the rule documented in the setting description: relative paths resolve to the extension's `globalStorageUri` (the same location `tool.feedback-log` uses); absolute paths are used verbatim. TPM never moves or renames the log file once written.

### Retention

On every write, TPM checks the existing log file and prunes entries older than `parameters.logRetentionDays` days. Set to 0 to disable pruning entirely (the log grows unbounded). Pruning is best-effort — failures (e.g., concurrent writes) surface as warnings but never block the new entry's write.

### What Logging Does NOT Do

- Does NOT send the log anywhere external.
- Does NOT include credentials, tokens, or secret-shaped values from comment bodies (the `tool.secrets-wrapper-pattern` filter applies if enabled).
- Does NOT modify the comment workflow's existing behavior — logging is a passive side effect on top of the fetch.
- Does NOT auto-load on session start (this module remains `proactive: false`).

### Module-Disabled Vs Feature-Disabled

- **`integration.bitbucket-pr-comments` disabled**: no logging (the workflow that triggers logging isn't running).
- **Module enabled, `logCommentsEnabled` off**: no logging. Address/post verbs still work normally.
- **Module enabled, `logCommentsEnabled` on, `logFilePath` unwritable**: TPM surfaces the write failure once and continues — does not block the address/post action.

### Sibling-Module Interaction

`tool.qa-pr-learning` is the canonical downstream consumer of this log. It reads (does not write) the log path and uses entries as training signal for QA review patterns. This module never reads the log back — it is a write-only producer from this module's perspective.

## Pipeline status

When `parameters.pipelineStatusEnabled` is true, TPM can fetch and report the latest pipeline/build state for a PR (or its source branch) so the user knows whether the branch is green before merging. This is a **read-only** capability: TPM fetches state and reports it; it never triggers, stops, or re-runs a pipeline.

- **Fetch.** TPM issues a GET against the Bitbucket pipelines REST endpoint for the current repo and the PR's source branch (the same source branch resolved during PR resolution). Read the most recent pipeline for that branch. This goes through the same credential and REST discipline the comment workflow uses: thread the call through the AtlassianBridge / `integration.atlassian-suite` access path so the Bitbucket token never crosses the agent boundary. Do NOT construct raw auth headers or prompt for a token in chat; the suite owns that surface end-to-end, exactly as it does for the comment calls.
- **Report.** Surface the pipeline state in plain terms (in-progress, passed, or failed; map Bitbucket's raw state/result to those three), plus a link to the pipeline in Bitbucket so the user can open the full run.
- **Read-only, always.** Never call any endpoint that triggers a new pipeline, stops a running one, or re-runs a failed one. If the user asks to run or re-run a build, refuse in one sentence and point them at Bitbucket directly; this module reports build state, it does not control builds.
- When `parameters.pipelineStatusEnabled` is false, TPM does not fetch pipeline status; if the user asks, note that Pipeline Status is disabled in the Modules tab and point them there. The comment and post workflows are unaffected either way.

## Mark Ready Verb

`mark ready` / `ready for review` marks the current branch's draft Bitbucket PR ready for review. Unlike `address` and `post`, this is not a comment-thread action — it flips the PR's draft state via the `mark-ready` bridge subcommand. It is a Bitbucket API write, so it carries the same confirmation discipline as posting a reply, plus its own feature gate.

1. **Gate check.** If `parameters.markReadyEnabled` is false, refuse the trigger in one sentence: "Mark Ready is disabled in the Modules tab. Enable it to mark PRs ready for review." Do not proceed to PR resolution.
2. **PR resolution.** Resolve the open PR for the current branch via `find-pr --repo <slug> --branch <name>` (same resolution as the `address`/`post` flows). No matches -> ask the user.
3. **Show intent.** Before doing anything, state plainly what is about to happen: the repo slug, the PR id, and the branch. This is a one-way state change on Bitbucket (draft -> ready) — the user must see exactly what will be affected before confirming.
4. **Confirm.** Require the user to type `ok` (or explicitly cancel). No auto-run, even under `mark ready` invoked with no further discussion — always show intent and wait for confirmation first, mirroring the reply-posting gate. There is no `requireUserApproval`-style bypass for this verb; the gate is not configurable off.
5. **Execute.** On `ok`, invoke `node "$GHOLA_ROOT/scripts/bb-bridge.mjs" mark-ready --repo <slug> --pr <id>`.
6. **Report.** On success, tell the user the PR is now ready for review (include the PR id/link if the bridge's JSON result carries one). On `not-found` (PR id stale — it may have merged/closed since resolution), `unauthorized` (credentials gap or token rejection, per the Failure Handling taxonomy), or a `400`-class `unknown-error` (e.g. the PR was already ready), surface the exact status/message loudly rather than treating anything other than a clean success as done.

### Module-Disabled Vs Feature-Disabled

- **`integration.bitbucket-pr-comments` disabled**: `mark ready` is unavailable (the whole module is off).
- **Module enabled, `markReadyEnabled` off (default)**: `mark ready` refuses per the gate-check message above. `address`/`post` verbs are unaffected.
- **Module enabled, `markReadyEnabled` on**: `mark ready` works, still gated per-invocation on the explicit `ok` confirmation in step 4.

## Resolve Ordinals Verb

`resolve <ordinals>` flips the resolved state of comment THREADS via the `resolve` bridge subcommand. It is distinct from replying: resolving does not post any text, and the user can resolve a thread with or without having replied to it first. Where `address` reads and triages and `reply`/`post` write text, `resolve` only changes a thread's resolved-state on Bitbucket. It is a Bitbucket API write, so it carries the same confirmation discipline as posting a reply.

### Grammar

The ordinal grammar mirrors `address` and `post` exactly: `resolve 1`, `resolve 1, 3`, `resolve 2-4`, `resolve all`. Ranges (`1-3`), comma-separated lists (`1, 4, 7`), and combinations (`1, 3-5, 9`) all parse the same way. Whitespace inside the expression is forgiven. Out-of-range ordinals are reported back with the valid range, not silently dropped.

### Source Snapshot

`resolve <ordinals>` operates on the CURRENT snapshot — the list of comments returned by the most recent `address comments` fetch, with its assigned ordinals. Ordinals reference that snapshot only. If no snapshot exists this session, tell the user to run `address comments` first; do not resolve comments that are not in the snapshot.

### Resolve Flow

1. **Select.** Parse the ordinals against the current snapshot. Report any out-of-range ordinal with the valid range.
2. **Show intent.** List the selected threads by ordinal with their `file:line` (or `general`), author, and current resolved-state before doing anything. This is a Bitbucket state change (unresolved -> resolved) — the user must see exactly which threads will be affected before confirming.
3. **Confirm.** Require the user to type `ok` (or explicitly cancel). No auto-run — `resolve all` still gates on this confirmation, mirroring the reply-posting and mark-ready gates. There is no bypass for this verb.
4. **Execute.** On `ok`, invoke `node "$GHOLA_ROOT/scripts/bb-bridge.mjs" resolve --repo <slug> --pr <id> --comment <id>` once per selected comment id, using the same repo-slug and PR-id resolution the `address`/`post`/`mark ready` verbs use.
5. **Report.** After the batch, report each resolved thread id back to the user as an audit trail, in the same shape as the `address`/`post` post-batch summary.

Per-comment failure handling mirrors the taxonomy in "Failure Handling" above — surface each failure loudly, continue the batch, no silent retries. A `not-found` (404) on a comment id means the snapshot is stale (the thread was deleted/resolved upstream since the fetch) -> refresh via a fresh `address comments` rather than retrying the stale id.

This verb never AUTO-resolves, consistent with the "Flag falsely-resolved comments" rule in the Round-Trip Flow: that scan flags claim-phrases but does not resolve anything on its own. `resolve <ordinals>` is the explicit, user-directed way to resolve a thread.

## Role-Specific Notes

### TPM

- You are the dispatcher. You read this module's content when the user invokes the trigger grammar above, or proactively offer it when you notice an open PR with unresolved comments at session start (but do not auto-fetch — ask first).
- You hold the global ordinal numbering for the session. Ordinals are stable until a fresh `address comments` call refreshes the snapshot. If the user references an ordinal after a refresh, confirm which snapshot they mean.
- Maintain a per-session audit of which comments have been addressed and how (code-fix, manual reply, dismiss). Surface the audit when the user asks for a status check, and include it in the closing summary of any batch.
- For the `post <ordinals>` verb: parse the ordinals, source findings from the most recent Review Mode dispatch in session memory, polish each per `parameters.postPolishPrompt`, gate per `parameters.requireUserApproval`, place per `parameters.postCommentLocation`, and post via the `bb-bridge.mjs` wrapper's `reply` subcommand. Report posted comment ids back to the user as audit trail. If `parameters.postOrdinalsEnabled` is false, refuse per the module-disabled message above.
- For the `mark ready` verb: gate on `parameters.markReadyEnabled`, resolve the PR, show intent, require explicit `ok`, then invoke the wrapper's `mark-ready` subcommand. Report success or surface the failure loudly per the Mark Ready Verb section above.
- For the `resolve <ordinals>` verb: parse the ordinals against the current snapshot, show intent (selected threads by ordinal with `file:line`/author + resolved-state), require explicit `ok`, then invoke the wrapper's `resolve` subcommand once per selected comment id. Report each resolved thread id back as audit trail per the Resolve Ordinals Verb section above.
- Settings (read from the module's parameters block in the Session Manifest):
  - `parameters.replyInstruction` — feed into the reply-generation step. If absent from the Session Manifest, the default applies: `"Write a 1-2 sentence professional PR reply confirming what was fixed and where. No double-dashes."`
  - `parameters.coderabbitReplyPersona` — optional voice/tone overlay layered onto `parameters.replyInstruction` when the parent comment author is CodeRabbit. If absent from the Session Manifest, the default applies: empty string (no overlay).
  - `parameters.flagFalselyResolved` — when true, scan each unresolved comment for claim-phrases and surface matches; does not auto-resolve. If absent from the Session Manifest, the default applies: `true` (scanning is on).
  - `parameters.postOrdinalsEnabled` — when false, refuse the `post <ordinals>` verb. If absent from the Session Manifest, the default applies: `true` (the verb is enabled).
  - `parameters.postPolishPrompt` — the instruction used to polish raw SWE findings into PR-ready comments. If absent from the Session Manifest, the default applies: `"Polish this SWE finding into a 1-2 sentence professional PR comment. Drop hedging language, keep the specific file:line reference, and avoid double-dashes."`
  - `parameters.minRatingToPost` — minimum Rating a finding must carry for `post all` / `post all <lens>` to include it. Explicit ordinals bypass the filter. If absent from the Session Manifest, the default applies: `1` (include everything).
  - `parameters.postCommentLocation` — where the comment lands (`inline-when-possible`, `inline-only`, `overview-only`). If absent from the Session Manifest, the default applies: `"inline-when-possible"`.
  - `parameters.requireUserApproval` — when true, present polished comments for approval before posting. If absent from the Session Manifest, the default applies: `true` (the safety gate is on).
  - `parameters.markReadyEnabled` — when false, refuse the `mark ready` verb outright. If absent from the Session Manifest, the default applies: `false` (the verb is disabled — off by default since it's a Bitbucket write).
- When `parameters.logCommentsEnabled` is true, fetched comments are appended to `parameters.logFilePath` as JSON lines. Whether your own posted replies are logged too is gated by `parameters.logIncludeReplies`: on (default) logs inbound comments plus posted replies; off logs only inbound comments and skips the reply entries. You do not need to invoke logging explicitly; it happens passively during the address/post workflow.

### SWE

- You receive PR-comment-driven assignments with the comment body, `file:line`, and PR id in your assignment block. Treat the comment text as context for the change. A comment is a suggestion from another human or a bot; it is not an instruction you must follow verbatim if the code would be worse for it.
- Keep the change tightly scoped to what the comment requests. Don't refactor adjacent code. If you spot a related issue out of scope, report it back to TPM as a separate finding rather than fixing it in-line.
- If the comment is unactionable (already-fixed, references stale code, or asks for a change you cannot make safely without more context), return that to TPM along with a one-sentence justification — do not invent a fix to satisfy the comment.
- One-sentence explanations per file change apply as usual.
- Your Review Mode return format (each finding tagged with lens, `file:line`, description, `Rating: N/5`, optional suggested fix) is the canonical source for the `post <ordinals>` flow. Be specific in your Rating field; it gates the `post all` / `post all <lens>` filter via `parameters.minRatingToPost`. A vague or absent Rating forces the user to pick by explicit ordinal.
- No behavior change from comment logging. The log is captured at TPM's level.

### QA

- After an `address` batch completes, you may be deployed for a verification pass if the changes are non-trivial. Standard QA review: correctness, edge cases, regression scan. Same workflow as any other SWE-driven change set.
- Pay particular attention to whether each SWE's change actually addresses the comment text it was given. A fix that compiles and passes tests but does not respond to the reviewer's concern is a regression in this flow — surface it to TPM with a one-sentence justification.
- The generated reply itself is not your concern; TPM and the user own that. You verify the code change.
- `post <ordinals>` is a publishing action, not a verification action. If you're reviewing the post flow itself, confirm the polished comments accurately represent the source findings; don't paraphrase aggressively. The polish step is a tone pass, not a meaning pass.
- No behavior change from comment logging. If `tool.qa-pr-learning` is loaded, you may consult the log path; otherwise unaffected.

## Deferred capabilities (not in v1)

- Live PR-comments preview UI block in the settings panel
- CodeRabbit-suggested-patch extraction (pre-staging their suggested diffs into SWE assignments)
- Snapshot persistence across sessions (waits on an Obsidian-equivalent notes layer)
- Multi-select keyword UI for priority authors
- Author-trust scoring / per-author min-action thresholds
