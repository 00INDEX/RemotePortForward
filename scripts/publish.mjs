import { createHash } from 'node:crypto';
import { readFile, appendFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs, promisify } from 'node:util';
import { URL } from 'node:url';
import yauzl from 'yauzl';

const { values } = parseArgs({ options: {
  registry: { type: 'string', default: 'all' },
  check: { type: 'boolean', default: false },
  preflight: { type: 'boolean', default: false },
  'verify-only': { type: 'boolean', default: false },
} });
if (!['all', 'openvsx', 'marketplace'].includes(values.registry)) throw new Error('Unknown registry.');
const publisher = '00index';
const root = JSON.parse(await readFile('package.json', 'utf8'));
const openZip = promisify(yauzl.fromBuffer);
const summaries = [];

async function packageContents(buffer) {
  const zip = await openZip(buffer, { lazyEntries: true });
  return new Promise((resolveZip, reject) => {
    const files = new Map();
    let total = 0;
    let entries = 0;
    const fail = error => { zip.close(); reject(error); };
    zip.on('error', fail);
    zip.on('end', () => resolveZip(files));
    zip.on('entry', entry => {
      if (++entries > 1000) { fail(new Error('VSIX contains too many entries.')); return; }
      if (entry.fileName.endsWith('/')) { zip.readEntry(); return; }
      total += entry.uncompressedSize;
      if (total > 64 * 1024 * 1024 || files.size >= 1000) { fail(new Error('VSIX exceeds verification limits.')); return; }
      zip.openReadStream(entry, (error, stream) => {
        if (error) { fail(error); return; }
        const chunks = [];
        stream.on('error', fail);
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => {
          if (files.has(entry.fileName)) { fail(new Error('Duplicate VSIX entry.')); return; }
          files.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry();
        });
      });
    });
    zip.readEntry();
  });
}

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    const address = new URL(url);
    throw new Error(`Registry request failed (${response.status}): ${address.origin}${address.pathname}`);
  }
  return response;
}

async function publishedDownload(registry, item) {
  if (registry === 'openvsx') {
    const response = await request(`https://open-vsx.org/api/${publisher}/${item.manifest.name}/${root.version}`);
    if (!response) return undefined;
    const metadata = await response.json();
    if (metadata.error || metadata.version !== root.version || metadata.namespace !== publisher) return undefined;
    return metadata.files?.download;
  }
  const response = await request('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', {
    method: 'POST',
    headers: { Accept: 'application/json;api-version=3.0-preview.1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ filters: [{ pageNumber: 1, pageSize: 1, criteria: [{ filterType: 7, value: item.id }] }], flags: 1 | 2 | 16 | 32 | 128 }),
  });
  if (!response) throw new Error('Marketplace gallery API is unavailable.');
  const result = await response.json();
  if (result.errorCode !== undefined || !Array.isArray(result.results)) throw new Error('Marketplace returned an invalid gallery response.');
  const extension = result.results?.[0]?.extensions?.find(extension => `${extension.publisher.publisherName}.${extension.extensionName}`.toLowerCase() === item.id);
  const version = extension?.versions?.find(version => version.version === root.version);
  return version?.files?.find(file => file.assetType === 'Microsoft.VisualStudio.Services.VSIXPackage')?.source;
}

async function verifyDownload(url, item) {
  if (!url.startsWith('https://')) throw new Error('Registry returned an insecure download URL.');
  const response = await request(url);
  if (!response) return false;
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 32 * 1024 * 1024) throw new Error('Registry package exceeds download limit.');
    chunks.push(chunk);
  }
  const remote = await packageContents(Buffer.concat(chunks));
  const expectedPaths = [...item.files.keys()].filter(path => path.startsWith('extension/')).sort();
  const actualPaths = [...remote.keys()].filter(path => path.startsWith('extension/')).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) throw new Error(`Published file list differs for ${item.id}.`);
  for (const [path, expected] of item.files) {
    if (!path.startsWith('extension/')) continue;
    const actual = remote.get(path);
    if (!actual || !actual.equals(expected)) throw new Error(`Published content differs for ${item.id}: ${path}`);
  }
  return true;
}

