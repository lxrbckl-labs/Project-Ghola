# Open Local Repo

This module is TPM's quick-navigation helper for local repos. It is **not proactive** — it does not fire at session start. It activates only when the user issues a trigger phrase (per `parameters.triggerPhrases`) or explicitly asks to be taken to a project by name. When triggered, TPM resolves the name to a path under one of the configured search roots and surfaces the exact command for the user to run.

## What The Module Does

TPM watches for trigger phrases like "open repo `X`" or "switch to project `X`". On a match, TPM extracts the candidate name from the rest of the turn and fuzzy-matches it against directory basenames under `parameters.searchRoots`. The result is a resolved path plus a copy-pasteable shell command. The user runs the command in their own terminal — TPM does **not** execute it.

## Resolution Flow

1. The user's turn contains a substring from `parameters.triggerPhrases` (matched case-insensitively).
2. TPM extracts the repo-name candidate from the rest of the turn — the token or phrase the user named after the trigger.
3. TPM iterates `parameters.searchRoots` in the order listed. For each root, it lists immediate subdirectories and matches each basename against the candidate.
4. Matching mode is governed by `parameters.fuzzyMatch`: when `true`, case-insensitive substring match against the basename; when `false`, exact basename match (case-insensitive).
5. On match(es), routing is governed by `parameters.onMultipleMatches` (see below).

## Surfacing The Command

When resolution yields a single path (or the user picks one from a multi-match list), TPM responds with the exact shell command for the user to run:

> `<openCommand> <resolved-path>`

For example, with `openCommand: code` and a resolved path of `~/projects/Project-Nomeda`:

> `code ~/projects/Project-Nomeda`

TPM does **not** execute this command. The user runs it themselves in their bash terminal. This preserves their ability to abort, adapt, or run a different command if the resolution is wrong.

## Multiple-Matches Handling

When more than one subdirectory matches the candidate (fuzzy mode is the common cause), the response is governed by `parameters.onMultipleMatches`:

- **`ask`** (default): "Found N matches: ….  Which one?" TPM lists the candidate paths and waits for the user to pick.
- **`first`**: silently takes the first match in search-root order — the first matching subdirectory under the first root that yielded a hit.
- **`refuse`**: "Ambiguous match — be more specific." TPM does not surface any command; the user re-issues with a tighter name.

## What This Module Does NOT Do

- Does **not** execute the open command. TPM surfaces it; the user runs it.
- Does **not** modify any file or repo state. Resolution is read-only.
- Does **not** verify the resolved path is actually a git repo. A directory containing a non-git project still matches — basename matching is the entire policy.
- Does **not** manage platform-specific path translation. The open command is surfaced as-is; the user's shell and their configured editor handle any platform bridging.

## Module-Disabled vs Feature-Disabled

- **Module disabled** (no `tool.open-wsl-repo` in the Session Manifest): TPM does not watch for the trigger phrases. The user navigates manually — `cd` to the repo and run `code .` themselves.
- **Module enabled, `fuzzyMatch` off**: only exact basename matches succeed. Partial inputs that would have matched in fuzzy mode return "no match" instead.
- **Module enabled, no roots match**: TPM responds "No repo matching `X` found under any of: `<root list>`." The root list in the message is the actual contents of `parameters.searchRoots` so the user knows where TPM looked.

## Platform Notes

On WSL, the search roots typically live under `~/projects` or similar Linux-native paths. On macOS, the same convention applies — `~/projects`, `~/src`, `~/code` are common locations. The module works identically on both platforms; the user configures their search roots in the Modules tab.

## Role-Specific Notes

### TPM

You own the navigation flow. Watch for the trigger phrases in `parameters.triggerPhrases`. When one fires, extract the candidate name, iterate `parameters.searchRoots`, match basenames per `parameters.fuzzyMatch`, and route per `parameters.onMultipleMatches`. Surface the exact `<openCommand> <resolved-path>` command for the user to run. **Never** execute the command on the user's behalf — the user runs it in their own shell after they see and confirm the resolution.

### SWE

Not involved. This module does not contribute to the SWE prompt and does not factor into code-work assignments.

### QA

Not involved. This module does not contribute to the QA prompt and does not factor into review verdicts.
