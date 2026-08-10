# Statusline

**Status: the renderer is live; its output is empty by default.** The Ghola statusline is the **Claude Code harness statusline** — the row the harness renders at the bottom of the session, driven by the `statusLine.command` entry in `$CLAUDE_CONFIG_DIR/settings.json` when that variable is set, otherwise `~/.claude/settings.json`. It is **not** the VS Code status-bar pill and is not produced by extension code in `src/`.

**Read this before changing either renderer:** the renderers now render **nothing** by default, and their reason to exist is the **state write** that feeds the pill, not the footer. See *The renderers' purpose is now the state write* below — it is the section that prevents the one destructive mistake this module invites.

Two renderers exist and they have a **byte-identical output contract**:

- **`scripts/ghola-statusline.mjs`** — the current renderer. Node, built-ins only. Works on **both** supported hosts (WSL and native Windows). This is what a `statusLine.command` should point at.
- **`scripts/ghola-statusline.sh`** — the original. bash + `python3`, therefore **WSL-only** in practice. Retained for back-compat; nothing needs to migrate off it on WSL. It now **delegates to the `.mjs` as a fallback writer** when its `python3` will not run — see *Failure behavior*, which also records the one case that fallback cannot cover.

On each refresh the harness runs the configured renderer, passing its JSON payload on stdin. The renderer parses that payload, writes two state files, and — **by default — prints nothing at all.**

## What the statusline shows: NOTHING, by default

> **The terminal statusline emits zero bytes on an ordinary invocation.** No bracket, no version, no metrics. Exit code 0. The harness trims empty stdout, treats it as absent, and renders **no footer row**. This is the intended, operator-requested end state, not a failure.

The renderer still **runs** on every refresh and still **writes both state files** — see the warning in *The renderers' purpose is now the state write* below, which is the single most important thing in this document.

### Re-enabling the line

`GHOLA_STATUSLINE_SILENT=0` is the escape hatch. With it set, and only with it set, the renderer emits one bracketed label on stdout with no trailing newline:

```
[Ghola vX.Y.Z]
```

That is the **whole** line. **Version only.** Read from the `VERSION` file beside the renderer, e.g. `v0.34.0`; if `VERSION` is unreadable it falls back to `vunknown`.

There is **no metrics group at all** — no context percentage, no 5-hour rolling-window percentage, no absolute token figure, no ` │ ` (U+2502) separator, no ` · ` (U+00B7) join, and **no color of any kind**. A single `printf` / `process.stdout.write` of one literal is the entire render, on every path, in both renderers. Because none of those characters is emitted anywhere, no branch can strand a doubled, leading, or trailing separator — the class of bug the old join logic existed to prevent is gone with the join. Any tint the operator sees on that row is the terminal's own styling of a custom statusline, not ours.

### How the line got to version-only, in three steps

The footer used to close with a metrics group — `[Ghola v0.16.2 │ 62% · 5h 41%]` — and the three figures were removed in three separate changes, for three different reasons. Recorded because each one is a question that gets asked again:

1. **The absolute token figure** (`142k`, from `context_window.total_input_tokens` + `total_output_tokens`, abbreviated by a `fmt_tokens`/`fmtTokens` pair both renderers carried). Dropped as **redundant** — `142k` beside `62%` is one measurement printed twice, since `142k / 0.62` recovers the window size the percentage already reports — and because its name had gone **stale**: as of Claude Code **v2.1.132** (installed here: 2.1.220) that pair reports the size of the CURRENT context window, not a running total, so it drops after a compaction and plateaus near the context ceiling. It *was* cumulative before v2.1.132, so anyone reading it as "tokens spent this session" was reading a number that stopped meaning that.
2. **Both percentages.** Dropped because the VS Code status-bar pill displays the usage stats (`Ghola: cmms2@win · Ticket Work · 262k · 5h 40%`), so the footer was printing the same numbers a second time. The red-at-85 tint went with them; it was the only color either renderer ever produced.
3. **The bracket itself.** Silenced by default, per the operator: with the pill carrying the figures, the footer row was pure noise. The render was **not deleted** — it is gated, and `GHOLA_STATUSLINE_SILENT=0` still reaches it.

**Every removal was a display decision only.** All three numbers are still computed on every render and still written to **both** state files as `session_tokens`, `context_pct`, and `five_hour_pct`.

## The renderers' purpose is now the state write

> **WARNING TO ANY FUTURE READER OR AGENT: the computations in both renderers have no visible consumer, and they are NOT dead code. Deleting them silently blanks the VS Code status-bar pill.**
>
> The renderers print nothing by default. That makes the JSON parsing, the token sum, the two percentage roundings, and the state-key derivation look like leftovers from a display that no longer exists. They are not. They are the **only** thing that feeds `~/.ghola/statusline/state/<key>.json`, which `src/session/statusline-state.ts` reads and `src/status-bar/mode-status-bar.ts` renders into the pill. There is no other writer.
>
> **The failure mode is invisible.** Nothing errors, nothing logs, no exit code changes. The pill just goes blank once the last snapshot passes the reader's 90-second staleness window, and there is nothing to grep. "Tidying up" an unused computation here, changing the on-disk key set or key order, or renaming the `updated` field are all silent-breakage changes.

So: the renderer's job is now **write, not display**. The print is the vestigial part; the writes are the product.

## Failure behavior

Neither renderer ever fails and neither ever prints error text. `VERSION` is read defensively, stdin is captured once, and all JSON parsing is wrapped. On any error the output is **nothing** (the default) and the exit code is always 0; un-silenced, an error degrades to `[Ghola vX.Y.Z]` or `[Ghola vunknown]`. There is no path on which the harness sees a crash, a stack trace, or a partial line.

### The `.sh`'s `python3` dependency, and the fallback writer that covers most of it

