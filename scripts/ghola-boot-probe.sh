#!/usr/bin/env bash
# ghola-boot-probe.sh — one-shot consolidated session-start probe for Ghola.
#
# Collapses the ~9 per-step boot probes into ONE invocation so the TPM startup
# sequence costs a single model round-trip instead of nine. Prints a compact
# key=value digest to stdout (one field per line); writes bulky detail (the Jira
# ticket body and the notes handoff block) to a temp file named in the digest as
# `detail_file=`. NEVER fails and never prints error text — every probe is
# guarded and unavailable data degrades to `na`/`none`. No `set -e`.
#
# ONE exception to "degrades silently": a bridge that is not reachable now
# reports `ticket_state=bridge-down` / `pr_state=bridge-down` and an extra
# `bridge_state=down` field. That is deliberate — a dead bridge and an absent
# ticket are different problems with different fixes, and collapsing them into
# the same `unavailable`/`na` is what made a bridge outage invisible at boot.
# The probe still never blocks: every bridge call is wrapped in `timeout`.
#
# Env consumed (exported by the launcher): GHOLA_VERSION, GHOLA_BRANCH,
# GHOLA_ROOT, GHOLA_TPM_PROMPT_FILE, GHOLA_SWE_PROMPT_FILE, GHOLA_QA_PROMPT_FILE,
# SWE_PERFORMANCE_CORES, SWE_EFFICIENCY_CORES, QA_AGENT_COUNT,
# SWE_PERFORMANCE_MODEL, SWE_EFFICIENCY_MODEL, QA_MODEL, and optional GHOLA_VAULT.
#
# STRICTLY READ-ONLY except for its own temp `detail` file (under /tmp, or under
# `%TEMP%` on a native-Windows session — see the detail-file block below). It never
# writes to the work repo or the Obsidian vault — note-file creation and any
# vault writes remain TPM's job via the obsidian-notes module, AFTER this probe.

emit() { printf '%s=%s\n' "$1" "$2"; }

# ── Bridge liveness plumbing ────────────────────────────────────────────────
# Both bridge calls below used to send stderr to /dev/null, which threw away the
# ONLY diagnostic there was: a dead bridge degraded to ticket_state=unavailable /
# pr_state=na, indistinguishable from "no ticket key in this branch" or "this is
# not a Bitbucket repo". The operator saw silence and three sessions guessed
# wrong about why. We now capture stderr and classify it.
#
# bb-bridge.mjs stamps every transport-level failure with a stable marker:
# `bridge-unreachable` (transport is dead), `bridge-unavailable` (no coordinates
# exist at all), or `bridge-timeout` (the bridge answered the connection and is
# healthy — WE stopped waiting, because the upstream is throttling the host and
# it is deliberately backing off). Those THREE strings are the contract between
# that script and this one — changing any of them requires changing both.
#
# The third marker is not a variant of the first two and must never be folded
# into them. `bridge-unreachable`/`bridge-unavailable` mean RELAUNCH THE SESSION;
# `bridge-timeout` means the bridge is fine, the lookup is simply UNANSWERED, and
# relaunching fixes nothing. Both differ again from a plain `na`/`notfound`, which
# is a lookup that DID complete and found nothing.
# Unlike `detail` below, this path is NEVER emitted — only this script's own bash
# opens it — so its MSYS-vs-Win32 form is irrelevant and plain `mktemp` is correct
# here on every platform. Do not "fix" it to match the detail file.
bridge_err="$(mktemp 2>/dev/null || echo /tmp/ghola-boot-bridge-err.txt)"
bridge_state=""

# True (exit 0) when the MOST RECENT captured stderr names a bridge-level
# failure; also latches the sticky `bridge_state` used by the digest. Callers
# must truncate "$bridge_err" immediately before their bb-bridge call so this
# only ever judges that call.
#
# NOTE: grep reads the FILE directly. It is deliberately NOT fed by a pipe from
# a producer — `producer | grep -q` makes the producer take SIGPIPE (141) the
# moment grep exits on its first match, which a `set -o pipefail` caller would
# promote to a spurious failure. This probe has no `set -e`, but the repo rule
# stands and this stays pipe-free.
bridge_down_last() {
  [ -s "$bridge_err" ] || return 1
  grep -qE 'bridge-unreachable|bridge-unavailable' "$bridge_err" 2>/dev/null || return 1
  bridge_state="down"
  return 0
}

# True (exit 0) when the MOST RECENT captured stderr says the bridge was ALIVE
# and we stopped waiting — bb-bridge's `bridge-timeout` marker, which it emits on
# `get-ticket`/`find-pr` when the host is mid-backoff against a rate-limiting
# (HTTP 429) or 5xx upstream. Same per-call discipline as `bridge_down_last`: the
# caller must truncate "$bridge_err" immediately before its bb-bridge call, and
# grep reads the FILE directly, never through a pipe (see the note above).
#
# This is a THIRD verdict, not a softer `down`. The state it latches is
# `upstream-slow`, and the only correct reading of it is "we could not look";
# the bridge is healthy, so relaunching the session is the WRONG advice, and the
# result is an UNKNOWN, never an absence. Collapsing it into `unavailable`/`na`
# is what made a throttled boot lookup read as "no ticket" / "no PR".
#
# `down` deliberately outranks `upstream-slow` on the STICKY `bridge_state`: that
# field latches across both bridge calls, and if one call found the transport dead
# then "relaunch the session" is real, actionable advice that a later slow call
# must not overwrite. The per-call return value is unaffected — the call site that
# saw the timeout still reports its own `bridge-slow` state.
bridge_slow_last() {
  [ -s "$bridge_err" ] || return 1
  grep -qE 'bridge-timeout' "$bridge_err" 2>/dev/null || return 1
  [ "$bridge_state" = "down" ] || bridge_state="upstream-slow"
  return 0
}

