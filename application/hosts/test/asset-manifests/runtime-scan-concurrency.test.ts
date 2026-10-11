import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileHandle } from 'node:fs/promises';
import test from 'node:test';

type PublishedGeneration = { generation: string; outDir: string };
type RuntimeApi = {
  acquireRuntimeGeneration(options: {
    extensionDir: string;
    identity: { publisher: string; name: string; version: string };
  }): Promise<{ generation: string | null; release(): Promise<void> }>;
  publishRuntimeGeneration(options: {
    sourceOutDir: string;
    extensionDir: string;
    identity: { publisher: string; name: string; version: string };
  }): Promise<PublishedGeneration>;
};

type OpenReplacement = (
  args: unknown[],
  openOriginal: (...args: unknown[]) => Promise<FileHandle>,
) => Promise<FileHandle>;
type LstatReplacement = (
  args: unknown[],
  lstatOriginal: (...args: unknown[]) => Promise<unknown>,
) => Promise<unknown>;

const require = createRequire(import.meta.url);
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

async function withOpen<T>(replacement: OpenReplacement, callback: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(fsPromises, 'open');
  assert.ok(descriptor);
  const original = fsPromises.open;
  Object.defineProperty(fsPromises, 'open', {
    ...descriptor,
    value: (...args: unknown[]) => replacement(
      args,
      (...originalArgs: unknown[]) => Reflect.apply(original, fsPromises, originalArgs),
    ),
  });
  try {
    return await callback();
  } finally {
    Object.defineProperty(fsPromises, 'open', descriptor);
  }
}

