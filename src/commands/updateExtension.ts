import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { toNativeHostPath } from '../session/host-path';

/**
 * Module-level re-entrancy guard. An update spawns a long-running build +
 * package + reinstall pipeline; firing the command again while one is in
 * flight would race two installs against the same vsix. We refuse the second
 * invocation rather than queue it.
 */
let updating = false;

/**
 * POSIX single-quote a shell argument. Safe characters are passed through
 * verbatim; anything else is wrapped in single quotes with embedded single
 * quotes escaped via the '\'' idiom. Used to build the `bash -lc` command
 * string so a path with spaces or shell metacharacters cannot break out.
 */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_\/.,:=@%+-]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Is `dir` a genuine Project-Ghola source checkout? All three markers must be
 * present — any one of them alone is far too weak to hand to `reinstall.sh`:
 *
 *   1. `.git` — the directory is a clone, not an unpacked copy.
 *   2. `esbuild.config.js` — it has Ghola's build layout. Corroborating only;
 *      strategy (b) below already leans on this same marker.
 *   3. `package.json` parses and its `name` is exactly `ghola` — the identity
 *      signal. A directory name is not trusted because a clone can be renamed;
 *      the manifest `name` survives that. This mirrors the self-upgrade repo
 *      guard in `scripts/ghola-boot-probe.sh`, which answers the identical
 *      "is this really Project-Ghola?" question the same way.
 *
 * An unrelated repo may hold (1) and (2) by coincidence, but it cannot declare
 * itself `ghola`. Every failure mode — missing file, unreadable file, malformed
 * JSON — resolves to `false`; a candidate is never assumed to match.
 */
function isGholaCheckout(dir: string): boolean {
  if (
    !fs.existsSync(path.join(dir, '.git')) ||
    !fs.existsSync(path.join(dir, 'esbuild.config.js'))
  ) {
    return false;
  }
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(dir, 'package.json'), 'utf8'),
    ) as { name?: unknown };
    return pkg.name === 'ghola';
  } catch {
    return false;
  }
}

/**
 * Resolve the Project-Ghola git checkout to pull/rebuild/reinstall from.
 *
 *   (a) If `ghola.repoPath` is set and points at a directory containing a
 *       `.git` entry, use it — either as-is, or after `toNativeHostPath`
 *       translation. The translation covers the cross-boundary case: a POSIX
 *       path set inside WSL that is actually reachable via `/mnt/<drive>/...`
 *       on native Windows, or a `C:/...` path that maps to `/mnt/c/...` on
 *       WSL. `toNativeHostPath` only substitutes when the translated path
 *       exists, so it cannot fabricate a wrong answer.
 *   (b) Otherwise fall back to `context.extensionPath` IF that path is itself
 *       a source checkout — it must contain BOTH `.git` and `esbuild.config.js`
 *       (an installed vsix copy has neither, so this distinguishes the F5 dev
 *       host / source install from a packaged install).
 *   (c) Otherwise scan the open workspace folders, in workspace order, and use
 *       the first one that `isGholaCheckout` verifies. This covers the common
 *       packaged-install case where the operator already has their clone open
 *       and has never set `ghola.repoPath`. The verification is deliberately
 *       stricter than (a) and (b): the workspace is not a path the user aimed
 *       at this command, so a merely-git-looking folder is not good enough.
 *   (d) Otherwise there is no checkout to operate on; return null.
 */
