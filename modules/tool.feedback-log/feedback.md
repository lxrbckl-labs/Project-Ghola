# Feedback Logging

When this module is loaded, the session has a persistent feedback log the user can capture ideas into mid-conversation and triage later from the Settings panel's "Feedback" tab. TPM is the only agent that interacts with this log — SWE and QA never read or write it. Entries the user explicitly asks you to capture are appended; entries already on disk can be surfaced back to the user on request.

The log file lives at `{parameters.feedbackFilePath}`. The path is injected by the host from the extension's `globalStorageUri` — do not hard-code it, do not guess it, and do not relocate it. If the parameter is missing from your Session Manifest entry, refuse the feedback operation with a one-sentence note that the module is enabled but the host did not inject a path (this would indicate a host bug, not a user error).

## File format

The file is a single JSON object:

```
{
  "schemaVersion": 1,
  "entries": [
    {
      "id": "<uuid>",
      "createdAt": "<ISO-8601 timestamp>",
      "text": "<the user's idea, verbatim>",
      "status": "pending" | "approved",
      "branch": "<git branch name> | null"
    },
    ...
  ]
}
```

`branch` is optional — entries logged before this field was introduced will not have it, and those entries are valid. Do not backfill `branch` on existing entries.

If the file does not exist on disk when you go to read it, treat it as `{ "schemaVersion": 1, "entries": [] }` and create it on first write. If `entries` is missing or not an array, treat it as `[]` and overwrite on next write (do not error the user out — the panel is the canonical writer and will heal the shape on its own next sync).

## Trigger phrases

Append a new entry when the user's message clearly opts into the feedback log. Treat these (and close paraphrases) as the trigger set:

- "add this to feedback"
- "log this for later"
- "save this idea"
- "note this for the feedback log"
- "add to the feedback log"
- "track this as feedback"
- "remind me about this later" (when paired with an idea, not a calendar task)

Do not append on ambiguous phrases — if the user is venting, brainstorming aloud, or describing a bug they want fixed right now, do not silently capture it. When unsure, ask: "Want me to log that to the feedback list?"

## How to append

When a trigger fires:

1. Build a new entry object:
   - `id`: a fresh UUID (use `crypto.randomUUID()` semantics — any RFC-4122 UUID string is fine).
   - `createdAt`: the current timestamp as an ISO-8601 string.
   - `text`: the user's idea, captured verbatim. Strip leading "add this to feedback:" / "log this:" prefixes so the stored text is the idea itself, not the trigger phrase.
   - `status`: `"pending"`.
   - `branch`: capture the current git branch by running `git rev-parse --abbrev-ref HEAD` in the current working directory:
     - If the command succeeds and the output (trimmed) is a non-empty string other than `HEAD` → set `branch` to that string.
     - If the output is `HEAD` (detached HEAD state) → set `branch` to `null`.
     - If the command fails for any reason (not a git repo, permission error, etc.) → set `branch` to `null`. **Do not block the append** — capturing the branch is best-effort; the entry must still be logged even if the branch cannot be determined.
2. Read the existing JSON file at `{parameters.feedbackFilePath}` with your `Read` tool. If the file is missing or empty, start from `{ "schemaVersion": 1, "entries": [] }`.
3. Append the new entry to the `entries` array (in arrival order — do not sort, do not deduplicate, do not rewrite existing entries).
4. Write the full JSON object back to the same path with your `Write` tool, preserving `schemaVersion`.
5. Confirm to the user in one sentence: e.g. "Logged to the feedback list." Do not echo the entry's `id` — it is an implementation detail the user does not need to see. Do not echo the full entry text back; the user just said it.

If the write fails (permission error, disk full, etc.), tell the user the capture failed and give them the error message in one line. Do not retry silently.

Note: the Settings panel creates the parent directory of `feedbackFilePath` automatically before its first write (the directory may not exist until then). As the TPM agent, you do not need to create it — your `Write` tool will target the path directly and will fail if the directory is missing; in that case the error message is sufficient.

## How to surface

When the user asks "what's in feedback?", "show me the feedback log", "what have I saved?", or similar, read `{parameters.feedbackFilePath}` and surface the entries grouped by status. Suggested format:

```
Pending:
- <text>  (<short relative date, e.g. "yesterday">)
- ...

Approved:
- <text>  (<short relative date>)
- ...
```

Do not include the `id` field — it is for the panel's internal routing, not user-visible. If `entries` is empty, say so plainly: "The feedback log is empty." If only one of the two groups is non-empty, omit the empty header.

## Who triages

The Settings panel's "Feedback" tab is the user's primary triage surface — it renders pending entries with Yes/No buttons (approve / delete) and approved entries with a Delete button. Entries in each group are sorted newest-first. Each card shows the creation date and, when a git branch was captured at log time, a branch chip (`on <branch>`).

The No button (pending entries) uses a two-step inline confirm: the first click changes the button to "Confirm?" for 2 seconds; a second click within that window posts the delete. If the user does not confirm within 2 seconds the button reverts to "No" automatically. The two-step confirm state is cleared when the user navigates away from and back to the Feedback detail view, so an in-progress confirm does not survive navigation.

The Delete button (approved entries) is immediate — it fires the delete on the first click with no confirm step.

Your role here is mostly capture, with surfacing as a secondary function. Do not offer to "mark this approved" or "delete this" from the chat — the panel is where that happens. If the user explicitly asks you to delete or approve an entry from the chat, tell them the panel is the right surface and that direct chat-side state transitions are not supported in this module.

## Concurrency note

The Settings panel serializes its own read-modify-write operations internally. However, concurrent writes between the panel and the TPM agent (which uses its own Read/Write tools) are not serialized — both can write the file simultaneously. This is an accepted limitation. In practice the window is small: TPM appends only when a trigger phrase fires, and the panel writes only when the user clicks Approve or Delete. If you notice the file looks unexpectedly stale after a write, advise the user to close and reopen the Feedback tab to force a fresh read.

## Entry validation by the panel

The Settings panel's reader silently drops individual entries that fail basic shape validation: an entry must have `id` (string), `createdAt` (string), `text` (string), and `status` (`"pending"` or `"approved"`). Entries missing any of these fields, or with an unrecognized `status` value, are filtered out and will not appear in the panel. The `branch` field is optional — absent or `null` branch values are valid and preserved. This means an agent-written entry with a typo in `status` (e.g. `"done"`) will silently disappear from the panel view. Use only `"pending"` or `"approved"` as the `status` value when writing entries.

## What NOT to do

- Do not echo entry IDs to the user — they are an implementation detail and noise in the chat.
- Do not invent entries, summarize, or paraphrase — capture the user's words.
- Do not deduplicate against existing entries; the user may intentionally re-log a recurring idea, and the panel handles dedupe via the user's triage.
- Do not read `{parameters.feedbackFilePath}` proactively at session start. This module is not `proactive` — it is consulted on demand when a trigger phrase fires.
- Do not surface feedback entries unsolicited. The user asks; you answer.
- Do not delegate the read or write to a SWE subagent. This is a TPM-only capability and a SWE does not have the module loaded.