function wrapHandle(handle: FileHandle, hooks: {
  read?: (args: unknown[], original: () => Promise<{ bytesRead: number; buffer: unknown }>) => Promise<unknown>;
  close?: (original: () => Promise<void>) => Promise<void>;
}): FileHandle {
  return new Proxy(handle, {
    get(target, property) {
      if (property === 'read' && hooks.read) {
        return (...args: unknown[]) => hooks.read!(args, () => Reflect.apply(target.read, target, args));
      }
      if (property === 'close' && hooks.close) return () => hooks.close!(() => target.close());
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
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

test('hashes files concurrently with bounded reads and preserves the full generation hash', async () => withTempRoot(async (root) => {
  const { source, contents } = await createValidRuntimeSource(root, 24);
  const extensionDir = path.join(root, 'extension');
  let active = 0;
  let maximumActive = 0;
  const readSizes: number[] = [];

  await withOpen(async (args, openOriginal) => {
    const handle = await openOriginal(...args);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    return wrapHandle(handle, {
      read: async (readArgs, original) => {
        readSizes.push((readArgs[0] as Buffer).length);
        return original();
      },
      close: async (original) => { await original(); active -= 1; },
    });
  }, async () => {
    const published = await runtime.publishRuntimeGeneration({ sourceOutDir: source, extensionDir, identity: IDENTITY });
    assert.equal(published.generation, expectedGeneration(contents));
    const lease = await runtime.acquireRuntimeGeneration({ extensionDir, identity: IDENTITY });
    assert.equal(lease.generation, expectedGeneration(contents), 'profiled acquisition preserves every digest');
    await lease.release();
  });

  assert.equal(active, 0, 'all hash handles have closed when publication resolves');
  assert.ok(maximumActive > 1, 'file hashes should overlap');
  assert.ok(maximumActive <= FILE_SCAN_CONCURRENCY, 'active file hashes stay within the fixed worker limit');
  assert.ok(readSizes.length > 0);
  assert.ok(readSizes.every((size) => size === HASH_FILE_READ_CHUNK_BYTES), 'each hash read uses the bounded chunk size');
}));

test('one acquisition scan reuses at most eight buffers until each owning handle finishes closing', async () => withTempRoot(async (root) => {
  const { source, contents } = await createValidRuntimeSource(root, 0);
  for (let index = 0; index < 40; index += 1) {
    const size = index === 0 ? 0 : index === 1 ? HASH_FILE_READ_CHUNK_BYTES
      : index === 2 ? HASH_FILE_READ_CHUNK_BYTES + 1
        : index % 5 === 0 ? index : HASH_FILE_READ_CHUNK_BYTES * 2 + index;
    const relative = `payload-${String(index).padStart(3, '0')}.bin`;
    const value = String.fromCharCode(33 + index).repeat(size);
    contents.set(relative, value);
    await writeFile(path.join(source, relative), value);
  }
  const extensionDir = path.join(root, 'extension');
  const published = await runtime.publishRuntimeGeneration({ sourceOutDir: source, extensionDir, identity: IDENTITY });
  const descriptor = Object.getOwnPropertyDescriptor(Buffer, 'allocUnsafeSlow');
  assert.ok(descriptor);
  const originalAllocate = Buffer.allocUnsafeSlow;
  let allocations = 0;
  let scanning = false;
  let opens = 0;
  let closes = 0;
  let reads = 0;
  let closeWaiters = 0;
  let releaseClose!: () => void;
  const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
  let markEightClosing!: () => void;
  const eightClosing = new Promise<void>((resolve) => { markEightClosing = resolve; });
  const buffers = new Set<Buffer>();
  const owners = new Map<Buffer, FileHandle>();
  const handleBuffers = new Map<FileHandle, Buffer>();
  let lease: Awaited<ReturnType<RuntimeApi['acquireRuntimeGeneration']>> | undefined;
  try {
    Object.defineProperty(Buffer, 'allocUnsafeSlow', {
      ...descriptor,
      value: (size: number) => {
        // Count the single payload scan, excluding manifest/selection readFile allocations.
        if (scanning) {
          assert.equal(size, HASH_FILE_READ_CHUNK_BYTES);
          allocations += 1;
        }
        return originalAllocate(size);
      },
    });
    await withLstat(async (args, original) => {
      if (String(args[0]) === published.outDir) scanning = true;
      return original(...args);
    }, async () => withOpen(async (args, openOriginal) => {
      const handle = await openOriginal(...args);
      assert.ok(isWithinDirectory(published.outDir, String(args[0])), 'only the selected generation is scanned');
      opens += 1;
      return wrapHandle(handle, {
        read: async (readArgs, original) => {
          const buffer = readArgs[0] as Buffer;
          assert.ok(Buffer.isBuffer(buffer));
          assert.equal(buffer.length, HASH_FILE_READ_CHUNK_BYTES);
          const owner = owners.get(buffer);
          assert.ok(!owner || owner === handle, 'a buffer cannot be reused before its prior close completes');
          const previous = handleBuffers.get(handle);
          if (previous) assert.equal(buffer, previous, 'all reads of a handle reuse its original buffer');
          handleBuffers.set(handle, buffer);
          owners.set(buffer, handle);
          buffers.add(buffer);
          reads += 1;
          assert.ok(buffers.size <= FILE_SCAN_CONCURRENCY, 'every read uses the fixed scan buffer pool');
          return original();
        },
        close: async (original) => {
          await original(); // Real fd is closed, but the awaited wrapper is still pending.
          closeWaiters += 1;
          if (closeWaiters === FILE_SCAN_CONCURRENCY) markEightClosing();
          await closeGate;
          const buffer = handleBuffers.get(handle)!;
          assert.equal(owners.get(buffer), handle, 'buffer ownership survives delayed close completion');
          owners.delete(buffer);
          closes += 1;
          if (closes === contents.size) scanning = false;
        },
      });
    }, async () => {
      const acquisition = runtime.acquireRuntimeGeneration({ extensionDir, identity: IDENTITY });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          eightClosing,
          acquisition.then(() => { throw new Error('acquisition resolved before delayed closes were drained'); }),
          new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('close gate did not fill')), 5000); }),
        ]);
        assert.equal(opens, FILE_SCAN_CONCURRENCY, 'pending closes retain all scan slots');
        assert.equal(allocations, FILE_SCAN_CONCURRENCY, 'the gated first wave allocates exactly eight scan buffers');
        assert.equal(closes, 0);
      } finally {
        if (timeout) clearTimeout(timeout);
        releaseClose();
        lease = await acquisition;
      }
      assert.equal(lease.generation, expectedGeneration(contents), 'all full chunks, tails, empty and small records match independent SHA-256');
      assert.equal(opens, contents.size, 'exactly one scan of the selected payload');
      assert.equal(closes, opens);
      assert.equal(owners.size, 0);
      assert.ok(reads > contents.size);
      assert.ok(allocations > 0 && allocations <= FILE_SCAN_CONCURRENCY, `scan allocated ${allocations} payload buffers`);
      assert.equal(buffers.size, allocations, 'all scan allocations are observed at the public read seam');
    }));
  } finally {
    releaseClose();
    Object.defineProperty(Buffer, 'allocUnsafeSlow', descriptor);
    await lease?.release();
  }
}));

for (const mutation of ['bad-sha-tail', 'missing-tail'] as const) {
  test(`acquisition rejects a multi-chunk payload with ${mutation}`, async () => withTempRoot(async (root) => {
    const { source } = await createValidRuntimeSource(root, 0);
    const prefix = 'p'.repeat(HASH_FILE_READ_CHUNK_BYTES);
    await writeFile(path.join(source, 'tail.bin'), `${prefix}x`);
    const extensionDir = path.join(root, 'extension');
    const published = await runtime.publishRuntimeGeneration({ sourceOutDir: source, extensionDir, identity: IDENTITY });
    await writeFile(path.join(published.outDir, 'tail.bin'), mutation === 'bad-sha-tail' ? `${prefix}y` : prefix);
    const lease = await runtime.acquireRuntimeGeneration({ extensionDir, identity: IDENTITY });
    try {
      assert.equal(lease.generation, null, 'verification must compare the true EOF size and SHA-256, including the tail');
    } finally {
      await lease.release();
    }
  }));
}

