# PR Monitor

When this module is loaded, the session can fetch open review comments on the current branch's Bitbucket pull request, triage them with the user, dispatch SWEs to apply code fixes, and — only when we are pushing back on a comment — post a reply to Bitbucket. The stated objective is **0 unresolved comments for the PR**, and the whole round-trip drives toward it. The usual flow is: for each comment, first decide whether we AGREE with it — fixing is not the default reflex. When we agree, fix the code and push; CodeRabbit (or Bitbucket) re-reviews the pushed commit and adds a ✅ checkmark confirming the fix, but it does NOT resolve the thread — the thread stays unresolved until WE resolve the ✅-checkmarked thread ourselves, which is the PRIMARY path to zero. We still do NOT post a "done / fixed this" acknowledgement reply (reply-silence on accepted findings stays). When we DISAGREE, we do not change the code — we draft a counter-comment (a protest reply) explaining why the requested change is not a good idea and present it to the operator for approval before posting. The one time we post a reply in response to a comment is to PROTEST — when we are not going to make the requested change and want to explain the reasoning. TPM never authors the code or any public reply text on its own — SWEs produce the fixes and the reply-composition step produces the protest reply, all under explicit user approval.

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

Seven subcommands are available:

- `find-pr --repo <slug> --branch <name>` — resolves the open PR id for the current branch.
- `list-comments --repo <slug> --pr <id>` — fetches all PR comments (resolved + unresolved, inline + general); this is the `address comments` snapshot source. Each comment carries: `id`, `parentId` (`null` for top-level thread starters), `kind` (`'inline'`/`'general'`), `author` (`{ displayName, accountId }`), `body`, `inline?` (`{ path, to, from? }`), `resolved`, `createdAt`, `updatedAt`.
- `reply --repo <slug> --pr <id> --parent <commentId> [--inline-path <p> --inline-to <n> --inline-from <n>]` — posts a reply threaded under an existing comment. The reply body is NOT a flag — it is piped via STDIN (see the heredoc pattern below). Supply the `--inline-*` flags when replying to an inline comment so the reply lands on the same file/line thread; omit them for general comments.
- `resolve --repo <slug> --pr <id> --comment <id>` — marks a comment thread resolved.
- `mark-ready --repo <slug> --pr <id>` — marks a DRAFT PR ready for review. This is a Bitbucket write; see "Mark Ready Verb" below for the confirmation gate that guards it.
- `to-draft --repo <slug> --pr <id>` — flips a READY PR back to draft (the reverse of `mark-ready`). This is a Bitbucket write; see "To Draft Verb" below for the confirmation gate that guards it.
- `delete-comment --repo <slug> --pr <id> --comment <id>` — deletes a single PR comment. This is a DESTRUCTIVE, IRREVERSIBLE Bitbucket write; see "Delete Verb" below for the confirmation gate that guards it.

Repo slug comes from `git remote get-url origin` (strip `.git`, take the last path segment). PR id comes from `find-pr`.

### Required Bitbucket write permission

The WRITE verbs — `reply`, `resolve`, `mark-ready`, `to-draft`, `delete-comment`, and `create pr` (owned by `integration.atlassian-suite`) — mutate Bitbucket and require the Bitbucket token to carry the `write:pullrequest:bitbucket` scope. The READ verbs — `find-pr`, `list-comments`, and pipeline status — need only the `read:*:bitbucket` scopes (`read:pullrequest:bitbucket`, `read:repository:bitbucket`, `read:workspace:bitbucket`). Scopes are chosen when the Atlassian API token is created and are a property of the token itself — not something this module or the Modules tab can turn on. Bitbucket App Passwords are deprecated (permanently removed 2026-07-28); the only supported credential is an Atlassian API token with scopes, and `integration.atlassian-suite` owns that setup end-to-end. See the 401/403 note in Failure Handling for what to do when a write verb is refused.

> PR *creation* is owned by `integration.atlassian-suite` (the `create pr` verb, which uses the same bridge via `bb-bridge.mjs create-pr`). This module handles the post-creation lifecycle only — read/reply/resolve comments and flip a PR between draft and ready.

### Posting a reply (stdin body)

Reply bodies are multi-line, so they are piped into the wrapper via a heredoc rather than passed as a flag:

```bash
node "$GHOLA_ROOT/scripts/bb-bridge.mjs" reply --repo my-repo --pr 42 --parent 9876 <<'EOF'
Leaving this as-is: validateInput() already guards this path upstream, so the extra check would be dead code.
EOF
```

(Replies exist for pushing back, not for acknowledging fixes — see the Round-Trip Flow. The body above declines a finding rather than confirming a change.)

For an inline reply, add the `--inline-*` flags before the heredoc:

