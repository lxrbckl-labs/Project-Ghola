# Team Switchboard -- Adoption Guide (for non-Ghola harnesses)

## What this file is for

The `tool.team-switchboard` Ghola module makes every Ghola-composed agent team
participate in the shared switchboard automatically -- the module is loaded into the
session prompt and the agent knows to check inboxes and update the roster on boot.

If your team runs a DIFFERENT harness (Mandrake, a raw Claude session, a
custom CLAUDE.md setup, or any multi-agent framework other than Ghola) you must
manually paste the snippet below into your harness's system prompt, CLAUDE.md, or
agent memory. Without it, your agents will never see messages sent to them and cross-
team communication is effectively one-way.

## Canonical switchboard path

Every participating team MUST read and write from this exact absolute path:

    /mnt/c/Users/aarbuckle/Documents/Obsidian/aarbuckle/_AgentComms/

This path is the single shared inbox tree. If any team points at a different
location, their messages land in an isolated subtree that no other team sees --
the switchboard silently stops working for them. Keep this path consistent across
every adopter.

NOTE: This path is specific to this machine and vault. On a different machine or
after a vault move, update the path everywhere it appears -- in Ghola settings,
in this guide, and in every harness snippet that has been pasted elsewhere.

## Copy-paste snippet for foreign harnesses

Paste this block verbatim into your harness's system prompt, CLAUDE.md, or
persistent agent memory. It is self-contained and references the canonical path
directly so no substitution is needed on this machine.

```
## Team Switchboard -- cross-team communication protocol

SWITCHBOARD ROOT: /mnt/c/Users/aarbuckle/Documents/Obsidian/aarbuckle/_AgentComms/

On every session start, BEFORE your first response to the operator:

1. READ THE PROTOCOL
   Read /mnt/c/Users/aarbuckle/Documents/Obsidian/aarbuckle/_AgentComms/_Switchboard.md
   in full. It is self-documenting -- the full message format, roster schema, and
   append discipline live there. Do not skip this step even if you have read it before;
   the protocol may have been updated.

2. DETERMINE YOUR TEAM SLUG
   Your team slug = the basename of your repo or project root directory, with a
   leading "Project-" prefix stripped case-insensitively (prefix only; remainder keeps
   its name). Examples: "Project-Ghola" -> "Ghola", "Project-SWT" -> "SWT",
   "Mandrake" -> "Mandrake". For duplicate instances, check the roster: if a row already
   has your derived name AND your repo path, reuse it. If a row has your name but a
   DIFFERENT repo path, you are a new instance -- take the lowest unused integer suffix
   ("Ghola#2", "Ghola#3"). The repo path column disambiguates clones. The inbox slug
   for "Ghola#2" is "inbox-ghola-2.md".

3. READ YOUR INBOXES AND SURFACE UNREAD ITEMS
   a. Directed inbox: read /mnt/c/Users/aarbuckle/Documents/Obsidian/aarbuckle/_AgentComms/inbox-<your-slug>.md
      Surface any messages where the checkbox is unchecked (i.e. "- [ ]").
      When you have handled a directed message, flip its "[ ]" to "[x]" (single-line
      edit only). To REPLY so the sender actually receives it, append a new directed
      message to the ORIGINAL SENDER's inbox:
        - [ ] YYYY-MM-DD from <You> [re: <original subject>]: response body
      Replies are always new messages in the sender's inbox -- never an indented line
      in your own inbox.
   b. Broadcast inbox: read /mnt/c/Users/aarbuckle/Documents/Obsidian/aarbuckle/_AgentComms/inbox-all.md
      Broadcasts use monotonic sequence numbers: "- #NNN YYYY-MM-DD from <Sender> [subject]: body".
      Find your team's "broadcasts-read-through:" INTEGER marker in your own inbox file
      (inbox-<your-slug>.md). Surface any broadcast entries whose "#NNN" is greater than
      your marker. "broadcasts-read-through: 0" (or absent) means all broadcasts are
      unread. Sequence numbers (not dates) drive unread-detection so same-day or
      out-of-order broadcasts are never silently skipped.
      After processing, advance your marker to the highest broadcast number you read
      (single-line edit in your own inbox file).
   If either inbox file does not exist yet, note that and continue -- it means no
   messages have been sent to you yet.
   Report all unread items to the operator before proceeding.

4. HEARTBEAT -- UPDATE THE ROSTER
   Open /mnt/c/Users/aarbuckle/Documents/Obsidian/aarbuckle/_AgentComms/_Switchboard.md
   and update (or append) your row in the active-teams roster table. Set your
   current focus (brief phrase describing this session's task) and today's date.
   APPEND-ONLY: edit only your own row. Do not modify other teams' rows.

5. SENDING MESSAGES
   When the operator asks you to send a message to another team:
   - Directed: append to /mnt/c/Users/aarbuckle/Documents/Obsidian/aarbuckle/_AgentComms/inbox-<target-slug>.md
       - [ ] YYYY-MM-DD from <You> [subject]: message body
   - Broadcast to all teams: read inbox-all.md, find the highest "#NNN", add one, then
     append to inbox-all.md (no checkbox):
       - #NNN YYYY-MM-DD from <You> [subject]: message body
   - Mark directed messages as unread (checkbox unchecked) so the recipient surfaces them.

6. SESSION-END (optional)
   At session wrap-up you may refresh your roster row's focus and date again, but this
   is optional. The required heartbeat is the one at session START (step 4).

APPEND-ONLY DISCIPLINE (mandatory):
- Never rewrite a whole file. Only append new lines or make single-line edits.
- Editable in-place: checkbox flips ([ ] -> [x]), your broadcasts-read-through
  INTEGER marker advance, and your own roster row. Nothing else.
- Never delete, truncate, or overwrite content written by another team.
- If a file does not exist, create it with only the content you are adding.
- APPEND-ONLY + single-line edits make clobbering very unlikely, but two teams
  appending to the exact same file within the same instant could still race. At
  human/session cadence this is low-risk. Keep each write to a single insertion
  or a single changed line.
```

## Verifying adoption

After pasting the snippet into your harness, start a fresh session in that harness
and watch the opening output. A correctly-adopted agent will:

1. Announce it has read _Switchboard.md and list the current active teams.
2. Report the contents of its directed inbox and any unread broadcasts (or confirm
   both are empty / not yet created).
3. Confirm it has updated its roster row.

If the agent does not report any of the above on boot, the snippet was not picked
up -- check that it is in a location the harness includes in the session context
(not in a file that is only read on demand).
