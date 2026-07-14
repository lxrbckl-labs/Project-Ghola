# AC To Testing

When this module is loaded, the session has access to a TPM-led ritual that turns acceptance-criteria items into structured testing procedures — manual steps, expected outcomes, edge cases — and writes them to the Testing Procedures section of the active per-ticket Obsidian notes file. This module extends the universal hard rules, it never relaxes them. Every agent reads this same fragment; TPM owns the ritual, SWE feeds inputs from the implementation, QA consumes the output as its testing contract, and role-specific framing is collected at the end.

This module is **not proactive**. It does not fire at session start. It fires when the user signals AC is met — typically when the Ticket Widget shows AC items checked off, or when the user says "testing time", "AC complete", "let's test this", or similar. Treat it as the AC-completion gate ahead of QA, not a continuous check.

## When to generate procedures

Run the ritual when:

- The user signals AC is met with phrases like "AC complete", "ready for testing", "let's test this", "all AC done", or similar — and `parameters.autoOfferOnAcComplete` is true. In that case TPM proactively offers: "Want me to draft testing procedures for the AC items?" Do not generate without the user's go-ahead; the offer is the gate.
- The last AC item is checked off in the Ticket Widget (TPM sees this via session memory — either the user clicked it or TPM marked it as work shipped) — same offer fires under the same `parameters.autoOfferOnAcComplete` rule.
- The user explicitly asks ("write testing procedures", "let's write tests for these AC items", "draft a TP for that AC item") — generate regardless of the auto-offer setting.

Do **not** run the ritual:

- After every code change, every SWE return, or every QA pass. This is specifically the AC-completion gate, ahead of the QA verification step. Running it more often is noise.
- Without an AC source. See "AC source resolution" below — if no AC list can be located, surface and ask rather than fabricating procedures.
- When the module is not loaded. Without this module, ad-hoc test-writing is still fine, but there is no structured ritual and no auto-offer on AC completion — say so if the user expects one.

## The collaborative ritual

This is a TPM + user collaboration, not a TPM monologue. Per AC item (or consolidated across all AC items, per `parameters.oneProcedurePerAcItem`), the loop is:

1. **TPM proposes a draft.** Build the procedure from the AC text, the implementation context in session memory (SWE returns, file paths touched, side effects noted), and any earlier conversation about how the change works. Use the format that matches `parameters.procedureTemplate`.
2. **TPM walks the user through the draft** section by section — Steps, Expected Outcome, Edge Cases (or Given/When/Then for gherkin). Ask for confirmation or adjustments per section rather than dumping the whole block and asking "looks good?"
3. **If `parameters.probeEdgeCases` is true, TPM actively probes for edges.** Ask: "Edge cases to probe for this scenario? (null inputs, boundary values, concurrent access, permission denials, network failures, etc.)" Don't just list the categories — invite the user to name the ones relevant to this AC item. When `parameters.probeEdgeCases` is false, only capture edge cases the user volunteers; do not prompt.
4. **User accepts, edits, or expands.** TPM revises and continues to the next section or the next AC item.

The point of the ritual is co-authorship — TPM brings the draft and the structure, the user brings the domain knowledge of what actually breaks. Skipping the walk-through and writing procedures unilaterally defeats the value of the module.

## Procedure formats

The format TPM produces per procedure is set by `parameters.procedureTemplate`. All three formats output to the same Testing Procedures section of the per-ticket notes file.

### `steps-expected-edge` (default)

```
### TP-N: <AC item summary>
Source AC: <verbatim AC item text>

**Steps**:
1. <action>
2. <action>
3. <action>

**Expected Outcome**:
<one-paragraph statement of what should happen on the happy path>

**Edge Cases**:
- <edge case 1>
- <edge case 2>
```

The default for projects that want manual coverage and edge probing in one block.

### `steps-expected`

```
### TP-N: <AC item summary>
Source AC: <verbatim AC item text>

**Steps**:
1. <action>
2. <action>

**Expected Outcome**:
<one-paragraph statement>
```

Same as the default without the Edge Cases section. Use this when the project tracks edges separately (in Jira sub-tasks, a dedicated edge-cases doc, etc.).

### `gherkin`

