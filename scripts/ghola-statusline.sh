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
#   - Side effects: mirrors the usage snapshot to BOTH ~/.ghola/usage-state.json
#     (unkeyed, the tool.usage-observer contract) and the per-session keyed file
#     ~/.ghola/statusline/state/<key>.json that the VS Code status bar reads. The
#     unkeyed path is shared by every concurrent session and so cannot be
#     attributed to a window; the keyed one can. Both writes happen.
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
import hashlib, json, os, re, sys

tokens_str = ""
pct = ""
five_hour_pct = ""

# Raw numeric values (or None) mirrored into the usage-state file below so the
# tool.usage-observer module can read them; the display strings above are for
# the status line itself.
raw_tokens = None
raw_ctx = None
raw_fh = None
# The session's working directory, from the harness payload. Only consulted when
# GHOLA_STATE_KEY is absent; see resolve_state_key below.
project_dir = None

def fmt_tokens(n):
    if n < 1000:
        return str(n)
    if n < 1_000_000:
        return f"{n // 1000}k"
    return f"{n / 1_000_000:.1f}M"

# --- Per-session state key -------------------------------------------------
# THE SAME ALGORITHM LIVES IN THREE PLACES: here, in scripts/ghola-statusline.mjs,
# and in src/session/statusline-state.ts, which is the NORMATIVE spec and carries
# the full reasoning for every step. Drift fails SILENTLY — the writer writes one
# path, the VS Code status bar reads another, and the segment simply never appears
# — so nothing below may be "improved" without changing the other two in the same
# commit. Every rule is chosen to be trivially reproducible in all three
# languages: an explicit [A-Z] case fold rather than .lower()/toLowerCase() (whose
# Unicode behavior differs between them), a character class rather than any
# locale-aware transform, and sha256/hex, which all three have in stdlib.
STATE_KEY_ENV_VAR = "GHOLA_STATE_KEY"
STATE_KEY_HASH_LENGTH = 8
STATE_KEY_BODY_MAX_LENGTH = 100
STATE_KEY_EMPTY_BODY = "root"
# Belt-and-braces bound on the root walk; os.path.dirname already terminates.
MAX_ROOT_WALK_STEPS = 64

def normalize_state_key_path(p):
    """The exact string that gets hashed and folded. Steps, IN ORDER: re-slash,
    drop trailing "/" runs (an all-separator input survives unchanged rather than
    emptying), then ASCII-ONLY case folding. NTFS is case-insensitive and the two
    sides of this contract can each see a different casing of the same directory,
    so case is folded — via [A-Z] rather than .lower(), because that is the only
    spelling the three implementations agree on for non-ASCII input."""
    slashed = p.replace("\\", "/")
    trimmed = re.sub(r"/+$", "", slashed)
    with_root = trimmed if trimmed else slashed
    return re.sub(r"[A-Z]", lambda m: m.group(0).lower(), with_root)

def fold_state_key_body(normalized):
    """The readable half of the key: fold everything outside [a-z0-9._-] to "-",
    collapse runs, keep the LAST 100 characters (the tail is the recognizable
    part), then trim edge hyphens — AFTER truncation, because truncation can
    expose one, and an absolute path always folds to a leading one."""
    folded = re.sub(r"-+", "-", re.sub(r"[^a-z0-9._-]", "-", normalized))
    capped = folded[-STATE_KEY_BODY_MAX_LENGTH:] if len(folded) > STATE_KEY_BODY_MAX_LENGTH else folded
    body = capped.strip("-")
    return body if body else STATE_KEY_EMPTY_BODY

def derive_state_key(p):
    """<folded-body>-<sha256(normalized)[0:8]>. WHAT IS HASHED IS THE NORMALIZED
    PATH, NOT THE FOLDED BODY — folding is lossy (/a/b_c and /a/b-c both fold to
    a-b-c), so hashing the body would preserve the very collision the hash exists
    to break."""
    normalized = normalize_state_key_path(p)
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:STATE_KEY_HASH_LENGTH]
    return fold_state_key_body(normalized) + "-" + digest

def has_git_entry(d):
    """.git EXISTS — never isdir(); it is a FILE in a worktree or a submodule."""
    try:
        return os.path.exists(os.path.join(d, ".git"))
    except Exception:
        return False

def find_repo_root(start):
    """Nearest ancestor of start (inclusive) holding a .git entry, or None.
    Trailing separators come off FIRST because dirname("/a/b/") is "/a", not
    "/a/b", so an untrimmed input skips a level. Never cached: the filesystem can
    change under us (git init), and the walk is a handful of stats the OS dentry
    cache already holds."""
    trimmed = re.sub(r"[\\/]+$", "", start)
    current = trimmed if trimmed else start
    for _ in range(MAX_ROOT_WALK_STEPS):
        if has_git_entry(current):
            return current
        parent = os.path.dirname(current)
        # dirname is its own fixed point at the top of the tree, so equality is the
        # "out of parents" signal. Compared before assignment so the root itself is
        # probed exactly once.
        if parent == current:
            return None
        current = parent
    return None

