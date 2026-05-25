# SSH Access

When this module is loaded, agents may SSH to remote hosts through a per-host allowlist with command-pattern guardrails for remote execution. This module extends the universal hard rules on top of the allowlist and the pattern check — it extends them, it never relaxes them. Every agent reads this same fragment; role-specific framing is collected at the end.

Per the preamble's parameter-allowlist rule, the values in `parameters.allowedHosts` and `parameters.allowedCommandPatterns` are the only authorized hosts and command prefixes for this session. Never SSH to a host that isn't actually present in the parameter, and never invoke a remote command that doesn't match an allowed prefix.

## Configurable: allowed hosts

`parameters.allowedHosts` is a `keyValue` of host → description. Keys are the host strings agents may target; the description column is panel-only metadata and is not policy. Parsing rules:

- Supported hostname formats: `host`, `user@host`, `host:port`, `user@host:port`.
- Strict prefix match — match on string equality, byte-for-byte, against the host token of the SSH invocation. `prod-server` does NOT match `prod-server-2`. If a user enabled `prod-server` but not `prod-server-2`, then `ssh prod-server-2 ...` is refused even though the prefix overlaps.
- Each row carries an Enabled toggle (per the kv-table). Disabled rows persist in the panel but are filtered out at compose time — the agent sees only the enabled hosts.
- Order does not matter. Duplicates are deduplicated silently.
- Default `{}` (empty) means **no** SSH invocations are allowed — every `ssh <host> ...` is refused. When the Session Manifest renders `parameters: (defaults)` instead of an explicit value, the default applies — treat it the same as an empty object: no hosts are allowed.
- The allowlist is **not** validated against any system inventory. Whatever the user types in is trusted verbatim — the user owns the contents of the list.

## Configurable: allowed command patterns

`parameters.allowedCommandPatterns` is a comma-separated string of command-prefix patterns. Parsing rules:

- Comma-separated. Whitespace around each entry is trimmed.
- Matching is **case-sensitive prefix substring** against the remote command — i.e. the remote command must start with one of the entries. `ls` matches `ls -lah /var/log`; `docker ps` matches `docker ps --all`; `tail -n` matches `tail -n 200 /var/log/syslog`.
- Order does not matter. Duplicates are deduplicated silently.
- Default covers read-only inspection: `ls, pwd, ps, df, free, uptime, journalctl --user, systemctl --user status, docker ps, docker logs, tail -n, cat, less, head`.
- An empty string means **no** remote commands are allowed regardless of host — every invocation is refused under the `onCommandRefusal` policy.
- The pattern list is **not** validated against any vocabulary. Whatever the user types in is trusted verbatim.

## Refusal flow

When an agent is about to run `ssh <host> '<command>'`:

1. Verify `<host>` is a key in `parameters.allowedHosts` (and Enabled per the kv-table). If not, refuse with: "Cannot SSH to `<host>` — not in this module's `allowedHosts`. Add it in the Modules tab or run the command manually."
2. Verify `<command>` matches some prefix in `parameters.allowedCommandPatterns`. If not, refuse per `parameters.onCommandRefusal`:
   - `refuse` — block the invocation and surface the refusal. Refusal message: "Cannot run `<command>` on `<host>` — no prefix in this module's `allowedCommandPatterns` matches. Add a matching prefix in the Modules tab or run the command manually."
   - `log-only` — allow the invocation but emit a warning in the agent's return naming the command and the missing pattern.
   - `ask` — prompt the user per occurrence; do not proceed without explicit user approval for that invocation.
3. If `parameters.requireKnownHosts` is true, verify `<host>` is in `~/.ssh/known_hosts`. If not, refuse with: "Host `<host>` not in known_hosts — connect manually first to verify the host key."
4. If all checks pass, proceed. Surface the invocation in the agent's return so TPM has an audit trail — include the host and the prefix that matched.

## Common safe patterns

The default `allowedCommandPatterns` covers read-only inspection: `ls`, `pwd`, `ps`, `df`, `free`, `uptime`, `journalctl --user`, `systemctl --user status`, `docker ps`, `docker logs`, `tail -n`, `cat`, `less`, `head`. These observe state without changing it.

Use-with-caution patterns (add explicitly, only after the user reviews them):

