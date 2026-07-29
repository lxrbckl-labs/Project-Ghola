// Centralized host-path translation and War Mode ledger-root resolution.
//
// FOUR surfaces need to agree on exactly one ledger location: the session
// launcher (which exports GHOLA_LEDGER_ROOT / GHOLA_VAULT into the terminal),
// the settings panel (the War Room's READER), the extension's activation-time
// ledger file WATCHERS, and the `ghola` CLI (the ledger's WRITER). Three of
// those four live in this extension host and now share this module; the fourth
// is `scripts/ghola.mjs`, a standalone Node script that cannot import from
// `src/`, so it carries a small documented MIRROR of `toNativeHostPath` below.
// A THIRD copy of the same rule set lives in `scripts/ghola-boot-probe.sh`
// (`translate_path`), which must be pure bash with no subprocess. Keep all three
// in step — and note that "keep them in step" is no longer only a comment:
// `scripts/ghola-path-parity.mjs` drives all three over one shared case table
// under every forced platform and exits non-zero on any drift. Every difference
// that remains is recorded as an explicit KEEP-IN-SYNC EXCEPTION on
// `toNativeHostPath` below, in the same words, in all three files.
//
// Why translation is needed at all: `tool.obsidian-notes`' `vaultPath` is a
// single GLOBAL string shared by hosts on both sides of the WSL boundary, and
// `GHOLA_LEDGER_ROOT` can be set by an operator from either side. Joining a
// `/mnt/c/...` value under win32 `path` semantics yields the DRIVE-RELATIVE
// `\mnt\c\...`, which `path.resolve` later anchors to the current drive
// (`C:\mnt\c\...`) — a fabricated tree that reads as a perfectly legitimate
// Windows path. That is precisely why writes landing there went unnoticed, and
// why the anti-fabrication rule in `toNativeHostPath` is the point of this
// module rather than a nicety.
//
// Before this module existed the same fabrication was open-coded in three
// places and only ONE of them was fixed, which was worse than uniformly wrong:
// the launcher and CLI wrote to the correct root while the War Room reader and
// the file watchers still targeted the fabricated one, so the War Room silently
// never refreshed and the symptom no longer pointed at the cause.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { readModuleSettings } from '../state/module-settings';

/**
 * Flat `ghola.moduleSettings` key holding the Obsidian vault path — the single
 * source of truth for the vault, and step 2 of the ledger-root precedence.
 * Exported so no caller has to re-spell the `moduleId::fieldKey` string.
 */
export const VAULT_PATH_SETTING_KEY = 'tool.obsidian-notes::vaultPath';

/**
 * Sink for the single diagnostic this module emits (a skipped translation).
 * Callers pass a closure that prepends their own surface prefix (`[session]`,
 * `[panel]`, `[ghola]`) so the line reads the same as the rest of their log.
 */
export type PathLogger = (message: string) => void;

