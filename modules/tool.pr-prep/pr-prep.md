# PR Prep

When this module is loaded, the session has a multi-stage PR-handoff toolkit: a structured **pre-PR quality gate** (the checklist), a structured **PR-description generator**, and a **reviewer configuration**. They run in sequence as the user hands a task off to a PR. The checklist runs first, catching the kinds of issues automated PR reviewers (CodeRabbit, Copilot review, etc.) commonly flag; the description runs next, drafting a PR body the user edits directly before submission; reviewers are confirmed last before the PR is created. Every agent reads this same fragment; TPM owns all stages, SWE and QA feed findings into both the checklist and description, and role-specific framing is collected at the end.

This module is **not proactive**. It does not fire at session start. It fires when the user signals they are ready to PR (per `parameters.checklistAutoOffer` for the checklist) or when the user explicitly asks. When the checklist completes cleanly, TPM proceeds directly to generating the PR description with a change summary of at most three sentences (the hard cap in the generation contract) — no offer, no prompt, just do it. Treat it as a handoff ritual, not a continuous check.

## PR-handoff sequence

The stages of this module bracket the PR handoff, and a separate module may run between the first two:

1. **Pre-PR Checklist** (this module, first) — the quality gate. TPM sweeps the working tree against the configured checks and reports findings before the PR is created.
2. **`tool.regression-scan`** (a **separate** module, between checklist and description, when enabled) — runs after the checklist and before the description. It is not part of this module; when it is enabled it slots into the sequence here, and when it is not enabled the description simply follows the checklist directly.
3. **PR Description** (this module) — the artifact. TPM drafts the PR body once the checklist (and the regression scan, when enabled) has completed cleanly. The user edits the draft directly before submission.
4. **Reviewers** (this module, last) — TPM presents the reviewer list (defaults plus per-PR additions), the user confirms, and TPM proceeds with PR creation.

The checklist auto-offer gates the first stage; the description and change summary follow automatically when the checklist completes with no blocking flags. Reviewer confirmation follows the description.

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

TPM evaluates checks from three inputs, all read-only (a fourth joins when `tool.reviewer-dossier` is loaded):

- `git diff --name-only`, `git diff`, and `git status` — the canonical view of what is about to ship.
- Session memory — the assignments, SWE returns, and QA verdicts already in the conversation. SWE's edge-case calls and QA's findings are first-class inputs, not afterthoughts.
- The check description in `parameters.checks[<name>].value` — this tells TPM what pattern the check is looking for.
- The reviewer dossier (`tool.reviewer-dossier`, when loaded) — a read-only reference of patterns known reviewers reliably flag, consulted for the "Known reviewer patterns pre-empted" check and never written to from this module.

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

Once the checklist (and the regression scan, when `tool.regression-scan` is enabled) has completed cleanly, TPM **immediately** drafts a plain-language PR description with a change summary of at most three sentences appended — the generation contract's hard cap, and it is not negotiable against diff size. No offer, no prompt — just generate it. The description is free of double-dashes (and any other token in `parameters.bannedTokens`) and ticket-aware when a ticket-scoped mode (`mode.ticket-work` or `mode.ticket-pr`) is active. The draft is presented to the user as editable text; the user edits it directly and what they approve is what gets submitted.

### When to generate a description

Generate a description when:

- The pre-PR checklist (and the regression scan, when enabled) has just completed with no `✗` flags. TPM proceeds directly to generating the description — no offer, no prompt.
- The user signals PR readiness without running the checklist ("create a PR", "ship this", "ready to PR"). Generate directly.
- The user explicitly asks ("write a PR description", "give me a PR body", "draft the PR text"). Generate without preamble.

Do **not** generate a description:

- On every code change or session end. The description is specifically the PR-handoff gesture, not a continuous narration.
- Immediately after the checklist when the checklist returned `✗` flags. The user should address the flags first. They can still ask explicitly if they want a draft before addressing them.
- When the module is not loaded. Without this module, TPM does not draft PR bodies — the user writes their own.

### Generation contract

These rules apply to every draft.

