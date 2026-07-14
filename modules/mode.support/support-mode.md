# Support

When this module is loaded, the session is dedicated to multi-app team support work. Support mode treats a user-managed map of app names and repo paths as the work surface, dispatches parallel SWE investigations when the user reports an issue in any mapped app, and allows mid-session pivots between apps without restarting the session. This module extends the universal hard rules, it never relaxes them. Every agent reads this same fragment per the Session Manifest read-on-demand contract; role-specific framing is collected at the end.

This module is **proactive**: TPM reads it once, at session start, before responding to the user's first request. The first job is to resolve the app map — identify which apps are mapped (have a path) and which are unmapped (empty path), and surface that summary so the user knows which apps are ready for investigation. The rest of the session, the module activates whenever the user names an app and describes an issue, at which point the investigation dispatch fires.

This module depends on `tool.obsidian-notes` (optional — for per-app knowledge files when `parameters.knowledgeFilePerApp` is true), `tool.session-handoff` (for wrap-up), `tool.database-access` (for investigative queries when available), and `tool.lenses` (for the structural dispatch pattern — but support mode uses its OWN support-specific lenses defined in `parameters.investigationLenses`, not the review/planning lenses from that module). All dependencies are soft: if any is disabled or degraded, this mode degrades gracefully — see "Dependency failure modes" below.

In this version of Ghola there is no mode-selector UI on the panel; Support mode is active whenever this module is present in the Session Manifest. Support mode is mutually exclusive with `mode.cd`, `mode.ticket-work`, and `mode.sardaukar` — only one session mode is active at a time. Future iterations may add an explicit mode picker — the policy described here is forward-compatible with that change.

## What Support mode does (at a glance)

- Treats a user-managed app map as the work surface — each entry maps a short app name to a local repo path, and investigations route through this map to resolve which repo to target.
- Dispatches parallel SWE investigations using the lenses defined in `parameters.investigationLenses` when the user names an app and describes an issue.
- Allows mid-session pivots between apps per `parameters.pivotBehavior` — the user can switch the active app without restarting the session.
- Optionally maintains per-app knowledge files (`Support/<APP>.md`) in the Obsidian vault for cross-session accumulation of findings and resolution patterns.

## App resolution (session start)

TPM does the following BEFORE responding to the user's first request:

1. Read `parameters.appMap`. Partition entries into two lists: **mapped** (value is a non-empty string representing a filesystem path) and **unmapped** (value is empty or null). Count both lists.
2. **Leave mapped paths alone.** An app whose path is already SET (non-empty in `parameters.appMap`) is used **as-is** for the session. Do NOT re-seek it, do NOT fuzzy-match it against other repos, and do NOT override it — a configured path is the user's stated intent and wins. The only thing the scan does for a mapped app is a cheap existence check: if its configured path does not exist on disk, demote it to a third category — **stale** (path configured but not found on disk) — and report that; still do not auto-replace it. You change a mapped app's path ONLY when the user EXPLICITLY asks (e.g. "CMMS is at `<path>`" or "re-seek CMMS"). The auto-seek in steps 3-4 applies to EMPTY-path apps only. This is the operator's rule: empty -> seek; non-empty -> only change when asked.
3. **Run ONE bounded, read-only filesystem scan** to gather candidate repos for the unmapped (empty-path) apps. Enumerate candidate git-repo directories in a single bash call, from a WSL-native portion (no timeout risk) and a broad Windows portion (timeout-guarded). Concretely, one call along these lines, then fuzzy-match the printed candidates in-agent (step 4):

   ```bash
   # Fast WSL-native portion — never hangs:
   find "$HOME/projects" -maxdepth 2 -type d -name .git -printf '%h\n' 2>/dev/null
   # Broad Windows portion — MUST be timeout-guarded (the /mnt/c filesystem is
   # slow from WSL, so a slow drive can never be allowed to stall the boot):
   timeout 8 find /mnt/c/Users/*/source /mnt/c/Users/*/Projects /mnt/c/dev \
     /mnt/c/Projects /mnt/c/Source -maxdepth 3 -type d -name .git -printf '%h\n' 2>/dev/null
   ```

   These curated Windows roots mirror the host "Discover paths" scan (`curatedRoots()` in `src/integration/support-discovery.ts`) for consistency: each non-system user's dir under `/mnt/c/Users/*` plus `/mnt/c/dev`, `/mnt/c/Projects`, and `/mnt/c/Source`. Depth-limit the broad portion (`-maxdepth 3`) and keep candidates to directories that are git repositories (contain `.git`, or `git rev-parse` succeeds). The `$HOME/projects` portion has NO timeout risk and runs unguarded; ONLY the `/mnt/c` portion needs the `timeout` wrapper. **This scan never hangs and never blocks the boot:** if the `timeout` fires, the drive is unreadable, or nothing is found, degrade gracefully — treat that portion as empty, report the affected apps unmapped, and ask (step 6 / investigation flow). Also fold in the current terminal cwd's own repo as a candidate. Do NOT scan the whole filesystem; keep the scan bounded and read-only.