test('hashes short reads through true EOF using actual bytes when a file grows after lstat', async () => withTempRoot(async (root) => {
  const { source, contents } = await createValidRuntimeSource(root, 0);
  const relative = 'growing.bin';
  const filePath = path.join(source, relative);
  const initial = 'a'.repeat(HASH_FILE_READ_CHUNK_BYTES);
  const grown = `${initial}tail-after-metadata`;
  contents.set(relative, grown);
  await writeFile(filePath, initial);
  let appended = false;
  let zeroReads = 0;
  let reads = 0;
  await withLstat(async (args, original) => {
    const info = await original(...args);
    if (String(args[0]) === filePath && !appended) {
      appended = true;
      await writeFile(filePath, grown);
    }
    return info;
  }, async () => withOpen(async (args, original) => {
    const handle = await original(...args);
    return wrapHandle(handle, {
      read: async (readArgs) => {
        const boundedArgs = [...readArgs];
        boundedArgs[2] = Math.min(Number(readArgs[2]), 997);
        const result = await Reflect.apply(handle.read, handle, boundedArgs);
        if (String(args[0]) === filePath) {
          reads += 1;
          if (result.bytesRead === 0) zeroReads += 1;
        }
        return result;
      },
    });
  }, async () => {
    const published = await runtime.publishRuntimeGeneration({ sourceOutDir: source, extensionDir: path.join(root, 'extension'), identity: IDENTITY });
    assert.equal(published.generation, expectedGeneration(contents));
  }));
  assert.ok(appended);
  assert.ok(reads > HASH_FILE_READ_CHUNK_BYTES / 997);
  assert.ok(zeroReads > 0, 'short reads are not mistaken for EOF');
}));

test('a failed scan stops admission and waits for every delayed close before returning its error', async () => withTempRoot(async (root) => {
  const source = path.join(root, 'source');
  await mkdir(source);
  for (let index = 0; index < 24; index += 1) await writeFile(path.join(source, `${index}.bin`), 'payload');
  const primary = new Error('deterministic read failure');
  let opened = 0;
  let closed = 0;
  let closing = 0;
  let settled = false;
  let releaseReads!: () => void;
  const readGate = new Promise<void>((resolve) => { releaseReads = resolve; });
  let releaseCloses!: () => void;
  const closeGate = new Promise<void>((resolve) => { releaseCloses = resolve; });
  let markClosing!: () => void;
  const allClosing = new Promise<void>((resolve) => { markClosing = resolve; });
  await withOpen(async (args, original) => {
    const handle = await original(...args);
    const shouldFail = opened === 0;
    opened += 1;
    if (opened === FILE_SCAN_CONCURRENCY) releaseReads();
    return wrapHandle(handle, {
      read: async (_args, readOriginal) => {
        await readGate;
        if (shouldFail) throw primary;
        return readOriginal();
      },
      close: async (closeOriginal) => {
        await closeOriginal();
        closing += 1;
        if (closing === FILE_SCAN_CONCURRENCY) markClosing();
        if (!shouldFail) await closeGate;
        closed += 1;
      },
    });
  }, async () => {
    const outcome = runtime.publishRuntimeGeneration({ sourceOutDir: source, extensionDir: path.join(root, 'extension'), identity: IDENTITY })
      .then(() => { settled = true; return undefined; }, (error: unknown) => { settled = true; return error; });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        allClosing,
        outcome.then(() => { throw new Error('scan settled before all closes started'); }),
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('drain gate did not fill')), 5000); }),
      ]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false, 'rejection cannot escape pending close promises');
      assert.equal(opened, FILE_SCAN_CONCURRENCY, 'failure prevents queued files from being opened');
      assert.equal(closed, 1);
    } finally {
      if (timeout) clearTimeout(timeout);
      releaseReads();
      releaseCloses();
      assert.equal(await outcome, primary);
    }
    assert.equal(closed, opened);
    assert.equal(opened, FILE_SCAN_CONCURRENCY);
  });
}));