# ── Platform detection + path translation ───────────────────────────────────
# The probe runs under WSL today, but a native-Windows session runs it under
# Git-for-Windows bash, where every path the probe DERIVES from strings resolves
# to nothing. `work_repo` survives only because it is produced by `git rev-parse`,
# whose Windows build emits `C:/...` on its own. `$GHOLA_VAULT` does not: the
# launcher hands it over in WSL `/mnt/c/...` form, and on native Windows that
# silently fails every `-f`/`-d` test below, which reports `notes_exists=no` and
# a confident "fresh session" on a ticket that has thousands of lines of notes.
#
# `translate_path` is deliberately PURE BASH — no `cygpath`, no `wslpath`, no
# subprocess of any kind. `cygpath -m /mnt/c/Users/x` returns
# `<msys-root-drive>:/mnt/c/Users/x`: a syntactically perfect, plausible-looking,
# NONEXISTENT path. `/mnt/<letter>` is a WSL mount-table remap, not a path
# format, and cygpath knows nothing about WSL's mount table. A pure `case` also
# cannot write to stderr and cannot depend on PATH, both of which this
# never-fails/never-prints probe requires.
#
# Windows-form output is ALWAYS `C:/...`, never MSYS `/c/...`. The digest has two
# consumers with different path grammars: bash (accepts either form) and the
# agent's Read/Write tools (accept only `C:/` or `C:\`). `C:/` is the unique form
# that satisfies both.
#
# KEEP IN SYNC with `toNativeHostPath` in `src/session/host-path.ts` and its
# hand-maintained mirror in `scripts/ghola.mjs` — the same rule set, three times,
# because none of the three can import from either of the others. That instruction
# is no longer enforced by comment alone: `scripts/ghola-path-parity.mjs` extracts
# `translate_path` (anchored on its header, so renaming it fails the checker
# loudly), sources it in a subshell, drives all three over one shared case table
# under every forced `shell_os`, and exits non-zero on any drift. Run it after
# touching this function. Two differences remain and are AGREED, recorded here and
# in the same words in both JS copies:
#
# KEEP-IN-SYNC EXCEPTION 1 — the bare re-slash is UNGATED here and GATED in JS.
# Step 1 below re-slashes unconditionally and this function returns the re-slashed
# string even when no platform arm fired, so `C:\Users\x` comes back as
# `C:/Users/x`; the JS pair treats the bare re-slash as a translation like any
# other and returns it only if `existsSync` confirms it, otherwise handing back the
# operator's original spelling. Deliberate on both sides: a backslash is a LEGAL
# POSIX filename character, so the JS copies refuse to re-slash unverified, while
# this function must normalize before matching (a glob cannot match through `\`)
# and its own callers — blocks 8a/8b — adopt its output only after `-d`. Both
# spellings name the same directory to every Win32 consumer, so the difference is
# cosmetic; the parity checker neutralizes the JS gate and sees the transforms
# agree.
#
# KEEP-IN-SYNC EXCEPTION 2 — this function models THREE platforms and makes `unix`
# the identity so a plain Linux or macOS host is never rewritten; both JS copies
# model TWO (`win32` vs everything else) and therefore apply the WSL rule on
# darwin and on non-WSL Linux. Accepted rather than reconciled: a WSL detector in
# JS would be a FOURTH copy of a rule set whose duplication is already the problem,
# and JS's `existsSync` gate neutralizes the difference on any host with no
# `/mnt/<letter>` tree. Residual: a plain-Linux host that really mounts `/mnt/c`
# would see the JS pair adopt `C:/Users/x` -> `/mnt/c/Users/x` where this function
# keeps `C:/Users/x`. Neither supported host (WSL, native Windows) is affected, and
# the JS side only adopts a path it has CONFIRMED exists, so the worst case is a
# disagreement about a real directory rather than a fabricated one.

# Echoes `windows` (Git Bash / MSYS / Cygwin), `wsl`, or `unix`. Anything
# unrecognized degrades to `unix`, whose translation is the identity, so a plain
# Linux or macOS host is never rewritten. The detector is deliberately NOT "does
# /mnt/c exist": that is false on plain Linux and macOS too, and false on a WSL
# install with a custom `automount.root`. `grep` reads /proc/version as a FILE,
# never through a pipe — same reason as `bridge_down_last` above.
shell_platform() {
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*) printf '%s' "windows"; return 0 ;;
  esac
  if [ -r /proc/version ] && grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then
    printf '%s' "wsl"; return 0
  fi
  printf '%s' "unix"
}
shell_os="$(shell_platform)"