def resolve_state_key(project_dir):
    """This session's key, or None when none can be derived.

    GHOLA_STATE_KEY WINS AND IS USED VERBATIM — no normalization, no folding, no
    hashing, no walk. src/session/launcher.ts exports it, computed from the VS Code
    workspace folder's git root, and that is not defensive duplication: the two
    derivations provably disagree when the terminal is opened in the WSL-native
    clone of a /mnt/c/... workspace, because project_dir then walks up to a
    DIFFERENT root than the workspace folder does. The env var makes writer and
    reader agree by construction; the walk survives only as the fallback for a
    session Ghola did not launch. (Whitespace-only is treated as absent: it is not
    a key, and honoring it would write a file no reader ever opens.)

    An empty or whitespace-only project_dir yields NO KEY rather than a walk from
    nowhere — has_git_entry("") probes .git relative to whatever cwd the harness
    ran us in, and a key must never depend on cwd."""
    env_key = os.environ.get(STATE_KEY_ENV_VAR)
    if env_key is not None and env_key.strip():
        return env_key
    if not isinstance(project_dir, str) or not project_dir.strip():
        return None
    root = find_repo_root(project_dir)
    return derive_state_key(root if root is not None else project_dir)

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
    try:
        p = json.loads(raw)
        ws = p.get("workspace") if isinstance(p, dict) else None
        if isinstance(ws, dict):
            pd = ws.get("project_dir")
            if isinstance(pd, str):
                project_dir = pd
    except Exception:
        pass

# Best-effort snapshot for tool.usage-observer. GLOBAL location (~/.ghola/),
# never the work repo. Atomic write (temp + replace). Only written when there is
# an actual usage signal, so an empty payload never clobbers a good snapshot.
# Wrapped so a filesystem fault can never break the status line.
#
# The temp name carries our PID. A FIXED ".tmp" is not safe when several sessions
# render at once (the normal case here): the second render truncates the temp the
# first is about to rename into place, publishing a torn file that
# tool.usage-observer then fails to parse. Readers only ever open
# usage-state.json, so the temp name is not part of the contract — the path,
# shape, and key order below are, and are unchanged. Matches the .mjs port.
#
# On failure the temp is unlinked; if that unlink itself fails we leave the stray
# temp behind rather than risk the status line — it is inert (nothing reads
# ".tmp.<pid>") and the next successful render of that PID overwrites it.
tmp_path = None
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
        tmp_path = state_path + ".tmp." + str(os.getpid())
        with open(tmp_path, "w") as f:
            json.dump(obj, f)
        os.replace(tmp_path, state_path)
        tmp_path = None
except Exception:
    if tmp_path is not None:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass

# The PER-SESSION snapshot, at ~/.ghola/statusline/state/<key>.json, read by the
# VS Code status bar for the window it is running in — which is the whole point,
# and the reason this is a SECOND write rather than a replacement for the one
# above: that file's unkeyed path is a documented cross-module contract with
# tool.usage-observer and is left exactly as it was. The two blocks stay separate,
# duplication and all, because their gates and their audiences differ and neither
# should be able to change the other by accident.
#
# Same shape, same key ORDER, and the same epoch-SECONDS "updated" as the unkeyed
# file, so a reader written for one can read the other. Same PID-in-temp atomic
# write, for the same anti-tearing reason.
#
# The gate is DELIBERATELY WIDER than the unkeyed one: any of the three metrics is
# enough, where the unkeyed write ignores a context percentage that arrives with no
# token count. The status bar's job is to show context %, so dropping a ctx-only
# payload would blank it for no reason. A payload with NO metric at all still
# writes nothing, so an empty render can never clobber a good snapshot with a bare
# timestamp — and the writer never gates on AGE, because staleness belongs to the
# reader (STATE_STALE_AFTER_MS in src/session/statusline-state.ts).
tmp_path = None
try:
    state_key = resolve_state_key(project_dir)
    if state_key is not None and (raw_tokens is not None or raw_ctx is not None or raw_fh is not None):
        import time
        state_dir = os.path.expanduser("~/.ghola/statusline/state")
        os.makedirs(state_dir, exist_ok=True)
        state_path = os.path.join(state_dir, state_key + ".json")
        obj = {"updated": int(time.time())}
        if raw_tokens is not None:
            obj["session_tokens"] = raw_tokens
        if raw_ctx is not None:
            obj["context_pct"] = raw_ctx
        if raw_fh is not None:
            obj["five_hour_pct"] = raw_fh
        tmp_path = state_path + ".tmp." + str(os.getpid())
        with open(tmp_path, "w") as f:
            # COMPACT SEPARATORS, unlike the unkeyed write above. json.dump defaults
            # to (", ", ": ") while JavaScript's JSON.stringify emits no spaces at
            # all, so the two renderers' UNKEYED files differ by whitespace today —
            # harmless, since every reader parses rather than compares, but it means
            # the two are not byte-comparable. This file is new, so it is written
            # byte-identically to the .mjs's instead, which makes the two renderers
            # diffable and keeps the parity check honest. The unkeyed write is left
            # exactly as it was; its formatting is not ours to change.
            json.dump(obj, f, separators=(",", ":"))
        os.replace(tmp_path, state_path)
        tmp_path = None
except Exception:
    if tmp_path is not None:
        try:
            os.unlink(tmp_path)
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
