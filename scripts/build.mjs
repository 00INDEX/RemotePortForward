import * as esbuild from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

for (const kind of ['local', 'remote']) {
  await rm(`packages/${kind}/dist`, { recursive: true, force: true });
  await mkdir(`packages/${kind}/dist`, { recursive: true });
}

const options = ['local', 'remote'].map(kind => ({
  entryPoints: [`packages/${kind}/src/extension.ts`],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode', 'bufferutil', 'utf-8-validate'],
  outfile: `packages/${kind}/dist/extension.cjs`,
  sourcemap: !production,
  sourcesContent: false,
  minify: production,
  logLevel: 'info',
}));

options.push({
  entryPoints: ['packages/local/webview/portsTable.ts'],
  outfile: 'packages/local/dist/portsTable.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
});

await copyFile('packages/local/webview/portsTable.css', 'packages/local/dist/portsTable.css');

if (watch) {
  await Promise.all(options.map(async option => (await esbuild.context(option)).watch()));
} else {
  await Promise.all(options.map(option => esbuild.build(option)));
}