The `.sh`'s state writes live *inside* its `python3` heredoc, because `python3` is what parses the harness payload and computes the values in the first place — bash cannot parse that JSON alone, so there is nothing to write without it. A `python3` that would not run therefore used to mean the `.sh` wrote **no state at all**, silently, while still exiting 0 and still emitting zero bytes. With the footer blank by default there was **no visible symptom anywhere**: the only consequence was a VS Code status-bar pill that emptied 90 seconds later with nothing to grep. That mattered concretely rather than hypothetically, because this operator's live WSL `statusLine.command` points at the **`.sh`**, not the `.mjs` (see *An edit-latency asymmetry between hosts*).

**The `.sh` now covers that case by delegating to the `.mjs`.** The mechanism, in the order it happens:

1. The `python3` block's **last** statement writes a one-byte field to stdout: `1` when the silent marker file exists, `0` when it does not. That write sits *after* both state writes, so **a non-empty field is positive evidence the block ran to completion**, and an **empty** field — which is not one of its two answers — is positive evidence it did not.
2. On an empty field, bash pipes the payload it already captured into `node <script dir>/ghola-statusline.mjs` and **discards that process's stdout and stderr**.
3. Bash then prints for itself exactly as before.

Because the delegate's output is discarded, the fallback can only ever **add a state write**. It cannot change, duplicate, or suppress a byte of the `.sh`'s own output, in either silence state — so the render contract is untouched on every path.

**What it covers:** `python3` absent from `PATH`, present but not executable, a stub that exits without running the block (the Microsoft Store alias stub is one), a broken stdlib, and a crash anywhere before the final field write.

**What it does not cover, and these are the honest limits:**

- **Neither `node` nor `python3` available.** No JSON parser, no values, no write, and no way for bash to produce one. Zero bytes, exit 0, blank pill — this is the residual failure mode, and it is still silent. Making *it* visible needs a surface outside the renderer (see *A residual silent failure* below).
- **A `python3` that completes but whose write fails** on a filesystem fault. The block swallows that by design, the field still reports `0`/`1`, and no fallback is attempted — deliberately, since `node` would almost certainly fail the same way on the same directory.
- **A `.mjs` that is not a sibling of the `.sh`.** Only `"$_SCRIPT_DIR/ghola-statusline.mjs"` is tried. This is on purpose: a second candidate under `<homedir>/.ghola/statusline/` would introduce a home-directory resolution rule in bash separate from the `expanduser("~")` that resolves the state files, which is exactly the kind of second rule this renderer avoids elsewhere. Moving or renaming the `.mjs` silently disarms the fallback.
- **`node` not on `PATH` in the harness's environment.** On this host `node` comes from nvm (`~/.nvm/versions/node/<v>/bin/node`), so it is on `PATH` only for a Claude Code process launched from a shell that sourced nvm. The fallback is a `command -v node` test, so an unavailable `node` just skips the attempt — but do not assume the fallback is armed on a host without checking that `node` resolves in the *harness's* environment, not merely in an interactive shell.

**`python3` is still tried first on every render, and that is deliberate rather than incidental.** Preferring `node` would have fixed the same case, but it would also demote the `python3` heredoc to code that never runs on this host while `ghola-statusline-parity.mjs` went on certifying it — and it would make "pipe the same payload into both renderers and diff the bytes" a tautology, since piping into the `.sh` would just be running the `.mjs`. Keeping `python3` primary confines the new code path to the already-broken case, costs the healthy path no extra process spawn, and keeps both renderers independently exercised. The `.mjs` remains the recommended renderer on every host regardless; the fallback narrows the cost of *not* following that recommendation, it does not remove the reason for it.

### A residual silent failure

With **neither** interpreter available the pill still goes blank with nothing to explain it, and nothing inside the `.sh` can fix that:

- Writing a state file with `updated` but no metrics would make it **worse**, not better — the reader would see a fresh snapshot with no figures, and it would clobber a good one.
- Adding an error field to the state file would be **invisible**: `readStatuslineState` in `src/session/statusline-state.ts` reads only the four known keys and ignores everything else, so surfacing an error field there would require a reader-side change.
- stdout is the harness's UI and stderr is diagnostic noise on every render, so neither is available.

The right home for that signal is therefore a surface that already reports environment health — the boot probe, or the pill's own tooltip — not the renderer.

## How it is wired

The renderer is staged to a **version-stable** location. On every activation the extension copies `scripts/ghola-statusline.mjs` and a `VERSION` stamp into:

```
<homedir>/.ghola/statusline/
```

That indirection matters: the installed extension directory is version-pinned (`local.ghola-0.25.0/...`), so a command pointing into it silently stops working at the next version bump — the tag just disappears from the footer with nothing to explain it. The staged path never changes, so the operator configures `statusLine.command` **once**. The staging is idempotent (it compares the stamp and the renderer bytes and does nothing when already current), never blocks or fails activation, and touches only those two files — `usage-state.json` and `ledger/` in the parent directory, and the `state/` subdirectory the renderers write, are never read or written by it.

`$CLAUDE_CONFIG_DIR/settings.json` when that variable is set, otherwise `~/.claude/settings.json`, on **WSL**:

```json
{ "statusLine": { "type": "command",
                  "command": "node /home/aarbuckle/.ghola/statusline/ghola-statusline.mjs" } }
```

`%CLAUDE_CONFIG_DIR%\settings.json` when that variable is set, otherwise `%USERPROFILE%\.claude\settings.json`, on **native Windows** (forward slashes so no JSON backslash escaping is needed):

```json
{ "statusLine": { "type": "command",
                  "command": "node C:/Users/aarbuckle/.ghola/statusline/ghola-statusline.mjs" } }
```

Substitute the real home directory on each host. The `node <path>` form is used on both platforms deliberately: it works whether or not the file carries an exec bit, and a `.mjs` cannot be launched by shebang on win32 at all.

