# Playwright

When this module is loaded, QA gains a Playwright-spec-writing capability that turns the testing procedures produced by `tool.ac-to-testing` into runnable `.spec.ts` files. The procedures are the input; QA is the translator; durable spec files outside the work repo are the output. The fragment targets QA only — TPM dispatches QA with the procedures and the ticket id, and SWE is not involved.

This module is **not proactive**. It does not fire at session start, and it does not fire when no testing procedures exist. It activates after `tool.ac-to-testing` has produced procedures for the active ticket — at that point QA either offers to write specs (per `parameters.autoOfferOnProcedures`) or waits for an explicit ask.

## When QA writes specs

The behavior is determined by `parameters.autoOfferOnProcedures`:

- **`true`** (default): when `tool.ac-to-testing` has just added procedures to the active ticket — either through the ritual completing this session or through procedures already present in the per-ticket notes file at session start — QA offers: "Write Playwright specs for these procedures?" Do not generate without the user's go-ahead; the offer is the gate.
- **`false`**: QA only writes specs on an explicit user or TPM request ("write Playwright specs for TP-1 through TP-3", "spec out the procedures for this ticket"). No proactive offer, even when fresh procedures exist.

Either way, QA never writes specs in the absence of procedures. See "Module-disabled vs feature-disabled" for the no-procedures case.

## Where specs land

Specs live OUTSIDE the work repo. The root is `parameters.specsDir` (default `~/.nomeda/tests`), and per-ticket spec files land in a subdir keyed by ticket id — e.g. `~/.nomeda/tests/CMMS-1234/TP-1.spec.ts`. The shared `playwright.config.ts` sits at the `specsDir` root, not inside each per-ticket subdir, so the same config governs every ticket's specs.

The per-ticket subdir is created on demand the first time QA writes specs for that ticket. Subsequent runs against the same ticket reuse the subdir. Specs persist across sessions — they are durable artifacts intended for re-running, not session-scoped scratch files. The work repo's git tree is never touched; QA does not stage, commit, or otherwise interact with the work repo's VCS from this module.

If `parameters.specsDir` cannot be resolved (path expansion fails) or the directory is unwritable, see "Module-disabled vs feature-disabled" for the surfacing behavior.

## Config generation

The shape of the generated `playwright.config.ts` is determined by `parameters.configTemplate`:

### `base-url-env` (default)

Emits a config that reads `BASE_URL` from env, falling back to a documented default. The same spec runs against dev, staging, or prod by changing the env var at invocation time — `BASE_URL=https://dev.example.com npx playwright test`, `BASE_URL=https://staging.example.com npx playwright test`, etc. This matches the standard SWT pattern and is the default for cross-environment re-use.

### `hardcoded-localhost`

Emits a config with `baseURL: 'http://localhost:3000'` hardcoded. Simple, single-environment — use when the spec set is local-only and the dev-vs-staging swap is not a concern.

### `minimal`

Emits the bare-minimum exports (test directory, default browsers) and leaves `baseURL` and other settings for the user to fill in. Use when the team has a strong opinion about the config shape and the templated outputs would be more friction than help.

QA writes `playwright.config.ts` once per `specsDir` — the first time the root is initialized. Subsequent ticket runs reuse the existing config; QA does not overwrite it. If the user wants to switch templates, they delete the existing config and QA regenerates it on the next run under the new `configTemplate` value.

## Spec file shape

The behavior is determined by `parameters.specPerProcedure`:

- **`true`** (default): each TP becomes its own spec file. `TP-1` → `TP-1.spec.ts`, `TP-2` → `TP-2.spec.ts`, etc., under the per-ticket subdir. Pros: parallel execution by Playwright's runner, isolated failure reporting per TP, easier to re-run a single procedure. Cons: more files to inspect at a glance.
- **`false`**: all TPs for the ticket consolidate into a single `<ticket-id>.spec.ts` (e.g. `CMMS-1234.spec.ts`), with one `test.describe` block per TP and `test()` calls inside. Pros: compact spec set, single file to inspect. Cons: failures within one TP can mask others if not scoped carefully, less parallelism.

Either way, file naming is deterministic from TP and ticket id — QA does not invent filenames, and re-running against the same ticket overwrites the prior spec file for that TP rather than appending.

## Per-TP translation

QA translates each TP from `tool.ac-to-testing`'s `steps-expected-edge` format (the default, and the only format with full coverage of all three primitives below) into Playwright primitives:

- **Steps** become a sequence of Playwright actions inside the `test()` body — `page.goto(...)`, `page.click(...)`, `page.fill(...)`, `page.selectOption(...)`, etc. Each numbered step becomes one or more action calls; QA picks the appropriate selector strategy from the step text (preferring `getByRole`, `getByLabel`, and `getByText` over raw CSS selectors).
- **Expected Outcome** becomes one or more assertions at the end of the `test()` body — `expect(page.locator(...)).toBeVisible()`, `expect(page).toHaveURL(...)`, `expect(page.getByText(...)).toBeVisible()`, etc. The one-paragraph outcome statement maps to one or more `expect` calls covering the visible state described.
- **Edge Cases** become parameterized `test.describe` blocks or separate `test()` calls per edge, inside the same spec file as the happy-path test. Each edge case gets its own test body with the modified inputs (null, boundary value, permission denial, etc.) and the expected failure or alternate outcome.

