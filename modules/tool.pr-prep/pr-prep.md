# PR Prep

When this module is loaded, the session has a multi-stage PR-handoff toolkit: a structured **pre-PR quality gate** (the checklist), a structured **PR-description generator**, and a **reviewer configuration**. They run in sequence as the user hands a task off to a PR. The checklist runs first, catching the kinds of issues automated PR reviewers (CodeRabbit, Copilot review, etc.) commonly flag; the description runs next, drafting a PR body the user edits directly before submission; reviewers are confirmed last before the PR is created. Every agent reads this same fragment; TPM owns all stages, SWE and QA feed findings into both the checklist and description, and role-specific framing is collected at the end.

This module is **not proactive**. It does not fire at session start. It fires when the user signals they are ready to PR (per `parameters.checklistAutoOffer` for the checklist and `parameters.descriptionAutoOffer` for the description) or when the user explicitly asks for either stage. Treat it as a handoff ritual, not a continuous check.

## PR-handoff sequence

The stages of this module bracket the PR handoff, and a separate module may run between the first two:

1. **Pre-PR Checklist** (this module, first) — the quality gate. TPM sweeps the working tree against the configured checks and reports findings before the PR is created.
2. **`tool.regression-scan`** (a **separate** module, between checklist and description, when enabled) — runs after the checklist and before the description. It is not part of this module; when it is enabled it slots into the sequence here, and when it is not enabled the description simply follows the checklist directly.
3. **PR Description** (this module) — the artifact. TPM drafts the PR body once the checklist (and the regression scan, when enabled) has completed cleanly. The user edits the draft directly before submission.
4. **Reviewers** (this module, last) — TPM presents the reviewer list (defaults plus per-PR additions), the user confirms, and TPM proceeds with PR creation.

The checklist auto-offer and the description auto-offer chain through this sequence: the checklist offers first, and the description offers after the checklist (and regression scan, when enabled) completes with no blocking flags. Reviewer confirmation follows the description.

---

## Pre-PR Checklist

The checklist is a configurable sweep TPM runs immediately before the user creates a PR, catching the kinds of issues automated PR reviewers commonly flag — unintended file changes, leaked secrets, commented-out code, missing null checks, unused imports, and the like. It fires when the user signals they are ready to PR (per `parameters.checklistAutoOffer`) or when the user explicitly asks for the sweep.

### What the checklist does

The checklist runs the entries in `parameters.checks` that have `enabled: true`, in the order they appear in the parameter. Each entry has a name (the row key) and a description (the row value) telling TPM what to look for. TPM evaluates each check against the current working-tree state (read-only inspection of `git diff`, `git status`, and session memory) and reports findings to the user before the PR is created.

The presentation depends on `parameters.runMode` — interactive (one check at a time) or batched (one consolidated summary). Both modes evaluate the same checks against the same inputs; only the reporting cadence differs.

### When to run the checklist

Run the checklist when:

- The user signals PR-handoff with phrases like "ready for PR", "let's wrap up", "create a PR", "ship this", or similar — and `parameters.checklistAutoOffer` is true. In that case TPM proactively offers: "Want me to run the pre-PR checklist before you create the PR?" Do not run it without the user's go-ahead; the offer is the gate.
- The user explicitly asks ("run the pre-PR checklist", "let's check this before PR", "do the sweep").

Do **not** run the checklist:

- On every code change, every commit, or every session end. The checklist is specifically the PR-handoff gate. Running it more often is noise.
- Without a PR-handoff signal or an explicit request, even if the working tree looks ready. TPM does not unilaterally decide a task is PR-ready.
- When the module is not loaded. Without this module, ad-hoc inspections are still fine, but there is no structured gate — say so if the user expects one.

### How TPM runs the checklist

The mechanics depend on `parameters.runMode`:

#### Interactive mode

TPM walks each enabled check one at a time. For each check, output the same structured block:

```
Check N of M: <check name>
What to look for: <description from parameters.checks[<name>].value>
Findings: <what TPM observed in the diff or session memory>
Verdict: Pass / Note / Flag?
```

