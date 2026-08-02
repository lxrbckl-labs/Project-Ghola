#!/usr/bin/env bash
# ghola-statusline.sh — Claude Code statusLine hook for Project-Ghola.
#
# BY DEFAULT IT PRINTS NOTHING AT ALL — zero bytes on stdout, exit 0. Silent mode
# is now the DEFAULT rather than an opt-in (see "Silent mode" below), so this
# script's REASON TO EXIST IS THE TWO STATE WRITES, not the footer line. When the
# operator re-enables output with GHOLA_STATUSLINE_SILENT=0 it emits exactly one
# line on stdout (no trailing newline) carrying the current Ghola version — a
# session marker, not a usage display.
#
# Behavior:
#   - When un-silenced, the line is EXACTLY [Ghola v<version>]. Nothing else is
#     ever appended: no metrics group, no U+2502 separator, no U+00B7 join, and no
#     color at all. Silenced (the default) nothing is emitted, not even a newline.
#   - THE FOOTER RENDERS NO USAGE METRICS AT ALL. It used to close with a metrics
#     group — [Ghola v0.16.2 | 62% · 5h 41%] — carrying the context percentage and
#     the 5-hour rolling-window percentage, and before those an absolute token
#     count. All three are gone from the rendered line, in three separate steps.
#     The token figure went first: it was the same measurement as the context
#     percentage printed twice ("142k" alongside "62%" recovers nothing the
#     percentage does not already say) and the field it came from
#     (context_window.total_input_tokens + total_output_tokens) stopped meaning
#     "cumulative session spend" in Claude Code v2.1.132, where it became the size
#     of the CURRENT context window. The two percentages then went for a different
#     reason: the VS Code status-bar pill now displays the usage stats
#     ("Ghola: cmms2@win · Ticket Work · 34k · 5h 3%"), so the footer was
#     printing the same numbers a second time. THIS IS A DISPLAY DECISION ONLY,
#     and the same change is made in ghola-statusline.mjs.
#   - EVERY VALUE IS STILL COMPUTED AND STILL WRITTEN. Both state writes below
#     still record "session_tokens", "context_pct", and "five_hour_pct", with the
#     same key set, key order, and timestamp they always had: that on-disk shape is
#     a cross-module contract with tool.usage-observer AND the feed the VS Code
#     status bar reads, so it must not move when a rendered segment does. Beyond
#     the silent-mode marker, those two writes are now this script's ONLY purpose
#     past printing the version — which is why the python3 block below computes
#     values nothing displays, and why that is not dead code.
#   - THE WRITES LIVE INSIDE THE python3 BLOCK, so a host with no usable python3
#     used to write NOTHING — silently, exit 0, zero bytes out, and (since the
#     footer is blank by default) with no visible symptom anywhere except a
#     VS Code status-bar pill that goes empty 90 seconds later. Step 3a below adds
#     a FALLBACK WRITER for exactly that case: when the python3 block does not run
#     to completion, the payload is handed to the sibling scripts/ghola-statusline.mjs
#     under `node`, which performs the same two writes with no python3 involved.
#     See "Fallback writer" below for what it does and does not cover.
#   - On ANY error the script must NOT fail and must NOT print error text; it
#     prints nothing (the default). Un-silenced it falls back to
#     [Ghola v<version>] (or [Ghola vunknown] if VERSION unreadable).
#   - Side effects: mirrors the usage snapshot to BOTH ~/.ghola/usage-state.json
#     (unkeyed, the tool.usage-observer contract) and the per-session keyed file
#     ~/.ghola/statusline/state/<key>.json that the VS Code status bar reads. The
#     unkeyed path is shared by every concurrent session and so cannot be
#     attributed to a window; the keyed one can. Both writes happen.
#
# Silent mode: THE DEFAULT. No footer line, and the writes still happen.
#   THE OPERATOR WANTS NO FOOTER ROW AT ALL, so silence is the DEFAULT and there is
#   nothing to switch on to get it. What used to be the opt-in path is now the
#   normal path: it is already the tested path, and inverting one default keeps the
#   change reversible instead of deleting the render.
#   THIS SCRIPT IS THE WRITER of the two state files above, so deleting
#   "statusLine" from ~/.claude/settings.json is STILL the WRONG way to get a blank
#   footer even though the footer is now blank by default: the harness then never
#   invokes us, nothing writes state, and the VS Code status-bar pill goes empty
#   inside its 90-second staleness window on BOTH hosts. The renderer must keep
#   being invoked, keep running, and keep writing; it simply prints nothing.
#   The controls, in precedence order:
#     - ENV VAR GHOLA_STATUSLINE_SILENT, CHECKED FIRST and the ONLY thing that can
#       change the outcome. 0/false/no (case-insensitive, surrounding whitespace
#       trimmed) means NOT silent and is the escape hatch that puts the bracket back
#       for one session; 1/true/yes means silent, which is what would have happened
#       anyway. Unset, empty, whitespace-only, or any unrecognized value is NO
#       SIGNAL and falls through to the default.
#     - MARKER FILE <homedir>/.ghola/statusline/silent — still probed, still answers
#       "silent" when it EXISTS, and now REDUNDANT: it can only ever ask for the
#       behavior that already happens. Kept rather than removed so a marker the
#       operator already created keeps meaning what it said, and so
#       _SILENT_BY_DEFAULT below is the single line that restores a printing
#       default. Contents are irrelevant; existence is the whole signal. The check
#       lives in the python3 block below so the home directory is resolved by the
#       SAME os.path.expanduser("~") that resolves the state files, rather than by
#       a second rule.
#   Identical rules, path, precedence, and default live in
#   scripts/ghola-statusline.mjs (as SILENT_BY_DEFAULT), which carries the
#   long-form rationale — including why the control surface is an env var and a
#   marker file and not a module setting (Ghola module settings live in VS Code's
#   globalState, an opaque Memento with no on-disk form, so no standalone script
#   can read them).
#   SILENCE IS ABOUT STDOUT ONLY: both state writes happen unconditionally and
#   before the print gate.
#   NOTE THE FAIL-SAFE DIRECTION INVERTED WITH THE DEFAULT. It used to be that a
#   FAILED CHECK degraded to NOT SILENT — if python3 died the marker field arrived
#   empty and the line printed. Now that same empty field falls through to the
#   silent default, so a dead python3 yields zero bytes rather than a bracket. That
#   is the correct direction: printing a footer the operator asked to be rid of is
#   the wrong answer, and there is no longer a footer to protect. What has NOT
#   changed is that a failure never aborts the render: every path still exits 0.
#   BE PRECISE ABOUT THE STATE WRITE, THOUGH — the older wording here claimed that
#   "a failure never suppresses a state write", and for a DEAD python3 that was
#   simply untrue, because both writes live inside its block. Step 3a's fallback
#   writer closes that hole only when `node` and the sibling .mjs are both
#   reachable; with neither interpreter available nothing can compute the values and
#   nothing is written. That is the one honest residual gap, and it is recorded
#   under "Fallback writer" rather than papered over.
#
# Fallback writer (step 3a): the python3 block's LAST act is to write a one-byte
#   field to stdout ("0" no marker / "1" marker present). It therefore never emits
#   an EMPTY field on a successful run, and an empty field is proof — not a guess —
#   that the block did not reach its end, whether because python3 is absent, is a
#   stub, cannot start, or died partway. Bash treats that empty field as "the two
#   writes above did not happen" and re-runs the whole render through
#   `node <script dir>/ghola-statusline.mjs`, feeding it the payload already
#   captured in step 2. The .mjs is the byte-identical Node port and performs the
#   SAME two writes to the SAME paths, so the pill gets its snapshot.
#   WHAT IT COVERS: python3 missing from PATH, not executable, a stub that exits
#   without running our code, a broken stdlib, and a crash anywhere before the
#   final field write (which is after both state writes, so a completed block is
#   also evidence the write code was reached).
#   WHAT IT DOES NOT COVER, deliberately: (1) neither node nor python3 available —
#   there is then no JSON parser and no values to write, and bash cannot parse that
#   payload alone; (2) a python3 that runs to completion but whose write fails on a
#   filesystem fault — the block swallows that by design and node would almost
#   certainly fail the same way, so no fallback is attempted; (3) a .mjs that is not
#   a sibling of this script (only "$_SCRIPT_DIR/ghola-statusline.mjs" is tried, so
#   no second home-directory resolution rule is introduced).
#   STDOUT IS UNAFFECTED BY ALL OF IT. The delegated render's stdout is discarded
#   and bash still does its own printing below, so the fallback can only ever add a
#   state write; it can never change, duplicate, or suppress a byte of output.
#   The python3 block remains the PRIMARY path and is deliberately NOT bypassed
#   when node is present: it is the third implementation of the state-key algorithm
#   that scripts/ghola-statusline-parity.mjs checks, and demoting it to a path that
#   never runs on this host would leave that check guarding nothing anybody uses.
#
# Portability: derives the VERSION path from the script's own location (parent
# dir's VERSION file), so it works regardless of the cwd the harness runs it in.
#
# Dependencies: bash, and EITHER python3 OR node (safe JSON parsing — jq is NOT
# assumed). python3 is the primary parser; node is used only as step 3a's fallback
# writer, via the sibling ghola-statusline.mjs. With both missing this script still
# exits 0 and still prints nothing, but no state is written.
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
# Output on stdout is now a SINGLE field, unseparated, and it is ALWAYS EXACTLY ONE
# BYTE on a run that finishes:
#   "1" — the silent-mode marker file exists
#   "0" — it does not (or could not be probed)
#   ""  — THIS BLOCK NEVER FINISHED. Not one of its answers.
# The empty case is the whole reason the field is spelled "0"/"1" rather than
# ""/"1": this write is the LAST statement in the block, after both state writes, so
# a non-empty field is positive evidence that python3 ran our code all the way
# through, and an empty one is positive evidence that it did not. Step 3a below turns
# that into the fallback-writer trigger. Note the vocabulary change CANNOT move
# stdout: "0" and "" both fall through the precedence chain to _SILENT_BY_DEFAULT,
# which is the same silent answer "" produced before.
# There used to be three fields, and before that four: a leading <tokens_str>, then
# <pct> and <five_hour_pct>. Each was dropped as its rendered segment was, rather
# than being left in place empty, so the field count and the bash split below cannot
# drift apart while one side quietly carries a value nothing reads — a mismatched
# field count is exactly the kind of drift that fails silently here. With one field
# there is no separator left to split on, so the bash side reads $parsed whole.
# THE NUMBERS ARE STILL CAPTURED — as raw_tokens/raw_ctx/raw_fh, for the two state
# writes only. They never travel back to bash because nothing in bash displays them.
parsed="$(PAYLOAD="$payload" python3 - <<'PY' 2>/dev/null
import hashlib, json, os, re, sys

