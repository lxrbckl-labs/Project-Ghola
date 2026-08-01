# Claude Usage Observer (on-request usage readout)

This module lets TPM report the operator's live usage figures — the 5-hour rolling-window percentage and the context-window numbers — from the snapshot the Ghola status line writes. It **used to** divide those figures into a subscription-plan estimate; that inference no longer holds (see *Why the plan estimate is retired*) and must not be presented. It is **on-request only** — TPM does this ONLY when the operator asks, and never volunteers it.

## When to act

Act when the operator asks something like: "what plan am I on?", "estimate my plan", "usage check", "how much of my quota have I used?", "am I on Max?". Do NOT surface any of this proactively — not at session start, not mid-task, not in the boot trace. Silent until asked. For the plan questions specifically the honest answer is that Ghola cannot tell them: report the figures it does have and say why there is no estimate.

## Where the data comes from

The Ghola status line receives the harness usage payload and writes a small snapshot to **`~/.ghola/usage-state.json`** on every render, so it is effectively always current. Either renderer writes it — `scripts/ghola-statusline.mjs` (Node, used on both WSL and native Windows) or `scripts/ghola-statusline.sh` (the original, WSL-only) — to the same path, with the same shape. Read that file:

```json
{ "session_tokens": 142000, "context_pct": 62, "five_hour_pct": 41, "updated": 1752600000 }
```

- `session_tokens` — **not cumulative, despite the name.** The value is `context_window.total_input_tokens` + `total_output_tokens`, and as of Claude Code **v2.1.132** (installed here: 2.1.220) that pair reports the size of the **current context window**, not a running total for the session: it drops when a compaction clears the window and it plateaus near the model's context ceiling instead of growing for the life of the session. The key name is a cross-module contract and stays as it is — read the key, not its name. `modules/tool.statusline/statusline.md` is the normative account of this field.
- `five_hour_pct` — percent of the 5-hour rolling window consumed (the status line's `5h` segment).
- `context_pct` — percent of the context window in use, from `context_window.used_percentage`.
- `updated` — epoch seconds of the last status-line render.

If the file is missing, unreadable, or has `five_hour_pct` absent/0, the status line has not emitted rate-limit data yet (early in a session, or a non-Pro/Max account where the 5-hour block is not present). In that case, do NOT guess — tell the operator the 5-hour signal is not available yet and offer to have them read the `5h %` straight off their status line instead.

## Why the plan estimate is retired

The old procedure took `T` = `session_tokens` and `P` = `five_hour_pct`, computed an implied 5-hour quota `Q = T / (P / 100)`, and matched `Q` against `parameters.planBands` to name a plan. **Do not do that, and do not reconstruct it.** It rested entirely on `T` being a cumulative session total, and `T` is not: it is the current context-window size, so it is bounded by the model's context ceiling and it *falls* on every compaction, while `P` only ever rises as quota is spent. `Q` therefore **shrinks the more quota the operator consumes** — the formula names a smaller plan the longer the session runs. The error is unbounded and grows with session length, so it is not a fixed bias that a fudge factor could correct.

There is also nothing to substitute for `T`: the renderers read only `context_window.*` and `rate_limits.five_hour.used_percentage`, and none of those is a cumulative session token count. So the estimate is not merely mis-tuned, it has no input. **A confidently wrong plan is worse than no plan** — report the figures and say plainly that they do not identify a plan.

## What to report instead

1. **Read** `five_hour_pct`, `context_pct`, and `updated` from the state file. Check `updated` to confirm the snapshot is current.
2. **Report `five_hour_pct` as what it is** — the share of the 5-hour rolling window already consumed. This is a direct harness reading and is trustworthy.
3. **Report `context_pct` (and `session_tokens`, if you cite it) as the current context window only** — never as "tokens spent this session".
4. **If the question was about the plan, say Ghola cannot determine it.** The harness payload carries no per-plan quota and no cumulative session total, so there is nothing to infer from. Point the operator at their Claude account settings, which does know.

## Report format

Keep it short. State the 5-hour percentage, the context figures, and — when the question was about the plan — one sentence on why there is no estimate.

Example: *"You're at **41% of your 5-hour window**; the current context window is 62% full (~142k tokens). I can't tell you which plan that implies — the token figure the status line has is the size of the current context window, not a session total, so the old plan-estimate math no longer works. Your Claude account settings has the actual plan."*

## Caveats to always convey (concisely)

- **Never present a plan as read or estimated.** No band math, no reconstructed `Q`, no "looks like Max 5x". If the operator wants a guess anyway, the answer is still no: an estimate whose error grows with session length is not a guess, it is a wrong number with a confidence interval attached.
- **The 5-hour window is a SHARED pool** across Claude Code AND Claude chat, and across ALL sessions in the window — not just this one. `five_hour_pct` is honest about the pool; it is simply not attributable to this session, so do not describe it as "what this session has used".
- **`session_tokens` is not a spend figure.** It can go DOWN between two readings (a compaction cleared the window) and it stops climbing near the context ceiling. If the operator reads it as cumulative cost, correct them.
- **`parameters.planBands` is dead weight.** The bands existed only to be matched against `Q`, and there is no `Q` any more. The setting is still declared so a saved operator value is not orphaned, but nothing reads it — do not consult it, do not quote its numbers, and do not ask the operator to tune it.

## Calibration

There is nothing left to calibrate. If the operator tells you their plan, take it as ground truth for the rest of the session — but record it as something *they told you*, never as something Ghola measured, and do not "confirm" it against `planBands`.

## Hard rules

- On-request only; never proactive.
- Read-only: never write to `~/.ghola/usage-state.json` (the status line owns it) or to the work repo.
- **Never name a plan Ghola did not hear from the operator.** Report the figures, and state what they do not tell you.
