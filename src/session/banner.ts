import type { ModuleHandle } from '../modules/handle';

/**
 * Session modality label. Precedence mirrors the launcher's GHOLA_MODE
 * derivation exactly so the Mode row and the env var never disagree:
 * enabled `mode.*` module ids (prefix stripped, joined) win if present; else
 * `self-upgrade` when `tool.self-upgrade` is enabled (a Self Upgrade session is
 * its own non-ticket-scoped modality); else `unconstrained`.
 */
export function formatMode(enabled: ModuleHandle[]): string {
  const modes = enabled
    .filter((h) => h.manifest.id.startsWith('mode.'))
    .map((h) => h.manifest.id.slice('mode.'.length));
  if (modes.length > 0) return modes.join(', ');
  const selfUpgrade = enabled.some((h) => h.manifest.id === 'tool.self-upgrade');
  return selfUpgrade ? 'self-upgrade' : 'unconstrained';
}

/**
 * Mode-field value with the War Mode marker layered on. War Mode layers on top
 * of the session modality, so when it is on we append `+ war` to the modality
 * (e.g. `ticket-work + war`). When there is no modality (`unconstrained`), War
 * Mode IS the meaningful modality, so we show `war` alone rather than
 * `unconstrained + war`. Non-war sessions are unaffected — `formatMode` itself
 * is untouched and the marker is gated on `warMode`.
 */
export function formatModeWithWar(enabled: ModuleHandle[], warMode: boolean): string {
  const base = formatMode(enabled);
  if (!warMode) return base;
  return base === 'unconstrained' ? 'war' : `${base} + war`;
}
