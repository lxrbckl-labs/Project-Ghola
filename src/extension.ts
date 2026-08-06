import * as fs from 'fs/promises';
import { readFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { AtlassianClient } from './integration/atlassian-client';
import { adfToPlainText } from './integration/adf-to-text';
import { BitbucketPrClient } from './integration/bitbucket-pr-client';
import { discoverObsidianVault } from './integration/vault-discovery';
import { startBitbucketBridge } from './integration/bitbucket-bridge-server';
import type { GetCommentsResult, PostCommentFn, PostCommentResult } from './integration/bitbucket-bridge-server';
import { isJiraCommentWriteEnabled } from './integration/jira-comment-write-gate';
import { ModuleLoader } from './modules/loader';
import { ModuleState } from './modules/state';
import { PromptComposer } from './prompts/composer';
import { resolveLedgerRoot } from './session/host-path';
import { SessionLauncher } from './session/launcher';
import { BUILT_IN_CONFIGURATIONS, DEFAULT_ENABLED_IDS } from './settings-panel/built-in-configurations';
import { ConfigurationsStore } from './settings-panel/configurations-store';
import { SettingsPanel } from './settings-panel/host';
import { WORKSPACE_STATE_KEYS } from './state/keys';
import {
  BitbucketTokenEntry,
  BitbucketTokenSummary,
  readBitbucketTokens,
  writeBitbucketTokens,
  summarizeBitbucketTokens,
  addBitbucketToken,
  removeBitbucketToken,
  reorderBitbucketTokens,
  setBitbucketTokenLabel,
  replaceBitbucketTokenValue,
} from './state/bitbucket-tokens';
import {
  readModuleSettings,
  writeModuleSettings,
  migrateModuleSettingsToGlobal,
  migrateGitBranchCommandsEnabled,
} from './state/module-settings';
import { ModeStatusBarItem, MODE_STATUS_BAR_CONFIG_SECTION } from './status-bar/mode-status-bar';
import { TicketLinkStatusBarItems, type PrLookupAnswer } from './status-bar/ticket-link-status-bar';

/** Module id for the atlassian-suite integration. */
const ATLASSIAN_MODULE_ID = 'integration.atlassian-suite';

/**
 * SecretStorage keys for the per-product Atlassian API tokens. Jira and
 * Bitbucket are stored under separate keys so the UX is unambiguous about
 * which token authenticates which product — the user enters two distinct
 * tokens (one per product surface) and the bridge never mixes them.
 */
const ATLASSIAN_JIRA_TOKEN_SECRET_KEY = 'ghola.atlassianSuite.jiraToken';
const ATLASSIAN_BITBUCKET_TOKEN_SECRET_KEY = 'ghola.atlassianSuite.bitbucketToken';

/**
 * SecretStorage key for the ORDERED list of Bitbucket tokens (multi-token
 * failover). The whole list is JSON-serialized under this single key (see
 * `state/bitbucket-tokens.ts`). The legacy single-token key above is migrated
 * into this list on first read and then left orphaned in place — never deleted.
 */
const ATLASSIAN_BITBUCKET_TOKENS_SECRET_KEY = 'ghola.atlassianSuite.bitbucketTokens';

/*
 * LEGACY: `ghola.atlassianSuite.apiToken` — SecretStorage key from a
 * previous single-token design that stored one shared token used for both
 * Jira and Bitbucket. Intentionally orphaned in place: this codebase no
 * longer reads, writes, migrates, or deletes it. Users were informed that
 * re-entering credentials once after the split is expected. Recorded here
 * only so future readers do not reintroduce the key under the assumption it
 * is unused — it may still exist in some users' SecretStorage and should
 * stay untouched. Do NOT convert this comment back into a `const`; an
 * unused declaration would trip `noUnusedLocals`.
 */

/**
 * Outcome of a single end-to-end Atlassian credential probe. Each product can
 * be `'ok'` (the API accepted the token), `'failed'` (the API rejected it or
 * the network failed), or `'skipped'` (a required configuration field is
 * missing so the probe was not even attempted).
 *
 * Persisted to `context.workspaceState` so the Settings panel can render a
 * fresh-on-reload indicator without re-running the probes on activation.
 *
 * Shared with SWE-2 — they read this off the bridge to render the panel's
 * Validate-status indicator.
 */
export interface AtlassianValidationResult {
  jira: { status: 'ok' | 'failed' | 'skipped'; message?: string; displayName?: string };
  /**
   * PER-TOKEN Bitbucket outcome — one entry per stored token (keyed by its
   * stable `id`), validated individually so the panel can show which specific
   * token is `ok`, expired (401 → `failed`), or wrong-scope (403 → `failed`).
   * Empty when no Bitbucket token is stored. Jira stays a single aggregate.
   */
  bitbucket: BitbucketTokenValidation[];
  /** ISO 8601 timestamp of when the probe ran. */
  lastCheckedAt: string;
}

/**
 * Validation outcome for a SINGLE Bitbucket token, tied to the entry's stable
 * `id` so the panel can join it back to the masked token row. `message` carries
 * the sanitized reason on `failed` (it preserves the 401-vs-403 hint from the
 * REST probe); the token value never appears here.
 */
export interface BitbucketTokenValidation {
  id: string;
  status: 'ok' | 'failed' | 'skipped';
  message?: string;
  displayName?: string;
}

/**
 * Coordination surface passed to `SettingsPanel` so the panel's webview can
 * query whether each Atlassian API token is currently stored without ever
 * receiving the token value itself, and subscribe to a refresh event when
 * the token-set/clear commands fire. Token VALUES never leave the host.
 *
 * Shared with SWE-2 — they consume this interface when wiring the panel-side
 * per-product token-status indicators.
 */
export interface AtlassianBridge {
  // ── Per-product token storage queries ──
  /** Resolves to true when a Jira token is currently stored in SecretStorage. */
  isJiraTokenSet(): Promise<boolean>;
  /** Resolves to true when a Bitbucket token is currently stored in SecretStorage. */
  isBitbucketTokenSet(): Promise<boolean>;
  /**
   * Read the stored Jira token. Intended ONLY for host-side consumers that
   * need to construct an authenticated HTTP request (the validation routine
   * and the host-side Jira ticket fetcher) or to derive a masked LAST-4
   * fingerprint. The full returned value MUST NOT be forwarded across the
   * webview boundary or written to any log / output channel — only a derived
   * last-4 fragment may cross the boundary (see `broadcastAtlassianTokenStatus`).
   */
  getJiraToken(): Promise<string | undefined>;
  /**
   * Read the stored Bitbucket token. Same host-only contract as
   * `getJiraToken()`. The full value never crosses the webview boundary; only a
   * derived last-4 fragment may.
   *
   * Back-compat single-token accessor: now sourced from the ordered token list
   * (via migration), returning the FIRST entry's value or `undefined` when the
   * list is empty. Existing single-token callers are unaffected.
   */
  getBitbucketToken(): Promise<string | undefined>;

  /**
   * Read the FULL ordered list of Bitbucket tokens, including secret values.
   * Host-only consumer contract (identical to `getBitbucketToken()`): the
   * future rotation loop uses this to try each token in order. Values MUST NOT
   * cross the webview boundary — use `getBitbucketTokenSummaries()` for the UI.
   */
  getBitbucketTokens(): Promise<BitbucketTokenEntry[]>;
  /**
   * Non-secret masked view of the Bitbucket token list for the panel: each
   * entry's `id`, `label`, and last-4 fingerprint only. Safe to forward across
   * the webview boundary.
   */
  getBitbucketTokenSummaries(): Promise<BitbucketTokenSummary[]>;

  // ── Bitbucket token list mutations (all operate on the ordered LIST) ──
  //
  // The webview drives these via the settings-panel protocol. Each mutates the
  // JSON-array secret, fires `onDidChangeAtlassianTokenStatus` so the panel
  // re-broadcasts the masked list, and (for value-changing ops) triggers a
  // re-validate. A token VALUE only ever travels INBOUND (webview -> host, e.g.
  // the user typing a new token) — never back across the boundary, never logged.
  /** Append a new token (secret `value`) with an optional label to the list. */
  addBitbucketToken(label: string | undefined, value: string): Promise<void>;
  /** Remove the token with the given stable `id`. No-op when absent. */
  removeBitbucketToken(id: string): Promise<void>;
  /** Reorder the list to `orderedIds` — this IS the failover order. */
  reorderBitbucketTokens(orderedIds: string[]): Promise<void>;
  /** Rename the token with the given `id`, preserving its id + value. */
  setBitbucketTokenLabel(id: string, label: string): Promise<void>;
  /** Replace the secret `value` of the token with the given `id`. */
  replaceBitbucketTokenValue(id: string, value: string): Promise<void>;
  /**
   * Re-validate a SINGLE Bitbucket token by `id`, merge the result into the
   * cached validation (preserving Jira and every other token's status), persist
   * it, fire `onDidChangeValidation`, and return the merged result. Never throws.
   */
  validateBitbucketToken(id: string): Promise<AtlassianValidationResult>;

  /**
   * Fires whenever EITHER product's token state changes — set or clear, for
   * Jira or Bitbucket. SWE-2 subscribes once and re-queries
   * `isJiraTokenSet()` / `isBitbucketTokenSet()` to refresh the indicators.
   */
  onDidChangeAtlassianTokenStatus: vscode.Event<void>;

  /**
   * Run Jira + Bitbucket reachability probes against the currently-configured
   * settings, persist the result to workspaceState, fire
   * `onDidChangeValidation`, and return the result. Never throws — failures
   * surface as `status: 'failed'` with a user-readable message.
   */
  validate(): Promise<AtlassianValidationResult>;
  /** Last persisted validation result (or `undefined` on first run). */
  getLastValidation(): AtlassianValidationResult | undefined;
  /** Fires every time `validate()` completes (or a token is cleared). */
  onDidChangeValidation: vscode.Event<AtlassianValidationResult>;
}

/**
 * Resolve the War Mode ledger root GLOBALLY for the activation-time ledger
 * watchers, by delegating to the SHARED resolver in `src/session/host-path.ts` —
 * the same call `SettingsPanel.resolveLedgerRoot` (the War Room's reader) and
 * `SessionLauncher` (which exports the root to the CLI, the ledger's writer)
 * make. Sharing one implementation is what keeps the WATCHED location and the
 * WRITTEN location identical; when they were open-coded separately the watchers
 * ended up on a fabricated `C:\mnt\c\...` root on win32 and the War Room simply
 * never refreshed. See that module for the precedence table.
 *
 * NEVER resolves under the open work repo — no `.ghola/` is read from or written
 * to the workspace. Never throws.
 */
function resolveWatchedLedgerRoot(
  context: vscode.ExtensionContext,
  logger: vscode.OutputChannel,
): string {
  return resolveLedgerRoot(context.globalState, context.workspaceState, (m) =>
    logger.appendLine(`[ghola] ${m}`),
  ).root;
}

/**
 * Directory the Claude Code statusline renderer is staged into, and the two
 * files that live there. `<homedir>/.ghola/` is already established Ghola GLOBAL
 * state (it holds `usage-state.json` and, in the no-vault case, `ledger/`), so
 * the renderer gets its own subdirectory inside it rather than being sprinkled
 * across that shared root.
 *
 * `VERSION` is staged BESIDE the renderer deliberately: the renderer resolves
 * its version relative to its OWN location, and its second candidate is
 * `<scriptDir>/VERSION` precisely so this flat two-file layout works (the repo /
 * installed-extension candidate `<scriptDir>/../VERSION` is tried first, so the
 * in-repo behavior is untouched). It doubles as the staging VERSION STAMP.
 */
const STATUSLINE_STAGE_DIRNAME = 'statusline';
const STATUSLINE_RENDERER_FILENAME = 'ghola-statusline.mjs';
const STATUSLINE_VERSION_FILENAME = 'VERSION';

/**
 * Copy the Node statusline renderer (`scripts/ghola-statusline.mjs`) plus a
 * version stamp into `<homedir>/.ghola/statusline/` so the operator's
 * `~/.claude/settings.json` can point `statusLine.command` at a path that NEVER
 * CHANGES.
 *
 * Why staging exists at all: the renderer ships inside the VSIX, but the
 * installed extension directory is version-pinned (`local.ghola-<version>/...`), so
 * a `statusLine.command` aimed there silently breaks on every version bump — the
 * footer just loses its Ghola tag and nothing says why. Pointing at the repo
 * checkout is no better: there is no Windows checkout of Project-Ghola (see
 * CLAUDE.md), which is half the reason the tag has only ever appeared on WSL.
 *
 * ── Why this cannot degrade startup ──────────────────────────────────────
 *   - The caller invokes it fire-and-forget (`void`); nothing awaits it and no
 *     later activation step reads its result.
 *   - The ENTIRE body is inside one try/catch, so the returned promise never
 *     rejects — there is no unhandled rejection to surface even in the worst case.
 *   - Every filesystem call is awaited (`fs/promises`), so the synchronous part
 *     of `activate` is never blocked on disk I/O.
 *   - On ANY failure it logs one non-fatal line and returns. A missing staged
 *     renderer costs the operator a statusline segment, never an extension.
 *
 * ── Idempotence ──────────────────────────────────────────────────────────
 * This runs on every activation, so it must be a cheap no-op once current. It
 * compares the staged VERSION stamp AND the staged renderer bytes against the
 * shipped pair and returns without writing when both already match — the stamp
 * catches the ordinary version-bump case, the byte compare additionally catches
 * an edit made during development at an unchanged version. Two small reads (a
 * few KB) is the entire cost of the steady state.
 *
 * Writes are temp-file-then-rename so a concurrently-running statusline never
 * reads a half-written renderer, and the VERSION stamp is written LAST: if the
 * process dies mid-stage the stamp still reads stale, so the next activation sees
 * the mismatch and retries rather than trusting a partial stage.
 *
 * Touches ONLY these two files. `usage-state.json` and `ledger/` live in the
 * parent directory and are never read, written, or deleted here — nothing is
 * ever deleted here at all.
 *
 * On `~/.claude/settings.json`: deliberately NOT written. That is the operator's
 * live harness config and is out of scope for the extension; the `tool.statusline`
 * module documents the exact line to add, per platform.
 *
 * On path translation: `src/session/host-path.ts`'s `toNativeHostPath` does NOT
 * apply here and is deliberately not called. Its job is to sanitize a path STRING
 * AUTHORED ELSEWHERE that may have crossed the WSL boundary (the shared
 * `vaultPath` setting, a `GHOLA_LEDGER_ROOT` export) and could otherwise be
 * joined into a fabricated `C:\mnt\c\...` tree. Both paths here are produced by
 * the running host for the running host — `context.extensionPath` from VS Code
 * and `os.homedir()` from Node — so they are already native on WSL and on win32
 * alike, and there is no foreign spelling to translate. Running them through it
 * would add a pointless `existsSync` and could not change either value.
 */
async function stageStatuslineRenderer(
  context: vscode.ExtensionContext,
  logger: vscode.OutputChannel,
): Promise<void> {
  try {
    const srcRenderer = path.join(context.extensionPath, 'scripts', STATUSLINE_RENDERER_FILENAME);
    const srcVersion = path.join(context.extensionPath, STATUSLINE_VERSION_FILENAME);
    const stageDir = path.join(os.homedir(), '.ghola', STATUSLINE_STAGE_DIRNAME);
    const destRenderer = path.join(stageDir, STATUSLINE_RENDERER_FILENAME);
    const destVersion = path.join(stageDir, STATUSLINE_VERSION_FILENAME);

    // Read what shipped. Both files are required: staging a renderer without its
    // stamp would leave the line rendering `[Ghola vunknown]`, and staging a stamp
    // without the renderer would leave nothing to run. Either read failing means
    // there is nothing coherent to stage, so we leave any existing stage alone.
    const [rendererText, versionText] = await Promise.all([
      fs.readFile(srcRenderer, 'utf8'),
      fs.readFile(srcVersion, 'utf8'),
    ]);

    // Read what is already staged. Absent / unreadable simply means "not current".
    const readIfPresent = async (p: string): Promise<string | undefined> => {
      try {
        return await fs.readFile(p, 'utf8');
      } catch {
        return undefined;
      }
    };
    const [stagedRenderer, stagedVersion] = await Promise.all([
      readIfPresent(destRenderer),
      readIfPresent(destVersion),
    ]);
    if (stagedVersion === versionText && stagedRenderer === rendererText) return;

    await fs.mkdir(stageDir, { recursive: true });
    const writeAtomic = async (dest: string, text: string): Promise<void> => {
      const tmp = `${dest}.tmp.${process.pid}`;
      try {
        await fs.writeFile(tmp, text, 'utf8');
        await fs.rename(tmp, dest);
      } catch (err) {
        // Never leave a stray temp file behind on a failed stage.
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }
    };
    await writeAtomic(destRenderer, rendererText);
    // Best-effort exec bit for anyone who invokes the staged file directly via
    // its shebang. The documented command form is `node <path>`, which does not
    // need it, so a chmod failure (or win32, where the mode is meaningless) is
    // not worth failing the stage over.
    if (process.platform !== 'win32') {
      await fs.chmod(destRenderer, 0o755).catch(() => undefined);
    }
    // Stamp LAST — see the retry-safety note above.
    await writeAtomic(destVersion, versionText);
    logger.appendLine(`[ghola] statusline renderer staged to ${destRenderer}`);
  } catch (err) {
    logger.appendLine(`[ghola] statusline renderer staging failed (non-fatal): ${err}`);
  }
}

/**
 * Resolve THIS extension's own version for the activation log line.
 *
 * The `VERSION` file at the extension root is the single source of truth for
 * Ghola's version: `scripts/reinstall.sh` keys the update check on it, the
 * `Ghola: Update Extension` command reads the shipped copy of it, and
 * `.githooks/pre-commit` rewrites `package.json`'s version FROM it. Reading the
 * same file here is what keeps the first line an operator sees in the output
 * channel from disagreeing with what the updater compares. `package.json` (via
 * the VS Code manifest) is the fallback only because the hook keeps it in sync;
 * `'unknown'` is the last resort. Same resolution order as the installed-version
 * read in `src/commands/updateExtension.ts`.
 *
 * Synchronous and never-throwing on purpose: it feeds one log line at the very
 * top of `activate`, so it must not be able to fail or defer activation.
 */
function readActivationVersion(context: vscode.ExtensionContext): string {
  try {
    const fileVersion = readFileSync(path.join(context.extensionPath, 'VERSION'), 'utf8').trim();
    if (fileVersion) return fileVersion;
  } catch {
    // Unreadable or absent (e.g. a partial build) — fall through to the manifest.
  }
  const manifestVersion: unknown = context.extension?.packageJSON?.version;
  return typeof manifestVersion === 'string' && manifestVersion ? manifestVersion : 'unknown';
}

/**
 * `globalState` key recording the highest newer-on-disk version the operator has
 * already been offered and declined (see `promptWhenNewerVersionInstalled`).
 *
 * GLOBAL, not workspace: installing a VSIX is a machine-wide act, so a
 * workspace-scoped marker would re-offer the same install once per workspace —
 * exactly the nagging this is built to avoid.
 *
 * Declared here rather than in `src/state/keys.ts` only because that module is
 * outside this change's ownership. If a later change consolidates it, move the
 * literal string VERBATIM — it names persisted state.
 */
const NEWER_INSTALL_DECLINED_VERSION_KEY = 'ghola.newerInstall.declinedVersion';

/**
 * A parsed VS Code extension install-directory name — `local.ghola-0.26.0` split
 * into the identity prefix (`local.ghola-`) and the version as NUMBERS.
 */
interface ParsedInstallDir {
  /** Directory-name prefix, trailing hyphen included. This IS the install identity. */
  prefix: string;
  /** `[major, minor, patch]` as numbers, for ordering. */
  version: [number, number, number];
  /** Canonical `major.minor.patch`, for display. */
  versionText: string;
}

/** The outcome of a successful newer-install scan: what is on disk vs. what is running. */
interface NewerInstall {
  /** Highest strictly-newer sibling version found, canonical `major.minor.patch`. */
  newest: string;
  /** The version this window is actually running, canonical `major.minor.patch`. */
  running: string;
}

// ─── begin: newer-install detection (pure) ───────────────────────────
// Everything from here to the matching end marker is pure — no `vscode`, no
// filesystem, no state. The markers are load-bearing: with no test suite in this
// repo, this block is sliced straight out of this file and exercised against real
// directory listings, so the verified code is literally the shipped code.

/**
 * Parse an extensions-directory entry name of the form
 * `<publisher>.<name>-<major>.<minor>.<patch>[-<platform> | +<build>]`.
 *
 * The optional trailing suffix is not hypothetical: a real extensions directory
 * holds entries like `anthropic.claude-code-2.1.220-linux-x64`, so a parser that
 * required the version to be the entire tail would reject platform-specific
 * installs. Greedy `(.*-)` followed by a REQUIRED numeric triple resolves the
 * split by taking the last hyphen that is actually followed by a version.
 *
 * Returns `undefined` for anything that does not match — `extensions.json`, a
 * hand-renamed directory, a stray file. An unparseable name is never guessed at.
 */
function parseInstallDir(name: string): ParsedInstallDir | undefined {
  const m = /^(.*-)(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(name);
  if (!m) return undefined;
  const version: [number, number, number] = [Number(m[2]), Number(m[3]), Number(m[4])];
  // `\d+` happily matches a digit run longer than Number can represent exactly.
  // A version we cannot hold precisely is one we must not order against.
  if (!version.every((n) => Number.isSafeInteger(n))) return undefined;
  return { prefix: m[1], version, versionText: version.join('.') };
}

/**
 * Parse a BARE `major.minor.patch` string (the shipped `VERSION` file, the stored
 * declined marker) by routing it through `parseInstallDir` with a synthetic
 * prefix. Sharing the one regex is deliberate: the grammar accepted for a bare
 * version and for a directory tail can then never drift apart.
 */
function parseVersionTriple(text: string | undefined): [number, number, number] | undefined {
  if (typeof text !== 'string' || text.trim() === '') return undefined;
  return parseInstallDir(`v-${text.trim()}`)?.version;
}

/**
 * NUMERIC compare of two version triples, returning a sort-comparator sign.
 *
 * String comparison is the bug this exists to prevent: lexically `'0.9.0'` sorts
 * ABOVE `'0.26.0'`, which would have told an operator running 0.26.0 that a
 * long-dead 0.9.0 directory was newer. This repo has already walked 0.24 -> 0.25
 * -> 0.26 with stale directories left behind at each step, so that listing is
 * the normal case, not a contrived one.
 */
function compareVersionTriples(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Given the entry names of an extensions directory and the RUNNING install's own
 * directory name, return the highest sibling version strictly newer than the
 * running one, or `undefined` when there is nothing newer.
 *
 * Rules, each one a "do not prompt spuriously" guard:
 *   - The running directory name must itself parse, or we bail. This is also what
 *     makes the F5 dev host a silent no-op for free: there `extensionPath` is the
 *     repo checkout (`Project-Ghola`), which has no `-<version>` tail, so the
 *     scan ends before it looks at anything.
 *   - A sibling must share the running install's prefix EXACTLY. Nothing about
 *     `herzog.mandrake-0.3.61` sitting alongside is our business, and the shared
 *     prefix is what makes this immune to a differently-named neighbour.
 *   - `declaredRunningVersion` (the shipped `VERSION` file) RAISES the floor when
 *     it is higher than the directory's own version, never lowers it. Directory
 *     name and VERSION file normally agree; if a build ever leaves them
 *     disagreeing, taking the max means "strictly newer than what is running" is
 *     true under BOTH readings before anyone is interrupted.
 *   - Strictly greater only. An equal version is not news — and a repeat
 *     `--force` sideload of the same version reuses the same directory anyway.
 *   - The HIGHEST newer sibling wins, not the first found: with 0.27.0 and 0.28.0
 *     both staged, 0.28.0 is what the operator actually wants to be running, and
 *     keying the decline marker to the highest is what keeps one dismissal from
 *     being re-asked as a lower version.
 */
function findNewerSiblingInstall(
  entryNames: readonly string[],
  runningDirName: string,
  declaredRunningVersion?: string,
): NewerInstall | undefined {
  const running = parseInstallDir(runningDirName);
  if (!running) return undefined;

  let floor = running.version;
  const declared = parseVersionTriple(declaredRunningVersion);
  if (declared && compareVersionTriples(declared, floor) > 0) floor = declared;

  let best: ParsedInstallDir | undefined;
  for (const name of entryNames) {
    if (name === runningDirName) continue;
    const sibling = parseInstallDir(name);
    if (!sibling || sibling.prefix !== running.prefix) continue;
    if (compareVersionTriples(sibling.version, floor) <= 0) continue;
    if (!best || compareVersionTriples(sibling.version, best.version) > 0) best = sibling;
  }
  if (!best) return undefined;
  return { newest: best.versionText, running: floor.join('.') };
}

// ─── end: newer-install detection (pure) ─────────────────────────────

/**
 * Offer a window reload when a NEWER build of Ghola is installed on disk than the
 * one this window is running.
 *
 * Why this exists: `npm run install-local` (`code --install-extension ghola.vsix
 * --force`) drops a new version into the extensions directory while the running
 * extension host keeps executing the OLD one. Nothing said so. The operator had to
 * remember to reload every single time, and twice debugged behaviour that was
 * simply the previous build still running. The in-app `Ghola: Update Extension`
 * command already ends with exactly this offer (see
 * `src/commands/updateExtension.ts`) — but only after a successful IN-APP update,
 * which a hand-run sideload never goes through. Same prompt shape and the same
 * `Reload Window` action label, so the two paths read identically.
 *
 * ── Why this cannot degrade startup ──────────────────────────────────────
 * Same contract as `stageStatuslineRenderer` above: invoked fire-and-forget
 * (`void`), nothing awaits it, the ENTIRE body sits in one try/catch so the
 * returned promise can never reject, and the only filesystem call is an awaited
 * `fs/promises` readdir — so the synchronous part of `activate` never touches
 * disk.
 *
 * ── Fail silent ──────────────────────────────────────────────────────────
 * Unreadable extensions directory, unparseable running directory name, malformed
 * sibling name: one log line, no prompt. A broken scan produces silence, never a
 * guess. Every rejection path is a `return`, so the default is "say nothing".
 *
 * ── Not nagging ──────────────────────────────────────────────────────────
 * This runs on EVERY activation, which means every window reload, so a prompt the
 * operator has already answered must never come back:
 *   - It fires only when a STRICTLY higher version exists (see
 *     `findNewerSiblingInstall`), so the steady state — running the newest build,
 *     stale lower directories lying around — is silent.
 *   - Declining records the offered version in `globalState` under
 *     `NEWER_INSTALL_DECLINED_VERSION_KEY`, and any later scan whose newest find
 *     is `<=` the recorded version stays silent. Only a genuinely higher version
 *     than the one declined can speak again. globalState (not workspaceState) is
 *     what stops a second window on a second workspace re-asking.
 *   - "Declining" covers BOTH `Later` and dismissing the notification outright,
 *     because a dismissal that did not count would come straight back on the next
 *     reload. Accepted trade-off, stated plainly: this is ONE offer per version.
 *     A notification carrying action buttons does not auto-hide — it waits for the
 *     operator — so the offer is not lost to a timeout, and the log line records
 *     it either way.
 *   - Non-modal, unlike the update command's modal. A modal on every activation
 *     would be intolerable; this is passive news the operator may ignore.
 *
 * ── Not fighting VS Code, and not racing the in-app update ───────────────
 * Gallery-installed extensions are VS Code's to update and it raises its own
 * reload prompt when it replaces one, so those are skipped outright and only
 * sideloads are ours to mention. The in-app update flow cannot double up either:
 * this scan happens ONCE, at activation, and nothing watches the directory
 * afterwards — so the newer sibling that `reinstall.sh` writes mid-update is
 * never seen by a second scan. After that update, `Reload Window` activates the
 * newest build (nothing newer -> silence) and `Later` performs no reload at all
 * (no activation -> no second prompt). Either way the operator is asked once.
 */
async function promptWhenNewerVersionInstalled(
  context: vscode.ExtensionContext,
  logger: vscode.OutputChannel,
): Promise<void> {
  try {
    // Gallery vs. sideload. The signal is `__metadata.publisherId`, NOT the
    // presence of `__metadata` — every install has that block. A VSIX sideload's
    // copy holds only { installedTimestamp, targetPlatform, size }, while a
    // gallery install's additionally holds `id` / `publisherId` /
    // `publisherDisplayName`, which VS Code writes from the marketplace response.
    // Verified against a real extensions directory rather than assumed.
    const metadata: unknown = context.extension?.packageJSON?.__metadata;
    const publisherId =
      metadata !== null && typeof metadata === 'object'
        ? (metadata as { publisherId?: unknown }).publisherId
        : undefined;
    if (typeof publisherId === 'string' && publisherId !== '') {
      logger.appendLine(
        '[ghola] newer-install check skipped: gallery-managed install, VS Code owns its own update prompt',
      );
      return;
    }

    // `extensionPath` is the RUNNING build's directory; its parent is the
    // extensions directory, where every other installed version also lives.
    const runningDirName = path.basename(context.extensionPath);
    const entryNames = await fs.readdir(path.dirname(context.extensionPath));
    const found = findNewerSiblingInstall(
      entryNames,
      runningDirName,
      // Prefers the shipped VERSION file, same source of truth as the activation
      // log line and the updater's installed-version read.
      readActivationVersion(context),
    );
    if (!found) return;

    const declined = parseVersionTriple(
      context.globalState.get<string>(NEWER_INSTALL_DECLINED_VERSION_KEY),
    );
    const newest = parseVersionTriple(found.newest);
    if (declined && newest && compareVersionTriples(declined, newest) >= 0) {
      logger.appendLine(
        `[ghola] v${found.newest} is installed on disk but was already declined; not prompting`,
      );
      return;
    }

    logger.appendLine(
      `[ghola] newer install found on disk: v${found.newest} (this window is running v${found.running})`,
    );
    const choice = await vscode.window.showInformationMessage(
      `Ghola v${found.newest} is installed, but this window is still running v${found.running}. Reload window to activate?`,
      'Reload Window',
      'Later',
    );
    if (choice === 'Reload Window') {
      void vscode.commands.executeCommand('workbench.action.reloadWindow');
      return;
    }
    // `Later` AND dismissal both land here (dismissal resolves `undefined`) — see
    // the one-offer-per-version note above.
    await context.globalState.update(NEWER_INSTALL_DECLINED_VERSION_KEY, found.newest);
    logger.appendLine(`[ghola] reload into v${found.newest} declined; will not ask again for it`);
  } catch (err) {
    logger.appendLine(`[ghola] newer-install check failed (non-fatal): ${err}`);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const logger = vscode.window.createOutputChannel('Ghola');
  context.subscriptions.push(logger);
  logger.appendLine(`[ghola] activating v${readActivationVersion(context)}`);

  // Migrate any legacy per-workspace module settings into the global store so
  // field values (Atlassian email, vault path, personas, instructions, etc.)
  // follow the operator across workspaces and survive preset applies. Idempotent
  // and fire-and-forget: reads use `readModuleSettings`, which merges the legacy
  // fallback until this completes, so correctness never depends on its timing.
  // Then flip `git branch <name>` / `git switch` on inside an already-stored
  // tool.git allowed-commands override, which shadows the manifest default.
  // CHAINED, not fired independently: both migrations rewrite the same
  // `ghola.moduleSettings` globalState key, so running them concurrently could
  // let the legacy fold's stale snapshot clobber the flip. The branch-command
  // migration never throws, and the `.catch` keeps a failed legacy fold from
  // both skipping it and surfacing an unhandled rejection.
  void migrateModuleSettingsToGlobal(context.globalState, context.workspaceState)
    .catch((err) => {
      logger.appendLine(`[ghola] module-settings global migration failed (non-fatal): ${err}`);
    })
    .then(() => migrateGitBranchCommandsEnabled(context.globalState, context.workspaceState, logger));

  const moduleState = new ModuleState(context.workspaceState);
  const loader = new ModuleLoader(moduleState, {
    // Cores live in prompts/cores/ and are not modules. The IDs listed here are
    // the modules enabled on first run so the session boots with the same
    // baseline capabilities the cores used to ship inline.
    defaultEnabledIds: DEFAULT_ENABLED_IDS,
    logger,
  });
  context.subscriptions.push({ dispose: () => loader.dispose() });

  // Cores ship with the extension and are read from the extension install path,
  // never the workspace. Always resolve relative to context.extensionPath.
  const coresPath = path.join(context.extensionPath, 'prompts', 'cores');
  const composer = new PromptComposer(loader, coresPath, logger);

  const session = new SessionLauncher(loader, context.extensionPath, context.globalState, context.workspaceState, logger);
  const configurationsStore = new ConfigurationsStore(context.workspaceState);
  const resolveModulesDir = resolveModulesDirFn(context);
  // Path used by the `tool.feedback-log` module: the host reads/writes this
  // file directly from the Feedback panel tab, and the path is injected into
  // the agent-facing Session Manifest as `parameters.feedbackFilePath` so TPM
  // can read/write the same file via its Read/Write tools. `globalStorageUri`
  // is per-extension and persists across workspaces, which matches the user's
  // expectation that the feedback log follows them.
  const feedbackFilePath = path.join(context.globalStorageUri.fsPath, 'feedback.json');

  // ─── Atlassian Suite wiring ─────────────────────────────────────────
  // Emitter fired whenever EITHER product's token state changes (set or
  // clear, Jira or Bitbucket). SWE-2's panel subscribes once and re-queries
  // both `isJiraTokenSet()` / `isBitbucketTokenSet()` on each fire.
  const tokenStatusEmitter = new vscode.EventEmitter<void>();
  context.subscriptions.push(tokenStatusEmitter);

  // Emitter fired whenever a validation probe completes. Set/clear commands
  // for either product re-trigger `validate()`, so subscribers always see a
  // fresh result reflecting the new SecretStorage state (with the cleared
  // product's probe naturally returning `skipped` via the client). The
  // Settings panel subscribes to refresh its indicators.
  const validationEmitter = new vscode.EventEmitter<AtlassianValidationResult>();
  context.subscriptions.push(validationEmitter);

  // Emitter the host fires whenever module-settings change. The Settings panel
  // and the mode / War Mode status-bar item subscribe so they re-pull settings
  // after a save.
  const moduleSettingsEmitter = new vscode.EventEmitter<void>();
  context.subscriptions.push(moduleSettingsEmitter);

  // ───── Ghola identity / usage status-bar item ────────────────────────
  // A native status-bar indicator leading with a literal `Ghola:` product
  // prefix, followed by this window's Team Switchboard identity, this
  // session's modality, and — when a live Claude Code session has rendered a
  // status line for this repository — its context size and 5-hour-window
  // usage (e.g. `$(organization) Ghola: cmms2@win · Ticket Work · 238k · 5h
  // 11%`). The session modality IS in the visible text, not tooltip-only; only
  // the War-Mode flag's full explanation lives in the tooltip rather than the
  // visible text, though the visible text still signals War Mode via a
  // `$(flame)` icon swapped in for the org icon. War Mode is NOT a
  // loader-toggleable module — its source of truth is the `mode.war::enabled`
  // module-setting (an Agents configuration), exactly as the launcher/banner/
  // composer read it — so we resolve it from the flattened MODULE_SETTINGS
  // store rather than loader state, keeping the item's war flag in agreement.
  const readWarMode = (): boolean => {
    const flat = readModuleSettings(context.globalState, context.workspaceState);
    return flat['mode.war::enabled'] === true;
  };
  // The identity itself needs no provider: `resolveTeamIdentity` derives it from
  // this window's own workspace folder, with no operator override to read. The
  // Team Switchboard module used to declare a `teamName` setting that was passed
  // in here, and it was removed deliberately — module settings live in
  // `globalState`, which is shared by every window on the machine, so a single
  // override would have given all of the operator's concurrent windows the same
  // pill and erased the discriminator the pill exists for.
  const modeStatusBar = new ModeStatusBarItem(loader, readWarMode);
  context.subscriptions.push(modeStatusBar);
  // Refresh on: module enable/disable (loader), module-settings save (covers
  // the mode.war::enabled War-Mode toggle), and the statusBar.enabled config
  // toggle (show/hide). Initial paint below reflects the boot state. The usage
  // metrics need no wiring here — the item owns its own state-file watcher and
  // poll timer (and disposes both), because they change on Claude Code's clock
  // rather than on any extension-host event.
  context.subscriptions.push(loader.onDidChange(() => modeStatusBar.refresh()));
  context.subscriptions.push(moduleSettingsEmitter.event(() => modeStatusBar.refresh()));
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(MODE_STATUS_BAR_CONFIG_SECTION)) modeStatusBar.refresh();
    }),
  );
  modeStatusBar.refresh();

  /**
   * Read a single Atlassian-module setting from the flattened GLOBAL
   * `ghola.moduleSettings` map (via `readModuleSettings`). Falls back to the
   * manifest's declared default (if any) when the user has not yet saved the
   * field — this mirrors the webview's own `state.settingsValues[key] ??
   * field.default` logic so that pre-populated default values are visible to
   * validate() even before the user has explicitly clicked Save.
   */
  const readAtlassianSetting = (fieldKey: string): string => {
    const flat = readModuleSettings(context.globalState, context.workspaceState);
    const v = flat[`${ATLASSIAN_MODULE_ID}::${fieldKey}`];
    if (typeof v === 'string') return v;
    // No saved value — fall back to the manifest default so that fields shown
    // as pre-populated in the UI (e.g. bitbucketWorkspace: "herzog-technologies")
    // are treated as present by validation even before the user has saved them.
    const manifestDefault = loader
      .find(ATLASSIAN_MODULE_ID)
      ?.manifest.contributes?.settings?.[fieldKey]?.default;
    return typeof manifestDefault === 'string' ? manifestDefault : '';
  };

  // Read the ordered Bitbucket token list, running the one-time non-destructive
  // legacy migration on first access. All Bitbucket bridge accessors below
  // route through this so single-token and multi-token callers see one source.
  const readBbTokens = (): Promise<BitbucketTokenEntry[]> =>
    readBitbucketTokens(
      context.secrets,
      ATLASSIAN_BITBUCKET_TOKENS_SECRET_KEY,
      ATLASSIAN_BITBUCKET_TOKEN_SECRET_KEY,
    );

  // Probe ONE Bitbucket token in isolation and map it to a per-token result.
  // A single-token client means the shared failover loop makes exactly one
  // attempt, so the returned status reflects THIS entry alone (401 → expired,
  // 403 → wrong-scope, both surface as `failed` with the sanitized message).
  // The value is only used to build the client; it never leaves this scope.
  const probeBitbucketEntry = async (
    entry: BitbucketTokenEntry,
    email: string,
    bitbucketWorkspace: string,
  ): Promise<BitbucketTokenValidation> => {
    const client = new AtlassianClient({
      email,
      bitbucketTokens: [entry.value],
      jiraBase: '',
      bitbucketWorkspace,
    });
    const probe = await client.validateBitbucket();
    return {
      id: entry.id,
      status: probe.status,
      message: probe.message,
      displayName: probe.displayName,
    };
  };

  const atlassianBridge: AtlassianBridge = {
    isJiraTokenSet: async () =>
      (await context.secrets.get(ATLASSIAN_JIRA_TOKEN_SECRET_KEY)) !== undefined,
    isBitbucketTokenSet: async () => (await readBbTokens()).length > 0,
    onDidChangeAtlassianTokenStatus: tokenStatusEmitter.event,
    getJiraToken: async () => context.secrets.get(ATLASSIAN_JIRA_TOKEN_SECRET_KEY),
    getBitbucketToken: async () => (await readBbTokens())[0]?.value,
    getBitbucketTokens: () => readBbTokens(),
    getBitbucketTokenSummaries: async () => summarizeBitbucketTokens(await readBbTokens()),
    getLastValidation: () =>
      context.workspaceState.get<AtlassianValidationResult>(WORKSPACE_STATE_KEYS.ATLASSIAN_LAST_VALIDATION),
    onDidChangeValidation: validationEmitter.event,
    validate: async (): Promise<AtlassianValidationResult> => {
      // Read the Jira token and the ordered Bitbucket token list in parallel so
      // a slow SecretStorage call on one product does not serialise the other.
      // Jira stays single-token; Bitbucket is validated PER-TOKEN (each entry
      // probed individually) so the panel can show which specific token is
      // ok / expired / wrong-scope. Either side may be empty — a single-token
      // Jira client and an empty Bitbucket list both degrade to `skipped`.
      const [jiraToken, bitbucketTokenEntries] = await Promise.all([
        context.secrets.get(ATLASSIAN_JIRA_TOKEN_SECRET_KEY),
        readBbTokens(),
      ]);
      const email = readAtlassianSetting('email');
      const jiraBase = readAtlassianSetting('jiraBase');
      const bitbucketWorkspace = readAtlassianSetting('bitbucketWorkspace');
      const jiraClient = new AtlassianClient({
        email,
        jiraToken,
        jiraBase,
        bitbucketWorkspace: '',
      });
      const [jira, bitbucket] = await Promise.all([
        jiraClient.validateJira(),
        Promise.all(
          bitbucketTokenEntries.map((entry) =>
            probeBitbucketEntry(entry, email, bitbucketWorkspace),
          ),
        ),
      ]);
      const result: AtlassianValidationResult = {
        jira,
        bitbucket,
        lastCheckedAt: new Date().toISOString(),
      };
      await context.workspaceState.update(WORKSPACE_STATE_KEYS.ATLASSIAN_LAST_VALIDATION, result);
      validationEmitter.fire(result);
      return result;
    },
    // ── List mutations ── Each fires the token-status event so the panel
    // re-broadcasts the masked list; value-changing ops (add / replace) also
    // trigger a re-validate so the per-token status stays fresh.
    addBitbucketToken: async (label, value) => {
      await addBitbucketToken(context.secrets, ATLASSIAN_BITBUCKET_TOKENS_SECRET_KEY, label, value);
      tokenStatusEmitter.fire();
      void atlassianBridge.validate();
    },
    removeBitbucketToken: async (id) => {
      await removeBitbucketToken(context.secrets, ATLASSIAN_BITBUCKET_TOKENS_SECRET_KEY, id);
      tokenStatusEmitter.fire();
    },
    reorderBitbucketTokens: async (orderedIds) => {
      await reorderBitbucketTokens(context.secrets, ATLASSIAN_BITBUCKET_TOKENS_SECRET_KEY, orderedIds);
      tokenStatusEmitter.fire();
    },
    setBitbucketTokenLabel: async (id, label) => {
      await setBitbucketTokenLabel(context.secrets, ATLASSIAN_BITBUCKET_TOKENS_SECRET_KEY, id, label);
      tokenStatusEmitter.fire();
    },
    replaceBitbucketTokenValue: async (id, value) => {
      await replaceBitbucketTokenValue(context.secrets, ATLASSIAN_BITBUCKET_TOKENS_SECRET_KEY, id, value);
      tokenStatusEmitter.fire();
      void atlassianBridge.validate();
    },
    validateBitbucketToken: async (id): Promise<AtlassianValidationResult> => {
      // Re-validate ONE token and merge it into the cached result so Jira and
      // every other token's status is preserved. Starting from the last cached
      // result (or an empty scaffold) keeps a per-row Validate from wiping the
      // rest of the panel.
      const prior = context.workspaceState.get<AtlassianValidationResult>(
        WORKSPACE_STATE_KEYS.ATLASSIAN_LAST_VALIDATION,
      );
      const jira = prior?.jira ?? { status: 'skipped' as const };
      const bitbucket = prior?.bitbucket ? [...prior.bitbucket] : [];
      const entries = await readBbTokens();
      const entry = entries.find((e) => e.id === id);
      if (!entry) {
        // Token was removed between click and probe — drop any stale row.
        const result: AtlassianValidationResult = {
          jira,
          bitbucket: bitbucket.filter((b) => b.id !== id),
          lastCheckedAt: new Date().toISOString(),
        };
        await context.workspaceState.update(WORKSPACE_STATE_KEYS.ATLASSIAN_LAST_VALIDATION, result);
        validationEmitter.fire(result);
        return result;
      }
      const email = readAtlassianSetting('email');
      const bitbucketWorkspace = readAtlassianSetting('bitbucketWorkspace');
      const probed = await probeBitbucketEntry(entry, email, bitbucketWorkspace);
      const idx = bitbucket.findIndex((b) => b.id === id);
      if (idx >= 0) bitbucket[idx] = probed;
      else bitbucket.push(probed);
      const result: AtlassianValidationResult = {
        jira,
        bitbucket,
        lastCheckedAt: new Date().toISOString(),
      };
      await context.workspaceState.update(WORKSPACE_STATE_KEYS.ATLASSIAN_LAST_VALIDATION, result);
      validationEmitter.fire(result);
      return result;
    },
  };

  // Long-lived Bitbucket PR-comments client. Token and workspace are read
  // lazily on every request via the bridge + setting accessor, so one
  // instance lives for the extension's lifetime and naturally honors
  // token / workspace changes without rebuilding.
  const bitbucketPrClient = new BitbucketPrClient(atlassianBridge, readAtlassianSetting);

  // ───── Ticket-link status-bar buttons (ticket-work mode) ───────────
  // Two icon-only buttons beside the Ghola pill: $(issues) opens the Jira
  // ticket derived from the branch name, $(git-pull-request) opens the
  // branch's Bitbucket PR. Both are gated on mode.ticket-work and share the
  // pill's ghola.statusBar.enabled toggle. The PR lookup is adapted from
  // BitbucketPrClient.findOpenPrForBranch via a never-throwing shim that
  // maps PrLookupResult into the status bar's own PrLookupAnswer shape.
  const findPrForBranch = async (repoSlug: string, branch: string): Promise<PrLookupAnswer> => {
    try {
      const result = await bitbucketPrClient.findOpenPrForBranch(repoSlug, branch);
      if (result.prUrl !== null) {
        return {
          kind: 'found',
          url: result.prUrl,
          id: result.prId,
          state: result.prState,
        };
      }
      // Distinguish a confirmed absence from a lookup failure: PrLookupResult
      // carries `failure` when the client could not reach Bitbucket at all.
      const failure = (result as { failure?: { message?: string } }).failure;
      if (failure !== undefined) {
        return { kind: 'unknown', reason: failure.message ?? 'lookup failed' };
      }
      return { kind: 'none' };
    } catch (error) {
      return { kind: 'unknown', reason: error instanceof Error ? error.message : String(error) };
    }
  };
  const ticketLinkStatusBar = new TicketLinkStatusBarItems(loader, readAtlassianSetting, findPrForBranch);
  context.subscriptions.push(ticketLinkStatusBar);
  // Same event set as the Ghola pill: module enable/disable, module-settings
  // save, and the statusBar.enabled config toggle. The branch poll timer and
  // any PR-lookup completion are managed inside the class itself.
  context.subscriptions.push(loader.onDidChange(() => ticketLinkStatusBar.refresh()));
  context.subscriptions.push(moduleSettingsEmitter.event(() => ticketLinkStatusBar.refresh()));
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(MODE_STATUS_BAR_CONFIG_SECTION)) ticketLinkStatusBar.refresh();
    }),
  );
  ticketLinkStatusBar.refresh();

  // Host-side Jira ticket fetcher passed into the loopback bridge. Reads the
  // current email + jiraBase settings and the Jira token via the bridge, builds
  // a fresh AtlassianClient, fetches the
  // ticket, and converts the ADF `description` to plain text host-side so the
  // CLI agent only ever sees text. The Jira token is confined to the client we
  // construct here — it is never logged nor returned in the result.
  const jiraGetTicket = async (
    key: string,
  ): Promise<{ exists: boolean; status?: string; summary?: string; description?: string; error?: string }> => {
    try {
      const email = readAtlassianSetting('email');
      const jiraBase = readAtlassianSetting('jiraBase');
      const jiraToken = await atlassianBridge.getJiraToken();
      const client = new AtlassianClient({
        email,
        jiraToken,
        jiraBase,
        bitbucketWorkspace: '',
      });
      const result = await client.getTicketDetails(key);
      if (!result.exists) {
        return result.error ? { exists: false, error: result.error } : { exists: false };
      }
      const description =
        result.description !== undefined ? adfToPlainText(result.description) : undefined;
      return {
        exists: true,
        status: result.status,
        summary: result.summary,
        description: description || undefined,
      };
    } catch {
      // Never surface an internal error (or the token) to the caller.
      return { exists: false, error: 'ticket fetch failed' };
    }
  };

  // Host-side Jira COMMENT fetcher passed into the loopback bridge. Same
  // containment story as `jiraGetTicket` above: reads the current email +
  // jiraBase settings and the Jira token via the bridge, builds a fresh
  // AtlassianClient, and flattens each comment's ADF body to plain text
  // host-side so the CLI agent only ever sees text. This is a READ — it does
  // not, and must not, post Jira comments.
  //
  // The three outcomes are kept strictly apart, because merging them is exactly
  // the bug that has misled agents before:
  //   - issue exists with no comments -> { exists: true, comments: [] } (SUCCESS)
  //   - issue genuinely absent        -> { exists: false, comments: [] }
  //   - real failure                  -> `error` set, with 'Jira not configured'
  //     distinguishing "no credentials" from "no ticket".
  const jiraGetComments = async (key: string): Promise<GetCommentsResult> => {
    try {
      const email = readAtlassianSetting('email');
      const jiraBase = readAtlassianSetting('jiraBase');
      const jiraToken = await atlassianBridge.getJiraToken();
      const client = new AtlassianClient({
        email,
        jiraToken,
        jiraBase,
        bitbucketWorkspace: '',
      });
      const result = await client.getIssueComments(key);
      if (result.error) {
        return { exists: result.exists, comments: [], error: result.error };
      }
      if (!result.exists) {
        return { exists: false, comments: [] };
      }
      // Truncation metadata is carried through EXPLICITLY. This projection
      // rebuilds the result from scratch (deliberately — it is what keeps raw
      // ADF and any future internal field from reaching the agent), but that
      // same property means any field not named here is silently dropped. The
      // host walk can stop early on its page cap or its time budget, and until
      // these three were forwarded a partial thread arrived looking exactly like
      // a complete one: no flag, no note, no way for the caller to know. A
      // partial answer indistinguishable from a whole one is the worst failure
      // shape available, because nothing looks wrong.
      //
      // Spread-conditional rather than unconditional so the wire shape is
      // unchanged for the overwhelmingly common complete read.
      return {
        exists: true,
        comments: result.comments.map((c) => ({
          author: c.author,
          created: c.created,
          body: c.body !== undefined ? adfToPlainText(c.body) : '',
        })),
        ...(result.truncated === true ? { truncated: true } : {}),
        ...(result.message !== undefined ? { message: result.message } : {}),
        ...(result.totalAvailable !== undefined ? { totalAvailable: result.totalAvailable } : {}),
      };
    } catch {
      // Never surface an internal error (or the token) to the caller.
      return { exists: false, comments: [], error: 'comment fetch failed' };
    }
  };

  // Host-side Jira comment POSTER passed into the loopback bridge. This is the
  // extension's ONLY Jira write. Same containment story as the readers above —
  // settings and token are read here, the token never leaves the host, and only
  // a sanitized result shape goes back to the agent.
  //
  // Authorization does NOT live here. Agent cores forbid ticketing-system
  // mutations outright; the Jira Comment Write flow in
  // `integration.atlassian-suite` is what lifts that for a session — and only
  // when the operator has turned on its `enableJiraCommentWrite` setting, which
  // defaults to off. Even then it requires the operator to approve the exact
  // comment text before anything is posted. This closure is the plumbing that
  // flow drives, not a licence to post.
  //
  // Note the failure contract: `posted: false` with an error can mean the post
  // definitely failed OR that it timed out ambiguously and may have landed.
  // Nothing here retries, precisely because of that second case.
  const jiraPostComment = async (key: string, body: string): Promise<PostCommentResult> => {
    try {
      const email = readAtlassianSetting('email');
      const jiraBase = readAtlassianSetting('jiraBase');
      const jiraToken = await atlassianBridge.getJiraToken();
      const client = new AtlassianClient({
        email,
        jiraToken,
        jiraBase,
        bitbucketWorkspace: '',
      });
      const result = await client.postIssueComment(key, body);
      if (result.error) {
        return { posted: false, error: result.error };
      }
      return {
        posted: result.posted,
        ...(result.id !== undefined ? { id: result.id } : {}),
      };
    } catch {
      // Never surface an internal error (or the token) to the caller. The
      // comment may or may not have been created — say so honestly rather than
      // implying a clean failure.
      return { posted: false, error: 'comment post failed (state unconfirmed)' };
    }
  };

  // HOST-SIDE ENFORCEMENT of `integration.atlassian-suite`'s
  // `enableJiraCommentWrite` gate. The bridge asks this resolver for the poster
  // on EVERY `/post-comment` request; while the gate is shut it gets `undefined`
  // and refuses the route with nothing to call. That is the difference between
  // the gate the operator approved and the strongly-worded suggestion it was:
  // previously the capability was wired in unconditionally and only the module's
  // markdown asked an agent not to use it, so ignoring the markdown was enough
  // to post.
  //
  // Per-request, not activation-time, so turning the setting OFF applies to the
  // next call rather than at the next window reload. Both inputs are read live:
  // `loader.find(...)?.isEnabled` reflects the current Modules-tab state (the
  // loader mutates the handle on enable/disable) and `readModuleSettings` re-reads
  // the flat map, which is also why a sibling window's save is picked up.
  //
  // Module enablement is checked as well as the value, because the value lives in
  // `globalState` while enablement is per-workspace — a `true` left over from a
  // window where the suite is on must not hold the gate open in one where it is
  // off. `isJiraCommentWriteEnabled` never throws and treats every non-`true`
  // outcome as OFF; see `jira-comment-write-gate.ts`.
  const resolveJiraPostComment = (): PostCommentFn | undefined =>
    isJiraCommentWriteEnabled({
      isModuleEnabled: () => loader.find(ATLASSIAN_MODULE_ID)?.isEnabled,
      readSettings: () => readModuleSettings(context.globalState, context.workspaceState),
    })
      ? jiraPostComment
      : undefined;

  // Loopback bridge: exposes `bitbucketPrClient` (Bitbucket PR ops),
  // `jiraGetTicket` (Jira ticket reads), `jiraGetComments` (Jira comment reads)
  // and `resolveJiraPostComment` (the single Jira write, WITHHELD per request
  // unless `integration.atlassian-suite`'s `enableJiraCommentWrite` setting is
  // on) to the CLI agent over a per-session
  // bearer-authenticated HTTP server bound to 127.0.0.1. The Bitbucket and Jira
  // API tokens stay host-side; the agent only receives the loopback URL +
  // bearer token via the session env (wired into the launcher below). When the
  // bridge fails to bind, `startBitbucketBridge` returns null and we inject no
  // env — the CLI-side module then fails loud instead of silently targeting a
  // phantom bridge.
  // `startBitbucketBridge` resolves only once the loopback server is actually
  // listening (so its random port -> url is known). We await it in a
  // fire-and-forget IIFE rather than blocking `activate`: binding a loopback
  // socket completes within a tick, long before the user can click Launch, so
  // `setBridge` runs well before any session starts and the env injects. The
  // token is only ever handed to `setBridge` (terminal env) — never logged.
  //
  // The bridge also writes its live `{ url, token }` to a COORDINATES FILE and
  // the launcher exports that path as GHOLA_BRIDGE_FILE. Location:
  // `context.storageUri` — VS Code's workspace-scoped storage dir, which lives
  // under the extension host's own state, NOT inside the user's workspace
  // folder. That placement is deliberate and load-bearing: the file contains a
  // bearer token, and a token inside the repo could be committed. We fall back
  // to `globalStorageUri` (also outside any workspace) for the no-folder-open
  // case, where `storageUri` is undefined. The path derives from the workspace,
  // never from the random port, so it is STABLE across host restarts — which is
  // the entire point: an already-running agent terminal keeps resolving the
  // live bridge after a reload instead of being orphaned on a dead port.
  const bridgeStorageUri = context.storageUri ?? context.globalStorageUri;
  const bridgeCoordinatesPath = bridgeStorageUri
    ? path.join(bridgeStorageUri.fsPath, 'bridge.json')
    : undefined;
  void (async () => {
    const bbBridge = await startBitbucketBridge(
      bitbucketPrClient,
      jiraGetTicket,
      jiraGetComments,
      resolveJiraPostComment,
      bridgeCoordinatesPath,
      logger,
    );
    if (bbBridge) {
      context.subscriptions.push({ dispose: () => bbBridge.dispose() });
      session.setBridge(bbBridge.url, bbBridge.token, bbBridge.coordinatesPath);
    }
  })();

  const panel = new SettingsPanel(
    context,
    loader,
    composer,
    configurationsStore,
    resolveModulesDir,
    feedbackFilePath,
    atlassianBridge,
    moduleSettingsEmitter,
    logger,
  );
  context.subscriptions.push(panel);

  // Auto-reopen the settings panel after a window reload (e.g. the in-app
  // "Update Extension" flow ends with workbench.action.reloadWindow, which
  // would otherwise close the panel). VS Code persists that a panel of this
  // viewType was open and calls back here on the next activation; we adopt the
  // restored panel onto the same singleton SettingsPanel instance so it
  // re-renders from current extension state. No custom getState/setState is
  // needed — the panel content is derived from workspace/global state, not
  // webview-local state. `onStartupFinished` in activationEvents guarantees the
  // extension is active when restore happens.
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer('gholaSettings', {
      async deserializeWebviewPanel(restored: vscode.WebviewPanel): Promise<void> {
        panel.revive(restored);
      },
    }),
  );

  // Register the five Atlassian token commands. All are user-discoverable
  // from the Command Palette (declared in package.json) and can also be
  // invoked programmatically by the panel UI via
  // vscode.commands.executeCommand. Set/clear commands are split per product
  // — Jira and Bitbucket each get their own pair so the UX is unambiguous
  // about which token authenticates which surface.
  //
  // Token leak audit for this block:
  //   - Token values are read only from `showInputBox` (password-masked) and
  //     written directly to SecretStorage. They are never logged, echoed, or
  //     placed in any error path. `validate()` returns a sanitized shape that
  //     never contains the raw token.
  context.subscriptions.push(
    vscode.commands.registerCommand('ghola.atlassianSuite.setJiraToken', async () => {
      const value = await vscode.window.showInputBox({
        prompt: 'Jira API token',
        password: true,
        ignoreFocusOut: true,
      });
      // User cancelled: showInputBox returns undefined. Empty-string and
      // whitespace-only input are treated as cancel too so we don't store a
      // sentinel empty secret or a token corrupted by stray whitespace.
      const token = value?.trim();
      if (!token) return;
      await context.secrets.store(ATLASSIAN_JIRA_TOKEN_SECRET_KEY, token);
      tokenStatusEmitter.fire();
      // Fire-and-forget validation. The validation event listeners pick up
      // the result asynchronously; awaiting would block the command UI until
      // both probes return. Errors inside `validate()` are converted to a
      // `failed` result so no rejection can escape.
      void atlassianBridge.validate();
    }),
    vscode.commands.registerCommand('ghola.atlassianSuite.clearJiraToken', async () => {
      await context.secrets.delete(ATLASSIAN_JIRA_TOKEN_SECRET_KEY);
      tokenStatusEmitter.fire();
      // Re-run validation so the persisted result reflects "Jira token
      // missing" for the cleared product without disturbing Bitbucket's
      // current state. The client handles the per-product `skipped` shape.
      void atlassianBridge.validate();
    }),
    vscode.commands.registerCommand('ghola.atlassianSuite.setBitbucketToken', async () => {
      const value = await vscode.window.showInputBox({
        prompt: 'Bitbucket API token',
        password: true,
        ignoreFocusOut: true,
      });
      const token = value?.trim();
      if (!token) return;
      // Multi-token: APPEND to the ordered list (the failover order) rather than
      // writing the orphaned legacy single key. A single-token user who runs this
      // once still ends up with a working 1-entry list.
      await addBitbucketToken(context.secrets, ATLASSIAN_BITBUCKET_TOKENS_SECRET_KEY, undefined, token);
      tokenStatusEmitter.fire();
      void atlassianBridge.validate();
    }),
    vscode.commands.registerCommand('ghola.atlassianSuite.clearBitbucketToken', async () => {
      // Multi-token: clear the whole list (write an empty array) rather than the
      // orphaned legacy single key. A valid empty list is authoritative, so the
      // migration never re-seeds it from the legacy token on the next read.
      await writeBitbucketTokens(context.secrets, ATLASSIAN_BITBUCKET_TOKENS_SECRET_KEY, []);
      tokenStatusEmitter.fire();
      void atlassianBridge.validate();
    }),
    vscode.commands.registerCommand('ghola.atlassianSuite.validateToken', async () => {
      // On-demand validation invoked by SWE-2's Validate button (and from
      // the Command Palette). Result lands via the validation event
      // listeners; we still return it so callers that want to await the
      // outcome can do so.
      return atlassianBridge.validate();
    }),
  );

  registerCommands(context, {
    loader,
    panel,
    session,
    resolveModulesDir,
    logger,
  });

  // Initial discovery (best-effort). After discover() resolves we apply any
  // user-flagged default configuration so the workspace boots into the same
  // preset they last marked as default. The dev-mode openSettings call below
  // intentionally runs after this chain so the panel renders with the applied
  // configuration in place.
  void loader.discover(resolveModulesDirFn(context)())
    .then(async (handles) => {
    logger.appendLine(`[ghola] discovered ${handles.length} module(s)`);
    await seedBuiltInConfigurations(context, configurationsStore, logger);
    await panel.applyDefaultOnStartup();

    // Load-time ghola-ledger backfill. `mode.war::enabled` (an Agents
    // configuration tracked in the module-settings store, NOT a loader toggle)
    // can be true while its required `tool.ghola-ledger` module is left disabled
    // in the loader. The dependency is only pulled on the webview master-toggle
    // ON transition, so a session restored/booted with ghola already enabled
    // never composes the ledger contract fragment, leaving TPM's prompt
    // referencing a `ghola` CLI whose contract was never included. Auto-enable
    // the ledger here (same loader.enable path the toggleModule handler uses) so
    // the composed prompt stays coherent. Runs after applyDefaultOnStartup so it
    // reflects the final resolved settings/enabled state. No-op when ghola is off
    // or the ledger is already enabled/undiscovered.
    const gholaFlat = readModuleSettings(context.globalState, context.workspaceState);
    const gholaEnabled = gholaFlat['mode.war::enabled'] === true;
    const ledgerHandle = loader.find('tool.ghola-ledger');
    if (gholaEnabled && ledgerHandle && !ledgerHandle.isEnabled) {
      await loader.enable('tool.ghola-ledger');
      logger.appendLine(
        '[ghola] ghola-ledger backfill: mode.war is enabled but tool.ghola-ledger was disabled; auto-enabled it',
      );
    }

    // One-time boot auto-detect of the Obsidian vault. When `tool.obsidian-notes`
    // is enabled and its `vaultPath` is still empty, run discovery once and write
    // any found vault into the flat module-settings dict — the same write the
    // panel's "Detect Vault" button performs — so Notes goes green without a
    // manual click. Fire-and-forget so the filesystem scan never blocks
    // activation; the empty-only guard makes it naturally one-time (a written
    // path is non-empty on the next boot, so this skips). Wrapped so a scan or
    // write fault just leaves vaultPath empty, exactly as before.
    void (async () => {
      try {
        const notesEnabled = loader.find('tool.obsidian-notes')?.isEnabled === true;
        if (!notesEnabled) return;
        const flat = readModuleSettings(context.globalState, context.workspaceState);
        const current = flat['tool.obsidian-notes::vaultPath'];
        // Empty-only guard: never overwrite a user-set (non-whitespace) path.
        if (typeof current === 'string' && current.trim() !== '') return;
        const result = await discoverObsidianVault();
        if (!result.vaultPath) return;
        // Re-read immediately before writing so a concurrent panel write (e.g. a
        // user clicking Detect Vault mid-scan) is not clobbered by a stale copy.
        const latest = readModuleSettings(context.globalState, context.workspaceState);
        const latestCurrent = latest['tool.obsidian-notes::vaultPath'];
        if (typeof latestCurrent === 'string' && latestCurrent.trim() !== '') return;
        const next = { ...latest, ['tool.obsidian-notes::vaultPath']: result.vaultPath };
        await writeModuleSettings(context.globalState, next);
        // Mirror the panel's Detect-Vault refresh side effects so the panel and
        // composed prompts pick up the newly written path.
        panel.broadcastComposedPrompts();
        moduleSettingsEmitter.fire();
        logger.appendLine(`[ghola] obsidian vault auto-detected on boot: ${result.vaultPath}`);
      } catch (err) {
        logger.appendLine(`[ghola] obsidian vault boot auto-detect failed (non-fatal): ${err}`);
      }
    })();

    if (context.extensionMode === vscode.ExtensionMode.Development) {
      vscode.commands.executeCommand('ghola.openSettings');
    }
  });

  // File watcher: re-discover and re-broadcast composed prompts whenever a
  // manifest.json is added, changed, or deleted (250 ms debounce).
  const watcherDisposable = loader.watchManifests(resolveModulesDirFn(context), () => {
    panel.broadcastComposedPrompts();
  });
  context.subscriptions.push(watcherDisposable);

  // React to config changes that affect paths.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('ghola.modulesDir')) {
        void vscode.commands.executeCommand('ghola.reloadModules');
      }
    }),
  );

  // ───── War Room ledger watchers (War Mode) ────────────────────────
  // The ledger root is resolved GLOBALLY (GHOLA_LEDGER_ROOT env, else the
  // `tool.obsidian-notes` `vaultPath` setting -> <vault>/_Gholas, else
  // <homedir>/.ghola/ledger) — the SAME resolution the CLI, launcher, and host
  // use, and NEVER the open work repo. Two watchers on that real location
  // (mirroring loader.watchManifests' 250ms debounce), each re-posting the War
  // Room on any ghola-command / control write:
  //   - ledger:  <root>/**/*.md          — mission/ghola/alerts/notes writes.
  //   - control: <root>/**/control.json  — per-subject cooperative-control writes
  //              (a CLI `*-ack` or a host button touches only control.json, not
  //              any .md, so it needs its own watcher or pending indicators go
  //              stale). control.json is not a .md file, so the ledger watcher
  //              never sees it.
  // The root is static for the session, so both watchers are created once at
  // activation and target the real path even before the dir exists (the CLI's
  // resolveContext mkdir -p's it on first write). Watching a vault on /mnt/c can
  // be unreliable; that is fine — the War Room tab re-reads on open. Both
  // watchers + the debounce timer are disposed on deactivate.
  {
    const ledgerRoot = resolveWatchedLedgerRoot(context, logger);
    let warRoomDebounce: ReturnType<typeof setTimeout> | undefined;

    const scheduleWarRoomRefresh = (): void => {
      if (warRoomDebounce !== undefined) clearTimeout(warRoomDebounce);
      warRoomDebounce = setTimeout(() => {
        warRoomDebounce = undefined;
        void panel.postWarRoom();
      }, 250);
    };

    const ledgerWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(ledgerRoot, '**/*.md'),
    );
    ledgerWatcher.onDidCreate(scheduleWarRoomRefresh);
    ledgerWatcher.onDidChange(scheduleWarRoomRefresh);
    ledgerWatcher.onDidDelete(scheduleWarRoomRefresh);

    const controlWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(ledgerRoot, '**/control.json'),
    );
    controlWatcher.onDidCreate(scheduleWarRoomRefresh);
    controlWatcher.onDidChange(scheduleWarRoomRefresh);
    controlWatcher.onDidDelete(scheduleWarRoomRefresh);

    context.subscriptions.push(ledgerWatcher, controlWatcher, {
      dispose: () => {
        if (warRoomDebounce !== undefined) clearTimeout(warRoomDebounce);
      },
    });
  }

  // ───── Claude Code statusline renderer staging ─────────────────────
  // Copy `scripts/ghola-statusline.mjs` + a VERSION stamp into
  // `<homedir>/.ghola/statusline/` so `statusLine.command` in the operator's
  // `~/.claude/settings.json` can be a VERSION-STABLE path instead of the
  // version-pinned extension install dir (which breaks on every bump) or a repo
  // checkout (which does not exist on native Windows). Fire-and-forget and fully
  // self-contained: it never blocks activation, never throws, and a failure costs
  // a statusline segment rather than extension startup. We do NOT touch
  // `~/.claude/settings.json` — the `tool.statusline` module documents the line
  // the operator adds once, and it never needs changing again.
  void stageStatuslineRenderer(context, logger);

  // ───── Newer-build-on-disk reload offer ────────────────────────────
  // `npm run install-local` sideloads a new VSIX while this window keeps running
  // the previous build, and until now nothing said so. Offer the same reload
  // prompt the in-app update flow ends with. Fire-and-forget on the identical
  // contract as the staging call above: never awaited, never rejects, one async
  // readdir, silent on any failure, and it cannot re-ask a version already
  // declined. See `promptWhenNewerVersionInstalled` for the full rationale.
  void promptWhenNewerVersionInstalled(context, logger);

  // Dev-mode convenience auto-open lives inside the discover().then() block
  // above so it runs after applyDefaultOnStartup completes.
}