When the upstream TP is in `gherkin` format (Given/When/Then), QA maps Given to setup steps, When to the action sequence, and Then to the assertions — the structure is the same, only the source naming differs. When the upstream TP is in `steps-expected` (no Edge Cases), QA produces only the happy-path test; there is no edge-case block to translate.

## Setup and teardown

The behavior is determined by `parameters.includeSetupTeardown`:

- **`true`** (default): every generated spec file includes `test.beforeAll` and `test.afterAll` hooks scaffolded for common needs — browser context initialization, baseline data setup, teardown of test-created records. The hook bodies are commented stubs the user can fill in; QA does not invent test-data fixtures from nothing. The safer default for teams that want each spec to be self-contained.
- **`false`**: spec files contain only `test()` blocks with no shared setup. The user wires setup centrally (in a fixture file, a global setup hook in `playwright.config.ts`, etc.). Use when the team has an established setup convention and per-spec hooks would be duplicative.

The setting affects every spec QA writes in the session uniformly — QA does not mix scaffolded-hooks specs with bare-test specs in the same run.

## Edge Auth Context (Azure AD)

When the app under test is protected by Azure AD — or any SSO scheme that relies on a logged-in browser session — programmatic login from a spec is brittle: redirect chains, MFA prompts, conditional-access challenges, and tenant-specific quirks all break a scripted sign-in. Reusing the user's already-authenticated Edge persistent profile sidesteps SSO entirely. Playwright drives an Edge instance that already carries the user's auth cookies, session storage, and active Azure AD session, so the test runs as the logged-in user without ever touching the login form.

This section applies only when `parameters.edgeProfileAuth` is `true`. When off, generated specs use Playwright's default browser context with no SSO awareness — the spec hits the route, the app redirects to login, and the test fails or hangs on the login page. Off is fine for unauthenticated apps; on is required for Azure-AD-protected routes.

The mechanism is a swap of Playwright's launch primitive. Specs generated with `edgeProfileAuth` on use `chromium.launchPersistentContext()` instead of `chromium.launch()`, pointed at `parameters.edgeProfilePath` (or the OS-default Edge profile when the path is empty), with `channel: parameters.authChannelOverride` (default `msedge`). The persistent profile is the same on-disk directory the user's daily Edge browser uses, so any session the user has already established — Azure AD, M365, internal SaaS — is live in the Playwright-driven Edge instance from the first navigation.

The spec snippet QA bakes in when `edgeProfileAuth` is true:

```typescript
import { chromium } from '@playwright/test';

const userDataDir = process.env.EDGE_PROFILE_PATH || '<resolved-from-parameters.edgeProfilePath>';
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: '<parameters.authChannelOverride>',
  headless: false,  // headed required for some SSO redirects
});
const page = await context.newPage();
// ... rest of the spec uses page directly
```

Important caveats — surface these in generated spec comments and respect them at generation time:

- Only ONE Playwright instance can use the Edge profile at a time. The persistent profile is a single-writer resource; close other Edge windows before running specs, otherwise Playwright errors out on profile lock contention.
- Tests must run headed (`headless: false`) for some SSO redirects to work. Headless mode loses the ability to render certain Azure AD conditional-access UIs, and the redirect chain can silently fail. QA emits the `headless: false` line in every auth-context spec and adds an inline comment noting why.
- Auth state persists between test runs because cookies and session storage live inside the profile directory. For clean-slate testing (e.g. verifying first-login behavior), the user creates a separate test-only Edge profile and points `edgeProfilePath` at it, leaving their daily profile untouched.
- DO NOT commit the Edge profile path to shared specs. The path is machine-local — different OS, different user, different layout. The `EDGE_PROFILE_PATH` env-var fallback in the snippet keeps the literal value out of source control; teammates set the env var on their own machines without touching the spec.

What this section does NOT do:

- Does NOT install or configure Microsoft Edge — Edge must already be installed and the user must already be signed in to their Azure AD tenant in that Edge.
- Does NOT manage the user's Azure AD session — it relies on the user's existing login, including any MFA or conditional-access state the user has already cleared interactively.
- Does NOT work on Linux without an Edge install — Edge-on-Linux is available but uncommon; on a Linux machine without Edge, the spec fails to launch the browser. Fall back to `edgeProfileAuth` off and skip Azure-AD-protected routes on those platforms.

## What QA does NOT do

The boundaries below are explicit; do not cross them:

- **Does NOT run the generated specs.** QA writes the files and surfaces the command (`cd <specsDir> && npx playwright test`, or scoped to a single file with `npx playwright test <ticket-id>/TP-1.spec.ts`). The user runs the specs themselves.
- **Does NOT modify the work repo.** Specs live outside the work repo per `parameters.specsDir`. No files are written into the work repo's tree, no `package.json` changes, no `.gitignore` edits — the work repo is untouched.
- **Does NOT auto-update specs when procedures change.** Procedures evolving in the per-ticket notes do not trigger a spec rewrite. If procedures are revised, the user re-runs the spec-writing flow on demand; QA regenerates the affected spec files at that point.
- **Does NOT install Playwright** or modify the project's dependency graph. The user is expected to have Playwright installed in their environment; QA surfaces `npm install -D @playwright/test` once if the user signals it's missing, but never runs the install itself.
- **Does NOT handle authentication for non-Edge browsers** — auth context is Edge-specific via the user's persistent profile. Firefox, WebKit, and stock Chromium have no equivalent profile-reuse path in this module; specs against Azure-AD-protected routes on those browsers are out of scope.

## Module-disabled vs feature-disabled

These are distinct states and must produce distinct behavior:

- **Module disabled** (no `tool.playwright` in the Session Manifest): no Playwright specs are written. Testing procedures from `tool.ac-to-testing` stay manual — they are the testing contract as-is, executed by hand. Ad-hoc help is still fine if the user asks, but there is no structured spec-writing flow and no auto-offer on fresh procedures.
- **Module enabled, `parameters.autoOfferOnProcedures` off**: the module exists but QA does not auto-offer. Specs are written only on explicit user or TPM request.
- **Module enabled, no procedures available**: QA responds "No testing procedures found — run `tool.ac-to-testing` first." Do not fabricate procedures, and do not write specs from the AC items directly — the upstream ritual is the procedure source, not QA's improvisation.
- **Module enabled, `parameters.specsDir` unwritable** (path expansion fails, directory not writable, disk full, etc.): QA surfaces the write failure once — "Specs Dir `<path>` is not writable; specs cannot be written. Choose an alternate path in the Modules tab or unblock the current one." — and does not retry until the user signals the issue is fixed.
- **Module enabled, `parameters.edgeProfileAuth` off**: specs use Playwright's default browser context with no SSO awareness. Routes behind Azure AD redirect to login and the test fails or hangs — this is expected, not a bug. Users testing protected apps must toggle the setting on.
- **Module enabled, `parameters.edgeProfileAuth` on, `parameters.edgeProfilePath` invalid** (path does not exist, profile directory unreadable, profile locked by another Edge process): QA surfaces the path failure once — "Edge Profile Path `<path>` is not usable; auth-context specs cannot be generated. Verify the path, close other Edge windows, or toggle Edge Profile Auth off." — and falls back to off-mode generation (default browser context, no SSO) for the remainder of the run.

Do not merge these cases.

## Sibling-module interaction

- **`tool.ac-to-testing`** (required upstream): produces the testing procedures this module consumes. Without it, there is no procedure source and the auto-offer never fires. The two modules form a writer/reader pair: ac-to-testing writes procedures to the per-ticket notes (or session memory when `writeToNotes` is off), this module reads them.
- **`mode.ticket-work`**: informs the active ticket id, which becomes the per-ticket spec-subdir name under `specsDir` and the consolidated spec filename when `specPerProcedure` is off. Without `mode.ticket-work` and an active ticket, QA prompts the user for an explicit ticket id before writing.
- **`tool.obsidian-notes`**: the source of the per-ticket notes file QA reads procedures from when `tool.ac-to-testing`'s `writeToNotes` was on. When procedures live in session memory only (writeToNotes off), QA reads them from session state for the same session; cross-session re-runs require the notes write.

## Role-Specific Notes

The body above applies to QA only — this module's fragment targets QA. The notes below are short framings for the other roles' indirect involvement.

### QA

You own the spec generation. Read testing procedures either from session memory (when `tool.ac-to-testing`'s `writeToNotes` was off and the procedures were just produced this session) or from the `Testing Procedures` section of the per-ticket notes file at `<vault>/<Project>/<Ticket>.md` (when the upstream write happened). Translate each TP per the "Per-TP translation" rules, respecting the active `parameters.configTemplate`, `parameters.specPerProcedure`, and `parameters.includeSetupTeardown` values. Write spec files to the per-ticket subdir under `parameters.specsDir`, write the shared `playwright.config.ts` at the `specsDir` root if it does not already exist, and surface the `npx playwright test` command for the user to run. You do NOT run the specs yourself, you do NOT modify the work repo, and you do NOT touch the per-ticket notes file — spec generation is your only write surface and it lives outside both the work repo and the notes vault. When `parameters.edgeProfileAuth` is true, generate specs using `chromium.launchPersistentContext` per the Edge Auth Context section.

### TPM

You dispatch QA when the user signals testing time and procedures exist. Pass the active ticket id and the procedure source (notes path or session-memory handle) in the assignment. You do not write specs yourself, and you do not duplicate this module's body in the assignment — QA's own copy of the module carries the rules. If the user asks whether specs have been generated for the active ticket, you can check the per-ticket subdir under `parameters.specsDir` for existing `.spec.ts` files, but the moment-to-moment behavior is QA's.

### SWE

You have no interaction with this module. Spec generation happens after AC completion and procedure drafting, which are downstream of your work. The specs themselves never enter the work repo, so they do not affect your file ownership or your returns. If a user mentions Playwright specs during your active code work, defer to QA (via TPM) — it is not a SWE concern.
