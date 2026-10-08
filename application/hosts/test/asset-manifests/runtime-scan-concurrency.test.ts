import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import test from 'node:test';

type PublishedGeneration = { generation: string };
type RuntimeApi = {
  publishRuntimeGeneration(options: {
    sourceOutDir: string;
    extensionDir: string;
    identity: { publisher: string; name: string; version: string };
  }): Promise<PublishedGeneration>;
};

type CreateReadStreamReplacement = (
  args: unknown[],
  createOriginal: (...args: unknown[]) => unknown,
) => unknown;
type LstatReplacement = (
  args: unknown[],
  lstatOriginal: (...args: unknown[]) => Promise<unknown>,
) => Promise<unknown>;

const require = createRequire(import.meta.url);
const fsSync = require('node:fs') as typeof import('node:fs');
const fsPromises = require('node:fs/promises') as typeof import('node:fs/promises');
const runtimeModulePath = fileURLToPath(new URL('../../vscode/runtime/runtime-generations.cjs', import.meta.url));
const runtime = require(runtimeModulePath) as RuntimeApi;
const IDENTITY = { publisher: 'pie', name: 'pie', version: '0.3.0' };
const BUILD_ID = '0123456789abcdef0123';
const FILE_SCAN_CONCURRENCY = 8;
const HASH_FILE_READ_CHUNK_BYTES = 64 * 1024;

async function withTempRoot<T>(callback: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pie-runtime-scan-'));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withCreateReadStream<T>(
  replacement: CreateReadStreamReplacement,
  callback: () => Promise<T>,
): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(fsSync, 'createReadStream');
  assert.ok(descriptor);
  const original = fsSync.createReadStream;
  Object.defineProperty(fsSync, 'createReadStream', {
    ...descriptor,
    value: (...args: unknown[]) => replacement(
      args,
      (...originalArgs: unknown[]) => Reflect.apply(original, fsSync, originalArgs),
    ),
  });
  try {
    return await callback();
  } finally {
    Object.defineProperty(fsSync, 'createReadStream', descriptor);
  }
}

async function withLstat<T>(replacement: LstatReplacement, callback: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(fsPromises, 'lstat');
  assert.ok(descriptor);
  const original = fsPromises.lstat;
  Object.defineProperty(fsPromises, 'lstat', {
    ...descriptor,
    value: (...args: unknown[]) => replacement(
      args,
      (...originalArgs: unknown[]) => Reflect.apply(original, fsPromises, originalArgs),
    ),
  });
  try {
    return await callback();
  } finally {
    Object.defineProperty(fsPromises, 'lstat', descriptor);
  }
}