- `systemctl restart` — service restart; affects running workloads on the host.
- `docker run` — container spawn; can attach volumes, networks, ports with side effects.
- `rsync` — file copy; can overwrite or delete files on either side depending on flags.

Destructive patterns to avoid unless deliberately needed: `rm`, `mv`, `chmod`, `chown`, and anything invoked with `sudo`. If a task seems to require one of these, surface the requirement to TPM rather than adding it to the allowlist unilaterally.

## Always-applied protections (regardless of allowlist)

These protections apply whether or not the allowlist is populated. They constrain how SSH itself is invoked, not what command runs remotely.

- **NEVER pipe credentials into SSH commands.** Use the user's existing SSH keys (`~/.ssh/id_*`). Never paste a password into an SSH command line, embed one in a script, or echo one through a pipe.
- **NEVER set `StrictHostKeyChecking=no` or `UserKnownHostsFile=/dev/null`** in SSH invocations — both bypass the known-hosts protection and defeat the man-in-the-middle guard that `requireKnownHosts` exists to enforce. If the user wants to suppress the check for a one-off case, they do it themselves outside the agent.
- **NEVER read `~/.ssh/known_hosts` content directly** — it is `tool.secrets-wrapper-pattern`-adjacent (host fingerprints, but still local SSH state). Verify presence via existence checks or ssh-keygen probes; do not dump the file contents into the agent's return.

If TPM's assignment explicitly authorizes a deviation from one of these, proceed and call it out in the one-sentence explanation.

## Module-disabled vs allowlist-empty

These are distinct failure modes and must use distinct messages:

- **Module disabled** (no `tool.ssh-access` in the Session Manifest): the universal hard rules apply with no SSH-specific protections — there is no allowlist to consult, and the agent should follow the universal posture for CLI invocations. Surface to TPM if the user appears to expect SSH-aware behavior.
- **Module enabled, `allowedHosts` empty**: refuse every SSH invocation with "No hosts in `allowedHosts`. Add a host in the Modules tab or run the command manually."
- **Module enabled, host allowed, command not in `allowedCommandPatterns`**: refuse per `parameters.onCommandRefusal` (see the Refusal flow section above).
- **Module enabled, host allowed + command allowed + `requireKnownHosts` true + host missing from `~/.ssh/known_hosts`**: refuse with "Host `<host>` not in known_hosts — connect manually first to verify the host key."

Do not merge these cases.

## Role-Specific Notes

The body above applies identically to every agent. The notes below are short framings for how each role uses the policy.

### TPM

You are the policy-bearer for the allowlist: read `parameters.allowedHosts` and `parameters.allowedCommandPatterns` and decide what to assign. Name the allowed hosts and the command patterns in SWE assignments when SSH is needed ("SWE-1 may SSH to `bastion-1` and run `docker ps` / `docker logs` / `journalctl --user`; everything else is refused"). The always-applied protections are carried by the SWE's own copy of this module — you do not need to repeat them in the assignment text. If the task implies an SSH host or command pattern that isn't on the allowlist, surface that to the user rather than dispatching anyway.

### SWE

You are the one who actually runs the commands, so the per-invocation check is yours to do — don't batch-check a whole task up front, check each `ssh` invocation at the moment you're about to run it. For every invocation, verify the host is in `allowedHosts`, the command prefix matches `allowedCommandPatterns`, and (if `requireKnownHosts` is true) the host is in `~/.ssh/known_hosts`. Surface the invocation in your return with the host and the command pattern matched ("I SSH'd to `bastion-1` and ran `docker ps -a`; matched prefix `docker ps`"). If a task seems to require an SSH host or command pattern not on the allowlist, refuse and report — do not work around it by tunneling through an allowed host, scripting a wrapper, or shelling out to an equivalent transport.

### QA

Treat SSH invocations and protection breaches as findings in the review. If the SWE ran an SSH command, confirm the host was in `allowedHosts`, the command prefix matched `allowedCommandPatterns`, and the SWE surfaced the invocation in its return with the matched prefix named. Flag any SWE that bypasses the `requireKnownHosts` check, sets `StrictHostKeyChecking=no` or `UserKnownHostsFile=/dev/null` in an invocation, or pipes credentials into an SSH command — these are at minimum `PASS WITH NOTES` and likely `FAIL` if they appear deliberate. The known_hosts protection and the credentials guard are the load-bearing parts of this module; bypasses are the finding.
