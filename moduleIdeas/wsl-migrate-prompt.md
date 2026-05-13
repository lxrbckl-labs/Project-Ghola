# Migrate Project to WSL2 Linux Filesystem

You are helping migrate a code project from the Windows filesystem (`/mnt/c/...`) into the WSL2 Linux filesystem (`~/projects/...`) for ~10-20x faster file I/O when working with Node.js, git, and AI coding tools.

## Inputs

- **SOURCE_PATH**: The current Windows-side path (e.g., `/mnt/c/Users/aarbuckle/Project-ExamUs`)
- **PROJECT_NAME**: The directory name (default: basename of SOURCE_PATH)
- **DEST_PATH**: Default `~/projects/<PROJECT_NAME>`

If SOURCE_PATH is not provided, ask for it. Do not guess.

## Pre-flight Checks (do all before touching anything)

1. Confirm we're inside WSL: `uname -a` should show Linux. If not, abort and tell the user to run from WSL.
2. Confirm SOURCE_PATH exists and is a directory.
3. Check if DEST_PATH already exists. If yes, STOP and ask the user whether to:
   - (a) abort
   - (b) pick a different name
   - (c) delete the existing dest first

   Never silently overwrite.
4. Check if SOURCE_PATH is a git repo (`.git` directory present).
5. If it's a git repo, run from SOURCE_PATH:
   - `git status --porcelain` — warn if there are uncommitted changes
   - `git stash list` — warn if there are stashes
   - `git log @{u}.. 2>/dev/null` — warn if there are unpushed commits
   - `git remote -v` — capture the remote URL

   Show the user the warnings and ask for explicit confirmation before continuing if any are non-empty.
6. Identify gitignored files that may be important (especially `.env*`, local config). List them so the user knows what will/won't be copied.

## Migration Strategy

Prefer **Strategy A (fresh clone)** when:
- The repo has a clean working tree
- A remote is configured and reachable
- The user confirms

Otherwise use **Strategy B (rsync copy)**.

### Strategy A: Fresh clone

```bash
mkdir -p ~/projects
cd ~/projects
git clone <REMOTE_URL> <PROJECT_NAME>
cd <PROJECT_NAME>
# Copy gitignored files that matter
cp <SOURCE_PATH>/.env ./.env 2>/dev/null || true
# Copy any other identified untracked-but-needed files
```

### Strategy B: rsync copy (preserves uncommitted work)

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

## Post-migration

1. `cd` into DEST_PATH.
2. Detect package manager from lockfile:
   - `pnpm-lock.yaml` → `pnpm install`
   - `yarn.lock` → `yarn install`
   - `package-lock.json` → `npm install`
   - `bun.lockb` → `bun install`
3. If a `.env` was copied, grep it for `C:\` or `/mnt/c/` paths and warn the user about any that need updating for Linux.
4. Run a sanity check: `git status` (should be clean or match expectations) and `ls -la` to show the result.
5. Print a summary:
   - Source path (UNCHANGED)
   - Destination path
   - Strategy used
   - Any warnings to address
   - Suggested next command: `cd ~/projects/<PROJECT_NAME> && code .`

## Hard Rules

- **NEVER** delete or modify SOURCE_PATH. The Windows-side copy stays intact as a safety net. The user removes it manually later if they want.
- **NEVER** use `mv` on the source.
- **NEVER** overwrite an existing DEST_PATH without explicit confirmation.
- If any step fails, stop and report. Do not try to recover by deleting partial state unless the user confirms.
- Do not run `pnpm install` (or equivalent) if the user hasn't confirmed network access is fine — some corporate networks block npm.

## Output

At the end, output a one-paragraph summary of what was done and what the user should verify before considering the Windows-side copy disposable.