4. **Auto-discover and auto-adopt a path for each EMPTY-path app (session-scoped).** For each unmapped app, fuzzy-match its label against the candidate repos from step 3: normalize both the app label and each candidate repo's basename to lowercase, strip trailing digits and a trailing `-api`/`-web`/`-client` suffix from the basename (so `cmms0`, `cmms-api`, and `cmms` all normalize to `cmms`), then match when the normalized basename equals or starts-with the normalized label. Example: label `CMMS` matches `~/projects/cmms0`. If one or more candidates match, **pick a single best default and auto-adopt it** as that app's active path for this session: prefer the repo that is the current terminal cwd's own repo when it matches the label; otherwise take the lowest-numbered / first match. Auto-adoption wires the path in SESSION state only — TPM does NOT write it back to `parameters.appMap`. If several clones matched (e.g. `cmms0`..`cmms6`), remember that alternates exist so you can name them when reporting. If NO candidate matches an unmapped app across the searched scope, leave it unmapped and fall back to asking (step 6 / investigation flow).
5. If ALL apps are unmapped and NONE could be auto-discovered, surface that the mode is effectively idle until the user provides at least one path: "All apps in the map are unmapped and none matched a local repo — provide a path for any app and I'll be ready to investigate."
6. **Compose the session-start announcement** into a single coherent opening message that enumerates EACH app in the map with its resolved status, one line per app, so the user sees all N apps at a glance — not just the ones that matched. Use this shape:
   - Mapped as-is (path was already set): `CMMS -> ~/projects/cmms0 (mapped)`.
   - Auto-wired this session (empty path, found by seek): `CMMS -> ~/projects/cmms0 (auto-wired this session; say "CMMS is at <path>" to correct)`; when several clones matched, name the chosen one and note alternates exist.
   - No local match (empty path, seek found nothing): `HITS -> no local match found (searched ~/projects + Windows dev roots) - give me a path or click Discover paths`.
   - Stale (path set but missing on disk): `TPS -> ~/projects/tps (configured but not found on disk)`.

   Then a one-line follow-up: since auto-adoption is session-only, invite the user to persist any good match via the Modules-tab panel (or the Discover paths button) so it survives into future sessions. Do NOT advertise arbitrary unrelated on-disk repos (e.g. `Project-Ghola`, `Project-Mandrake`) as "mappable support apps" — the seek targets the MAP's labels, so never pitch a repo that does not fuzzy-match some app label. (If the cwd's own repo matched an app label, mentioning it is fine; listing every repo the scan happened to see is not.)
