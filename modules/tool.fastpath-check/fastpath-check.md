# Fast Path Check

This module is **proactive**: read it once, at session start, before responding to the user's first request. It does one thing — detect whether the work repo lives on a slow filesystem path and, if so, tell the user once. It does **not** migrate anything.

## What To Check

At the very beginning of the session, look at the current working directory.

- **On WSL / Linux:** if the cwd starts with `/mnt/c/`, `/mnt/d/`, or any other `/mnt/<letter>/` mount, the repo is on the Windows filesystem accessed across the WSL/Windows boundary. That boundary is slow — typically ~5-6x slower than a WSL-native path for I/O-heavy workloads (npm/pnpm install, esbuild/webpack builds, git, grep, large `Read` sweeps).
- **On native Windows:** if the cwd starts with a drive letter like `C:\` and the session is otherwise expected to use a WSL toolchain, the same penalty applies.
- **On macOS, Linux without WSL, or a WSL-native path (`/home/...`, `~/projects/...`):** no action — the cwd is already fast.

## What To Say

If — and only if — the cwd matches the slow-path pattern, surface a single, short advisory to the user as part of your opening message. Phrase it as a heads-up, not a blocker:

> Heads up — this repo is on the Windows filesystem (`/mnt/c/...`). Moving to a WSL-native path (`~/projects/...`) typically gives ~5-6x I/O speedup for builds, git, grep, and `npm install`. Not blocking — but worth doing when convenient.

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
