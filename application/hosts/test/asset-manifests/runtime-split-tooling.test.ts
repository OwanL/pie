import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const runtime = require('../../vscode/runtime/runtime-generations.cjs');
const identity = { publisher: 'pie', name: 'pie', version: '0.3.0' };
const toolingIdentity = 'a'.repeat(64);
const referencePath = 'pi-runtime/tooling-reference.json';
type RecordEntry = { path: string; size: number; sha256: string };

async function fixture(callback: (source: string, extensionDir: string) => Promise<void>, split = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-runtime-split-'));
  const source = path.join(root, 'source');
  const extensionDir = path.join(root, 'extension');
  try {
    const files: Record<string, string> = {
      'extension.js': 'extension', 'backend.js': 'backend', 'worker-entry.js': 'worker',
      'pie-build-id.txt': 'build', 'webview/panel/pie-build-id.txt': 'build',
      'webview/panel/.vite/manifest.json': JSON.stringify({ panel: { file: 'assets/panel.js', isEntry: true } }),
      'webview/panel/assets/panel.js': 'panel', 'shared/dependency.js': 'dependency',
    };
    if (split) Object.assign(files, {
      [referencePath]: JSON.stringify({ schemaVersion: 1, artifactDirectory: '../pi-tooling', identity: toolingIdentity }),
      'pi-runtime/runtime.js': 'runtime SDK fixture',
      'pi-tooling/manifest.json': 'opaque tooling metadata',
      'pi-tooling/node_modules/package/tool.js': 'full original tooling bytes',
    });
    for (const [name, contents] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(source, name)), { recursive: true });
      await fs.writeFile(path.join(source, name), contents);
    }
    await callback(source, extensionDir);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
const publish = (sourceOutDir: string, extensionDir: string, beforeSelect?: (value: any) => Promise<void>) =>
  runtime.publishRuntimeGeneration({ sourceOutDir, extensionDir, identity, beforeSelect });
const resolve = (extensionDir: string) => runtime.resolveRuntimeGeneration({ extensionDir, identity });
const manifestPath = (outDir: string) => path.join(outDir, '..', 'runtime-manifest.json');
async function manifest(outDir: string) { return JSON.parse(await fs.readFile(manifestPath(outDir), 'utf8')); }
function hashRecords(records: RecordEntry[]) {
  const hash = createHash('sha256');
  for (const record of [...records].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`${record.path}\0${record.size}\0${record.sha256}\0`);
  }
  return hash.digest('hex');
}

test('v2 partitions records but keeps the full payload generation hash and schema-1 selection', async () => fixture(async (source, extensionDir) => {
  const published = await publish(source, extensionDir);
  const metadata = await manifest(published.outDir);
  assert.equal(metadata.schema, 2);
  assert.equal(metadata.tooling.path, 'pi-tooling');
  assert.equal(metadata.tooling.identity, toolingIdentity);
  assert(metadata.files.some((record: RecordEntry) => record.path === referencePath));
  assert(metadata.files.every((record: RecordEntry) => !record.path.startsWith('pi-tooling/')));
  assert.equal(hashRecords([...metadata.files, ...metadata.tooling.files]), published.generation);
  const selections = path.join(extensionDir, 'pie-runtime-v2', 'selections');
  const marker = JSON.parse(await fs.readFile(path.join(selections, (await fs.readdir(selections))[0]), 'utf8'));
  assert.equal(marker.schema, 1);
}));

test('v2 acquisition never lstats tooling members; unused tooling damage does not block runtime', async () => fixture(async (source, extensionDir) => {
  const published = await publish(source, extensionDir);
  await fs.rm(path.join(published.outDir, 'pi-tooling/manifest.json'));
  await fs.writeFile(path.join(published.outDir, 'pi-tooling/node_modules/package/tool.js'), 'damaged');
  await fs.writeFile(path.join(published.outDir, 'pi-tooling/unknown'), 'extra');
  const original = fs.lstat;
  fs.lstat = (async (file: any, ...args: any[]) => {
    assert(!String(file).replaceAll('\\', '/').includes('/pi-tooling/'), 'tooling member metadata read');
    return (original as any)(file, ...args);
  }) as typeof fs.lstat;
  let lease;
  try {
    lease = await runtime.acquireRuntimeGeneration({ extensionDir, identity });
    assert.equal(lease.generation, published.generation);
    assert.equal((await resolve(extensionDir)).generation, published.generation);
  } finally { fs.lstat = original; await lease?.release(); }
}));

for (const damage of ['modify', 'remove', 'add']) {
  test(`publication rejects ${damage} tooling before selection, including existing-generation reuse`, async () => fixture(async (source, extensionDir) => {
    const previous = await publish(source, extensionDir);
    await fs.writeFile(path.join(source, 'backend.js'), 'new backend');
    await assert.rejects(publish(source, extensionDir, async ({ outDir }) => {
      const file = path.join(outDir, 'pi-tooling/node_modules/package/tool.js');
      if (damage === 'modify') await fs.writeFile(file, 'damaged');
      if (damage === 'remove') await fs.rm(file);
      if (damage === 'add') await fs.writeFile(path.join(outDir, 'pi-tooling/added'), 'extra');
    }));
    assert.equal((await resolve(extensionDir)).generation, previous.generation);
    await assert.rejects(publish(source, extensionDir));
    assert.equal((await resolve(extensionDir)).generation, previous.generation);
  }));
  test(`runtime ${damage} remains fail-closed`, async () => fixture(async (source, extensionDir) => {
    const published = await publish(source, extensionDir);
    const file = path.join(published.outDir, 'shared/dependency.js');
    if (damage === 'modify') await fs.writeFile(file, 'tampered');
    if (damage === 'remove') await fs.rm(file);
    if (damage === 'add') await fs.writeFile(path.join(published.outDir, 'unknown.js'), 'extra');
    assert.equal((await resolve(extensionDir)).generation, null);
  }));
}

