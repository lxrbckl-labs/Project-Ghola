import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import type { ModuleLoader } from '../modules/loader';
import type { ModuleHandle } from '../modules/handle';
import type { SettingsSchema } from '../manifest/types';

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

      const fragments = handle.manifest.contributes?.promptFragments ?? [];
      const targeted = fragments.filter((f) => f.target === agentId);
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

    if (entries.length === 0) {
      lines.push('_(no modules contribute prompt fragments to this agent)_');
      return lines.join('\n');
    }

    lines.push(...entries.flatMap((e) => [e, '']));
    // Trim trailing blank line.
    if (lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  }

  // --- parameter rendering -------------------------------------------------

  /**
   * Three-branch rendering for a module's parameters in the Session Manifest:
   *   - None:     module declares no settings schema     → render `(none)`
   *   - Defaults: schema present but no user overrides   → render `(defaults)`
   *   - Values:   user has overrides                     → render as a sub-list of key: value pairs
   */
  private renderParameters(
    schema: SettingsSchema | undefined,
    userValues: Record<string, unknown> | undefined,
  ): string[] {
    const hasSchema = schema && Object.keys(schema).length > 0;
    if (!hasSchema) return ['  - parameters: (none)'];

    const overrides = userValues && Object.keys(userValues).length > 0 ? userValues : undefined;
    if (!overrides) return ['  - parameters: (defaults)'];

    const out: string[] = ['  - parameters:'];
    for (const key of Object.keys(overrides)) {
      const rendered = this.renderValue(overrides[key]);
      out.push(`    - ${key}: ${rendered}`);
    }
    return out;
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
