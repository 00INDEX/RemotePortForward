import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';

const { values } = parseArgs({ options: {
  registry: { type: 'boolean', default: false },
  publisher: { type: 'string' },
  out: { type: 'string' },
} });
const local = JSON.parse(await readFile('packages/local/package.json', 'utf8'));
const remote = JSON.parse(await readFile('packages/remote/package.json', 'utf8'));
if (local.version !== remote.version) throw new Error('Both components must use the same version.');
if (local.publisher !== remote.publisher) throw new Error('Both components must use the same publisher.');
const publisher = values.publisher ?? local.publisher;
if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(publisher)) throw new Error('Invalid publisher namespace.');
if (values.registry && (!values.publisher || publisher === 'local-dev')) {
  throw new Error('Registry packaging requires --publisher <your-namespace>. No upload is performed.');
}
if (!values.registry && values.publisher) throw new Error('Use --registry when choosing a publishing namespace.');

const out = resolve(values.out ?? (values.registry ? `artifacts/openvsx/${publisher}` : 'artifacts'));
await mkdir(out, { recursive: true });
const staging = await mkdtemp(join(tmpdir(), 'remote-ports-package-'));
const checksums = [];
try {
  for (const [kind, source] of [['local', local], ['remote', remote]]) {
    const manifest = { ...source, publisher };
    // Offline builds must not resolve unpublished companion IDs from a gallery.
    if (kind === 'remote' && values.registry) manifest.extensionPack = [`${publisher}.${local.name}`];
    else delete manifest.extensionPack;
    if (manifest.extensionDependencies?.length) throw new Error('Do not turn an install-time companion into a cross-host activation dependency.');
    const stage = join(staging, kind);
    await mkdir(stage, { recursive: true });
    await writeFile(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    await writeFile(join(stage, '.vscodeignore'), '.vscodeignore\n**/*.map\n');
    for (const file of ['dist', ...(kind === 'local' ? ['media'] : [])]) {
      await cp(resolve('packages', kind, file), join(stage, file), {
        recursive: true, filter: path => !path.endsWith('.map'),
      });
    }
    for (const file of ['README.md', 'CHANGELOG.md', 'LICENSE', 'THIRD_PARTY_NOTICES']) {
      await cp(resolve(file), join(stage, file));
    }
    const output = join(out, `remote-ports-${kind}-${manifest.version}.vsix`);
    const result = spawnSync(process.execPath, [
      resolve('node_modules/@vscode/vsce/vsce'), 'package', '--no-dependencies',
      '--allow-missing-repository', '--out', output,
    ], { cwd: stage, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Packaging ${kind} failed (${result.status}).`);
    checksums.push(`${createHash('sha256').update(await readFile(output)).digest('hex')}  ${basename(output)}`);
  }
  await writeFile(join(out, 'SHA256SUMS'), checksums.join('\n') + '\n');
} finally {
  await rm(staging, { recursive: true, force: true });
}
process.stdout.write(values.registry
  ? `Registry packages prepared in ${out}. Publish the companion first, then the main extension. Nothing was uploaded.\n`
  : `Offline development packages prepared in ${out}. Registry builds use extensionPack for one-entry installation.\n`);
