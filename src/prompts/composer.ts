import * as fs from 'fs/promises';
import * as path from 'path';
import type * as vscode from 'vscode';
import type { AgentTarget } from '../manifest/types';
import type { ModuleLoader } from '../modules/loader';
import type { ModuleHandle } from '../modules/handle';

const DEFAULT_ORDER = 100;

export class PromptComposer {
  constructor(
    private readonly loader: ModuleLoader,
    private readonly logger?: vscode.OutputChannel,
  ) {}

  /**
   * Compose the full system prompt for `target` from the currently enabled modules.
   * Walks all enabled modules: picks the highest-priority (last-wins-by-order) agent
   * definition, then appends every matching prompt fragment in `order` ascending.
   */
  async compose(target: AgentTarget): Promise<string> {
    const enabled = this.loader.getEnabled();
    const baseDef = await this.resolveBaseDefinition(enabled, target);

    const fragments: Array<{
      handle: ModuleHandle;
      section?: string;
      content: string;
      order: number;
    }> = [];

    for (const handle of enabled) {
      const fr = handle.manifest.contributes?.promptFragments ?? [];
      for (const f of fr) {
        if (f.target !== target) continue;
        const abs = path.join(handle.rootPath, f.contentPath);
        try {
          const content = await fs.readFile(abs, 'utf-8');
          fragments.push({
            handle,
            section: f.section,
            content,
            order: f.order ?? DEFAULT_ORDER,
          });
        } catch (err) {
          this.log(`fragment unreadable (${handle.manifest.id} → ${f.contentPath}): ${(err as Error).message}`);
        }
      }
    }

    fragments.sort((a, b) => a.order - b.order);

    const parts: string[] = [];
    if (baseDef) {
      parts.push(baseDef);
    } else {
      parts.push(
        `# ${target.toUpperCase()} (no agent definition module loaded)\n\n` +
          `No enabled module contributes an agent definition for "${target}". ` +
          `Enable a core module (e.g. core.tpm, core.swe, core.qa) or write your own.`,
      );
    }

    for (const f of fragments) {
      const header = f.section
        ? `## ${f.handle.manifest.name}: ${f.section}`
        : `## ${f.handle.manifest.name}`;
      parts.push(`${header}\n\n${f.content.trim()}`);
    }

    return parts.join('\n\n');
  }

  private async resolveBaseDefinition(
    enabled: ModuleHandle[],
    target: AgentTarget,
  ): Promise<string | undefined> {
    // Last-declared wins; user can re-order modules later if needed.
    let chosen: { handle: ModuleHandle; defPath: string } | undefined;
    for (const handle of enabled) {
      const agents = handle.manifest.contributes?.agents ?? [];
      for (const a of agents) {
        if (a.id === target) {
          chosen = { handle, defPath: a.definitionPath };
        }
      }
    }
    if (!chosen) return undefined;
    const abs = path.join(chosen.handle.rootPath, chosen.defPath);
    try {
      return await fs.readFile(abs, 'utf-8');
    } catch (err) {
      this.log(`agent definition unreadable (${chosen.handle.manifest.id}): ${(err as Error).message}`);
      return undefined;
    }
  }

  private log(msg: string): void {
    this.logger?.appendLine(`[composer] ${msg}`);
  }
}