# Rewrite $1 into the CURRENT platform's path form; echoes the input unchanged
# when no rule applies. Every drive-letter pattern matches exactly ONE character
# followed by `/` or end-of-string, so `/mnt/wsl`, `/mnt/host`, `/mnt/cdrom` and
# a legitimately-named Linux `/mnt/data` disk are all left alone (a glob like
# `/mnt/[a-zA-Z]*` would wrongly capture every one of them). `${d^^}`/`${d,,}`
# are bash 4+ and are only ever reached on the windows/wsl branches, where the
# shell is Git-for-Windows bash 5 or WSL bash 5.
translate_path() {
  # Step 1, unconditional and on EVERY platform: `\` -> `/`. A native-Windows
  # Detect Vault stores a backslash path (vault-discovery.ts builds it with
  # path.join), so a `/mnt/`-only rewrite would miss the likeliest real input.
  local p="${1//\\//}"
  case "$shell_os" in
    windows)
      case "$p" in
        //*) ;;                                   # UNC `//server/share` — passthrough
        [a-zA-Z]:|[a-zA-Z]:/*) ;;                 # already `C:` / `C:/...` — nothing to do
        [a-zA-Z]:*) ;;                            # drive-RELATIVE `C:foo` — ambiguous, refuse
        /mnt/[a-zA-Z]|/mnt/[a-zA-Z]/*)            # WSL mount -> `C:/...`
          local d="${p:5:1}" r="${p#/mnt/?}"
          p="${d^^}:${r:-/}" ;;                   # `${r:-/}` keeps `/mnt/c/` from becoming `C://`
        /[a-zA-Z]|/[a-zA-Z]/*)                    # MSYS `/c/...` -> `C:/...`
          local d="${p:1:1}" r="${p#/?}"
          p="${d^^}:${r:-/}" ;;
      esac ;;
    wsl)
      case "$p" in
        //*) ;;                                   # UNC — passthrough
        [a-zA-Z]:|[a-zA-Z]:/*)                    # `C:` / `C:/...` -> `/mnt/c/...`
          local d="${p%%:*}" r="${p#?:}"
          d="${d,,}"; p="/mnt/${d}${r:-/}" ;;
        [a-zA-Z]:*) ;;                            # drive-relative `C:foo` — refuse
        /[a-zA-Z]|/[a-zA-Z]/*)                    # MSYS `/c/...` -> `/mnt/c/...`
          local d="${p:1:1}" r="${p#/?}"
          d="${d,,}"; p="/mnt/${d}${r:-/}" ;;
      esac ;;
    *) ;;                                         # unix: identity beyond step 1
  esac
  printf '%s' "$p"
}

# ── Detail file (the bulky-output overflow named by `detail_file=`) ──────────
# Created HERE, after the platform block, and not at the top of the script:
# choosing its location needs `shell_os` and `translate_path`.
#
# The problem this solves is the same silent degradation as the vault path, one
# field over. `mktemp` under Git Bash returns an MSYS path (`/tmp/tmp.XXXXXXXX`),
# the digest emits it as `detail_file=`, and TPM opens that path with its Read
# tool — a Win32-API consumer that knows nothing about the MSYS mount table. If
# the open fails, EVERY native-Windows boot silently loses the handoff block.
#
# `translate_path` cannot rescue this and deliberately does not try: MSYS `/tmp`
# is a mount-table entry (`<git-root>/tmp` on some installs, the `usertemp`
# mapping of `%TEMP%` on others), so its Win32 form is NOT derivable from the
# string `/tmp/...`. The drive-letter patterns above match exactly ONE character,
# so `/tmp/...` falls straight through unchanged — correctly, because translating
# it would mean inventing a path. Emitting an unverified translation is the one
# thing worse than emitting the MSYS form.
#
# So on windows we do not translate; we CREATE the file somewhere whose Win32
# form is already known — `%TEMP%`/`%TMP%`, which Git Bash inherits from the
# Windows environment in `C:\...` form — and emit that verified path. If no such
# directory can be confirmed we fall back to plain `mktemp` AND emit
# `detail_file_form=msys`, so the consumer can react (translate it itself, or skip
# the read and say so) instead of failing blind. Nothing here runs off the windows
# branch, so wsl/unix keep the original single `mktemp` byte for byte.
detail=""; detail_form=""
if [ "$shell_os" = "windows" ]; then
  for t in "$TEMP" "$TMP" "$TMPDIR"; do
    [ -n "$t" ] || continue
    td="$(translate_path "$t")"
    # ONLY a drive-letter-rooted directory is usable. Anything still in POSIX form
    # after translation (`/tmp`, `/var/tmp`) is exactly the unknowable case above,
    # so it is skipped rather than guessed at.
    case "$td" in [a-zA-Z]:/*) ;; *) continue ;; esac
    [ -d "$td" ] || continue
    detail="$(mktemp "${td%/}/ghola-boot-detail.XXXXXX" 2>/dev/null)"
    # mktemp echoes back the template it was handed, so this is already `C:/...`;
    # re-canonicalize anyway (cheap, and survives a mktemp that normalizes form)
    # and require the file to actually EXIST before trusting the path — the same
    # try-then-verify discipline the vault gate uses. Any miss clears `detail` and
    # tries the next candidate.
    if [ -n "$detail" ]; then
      detail="$(translate_path "$detail")"
      case "$detail" in [a-zA-Z]:/*) [ -f "$detail" ] && break ;; esac
    fi
    detail=""
  done
  [ -z "$detail" ] && detail_form="msys"
fi
if [ -z "$detail" ]; then
  detail="$(mktemp 2>/dev/null || echo /tmp/ghola-boot-detail.txt)"
fi
: > "$detail" 2>/dev/null

# 1. version
version="${GHOLA_VERSION:-}"
if [ -z "$version" ] && [ -n "$GHOLA_ROOT" ]; then
  version="$(tr -d '[:space:]' < "$GHOLA_ROOT/VERSION" 2>/dev/null)"
fi
[ -z "$version" ] && version="unknown"

# 1b. current time (guarded; empty is fine if date is unavailable)
now="$(date +'%Y-%m-%d %H:%M %Z (%A)' 2>/dev/null)"

# 1c. session mode (exported by the launcher; empty => unconstrained). Used to
# gate the ticket-key Jira pull and the ticket-notes lookup: a non-ticket mode
# (support, cd, self-upgrade) owns its own work surface, so the probe suppresses
# that work. self-upgrade only ever operates on the Project-Ghola repo itself.
mode_session="${GHOLA_MODE:-}"
# Exact-token match (not substring) so a future mode whose name merely CONTAINS
# `cd`/`support`/`self-upgrade` (e.g. `mode.abcd`, `mode.customer-support`) does
# not wrongly gate as non-ticket and desync from the banner's exact matching.
# GHOLA_MODE is normally a single token but can be a `, `-joined list; tokenize
# on comma/space. Empty/unset leaves the loop a no-op (non_ticket_mode stays no).
non_ticket_mode="no"
_oldifs="$IFS"; IFS=', '
for _tok in $mode_session; do
  case "$_tok" in support|cd|self-upgrade) non_ticket_mode="yes" ;; esac
done
IFS="$_oldifs"

# 2. environment
env_state="ok"; missing=""
[ -z "$GHOLA_ROOT" ] && env_state="fail" && missing="GHOLA_ROOT"
for v in GHOLA_TPM_PROMPT_FILE GHOLA_SWE_PROMPT_FILE GHOLA_QA_PROMPT_FILE; do
  f="${!v}"
  if [ -z "$f" ] || [ ! -r "$f" ]; then env_state="fail"; missing="${missing:+$missing,}$v"; fi
done

# 2b. statusline health (READ-ONLY: never writes, stages, or repairs harness config)
# Closes the one silent failure `modules/tool.statusline/statusline.md` admits it
# cannot close from inside a renderer, and that file ("A residual silent failure")
# names THIS probe as the right home for the signal.
#
# Both renderers now emit ZERO BYTES by default, so the footer is no longer a
# symptom of anything: the ONLY reason they still run is the state write to
# `~/.ghola/statusline/state/<key>.json` that feeds the VS Code status-bar pill.
# `ghola-statusline.sh` parses the harness payload with `python3` and falls back to
# `node <dir>/ghola-statusline.mjs` when that python3 will not run — but with
# NEITHER interpreter resolvable nothing is written, nothing errors, nothing is
# logged, and the pill just empties once the reader's 90-second staleness window
# passes. There is no visible symptom anywhere and nothing to grep, which is why
# the condition has to surface at boot instead.
#
# ONE field, `statusline_health`, with a five-token closed vocabulary:
#   ok       — a Ghola renderer is configured and an interpreter that can run it
#              resolves: `.mjs` + node, or `.sh` + node (which arms the fallback
#              writer even if python3 is dead), or `.sh` + python3 + node.
#   at-risk  — `.sh` configured, python3 resolves, node does NOT. It renders and
#              writes state TODAY, but the fallback writer is disarmed, so a
#              python3 that later stops running takes the pill with it, silently.
#   broken   — no interpreter can run the configured renderer (`.sh` with neither,
#              `.mjs` with no node). Nothing writes state: THIS is the silent case.
#   none     — a USER-LEVEL settings file WAS read and no candidate carries a
#              `statusLine` command, so the harness invokes no renderer at all. A
#              CONFIRMED absence, which is why it takes the user-level file: see
#              `sl_user_from` below for why a project file alone cannot license it.
#   unknown  — nothing was confirmed: no settings file was readable, the
#              `statusLine` block yielded no command, or the command names neither
#              Ghola renderer. NEVER a health claim; see the module's rendering.
#
# Unlike `bridge_state` / `vault_state` / `detail_file_form`, this field is emitted
# UNCONDITIONALLY, `ok` included. Those are absent-means-healthy; this one cannot
# be, because absent has to keep meaning "an older probe wrote this digest". That
# is the same rule those fields follow, reached from the other side: a check that
# went unanswered and a check that came back healthy must never collapse together.
#
# The parse is deliberately PURE BASH — no `node`, no `python3`, no `jq`. Using an
# interpreter to detect a missing interpreter is the one thing that cannot work: in
# the `broken` case there is nothing left to parse with. So the file is read with
# `$(<file)` (a bash redirection, not a subprocess) and sliced with parameter
# expansion. It is a targeted extraction, not a JSON parser: take everything after
# the `"statusLine"` key, bound it at the next `}` so a `"command"` belonging to a
# `hooks` entry can never be picked up, then lift the first quoted value after
# `"command"`. Anything that does not yield a value degrades to `unknown`.
#
# The renderer is identified by FILENAME SUBSTRING, never by resolving the path.
# The command can be `node C:/Users/x/.ghola/statusline/ghola-statusline.mjs`, a
# bare repo path (this operator's live WSL config), or carry `\\`-escaped Windows
# separators; the basename survives all three with no filesystem test at all.
#
# Candidates are tried in the harness's own precedence order FOR THIS KEY, and the
# first file that actually CARRIES a statusLine command wins — a project settings
# file that exists but says nothing about the statusline must not mask the
# user-level one, which is how the merge behaves for a single key.
# `$CLAUDE_CONFIG_DIR` comes before `$HOME` because it RELOCATES the whole config
# directory when set (it IS set in this operator's live environment), so preferring
# `$HOME` would read a file the harness never reads and report a confident `none`.
# Two limits, recorded rather than guessed at: an enterprise `managed-settings.json`
# outranks every file below and is not consulted, and the project candidates are
# derived from `$PWD` because that is the surface the harness resolves them from.
statusline_health="unknown"
sl_node="no"; sl_py="no"
command -v node >/dev/null 2>&1 && sl_node="yes"
command -v python3 >/dev/null 2>&1 && sl_py="yes"
# Ordered candidate list, built the same guarded way as the vault roots in block 8:
# a missing input DROPS its candidate instead of composing a nonsense path.
sl_files=()
[ -n "$PWD" ] && sl_files+=("$PWD/.claude/settings.local.json" "$PWD/.claude/settings.json")
# `sl_user_from` is the index where the USER-LEVEL candidates begin, and it exists
# to keep the `none` verdict honest. A project settings file that says nothing
# about the statusline rules NOTHING out — the user-level file is where this
# operator's `statusLine.command` actually lives — so a run that could read only
# the project file (e.g. an unset `HOME`) must answer `unknown`, not assert a
# confirmed absence about a file it never opened. Only a readable USER-LEVEL
# candidate licenses `none`; a positive hit is still taken from whichever file
# carries it, project files first, because that is the harness's precedence.
sl_user_from="${#sl_files[@]}"
[ -n "$CLAUDE_CONFIG_DIR" ] && sl_files+=("$CLAUDE_CONFIG_DIR/settings.json")
[ -n "$HOME" ] && sl_files+=("$HOME/.claude/settings.json")
if [ "$shell_os" = "windows" ] && [ -n "$USERPROFILE" ]; then
  # Same reasoning as block 8's windows arm: Git Bash inherits `%USERPROFILE%` in
  # `C:\...` form, and step 1 of `translate_path` alone repairs the separators.
  sl_files+=("$(translate_path "$USERPROFILE")/.claude/settings.json")
fi
sl_user_seen="no"; sl_key="no"; sl_cmd=""; _sl_i=0
# Guarded expansion (empty array), matching block 8 — this probe must never error.
if [ "${#sl_files[@]}" -gt 0 ]; then
  for _sl_f in "${sl_files[@]}"; do
    if [ "$_sl_i" -ge "$sl_user_from" ]; then _sl_user="yes"; else _sl_user="no"; fi
    _sl_i=$((_sl_i + 1))
    # `-f` before `-r`: a DIRECTORY passes `-r`, and `$(<dir)` would write to
    # stderr, which this probe must never do.
    [ -f "$_sl_f" ] && [ -r "$_sl_f" ] || continue
    [ "$_sl_user" = "yes" ] && sl_user_seen="yes"
    _sl_raw=""
    # Braced group so the stderr redirect covers the command substitution. Do NOT
    # fold it into `$(<"$_sl_f" 2>/dev/null)`: a second redirect defeats bash's
    # read-a-file special case, which silently yields the EMPTY string instead.
    { _sl_raw="$(<"$_sl_f")"; } 2>/dev/null
    _sl_after="${_sl_raw#*\"statusLine\"}"
    # Unchanged means the key is absent from THIS file; keep looking, because a
    # lower-precedence file may still configure it.
    [ "$_sl_after" = "$_sl_raw" ] && continue
    sl_key="yes"
    # Bound the slice at the statusLine object's closing brace BEFORE hunting for
    # `"command"`. With no brace at all the extraction is not trustworthy, so it
    # yields nothing and the field degrades to `unknown`.
    case "$_sl_after" in *\}*) _sl_obj="${_sl_after%%\}*}" ;; *) _sl_obj="" ;; esac
    # The key is matched WITH its colon, and that is load-bearing rather than
    # tidy: the sibling `"type": "command"` puts the bare token `"command"` in
    # this same object BEFORE the real key, so matching the token alone lifts the
    # word `command` as the renderer path and reports a healthy host as
    # `unknown`. Two spellings are tried because JSON permits whitespace before
    # the colon; anything more exotic yields no value and degrades to `unknown`.
    for _sl_pat in '"command":' '"command" :'; do
      case "$_sl_obj" in
        *"$_sl_pat"*)
          sl_cmd="${_sl_obj#*"$_sl_pat"}"  # ` "<cmd>", ...` remains
          sl_cmd="${sl_cmd#*\"}"           # through the opening quote
          sl_cmd="${sl_cmd%%\"*}"          # up to the closing quote
          break ;;
      esac
    done
    break
  done
fi
if [ -n "$sl_cmd" ]; then
  case "$sl_cmd" in
    *ghola-statusline.mjs*) _sl_target="mjs" ;;
    *ghola-statusline.sh*)  _sl_target="sh" ;;
    *)                      _sl_target="other" ;;
  esac
  case "$_sl_target" in
    mjs)
      # The `.mjs` needs node and nothing else; python3 is irrelevant to it.
      if [ "$sl_node" = "yes" ]; then statusline_health="ok"; else statusline_health="broken"; fi ;;
    sh)
      # node FIRST: it alone is sufficient, because the fallback writer covers a
      # python3 that will not run. python3 alone renders today but is unbacked.
      if [ "$sl_node" = "yes" ]; then statusline_health="ok"
      elif [ "$sl_py" = "yes" ]; then statusline_health="at-risk"
      else statusline_health="broken"; fi ;;
    *) statusline_health="unknown" ;;   # a command that is not a Ghola renderer
  esac
elif [ "$sl_key" = "no" ] && [ "$sl_user_seen" = "yes" ]; then
  statusline_health="none"
fi
# Every other outcome — no readable user-level settings file, or a `statusLine`
# block that yielded no command — keeps the initialized `unknown`, which is the
# honest answer for a check that could not be completed.

# 3. team
perf="${SWE_PERFORMANCE_CORES:-2}"; eff="${SWE_EFFICIENCY_CORES:-1}"; qa="${QA_AGENT_COUNT:-1}"
pm="${SWE_PERFORMANCE_MODEL:-opus}"; em="${SWE_EFFICIENCY_MODEL:-sonnet}"; qm="${QA_MODEL:-sonnet}"

# 4/5. work repo + branch (resolve the clone checked out on GHOLA_BRANCH if cwd is a container)
repo=""; branch=""
if git -C "$PWD" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  repo="$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null)"
fi
if [ -z "$repo" ] && [ -n "$GHOLA_BRANCH" ]; then
  for d in "$PWD"/* "$HOME"/projects/*; do
    [ -d "$d" ] || continue
    b="$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null)"
    if [ "$b" = "$GHOLA_BRANCH" ]; then
      repo="$(git -C "$d" rev-parse --show-toplevel 2>/dev/null)"; break
    fi
  done
fi
[ -n "$repo" ] && branch="$(git -C "$repo" rev-parse --abbrev-ref HEAD 2>/dev/null)"
[ -z "$branch" ] && branch="${GHOLA_BRANCH:-}"

# 5b. self-upgrade repo guard (only when the session IS self-upgrade). Self
# Upgrade operates ONLY on the Project-Ghola repo itself. Confirm the resolved
# work repo is Project-Ghola by parsing its package.json "name" (== "ghola");
# the package.json name is the robust signal (survives clone renames). Guarded
# node parse, like the ticket/get-ticket parsing; never fails.
self_upgrade_repo=""
# Exact-token match (mirrors the non_ticket_mode gate above): only an EXACT
# `self-upgrade` token triggers the repo guard, not a substring.
_is_self_upgrade="no"
_oldifs="$IFS"; IFS=', '
for _tok in $mode_session; do
  [ "$_tok" = "self-upgrade" ] && _is_self_upgrade="yes"
done
IFS="$_oldifs"
if [ "$_is_self_upgrade" = "yes" ]; then
  self_upgrade_repo="wrong"
  if [ -n "$repo" ] && [ -f "$repo/package.json" ]; then
    pkgname="$(node -e 'try{const p=require(process.argv[1]);process.stdout.write(String((p&&p.name)||""))}catch(e){}' "$repo/package.json" 2>/dev/null)"
    [ "$pkgname" = "ghola" ] && self_upgrade_repo="ok"
  fi
fi

# 6. mode detection
mode="author"; base=""; ahead=""
if [ -n "$repo" ]; then
  for b in main dev master; do
    git -C "$repo" show-ref --verify --quiet "refs/heads/$b" && base="$b" && break
  done
  [ -z "$base" ] && base="$(git -C "$repo" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null | sed 's#^[^/]*/##')"
  if [ -n "$base" ]; then
    ahead="$(git -C "$repo" rev-list --count "$base..HEAD" 2>/dev/null)"
    if [ "$ahead" = "0" ]; then
      mode="planning"
    else
      me="$(git -C "$repo" config user.email 2>/dev/null)"
      if [ -n "$me" ]; then
        others="$(git -C "$repo" log "$base..HEAD" --format='%ae' 2>/dev/null | sort -u | grep -v -x -F "$me")"
        [ -n "$others" ] && mode="review"
      fi
    fi
  fi