**Dependencies: `node` only.** The `.mjs` renderer needs no npm packages, no `bash`, no `python3`, and no `jq`. That is the whole reason it exists — on the operator's Windows host `bash.exe` is not on PATH (Git for Windows only puts `...\Git\cmd\` there, not `...\Git\bin\`) and `python3` resolves to the Microsoft Store alias stub rather than a real interpreter, so the legacy `.sh` renderer would fail there twice over even if its POSIX command path resolved. The legacy `.sh` requires `bash` and must be `chmod +x`, plus **either `python3` or `node`** — `python3` for its own render, `node` for the fallback writer that covers a `python3` which will not run. It is fine on WSL and unusable on win32 regardless, because its POSIX command path does not resolve there and `bash.exe` is not on the Windows `PATH` at all, so the fallback never gets the chance to help.

The renderer resolves `VERSION` from its own directory: `<dir>/../VERSION` (the repo and installed-extension layout, where it sits in `scripts/`) and then `<dir>/VERSION` (the flat staged layout). A non-empty `GHOLA_DIR` environment variable overrides both and is used as the sole location.

### An edit-latency asymmetry between hosts

The example commands above are the documented recommendation: point `statusLine.command` at the staged copy on every host. Verified live configuration here does not match that on both sides — this operator's WSL `statusLine.command` points at the **repo** script directly (`scripts/ghola-statusline.sh`), while native Windows points at the **staged** copy (`%USERPROFILE%\.ghola\statusline\ghola-statusline.mjs`), which does follow the recommendation.

That split means the same renderer edit takes effect on a different schedule per host. On WSL here, editing the repo script is live on the very next render — there is no staging step in that path at all. On Windows here, editing `scripts/ghola-statusline.mjs` in the repo changes nothing until the extension re-stages it, which happens only at activation (a dev-host launch or a reinstall) — the same edit needs an install plus a window activation before it shows up there.

Pointing at the staged copy is the documented recommendation for exactly this reason: it decouples the footer from the extension's version-pinned install path (see above) and gives one predictable, install-triggered refresh point instead of two different ones per host. The repo-script form works, but it couples the footer to the repo living at one fixed path — move or rename the checkout and the command silently stops resolving, with the same silent-failure signature as every other misconfiguration in this document: the tag just disappears with nothing to explain it.

## Side effect: two usage snapshots

On every render the renderer mirrors the numbers it just displayed into **two** files, both under `~/.ghola/`, never the work repo, and both written atomically (temp file then rename, with the renderer's PID in the temp name so concurrent renders cannot tear each other's write). Both writes happen on every render; neither is conditional on the other.

**1. `~/.ghola/usage-state.json` — unkeyed.** Written when the payload carries a token count or a 5-hour figure. `tool.usage-observer` was once documented as this file's consumer; that module is **retired**, so the file has **no in-repo reader today**. It is kept anyway as a **stable external contract** — both renderers still write the same location, the same keys, and the same key order, so anything reading it from outside this repo (or a future in-repo consumer) sees an unchanged shape. A payload with no usage signal writes nothing, so an empty render never clobbers a good snapshot. One path, shared by every session — which is exactly why it cannot serve the status bar (see below).

**2. `~/.ghola/statusline/state/<key>.json` — keyed per session, for the VS Code status bar.** Same shape and same key order as the unkeyed file:

```json
{"updated": 1785421479, "session_tokens": 299949, "context_pct": 30, "five_hour_pct": 11}
```

**`session_tokens` is a misnomer as of Claude Code v2.1.132.** The value is `context_window.total_input_tokens + total_output_tokens` (see *How the line got to version-only* above), and that pair now reports the CURRENT context window's size, not a cumulative session total — it can shrink after a compaction and plateaus near the model's context ceiling. The key name is unchanged and must stay unchanged: it is shared verbatim by both renderers as part of the unkeyed file's stable external contract (see *Side effect: two usage snapshots* — `tool.usage-observer`, once named as its consumer, is retired and the file has no in-repo reader today, but the contract still has to hold for whatever reads it externally), and renaming it would break that contract. Read the key, not its name.

**This field is read AND rendered** — by `src/status-bar/mode-status-bar.ts`, which puts an abbreviated form of it in the pill (see *The VS Code status-bar pill* below). It is the reason `formatTokenCount` in `src/session/statusline-state.ts` is a live function with a live caller. **The key also outlived the footer segment it used to mirror**: the renderers no longer display the figure but still write it, precisely because a display change must not propagate into this shape — and the pill proves the point, because it went on rendering the number after the footer stopped.

`updated` is epoch **seconds**. Every metric field is optional and gated on its own source value being present — `five_hour_pct` requires a Pro/Max `rate_limits` block and only appears after the first API response, and `context_pct` can be absent independently of `session_tokens`, so a reader must gate each metric separately rather than letting one missing field blank the segment. The write gate here is slightly **wider** than the unkeyed one: any single metric is enough, where the unkeyed write ignores a context percentage that arrives with no token count. A payload with no metric at all still writes nothing.

The keyed file exists because the unkeyed one **cannot be attributed to a window**. With 8+ concurrent sessions all writing one path, a status bar reading it would show whichever session rendered last, in every window, while looking authoritative. The key is per repository root, so each session gets its own file and the reader can only ever be right about the window it is running in.

### The key

`GHOLA_STATE_KEY`, when present and non-empty in the environment, **is the key, used verbatim** — no normalization, no folding, no hashing, and no git-root walk. `src/session/launcher.ts` exports it into every Ghola-launched session, computed from the VS Code workspace folder's git root. That is not belt-and-braces: the terminal can be opened in the WSL-native clone of a `/mnt/c/...` workspace, in which case the renderer's own walk would reach a *different* root than the workspace folder does and the two sides would key on two different paths. The env var makes writer and reader agree by construction.