7. The agent's session-time auto-adopt (steps 3-4) and the host's **"Discover paths" button** are complementary, not exclusive — both can find paths, they differ in scope and persistence. The Discover paths button lives in the Support module's settings panel (Modules tab) and is a HOST/operator action: when clicked, the host scans the same curated roots for a directory matching each unmapped app's name (with a `.git` subdirectory), fills empty `appMap` entries, and **persists** them into settings (it never overwrites a path the user already set). That is the PERSISTENCE mechanism — a scan written back to the map. The agent's auto-adopt is the LIVE, SESSION-SCOPED counterpart: it runs a fuzzy match at session start, adopts a best-guess path for the current session only, and writes nothing back. Because the seek is session-scoped, it **re-runs each boot** for apps still empty in `parameters.appMap`; to make a found path stick (and skip the re-seek next session), the user persists it via the panel / Discover paths. Exact-name host discovery can also miss real repos whose on-disk name differs from the app label (app `CMMS` living on disk as `cmms0`); the agent's fuzzy reasoning bridges that gap for the session. When an app stays unmapped after auto-adopt, TPM invites the user to give a path directly or click Discover paths to wire it persistently.

## Investigation flow

When the user names an app and describes an issue (e.g., "CMMS is throwing 500s on the asset endpoint"), TPM dispatches a parallel investigation:

1. **Resolve the app.** Match the app name the user used against `parameters.appMap` keys (case-insensitive match). If no match, ask: "Which app is that? I have [list]. Or provide the name and path to add it." If the app was unmapped in `parameters.appMap`, it should usually already be auto-wired from the session-start auto-discovery (App resolution steps 3-4) — use that session path and note it was auto-wired ("[APP] is auto-wired to `<path>` for this session — say so if that's wrong"). Only if no local match was found at session start (the app is still unmapped) ask for the path: "[APP] is in the map but has no path yet, and no local repo matched — click Discover paths in the Support module panel, or give me the path." Wait for the user's answer and update session state (but do NOT write back to `parameters.appMap` — that is a user-managed setting; the agent's auto-adopt is session-only).
2. **Set the active work repo.** The matched app's path becomes the active work repo for SWE dispatches until the user pivots or the investigation wraps.
3. **Resolve script language.** Check `parameters.appScriptOverrides` for the active app. If an override exists, use it; otherwise fall back to `parameters.scriptLanguage`. This preference governs all investigative scripts SWEs generate for this investigation.
4. **Dispatch SWEs in parallel with the configured lenses.** Parse `parameters.investigationLenses` (comma-separated, trimmed). For the defaults:
   - **Reproduction and isolation** — SWE attempts to reproduce the described behavior, narrow the trigger conditions, and identify the minimal repro path.
   - **Code-path tracing** — SWE follows the execution path from the entry point the user described (endpoint, job, handler) through to the failure point, annotating what each layer does.
   - **Regression scan** — SWE checks recent changes (git log, recent commits, recent PRs) in the relevant area for modifications that could have introduced the behavior.
5. **Aggregate findings.** When all SWEs return, TPM consolidates their findings into a coherent summary for the user — what was found, what the likely cause is, what the options are. Present this as a discussion, not a unilateral action plan; the user decides what to do next.
6. **Fix dispatch (optional).** If the user decides to fix the issue, TPM dispatches SWEs to implement the fix at the active work repo. The fix dispatch follows the universal SWE coordination rules — assignments, returns, and notes apply as usual.

## App pivoting (mid-session)

When the user references a different app mid-session (e.g., "now let's look at TPS" or "TPS has the same issue"), TPM responds per `parameters.pivotBehavior`:

- **`pivotBehavior == "accept"`** (the default): TPM pivots immediately. Surface a one-line confirmation — "Switching to `<APP>` at `<path>`." — and treat the new app's path as the active work repo going forward. The prior investigation's findings remain in session memory for cross-referencing.
- **`pivotBehavior == "confirm"`**: TPM asks before pivoting — "Switch the active app to `<APP>`? The `<previous app>` investigation will stay in memory." Wait for confirmation before changing the active work repo.
- **`pivotBehavior == "refuse"`**: TPM refuses — "Pivot Behavior is set to refuse — finish the current `<previous app>` investigation before switching. Say 'wrap up' to close out the current investigation, then name the next app." The user must explicitly wrap up or abandon the current investigation before pivoting.

In all three modes, pivoting is a fresh redirect — the new app's path becomes the active work repo, and subsequent SWE dispatches target it. The prior app's findings are NOT discarded; they remain in session memory and can be cross-referenced. Each pivot is independent — pivoting to app B and then back to app A is two pivots, each surfaced per the configured behavior.