for (const fault of ['open', 'read', 'close', 'read-and-close'] as const) {
  test(`preserves the primary ${fault} failure and closes real descriptors`, async () => withTempRoot(async (root) => {
    const source = path.join(root, 'source');
    await mkdir(source);
    await writeFile(path.join(source, 'payload.bin'), 'payload');
    const primary = new Error(`injected ${fault} failure`);
    const secondary = new Error('secondary close failure');
    let opened = 0;
    let closed = 0;
    await withOpen(async (args, original) => {
      if (fault === 'open') throw primary;
      const handle = await original(...args);
      opened += 1;
      return wrapHandle(handle, {
        read: async (_args, readOriginal) => {
          if (fault === 'read' || fault === 'read-and-close') throw primary;
          return readOriginal();
        },
        close: async (closeOriginal) => {
          await closeOriginal();
          closed += 1;
          if (fault === 'close') throw primary;
          if (fault === 'read-and-close') throw secondary;
        },
      });
    }, async () => {
      await assert.rejects(runtime.publishRuntimeGeneration({ sourceOutDir: source, extensionDir: path.join(root, 'extension'), identity: IDENTITY }), (error) => error === primary);
      assert.equal(closed, opened, 'failure is reported only after real descriptor cleanup');
    });
  }));
}

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
  }, async () => withOpen(async (args, openOriginal) => {
    const handle = await openOriginal(...args);
    const filePath = path.resolve(String(args[0]));
    if (!isWithinDirectory(source, filePath)) return handle;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    return wrapHandle(handle, {
      close: async (original) => {
        await original();
        active -= 1;
        if (filePath === readyPath && !gateReleased) markReadyHashed();
      },
    });
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
  await withOpen(async (args, openOriginal) => {
    const handle = await openOriginal(...args);
    const shouldFail = path.basename(String(args[0])).startsWith('000-fail');
    started += 1;
    active += 1;
    return wrapHandle(handle, {
      read: async (_args, original) => {
        await new Promise((resolve) => setTimeout(resolve, shouldFail ? 5 : 75));
        if (shouldFail) throw new Error('injected hash failure');
        return original();
      },
      close: async (original) => { await original(); active -= 1; closed += 1; },
    });
  }, async () => {
    await assert.rejects(
      runtime.publishRuntimeGeneration({
        sourceOutDir: source,
        extensionDir: path.join(root, 'extension'),
        identity: IDENTITY,
      }),
      /injected hash failure/u,
    );
    assert.equal(active, 0, 'rejection waits until all started handles are closed');
    assert.equal(closed, started);
    assert.equal(started, FILE_SCAN_CONCURRENCY, 'failure stops the pool from starting queued files');
  });
}));

test('acquisition scan profiling counts failed hashes after draining all admitted handles', async () => withTempRoot(async (root) => {
  const { source } = await createValidRuntimeSource(root, 24);
  const extensionDir = path.join(root, 'extension');
  const published = await runtime.publishRuntimeGeneration({ sourceOutDir: source, extensionDir, identity: IDENTITY });
  const diagnosticFile = path.join(root, 'profile.jsonl');
  const previous = process.env.PIE_STARTUP_TIMING_FILE;
  process.env.PIE_STARTUP_TIMING_FILE = diagnosticFile;
  let started = 0;
  let closed = 0;
  let active = 0;
  let acquired: Awaited<ReturnType<RuntimeApi['acquireRuntimeGeneration']>> | undefined;
  try {
    await withOpen(async (args, openOriginal) => {
      const handle = await openOriginal(...args);
      if (!isWithinDirectory(published.outDir, String(args[0]))) return handle;
      const shouldFail = started === 0;
      started += 1;
      active += 1;
      return wrapHandle(handle, {
        read: async (_args, original) => {
          await new Promise((resolve) => setTimeout(resolve, shouldFail ? 5 : 75));
          if (shouldFail) throw new Error('profiled hash failure');
          return original();
        },
        close: async (original) => { await original(); active -= 1; closed += 1; },
      });
    }, async () => {
      const lease = await runtime.acquireRuntimeGeneration({ extensionDir, identity: IDENTITY });
      acquired = lease;
      assert.equal(lease.generation, null, 'failed verification still uses packaged fallback');
      assert.equal(active, 0, 'profiling does not shorten failure draining');
      assert.equal(closed, started);
      assert.ok(started > 1 && started <= FILE_SCAN_CONCURRENCY);
    });
    let rows: Array<Record<string, unknown>> = [];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        rows = (await readFile(diagnosticFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        if (rows.length) break;
      } catch { /* Best-effort output is queued asynchronously. */ }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(rows.length, 1);
    const verification = (rows[0]!.verification as Array<Record<string, unknown>>)[0]!;
    assert.equal(verification.failures, 1);
    const profile = verification.scanProfile as { hash: { count: number; observedTotalMs: number; observedMaxMs: number } };
    assert.equal(profile.hash.count, started, 'includes failed and drained hash attempts');
    assert.ok(profile.hash.observedTotalMs >= profile.hash.observedMaxMs);
    assert.ok(profile.hash.observedMaxMs >= 50, 'captures the slow drained hash rather than stopping at the first failure');
  } finally {
    await acquired?.release();
    if (previous === undefined) delete process.env.PIE_STARTUP_TIMING_FILE;
    else process.env.PIE_STARTUP_TIMING_FILE = previous;
  }
}));
