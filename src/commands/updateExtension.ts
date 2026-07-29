import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

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
 *       `.git` entry, use it.
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
  if (configured && fs.existsSync(path.join(configured, '.git'))) {
    return configured;
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
  return null;
}

/**
 * Run the reinstall pipeline: resolve the repo root, verify the script exists,
 * then stream `scripts/reinstall.sh` (under a `bash -lc` login shell so the
 * user's interactive PATH — nvm node/npm, the `code` CLI — is inherited) into
 * an OutputChannel while a notification progress spinner is shown. Parses the
 * accumulated output for the up-to-date / installed / failure markers and
 * surfaces a modal prompt for each outcome.
 */
async function runUpdate(context: vscode.ExtensionContext): Promise<void> {
  if (updating) {
    vscode.window.showInformationMessage('Update already in progress.');
    return;
  }

  const repoRoot = resolveRepoRoot(context);
  if (!repoRoot) {
    const choice = await vscode.window.showErrorMessage(
      'Ghola: could not locate a Project-Ghola git checkout to update from. Open your clone as a workspace folder, or set "ghola.repoPath" to its absolute path.',
      'Open Settings',
    );
    if (choice === 'Open Settings') {
      void vscode.commands.executeCommand('workbench.action.openSettings', 'ghola.repoPath');
    }
    return;
  }

  const scriptPath = path.join(repoRoot, 'scripts', 'reinstall.sh');
  if (!fs.existsSync(scriptPath)) {
    vscode.window.showErrorMessage(
      `Ghola: update script not found at ${scriptPath}.`,
    );
    return;
  }

  // The INSTALLED extension's version is the correct left-hand side of the
  // update check: context.extensionPath now ships a VERSION file. We read it
  // here and hand it to the script via GHOLA_INSTALLED_VERSION so the script
  // compares installed-vs-remote (the install can lag) rather than
  // clone-vs-remote (the maintainer's clone is never behind its own push).
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
            env: { ...process.env, GHOLA_INSTALLED_VERSION: installedVersion ?? '' },
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
