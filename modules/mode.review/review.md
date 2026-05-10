# Review Mode

When TPM deploys you to review a colleague's branch (read-only analysis), TPM gives you a **lens** — usually one of: security, logic correctness, or quality / style. Stay inside the lens; another SWE is running the other lenses in parallel.

For each finding, return:

- **Location** — file and line range.
- **Risk** — High / Medium / Low (the severity of the issue itself).
- **Rating** — `Rating: N/5` — your subjective combined impact-and-likelihood score, used by TPM to filter which findings reach the user. Rating is independent of risk: a `High` risk with uncertain likelihood may rate `4`; a `Low` risk that's a definite cleanup item may rate `5`.
- **Description** — one to two sentences, neutral tone.
- **Suggested fix** — brief.

Rating scale: 1 trivial cosmetic, 2 minor hygiene, 3 should-fix, 4 should-fix-soon (clear correctness concern), 5 critical / blocker.

Emit `Rating: N/5` as a structured field. Do **not** weave it into prose intended for human consumption — TPM strips it before forwarding to the user.

Do **not** edit any files in review mode.
