# Claude Usage Observer (on-request plan estimator)

This module lets TPM estimate which Claude subscription plan the operator is likely on, by comparing their session token usage against the 5-hour rolling-window percentage the Ghola status line reports. It is **on-request only** — TPM does this ONLY when the operator asks, and never volunteers it.

## When to act

Act when the operator asks something like: "what plan am I on?", "estimate my plan", "usage check", "how much of my quota have I used?", "am I on Max?". Do NOT surface any of this proactively — not at session start, not mid-task, not in the boot trace. Silent until asked.

## Where the data comes from

The Ghola status line (`scripts/ghola-statusline.sh`) receives the harness usage payload and writes a small snapshot to **`~/.ghola/usage-state.json`** on every render, so it is effectively always current. Read that file:

```json
{ "session_tokens": 142000, "context_pct": 62, "five_hour_pct": 41, "updated": 1752600000 }
```

- `session_tokens` — cumulative input+output tokens for THIS session (the status line's token segment, un-abbreviated).
- `five_hour_pct` — percent of the 5-hour rolling window consumed (the status line's `5h` segment).
- `context_pct` — percent of the context window in use (not needed for plan estimation; informational).
- `updated` — epoch seconds of the last status-line render.

If the file is missing, unreadable, or has `five_hour_pct` absent/0, the status line has not emitted rate-limit data yet (early in a session, or a non-Pro/Max account where the 5-hour block is not present). In that case, do NOT guess — tell the operator the 5-hour signal is not available yet and offer to have them read the two numbers (tokens and `5h %`) straight off their status line instead.

## How to estimate

1. **Read** `session_tokens` (T) and `five_hour_pct` (P) from the state file.
2. **Guard:** if P is missing or 0, stop and explain (per above) — dividing by zero/near-zero has no signal.
3. **Implied 5-hour quota:** `Q = T / (P / 100)`. Example: 142,000 tokens at 41% → `Q ≈ 346,000` tokens per 5-hour window.
4. **Name the plan:** compare Q against `parameters.planBands` (plan name → approximate 5h token quota) and report the CLOSEST band. Lean on the multiplier structure — Max 5x ≈ 5x Pro, Max 20x ≈ 20x Pro — which is the reliable part; the absolute anchors are estimates.
5. **Confidence:** higher P = more signal (a large denominator is stable); a very small P (e.g. 1–3%) amplifies error badly, so report low confidence and say so.

## Report format

Keep it short. State: the estimated plan, the implied 5-hour quota Q, and the observed inputs (T and P). Then the caveats that matter, briefly.

Example: *"Rough estimate: you look like **Max 5x**. This session used ~142k tokens, which registered as 41% of your 5-hour window → an implied ~346k-token 5-hour budget. That's closest to the Max 5x band. Low-to-moderate confidence — see caveats."*

## Caveats to always convey (concisely)

- **It is an estimate, not a reading.** Anthropic does not publish per-plan token limits; the bands are best-effort anchors. The multiplier (5x / 20x vs Pro) is the dependable structure.
- **The 5-hour window is a SHARED pool** across Claude Code AND Claude chat, and across ALL sessions in the window — not just this one. So if the operator has used other sessions or the chat app in the last 5 hours, `session_tokens` is only PART of what drove `five_hour_pct`, which makes the implied Q an **under**estimate (and can under-call the plan). The estimate is sharpest when the window is fresh and this session dominates it.
- **Small-percentage noise:** at low `five_hour_pct` the division magnifies rounding error; treat early-session estimates as loose.

## Calibration

If the operator tells you their actual plan, use it: note that their observed Q corresponds to that plan, and suggest they update `parameters.planBands` so future estimates land on the right tier. You may also refine on the fly within a session — if the operator says "I'm on Max 20x," take that as ground truth over the band math for the rest of the session.

## Hard rules

- On-request only; never proactive.
- Read-only: never write to `~/.ghola/usage-state.json` (the status line owns it) or to the work repo.
- Never present the estimate as an authoritative account reading — always frame it as an estimate with the shared-pool caveat.
