import type { LifecycleHooks, ModuleManifest } from '../manifest/types';

export interface ModuleHandle {
  manifest: ModuleManifest;
  /** Absolute path to the module directory containing manifest.json. */
  rootPath: string;
  isEnabled: boolean;
  /** Lazily imported lifecycle hooks (resolved on first access). */
  entryModule?: LifecycleHooks;
}