# "1" when the silent-mode marker file exists, "0" otherwise (INCLUDING on any
# failure to look). Reported rather than acted on: the printing lives in bash, and
# the environment override that outranks this field is evaluated there. It is the
# ONLY thing this block reports back — there are no pct / five_hour_pct display
# strings any more, because the footer displays no metrics.
#
# THE DEFAULT IS "0", NOT "". Both mean "no marker" to the precedence chain in bash,
# so this is behaviorally inert for silence — but it reserves "" to mean ONLY "this
# block never reached its final stdout write", which is what bash's step 3a uses to
# decide the two state writes below did not happen. An empty field must therefore
# never be reachable on a run that completes.
silent_marker = "0"

# Raw numeric values (or None) mirrored into the two state files below so the
# tool.usage-observer module and the VS Code status bar can read them. ALL THREE ARE
# WRITE-ONLY: raw_tokens, raw_ctx, and raw_fh feed "session_tokens", "context_pct",
# and "five_hour_pct" in both files and none of them is rendered anywhere.
raw_tokens = None
raw_ctx = None
raw_fh = None
# The session's working directory, from the harness payload. Only consulted when
# GHOLA_STATE_KEY is absent; see resolve_state_key below.
project_dir = None

# NOTE: there is no fmt_tokens here any more, and no percentage formatting either.
# The k/M abbreviation existed only to render the token segment, and the pct /
# five_hour_pct strings only to carry the two percentage segments back to bash; each
# went with the segment it fed rather than being left behind as dead code. All three
# NUMBERS are still computed below and still written into both state files, because
# that on-disk shape is a cross-module contract with tool.usage-observer and with the
# VS Code status bar that outlived the display. The abbreviation rule the pill needs
# lives on in formatTokenCount in src/session/statusline-state.ts - that function is
# live and has a caller, because the pill DOES render an absolute token figure
# ("Ghola: cmms2@win - Ticket Work - 34k - 5h 3%"); this footer is the surface
# that stopped. The .mjs's fmtTokens and pctSegment were removed in the same
# changes as this file's.

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
    # \Z, not $: Python's $ (non-MULTILINE) also matches before one trailing "\n",
    # which JS/TS $ (no /m) never does - \Z is the absolute-end match both share.
    trimmed = re.sub(r"/+\Z", "", slashed)
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
    # \Z, not $: same JS/Python end-anchor divergence as normalize_state_key_path above.
    trimmed = re.sub(r"[\\/]+\Z", "", start)
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
                # Captured for the two state writes only — the >= 0 gate is kept
                # because the reader side rejects a negative anyway, and writing one
                # would only put a value on disk that nothing will accept.
                if total >= 0:
                    raw_tokens = total
            if isinstance(up, (int, float)):
                # Rounded (half-to-EVEN, per Python's round) and clamped exactly as
                # before: this is the value that goes ON DISK as "context_pct", and
                # the status bar's reader expects the same integer it always got. The
                # .mjs mirrors the same rounding for the same reason.
                p_int = int(round(up))
                if p_int < 0:
                    p_int = 0
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
                    # Same as raw_ctx above: rounded for the on-disk "five_hour_pct",
                    # not for any rendered text.
                    fh_int = int(round(fh_up))
                    if fh_int < 0:
                        fh_int = 0
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