function resolveRepoRoot(context: vscode.ExtensionContext): string | null {
  const configured = vscode.workspace
    .getConfiguration('ghola')
    .get<string>('repoPath', '')
    .trim();
  if (configured) {
    // Try the setting value as-is first.
    if (fs.existsSync(path.join(configured, '.git'))) {
      return configured;
    }
    // Try the host-translated form. A POSIX path on win32 translates to
    // `C:/...`; a Windows path on WSL/Linux translates to `/mnt/c/...`.
    // `toNativeHostPath` only substitutes when the translated location exists,
    // so this cannot fabricate a path.
    const translated = toNativeHostPath(configured);
    if (translated !== configured && fs.existsSync(path.join(translated, '.git'))) {
      return translated;
    }
  }
  const extPath = context.extensionPath;
  if (
    fs.existsSync(path.join(extPath, '.git')) &&
    fs.existsSync(path.join(extPath, 'esbuild.config.js'))
  ) {
    return extPath;
  }
  // `workspaceFolders` is undefined with no folder open and may hold several in
  // a multi-root workspace, so iterate rather than indexing [0]. First verified
  // match wins: the resolution must stay synchronous and non-interactive, and
  // two Ghola clones in one workspace is pathological — workspace order is at
  // least deterministic and puts the primary folder first. Non-`file` schemes
  // (virtual/remote filesystems) have no meaningful local path to build in, so
  // they are skipped rather than probed.
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file') {
      continue;
    }
    if (isGholaCheckout(folder.uri.fsPath)) {
      return folder.uri.fsPath;
    }
  }
  // (e) Scan sibling directories of the open workspace folder for a
  //     Project-Ghola checkout. This covers the common case where the operator
  //     has a different repo open (e.g. cmms1) but Project-Ghola lives in the
  //     same parent directory (e.g. C:\Users\...\source\repos\).
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file') {
      continue;
    }
    const parent = path.dirname(folder.uri.fsPath);
    try {
      for (const sibling of fs.readdirSync(parent)) {
        if (!/project.ghola/i.test(sibling)) {
          continue;
        }
        const candidate = path.join(parent, sibling);
        if (isGholaCheckout(candidate)) {
          return candidate;
        }
      }
    } catch {
      // Parent unreadable — continue to next folder.
    }
  }
  return null;
}

/**
 * Read the INSTALLED extension's version from the VERSION file or package.json.
 * Shared by the local (bash), native-Windows, and WSL update flows.
 */
function readInstalledVersion(context: vscode.ExtensionContext): string {
  let installedVersion: string | undefined;
  try {
    installedVersion = fs
      .readFileSync(path.join(context.extensionPath, 'VERSION'), 'utf8')
      .trim();
  } catch {
    installedVersion = context.extension?.packageJSON?.version;
  }
  if (installedVersion !== undefined && installedVersion === '') {
    installedVersion = undefined;
  }
  return installedVersion ?? '';
}

/**
 * True when `repoRoot` is a local Windows-native path (a drive letter or UNC).
 * Used to decide whether to run the build pipeline natively on Windows or
 * delegate to a POSIX shell. A WSL path like `/home/...` resolved via the
 * `\\wsl$\...` UNC mount would return `true`, but that case is handled
 * upstream: `resolveRepoRoot` never returns a `\\wsl$` path.
 */
function isWindowsLocalPath(repoRoot: string): boolean {
  // Drive letter: `C:\...` or `C:/...`
  if (/^[A-Za-z]:[\\/]/.test(repoRoot)) return true;
  // UNC: `\\server\share`
  if (repoRoot.startsWith('\\\\')) return true;
  return false;
}

/**
 * Run a single command and stream its output into the channel, accumulating
 * into `state.buffer`. Resolves with the exit code. Used by the native-Windows
 * pipeline to run each step sequentially.
 */
function runStepStreamed(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  channel: vscode.OutputChannel,
  state: { buffer: string },
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: true });
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      state.buffer += text;
      channel.append(text);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      state.buffer += text;
      channel.append(text);
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => resolve(code ?? 0));
  });
}

// ─── NATIVE-WINDOWS UPDATE ────────────────────────────────────────────────
//
// When the Project-Ghola checkout is on the local Windows filesystem, the
// build pipeline runs NATIVELY — no bash, no WSL. The steps mirror
// `scripts/reinstall.sh` but use `npm` / `npx` / `code` directly through
// Node's `child_process.spawn` with `shell: true` so Windows can resolve
// the commands from PATH. The `code` CLI install is replaced by
// `workbench.extensions.installExtension` (the same API the WSL flow uses)
// to avoid any UNC / Electron gating issues.

/**
 * Run the native-Windows update pipeline: git fetch + pull, npm install,
 * npm run build, vsce package, and install the vsix — all as native Windows
 * commands. The pipeline mirrors `scripts/reinstall.sh`'s logic and emits the
 * same marker lines so the result-parsing code is shared.
 */
