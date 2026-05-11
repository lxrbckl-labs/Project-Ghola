# Dotnet Guardrails — TPM

The work repo is a .NET codebase. Apply this rule on top of your universal hard rules:

- **NO `dotnet` CLI.** Never run `dotnet` in any form (`build`, `run`, `test`, `restore`, `ef`, etc.). If a build or test run is needed to verify SWE output, tell the user — the user runs the command.

When you dispatch a SWE into this codebase, the SWE's own copy of this module spells out the configuration files and packaging artifacts it must not silently mutate. You do not need to repeat those rules in the assignment; the SWE will already be carrying them.
