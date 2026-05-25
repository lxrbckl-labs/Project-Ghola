# Docker

When this module is loaded, the work repo is treated as one that uses Docker. This module grants `docker` CLI capability (including `docker compose` subcommands) through a configurable allowlist and applies built-in protections for Dockerfile and docker-compose.yml on top of the universal hard rules — they extend them, they never relax them. Every agent reads this same fragment; role-specific framing is collected at the end.

Per the preamble's parameter-allowlist rule, the values in `parameters.allowedCommands` are the only authorized docker subcommands for this session. The full vocabulary is documented in `allowed-commands-keywords.json` in this module's root. Read it for context, but never invoke a subcommand that isn't actually present in the parameter.

## Configurable: docker command allowlist

`parameters.allowedCommands` is a comma-separated list of subcommands the agents may invoke as `docker <name>`. Parsing rules:

- Comma-separated. Whitespace around each entry is trimmed. Case is folded to lowercase.
- Each entry is the subcommand only — `ps`, not `docker ps`. A leading `docker ` token, if present, is stripped before comparison. Entries may be multi-word (e.g. `compose up`, `compose down`) — these match the full token after `docker ` (so `docker compose up` is allowed if and only if `compose up` is in the list).
- Order does not matter.
- Duplicates are deduplicated silently.
- An empty string (the default) means **no** `docker` commands are allowed — every `docker` invocation is refused. When the Session Manifest renders `parameters: (defaults)` instead of an explicit value, the default applies — treat it the same as an empty string: no docker commands are allowed.
- The allowlist is **not** validated against a hardcoded master list of known subcommands. Whatever the user types in is trusted verbatim. If they list `whoami`, then `docker whoami` is permitted by this module even though it is not a real subcommand. The user owns the contents of the list.

When an agent is about to run `docker <X>`:

1. Parse `parameters.allowedCommands` into a normalized set.
2. If the set is empty, refuse with: "Cannot run `docker <X>` — this module's `allowedCommands` is empty, so all docker CLI invocations are refused. Set a value in the Modules tab or run the command manually."
3. If the set is non-empty and `X` (lowercased, trimmed) is not in it, refuse with: "Cannot run `docker <X>` — `<X>` is not in this module's `allowedCommands`."
4. If `X` is in the set, proceed. Surface the run in the agent's return so TPM has an audit trail.

Common safe values to consider: `ps, images, logs, inspect, compose ps, compose logs` — read-only or inspection-friendly. Use-with-caution subcommands: `build` (writes to the local image store), `run` (may attach volumes, networks, and ports with side effects), `exec` (executes inside a live container), `compose up` / `compose down` (start or tear down a multi-service stack). Destructive subcommands worth omitting unless the user deliberately enables them: `rm` (removes a container), `rmi` (removes a local image), `push` (writes to a remote registry).

### Keywords file

Every keyword listed in `allowed-commands-keywords.json` is documented for your reference — but only the keywords ACTUALLY PRESENT in `parameters.allowedCommands` are authorized for this session. The full table exists so you can tell the user what to enable when a task would require a subcommand they haven't included (e.g. "this needs `docker build` — add `build` to `allowedCommands` in the Modules tab"). Never silently use a subcommand that isn't in the parameter, even if it appears in the keywords file.

## WSL Engine Setup

When the user is on WSL2 Ubuntu, Docker Engine setup is non-trivial — and native Docker Engine is recommended over Docker Desktop for performance and resource control. This section gives TPM the playbook to walk a user through a native install when no `docker` binary is reachable. It is informational guidance only: the user runs every command.

### Detection