async function runUpdateNativeWindows(
  context: vscode.ExtensionContext,
  repoRoot: string,
): Promise<void> {
  updating = true;
  const channel = vscode.window.createOutputChannel('Ghola Update');
  channel.clear();
  channel.show(true);

  const installedVersion = readInstalledVersion(context);
  const vsixName = 'ghola.vsix';
  const vsixPath = path.join(repoRoot, vsixName);
  const env = { ...process.env, GHOLA_INSTALLED_VERSION: installedVersion };

  try {
    const state = { buffer: '' };
    const exitCode = await vscode.window.withProgress<number>(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Updating Ghola…',
        cancellable: false,
      },
      async () => {
        channel.appendLine(`[ghola] native-Windows update from ${repoRoot}`);

        // ── Remote-version check (git fetch + compare) ────────────────
        // Mirrors reinstall.sh's remote-version logic. Unlike reinstall.sh
        // there is no --local flag; the native flow always checks remote.
        let code: number;

        // Resolve upstream tracking ref.
        code = await runStepStreamed(
          'git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
          repoRoot, env, channel, state,
        );
        const upstream = state.buffer.trim().split('\n').pop()?.trim() ?? '';
        if (code !== 0 || !upstream) {
          channel.appendLine('[ext] ERROR: no upstream tracking branch configured');
          return 1;
        }

        // Reset buffer for subsequent steps (upstream was captured above).
        state.buffer = '';

        // git fetch
        channel.appendLine('[ext] git fetch');
        code = await runStepStreamed('git', ['fetch'], repoRoot, env, channel, state);
        if (code !== 0) {
          channel.appendLine('[ext] ERROR: git fetch failed');
          return 1;
        }

        // Read remote VERSION via `git show upstream:VERSION`.
        state.buffer = '';
        code = await runStepStreamed(
          'git', ['show', `${upstream}:VERSION`],
          repoRoot, env, channel, state,
        );
        const remoteVersion = state.buffer.trim().split('\n').pop()?.trim() ?? '';
        if (code !== 0 || !remoteVersion) {
          channel.appendLine(`[ext] ERROR: could not read remote version from ${upstream}:VERSION`);
          return 1;
        }

        // Read local VERSION.
        let localVersion = '';
        try {
          localVersion = fs.readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim();
        } catch {
          // Fine — will just not short-circuit the pull.
        }

        channel.appendLine(
          `[ext] installed=${installedVersion || 'unknown'} remote=${remoteVersion} local=${localVersion} upstream=${upstream}`,
        );

        // Up-to-date gate.
        if (installedVersion && installedVersion === remoteVersion) {
          state.buffer += '\nALREADY_UP_TO_DATE\n';
          channel.appendLine('[ext] ALREADY_UP_TO_DATE');
          channel.appendLine(
            `[ext] Already up to date (installed v${installedVersion} matches remote) - nothing to install.`,
          );
          return 0;
        }

        // Pull gate.
        if (localVersion !== remoteVersion) {
          channel.appendLine(`[ext] update needed: local=${localVersion || 'unknown'} -> remote=${remoteVersion}`);
          state.buffer = '';
          code = await runStepStreamed('git', ['pull', '--ff-only'], repoRoot, env, channel, state);
          if (code !== 0) {
            channel.appendLine('[ext] ERROR: git pull --ff-only failed');
            return 1;
          }
          channel.appendLine(`[ext] pulled to remote version ${remoteVersion}`);
        } else {
          channel.appendLine(`[ext] clone already at remote version ${remoteVersion} - skipping pull`);
        }

        // ── npm install ───────────────────────────────────────────────
        channel.appendLine('[ext] npm install');
        state.buffer = '';
        code = await runStepStreamed('npm', ['install'], repoRoot, env, channel, state);
        if (code !== 0) {
          channel.appendLine('[ext] ERROR: npm install failed');
          return code;
        }

        // ── npm run build ─────────────────────────────────────────────
        channel.appendLine('[ext] npm run build');
        state.buffer = '';
        code = await runStepStreamed('npm', ['run', 'build'], repoRoot, env, channel, state);
        if (code !== 0) {
          channel.appendLine('[ext] ERROR: npm run build failed');
          return code;
        }

        // ── Remove stale vsix ─────────────────────────────────────────
        try { fs.unlinkSync(vsixPath); } catch { /* fine if absent */ }

        // ── Package ───────────────────────────────────────────────────
        channel.appendLine(`[ext] packaging ${vsixName}`);
        state.buffer = '';
        code = await runStepStreamed(
          'npx',
          ['--yes', '@vscode/vsce', 'package', '-o', vsixName, '--allow-missing-repository', '--skip-license'],
          repoRoot, env, channel, state,
        );
        if (code !== 0) {
          channel.appendLine(`[ext] ERROR: packaging failed`);
          return code;
        }
        if (!fs.existsSync(vsixPath)) {
          channel.appendLine(`[ext] ERROR: packaging did not produce ${vsixName}`);
          return 1;
        }

        // ── Install via VS Code API ───────────────────────────────────
        // Uses the `workbench.extensions.installExtension` command rather
        // than `code --install-extension` to avoid the Electron UNC-host
        // block and to stay in-process.
        channel.appendLine(`[ext] installing ${vsixPath}`);
        await vscode.commands.executeCommand(
          'workbench.extensions.installExtension',
          vscode.Uri.file(vsixPath),
        );

        // Read the installed version from the repo's VERSION file.
        let version = '';
        try {
          version = fs.readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim();
        } catch { /* version stays empty, reported as 'latest' */ }
        state.buffer += `\n[ext] Installed: ghola v${version || 'latest'}\n`;
        channel.appendLine(`[ext] Installed: ghola v${version || 'latest'}`);
        return 0;
      },
    );

    if (/\bALREADY_UP_TO_DATE\b/.test(state.buffer)) {
      await vscode.window.showInformationMessage(
        'Ghola is already up to date.',
        { modal: true },
      );
      return;
    }

    if (exitCode === 0) {
      const installedMatch = state.buffer.match(/\[ext\]\s+Installed:\s+ghola v(\S+)/i);
      const version = installedMatch ? installedMatch[1] : 'latest';
      const choice = await vscode.window.showInformationMessage(
        `Ghola updated to v${version}. Reload window to activate?`,
        { modal: true },
        'Reload Window',
        'Later',
      );
      if (choice === 'Reload Window') {
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
      return;
    }

    const choice = await vscode.window.showErrorMessage(
      `Ghola update failed (exit ${exitCode}).`,
      { modal: true },
      'Show Log',
    );
    if (choice === 'Show Log') {
      channel.show();
    }
  } catch (err) {
    const choice = await vscode.window.showErrorMessage(
      `Ghola update failed — ${(err as Error).message}`,
      { modal: true },
      'Show Log',
    );
    if (choice === 'Show Log') {
      channel.show();
    }
  } finally {
    updating = false;
  }
}

