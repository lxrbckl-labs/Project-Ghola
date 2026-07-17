/**
 * Storage foundation for an ORDERED list of Bitbucket API tokens (multi-token
 * support with round-robin failover). The whole list is JSON-serialized and
 * stored under a SINGLE SecretStorage key so the array is read/written
 * atomically and token values never touch plaintext settings. Token VALUES are
 * host-side secrets: only a derived last-4 fragment (see BitbucketTokenSummary)
 * may cross the webview boundary, and nothing here logs or echoes a value.
 *
 * This module owns storage + non-destructive legacy migration + a masked view.
 * It deliberately ships NO command handlers or webview wiring (later phases).
 */
import * as vscode from 'vscode';

/**
 * A single stored Bitbucket API token. `id` is a stable opaque identifier,
 * `label` is a user-facing name (e.g. "Token 1"), and `value` is the SECRET —
 * it must stay host-side and never be forwarded across the webview boundary or
 * written to any log / output channel.
 */
export interface BitbucketTokenEntry {
  id: string;
  label: string;
  value: string;
}

/**
 * Non-secret masked view of a stored token, safe to send to the webview.
 * `last4` is the last four characters of the value, or an empty string when the
 * value is shorter than four characters. The full value is never included.
 */
export interface BitbucketTokenSummary {
  id: string;
  label: string;
  last4: string;
}

/**
 * Generate a stable id. Mirrors `configurations-store.makeId` /
 * `todos-store` — prefer `crypto.randomUUID` (present in the VS Code Electron
 * host) and fall back to a Math.random composite. No new dependency.
 */
function makeId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const seg = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `${seg()}-${seg()}-${seg()}-${seg()}`;
}

/**
 * Parse a stored JSON array into normalized entries. Returns `undefined` when
 * the payload is not valid JSON or not an array (treated by the caller as
 * "corrupt / not yet initialized"); returns a (possibly empty) array otherwise.
 * Individual malformed members (missing/non-string `value`) are dropped, and a
 * missing/blank `id` is regenerated so downstream code can rely on the shape.
 */
function parseEntries(raw: string): BitbucketTokenEntry[] | undefined {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(data)) return undefined;
  const out: BitbucketTokenEntry[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.value !== 'string') continue;
    const id = typeof rec.id === 'string' && rec.id !== '' ? rec.id : makeId();
    const label = typeof rec.label === 'string' ? rec.label : '';
    out.push({ id, label, value: rec.value });
  }
  return out;
}

/**
 * Read the ordered Bitbucket token list from SecretStorage.
 *
 * Behavior:
 *  - A valid stored array (including an empty one) is authoritative and is
 *    returned as-is (normalized).
 *  - When no valid list exists yet (key absent, or the stored payload is
 *    corrupt) AND the legacy single-token key holds a value, perform a
 *    non-destructive one-time migration: seed the list with one entry
 *    `{ id, label: 'Token 1', value: <legacy> }`, WRITE it back, and LEAVE the
 *    legacy key untouched (orphaned, matching the existing `apiToken`
 *    precedent). This preserves a user's existing working token as entry 1.
 *  - Otherwise return `[]`.
 *
 * Idempotent: once the list has been written it is present and authoritative,
 * so subsequent reads never re-migrate and never duplicate. A valid empty list
 * is respected (it is NOT re-seeded from the legacy key), so a future
 * remove-all in a later phase will not resurrect the legacy token.
 */
export async function readBitbucketTokens(
  secrets: vscode.SecretStorage,
  tokensKey: string,
  legacyTokenKey: string,
): Promise<BitbucketTokenEntry[]> {
  const raw = await secrets.get(tokensKey);
  if (typeof raw === 'string') {
    const parsed = parseEntries(raw);
    // A parseable array (even empty) is authoritative: the list has been
    // initialized, so we never migrate over it. Only a corrupt payload
    // (parsed === undefined) falls through to the seed path below, which
    // self-heals by overwriting the bad value.
    if (parsed) return parsed;
  }
  const legacy = await secrets.get(legacyTokenKey);
  if (typeof legacy === 'string' && legacy !== '') {
    const seeded: BitbucketTokenEntry[] = [{ id: makeId(), label: 'Token 1', value: legacy }];
    await writeBitbucketTokens(secrets, tokensKey, seeded);
    return seeded;
  }
  return [];
}

/**
 * Serialize and store the whole list atomically under the single tokens key.
 * Does not fire any change event — that is a command-layer concern in a later
 * phase.
 */
export async function writeBitbucketTokens(
  secrets: vscode.SecretStorage,
  tokensKey: string,
  entries: BitbucketTokenEntry[],
): Promise<void> {
  await secrets.store(tokensKey, JSON.stringify(entries));
}

/**
 * Derive the non-secret masked view of a token list for the panel. Reuses the
 * same last-4 masking rule as `SettingsPanel.broadcastAtlassianTokenStatus`
 * (last four chars, empty when shorter than four). Never includes `value`.
 */