fi

# 7. ticket key + Jira pull via the bridge
# The key is derived from the branch ALWAYS (cheap regex, informational). The
# Jira pull is gated on mode: a non-ticket mode (support, cd) is not
# ticket-scoped, so it is a clean skip (ticket_state=skipped) with no bridge call.
key=""
# CLAUDE.md rule 7: capture the producer's output first, then slice the
# variable with `head`, so an early-exiting consumer never SIGPIPEs a live
# producer if `set -o pipefail` is ever added to this file.
if [ -n "$branch" ]; then
  _key_matches="$(printf '%s' "$branch" | grep -oiE '[A-Z][A-Z0-9]+-[0-9]+')"
  [ -n "$_key_matches" ] && key="$(head -1 <<<"$_key_matches" | tr 'a-z' 'A-Z')"
fi
ticket_state="none"; ticket_status=""; ticket_summary=""
if [ "$non_ticket_mode" = "yes" ]; then
  ticket_state="skipped"
elif [ -n "$key" ] && [ -n "$GHOLA_ROOT" ] && [ -f "$GHOLA_ROOT/scripts/bb-bridge.mjs" ]; then
  # `timeout 8` mirrors the PR probe's guard below. This call previously had NO
  # outer bound at all, which was survivable only because the client had no
  # timeout either and a refused connection fails instantly; now that the client
  # retries reads (worst case ~6.25s against a WEDGED bridge), an explicit
  # ceiling keeps boot non-blocking. A refused connection still fails in
  # milliseconds — bb-bridge deliberately does not retry ECONNREFUSED.
  #
  # `GHOLA_BRIDGE_TIMEOUT_MS=6000` is a CLIENT-SIDE CEILING, not a wait: bb-bridge
  # judges `/get-ticket` at its 87s retry-budget tier, which the outer `timeout 8`
  # would SIGTERM at 8s — killing the process before it could print its own
  # truthful `bridge-timeout` message, leaving an EMPTY stderr and sending this
  # probe to `unavailable` ("Jira had nothing") for a lookup nothing answered.
  # Overriding it to 6000 puts bb-bridge's deadline INSIDE the outer bound so the
  # marker always gets written. 6000-inside-8 clears with room to spare because
  # bb-bridge does NOT replay a deadline on this route (see `noReplayOnDeadline`
  # in bb-bridge.mjs) — one attempt, so the override IS the worst case. The
  # override changes nothing for a healthy call, which returns in well under a
  # second, and the boot budget is unchanged: the outer `timeout 8` still governs.
  : > "$bridge_err" 2>/dev/null
  tj="$(GHOLA_BRIDGE_TIMEOUT_MS=6000 timeout 8 node "$GHOLA_ROOT/scripts/bb-bridge.mjs" get-ticket --key "$key" 2>"$bridge_err")"
  if [ -n "$tj" ]; then
    parsed="$(printf '%s' "$tj" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);if(j&&j.exists===true){process.stdout.write("ok\t"+(j.status||"")+"\t"+(j.summary||""))}else{process.stdout.write("missing\t\t")}}catch(e){process.stdout.write("err\t\t")}})' 2>/dev/null)"
    st="${parsed%%$'\t'*}"; rest="${parsed#*$'\t'}"; ticket_status="${rest%%$'\t'*}"; ticket_summary="${rest#*$'\t'}"
    case "$st" in
      ok) ticket_state="ok"; printf 'TICKET %s — %s [%s]\n%s\n' "$key" "$ticket_summary" "$ticket_status" "$tj" >> "$detail" ;;
      missing) ticket_state="notfound" ;;
      *) ticket_state="unavailable" ;;
    esac
  else
    ticket_state="unavailable"
  fi
  # A bridge-level transport failure is its OWN state. Overriding last means an
  # unreachable bridge reports `bridge-down` (actionable: relaunch the session)
  # instead of hiding inside `unavailable`, which reads as "Jira had nothing"
  # and sends the operator to the wrong place.
  if bridge_down_last; then ticket_state="bridge-down"; fi
  # And a THROTTLED-but-healthy bridge is its own state again, checked after
  # `bridge_down_last` so the dead-transport verdict is never softened. `unavailable`
  # would read as "Jira answered and had nothing"; `bridge-down` would wrongly tell
  # the operator to relaunch. Neither is true here: we could not look, the bridge is
  # fine, and the ticket's existence is UNKNOWN.
  if bridge_slow_last; then ticket_state="bridge-slow"; fi
