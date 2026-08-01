# Team Switchboard

When this module is loaded, the session participates in a shared cross-team communication layer via a set of Obsidian markdown files. Team Switchboard maintains a roster of active teams and routes directed messages and broadcasts through per-team inbox files. This module is **on-demand**: TPM does NOT read or act on it automatically at session start. Do not heartbeat, register, or check mail automatically at session start. The module only activates when the operator explicitly asks about cross-team comms — e.g. asks to check mail, check the inbox, look at the roster, send a message to another team, heartbeat/register this team's presence, or look up which team owns a given focus area. When one of those requests comes in, TPM reads this module and performs the relevant procedure below.

## Reading parameters

Locate this module's entry in the Session Manifest. Its `parameters` object may appear as `(defaults)`, be absent entirely, or be a live JSON object.

- If the entry shows `(defaults)` or a parameter key is absent, the default for that parameter applies. Defaults: `commsRoot` = `""` (derive at runtime), `staleAfterDays` = `14`, `checkInboxOnBoot` = `false`, `heartbeatOnBoot` = `false`, `handledMessageRetentionDays` = `3`, `detectParentProject` = `true`, `mergeDeadChildren` = `true`. There is no automatic session-start run — `checkInboxOnBoot` and `heartbeatOnBoot` only matter once the operator has already asked for an on-demand switchboard check; they control whether that on-demand check includes the inbox summary / roster heartbeat, not whether anything happens at session start.
- If `parameters` is a live object, read each key present and fall back to the documented default for any key that is missing.

### Resolving `commsRoot`

`parameters.commsRoot` is the absolute path to the shared `_AgentComms/` directory.

- Non-empty string: use it verbatim as the comms root. Verify it exists (or bootstrap it — see "Self-heal / bootstrap" below).
- Empty string or absent: derive `<obsidian-vault-root>/_AgentComms/`. Resolve the vault root from the same two sources `tool.cwd-discipline` seeds its vault exception on, in this order and stopping at the first that yields a value: `tool.obsidian-notes`' `parameters.vaultPath` in your Session Manifest — the authority for where the vault lives for any real notes operation, whose path *form* you resolve per that module's ordered steps before using it — and then the `GHOLA_VAULT` environment variable, the host-native form the launcher exports. Neither source alone is sufficient: `vaultPath` is empty whenever the operator has not set a vault, and `GHOLA_VAULT` is absent whenever the operator has set `GHOLA_LEDGER_ROOT` (the launcher exports the vault only when the ledger resolved *through* it). If neither resolves, surface to the operator: "Team Switchboard: cannot resolve commsRoot — set an explicit path in the Modules tab, or set Vault Path in the Obsidian Notes panel." Do not proceed with switchboard operations until the path is resolved.

Deriving under the vault keeps the comms root inside a directory `tool.cwd-discipline` already authorizes (`${tool.obsidian-notes:vaultPath}/**` and `${GHOLA_VAULT}/**` are seeded exceptions). A non-empty `commsRoot` pointing anywhere else is an out-of-cwd path with no seeded authorization — it needs its own `allowedExceptionPaths` entry, and absent one the switchboard writes are refused like any other out-of-cwd write.

### Resolving the team name

**The team name is always derived. There is no parameter for it and no operator override** — derivation is the single rule, and it is not overridable by design. Ghola's status-bar pill and its Remote Control session name derive from this same rule, so all three agree about a given repo without anyone having to keep a setting in sync.

Derive it as follows:

