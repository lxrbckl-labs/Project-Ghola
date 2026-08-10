import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import type { ModuleLoader } from '../modules/loader';
import type { ModuleHandle } from '../modules/handle';
import type { SettingsField, SettingsSchema } from '../manifest/types';

/**
 * `mode.war` is no longer a toggleable module: its enablement is driven by the
 * `mode.war::enabled` setting (surfaced as an Agents configuration), not by
 * loader state. It is excluded from the generic enabled-module fragment loop and
 * injected via a dedicated special case gated on that setting. It remains
 * discoverable by the loader so its settings schema and `ghola.md` fragment path
 * stay reachable.
 */
const GHOLA_MODE_ID = 'mode.war';

/**
 * Every character that terminates a line somewhere between a raw file, a
 * markdown renderer, and a JS string literal, mapped to the escape sequence
 * that stands in for it in a rendered parameter value.
 *
 * The spellings are JSON's own on purpose: `renderValue`'s object branch runs
 * values through `JSON.stringify`, which already escapes LF/CR/VT/FF this exact
 * way, so applying this map to every branch makes a string value and a value
 * nested inside a rendered object read identically — and keeps the object
 * branch's output parseable as JSON, since each replacement is itself a legal
 * JSON escape.
 *
 * U+0085 (NEL), U+2028 (LINE SEPARATOR), and U+2029 (PARAGRAPH SEPARATOR) are
 * here because `JSON.stringify` does NOT escape them: they are Unicode line
 * terminators that survive stringification raw and break the manifest line the
 * same way a bare LF does.
 */