# --- Silent-mode marker probe -----------------------------------------------
# LAST, and deliberately AFTER both state writes above, so it cannot influence
# them: silence is a stdout concern only. Reported to bash as a field rather than
# acted on here, because the printing happens there.
#
# expanduser("~") is the SAME home resolution the two writes above use, which is
# the reason this probe lives inside the python3 block at all: doing it in bash
# with $HOME would be a second, subtly different rule.
#
# Any failure yields "0" — which means only "this probe contributes nothing", NOT
# "print": bash's _SILENT_BY_DEFAULT decides that, and it is silent. So an
# unreadable directory or a permission error can no longer change the outcome in
# either direction, which is a strictly better property than the old one and is
# what let the default invert without touching this probe at all. It is "0" rather
# than "" so that a failed probe is still distinguishable from a block that never
# got here at all — see the "0"/"1"/"" vocabulary at the top of this block.
try:
    if os.path.exists(os.path.expanduser("~/.ghola/statusline/silent")):
        silent_marker = "1"
except Exception:
    silent_marker = "0"

# THE LAST STATEMENT IN THE BLOCK, and load-bearing as such: reaching it is what
# tells bash that both state writes above were executed. Do not move it upward, do
# not add anything after it that could fail, and do not let it emit an empty string.
sys.stdout.write(silent_marker)
PY
)"

