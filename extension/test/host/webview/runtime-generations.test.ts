import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

type Identity = { publisher: string; name: string; version: string };
type RuntimeGeneration = { generation: string | null; outDir: string; publishedAt: number };
type PublishedGeneration = { generation: string; outDir: string; publishedAt: number };
type RuntimeLease = RuntimeGeneration & { release(): Promise<void> };
type RuntimeApi = {
  publishRuntimeGeneration(options: {
    sourceOutDir: string;
    extensionDir: string;
    identity: Identity;
    beforeSelect?: (publication: PublishedGeneration) => void | Promise<void>;
  }): Promise<PublishedGeneration>;
  resolveRuntimeGeneration(options: { extensionDir: string; identity: Identity }): Promise<RuntimeGeneration>;
  acquireRuntimeGeneration(options: { extensionDir: string; identity: Identity }): Promise<RuntimeLease>;
};

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const runtimeModulePath = fileURLToPath(new URL('../../../runtime/runtime-generations.cjs', import.meta.url));
const runtime = require(runtimeModulePath) as RuntimeApi;
const IDENTITY: Identity = { publisher: 'pie', name: 'pie', version: '0.3.0' };
const BUILD_ID = '0123456789abcdef0123';

async function createRuntimeSource(root: string, name: string, options: {
  sharedContents?: string;
  manifest?: Record<string, unknown>;
  extensionContents?: string;
} = {}): Promise<string> {
  const source = path.join(root, `source-${name}`);
  const renderer = path.join(source, 'webview', 'panel');
  await mkdir(path.join(renderer, '.vite'), { recursive: true });
  await mkdir(path.join(renderer, 'assets'), { recursive: true });
  await mkdir(path.join(source, 'shared'), { recursive: true });
  const entry = `assets/panel-${name}.js`;
  const lazy = `assets/lazy-${name}.js`;
  await Promise.all([
    writeFile(path.join(source, 'extension.js'), options.extensionContents ?? 'module.exports = { activate: async () => ({ deactivate: async () => {} }) };'),
    writeFile(path.join(source, 'backend.js'), `backend-${name}`),
    writeFile(path.join(source, 'worker-entry.js'), `worker-${name}`),
    writeFile(path.join(source, 'pie-build-id.txt'), `${BUILD_ID}\n`),
    writeFile(path.join(renderer, 'pie-build-id.txt'), `${BUILD_ID}\n`),
    writeFile(path.join(renderer, entry), `export const panel = '${name}';`),
    writeFile(path.join(renderer, lazy), `export const lazy = '${name}';`),
    writeFile(path.join(source, 'shared', 'dependency.js'), options.sharedContents ?? `shared-${name}`),
    writeFile(path.join(renderer, '.vite', 'manifest.json'), JSON.stringify(options.manifest ?? {
      'panel.tsx': { file: entry, dynamicImports: ['lazy.ts'], isEntry: true },
      'lazy.ts': { file: lazy, isDynamicEntry: true },
    })),
  ]);
  return source;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function withTempRoot<T>(callback: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pie-runtime-generations-'));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('publishes a verified full-output content generation, not just the build ID', async () => withTempRoot(async (root) => {
  const extensionDir = path.join(root, 'extension');
  const sourceA = await createRuntimeSource(root, 'a', { sharedContents: 'shared-a' });
  const sourceB = await createRuntimeSource(root, 'b', { sharedContents: 'shared-b' });

  const packaged = await runtime.resolveRuntimeGeneration({ extensionDir, identity: IDENTITY });
  assert.deepEqual(packaged, { generation: null, outDir: path.join(extensionDir, 'out'), publishedAt: 0 });

  const first = await runtime.publishRuntimeGeneration({ sourceOutDir: sourceA, extensionDir, identity: IDENTITY });
  const second = await runtime.publishRuntimeGeneration({ sourceOutDir: sourceB, extensionDir, identity: IDENTITY });
  assert.notEqual(first.generation, second.generation, 'shared output changes must change the content generation');
  assert.match(first.generation, /^[0-9a-f]{64}$/u);
  assert.equal(await readFile(path.join(second.outDir, 'shared', 'dependency.js'), 'utf8'), 'shared-b');
  await Promise.all(['extension.js', 'backend.js', 'worker-entry.js'].map((name) => stat(path.join(second.outDir, name))));
  await stat(path.join(path.dirname(second.outDir), 'runtime-manifest.json'));

  const selected = await runtime.resolveRuntimeGeneration({ extensionDir, identity: IDENTITY });
  assert.deepEqual(selected, second);
  assert.ok(selected.publishedAt > 0);
}));

