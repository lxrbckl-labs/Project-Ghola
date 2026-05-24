# Fast Path Check

This module is **proactive**: read it once, at session start, before responding to the user's first request. It does one thing — detect whether the work repo lives on a slow filesystem path and, if so, tell the user once. It does **not** migrate anything.

## What To Check

At the very beginning of the session, look at the current working directory.

- **On WSL / Linux:** if the cwd starts with `/mnt/c/`, `/mnt/d/`, or any other `/mnt/<letter>/` mount, the repo is on the Windows filesystem accessed across the WSL/Windows boundary. That boundary is slow — typically ~5-6x slower than a WSL-native path for I/O-heavy workloads (npm/pnpm install, esbuild/webpack builds, git, grep, large `Read` sweeps).
- **On native Windows:** if the cwd starts with a drive letter like `C:\` and the session is otherwise expected to use a WSL toolchain, the same penalty applies.
- **On macOS, Linux without WSL, or a WSL-native path (`/home/...`, `~/projects/...`):** no action — the cwd is already fast.

## What To Say

If — and only if — the cwd matches the slow-path pattern, surface a single, short advisory to the user as part of your opening message. Phrase it as a heads-up, not a blocker:

> Heads up — this repo is on the Windows filesystem (`/mnt/c/...`). Moving to a WSL-native path (e.g. `{parameters.fastpathDirectory}/<repo>`) typically gives ~5-6x I/O speedup for builds, git, grep, and `npm install`. Not blocking — but worth doing when convenient.

Use the actual value of `parameters.fastpathDirectory` (default `~/projects`) in the message above — replace `{parameters.fastpathDirectory}` with whatever is configured. If `fastpathDirectory` is blank or missing, fall back to `~/projects` in the message text.

That is the entire message. Then continue with whatever the user actually asked.

## What NOT To Do

This module is **detect-and-advise only**. It deliberately does not include a migration procedure. Specifically, do **not**:

- Suggest `rsync`, `cp -r`, `git clone`, or any other concrete sequence of commands to move the project.
- Spawn a SWE to do the migration.
- Touch the source tree in any way.
- Run repeated checks during the session. Once at the top is enough; if the user doesn't act on it, drop it.
- Re-advise on subsequent turns. The user has heard it; nagging is counterproductive.

A full migration is a manual operation with safety implications (uncommitted work, stashes, unpushed commits, gitignored config files) and is out of scope for this proactive check. If the user explicitly asks "how do I move it?", give them a brief outline at most — pre-flight (`git status` clean? remote configured?), pick one of clone-or-rsync, install dependencies fresh, sanity-check — and recommend they do it interactively at a shell rather than via the agent.

## Why This Is A Module, Not Core

Filesystem-path performance is an environmental concern, not an intrinsic agent rule. Users on macOS, native Linux, or already on a WSL-native path see no value from this check. Keeping it in a module means those users can disable it and stop receiving the advisory, while WSL-on-Windows users get a one-time nudge that's worth the seconds of attention it costs.

## Launcher Side-Effect (Read-Only Awareness)

While this module is enabled, the Nomeda session launcher opens the bash terminal already `cd`'d into a WSL-native fast-path directory rather than the workspace folder. Resolution order:

1. **`fastpathDirectory`** — if the user has explicitly saved a value for this setting (the panel pre-fills `~/projects` as a UI placeholder, but the launcher only acts on a persisted value), it is treated as the parent directory. If `autoCdIntoRepo` is on (the default), the launcher checks for `<fastpathDirectory>/<basename(workspace)>` — e.g. `~/projects` + workspace `/mnt/c/Users/me/Project-Nomeda` → looks for `~/projects/Project-Nomeda`. If that subdirectory exists, the terminal opens there (the actual repo, not the parent).
2. If `autoCdIntoRepo` is on but no matching subdirectory is found, the launcher falls back to `<fastpathDirectory>` itself.
3. If `autoCdIntoRepo` is off, the launcher cd's directly into `<fastpathDirectory>` without probing for a subdirectory.
4. If `fastpathDirectory` has never been saved (or was saved as blank), the launcher falls back to its older auto-compute: translating `/mnt/<letter>/Users/<user>/<rest>` → `~/projects/<basename(rest)>`. Workspaces already on a WSL-native path (starting with `/home/` or the system home directory) are considered fast and the workspace path itself is used. **Scope limit:** auto-compute only recognises the `\Users\<user>\` sub-path convention. A path like `/mnt/e/workprojects/foo` does not match the pattern and the launcher falls back to the workspace folder unchanged — the user must set `fastpathDirectory` explicitly for non-standard mount layouts.

**Absent-means-default semantics:** Each setting is independent — the user may have saved one without the other. If `fastpathDirectory` is not present in the persisted state (the key was never saved), the launcher treats it as unset and falls back to auto-compute (step 4 above). If `autoCdIntoRepo` is not present in the persisted state, the launcher treats it as `true` — the auto-cd behavior is on by default and only an explicit saved value of `false` opts out. This means a user who saves only `fastpathDirectory` (but never touches the `autoCdIntoRepo` toggle) gets auto-cd on; a user who saves only `autoCdIntoRepo: false` (but leaves `fastpathDirectory` blank) gets auto-compute with no subdirectory probe.

In all cases, if the resolved path does not exist on disk the launcher falls back to the workspace folder silently. In a multi-root workspace the launcher uses the first workspace folder for resolution and logs a warning. This is launcher behavior, not an instruction you act on — it is documented here so you understand why the cwd may differ from `vscode.workspace.workspaceFolders[0]` when this module is in the enabled set.

**Known edge cases (launcher scope, not agent-actionable):**

- **No workspace folder open:** If the user launches a session before VS Code has a workspace open (or in an untitled window), `vscode.workspace.workspaceFolders` is `undefined` or empty. The launcher detects this, logs a warning, and skips the fast-path `cd` entirely — the terminal opens without a `cwd`, falling back to VS Code's default shell directory.
- **Relative paths in `fastpathDirectory`:** The launcher only expands a leading `~` or `~/`. A bare relative path (e.g. `projects/Foo` without a leading `~`) is passed to `fs.existsSync` relative to the extension host's cwd, not the user's home directory. The resolved path is usually wrong and the launcher will likely fall back to the workspace folder. Users must supply an absolute path or a `~/`-prefixed path.
- **Whitespace-only `fastpathDirectory`:** A saved value that is entirely whitespace (e.g. `"   "`) is treated as unset — the launcher trims the value and treats an empty-after-trim result the same as a blank value, falling back to auto-compute.
- **Symlinks:** The existence check uses `fs.existsSync`, which follows symlinks. A symlinked target directory is accepted and the terminal opens inside it.
- **File vs. directory:** `fs.existsSync` returns true for files as well as directories. If a file happens to exist at the resolved target path, VS Code receives it as the terminal `cwd` and will reject it (terminals require directories), effectively falling back to default behavior. The launcher does not verify that the target is a directory before passing it to `createTerminal`.
- **Network/UNC paths (e.g. `\\\\server\\share`):** The auto-compute regex only matches `/mnt/<letter>/Users/<user>/...`. A workspace path that is a network mount not matching this pattern returns `undefined` and the launcher silently falls back to the workspace folder. Users on such paths must set `fastpathDirectory` explicitly to get auto-cd behavior.
