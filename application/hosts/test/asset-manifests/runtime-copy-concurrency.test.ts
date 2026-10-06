import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

type RuntimeApi = {
  publishRuntimeGeneration(options: {
    sourceOutDir: string;
    extensionDir: string;
    identity: { publisher: string; name: string; version: string };
  }): Promise<{ generation: string; outDir: string }>;
};
type FsPromises = typeof import('node:fs/promises');
type LstatReplacement = (
  args: unknown[],
  lstatOriginal: (...args: unknown[]) => Promise<unknown>,
) => Promise<unknown>;
type CopyFileReplacement = (
  args: unknown[],
  copyFileOriginal: (...args: unknown[]) => Promise<unknown>,
) => Promise<unknown>;

const require = createRequire(import.meta.url);
const fsPromises = require('node:fs/promises') as FsPromises;
const runtimeModulePath = fileURLToPath(new URL('../../vscode/runtime/runtime-generations.cjs', import.meta.url));
const runtime = require(runtimeModulePath) as RuntimeApi;
const IDENTITY = { publisher: 'pie', name: 'pie', version: '0.3.0' };
const BUILD_ID = '0123456789abcdef0123';
const COPY_CONCURRENCY = 8;

async function withTempRoot<T>(callback: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pie-runtime-copy-'));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withPatchedFsMethod<T>(
  method: 'lstat' | 'copyFile',
  replacement: LstatReplacement | CopyFileReplacement,
  callback: () => Promise<T>,
): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(fsPromises, method);
  assert.ok(descriptor);
  const original = fsPromises[method] as (...args: unknown[]) => Promise<unknown>;
  Object.defineProperty(fsPromises, method, {
    ...descriptor,
    value: (...args: unknown[]) => replacement(
      args,
      (...originalArgs: unknown[]) => Reflect.apply(original, fsPromises, originalArgs) as Promise<unknown>,
    ),
  });
  try {
    return await callback();
  } finally {
    Object.defineProperty(fsPromises, method, descriptor);
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function createRuntimeSource(root: string, extraFiles: number): Promise<{
  source: string;
  contents: Map<string, Buffer>;
}> {
  const source = path.join(root, 'source');
  const contents = new Map<string, Buffer>([
    ['extension.js', Buffer.from('module.exports = {};')],
    ['backend.js', Buffer.from('backend')],
    ['worker-entry.js', Buffer.from('worker')],
    ['pie-build-id.txt', Buffer.from(`${BUILD_ID}\n`)],
    ['webview/panel/pie-build-id.txt', Buffer.from(`${BUILD_ID}\n`)],
    ['webview/panel/.vite/manifest.json', Buffer.from(JSON.stringify({
      'panel.tsx': { file: 'assets/panel.js', isEntry: true },
    }))],
    ['webview/panel/assets/panel.js', Buffer.from('export const panel = true;')],
  ]);
  for (let index = 0; index < extraFiles; index += 1) {
    const bytes = Buffer.alloc(4_096 + index, index % 251);
    randomBytes(16).copy(bytes, 0);
    contents.set(`webview/panel/assets/chunks/chunk-${String(index).padStart(3, '0')}.bin`, bytes);
  }

  for (const [relativePath, bytes] of contents) {
    const filePath = path.join(source, ...relativePath.split('/'));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, bytes);
  }
  return { source, contents };
}

function expectedGeneration(contents: Map<string, Buffer>): string {
  const generation = createHash('sha256');
  const records = [...contents.entries()].map(([filePath, bytes]) => ({
    path: filePath,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  })).sort((left, right) => left.path.localeCompare(right.path));
  for (const record of records) {
    generation.update(record.path, 'utf8');
    generation.update('\0', 'utf8');
    generation.update(String(record.size), 'utf8');
    generation.update('\0', 'utf8');
    generation.update(record.sha256, 'utf8');
    generation.update('\0', 'utf8');
  }
  return generation.digest('hex');
}