export function deactivate(): void {
  // No-op; subscriptions handle cleanup.
}

/**
 * Built-in presets that were seeded under an earlier name and must be renamed
 * in place on activation. Because seeded presets are tracked by NAME, a plain
 * source rename would strand the old-named entry in existing stores AND seed a
 * fresh duplicate under the new name; the rename-migration pass in
 * `seedBuiltInConfigurations` reconciles both.
 */
const BUILT_IN_RENAMES: { from: string; to: string }[] = [{ from: 'CD (Project)', to: 'Project' }];

/**
 * Built-in presets that were seeded under an earlier build but have since been
 * retired from source. Because seeded presets are tracked by NAME, a plain
 * source deletion would strand the already-seeded entry in existing stores
 * (still shown in the dropdown); the removal-migration pass in
 * `seedBuiltInConfigurations` deletes the stored entry and clears its seeded
 * marker so it neither lingers nor gets resurrected.
 */
const BUILT_IN_REMOVALS: string[] = ['Unconstrained'];

/**
 * Reconcile the built-in configuration presets into the store on every
 * activation, adding any newly-introduced built-in exactly once without
 * duplicating existing presets or resurrecting ones the user deleted.
 *
 * Tracking is by preset NAME via `ghola.configurations.seededNames` (an array
 * of the built-in names already seeded). This replaces the legacy single
 * boolean `CONFIGURATIONS_SEEDED` gate, which short-circuited so a built-in
 * added after first install (e.g. "Self Upgrade") never reached the store.
 *
 * Migration: on an install that predates the names list, if the legacy boolean
 * flag is set, every built-in currently present in the store (matched by name)
 * is treated as already seeded, leaving genuinely-new built-ins eligible to be
 * added. A fresh install (no flag, no list) seeds everything.
 *
 * Presets are appended via a single `store.addMany` write, which generates each
 * id + createdAt and forces `isDefault: false`, so none auto-applies on startup.
 * Seeding stays atomic + retry-safe: the seeded-names list (and legacy flag) are
 * persisted ONLY after the store write succeeds, so a failed write leaves no
 * partial state and the next activation retries cleanly. Even if the names-list
 * write itself fails, the by-name dedupe against `store.getAll()` prevents
 * duplicates on the retry.
 */