Wait for the user to confirm the verdict (or proceed with TPM's own verdict if TPM is confident and the user has indicated they want auto-pilot through obvious passes). Move to the next check. Do not batch checks in this mode — the point of interactive is per-check deliberation.

#### Batched mode

TPM runs every enabled check internally, then presents one consolidated summary structured like:

```
Pre-PR Checklist Results (N of M passed)

✓ Tests pass locally — confirmed by user
✓ No unintended file changes — git diff shows only the expected 4 files
⚠ No commented-out code left behind — found commented-out block in src/foo.ts:42
✗ Null checks in place where needed — missing check on user.email in src/auth.ts:88
...
```

Then ask: "Address the flagged items before creating the PR, or proceed anyway?" The user decides — TPM does not auto-fix.

### How each check is evaluated

TPM evaluates checks from three inputs, all read-only:

- `git diff --name-only`, `git diff`, and `git status` — the canonical view of what is about to ship.
- Session memory — the assignments, SWE returns, and QA verdicts already in the conversation. SWE's edge-case calls and QA's findings are first-class inputs, not afterthoughts.
- The check description in `parameters.checks[<name>].value` — this tells TPM what pattern the check is looking for.

TPM does **not** run tests itself. The "Tests pass locally" check asks the user; it does not invoke any test runner, build command, or CI hook. TPM does **not** modify files during the checklist — the entire sweep is a read-only inspection. Any fix the user wants TPM to make happens AFTER the checklist, as a separate SWE task.

### Adding, removing, or disabling checks

The user manages the list in the Modules tab. The default seed is project-agnostic — teams should tailor it to their reviewer and stack (CodeRabbit-specific patterns, project-specific naming rules, framework-specific checks like ASP.NET appsettings, etc.).

- **Add a check**: type a check name and a description in the Modules tab, click Add.
- **Remove a check**: delete the row from the Modules tab.
- **Disable a check without deleting it**: uncheck the per-row Enabled checkbox. Disabled checks persist in the manifest but TPM skips them at run time. Use this for checks that are situationally relevant — e.g., "Database migration reviewed" should be enabled for the sessions that touch migrations and disabled otherwise.

### Findings format

When reporting findings to the user, use exactly three severity markers — no others:

- `✓` (pass) — the check found no issues.
- `⚠` (note) — the check found something worth mentioning but not blocking. Examples: a TODO comment with a linked ticket id, a naming inconsistency in a generated file the user already knows about.
- `✗` (flag) — the check found a blocking issue. Examples: a missing null check on a nullable input, a leaked credential in an `appsettings.json` diff, a commented-out block of source.

The user decides whether to address flagged items now or proceed. TPM surfaces the finding and the location; TPM does **not** force a fix, and TPM does **not** silently downgrade a flag to a note to avoid friction. If the finding is genuinely a flag, mark it as a flag.

### Checklist: module-disabled vs feature-disabled

These are distinct states and must produce distinct behavior:

- **Module disabled** (no `tool.pr-prep` in the Session Manifest): TPM does NOT offer or run the pre-PR checklist. The user can still ask for ad-hoc inspections — TPM is still allowed to look at the diff — but there is no structured gate, no consolidated summary, and no auto-offer on PR signals. Do not pretend the checklist exists.
- **Module enabled, `parameters.checklistAutoOffer` off**: the checklist exists but TPM does not auto-offer on PR signals. The checklist runs only when the user explicitly asks for it.
- **Module enabled, every check disabled in the kv-table**: when the user invokes the checklist (auto-offer or explicit), respond: "no checks configured — pre-PR checklist is empty. Enable some in the Modules tab or run an ad-hoc inspection." Do not silently pass an empty sweep.

Do not merge these cases.

---

## PR Description

Once the checklist (and the regression scan, when `tool.regression-scan` is enabled) has completed cleanly, TPM drafts a plain-language PR description based on the session's work, free of double-dashes (and any other token in `parameters.bannedTokens`), and ticket-aware when `mode.ticket-work` is active. The draft is presented to the user as editable text; the user edits it directly and what they approve is what gets submitted. It fires when the user signals PR readiness (per `parameters.descriptionAutoOffer`) or when the user explicitly asks for a description.

### When to generate a description

Generate a description when:

- The pre-PR checklist (and the regression scan, when enabled) has just completed with no `✗` flags AND `parameters.descriptionAutoOffer` is true. In that case TPM chains directly into the offer: "Want me to draft a PR description?" Wait for the user's go-ahead; the offer is the gate.
- The user signals PR readiness without running the checklist ("create a PR", "ship this", "ready to PR") AND `parameters.descriptionAutoOffer` is true. Offer the same way.
- The user explicitly asks ("write a PR description", "give me a PR body", "draft the PR text"). Generate without preamble.

Do **not** generate a description:

- On every code change or session end. The description is specifically the PR-handoff gesture, not a continuous narration.
- Immediately after the checklist when the checklist returned `✗` flags. The user should address the flags first. They can still ask explicitly if they want a draft before addressing them.
- When the module is not loaded. Without this module, TPM does not draft PR bodies — the user writes their own.

### Generation contract

These rules apply to every draft.

- **Banned tokens.** No token from `parameters.bannedTokens` may appear in the final output. Parse the parameter as comma-separated, trim each entry, and scan every draft for each entry as a substring match. If a banned token slips in (TPM caught itself writing one), rewrite the sentence to avoid it — usually by replacing the dash with a comma or restructuring the clause. Em-dashes (`—`, U+2014) are FINE — banned tokens are about double-dashes (`--`) and double-dash-adjacent patterns, not em-dashes. Scan the **final** text (after user edits) before submission; if the user introduced a banned token in their edit, surface it and ask whether to rewrite or accept.
- **Plain language.** No jargon the user would not say in conversation. Drop adjectives that do not add information. Active voice over passive when possible. Reviewers should be able to read the description once and understand the change.
- **Ticket reference.** When `mode.ticket-work` is enabled AND `parameters.ticketId` is non-empty, prepend the ticket id to the description as a convention (e.g., `PROJ-123: ...`). When ticket-work is not active or the ticket id is empty, drop the ticket prefix gracefully.
- **What and why, not how.** Reflect what changed (the user-observable behavior) and why (the motivation or the bug it fixes). Do not enumerate implementation details, internal function names, or refactor mechanics. Reviewers see the diff for the how.
- **Template awareness.** When `parameters.descriptionTemplate` is non-empty, use it as the starting structure for the draft. Fill in the template sections with content derived from the session's work. When the template is empty, draft free-form based on the input sources below.

### Input sources TPM uses to write the description

TPM composes the draft from these inputs, all read-only:

- **Session memory** — SWE return messages (especially the one-sentence per-file explanations), QA verdicts, edge cases flagged during the work. This is the primary source for the "what" content.
- **`git diff --stat` and `git diff --name-only`** — context for the change-summary bullets (when `parameters.includeChangeSummary` is true) and a sanity check that the session memory matches what is actually staged.
- **`mode.ticket-work` ticket summary** — when active, the Jira summary provides "why" context for free, used as plain context for the description.
- **`tool.obsidian-notes` per-ticket or per-project notes** — when enabled, read the relevant notes file for "why" framing the user articulated earlier in the session (Implementation Notes, Ticket Summary). Use the read paths the notes module already exposes; do not invent a path.
- **The user's own framing in the current session** — if the user said "this fixes the auth race we found earlier", lift that framing verbatim or near-verbatim into the description. It is almost always the best "why" content.

If multiple inputs disagree, prefer the user's own framing > the ticket summary > the SWE returns > the diff. The diff tells you what changed; it does not tell you why.

### Presenting the draft

After generating a draft that satisfies the generation contract:

1. Show the draft to the user in a large editable block (in the settings panel's PR Prep textarea or in chat), formatted as it will appear in the PR. No extra prose around it.
2. Tell the user: "Edit the description above, then confirm to submit." The user edits the text directly — what they see is what gets submitted.
3. If the user asks to **regenerate** ("regenerate", "try again with a different angle"), ask for the angle ("more emphasis on impact", "less technical", etc.) and draft again. Do not loop indefinitely — if the user regenerates more than twice, ask whether the inputs are insufficient (maybe SWE returns were vague, maybe no ticket summary is available) so the issue can be addressed at the source.
4. Before submission, re-apply the banned-tokens scan to the final text (which may have been edited by the user). If a banned token is present, surface it and ask whether to rewrite or accept.

### Description: module-disabled vs feature-disabled

These are distinct states and must produce distinct behavior:

- **Module disabled** (no `tool.pr-prep` in the Session Manifest): TPM does NOT offer or generate PR descriptions. The user writes their own PR body. If the user appears to expect TPM to draft one ("can you write the PR description?"), surface that the module is not loaded — do not pretend the feature exists.
- **Module enabled, `parameters.descriptionAutoOffer` off**: TPM does not auto-offer on PR signals or after the checklist completes. The description is only generated when the user explicitly asks.

Do not merge these cases.

---

## Reviewers

When `parameters.defaultReviewers` has entries, those reviewers are automatically included on every PR. Each entry is a display name (key) plus a Bitbucket account ID (value). Default reviewers are pre-populated in the reviewer list when TPM assembles the PR creation request.

### Adding reviewers

Reviewers come from two sources:

- **Default reviewers** (`parameters.defaultReviewers`) — configured in the Modules tab, persisted across sessions. These are always included unless the user explicitly removes one for a specific PR.
- **Per-PR reviewer search** — the operator can search for additional reviewers via the bridge's `/workspace-members` route (served by the Bitbucket bridge, built by SWE-2). The search shows display names and avatar images from Bitbucket's workspace members API. Selected reviewers are added to the PR alongside the defaults.

### How reviewers are passed to the bridge

When TPM calls the `create-pr` bridge route, reviewers are passed as:

```json
"reviewers": [{ "account_id": "..." }, { "account_id": "..." }]
```

This array includes both default reviewers and any per-PR additions the user selected. TPM merges the two lists, deduplicating by account ID.

### Presenting reviewers before PR creation

Before submitting the PR, TPM presents the full reviewer list to the user for confirmation:

1. List all reviewers (defaults marked as such, per-PR additions listed separately).
2. The user confirms the list, removes entries, or searches for additional reviewers.
3. Only after the user confirms does TPM proceed with the `create-pr` call.

---

### Sibling-module interaction

The description composes cleanly with the checklist stage of this module and three sibling modules.

#### Pre-PR Checklist (this module, first stage)

The checklist and the description form the PR-handoff pair within this module: checklist first (the gate), description second (the artifact). When the checklist completes with no `✗` flags, TPM chains directly into the description offer per `parameters.descriptionAutoOffer`. When the checklist surfaced `✗` flags, TPM does NOT auto-offer the description — the user should address the flags first. The user can still ask explicitly ("draft the PR body anyway") and TPM generates, noting once: "The checklist still has open flags — confirm you want to proceed to the description?"

#### `tool.regression-scan`

When enabled, the regression scan is a **separate** module that runs between the checklist and the description in the PR-handoff sequence. TPM chains the description offer only after the regression scan (and the checklist) has completed cleanly. When it is not enabled, the description follows the checklist directly with no intervening stage.

#### `mode.ticket-work`

Provides the `ticketId` for prepending to the PR description. Provides the Ticket Summary as a strong candidate for the "why" content, used as plain context when composing the description. Without ticket-work active, the ticket prefix is dropped gracefully.

#### `tool.obsidian-notes`

The per-ticket or per-project notes file is a rich input source — TPM reads it (via the read paths the notes module already exposes) to find the "why" framing the user articulated earlier in the session. Implementation Notes and Ticket Summary are the highest-value sections. Do NOT write back to the notes file from this module — generation is read-only. The user's PR body lives in Bitbucket or GitHub, not in Obsidian.

---

## Role-Specific Notes

The body above applies identically to every agent. The notes below are short framings for how each role uses both stages of PR Prep.

### TPM

You own all three stages (checklist, description, reviewers). **For the checklist:** you decide when to offer it (per the signal rules in the checklist's When-to-Run section), you read the git diff, consult session memory, and evaluate each check. You present findings using the `✓ / ⚠ / ✗` format. You do **not** delegate check evaluation to SWE — the checklist is a TPM-level synthesis that combines SWE returns, QA verdicts, and your own read of the diff. If SWE has already noted a side effect or QA has already flagged an issue, use that as input; do not re-dispatch SWE to look at what SWE just looked at. **For the description:** you read session memory (SWE returns, QA verdicts, user framing), you run `git diff --stat` and `git diff --name-only` for change-summary context, and you read the per-ticket or per-project notes file when `tool.obsidian-notes` is enabled. You apply the generation contract — banned-tokens scan, plain-language pass — before presenting any draft, treating any Jira-derived text from `mode.ticket-work` as plain context for the description. You present the draft as editable text; the user edits it directly and confirms before submission. You do not delegate generation to SWE or QA — this is a TPM-level synthesis, and SWE / QA findings are inputs, not drafts. **For reviewers:** you present the reviewer list (defaults from `parameters.defaultReviewers` plus any per-PR additions) to the user and confirm before PR creation. You merge default and per-PR reviewers, deduplicating by account ID, and pass the final list to the `create-pr` bridge call.

### SWE

Your findings feed both stages. When you complete a code task, include in your standard return any edge cases you considered, side effects you anticipated, dead code observations, places where you added a TODO, and anything else TPM might surface in the checklist sweep. Your one-sentence per-file explanations are also the primary raw material for the description's "what" sentence — be specific in those one-liners ("added null check on `user.email` before the SendEmail call" beats "fixed auth bug" every time), because vague explanations produce both vague sweeps and vague PR bodies. If you flagged an edge case or made a deliberate design choice during the work, mention it so TPM can decide whether it belongs in the description or just in the per-ticket notes. You do not run the checklist or draft the PR body yourself — do not pre-format your return as a checklist or a PR body; just include the findings clearly so TPM can lift them into either stage.

### QA

Your verdict feeds both stages. The pre-PR checklist runs AFTER QA — it is the layer above QA, focused on PR-readiness rather than functional correctness, so do not duplicate QA's job in the checklist or QA's job in your verdict. If QA finds a functional issue, that is QA's verdict, and TPM may or may not surface it as a checklist flag depending on what the check description says to look for. If QA finds a non-functional issue that matches a checklist check (e.g., a dead-code observation, a TODO without a ticket), include it in your verdict's notes — TPM lifts it into the sweep. Your verdict's Issues and Notes sections are also input for the description's "why" sentence when a PR is fixing or hardening something: be explicit about what the change protects against ("prevents the SendEmail call from throwing when `user.email` is null" reads cleanly as an impact line). If your verdict is `PASS WITH NOTES` and the note is non-blocking but worth surfacing in the PR body, say so in the verdict so TPM can weigh including it. Do not draft PR text yourself — TPM owns the synthesis.