1. **Start from the git repository root**, not the folder that happens to be open. Walk up from the workspace folder to the nearest ancestor holding a `.git` entry (a directory in a plain clone, a file in a worktree or submodule — either counts). This matters for nested layouts: `.../repos/cmms1/cmms-api` and `.../repos/cmms2/cmms-api` both reduce to `cmms-api` if you take the open folder, which is a collision, whereas their repo roots give the distinct `cmms1` and `cmms2` — and those are also what the roster's `Repo path` column records. If no `.git` is found above it, fall back to the workspace folder itself.
2. **Take that path's basename and strip a leading `Project-`** case-insensitively, prefix only, with the remainder keeping its original casing: `Project-Ghola` -> `Ghola`, `project-swt` -> `swt`, `cmms2` -> `cmms2`, `My-Project-Thing` -> `My-Project-Thing` (not a prefix, so untouched). A basename of exactly `Project-` would strip to nothing, so it keeps its unstripped form.
3. **Qualify by environment** per "Environment delineation" in the canonical vault `_Switchboard.md`: WSL is the incumbent and holds the unqualified name, and every other environment appends `@<env>` — `@win`, `@mac`, `@linux`. Detect your own environment; never ask and never assume. The qualifier is idempotent: a name that already ends in one of those four tokens is never given a second one, so a repo directory literally named `cmms1@win` renders `cmms1@win`, not `cmms1@win@win`.
4. **Disambiguate duplicate instances against the roster.** If a row already has your derived name AND your repo path, the row is yours — reuse it. If a row has your derived name but a DIFFERENT repo path, you are a new instance — take the lowest unused integer suffix (`Ghola#2`, `Ghola#3`, etc.).

If a `teamName` key nonetheless appears in this module's `parameters` block, it is a stale leftover from a removed setting: **ignore it** and derive as above.

The inbox filename is the slug of the team name: lowercased, spaces and punctuation replaced with hyphens. For example: `Ghola` -> `inbox-ghola.md`, `Ghola#2` -> `inbox-ghola-2.md`.

## Canonical location and files

The comms root is `<commsRoot>/` (resolved above). All paths below are relative to it.

| File | Purpose |
|------|---------|
| `_Switchboard.md` | Protocol header + roster table listing all teams |
| `inbox-<slug>.md` | Directed messages TO the team named by `<slug>` |
| `inbox-all.md` | Broadcast messages visible to all teams |

### _Switchboard.md format

The file opens with a self-documenting protocol header (created verbatim during bootstrap) followed by the roster table. The header is intentionally self-documenting so any team — even one without this module loaded — can read it and participate by hand.

```
# Agent Switchboard

This is the shared coordination point for the independent agent teams that work in this
Obsidian vault. Any agent, regardless of framework, can participate by following the
protocol below. It is self-documenting on purpose so a team without a dedicated comms
module can still read this file and join in.

**Golden rule: edits are APPEND-ONLY.** Add to your own section or append to a recipient's
inbox. Never rewrite the whole file and never delete another team's content. This is what
lets multiple teams touch these files at the same time without clobbering each other.

## Canonical location

`_AgentComms/` lives at the root of this vault:
`<commsRoot>/`

| File | Purpose |
|------|---------|
| `_Switchboard.md` | This file: protocol + team roster |
| `inbox-<team>.md` | Directed messages TO that team |
| `inbox-all.md` | Broadcast messages to every team |

`<team>` is the team name lowercased with spaces and punctuation replaced by hyphens
(e.g. `Ghola` -> `inbox-ghola.md`).

## Identity

Your team name is your repo/project name with a leading `Project-` stripped
case-insensitively (prefix only; the remainder keeps its name).
Example: `Project-Ghola` -> `Ghola`. For duplicate instances, check the roster: if a
row already has your name AND your repo path, reuse it. If a row has your name but a
DIFFERENT repo path, you are a new instance -- take the lowest unused integer suffix
(`Ghola#2`, `Ghola#3`). The repo path column disambiguates clones. The inbox slug for
`Ghola#2` is `inbox-ghola-2.md`.

## When the operator asks to check the switchboard / mail / register, a participating team should:

1. **Heartbeat** — update your row in the Roster below with what you are currently
   working on and today's date. If you have no row, append one.
2. **Check inbox** — read `inbox-<your-team>.md` and `inbox-all.md` for unread items and
   surface them to your operator.

This is on-demand only — do not perform these steps automatically at session start.

## Sending a message

Append a line to the recipient's inbox file (create it if it does not exist). Never delete
existing messages.

- **Directed:** append to `inbox-<recipient>.md`:
  `- [ ] YYYY-MM-DD from <Sender> [subject]: message body`
- **Broadcast:** append to `inbox-all.md` (no checkbox; read-state is tracked per team):
  `- #NNN YYYY-MM-DD from <Sender> [subject]: message body`
  where NNN is a zero-padded monotonic integer. Read `inbox-all.md`, find the highest
  existing `#NNN`, add one (first broadcast is `#001`).

