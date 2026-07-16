#!/usr/bin/env bash
# ghola-statusline.sh — Claude Code statusLine hook for Project-Ghola.
#
# Emits exactly one line on stdout (no trailing newline) describing the current
# Ghola version and, when available, the user's session token/context usage.
#
# Behavior:
#   - Always shows [Ghola v<version>].
#   - When the JSON payload on stdin contains context_window.total_input_tokens +
#     total_output_tokens and/or context_window.used_percentage and/or
#     rate_limits.five_hour.used_percentage, each of those segments is appended
#     independently — e.g. [Ghola v0.16.2 | 142k · 62% · 5h 41%].
#   - On ANY error the script must NOT fail and must NOT print error text; it
#     falls back to [Ghola v<version>] (or [Ghola vunknown] if VERSION unreadable).
#
# Portability: derives the VERSION path from the script's own location (parent
# dir's VERSION file), so it works regardless of the cwd the harness runs it in.
#
# Dependencies: bash, python3 (safe JSON parsing — jq is NOT assumed).
# Installation: chmod +x this file and reference it from ~/.claude/settings.json:
#   { "statusLine": { "type": "command",
#                     "command": "/home/aarbuckle/projects/Project-Ghola/scripts/ghola-statusline.sh" } }
#
# Note: deliberately does NOT use `set -e` — every command handles its own
# failure via fallbacks so the script can never abort partway through.

# Derive the Ghola repo dir from the script's own location (parent of scripts/).
_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)" || _SCRIPT_DIR=""
_GHOLA_DIR_DEFAULT="$(cd "${_SCRIPT_DIR}/.." 2>/dev/null && pwd)" || _GHOLA_DIR_DEFAULT=""
VERSION_FILE="${GHOLA_DIR:-$_GHOLA_DIR_DEFAULT}/VERSION"

# --- 1. Read VERSION (strip trailing newline/whitespace) ---
version="$( { tr -d '[:space:]' < "$VERSION_FILE"; } 2>/dev/null)"
[ -z "$version" ] && version="unknown"

# --- 2. Capture stdin once (Claude Code's JSON payload) ---
payload="$(cat 2>/dev/null)" || payload=""

# --- 3. Ask python3 to do all the JSON work in one shot.
# Output on stdout: "<tokens_str_or_empty>|<pct_or_empty>|<five_hour_pct_or_empty>"
parsed="$(PAYLOAD="$payload" python3 - <<'PY' 2>/dev/null
import json, os, sys

tokens_str = ""
pct = ""
five_hour_pct = ""

# Raw numeric values (or None) mirrored into the usage-state file below so the
# tool.usage-observer module can read them; the display strings above are for
# the status line itself.
raw_tokens = None
raw_ctx = None
raw_fh = None

def fmt_tokens(n):
    if n < 1000:
        return str(n)
    if n < 1_000_000:
        return f"{n // 1000}k"
    return f"{n / 1_000_000:.1f}M"

raw = os.environ.get("PAYLOAD", "")
if raw.strip():
    try:
        p = json.loads(raw)
        cw = p.get("context_window") if isinstance(p, dict) else None
        if isinstance(cw, dict):
            ti = cw.get("total_input_tokens")
            to = cw.get("total_output_tokens")
            up = cw.get("used_percentage")
            if isinstance(ti, (int, float)) and isinstance(to, (int, float)):
                total = int(ti) + int(to)
                if total >= 0:
                    tokens_str = fmt_tokens(total)
                    raw_tokens = total
            if isinstance(up, (int, float)):
                p_int = int(round(up))
                if p_int < 0:
                    p_int = 0
                pct = str(p_int)
                raw_ctx = p_int
    except Exception:
        pass
    try:
        p = json.loads(raw)
        rl = p.get("rate_limits") if isinstance(p, dict) else None
        if isinstance(rl, dict):
            fh = rl.get("five_hour")
            if isinstance(fh, dict):
                fh_up = fh.get("used_percentage")
                if isinstance(fh_up, (int, float)):
                    fh_int = int(round(fh_up))
                    if fh_int < 0:
                        fh_int = 0
                    five_hour_pct = str(fh_int)
                    raw_fh = fh_int
    except Exception:
        pass

# Best-effort snapshot for tool.usage-observer. GLOBAL location (~/.ghola/),
# never the work repo. Atomic write (temp + replace). Only written when there is
# an actual usage signal, so an empty payload never clobbers a good snapshot.
# Wrapped so a filesystem fault can never break the status line.
try:
    if raw_tokens is not None or raw_fh is not None:
        import time
        state_dir = os.path.expanduser("~/.ghola")
        os.makedirs(state_dir, exist_ok=True)
        state_path = os.path.join(state_dir, "usage-state.json")
        obj = {"updated": int(time.time())}
        if raw_tokens is not None:
            obj["session_tokens"] = raw_tokens
        if raw_ctx is not None:
            obj["context_pct"] = raw_ctx
        if raw_fh is not None:
            obj["five_hour_pct"] = raw_fh
        tmp_path = state_path + ".tmp"
        with open(tmp_path, "w") as f:
            json.dump(obj, f)
        os.replace(tmp_path, state_path)
except Exception:
    pass

sys.stdout.write(f"{tokens_str}|{pct}|{five_hour_pct}")
PY
)"

# Defensive split (if python3 failed, parsed is empty -> all segments empty).
tokens_str="${parsed%%|*}"
rest="${parsed#*|}"
pct="${rest%%|*}"
five_hour_pct="${rest#*|}"

# --- 4. Format the output line ---
# Each segment is independent — gates on its own source field being non-empty.
# Segments joined with ' · ' (U+00B7). The ' │ ' (U+2502) separator appears only
# when at least one segment is present. Context % and 5h % render red at >=85%.
parts=()
[ -n "$tokens_str" ] && parts+=("$tokens_str")
if [ -n "$pct" ]; then
    if [ "$pct" -ge 85 ] 2>/dev/null; then
        parts+=("$(printf '\033[31m%s%%\033[0m' "$pct")")
    else
        parts+=("$(printf '%s%%' "$pct")")
    fi
fi
if [ -n "$five_hour_pct" ]; then
    if [ "$five_hour_pct" -ge 85 ] 2>/dev/null; then
        parts+=("$(printf '5h \033[31m%s%%\033[0m' "$five_hour_pct")")
    else
        parts+=("$(printf '5h %s%%' "$five_hour_pct")")
    fi
fi
if [ "${#parts[@]}" -gt 0 ]; then
    joined="${parts[0]}"
    for i in "${!parts[@]}"; do
        [ "$i" -eq 0 ] && continue
        joined="${joined} $(printf '\302\267') ${parts[$i]}"
    done
    printf '[Ghola v%s \342\224\202 %s]' "$version" "$joined"
else
    printf '[Ghola v%s]' "$version"
fi
