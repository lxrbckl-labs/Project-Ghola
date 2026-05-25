# NPM Suite

When this module is loaded, the work repo is treated as an npm + Angular CLI codebase. This module grants `npm` and `ng` CLI capability through a user-managed command allowlist and applies built-in protections on top of the universal hard rules — they extend them, they never relax them. Every agent reads this same fragment; role-specific framing is collected at the end.

Per the preamble's parameter-allowlist rule, the entries in `parameters.allowedCommands` are the only authorized npm and Angular CLI invocations for this session. The user manages a list of allowed commands via the `tool.npm-suite` settings panel. The current allowlist is provided in this module's Session Manifest entry as a JSON object whose KEYS are the exact command strings agents may run. Run a command ONLY if it matches a key on the list verbatim — key presence is the grant; absence is the refusal. Commands disabled by the user do not appear in the projected object the agent sees. If the user requests a command that isn't on the list, ask before running. If the list is empty, do not run any `npm` or `ng` commands without explicit user authorization for the specific command.

## Configurable: command allowlist

`parameters.allowedCommands` is an object whose KEYS are the exact command strings the agents may invoke and whose VALUES are free-form description strings the user entered for their own bookkeeping (empty string `""` when the user left the description blank — `optionalValue: true` makes the description optional). The composer projects the user's settings into this flat shape at compose time — only commands the user has marked enabled appear; disabled commands are omitted entirely. Parsing rules:

- The key is the full command form — e.g. `npm test`, `npm run build`, `ng lint`. Match on string equality, byte-for-byte. No case folding, no whitespace normalization, no leading-token stripping.
- The value is a free-form description for human bookkeeping. It may be an empty string. The agent does not act on it.
- A key's presence is the grant; its absence is the refusal. There is no `enabled` field to check — commands disabled by the user are absent from the object entirely.
- Order does not matter.
- An empty object (the default for a freshly added module before the user seeds entries, or a list the user has cleared) means **no** `npm` or `ng` commands are allowed — every such invocation must be refused or surfaced to the user for explicit authorization.
- The allowlist is **not** validated against a hardcoded master list of known commands. Whatever the user enters is trusted verbatim. If they list `npm whoami`, then `npm whoami` is permitted by this module. The user owns the contents of the list.
- All commands are run from the project root (the current working directory). Do not `cd` into a subfolder to run an allowlisted command unless the user explicitly asks.

When an agent is about to run an `npm` or `ng` command:

1. Read `parameters.allowedCommands` from the Session Manifest entry for `tool.npm-suite`.
2. Check how it appears:
   - `(defaults)` — the user has not yet overridden the module settings. The factory allowlist applies: `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm ls`, `npm outdated`, `ng test`, `ng lint`, `ng build` are all enabled. Treat these as the operative keys and proceed to step 3.
   - `{}` (an empty JSON object) — the user explicitly cleared every entry. Refuse with: "Cannot run `<command>` — this module's `allowedCommands` is empty, so all npm and ng invocations are refused. Add the command in the Modules tab or run it manually."
   - A non-empty JSON object — proceed to step 3.
3. If the requested command string is not a key in the effective allowlist, refuse with: "Cannot run `<command>` — `<command>` is not in this module's `allowedCommands`. Add it in the Modules tab to authorize it for this session."
4. If the command string is a key, proceed. Surface the run in the agent's return so TPM has an audit trail.

Even when a command IS on the allowlist, the agent must still avoid using it in destructive ways. Prefer the canonical form. Do not append flags that overwrite files, delete artifacts, or otherwise mutate state beyond what the bare command does (e.g. `npm test -- --some-flag-that-overwrites-files` is off-pattern even though `npm test` is allowed). If a task seems to require a non-canonical flag, surface it to TPM before running.

Commonly seeded values (the defaults this module ships with): `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm ls`, `npm outdated`, `ng test`, `ng lint`, `ng build`. These are read-only or build-only — they inspect or produce artifacts but do not mutate source, `node_modules`, or `package-lock.json`. The user may add or remove freely. High-risk commands deliberately NOT seeded by default: `npm install` / `npm ci` / `npm i` (mutate `node_modules` and the lockfile), `npm publish` (pushes to a registry), `npm run dev` / `ng serve` (long-running dev servers — user starts those, not the agent), `ng new` / `ng generate` (scaffolding that creates files), and anything resembling `npm uninstall` or shell-style destructive operations. The user can add these explicitly if they want them; they are not part of the safe starter set.

