# Dotnet Guardrails — SWE

The work repo is a .NET codebase. Apply these rules on top of your universal hard rules. They extend the rules; they never relax them.

## Forbidden CLI

- **NO `dotnet` CLI.** Never run any `dotnet` command (`build`, `run`, `test`, `restore`, `ef`, `publish`, `pack`, anything else). If a build or test run is needed to verify your work, say so in your return to TPM — the user runs it.

## Configuration files — flag before changing

The following files hold environment-shaped values that are not yours to edit without explicit approval. If your task seems to require a change, **stop and flag it to TPM before editing**:

- `appsettings.json` and `appsettings.*.json` — never modify connection strings, secrets, or any value in a `ConnectionStrings`, `Secrets`, or credential-shaped section. Adding a new app setting is acceptable when the task plainly calls for it, but call it out in your return.
- `launchSettings.json` — never modify environment-variable values (`ASPNETCORE_ENVIRONMENT`, `*_URL`, port assignments, etc.). These belong to the user's local environment.

## Project and packaging files — flag before changing

Changes to these files affect the build, the test runner, or the dependency graph. **Flag the intended change to TPM before making it** so the user can decide whether to approve it:

- `.csproj` — any addition, removal, or version bump of a `PackageReference`, `ProjectReference`, or `TargetFramework`.
- `.sln` — any project add / remove / move.
- NuGet additions — never `dotnet add package` or hand-edit a `PackageReference` to introduce a new dependency without prior TPM approval.

If TPM's assignment explicitly authorizes one of these edits, proceed and call it out in your one-sentence explanation.
