// Two-target build: Node CJS for the extension host, browser IIFE for the webview.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');

// Copy webview styles into dist so they ship in the packaged extension.
const copyStylesPlugin = {
  name: 'copy-webview-styles',
  setup(build) {
    build.onEnd(() => {
      const src = path.resolve(__dirname, 'src/settings-panel/webview/styles.css');
      const dst = path.resolve(__dirname, 'dist/styles.css');
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      } catch (err) {
        console.warn('[nomeda] failed to copy styles.css:', err.message);
      }
    });
  },
};

const extensionConfig = {
  entryPoints: [path.resolve(__dirname, 'src/extension.ts')],
  bundle: true,
  outfile: path.resolve(__dirname, 'dist/extension.js'),
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
};

const webviewConfig = {
  entryPoints: [path.resolve(__dirname, 'src/settings-panel/webview/main.ts')],
  bundle: true,
  outfile: path.resolve(__dirname, 'dist/webview.js'),
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: true,
  logLevel: 'info',
  plugins: [copyStylesPlugin],
};

async function run() {
  if (watch) {
    const ctxExt = await esbuild.context(extensionConfig);
    const ctxWeb = await esbuild.context(webviewConfig);
    await Promise.all([ctxExt.watch(), ctxWeb.watch()]);
    console.log('[nomeda] watching...');
  } else {
    await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)]);
    console.log('[nomeda] build complete');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