export function summarizeBitbucketTokens(entries: BitbucketTokenEntry[]): BitbucketTokenSummary[] {
  return entries.map((e) => ({
    id: e.id,
    label: e.label,
    last4: e.value.length >= 4 ? e.value.slice(-4) : '',
  }));
}

// ─── Mutation helpers ──────────────────────────────────────────────────────
//
// Each helper below is a pure async read-modify-write of the JSON array stored
// under `tokensKey`. They operate on the ALREADY-INITIALIZED list (the panel's
// broadcast path runs `readBitbucketTokens`, which performs the one-time legacy
// migration, before any of these can be reached), so they deliberately do NOT
// re-run migration: a mutation must never resurrect the orphaned legacy key.
// A corrupt / absent payload is treated as an empty list and self-heals on the
// next write. IDs are STABLE opaque identifiers — relabel, replace, and reorder
// key off `id`, never a positional index — so a token keeps its identity across
// every operation.

/**
 * Read the current list WITHOUT migration. A parseable array (even empty) is
 * authoritative; an absent or corrupt payload becomes `[]`. Used only by the
 * mutation helpers, which run after the list has already been initialized.
 */
async function readListForMutation(
  secrets: vscode.SecretStorage,
  tokensKey: string,
): Promise<BitbucketTokenEntry[]> {
  const raw = await secrets.get(tokensKey);
  if (typeof raw === 'string') {
    const parsed = parseEntries(raw);
    if (parsed) return parsed;
  }
  return [];
}

/**
 * Append a new token to the end of the list (end = lowest failover priority).
 * A blank/whitespace-only `label` falls back to `Token <n>` where n is the new
 * length, matching the migration's `Token 1` seed. The generated `id` is
 * stable. The VALUE is the secret and is only ever written to SecretStorage.
 */
export async function addBitbucketToken(
  secrets: vscode.SecretStorage,
  tokensKey: string,
  label: string | undefined,
  value: string,
): Promise<void> {
  const entries = await readListForMutation(secrets, tokensKey);
  const trimmedLabel = (label ?? '').trim();
  entries.push({
    id: makeId(),
    label: trimmedLabel !== '' ? trimmedLabel : `Token ${entries.length + 1}`,
    value,
  });
  await writeBitbucketTokens(secrets, tokensKey, entries);
}

/**
 * Remove the token whose `id` matches. A no-op when no entry matches (idempotent
 * — a double-click or a stale id simply leaves the list unchanged).
 */
export async function removeBitbucketToken(
  secrets: vscode.SecretStorage,
  tokensKey: string,
  id: string,
): Promise<void> {
  const entries = await readListForMutation(secrets, tokensKey);
  const next = entries.filter((e) => e.id !== id);
  if (next.length !== entries.length) {
    await writeBitbucketTokens(secrets, tokensKey, next);
  }
}

/**
 * Reorder the list to match `orderedIds` (which is the failover order). Entries
 * are emitted in `orderedIds` order; unknown ids are skipped, and any existing
 * entry NOT named in `orderedIds` is appended afterward in its prior order so a
 * partial/stale order can never silently drop a token.
 */
export async function reorderBitbucketTokens(
  secrets: vscode.SecretStorage,
  tokensKey: string,
  orderedIds: string[],
): Promise<void> {
  const entries = await readListForMutation(secrets, tokensKey);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const seen = new Set<string>();
  const next: BitbucketTokenEntry[] = [];
  for (const id of orderedIds) {
    const entry = byId.get(id);
    if (entry && !seen.has(id)) {
      next.push(entry);
      seen.add(id);
    }
  }
  for (const entry of entries) {
    if (!seen.has(entry.id)) next.push(entry);
  }
  await writeBitbucketTokens(secrets, tokensKey, next);
}

/**
 * Rename the token whose `id` matches, preserving its `id` and secret `value`.
 * A no-op when no entry matches. The label is trimmed; an empty result is
 * stored as-is (the caller decides whether to allow blank labels).
 */
export async function setBitbucketTokenLabel(
  secrets: vscode.SecretStorage,
  tokensKey: string,
  id: string,
  label: string,
): Promise<void> {
  const entries = await readListForMutation(secrets, tokensKey);
  let changed = false;
  const next = entries.map((e) => {
    if (e.id !== id) return e;
    changed = true;
    return { ...e, label: label.trim() };
  });
  if (changed) await writeBitbucketTokens(secrets, tokensKey, next);
}

/**
 * Replace the secret `value` of the token whose `id` matches, preserving its
 * `id` and `label`. A no-op when no entry matches. The new value is the secret
 * and is only ever written to SecretStorage.
 */
export async function replaceBitbucketTokenValue(
  secrets: vscode.SecretStorage,
  tokensKey: string,
  id: string,
  value: string,
): Promise<void> {
  const entries = await readListForMutation(secrets, tokensKey);
  let changed = false;
  const next = entries.map((e) => {
    if (e.id !== id) return e;
    changed = true;
    return { ...e, value };
  });
  if (changed) await writeBitbucketTokens(secrets, tokensKey, next);
}
