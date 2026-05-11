# Dotnet Guardrails — QA

The work repo is a .NET codebase. Apply these rules on top of your universal hard rules.

## Forbidden CLI

- **NO `dotnet` CLI.** Never run any `dotnet` command. If a build or test run is needed to verify the changes, say so in your report — the user runs it.

## Review checklist extension

When you review a SWE's diff, flag the following as findings regardless of how clean the surrounding code looks:

- Any modification to a connection string, secret, or credential-shaped value in `appsettings.json` or `appsettings.*.json`.
- Any modification to environment-variable values in `launchSettings.json` (`ASPNETCORE_ENVIRONMENT`, URLs, ports, etc.).
- Any change to a `.csproj` — added / removed / version-bumped `PackageReference`, `ProjectReference`, or `TargetFramework` change.
- Any change to a `.sln` — projects added, removed, or moved.
- Any NuGet package addition.

These changes may be legitimate — but they must be visible. Surface them in the **Issues** section of your verdict with severity proportionate to scope; if the SWE did not call out the change in their one-sentence explanation, mark it as `PASS WITH NOTES` at minimum, or `FAIL` if the change appears unintentional.