Without it, the renderer derives the key from the payload's `workspace.project_dir`: walk up (inclusive) to the nearest ancestor holding a `.git` **entry** (existence, never `isDirectory` — it is a *file* in a worktree or submodule), falling back to the starting directory when there is none, then `<folded-path>-<sha256(normalized-path)[0:8]>`. An empty or whitespace-only `project_dir` produces **no key and no keyed write** rather than a walk that would resolve `.git` against the harness's cwd.

**`src/session/statusline-state.ts` is the normative spec** for all of it — every step, in order, with the reasoning. Do not restate the algorithm anywhere else and do not change a step in one place: it is implemented **three** times (that file, `ghola-statusline.mjs`, and the `python3` block in `ghola-statusline.sh`) and drift fails **silently**, because the writer writes one path while the reader reads another and the status-bar segment simply never appears.

### The parity gate: `node scripts/ghola-statusline-parity.mjs`

Because that drift is invisible — no error, no log line, nothing to grep — the triplicate has a checker, and it is now a **blocking pre-commit gate**, not a standalone one: `.githooks/pre-commit` carries a `PARITY_CHECKS` registry with one record per checker, and this checker's record lists `src/session/statusline-state.ts`, `scripts/ghola-statusline.mjs`, and `scripts/ghola-statusline.sh` as trigger paths (the checker's own path is always an implicit trigger too). The gate runs — on an exact whole-path match against the staged set, nothing looser — whenever a commit stages one of those files, and exit 1 (a genuine divergence) **refuses the commit**, naming the checker in the message; every other outcome (exit 2, a missing checker, no `node`, no `esbuild`, or any other status) prints a notice and lets the commit through. Two holes remain and neither is closed by any of this: `GHOLA_SKIP_HOOK=1` bypasses the entire hook, and a commit that changes a triplicate file without staging it (or stages only unrelated files) never trips the trigger. Absent either of those, this is no longer a check that only runs when someone types the command. It reaches all three implementations without modifying or executing any of them (esbuild `transformSync` for the TypeScript, anchored line-range extraction for the `.mjs`, and the `python3` heredoc body sliced down to its constants and `def`s so the state write is left behind), then asserts that they agree with each other **and** with nine baked-in normative vectors, on the four shared constants, on `normalize` -> `fold` -> `key`, on the structural invariants of every key, on which inputs must collide and which must not, and on `GHOLA_STATE_KEY`-wins-verbatim plus the git-root walk. Exit 0 means parity; 1 means drift, naming the implementation, the stage, and the input; 2 means an implementation could not be reached, which is treated as a failure rather than tolerated. It touches nothing under `~/.ghola` and writes only to a stable scratch directory in the OS temp dir, the same convention `scripts/ghola-path-parity.mjs` uses for the host-path triplicate.

Run it after any change to a key-derivation step in any of the three files: the pre-commit gate above will also catch it on a normal staged commit, but do not rely on that alone — `GHOLA_SKIP_HOOK=1` skips it entirely and a commit that leaves the changed file unstaged skips it too. The vectors are the point: three implementations can agree on the *wrong* answer if someone "improves" all three in one commit, and only the vectors catch that. It carries **no quarantined case**. The one it used to carry is resolved: Python's `$` (non-MULTILINE) also matches before a single trailing newline where JavaScript's `$` does not, so a path ending in `/` + `\n` normalized differently in the `.sh`. The fix landed — both `re.sub` calls in `ghola-statusline.sh` now anchor on `\Z` (`normalize_state_key_path` and `find_repo_root`), which is the absolute-end match all three languages share — and the checker now asserts that case normally, labeling it `FORMERLY QUARANTINED` in its output.

**Staleness belongs to the reader, not the writer.** The renderers never gate on age; they write whenever they render. The reader treats a snapshot older than **90 seconds** (`STATE_STALE_AFTER_MS`) as stale. That threshold is deliberately not 30s: the harness re-renders on assistant messages rather than on a clock, so a single long agent run legitimately emits no writes for a minute or more, and a tighter threshold would blank the segment on a perfectly healthy session.

## Silent mode: THE DEFAULT

> **Do NOT delete `statusLine` from `$CLAUDE_CONFIG_DIR/settings.json` (or `~/.claude/settings.json` when that variable is unset), even though the footer is now blank by default.** The renderer is also the **writer** of both state files above, including the keyed one the VS Code status-bar pill reads. Removing the `statusLine` entry stops the harness invoking the renderer at all, so nothing writes state, and the pill's figures go empty inside the reader's 90-second staleness window — on **both** hosts. A blank footer and a working pill are the same script: the renderer must keep being invoked, keep running, and keep writing. It simply prints nothing.

**Silence is the default, so there is nothing to switch on to get it.** The renderer runs on every refresh, writes both state files, and prints nothing. This reuses the already-tested opt-in path rather than adding a new one, and it keeps the change reversible: one named constant (`SILENT_BY_DEFAULT` in the `.mjs`, `_SILENT_BY_DEFAULT` in the `.sh`) restores a printing default, and the rendering code it gates is deliberately intact.

Two controls, in this precedence order:

1. **`GHOLA_STATUSLINE_SILENT`** (environment variable) — checked **first**, and **the only thing that can change the outcome**.
   - `0`, `false`, `no` (case-insensitive, surrounding whitespace trimmed) -> **not silent**. This is the **escape hatch**: it puts the `[Ghola vX.Y.Z]` bracket back for one session, and it beats the marker file too.
   - `1`, `true`, `yes` -> **silent**, which is what would have happened anyway.
   - Unset, empty, whitespace-only, or any unrecognized value -> **no signal**; falls through to the default, which is silent. (Empty is deliberately absence rather than an explicit "not silent": `export GHOLA_STATUSLINE_SILENT=` is what a shell does when a variable is cleared, and treating it as an override would put the bracket back in every such shell. A typo like `flase` also defers, so no misspelling can resurrect the footer by accident — every ambiguous input now errs toward *silence*, which is the **inverse** of what it used to do and follows the default rather than contradicting it.)