elif [ -n "$key" ]; then
  ticket_state="unavailable"
fi

# 7b. related PR via the bridge (best-effort, TIGHT timeout — boot never drags)
# Mirrors the ticket gate: a non-ticket mode (support, cd, self-upgrade) owns its
# own work surface, so it is a clean skip (pr_state=skipped, no bridge call). For
# a ticket-scoped session with a resolvable branch + repo, resolve the PR via the
# SAME bb-bridge path the ticket pull uses. The call is wrapped in `timeout 3` so
# a slow/unreachable bridge cannot stall boot; ANY failure (timeout, non-zero
# exit, empty/garbage output, missing slug) degrades to pr_state=na and the probe
# continues — matching its never-fail discipline. The find-pr JSON keys consumed
# are `status`, `prState`, `prId`, `prTitle`, `prUrl`, `prAuthor` (parsed with the
# same `node -e` tool the ticket pull uses).
pr_state="na"; pr_id=""; pr_title=""; pr_url=""; pr_author=""
if [ "$non_ticket_mode" = "yes" ]; then
  pr_state="skipped"
elif [ -n "$branch" ] && [ -n "$repo" ] && [ -n "$GHOLA_ROOT" ] && [ -f "$GHOLA_ROOT/scripts/bb-bridge.mjs" ]; then
  # Repo slug = origin's last path segment with any `.git` suffix stripped
  # (handles both git@host:workspace/repo.git and https://.../workspace/repo.git).
  pr_slug="$(git -C "$repo" remote get-url origin 2>/dev/null | sed -E 's#\.git$##; s#.*[/:]##')"
  if [ -n "$pr_slug" ]; then
    : > "$bridge_err" 2>/dev/null
    # `timeout 7` (was 3): the outer bound must exceed the CLIENT's own worst
    # case (2 * 3s read timeout + 250ms retry delay ~= 6.25s), otherwise a
    # WEDGED bridge gets SIGKILLed before bb-bridge can print its
    # `bridge-unreachable` marker and this probe reports pr_state=na — "we
    # looked and there is no PR" — for a bridge it never actually reached. That
    # is the exact silent-misreport this change exists to remove. The common
    # failure (bridge DOWN, connection refused) still returns in milliseconds
    # because bb-bridge deliberately does not retry ECONNREFUSED, so the extra
    # headroom is only ever spent on a genuinely hung host.
    #
    # `GHOLA_BRIDGE_TIMEOUT_MS=5000` is the same client-side CEILING the get-ticket
    # call above applies, for the same reason: bb-bridge judges `/find-pr` at its
    # 87s retry-budget tier (two upstream queries x the host's 41s retry budget),
    # so the outer `timeout 7` would SIGTERM it long before it could print its own
    # `bridge-timeout` message — and an empty stderr degrades to `pr_state=na`,
    # i.e. "we looked and there is no PR", about a lookup that was never answered.
    # 5000-inside-7 clears because bb-bridge does NOT replay a deadline on this
    # route, so one attempt at 5s is its whole worst case. A healthy find-pr is
    # unaffected (well under a second) and the boot budget is unchanged — the
    # outer `timeout 7` is still the bound.
    pj="$(GHOLA_BRIDGE_TIMEOUT_MS=5000 timeout 7 node "$GHOLA_ROOT/scripts/bb-bridge.mjs" find-pr --repo "$pr_slug" --branch "$branch" 2>"$bridge_err")"
    if [ -n "$pj" ]; then
      parsedpr="$(printf '%s' "$pj" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);let st="na",id="",ti="",ur="",au="";if(j&&j.status==="ok"){st=j.prState||"OPEN";id=(j.prId!=null?String(j.prId):"");ti=j.prTitle||"";ur=j.prUrl||"";au=j.prAuthor||""}else if(j&&j.status==="not-found"){st="none"}process.stdout.write(st+"\t"+id+"\t"+ti+"\t"+ur+"\t"+au)}catch(e){process.stdout.write("na\t\t\t\t")}})' 2>/dev/null)"
      if [ -n "$parsedpr" ]; then
        pr_state="${parsedpr%%$'\t'*}"; r="${parsedpr#*$'\t'}"
        pr_id="${r%%$'\t'*}"; r="${r#*$'\t'}"
        pr_title="${r%%$'\t'*}"; r="${r#*$'\t'}"
        pr_url="${r%%$'\t'*}"; pr_author="${r#*$'\t'}"
      fi
    fi
    # Same distinction as the ticket probe: a dead bridge is `bridge-down`, not
    # `na`. `na` means "we looked and there is no PR"; it must not double as
    # "we could not look".
    if bridge_down_last; then pr_state="bridge-down"; fi
    # Third verdict, checked after the dead-transport one so it can never soften
    # it. A throttled `find-pr` told us NOTHING about whether a PR exists, so it
    # must not land on `na` ("we looked, there is none") and must not land on
    # `bridge-down` (whose fix, relaunching, is wrong for a healthy bridge).
    if bridge_slow_last; then pr_state="bridge-slow"; fi
  fi
