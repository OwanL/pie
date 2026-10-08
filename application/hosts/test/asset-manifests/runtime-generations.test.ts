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
  RUNTIME_DIRECTORY: string;
  SELECTIONS_DIRECTORY: string;
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
const runtimeModulePath = fileURLToPath(new URL('../../vscode/runtime/runtime-generations.cjs', import.meta.url));
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

async function withTimingFile<T>(filePath: string, callback: () => Promise<T>): Promise<T> {
  const previous = process.env.PIE_STARTUP_TIMING_FILE;
  process.env.PIE_STARTUP_TIMING_FILE = filePath;
  try {
    return await callback();
  } finally {
    if (previous === undefined) delete process.env.PIE_STARTUP_TIMING_FILE;
    else process.env.PIE_STARTUP_TIMING_FILE = previous;
  }
}

async function waitForTimingRows(filePath: string): Promise<Array<Record<string, unknown>>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const contents = await readFile(filePath, 'utf8');
      const rows = contents.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
      if (rows.length > 0) return rows;
    } catch {
      // The diagnostic append is intentionally asynchronous and best effort.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Runtime acquisition timing record was not written.');
}

async function addSelectionMarker(extensionDir: string, generation: string, publishedAt: number, suffix: string): Promise<string> {
  const selectionsDir = path.join(extensionDir, runtime.RUNTIME_DIRECTORY, runtime.SELECTIONS_DIRECTORY);
  const name = `${String(publishedAt).padStart(13, '0')}-${String(process.pid).padStart(10, '0')}-999999999-${generation}-${suffix.padStart(16, '0')}.json`;
  await writeFile(path.join(selectionsDir, name), JSON.stringify({ schema: 1, identity: IDENTITY, generation, publishedAt }));
  return name;
}

test('records bounded acquisition and per-generation verification phase timings', async () => withTempRoot(async (root) => {
  const extensionDir = path.join(root, 'extension');
  const diagnosticFile = path.join(root, 'startup-timing.jsonl');
  await withTimingFile(diagnosticFile, async () => {
    const source = await createRuntimeSource(root, 'timed');
    const published = await runtime.publishRuntimeGeneration({ sourceOutDir: source, extensionDir, identity: IDENTITY });
    const lease = await runtime.acquireRuntimeGeneration({ extensionDir, identity: IDENTITY });
    assert.equal(lease.generation, published.generation);
    await lease.release();

    const rows = await waitForTimingRows(diagnosticFile);
    for (const row of rows) {
      assert.equal(row.tag, 'DEBUG-startup-profile');
      assert.equal(row.pid, process.pid);
      assert.equal(typeof row.timestamp, 'string');
      assert.equal(new Date(row.timestamp as string).toISOString(), row.timestamp);
    }
    const acquisition = rows.find((row) => row.source === 'runtime-generations' && row.event === 'acquire');
    assert.ok(acquisition);
    assert.equal(acquisition.outcome, 'success');
    for (const field of ['acquisitionMs', 'lockWaitMs', 'selectionVerificationMs', 'cleanupMs']) {
      assert.equal(typeof acquisition[field], 'number', `${field} should be a duration`);
    }
    const verifications = acquisition.verification as Array<Record<string, unknown>>;
    assert.equal(verifications.length, 1);
    assert.equal(verifications[0]?.generation, published.generation);
    assert.equal(verifications[0]?.count, 1, 'the selected generation is verified once before leasing');
    assert.equal(acquisition.cleanupMs, 0, 'acquisition performs no retention cleanup');
    assert.ok(Number(verifications[0]?.files) > 0);
    assert.ok(Number(verifications[0]?.bytes) > 0);
    const phases = verifications[0]?.phasesMs as Record<string, unknown>;
    for (const phase of ['manifestMs', 'fileScanMs', 'manifestComparisonMs', 'contentHashMs', 'outputShapeMs']) {
      assert.equal(typeof phases[phase], 'number', `${phase} should be a duration`);
    }
    const serialized = JSON.stringify(acquisition);
    assert.doesNotMatch(serialized, /startup-timing|extensionDir|identity|publisher|version|session/iu);
    assert.ok((await stat(diagnosticFile)).size <= 1_048_576);

    // A diagnostics write failure is best effort; runtime acquisition still works.
    process.env.PIE_STARTUP_TIMING_FILE = root;
    const leaseWithoutDiagnostics = await runtime.acquireRuntimeGeneration({ extensionDir, identity: IDENTITY });
    assert.equal(leaseWithoutDiagnostics.generation, published.generation);
    await leaseWithoutDiagnostics.release();
  });
}));

