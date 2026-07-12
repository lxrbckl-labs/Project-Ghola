import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import type { ModuleLoader } from '../modules/loader';
import type { ModuleHandle } from '../modules/handle';
import type { SettingsField, SettingsSchema } from '../manifest/types';

/**
 * `mode.ghola` is no longer a toggleable module: its enablement is driven by the
 * `mode.ghola::enabled` setting (surfaced as an Agents configuration), not by
 * loader state. It is excluded from the generic enabled-module fragment loop and
 * injected via a dedicated special case gated on that setting. It remains
 * discoverable by the loader so its settings schema and `ghola.md` fragment path
 * stay reachable.
 */
const GHOLA_MODE_ID = 'mode.ghola';

/**
 * `tool.commit-push` contributes a single TPM-targeted fragment (`commit-push.md`)
 * that is one-shot BUTTON-dispatch text ("You were launched by the ... button ...
 * You are not TPM"). The Explorer "Commit and Push" button reads that file DIRECTLY
 * (see `src/commands/commitAndPush.ts`, which builds a self-contained prompt pointing
 * the dispatched agent at the module's `commit-push.md`), NOT via the composed TPM
 * manifest. Injecting it into the long-running TPM session would therefore be
 * self-contradictory dead weight, so it is excluded from the generic fragment loop
 * here. The module stays discoverable so the button can still resolve its file path.
 */
const COMMIT_PUSH_ID = 'tool.commit-push';

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
      // mode.ghola is gated by the `mode.ghola::enabled` setting, not loader
      // state — injected separately below, never by this generic loop.
      if (id === GHOLA_MODE_ID) continue;
      // tool.commit-push's fragment is one-shot button-dispatch text read
      // directly by the Commit-and-Push button, not by the persistent TPM
      // session, never emit it into any composed manifest (see COMMIT_PUSH_ID).
      if (id === COMMIT_PUSH_ID) continue;

      const fragments = handle.manifest.contributes?.promptFragments ?? [];
      // `target: "all"` fans out to every agent — include those alongside the
      // agent-specific fragments so a shared module (e.g. tool.git) appears
      // in tpm, swe, and qa manifests from a single declaration.
      const targeted = fragments.filter(
        (f) => f.target === agentId || f.target === 'all',
      );
      if (targeted.length === 0) continue;

      for (const fragment of targeted) {
        const contentPath = `\${NOMEDA_ROOT}/modules/${handle.manifest.id}/${fragment.contentPath}`;
        const proactive = handle.manifest.proactive === true;
        const marker = proactive ? ' [proactive — consult at session start]' : '';
        const header = `- **${id}**${marker}`;
        const contentLine = `  - contentPath: \`${contentPath}\``;
        const paramsBlock = this.renderParameters(
          handle.manifest.contributes?.settings,
          settings[id],
        );
        entries.push([header, contentLine, ...paramsBlock].join('\n'));
      }
    }

    // mode.ghola's TPM fragment: injected here (outside the loop) when the
    // `mode.ghola::enabled` setting is on. TPM-only, matching the fragment's
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
   * Build the Session Manifest entry for `mode.ghola`'s TPM fragment when the
   * `mode.ghola::enabled` setting is on, or `null` otherwise. Reuses the still-
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

    const contentPath = `\${NOMEDA_ROOT}/modules/${handle.manifest.id}/${fragment.contentPath}`;
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
      handle.manifest.contributes?.settings,
      params,
    );
    return [header, contentLine, ...paramsBlock].join('\n');
  }

  // --- parameter rendering -------------------------------------------------

  /**
   * Four-branch rendering for a module's parameters in the Session Manifest:
   *   - None:          no schema AND no host-injected values     → render `(none)`
   *   - Injected only: no schema but host injected values exist  → render as a sub-list (schema-less, e.g. feedbackFilePath)
   *   - Defaults:      schema present but no user overrides      → render `(defaults)`
   *   - Values:        user has overrides (schema + values)      → render as a sub-list of key: value pairs
   *
   * The "injected only" branch exists because some modules (e.g. tool.feedback-log)
   * declare no user-editable settings schema but receive host-injected parameters
   * at compose time. Without this branch those parameters would be silently dropped,
   * leaving the agent with `(none)` and no path to operate.
   */
  private renderParameters(
    schema: SettingsSchema | undefined,
    userValues: Record<string, unknown> | undefined,
  ): string[] {
    const hasSchema = schema && Object.keys(schema).length > 0;
    const hasValues = userValues && Object.keys(userValues).length > 0;

    if (!hasSchema && !hasValues) return ['  - parameters: (none)'];

    // Schema-less but host injected values exist — render them directly.
    if (!hasSchema && hasValues) {
      const out: string[] = ['  - parameters:'];
      for (const key of Object.keys(userValues!)) {
        const projected = this.projectValueForAgent(undefined, userValues![key]);
        const rendered = this.renderValue(projected);
        out.push(`    - ${key}: ${rendered}`);
      }
      return out;
    }

    const overrides = hasValues ? userValues : undefined;
    if (!overrides) return ['  - parameters: (defaults)'];

    const out: string[] = ['  - parameters:'];
    for (const key of Object.keys(overrides)) {
      const field = schema ? schema[key] : undefined;
      const projected = this.projectValueForAgent(field, overrides[key]);
      const rendered = this.renderValue(projected);
      out.push(`    - ${key}: ${rendered}`);
    }
    return out;
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
   * available (e.g. settings stored for an unknown key): if the first value
   * looks like a `{ value, enabled }` object, treat as the richer shape.
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

  private renderValue(value: unknown): string {
    let str: string;
    if (typeof value === 'string') {
      // Strip \r\n from string values per spec.
      str = value.replace(/\r\n/g, '').replace(/\r/g, '');
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