fi

# 8. vault + notes (READ-ONLY: probe never creates the notes file)
vault="${GHOLA_VAULT:-}"
if [ -z "$vault" ]; then
  # Fallback scan when Detect Vault never stored a path. This used to be a single
  # two-glob `for` and was WSL-only in two ways: the `/mnt/c/...` arm can never
  # match on native Windows, and `$USER` is normally UNSET under Git Bash (which
  # sets `USERNAME`), so that arm degraded to the literal
  # `/mnt/c/Users//Documents/Obsidian/*` — harmless only because this script has
  # no `set -u`. Candidates are now built into an ordered list so a missing input
  # DROPS its candidate instead of producing a nonsense glob.
  #
  # The first two entries are the original two, in the original order, so a WSL or
  # plain-Linux scan probes exactly what it always did. The windows-only entries
  # are appended after them and are unreachable off that platform. Any candidate
  # they resolve is still adopted only when it passes `-d` (unchanged), and the
  # canonicalization gate at 8b below puts it in `C:/...` form.
  vault_user="${USER:-${USERNAME:-}}"
  vault_roots=()
  [ -n "$vault_user" ] && vault_roots+=("/mnt/c/Users/${vault_user}/Documents/Obsidian")
  [ -n "$HOME" ] && vault_roots+=("$HOME/Documents/Obsidian")
  if [ "$shell_os" = "windows" ]; then
    # `%USERPROFILE%` is the authoritative Windows user-profile location and Git
    # Bash inherits it in `C:\...` form, so translate it (step 1 of translate_path
    # alone fixes the backslashes; a glob cannot match through `\`). `$HOME` above
    # is often the same directory in MSYS form — a duplicate candidate is harmless
    # because the first `-d` hit wins and both name the same folder.
    [ -n "$USERPROFILE" ] && vault_roots+=("$(translate_path "$USERPROFILE")/Documents/Obsidian")
    # Last resort when neither HOME nor USERPROFILE is usable: compose the
    # standard profile path from the username directly.
    [ -n "$vault_user" ] && vault_roots+=("C:/Users/${vault_user}/Documents/Obsidian")
  fi
  # Guarded expansion: an empty array is only safe to expand unquoted-in-a-loop on
  # newer bash, and this probe must never error on any host.
  if [ "${#vault_roots[@]}" -gt 0 ]; then
    for r in "${vault_roots[@]}"; do
      for c in "$r"/*; do
        [ -d "$c" ] && vault="$c" && break
      done
      [ -n "$vault" ] && break
    done
  fi
fi
# 8a. Platform-form repair for the resolved vault path — TRY THE STORED VALUE
# FIRST, ADOPT THE TRANSLATION ONLY IF IT EXISTS. The stored value is translated
# ONLY when it FAILS `-d`, and the translation is adopted ONLY when it PASSES
# `-d`. On a WSL session — i.e. every session that has ever run — the stored
# `/mnt/c/...` path passes `-d` on the first test, so this block does nothing and
# the digest is byte-identical: the change is a provable no-op there. If NEITHER
# form resolves we keep the stored value untouched, leave notes_exists=no, and
# say so via `vault_state=unresolved` rather than emitting a path we invented.
vault_translated=""; vault_state=""; vault_canonicalized=""
if [ -n "$vault" ] && [ ! -d "$vault" ]; then
  vt="$(translate_path "$vault")"
  if [ "$vt" != "$vault" ] && [ -d "$vt" ]; then
    # `vault_translated` carries the platform form we translated INTO (a token,
    # never a path — the resolved path is `vault` itself), and the consumer
    # contract in `modules/tool.session-bootstrap/session-bootstrap.md` declares
    # its vocabulary as `<windows|wsl>`. `unix` is REACHABLE here and must not be
    # emitted: the unix arm of `translate_path` performs no platform rewrite at
    # all, so the only way `vt` can differ from `vault` on that platform is step
    # 1's unconditional `\` -> `/` re-slash — i.e. a stored path spelled with
    # backslashes on a plain Linux/macOS host. That is a spelling repair, not a
    # translation INTO a platform form, so there is no honest token for it and the
    # field stays absent rather than inventing a third value the contract does not
    # define. The recovered path is still ADOPTED: discarding a vault that
    # resolves would be strictly worse than emitting one unexplained field fewer.
    vault="$vt"
    case "$shell_os" in windows|wsl) vault_translated="$shell_os" ;; esac
  else
    vault_state="unresolved"
  fi
fi
# 8b. Windows-only FORM CANONICALIZATION — a separate rule from 8a's recovery, and
# it fires on a path that ALREADY RESOLVES. Under Git Bash the 8a gate never runs
# for the commonest native-Windows case: `$HOME` is `/c/Users/<u>`, so the fallback
# scan (and a `$HOME`-derived stored setting) yields `/c/Users/<u>/Documents/...`,
# which PASSES `-d` in MSYS bash. 8a therefore sees a healthy path and leaves the
# MSYS form in place — and MSYS form is accepted by bash but REJECTED by the
# agent's Read/Write tools, which need `C:/...` or `C:\...`. That is the same class
# of silent failure 8a exists to prevent, reached by a different route, so the
# digest must not emit it.
#
# Gated on `[ -d "$vault" ]`, which makes it mutually exclusive with 8a's outcome:
# an unresolved vault is left exactly as 8a left it, and a path 8a already
# rewrote is already `C:/...` so `translate_path` returns it unchanged. The
# rewrite is still adopted only when it PASSES `-d`, so a form change can never
# turn a working path into a broken one. `shell_os` is checked first, so this
# block is unreachable — not merely inert — on wsl and unix.
#
# It sets `vault_canonicalized`, NOT `vault_translated`. The two facts are
# different and a consumer must be able to tell them apart: `vault_translated`
# means THE STORED SETTING WAS WRONG (it did not exist as stored and had to be
# recovered), which is worth surfacing to the operator; canonicalization means the
# setting was fine and only its spelling changed. Reusing `vault_translated` here
# would report a healthy Windows session as a misconfigured one on every boot.
if [ "$shell_os" = "windows" ] && [ -n "$vault" ] && [ -d "$vault" ]; then
  vc="$(translate_path "$vault")"
  if [ "$vc" != "$vault" ] && [ -d "$vc" ]; then
    vault="$vc"; vault_canonicalized="$shell_os"
  fi
fi
notes_exists="no"; notes_file=""; handoff_date=""
# The ticket-notes lookup is gated on mode: in a non-ticket mode (support, cd)
# the session-mode module owns its own work surface (Support/<APP>.md,
# Projects/<basename>.md), so the probe does not guess a ticket-notes path —
# it still resolves and emits `vault` above (mode-agnostic), but leaves
# notes_exists=no / notes_file=none.
if [ "$non_ticket_mode" != "yes" ] && [ -n "$vault" ] && [ -n "$key" ]; then
  proj="${key%%-*}"; num="${key##*-}"
  notes_file="$vault/$proj/$num.md"
  if [ -f "$notes_file" ]; then
    notes_exists="yes"
    # CLAUDE.md rule 7: capture each producer's output first, then slice the
    # variable with `tail`, so this stays correct if `set -o pipefail` is ever
    # added to this file. `_handoffs` empty -> handoff_date stays "" (matches
    # the original's empty-in/empty-out); `_handoff_block` empty -> the `tail`
    # call is skipped entirely so no phantom blank line is written to `detail`.
    _handoffs="$(grep -oE '## Session Handoff \(([^)]+)\)' "$notes_file" 2>/dev/null)"
    [ -n "$_handoffs" ] && handoff_date="$(tail -1 <<<"$_handoffs" | sed -E 's/.*\(([^)]+)\).*/\1/')"
    _handoff_block="$(awk '/^## Session Handoff/{p=1} p' "$notes_file" 2>/dev/null)"
    {
      echo "----- NOTES HANDOFF ($notes_file) -----"
      [ -n "$_handoff_block" ] && tail -60 <<<"$_handoff_block"
    } >> "$detail"
  fi
