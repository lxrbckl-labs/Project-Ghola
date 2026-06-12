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

  # REMOTE version: read package.json at the upstream ref without touching the
  # working tree.
  REMOTE_VERSION=""
  if REMOTE_PKG="$(git show "$UPSTREAM:package.json" 2>/dev/null)"; then
    REMOTE_VERSION="$(printf '%s' "$REMOTE_PKG" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version" 2>/dev/null || true)"
  fi
  if [ -z "$REMOTE_VERSION" ]; then
    echo "[ext] ERROR: could not read remote version from $UPSTREAM:package.json" >&2
    exit 1
  fi

  # INSTALLED version: ask the `code` CLI which version is currently installed.
  INSTALLED_VERSION="$(code --list-extensions --show-versions 2>/dev/null | grep -i "^${EXT_ID}@" | sed 's/^.*@//' || true)"

  # LOCAL repo version: the version in the working-tree package.json.
  LOCAL_VERSION="$(node -p "require('./package.json').version" 2>/dev/null || true)"

  echo "[ext] remote=$REMOTE_VERSION installed=${INSTALLED_VERSION:-none} local=${LOCAL_VERSION:-unknown} upstream=$UPSTREAM"

  # If what's installed already matches the remote, there is nothing to do.
  if [ -n "$INSTALLED_VERSION" ] && [ "$INSTALLED_VERSION" = "$REMOTE_VERSION" ]; then
    echo "[ext] ALREADY_UP_TO_DATE"
    exit 0
  fi

  # Pull ONLY when the local repo version differs from remote — i.e. the
  # working tree is actually behind. If local already equals remote (the source
  # is current but the INSTALLED copy is stale), skip the pull so a dirty tree
  # can't fail `git pull --ff-only`; we just rebuild/reinstall what's here.
  if [ "$LOCAL_VERSION" != "$REMOTE_VERSION" ]; then
    if ! git pull --ff-only >/dev/null 2>&1; then
      echo "[ext] ERROR: git pull --ff-only failed (resolve manually or run with --local)" >&2
      exit 1
    fi
    echo "[ext] pulled to remote version $REMOTE_VERSION"
  else
    echo "[ext] local repo already at remote version; skipping pull"
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
VERSION="$(node -p "require('./package.json').version" 2>/dev/null || true)"
if [ -z "$VERSION" ]; then
  echo "[ext] ERROR: could not read installed version from package.json" >&2
  exit 1
fi
echo "[ext] Installed: nomeda v$VERSION"