# --- 3a. FALLBACK WRITER: cover a python3 that never ran ----------------------
# An EMPTY $parsed is not one of the block's answers (it reports "0" or "1"), and its
# write is the block's last statement, so empty means the block did not get there —
# python3 absent from PATH, not executable, a stub, a broken stdlib, or a crash. In
# that case NEITHER STATE WRITE HAPPENED, and because the footer is silent by default
# the only symptom is a VS Code status-bar pill that empties 90 seconds later, with
# no error, no exit code, and nothing to grep. That is the failure this block exists
# to remove.
#
# The remedy is to re-run the render under the OTHER interpreter: the sibling
# scripts/ghola-statusline.mjs is the byte-identical Node port and writes the same
# two files to the same paths with no python3 involved. The payload captured in step
# 2 is piped into it (a pipe, not a here-string: no temp file, and `node` reads fd 0
# to EOF rather than exiting early, so this is the full-reading-consumer form CLAUDE.md
# rule 7 asks for even in a script with no `pipefail`).
#
# STDOUT OF THE DELEGATE IS DISCARDED and bash still prints for itself below. That is
# the point: this block can only ADD a state write, never change, duplicate, or
# suppress a byte of this script's output, so the render contract is untouched on
# every path. stderr is discarded for the same reason — a statusline never emits
# diagnostics. Every guard is a test rather than a trap, so a missing node, an
# unreadable .mjs, or an unresolvable script directory just skips the attempt.
#
# NOT AN OPTIMIZATION AND NOT THE PRIMARY PATH. python3 is still tried first on every
# render, deliberately: its block is the third implementation of the state-key
# algorithm that scripts/ghola-statusline-parity.mjs checks three ways, and preferring
# node would demote it to code that never runs on this host while the checker went on
# certifying it. Keeping it primary also keeps the .sh and .mjs independently
# exercised, which is what makes "pipe the same payload into both and diff" a real
# test instead of a tautology.
if [ -z "$parsed" ]; then
    _mjs_fallback="${_SCRIPT_DIR}/ghola-statusline.mjs"
    if [ -n "$_SCRIPT_DIR" ] && [ -r "$_mjs_fallback" ] && command -v node >/dev/null 2>&1; then
        printf '%s' "$payload" | node "$_mjs_fallback" >/dev/null 2>&1
    fi
fi

