# Database Access

When this module is loaded, the session has **read-only database access** for SWE via a host-provided query runner and an allowlisted set of connection names. SWE is the only role that executes queries; QA has no DB access regardless. Every agent reads this same fragment; role-specific framing is collected at the end.

Per the preamble's parameter-allowlist rule, the values in `parameters.allowlist` are the only authorized connection names for this session. This module has no keywords file — connection names are user-defined and host-specific, not drawn from a finite vocabulary — but the `allowlist` parameter is still the authoritative gate. Never query a connection whose name is not present verbatim as a **value** in that map.

## Configurable: connection allowlist

`parameters.allowlist` is a JSON object mapping user-defined project keys to host-defined connection names:

```
{ "<project-key>": "<connection-name>", ... }
```

Parsing rules:

- **The connection name (value) is the authoritative gate.** Project keys are documentation/routing context only — they let TPM and SWE talk about "the CMMS connection" without ambiguity, but the security check is on the value.
- Connection names are **case-sensitive** and must match exactly — do not normalize, lowercase, or guess.
- Project keys are unique within the map. If the user enters a duplicate key, the existing value is overwritten.
- An empty object `{}` means **no** DB access is granted for this session, even though the module is enabled. SWE must ask TPM to populate the map before running any query. When the Session Manifest renders `parameters: (defaults)` instead of an explicit map, the default applies — treat it the same as an empty object: no DB access is granted.
- SWE may **only** query a connection whose name appears verbatim as a value in the map — never invent connection names, pull credentials from `appsettings.json` or environment variables, or construct an ad-hoc connection.

Example:

```
{
  "CMMS": "localhost.cmms",
  "MCP":  "mcpdevsql.MCP_Dev"
}
```

In the example above, SWE may query `localhost.cmms` and `mcpdevsql.MCP_Dev`. The project keys "CMMS" and "MCP" are how TPM and SWE refer to those connections in dispatch and reporting; they are not themselves connection strings.

**Host-specific note:** Connection names are sourced from the user's LINQPad ConnectionsV2.xml on Windows/WSL hosts, surfaced as a dropdown quick-pick in the Nomeda settings panel. The dropdown is the only input — free-form text entry is not available in the value cell. When the settings panel cannot supply connections, three distinct non-`ok` states apply:

- **Loading** (`loading`): the webview has not yet received a probe result from the host. No banner is shown; the value cell renders a dropdown with only a placeholder option ("Loading…"). The dropdown is enabled but has no selectable connections — the change-handler guards against selecting the placeholder — so no value can actually be committed until the host responds.
- **LINQPad connections file not found** (`not-installed`): no candidate XML path existed on this host. A banner appears above the table with the heading "LINQPad connections file not found". The value cell renders empty and the allowlist cannot be populated from the UI. The user must install LINQPad and define at least one connection, then refresh.
- **LINQPad connections file could not be read** (`error`): a candidate path was found but the file could not be read or parsed (e.g. permissions issue, corrupt XML, or wrong override path). A banner appears with the heading "LINQPad connections file could not be read". The value cell renders empty.

In the `not-installed` and `error` states the panel shows two action buttons: "Copy install instructions" (copies a configurable prompt to the clipboard) and "Configure path…" (opens the `nomeda.linqpadConnectionsPath` VS Code setting so the user can supply an explicit path to the XML file). The user must resolve the underlying problem before the dropdown will populate. In the `loading` state no action buttons are shown.

## Universal rules (when module is enabled with a populated allowlist)

These rules apply regardless of which connection is targeted or what the task requires.

### SELECT only

You may run `SELECT` statements, including `WITH ... SELECT`, `EXPLAIN`, `SHOW`, and other read-only equivalents your DB flavor supports. You may **never** issue:

- `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `UPSERT`
- `DROP`, `ALTER`, `CREATE`, `TRUNCATE`
- `EXEC` / `EXECUTE` of stored procedures (their bodies are unknown and may mutate state)
- Any vendor-specific statement that writes to disk, changes schema, or alters server state

A query that appears read-only but calls a function with side effects (e.g. `SELECT mutating_fn(...)`) is forbidden. When in doubt about whether a query is truly read-only, ask TPM rather than running it.

### Use the host-provided query runner

Use only the tool path the host exposes. On Windows/WSL hosts configured for LINQPad, the wrapper is typically `lprun-query.sh`. On other hosts it may differ. **Ask TPM for the wrapper path before running your first query** on an unfamiliar host — do not hand-roll connections via `sqlcmd`, `psql`, ODBC drivers, or any other direct database client.

### Returning results

Include the exact query you ran, the connection name you targeted (the **value** from the allowlist map, not the project key), and a concise summary of the result in your return to TPM. Treat a large row count as a signal to refine the query rather than dumping raw output.

### When to stop and ask

If you are unsure whether a query is read-only, whether a connection name is on the allowlist, or what the host's query runner path is — ask TPM rather than guessing.

## Module-disabled vs allowlist-empty

These are distinct failure modes:

- **Module disabled** (no `tool.database-access` in the Session Manifest): the universal hard rules apply with no database-specific protections — no LINQPad invocations are sanctioned by this module, and agents fall back to whatever universal posture exists. Surface to TPM if the user appears to expect database-aware behavior.
- **Module enabled but `allowlist` empty**: the agent must refuse every LINQPad query attempt with: "Cannot run query against the database — this module's `allowlist` has no connection entries, so all DB operations are refused. Add a connection in the Modules tab or run the query manually."
- **Module enabled, connection requested not in allowlist**: refuse with: "Cannot query `<connection>` — it is not in this module's `allowlist`. Add it in the Modules tab if you need it for this session."

Do not merge these cases.

## Role-Specific Notes

The body above applies identically to every agent. The notes below are short framings for how each role uses the policy.

### TPM

You are the orchestrator for DB work. Before dispatching SWE for a database query, confirm the `allowlist` map is populated and brief SWE on which connection names are available for the session (you may use the project keys when referring to them in dispatch text, but tell SWE the underlying connection name too — that is what SWE must target). Reject any SWE assignment that would target a connection not present as a value in the map — do not let SWE make that determination unilaterally. If the map is empty, surface the configuration gap to the user before any DB-related work begins.

### SWE

You are the one who actually executes the queries. Apply the allowlist check per-query at the moment you are about to run it — compare the connection name you intend to target against the **values** of the `allowlist` map. Do not batch-check the whole task up front. Include the connection name (the value) in your return so TPM has an audit trail. If a requested query would target a connection not present as a value in the map or would require a non-`SELECT` statement, refuse immediately and surface the refusal to TPM; do not substitute an alternative or widen scope without authorization.

### QA

You have no DB access, regardless of whether this module is loaded or the allowlist is populated. When a data-state fact (row counts, record values, schema shape) would change your verdict, do not attempt to retrieve it yourself. Instead, state the unresolved data question in your report, recommend that TPM deploy SWE with this module enabled to answer it, and issue the verdict you can defend from the diff and code alone — or `FAIL` if the unknown fact is decisive.