/**
 * Run the reinstall pipeline: resolve the repo root, verify the script exists,
 * then stream `scripts/reinstall.sh` (under a `bash -lc` login shell so the
 * user's interactive PATH — nvm node/npm, the `code` CLI — is inherited) into
 * an OutputChannel while a notification progress spinner is shown. Parses the
 * accumulated output for the up-to-date / installed / failure markers and
 * surfaces a modal prompt for each outcome.
 *
 * OS-AMORPHIC DISPATCH:
 *   1. Resolve the repo root (local first, then WSL fallback).
 *   2. If the repo is on the local Windows filesystem (drive-letter path),
 *      run the build pipeline natively — no bash needed.
 *   3. If the repo is on a POSIX filesystem (WSL/Linux/macOS), run via
 *      `bash -lc` as before.
 *   4. If no local repo is found on win32, fall back to WSL delegation
 *      (the existing `resolveWslDelegation` + `runUpdateViaWsl` path).
 *   5. On non-win32 hosts, WSL delegation is never attempted.
 */
async function runUpdate(context: vscode.ExtensionContext): Promise<void> {
  if (updating) {
    vscode.window.showInformationMessage('Update already in progress.');
    return;
  }

  const repoRoot = resolveRepoRoot(context);

  // ── Win32 with a local Windows-native checkout ──────────────────────────
  // Run the build pipeline natively: npm, npx, and the VS Code extension API
  // are all available without bash.
  if (repoRoot && os.platform() === 'win32' && isWindowsLocalPath(repoRoot)) {
    await runUpdateNativeWindows(context, repoRoot);
    return;
  }

  // ── POSIX host (WSL/Linux/macOS) with a local checkout ──────────────────
  // Run via `bash -lc` exactly as before.
  if (repoRoot) {
    await runUpdateViaBash(context, repoRoot);
    return;
  }

  // ── Win32 with no local checkout: try WSL delegation ────────────────────
  // `resolveWslDelegation` returns the POSIX path from `ghola.repoPath` when
  // it looks like a WSL-side clone. Non-win32 hosts never reach this.
  if (os.platform() === 'win32') {
    const wslRepoPath = resolveWslDelegation();
    if (wslRepoPath) {
      await runUpdateViaWsl(context, wslRepoPath);
      return;
    }
  }

  const choice = await vscode.window.showErrorMessage(
    'Ghola: could not locate a Project-Ghola git checkout to update from. Open your clone as a workspace folder, or set "ghola.repoPath" to its absolute path.',
    'Open Settings',
  );
  if (choice === 'Open Settings') {
    void vscode.commands.executeCommand('workbench.action.openSettings', 'ghola.repoPath');
  }
}