# ONE field, so there is nothing to split: $parsed IS the marker report. Kept as a
# named assignment rather than using $parsed below, so the block above and the
# precedence logic below still meet at an explicitly named value — and so growing a
# second field back means re-adding a split here rather than quietly reinterpreting
# this one. If python3 failed, $parsed is empty, and empty is NO SIGNAL: it falls
# through to _SILENT_BY_DEFAULT below, so a dead parser lands on silence like every
# other ambiguous input. (This comment used to say an empty field meant NOT silent.
# That was true before the default inverted and is not true now — the value it
# describes takes the `else` branch, which is silent.)
silent_marker="$parsed"

# --- 3b. Resolve silent mode: env override FIRST, marker second, SILENT by default ---
# SILENCE IS THE DEFAULT. With no environment override and no marker file this is
# the answer, so an ordinary invocation emits zero bytes while still having done
# both state writes above.
#
# Spelled as a named variable rather than a bare "1" in the branch below because it
# is the ONE line to flip to restore a printing footer, and because it is the value
# SILENT_BY_DEFAULT in scripts/ghola-statusline.mjs has to agree with. The two
# renderers are a hand-maintained pair; this default is part of that contract.
_SILENT_BY_DEFAULT="1"

# The env var is normalized here in pure bash — no filesystem, no subprocess, so
# this step cannot fail and cannot be lost when python3 is unavailable. That
# matters more than it used to: it is now the only signal that can turn the line
# back on, so it must survive a dead python3.
#
# Trim surrounding POSIX whitespace with the standard parameter-expansion idiom
# (a real trim, not `tr -d`, which would also eat whitespace in the MIDDLE of a
# value and so disagree with the .mjs on an input like "t rue").
_silent_env="${GHOLA_STATUSLINE_SILENT-}"
_silent_env="${_silent_env#"${_silent_env%%[![:space:]]*}"}"
_silent_env="${_silent_env%"${_silent_env##*[![:space:]]}"}"

# Case-insensitive match spelled as explicit ASCII character classes rather than
# ${var,,} or `tr '[:upper:]' '[:lower:]'`: both are locale-sensitive, and the
# .mjs folds with an explicit [A-Z] class for exactly the same reason the state-key
# algorithm does. "" means NO SIGNAL, not "not silent" — unset, empty,
# whitespace-only, and unrecognized values all defer onward, so a shell that
# exports the variable empty cannot resurrect the footer and a typo (`flase`)
# cannot either. Every ambiguous input now errs toward SILENCE, following the
# default rather than contradicting it — the inverse of what it used to do.
case "$_silent_env" in
    1|[Tt][Rr][Uu][Ee]|[Yy][Ee][Ss])  _silent_override="1" ;;
    0|[Ff][Aa][Ll][Ss][Ee]|[Nn][Oo])  _silent_override="0" ;;
    *)                                _silent_override="" ;;
esac

# An explicit override wins in BOTH directions, and it is now the ONLY thing that
# can change the outcome: `GHOLA_STATUSLINE_SILENT=0` is the escape hatch that puts
# the bracket back for one session. The marker file is consulted next so a marker
# the operator already created keeps meaning what it said, but it can only ever ask
# for the default that already applies. Everything else — marker absent, python3
# dead, variable unset — lands on _SILENT_BY_DEFAULT.
if [ -n "$_silent_override" ]; then
    silent="$_silent_override"
elif [ "$silent_marker" = "1" ]; then
    silent="1"
else
    silent="$_SILENT_BY_DEFAULT"
fi

# --- 4. Emit the line, unless silenced ---
# THE BRACKET CARRIES THE VERSION AND NOTHING ELSE. There is no metrics group to
# build, so there is no parts array, no U+2502 separator introducing it, and no
# U+00B7 joining its members - all three went together, which is the only way to
# remove a segment without stranding the punctuation that framed it. One printf is
# therefore the whole render: no branch can leave a trailing separator, an empty
# group, or a doubled space inside the bracket, because none of those characters is
# emitted on any path. No ANSI escape is emitted either - the red-at-85 tint went
# with the percentages it colored, and it was the only color this script produced.
#
# SILENCE IS THE ONLY THING GATED HERE, and on an ordinary invocation it wins — the
# printf below is NOT reached unless the operator set GHOLA_STATUSLINE_SILENT=0. It
# is kept, not deleted, because it is the escape hatch's whole output. Both state
# writes already happened inside the python3 block above, which is the entire point:
# the status-bar pill keeps its data while the footer row is gone. Nothing at all is
# written - not a newline - though the harness trims stdout and drops blank lines,
# so it would treat the two identically.
if [ "$silent" != "1" ]; then
    printf '[Ghola v%s]' "$version"
fi
