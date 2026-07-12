# Time

When this module is loaded, the agent has an active mechanism for learning the real current date and time, plus a hard rule against inventing one.

## The rule: never fabricate the current time

Training data has a knowledge cutoff -- it is not a clock. The agent MUST NOT guess, infer, or recall the current date/time from training data, from the model's sense of "recent," or from any other soft signal. That value is always stale or wrong. Whenever the current date/time matters -- dating a note, computing an interval, stamping a roster row, deciding what "today" means -- the agent obtains it from the shell, never from memory.

## How to read parameters

Locate this module's entry in the Session Manifest. Its `parameters` object may appear as `(defaults)`, be absent, or be a live JSON object.

- `(defaults)` or absent: `timezone` = `""` (host local time), `timestampFormat` = `"friendly"`.
- Live object: read `timezone` and `timestampFormat`; fall back to the documented default for any key that is missing.

## Getting the current time

The agent has shell access. Run `date` with the format string selected by `timestampFormat`, prefixed with a `TZ=` override if `timezone` is non-empty.

**Format string by `timestampFormat`:**

| Value | Command | Example output |
|-------|---------|-----------------|
| `iso-8601` | `date -Iseconds` | `2026-07-09T18:58:06-05:00` |
| `friendly` (default) | `date +'%Y-%m-%d %H:%M %Z (%A)'` | `2026-07-09 18:58 CDT (Thursday)` |
| `date-only` | `date +%Y-%m-%d` | `2026-07-09` |

**Timezone prefix by `timezone`:**

- Empty (default): no `TZ` prefix -- the host's local timezone applies. E.g. `date +'%Y-%m-%d %H:%M %Z (%A)'`.
- Non-empty (an IANA timezone name, e.g. `UTC`, `America/Chicago`): prefix the command with `TZ='<value>' `. E.g. `TZ='America/Chicago' date +'%Y-%m-%d %H:%M %Z (%A)'`.

Combine both: pick the command from the format table, then add the `TZ=` prefix if `timezone` is set.

## Session-start behavior

Because this module is `proactive` with `trigger: session-start`, establish "now" once, early in the session, before any dated work happens. Run the resolved `date` command and hold the result as the session's verified current time. Downstream dated work -- session-handoff dated sections, switchboard roster date-stamping, ticket or commit timestamps, or anything else that needs "today" -- reads from this verified value rather than re-deriving it or falling back to a guess. If the shell call fails for any reason, surface that to the operator rather than silently substituting a guessed date.

## Re-checking mid-session

A long-running session can cross a day boundary or a DST transition. If a request depends on precise elapsed time rather than the "today" already established at session start, or enough wall-clock time has plausibly passed since the last check, re-run `date` rather than trusting the stale in-session value.