Optionally tag priority after the subject, e.g. `[subject] (priority: high)`.

## Read model

- **Directed messages** -- flip `[ ]` to `[x]` when you have read it (local handled-marker
  only; the sender does not see your inbox). To deliver a reply, append a NEW directed
  message to the ORIGINAL SENDER's inbox:
  `- [ ] YYYY-MM-DD from <You> [re: <original subject>]: response body`
- **Broadcasts** -- do NOT flip shared checkboxes (that would mark them read for everyone).
  Instead, each team keeps an INTEGER `broadcasts-read-through:` marker at the top of its
  own inbox file. A broadcast is unread if its sequence number is greater than your marker.
  After processing, advance the marker to the highest broadcast number you have read.
  Sequence numbers (not dates) drive unread-detection so same-day or out-of-order
  broadcasts are never silently skipped.

## Stale teams

A roster row whose Last active date is older than the configured threshold (default
14 days) is considered stale. Stale rows are kept, not deleted, but can be flagged when
listing who is active.

## Roster

| Team | Repo path | Currently working on | Last active |
|------|-----------|----------------------|-------------|
| <Team> | <repo path> | <focus> | <YYYY-MM-DD> |
```

Roster row format (exact):

```
| <Team> | <repo path> | <focus> | <YYYY-MM-DD> |
```

### inbox-<slug>.md format

Each directed inbox file opens with a `broadcasts-read-through:` marker line, then contains a list of message items:

```
broadcasts-read-through: 0

- [ ] YYYY-MM-DD from <Sender> [subject]: body
```

The `broadcasts-read-through:` marker is an INTEGER tracking which broadcast sequence number this team has already processed (see "Read / acknowledge model" below). New files are created with `broadcasts-read-through: 0` (equivalent to `(none)` — all broadcasts are unread).

### inbox-all.md format

Broadcasts are appended without checkboxes, with a monotonic sequence number:

```
- #NNN YYYY-MM-DD from <Sender> [subject]: body
```

NNN is a zero-padded monotonic integer (`#001`, `#002`, ...). Read the file, find the highest existing `#NNN`, add one. The first broadcast in a fresh file is `#001`.

## Self-heal / bootstrap

Before performing any switchboard operation, verify the comms root and its files exist.

1. If `_AgentComms/` does not exist, create the directory and both `_Switchboard.md` and `inbox-all.md` using the formats above. Surface to the operator once: "Team Switchboard: bootstrapped `_AgentComms/` at `<path>`."
2. If `_Switchboard.md` does not exist, create it using the full self-documenting protocol header from the "### _Switchboard.md format" section above (substituting the resolved `commsRoot` path for `<commsRoot>/`), followed by the roster table header row. Do not add any team rows yet. Note: the header is intentionally self-documenting so teams without this module can read the file and participate by hand.
3. If `inbox-all.md` does not exist, create it as an empty file.
4. If this team's `inbox-<slug>.md` does not exist, create it with the `broadcasts-read-through: 0` header and no message items.

Do not recreate files that already exist — check first, create only if absent.

## On-demand switchboard check

Because this module is on-demand with `trigger: user-request`, TPM does NOT perform the sequence below automatically. It runs ONLY when the operator explicitly asks about cross-team comms — e.g. "check the switchboard," "any mail?," "check my inbox," "register us on the switchboard," or similar. When such a request comes in, perform the following steps.

**Step 1 — Resolve identity and location.** Resolve `commsRoot` and derive the team name per the rules above. If either cannot be resolved, surface the blockage to the operator and skip the remaining steps.

**Step 2 — Bootstrap if needed.** Run the self-heal check. Create any missing files.

**Step 3 — Heartbeat (if `parameters.heartbeatOnBoot` is true).** Find this team's row in the roster table (match on Team name AND repo path). If the row exists, update the `Currently working on` and `Last active` columns in-place — edit only that row, do not rewrite the table. If the row is absent, append it. Use the operator's stated focus for the current session as the `Currently working on` value; if no focus is established yet, use `(unspecified)` and update the row once the operator states their goal. Use today's date as `Last active`.

**Step 3b — Parent-project detection (if `parameters.detectParentProject` is true).** Reusing the roster data already loaded for the heartbeat, run the path-containment check in "Parent-project detection" below against this team's repo path. Fold the results into the compact opening message:

- If a parent is detected: `Detected parent project: <Parent> (this workspace is nested under <parent repo path>). Roster row grouped under it.` Then set this team's own `Parent` column value per the roster-grouping mechanics.
- If this team IS a parent of one or more registered children: `You are the parent of N child channel(s): <child list>. Combined view available on request.`
- If neither, say nothing about parentage.

This is presentation and an own-row annotation only — it never moves an inbox and never edits another team's row.

**Step 4 — Inbox check (if `parameters.checkInboxOnBoot` is true).** Read this team's `inbox-<slug>.md` and `inbox-all.md`. Surface a concise summary to the operator:

- **Directed messages**: list each unread item (checkbox `[ ]`) as one line: `<date> from <Sender> [subject]`. Count: "N unread directed message(s)." Do not dump full bodies unless the operator asks.
- **Broadcasts**: find entries in `inbox-all.md` whose sequence number is GREATER than this team's `broadcasts-read-through:` integer marker. If the marker is `0` (or absent), all broadcasts are unread. List each as: `#NNN <date> from <Sender> [subject]`. Count: "N unread broadcast(s)."
- If both inboxes are empty or fully read, say: "Inbox clear."

**Step 5 — Prune handled messages (after the inbox check).** Run one prune pass over this team's OWN `inbox-<slug>.md` per "Pruning handled directed messages" above: delete directed `[x]` items whose sent date is `parameters.handledMessageRetentionDays` (default 3) or more days before today. This runs after Step 4 so the inbox summary reflects what was present this on-demand check. Keep it lightweight. If any items were pruned, add one line to the summary message: "pruned N handled message(s) older than <days>d." If nothing was pruned, stay silent about it. A prune error must NEVER fail the check — on any error, skip the prune, optionally note it once, and continue the session normally.

Combine the heartbeat confirmation and inbox summary into a single, compact message rather than multiple separate messages.

## Sending messages

When the operator asks you to send a message to another team (e.g. "tell Mandrake that the API contract changed"), you:

1. Identify the recipient team name and find its slug.
2. Ensure `inbox-<recipient-slug>.md` exists (create it with the `broadcasts-read-through: 0` header if absent).
3. Append a directed message line to that file:

```
- [ ] YYYY-MM-DD from <Sender> [subject]: body
```

The optional priority suffix goes after the subject bracket: `- [ ] YYYY-MM-DD from Ghola [API contract change] (priority: high): The /users endpoint now returns a 'role' field...`

4. Confirm to the operator: "Message sent to `<Recipient>` — appended to `inbox-<slug>.md`."

TPM composes the message text from the operator's natural-language request. The operator never hand-edits inbox files; all writes go through the agent.

### Broadcasts

When the operator asks to broadcast to all teams:

1. Read `inbox-all.md` and find the highest existing sequence number `#NNN`. The new broadcast gets `#(NNN+1)`. If no broadcasts exist yet, use `#001`.
2. Append to `inbox-all.md` (no checkbox, no recipient slug):

```
- #NNN YYYY-MM-DD from <Sender> [subject]: body
```

3. Confirm: "Broadcast sent — appended to `inbox-all.md` as `#NNN`."

## Read / acknowledge model

### Directed messages

When you read a directed message (on operator request), flip the checkbox from `[ ]` to `[x]` on that line. Edit only that single line — do not rewrite the surrounding file. This `[x]` flip is a LOCAL handled-marker for your own inbox only; the sender does not read your inbox and will never see it.

To deliver a reply so the sender actually receives it, append a NEW directed message to the ORIGINAL SENDER's inbox file:

```
- [ ] YYYY-MM-DD from <You> [re: <original subject>]: body
```

The `[re: <original subject>]` subject signals it is a reply. The sender will surface it on their next inbox check. There is no inline reply mechanism — replies are always delivered as new directed messages in the sender's inbox.

### Broadcasts

Never flip checkboxes in `inbox-all.md` — broadcasts are shared and the checkbox state would be meaningless across teams. Instead, once you have processed all new broadcasts in a session, advance this team's `broadcasts-read-through:` marker in `inbox-<slug>.md` to the INTEGER sequence number of the highest broadcast you read. Edit only that single line.