function isWithinDirectory(directory: string, filePath: string): boolean {
  const relative = path.relative(directory, filePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function createValidRuntimeSource(root: string, extraFiles: number): Promise<{
  source: string;
  contents: Map<string, string>;
}> {
  const source = path.join(root, 'source');
  const contents = new Map<string, string>([
    ['extension.js', 'module.exports = {};'],
    ['backend.js', 'backend'],
    ['worker-entry.js', 'worker'],
    ['pie-build-id.txt', `${BUILD_ID}\n`],
    ['webview/panel/pie-build-id.txt', `${BUILD_ID}\n`],
    ['webview/panel/.vite/manifest.json', JSON.stringify({
      'panel.tsx': { file: 'assets/panel.js', isEntry: true },
    })],
    ['webview/panel/assets/panel.js', 'export const panel = true;'],
  ]);
  for (let index = 0; index < extraFiles; index += 1) {
    contents.set(`webview/panel/assets/chunks/chunk-${String(index).padStart(3, '0')}.js`, `chunk-${index}`);
  }

  for (const [relativePath, value] of contents) {
    const filePath = path.join(source, ...relativePath.split('/'));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, value);
  }
  return { source, contents };
}

function expectedGeneration(contents: Map<string, string>): string {
  const generation = createHash('sha256');
  const records = [...contents.entries()].map(([filePath, value]) => {
    const bytes = Buffer.from(value, 'utf8');
    return {
      path: filePath,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }).sort((left, right) => left.path.localeCompare(right.path));

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

test('hashes files concurrently with bounded streaming and preserves the full generation hash', async () => withTempRoot(async (root) => {
  const { source, contents } = await createValidRuntimeSource(root, 24);
  const extensionDir = path.join(root, 'extension');
  let active = 0;
  let maximumActive = 0;
  const readSizes: number[] = [];

  await withCreateReadStream((args, createOriginal) => {
    const stream = createOriginal(...args) as ReturnType<typeof fsSync.createReadStream>;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    const options = args[1];
    if (options && typeof options === 'object' && 'highWaterMark' in options) {
      readSizes.push(Number(options.highWaterMark));
    }
    stream.once('close', () => { active -= 1; });
    return stream;
  }, async () => {
    const published = await runtime.publishRuntimeGeneration({ sourceOutDir: source, extensionDir, identity: IDENTITY });
    assert.equal(published.generation, expectedGeneration(contents));
  });

  assert.equal(active, 0, 'all hash streams have closed when publication resolves');
  assert.ok(maximumActive > 1, 'file hashes should overlap');
  assert.ok(maximumActive <= FILE_SCAN_CONCURRENCY, 'active file hashes stay within the fixed worker limit');
  assert.ok(readSizes.length > 0);
  assert.ok(readSizes.every((size) => size === HASH_FILE_READ_CHUNK_BYTES), 'each hash read uses the bounded chunk size');
}));

test('checks file metadata concurrently within the fixed scan limit', async () => withTempRoot(async (root) => {
  const { source, contents } = await createValidRuntimeSource(root, 24);
  let active = 0;
  let maximumActive = 0;

  await withLstat(async (args, lstatOriginal) => {
    const filePath = path.resolve(String(args[0]));
    if (!isWithinDirectory(source, filePath) || filePath === source) {
      return lstatOriginal(...args);
    }
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return await lstatOriginal(...args);
    } finally {
      active -= 1;
    }
  }, async () => {
    const published = await runtime.publishRuntimeGeneration({
      sourceOutDir: source,
      extensionDir: path.join(root, 'extension'),
      identity: IDENTITY,
    });
    assert.equal(published.generation, expectedGeneration(contents));
  });

  assert.ok(maximumActive > 1, 'metadata checks should overlap');
  assert.ok(maximumActive <= FILE_SCAN_CONCURRENCY, 'active metadata checks stay within the fixed scan limit');
}));

test('rolls across nested directories and hashes files while independent metadata is gated', async () => withTempRoot(async (root) => {
  const { source, contents } = await createValidRuntimeSource(root, 0);
  for (const relative of ['a-nested/blocked.bin', 'b-nested/ready.bin']) {
    contents.set(relative, relative);
    await mkdir(path.dirname(path.join(source, relative)), { recursive: true });
    await writeFile(path.join(source, relative), relative);
  }
  const blockedPath = path.join(source, 'a-nested', 'blocked.bin');
  const readyPath = path.join(source, 'b-nested', 'ready.bin');
  let releaseMetadata!: () => void;
  const metadataGate = new Promise<void>((resolve) => { releaseMetadata = resolve; });
  let markBlocked!: () => void;
  const blocked = new Promise<void>((resolve) => { markBlocked = resolve; });
  let markReadyHashed!: () => void;
  const readyHashed = new Promise<void>((resolve) => { markReadyHashed = resolve; });
  let gateReleased = false;
  let readyMetadataOverlapped = false;
  let active = 0;
  let maximumActive = 0;

  await withLstat(async (args, lstatOriginal) => {
    const filePath = path.resolve(String(args[0]));
    if (!isWithinDirectory(source, filePath) || filePath === source) return lstatOriginal(...args);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    try {
      if (filePath === blockedPath && !gateReleased) {
        markBlocked();
        await metadataGate;
      }
      if (filePath === readyPath && !gateReleased) {
        await blocked;
        readyMetadataOverlapped = !gateReleased;
      }
      return await lstatOriginal(...args);
    } finally {
      active -= 1;
    }
  }, async () => withCreateReadStream((args, createOriginal) => {
    const stream = createOriginal(...args) as ReturnType<typeof fsSync.createReadStream>;
    const filePath = path.resolve(String(args[0]));
    if (isWithinDirectory(source, filePath)) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      stream.once('close', () => {
        active -= 1;
        if (filePath === readyPath && !gateReleased) markReadyHashed();
      });
    }
    return stream;
  }, async () => {
    const publication = runtime.publishRuntimeGeneration({
      sourceOutDir: source,
      extensionDir: path.join(root, 'extension'),
      identity: IDENTITY,
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await blocked;
      const overlapped = await Promise.race([
        readyHashed.then(() => true),
        new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), 500); }),
      ]);
      assert.ok(readyMetadataOverlapped, 'independent nested directory metadata must proceed before the gate is released');
      assert.ok(overlapped, 'independent file hashing must finish before the metadata gate is released');
    } finally {
      if (timeout) clearTimeout(timeout);
      gateReleased = true;
      releaseMetadata();
      const published = await publication;
      assert.equal(published.generation, expectedGeneration(contents));
    }
  }));
  assert.equal(active, 0);
  assert.ok(maximumActive <= FILE_SCAN_CONCURRENCY, 'metadata and file hashes share one global limit');
}));

