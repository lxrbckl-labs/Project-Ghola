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
# Env consumed (exported by the launcher): GHOLA_VERSION, GHOLA_BRANCH,
# GHOLA_ROOT, GHOLA_TPM_PROMPT_FILE, GHOLA_SWE_PROMPT_FILE, GHOLA_QA_PROMPT_FILE,
# SWE_PERFORMANCE_CORES, SWE_EFFICIENCY_CORES, QA_AGENT_COUNT,
# SWE_PERFORMANCE_MODEL, SWE_EFFICIENCY_MODEL, QA_MODEL, and optional GHOLA_VAULT.
#
# STRICTLY READ-ONLY except for its own temp `detail` file under /tmp. It never
# writes to the work repo or the Obsidian vault — note-file creation and any
# vault writes remain TPM's job via the obsidian-notes module, AFTER this probe.

emit() { printf '%s=%s\n' "$1" "$2"; }

detail="$(mktemp 2>/dev/null || echo /tmp/ghola-boot-detail.txt)"
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
[ -n "$branch" ] && key="$(printf '%s' "$branch" | grep -oiE '[A-Z][A-Z0-9]+-[0-9]+' | head -1 | tr 'a-z' 'A-Z')"
ticket_state="none"; ticket_status=""; ticket_summary=""
if [ "$non_ticket_mode" = "yes" ]; then
  ticket_state="skipped"
elif [ -n "$key" ] && [ -n "$GHOLA_ROOT" ] && [ -f "$GHOLA_ROOT/scripts/bb-bridge.mjs" ]; then
  tj="$(node "$GHOLA_ROOT/scripts/bb-bridge.mjs" get-ticket --key "$key" 2>/dev/null)"
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
elif [ -n "$key" ]; then
  ticket_state="unavailable"
fi

# 8. vault + notes (READ-ONLY: probe never creates the notes file)
vault="${GHOLA_VAULT:-}"
if [ -z "$vault" ]; then
  for c in "/mnt/c/Users/${USER}/Documents/Obsidian"/* "$HOME/Documents/Obsidian"/*; do
    [ -d "$c" ] && vault="$c" && break
  done
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
    handoff_date="$(grep -oE '## Session Handoff \(([^)]+)\)' "$notes_file" 2>/dev/null | tail -1 | sed -E 's/.*\(([^)]+)\).*/\1/')"
    { echo "----- NOTES HANDOFF ($notes_file) -----"; awk '/^## Session Handoff/{p=1} p' "$notes_file" 2>/dev/null | tail -60; } >> "$detail"
  fi
fi

# digest
emit version "$version"
emit now "$now"
emit session_mode "${mode_session:-unconstrained}"
emit env_state "$env_state"; [ -n "$missing" ] && emit env_missing "$missing"
emit team "${perf}p/${eff}e/${qa}qa"
emit team_models "perf=${pm},eff=${em},qa=${qm}"
emit work_repo "${repo:-none}"
[ -n "$self_upgrade_repo" ] && emit self_upgrade_repo "$self_upgrade_repo"
emit branch "${branch:-none}"
emit mode "$mode"; [ -n "$base" ] && emit base "$base"; [ -n "$ahead" ] && emit ahead "$ahead"
emit ticket_key "${key:-none}"
emit ticket_state "$ticket_state"
[ -n "$ticket_status" ] && emit ticket_status "$ticket_status"
[ -n "$ticket_summary" ] && emit ticket_summary "$ticket_summary"
emit vault "${vault:-none}"
emit notes_file "${notes_file:-none}"
emit notes_exists "$notes_exists"
[ -n "$handoff_date" ] && emit handoff_date "$handoff_date"
emit detail_file "$detail"