test('skips torn or damaged newest markers and rejects manifest traversal', async () => withTempRoot(async (root) => {
  const extensionDir = path.join(root, 'extension');
  const sourceA = await createRuntimeSource(root, 'a');
  const sourceB = await createRuntimeSource(root, 'b');
  const first = await runtime.publishRuntimeGeneration({ sourceOutDir: sourceA, extensionDir, identity: IDENTITY });
  const second = await runtime.publishRuntimeGeneration({ sourceOutDir: sourceB, extensionDir, identity: IDENTITY });

  await writeFile(path.join(second.outDir, 'backend.js'), 'damaged');
  const afterDamage = await runtime.resolveRuntimeGeneration({ extensionDir, identity: IDENTITY });
  assert.equal(afterDamage.generation, first.generation);

  const selectionsDir = path.join(extensionDir, 'pie-runtime', 'selections');
  let markerName: string | undefined;
  for (const name of await readdir(selectionsDir)) {
    if (!name.endsWith('.json')) continue;
    const marker = JSON.parse(await readFile(path.join(selectionsDir, name), 'utf8')) as { generation?: unknown };
    if (marker.generation === second.generation) {
      markerName = name;
      break;
    }
  }
  assert.ok(markerName);
  const markerPath = path.join(selectionsDir, markerName);
  const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>;
  await writeFile(markerPath, JSON.stringify({ ...marker, generation: '../outside' }));
  const afterTraversalMarker = await runtime.resolveRuntimeGeneration({ extensionDir, identity: IDENTITY });
  assert.equal(afterTraversalMarker.generation, first.generation);

  const invalidSource = await createRuntimeSource(root, 'invalid', {
    manifest: { 'panel.tsx': { file: '../outside.js', isEntry: true } },
  });
  await assert.rejects(
    runtime.publishRuntimeGeneration({ sourceOutDir: invalidSource, extensionDir, identity: IDENTITY }),
    /inside its runtime output|traverse/u,
  );
}));

test('serializes concurrent publication and retains leased generations until release', async () => withTempRoot(async (root) => {
  const extensionDir = path.join(root, 'extension');
  const sources = await Promise.all([
    createRuntimeSource(root, 'a'),
    createRuntimeSource(root, 'b'),
    createRuntimeSource(root, 'c'),
  ]);
  const publications = await Promise.all(sources.map((source) => runtime.publishRuntimeGeneration({
    sourceOutDir: source,
    extensionDir,
    identity: IDENTITY,
  })));
  const current = publications.at(-1)!;
  const generationsDir = path.join(extensionDir, 'pie-runtime', 'generations');
  const afterConcurrent = (await readdir(generationsDir)).filter((name) => /^[0-9a-f]{64}$/u.test(name));
  assert.ok(afterConcurrent.length <= 2, 'ordinary retention keeps only current and prior generations');

  const lease = await runtime.acquireRuntimeGeneration({ extensionDir, identity: IDENTITY });
  assert.equal(lease.generation, (await runtime.resolveRuntimeGeneration({ extensionDir, identity: IDENTITY })).generation);
  const oldGeneration = lease.generation;
  assert.ok(oldGeneration);

  const sourceD = await createRuntimeSource(root, 'd');
  const sourceE = await createRuntimeSource(root, 'e');
  await runtime.publishRuntimeGeneration({ sourceOutDir: sourceD, extensionDir, identity: IDENTITY });
  await runtime.publishRuntimeGeneration({ sourceOutDir: sourceE, extensionDir, identity: IDENTITY });
  assert.equal(await exists(path.join(generationsDir, oldGeneration, 'out')), true, 'a live lease prevents deletion');
  await lease.release();
  assert.equal(await exists(path.join(generationsDir, oldGeneration, 'out')), false, 'release makes an old generation reclaimable');
  assert.equal(await exists(path.join(generationsDir, current.generation, 'out')), false, 'the oldest unleased generation is reclaimed');
}));

test('recovers a stale lock directory whose owner marker is missing', async () => withTempRoot(async (root) => {
  const extensionDir = path.join(root, 'extension');
  const lockDir = path.join(extensionDir, 'pie-runtime', '.lock');
  await mkdir(lockDir, { recursive: true });
  await utimes(lockDir, new Date(0), new Date(0));

  const lease = await runtime.acquireRuntimeGeneration({ extensionDir, identity: IDENTITY });
  assert.equal(lease.generation, null);
  await lease.release();
  assert.equal(await exists(lockDir), false, 'the abandoned lock was recovered');
}));