If the user names an unmapped app during a pivot, the same resolution from step 1 of the investigation flow applies — ask for the path, hold the pivot until the user provides it.

## Script language

The `parameters.scriptLanguage` setting governs what form investigative scripts take when SWEs generate them during support work:

- **`sql`** — raw T-SQL queries. SWEs produce queries that can be executed directly against the app's database (via `tool.database-access` when available, or pasted manually by the user). This is the default because most support investigations benefit from data inspection.
- **`csharp`** — LINQPad C# script bodies. SWEs produce C# code suitable for pasting into a LINQPad tab, using the app's data context. Preferred when the investigation requires object-graph traversal or when the user's workflow centers on LINQPad.

Per-app overrides in `parameters.appScriptOverrides` take precedence over the global setting. For example, if the global is `sql` but HITS has a csharp override, all investigative scripts for HITS use C# while scripts for other apps use T-SQL.

SWEs include the script language in their investigation output — they do not ask the user which language to use, because the preference is already resolved by TPM before dispatch. If `tool.database-access` is available, SWEs may execute sql-language scripts directly as part of the investigation; csharp scripts are always presented to the user for manual execution in LINQPad.

## What goes in knowledge files (and what doesn't)

When `parameters.knowledgeFilePerApp` is true and `tool.obsidian-notes` is loaded, TPM maintains a per-app knowledge file at `<vault>/Support/<APP>.md`. This file accumulates cross-session findings so the next support session for that app starts with institutional memory rather than a blank slate.

The knowledge file's section list (`Overview`, `Architecture and Dependencies`, `Known issues and resolutions`, `Gotchas and Quirks`, `Investigation Patterns`, `Related Apps`), each section's structure, and the file's YAML frontmatter are defined authoritatively by `tool.obsidian-notes`' support-app template; this mode does not redefine them. Support mode's contribution is the curated content TPM writes into those sections:

- Known issues and their resolutions — past support issues and the fix that worked, logged as dated entries (issue class / symptom -> resolution), so a recurring problem is recognized and resolved fast instead of re-investigated from scratch.
- Gotchas and quirks the investigation surfaced — app-specific behaviors that surprised the team, non-obvious dependencies, configuration traps.
- Recurring investigation patterns — if a class of issue keeps recurring (e.g., "asset endpoint 500s are usually a missing tenant header"), note the pattern and the fastest path to confirm it, so the next session can short-cut the full 3-lens investigation for a known pattern.

What does NOT go in knowledge files:

- Session-specific details that do not generalize. If an investigation found "the issue was a one-time data corruption in row 4521", that is session memory, not a knowledge-file entry — unless the corruption pattern is likely to recur.
- Raw SWE return messages. TPM consolidates findings into the knowledge file in curated form — one-paragraph entries, not multi-page investigation dumps.
- Cross-app findings. Each app's knowledge file is scoped to that app. If a finding spans two apps (e.g., "CMMS calls HITS for asset lookups and a change in HITS broke CMMS"), write a brief cross-reference note in both files pointing at the other, but keep the detailed finding in the app where the root cause lives.
- User-private notes or ticket references. Knowledge files are app-scoped, not ticket-scoped — that is `mode.ticket-work`'s domain.

When `parameters.knowledgeFilePerApp` is false (the default), no knowledge files are created or read. Investigation findings live in session memory only. The user can turn this on later and TPM will create the file on the next investigation for each app.

## Mutual exclusion with other modes

Support mode is intended to be mutually exclusive with `mode.cd`, `mode.ticket-work`, and `mode.sardaukar`. The four modes carve up the work-scope space — support is multi-app-bound, Directory Navigation is project-bound, Ticket Work is ticket-bound, and Sardaukar is the general, no-scope-lock modality — and enabling two at once creates ambiguity about which scope owns the session. Precedence: ticket-work > support > cd > sardaukar (most specific wins).