async function assertNoStagingDirectories(extensionDir: string): Promise<void> {
  const generationsDir = path.join(extensionDir, 'pie-runtime', 'generations');
  const entries = await readdir(generationsDir);
  assert.deepEqual(entries.filter((entry) => entry.startsWith('.staging-')), []);
}

test('copies runtime files with bounded metadata and copy concurrency, preserving exact bytes without hardlinks', async () => withTempRoot(async (root) => {
  const { source, contents } = await createRuntimeSource(root, 24);
  const extensionDir = path.join(root, 'extension');
  const metadataCounts = new Map<string, number>();
  let activeMetadata = 0;
  let maximumMetadata = 0;
  let activeCopies = 0;
  let maximumCopies = 0;

  const published = await withPatchedFsMethod('lstat', async (args, lstatOriginal) => {
    const filePath = path.resolve(String(args[0]));
    if (filePath.startsWith(`${source}${path.sep}`) && filePath.includes(`${path.sep}chunks${path.sep}`)) {
      const count = (metadataCounts.get(filePath) ?? 0) + 1;
      metadataCounts.set(filePath, count);
      // The first lstat is the source snapshot; the second is copyTree's metadata pass.
      if (count > 1) {
        activeMetadata += 1;
        maximumMetadata = Math.max(maximumMetadata, activeMetadata);
        try {
          await delay(10);
          return await lstatOriginal(...args);
        } finally {
          activeMetadata -= 1;
        }
      }
    }
    return lstatOriginal(...args);
  }, () => withPatchedFsMethod('copyFile', async (args, copyFileOriginal) => {
    activeCopies += 1;
    maximumCopies = Math.max(maximumCopies, activeCopies);
    try {
      await delay(20);
      return await copyFileOriginal(...args);
    } finally {
      activeCopies -= 1;
    }
  }, async () => runtime.publishRuntimeGeneration({ sourceOutDir: source, extensionDir, identity: IDENTITY })));

  assert.equal(published.generation, expectedGeneration(contents));
  assert.ok(maximumMetadata > 1, 'copy metadata checks overlap');
  assert.ok(maximumMetadata <= COPY_CONCURRENCY, 'copy metadata checks stay within the fixed worker limit');
  assert.ok(maximumCopies > 1, 'file copies overlap');
  assert.ok(maximumCopies <= COPY_CONCURRENCY, 'active file copies stay within the fixed worker limit');
  assert.equal(activeMetadata, 0);
  assert.equal(activeCopies, 0);

  for (const [relativePath, expectedBytes] of contents) {
    const sourceFile = path.join(source, ...relativePath.split('/'));
    const copiedFile = path.join(published.outDir, ...relativePath.split('/'));
    assert.deepEqual(await readFile(copiedFile), expectedBytes, `${relativePath} keeps its exact bytes`);
    const [sourceInfo, copiedInfo] = await Promise.all([stat(sourceFile), stat(copiedFile)]);
    assert.ok(sourceInfo.dev !== copiedInfo.dev || sourceInfo.ino !== copiedInfo.ino, `${relativePath} is not hardlinked`);
  }
}));

test('emits one bounded publish phase record only when PIE_BUILD_TIMING is enabled', async () => withTempRoot(async (root) => {
  const { source } = await createRuntimeSource(root, 2);
  const previousSetting = process.env.PIE_BUILD_TIMING;
  const originalLog = console.log;
  const logs: string[] = [];
  process.env.PIE_BUILD_TIMING = '1';
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  try {
    await runtime.publishRuntimeGeneration({
      sourceOutDir: source,
      extensionDir: path.join(root, 'extension'),
      identity: IDENTITY,
    });
  } finally {
    console.log = originalLog;
    if (previousSetting === undefined) delete process.env.PIE_BUILD_TIMING;
    else process.env.PIE_BUILD_TIMING = previousSetting;
  }

  assert.equal(logs.length, 1);
  assert.ok(logs[0]?.startsWith('[pie-build-timing] '));
  const record = JSON.parse(logs[0]!.slice('[pie-build-timing] '.length)) as {
    event: string;
    phasesMs: Record<string, unknown>;
  };
  assert.equal(record.event, 'runtime-generation-publish');
  assert.deepEqual(Object.keys(record.phasesMs), [
    'snapshot', 'copy', 'stagedScan', 'stagedVerify', 'previousSelections', 'cleanup',
  ]);
  for (const value of Object.values(record.phasesMs)) assert.equal(typeof value, 'number');
  assert.ok(logs[0]!.length < 1_000, 'the diagnostic line is fixed-size and bounded');
}));

