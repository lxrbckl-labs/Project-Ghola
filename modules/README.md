# Module authoring guide

A Ghola module is a folder under this directory containing a `manifest.json`
matching `src/manifest/schema.json`, plus any prompt fragment `.md` files it
declares. The composer emits the Session Manifest from these manifests;
agents read fragment content on demand via the Read tool.

## Detail-view layout — settings at top

The settings panel renders each module's detail view in this order:

1. Header (name, version, enable toggle, optional Proactive pill)
2. Description
3. Definition list (id, version, content files, agents, tools, UI sections)
4. **Settings** — the configurable inputs declared in `contributes.settings`
5. **Prompt Content** — the raw `.md` fragments, reference material

Settings sit above prompt content because they are the actionable surface.
Keep your settings simple and clearly described so users can grasp the
configurable surface without scrolling through prompt fragments.

## Setting `description` fields — describe consequences

Each `SettingsField.description` must explain CONSEQUENCES, not restate the
label:

- What does each value mean at runtime?
- What changes when the user picks a different value or empties the field?
- Why is the default what it is?

Match the declarative, no-filler voice established by `core.swe` and
`tool.git`. The description is the user's only in-panel guide to the setting
— make it answer "what happens if I change this?" rather than "what is this?"

## Per-agent targeting

Each `promptFragments[]` entry declares a `target`:

- `target: "tpm"` / `"swe"` / `"qa"` — fragment is appended only to that
  agent's composed prompt. Use when the content is role-specific (TPM
  policy, SWE workflow, QA verification).
- `target: "all"` — fragment fans out to every agent's prompt. Use when
  the content applies identically across roles, such as `tool.git`'s rwd
  model and command tables. Prefer one shared fragment over three near-
  identical copies.

The composer filters fragments per agent and includes both `target ===
agentId` and `target === 'all'` matches.

## `proactive` flag

Set `"proactive": true` only when the module's content must be consulted at
session start — environment checks, pre-flight advisories, or any guidance
that loses value if read lazily. Proactive modules are annotated `[proactive
— consult at session start]` in the Session Manifest so agents read them
immediately. Most modules are lazy; reserve the flag for the rare cases
where on-demand reading would defeat the purpose.