test('drains all started metadata checks before rejecting and does not schedule more after failure', async () => withTempRoot(async (root) => {
  const source = path.join(root, 'source');
  await mkdir(source, { recursive: true });
  for (let index = 0; index < 16; index += 1) {
    await writeFile(path.join(source, `${String(index).padStart(3, '0')}-${index === 0 ? 'fail' : 'pending'}.bin`), 'file');
  }

  let active = 0;
  let started = 0;
  let completed = 0;
  await withLstat(async (args, lstatOriginal) => {
    const filePath = path.resolve(String(args[0]));
    if (!isWithinDirectory(source, filePath) || filePath === source) {
      return lstatOriginal(...args);
    }
    started += 1;
    active += 1;
    try {
      if (path.basename(filePath).startsWith('000-fail')) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error('injected metadata failure');
      }
      await new Promise((resolve) => setTimeout(resolve, 75));
      return await lstatOriginal(...args);
    } finally {
      active -= 1;
      completed += 1;
    }
  }, async () => {
    await assert.rejects(
      runtime.publishRuntimeGeneration({
        sourceOutDir: source,
        extensionDir: path.join(root, 'extension'),
        identity: IDENTITY,
      }),
      /injected metadata failure/u,
    );
    assert.equal(active, 0, 'rejection waits until all started metadata checks finish');
    assert.equal(completed, started);
    assert.equal(started, FILE_SCAN_CONCURRENCY, 'failure stops the pool from checking queued entries');
  });
}));

test('drains all started file hashes before rejecting and does not schedule more after failure', async () => withTempRoot(async (root) => {
  const source = path.join(root, 'source');
  await mkdir(source, { recursive: true });
  for (let index = 0; index < 16; index += 1) {
    await writeFile(path.join(source, `${String(index).padStart(3, '0')}-${index === 0 ? 'fail' : 'pending'}.bin`), 'file');
  }

  let active = 0;
  let started = 0;
  let closed = 0;
  await withCreateReadStream((args) => {
    const filePath = String(args[0]);
    const shouldFail = path.basename(filePath).startsWith('000-fail');
    let scheduled = false;
    let stream!: Readable;
    stream = new Readable({
      read() {
        if (scheduled) return;
        scheduled = true;
        setTimeout(() => {
          if (shouldFail) stream.destroy(new Error('injected hash failure'));
          else {
            stream.push(Buffer.from('hashed'));
            stream.push(null);
          }
        }, shouldFail ? 5 : 75);
      },
    });
    started += 1;
    active += 1;
    stream.once('close', () => {
      active -= 1;
      closed += 1;
    });
    return stream;
  }, async () => {
    await assert.rejects(
      runtime.publishRuntimeGeneration({
        sourceOutDir: source,
        extensionDir: path.join(root, 'extension'),
        identity: IDENTITY,
      }),
      /injected hash failure/u,
    );
    assert.equal(active, 0, 'rejection waits until all started streams are closed');
    assert.equal(closed, started);
    assert.equal(started, FILE_SCAN_CONCURRENCY, 'failure stops the pool from starting queued files');
  });
}));