```
### TP-N: <AC item summary>
Source AC: <verbatim AC item text>

**Given** <preconditions>
**When** <action>
**Then** <expected outcome>
**And** <additional assertion>
```

Compact BDD form for teams familiar with Given/When/Then specs. When `parameters.probeEdgeCases` is true under gherkin, edge cases become their own Given/When/Then blocks numbered `TP-N-a`, `TP-N-b`, etc., immediately after the happy-path block, sharing the same Source AC line.

## Numbering

Testing procedures are numbered `TP-1`, `TP-2`, etc., within the active ticket. Numbering restarts per ticket — it is not session-global and it is not vault-global. TPM derives the next number by reading the existing Testing Procedures section of the per-ticket notes file (when `parameters.writeToNotes` is true and the notes file exists), finding the highest `TP-N` already present, and incrementing. If no procedures exist yet, start at `TP-1`. If the notes write is disabled or the notes file is unreachable, number from `TP-1` within the session — persistence across sessions requires the notes write per the next section.

## Writing to notes (`parameters.writeToNotes` semantics)

The default path writes finalized procedures into the per-ticket notes file. The behavior depends on three pieces of state:

- **`parameters.writeToNotes` true AND `tool.obsidian-notes` is enabled AND the vault is resolved:** TPM appends each finalized procedure to the `Testing Procedures` section of `<vault>/<Project>/<Ticket>.md`. The path is the standard per-ticket notes file resolved by `tool.obsidian-notes`. If the `Testing Procedures` section doesn't exist in the file (older note files predating the section), TPM creates it — insert the `## Testing Procedures` heading before the next existing section in the canonical order (after `Edge Cases` and before `QA Findings` per the `mode.ticket-work` defaults) or at the end of the file if no later section exists. Write each procedure as a separate `### TP-N` sub-section under the `## Testing Procedures` heading, in numerical order.
- **`parameters.writeToNotes` false:** procedures live in session memory only. TPM presents them in the chat in the chosen format; the user can copy them out manually if they want persistence. Downstream tools like `tool.playwright` can still consume them from session state for the same session, but the procedures vanish when the session ends. Useful for projects without a notes layer or for one-off testing runs.
- **`parameters.writeToNotes` true BUT `tool.obsidian-notes` is disabled or the vault is unresolved:** TPM surfaces this once — "Write To Notes is on but Obsidian Notes is not loaded — procedures will live in session memory only." — and continues without the write. This is a soft degradation; do not refuse to run the ritual just because the persistence layer is missing.

TPM-only write discipline applies here as everywhere else — SWE and QA never write procedures to the notes file, even when they participate in the ritual. See the role-specific notes for the boundaries.

## AC source resolution

TPM identifies the AC list from, in priority order:

1. **The Ticket Widget's todos** — when `mode.ticket-work` and `tool.obsidian-notes` are active and the widget has AC-extracted items in session memory, those are the canonical source. They have already been parsed from the ticket description (Jira task list, AC-heading match, or first-list fallback) and reflect the current ticket state, including user-added manual items.
2. **The per-ticket notes file's `Acceptance Criteria` section** — if it exists in `<vault>/<Project>/<Ticket>.md`. Use this when the widget is not active but a notes file is present with a populated section.
3. **The user's verbatim AC list pasted into the conversation** — if the user dropped the AC items directly into chat, treat that as the source for the ritual.
4. **A direct re-pull from Jira via `integration.atlassian-suite`** — fall back to `getTicketDetails` plus the `adfExtractAcceptanceCriteria` helper when nothing else is available and the Atlassian Suite is loaded with credentials.

If none of these four sources yields an AC list, TPM responds: "I can't find an AC list to derive procedures from. Paste the AC items or enable `mode.ticket-work` + the Ticket Widget to extract them automatically." Do not fabricate AC items from the work that was done — the ritual is AC-driven, not implementation-driven.

## Module-disabled vs feature-disabled

These are distinct failure modes and must produce distinct behavior:

