# Playwright

When this module is loaded, the tester agent gains a Playwright-spec-writing capability that turns the testing procedures produced by `tool.ac-to-testing` into runnable `.spec.ts` files. The procedures are the input; the agent is the translator; durable spec files outside the work repo are the output. Either tester agent can hold this capability: QA gets it as its normal beat, and SWE gets it when TPM or the user assigns spec-writing on an explicit request. TPM dispatches the procedures and the ticket id but does not author specs itself.

This module is **not proactive**. It does not fire at session start, and it does not fire when no testing procedures exist. It activates after `tool.ac-to-testing` has produced procedures for the active ticket; at that point the agent either offers to write specs (per `parameters.autoOfferOnProcedures`, QA's default gesture) or waits for an explicit ask.

## When you write specs

The behavior is determined by `parameters.autoOfferOnProcedures`:

- **`true`** (default): when `tool.ac-to-testing` has just added procedures to the active ticket (either through the ritual completing this session or through procedures already present in the per-ticket notes file at session start), QA offers: "Write Playwright specs for these procedures?" Do not generate without the user's go-ahead; the offer is the gate. This proactive offer is a QA flow; a SWE does not offer unprompted.
- **`false`**: specs are written only on an explicit user or TPM request ("write Playwright specs for TP-1 through TP-3", "spec out the procedures for this ticket"). No proactive offer, even when fresh procedures exist.

An explicit request can route to either agent, and SWE spec-writing is always on explicit TPM or user request rather than a self-initiated offer. Either way, the agent never writes specs in the absence of procedures. See "Module-disabled vs feature-disabled" for the no-procedures case.

## Where specs land

Specs live OUTSIDE the work repo, under a two-level path: a **repo scope** segment, then the ticket id.

```
<specsDir>/<scope>/<TICKET>/
```

`<specsDir>` is `parameters.specsDir` (default `~/.ghola/tests`). `<scope>` is `<basename>-<shortHash>`, where `<basename>` is the work repo's directory name and `<shortHash>` is the first 12 hex chars of sha256 over the repo's ABSOLUTE path. So a ticket's specs land at e.g. `~/.ghola/tests/cmms0-2f44a92693f1/CMMS-1234/TP-1.spec.ts`.

The scope exists because the operator runs multiple repositories concurrently, each with its own isolated live stack. Without it, two repos share one spec namespace, one config, and one output directory, and concurrent sessions read each other's results. The basename keeps the tree readable when browsing by hand; the hash keeps sibling clones of the same project (`cmms0`, `cmms1`) from colliding, and it is the same 12-hex-sha256 scheme Ghola already uses to give each workspace its own composed-prompt file.

**Deriving the scope.** The agent computes it itself, once, at the start of any run that touches this module, and reuses that one value for every path in the run:

```bash
GHOLA_PW_SCOPE="$(node -e "const c=require('crypto'),p=require('path'),r=process.argv[1];process.stdout.write(p.basename(r)+'-'+c.createHash('sha256').update(r).digest('hex').slice(0,12))" "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")"
```

`git rev-parse --show-toplevel` is used rather than a bare `pwd` so the value is identical whether the agent is sitting at the repo root or in a subdirectory; it falls back to `pwd` when the work dir is not a git repo. The path it returns is already absolute and canonical, with no trailing slash — do not normalize it further, and do not hash a `/mnt/c` path in one session and a `C:\` path in another for the same repo, or you will produce two scopes for one repo. Never hand-write a scope, never reuse a scope you saw in a previous session's report, and never derive it from the ticket id or the branch.

The scope dir and the per-ticket subdir under it are created on demand the first time the agent writes specs for that ticket. Subsequent runs against the same ticket reuse them. Specs persist across sessions; they are durable artifacts intended for re-running, not session-scoped scratch files. The work repo's git tree is never touched; the agent does not stage, commit, or otherwise interact with the work repo's VCS from this module.

If `parameters.specsDir` cannot be resolved (path expansion fails) or the directory is unwritable, see "Module-disabled vs feature-disabled" for the surfacing behavior.

## Where run output lands

The scope is per-REPO, which is the right grain for durable artifacts and the wrong grain for run output. Two sessions open in the SAME repo at the same time resolve to one identical scope, so if run output lived directly under the scope they would overwrite each other's `test-results/`, fight over one `playwright-report/`, and contend on one Edge profile lock. Run output therefore gets a second, finer segment: the **session**.

```
<specsDir>/<scope>/                      <- durable, per REPO
├── playwright.config.ts                 <- one per scope, written once
├── <TICKET>/
│   ├── TP-1.spec.ts                     <- specs persist across sessions
│   └── AC-walkthrough.md
└── runs/
    └── <session>/                       <- ephemeral, per SESSION
        ├── test-results/
        ├── playwright-report/
        └── videos/<TICKET>/
```

The split is deliberate and the two halves must not be swapped. Specs, the config, and the AC walkthrough are durable per-ticket deliverables the operator re-runs and re-reads across sessions; scoping them per session would fragment the spec tree into a pile of near-duplicate copies and destroy the persistence that is their whole point. `test-results/`, `playwright-report/`, and `videos/` are per-run byproducts, regenerated wholesale by every invocation, and are exactly what collides.

**Deriving the session segment.** `<session>` is the value of the `GHOLA_SESSION_ID` environment variable, exported by Ghola's session launcher. It is generated fresh at every launch, so two sessions opened concurrently in one repo hold different values, and it stays constant for that session's lifetime, so every path the agent builds during the run agrees.

```bash
GHOLA_PW_SESSION="${GHOLA_SESSION_ID:-}"
```

Do NOT substitute the hash embedded in `$GHOLA_SWE_PROMPT_FILE`, `$GHOLA_QA_PROMPT_FILE`, or `$GHOLA_TPM_PROMPT_FILE` for this value. That suffix is a hash of the WORKSPACE FOLDER, not of the session: every session opened in a given repo produces the identical suffix, so keying run output on it would reproduce the exact collision this segment exists to prevent. `GHOLA_SESSION_ID` is the only per-session value available; nothing else in the environment distinguishes two sessions in one repo.

**When `GHOLA_SESSION_ID` is unset** — an agent running outside a Ghola-launched terminal, or a terminal launched by a Ghola build predating the variable — the module degrades to the per-repo behavior: run output goes to the shared `<specsDir>/<scope>/runs/shared/`. This degradation is NEVER silent. The agent says once, in its report: "GHOLA_SESSION_ID is unset, so run output is going to the shared per-repo dir `<specsDir>/<scope>/runs/shared/`. A second concurrent run in this repo will overwrite it." The generated config emits the equivalent warning at run time (see "Config generation"). A shared directory entered knowingly is a tolerable fallback; a shared directory entered silently is the contamination bug itself.

### Specs written before the scope layout existed

Earlier versions of this module wrote to `<specsDir>/<TICKET>/` with no scope segment, and put a single `playwright.config.ts` at the `specsDir` root. Those files are not migrated automatically and this module never moves or deletes them — they are simply orphaned: nothing under the new layout reads them.

The operator recognizes them by shape: any directory directly under `<specsDir>` whose name is a ticket id (`CMMS-1234`) rather than a `<basename>-<12 hex>` scope, plus a `playwright.config.ts`, `test-results/`, or `playwright-report/` sitting at the `specsDir` root. To adopt them, the operator derives the scope for the owning repo with the one-liner above, creates `<specsDir>/<scope>/`, and moves the ticket directories into it by hand; the agent regenerates a per-scope config on the next run. The root-level `playwright.config.ts` should be left behind or removed by the operator — the new layout never reads it. If the operator cannot tell which repo an orphaned ticket dir belonged to, the spec contents (the `baseURL` in the old root config, the routes under test) are the only evidence; the agent should say so rather than guess.

## Config generation

There is ONE `playwright.config.ts` per scope, at `<specsDir>/<scope>/playwright.config.ts` — not at the `specsDir` root. Each repo's config is its own file, so the first repo to initialize cannot dictate `baseURL`, browsers, reporters, or video for every repo after it, and an in-place patch to one repo's config can never touch a config another repo's live session is reading.

Every generated config MUST pin its output paths inside the current session's run dir, so concurrent runs — whether in different repos or in the same one — cannot overwrite each other's results:

```typescript
const sessionId = process.env.GHOLA_SESSION_ID;
if (!sessionId) {
  console.warn(
    '[ghola] GHOLA_SESSION_ID is unset; run output falls back to the shared ' +
      'per-repo dir ./runs/shared. A concurrent run in this repo will overwrite it.'
  );
}
const runDir = `./runs/${sessionId || 'shared'}`;

export default defineConfig({
  testDir: '.',
  outputDir: `${runDir}/test-results`,
  reporter: [['html', { outputFolder: `${runDir}/playwright-report`, open: 'never' }]],
  use: { baseURL: /* per template, see below */ },
});
```

The session is read from the environment at run time rather than baked in as a literal, and that is load-bearing: the config is written ONCE per scope and never regenerated (see the no-overwrite rule below), so a hardcoded session id would pin every future run in that repo to the id of whichever session happened to create the file. Reading `process.env` keeps one durable config correct for every session that ever uses it.

`outputDir` and `outputFolder` are resolved relative to the config file, so both land under `<specsDir>/<scope>/runs/<session>/`. `open: 'never'` is mandatory: it stops the run from auto-serving the report, which sidesteps the port-9323 collision that would otherwise make two concurrent runs fight over one port. The operator views a report manually afterward with `npx playwright show-report <specsDir>/<scope>/runs/<session>/playwright-report` (add `--port <n>` when viewing two reports at once). The agent reports the fully expanded path, with both the scope and the session segment spelled out, so the operator never has to guess which run a report belongs to.

The `console.warn` is not decoration. It is the run-time half of the never-silently-share rule: an agent's report covers the session that generated the specs, but the operator may re-run that config months later from a plain shell with no `GHOLA_SESSION_ID` set, and the warning is what tells them their output is landing in a shared directory.

### `BASE_URL` is mandatory — there is no default

The module NEVER guesses a base URL. A guessed URL is the worst failure mode available here: `http://localhost:3000` is a plausible address for *every* repo the operator runs, so a wrong guess silently drives repo B's specs against repo A's live stack and reports the results as if they were repo B's. If no base URL is available for the run, the agent REFUSES and tells the operator: "No BASE_URL for this session. Set `BASE_URL=<url>` for the run (or supply the URL to hardcode); this module will not guess one." Do not proceed, do not substitute a default, do not infer a URL from the repo name, the port a dev server happens to be on, or another scope's config.

The shape of the generated config is determined by `parameters.configTemplate`:

### `base-url-env` (default)

Emits a config that reads `BASE_URL` from env with **no fallback**, and fails loudly when it is unset:

```typescript
const baseURL = process.env.BASE_URL;
if (!baseURL) {
  throw new Error('BASE_URL is required. Set it for this run, e.g. BASE_URL=https://dev.example.com npx playwright test');
}
```

The same spec set runs against dev, staging, or prod by changing the env var at invocation time: `BASE_URL=https://dev.example.com npx playwright test`, etc. The throw is the enforcement mechanism — it makes an unset `BASE_URL` a hard, immediate, unmistakable failure instead of a silent redirection to whatever `localhost:3000` currently belongs to.

### `hardcoded-base-url`

Emits a config with an explicit, operator-supplied URL literal, e.g. `baseURL: 'https://cmms0.dev.example.com'`. Use when the scope is pinned to exactly one environment and the env-var dance is friction. The agent MUST obtain the literal from the operator before generating; there is no default value for it. `hardcoded-localhost` is accepted as a legacy alias for this template — it no longer emits `http://localhost:3000` and it, too, requires an operator-supplied URL. If a saved setting still reads `hardcoded-localhost`, treat it as `hardcoded-base-url` and tell the operator the key was repointed.

### `minimal`

Emits the bare-minimum exports (test directory, default browsers) plus the session-pinned `outputDir` and reporter block above, and leaves `baseURL` for the user to fill in. Use when the team has a strong opinion about the config shape and the templated outputs would be more friction than help. The output pinning is not optional even here — it is what keeps concurrent runs from clobbering each other.

The agent writes `playwright.config.ts` once per SCOPE, the first time that scope is initialized. Subsequent ticket runs within the same scope reuse the existing config; the agent does not overwrite it. A different repo gets a different scope and therefore its own first-write. If the user wants to switch templates, they delete that scope's config and the agent regenerates it on the next run under the new `configTemplate` value.

**Video is a narrow, explicit exception to the no-overwrite rule.** Capability A's fixture-driven recording depends on `use: { video: 'on' }` being present in the config, so a config first written with video off could otherwise never gain video on a later run. To close that gap, whenever a video is requested for this run (per `parameters.verificationVideo`, see Capability A), the agent ENSURES video is enabled in **its own scope's** config:

- If the scope's config does not exist yet, generate it WITH `use: { video: 'on' }` included from the start.
- If the scope's config already exists but lacks a `video` key (or has `video: 'off'`), PATCH it in place to set `use: { video: 'on' }`. This is a targeted, allowed update that touches only the video setting; it is distinct from and does not license the general config regeneration the no-overwrite rule forbids. Leave every other key as-is and note the patch in the run report.

The patch target is always `<specsDir>/<scope>/playwright.config.ts` and never a config outside the current scope. This is what makes the in-place patch safe under concurrency: the file being mutated is read by this repo's sessions only, so no other repo's live run can observe a half-written config or wake up with video silently switched on.

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

The mechanism is a swap of Playwright's launch primitive. Specs generated with `edgeProfileAuth` on use `chromium.launchPersistentContext()` instead of `chromium.launch()`, pointed at `parameters.edgeProfilePath`, with `channel: parameters.authChannelOverride` (default `msedge`).

**The profile directory is per-session.** `parameters.edgeProfilePath` defaults to `~/.ghola/edge-profiles/<scope>/<session>`, where `<scope>` and `<session>` are the same values derived in "Where specs land" and "Where run output lands". The agent expands both tokens before use; a path the operator set with neither token is used as the literal it is, and the profile is then shared by everything pointed at it. An Edge persistent profile is a single-writer resource, so any two runs sharing a directory means the second hard-fails on profile lock contention — per-session is the only grain at which two concurrent runs in ONE repo can both launch Edge.

**The honest tradeoff, and it is a real one: a per-session profile starts EMPTY, every session.** It is not the user's daily Edge profile, so no Azure AD, M365, or internal-SaaS session is live in it, and unlike the previous per-scope default the sign-in does NOT carry over to the next session — **the operator signs in interactively on every session's first headed run**. That is the price of concurrent Edge runs in one repo, and the agent states it plainly when generating auth-context specs rather than letting the operator discover it at the login prompt.

Two documented escape hatches, both operator choices the agent surfaces rather than makes:

- **Sign in once per repo, run Edge serially.** Set `edgeProfilePath` to `~/.ghola/edge-profiles/<scope>` — the `<scope>` token with no `<session>` token. Auth then persists across that repo's sessions exactly as before, and only one session at a time may run Edge specs. Correct when the operator runs concurrent sessions but only ever drives Edge from one of them.
- **Reuse the daily profile.** Set an explicit literal path to the OS-default Edge profile. Existing sign-in, no interactive step at all, and only one session anywhere may use it.

Note the asymmetry these hatches expose: everything else in this module can be isolated per session for free, but browser auth cannot, because the auth state IS the durable thing worth keeping. Isolation and persistence are genuinely in tension here, and the operator picks which one they want.

What this does NOT establish: that concurrent Edge runs are fully safe. Separate profile directories remove the lock contention on the profile itself, which is the failure this module observed. Whether two headed Edge instances of the same channel coexist cleanly beyond that — shared singleton sockets, crash-recovery state, OS-level per-user Edge behavior — has not been verified here, and moving from per-scope to per-session profiles does not make it more likely, it only makes the contention possible to hit in one repo instead of two. Treat concurrent Edge-auth runs as plausible but unproven, and if a second run fails to launch, run them serially.

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

- Only ONE Playwright instance can use a GIVEN Edge profile directory at a time. The persistent profile is a single-writer resource. With the per-session default each session has its own directory, so neither two repos nor two concurrent sessions in one repo contend with each other. Contention remains where a directory is genuinely shared: two runs inside the SAME session, any setup using one of the escape-hatch paths above, and a profile the user's own daily Edge has open, which that Edge holds locked. Close other windows using that profile before running specs.
- Tests must run headed (`headless: false`) for some SSO redirects to work. Headless mode loses the ability to render certain Azure AD conditional-access UIs, and the redirect chain can silently fail. Emit the `headless: false` line in every auth-context spec and add an inline comment noting why.
- Auth state persists between test runs WITHIN a session, because cookies and session storage live inside the profile directory and the per-session default keeps that directory alive for the session's lifetime. It does not persist into the NEXT session, which gets a fresh empty directory — see the tradeoff above. Clean-slate testing (e.g. verifying first-login behavior) is therefore the default behavior on each session's first run rather than something to arrange; a user who instead wants a durable test-only profile points `edgeProfilePath` at an explicit literal path, leaving their daily profile untouched.
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

1. Enable Playwright's native video recording. There are two mechanisms and the correct one depends on how the spec acquires its `page` (see "Page acquisition for annotated-video specs" below): for fixture-driven specs, recording comes from `use: { video: 'on' }` in the scope's `playwright.config.ts` (the agent ensures this key is present per the video exception in the "Config generation" section); for Edge persistent-context specs, recording comes from the per-context `recordVideo` option passed to `launchPersistentContext`, which does not consult the config. Either way, raw `.webm` files land under the current session's run dir, `<specsDir>/<scope>/runs/<session>/videos/<TICKET>/`. Videos are per-run output, not durable deliverables: a fixture-driven run writes them beneath the session's `outputDir` automatically, and the Edge path must be pointed at the session run dir explicitly because `recordVideo.dir` takes a literal.
2. When `parameters.annotateVideoSteps` is true, wrap each action group in `test.step('<human description>', ...)` and, at the start of the step, render a fixed-position caption banner in the page that displays the step text. Because the banner is part of the rendered page, it is captured in the recording, giving a self-explaining narrated video. When `annotateVideoSteps` is false, video records with no overlay.

Copyable helper the tester bakes into annotated specs:

```typescript
async function annotate(page, text) {
  await page.evaluate((label) => {
    let el = document.getElementById('ghola-annotation');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ghola-annotation';
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
    recordVideo: { dir: '<specsDir>/<scope>/runs/<session>/videos/<TICKET>/' },
  });
  const page = await context.newPage();
  ```

  Pass this single `page` to `annotate(page, ...)` and every `test.step` action, so Edge-auth and video compose on one page with no fixture conflict. Close the context at the end of the run so the `.webm` is flushed.

The tester references the produced `.webm` paths under `<specsDir>/<scope>/runs/<session>/videos/<TICKET>/` in its report so the reviewer can find them, with the scope and session segments spelled out in full.

**Artifact path discipline (hard rule).** Every read, reference, and report of a Playwright artifact must be qualified to the right grain, and the two grains differ:

- **Durable artifacts** — specs and `AC-walkthrough.md` — are scope-qualified. The agent reads and reports them from its own repo's scope, and only from there.
- **Run output** — `test-results/`, `playwright-report/`, `videos/` — is scope-AND-session-qualified. The agent reads and reports these only from `<specsDir>/<scope>/runs/<session>/` for its own session.

The agent NEVER lists, globs, reads, or reports anything from a bare `<specsDir>/`, and never from a scope other than the one it derived for its own repo. A path from another scope belongs to another repo's concurrent session; reading it means reporting another stack's results as this ticket's, which is the exact contamination this layout exists to prevent. The same applies one level down: a sibling directory under `runs/` belongs to a different session, possibly one running RIGHT NOW against different code, and its `test-results/` is not evidence about this run. Do not read another session's run dir to fill a gap in your own — if this session's output is missing, say it is missing. If a run turns up an artifact outside the current scope or outside the current session's run dir, do not open it — say that it is out of scope and stop.

A recording run drives a real, often headed browser, so the tester agent (or TPM) should periodically check that a long run has not stalled: a spec hung on a selector that never appears, a browser blocked on an SSO or login prompt, or an idle headed session that never exits. If there is no forward progress, treat the run as failed and kill and retry it or surface it to TPM or the user rather than letting the hung wait hang the session.

### Capability B: AC walkthrough doc

The tester writes a human-readable, step-by-step walkthrough of the acceptance criteria to `<specsDir>/<scope>/<TICKET>/AC-walkthrough.md`, co-located with the specs and videos as one verification package. A person can follow it to verify the ticket by hand, and it doubles as the narration script for the video.

Content shape: one titled section per AC item, each with

- numbered steps in plain reviewer-friendly language (what to click, what to enter),
- the expected result for that item,
- any preconditions or test data needed to run it.

The walkthrough maps 1:1 to the active ticket's AC as covered by the procedures from `tool.ac-to-testing`. Do NOT invent AC beyond what the ticket or procedures cover. The tester reports the `AC-walkthrough.md` path.

The verification package spans both grains, and the tester reports both paths so the reviewer can find every part. Its durable half — the specs and `AC-walkthrough.md` — lives under `<specsDir>/<scope>/<TICKET>/` and survives the session. Its recorded half — the `.webm` files — lives under `<specsDir>/<scope>/runs/<session>/videos/<TICKET>/` and is a byproduct of the run that produced it. Both sit outside the work repo, and the tester never touches the work repo or its git tree when producing any part of the package. If the operator wants a video kept permanently alongside the walkthrough, they copy it out of the run dir themselves; the agent does not move files between the two halves.

## Concurrent sessions

This module supports concurrent Playwright sessions both ACROSS repositories and WITHIN one repository, running at the same time against separate live stacks. Two segments make that safe, at two different grains, and it matters which does which.

Isolated per SCOPE (per repo) — durable, shared deliberately by every session working that repo:

- **Spec tree** — `<specsDir>/<scope>/<TICKET>/`, so two repos never share a ticket namespace. Two sessions in ONE repo do share it, which is intended: the specs are the ticket's durable artifact, and a second session working the same ticket should see and re-run the first session's specs, not a private copy of them.
- **Config** — one `playwright.config.ts` per scope, so no first-writer-wins on `baseURL`, browsers, or reporters across repos, and the video patch mutates only the patching repo's file. Shared by that repo's sessions on purpose; it resolves the session at run time so sharing it costs nothing.
- **AC walkthrough** — `<specsDir>/<scope>/<TICKET>/AC-walkthrough.md`, durable alongside the specs it narrates.

Isolated per SESSION (per run) — the things that actually collide:

- **Output dir** — `outputDir: ./runs/<session>/test-results` resolved against the scope's config.
- **Report dir** — `outputFolder: ./runs/<session>/playwright-report`, with `open: 'never'` so no run tries to bind port 9323.
- **Videos** — `<specsDir>/<scope>/runs/<session>/videos/<TICKET>/`.
- **Edge profile** — `~/.ghola/edge-profiles/<scope>/<session>` by default, so the single-writer profile lock is contended neither between repos nor between concurrent sessions in one repo (with the caveats and the persistence tradeoff in "Edge Auth Context").

Independent of both segments:

- **`BASE_URL`** — supplied per run and never defaulted, so no run can inherit or guess another run's stack URL.
- **Run command** — rooted at the scope dir, so a run cannot reach another repo's specs.

Still shared, and safe to share:

- **Playwright browser binaries** (`PLAYWRIGHT_BROWSERS_PATH`, default `~/.cache/ms-playwright`) — read-only at run time. Concurrent runs only execute these binaries; nothing writes to that tree except an explicit `npx playwright install`, which the agent never runs. Sharing them is what keeps this layout from costing a browser download per repo.
- **The `specsDir` root itself** — a container only. Scopes are siblings inside it; nothing is written at the root by the new layout.

**Earlier versions of this module warned that two concurrent runs of the same scope collide on the output dirs and the Edge profile, and instructed one run per scope at a time. That warning is obsolete — closing it is what the session segment is for.** Do not reinstate it, and do not tell the operator to serialize runs within a repo on those grounds.

What remains genuinely unsafe, and what the session segment does NOT fix:

- **Two runs inside ONE session.** They share a session id and therefore share the run dir and the Edge profile directory. Run them serially.
- **The application under test.** Two sessions in one repo pointed at the same `BASE_URL` drive the same live stack and the same database. Their Playwright artifacts stay separate; their test DATA does not, and one run's fixture teardown can delete records the other run is asserting on. Isolating output directories does nothing about this — give concurrent runs in one repo separate stacks, or accept the interference knowingly.
- **The spec files themselves.** Two sessions writing specs for the same ticket write to the same paths, and the last writer wins. This is the flip side of keeping specs durable and shared.
- **`GHOLA_SESSION_ID` unset.** Every session missing the variable falls back to the same `runs/shared/` dir and collides with every other such session. The warning is the mitigation; there is no isolation without the variable.

The boundaries below are explicit; do not cross them:

- **Does NOT run the generated specs.** The agent writes the files and surfaces the command, always rooted at its own scope so a run can never execute another repo's specs:

  ```bash
  cd <specsDir>/<scope> && BASE_URL=<url> npx playwright test <TICKET>/
  ```

  The command needs no session argument: `GHOLA_SESSION_ID` is already in the session terminal's environment, and the config reads it there. If the operator runs the command from a shell that lacks it, they prefix it explicitly — `GHOLA_SESSION_ID=<id> BASE_URL=<url> npx playwright test <TICKET>/` — or accept the `runs/shared/` fallback the config warns about. Narrow to a single procedure with `npx playwright test <TICKET>/TP-1.spec.ts` from the same directory. The `cd` target is the scope dir, never `<specsDir>` — a bare `cd <specsDir> && npx playwright test` runs every repo's specs against whatever `BASE_URL` happens to be set, and the agent must not surface that form. `BASE_URL` is included in the surfaced command because the config refuses to run without it.

  View that run's report with:

  ```bash
  npx playwright show-report <specsDir>/<scope>/runs/<session>/playwright-report
  ```

  Add `--port <n>` when viewing two reports at once, since `show-report` binds 9323 by default.

## Run-dir growth and pruning (operator task)

Every session creates a new `runs/<session>/` directory and nothing ever removes one, so the tree grows without bound — one dir per session forever, each holding a report, traces, and any videos. Videos in particular are large. On a machine running several sessions a day this becomes the biggest thing under `specsDir` within weeks.

**The agent never prunes.** It does not delete run dirs, does not offer to, and does not run a command that would; no-deletions is a hard rule and stale run dirs are exactly the kind of thing an agent should not be judging the disposability of. What the agent DOES do is surface the situation: when it notices a scope has accumulated many run dirs, it tells the operator the count and the path and leaves the decision there.

The operator prunes by hand. Everything under `<specsDir>/<scope>/runs/` is regenerable output — deleting a run dir loses that run's report and videos and nothing else; specs, config, and walkthroughs live outside `runs/` and are untouched. A run dir belonging to a LIVE session must not be deleted, so prune when the relevant sessions are closed, or keep recent dirs by age. Sketches the operator may adapt, to run themselves:

```bash
# Inspect first: size per run dir, largest last.
du -sh <specsDir>/<scope>/runs/*/ | sort -h

# Then, once the sessions owning them are closed, drop run dirs older than 7 days.
find <specsDir>/<scope>/runs/ -mindepth 1 -maxdepth 1 -type d -mtime +7
# re-run with -exec rm -rf {} + once the listing looks right
```

The listing form is deliberately separated from the deleting form: the operator confirms what would go before anything goes. The agent may show these commands as documentation; it does not execute the second one.
- **Does NOT modify the work repo.** Specs live outside the work repo per `parameters.specsDir`. No files are written into the work repo's tree, no `package.json` changes, no `.gitignore` edits; the work repo is untouched.
- **Does NOT auto-update specs when procedures change.** Procedures evolving in the per-ticket notes do not trigger a spec rewrite. If procedures are revised, the user re-runs the spec-writing flow on demand; the agent regenerates the affected spec files at that point.
- **Does NOT install Playwright** or modify the project's dependency graph. The user is expected to have Playwright installed in their environment; the agent surfaces `npm install -D @playwright/test` once if the user signals it's missing, but never runs the install itself.
- **Does NOT handle authentication for non-Edge browsers.** Auth context is Edge-specific via the user's persistent profile. Firefox, WebKit, and stock Chromium have no equivalent profile-reuse path in this module; specs against Azure-AD-protected routes on those browsers are out of scope.

## Module-disabled vs feature-disabled

These are distinct states and must produce distinct behavior:

- **Module disabled** (no `tool.playwright` in the Session Manifest): no Playwright specs are written. Testing procedures from `tool.ac-to-testing` stay manual; they are the testing contract as-is, executed by hand. Ad-hoc help is still fine if the user asks, but there is no structured spec-writing flow and no auto-offer on fresh procedures.
- **Module enabled, `parameters.autoOfferOnProcedures` off**: the module exists but no auto-offer is made. Specs are written only on explicit user or TPM request.
- **Module enabled, no procedures available**: respond "No testing procedures found; run `tool.ac-to-testing` first." Do not fabricate procedures, and do not write specs from the AC items directly; the upstream ritual is the procedure source, not the agent's improvisation.
- **Module enabled, no base URL for the run**: refuse and surface once ("No BASE_URL for this session. Set `BASE_URL=<url>` for the run (or supply the URL to hardcode); this module will not guess one."). Do not fall back to `localhost:3000` or any other literal, and do not read another scope's config to borrow its URL. This is a refusal, not a degradation — no specs, no config, no run command until the operator supplies the value.
- **Module enabled, scope cannot be derived** (node unavailable, `git rev-parse` fails AND `pwd` is not a usable absolute path): refuse and surface once ("Cannot derive the repo scope for the Playwright spec tree; specs cannot be written without it."). Never fall back to the unscoped `<specsDir>/<TICKET>/` layout — that is the contamination path this module exists to close.
- **Module enabled, `GHOLA_SESSION_ID` unset**: this is a DEGRADATION, not a refusal — unlike a missing scope, which is fatal. Specs, config, and walkthrough are unaffected (they are per-repo and need no session). Run output goes to the shared `<specsDir>/<scope>/runs/shared/`, and the agent says so once, explicitly, in its report: "GHOLA_SESSION_ID is unset, so run output is going to the shared per-repo dir `<specsDir>/<scope>/runs/shared/`. A second concurrent run in this repo will overwrite it." Never take the shared path quietly, and never invent a session id of your own — a value the agent makes up is not stable across the tool calls of one run and would scatter one run's output across several dirs, which is worse than one honest shared dir. If the operator wants isolation, the fix is to run in a Ghola-launched terminal or to set the variable themselves.
- **Module enabled, `parameters.specsDir` unwritable** (path expansion fails, directory not writable, disk full, etc.): surface the write failure once ("Specs Dir `<path>` is not writable; specs cannot be written. Choose an alternate path in the Modules tab or unblock the current one."), and do not retry until the user signals the issue is fixed.
- **Module enabled, `parameters.edgeProfileAuth` off**: specs use Playwright's default browser context with no SSO awareness. Routes behind Azure AD redirect to login and the test fails or hangs; this is expected, not a bug. Users testing protected apps must toggle the setting on.
- **Module enabled, `parameters.edgeProfileAuth` on, `parameters.edgeProfilePath` invalid** (parent directory unwritable, profile directory unreadable, profile locked by another Edge process): surface the path failure once ("Edge Profile Path `<path>` is not usable; auth-context specs cannot be generated. Verify the path, close other Edge windows, or toggle Edge Profile Auth off."), and fall back to off-mode generation (default browser context, no SSO) for the remainder of the run. A profile path that does not exist yet is NOT a failure under the per-session default — the session's profile dir is absent before its first run and Playwright creates it; expect an unauthenticated first run and an interactive sign-in EVERY session, not an error.
- **Module enabled, `parameters.edgeProfileAuth` on, `parameters.edgeProfilePath` empty**: an empty value is a leftover from the pre-scope default and means "the OS-default Edge profile". Honor it, but say once that it is shared across every repo and every session and therefore usable by only one session at a time, and point the operator at the `~/.ghola/edge-profiles/<scope>/<session>` default if they want concurrent Edge runs.
- **Module enabled, `parameters.edgeProfilePath` contains `<session>` but `GHOLA_SESSION_ID` is unset**: expand the token to `shared`, matching the run-dir fallback, and fold it into the same one-time degradation notice rather than emitting a second warning. The profile is then shared with any other session in the same state, so the operator is told that a concurrent Edge run may fail on the profile lock.

Do not merge these cases.

## Sibling-module interaction

- **`tool.ac-to-testing`** (required upstream): produces the testing procedures this module consumes. Without it, there is no procedure source and the auto-offer never fires. The two modules form a writer/reader pair: ac-to-testing writes procedures to the per-ticket notes (or session memory when `writeToNotes` is off), this module reads them.
- **`mode.ticket-work`**: informs the active ticket id, which becomes the per-ticket spec-subdir name under `<specsDir>/<scope>/` and the consolidated spec filename when `specPerProcedure` is off. The ticket id supplies only the ticket segment; the scope segment is derived from the repo, never from the ticket. Without `mode.ticket-work` and an active ticket, the agent prompts the user for an explicit ticket id before writing.
- **`tool.obsidian-notes`**: the source of the per-ticket notes file the agent reads procedures from when `tool.ac-to-testing`'s `writeToNotes` was on. When procedures live in session memory only (writeToNotes off), the agent reads them from session state for the same session; cross-session re-runs require the notes write.

## Role-Specific Notes

The body above applies to whichever tester agent holds this capability; this module's fragment targets QA and SWE. The notes below frame each role's relationship to spec-writing.

### QA

You own spec generation as your normal beat, including the proactive offer when `parameters.autoOfferOnProcedures` is on. Read testing procedures either from session memory (when `tool.ac-to-testing`'s `writeToNotes` was off and the procedures were just produced this session) or from the `Testing Procedures` section of the per-ticket notes file at `<vault>/<Project>/<Ticket>.md` (when the upstream write happened). Translate each TP per the "Per-TP translation" rules, respecting the active `parameters.configTemplate`, `parameters.specPerProcedure`, and `parameters.includeSetupTeardown` values. Derive the repo scope AND the session id first (see "Where specs land" and "Where run output lands"), write spec files to `<specsDir>/<scope>/<TICKET>/`, write that scope's `playwright.config.ts` at `<specsDir>/<scope>/` if it does not already exist, and surface the scope-rooted `npx playwright test` command plus the session-qualified `show-report` path for the user to run. Every durable artifact path you read or report is scope-qualified and every run-output path is additionally session-qualified; you never touch another scope, and you never read a sibling session's run dir. If `GHOLA_SESSION_ID` is unset, say so once and name the shared fallback dir rather than proceeding quietly. You do NOT run the specs yourself, you do NOT modify the work repo, and you do NOT touch the per-ticket notes file; spec generation is your only write surface and it lives outside both the work repo and the notes vault. When `parameters.edgeProfileAuth` is true, generate specs using `chromium.launchPersistentContext` per the Edge Auth Context section.

### TPM

You dispatch spec-writing when the user signals testing time and procedures exist. Pass the active ticket id and the procedure source (notes path or session-memory handle) in the assignment, and name the agent (QA by default, or a SWE when you are explicitly routing spec-writing to the coder). You do not write specs yourself, and you do not duplicate this module's body in the assignment; the assigned agent's own copy of the module carries the rules. If the user asks whether specs have been generated for the active ticket, you can check `<specsDir>/<scope>/<TICKET>/` for existing `.spec.ts` files — derive the scope for THIS repo first and look only there; a ticket dir under another scope belongs to another repo's session and is not evidence about yours. Specs are per-repo, so a spec written by an EARLIER session in this same repo is legitimately yours to find there. Run output is not: `<specsDir>/<scope>/runs/` holds one dir per session, and only your own session's dir describes your run. The moment-to-moment behavior is the assigned agent's.

### SWE

You gain this capability on an explicit TPM or user request to write specs; you do NOT proactively offer, that gesture is QA's. When assigned, you follow the same mechanics as QA: read the procedures from session memory or the per-ticket notes file, translate each TP per the "Per-TP translation" rules against the active `parameters.*` values, derive the repo scope and the session id first, write spec files to `<specsDir>/<scope>/<TICKET>/`, write that scope's `playwright.config.ts` at `<specsDir>/<scope>/` if it does not exist, and surface the scope-rooted `npx playwright test` command along with the session-qualified report path. The specs live outside the work repo, so writing them does not touch your file ownership or your code returns; you do NOT run the specs, you do NOT stage or commit them, and you do NOT modify the work repo from this module. When `parameters.edgeProfileAuth` is true, generate specs using `chromium.launchPersistentContext` per the Edge Auth Context section. Absent an explicit spec-writing assignment, treat Playwright specs as QA's beat and defer via TPM.