const LINE_BREAK_ESCAPES: Record<string, string> = {
  '\n': '\\n',
  '\r': '\\r',
  '\u000b': '\\u000b',
  '\f': '\\f',
  '\u0085': '\\u0085',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

const LINE_BREAK_PATTERN = /[\n\r\u000b\f\u0085\u2028\u2029]/g;

/**
 * Stateless composer: pure function from (agentId, settings) → composed prompt string.
 *
 * Emits `[core] + [preamble] + [Session Manifest block]`. The core and preamble
 * are bundled with the extension and live under `prompts/cores/` — they are NOT
 * modules and are NOT discovered by the ModuleLoader. The Session Manifest lists
 * every enabled module that contributes a `promptFragments[]` entry targeting
 * this agent. Module content is NOT inlined — agents read `modules/{id}/*.md`
 * on demand.
 *
 * Two file reads per call: the preamble + the agent's core (both from
 * `coresPath`). Module manifests are already loaded by the loader (in-memory)
 * and not re-read here.
 */
export class PromptComposer {
  constructor(
    private readonly loader: ModuleLoader,
    /** Absolute path to the directory holding `preamble.md`, `tpm.md`, `swe.md`, `qa.md`. Always rooted in `context.extensionPath`, never workspace-relative. */
    private readonly coresPath: string,
    private readonly logger?: vscode.OutputChannel,
  ) {}

  /**
   * Compose the full system prompt for `agentId` from the currently enabled modules,
   * given the host-provided settings dict (keyed by module id → field id → value).
   */
  compose(agentId: string, settings: Record<string, Record<string, unknown>>): string {
    const enabled = this.loader.getEnabled();

    const core = this.readCore(agentId);
    const preamble = this.readPreamble();
    const manifestBlock = this.renderSessionManifest(agentId, enabled, settings);

    const parts: string[] = [];
    if (core) parts.push(core);
    if (preamble) parts.push(preamble);
    if (manifestBlock) parts.push(manifestBlock);
    return parts.join('\n\n');
  }

  // --- core ----------------------------------------------------------------

  private readCore(agentId: string): string {
    const abs = path.join(this.coresPath, `${agentId}.md`);
    try {
      return fs.readFileSync(abs, 'utf-8').trimEnd();
    } catch (err) {
      this.log(`core unreadable (${agentId} → ${abs}): ${(err as Error).message}`);
      return `# ${agentId.toUpperCase()} (core unreadable)\n\nCould not read ${abs}.`;
    }
  }

  // --- preamble ------------------------------------------------------------

  private readPreamble(): string {
    const abs = path.join(this.coresPath, 'preamble.md');
    try {
      return fs.readFileSync(abs, 'utf-8').trimEnd();
    } catch (err) {
      this.log(`preamble unreadable (${abs}): ${(err as Error).message}`);
      return '';
    }
  }

  // --- session manifest ----------------------------------------------------

  private renderSessionManifest(
    agentId: string,
    enabled: ModuleHandle[],
    settings: Record<string, Record<string, unknown>>,
  ): string {
    const lines: string[] = ['## Session Manifest', ''];
    const entries: string[] = [];

    for (const handle of enabled) {
      const id = handle.manifest.id;
      // Defensive skip: cores live in prompts/cores/ and should never be
      // discovered by the loader. If a stale core.* manifest survives in the
      // modules dir during transition, swallow it here rather than emit it.
      if (id.startsWith('core.')) continue;
      // mode.war is gated by the `mode.war::enabled` setting, not loader
      // state — injected separately below, never by this generic loop.
      if (id === GHOLA_MODE_ID) continue;

      const fragments = handle.manifest.contributes?.promptFragments ?? [];
      // `target: "all"` fans out to every agent — include those alongside the
      // agent-specific fragments so a shared module (e.g. tool.git) appears
      // in tpm, swe, and qa manifests from a single declaration.
      const targeted = fragments.filter(
        (f) => f.target === agentId || f.target === 'all',
      );
      if (targeted.length === 0) continue;

      for (const fragment of targeted) {
        const contentPath = `\${GHOLA_ROOT}/modules/${handle.manifest.id}/${fragment.contentPath}`;
        const proactive = handle.manifest.proactive === true;
        const marker = proactive ? ' [proactive — consult at session start]' : '';
        const header = `- **${id}**${marker}`;
        const contentLine = `  - contentPath: \`${contentPath}\``;
        const paramsBlock = this.renderParameters(
          id,
          handle.manifest.contributes?.settings,
          settings[id],
        );
        entries.push([header, contentLine, ...paramsBlock].join('\n'));
      }
    }

    // mode.war's TPM fragment: injected here (outside the loop) when the
    // `mode.war::enabled` setting is on. TPM-only, matching the fragment's
    // declared target — never emitted for swe/qa.
    if (agentId === 'tpm') {
      const gholaEntry = this.renderGholaEntry(settings);
      if (gholaEntry) entries.push(gholaEntry);
    }

    if (entries.length === 0) {
      lines.push('_(no modules contribute prompt fragments to this agent)_');
      return lines.join('\n');
    }

    lines.push(...entries.flatMap((e) => [e, '']));
    // Trim trailing blank line.
    if (lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  }

  /**
   * Build the Session Manifest entry for `mode.war`'s TPM fragment when the
   * `mode.war::enabled` setting is on, or `null` otherwise. Reuses the still-
   * discoverable module manifest for the fragment/parameters metadata; only the
   * gate has moved from loader-enabled state to the setting value. Emits the
   * exact same entry shape the generic loop produces (header + contentPath +
   * parameters sub-list). Read-on-demand is preserved — ghola.md is not inlined.
   *
   * The stored `enabled` key is a gate flag, not a ghola parameter, so it is
   * stripped before rendering — only the four sub-toggles reach the params list.
   */
  private renderGholaEntry(
    settings: Record<string, Record<string, unknown>>,
  ): string | null {
    const gholaSettings = settings[GHOLA_MODE_ID];
    if (gholaSettings?.['enabled'] !== true) return null;

    const handle = this.loader.find(GHOLA_MODE_ID);
    if (!handle) return null;

    const fragment = (handle.manifest.contributes?.promptFragments ?? []).find(
      (f) => f.target === 'tpm',
    );
    if (!fragment) return null;

    const contentPath = `\${GHOLA_ROOT}/modules/${handle.manifest.id}/${fragment.contentPath}`;
    const proactive = handle.manifest.proactive === true;
    const marker = proactive ? ' [proactive — consult at session start]' : '';
    const header = `- **${handle.manifest.id}**${marker}`;
    const contentLine = `  - contentPath: \`${contentPath}\``;

    const params: Record<string, unknown> = {};
    for (const key of Object.keys(gholaSettings)) {
      if (key === 'enabled') continue;
      params[key] = gholaSettings[key];
    }
    const paramsBlock = this.renderParameters(
      handle.manifest.id,
      handle.manifest.contributes?.settings,
      params,
    );
    return [header, contentLine, ...paramsBlock].join('\n');
  }

  // --- parameter rendering -------------------------------------------------

  /**
   * Three-branch rendering for a module's parameters in the Session Manifest:
   *   - None:          no schema AND no host-injected values     → render `(none)`
   *   - Injected only: no schema but host injected values exist  → render as a sub-list (schema-less, e.g. feedbackFilePath)
   *   - Schema:        schema present                            → render as a sub-list of key: value pairs
   *
   * The "injected only" branch exists because some modules (e.g. tool.feedback-log)
   * declare no user-editable settings schema but receive host-injected parameters
   * at compose time. Without this branch those parameters would be silently dropped,
   * leaving the agent with `(none)` and no path to operate.
   *
   * The "Schema" branch resolves the schema's DECLARED DEFAULTS underneath any
   * stored overrides, so every declared setting renders with a concrete value.
   * It used to print a bare `(defaults)` sentinel when the user had no overrides,
   * which was not merely terse but wrong: the preamble's "Parameter Allowlists
   * Are Authoritative" rule makes a comma-separated allowlist the ONLY permitted
   * set of values and forbids substituting when one is absent, so an unresolved
   * `(defaults)` reads to a strict agent as an EMPTY allowlist. The same sentinel
   * hid numeric backstops (e.g. mode.ticket-pr's maxAutonomousIterations /
   * maxTicketsPerRun) whose own prose cites them by name. The schema is already
   * in hand here, so resolve it rather than making every preset pin the defaults
   * by hand — a stopgap that only ever helped fresh installs, because preset
   * seeding copies a preset's `settings` by name once.
   *
   * The sentinel survives in exactly one case: a schema whose fields declare no
   * defaults at all and that has no stored overrides, which resolves to zero
   * rows. Emitting `parameters:` with nothing under it would be worse.
   *
   * In the "Schema" branch, stored keys the schema does not declare are FILTERED
   * OUT (and logged) rather than rendered — see the comment on the filter itself.
   * Only that branch filters: the "injected only" branch has no schema to check
   * against, so nothing there can be validated or dropped.
   */
  private renderParameters(
    moduleId: string,
    schema: SettingsSchema | undefined,
    userValues: Record<string, unknown> | undefined,
  ): string[] {
    const hasSchema = schema && Object.keys(schema).length > 0;
    const hasValues = userValues && Object.keys(userValues).length > 0;

    if (!hasSchema && !hasValues) return ['  - parameters: (none)'];

    // Schema-less but host injected values exist — render them directly. There
    // is no schema to validate these against, so the undeclared-key filter in
    // the Schema branch below deliberately does not apply here; this is exactly
    // the case that branch's scoping exists to protect.
    if (!hasSchema && hasValues) {
      const out: string[] = ['  - parameters:'];
      for (const key of Object.keys(userValues!)) {
        const projected = this.projectValueForAgent(undefined, userValues![key]);
        const rendered = this.renderValue(projected);
        out.push(`    - ${key}: ${rendered}`);
      }
      return out;
    }

    const declared = schema!;
    const overrides = hasValues ? userValues : undefined;

    // Walk the SCHEMA, not the stored keys: that resolves declared defaults for
    // every field the module ships and layers the stored override on top where
    // one exists (stored wins, default fills the rest). Walking the schema also
    // makes row order deterministic — manifest order, which is the order the
    // settings panel shows — instead of globalState's arbitrary insertion order.
    const rows: string[] = [];
    for (const [key, field] of Object.entries(declared)) {
      const stored =
        overrides !== undefined &&
        Object.prototype.hasOwnProperty.call(overrides, key);
      // A field with no stored value AND no declared default has nothing to say;
      // emit no row rather than the literal string `undefined`. A stored value is
      // rendered verbatim even when it is nullish, exactly as it was before
      // defaults were resolved here.
      if (!stored && field.default === undefined) continue;
      const value = stored ? overrides![key] : field.default;
      const projected = this.projectValueForAgent(field, value);
      const rendered = this.renderValue(projected);
      rows.push(`    - ${key}: ${rendered}`);
    }

    // Undeclared stored key: module settings persist as flat `id::field` keys
    // in globalState and nothing prunes them, so a setting that is removed or
    // renamed leaves its value orphaned in the store forever. The preamble
    // tells agents that manifest parameters are AUTHORITATIVE, so rendering an
    // orphan promotes dead storage into a live instruction the operator cannot
    // see or edit in any panel — worst case a stale allowlist sitting next to
    // the real one with no marker for which is live. Drop it instead.
    //
    // Walking the schema above already excludes orphans structurally; this pass
    // exists only to keep reporting them. It is scoped to this branch on
    // purpose: a module may legitimately have stored values and no declared
    // settings at all (tool.feedback-log's injected feedbackFilePath), and
    // those are routed to the schema-less branch above, which must not filter.
    const skipped: string[] = [];
    for (const key of Object.keys(overrides ?? {})) {
      if (!declared[key]) skipped.push(key);
    }

    // Do not drop orphans silently: a skipped key is invisible in the composed
    // prompt by design, so leave a trace in the output channel. Aggregated per
    // module per compose (compose runs on every Agents-tab refresh) so this
    // stays one greppable line, not per-key noise.
    if (skipped.length > 0) {
      this.log(
        `${moduleId}: ${skipped.length} stored parameter(s) not declared in the module's settings schema, skipped: ${skipped.join(', ')}`,
      );
    }

    // Nothing resolved: every schema field is default-less and the module has no
    // live overrides (all stored keys were orphans, or there were none). Keep the
    // sentinel rather than emit a `parameters:` header with no rows under it.
    if (rows.length === 0) return ['  - parameters: (defaults)'];
    return ['  - parameters:', ...rows];
  }

  /**
   * Project a stored parameter value into the shape an agent should see.
   *
   * Today only `keyValue` fields with `optionalEnabled: true` need projection:
   * the storage shape is `Record<string, { value: string; enabled: boolean }>`
   * but the agent should see the same simple `Record<string, string>` it sees
   * for plain keyValue fields, with disabled entries omitted.
   *
   * Falls back to runtime-shape detection when no field definition is
   * available: if the first value looks like a `{ value, enabled }` object,
   * treat as the richer shape.
   *
   * That fallback used to also cover settings stored under a key the schema does
   * not declare. It no longer does: `renderParameters` now filters undeclared
   * stored keys upstream, so they never reach this function. The surviving
   * callers with `field === undefined` are the schema-less modules (a module that
   * declares no settings but receives host-injected parameters), i.e. a value
   * that is declared-by-injection but shapeless. Keep the fallback for those.
   */
  private projectValueForAgent(
    field: SettingsField | undefined,
    value: unknown,
  ): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object' || Array.isArray(value)) return value;

    const useRichShape = field
      ? field.type === 'keyValue' && field.optionalEnabled === true
      : this.looksLikeRichKeyValue(value as Record<string, unknown>);

    if (!useRichShape) return value;

    const entries = Object.entries(value as Record<string, unknown>);
    const projected: Record<string, string> = {};
    for (const [k, v] of entries) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const obj = v as { value?: unknown; enabled?: unknown };
        if (obj.enabled === false) continue;
        projected[k] = typeof obj.value === 'string' ? obj.value : '';
      }
    }
    return projected;
  }

  /** Heuristic: does this object look like Record<string, {value, enabled}>? */
  private looksLikeRichKeyValue(obj: Record<string, unknown>): boolean {
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v) {
        return true;
      }
      return false;
    }
    return false;
  }

  /**
   * Render one parameter value as a single manifest line.
   *
   * A rendered value is emitted inside a markdown list item (`    - key: ...`),
   * so it MUST NOT contain a raw line terminator: the moment it does, every
   * character after the break sits at column 0 and stops being part of the
   * list. That is not cosmetic. `integration.atlassian-suite`'s
   * `attributionSuffix` default begins with `\n\n---\n`, which used to emit a
   * bare `---` at column 0 — a markdown horizontal rule an agent can read as
   * the Session Manifest having ended, silently dropping every module below it.
   *
   * Line terminators are therefore ESCAPED, not stripped and not folded to a
   * space. Escaping is what the object branch already does (via
   * `JSON.stringify`) and it is the only option that preserves meaning: a value
   * whose line breaks are load-bearing — `tool.pr-prep`'s `descriptionTemplate`
   * is a PR-description skeleton whose blank lines ARE the structure — survives
   * as something the agent can reconstruct, where folding or deleting would
   * hand it a mangled template it would reproduce verbatim.
   *
   * Escaping runs on the final `str` so it covers every branch: raw strings,
   * host-injected values, and the JSON of an object/kv-table alike (nested
   * newlines inside a `keyValue` key or value included). Only line-terminating
   * characters are touched — backslashes and tabs are left exactly as-is, so a
   * value with no line break renders byte-for-byte as it did before.
   */
  private renderValue(value: unknown): string {
    let str: string;
    if (typeof value === 'string') {
      str = value;
    } else if (value === null || value === undefined) {
      str = String(value);
    } else if (typeof value === 'object') {
      try {
        str = JSON.stringify(value);
      } catch {
        str = String(value);
      }
    } else {
      str = String(value);
    }

    str = str.replace(LINE_BREAK_PATTERN, (ch) => LINE_BREAK_ESCAPES[ch]);

    // Wrap in backticks. If the value contains a backtick, fall back to single-quote
    // escape (\'). Spec note: this is adequate for an agent reading it; cosmetic
    // polish deferred.
    if (str.includes('`')) {
      const escaped = str.replace(/'/g, "\\'");
      return `'${escaped}'`;
    }
    return `\`${str}\``;
  }

  // --- logging -------------------------------------------------------------

  private log(msg: string): void {
    this.logger?.appendLine(`[composer] ${msg}`);
  }
}