test('verifies Vite worker URL literal assets that are absent from manifest.json', async () => withTempRoot(async (root) => {
  const extensionDir = path.join(root, 'extension');
  const source = await createRuntimeSource(root, 'worker');
  const entryPath = path.join(source, 'webview', 'panel', 'assets', 'panel-worker.js');
  const workerName = 'panel-worker-abc123.js';
  await writeFile(entryPath, `const workerUrl = '/assets/${workerName}';`);

  await assert.rejects(
    runtime.publishRuntimeGeneration({ sourceOutDir: source, extensionDir, identity: IDENTITY }),
    /Renderer worker asset|ENOENT/u,
  );
  await writeFile(path.join(source, 'webview', 'panel', 'assets', workerName), 'worker');
  const published = await runtime.publishRuntimeGeneration({ sourceOutDir: source, extensionDir, identity: IDENTITY });
  assert.equal(published.generation.length, 64);
}));

test('fails closed when selection or lease metadata directories cannot be read', async () => withTempRoot(async (root) => {
  const extensionDir = path.join(root, 'extension');
  const sourceA = await createRuntimeSource(root, 'unreadable-a');
  const sourceB = await createRuntimeSource(root, 'unreadable-b');
  const sourceC = await createRuntimeSource(root, 'unreadable-c');
  const first = await runtime.publishRuntimeGeneration({ sourceOutDir: sourceA, extensionDir, identity: IDENTITY });
  const lease = await runtime.acquireRuntimeGeneration({ extensionDir, identity: IDENTITY });
  assert.equal(lease.generation, first.generation);
  await runtime.publishRuntimeGeneration({ sourceOutDir: sourceB, extensionDir, identity: IDENTITY });

  const leasesDir = path.join(extensionDir, 'pie-runtime', 'leases');
  await runtime.publishRuntimeGeneration({
    sourceOutDir: sourceC,
    extensionDir,
    identity: IDENTITY,
    beforeSelect: async () => {
      await rm(leasesDir, { recursive: true, force: true });
      await writeFile(leasesDir, 'not a directory');
    },
  });
  assert.equal(
    await exists(path.join(extensionDir, 'pie-runtime', 'generations', first.generation, 'out')),
    true,
    'cleanup does not delete a generation when lease knowledge is unavailable',
  );

  const selectionsDir = path.join(extensionDir, 'pie-runtime', 'selections');
  await rm(selectionsDir, { recursive: true, force: true });
  await writeFile(selectionsDir, 'not a directory');
  await assert.rejects(
    runtime.resolveRuntimeGeneration({ extensionDir, identity: IDENTITY }),
    /ENOTDIR|not a directory|directory/u,
  );
}));

test('mints monotonic selection timestamps across frozen cross-process clocks', async () => withTempRoot(async (root) => {
  const extensionDir = path.join(root, 'extension');
  const sourceA = await createRuntimeSource(root, 'same-ms-a');
  const sourceB = await createRuntimeSource(root, 'same-ms-b');
  const childScript = `
    Date.now = () => 1700000000000;
    const runtime = require(process.env.PIE_RUNTIME_MODULE);
    runtime.publishRuntimeGeneration({
      sourceOutDir: process.env.PIE_RUNTIME_SOURCE,
      extensionDir: process.env.PIE_RUNTIME_EXTENSION,
      identity: ${JSON.stringify(IDENTITY)},
    }).then((value) => process.stdout.write(JSON.stringify(value)))
      .catch((error) => { console.error(error?.stack || error); process.exitCode = 1; });
  `;
  async function publishInChild(source: string): Promise<PublishedGeneration> {
    const { stdout } = await execFileAsync(process.execPath, ['-e', childScript], {
      env: {
        ...process.env,
        PIE_RUNTIME_MODULE: runtimeModulePath,
        PIE_RUNTIME_SOURCE: source,
        PIE_RUNTIME_EXTENSION: extensionDir,
      },
      encoding: 'utf8',
      windowsHide: true,
    });
    return JSON.parse(stdout.trim()) as PublishedGeneration;
  }

  const first = await publishInChild(sourceA);
  const second = await publishInChild(sourceB);
  assert.equal(first.publishedAt, 1700000000000);
  assert.equal(second.publishedAt, 1700000000001);
  assert.equal((await runtime.resolveRuntimeGeneration({ extensionDir, identity: IDENTITY })).generation, second.generation);
}));