/**
 * Translate a possibly-foreign absolute path into the running host's native
 * form. Mirrors the bash implementation in `scripts/ghola-boot-probe.sh` and the
 * inline mirror in `scripts/ghola.mjs`, so no surface ever disagrees about where
 * the ledger lives.
 *
 *   - Separators are read as `/` regardless of which slash the setting used.
 *   - On win32:  `/mnt/<letter>/...` and MSYS `/<letter>/...` -> `<LETTER>:/...`
 *   - On WSL/Linux/macOS: `<letter>:/...` AND MSYS `/<letter>/...`
 *                                            -> `/mnt/<lowercase letter>/...`
 *   - Anything else keeps its RE-SLASHED spelling when that spelling resolves on
 *     this host, and is otherwise left completely alone.
 *
 * Only SINGLE-character drive letters translate, so real WSL mount points
 * (`/mnt/wsl`, `/mnt/host`, `/mnt/data`) and UNC paths are never mangled.
 *
 * The MSYS arm on the WSL side is not hypothetical, and its absence here was a
 * real divergence from `translate_path`. Under Git Bash `$HOME` is
 * `/c/Users/<u>`, so a vault path stored by a native-Windows session can plausibly
 * be `/c/Users/<u>/Documents/Obsidian/<vault>`. Read back on WSL, the boot probe
 * recovered that to `/mnt/c/...` and reported that vault while this host and the
 * CLI kept the untranslated `/c/...` — the digest and the War Room then pointed at
 * different roots, which is exactly the four-surface disagreement the header
 * describes. The anti-fabrication gate did NOT neutralize it: with no candidate
 * produced there was no translation for the gate to reject.
 *
 * CANNOT FABRICATE A PATH: a translation is only returned when the translated
 * location actually exists on this host. Otherwise the caller's ORIGINAL string
 * is returned untouched (not even re-slashed) and the mismatch is logged. A
 * wrong-but-honest original at least keeps pointing at the operator's actual
 * misconfiguration, whereas a plausible-looking `C:\mnt\c\...` does not.
 *
 * KEEP-IN-SYNC EXCEPTION 1 (agreed, not drift) — the bare re-slash is GATED here
 * and UNGATED in bash. `translate_path` re-slashes first and returns the
 * re-slashed string even when no platform rule fired, so it answers `C:/Users/x`
 * for `C:\Users\x`; here the bare re-slash is treated as a translation like any
 * other and must therefore clear `existsSync`, so on a host where that directory
 * does not resolve the caller gets `C:\Users\x` back. Deliberate: a backslash is
 * a LEGAL POSIX filename character, so an unconditional re-slash could invent a
 * path (`/home/u/a\b` -> `/home/u/a/b`) — precisely the fabrication class this
 * module exists to refuse. The two spellings name the same directory to every
 * Win32 consumer (Win32 APIs, Node `path`, and the agent's Read/Write tools all
 * accept either), so gating costs nothing real. `ghola-path-parity.mjs`
 * neutralizes the gate, and with it neutralized the transform is identical.
 *
 * KEEP-IN-SYNC EXCEPTION 2 (agreed, not drift) — bash models THREE platforms
 * (`windows`, `wsl`, `unix`) and makes `unix` the identity so a plain Linux or
 * macOS host is never rewritten; this models TWO (`win32` vs everything else) and
 * therefore applies the WSL rule on darwin and on non-WSL Linux. Accepted rather
 * than fixed, because a WSL detector here would add a FOURTH copy of a rule set
 * whose duplication is already the problem this file's header is about, and
 * `existsSync` neutralizes the difference on any host with no `/mnt/<letter>`
 * tree — which is every plain Linux and macOS host. The known residual: a
 * plain-Linux host that genuinely mounts `/mnt/c` would see this pair adopt
 * `C:/Users/x` -> `/mnt/c/Users/x` where bash keeps `C:/Users/x`. Neither of the
 * two supported hosts (WSL, native Windows) is affected, and the adopted path is
 * one `existsSync` has CONFIRMED, so the worst case is a disagreement about a
 * real directory rather than a fabricated one.
 */
export function toNativeHostPath(p: string, log?: PathLogger): string {
  const slashed = p.replace(/\\/g, '/');
  const translated = os.platform() === 'win32' ? toWindowsForm(slashed) : toWslForm(slashed);
  // No platform rule fired -> the re-slashed spelling is the candidate (EXCEPTION
  // 1 above). When the input had no backslash that candidate IS the input, so the
  // common case still short-circuits without touching the filesystem.
  const candidate = translated ?? slashed;
  if (candidate === p) return p;
  if (fs.existsSync(candidate)) return candidate;
  log?.(
    `path translation skipped: ${p} maps to ${candidate} on this host, but that location does not exist; keeping the original`,
  );
  return p;
}

/**
 * `/mnt/c/Users/x` or `/c/Users/x` -> `C:/Users/x`. Returns `undefined` when
 * `slashed` is not a foreign (POSIX-style drive-mount) path — including any
 * `/mnt/<multi-char>` mount and any path already in `C:/...` form.
 */