test('waits for all in-flight copies before rejecting and cleaning the staging directory', async () => withTempRoot(async (root) => {
  const { source } = await createRuntimeSource(root, 16);
  const extensionDir = path.join(root, 'extension');
  let active = 0;
  let maximumActive = 0;
  let started = 0;
  let startedAtFailure = 0;
  let activeAtFailure = 0;
  let completed = 0;

  await withPatchedFsMethod('copyFile', async (args, copyFileOriginal) => {
    const sourceFile = String(args[0]);
    active += 1;
    started += 1;
    maximumActive = Math.max(maximumActive, active);
    try {
      if (path.basename(sourceFile) === 'chunk-000.bin') {
        await delay(5);
        startedAtFailure = started;
        activeAtFailure = active;
        throw new Error('injected copy failure');
      }
      await delay(75);
      return await copyFileOriginal(...args);
    } finally {
      active -= 1;
      completed += 1;
    }
  }, async () => {
    await assert.rejects(
      runtime.publishRuntimeGeneration({ sourceOutDir: source, extensionDir, identity: IDENTITY }),
      /injected copy failure/u,
    );
    assert.equal(active, 0, 'publication rejects only after all started copies settle');
    assert.equal(completed, started);
    assert.ok(maximumActive <= COPY_CONCURRENCY, 'active file copies stay within the fixed worker limit');
    assert.ok(activeAtFailure > 1, 'the injected failure overlaps other in-flight copies');
    assert.equal(started, startedAtFailure, 'failed copy stops additional files from starting');
    await assertNoStagingDirectories(extensionDir);
  });
}));

test('rejects symlink and non-regular source metadata before leaving a staged generation', async () => withTempRoot(async (root) => {
  for (const kind of ['symlink', 'unsupported'] as const) {
    const fixtureRoot = path.join(root, kind);
    const { source } = await createRuntimeSource(fixtureRoot, 0);
    const probePath = path.join(source, 'copy-probe.bin');
    await writeFile(probePath, 'probe');
    const extensionDir = path.join(fixtureRoot, 'extension');
    let probeLstats = 0;

    await withPatchedFsMethod('lstat', async (args, lstatOriginal) => {
      const info = await lstatOriginal(...args) as {
        isDirectory(): boolean;
        isFile(): boolean;
        isSymbolicLink(): boolean;
      };
      if (path.resolve(String(args[0])) !== probePath) return info;
      probeLstats += 1;
      // snapshotSource performs the first lstat; copyTree sees the second.
      if (probeLstats !== 2) return info;
      return new Proxy(info, {
        get(target, property, receiver) {
          if (property === 'isSymbolicLink') return () => kind === 'symlink';
          if (property === 'isDirectory' || property === 'isFile') return () => false;
          return Reflect.get(target, property, receiver);
        },
      });
    }, async () => {
      await assert.rejects(
        runtime.publishRuntimeGeneration({ sourceOutDir: source, extensionDir, identity: IDENTITY }),
        kind === 'symlink' ? /may not contain symlinks/u : /Unsupported runtime source entry/u,
      );
      assert.equal(probeLstats, 2);
      await assertNoStagingDirectories(extensionDir);
    });
  }
}));