2. **`<homedir>/.ghola/statusline/silent`** (marker file) — still probed, still answers "silent" when it **exists**, and now **redundant**: it can only ever ask for the behavior that already happens. It is kept rather than removed so a marker the operator already created keeps meaning exactly what it said. **Contents are irrelevant**; existence is the entire signal. It sits beside the staged renderer and the `VERSION` stamp, so it needs no new directory and no new path-resolution rule; the home directory is resolved by exactly the same call that resolves the state files.

Silence is about **stdout only**. Both state writes happen unconditionally and *before* the print gate, so the unkeyed file's stable external contract and the status-bar pill are unaffected — that is the whole point.

### The fail-safe direction inverted with the default

It used to be that **a failed check degrades to NOT silent**: an unreadable marker directory, a permission error, or a `python3` that would not run all fell through to the normal line, on the reasoning that a broken probe must never blank the operator's footer.

**That is no longer true, and the reversal is deliberate.** A failed check now yields *no signal*, which falls through to the silent default, so a broken probe or a dead `python3` produces zero bytes. Printing a bracket the operator asked to be rid of is the wrong answer, and there is no longer a footer to protect. In practice the marker probe can no longer change the outcome in *either* direction, which is a strictly simpler property than the one it replaced.

What has **not** changed, and is the invariant that actually matters: a failure never aborts the render and both renderers still exit 0 on every path.

Be precise about the state write, though, because the older wording here claimed a failure "never suppresses a state write" and that was **not** true of the `.sh`: a dead `python3` cost it both writes, since they live inside the heredoc. As of the fallback writer described under *The `.sh`'s `python3` dependency* that case is covered whenever `node` and the sibling `.mjs` are reachable, and **only** then — with neither interpreter available nothing is written. Claim the fallback, not blanket robustness.

### Operator commands

**Getting the line back** is the only command that does anything now, since silence needs no action:

```bash
GHOLA_STATUSLINE_SILENT=0 claude   # bracket back on for this session, marker or not
```

```powershell
$env:GHOLA_STATUSLINE_SILENT = "0"; claude
```

Forcing silence explicitly is a no-op against the default, but the value is still honored if someone wants it spelled out:

```bash
GHOLA_STATUSLINE_SILENT=1 claude
```

The **marker file** now buys nothing over the default, so there is no reason to create one. If a host already has one, it agrees with the default and can be left alone; removing it changes nothing either. Deleting it is a file deletion and therefore the operator's call, not an agent's:

```bash
rm -f ~/.ghola/statusline/silent                                                  # WSL / bash
```

```powershell
Remove-Item -Force -ErrorAction SilentlyContinue "$env:USERPROFILE\.ghola\statusline\silent"
```

The two hosts have **separate** home directories and therefore separate markers — but with silence as the default that no longer produces a per-host behavior split, because neither host needs a marker to be quiet.

**A renderer change only takes effect once the host is running the new renderer.** `statusLine.command` should point at the *staged* copy in `<homedir>/.ghola/statusline/`, which the extension refreshes on activation by comparing bytes. Until that re-staging happens (a dev-host launch or a reinstall), the older staged renderer keeps printing its bracket. That one-activation lag applies to this default inversion exactly as it applies to every other renderer edit, and it is the likeliest reason the footer is still showing after this change lands. See *An edit-latency asymmetry between hosts* above: the operator's WSL config points at the repo `.sh` directly, so on WSL the change is live on the very next render with no staging step at all.

### What the harness does with no output

Claude Code `.trim()`s the renderer's stdout, drops blank lines, and treats an empty result as **absent** — so printing nothing and printing a bare newline are indistinguishable to it. It then renders **no row at all** in the default TUI; only in fullscreen / no-flicker mode does it reserve the slot with a single space, because there the layout is fixed. That choice is the harness's, not the renderer's: the script writes zero bytes and has no further lever. Determined by reading the status-line component and its command executor in the Claude Code 2.1.220 bundle, and consistent with the public docs' "Scripts that exit with non-zero codes or produce no output cause the status line to go blank". Note the harness only uses the output at all when the exit code is 0, which both renderers always are.

## The VS Code status-bar pill (a different surface, and the one that still shows numbers)

The pill is **not** this module's output — it is `src/status-bar/mode-status-bar.ts`, a **reader** of the keyed state file. It is documented here anyway, because it is the reason the renderers still compute everything they compute, and because "the footer stopped showing X" is only ever answerable alongside "the pill shows X instead".

Its label is:

```
Ghola: <SwitchboardID> · <Modality> · <tokens> · 5h <N>%
```

for example `Ghola: cmms2@win · Ticket Work · 262k · 5h 40%`. The leading `Ghola:` is the literal product name, always — on every host, in every repo. `<SwitchboardID>` is a separate, derived segment: the Team Switchboard identity, environment-qualified (`cmms2@win` on a native-Windows cmms clone). The two are not the same thing, and both now appear, which means **in Project-Ghola itself the pill reads `Ghola: Ghola · Self Upgrade · …`** — this repo's identity strips to the literal string `Ghola`, so the prefix and the identity segment collide in text even though they are two different values. That doubling is expected, not a bug.

When no identity resolves (no workspace folder open), the identity segment is **omitted entirely** — no placeholder, no fallback literal — and the label becomes `Ghola: Unconstrained · …`. The previous `NO_IDENTITY_LABEL` fallback of `'Ghola'` was **deliberately not reinstated**: with the `Ghola:` prefix present, that fallback would render byte-identically to this repo's real identity segment, which is exactly the collision described above and would make the two cases indistinguishable from the label alone.

