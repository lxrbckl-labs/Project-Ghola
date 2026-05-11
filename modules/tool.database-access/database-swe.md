# Database Access — SWE

When this module is loaded, you have **read-only** database access via the host-provided query runner.

## Allowlisted connections

The module's `parameters.allowlist` value in the Session Manifest lists the connection names you may target. Treat it as authoritative:

- If `allowlist` is empty, you have **no** database access for this session even though the module is enabled — ask TPM to configure connections in the module's settings before you attempt a query.
- You may only query a connection whose name appears verbatim in the allowlist. Do not invent connection names, do not edit configuration files to add a new one, and do not pull credentials from `appsettings.json` or environment variables to construct your own connection.

## Statement-level rules — SELECT only

You may run `SELECT` statements (including `WITH ... SELECT`, `EXPLAIN`, `SHOW`, and other read-only equivalents your DB supports). You may **never** issue:

- `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `UPSERT`
- `DROP`, `ALTER`, `CREATE`, `TRUNCATE`
- `EXEC` / `EXECUTE` of stored procedures (their bodies are unknown to you and may mutate state)
- Any vendor-specific statement that writes to disk, changes schema, or alters server state

A query that *looks* read-only but calls a function with side effects (e.g. `SELECT mutating_fn(...)`) is forbidden — if in doubt, ask TPM rather than running it.

## Running queries

The query-runner tool is host-provided. Its invocation differs by host:

- On the SWT host the wrapper is `lprun-query.sh`.
- On other hosts (including future Nomeda hosts) it may differ.

**Ask TPM for the tool path or wrapper for this host** before running your first query. Do not hand-roll connections via `sqlcmd`, `psql`, ODBC drivers, etc.

## Returning results

When your assignment needs DB-derived facts, include the exact query you ran, the connection you targeted, and a concise summary of the result in your return to TPM. Treat row counts large enough to be noisy as a signal to refine the query rather than dumping them.