const mutations: Record<string, (metadata: any) => void> = {
  'root extra field': (m) => { m.extra = true; },
  'tooling extra field': (m) => { m.tooling.extra = true; },
  'record extra field': (m) => { m.tooling.files[0].extra = true; },
  'tooling identity': (m) => { m.tooling.identity = 'b'.repeat(64); },
  'tooling digest': (m) => { m.tooling.files[0].sha256 = 'b'.repeat(64); },
  'tooling traversal': (m) => { m.tooling.path = '../pi-tooling'; },
  'role overlap': (m) => { m.files.push(m.tooling.files[0]); },
  'tooling runtime member': (m) => { m.tooling.files.push(m.files[0]); },
  'missing reference': (m) => { m.files = m.files.filter((r: RecordEntry) => r.path !== referencePath); },
  'missing tooling manifest': (m) => { m.tooling.files = m.tooling.files.filter((r: RecordEntry) => r.path !== 'pi-tooling/manifest.json'); },
  'tooling case alias': (m) => { m.tooling.files[0].path = m.tooling.files[0].path.replace('pi-tooling', 'PI-TOOLING'); },
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`rejects v2 metadata ${name}`, async () => fixture(async (source, extensionDir) => {
    const published = await publish(source, extensionDir);
    const metadata = await manifest(published.outDir);
    mutate(metadata);
    await fs.writeFile(manifestPath(published.outDir), JSON.stringify(metadata));
    assert.equal((await resolve(extensionDir)).generation, null);
  }));
}

test('reference bytes are verified, not an independent authority', async () => fixture(async (source, extensionDir) => {
  const published = await publish(source, extensionDir);
  await fs.writeFile(path.join(published.outDir, referencePath), JSON.stringify({ schemaVersion: 1, artifactDirectory: '../pi-tooling', identity: 'b'.repeat(64) }));
  assert.equal((await resolve(extensionDir)).generation, null);
}));

for (const reference of [
  { schemaVersion: 1, artifactDirectory: '../pi-tooling', identity: toolingIdentity, extra: true },
  { schemaVersion: 1, artifactDirectory: '../../pi-tooling', identity: toolingIdentity },
  { schemaVersion: 1, artifactDirectory: '../PI-TOOLING', identity: toolingIdentity },
  { schemaVersion: 1, artifactDirectory: '../pi-tooling', identity: 'not-a-digest' },
]) {
  test(`publication rejects noncanonical reference ${JSON.stringify(reference)}`, async () => fixture(async (source, extensionDir) => {
    await fs.writeFile(path.join(source, referencePath), JSON.stringify(reference));
    await assert.rejects(publish(source, extensionDir));
    assert.equal((await resolve(extensionDir)).generation, null);
  }));
}

test('tooling without a split reference remains a fully verified v1 output', async () => fixture(async (source, extensionDir) => {
  await fs.rm(path.join(source, referencePath));
  const published = await publish(source, extensionDir);
  assert.equal((await manifest(published.outDir)).schema, 1);
  await fs.writeFile(path.join(published.outDir, 'pi-tooling/manifest.json'), 'damage');
  assert.equal((await resolve(extensionDir)).generation, null);
}));

for (const variant of ['symlink', 'case alias', 'file']) {
  test(`fresh tooling root rejects ${variant}`, async () => fixture(async (source, extensionDir) => {
    const tooling = path.join(source, 'pi-tooling');
    if (variant === 'case alias') await fs.rename(tooling, path.join(source, 'PI-TOOLING'));
    else {
      const target = path.join(source, '..', 'original-tooling');
      await fs.rename(tooling, target);
      if (variant === 'file') await fs.writeFile(tooling, 'not a directory');
      else await fs.symlink(target, tooling, 'junction');
    }
    await assert.rejects(publish(source, extensionDir));
    assert.equal((await resolve(extensionDir)).generation, null);
  }));
}

test('v1 and v2 coexist and conservative leases preserve old generations', async () => fixture(async (source, extensionDir) => {
  const old = await publish(source, extensionDir);
  assert.equal((await manifest(old.outDir)).schema, 1);
  const lease = await runtime.acquireRuntimeGeneration({ extensionDir, identity });
  await fs.mkdir(path.join(source, 'pi-runtime'), { recursive: true });
  await fs.mkdir(path.join(source, 'pi-tooling'), { recursive: true });
  await fs.writeFile(path.join(source, referencePath), JSON.stringify({ schemaVersion: 1, artifactDirectory: '../pi-tooling', identity: toolingIdentity }));
  await fs.writeFile(path.join(source, 'pi-tooling/manifest.json'), 'opaque');
  const next = await publish(source, extensionDir);
  assert.equal((await manifest(next.outDir)).schema, 2);
  await fs.writeFile(path.join(source, 'backend.js'), 'third');
  const third = await publish(source, extensionDir);
  assert.equal((await resolve(extensionDir)).generation, third.generation);
  await fs.stat(old.outDir);
  await lease.release();
  await assert.rejects(fs.stat(old.outDir), { code: 'ENOENT' });
}, false));
