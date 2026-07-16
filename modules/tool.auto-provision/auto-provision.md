# Auto Provision

When this module is loaded, an agent that hits a wall because a CLI tool or package it needs is not installed may **install the missing tool and continue**, rather than silently working around its absence. This module authorizes the intent to provision; it does not change how installs execute. Every agent reads this same fragment; role-specific framing is collected at the end.

This module is **not proactive**. It does not fire at session start and it installs nothing on its own. It applies on-demand, exactly at the moment a task is blocked or degraded because a required tool is missing. With no such wall in flight, this module sits quietly.

## The capability

The scope is narrow and specific: **install a missing CLI tool or package that is genuinely required to complete the task in hand**, using the platform's package manager, so the work can proceed. Installing is the only mutation this module ever authorizes. It is not a license to manage, tidy, upgrade, or reshape the machine's toolchain — it exists solely to remove a missing-tool blocker from the task at hand.

The motivating anti-pattern this module exists to end: an agent needs `jq` to parse JSON, finds it missing, and falls back to hand-rolling the same work in `node`. When installing `jq` is the cleaner path, the agent installs `jq` and proceeds. The capability is **amorphic** — it applies whenever ANY task is blocked or degraded by ANY missing CLI tool or package, not just JSON work.

## The real execution gate

This module authorizes the *intent* to install. The **harness's own permission prompt on the state-changing install command remains the real gate** — the module never bypasses it. When the agent runs `sudo apt-get install -y <pkg>`, `npm install -g <pkg>`, `pipx install <pkg>`, or any other install command, the harness mediates that command exactly as it mediates any other state-changing command. This module changes what the agent is permitted to *intend*; it does not change what the harness permits to *run*. If the harness blocks or the user denies the install prompt, the agent does not route around it — it reports the block and falls back per the floor below.

## Detecting the right installer

Choose the installer that matches the platform and the kind of thing being installed, and prefer the **least-invasive** option that works:

- **System CLI tools on Debian/Ubuntu (including WSL — this repo runs in Remote-WSL):** `apt` / `apt-get`. Use `sudo apt-get install -y <pkg>` when a system package is the right mechanism. Prefer a package that installs without sudo where one genuinely exists, but a system tool from `apt` normally needs `sudo` and that is acceptable when it is the correct mechanism.
- **System CLI tools on macOS:** `brew install <pkg>` (no sudo; user-scoped by design).
- **Language-level packages:** use the language's own installer rather than a system package. Node: `npm install -g <pkg>` for a global CLI, or a project-local `npm install <pkg>` when the tool is a project dependency. Python: prefer `pipx install <tool>` for standalone CLIs, or `pip install --user <pkg>` for a user-local library — avoid a system-wide `pip install` that would need sudo and touch the system interpreter.
- **Least-invasive first:** where more than one mechanism works, prefer no-sudo / user-local (`brew`, `pipx`, `pip --user`, project-local `npm install`) over a system-wide install. Reach for `sudo apt-get` only when a system package genuinely is the right mechanism on the platform.

Detect what is actually available on the host (`command -v apt-get`, `command -v brew`, `command -v pipx`, etc.) rather than assuming; the correct installer depends on the platform you are actually on, not the platform you expect.

## Posture: `parameters.autonomy`

`parameters.autonomy` sets how the agent behaves when it hits a missing-tool wall. It has three values:

- **`autonomous`** (default): **install, then report.** When a task is blocked by a missing tool, the agent installs it (subject to the harness's permission prompt) and continues the task, then clearly reports WHAT it installed and WHY in its return to TPM / to the user. Under this posture the agent does NOT stop to ask first — the install proceeds and the report follows.
- **`propose`**: **name and wait.** The agent does NOT install first. It names the missing tool and the **exact install command** it would run, explains why the task needs it, and waits for approval before running anything. Nothing is installed until the user (via TPM) approves.
- **`allowlist`**: **listed tools are autonomous; everything else is propose.** Tools whose names appear in `parameters.allowlist` install freely, exactly as under `autonomous`. Any tool NOT in the allowlist falls back to the `propose` posture. Per the preamble's parameter-allowlist rule, the values in `parameters.allowlist` are the ONLY tools installable freely under this posture — do not default, infer, or substitute a tool that merely resembles a listed one. An unlisted tool is not forbidden; it simply requires a proposal.

`parameters.allowlist` is a comma-separated list of tool/package names (e.g. `jq, ripgrep, shellcheck`). It is authoritative ONLY when `parameters.autonomy` is `allowlist`; under `autonomous` and `propose` it is ignored. Match names as written — the allowlist gates the tool being installed, not the package name on any one platform, so use the listed name as the identity of the tool.

## Safety floor (hard, non-relaxable)

These rules are cumulative with every other module's rules and hard rules. They are NOT relaxed by any posture setting — not even `autonomous`. Where any other rule is stricter, the stricter rule wins.

- **Additive only.** Installing is the only mutation permitted. NEVER uninstall, downgrade, remove, replace, or reconfigure an existing tool or package. If a task seems to need a *different version* of an already-present tool, that is not this module's job — surface it, do not swap it.
- **Only to unblock the ACTUAL task.** No speculative, convenience, or "might be handy later" installs. The missing tool must be genuinely required by the work in hand right now.
- **Check first (idempotence).** Before installing, verify the tool is actually missing (`command -v <tool>`, `which <tool>`, or the language-ecosystem equivalent). If it is already present, use it — do NOT reinstall.
- **Verify after install.** After installing, confirm the tool now runs (e.g. `<tool> --version`), then resume the task. If the install fails, report the failure and fall back to the best available alternative rather than looping or retrying blindly.
- **Well-known tools only.** Install reputable, widely-used tooling from the platform's standard package manager. NEVER fetch-and-run arbitrary scripts from untrusted URLs to install (no `curl <unknown-url> | bash` and the like). If a tool is only installable that way from an untrusted source, do not install it — surface it instead.
- **Never to dodge a guardrail.** Installing a tool must NEVER be a way to bypass another module's allowlist or a safety floor. Do NOT install a second `git` or `gh` client to route around `tool.git` / `tool.github` allowlists; do NOT install a tool to reach secrets or to circumvent any restriction another module imposes. This module never relaxes another module's rules.
- **No secrets.** Never install in a way that logs or echoes credentials, and never pass a token or secret on an install command line.
- **Report every install.** Record each install in the standard return so there is an audit trail: the tool, its version if easy to capture, the exact command run, and why the task needed it.

## Module-disabled vs feature-disabled

These are distinct states and must produce distinct behavior:

- **Module disabled** (no `tool.auto-provision` in the Session Manifest): the agent has no sanctioned capability to install missing tools. It works around the absence within the existing hard rules and surfaces the missing tool to TPM / the user; it does not install on its own initiative.
- **Module enabled, `parameters.autonomy` = `autonomous`** (default): the agent installs a genuinely-required missing tool and continues, then reports it. Subject to the full safety floor and the harness's permission prompt.
- **Module enabled, `parameters.autonomy` = `propose`**: the agent never installs first; it names the tool and exact command and waits for approval.
- **Module enabled, `parameters.autonomy` = `allowlist`**: a tool named in `parameters.allowlist` installs freely; any other tool falls back to `propose`.

Do not merge these cases.

## Role-Specific Notes

The body above applies identically to every agent. The notes below are short framings for how each role uses the capability.

### SWE

You are the primary actor here — you run the task commands and you are where the missing-tool wall is usually hit. When a required tool is missing: check-first that it is genuinely absent, install it per `parameters.autonomy` (autonomously and then reporting, or by proposing and waiting), verify it runs, resume the task, and report every install to TPM (tool, version, exact command, why). Do NOT silently work around a missing tool when installing it is the cleaner path — the `jq`-falls-back-to-`node` pattern is exactly the anti-pattern this module exists to end. The safety floor is absolute: additive-only, task-scoped, well-known tools, never to dodge another module's guardrail.

### QA

You may install a tool you need to VERIFY a change — a linter, a formatter, a test runner the task's verification genuinely requires — under the exact same floor: check-first, additive-only, task-scoped, verify-after, well-known tools only, and never to route around a guardrail. Report any install in your verdict alongside the finding it supported, so the audit trail is complete. Installing a verification tool does not widen your review scope; it only lets you check what you were already reviewing.

### TPM

You do not usually run task tooling yourself, but you coordinate and you own the audit trail to the user. Surface to the user what SWE or QA installed and why, so provisioning is always visible. Honor the `parameters.autonomy` posture: under `propose` (and for unlisted tools under `allowlist`), relay the agent's proposal — the named tool and exact command — to the user and wait for approval before authorizing the install; under `autonomous` (and for listed tools under `allowlist`), let the install proceed and report it after. Never let an install be used to bypass another module's guardrail, and reject any provisioning that is speculative rather than needed by the task in hand.