test('acquisition resolves before reading a valid unused prior payload and defers invalid-marker maintenance', async () => withTempRoot(async (root) => {
  const extensionDir = path.join(root, 'extension');
  const sourceA = await createRuntimeSource(root, 'startup-prior');
  const sourceB = await createRuntimeSource(root, 'startup-selected');
  const prior = await runtime.publishRuntimeGeneration({ sourceOutDir: sourceA, extensionDir, identity: IDENTITY });
  const selected = await runtime.publishRuntimeGeneration({ sourceOutDir: sourceB, extensionDir, identity: IDENTITY });
  const selectionsDir = path.join(extensionDir, 'pie-runtime', 'selections');
  const invalidMarker = await addSelectionMarker(extensionDir, selected.generation, selected.publishedAt + 1, 'a');
  await writeFile(path.join(selectionsDir, invalidMarker), '{torn');

  // Gate the actual payload-hashing seam, not manifest metadata or timing output.
  const fsSync = require('node:fs') as typeof import('node:fs');
  const descriptor = Object.getOwnPropertyDescriptor(fsSync, 'createReadStream');
  assert.ok(descriptor);
  const original = fsSync.createReadStream;
  let unblock!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => { unblock = resolve; });
  const priorRead = new Promise<'prior-read'>((resolve) => { reached = () => resolve('prior-read'); });
  const selectedReads = new Set<string>();
  Object.defineProperty(fsSync, 'createReadStream', {
    ...descriptor,
    value: (...args: unknown[]) => {
      const filePath = String(args[0]);
      if (filePath.startsWith(`${selected.outDir}${path.sep}`)) selectedReads.add(path.relative(selected.outDir, filePath).replaceAll('\\', '/'));
      if (!filePath.startsWith(`${prior.outDir}${path.sep}`)) return Reflect.apply(original, fsSync, args);
      reached();
      return (async function* () {
        await gate;
        yield* Reflect.apply(original, fsSync, args);
      })();
    },
  });
  let lease: RuntimeLease | undefined;
  const acquisition = runtime.acquireRuntimeGeneration({ extensionDir, identity: IDENTITY });
  try {
    const winner = await Promise.race([acquisition.then((value) => { lease = value; return 'acquired'; }), priorRead]);
    assert.equal(winner, 'acquired', 'startup must resolve while unused prior payload reads remain gated');
    assert.equal(lease?.generation, selected.generation);
    const manifest = JSON.parse(await readFile(path.join(path.dirname(selected.outDir), 'runtime-manifest.json'), 'utf8')) as { files: Array<{ path: string }> };
    assert.deepEqual([...selectedReads].sort(), manifest.files.map((file) => file.path).sort(), 'every selected payload file is fully hashed before acquisition resolves');
    assert.equal(await exists(path.join(selectionsDir, invalidMarker)), true, 'acquisition leaves invalid markers for maintenance');
    assert.equal(await exists(prior.outDir), true, 'acquisition preserves the valid prior generation');
  } finally {
    unblock();
    try {
      lease = await acquisition;
    } finally {
      Object.defineProperty(fsSync, 'createReadStream', descriptor);
    }
    await lease?.release();
  }
  assert.equal(await exists(path.join(selectionsDir, invalidMarker)), false, 'release performs deferred marker cleanup');
  assert.equal(await exists(prior.outDir), true, 'release retains the valid prior generation');
}));

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

