# Playwright

When this module is loaded, the tester agent gains a Playwright-spec-writing capability that turns the testing procedures produced by `tool.ac-to-testing` into runnable `.spec.ts` files. The procedures are the input; the agent is the translator; durable spec files outside the work repo are the output. Either tester agent can hold this capability: QA gets it as its normal beat, and SWE gets it when TPM or the user assigns spec-writing on an explicit request. TPM dispatches the procedures and the ticket id but does not author specs itself.

This module is **not proactive**. It does not fire at session start, and it does not fire when no testing procedures exist. It activates after `tool.ac-to-testing` has produced procedures for the active ticket; at that point the agent either offers to write specs (per `parameters.autoOfferOnProcedures`, QA's default gesture) or waits for an explicit ask.

## When you write specs

The behavior is determined by `parameters.autoOfferOnProcedures`:

- **`true`** (default): when `tool.ac-to-testing` has just added procedures to the active ticket (either through the ritual completing this session or through procedures already present in the per-ticket notes file at session start), QA offers: "Write Playwright specs for these procedures?" Do not generate without the user's go-ahead; the offer is the gate. This proactive offer is a QA flow; a SWE does not offer unprompted.
- **`false`**: specs are written only on an explicit user or TPM request ("write Playwright specs for TP-1 through TP-3", "spec out the procedures for this ticket"). No proactive offer, even when fresh procedures exist.

An explicit request can route to either agent, and SWE spec-writing is always on explicit TPM or user request rather than a self-initiated offer. Either way, the agent never writes specs in the absence of procedures. See "Module-disabled vs feature-disabled" for the no-procedures case.

## Where specs land

Specs live OUTSIDE the work repo. The root is `parameters.specsDir` (default `~/.nomeda/tests`), and per-ticket spec files land in a subdir keyed by ticket id, e.g. `~/.nomeda/tests/CMMS-1234/TP-1.spec.ts`. The shared `playwright.config.ts` sits at the `specsDir` root, not inside each per-ticket subdir, so the same config governs every ticket's specs.

The per-ticket subdir is created on demand the first time the agent writes specs for that ticket. Subsequent runs against the same ticket reuse the subdir. Specs persist across sessions; they are durable artifacts intended for re-running, not session-scoped scratch files. The work repo's git tree is never touched; the agent does not stage, commit, or otherwise interact with the work repo's VCS from this module.

If `parameters.specsDir` cannot be resolved (path expansion fails) or the directory is unwritable, see "Module-disabled vs feature-disabled" for the surfacing behavior.

## Config generation

The shape of the generated `playwright.config.ts` is determined by `parameters.configTemplate`:

### `base-url-env` (default)

Emits a config that reads `BASE_URL` from env, falling back to a documented default. The same spec runs against dev, staging, or prod by changing the env var at invocation time: `BASE_URL=https://dev.example.com npx playwright test`, `BASE_URL=https://staging.example.com npx playwright test`, etc. This matches the standard SWT pattern and is the default for cross-environment re-use.

### `hardcoded-localhost`

Emits a config with `baseURL: 'http://localhost:3000'` hardcoded. Simple, single-environment; use when the spec set is local-only and the dev-vs-staging swap is not a concern.

### `minimal`

Emits the bare-minimum exports (test directory, default browsers) and leaves `baseURL` and other settings for the user to fill in. Use when the team has a strong opinion about the config shape and the templated outputs would be more friction than help.

The agent writes `playwright.config.ts` once per `specsDir`, the first time the root is initialized. Subsequent ticket runs reuse the existing config; the agent does not overwrite it. If the user wants to switch templates, they delete the existing config and the agent regenerates it on the next run under the new `configTemplate` value.

**Video is a narrow, explicit exception to the no-overwrite rule.** Capability A's fixture-driven recording depends on `use: { video: 'on' }` being present in the shared config, so a config first written with video off could otherwise never gain video on a later run. To close that gap, whenever a video is requested for this run (per `parameters.verificationVideo`, see Capability A), the agent ENSURES video is enabled in the config it will use:

- If the shared config does not exist yet, generate it WITH `use: { video: 'on' }` included from the start.
- If the shared config already exists but lacks a `video` key (or has `video: 'off'`), PATCH it in place to set `use: { video: 'on' }`. This is a targeted, allowed update that touches only the video setting; it is distinct from and does not license the general config regeneration the no-overwrite rule forbids. Leave every other key as-is and note the patch in the run report.

This ensures a video always records when requested. The per-context `recordVideo` fallback described in Capability A covers the Edge persistent-context path, which does not read the shared config's `use.video` at all; see the page-acquisition note in Capability A for which mechanism applies to which spec.

## Spec file shape

The behavior is determined by `parameters.specPerProcedure`:

- **`true`** (default): each TP becomes its own spec file. `TP-1` becomes `TP-1.spec.ts`, `TP-2` becomes `TP-2.spec.ts`, etc., under the per-ticket subdir. Pros: parallel execution by Playwright's runner, isolated failure reporting per TP, easier to re-run a single procedure. Cons: more files to inspect at a glance.
- **`false`**: all TPs for the ticket consolidate into a single `<ticket-id>.spec.ts` (e.g. `CMMS-1234.spec.ts`), with one `test.describe` block per TP and `test()` calls inside. Pros: compact spec set, single file to inspect. Cons: failures within one TP can mask others if not scoped carefully, less parallelism.

Either way, file naming is deterministic from TP and ticket id; the agent does not invent filenames, and re-running against the same ticket overwrites the prior spec file for that TP rather than appending.

## Per-TP translation

The agent translates each TP from `tool.ac-to-testing`'s `steps-expected-edge` format (the default, and the only format with full coverage of all three primitives below) into Playwright primitives:

- **Steps** become a sequence of Playwright actions inside the `test()` body: `page.goto(...)`, `page.click(...)`, `page.fill(...)`, `page.selectOption(...)`, etc. Each numbered step becomes one or more action calls; the agent picks the appropriate selector strategy from the step text (preferring `getByRole`, `getByLabel`, and `getByText` over raw CSS selectors).
- **Expected Outcome** becomes one or more assertions at the end of the `test()` body: `expect(page.locator(...)).toBeVisible()`, `expect(page).toHaveURL(...)`, `expect(page.getByText(...)).toBeVisible()`, etc. The one-paragraph outcome statement maps to one or more `expect` calls covering the visible state described.
- **Edge Cases** become parameterized `test.describe` blocks or separate `test()` calls per edge, inside the same spec file as the happy-path test. Each edge case gets its own test body with the modified inputs (null, boundary value, permission denial, etc.) and the expected failure or alternate outcome.

When the upstream TP is in `gherkin` format (Given/When/Then), map Given to setup steps, When to the action sequence, and Then to the assertions; the structure is the same, only the source naming differs. When the upstream TP is in `steps-expected` (no Edge Cases), produce only the happy-path test; there is no edge-case block to translate.

## Setup and teardown

The behavior is determined by `parameters.includeSetupTeardown`:

- **`true`** (default): every generated spec file includes `test.beforeAll` and `test.afterAll` hooks scaffolded for common needs: browser context initialization, baseline data setup, teardown of test-created records. The hook bodies are commented stubs the user can fill in; the agent does not invent test-data fixtures from nothing. The safer default for teams that want each spec to be self-contained.
- **`false`**: spec files contain only `test()` blocks with no shared setup. The user wires setup centrally (in a fixture file, a global setup hook in `playwright.config.ts`, etc.). Use when the team has an established setup convention and per-spec hooks would be duplicative.

The setting affects every spec the agent writes in the session uniformly; do not mix scaffolded-hooks specs with bare-test specs in the same run.

## Edge Auth Context (Azure AD)

When the app under test is protected by Azure AD (or any SSO scheme that relies on a logged-in browser session), programmatic login from a spec is brittle: redirect chains, MFA prompts, conditional-access challenges, and tenant-specific quirks all break a scripted sign-in. Reusing the user's already-authenticated Edge persistent profile sidesteps SSO entirely. Playwright drives an Edge instance that already carries the user's auth cookies, session storage, and active Azure AD session, so the test runs as the logged-in user without ever touching the login form.

This section applies only when `parameters.edgeProfileAuth` is `true`. When off, generated specs use Playwright's default browser context with no SSO awareness; the spec hits the route, the app redirects to login, and the test fails or hangs on the login page. Off is fine for unauthenticated apps; on is required for Azure-AD-protected routes.

The mechanism is a swap of Playwright's launch primitive. Specs generated with `edgeProfileAuth` on use `chromium.launchPersistentContext()` instead of `chromium.launch()`, pointed at `parameters.edgeProfilePath` (or the OS-default Edge profile when the path is empty), with `channel: parameters.authChannelOverride` (default `msedge`). The persistent profile is the same on-disk directory the user's daily Edge browser uses, so any session the user has already established (Azure AD, M365, internal SaaS) is live in the Playwright-driven Edge instance from the first navigation.

The spec snippet the agent bakes in when `edgeProfileAuth` is true:

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

Important caveats; surface these in generated spec comments and respect them at generation time:

- Only ONE Playwright instance can use the Edge profile at a time. The persistent profile is a single-writer resource; close other Edge windows before running specs, otherwise Playwright errors out on profile lock contention.
- Tests must run headed (`headless: false`) for some SSO redirects to work. Headless mode loses the ability to render certain Azure AD conditional-access UIs, and the redirect chain can silently fail. Emit the `headless: false` line in every auth-context spec and add an inline comment noting why.
- Auth state persists between test runs because cookies and session storage live inside the profile directory. For clean-slate testing (e.g. verifying first-login behavior), the user creates a separate test-only Edge profile and points `edgeProfilePath` at it, leaving their daily profile untouched.
- DO NOT commit the Edge profile path to shared specs. The path is machine-local: different OS, different user, different layout. The `EDGE_PROFILE_PATH` env-var fallback in the snippet keeps the literal value out of source control; teammates set the env var on their own machines without touching the spec.

What this section does NOT do:

- Does NOT install or configure Microsoft Edge; Edge must already be installed and the user must already be signed in to their Azure AD tenant in that Edge.
- Does NOT manage the user's Azure AD session; it relies on the user's existing login, including any MFA or conditional-access state the user has already cleared interactively.
- Does NOT work on Linux without an Edge install. Edge-on-Linux is available but uncommon; on a Linux machine without Edge, the spec fails to launch the browser. Fall back to `edgeProfileAuth` off and skip Azure-AD-protected routes on those platforms.

## Verification package (ticket work)

During ticket or project work the tester's role widens past spec authoring: on request it verifies the active ticket works as intended and produces a shareable verification package that a reviewer or PO can consume without reading the specs. The package has up to three parts under one per-ticket directory: the specs (always), an annotated verification video (Capability A), and an AC walkthrough doc (Capability B).

Both capabilities are TICKET-WORK-ONLY: a ticket id must be in scope (from `mode.ticket-work` or an explicit id). Absent a ticket id, neither fires. Both are REQUEST-DRIVEN by default, gated by their own settings:

- `parameters.verificationVideo`: `on-request` (default) produces a video only when the user or TPM asks, `always` produces one whenever specs are generated during ticket work, `off` never produces one.
- `parameters.acWalkthrough`: `on-request` (default) writes the walkthrough only when asked, `always` writes one whenever specs are generated during ticket work, `off` never writes one.

The `always` variants auto-produce during ticket-work spec generation; the `on-request` variants wait for an explicit ask. Neither replaces the spec-writing gate above; they extend it.

### Capability A: annotated verification video

The tester records a Playwright video of the AC flow with on-screen text narration, so a watcher understands each step without reading the spec. Two mechanisms combine:

1. Enable Playwright's native video recording. There are two mechanisms and the correct one depends on how the spec acquires its `page` (see "Page acquisition for annotated-video specs" below): for fixture-driven specs, recording comes from `use: { video: 'on' }` in the shared `playwright.config.ts` (the agent ensures this key is present per the video exception in the "Config generation" section); for Edge persistent-context specs, recording comes from the per-context `recordVideo` option passed to `launchPersistentContext`, which does not consult the shared config. Either way, raw `.webm` files land under `<specsDir>/<TICKET>/videos/`.
2. When `parameters.annotateVideoSteps` is true, wrap each action group in `test.step('<human description>', ...)` and, at the start of the step, render a fixed-position caption banner in the page that displays the step text. Because the banner is part of the rendered page, it is captured in the recording, giving a self-explaining narrated video. When `annotateVideoSteps` is false, video records with no overlay.

Copyable helper the tester bakes into annotated specs:

```typescript
async function annotate(page, text) {
  await page.evaluate((label) => {
    let el = document.getElementById('nomeda-annotation');
    if (!el) {
      el = document.createElement('div');
      el.id = 'nomeda-annotation';
      el.style.cssText = [
        'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:2147483647',
        'padding:14px 20px', 'background:rgba(0,0,0,0.82)', 'color:#fff',
        'font:600 18px/1.4 system-ui,sans-serif', 'text-align:center',
        'pointer-events:none',
      ].join(';');
      document.body.appendChild(el);
    }
    el.textContent = label;
  }, text);
}
```

Usage inside a test, one `test.step` per AC step, calling `annotate` first so the banner shows before the action is recorded:

```typescript
test('CMMS-1234 AC-1 happy path', async ({ page }) => {
  await test.step('Open the work order list', async () => {
    await annotate(page, 'Step 1: open the work order list');
    await page.goto('/work-orders');
  });
  await test.step('Create a new work order', async () => {
    await annotate(page, 'Step 2: create a new work order');
    await page.getByRole('button', { name: 'New' }).click();
  });
});
```

**Page acquisition for annotated-video specs.** A spec must acquire its `page` from exactly ONE source; never mix the injected fixture with a self-built context in the same spec, or you produce two conflicting `page`s. Pick the source by whether Edge auth is on:

- **`parameters.edgeProfileAuth` off (default):** use the injected fixture, `test('...', async ({ page }) => { ... })`, exactly as the annotate example above shows. Video comes from the shared config's `use: { video: 'on' }`. Do NOT build your own context.
- **`parameters.edgeProfileAuth` on:** use the Edge persistent context from the "Edge Auth Context" section: build the page with `chromium.launchPersistentContext(userDataDir, {...}).newPage()` and do NOT also destructure `{ page }` from the fixture. When a video is also requested, enable recording on THAT context via the per-context `recordVideo` option rather than relying on the shared config, since a persistent context does not read `use.video`:

  ```typescript
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: '<parameters.authChannelOverride>',
    headless: false,  // headed required for some SSO redirects
    recordVideo: { dir: '<specsDir>/<TICKET>/videos/' },
  });
  const page = await context.newPage();
  ```

  Pass this single `page` to `annotate(page, ...)` and every `test.step` action, so Edge-auth and video compose on one page with no fixture conflict. Close the context at the end of the run so the `.webm` is flushed.

The tester references the produced `.webm` paths under `<specsDir>/<TICKET>/videos/` in its report so the reviewer can find them.

A recording run drives a real, often headed browser, so the tester agent (or TPM) should periodically check that a long run has not stalled: a spec hung on a selector that never appears, a browser blocked on an SSO or login prompt, or an idle headed session that never exits. If there is no forward progress, treat the run as failed and kill and retry it or surface it to TPM or the user rather than letting the hung wait hang the session.

### Capability B: AC walkthrough doc

The tester writes a human-readable, step-by-step walkthrough of the acceptance criteria to `<specsDir>/<TICKET>/AC-walkthrough.md`, co-located with the specs and videos as one verification package. A person can follow it to verify the ticket by hand, and it doubles as the narration script for the video.

Content shape: one titled section per AC item, each with

- numbered steps in plain reviewer-friendly language (what to click, what to enter),
- the expected result for that item,
- any preconditions or test data needed to run it.

The walkthrough maps 1:1 to the active ticket's AC as covered by the procedures from `tool.ac-to-testing`. Do NOT invent AC beyond what the ticket or procedures cover. The tester reports the `AC-walkthrough.md` path.

The whole verification package (specs, `videos/`, `AC-walkthrough.md`) lives together under `<specsDir>/<TICKET>/`, outside the work repo. The tester never touches the work repo or its git tree when producing any part of it.

## What the agent does NOT do

The boundaries below are explicit; do not cross them:

- **Does NOT run the generated specs.** The agent writes the files and surfaces the command (`cd <specsDir> && npx playwright test`, or scoped to a single file with `npx playwright test <ticket-id>/TP-1.spec.ts`). The user runs the specs themselves.
- **Does NOT modify the work repo.** Specs live outside the work repo per `parameters.specsDir`. No files are written into the work repo's tree, no `package.json` changes, no `.gitignore` edits; the work repo is untouched.
- **Does NOT auto-update specs when procedures change.** Procedures evolving in the per-ticket notes do not trigger a spec rewrite. If procedures are revised, the user re-runs the spec-writing flow on demand; the agent regenerates the affected spec files at that point.
- **Does NOT install Playwright** or modify the project's dependency graph. The user is expected to have Playwright installed in their environment; the agent surfaces `npm install -D @playwright/test` once if the user signals it's missing, but never runs the install itself.
- **Does NOT handle authentication for non-Edge browsers.** Auth context is Edge-specific via the user's persistent profile. Firefox, WebKit, and stock Chromium have no equivalent profile-reuse path in this module; specs against Azure-AD-protected routes on those browsers are out of scope.

## Module-disabled vs feature-disabled

These are distinct states and must produce distinct behavior:

- **Module disabled** (no `tool.playwright` in the Session Manifest): no Playwright specs are written. Testing procedures from `tool.ac-to-testing` stay manual; they are the testing contract as-is, executed by hand. Ad-hoc help is still fine if the user asks, but there is no structured spec-writing flow and no auto-offer on fresh procedures.
- **Module enabled, `parameters.autoOfferOnProcedures` off**: the module exists but no auto-offer is made. Specs are written only on explicit user or TPM request.
- **Module enabled, no procedures available**: respond "No testing procedures found; run `tool.ac-to-testing` first." Do not fabricate procedures, and do not write specs from the AC items directly; the upstream ritual is the procedure source, not the agent's improvisation.
- **Module enabled, `parameters.specsDir` unwritable** (path expansion fails, directory not writable, disk full, etc.): surface the write failure once ("Specs Dir `<path>` is not writable; specs cannot be written. Choose an alternate path in the Modules tab or unblock the current one."), and do not retry until the user signals the issue is fixed.
- **Module enabled, `parameters.edgeProfileAuth` off**: specs use Playwright's default browser context with no SSO awareness. Routes behind Azure AD redirect to login and the test fails or hangs; this is expected, not a bug. Users testing protected apps must toggle the setting on.
- **Module enabled, `parameters.edgeProfileAuth` on, `parameters.edgeProfilePath` invalid** (path does not exist, profile directory unreadable, profile locked by another Edge process): surface the path failure once ("Edge Profile Path `<path>` is not usable; auth-context specs cannot be generated. Verify the path, close other Edge windows, or toggle Edge Profile Auth off."), and fall back to off-mode generation (default browser context, no SSO) for the remainder of the run.

Do not merge these cases.

## Sibling-module interaction

- **`tool.ac-to-testing`** (required upstream): produces the testing procedures this module consumes. Without it, there is no procedure source and the auto-offer never fires. The two modules form a writer/reader pair: ac-to-testing writes procedures to the per-ticket notes (or session memory when `writeToNotes` is off), this module reads them.
- **`mode.ticket-work`**: informs the active ticket id, which becomes the per-ticket spec-subdir name under `specsDir` and the consolidated spec filename when `specPerProcedure` is off. Without `mode.ticket-work` and an active ticket, the agent prompts the user for an explicit ticket id before writing.
- **`tool.obsidian-notes`**: the source of the per-ticket notes file the agent reads procedures from when `tool.ac-to-testing`'s `writeToNotes` was on. When procedures live in session memory only (writeToNotes off), the agent reads them from session state for the same session; cross-session re-runs require the notes write.

## Role-Specific Notes

The body above applies to whichever tester agent holds this capability; this module's fragment targets QA and SWE. The notes below frame each role's relationship to spec-writing.

### QA

You own spec generation as your normal beat, including the proactive offer when `parameters.autoOfferOnProcedures` is on. Read testing procedures either from session memory (when `tool.ac-to-testing`'s `writeToNotes` was off and the procedures were just produced this session) or from the `Testing Procedures` section of the per-ticket notes file at `<vault>/<Project>/<Ticket>.md` (when the upstream write happened). Translate each TP per the "Per-TP translation" rules, respecting the active `parameters.configTemplate`, `parameters.specPerProcedure`, and `parameters.includeSetupTeardown` values. Write spec files to the per-ticket subdir under `parameters.specsDir`, write the shared `playwright.config.ts` at the `specsDir` root if it does not already exist, and surface the `npx playwright test` command for the user to run. You do NOT run the specs yourself, you do NOT modify the work repo, and you do NOT touch the per-ticket notes file; spec generation is your only write surface and it lives outside both the work repo and the notes vault. When `parameters.edgeProfileAuth` is true, generate specs using `chromium.launchPersistentContext` per the Edge Auth Context section.

### TPM

You dispatch spec-writing when the user signals testing time and procedures exist. Pass the active ticket id and the procedure source (notes path or session-memory handle) in the assignment, and name the agent (QA by default, or a SWE when you are explicitly routing spec-writing to the coder). You do not write specs yourself, and you do not duplicate this module's body in the assignment; the assigned agent's own copy of the module carries the rules. If the user asks whether specs have been generated for the active ticket, you can check the per-ticket subdir under `parameters.specsDir` for existing `.spec.ts` files, but the moment-to-moment behavior is the assigned agent's.

### SWE

You gain this capability on an explicit TPM or user request to write specs; you do NOT proactively offer, that gesture is QA's. When assigned, you follow the same mechanics as QA: read the procedures from session memory or the per-ticket notes file, translate each TP per the "Per-TP translation" rules against the active `parameters.*` values, write spec files to the per-ticket subdir under `parameters.specsDir`, write the shared `playwright.config.ts` at the `specsDir` root if it does not exist, and surface the `npx playwright test` command. The specs live outside the work repo, so writing them does not touch your file ownership or your code returns; you do NOT run the specs, you do NOT stage or commit them, and you do NOT modify the work repo from this module. When `parameters.edgeProfileAuth` is true, generate specs using `chromium.launchPersistentContext` per the Edge Auth Context section. Absent an explicit spec-writing assignment, treat Playwright specs as QA's beat and defer via TPM.
