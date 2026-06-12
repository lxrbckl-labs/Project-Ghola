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
 * Resolve the Project-Nomeda git checkout to pull/rebuild/reinstall from.
 *
 *   (a) If `nomeda.repoPath` is set and points at a directory containing a
 *       `.git` entry, use it.
 *   (b) Otherwise fall back to `context.extensionPath` IF that path is itself
 *       a source checkout — it must contain BOTH `.git` and `esbuild.config.js`
 *       (an installed vsix copy has neither, so this distinguishes the F5 dev
 *       host / source install from a packaged install).
 *   (c) Otherwise there is no checkout to operate on; return null.
 */
function resolveRepoRoot(context: vscode.ExtensionContext): string | null {
  const configured = vscode.workspace
    .getConfiguration('nomeda')
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
      'Nomeda: could not locate a Project-Nomeda git checkout to update from. Set "nomeda.repoPath" to the absolute path of your clone.',
      'Open Settings',
    );
    if (choice === 'Open Settings') {
      void vscode.commands.executeCommand('workbench.action.openSettings', 'nomeda.repoPath');
    }
    return;
  }

  const scriptPath = path.join(repoRoot, 'scripts', 'reinstall.sh');
  if (!fs.existsSync(scriptPath)) {
    vscode.window.showErrorMessage(
      `Nomeda: update script not found at ${scriptPath}.`,
    );
    return;
  }

  updating = true;
  const channel = vscode.window.createOutputChannel('Nomeda Update');
  channel.clear();
  channel.show(true);

  try {
    // The child's accumulated stdout+stderr, captured here so it survives past
    // the withProgress promise for marker parsing below.
    let buffer = '';
    const exitCode = await vscode.window.withProgress<number>(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Updating Nomeda…',
        cancellable: false,
      },
      () =>
        new Promise<number>((resolve, reject) => {
          // `bash -lc` LOGIN shell is deliberate: the extension-host PATH lacks
          // the user's interactive node/npm (nvm) and the `code` CLI; a login
          // shell sources the user's profile so those resolve.
          const child = spawn('bash', ['-lc', `bash ${shellQuote(scriptPath)}`], {
            cwd: repoRoot,
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
        'Nomeda is already up to date.',
        { modal: true },
      );
      return;
    }

    if (exitCode === 0) {
      const installedMatch = buffer.match(/\[ext\]\s+Installed:\s+nomeda v(\S+)/i);
      const version = installedMatch ? installedMatch[1] : 'latest';
      const choice = await vscode.window.showInformationMessage(
        `Nomeda updated to v${version}. Reload window to activate?`,
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
      `Nomeda update failed (exit ${exitCode}).`,
      { modal: true },
      'Show Log',
    );
    if (choice === 'Show Log') {
      channel.show();
    }
  } catch (err) {
    const choice = await vscode.window.showErrorMessage(
      `Nomeda update failed — ${(err as Error).message}`,
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
 * Register the `nomeda.updateExtension` command. Returns the disposable so the
 * caller can push it onto `context.subscriptions` alongside the other commands.
 */
export function registerUpdateExtensionCommand(
  context: vscode.ExtensionContext,
): vscode.Disposable {
  return vscode.commands.registerCommand('nomeda.updateExtension', () =>
    runUpdate(context),
  );
}
