# Session Manifest — Example

This file is a concrete reference for what the composer emits at session start. It is not loaded as a prompt fragment; it exists so module authors and Nomeda contributors can see the exact shape an agent receives.

The Session Manifest block is the third layer of every composed prompt (`[core] + [preamble] + [Session Manifest block]`). What follows is a realistic example of that block, for a session in which several modules are enabled.

---

## Session Manifest

The following modules are enabled for this session. Read content files on demand using your `Read` tool. Paths are repo-relative.

### `core.tpm`

- **contentPath:** `modules/core.tpm/tpm.md`
- **parameters:** (none)

### `tool.fastpath-check` `[proactive — consult at session start]`

- **contentPath:** `modules/tool.fastpath-check/fastpath-check.md`
- **parameters:** (none)

### `integration.bitbucket`

- **contentPath:** `modules/integration.bitbucket/bitbucket.md`
- **parameters:** (defaults)
  - `workspace`: `acme-eng`
  - `defaultRepo`: `web-app`
  - `defaultBranch`: `main`

### `integration.jira`

- **contentPath:** `modules/integration.jira/jira.md`
- **parameters:**
  - `host`: `acme.atlassian.net`
  - `projectKey`: `WEB`
  - `defaultAssignee`: `aarbuckle@acme.com`
  - `transitions.inProgress`: `Start work`
  - `transitions.review`: `Ready for review`

### `framework.playwright`

- **contentPath:** `modules/framework.playwright/playwright.md`
- **parameters:** (defaults)

### `mode.support-mode`

- **contentPath:** `modules/mode.support-mode/support-mode.md`
- **parameters:**
  - `escalationChannel`: `#oncall-web`
  - `pagerWindowMinutes`: `15`

---

## How To Read The Example

- **`(none)`** means the module declared no configurable parameters. Read the content file as-is.
- **`(defaults)`** means the module declared parameters and the user did not override any — the content file's documented defaults apply.
- **A list of `key: value` lines** means the user overrode at least one parameter via the Modules tab. Treat the listed values as authoritative for this session; they take precedence over any defaults mentioned inside the content file.
- **The `[proactive — consult at session start]` marker** (here on `tool.fastpath-check`) tells you to read that module's content **immediately, before responding to the user's first request**. Modules without the marker are read lazily when a request touches their domain.

## Notes For Module Authors

- Always document a module's parameters and their defaults at the top of the module's primary content file. The composer renders the manifest tersely; the content file is where humans (and agents) verify what a parameter actually does.
- Keep `contentPath` stable across versions. Agents and the composer both reference it; renaming breaks every cached enablement.
- A module may legitimately ship multiple content files (e.g. one main procedure plus an appendix). List each one in the manifest entry's `contentPath` (the composer accepts an array). The agent reads only the files relevant to the task it is currently doing.