fi

# digest
emit version "$version"
emit now "$now"
emit session_mode "${mode_session:-unconstrained}"
emit env_state "$env_state"; [ -n "$missing" ] && emit env_missing "$missing"
# Emitted UNCONDITIONALLY and grouped with the environment fields, because the
# `environment` step is what renders it (see block 2b for the vocabulary and for
# why this field cannot use the absent-means-healthy convention `bridge_state`,
# `vault_translated`, `vault_canonicalized`, `vault_state` and `detail_file_form`
# all follow). `ok` is the healthy value and the module renders NO line for it, so
# a healthy boot trace is unchanged even though the digest gained a line.
emit statusline_health "$statusline_health"
emit team "${perf}p/${eff}e/${qa}qa"
emit team_models "perf=${pm},eff=${em},qa=${qm}"
emit work_repo "${repo:-none}"
[ -n "$self_upgrade_repo" ] && emit self_upgrade_repo "$self_upgrade_repo"
emit branch "${branch:-none}"
emit mode "$mode"; [ -n "$base" ] && emit base "$base"; [ -n "$ahead" ] && emit ahead "$ahead"
emit ticket_key "${key:-none}"
emit ticket_state "$ticket_state"
# Emitted ONLY when a bridge call actually failed at the transport level, so the
# digest's shape is unchanged for every healthy session. Its presence is the
# banner's cue to explain the bridge rather than silently reporting no ticket and
# no PR. TWO values, with OPPOSITE remedies — a consumer must not treat the mere
# presence of this field as "the bridge is down":
#   down          — the transport is dead (`bridge-unreachable`/`bridge-unavailable`).
#                   Say "the Ghola bridge is down — relaunch the session".
#   upstream-slow — the bridge is ALIVE and healthy; the upstream (Jira/Bitbucket)
#                   is throttling it and it is deliberately backing off, so the
#                   lookup went UNANSWERED. Do NOT advise a relaunch (it fixes
#                   nothing and discards session context) and do NOT report the
#                   ticket or PR as absent — nothing was ruled out.
# `down` wins when both occur in one boot; see `bridge_slow_last`.
[ -n "$bridge_state" ] && emit bridge_state "$bridge_state"
[ -n "$ticket_status" ] && emit ticket_status "$ticket_status"
[ -n "$ticket_summary" ] && emit ticket_summary "$ticket_summary"
emit pr_state "$pr_state"
[ -n "$pr_id" ] && emit pr_id "$pr_id"
[ -n "$pr_title" ] && emit pr_title "$pr_title"
[ -n "$pr_url" ] && emit pr_url "$pr_url"
[ -n "$pr_author" ] && emit pr_author "$pr_author"
emit vault "${vault:-none}"
# Both fields follow the `bridge_state` precedent above: emitted ONLY when the
# abnormal condition actually occurred, so the digest's shape is unchanged for
# every healthy session. `vault_translated=<windows|wsl>` says the stored vault
# path did not exist in the form it was stored and was rewritten into that
# platform's form (the rewritten path IS `vault`); `vault_state=unresolved` says
# neither form exists, so `vault` is the unusable stored value and every
# notes/handoff field below is absent for that reason and not because the ticket
# is new. `vault_translated` is constrained at block 8a to exactly the two tokens
# the module contract documents — it never carries `unix`; see the note there.
# `vault_canonicalized=windows` is the THIRD such field and follows the same
# emitted-only-when-abnormal rule: it says the vault path resolved fine but was in
# MSYS `/c/...` form and has been respelled as `C:/...` so the agent's Read/Write
# tools can open it. It is NOT a misconfiguration signal — unlike
# `vault_translated`, the stored setting was correct — so a consumer should render
# the notes line entirely normally and, at most, explain why the path shown differs
# from the setting. It never appears on wsl or unix.
[ -n "$vault_translated" ] && emit vault_translated "$vault_translated"
[ -n "$vault_canonicalized" ] && emit vault_canonicalized "$vault_canonicalized"
[ -n "$vault_state" ] && emit vault_state "$vault_state"
emit notes_file "${notes_file:-none}"
emit notes_exists "$notes_exists"
[ -n "$handoff_date" ] && emit handoff_date "$handoff_date"
emit detail_file "$detail"
# Emitted ONLY when the detail file's path could not be put in a form the reader is
# known to accept — i.e. a native-Windows session where no `%TEMP%`-derived
# directory could be confirmed, leaving an MSYS `/tmp/...` path that a Win32-API
# Read may not be able to open. Absent everywhere else, so the digest's shape is
# unchanged for wsl, unix, and a healthy Windows session. A consumer seeing it
# should treat a failed detail read as EXPECTED (and say the handoff block could
# not be read) rather than concluding there was no handoff.
[ -n "$detail_form" ] && emit detail_file_form "$detail_form"

# Explicit success. This probe must NEVER report failure, and without this line the
# script's exit status is whatever the LAST conditional emit evaluated to: an
# ABSENT optional field (`[ -n "" ]` -> 1) would make a perfectly healthy boot look
# like a failed command to the caller. Any future trailing `[ ... ] && emit` has the
# same hazard, so the guard belongs here rather than in the emit order.
exit 0
