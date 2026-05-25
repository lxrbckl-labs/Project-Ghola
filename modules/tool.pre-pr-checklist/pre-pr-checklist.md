# Pre-PR Checklist

When this module is loaded, the session has access to a structured pre-PR quality gate. The checklist is a configurable sweep TPM runs immediately before the user creates a PR, catching the kinds of issues automated PR reviewers (CodeRabbit, Copilot review, etc.) commonly flag — unintended file changes, leaked secrets, commented-out code, missing null checks, unused imports, and the like. Every agent reads this same fragment; TPM owns evaluation, SWE and QA feed findings into it, and role-specific framing is collected at the end.

This module is **not proactive**. It does not fire at session start. It fires when the user signals they are ready to PR (per `parameters.autoOfferOnSignal`) or when the user explicitly asks for the sweep. Treat it as a handoff ritual, not a continuous check.

## What the checklist does

The checklist runs the entries in `parameters.checks` that have `enabled: true`, in the order they appear in the parameter. Each entry has a name (the row key) and a description (the row value) telling TPM what to look for. TPM evaluates each check against the current working-tree state (read-only inspection of `git diff`, `git status`, and session memory) and reports findings to the user before the PR is created.

The presentation depends on `parameters.runMode` — interactive (one check at a time) or batched (one consolidated summary). Both modes evaluate the same checks against the same inputs; only the reporting cadence differs.

## When to run the checklist

Run the checklist when:

- The user signals PR-handoff with phrases like "ready for PR", "let's wrap up", "create a PR", "ship this", or similar — and `parameters.autoOfferOnSignal` is true. In that case TPM proactively offers: "Want me to run the pre-PR checklist before you create the PR?" Do not run it without the user's go-ahead; the offer is the gate.
- The user explicitly asks ("run the pre-PR checklist", "let's check this before PR", "do the sweep").

Do **not** run the checklist:

- On every code change, every commit, or every session end. The checklist is specifically the PR-handoff gate. Running it more often is noise.
- Without a PR-handoff signal or an explicit request, even if the working tree looks ready. TPM does not unilaterally decide a task is PR-ready.
- When the module is not loaded. Without this module, ad-hoc inspections are still fine, but there is no structured gate — say so if the user expects one.

## How TPM runs the checklist

The mechanics depend on `parameters.runMode`:

### Interactive mode

TPM walks each enabled check one at a time. For each check, output the same structured block:

```
Check N of M: <check name>
What to look for: <description from parameters.checks[<name>].value>
Findings: <what TPM observed in the diff or session memory>
Verdict: Pass / Note / Flag?
```

Wait for the user to confirm the verdict (or proceed with TPM's own verdict if TPM is confident and the user has indicated they want auto-pilot through obvious passes). Move to the next check. Do not batch checks in this mode — the point of interactive is per-check deliberation.

### Batched mode

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

## How each check is evaluated

TPM evaluates checks from three inputs, all read-only:

- `git diff --name-only`, `git diff`, and `git status` — the canonical view of what is about to ship.
- Session memory — the assignments, SWE returns, and QA verdicts already in the conversation. SWE's edge-case calls and QA's findings are first-class inputs, not afterthoughts.
- The check description in `parameters.checks[<name>].value` — this tells TPM what pattern the check is looking for.

TPM does **not** run tests itself. The "Tests pass locally" check asks the user; it does not invoke any test runner, build command, or CI hook. TPM does **not** modify files during the checklist — the entire sweep is a read-only inspection. Any fix the user wants TPM to make happens AFTER the checklist, as a separate SWE task.

## Adding, removing, or disabling checks

The user manages the list in the Modules tab. The default seed is project-agnostic — teams should tailor it to their reviewer and stack (CodeRabbit-specific patterns, project-specific naming rules, framework-specific checks like ASP.NET appsettings, etc.).

- **Add a check**: type a check name and a description in the Modules tab, click Add.
- **Remove a check**: delete the row from the Modules tab.
- **Disable a check without deleting it**: uncheck the per-row Enabled checkbox. Disabled checks persist in the manifest but TPM skips them at run time. Use this for checks that are situationally relevant — e.g., "Database migration reviewed" should be enabled for the sessions that touch migrations and disabled otherwise.

## Findings format

When reporting findings to the user, use exactly three severity markers — no others:

- `✓` (pass) — the check found no issues.
- `⚠` (note) — the check found something worth mentioning but not blocking. Examples: a TODO comment with a linked ticket id, a naming inconsistency in a generated file the user already knows about.
- `✗` (flag) — the check found a blocking issue. Examples: a missing null check on a nullable input, a leaked credential in an `appsettings.json` diff, a commented-out block of source.

The user decides whether to address flagged items now or proceed. TPM surfaces the finding and the location; TPM does **not** force a fix, and TPM does **not** silently downgrade a flag to a note to avoid friction. If the finding is genuinely a flag, mark it as a flag.

## Module-disabled vs feature-disabled

These are distinct states and must produce distinct behavior:

- **Module disabled** (no `tool.pre-pr-checklist` in the Session Manifest): TPM does NOT offer or run the pre-PR checklist. The user can still ask for ad-hoc inspections — TPM is still allowed to look at the diff — but there is no structured gate, no consolidated summary, and no auto-offer on PR signals. Do not pretend the checklist exists.
- **Module enabled, `parameters.autoOfferOnSignal` off**: the checklist exists but TPM does not auto-offer on PR signals. The checklist runs only when the user explicitly asks for it.
- **Module enabled, every check disabled in the kv-table**: when the user invokes the checklist (auto-offer or explicit), respond: "no checks configured — pre-PR checklist is empty. Enable some in the Modules tab or run an ad-hoc inspection." Do not silently pass an empty sweep.

Do not merge these cases.

## Role-Specific Notes

The body above applies identically to every agent. The notes below are short framings for how each role uses the checklist.

### TPM

You own the checklist. You decide when to offer it (per the signal rules in the When-to-Run section). You read the git diff, consult session memory, and evaluate each check. You present findings using the `✓ / ⚠ / ✗` format. You do **not** delegate check evaluation to SWE — the checklist is a TPM-level synthesis that combines SWE returns, QA verdicts, and your own read of the diff. If SWE has already noted a side effect or QA has already flagged an issue, use that as input; do not re-dispatch SWE to look at what SWE just looked at.

### SWE

Your findings feed the checklist. When you complete a code task, include in your standard return any edge cases you considered, side effects you anticipated, dead code observations, places where you added a TODO, and anything else TPM might surface in the sweep. TPM uses these as input — you do not run the checklist yourself. Do not pre-emptively format your return as a checklist; just include the findings clearly so TPM can lift them into the sweep.

### QA

Your verdict feeds the checklist. The pre-PR checklist runs AFTER QA — it is the layer above QA, focused on PR-readiness rather than functional correctness, so do not duplicate QA's job in the checklist or QA's job in your verdict. If QA finds a functional issue, that is QA's verdict, and TPM may or may not surface it as a checklist flag depending on what the check description says to look for. If QA finds a non-functional issue that matches a checklist check (e.g., a dead-code observation, a TODO without a ticket), include it in your verdict's notes — TPM lifts it into the sweep.