/**
 * Run the reinstall pipeline via `bash -lc` on a POSIX host. This is the
 * original local-update flow, extracted from `runUpdate` so the dispatch can
 * route to it or to the native-Windows pipeline.
 */
async function runUpdateViaBash(
  context: vscode.ExtensionContext,
  repoRoot: string,
): Promise<void> {
  const scriptPath = path.join(repoRoot, 'scripts', 'reinstall.sh');
  if (!fs.existsSync(scriptPath)) {
    vscode.window.showErrorMessage(
      `Ghola: update script not found at ${scriptPath}.`,
    );
    return;
  }

  const installedVersion = readInstalledVersion(context);

  updating = true;
  const channel = vscode.window.createOutputChannel('Ghola Update');
  channel.clear();
  channel.show(true);

  try {
    // The child's accumulated stdout+stderr, captured here so it survives past
    // the withProgress promise for marker parsing below.
    let buffer = '';
    const exitCode = await vscode.window.withProgress<number>(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Updating Ghola…',
        cancellable: false,
      },
      () =>
        new Promise<number>((resolve, reject) => {
          // `bash -lc` LOGIN shell is deliberate: the extension-host PATH lacks
          // the user's interactive node/npm (nvm) and the `code` CLI; a login
          // shell sources the user's profile so those resolve.
          const child = spawn('bash', ['-lc', `bash ${shellQuote(scriptPath)}`], {
            cwd: repoRoot,
            env: { ...process.env, GHOLA_INSTALLED_VERSION: installedVersion },
          });
          child.stdout.on('data', (chunk: Buffer) => {
            const text = chunk.toString();
            buffer += text;
            channel.append(text);
          });
          child.stderr.on('data', (chunk: Buffer) => {
            const text = chunk.toString();
            buffer += text;
            channel.append(text);
          });
          child.on('error', (err) => reject(err));
          child.on('close', (code) => resolve(code ?? 0));
        }),
    );

    if (/\bALREADY_UP_TO_DATE\b/.test(buffer)) {
      await vscode.window.showInformationMessage(
        'Ghola is already up to date.',
        { modal: true },
      );
      return;
    }

    if (exitCode === 0) {
      const installedMatch = buffer.match(/\[ext\]\s+Installed:\s+ghola v(\S+)/i);
      const version = installedMatch ? installedMatch[1] : 'latest';
      const choice = await vscode.window.showInformationMessage(
        `Ghola updated to v${version}. Reload window to activate?`,
        { modal: true },
        'Reload Window',
        'Later',
      );
      if (choice === 'Reload Window') {
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
      return;
    }

    const choice = await vscode.window.showErrorMessage(
      `Ghola update failed (exit ${exitCode}).`,
      { modal: true },
      'Show Log',
    );
    if (choice === 'Show Log') {
      channel.show();
    }
  } catch (err) {
    const choice = await vscode.window.showErrorMessage(
      `Ghola update failed — ${(err as Error).message}`,
      { modal: true },
      'Show Log',
    );
    if (choice === 'Show Log') {
      channel.show();
    }
  } finally {
    updating = false;
  }
}

// ─── WIN32 -> WSL DELEGATED UPDATE (FALLBACK) ─────────────────────────────
//
// WHEN THIS IS REACHED: `resolveRepoRoot` returned null (no local checkout
// found, even after `toNativeHostPath` translation) AND the host is win32.
// `resolveWslDelegation` checks whether `ghola.repoPath` names a POSIX
// absolute path — evidence that the clone lives inside WSL — and if so, the
// whole build pipeline is delegated to a WSL distro.
//
// This is now the LAST resort on win32. The dispatch order in `runUpdate` is:
//   1. Local Windows-native checkout -> `runUpdateNativeWindows`
//   2. Local POSIX checkout (can only happen on non-win32) -> `runUpdateViaBash`
//   3. WSL delegation (win32 only, POSIX `repoPath`) -> `runUpdateViaWsl`
//   4. Error

/**
 * Is this a win32 host whose `ghola.repoPath` names a POSIX absolute path? If
 * so, return that path — the WSL-side clone to delegate to; otherwise null.
 *
 * The `//` exclusion matters: `//server/share` is a legal forward-slash
 * spelling of a Windows UNC path and is NOT a POSIX path. `C:\...`, `C:/...`,
 * `\\wsl$\...` and any relative value all fail `startsWith('/')` outright.
 */
