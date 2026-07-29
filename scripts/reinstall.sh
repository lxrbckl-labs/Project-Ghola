#!/usr/bin/env bash
#
# reinstall.sh — pull (when needed), rebuild, repackage, and reinstall the
# Ghola VS Code extension from this git checkout. Invoked by the
# "Ghola: Update Extension" command (src/commands/updateExtension.ts), which
# runs it under a `bash -lc` login shell so the user's interactive PATH (nvm
# node/npm, the `code` CLI) is available — the extension-host PATH is not.
#
# Markers parsed by the command handler:
#   [ext] ALREADY_UP_TO_DATE        -> installed version already matches remote
#   [ext] Installed: ghola v<VER>  -> install succeeded, <VER> is the new version
#   [ext] ERROR: <msg>              -> hard failure (also exits non-zero)
#
# Flags:
#   --local   Skip ALL remote logic (no @{u} resolve, no fetch, no pull).
#             Just build + package + reinstall the current working tree.
#
set -euo pipefail

# ── Self-locate ─────────────────────────────────────────────────────────────
# The script lives at <repo>/scripts/reinstall.sh, so the repo root (which is
# also the extension root — Ghola's extension is at the repo root, no
# vscode-extension/ subdir) is two directories up from the resolved script.
SCRIPT_PATH="$(realpath "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$REPO_ROOT"

EXT_ID="local.ghola"
VSIX_NAME="ghola.vsix"

LOCAL_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --local) LOCAL_ONLY=1 ;;
    *) ;;
  esac
done

# ── Preflight: required tools on PATH ───────────────────────────────────────
for tool in npm npx code; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "[ext] ERROR: required tool '$tool' not found on PATH" >&2
    exit 1
  fi
done

# ── Remote-version check (skipped entirely with --local) ────────────────────
if [ "$LOCAL_ONLY" -eq 0 ]; then
  if ! command -v git >/dev/null 2>&1; then
    echo "[ext] ERROR: git not found on PATH" >&2
    exit 1
  fi

  # Resolve the upstream tracking ref. Wrapped in `if` so `set -e` does not
  # abort when there is no upstream configured.
  UPSTREAM=""
  if UPSTREAM_RESOLVED="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)"; then
    UPSTREAM="$UPSTREAM_RESOLVED"
  fi

  if [ -z "$UPSTREAM" ]; then
    echo "[ext] ERROR: no upstream tracking branch configured (set one or run with --local)" >&2
    exit 1
  fi

  # Fetch so the upstream ref reflects the remote. Non-fatal network failure is
  # still a hard error here — without a fetch we cannot trust the comparison.
  if ! git fetch >/dev/null 2>&1; then
    echo "[ext] ERROR: git fetch failed (check network / remote)" >&2
    exit 1
  fi

  # REMOTE version: read the VERSION file at the upstream ref without touching
  # the working tree. The VERSION file is the source of truth for the update
  # signal (package.json is no longer consulted for versioning).
  REMOTE_VERSION=""
  if REMOTE_VERSION_RAW="$(git show "$UPSTREAM:VERSION" 2>/dev/null)"; then
    REMOTE_VERSION="$(printf '%s' "$REMOTE_VERSION_RAW" | tr -d '[:space:]')"
  fi
  if [ -z "$REMOTE_VERSION" ]; then
    echo "[ext] ERROR: could not read remote version from $UPSTREAM:VERSION" >&2
    exit 1
  fi

  # INSTALLED version: the version of the extension build currently installed in
  # VS Code, passed in by the "Ghola: Update Extension" command (which reads it
  # from the installed extension's VERSION file). Empty when the script is run
  # directly from the terminal — that's fine; see the gate below.
  INSTALLED_VERSION="$(printf '%s' "${GHOLA_INSTALLED_VERSION:-}" | tr -d '[:space:]')"

  # LOCAL version: the working-tree VERSION file (REPO_ROOT is the clone root
  # where VERSION lives; cwd is REPO_ROOT). Drives the pull decision only.
  LOCAL_VERSION="$(tr -d '[:space:]' < ./VERSION 2>/dev/null || true)"

  echo "[ext] installed=${INSTALLED_VERSION:-unknown} remote=$REMOTE_VERSION local=$LOCAL_VERSION upstream=$UPSTREAM"

  # Update-needed gate: the correct comparison is INSTALLED-vs-REMOTE. Only
  # short-circuit as up-to-date when we actually know the installed version AND
  # it equals remote. When INSTALLED_VERSION is empty (a direct CLI run with no
  # env var), do NOT short-circuit — running the script by hand means install.
  if [ -n "$INSTALLED_VERSION" ] && [ "$INSTALLED_VERSION" = "$REMOTE_VERSION" ]; then
    echo "[ext] ALREADY_UP_TO_DATE"
    echo "[ext] Already up to date (installed v$INSTALLED_VERSION matches remote) - nothing to install."
    exit 0
  fi

  # Pull gate: only pull when the CLONE's working tree is actually behind the
  # remote VERSION. The clone — not the install — is what a pull updates.
  if [ "$LOCAL_VERSION" != "$REMOTE_VERSION" ]; then
    echo "[ext] update needed: local=${LOCAL_VERSION:-unknown} -> remote=$REMOTE_VERSION"
    if ! git pull --ff-only >/dev/null 2>&1; then
      echo "[ext] ERROR: git pull --ff-only failed (resolve manually or run with --local)" >&2
      exit 1
    fi
    echo "[ext] pulled to remote version $REMOTE_VERSION"
  else
    echo "[ext] clone already at remote version $REMOTE_VERSION - skipping pull"
  fi