async function verifyPublished(registry, item, wait = false) {
  const deadline = Date.now() + (wait ? 10 * 60_000 : 0);
  do {
    const url = await publishedDownload(registry, item);
    if (url && await verifyDownload(url, item)) return true;
    if (!wait) return false;
    await delay(15_000);
  } while (Date.now() < deadline);
  throw new Error(`${item.id}@${root.version} is not publicly downloadable from ${registry}.`);
}

async function publish(registry, item) {
  const hasToken = Boolean(process.env[registry === 'openvsx' ? 'OVSX_PAT' : 'VSCE_PAT']);
  const packageName = registry === 'openvsx' ? 'ovsx' : '@vscode/vsce';
  const metadata = JSON.parse(await readFile(`node_modules/${packageName}/package.json`, 'utf8'));
  const bin = typeof metadata.bin === 'string' ? metadata.bin : metadata.bin[registry === 'openvsx' ? 'ovsx' : 'vsce'];
  const executable = resolve('node_modules', packageName, bin);
  const args = registry === 'openvsx'
    ? ['publish', item.path, ...(hasToken ? [] : ['--trusted-publishing'])]
    : ['publish', '--packagePath', item.path, ...(hasToken ? [] : ['--oidc'])];
  process.stdout.write(`Publishing ${item.id}@${root.version} to ${registry} using ${hasToken ? 'configured token' : 'OIDC'}.\n`);
  await new Promise((resolveProcess, reject) => {
    const child = spawn(process.execPath, [executable, ...args], { stdio: 'inherit', timeout: 10 * 60_000 });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveProcess() : reject(new Error(`${registry} publishing failed (${code}).`)));
  });
}

const items = [];
for (const kind of ['local', 'remote']) {
  const path = resolve(`artifacts/openvsx/${publisher}/remote-ports-${kind}-${root.version}.vsix`);
  const bytes = await readFile(path);
  const files = await packageContents(bytes);
  const manifest = JSON.parse(files.get('extension/package.json').toString());
  const name = kind === 'local' ? 'remote-port-forward-ui' : 'remote-port-forward';
  if (manifest.publisher !== publisher || manifest.version !== root.version || manifest.name !== name || manifest.license !== 'MIT') {
    throw new Error('Release package identity does not match the source.');
  }
  if (manifest.extensionKind?.[0] !== (kind === 'local' ? 'ui' : 'workspace')) throw new Error('Unexpected extension host.');
  if (kind === 'remote' && JSON.stringify(manifest.extensionPack) !== JSON.stringify([`${publisher}.remote-port-forward-ui`])) throw new Error('Incorrect companion installation reference.');
  items.push({ id: `${publisher}.${name}`, manifest, path, files });
  process.stdout.write(`Verified ${name}: ${createHash('sha256').update(bytes).digest('hex')}\n`);
}

if (values.preflight) {
  for (const registry of values.registry === 'all' ? ['openvsx', 'marketplace'] : [values.registry]) {
    const url = await publishedDownload(registry, items[0]);
    process.stdout.write(`${registry} API is reachable; companion version ${url ? 'is available' : 'has not been published'}.\n`);
  }
}

if (!values.check && !values.preflight) {
  for (const registry of values.registry === 'all' ? ['openvsx', 'marketplace'] : [values.registry]) {
    for (const item of items) {
      if (await verifyPublished(registry, item)) {
        process.stdout.write(`Verified existing ${item.id}@${root.version} on ${registry}.\n`);
      } else {
        if (values['verify-only']) throw new Error(`${item.id} is not published to ${registry}.`);
        await publish(registry, item);
        await verifyPublished(registry, item, true);
      }
      summaries.push(`- ${registry}: ${item.id}@${root.version} — published package contents verified`);
    }
  }
}
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Remote Ports ${root.version}\n\n${summaries.length ? summaries.join('\n') : 'Release package validation passed. Publishing was not requested.'}\n`);
}