Format: `broadcasts-read-through: <N>`

If the highest broadcast you processed is `#007`, update the line to:

```
broadcasts-read-through: 7
```

A broadcast is unread if its sequence number is greater than your marker. `broadcasts-read-through: 0` (or absent) means all broadcasts are unread. Sequence numbers (not dates) drive unread-detection so same-day or out-of-order broadcasts are never silently skipped.

## Pruning handled directed messages

`[x]` is a TRANSIENT handled-marker, not a permanent record. Instead of leaving handled messages crossed out in your inbox forever, this module deletes them once they have aged past a retention window. Crossing out still happens the moment you handle a message (so a just-read item and any reply history stay visible during the window); deletion supersedes the cross-out after `parameters.handledMessageRetentionDays` days (default 3).

**What gets pruned — the exact rule.** A directed message line in THIS team's own `inbox-<slug>.md` is pruned when ALL of the following hold:

1. It is a directed message item (a `- [x] ...` or `- [ ] ...` line), not the `broadcasts-read-through:` header and not a stray note.
2. It is already handled: the checkbox is `[x]`. A `[ ]` (unhandled) item is NEVER pruned, no matter how old — an unmet message must survive until it is handled.
3. Its SENT date (the `YYYY-MM-DD` the line carries) is `handledMessageRetentionDays` or more days before today. Formally: `today - sentDate >= handledMessageRetentionDays` (whole days). With the default 3, a message sent on the 10th is pruned on or after the 13th.

**Age clock.** Use the SENT date already embedded in the message line as the age clock — no separate handled-date is recorded. This deliberately uses existing data: adding a second timestamp when flipping to `[x]` would mean rewriting the line's format and give teams-without-this-module something they cannot produce. The small cost is that a message handled late (e.g. read 5 days after it was sent, with a 3-day window) is eligible to prune immediately; in practice directed messages are handled within a session or two of arrival, so the sent date is a close-enough proxy and never deletes anything still marked `[ ]`.

**"Today."** Obtain the current date the same way the heartbeat obtains it for the `Last active` column — from the session's current date (the `tool.time` module or the session context), never hardcoded. Compare dates in ISO `YYYY-MM-DD` form.

**Scope — read this carefully. The prune is intentionally narrow:**

- ONLY your OWN `inbox-<slug>.md`. Never another team's inbox.
- ONLY directed `[x]` items. Never `[ ]` items.
- NEVER `inbox-all.md`. Broadcasts are not pruned by this rule at all. Deleting a broadcast line would corrupt every team's `broadcasts-read-through:` math (a team whose marker is below the deleted number could never reconcile) — broadcasts age out by marker, not by deletion.
- NEVER the roster in `_Switchboard.md`. Stale roster rows are kept per the "Stale teams" rule; only handled directed messages are subject to this prune.

**How to prune.** Re-read your `inbox-<slug>.md` immediately before writing (the same re-read-right-before-write discipline every mutation here uses). Identify the exact `[x]` lines that meet the rule, and delete only those lines — leave the `broadcasts-read-through:` header, every `[ ]` item, and every not-yet-expired `[x]` item exactly as they are. If a line's date is missing or unparseable, treat it as NOT prunable and leave it in place. If nothing qualifies, make no write at all.

## Concurrency discipline

This is a shared, multi-writer file system. The rules below prevent one team's writes from clobbering another's.

- **APPEND-ONLY for new content.** When adding a roster row, a message, or a broadcast, INSERT into the correct location — do not rewrite the whole file. Use the Read tool to load the current file contents, identify the exact insertion point, and write only the new lines.
- **Single-line edits only for mutations.** When flipping a checkbox (`[ ]` -> `[x]`), updating the `broadcasts-read-through:` marker, or updating a roster row, edit only that single line. No other lines change.
- **Never delete another team's content.** Roster rows, inbox messages, and broadcasts are permanent records. You may update your own roster row and flip your own received-message checkboxes. You never delete rows written by other teams.
- **Controlled exception — pruning your OWN handled directed messages.** This is the one carve-out the module performs autonomously: during an on-demand switchboard check a team may delete EXPIRED handled (`[x]`) directed messages from its OWN `inbox-<slug>.md`, per "Pruning handled directed messages." This is still a single-team-owns-its-own-inbox operation done with the same re-read-right-before-write discipline. (Cross-team dead-channel reclamation is a separate exception, sanctioned and governed by the canonical vault `_Switchboard.md`, always operator-confirmed and tombstone-based — never a silent delete — so it too does not contradict "never delete another team's content.") The invariant otherwise stands in full: never rewrite a whole shared file, never delete another team's content, never delete roster rows, never delete `[ ]` (unhandled) items, and never delete broadcasts in `inbox-all.md`.
- **Roster write scope.** You own one row: the row matching your team name and repo path. Update only that row. Do not touch other teams' rows even if their data looks stale or incorrect.
- **No file lock — low but non-zero race risk.** APPEND-ONLY + single-line edits make clobbering very unlikely, but two teams appending to the exact same file within the same instant could still race. At human/session cadence this is low-risk. Keep each write to a single insertion or a single changed line to minimize the window.