function toWindowsForm(slashed: string): string | undefined {
  const mnt = slashed.match(/^\/mnt\/([a-zA-Z])(\/.*)?$/);
  if (mnt) return `${mnt[1]!.toUpperCase()}:${mnt[2] ?? '/'}`;
  const msys = slashed.match(/^\/([a-zA-Z])(\/.*)?$/);
  if (msys) return `${msys[1]!.toUpperCase()}:${msys[2] ?? '/'}`;
  return undefined;
}

/**
 * `C:/Users/x` or MSYS `/c/Users/x` -> `/mnt/c/Users/x`. Returns `undefined` when
 * `slashed` is neither a drive-letter path nor a single-letter POSIX root — any
 * other POSIX path (including every `/mnt/...`) is already native. The arm order
 * mirrors `translate_path`'s `case` order, and the drive arm's required `/`-or-end
 * after the colon is what refuses the ambiguous drive-relative `C:foo`.
 */
function toWslForm(slashed: string): string | undefined {
  const drive = slashed.match(/^([a-zA-Z]):(\/.*)?$/);
  if (drive) return `/mnt/${drive[1]!.toLowerCase()}${drive[2] ?? '/'}`;
  const msys = slashed.match(/^\/([a-zA-Z])(\/.*)?$/);
  if (msys) return `/mnt/${msys[1]!.toLowerCase()}${msys[2] ?? '/'}`;
  return undefined;
}

/**
 * Resolve the War Mode ledger root GLOBALLY. THE one implementation: the
 * session launcher, `SettingsPanel`, the activation-time ledger watchers, and
 * (via its documented mirror) `scripts/ghola.mjs` all resolve through this
 * precedence, so every surface always agrees:
 *   1. GHOLA_LEDGER_ROOT env (non-empty)                 -> that value.
 *   2. Else the `tool.obsidian-notes` `vaultPath` setting -> <vault>/_Gholas.
 *   3. Else                                               -> <homedir>/.ghola/ledger.
 * NEVER resolves under the launched/open work repo — no `.ghola/` is read from
 * or written to the workspace. Returns the resolved root plus the vault it came
 * from (or null) so the launcher can also export GHOLA_VAULT. Never throws.
 *
 * BOTH the env override and the vault setting are run through
 * `toNativeHostPath` before use. The env override was previously taken verbatim,
 * which meant an operator exporting a WSL-form `GHOLA_LEDGER_ROOT` on win32
 * reproduced the fabrication bug the vault path had. Normalizing it does NOT
 * weaken the documented four-surface contract:
 *   - The precedence order is untouched; the env var still wins outright.
 *   - The contract's substance is that all four surfaces resolve to the SAME
 *     directory. Applying one identical translation rule everywhere is what
 *     makes that true on win32; taking the string verbatim is what broke it.
 *   - `toNativeHostPath` only ever substitutes a path it has CONFIRMED exists,
 *     so any value it cannot verify is still passed through verbatim — the old
 *     behavior is retained for exactly the cases where translating would be a
 *     guess.
 */
export function resolveLedgerRoot(
  globalState: vscode.Memento,
  workspaceState: vscode.Memento,
  log?: PathLogger,
): { root: string; vault: string | null } {
  const envRoot = process.env.GHOLA_LEDGER_ROOT;
  if (typeof envRoot === 'string' && envRoot.trim() !== '') {
    return { root: toNativeHostPath(envRoot.trim(), log), vault: null };
  }
  const flat = readModuleSettings(globalState, workspaceState);
  const vaultSetting = flat[VAULT_PATH_SETTING_KEY];
  if (typeof vaultSetting === 'string' && vaultSetting.trim() !== '') {
    const vault = toNativeHostPath(vaultSetting.trim(), log);
    return { root: path.join(vault, '_Gholas'), vault };
  }
  return { root: path.join(os.homedir(), '.ghola', 'ledger'), vault: null };
}