async function seedBuiltInConfigurations(
  context: vscode.ExtensionContext,
  store: ConfigurationsStore,
  logger: vscode.OutputChannel,
): Promise<void> {
  // Rename-migration pass: rename any stored built-in preset that was seeded
  // under an old name to its current name, in place (preserving id, enabledIds,
  // settings, isDefault, createdAt via the store's field-preserving update).
  // Runs BEFORE the reconcile/add pass so the renamed preset is recognized as
  // already-seeded and not re-added as a duplicate. A collision guard skips the
  // rename when a config already carries the target name, so the migration
  // never produces two configs with the same name and never clobbers a
  // user-created "to"-named config; the old-named entry is left for the user to
  // resolve in that rare case.
  for (const { from, to } of BUILT_IN_RENAMES) {
    const all = store.getAll();
    const source = all.find((c) => c.name === from);
    if (!source || all.some((c) => c.name === to)) continue;
    try {
      await store.update(source.id, { name: to });
      // Reflect the rename in the persisted seeded-names list so the reconcile
      // pass below treats the renamed preset as already seeded (no re-add). The
      // legacy-boolean install (no names list yet) needs no update here: its
      // seeded set is recomputed from the store by name further down.
      const seeded = context.workspaceState.get<string[]>(WORKSPACE_STATE_KEYS.CONFIGURATIONS_SEEDED_NAMES);
      if (Array.isArray(seeded) && seeded.includes(from)) {
        await context.workspaceState.update(
          WORKSPACE_STATE_KEYS.CONFIGURATIONS_SEEDED_NAMES,
          seeded.map((n) => (n === from ? to : n)),
        );
      }
    } catch (err) {
      // Partial-failure note: store.update already renamed the config to `to`;
      // only the seededNames write failed, so seededNames may be left listing
      // the old `from` name on the next activation. That is harmless: the rename
      // pass then no-ops (no config named `from` remains, so `source` is
      // undefined), and the reconcile pass's existingNames dedupe prevents a
      // duplicate `to` from being added.
      logger.appendLine(`[ghola] built-in configuration rename "${from}" to "${to}" failed: ${err}`);
      return;
    }
  }

  // Recompute after the rename so the reconcile + removal passes see the NEW
  // name and do not add a fresh "Project".
  const existingNames = new Set(store.getAll().map((c) => c.name));

  // Resolve the set of built-in preset NAMES already seeded. This is computed
  // BEFORE the removal pass (below) so that pass's ownership guard can key off
  // the RESOLVED set, which is critical for the legacy-boolean branch: the
  // exact upgrade population BUILT_IN_REMOVALS targets.
  const rawSeeded = context.workspaceState.get<string[]>(
    WORKSPACE_STATE_KEYS.CONFIGURATIONS_SEEDED_NAMES,
  );
  let seededNames: string[];
  if (Array.isArray(rawSeeded)) {
    seededNames = rawSeeded;
  } else if (context.workspaceState.get<boolean>(WORKSPACE_STATE_KEYS.CONFIGURATIONS_SEEDED)) {
    // Legacy install: an older build already seeded the built-ins that existed
    // at the time. Mark every built-in currently present (by name) as done so
    // it is not re-added; genuinely-new built-ins stay eligible below.
    seededNames = BUILT_IN_CONFIGURATIONS.map((p) => p.name).filter((name) => existingNames.has(name));
    // ALSO record any retired (BUILT_IN_REMOVALS) preset that is CURRENTLY
    // PRESENT in the store as seeded. A legacy-boolean install rebuilds
    // seededNames from BUILT_IN_CONFIGURATIONS, which no longer lists
    // "Unconstrained", so without this the removal pass below would never
    // recognize the stored retired preset as ours and would never fire (the
    // precise upgrade population the removal targets). Recording it here lets the
    // removal pass's ownership guard pass, so the retired preset is
    // recorded-as-seeded then removed within this single activation. Accepted
    // trade-off (unchanged from the prior design): a user-CREATED preset that
    // happens to share a retired built-in's name is indistinguishable on a pure
    // legacy install and would also be removed.
    for (const name of BUILT_IN_REMOVALS) {
      if (existingNames.has(name) && !seededNames.includes(name)) seededNames.push(name);
    }
  } else {
    // Fresh install: nothing has been seeded yet.
    seededNames = [];
  }
  const seededSet = new Set(seededNames);

  // Removal-migration pass: delete any stored built-in preset that has been
  // retired from source. Runs AFTER the rename pass (so a renamed-then-retired
  // preset is matched under its current name) and AFTER seededNames is resolved
  // (so the legacy-boolean branch's augmentation above is in effect), and BEFORE
  // the reconcile/add pass. The reconcile pass never re-adds these because they
  // are no longer present in BUILT_IN_CONFIGURATIONS. Idempotent: a name with no
  // matching stored config is a no-op. `store.remove` also clears the
  // active-configuration id when the deleted preset was the active one, so no
  // dangling active id is left behind (same path the panel's deleteConfiguration
  // UI uses).
  for (const name of BUILT_IN_REMOVALS) {
    const target = store.getAll().find((c) => c.name === name);
    if (!target) continue;
    // Ownership guard: only delete a stored config with this name if WE seeded
    // it, i.e. the name is present in the RESOLVED seededNames set. On a
    // names-list install that is the persisted list (a user-created config that
    // merely shares a retired built-in's name is absent from it and is spared);
    // on a legacy-boolean install the branch above added the name iff it is
    // present in the store (the accepted trade-off documented there).
    if (!seededSet.has(name)) continue;
    try {
      await store.remove(target.id);
      // Drop the retired name from the in-memory + persisted seeded-names list
      // so tracking stays clean (the reconcile pass keys off it). Persisting
      // here (rather than only via the final reconcile write) preserves the
      // original removal pass's retry-safety on the names-list path and durably
      // records the legacy-boolean rebuild.
      seededSet.delete(name);
      seededNames = seededNames.filter((n) => n !== name);
      await context.workspaceState.update(
        WORKSPACE_STATE_KEYS.CONFIGURATIONS_SEEDED_NAMES,
        seededNames,
      );
    } catch (err) {
      // Partial-failure note: store.remove already deleted the config from the
      // store; only the seededNames write failed, so seededNames may be left
      // listing the removed name on the next activation. That is harmless: the
      // removal pass then no-ops (no stored config carries the name, so `target`
      // is undefined), and the reconcile pass never re-adds a name absent from
      // BUILT_IN_CONFIGURATIONS.
      logger.appendLine(`[ghola] built-in configuration removal "${name}" failed: ${err}`);
      return;
    }
  }

  // Reconcile: add each built-in whose name is neither already recorded as
  // seeded nor already present in the store (dedupe by name). A built-in the
  // user later deleted keeps its name in seededNames, so it is not resurrected.
  const toAdd = BUILT_IN_CONFIGURATIONS.filter(
    (preset) => !seededSet.has(preset.name) && !existingNames.has(preset.name),
  );

  try {
    if (toAdd.length > 0) {
      await store.addMany(
        toAdd.map((preset) => ({
          name: preset.name,
          enabledIds: preset.enabledIds,
          settings: preset.settings,
        })),
      );
    }
    // Persist the reconciled names list ONLY after the store write succeeds.
    await context.workspaceState.update(WORKSPACE_STATE_KEYS.CONFIGURATIONS_SEEDED_NAMES, [
      ...seededNames,
      ...toAdd.map((p) => p.name),
    ]);
    // Keep the legacy boolean flag set for any other/older reader.
    await context.workspaceState.update(WORKSPACE_STATE_KEYS.CONFIGURATIONS_SEEDED, true);
  } catch (err) {
    logger.appendLine(`[ghola] built-in configuration seeding failed, will retry next activation: ${err}`);
  }
}

function resolveModulesDirFn(context: vscode.ExtensionContext): () => string {
  return () => {
    const cfg = vscode.workspace.getConfiguration('ghola');
    const value = cfg.get<string>('modulesDir') ?? 'modules';
    // Default path: modules ship inside the installed extension, so resolve
    // against extensionPath. This makes the extension self-contained — it finds
    // its bundled modules in ANY workspace the user opens, not just this repo.
    // In the F5 dev host extensionPath is this repo, so dev keeps working.
    if (value === 'modules') {
      return path.join(context.extensionPath, 'modules');
    }
    // Explicit override: an absolute path is used as-is; a relative path points
    // at an in-workspace modules dir (escape hatch), resolved against the open
    // workspace root and falling back to extensionPath when no folder is open.
    if (path.isAbsolute(value)) return value;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? context.extensionPath;
    return path.join(root, value);
  };
}