These rules allow multiple teams to share `_Switchboard.md`, `inbox-all.md`, and `inbox-<slug>.md` without overwriting each other's work.

## Routing via the roster

The roster's `Currently working on` column serves as a lightweight routing table. When the operator asks "which team would know about X?", scan the `Currently working on` column in `_Switchboard.md` for teams whose focus overlaps with X. Report the matches with their team names and repo paths. No message is needed — this is a read-only lookup.

## Parent-project detection

The vault accumulates near-duplicate channels because a clone of one project often lives INSIDE another project's working copy — e.g. a `cmms-api` checkout at `/home/aarbuckle/projects/cmms4/cmms-api` is nested under the `cmms4` workspace. This section recognizes that WORKSPACE NESTING so the roster can group a child under its parent, without ever merging live channels. It is enabled by `parameters.detectParentProject` (default true).

**Two different axes — do not conflate them.** *Repo identity* is defined by the git remote (a `cmms-api` clone is its own distinct repo). *Workspace nesting* is defined by the filesystem path (that same clone sits inside the parent's checkout). Parent detection here uses PATH NESTING only — never the team name, never the `#N` suffix, never the git remote. A channel can be a distinct repo by remote AND a child by path at the same time; this feature speaks only to the path axis.

### The rule

Team B is a CHILD of team A iff B's repo path is a PROPER subdirectory of A's repo path, where both paths are read from the roster's `Repo path` column.

- **Nearest ancestor wins.** If several roster teams are ancestors of B's path, B's direct parent is the one with the LONGEST matching path prefix (the deepest containing directory); shallower ancestors are grandparents. This produces a CHAIN, not a flat group (e.g. `cmms4` -> `cmms-api` at `/cmms4/cmms-api` -> an `e2e` instance at `/cmms4/cmms-api/e2e`).
- **The `#N` suffix is NOT the parent signal.** The suffix is assigned by registration order (lowest unused integer), so `inbox-cmms-api-2` is NOT necessarily the child of `cmms2` — resolve the parent purely from the path. Path containment is the only reliable signal.

### Edge cases

- **Segment-boundary compare.** Normalize both paths to absolute form and compare with a trailing separator so `/cmms4/cmms-api` is NOT treated as an ancestor of `/cmms4/cmms-api2`. Require a real path-segment boundary, never a bare string prefix.
- **Same-path teams are SIBLINGS, not parent/child.** If two teams share the exact same repo path (co-located instances, e.g. `cmms-api#3` and `#7` both at `/cmms4/cmms-api`), neither is the other's parent; they share the same real parent. Path equality is never a parent relationship.
- **Multi-level chains render indented by depth** in the roster grouping — a grandchild is shown under its direct parent, not flattened up to the top-level project.
- **Ancestor directory exists on disk but is NOT registered as a team.** B stands alone (no live parent row to group under), but note the INFERRED parent directory so the operator can see the intended grouping.
- **Symlink / trailing-slash normalization.** Resolve `..`, symlinks, and trailing slashes before comparing, so a symlinked child still matches its parent and roster entries with inconsistent trailing slashes compare correctly.

### Roster grouping

Grouping is expressed by a `Parent` column value on THIS team's OWN roster row only. Set it to your detected direct parent's team name (blank for a top-level team). This is an additive, single-line-edit annotation under the same discipline as every other roster mutation: edit only your own row, never another team's row, and never move or rename an inbox. Chains are rendered by depth (child under direct parent, grandchild under child).

### Combined read view

A parent MAY read its children's `inbox-<slug>.md` files to present a COMBINED view of the family's channels on operator request. This is read-only aggregation: children keep their own inboxes for RECEIVING directed mail, so addressing is unchanged and no files are moved. The combined view never merges or writes across inboxes — it only reads them together.

### Dead-channel reclamation

When `parameters.mergeDeadChildren` is true and this team is a parent, the agent MAY offer to reclaim a child channel that is DEAD. "Dead" is defined strictly: the child's roster row is stale past `parameters.staleAfterDays` AND its inbox holds no unhandled `[ ]` directed items (nothing is still owed to it). Both conditions must hold; a child with any unhandled `[ ]` item is never dead, regardless of age.

Reclamation is ALWAYS operator-confirmed and never automatic — `mergeDeadChildren` only controls whether the OFFER appears, not whether the fold happens. Crucially, actually folding or removing ANOTHER team's dead inbox is a CROSS-TEAM action: its mechanics, the pointer left behind, and the authorization for one team to touch another team's inbox are governed by the canonical protocol in the vault `_Switchboard.md`. This module surfaces the offer and defers the cross-team fold to that doc. Absent that sanctioned canonical procedure, the agent does not fold another team's inbox — it stops at presenting the offer and the dead-child list.

## Stale teams

A roster row is stale when its `Last active` date is more than `parameters.staleAfterDays` days in the past (default 14). When listing active teams (e.g. the operator asks "who is active?"), flag stale rows inline: `<Team> (stale — last active <date>)`. Do not delete stale rows. Stale rows remain in the roster as a permanent record of teams that have participated in the switchboard.

## Template reference

Exact formats — use these verbatim when creating or appending content:

**Roster row:**
```
| <Team> | <repo path> | <focus> | <YYYY-MM-DD> |
```

**Directed message:**
```
- [ ] YYYY-MM-DD from <Sender> [subject]: body
```

**Directed reply** (appended to the ORIGINAL SENDER's inbox, not your own):
```
- [ ] YYYY-MM-DD from <You> [re: <original subject>]: body
```

**Handled marker** (flip in your OWN inbox after reading; local only — not a reply. Transient: pruned from your inbox once its sent date is older than `handledMessageRetentionDays`, default 3 — see "Pruning handled directed messages"):
```
- [x] YYYY-MM-DD from <Sender> [subject]: body
```

**Broadcast** (sequence number is monotonically incrementing; read `inbox-all.md` for highest `#NNN`, add one):
```
- #NNN YYYY-MM-DD from <Sender> [subject]: body
```

**Inbox header marker (new files):**
```
broadcasts-read-through: 0
```

**Broadcast marker advance** (edit this single line in YOUR inbox after processing broadcasts):
```
broadcasts-read-through: <N>
```

## Session-end behavior

At the end of a session, if the operator explicitly wraps up via the switchboard, the agent may refresh its roster row's `Currently working on` and `Last active` columns to reflect the session's final focus and today's date. This remains on-demand like every other switchboard operation — there is no automatic session-end update to mirror, since there is no automatic session-start heartbeat either (Step 3 above only runs when asked). If the operator does not explicitly ask for it, skipping the session-end roster update is the default.

## Module-disabled vs parameter-disabled

These are distinct cases:

- **Module disabled** (no `tool.team-switchboard` in the Session Manifest): no switchboard operations are available. If the operator asks to send a message to another team, surface that the module is not loaded and direct them to enable it in the Modules tab.
- **Module enabled, `heartbeatOnBoot` is false**: when the operator asks for an on-demand switchboard check, the roster is not updated as part of it. The agent can still update the roster if the operator explicitly asks it to register/heartbeat.
- **Module enabled, `checkInboxOnBoot` is false**: when the operator asks for an on-demand switchboard check, the inbox is not read as part of it. The agent checks it if the operator explicitly asks to see mail.
- **Module enabled, `commsRoot` unresolvable**: surface the blockage once, when the operator's on-demand request triggers resolution (see "Resolving commsRoot" above), and skip the remaining steps. Switchboard operations are blocked until the path is resolved.

Do not merge these cases.