```bash
node "$GHOLA_ROOT/scripts/bb-bridge.mjs" reply --repo my-repo --pr 42 --parent 9876 \
  --inline-path src/Foo.ts --inline-to 88 <<'EOF'
Leaving this as-is: validateInput() already guards this path upstream, so the extra check would be dead code.
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
- `to draft` / `back to draft` — flips the current branch's ready PR back to draft via the `to-draft` bridge subcommand (the reverse of `mark ready`). This is a Bitbucket write; see "To Draft Verb" below for the confirmation gate and the `toDraftEnabled` setting that gate it.
- `resolve <ordinals>` — `resolve 1`, `resolve 1, 3`, `resolve 2-4`, `resolve all`. Resolves comment threads from the current snapshot (same ordinal grammar as `address`/`post`). A natural-language / text-filter phrasing also maps here (e.g. "resolve comments that say 'this has been resolved'"), selecting the snapshot subset whose text matches. This is a Bitbucket write; see "Resolve Ordinals Verb" below for the confirmation gate — and the CodeRabbit resolve-eligibility gate — that guard it.
- `delete <ordinals>` — `delete 1`, `delete 1, 3`, `delete 2-4`. Deletes the named comment(s) from the current snapshot (same ordinal grammar as `resolve`); `delete <id>` also accepts a raw comment id. `delete resolved` bulk-deletes every resolved comment on the PR. This is a DESTRUCTIVE, IRREVERSIBLE Bitbucket write; see "Delete Verb" below for the confirmation gate and the `deleteCommentEnabled` setting that gate it.

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

1. **PR resolution.** Resolve the open PR for the current branch via `find-pr --repo <slug> --branch <name>`. Repo slug comes from `git remote get-url origin` (strip `.git`, take the last path segment). The bridge returns `values[0]` from Bitbucket's response — the first PR in whatever order Bitbucket returns (no explicit sort is requested). In practice this is the most recently created open PR for the branch, but no sort order is enforced. On success the bridge returns `status: 'ok'` with `prId` / `prUrl` / `prTitle` (exit 0); when no open PR exists it returns `status: 'not-found'` with a "No open PR for branch ..." message (non-zero exit). No matches -> ask the user.
2. **Fetch.** Call `list-comments --repo <slug> --pr <id>`. The bridge filters out deleted comments, any comment missing a numeric `id`, and any comment with an empty body before returning. Include resolved + unresolved in the snapshot (mark them visually).
3. **Number + present.** Assign globally stable ordinals across the session. Group by file/thread. Print in chat:
   ```
   [1] inline - src/Foo.cs:42 - @coderabbit - unresolved - CR-confirmed
       "<comment body, truncated to ~120 chars>"
   [2] general - @reviewer-name - unresolved
       "..."
   ```
   When `parameters.coderabbitResolveRequiresConfirmation` is true, append a `CR-confirmed` marker to any CodeRabbit-authored thread that carries CodeRabbit's own resolution confirmation (see "CodeRabbit resolution confirmation" under the Resolve Ordinals Verb) so the operator can see at a glance which CodeRabbit threads are resolve-eligible. CodeRabbit threads WITHOUT that confirmation are left unmarked. The marker is purely visual — it never changes the printed `resolved`/`unresolved` state, and it is not applied to human/other-author comments. When the parameter is false, omit the marker entirely (no CodeRabbit gate applies).
4. **Triage — evaluate agree/disagree FIRST.** For each picked ordinal, TPM does NOT treat "comment => fix" as automatic. It first evaluates whether we AGREE with the comment, then offers a default action and asks the user to confirm or override. The agree/disagree decision comes upstream of everything else and routes to one of:
   - **Agree -> code fix** (default for actionable comments we accept) — dispatch a SWE, fix, and push. This path posts NO reply. It does NOT resolve the thread at push time; instead we wait for CodeRabbit's ✅ checkmark confirming the fix and then WE resolve the ✅-checkmarked thread ourselves (see step 6). That manual resolve of a ✅'d thread is the expected, correct action — the primary path to 0 unresolved comments, not something to avoid.
   - **Disagree -> protest counter-comment** — when we are NOT making the requested change (the finding is wrong, out of scope, or intentionally declined). We do NOT change code. We draft a counter-comment explaining why the requested change is not a good idea, composed via `parameters.replyInstruction` / `parameters.coderabbitReplyPersona` (steps 7-8) or supplied verbatim by the user, and present it to the operator for approval BEFORE posting (respecting `parameters.requireUserApproval`). The operator sees the drafted counter-comment and gives a yes/no; post only on the operator's `ok` — never auto-post it, and never silently fix instead. This is the only case that posts a comment in response. After it is posted (or a decline is stated), the thread's resolve disposition follows the Declined-Thread Disposition section.
   - **Dismiss** (no action, no reply; flagged in audit)
5. **Dispatch SWEs.** For code-fix ordinals, deploy SWEs in parallel respecting `SWE_AGENT_COUNT`. Each assignment carries the comment's body verbatim, `file:line`, the PR id, and the dependency that this is a PR-comment fix (so the SWE knows to keep the change scoped to the comment).
6. **Fix, push, stay silent on replies, then resolve on the ✅ (the agree path).** For every ordinal triaged as an agreed code fix, once the SWE's fix is pushed do NOT post an acknowledgement reply: CodeRabbit's re-review adds a ✅ checkmark confirming the fix, so a "done / fixed this" reply is redundant, and skipping it preserves headroom under Bitbucket's hard 200-comment-per-PR cap. But pushing the fix does NOT resolve the thread on its own — CodeRabbit adds the ✅ checkmark and leaves the thread UNRESOLVED. Reaching 0 unresolved comments therefore requires that WE resolve the ✅-checkmarked thread ourselves via the `resolve` verb (per the CodeRabbit resolve-eligibility gate). So the full agree path is: fix -> push -> stay silent on replies -> wait for CodeRabbit's ✅ -> resolve the ✅'d thread. The threads we resolve this way are exactly what the `delete resolved` verb can later clear out. (If a thread is claimed resolved in text WITHOUT the ✅ confirmation, `parameters.flagFalselyResolved` still surfaces it and the resolve gate holds it out for per-comment confirmation — see step 9 and the Resolve Ordinals Verb.)
7. **Compose protest replies (exception path only).** This step and step 8 fire ONLY for ordinals triaged as a protest — comments we are declining rather than fixing. Write each protest reply using `parameters.replyInstruction`. 1-2 sentences. Never include severity/rating/SWE attribution. If the user supplied the reply text verbatim, skip composition and post their words unchanged.

   **CodeRabbit persona overlay.** If the parent comment's author display name contains "coderabbit" (case-insensitive), prepend the `parameters.coderabbitReplyPersona` instruction onto the `parameters.replyInstruction` before composing the protest reply. The persona shapes voice/tone; the instruction shapes content. If `parameters.coderabbitReplyPersona` is empty, treat CodeRabbit replies the same as any other (no overlay). When the overlay IS applied, apply it at the level set by this module's own `parameters.coderabbitReplyPersonaIntensity` (1–10). The level controls HOW MUCH the reply acts in-character (the persona's character and mannerisms), NOT how extreme any single trait is — and at EVERY level the reply must still fully convey the actual message it needs to communicate. At 1 the reply is mostly plain with only a light touch of the persona; at 5 (default) it is clearly in-character but balanced; at 10 it is fully in-character. If unset, use the moderate default (5). This level is self-contained to this module and does NOT depend on `tool.operator-profile`. It affects VOICE only — it never relaxes the no-severity/no-rating/no-attribution rule or the `ok`-before-post approval gate, and it never lets persona flavor drop or distort the substance of the reply.
8. **Approve + post (protest replies only).** Show all composed protest replies in one block. User confirms with `ok / revise N: <change> / cancel`. On `ok`, post each via the `reply` subcommand, piping the reply body via stdin (per the heredoc pattern in Capabilities), passing the comment's own `.id` as `--parent` (not its `.parentId` field — that is the comment's parent, which is `null` for top-level threads) and the parent comment's `inline` block (if any) as `--inline-path`/`--inline-to`/`--inline-from` so the reply lands on the correct thread.
9. **Flag falsely-resolved comments.** If `parameters.flagFalselyResolved` is enabled, scan each unresolved comment (and the text of its latest reply, if any) for phrases that claim resolution — e.g., "resolved", "fixed", "done", "addressed", "handled", "taken care of". For each match, list the comment with its `file:line` location and a short excerpt of the claim phrase. Do not call `resolve` automatically; the user reviews the list and resolves manually. If `parameters.flagFalselyResolved` is disabled, skip this scan entirely. This scan is consistent with the CodeRabbit resolve-eligibility gate on the `resolve <ordinals>` verb (see the Resolve Ordinals Verb): both surface comments for the user rather than auto-resolving them. A claim phrase alone never makes a CodeRabbit thread resolve-eligible — only CodeRabbit's own green-check confirmation does; a comment claiming "fixed" without that confirmation is exactly what the resolve gate holds out for per-comment confirmation.

## Declined-Thread Disposition

After we post a counter-comment on a thread we are pushing back on (step 8) — or state a decline without posting — the thread is still unresolved, and whether we then resolve it depends on WHO authored the comment:

- **CodeRabbit (a bot)** — when `parameters.resolveDeclinedBotThreads` is true (default), resolve the declined thread. A bot does not need the thread kept open to respond, so resolving it keeps the count moving toward zero.
- **Human reviewer** — when `parameters.resolveDeclinedHumanThreads` is false (default), LEAVE the thread unresolved. Resolving a thread you just pushed back on reads as dismissive to a person; leave it open for the reviewer to respond. Set the parameter true to resolve declined human threads like bot threads.

Detect CodeRabbit authorship with the same convention the persona overlay and the resolve-eligibility gate use: the comment's author display name contains "coderabbit" (case-insensitive). Any author whose display name does not match is treated as a human reviewer for this rule.

This disposition is DISTINCT from the CodeRabbit resolve-eligibility gate: that gate governs threads we FIXED (resolve only on the ✅ fix-confirmation), whereas here we are resolving a bot thread we deliberately DECLINED — there is no fix and no ✅ to wait for, so the ✅ gate does not apply. Resolving a declined thread still goes through the `resolve` verb's confirmation discipline; it is not an auto-resolve that bypasses the operator's `ok`.

## Drive-to-Zero Closeout

The stated objective of the whole address round-trip is **0 unresolved comments for the PR**. When `parameters.driveToZeroCloseout` is true, TPM runs a closeout accounting pass at the end of a round-trip — and on demand whenever the operator asks for a status check — that enumerates every unresolved comment, buckets each by disposition, and reports the concrete gap to zero so nothing is silently left behind. The pass never resolves or posts anything on its own; it reports the tally and routes each bucket through the existing gates.

Buckets, per unresolved comment:

- **CodeRabbit ✅-checkmarked (fix verified)** — carries CodeRabbit's own green-check (✅) resolution confirmation. Resolve-eligible -> route to the `resolve` verb (which still gates on the operator's `ok`). These are the threads driving the count toward zero.
- **Fix pushed, no ✅ yet** — we pushed a fix but CodeRabbit has not yet added its ✅ checkmark. Awaiting re-review; leave it unresolved and note it. Not a blocker, just not done yet.
- **Not yet addressed** — the real blocker toward zero. Route through the agree/disagree triage gate (step 4): agree -> fix / push / wait-for-✅ / resolve; disagree -> draft a counter-comment for operator approval.
- **Counter-comment posted / declined** — a thread we pushed back on. Disposition per the Declined-Thread Disposition section above (resolve bot threads, leave human threads; both tunable).
- **Outdated (PENDING — Phase 2, not yet implemented)** — Bitbucket can mark a comment outdated when its anchored code has changed; such a thread would be resolve-eligible. This bucket is documented as a FUTURE disposition ONLY: the outdated flag is NOT fetched today and no outdated detection exists in this module, so do not implement or act on it. It is listed here so the accounting model is complete, not as active logic.

The pass reports a concrete tally so the operator sees the exact gap to zero, e.g.:

```
12 unresolved -> 5 resolve-eligible (✅-confirmed; confirm to clear), 3 awaiting ✅ re-review, 4 need your decision: [ordinals + file:line]
```

Nothing is silently left behind: every unresolved comment lands in exactly one bucket, and the buckets that block zero (not-yet-addressed, needs-your-decision) are named explicitly with their ordinals. When `parameters.driveToZeroCloseout` is false, TPM does not run this pass automatically, though the operator can still ask for a status check.

## Failure Handling

Every bridge subcommand's result surfaces two things: the wrapper's process exit code (zero on success, non-zero on failure) and, on failure, a JSON body on stdout carrying a `status` field plus a `message`. The taxonomy below documents `status` values as they map onto the wrapper's output — treat "the client returns" and "the wrapper reports" as the same thing; the wrapper is a thin pass-through onto the same host-side response shape.

The client now appends Bitbucket's own `error.message` to the failure `message` whenever the API returns one, so a failed `delete-comment`/`reply`/`resolve`/`create pr` surfaces the ACTUAL reason rather than a bare status code. In practice this means a **403** now names the permission-scope cause (the token is missing `write:pullrequest:bitbucket`), and a **400** on a `create pr`/`reply`/`delete` at the comment ceiling now carries Bitbucket's real cap text ("By default, you can't create more than 200 comments per pull request."). Relay the surfaced message to the user verbatim instead of a generic "failed" — the real reason is now in the `message`.

- Exit code 2 -> the bridge server itself is unavailable (not a Ghola session, or the extension host isn't running the loopback server). This is not a Bitbucket error and there is no `status` field to inspect. Surface it to the user in one sentence — "the Bitbucket bridge isn't available in this session" — and stop; do not retry, do not fall back to another auth path.
- Per-comment post failure -> tell the user, leave audit untouched, continue the batch. No silent retries (could double-post on timeouts). User retries via `address <ordinal>` again.
- `status: 'network-error'` -> the bridge could not reach Bitbucket's API: either the 8-second AbortController timeout fired (message "Request timed out — try again") or a lower-level network error occurred (message "Network error — try again"). Surface the message to the user and suggest retrying. Do not retry automatically — on a timeout the request may have reached the server and a retry could double-post.
- `status: 'not-found'` with `message` starting "Missing repo" -> the bridge detected that `--repo` is empty or `--pr` / `--comment` / `--parent` is not a finite number before making any request. This is a call-site gap, not a Bitbucket error. Surface the message to the user so they can check repo-slug resolution and PR-id lookup.
- `status: 'unknown-error'` with `message` "Reply body is empty" -> the bridge detected an empty reply body (stdin) before making any request in `reply`. Surface the message and ask the user to provide reply text before retrying.
- `status: 'unauthorized'` with `message` starting "Missing:" -> the bridge detected that `email`, `bitbucketWorkspace`, or `bitbucketToken` is unset before making any request. Cancel the batch and tell the user which fields are missing (the message names them) — this is a configuration gap, not a token-rejection; point the user at the Atlassian Suite settings to fill in the missing values.
- 401 / 403 from the API (`status: 'unauthorized'` with message "401 Unauthorized..." or `status: 'forbidden'`) -> cancel the batch. A **401** means the token is invalid or expired: re-set it via the Atlassian Suite's **Set Bitbucket API Token**. A **403** on a WRITE verb (`reply`, `resolve`, `mark-ready`, `to-draft`, `delete-comment`, `create pr`) almost always means the token is valid but lacks the `write:pullrequest:bitbucket` scope (the surfaced `message` now names this permission cause directly) -> per `integration.atlassian-suite`, create a new Atlassian API token with scopes (https://id.atlassian.com/manage-profile/security/api-tokens -> Create API token with scopes -> Bitbucket, with `write:pullrequest:bitbucket` selected) and re-save it via the suite's **Set Bitbucket API Token**. Scopes can't be edited after a token is created, so make a fresh token — you can't add the scope to the existing one. Alternatively perform the one-off action in the Bitbucket web UI, which uses the browser session rather than the token. There is NO Modules-tab toggle that grants this scope — the scope is a property of the token, chosen on Bitbucket's side when the token is issued, so do not tell the user to "enable write access in the Modules tab" or invent a permission setting. Do not echo the token, do not suggest the user paste it into chat.
- 404 on the PR id -> the PR may have been merged or closed since the snapshot was taken. Refresh the snapshot via a fresh `address comments` rather than retrying the stale id.
- 429 (rate limit) -> maps to `status: 'unknown-error'` with a `message` of the form `"<status-code> <statusText>"` (e.g. "429 Too Many Requests") or `"429 request failed"` when statusText is absent. Detect this by checking `status === 'unknown-error' && message.startsWith('429 ')` (note the trailing space — avoids false positives from other codes that might begin with the digits "429"). Stop the batch, tell the user what completed, and recommend they retry after a short pause. Do not implement automatic backoff in this module's flow; that belongs in the bridge.
- 5xx / other non-2xx -> all HTTP errors not explicitly handled (400, 409, 422, 500, 502, 503, etc.) map to `status: 'unknown-error'` with a `message` of the form `"<status-code> <statusText>"`, now with Bitbucket's own `error.message` appended when the API supplies one. Surface `message` to the user so they can see the raw code AND the real reason; do not retry automatically. This applies to `mark-ready` too — a `400` from `mark-ready` (e.g. the PR is already ready) should be surfaced loudly rather than treated as success. It also covers the 200-comment cap: a `reply`/`create pr` (or, if it hit the ceiling mid-flow, a comment-creating path) that trips Bitbucket's per-PR limit now surfaces the real "By default, you can't create more than 200 comments per pull request." text — relay it so the user knows to free room via `delete resolved` rather than seeing a bare `400`.
- Snapshot staleness: if a comment in the snapshot has been deleted/resolved upstream between fetch and post, the bridge returns `not-found` — surface this to the user and continue.

## Hard Rules

- **Reply only to protest, never to acknowledge — but do resolve the ✅'d thread.** When we accept a finding, the response is code: fix it and push, then stay silent on replies — do NOT post a "done / fixed this" reply. Do NOT, however, assume the thread resolves itself: CodeRabbit's re-review adds a ✅ checkmark confirming the fix yet leaves the thread UNRESOLVED, so WE resolve the ✅-checkmarked thread ourselves (that manual resolve is the primary path to 0 unresolved comments, not something to avoid). A reply in response to a comment is warranted ONLY when we are declining the change and want to explain why (the protest counter-comment, drafted for operator approval before posting). Redundant acknowledgement replies also burn Bitbucket's hard 200-comment-per-PR budget.
- **No auto-posting.** Every reply requires explicit `ok` confirmation. `address all` still gates on the compose + approve step for any protest replies.
- **No token echo.** Neither secret ever appears in chat, logs, or error messages: the Bitbucket token stays behind the AtlassianBridge on the host side, and the bridge server's own bearer token (`GHOLA_BRIDGE_TOKEN`) is read from the environment by the `bb-bridge.mjs` wrapper and never surfaced to or handled by the agent. Never echo either token, and never pass a token as a flag.
- **No git writes / no Jira writes.** Read-only git only (local git — `git commit`, `git push`, etc.). This module never touches Jira. This is a separate concern from `mark ready` / `to draft` below: flipping a PR's draft state is a Bitbucket API write, not a local git write, and is allowed — but only behind the explicit confirmation gate and the respective `markReadyEnabled` / `toDraftEnabled` setting.
- **`mark ready` requires explicit confirmation.** Same discipline as reply posting: show intent (repo, PR id, branch), require the user to type `ok`, never auto-run. Refuse the verb outright if `parameters.markReadyEnabled` is false.
- **`to draft` requires explicit confirmation.** Same discipline as `mark ready`: show intent (repo, PR id, branch), require the user to type `ok`, never auto-run. Refuse the verb outright if `parameters.toDraftEnabled` is false.
- **`resolve <ordinals>` requires explicit confirmation.** Like reply and mark-ready, resolving a thread is a Bitbucket write: show intent (the selected threads), require the user to type `ok`, never auto-run. `resolve all` still gates on this confirmation. It never auto-resolves.
- **`delete` requires explicit confirmation and is IRREVERSIBLE.** Deletion is DESTRUCTIVE and cannot be undone on Bitbucket — there is no restore. Show intent (the exact comment(s) to be deleted, by ordinal/id + short text), require the user to type `ok`, never auto-run. This holds for both `delete <ordinals>`/`delete <id>` and the bulk `delete resolved`. Refuse the verb outright if `parameters.deleteCommentEnabled` is false. Deleting requires the `write:pullrequest:bitbucket` scope.
- **No new code in the work repo outside what SWEs are dispatched to do.** TPM does not author code in this flow; SWEs do.
- **Generated reply must not include severity, rating, attribution, or any Ghola-internal filter metadata.** It's a public Bitbucket comment.
- **Don't replace the user's words in manual replies.** When the user supplies reply text, post it verbatim (no generation step).
- **No batching across PRs.** A single `address` invocation operates on one PR at a time. If the user wants to address comments on a different PR, end the current batch and start a fresh one.
- **No reordering of the snapshot mid-batch.** Once ordinals are assigned, they remain stable until a fresh `address comments` refresh. Do not renumber after a partial post.

## Post Ordinals Verb

`post <ordinals>` is the outbound twin of `address <ordinals>`: where `address` reads inbound review comments, triages them, fixes the code, and posts a reply only to push back, `post` reads SWE Review Mode findings, polishes them, and publishes the selected ones as inline Bitbucket PR comments via the AtlassianBridge. The findings source is the most recent `tool.lenses`-driven Review Mode dispatch held in session memory; this verb does not initiate a new review on its own.

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

`address <ordinals>` is inbound (read inbound review comments, triage, fix, and reply only to protest); `post <ordinals>` is outbound (read SWE findings, polish, post). They share the ordinal grammar, the user-approval gate, and the same `bb-bridge.mjs` wrapper's `reply` subcommand as the write path. This module owns both halves of the PR-comment workflow — there is no separate "post" module.

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

## To Draft Verb

`to draft` / `back to draft` flips the current branch's ready-for-review Bitbucket PR back to draft — the exact reverse of `mark ready`. Like `mark ready`, it flips the PR's draft state via a bridge subcommand (`to-draft`), is a Bitbucket API write, and carries the same confirmation discipline plus its own feature gate.

1. **Gate check.** If `parameters.toDraftEnabled` is false, refuse the trigger in one sentence: "To Draft is disabled in the Modules tab. Enable it to flip PRs back to draft." Do not proceed to PR resolution.
2. **PR resolution.** Resolve the open PR for the current branch via `find-pr --repo <slug> --branch <name>` (same resolution as the `mark ready`/`address`/`post` flows). No matches -> ask the user.
3. **Show intent.** Before doing anything, state plainly what is about to happen: the repo slug, the PR id, and the branch. This is a state change on Bitbucket (ready -> draft) — the user must see exactly what will be affected before confirming.
4. **Confirm.** Require the user to type `ok` (or explicitly cancel). No auto-run, even under `to draft` invoked with no further discussion — always show intent and wait for confirmation first, mirroring the `mark ready` gate. There is no `requireUserApproval`-style bypass for this verb; the gate is not configurable off.
5. **Execute.** On `ok`, invoke `node "$GHOLA_ROOT/scripts/bb-bridge.mjs" to-draft --repo <slug> --pr <id>`.
6. **Report.** On success, tell the user the PR is now a draft (include the PR id/link if the bridge's JSON result carries one). On `not-found` (PR id stale — it may have merged/closed since resolution), `unauthorized` (credentials gap or token rejection, per the Failure Handling taxonomy), or a `400`-class `unknown-error` (e.g. the PR was already a draft), surface the exact status/message loudly rather than treating anything other than a clean success as done.

### Module-Disabled Vs Feature-Disabled

- **`integration.bitbucket-pr-comments` disabled**: `to draft` is unavailable (the whole module is off).
- **Module enabled, `toDraftEnabled` off (default)**: `to draft` refuses per the gate-check message above. `address`/`post`/`mark ready` verbs are unaffected.
- **Module enabled, `toDraftEnabled` on**: `to draft` works, still gated per-invocation on the explicit `ok` confirmation in step 4.

## Resolve Ordinals Verb

`resolve <ordinals>` flips the resolved state of comment THREADS via the `resolve` bridge subcommand. It is distinct from replying: resolving does not post any text, and the user can resolve a thread with or without having replied to it first. Where `address` reads and triages and `reply`/`post` write text, `resolve` only changes a thread's resolved-state on Bitbucket. It is a Bitbucket API write, so it carries the same confirmation discipline as posting a reply.

### Grammar

The ordinal grammar mirrors `address` and `post` exactly: `resolve 1`, `resolve 1, 3`, `resolve 2-4`, `resolve all`. Ranges (`1-3`), comma-separated lists (`1, 4, 7`), and combinations (`1, 3-5, 9`) all parse the same way. Whitespace inside the expression is forgiven. Out-of-range ordinals are reported back with the valid range, not silently dropped.

**Natural-language / text-filter selection.** The operator may also target the resolve verb with a natural-language text filter rather than ordinals — e.g. "resolve any comments that say 'this has been resolved'" or "resolve the comments mentioning the null check". This is neither `resolve all` nor an explicit ordinal list; it selects the subset of the current snapshot whose bodies (or latest replies) match the operator's described text. Resolve the filter against the snapshot to produce a matched set, then run that set through the same flow below — the CodeRabbit resolve-eligibility gate applies to it exactly as it does to `resolve all` and explicit ordinals (see the gate subsection). Crucially, a comment matching a text filter like "this has been resolved" is a textual CLAIM, not a trusted confirmation: if that comment is CodeRabbit-authored it is still un-confirmed unless it also carries CodeRabbit's own green-check (✅) resolution confirmation. The very words the filter matched are the untrusted claim phrase, not the signal that earns auto-resolve.

### Source Snapshot

`resolve <ordinals>` operates on the CURRENT snapshot — the list of comments returned by the most recent `address comments` fetch, with its assigned ordinals. Ordinals reference that snapshot only. If no snapshot exists this session, tell the user to run `address comments` first; do not resolve comments that are not in the snapshot.

### CodeRabbit resolve-eligibility gate

The ✅ checkmark is the PRIMARY engine for reaching 0 unresolved comments, not merely a safety brake. After we push a fix, CodeRabbit's re-review adds its ✅ confirmation but leaves the thread unresolved, and resolving those ✅'d threads ourselves is how the count reaches zero. Concretely: **✅ present -> resolve-eligible, resolve it; fix pushed but no ✅ yet -> wait for the re-review, do not resolve; text claims "resolved" without the ✅ -> held out, ask the operator** (never auto-resolved on a textual claim). The gate below encodes exactly that.

When `parameters.coderabbitResolveRequiresConfirmation` is true, a CodeRabbit-authored comment is only auto-included (pre-selected as safe) in a `resolve` selection when it carries a **CodeRabbit resolution confirmation**; without one it is not pre-selected but is instead called out for per-comment confirmation. This gate runs over EVERY resolve-selection entry point: any path that produces a set of threads to resolve — `resolve all`, explicit ordinals (`resolve 1, 3`), and a natural-language / text-filter request ("resolve comments that say 'this has been resolved'") — runs the CodeRabbit gate over that matched set before anything is resolved. The gate applies to CodeRabbit-authored comments ONLY — human/other-author comments keep their current behavior and are never affected by this rule. Detect CodeRabbit authorship with the same convention the persona overlay uses in the Round-Trip Flow: the comment's author display name contains "coderabbit" (case-insensitive).

A **CodeRabbit resolution confirmation** is a described heuristic, not a brittle exact-string match: a CodeRabbit comment — or CodeRabbit's own follow-up/reply text on that thread — that carries CodeRabbit's green-check confirmation, i.e. a green-check (U+2705, the ✅ emoji) together with resolution language such as "resolved", "addressed", "verified", or "done". Treat the green-check plus resolution-language pairing as the signal; do not require an exact marker string. NOTE: we have not yet inspected a live CodeRabbit payload, so the precise CodeRabbit marker text should be verified against a real CodeRabbit comment in a later phase — do not treat this heuristic as a confirmed exact format.

**A textual resolution claim is NOT the trusted signal.** Only CodeRabbit's own ✅ confirmation earns auto-inclusion. A plain textual claim of resolution — even the exact words "this has been resolved", and even when those words are precisely what a text filter matched on — does NOT make a CodeRabbit comment resolve-eligible. So the crisp distinction the operator wants encoded is: **auto-include (pre-selected, safe) = a CodeRabbit comment WITH the ✅ confirmation; called-out-and-needs-confirm = a CodeRabbit comment WITHOUT the ✅ confirmation, including one whose body merely claims resolution in text.** This is the resolve-time counterpart of the `flagFalselyResolved` scan (Round-Trip step 9), which already distrusts textual "resolved/fixed/done" claims; this gate applies that same distrust at resolve time.

**Annotate, do not refuse.** When the operator explicitly asks to resolve a filtered or named set, the gate never silently drops their picks — the operator keeps final authority. Within the matched set, Ghola shows all matches, annotates each CodeRabbit match as ✅-confirmed (resolve-eligible) vs. un-confirmed, explicitly calls out the un-confirmed CodeRabbit ones (wording along the lines of "these claim resolution in text but lack CodeRabbit's ✅ confirmation — resolve anyway?"), and still gates on the operator's `ok`. The gate changes only what is PRE-selected and how the un-confirmed matches are framed — never whether the operator can override and resolve them anyway.

When `parameters.coderabbitResolveRequiresConfirmation` is false, this gate does not apply at all: `resolve` / `resolve all` / text-filter resolves behave exactly as they did before (no CodeRabbit filtering — every selected, swept, or matched thread is pre-selected regardless of author or confirmation). This gate never changes the user-types-`ok` confirmation below; it only narrows WHAT gets pre-selected before that confirmation.

### Resolve Flow

1. **Select.** Resolve the request into a matched set against the current snapshot — parse ordinals for `resolve <ordinals>`, take the whole snapshot for `resolve all`, or match the operator's described text for a natural-language / text-filter request. Report any out-of-range ordinal with the valid range. When `parameters.coderabbitResolveRequiresConfirmation` is true, run the CodeRabbit resolve-eligibility gate over that matched set regardless of which entry point produced it: partition CodeRabbit-authored threads into ✅-confirmed (carry a CodeRabbit resolution confirmation) and un-confirmed (do not). ✅-confirmed CodeRabbit threads and all human/other-author threads are pre-selected; un-confirmed CodeRabbit threads are NOT pre-selected but are also NOT dropped — they move to a "needs your confirmation" grouping in Show intent. For a text-filter request, remember that matching the filter text is a textual claim, not the ✅ signal, so a CodeRabbit comment matching "this has been resolved" still lands in the un-confirmed grouping.
2. **Show intent.** List the pre-selected threads by ordinal with their `file:line` (or `general`), author, and current resolved-state before doing anything. This is a Bitbucket state change (unresolved -> resolved) — the user must see exactly which threads will be affected before confirming. When the gate moved any CodeRabbit threads into the "needs your confirmation" grouping, present them separately: for each, show its ordinal, `file:line`/author, an annotation that it claims resolution in text but lacks CodeRabbit's ✅ confirmation, and a note on whether the pushed code appears to address the finding — then explicitly ask "resolve anyway?". The operator keeps final authority: they can confirm any of these to fold them into the batch. Only threads the operator confirms there join the resolve batch; unconfirmed ones stay unresolved. The whole batch (pre-selected plus any operator-confirmed carve-ins) still gates on the single `ok` in the Confirm step below.
3. **Confirm.** Require the user to type `ok` (or explicitly cancel). No auto-run — `resolve all` still gates on this confirmation, mirroring the reply-posting and mark-ready gates. There is no bypass for this verb.
4. **Execute.** On `ok`, invoke `node "$GHOLA_ROOT/scripts/bb-bridge.mjs" resolve --repo <slug> --pr <id> --comment <id>` once per selected comment id, using the same repo-slug and PR-id resolution the `address`/`post`/`mark ready` verbs use.
5. **Report.** After the batch, report each resolved thread id back to the user as an audit trail, in the same shape as the `address`/`post` post-batch summary.

Per-comment failure handling mirrors the taxonomy in "Failure Handling" above — surface each failure loudly, continue the batch, no silent retries. A `not-found` (404) on a comment id means the snapshot is stale (the thread was deleted/resolved upstream since the fetch) -> refresh via a fresh `address comments` rather than retrying the stale id.

This verb never AUTO-resolves, consistent with the "Flag falsely-resolved comments" rule in the Round-Trip Flow: that scan flags claim-phrases but does not resolve anything on its own. `resolve <ordinals>` is the explicit, user-directed way to resolve a thread.

## Delete Verb

`delete` removes PR comments outright via the `delete-comment` bridge subcommand. Unlike `resolve`, which only flips a thread's resolved-state, `delete` permanently removes the comment — it is a DESTRUCTIVE, IRREVERSIBLE Bitbucket write with no undo. The primary use case is Bitbucket's **200-comment-per-PR cap**: once a PR hits that ceiling, new comments cannot be posted (the create call 400s with "By default, you can't create more than 200 comments per pull request."), so deleting resolved comments frees room for new ones. It carries the same confirmation discipline as `resolve`/`mark-ready`, plus its own feature gate, plus stronger destructive-action language because there is no going back.

### Grammar

Two forms:

- **Per-comment** — `delete <ordinals>` (`delete 1`, `delete 1, 3`, `delete 2-4`) deletes the specific comment(s) named. Ordinals map to the CURRENT snapshot exactly as in `resolve <ordinals>`. `delete <id>` also accepts a raw Bitbucket comment id for a comment not in the snapshot. Ranges (`1-3`), comma-separated lists (`1, 4, 7`), and combinations (`1, 3-5, 9`) parse the same way; whitespace is forgiven; out-of-range ordinals are reported back with the valid range, not silently dropped.
- **Bulk delete-resolved** — `delete resolved` deletes every resolved comment on the PR. There is no ordinal argument; the set is computed from a fresh `list-comments` fetch (see the flow below).

### Gate check

If `parameters.deleteCommentEnabled` is false, refuse the trigger in one sentence: "Delete is disabled in the Modules tab. Enable it to delete PR comments." Do not proceed, do not improvise a resolve-instead workaround, and do not attempt any other deletion path. Deleting also requires the Bitbucket token to carry the `write:pullrequest:bitbucket` scope; a Read-only token 403s on `delete-comment`, and per the enriched Failure Handling the surfaced `message` now names that permission cause.

### Per-comment delete flow

1. **Select.** Parse the ordinals against the current snapshot (or take the raw id for `delete <id>`). Report any out-of-range ordinal with the valid range.
2. **Show intent.** List each selected comment by ordinal/id with its `file:line` (or `general`), author, resolved-state, and a short excerpt of the body before doing anything. State plainly that these comments will be permanently deleted and CANNOT be restored.
3. **Confirm.** Require the user to type `ok` (or explicitly cancel). No auto-run — deletion is irreversible, so the gate is not configurable off and there is no bulk bypass.
4. **Execute.** On `ok`, invoke `node "$GHOLA_ROOT/scripts/bb-bridge.mjs" delete-comment --repo <slug> --pr <id> --comment <id>` once per selected comment id, using the same repo-slug and PR-id resolution the other verbs use.
5. **Report.** After the batch, report each deleted comment id back to the user as an audit trail, in the same shape as the `resolve` post-batch summary.

### Bulk delete-resolved flow

1. **Fetch.** Run `list-comments --repo <slug> --pr <id>` to get the current comment set, then filter to comments where `resolved === true`. This snapshot is bounded (~200 comments), which lines up with the per-PR cap the flow exists to relieve.
2. **Show intent.** Present the exact list to be deleted — each resolved comment's `id` plus a short excerpt of its body. When the list is large, summarize the count (e.g. "38 resolved comments will be deleted") and offer a `list-all` option so the user can see every entry before deciding. State plainly that this permanently deletes each listed comment and CANNOT be undone.
3. **Confirm.** Require the user to type `ok` (or explicitly cancel). No auto-run — the destructive-action gate applies to the bulk path exactly as to the per-comment path.
4. **Execute.** On `ok`, delete each comment via `node "$GHOLA_ROOT/scripts/bb-bridge.mjs" delete-comment --repo <slug> --pr <id> --comment <id>`, one call per id.
5. **Report.** After the batch, report the deleted ids (or the deleted count) back as an audit trail; surface any per-id failure loudly and continue.

### Operational caveats

- **Tombstoned replies.** Deleting a resolved thread's ROOT comment tombstones its replies on Bitbucket's side. So a later `delete-comment` for a child id that was already removed as part of its parent may come back `not-found` — tolerate that, treat it as already-gone, and continue the batch rather than aborting.
- **Bounded list.** The `list-comments` snapshot is bounded (~200), which aligns with the 200-comment cap this flow relieves; if a PR is at the ceiling the fetched set is effectively the whole comment population.
- **Per-comment failure handling** mirrors the taxonomy in "Failure Handling" above — surface each failure loudly (relaying Bitbucket's now-included `error.message`, e.g. a 403 naming the missing write scope), continue the batch, no silent retries.

### Module-Disabled Vs Feature-Disabled

- **`integration.bitbucket-pr-comments` disabled**: `delete` is unavailable (the whole module is off).
- **Module enabled, `deleteCommentEnabled` off (default)**: `delete` refuses per the gate-check message above. `address`/`post`/`resolve`/`mark ready`/`to draft` verbs are unaffected.
- **Module enabled, `deleteCommentEnabled` on**: `delete` works, still gated per-invocation on the explicit `ok` confirmation, for both the per-comment and bulk `delete resolved` paths.

## Role-Specific Notes

### TPM

- You are the dispatcher. You read this module's content when the user invokes the trigger grammar above, or proactively offer it when you notice an open PR with unresolved comments at session start (but do not auto-fetch — ask first).
- You hold the global ordinal numbering for the session. Ordinals are stable until a fresh `address comments` call refreshes the snapshot. If the user references an ordinal after a refresh, confirm which snapshot they mean.
- Maintain a per-session audit of which comments have been addressed and how (code-fix, manual reply, dismiss). Surface the audit when the user asks for a status check, and include it in the closing summary of any batch.
- For the `post <ordinals>` verb: parse the ordinals, source findings from the most recent Review Mode dispatch in session memory, polish each per `parameters.postPolishPrompt`, gate per `parameters.requireUserApproval`, place per `parameters.postCommentLocation`, and post via the `bb-bridge.mjs` wrapper's `reply` subcommand. Report posted comment ids back to the user as audit trail. If `parameters.postOrdinalsEnabled` is false, refuse per the module-disabled message above.
- For the `mark ready` verb: gate on `parameters.markReadyEnabled`, resolve the PR, show intent, require explicit `ok`, then invoke the wrapper's `mark-ready` subcommand. Report success or surface the failure loudly per the Mark Ready Verb section above.
- For the `to draft` verb: gate on `parameters.toDraftEnabled`, resolve the PR, show intent, require explicit `ok`, then invoke the wrapper's `to-draft` subcommand. Report success or surface the failure loudly per the To Draft Verb section above.
- For the `resolve <ordinals>` verb (and its `resolve all` and natural-language / text-filter variants — e.g. "resolve comments that say 'this has been resolved'"): resolve the request into a matched set against the current snapshot, apply the CodeRabbit resolve-eligibility gate over that set when `parameters.coderabbitResolveRequiresConfirmation` is true (pre-select only ✅-confirmed CodeRabbit threads plus human/other-author threads; move un-confirmed CodeRabbit threads — including ones whose text merely claims resolution — into a "needs your confirmation" grouping, annotated and called out with "resolve anyway?" rather than dropped), show intent, require explicit `ok`, then invoke the wrapper's `resolve` subcommand once per selected comment id. The operator keeps final authority — the gate changes what is pre-selected and how un-confirmed matches are framed, not whether they can override. Report each resolved thread id back as audit trail per the Resolve Ordinals Verb section above.
- For the `delete` verb: gate on `parameters.deleteCommentEnabled`. For `delete <ordinals>`/`delete <id>`, select against the current snapshot; for `delete resolved`, run `list-comments` and filter to `resolved === true`. Show intent (the exact comment(s) with id + short text) and state plainly that deletion is permanent and cannot be undone, require explicit `ok`, then invoke the wrapper's `delete-comment` subcommand once per id. Tolerate a `not-found` on an already-tombstoned child id and continue. Report the deleted ids back as audit trail per the Delete Verb section above.
- Settings (read from the module's parameters block in the Session Manifest):
  - `parameters.replyInstruction` — feeds the protest-reply composition step (step 7), which drafts the disagree-path counter-comment presented to the operator for approval before posting. Protest replies are the only replies we post: accepted findings are fixed, pushed, left silent on replies, and then resolved by us once CodeRabbit adds its ✅ checkmark confirming the fix. If absent from the Session Manifest, the default applies: `"Write a 1-2 sentence professional PR reply explaining why we are declining the requested change (the finding is incorrect, out of scope, or intentionally not being made). No double-dashes."`
  - `parameters.coderabbitReplyPersona` — optional voice/tone overlay layered onto `parameters.replyInstruction` when the parent comment author is CodeRabbit (and therefore applied only to protest replies). If absent from the Session Manifest, the default applies: empty string (no overlay).
  - `parameters.coderabbitReplyPersonaIntensity` — how much the reply acts in-character (the persona's character/mannerisms) while STILL fully conveying the message, 1–10. Not a measure of any single trait; the substance is always delivered at every level. If absent from the Session Manifest, the default applies: `5` (moderate). Self-contained to this module — no dependency on `tool.operator-profile`. Only matters when `coderabbitReplyPersona` is set; affects reply VOICE only — never the no-severity/no-rating/no-attribution rule or the approval gate.
  - `parameters.flagFalselyResolved` — when true, scan each unresolved comment for claim-phrases and surface matches; does not auto-resolve. If absent from the Session Manifest, the default applies: `true` (scanning is on).
  - `parameters.coderabbitResolveRequiresConfirmation` — when true, a CodeRabbit-authored comment is only auto-included in a `resolve` / `resolve all` selection if it carries a CodeRabbit resolution confirmation (green-check + resolution language); otherwise it is held out and the operator is asked to confirm per-comment before resolving (see the CodeRabbit resolve-eligibility gate under the Resolve Ordinals Verb). Applies to CodeRabbit-authored comments only; human/other-author comments are unaffected. When false, no CodeRabbit gate applies and `resolve` behaves as it did before. If absent from the Session Manifest, the default applies: `true` (the gate is on).
  - `parameters.driveToZeroCloseout` — when true, run the drive-to-zero closeout accounting pass at the end of a round-trip (and on demand): enumerate every unresolved comment, bucket each by disposition (✅-confirmed resolve-eligible, fix-pushed-awaiting-✅, not-yet-addressed, counter-comment-posted/declined, and outdated-as-PENDING), and report the concrete gap to 0 unresolved comments. Never resolves or posts on its own; routes each bucket through the existing gates. If absent from the Session Manifest, the default applies: `true` (the pass runs).
  - `parameters.resolveDeclinedBotThreads` — when true, after we post a counter-comment on (or decline) a CodeRabbit (bot) thread, resolve that thread — a bot does not need it kept open. CodeRabbit authorship is the display-name-contains-"coderabbit" convention. If absent from the Session Manifest, the default applies: `true` (resolve declined bot threads).
  - `parameters.resolveDeclinedHumanThreads` — when true, after we post a counter-comment on (or decline) a human reviewer's thread, resolve that thread; when false, leave it unresolved for the person to respond (resolving a thread you just pushed back on reads as dismissive). If absent from the Session Manifest, the default applies: `false` (leave declined human threads for the reviewer).
  - `parameters.postOrdinalsEnabled` — when false, refuse the `post <ordinals>` verb. If absent from the Session Manifest, the default applies: `true` (the verb is enabled).
  - `parameters.postPolishPrompt` — the instruction used to polish raw SWE findings into PR-ready comments. If absent from the Session Manifest, the default applies: `"Polish this SWE finding into a 1-2 sentence professional PR comment. Drop hedging language, keep the specific file:line reference, and avoid double-dashes."`
  - `parameters.minRatingToPost` — minimum Rating a finding must carry for `post all` / `post all <lens>` to include it. Explicit ordinals bypass the filter. If absent from the Session Manifest, the default applies: `1` (include everything).
  - `parameters.postCommentLocation` — where the comment lands (`inline-when-possible`, `inline-only`, `overview-only`). If absent from the Session Manifest, the default applies: `"inline-when-possible"`.
  - `parameters.requireUserApproval` — when true, present polished comments for approval before posting. If absent from the Session Manifest, the default applies: `true` (the safety gate is on).
  - `parameters.markReadyEnabled` — when false, refuse the `mark ready` verb outright. If absent from the Session Manifest, the default applies: `false` (the verb is disabled — off by default since it's a Bitbucket write).
  - `parameters.toDraftEnabled` — when false, refuse the `to draft` verb outright. If absent from the Session Manifest, the default applies: `false` (the verb is disabled — off by default since it's a Bitbucket write).
  - `parameters.deleteCommentEnabled` — when false, refuse the `delete` verb (both `delete <ordinals>`/`delete <id>` and `delete resolved`) outright. If absent from the Session Manifest, the default applies: `false` (the verb is disabled — off by default since deletion is a DESTRUCTIVE, IRREVERSIBLE Bitbucket write).
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