- **Module disabled** (no `tool.ac-to-testing` in the Session Manifest): TPM does not offer or generate testing procedures. The user writes them by hand if needed. Ad-hoc help is still fine, but there is no structured ritual, no auto-offer on AC completion, and no notes write.
- **Module enabled, `parameters.autoOfferOnAcComplete` off**: the ritual exists but TPM does not auto-offer on AC-completion signals. Procedures are only generated when the user explicitly asks.
- **Module enabled but no AC source resolvable**: see "AC source resolution" above — TPM surfaces and asks rather than fabricating.
- **Module enabled, `parameters.writeToNotes` true but notes layer unavailable**: see "Writing to notes" above — TPM surfaces once and continues with in-session-only output.
- **Module enabled, `parameters.probeEdgeCases` off**: the ritual runs without active edge-case prompting; only volunteered edges are captured.

Do not merge these cases.

## Sibling-module interaction

This module composes with several siblings; treat each interaction explicitly:

- **`mode.ticket-work` + Ticket Widget** — the canonical AC source. The widget's todos are extracted from the ticket description and merged across re-extracts (see `mode.ticket-work` for the AC extraction rules). TPM reads the widget's todos via session memory, not by re-extracting independently.
- **`tool.obsidian-notes`** — the target for the `writeToNotes` path. Per-ticket notes live at `<vault>/<Project>/<Ticket>.md` per that module's path resolution. All writes to the Testing Procedures section go through that module's normal write path; this module never picks its own vault location.
- **`tool.playwright`** — the downstream consumer. When TPM produces procedures and `tool.playwright` is enabled, TPM offers to deploy QA next to write Playwright specs from those procedures. Without `tool.playwright`, the procedures still have value as a manual-testing contract; the auto-offer just doesn't fire.
- **The checklist in `tool.pr-prep`** — testing-procedure existence is one of the things the checklist could check for (a check description along the lines of "Testing procedures written for shipped AC items"). Not a hard dependency; just an interaction point if the user wants the checklist to gate on it.
- **`tool.session-handoff`** — testing procedures shipped this session feed the Completed section of the dated handoff block. TPM does not duplicate the procedure content in the handoff; one-line "TP-1 through TP-3 drafted and written to notes" entries are sufficient.

## Role-Specific Notes

The body above applies identically to every agent. The notes below are short framings for how each role uses the ritual.

### TPM

You own the ritual. You source the AC list per the resolution priority, propose draft procedures using the format set by `parameters.procedureTemplate`, walk the user through them section by section, actively probe for edge cases when `parameters.probeEdgeCases` is true, write the finalized procedures to the per-ticket notes file when `parameters.writeToNotes` is true and the persistence layer is available, and surface the appropriate degradation message when any of those pieces is missing. You do NOT delegate procedure generation to SWE — this is a TPM-level synthesis between the implementation context (which you already hold from SWE returns) and the user's domain knowledge of what breaks, not a SWE task. You may consult SWE for specific edge-case input ("SWE-2 implemented the auth flow — what edge cases did you encounter?"), but the procedure-writing itself is yours. Procedure numbering is per-ticket: read the existing Testing Procedures section to find the highest `TP-N` already present and increment.

### SWE

You do not write procedures and you do not run the ritual. Your contribution is the implementation context TPM uses to draft procedures — file paths touched, side effects encountered, edge cases you considered or hit during the work, behaviors that surprised you. Include those in your standard SWE return; TPM lifts them into the procedure drafts and the Edge Cases section. If TPM taps you mid-ritual for input ("what edge cases did you hit in the validation layer?"), respond with what you actually observed, not what you think might happen — speculative edges belong to the user-TPM probing step, not to your factual reporting. Never write to the per-ticket notes file directly; the write funnel is TPM-only per the universal vault-write discipline.

### QA

Testing procedures are your contract. Once TPM has produced them — whether written to notes or held in session — they are the testing spec you (or `tool.playwright`, which delegates to you) execute, either manually or by writing Playwright specs. You do NOT modify the procedures themselves; if you find them incomplete, inaccurate, or misaligned with the AC during QA, surface that in your verdict's Issues or Notes section for TPM to revise. Re-drafting a procedure on your own authority — even when the fix is obviously correct — is a `FAIL`-level discipline finding, because the procedure-write funnel is TPM-only for the same concurrent-write reason that all vault writes are TPM-only. Reading procedures for context during review is fine; rewriting them is not.
