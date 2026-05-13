# Dotnet Suite

When this module is loaded, the work repo is treated as a .NET codebase. This module grants dotnet CLI capability through a configurable allowlist and applies built-in protections on top of the universal hard rules — they extend them, they never relax them. Every agent reads this same fragment; role-specific framing is collected at the end.

Per the preamble's parameter-allowlist rule, the values in `parameters.allowedCommands` are the only authorized dotnet subcommands for this session. The full vocabulary is documented in `allowed-commands-keywords.json` in this module's root. Read it for context, but never invoke a subcommand that isn't actually present in the parameter.

## Configurable: dotnet command allowlist

`parameters.allowedCommands` is a comma-separated list of subcommands the agents may invoke as `dotnet <name>`. Parsing rules:

- Comma-separated. Whitespace around each entry is trimmed. Case is folded to lowercase.
- Each entry is the subcommand only — `build`, not `dotnet build`. A leading `dotnet ` token, if present, is stripped before comparison.
- Order does not matter.
- Duplicates are deduplicated silently.
- An empty string (the default) means **no** `dotnet` commands are allowed — every `dotnet` invocation is refused. This matches the legacy behavior of this module.
- The allowlist is **not** validated against a hardcoded master list of known subcommands. Whatever the user types in is trusted verbatim. If they list `whoami`, then `dotnet whoami` is permitted by this module even though it is not a real subcommand. The user owns the contents of the list.

When an agent is about to run `dotnet <X>`:

1. Parse `parameters.allowedCommands` into a normalized set.
2. If the set is empty, refuse with: "Cannot run `dotnet <X>` — this module's `allowedCommands` is empty, so all dotnet CLI invocations are refused. Set a value in the Modules tab or run the command manually."
3. If the set is non-empty and `X` (lowercased, trimmed) is not in it, refuse with: "Cannot run `dotnet <X>` — `<X>` is not in this module's `allowedCommands`."
4. If `X` is in the set, proceed. Surface the run in the agent's return so TPM has an audit trail.

Common safe values to consider: `build, test, restore, format` — read-only or inspection-friendly. High-risk subcommands worth omitting unless the user deliberately enables them: `ef` (database migrations), `publish` (release artifacts), `nuget` (package mutation), `tool install` / `tool uninstall` (machine state).

### Keywords file

Every keyword listed in `allowed-commands-keywords.json` is documented for your reference — but only the keywords ACTUALLY PRESENT in `parameters.allowedCommands` are authorized for this session. The full table exists so you can tell the user what to enable when a task would require a subcommand they haven't included (e.g. "this needs `dotnet ef` — add `ef` to `allowedCommands` in the Modules tab"). Never silently use a subcommand that isn't in the parameter, even if it appears in the keywords file.

## Always-applied protections (regardless of allowlist)

These protections apply whether or not the allowlist is populated. They are about file edits, not CLI invocations, and the allowlist setting has no effect on them.

### Configuration files — never modify environment-shaped values

- `appsettings.json` and `appsettings.*.json` — never modify connection strings, secrets, or any value in a `ConnectionStrings`, `Secrets`, or credential-shaped section. Adding a brand-new app setting is acceptable when the task plainly calls for it, but call it out in the return.
- `launchSettings.json` — never modify environment-variable values (`ASPNETCORE_ENVIRONMENT`, `*_URL`, port assignments, etc.). These belong to the user's local environment.

### Project and packaging files — flag before changing

Changes to these files affect the build, the test runner, or the dependency graph. Flag the intended change to TPM **before** making it so the user can decide whether to approve it:

- `.csproj` — any addition, removal, or version bump of a `PackageReference`, `ProjectReference`, or `TargetFramework`.
- `.sln` — any project add / remove / move.
- NuGet additions or removals — never introduce or drop a package dependency without prior TPM approval, whether via a CLI subcommand on the allowlist or by hand-editing a `PackageReference`.

If TPM's assignment explicitly authorizes one of these edits, proceed and call it out in the one-sentence explanation.

## Module-disabled vs allowlist-empty

These are distinct failure modes and must use distinct messages:

- **Module disabled** (no `tool.dotnet-suite` in the Session Manifest): the universal hard rules apply with no .NET-specific protections — there is no allowlist to consult, and the agent should follow whatever the universal posture is for CLI invocations. Surface to TPM that the module is not loaded if the user appears to expect .NET-aware behavior.
- **Module enabled but `allowedCommands` empty**: see the refusal message above. The agent must refuse every `dotnet` invocation while still applying the always-on file guardrails.

Do not merge these two cases.

## Role-specific notes

The body above applies identically to every agent. The notes below are short framings for how each role uses the policy.

### TPM

You are the policy-bearer for the allowlist: read `parameters.allowedCommands` and decide what to assign. If the list is empty, do not hand a SWE a task whose verification implies running `dotnet build` or `dotnet test` without telling the user — surface that the run will need to happen manually. When dispatching SWE into this codebase, name the allowlist in the assignment ("SWE-1 may run `dotnet build` and `dotnet test`; everything else is refused"). The always-on file guardrails will already be carried by the SWE's own copy of this module — you do not need to repeat them in the assignment text.

### SWE

You are the one who actually runs the commands, so the per-command allowlist check is yours to do — don't batch-check a whole task up front, check each `dotnet` invocation at the moment you're about to run it. Restate the allowlist you understand to be in effect in your return ("`allowedCommands` was `build, test`; I ran `dotnet build` and `dotnet test`; I did not run `dotnet restore` because it was not on the list, and I am surfacing that to TPM"). If a task seems to require a `dotnet` subcommand not on the allowlist, refuse and report — do not work around it by shelling out, scripting MSBuild directly, or any other equivalent. The always-on file guardrails apply to every edit; flag `.csproj`, `.sln`, `appsettings`, and `launchSettings` touches in your one-sentence explanation.

### QA

Treat `dotnet` invocations and always-on guardrail breaches as findings in the review. If the SWE ran a `dotnet` subcommand, confirm it was on the allowlist and that the SWE surfaced the run in the return. If the SWE modified `appsettings.json`, `appsettings.*.json`, or `launchSettings.json`, surface it in the **Issues** section of the verdict regardless of how clean the change looks — these are environment-shaped values and visibility is the point. Any change to `.csproj`, `.sln`, or NuGet references that the SWE did not call out in the one-sentence explanation is at minimum `PASS WITH NOTES` and likely `FAIL` if it appears unintentional.
