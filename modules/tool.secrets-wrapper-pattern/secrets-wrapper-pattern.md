# Secrets Wrapper Pattern

When this module is loaded, the session has a single project-wide convention for handling credentials: agents NEVER read secrets directly. Secrets live in wrapper scripts that source the credential at call time and never expose the value in their output. The rule was previously inlined in the cores' hard rules ("NEVER read or echo secrets" — covering `*_TOKEN`, `*_SECRET`, `*_KEY`, `*_PASSWORD` env vars and the SWT secrets file); this module promotes it to a single configurable policy and adds an approved-wrappers registry. Every agent reads this same fragment; TPM orchestrates wrapper invocation, SWE invokes the wrappers, and QA verifies no secrets were read or echoed.

This module is **not proactive**. It does not fire at session start. The rule applies on-demand, exactly when an agent is about to access a secret-protected resource — for example, when a task requires a Bitbucket REST call, a database query, or any other action that would otherwise involve reading an env var or credentials file. Without such an action pending, this module sits quietly.

## The core pattern

Agents NEVER read secrets directly. Wrapper scripts own the secret-handling boundary. A wrapper script sources the credential at call time (from an env var, a config file, or the SWT secrets file) and constructs the authenticated action internally; the agent invokes the wrapper with non-secret arguments and reads back non-secret output. The credential never enters the agent's tool result, prompt, return message, or any downstream artifact.

Three concrete examples from the existing ecosystem:

- **`bb-curl.sh`** — Bitbucket REST wrapper. Sources `BITBUCKET_TOKEN` from the SWT secrets file at call time and constructs the `Authorization: Bearer <token>` header internally. The agent invokes it with the REST path and method (e.g. `bb-curl.sh GET /pullrequests/123`) and reads back the response body; the token is never exposed in stdout, stderr, or the agent's tool result.
- **`lprun-query.sh`** — Database query wrapper. Reads the connection details from `swt_settings.json` and runs the query via `lprun8`. The agent invokes it with a connection name and a SELECT statement; the agent never sees connection strings, server names, or credentials.
- **`clipboard-read.ps1`** — Windows clipboard helper. Reads the clipboard image into a temp file and prints the path. No secrets are involved here, but the pattern is the same: wrapper owns the action, agent owns the orchestration. Listed in `approvedWrappers` for consistency.

The shape is always: agent supplies non-secret arguments, wrapper supplies the secret internally, wrapper returns non-secret output.

## What the rule forbids

When `parameters.enforcePattern` is true, the following actions are forbidden:

- Reading env vars whose name matches any pattern in `parameters.secretEnvPatterns` (e.g. `BITBUCKET_TOKEN`, `OPENAI_API_KEY`, `DB_PASSWORD`). The patterns are glob-matched case-insensitively against env var names.
- Reading files whose path matches any entry in `parameters.secretFilePaths` (e.g. `${SWT_SECRETS_PATH}`, `~/.aws/credentials`, `~/.ssh/id_rsa`). Environment variables in entries are expanded at runtime.
- Echoing, logging, or including in any agent output (return message, SWE assignment, QA verdict, Obsidian note, file write) the value of any matched env var or the contents of any matched file.
- Constructing raw `Authorization` headers or other credential-bearing values directly in shell commands, HTTP requests, or source files.

The prohibition applies regardless of intent. A debug `echo $BITBUCKET_TOKEN` is forbidden even when the agent is "just checking"; a `cat ~/.aws/credentials` is forbidden even when the agent is "just confirming the file exists."

## What the rule permits

- Invoking approved wrappers from `parameters.approvedWrappers` with non-secret arguments. The wrapper handles the secret internally.
- Reading env vars whose names do NOT match any pattern in `parameters.secretEnvPatterns` (e.g. `PATH`, `HOME`, `SWT_DIR`). The patterns must match for the prohibition to apply.
- Reading files whose paths do NOT match any entry in `parameters.secretFilePaths`. Most project files, configs, and source code are fair game.
- Discussing the existence of a secret without echoing the value (e.g. "the Bitbucket token is set in `${SWT_SECRETS_PATH}` — invoke `bb-curl.sh` to use it").
- Asking TPM to add a wrapper if a task requires accessing a secret-protected resource that no approved wrapper currently covers.

## Violation handling

The behavior on a forbidden action is determined by `parameters.onViolation`:

- **`refuse`** (default): the agent refuses and surfaces "Refusing to read `<SECRET_NAME>` — `secrets-wrapper-pattern` is enforced; use the approved wrapper instead." If a wrapper in `parameters.approvedWrappers` covers the relevant resource, the agent names it in the refusal ("invoke `${SWT_DIR}/scripts/bb-curl.sh` for Bitbucket REST calls"). If no wrapper covers the resource, the agent reports the gap and asks TPM whether to add one or relax the pattern.
- **`log-only`**: the agent proceeds with the action but emits a warning visible in the return ("Warning: read env var `BITBUCKET_TOKEN` directly; `secrets-wrapper-pattern` is set to log-only. Consider invoking the approved wrapper instead."). Useful in trusted-but-noisy environments where the user wants awareness without friction.
- **`ask`**: the agent prompts the user to confirm before proceeding. The user can lower the rule, edit the patterns, or allow the action for the single occurrence.

`refuse` is the safest default and the recommended posture for any environment where credentials actually grant production access.

## Relationship to existing module sections

The cores (`core.tpm`, `core.swe`, `core.qa`) inline a "NEVER read or echo secrets" hard rule that covers `*_TOKEN`, `*_SECRET`, `*_KEY`, `*_PASSWORD` env vars and the SWT secrets file. With this module loaded:

- The cores' inline rules become AUTHORITATIVE-RECEIVER for the policy this module defines — they continue to articulate the floor, but the configurable settings here (`parameters.secretEnvPatterns`, `parameters.secretFilePaths`, `parameters.approvedWrappers`, `parameters.onViolation`) take precedence for the specifics.
- When this module is DISABLED, the cores' inline rules act as the fallback. The basic NEVER-READ-SECRETS posture is preserved but the registry and configurability are lost.
- When this module is ENABLED, the cores' inline rules defer to this module's exact settings for pattern coverage, wrapper registry, and violation handling.

This module does NOT modify the cores; the deference is by convention. Future cleanup may prune the inline rules once this module is the established norm, but that is a separate concern — the inline rules stay in place as the safety net until then.

## Module-disabled vs feature-disabled

These are distinct states and must produce distinct behavior:

- **Module disabled** (no `tool.secrets-wrapper-pattern` in the Session Manifest): the cores' inline hard rules act as fallback. Agents still refuse to read or echo `*_TOKEN`, `*_SECRET`, `*_KEY`, `*_PASSWORD` env vars and the SWT secrets file, but the pattern set is fixed, the wrapper registry is unavailable, and the violation behavior is hardcoded refuse.
- **Module enabled, `parameters.enforcePattern` off**: the rule is informational only. Agents may read secrets directly. NOT recommended outside fully-controlled environments.
- **Module enabled, secret pattern matches but no approved wrapper exists for the resource**: the agent refuses and surfaces the gap to TPM ("`BITBUCKET_TOKEN` is enforced as a secret, but no wrapper in `approvedWrappers` covers Bitbucket. Add a wrapper or relax the pattern."). The agent does NOT proceed by reading the secret directly even though no wrapper is registered.

Do not merge these cases.

## Role-Specific Notes

The body above applies identically to every agent. The notes below are short framings for how each role uses the policy.

### TPM

You enforce this pattern across all agents. When dispatching a SWE that needs to access a secret-protected resource, name the wrapper script explicitly in the assignment ("use `${SWT_DIR}/scripts/bb-curl.sh` to make the Bitbucket call" or "use `${SWT_DIR}/scripts/lprun-query.sh` against connection `<name>` for the query"). NEVER include raw tokens, passwords, or credential values in assignments — if you find yourself wanting to paste a value, stop and reroute through the wrapper. If a task requires a resource for which no approved wrapper exists, surface the gap to the user before dispatching: either add a wrapper to `parameters.approvedWrappers` or accept that the task cannot proceed under the current configuration.

### SWE

Your work involves invoking wrappers, never reading secrets. When TPM names a wrapper in your assignment, invoke it via the Bash tool with the documented arguments. NEVER read the SWT secrets file, NEVER echo env var values matching `parameters.secretEnvPatterns`, NEVER paste a credential into a source file or command. If you find yourself wanting to construct a raw `Authorization` header, a connection string, or any credential-bearing value directly — stop and ask TPM for the wrapper. If no wrapper covers your task, refuse and surface to TPM rather than improvising. The per-invocation check is yours to do: at the moment you are about to read a file or env var, compare against `parameters.secretFilePaths` and `parameters.secretEnvPatterns` and refuse if either matches.

### QA

When reviewing a SWE's work, confirm no secrets were read or echoed. If you spot a `git diff` showing a token, env var value, connection string, or credential in any file the SWE added or modified, flag it as a FAIL-level finding regardless of intent — the secrets-wrapper-pattern exists precisely to prevent that, and a clean functional change does not redeem a leaked credential. Confirm that any secret-protected action in the SWE's return was performed via an approved wrapper from `parameters.approvedWrappers`; an action that touched a credential without going through a wrapper is at minimum `FAIL` and warrants surfacing to the user immediately.