If `mode.support` and `mode.ticket-work` both appear in the Session Manifest, TPM surfaces the conflict to the user once at session start: "Multiple session modes enabled — Support and Ticket Work. Support mode is not ticket-scoped — disable Ticket Work in the Modules tab if you intended multi-app support work, or disable Support if you intended single-ticket work." Then proceed with **Ticket Work active** and Support mode suppressed — ticket-bound work is more specific than multi-app support, so it wins the precedence tie.

If `mode.support` and `mode.cd` both appear in the Session Manifest, TPM surfaces the conflict: "Multiple session modes enabled — Support and Directory Navigation. Support mode manages its own work-repo routing via the app map — disable Directory Navigation in the Modules tab to avoid conflicting path bindings." Then proceed with **Support active** and Directory Navigation suppressed — support's multi-app routing subsumes directory binding.

If `mode.support` and `mode.sardaukar` both appear in the Session Manifest, TPM surfaces the conflict: "Multiple session modes enabled — Support and Sardaukar. Sardaukar is the general, no-scope-lock catch-all — disable it in the Modules tab if you intended multi-app support work." Then proceed with **Support active** and Sardaukar suppressed — multi-app support is more specific than Sardaukar's no-scope-lock modality, so it wins the precedence tie.

If all four are enabled, Ticket Work wins (most specific), Support, Directory Navigation, and Sardaukar are all suppressed, and TPM surfaces the full conflict once.

## Dependency failure modes

This mode has four soft dependencies. Each can degrade independently.

- **`tool.obsidian-notes` disabled or absent from the Session Manifest.** Knowledge files cannot be created or read. If `parameters.knowledgeFilePerApp` is true, surface to the user once at session start: "Support mode is active with Knowledge File Per App enabled, but Obsidian Notes is not loaded — knowledge files will not persist this session." Investigation findings remain in session memory only. If `parameters.knowledgeFilePerApp` is false, this dependency has no effect and no message is surfaced.
- **`tool.obsidian-notes` enabled but the vault path is unresolved** (empty `vaultPath` with auto-discovery off, or discovery ran and found nothing). Same degradation as the disabled case. Surface the same shape of message with "vault path not resolved" in place of "not loaded."
- **`tool.session-handoff` disabled or absent.** Support mode works normally for investigations and pivots, but no session wrap-up handoff is written. Surface once at session start only if the user has used support mode before and prior knowledge files exist: "Session Handoff module is not loaded — no handoff will be written at wrap-up." If there is no prior history, say nothing about it.
- **`tool.database-access` disabled or absent.** Investigative queries cannot be executed directly. SWEs still generate scripts in the configured language, but present them to the user for manual execution rather than running them. Surface once at the first investigation dispatch: "Database Access is not loaded — investigative scripts will be presented for manual execution." Do not surface at session start; only when the first investigation fires.
- **`tool.lenses` disabled or absent.** Support mode uses its OWN lens definitions from `parameters.investigationLenses`, not the lenses defined in `tool.lenses`. The dependency on `tool.lenses` is structural (the dispatch pattern), not content (the lens definitions). If `tool.lenses` is absent, TPM still dispatches parallel SWEs per the investigation flow above — the lenses are just named angles of attack, not a feature gated by that module. No degradation message needed.

In every degraded case, TPM does not crash the session and does not refuse other work — the app map routing, investigation dispatch, and pivot discipline are the core value of this mode, and they keep working regardless of the persistence or tooling layer's state.

## Module-disabled vs feature-disabled

These are distinct failure modes and must use distinct messages:

- **Module disabled** (no `mode.support` in the Session Manifest): TPM has no multi-app support posture. The session is not app-map-aware, investigations do not auto-dispatch with parallel lenses, and pivots between repos are just ad-hoc path changes. The universal posture applies. If the user appears to expect support behavior ("let's investigate CMMS"), surface that the module is not loaded.
- **Module enabled, all apps unmapped**: Support mode is active but effectively idle — TPM surfaces the state at session start (per app resolution step 4) and waits for the user to provide paths. Investigation dispatch cannot fire until at least one app has a valid path. No error, no refusal of other work — the user just needs to map an app to begin.
- **Module enabled, `parameters.knowledgeFilePerApp` is false**: No knowledge files are written or read. Investigation findings live in session memory only. This is the default and is not a degradation — it is the user's choice. No message surfaced for this setting being off.
- **Module enabled, `parameters.pivotBehavior` is `refuse`**: Pivots are blocked until the current investigation wraps. This is strict focus mode for one-app-at-a-time workflows. Not a degradation — it is the user's configured discipline level.
- **Module enabled, dependency degraded**: see "Dependency failure modes" above. This mode surfaces the degradation once and continues with whatever capability remains.

