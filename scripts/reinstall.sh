#!/usr/bin/env bash
#
# reinstall.sh — pull (when needed), rebuild, repackage, and reinstall the
# Nomeda VS Code extension from this git checkout. Invoked by the
# "Nomeda: Update Extension" command (src/commands/updateExtension.ts), which
# runs it under a `bash -lc` login shell so the user's interactive PATH (nvm
# node/npm, the `code` CLI) is available — the extension-host PATH is not.
#
# Markers parsed by the command handler:
#   [ext] ALREADY_UP_TO_DATE        -> installed version already matches remote
#   [ext] Installed: nomeda v<VER>  -> install succeeded, <VER> is the new version
#   [ext] ERROR: <msg>              -> hard failure (also exits non-zero)
#
# Flags:
#   --local   Skip ALL remote logic (no @{u} resolve, no fetch, no pull).
#             Just build + package + reinstall the current working tree.
#
set -euo pipefail

# ── Self-locate ─────────────────────────────────────────────────────────────
# The script lives at <repo>/scripts/reinstall.sh, so the repo root (which is
# also the extension root — Nomeda's extension is at the repo root, no
# vscode-extension/ subdir) is two directories up from the resolved script.
SCRIPT_PATH="$(realpath "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$REPO_ROOT"

EXT_ID="local.nomeda"
VSIX_NAME="nomeda.vsix"

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

  # LOCAL version: the working-tree VERSION file (REPO_ROOT is the clone root
  # where VERSION lives; cwd is REPO_ROOT).
  LOCAL_VERSION="$(tr -d '[:space:]' < ./VERSION 2>/dev/null || true)"

  echo "[ext] remote=$REMOTE_VERSION local=${LOCAL_VERSION:-unknown} upstream=$UPSTREAM"

  # If the working-tree VERSION already matches the remote, there is nothing to
  # do — the source is current.
  if [ -n "$LOCAL_VERSION" ] && [ "$LOCAL_VERSION" = "$REMOTE_VERSION" ]; then
    echo "[ext] ALREADY_UP_TO_DATE"
    echo "[ext] already at remote version $REMOTE_VERSION; nothing to update"
    exit 0
  fi

  # Update needed: the working tree is behind the remote VERSION. Fast-forward
  # pull, then rebuild/repackage/reinstall below.
  echo "[ext] update needed: local=${LOCAL_VERSION:-unknown} -> remote=$REMOTE_VERSION"
  if ! git pull --ff-only >/dev/null 2>&1; then
    echo "[ext] ERROR: git pull --ff-only failed (resolve manually or run with --local)" >&2
    exit 1
  fi
  echo "[ext] pulled to remote version $REMOTE_VERSION"
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
  if ! unzip -l "$VSIX_NAME" | grep -q "extension/dist/extension.js"; then
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
echo "[ext] Installed: nomeda v$VERSION"
