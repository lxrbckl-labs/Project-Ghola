import type { ModuleHandle } from '../modules/handle';

export interface BannerInput {
  enabledModules: ModuleHandle[];
  composedAgentIds: string[];
}

export function formatBanner(input: BannerInput): string {
  const moduleCount = input.enabledModules.length;
  const agents = input.composedAgentIds.join(', ') || '(none)';
  const lines = [
    '== Ghola session ==',
    `modules loaded: ${moduleCount}`,
    `agents composed: ${agents}`,
    '----------------------------------------',
    'Launch your CLI of choice (e.g. claude) when ready.',
    '',
  ];
  return lines.join('\n');
}
