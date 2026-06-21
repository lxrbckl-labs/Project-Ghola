# Team Switchboard

When this module is loaded, the session participates in a shared cross-team communication layer via a set of Obsidian markdown files. Team Switchboard maintains a roster of active teams and routes directed messages and broadcasts through per-team inbox files. This module is **proactive**: TPM reads it once at session start, before responding to the user's first request, and performs the boot sequence described below. For the rest of the session, the module activates when the operator asks to send a message, check the inbox, or look up which team owns a given focus area.

## Reading parameters

Locate this module's entry in the Session Manifest. Its `parameters` object may appear as `(defaults)`, be absent entirely, or be a live JSON object.

- If the entry shows `(defaults)` or a parameter key is absent, the default for that parameter applies. Defaults: `commsRoot` = `""` (derive at runtime), `teamName` = `""` (auto-derive), `staleAfterDays` = `14`, `checkInboxOnBoot` = `true`, `heartbeatOnBoot` = `true`.
- If `parameters` is a live object, read each key present and fall back to the documented default for any key that is missing.

### Resolving `commsRoot`

`parameters.commsRoot` is the absolute path to the shared `_AgentComms/` directory.

- Non-empty string: use it verbatim as the comms root. Verify it exists (or bootstrap it — see "Self-heal / bootstrap" below).
- Empty string or absent: derive `<obsidian-vault-root>/_AgentComms/`. The Obsidian vault root is the parent of the project notes directory. In SWT sessions it is the value of the `SWT_OBSIDIAN_PATH` environment variable. If the env var is also absent, surface to the operator: "Team Switchboard: cannot resolve commsRoot — set an explicit path in the Modules tab or ensure SWT_OBSIDIAN_PATH is set." Do not proceed with switchboard operations until the path is resolved.

### Resolving `teamName`

`parameters.teamName` is the name this team registers and is addressed by.

- Non-empty string: use it as-is. This is the canonical team name for this session.
- Empty string or absent: auto-derive from the repo or project basename. Strip the leading `Project-` prefix case-insensitively (prefix only — the remainder keeps its original casing). For example: `Project-Nomeda` -> `Nomeda`, `project-swt` -> `SWT`. To disambiguate duplicate instances: check the roster. If a row already has your derived name AND your repo path, the row is yours — reuse it. If a row has your derived name but a DIFFERENT repo path, you are a new instance — take the lowest unused integer suffix (`Nomeda#2`, `Nomeda#3`, etc.).

The inbox filename is the slug of the team name: lowercased, spaces and punctuation replaced with hyphens. For example: `Nomeda` -> `inbox-nomeda.md`, `Nomeda#2` -> `inbox-nomeda-2.md`.

## Canonical location and files

The comms root is `<commsRoot>/` (resolved above). All paths below are relative to it.

| File | Purpose |
|------|---------|
| `switchboard.md` | Protocol header + roster table listing all teams |
| `inbox-<slug>.md` | Directed messages TO the team named by `<slug>` |
| `inbox-all.md` | Broadcast messages visible to all teams |

### switchboard.md format

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
| `switchboard.md` | This file: protocol + team roster |
| `inbox-<team>.md` | Directed messages TO that team |
| `inbox-all.md` | Broadcast messages to every team |

`<team>` is the team name lowercased with spaces and punctuation replaced by hyphens
(e.g. `Nomeda` -> `inbox-nomeda.md`).

## Identity

Your team name is your repo/project name with a leading `Project-` stripped
case-insensitively (prefix only; the remainder keeps its name).
Example: `Project-Nomeda` -> `Nomeda`. For duplicate instances, check the roster: if a
row already has your name AND your repo path, reuse it. If a row has your name but a
DIFFERENT repo path, you are a new instance -- take the lowest unused integer suffix
(`Nomeda#2`, `Nomeda#3`). The repo path column disambiguates clones. The inbox slug for
`Nomeda#2` is `inbox-nomeda-2.md`.

## On session start, a participating team should:

1. **Heartbeat** — update your row in the Roster below with what you are currently
   working on and today's date. If you have no row, append one.
2. **Check inbox** — read `inbox-<your-team>.md` and `inbox-all.md` for unread items and
   surface them to your operator.

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

1. If `_AgentComms/` does not exist, create the directory and both `switchboard.md` and `inbox-all.md` using the formats above. Surface to the operator once: "Team Switchboard: bootstrapped `_AgentComms/` at `<path>`."
2. If `switchboard.md` does not exist, create it using the full self-documenting protocol header from the "### switchboard.md format" section above (substituting the resolved `commsRoot` path for `<commsRoot>/`), followed by the roster table header row. Do not add any team rows yet. Note: the header is intentionally self-documenting so teams without this module can read the file and participate by hand.
3. If `inbox-all.md` does not exist, create it as an empty file.
4. If this team's `inbox-<slug>.md` does not exist, create it with the `broadcasts-read-through: 0` header and no message items.

Do not recreate files that already exist — check first, create only if absent.

## Session-start behavior

Because this module is `proactive` with `trigger: session-start`, TPM performs the following boot sequence before responding to the user's first request.

