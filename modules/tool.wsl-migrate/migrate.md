# WSL2 Migration

When the user asks to migrate a project to WSL2 — e.g. "migrate this to WSL", "move this off /mnt/c", "copy the project to Linux" — follow this procedure. Do not attempt it unsolicited.

## Inputs

- **SOURCE_PATH** — current Windows-side path (e.g. `/mnt/c/Users/aarbuckle/Project-ExamUs`)
- **PROJECT_NAME** — directory name; default: `basename` of SOURCE_PATH
- **DEST_PATH** — default `~/projects/<PROJECT_NAME>`

If SOURCE_PATH is not provided, TPM asks the user for it. Do not guess.

## Pre-flight Checks

Run all of the following before touching anything.

1. **Confirm WSL**: `uname -a` must show Linux. If it does not, abort and tell the user to open a WSL terminal first.
2. **Confirm source exists**: SOURCE_PATH must exist and be a directory.
3. **Check for destination collision**: if DEST_PATH already exists, stop and ask the user to choose one of: (a) abort, (b) pick a different name, (c) manually delete the existing destination first. Never silently overwrite.
4. **Check for git repo**: look for `.git` inside SOURCE_PATH.
5. **If it is a git repo**, run from SOURCE_PATH:
   - `git status --porcelain` — warn on uncommitted changes
   - `git stash list` — warn on stashes
   - `git log @{u}.. 2>/dev/null` — warn on unpushed commits (the `2>/dev/null` handles the case where no upstream is configured)
   - `git remote -v` — capture the remote URL

   If any of the above is non-empty, show the user the output and ask for explicit confirmation before continuing.
6. **Identify gitignored files that matter** (especially `.env*`, local config files). List them so the user knows what will and will not be copied before any file movement begins.

## Migration Strategy

Prefer **Strategy A (fresh clone)** when all of these hold:
- Working tree is clean
- A remote is configured and reachable
- The user confirms

Otherwise use **Strategy B (rsync copy)**.

### Strategy A — Fresh clone

```bash
mkdir -p ~/projects
cd ~/projects
git clone <REMOTE_URL> <PROJECT_NAME>
cd <PROJECT_NAME>
cp <SOURCE_PATH>/.env ./.env 2>/dev/null || true
# Copy any other identified untracked-but-needed files
```

### Strategy B — rsync copy (preserves uncommitted work)

```bash
mkdir -p ~/projects
rsync -av \
  --exclude='node_modules' \
  --exclude='.next' \
  --exclude='dist' \
  --exclude='build' \
  --exclude='.turbo' \
  --exclude='.cache' \
  <SOURCE_PATH>/ <DEST_PATH>/
```

## Post-migration Steps

1. `cd` into DEST_PATH.
2. Detect package manager from lockfile and install:
   - `pnpm-lock.yaml` → `pnpm install`
   - `yarn.lock` → `yarn install`
   - `package-lock.json` → `npm install`
   - `bun.lockb` → `bun install`

   Before running the install, TPM asks the user to confirm network access is available — some corporate networks block package registries.

3. If a `.env` was copied, grep it for `C:\` or `/mnt/c/` paths and warn the user about any values that need updating for Linux.
4. Sanity check: run `git status` (should be clean or match expectations) and `ls -la` to confirm the destination looks right.
5. Print a summary:
   - Source path (unchanged — see Hard Rules)
   - Destination path
   - Strategy used
   - Any warnings to address
   - Suggested next command: `cd ~/projects/<PROJECT_NAME> && code .`

## Hard Rules

- **NEVER** delete or modify SOURCE_PATH. The Windows-side copy remains intact as a safety net. The user removes it manually when they are ready.
- **NEVER** use `mv` on the source.
- **NEVER** overwrite an existing DEST_PATH without explicit user confirmation.
- If any step fails, stop and report. Do not attempt recovery by deleting partial state unless the user explicitly confirms.
- Do not run `pnpm install` (or equivalent) until the user confirms network access is acceptable.

## Nomeda Note

After a successful migration, suggest the user re-launch their CLI session from the new WSL path so the agent host re-binds to the faster location:

```
cd ~/projects/<PROJECT_NAME> && swt --cd
```

This rebinds the SWT host to the WSL2 filesystem path, which is what delivers the ~10-20x I/O improvement for Node.js, git, and AI coding tool operations.