function resolveWslDelegation(): string | null {
  if (os.platform() !== 'win32') {
    return null;
  }
  const configured = vscode.workspace
    .getConfiguration('ghola')
    .get<string>('repoPath', '')
    .trim();
  if (!configured.startsWith('/') || configured.startsWith('//')) {
    return null;
  }
  // Trailing slashes are harmless to POSIX but would show up as `//` in the
  // derived script paths and in the operator-facing log lines. `/` itself is
  // left alone rather than reduced to the empty string.
  return configured.length > 1 ? configured.replace(/\/+$/, '') : configured;
}

/**
 * Decode output captured from `wsl.exe`. Its OWN subcommands (`-l`) answer in
 * UTF-16LE, while output relayed from a Linux child process is UTF-8. A UTF-8
 * stream can never contain a NUL byte, so the presence of one is a reliable
 * discriminator between the two.
 */
function decodeWslOutput(buf: Buffer): string {
  return buf.includes(0) ? buf.toString('utf16le') : buf.toString('utf8');
}

/** A captured (non-streamed) `wsl.exe` invocation. */
interface WslResult {
  code: number;
  out: string;
  err: string;
}

/**
 * Turn a spawn failure into an operator-actionable message. ENOENT is the one
 * that matters: `wsl.exe` is simply not present (WSL never installed, or a
 * Windows edition without it), and the user needs to be told THAT rather than
 * shown a stack trace.
 */
function describeWslSpawnError(err: Error): Error {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
    return new Error(
      'wsl.exe was not found on this machine, so the update cannot be delegated to WSL. Install WSL, or set "ghola.repoPath" to a Project-Ghola checkout on this machine.',
    );
  }
  return err;
}

