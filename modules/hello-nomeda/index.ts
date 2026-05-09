// Reference module entry. In a real shipping scenario this file would be
// pre-compiled to index.js next to manifest.json. For v0.0.1 the host does
// not yet load module entry code at runtime — these hooks are scaffolding
// to demonstrate the LifecycleHooks contract.

import type { LifecycleContext, LifecycleHooks } from '../../src/manifest/types';

export const onActivate: LifecycleHooks['onActivate'] = (ctx: LifecycleContext) => {
  ctx.log(`[hello-nomeda] activated (greeting="${String(ctx.settings.greeting ?? 'hello')}")`);
};

export const onDeactivate: LifecycleHooks['onDeactivate'] = (ctx: LifecycleContext) => {
  ctx.log('[hello-nomeda] deactivated');
};

export const onSettingsChange: LifecycleHooks['onSettingsChange'] = (
  ctx: LifecycleContext,
  oldSettings: Record<string, unknown>,
  newSettings: Record<string, unknown>,
) => {
  ctx.log(
    `[hello-nomeda] settings changed: greeting "${String(oldSettings.greeting)}" → "${String(newSettings.greeting)}"`,
  );
};