**Step 1 — Resolve identity and location.** Resolve `commsRoot` and `teamName` per the rules above. If either cannot be resolved, surface the blockage to the operator and skip the remaining steps.

**Step 2 — Bootstrap if needed.** Run the self-heal check. Create any missing files.

**Step 3 — Heartbeat (if `parameters.heartbeatOnBoot` is true).** Find this team's row in the roster table (match on Team name AND repo path). If the row exists, update the `Currently working on` and `Last active` columns in-place — edit only that row, do not rewrite the table. If the row is absent, append it. Use the operator's stated focus for the current session as the `Currently working on` value; if no focus is established yet, use `(session start)` and update the row once the operator states their goal. Use today's date as `Last active`.

**Step 4 — Inbox check (if `parameters.checkInboxOnBoot` is true).** Read this team's `inbox-<slug>.md` and `inbox-all.md`. Surface a concise summary to the operator:

- **Directed messages**: list each unread item (checkbox `[ ]`) as one line: `<date> from <Sender> [subject]`. Count: "N unread directed message(s)." Do not dump full bodies unless the operator asks.
- **Broadcasts**: find entries in `inbox-all.md` whose sequence number is GREATER than this team's `broadcasts-read-through:` integer marker. If the marker is `0` (or absent), all broadcasts are unread. List each as: `#NNN <date> from <Sender> [subject]`. Count: "N unread broadcast(s)."
- If both inboxes are empty or fully read, say: "Inbox clear."

Combine the heartbeat confirmation and inbox summary into a single, compact opening message rather than multiple separate messages.

## Sending messages

When the operator asks you to send a message to another team (e.g. "tell Mandrake that the API contract changed"), you:

1. Identify the recipient team name and find its slug.
2. Ensure `inbox-<recipient-slug>.md` exists (create it with the `broadcasts-read-through: 0` header if absent).
3. Append a directed message line to that file:

```
- [ ] YYYY-MM-DD from <Sender> [subject]: body
```

The optional priority suffix goes after the subject bracket: `- [ ] YYYY-MM-DD from Nomeda [API contract change] (priority: high): The /users endpoint now returns a 'role' field...`

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

When you read a directed message (either at session start or on operator request), flip the checkbox from `[ ]` to `[x]` on that line. Edit only that single line — do not rewrite the surrounding file. This `[x]` flip is a LOCAL handled-marker for your own inbox only; the sender does not read your inbox and will never see it.

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

## Concurrency discipline

This is a shared, multi-writer file system. The rules below prevent one team's writes from clobbering another's.

- **APPEND-ONLY for new content.** When adding a roster row, a message, or a broadcast, INSERT into the correct location — do not rewrite the whole file. Use the Read tool to load the current file contents, identify the exact insertion point, and write only the new lines.
- **Single-line edits only for mutations.** When flipping a checkbox (`[ ]` -> `[x]`), updating the `broadcasts-read-through:` marker, or updating a roster row, edit only that single line. No other lines change.
- **Never delete another team's content.** Roster rows, inbox messages, and broadcasts are permanent records. You may update your own roster row and flip your own received-message checkboxes. You never delete rows written by other teams.
- **Roster write scope.** You own one row: the row matching your team name and repo path. Update only that row. Do not touch other teams' rows even if their data looks stale or incorrect.
- **No file lock — low but non-zero race risk.** APPEND-ONLY + single-line edits make clobbering very unlikely, but two teams appending to the exact same file within the same instant could still race. At human/session cadence this is low-risk. Keep each write to a single insertion or a single changed line to minimize the window.

These rules allow multiple teams to share `switchboard.md`, `inbox-all.md`, and `inbox-<slug>.md` without overwriting each other's work.

## Routing via the roster

The roster's `Currently working on` column serves as a lightweight routing table. When the operator asks "which team would know about X?", scan the `Currently working on` column in `switchboard.md` for teams whose focus overlaps with X. Report the matches with their team names and repo paths. No message is needed — this is a read-only lookup.

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

**Handled marker** (flip in your OWN inbox after reading; local only — not a reply):
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

At the end of a session, the agent may optionally refresh its roster row's `Currently working on` and `Last active` columns to reflect the session's final focus and today's date. This is a courtesy update — the required heartbeat is the session-START one (Step 3 above). If the session ends abruptly or the operator does not explicitly wrap up, skipping the session-end roster update is acceptable.

## Module-disabled vs parameter-disabled

These are distinct cases:

- **Module disabled** (no `tool.team-switchboard` in the Session Manifest): no switchboard operations are available. If the operator asks to send a message to another team, surface that the module is not loaded and direct them to enable it in the Modules tab.
- **Module enabled, `heartbeatOnBoot` is false**: the roster is not updated at session start. The agent can still update the roster on explicit request.
- **Module enabled, `checkInboxOnBoot` is false**: the inbox is not read at session start. The agent checks it on explicit request only.
- **Module enabled, `commsRoot` unresolvable**: surface the blockage once at session start (see "Resolving commsRoot" above) and skip all boot steps. Switchboard operations are blocked until the path is resolved.

Do not merge these cases.
