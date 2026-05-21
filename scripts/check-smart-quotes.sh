#!/usr/bin/env bash
# check-smart-quotes.sh — Scan src/ for Unicode smart quotes (U+2018/2019/201C/201D)
# that break esbuild tokenisation when they appear in .ts/.tsx/.js/.jsx source files.
#
# Usage:
#   bash scripts/check-smart-quotes.sh
#
# To wire into the build chain manually, add to package.json:
#   "prebuild": "bash scripts/check-smart-quotes.sh"
#
# Make this script executable after creation:
#   chmod +x scripts/check-smart-quotes.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$REPO_ROOT/src"

# One regex covering all four smart-quote codepoints:
#   U+2018 LEFT  SINGLE QUOTATION MARK  '
#   U+2019 RIGHT SINGLE QUOTATION MARK  '
#   U+201C LEFT  DOUBLE QUOTATION MARK  "
#   U+201D RIGHT DOUBLE QUOTATION MARK  "
PATTERN='[\x{2018}\x{2019}\x{201C}\x{201D}]'

# Collect matches across all TS/JS source files; exclude node_modules defensively.
MATCHES=$(
  grep -rn -P "$PATTERN" \
    --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" \
    --exclude-dir=node_modules \
    "$SRC_DIR" 2>/dev/null || true
)

if [[ -n "$MATCHES" ]]; then
  # Print each match with a helpful label to stderr.
  while IFS= read -r line; do
    # line is already in "file:lineno:content" form from grep -n.
    # Extract file path and line number for the codepoint annotation.
    file_part="${line%%:*}"
    rest="${line#*:}"
    lineno="${rest%%:*}"
    content="${rest#*:}"

    # Detect which codepoint(s) are present for a human-readable label.
    codepoints=""
    [[ "$content" =~ $'\xe2\x80\x98' ]] && codepoints+="U+2018 ' "
    [[ "$content" =~ $'\xe2\x80\x99' ]] && codepoints+="U+2019 ' "
    [[ "$content" =~ $'\xe2\x80\x9c' ]] && codepoints+="U+201C \" "
    [[ "$content" =~ $'\xe2\x80\x9d' ]] && codepoints+="U+201D \" "
    codepoints="${codepoints% }"

    echo "${file_part}:${lineno} → contains smart quote (${codepoints:-unknown})" >&2
  done <<< "$MATCHES"

  echo "[smart-quote-check] FAILED — smart quotes found (see above)" >&2
  exit 1
fi

echo "[smart-quote-check] clean"
exit 0