test('explicitly re-selects an earlier immutable generation while a later lease stays protected', { timeout: 30_000 }, async () => withTempRoot(async (root) => {
  const extensionDir = path.join(root, 'extension');
  const hostInteractionsPath = path.join(root, 'host-interactions.log');
  const extensionContents = [
    "const fs = require('node:fs');",
    `const interactionsPath = ${JSON.stringify(hostInteractionsPath)};`,
    "fs.appendFileSync(interactionsPath, 'module-loaded\\n');",
    'module.exports = {',
    '  activate: async () => {',
    "    fs.appendFileSync(interactionsPath, 'activate\\n');",
    "    return { deactivate: async () => fs.appendFileSync(interactionsPath, 'deactivate\\n') };",
    '  },',
    '};',
  ].join('\n');
  const sourceA = await createRuntimeSource(root, 'rollback-a', { extensionContents });
  const sourceB = await createRuntimeSource(root, 'rollback-b', { extensionContents });
  const sourceC = await createRuntimeSource(root, 'rollback-c', { extensionContents });
  const first = await runtime.publishRuntimeGeneration({ sourceOutDir: sourceA, extensionDir, identity: IDENTITY });
  const second = await runtime.publishRuntimeGeneration({ sourceOutDir: sourceB, extensionDir, identity: IDENTITY });
  assert.notEqual(second.generation, first.generation);

  const leaseB = await runtime.acquireRuntimeGeneration({ extensionDir, identity: IDENTITY });
  assert.equal(leaseB.generation, second.generation);
  try {
    // This is an explicit re-selection by publishing known-good A, not an automatic fallback/retry path.
    const reselected = await runtime.publishRuntimeGeneration({ sourceOutDir: sourceA, extensionDir, identity: IDENTITY });
    assert.equal(reselected.generation, first.generation, 'identical content keeps A\'s immutable generation identity');
    assert.equal(reselected.outDir, first.outDir, 're-selection reuses A\'s immutable output directory');

    const resolved = await runtime.resolveRuntimeGeneration({ extensionDir, identity: IDENTITY });
    assert.deepEqual(resolved, reselected, 'resolution selects the newly published marker for A');
    assert.equal(await readFile(path.join(resolved.outDir, 'shared', 'dependency.js'), 'utf8'), 'shared-rollback-a');
    assert.equal(await readFile(path.join(second.outDir, 'shared', 'dependency.js'), 'utf8'), 'shared-rollback-b');

    const third = await runtime.publishRuntimeGeneration({ sourceOutDir: sourceC, extensionDir, identity: IDENTITY });
    assert.notEqual(third.generation, first.generation);
    assert.notEqual(third.generation, second.generation);
    const generationsDir = path.join(extensionDir, 'pie-runtime', 'generations');
    assert.equal(
      await exists(path.join(generationsDir, second.generation, 'out')),
      true,
      'B remains retained by its lease after it falls outside current+prior selection retention',
    );
  } finally {
    await leaseB.release();
  }

  assert.equal(
    await exists(path.join(extensionDir, 'pie-runtime', 'generations', second.generation, 'out')),
    false,
    'releasing the lease makes now-unselected B reclaimable',
  );
  assert.equal(await exists(hostInteractionsPath), false, 'generation publication and re-selection do not load or activate host code');
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

test('reuses verified selection results while failed generations fall back and leases remain protected', async () => withTempRoot(async (root) => {
  const extensionDir = path.join(root, 'extension');
  const sourceA = await createRuntimeSource(root, 'reuse-a');
  const sourceB = await createRuntimeSource(root, 'reuse-b');
  const first = await runtime.publishRuntimeGeneration({ sourceOutDir: sourceA, extensionDir, identity: IDENTITY });
  const second = await runtime.publishRuntimeGeneration({ sourceOutDir: sourceB, extensionDir, identity: IDENTITY });
  const leaseB = await runtime.acquireRuntimeGeneration({ extensionDir, identity: IDENTITY });
  assert.equal(leaseB.generation, second.generation);

  let fallbackLease: RuntimeLease | undefined;
  try {
    await writeFile(path.join(second.outDir, 'backend.js'), 'damaged');
    const diagnosticFile = path.join(root, 'fallback-timing.jsonl');
    await withTimingFile(diagnosticFile, async () => {
      fallbackLease = await runtime.acquireRuntimeGeneration({ extensionDir, identity: IDENTITY });
      assert.equal(fallbackLease.generation, first.generation, 'a damaged newest selection falls back to the next verified generation');

      const rows = await waitForTimingRows(diagnosticFile);
      const acquisition = rows.find((row) => row.source === 'runtime-generations' && row.event === 'acquire');
      assert.ok(acquisition);
      const verifications = acquisition.verification as Array<Record<string, unknown>>;
      const failed = verifications.find((verification) => verification.generation === second.generation);
      const fallback = verifications.find((verification) => verification.generation === first.generation);
      assert.equal(failed?.count, 1, 'the failed candidate is not re-verified during cleanup');
      assert.equal(failed?.failures, 1);
      assert.equal(fallback?.count, 1, 'the selected fallback is not re-verified during cleanup');
      assert.equal(fallback?.failures, 0);
    });

    assert.equal(await exists(path.join(extensionDir, 'pie-runtime', 'generations', second.generation, 'out')), true, 'the lease protects a damaged generation');
    assert.ok(fallbackLease, 'the fallback lease was acquired');
    await fallbackLease.release();
    fallbackLease = undefined;
    await leaseB.release();
    assert.equal(await exists(path.join(extensionDir, 'pie-runtime', 'generations', second.generation, 'out')), false, 'releasing the last lease makes the failed generation reclaimable');
  } finally {
    if (fallbackLease) await fallbackLease.release();
    await leaseB.release();
  }
}));

test('bounds marker verification to distinct valid generations while honoring leases', async () => withTempRoot(async (root) => {
  const extensionDir = path.join(root, 'extension');
  const published: Record<string, PublishedGeneration> = {};
  const leases: RuntimeLease[] = [];
  let selectedLease: RuntimeLease | undefined;
  try {
    for (const name of ['oldest', 'older', 'prior', 'newest']) {
      const source = await createRuntimeSource(root, `bounded-${name}`);
      published[name] = await runtime.publishRuntimeGeneration({ sourceOutDir: source, extensionDir, identity: IDENTITY });
      leases.push(await runtime.acquireRuntimeGeneration({ extensionDir, identity: IDENTITY }));
    }

    const oldest = published.oldest!;
    const older = published.older!;
    const prior = published.prior!;
    const newest = published.newest!;
    const duplicateNewest = await addSelectionMarker(extensionDir, newest.generation, newest.publishedAt, 'f'.repeat(16));
    const duplicatePrior = await addSelectionMarker(extensionDir, prior.generation, prior.publishedAt, 'e'.repeat(16));
    await addSelectionMarker(extensionDir, older.generation, older.publishedAt, 'd'.repeat(16));
    await addSelectionMarker(extensionDir, oldest.generation, oldest.publishedAt, 'c'.repeat(16));
    await writeFile(path.join(newest.outDir, 'backend.js'), 'damaged');

    const diagnosticFile = path.join(root, 'bounded-selection-timing.jsonl');
    await withTimingFile(diagnosticFile, async () => {
      selectedLease = await runtime.acquireRuntimeGeneration({ extensionDir, identity: IDENTITY });
    });
    assert.ok(selectedLease, 'the fallback lease was acquired');
    assert.equal(selectedLease.generation, prior.generation, 'the damaged newest generation falls back');

    const rows = await waitForTimingRows(diagnosticFile);
    const acquisition = rows.find((row) => row.source === 'runtime-generations' && row.event === 'acquire');
    assert.ok(acquisition);
    const verifications = acquisition.verification as Array<Record<string, unknown>>;
    const summaries = new Map(verifications.map((verification) => [verification.generation, verification]));
    assert.equal(summaries.get(newest.generation)?.count, 1, 'duplicate markers do not re-verify a failed generation');
    assert.equal(summaries.get(newest.generation)?.failures, 1);
    assert.equal(summaries.get(prior.generation)?.count, 1, 'the newest duplicate marker represents its generation');
    assert.equal(summaries.has(older.generation), false, 'verification stops after one valid fallback');
    assert.equal(summaries.has(oldest.generation), false, 'older candidates are not scanned after one valid generation');
    assert.equal(acquisition.cleanupMs, 0);
    assert.equal(await exists(path.join(extensionDir, 'pie-runtime', 'selections', duplicateNewest)), true, 'acquisition leaves damaged markers for maintenance');

    await selectedLease.release();
    selectedLease = undefined;
    const selectionNames = (await readdir(path.join(extensionDir, 'pie-runtime', 'selections'))).filter((name) => name.endsWith('.json'));
    const priorMarkers = [];
    const retainedMarkerGenerations = new Set<string>();
    for (const name of selectionNames) {
      const marker = JSON.parse(await readFile(path.join(extensionDir, 'pie-runtime', 'selections', name), 'utf8')) as { generation?: string };
      if (marker.generation) retainedMarkerGenerations.add(marker.generation);
      if (marker.generation === prior.generation) priorMarkers.push(name);
    }
    assert.deepEqual(priorMarkers, [duplicatePrior], 'cleanup retains the newest marker for a generation');
    assert.deepEqual([...retainedMarkerGenerations].sort(), [older.generation, prior.generation].sort(), 'cleanup retains two distinct valid selections');
    assert.equal(selectionNames.includes(duplicateNewest), false, 'the damaged generation is not retained as a selected record');

    for (const generation of [oldest, older, prior, newest]) {
      assert.equal(
        await exists(path.join(extensionDir, 'pie-runtime', 'generations', generation.generation, 'out')),
        true,
        'leases preserve generations outside the two selected records',
      );
    }
  } finally {
    if (selectedLease) await selectedLease.release();
    for (const lease of leases.reverse()) await lease.release();
  }
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
  const second = await runtime.publishRuntimeGeneration({ sourceOutDir: sourceB, extensionDir, identity: IDENTITY });

  const leasesDir = path.join(extensionDir, 'pie-runtime', 'leases');
  const third = await runtime.publishRuntimeGeneration({
    sourceOutDir: sourceC,
    extensionDir,
    identity: IDENTITY,
    beforeSelect: async () => {
      await rm(leasesDir, { recursive: true, force: true });
      await writeFile(leasesDir, 'not a directory');
    },
  });
  for (const published of [first, second, third]) {
    assert.equal(
      await exists(path.join(extensionDir, 'pie-runtime', 'generations', published.generation, 'out')),
      true,
      'unreadable lease metadata leaves every generation untouched',
    );
  }

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