`parameters.engineSocketCheck` triggers a one-time probe (e.g. `test -S /var/run/docker.sock`, or a reachability check against the user's `DOCKER_HOST`) before the first `docker` invocation of the session. If the socket is unreachable AND `parameters.wslEngineGuide` is true, TPM surfaces the install steps below before assigning any docker-touching work. If the socket is reachable, TPM proceeds normally and does not bring up the guide.

### Install guide (WSL2 Ubuntu, native Docker Engine)

Walk the user through these steps in order. The user runs each command; the agent never runs them on the user's behalf.

1. Update the apt index and install prerequisites: `sudo apt-get update && sudo apt-get install -y ca-certificates curl gnupg`.
2. Add Docker's official GPG key (per Docker's published install instructions for the user's Ubuntu release).
3. Add the Docker repo to apt sources (per Docker's published install instructions for the user's Ubuntu release and architecture).
4. Install Docker Engine, the CLI, containerd, and the buildx and compose plugins: `sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin`.
5. Start the daemon: `sudo service docker start` (or `sudo systemctl start docker` on WSL2 with systemd enabled).
6. Add the current user to the `docker` group to avoid `sudo` per command: `sudo usermod -aG docker $USER`. A new shell is required after this for the group membership to take effect.
7. Verify with `docker ps`. Note that `docker ps` is allowlist-gated per `parameters.allowedCommands` if this module's allowlist enforcement is active — if `ps` isn't on the allowlist, the user runs it manually as a one-off verification step.

### Why native over Docker Desktop

Native Docker Engine on WSL2 Ubuntu avoids the VM-in-VM overhead of Docker Desktop (which itself runs a Linux VM that WSL2 already provides), gives the user direct resource control without the Desktop daemon's overhead, sidesteps Docker Desktop's commercial-use licensing trap, and plays cleaner with WSL2's native Linux filesystem.

### What this guide does NOT do

- Does NOT actually install Docker — TPM walks the user through; the user runs every command.
- Does NOT modify system configuration (sudoers, group memberships, apt sources, daemon config) on the user's behalf.
- Does NOT detect Docker Desktop's presence and warn against it — this guidance is informational only.

## Always-applied protections (regardless of allowlist)

These protections apply whether or not the allowlist is populated. They are about file edits, not CLI invocations, and the allowlist setting has no effect on them.

### Dockerfile — never modify without explicit user approval

- `Dockerfile` and any `Dockerfile.*` variant — never modify without explicit user approval. Flag any planned edit to TPM **before** making it. Changes here affect every image build and every downstream deployment that consumes the image — base-image bumps, layer reordering, and `RUN` / `COPY` edits can silently change runtime behavior, image size, or which secrets bake into a layer.

### docker-compose.yml — never modify environment-shaped values

- `docker-compose.yml`, `compose.yml`, and any `docker-compose.*.yml` variant (e.g. `docker-compose.override.yml`, `docker-compose.prod.yml`) — never modify environment-variable values, port mappings, volume mounts, image tags, or service definitions without explicit user approval. Flag the intended change to TPM first. Adding a brand-new service to an empty section can be acceptable when the task plainly calls for it, but call it out in the return.

### .dockerignore — flag before changing

- `.dockerignore` — flag the intended change to TPM **before** making it. This file controls the build context size and which files ship into the image; inadvertently including secrets or excluding required files can break the build or leak credentials.

If TPM's assignment explicitly authorizes one of these edits, proceed and call it out in the one-sentence explanation.

## Module-disabled vs allowlist-empty

These are distinct failure modes and must use distinct messages:

- **Module disabled** (no `tool.docker` in the Session Manifest): the universal hard rules apply with no docker-specific protections — there is no allowlist to consult, and the agent should follow whatever the universal posture is for CLI invocations. Surface to TPM that the module is not loaded if the user appears to expect docker-aware behavior.
- **Module enabled but `allowedCommands` empty**: see the refusal message above. The agent must refuse every `docker` invocation while still applying the always-on file guardrails.
- **Module enabled but `wslEngineGuide` off**: TPM does not surface the WSL Engine Setup install steps when the socket is unreachable; the user is on their own to install Docker. The allowlist and always-on file guardrails are unaffected.
- **Module enabled but `engineSocketCheck` off**: TPM skips the one-time socket probe; the first `docker` invocation fails directly if Docker isn't running. The allowlist and always-on file guardrails are unaffected.

Do not merge these cases.

## Role-Specific Notes

The body above applies identically to every agent. The notes below are short framings for how each role uses the policy.

### TPM

You are the policy-bearer for the allowlist: read `parameters.allowedCommands` and decide what to assign. If the list is empty, do not hand a SWE a task whose verification implies running `docker build` or `docker compose up` without telling the user — surface that the run will need to happen manually. When dispatching SWE into this codebase, name the allowlist in the assignment ("SWE-1 may run `docker ps` and `docker logs`; everything else is refused"). The always-on file guardrails will already be carried by the SWE's own copy of this module — you do not need to repeat them in the assignment text. When on WSL and the engine socket isn't reachable AND `parameters.wslEngineGuide` is true, surface the install steps from the WSL Engine Setup section before the first docker invocation.

### SWE

You are the one who actually runs the commands, so the per-command allowlist check is yours to do — don't batch-check a whole task up front, check each `docker` invocation at the moment you're about to run it. Restate the allowlist you understand to be in effect in your return ("`allowedCommands` was `ps, logs`; I ran `docker ps` and `docker logs`; I did not run `docker build` because it was not on the list, and I am surfacing that to TPM"). If a task seems to require a `docker` subcommand not on the allowlist, refuse and report — do not work around it by shelling out to the underlying daemon, scripting the engine API directly, or any other equivalent. The always-on file guardrails apply to every edit; flag `Dockerfile`, `docker-compose.yml` (including `compose.yml` and `docker-compose.*.yml` variants), and `.dockerignore` touches in your one-sentence explanation. The WSL Engine Setup guide is TPM's to surface — no behavior change for you; you still check the allowlist per invocation.

### QA

Treat `docker` invocations and always-on guardrail breaches as findings in the review. If the SWE ran a `docker` subcommand, confirm it was on the allowlist and that the SWE surfaced the run in the return. If the SWE modified a `Dockerfile`, `docker-compose.yml` / `compose.yml` / `docker-compose.*.yml`, or `.dockerignore` without surfacing it in the one-sentence explanation, that is at minimum `PASS WITH NOTES` and likely `FAIL` if it appears unintentional — these files affect every image build and every deployment that consumes them, and visibility is the point. The WSL Engine Setup guide is informational; no behavior change for you.