## Always-applied protections (regardless of allowlist)

These protections apply whether or not the allowlist is populated. They are about file edits and command behavior, not allowlist membership, and the allowlist setting has no effect on them.

### Package and lockfile files — flag before changing

Changes to these files affect the build, the test runner, or the dependency graph. Flag the intended change to TPM **before** making it so the user can decide whether to approve it:

- `package.json` — any addition, removal, or version bump of a `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies`, or `scripts` entry. Changes to `engines`, `main`, `exports`, or other top-level fields likewise need a heads-up.
- `package-lock.json` and `npm-shrinkwrap.json` — never hand-edit. These are generated artifacts; if a lockfile change is required, the user runs the relevant install/ci command themselves.
- `angular.json` — any change to project configuration, build targets, test targets, or `architect` blocks. These define how the workspace builds and tests.
- `tsconfig.json` and `tsconfig.*.json` — any change to `compilerOptions`, `include`, `exclude`, or path mappings affects the whole build.

If TPM's assignment explicitly authorizes one of these edits, proceed and call it out in the one-sentence explanation.

### Environment and config files — never modify environment-shaped values

- `.env`, `.env.*`, `environment.ts`, `environments/environment.*.ts` — never modify secrets, API keys, connection strings, or environment-shaped values. Adding a brand-new key that the task plainly calls for is acceptable, but call it out in the return.
- `.npmrc` — never modify registry URLs, auth tokens, or scope mappings. These belong to the user's local environment.

## Module-disabled vs allowlist-empty

These are distinct failure modes and must use distinct messages:

- **Module disabled** (no `tool.npm-suite` in the Session Manifest): the universal hard rules apply with no npm/ng-specific protections — there is no allowlist to consult, and the agent should follow whatever the universal posture is for CLI invocations. Surface to TPM that the module is not loaded if the user appears to expect npm-aware behavior.
- **Module enabled but `allowedCommands` empty**: see the refusal message above. The agent must refuse every `npm` and `ng` invocation while still applying the always-on file guardrails.

Do not merge these two cases.

## Role-Specific Notes

The body above applies identically to every agent. The notes below are short framings for how each role uses the policy.

### TPM

You are the policy-bearer for the allowlist: read `parameters.allowedCommands` and decide what to assign. Keys present in the object are enabled; absent keys are refused. If the object is empty, do not hand a SWE a task whose verification implies running `npm test` or `npm run build` without telling the user — surface that the run will need to happen manually. When dispatching SWE into this codebase, name the specific enabled commands in the assignment ("SWE-1 may run `npm test` and `npm run build`; everything else is refused"). The always-on file guardrails will already be carried by the SWE's own copy of this module — you do not need to repeat them in the assignment text.

### SWE

You are the one who actually runs the commands, so the per-command allowlist check is yours to do — don't batch-check a whole task up front, check each `npm` or `ng` invocation at the moment you're about to run it. Key presence is the gate — only keys present in `parameters.allowedCommands` are permitted. Restate the keys you understand to be in effect in your return ("`allowedCommands`: `npm test` (present), `npm run build` (present), `npm install` (absent); I ran `npm test`; I did not run `npm install` because it was not on the list, and I am surfacing that to TPM"). If a task seems to require a command not on the allowlist, refuse and report — do not work around it by shelling out, invoking the underlying tooling directly, or any other equivalent. The always-on file guardrails apply to every edit; flag `package.json`, `package-lock.json`, `angular.json`, `tsconfig*`, `.env*`, and `environment*.ts` touches in your one-sentence explanation.

### QA

Treat `npm` and `ng` invocations and always-on guardrail breaches as findings in the review. If the SWE ran a command, confirm it was a key present in `allowedCommands` at the time of the run and that the SWE surfaced the run in the return. If the SWE modified `.env`, `.env.*`, `environment.ts`, `environments/environment.*.ts`, or `.npmrc`, surface it in the **Issues** section of the verdict regardless of how clean the change looks — these are environment-shaped values and visibility is the point. Any change to `package.json`, `package-lock.json`, `angular.json`, or `tsconfig*` that the SWE did not call out in the one-sentence explanation is at minimum `PASS WITH NOTES` and likely `FAIL` if it appears unintentional.