/** Run `wsl.exe` with the given arguments and capture stdout/stderr. */
function runWslCapture(args: string[]): Promise<WslResult> {
  return new Promise<WslResult>((resolve, reject) => {
    const child = spawn('wsl.exe', args, { windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (e: Error) => reject(describeWslSpawnError(e)));
    child.on('close', (code) =>
      resolve({
        code: code ?? 0,
        out: decodeWslOutput(Buffer.concat(out)),
        err: decodeWslOutput(Buffer.concat(err)),
      }),
    );
  });
}

/**
 * Split a `wsl.exe -l -q` listing into distro names. The BOM and stray NULs are
 * stripped defensively in case the UTF-16LE discrimination above ever guesses
 * wrong on a truncated read; blank lines (the listing ends with one) are
 * dropped.
 */
function parseWslDistroList(out: string): string[] {
  return out
    .split(/\r?\n/)
    .map((line) => line.replace(/[\0\uFEFF]/g, '').trim())
    .filter((line) => line.length > 0);
}

/**
 * Pick the WSL distribution that actually holds the checkout. The distro is
 * DISCOVERED, never assumed to be `Ubuntu`: a wrong guess would silently build
 * some other tree or fail obscurely.
 *
 *   - ZERO installed distros -> hard error naming that as the problem.
 *   - ONE -> still probed, so "installed but the path isn't there" is reported
 *     as itself instead of surfacing later as an obscure build failure.
 *   - SEVERAL -> probe each in turn and take the first that contains
 *     `<repoPath>/.git`, which is the same marker `resolveRepoRoot` strategy
 *     (a) requires locally. Running distros are probed first so the common case
 *     does not cold-boot a stopped distro (and non-Linux utility distros such as
 *     `docker-desktop` fall out naturally by failing the probe).
 *
 * A probe is a `test -d` under `-e /bin/sh`, so no shell on either side of the
 * boundary interprets the path.
 */
async function resolveWslDistro(
  repoPosixPath: string,
  channel: vscode.OutputChannel,
): Promise<string> {
  const listed = await runWslCapture(['-l', '-q']);
  const all = parseWslDistroList(listed.out);
  if (all.length === 0) {
    const detail = listed.err.trim() || listed.out.trim();
    throw new Error(
      `no WSL distribution is installed, so there is nowhere to build the clone at ${repoPosixPath}${detail ? ` (wsl.exe said: ${detail})` : ''}.`,
    );
  }

  // Running-first ordering only; a failure here is not fatal because the plain
  // listing is enough to proceed.
  let running: string[] = [];
  try {
    const runningResult = await runWslCapture(['-l', '-q', '--running']);
    running = parseWslDistroList(runningResult.out);
  } catch {
    running = [];
  }
  const ordered = [
    ...all.filter((d) => running.includes(d)),
    ...all.filter((d) => !running.includes(d)),
  ];

  for (const distro of ordered) {
    channel.appendLine(`[ghola] probing WSL distribution ${distro} for ${repoPosixPath}/.git`);
    const probe = await runWslCapture([
      '-d',
      distro,
      '-e',
      '/bin/sh',
      '-c',
      `test -d ${shellQuote(`${repoPosixPath}/.git`)}`,
    ]);
    if (probe.code === 0) {
      channel.appendLine(`[ghola] using WSL distribution ${distro}`);
      return distro;
    }
  }

  throw new Error(
    `none of the installed WSL distributions (${ordered.join(', ')}) contain a git checkout at ${repoPosixPath}. Correct "ghola.repoPath" or clone Project-Ghola inside WSL.`,
  );
}

/**
 * Build the single bash script `wsl.exe` runs. Every interpolated value goes
 * through `shellQuote`, and the script is handed to `wsl.exe` as one argv
 * element (Node spawns without `shell: true`, so no cmd.exe ever sees it) —
 * a repo path containing a space or a quote therefore cannot break the
 * invocation or inject anything.
 *
 * STAGING PATH: `stageDirWin` is derived from the environment (USERPROFILE) by
 * the caller, and its `/mnt/<drive>/...` spelling is produced HERE BY WSL
 * ITSELF via `wslpath -a -u`. That is deliberate: the canonical statement of
 * that translation rule is `toNativeHostPath` in `src/session/host-path.ts`
 * (mirrored in `scripts/ghola.mjs` and `scripts/ghola-boot-probe.sh`, kept in
 * step by `scripts/ghola-path-parity.mjs`), it only ever converts INTO the
 * running host's form — which on win32 is the wrong direction for this — and its
 * `existsSync` gate cannot validate a WSL-side path from win32 anyway. Asking
 * WSL to do its own translation adds no fourth copy of the rule to keep in step.
 *
 * THE `code` SHIM: `scripts/reinstall.sh` both preflights `code` on PATH and
 * ends with `code --install-extension`. Neither can work across this boundary —
 * a WSL `code` is either absent (preflight fails, nothing builds) or the Windows
 * CLI reached over interop, whose cwd is then a `\\wsl$\...` UNC path that
 * Electron refuses with ERR_UNC_HOST_NOT_ALLOWED. A no-op `code` on a prepended
 * PATH satisfies the preflight and turns the script's install into a no-op, so
 * the WSL side does exactly the part it can do (fetch, pull, version-compare,
 * build, package) and the Windows extension host performs the real install from
 * the staged copy. The shim directory is a fixed per-user path, rewritten each
 * run, so repeated updates do not accumulate temp directories.
 */
function buildWslUpdateScript(
  repoPosixPath: string,
  scriptPosixPath: string,
  stageDirWin: string,
  installedVersion: string,
): string {
  return [
    'set -e',
    "command -v wslpath >/dev/null 2>&1 || { echo '[ghola] ERROR: wslpath not found in this WSL distribution' >&2; exit 1; }",
    `cd ${shellQuote(repoPosixPath)}`,
    `export GHOLA_INSTALLED_VERSION=${shellQuote(installedVersion)}`,
    `STAGE_DIR="$(wslpath -a -u ${shellQuote(stageDirWin)})"`,
    'mkdir -p "$STAGE_DIR"',
    'SHIM_DIR="${TMPDIR:-/tmp}/ghola-update-shim-$(id -u)"',
    'mkdir -p "$SHIM_DIR"',
    `printf '%s\\n' '#!/bin/sh' 'exit 0' > "$SHIM_DIR/code"`,
    'chmod 755 "$SHIM_DIR/code"',
    `PATH="$SHIM_DIR:$PATH" bash ${shellQuote(scriptPosixPath)}`,
    "echo '[ghola] the WSL-side code CLI was stubbed out; the Windows extension host installs the staged vsix'",
    'if [ -f ghola.vsix ]; then',
    '  cp -f ghola.vsix "$STAGE_DIR/ghola.vsix"',
    '  echo "[ghola] staged $STAGE_DIR/ghola.vsix"',
    'fi',
  ].join('\n');
}

// `readInstalledVersionForWsl` is retired: all three update flows (bash,
// native-Windows, WSL) now use the shared `readInstalledVersion` above.

/**
 * The delegated update: discover the distro, run the repo's own
 * `scripts/reinstall.sh` inside WSL (streaming into the same OutputChannel and
 * parsing the same markers as the local flow), then install the vsix the script
 * produced — copied to a Windows-local path from inside the WSL command,
 * because Electron blocks UNC hosts and so the extension host cannot read it in
 * place on `\\wsl$\...`.
 *
 * The install goes through `workbench.extensions.installExtension` rather than
 * the `code` CLI: the CLI route is what hits the UNC block, and it would be a
 * second process for no benefit.
 */
async function runUpdateViaWsl(
  context: vscode.ExtensionContext,
  repoPosixPath: string,
): Promise<void> {
  // Windows-local staging directory, derived from the environment rather than
  // any literal. USERPROFILE is available to the extension host; homedir() is
  // the fallback for the pathological case where it is unset or blank.
  const stageDirWin = path.join(
    process.env.USERPROFILE?.trim() || os.homedir(),
    '.ghola',
    'update',
  );
  const vsixWin = path.join(stageDirWin, 'ghola.vsix');

  updating = true;
  const channel = vscode.window.createOutputChannel('Ghola Update');
  channel.clear();
  channel.show(true);

  try {
    channel.appendLine(
      `[ghola] no Project-Ghola checkout on this Windows host; delegating to the WSL clone at ${repoPosixPath}`,
    );

    // The child's accumulated stdout+stderr, captured here so it survives past
    // the withProgress promise for marker parsing below.
    let buffer = '';
    const exitCode = await vscode.window.withProgress<number>(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Updating Ghola…',
        cancellable: false,
      },
      async () => {
        const distro = await resolveWslDistro(repoPosixPath, channel);
        const script = buildWslUpdateScript(
          repoPosixPath,
          `${repoPosixPath}/scripts/reinstall.sh`,
          stageDirWin,
          readInstalledVersion(context),
        );
        return await new Promise<number>((resolve, reject) => {
          // `bash -lc` LOGIN shell for the same reason as the local flow: the
          // pipeline needs the user's interactive node/npm (nvm), which a
          // non-login WSL shell does not have.
          const child = spawn('wsl.exe', ['-d', distro, '-e', 'bash', '-lc', script], {
            windowsHide: true,
          });
          child.stdout.on('data', (chunk: Buffer) => {
            const text = chunk.toString();
            buffer += text;
            channel.append(text);
          });
          child.stderr.on('data', (chunk: Buffer) => {
            const text = chunk.toString();
            buffer += text;
            channel.append(text);
          });
          child.on('error', (err: Error) => reject(describeWslSpawnError(err)));
          child.on('close', (code) => resolve(code ?? 0));
        });
      },
    );

    if (/\bALREADY_UP_TO_DATE\b/.test(buffer)) {
      await vscode.window.showInformationMessage(
        'Ghola is already up to date.',
        { modal: true },
      );
      return;
    }

    if (exitCode === 0) {
      if (!fs.existsSync(vsixWin)) {
        const choice = await vscode.window.showErrorMessage(
          `Ghola update failed — the WSL build finished but no vsix was staged at ${vsixWin}.`,
          { modal: true },
          'Show Log',
        );
        if (choice === 'Show Log') {
          channel.show();
        }
        return;
      }
      channel.appendLine(`[ghola] installing ${vsixWin} into this VS Code host`);
      await vscode.commands.executeCommand(
        'workbench.extensions.installExtension',
        vscode.Uri.file(vsixWin),
      );
      const installedMatch = buffer.match(/\[ext\]\s+Installed:\s+ghola v(\S+)/i);
      const version = installedMatch ? installedMatch[1] : 'latest';
      // Same prompt shape and wording as the local success path in `runUpdate`
      // — deliberately one wording, kept in step.
      const choice = await vscode.window.showInformationMessage(
        `Ghola updated to v${version}. Reload window to activate?`,
        { modal: true },
        'Reload Window',
        'Later',
      );
      if (choice === 'Reload Window') {
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
      return;
    }

    const choice = await vscode.window.showErrorMessage(
      `Ghola update failed (exit ${exitCode}).`,
      { modal: true },
      'Show Log',
    );
    if (choice === 'Show Log') {
      channel.show();
    }
  } catch (err) {
    const choice = await vscode.window.showErrorMessage(
      `Ghola update failed — ${(err as Error).message}`,
      { modal: true },
      'Show Log',
    );
    if (choice === 'Show Log') {
      channel.show();
    }
  } finally {
    updating = false;
  }
}

/**
 * Register the `ghola.updateExtension` command. Returns the disposable so the
 * caller can push it onto `context.subscriptions` alongside the other commands.
 */
export function registerUpdateExtensionCommand(
  context: vscode.ExtensionContext,
): vscode.Disposable {
  return vscode.commands.registerCommand('ghola.updateExtension', () =>
    runUpdate(context),
  );
}