`<Modality>` is display-cased (`Ticket Work`, `Support`, `Project`, `Self Upgrade`, `Unconstrained` — note `cd` displays as `Project`), never the raw hyphenated mode token. The absolute token figure is **rendered here**, abbreviated by `formatTokenCount` in `src/session/statusline-state.ts` — **that function is live and has a live caller.** The identity appears in **both** the label and the tooltip; the tooltip is not where it "survives" but where it does a different job — it explains the derivation (what value fed it, and why), which the label's bare string cannot. The tooltip also leads with an absolute-token clause.

So the token figure was never removed from Ghola, only from the footer: the footer dropped it as redundant beside a percentage it no longer prints either, while the pill kept it as the one place the number is actually useful. Any comment or note claiming `formatTokenCount` was deleted, or that the pill renders only percentages, is stale — it is live.

## Fixed behavior vs parameters

Neither renderer has **settings-file toggles**, and the six declared settings are **inert** — `showVersion`, `showCumulativeTokens`, `showContextPercent`, `showRollingWindowPercent`, `redThresholdPercent`, and `fallbackToVersionOnly` have **zero references** in either renderer.

Several of them now name things that do not exist at all, rather than merely being unread: there is no context percentage, no rolling-window percentage, and no red threshold in the rendered output, and by default there is no rendered output.

**`showCumulativeTokens` is RETIRED and INERT**, which is a step beyond the others: they at least name a concept, whereas the token segment has been removed from both renderers, so there is nothing left for that setting to govern in either direction. Its `label` is `Show Context Token Count (RETIRED)` and its `description` leads with `RETIRED and INERT`, matching how `ghola.remoteControlSessionName` is handled in `package.json`. **Its key and its `default` are deliberately left untouched** — not deleted, not renamed, not re-defaulted — because dropping or changing a declared setting orphans whatever value the operator already saved for it. Nothing reads it, and nothing should start.

**They are not merely unimplemented — they are unimplementable as written.** Ghola module settings live in VS Code's `globalState`, an opaque `Memento` with no on-disk representation. The renderers are standalone scripts that the Claude Code harness executes *outside* the extension host, so there is nothing for them to read. Wiring these toggles would first require exporting them to a file or an environment variable. Each setting's `description` in `manifest.json` now says so explicitly, because the Modules tab renders that text directly beneath the control — which is where the misleading impression was being created, and therefore where the correction has to live. This document is the secondary record; the manifest is the primary one.

They are kept rather than deleted: removing a declared setting can strand a stored value, and whether to drop them is the operator's call.

Today's behavior is: **nothing rendered by default**, and `[Ghola vX.Y.Z]` when un-silenced. Changing that is a renderer edit, not a settings change — and it must be made in **both** renderers to keep them byte-identical. **Silent mode is the one exception to "no runtime configuration"**, and it is deliberately controlled by an environment variable and a marker file rather than a module setting, precisely because those are the only two things a standalone script can actually see.

## What this module does NOT do

- **Installs nothing.** This module is **documentation only**. Enabling it does not create, modify, or remove the `statusLine` entry in `$CLAUDE_CONFIG_DIR/settings.json` (or `~/.claude/settings.json` when that variable is unset), and disabling it does not turn the statusline off. That file is the operator's live harness config and no Ghola code writes it — the operator adds the line above by hand, once. (This has surprised us before: the reason the tag appears on WSL and not on Windows is simply that the WSL settings file has a `statusLine` key and the Windows one does not.) Renderer staging is likewise done by the extension on activation regardless of whether this module is enabled.
- **Does not control silent mode either.** Toggling this module on or off has no effect on the default, the environment variable, or the marker file, and no Ghola code creates or deletes `<homedir>/.ghola/statusline/silent`. The silent default lives in the renderers themselves; the escape hatch is the operator's environment. Deleting a marker file is a file *deletion*, so an agent should hand the operator the command rather than run it.
- Does **not** render the VS Code status-bar pill. The statusline is the harness line only. The pill is `src/status-bar/mode-status-bar.ts`; it is a **reader** of the keyed state file described above, so the two surfaces share data, but nothing in this module draws it and the renderers know nothing about it beyond the file they write. The relationship is now one-directional in an important way: the footer shows nothing and the pill shows everything, off the same snapshot.
- Does **not** track or compute tokens itself; it formats whatever the harness supplies on stdin.
- Does **not** talk to any external service, telemetry endpoint, or remote logger. All data is local to the active session's payload.

## Role-Specific Notes

The body above applies identically to every agent. The notes below frame how each role relates to the live statusline.

### TPM

**The terminal statusline renders nothing.** That is the current, intended state: the renderer is silent by default, so the harness shows no footer row. What is still live is the renderer *process* — it runs on every refresh and writes the state files that feed the VS Code status-bar pill. If the user asks where the footer went, that is the answer, and the follow-up is that the numbers moved to the pill (`Ghola: cmms2@win · Ticket Work · 262k · 5h 40%`), which is why nothing was lost.

`GHOLA_STATUSLINE_SILENT=0` is the escape hatch and brings back `[Ghola vX.Y.Z]` — **version only.** Do not promise percentages or a token figure: those were removed from the rendered line before it was silenced, and un-silencing cannot bring them back.

Four honesty points to keep straight:

- **Never suggest deleting `statusLine` from `$CLAUDE_CONFIG_DIR/settings.json` (or `~/.claude/settings.json` when that variable is unset)** to keep the footer away, even though the footer is already gone. The renderer is the writer of the state files the pill reads, so that blanks the pill within 90 seconds — silently, with nothing to grep. The footer being blank and the renderer being invoked are not in tension; they are the design.
- If the user wants the line **back**, give them `GHOLA_STATUSLINE_SILENT=0` from *Operator commands*, and warn them that a host pointing at the *staged* renderer needs an activation before any renderer change takes effect at all.
- The module's six `parameters` are not honored and *cannot* be, so toggling them in the Modules tab changes nothing. Say so plainly. `showCumulativeTokens` is the sharpest case: it is **retired and inert**, and turning it on cannot restore a token segment, because the segment does not exist in either renderer — the pill is where that number lives now.
- If the user expected a footer on a host and there is a *configuration* question underneath, the usual cause is that the host's settings file — `$CLAUDE_CONFIG_DIR/settings.json` when that variable is set, otherwise `~/.claude/settings.json` — has no `statusLine` key. Check which file the harness is actually reading before assuming it is the default one: `$CLAUDE_CONFIG_DIR` relocates it away from `~/.claude` when set. Ghola never writes that file. But check the silent default first: today a missing footer is normal, not a symptom.
- **If the *pill* went blank rather than the footer, ask which renderer the host is pointing at.** A blank pill means nothing has written the keyed state file in 90 seconds. On a host pointing at the `.sh` (which is this operator's live WSL config) the historical cause was a `python3` that would not run; the `.sh` now falls back to `node` for that, so the remaining interpreter-level cause is **both** `node` and `python3` being unavailable — which is still silent, by admission, and is recorded under *A residual silent failure*. Do not present the fallback as making the pill unconditionally reliable.

### SWE

There are two renderers and they must stay byte-identical: `scripts/ghola-statusline.mjs` (Node, cross-platform, the one operators point at) and `scripts/ghola-statusline.sh` (bash + `python3`, WSL-only, back-compat — and it now calls the `.mjs` as a fallback writer when its `python3` will not run, so the two are coupled by sibling path as well as by contract). Any change to output or gating is a direct edit to **both**, verified by piping the same payloads into each and diffing the bytes — including the empty and malformed-JSON payloads, not just the happy path, and in **both** silence states.

**Before you "clean up" anything in either renderer, read *The renderers' purpose is now the state write* above.** Both files print nothing by default, which makes every computation in them look orphaned. They are not: they feed the keyed state file that is the pill's only source. Deleting one breaks the pill with no error and no log line.

**Silent mode is part of the pair contract, and silence is the DEFAULT.** Same default (`SILENT_BY_DEFAULT` / `_SILENT_BY_DEFAULT`, both `true`/`"1"`), same environment variable, same marker path, same precedence, same truthiness sets, in both files — and both must gate **only** stdout, never the state writes, which happen earlier and unconditionally. In the `.mjs` the flag is resolved once at module scope so the last-resort `catch` fallback honors it too; in the `.sh` the marker probe lives inside the `python3` block (so the home directory is resolved by the same `expanduser` that resolves the state files) and is reported to bash as a **single unseparated field** — there is nothing left to split on, so growing a second field back means re-adding a split in bash in the same edit. The environment override is normalized in pure bash so it survives a `python3` that will not run, which is now load-bearing: it is the only signal that can turn the line back on.

**The failure direction inverted.** Every failure path now answers **silent** (it yields no signal and falls through to the default), where it used to answer *not silent*. Do not "restore" the old fail-open behavior — printing a bracket the operator asked to be rid of is the wrong answer. What must still hold: no failure aborts the render and both exit 0. Neither file may grow a `set` line to get there — `ghola-statusline.sh` has **no `set` line at all** and its header says so; its never-fail contract depends on that.

**The `.sh` has a fallback writer, and it is not a general robustness claim.** Its `python3` block reports a one-byte field (`1` marker / `0` no marker) as its **last** statement, after both state writes, so an **empty** field proves the block never finished; bash then re-runs the render as `node "$_SCRIPT_DIR/ghola-statusline.mjs"` with the delegate's stdout and stderr discarded. Three rules follow for anyone editing either file. (1) **That final `sys.stdout.write` must stay last and must never emit an empty string** — moving it above the state writes, or adding a step after it that can fail, silently turns the detector into a liar in the direction that matters. (2) **`python3` stays the primary parser**; do not "optimize" by preferring `node`, which would leave the heredoc — the parity checker's third implementation — as code that runs on no real host, and would make byte-diffing the two renderers a tautology. (3) The `.mjs` is resolved **by sibling path**, so renaming or moving it out of `scripts/` disarms the fallback with no error. Full rationale and the uncovered cases are in *The `.sh`'s `python3` dependency* above; do not restate the coverage more strongly than it is written there.

Watch for the traps that make parity non-obvious: Python's `round()` is round-half-to-EVEN (`62.5` -> `62`) where `Math.round` is half-up, Python's `int()` truncates toward zero, and Python's `isinstance(x, int)` accepts `bool`. The `.mjs` mirrors all three deliberately, and all three still matter because the values still go **on disk**. Preserve the never-fail contract on both, and keep ASCII quotes in code. `~/.ghola/usage-state.json` is a stable external contract, not a live cross-module one — `tool.usage-observer`, once documented as its consumer, is retired, so the file has no in-repo reader today, but the shape (same path, same keys, same key order, atomic write) must stay exactly as it is regardless, for whatever reads it externally.

The state-key algorithm makes it a **triplicate**, not a pair: the third copy is `src/session/statusline-state.ts`, which is the normative spec, and a change to any step must land in all three in the same commit — then run `node scripts/ghola-statusline-parity.mjs` before you commit. `.githooks/pre-commit` also gates this now: staging any of the three files (or the checker itself) triggers it, and a divergence refuses the commit. That gate is not a substitute for running the check yourself, though — `GHOLA_SKIP_HOOK=1` bypasses it entirely, and it never fires on a commit that changes one of the three files without staging it. Treat a non-zero exit as a stop-and-fix signal either way. Its own traps are recorded there and are easy to get wrong from memory — ASCII-only case folding via an explicit `[A-Z]` class (never `toLowerCase()`/`.lower()`, which diverge on non-ASCII between the three languages), hashing the *normalized path* rather than the folded body (folding is lossy, so hashing the body would preserve the collision the hash exists to break), edge-hyphen trimming *after* truncation, and `.git` tested for existence rather than directory-ness. Note also that Python's `json.dump` defaults to `", "`/`": "` separators where `JSON.stringify` emits none, so the keyed write passes `separators=(",", ":")`; the unkeyed write does not and the two renderers' `usage-state.json` therefore differ by whitespace, which is harmless because every reader parses rather than compares.

### QA

**The headline assertion is that there is no output.** Pipe a full sample harness payload into `scripts/ghola-statusline.mjs` under a redirected `HOME` and confirm **zero bytes** on stdout and exit 0. Repeat with empty stdin and with malformed JSON: zero bytes, exit 0, and no error text on stderr on any of them. Then pipe each identical payload into `scripts/ghola-statusline.sh` and confirm the bytes match — the two are a hand-maintained pair and must agree in every case, including the silent ones.

Then the escape hatch: `GHOLA_STATUSLINE_SILENT=0` with a full payload must yield exactly `[Ghola vX.Y.Z]` and nothing more. **Version only** — there is no context percentage, no 5-hour percentage, no token figure, no `│`, no `·`, and no ANSI escape anywhere in the output. Removing a percentage from the payload cannot change that line, so vary the payload and confirm the output does not move. A `\033[` appearing in stdout is a regression; so is any metrics group.

**The check that actually matters is the write, not the render.** With stdout empty, both state files must still be created under the redirected `HOME`: `~/.ghola/usage-state.json` and `~/.ghola/statusline/state/<key>.json`, the latter carrying all three of `session_tokens`, `context_pct`, and `five_hour_pct` for a payload that supplies all three. A renderer that emits zero bytes *and* writes nothing looks identical to a correct one from the terminal, and blanks the pill 90 seconds later. Verify the fields, not just the file's existence. Also confirm the gate asymmetry survives: a payload with a context percentage but no token count writes the **keyed** file and not the unkeyed one, and a payload with no metric at all writes neither.

Silent-mode precedence needs its own checks, in both renderers, under a redirected `HOME`: no env and no marker (zero bytes — the default), marker present (zero bytes), `GHOLA_STATUSLINE_SILENT=1` (zero bytes), `GHOLA_STATUSLINE_SILENT=0` (prints), `GHOLA_STATUSLINE_SILENT=0` **with** the marker present (prints — the explicit override must beat the file), and a typo such as `flase` plus an empty-string value (both zero bytes — every ambiguous input errs toward silence now). **Never create `~/.ghola/statusline/silent` in the operator's real home**; it is redundant against the default anyway, so there is no reason to.

**The fail-safe direction is now silence — do not test for the old behavior.** Make the marker path unreadable (a non-directory partway along it, or mode `000` on its parent) and confirm the output stays at zero bytes and the exit code stays 0. For the `.sh`, stub `python3` to exit non-zero and confirm the same: exit 0, zero bytes.

**In that stubbed case the `.sh` must now still write both state files**, via the fallback writer described under *The `.sh`'s `python3` dependency* — the old note here said it wrote no state, and that is no longer the behavior. Test the whole grid, because each cell asserts something different: `python3` stubbed non-zero, `python3` absent from `PATH` entirely, `node` absent with `python3` present, and **neither** available. The first three must all produce both state files with all four fields; the last must produce **none** and is the documented residual failure. Two things make this testable without trusting exit codes:

- **The unkeyed file names its writer.** Python's `json.dump` emits `{"updated": 1785567980, ...}` with spaces; `JSON.stringify` emits `{"updated":1785567980,...}` with none. Spaces mean the heredoc wrote it; no spaces mean the `node` fallback did. (The *keyed* file is byte-identical from both by design, so it cannot tell you this.)
- **"Absent from `PATH`" has to be real absence, not a shadowing stub.** Build a scratch directory of symlinks to only the externals the `.sh` needs — `bash`, `cat`, `tr`, `dirname`, plus whichever interpreter the case keeps — and set `PATH` to just that. Omitting `bash` makes the `#!/usr/bin/env bash` shebang fail with exit 127 and looks exactly like a renderer bug.

Also confirm the healthy path does **not** delegate: `bash -x` the `.sh` with a good `python3` and check that `node` is invoked **zero** times and the trace shows `silent_marker=0` (or `=1` with a marker present). An empty `silent_marker` on a healthy host means the detector has broken.

Two further cautions. First, both renderers write `~/.ghola/usage-state.json` **and** `~/.ghola/statusline/state/<key>.json` on any payload carrying a usage signal — override `HOME` to a scratch directory when running test payloads, or you will overwrite the operator's live snapshots. Second, staging is only exercised at extension activation, so verifying `<homedir>/.ghola/statusline/` requires an actual activation (a dev-host launch or a reinstall), not just a script run. Note that the extension's staging step copies only the renderer and the `VERSION` stamp, so it neither creates nor removes a marker sitting in that same directory.

The keyed file is worth checking on its own terms, because a wrong key fails **silently** — the file lands somewhere real and the status-bar segment simply never appears. Start with `node scripts/ghola-statusline-parity.mjs`: it must exit 0, and it covers the three-way agreement of the key algorithm far more thoroughly than a rendered payload can. It is read-only with respect to the repo and never touches `~/.ghola`, so it is safe to run unguarded. Then verify the parts it cannot: set `GHOLA_STATE_KEY` and confirm it is honored verbatim with no derivation; unset it and confirm the key is derived from `workspace.project_dir` and matches what `src/session/statusline-state.ts` computes for the same path; confirm a blank `project_dir` writes nothing at all rather than keying off the cwd. Both renderers must produce the **same filename and the same bytes** for the same payload (modulo `updated`, which is epoch seconds and can cross a boundary between two processes).