- **Change summary: three sentences maximum. Hard cap.** The change summary is AT MOST THREE SENTENCES. Three is a ceiling, not a target — one or two is better when one or two will do. Count them before presenting the draft: a sentence is any span ending in `.`, `?`, or `!`. Bullets, fragments, headings, and semicolon-joined clauses each count as a sentence; splitting the summary into a list does not exempt it from the cap, and a list is never a substitute for the sentences. If the draft runs over, do NOT present it — cut to the three that matter most (what changed, why, and the user-visible effect) and drop the rest. Detail that does not fit belongs in the diff, the ticket, or the per-ticket notes, never in the summary. Re-count after every regeneration and after the user's own edits, in the same pass as the banned-tokens scan; if the final text is over, surface it ("The change summary is four sentences now — cut it to three, or submit as-is?"). There is NO exception for a large diff, a many-file change, or a change the user calls complicated: a bigger change gets a shorter, higher-altitude summary, not a longer one. This cap governs even when `parameters.descriptionTemplate` says otherwise.
- **Banned tokens.** No token from `parameters.bannedTokens` may appear in the final output. Parse the parameter as comma-separated, trim each entry, and scan every draft for each entry as a substring match. If a banned token slips in (TPM caught itself writing one), rewrite the sentence to avoid it — usually by replacing the dash with a comma or restructuring the clause. Em-dashes (`—`, U+2014) are FINE — banned tokens are about double-dashes (`--`) and double-dash-adjacent patterns, not em-dashes. Scan the **final** text (after user edits) before submission; if the user introduced a banned token in their edit, surface it and ask whether to rewrite or accept.
- **Plain language.** No jargon the user would not say in conversation. Drop adjectives that do not add information. Active voice over passive when possible. Reviewers should be able to read the description once and understand the change.
- **Ticket reference.** When a ticket-scoped mode (`mode.ticket-work` or `mode.ticket-pr`) is active and has resolved a ticket key for the session (derived from the branch, per that mode's ticket resolution), prepend the ticket id to the description as a convention (e.g., `PROJ-123: ...`). When no ticket-scoped mode is active or no ticket key has been resolved, drop the ticket prefix gracefully.
- **What and why, not how.** Reflect what changed (the user-observable behavior) and why (the motivation or the bug it fixes). Do not enumerate implementation details, internal function names, or refactor mechanics. Reviewers see the diff for the how.
- **Template awareness.** When `parameters.descriptionTemplate` is non-empty, use it as the starting structure for the draft. Fill in the template sections with content derived from the session's work. When the template is empty, draft free-form based on the input sources below. The template supplies structure only, never permission to exceed the three-sentence cap: an operator-customized template whose placeholder text asks for more (or omits the limit entirely) does not raise the ceiling.

### Input sources TPM uses to write the description

TPM composes the draft from these inputs, all read-only:

- **Session memory** — SWE return messages (especially the one-sentence per-file explanations), QA verdicts, edge cases flagged during the work. This is the primary source for the "what" content.
- **`git diff --stat` and `git diff --name-only`** — background context for the change summary and a sanity check that the session memory matches what is actually staged. This is raw material to draw from, not a list to reproduce: the summary is prose, never a per-file or per-change bullet list, and nothing in the diff is "always included". A wide diff still gets at most three sentences (see the hard cap in the generation contract) — it raises the altitude of the summary, it does not extend it.
- **Ticket-scoped mode's ticket summary** (`mode.ticket-work` or `mode.ticket-pr`) — when active, the Jira summary provides "why" context for free, used as plain context for the description.
- **`tool.obsidian-notes` per-ticket or per-project notes** — when enabled, read the relevant notes file for "why" framing the user articulated earlier in the session (Implementation Notes, Ticket Summary). Use the read paths the notes module already exposes; do not invent a path.
- **The user's own framing in the current session** — if the user said "this fixes the auth race we found earlier", lift that framing verbatim or near-verbatim into the description. It is almost always the best "why" content.

If multiple inputs disagree, prefer the user's own framing > the ticket summary > the SWE returns > the diff. The diff tells you what changed; it does not tell you why.

### Presenting the draft

After generating a draft that satisfies the generation contract:

1. Show the draft to the user in a large editable block (in the settings panel's PR Prep textarea or in chat), formatted as it will appear in the PR. No extra prose around it.
2. Tell the user: "Edit the description above, then confirm to submit." The user edits the text directly — what they see is what gets submitted.
3. If the user asks to **regenerate** ("regenerate", "try again with a different angle"), ask for the angle ("more emphasis on impact", "less technical", etc.) and draft again. Do not loop indefinitely — if the user regenerates more than twice, ask whether the inputs are insufficient (maybe SWE returns were vague, maybe no ticket summary is available) so the issue can be addressed at the source.
4. Before submission, re-apply the banned-tokens scan AND re-count the change summary's sentences against the three-sentence hard cap, on the final text (which may have been edited by the user). One pass, both checks. If a banned token is present, or the summary is over three sentences, surface it and ask whether to rewrite or accept.

### Description: module-disabled vs feature-disabled

These are distinct states and must produce distinct behavior:

- **Module disabled** (no `tool.pr-prep` in the Session Manifest): TPM does NOT offer or generate PR descriptions. The user writes their own PR body. If the user appears to expect TPM to draft one ("can you write the PR description?"), surface that the module is not loaded — do not pretend the feature exists.

Do not merge these cases.

---

## Reviewers

When `parameters.defaultReviewers` has entries, those reviewers are automatically included on every PR. Each entry is a display name (key) plus a Bitbucket account ID (value). Default reviewers are pre-populated in the reviewer list when TPM assembles the PR creation request.

### Adding reviewers

Reviewers come from two sources:

- **Default reviewers** (`parameters.defaultReviewers`) — configured in the Modules tab, persisted across sessions. These are always included unless the user explicitly removes one for a specific PR.
- **Per-PR reviewer search** — the operator can search for additional reviewers via the bridge's `/workspace-members` route (served by the Bitbucket bridge, built by SWE-2). The search shows display names and avatar images from Bitbucket's workspace members API. Selected reviewers are added to the PR alongside the defaults.

### How reviewers are passed to the bridge

When TPM calls `create-pr`, reviewers are passed via the `--reviewers` flag as a JSON array of account ID strings:

```bash
node "$GHOLA_ROOT/scripts/bb-bridge.mjs" create-pr \
  --repo my-repo --source feature/PROJ-123 --target dev \
  --title "PROJ-123: Add widget" --draft \
  --reviewers '["712020:abc123", "712020:def456"]'
```

The wrapper maps each string to `{ account_id: id }` before sending to Bitbucket. To add or change reviewers after PR creation, use `update-pr`:

```bash
node "$GHOLA_ROOT/scripts/bb-bridge.mjs" update-pr \
  --repo my-repo --pr 1556 \
  --reviewers '["712020:abc123", "712020:def456"]'
```

TPM merges default reviewers (`parameters.defaultReviewers`) and any per-PR additions the user selected, deduplicating by account ID, before constructing the array.

### Presenting reviewers before PR creation

Before submitting the PR, TPM presents the full reviewer list to the user for confirmation:

1. List all reviewers (defaults marked as such, per-PR additions listed separately).
2. The user confirms the list, removes entries, or searches for additional reviewers.
3. Only after the user confirms does TPM proceed with the `create-pr` call.

---

### Sibling-module interaction

The description composes cleanly with the checklist stage of this module and three sibling modules.

#### Pre-PR Checklist (this module, first stage)

The checklist and the description form the PR-handoff pair within this module: checklist first (the gate), description second (the artifact). When the checklist completes with no `✗` flags, TPM proceeds directly to generating the description with a change summary of at most three sentences (the generation contract's hard cap) — no offer, no delay. When the checklist surfaced `✗` flags, TPM holds the description until the flags are addressed. The user can still ask explicitly ("draft the PR body anyway") and TPM generates, noting once: "The checklist still has open flags — confirm you want to proceed to the description?"

#### `tool.regression-scan`

When enabled, the regression scan is a **separate** module that runs between the checklist and the description in the PR-handoff sequence. TPM chains the description offer only after the regression scan (and the checklist) has completed cleanly. When it is not enabled, the description follows the checklist directly with no intervening stage.

#### `mode.ticket-work` / `mode.ticket-pr`

Either ticket-scoped mode provides the resolved ticket key (derived from the branch, per that mode's ticket resolution) for prepending to the PR description. Either provides the Ticket Summary as a strong candidate for the "why" content, used as plain context when composing the description. Without a ticket-scoped mode active, the ticket prefix is dropped gracefully.

#### `tool.obsidian-notes`

The per-ticket or per-project notes file is a rich input source — TPM reads it (via the read paths the notes module already exposes) to find the "why" framing the user articulated earlier in the session. Implementation Notes and Ticket Summary are the highest-value sections. Do NOT write back to the notes file from this module — generation is read-only. The user's PR body lives in Bitbucket or GitHub, not in Obsidian.

#### `tool.reviewer-dossier`

When enabled, the checklist's "Known reviewer patterns pre-empted" row consults the dossier (in the vault, under the project's `## Reviewer Dossier` section) as its fourth read-only input, alongside the diff, session memory, and the check description. As with `tool.obsidian-notes`, TPM only reads the dossier here — capture, classification, and dossier writes are owned elsewhere, never by this module.

---

## Role-Specific Notes

The body above applies identically to every agent. The notes below are short framings for how each role uses both stages of PR Prep.

### TPM

You own all three stages (checklist, description, reviewers). **For the checklist:** you decide when to offer it (per the signal rules in the checklist's When-to-Run section), you read the git diff, consult session memory, and evaluate each check. You present findings using the `✓ / ⚠ / ✗` format. You do **not** delegate check evaluation to SWE — the checklist is a TPM-level synthesis that combines SWE returns, QA verdicts, and your own read of the diff. If SWE has already noted a side effect or QA has already flagged an issue, use that as input; do not re-dispatch SWE to look at what SWE just looked at. **For the description:** you read session memory (SWE returns, QA verdicts, user framing), you run `git diff --stat` and `git diff --name-only` for change-summary context (background material, not a list to reproduce), and you read the per-ticket or per-project notes file when `tool.obsidian-notes` is enabled. You apply the generation contract — three-sentence cap on the change summary, banned-tokens scan, plain-language pass — before presenting any draft, and you re-count and re-scan the final text after the user's edits, treating any Jira-derived text from a ticket-scoped mode (`mode.ticket-work` or `mode.ticket-pr`) as plain context for the description. You present the draft as editable text; the user edits it directly and confirms before submission. You do not delegate generation to SWE or QA — this is a TPM-level synthesis, and SWE / QA findings are inputs, not drafts. **For reviewers:** you present the reviewer list (defaults from `parameters.defaultReviewers` plus any per-PR additions) to the user and confirm before PR creation. You merge default and per-PR reviewers, deduplicating by account ID, and pass the final list to the `create-pr` bridge call.

### SWE

Your findings feed both stages. When you complete a code task, include in your standard return any edge cases you considered, side effects you anticipated, dead code observations, places where you added a TODO, and anything else TPM might surface in the checklist sweep. Your one-sentence per-file explanations are also the primary raw material for the description's "what" sentence — be specific in those one-liners ("added null check on `user.email` before the SendEmail call" beats "fixed auth bug" every time), because vague explanations produce both vague sweeps and vague PR bodies. If you flagged an edge case or made a deliberate design choice during the work, mention it so TPM can decide whether it belongs in the description or just in the per-ticket notes. You do not run the checklist or draft the PR body yourself — do not pre-format your return as a checklist or a PR body; just include the findings clearly so TPM can lift them into either stage.

### QA

Your verdict feeds both stages. The pre-PR checklist runs AFTER QA — it is the layer above QA, focused on PR-readiness rather than functional correctness, so do not duplicate QA's job in the checklist or QA's job in your verdict. If QA finds a functional issue, that is QA's verdict, and TPM may or may not surface it as a checklist flag depending on what the check description says to look for. If QA finds a non-functional issue that matches a checklist check (e.g., a dead-code observation, a TODO without a ticket), include it in your verdict's notes — TPM lifts it into the sweep. Your verdict's Issues and Notes sections are also input for the description's "why" sentence when a PR is fixing or hardening something: be explicit about what the change protects against ("prevents the SendEmail call from throwing when `user.email` is null" reads cleanly as an impact line). If your verdict is `PASS WITH NOTES` and the note is non-blocking but worth surfacing in the PR body, say so in the verdict so TPM can weigh including it. Do not draft PR text yourself — TPM owns the synthesis.