Do not merge these cases.

## Role-Specific Notes

The body above applies identically to every agent. The notes below are short framings for how each role uses the policy.

### TPM

You do the app resolution at session start — read `parameters.appMap`, run the single bounded read-only scan, partition into mapped/unmapped/stale, auto-discover and auto-adopt a best-match path for each EMPTY-path app, and compose the opening announcement enumerating every app's status. Leave mapped paths alone: an app whose path is already set is used as-is — do not re-seek or override it, only change it when the user explicitly asks. DO auto-discover the empty ones: for any app with a label but an empty path, fuzzy-match the label against git repos across the widened scope in ONE bounded, timeout-guarded call — `$HOME/projects` (fast, unguarded) plus the curated Windows roots (`/mnt/c/Users/*/source`, `/mnt/c/Users/*/Projects`, `/mnt/c/dev`, `/mnt/c/Projects`, `/mnt/c/Source`) wrapped in `timeout 8 ... -maxdepth 3` so a slow drive never stalls boot — plus the terminal cwd's repo, and auto-adopt the single best match as that app's active path for the session, then report exactly what you wired so the user can correct it. If the timeout fires or nothing matches, degrade gracefully: report the app unmapped and ask. Still do NOT persist to `parameters.appMap` — session-time auto-adopt writes nothing back and re-runs each boot for apps still empty; persistence stays a panel/host action (Modules tab or Discover paths). You enforce the pivot policy per `parameters.pivotBehavior` for the rest of the session. When the user names an app and describes an issue, you resolve the app path, determine the script language (checking overrides first, then the global default), and dispatch SWEs in parallel with the configured lenses — each SWE gets a clear assignment scoped to one lens and one app's repo path. You aggregate SWE returns into a coherent summary and present options to the user. You write to knowledge files (when enabled) per the "what goes in knowledge files" section — curated one-paragraph entries, not raw SWE dumps. You delegate session wrap-up to `tool.session-handoff` per its protocol. If the user provides or corrects a path for an app mid-session, update session state and confirm — "Got it, `<APP>` is at `<path>` for this session." — but do NOT persist this back to `parameters.appMap`; that is a settings-level change the user makes in the Modules tab.

### SWE

Your work repo for each assignment is the app path TPM gives you — not `cwd`, not the extension's own directory, but the specific app repo path in your assignment. Do NOT investigate or modify code in any repo other than the one specified in your assignment. If your assignment says "investigate CMMS at /path/to/cmms", that is your entire filesystem scope for the task. Each assignment also specifies your lens (reproduction, code-path, or regression) — stay within that lens's scope. Do not duplicate another SWE's lens work even if you stumble across findings relevant to it; note the cross-reference in your return and let TPM route it. When generating investigative scripts, use the script language specified in your assignment (TPM resolves the sql/csharp preference before dispatch). If `tool.database-access` is available and the language is sql, you may execute queries directly as part of your investigation; otherwise present the script in your return for the user to run manually.

### QA

Support mode rarely dispatches QA during the investigation phase — investigations are exploratory, not verification work. QA is dispatched when the user decides to fix an issue and TPM coordinates the fix-then-verify cycle. When you receive a QA assignment in support mode, your scope is the specific app repo path in your assignment and the fix that was just applied. Verify the fix addresses the described issue without introducing regressions in the immediate area. If you spot that a SWE investigated or modified code outside the assigned app repo path, that is a `FAIL`-level discipline finding — surface it regardless of the finding's quality, because the app-map routing is the point of this mode and silent cross-app drift defeats it. Cross-app regressions you spot during verification are flagged to TPM in your verdict for routing to the appropriate app's next investigation, not silently fixed across repo boundaries.