fi

# ── Install dependencies + build ────────────────────────────────────────────
echo "[ext] npm install"
npm install

echo "[ext] npm run build"
npm run build

# ── Remove any stale vsix so a failed package can't leave us reinstalling an
#    old artifact. This is the script's runtime cleanup of a build artifact,
#    not a source-file deletion.
rm -f "$VSIX_NAME"

# ── Package ─────────────────────────────────────────────────────────────────
# Invoke vsce directly (not `npm run package`) so we can pass explicit flags
# that keep packaging non-interactive and robust regardless of repository /
# LICENSE state. package.json has no `repository` field and the repo has no
# LICENSE file; without these flags vsce emits warnings and, under some TTY
# conditions, an interactive "Do you want to continue? [y/N]" prompt that would
# hang the `bash -lc` spawn. --allow-missing-repository and --skip-license make
# that impossible. --yes ensures npx never prompts to install @vscode/vsce
# (which is already a devDependency, so this resolves locally). The build half
# of `npm run package` is intentionally dropped here because the build already
# ran above.
echo "[ext] packaging $VSIX_NAME"
npx --yes @vscode/vsce package -o "$VSIX_NAME" --allow-missing-repository --skip-license

if [ ! -f "$VSIX_NAME" ]; then
  echo "[ext] ERROR: packaging did not produce $VSIX_NAME" >&2
  exit 1
fi

# ── Entry-point sanity check ────────────────────────────────────────────────
# The vsix must contain the bundled entry at extension/dist/extension.js
# (main is ./dist/extension.js; vsce nests everything under extension/).
# Skipped with a warning when `unzip` is unavailable.
if command -v unzip >/dev/null 2>&1; then
  # Capture the entry list first, then match it with a HERE-STRING — never a
  # pipe. Feeding ANY producer into `grep -q` lets grep exit on the first match
  # and SIGPIPE the still-writing producer (exit 141), which under `pipefail`
  # fails the whole pipeline and falsely trips the "missing" branch below.
  # Capturing `unzip -l` into a variable (v0.18.4) did NOT cure that: it only
  # promoted `printf` to producer, and `printf | grep -q` still loses the same
  # race roughly a third of the time on a ~660-line listing, because the match
  # sits near the top and grep exits while printf has many writes left to go.
  # A here-string is fully materialised before grep starts, so there is no
  # producer process left to signal. See CLAUDE.md rule 7.
  #
  # `-Z1` (zipinfo mode, names only) rather than `-l`: it lets the match be an
  # EXACT whole-line one (`grep -qxF`). A substring match against `-l` output is
  # too weak — `extension/dist/extension.js.map` contains `extension/dist/
  # extension.js`, so a build that emitted only the sourcemap would sail through.
  #
  # The capture is guarded so an unzip that is PRESENT but FAILS (unreadable or
  # corrupt archive) is reported as a tool/archive failure instead of aborting
  # with no diagnostic on `set -e` — the operator must be able to tell "the
  # build is bad" from "the environment is".
  if ! VSIX_ENTRIES="$(unzip -Z1 "$VSIX_NAME" 2>&1)"; then
    echo "[ext] ERROR: unzip could not read $VSIX_NAME, so the entry-point check did not run (unreadable archive, not necessarily a bad build)" >&2
    printf '%s\n' "$VSIX_ENTRIES" >&2
    exit 1
  fi
  if ! grep -qxF "extension/dist/extension.js" <<<"$VSIX_ENTRIES"; then
    echo "[ext] ERROR: $VSIX_NAME is missing extension/dist/extension.js (bad build?)" >&2
    exit 1
  fi
else
  echo "[ext] WARNING: unzip not found; skipping vsix entry-point sanity check"
fi

# ── Install ─────────────────────────────────────────────────────────────────
echo "[ext] installing $VSIX_NAME"
code --install-extension "$VSIX_NAME" --force

# ── Report the installed version via the parseable marker line ──────────────
# Version comes from the VERSION file (the source of truth), not package.json.
VERSION="$(tr -d '[:space:]' < ./VERSION 2>/dev/null || true)"
if [ -z "$VERSION" ]; then
  echo "[ext] ERROR: could not read installed version from VERSION" >&2
  exit 1
fi
echo "[ext] Installed: ghola v$VERSION"
