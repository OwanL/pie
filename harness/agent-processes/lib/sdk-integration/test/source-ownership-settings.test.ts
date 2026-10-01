import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isBuiltin, registerHooks, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { before } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { SessionManager as SessionManagerInstance } from '@earendil-works/pi-coding-agent';

// Import the private candidate distribution directly; no installed SDK or
// patch-barrier path is involved in source ownership tests.
import { sourceFixture } from './source-fixture.js';
const { piRoot, packageRoots } = sourceFixture;
const codingAgentEntry = path.join(packageRoots.codingAgent, 'dist/core/session-manager.js');
const approvedPackages: Readonly<Record<string, string>> = {
  '@earendil-works/pi-ai': packageRoots.ai,
  '@earendil-works/pi-agent-core': packageRoots.agent,
  '@earendil-works/pi-tui': packageRoots.tui,
  '@earendil-works/pi-coding-agent': packageRoots.codingAgent,
};
const isWithin = (file: string, root: string): boolean => file.startsWith(`${root}${path.sep}`);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (isBuiltin(specifier)) return result;

    assert.ok(result.url.startsWith('file:'), `Unexpected non-file runtime dependency: ${specifier} -> ${result.url}`);
    const resolved = fs.realpathSync(fileURLToPath(result.url));
    if (specifier.startsWith('@earendil-works/')) {
      const packageName = Object.keys(approvedPackages).find((name) => (
        specifier === name || specifier.startsWith(`${name}/`)
      ));
      const expectedRoot = packageName ? approvedPackages[packageName] : undefined;
      assert.ok(expectedRoot, `Unapproved private SDK package import: ${specifier}`);
      assert.ok(isWithin(resolved, expectedRoot), `Private SDK package graph escape for ${specifier}: ${resolved}`);
      return result;
    }

    assert.ok(isWithin(resolved, fs.realpathSync(piRoot)), `Private SDK runtime graph escape for ${specifier}: ${resolved}`);
    return result;
  },
});

let SessionManager: typeof import('@earendil-works/pi-coding-agent').SessionManager;
before(async () => {
  ({ SessionManager } = await import(pathToFileURL(codingAgentEntry).href));
});

type FsOverride = 'openSync' | 'renameSync' | 'writeFileSync' | 'fsyncSync';

function withFsOverrides<T>(overrides: Partial<Record<FsOverride, unknown>>, run: () => T): T {
  const mutableFs = fs as unknown as Record<string, unknown>;
  const originals = new Map<string, unknown>();
  for (const [name, replacement] of Object.entries(overrides)) {
    originals.set(name, mutableFs[name]);
    mutableFs[name] = replacement;
  }
  syncBuiltinESMExports();
  try {
    return run();
  } finally {
    for (const [name, original] of originals) mutableFs[name] = original;
    syncBuiltinESMExports();
  }
}

function withAtomicsWait<T>(wait: typeof Atomics.wait, run: () => T): T {
  const mutableAtomics = Atomics as unknown as Record<string, unknown>;
  const original = mutableAtomics.wait;
  mutableAtomics.wait = wait;
  try {
    return run();
  } finally {
    mutableAtomics.wait = original;
  }
}

function tempRoot(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-source-ownership-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function sessionHeader(cwd: string) {
  return {
    type: 'session',
    version: 3,
    id: 'settings-fixture',
    timestamp: '2026-08-25T00:00:00.000Z',
    cwd,
  };
}

function userEntry() {
  return {
    type: 'message',
    id: 'user-1',
    parentId: null,
    timestamp: '2026-08-25T00:00:01.000Z',
    message: { role: 'user', content: 'hello', timestamp: 1 },
  };
}

function attachLease(manager: SessionManagerInstance, sessionPath: string): void {
  const lease = {
    coordinatorGeneration: 1,
    workerId: 'worker-settings',
    workerGeneration: 1,
    canonicalSessionPath: path.resolve(sessionPath),
    ownershipRevision: 1,
    nonce: 'settings-lease',
  };
  manager.attachPieWriteLease({
    async reserveReplacement() { throw new Error('unused settings fixture reservation'); },
    async abortPrecommit() {},
    async commitTransfer() { throw new Error('unused settings fixture commit'); },
    async consumeTransferAuthorization() { throw new Error('unused settings fixture consumption'); },
    async runtimeReady() {},
    async failClosed(error: unknown): Promise<never> { throw error; },
    assertWriteLease(current: typeof lease, canonicalPath: string): void {
      assert.equal(current, lease);
      assert.equal(path.resolve(canonicalPath), path.resolve(sessionPath));
    },
  }, lease);
}

function errno(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

test('model-settings replacement frames against the temporary image and retries only the bounded transient window', { concurrency: false }, (t) => {
  const root = tempRoot(t);
  const sessionPath = path.join(root, 'settings.jsonl');
  const originalRows = [sessionHeader(root), userEntry()];
  const originalBytes = `${originalRows.map((row) => JSON.stringify(row)).join('\n')}\n`;
  const replacementBytes = originalBytes.slice(0, -1);
  fs.writeFileSync(sessionPath, originalBytes, 'utf8'); // The copied image has a final newline.
  const manager = SessionManager.open(sessionPath);
  attachLease(manager, sessionPath);
  const previousEntries = manager.getEntries();
  const previousLeaf = manager.getLeafId();
  const originalRename = fs.renameSync;
  const originalOpenSync = fs.openSync;
  const retryDelays = [10, 25, 50, 100, 250, 500, 1000, 2000, 4000];
  const observedDelays: number[] = [];
  let renameAttempts = 0;
  let sourceReplacedAfterCopy = false;
  const replaceSourceAfterCopy = ((...args: Parameters<typeof fs.openSync>) => {
    const fd = Reflect.apply(originalOpenSync, fs, args) as number;
    if (!sourceReplacedAfterCopy && args[1] === 'a' && String(args[0]).startsWith(`${sessionPath}.pie-model-settings-`)) {
      fs.writeFileSync(sessionPath, replacementBytes, 'utf8');
      sourceReplacedAfterCopy = true;
    }
    return fd;
  }) as typeof fs.openSync;
  const transientRename = ((...args: Parameters<typeof fs.renameSync>) => {
    renameAttempts++;
    assert.deepEqual(manager.getEntries(), previousEntries, 'manager state stays staged until rename commits');
    assert.equal(sourceReplacedAfterCopy, true, 'source was replaced only after the copy was complete');
    assert.equal(fs.readFileSync(sessionPath, 'utf8'), replacementBytes, 'concurrent source replacement remains visible until commit');
    const temporaryImage = fs.readFileSync(String(args[0]), 'utf8');
    assert.ok(temporaryImage.startsWith(originalBytes), 'framing is based on the copied image with its newline');
    assert.ok(!temporaryImage.slice(originalBytes.length).startsWith('\n'), 'copied final newline needs no added separator');
    if (renameAttempts <= retryDelays.length) {
      throw errno(['EACCES', 'EBUSY', 'EPERM'][((renameAttempts - 1) % 3)]!, 'simulated sharing violation');
    }
    return Reflect.apply(originalRename, fs, args);
  }) as typeof fs.renameSync;
  const wait = ((_array: Int32Array, _index: number, _value: number, timeout?: number) => {
    if (timeout !== undefined) observedDelays.push(timeout);
    return 'timed-out';
  }) as typeof Atomics.wait;

  const changes = withFsOverrides({ openSync: replaceSourceAfterCopy, renameSync: transientRename }, () =>
    withAtomicsWait(wait, () => manager.appendPieModelSettingsChange('provider-fixture', 'model-fixture', 'high')),
  );

  assert.deepEqual(observedDelays, retryDelays);
  assert.equal(renameAttempts, retryDelays.length + 1);
  assert.equal(manager.getEntries().length, previousEntries.length + 2);
  assert.equal(manager.getLeafId(), changes.thinkingLevelChangeId);
  assert.deepEqual(changes, {
    modelChangeId: manager.getEntries().at(-2)?.id,
    thinkingLevelChangeId: manager.getEntries().at(-1)?.id,
  });
  const committedRows = fs.readFileSync(sessionPath, 'utf8').trimEnd().split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(committedRows.length, originalRows.length + 2);
  assert.equal(committedRows[2]?.type, 'model_change');
  assert.equal(committedRows[3]?.type, 'thinking_level_change');
  assert.equal(committedRows[3]?.parentId, committedRows[2]?.id);
  assert.equal(fs.readdirSync(root).some((entry) => entry.endsWith('.tmp')), false);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(sessionPath).mode & 0o777, 0o600);
  }
});

test('rename exhaustion uses every transient delay and permanent failures are not retried', { concurrency: false }, (t) => {
  const parent = tempRoot(t);
  const retryDelays = [10, 25, 50, 100, 250, 500, 1000, 2000, 4000];
  const scenarios = [
    { name: 'exhausted', codes: ['EACCES', 'EBUSY', 'EPERM', 'EACCES', 'EBUSY', 'EPERM', 'EACCES', 'EBUSY', 'EPERM', 'EBUSY'], delays: retryDelays },
    { name: 'permanent', codes: ['EIO'], delays: [] as number[] },
  ];

  for (const scenario of scenarios) {
    const root = path.join(parent, scenario.name);
    fs.mkdirSync(root);
    const sessionPath = path.join(root, 'settings.jsonl');
    const originalBytes = `${JSON.stringify(sessionHeader(root))}\n${JSON.stringify(userEntry())}\n`;
    fs.writeFileSync(sessionPath, originalBytes, 'utf8');
    const manager = SessionManager.open(sessionPath);
    attachLease(manager, sessionPath);
    const previousEntries = manager.getEntries();
    const previousLeaf = manager.getLeafId();
    const observedDelays: number[] = [];
    let attempts = 0;
    const failRename = ((..._args: Parameters<typeof fs.renameSync>) => {
      const code = scenario.codes[attempts++]!;
      throw errno(code, `simulated ${scenario.name} rename failure`);
    }) as typeof fs.renameSync;
    const wait = ((_array: Int32Array, _index: number, _value: number, timeout?: number) => {
      if (timeout !== undefined) observedDelays.push(timeout);
      return 'timed-out';
    }) as typeof Atomics.wait;

    assert.throws(
      () => withFsOverrides({ renameSync: failRename }, () => withAtomicsWait(wait, () => (
        manager.appendPieModelSettingsChange('provider-fixture', 'model-fixture', 'high')
      ))),
      (error: NodeJS.ErrnoException) => error.code === scenario.codes.at(-1),
    );
    assert.equal(attempts, scenario.codes.length);
    assert.deepEqual(observedDelays, scenario.delays);
    assert.deepEqual(manager.getEntries(), previousEntries);
    assert.equal(manager.getLeafId(), previousLeaf);
    assert.equal(fs.readFileSync(sessionPath, 'utf8'), originalBytes);
    assert.deepEqual(fs.readdirSync(root), [path.basename(sessionPath)]);
  }
});

test('a suffix-write failure removes the temporary image and leaves manager state unchanged', { concurrency: false }, (t) => {
  const root = tempRoot(t);
  const sessionPath = path.join(root, 'settings.jsonl');
  const originalBytes = `${JSON.stringify(sessionHeader(root))}\n${JSON.stringify(userEntry())}\n`;
  fs.writeFileSync(sessionPath, originalBytes, 'utf8');
  const manager = SessionManager.open(sessionPath);
  attachLease(manager, sessionPath);
  const previousEntries = manager.getEntries();
  const previousLeaf = manager.getLeafId();
  const originalOpenSync = fs.openSync;
  const originalWriteFileSync = fs.writeFileSync;
  const suffixDescriptors = new Set<number>();
  const trackSuffixOpen = ((...args: Parameters<typeof fs.openSync>) => {
    const fd = Reflect.apply(originalOpenSync, fs, args) as number;
    if (args[1] === 'a' && String(args[0]).startsWith(`${sessionPath}.pie-model-settings-`)) suffixDescriptors.add(fd);
    return fd;
  }) as typeof fs.openSync;
  const failSuffixWrite = ((...args: Parameters<typeof fs.writeFileSync>) => {
    if (typeof args[0] === 'number' && suffixDescriptors.has(args[0])) {
      throw errno('EIO', 'simulated temporary suffix write failure');
    }
    return Reflect.apply(originalWriteFileSync, fs, args);
  }) as typeof fs.writeFileSync;

  assert.throws(
    () => withFsOverrides({ openSync: trackSuffixOpen, writeFileSync: failSuffixWrite }, () => (
      manager.appendPieModelSettingsChange('provider-fixture', 'model-fixture', 'high')
    )),
    /temporary suffix write failure/,
  );
  assert.equal(suffixDescriptors.size, 1, 'the injected failure occurs while appending after the complete copy');
  assert.equal(fs.readFileSync(sessionPath, 'utf8'), originalBytes);
  assert.deepEqual(manager.getEntries(), previousEntries);
  assert.equal(manager.getLeafId(), previousLeaf);
  assert.deepEqual(fs.readdirSync(root), [path.basename(sessionPath)]);
});

test('post-rename directory fsync failure keeps the published image and manager state committed', { concurrency: false }, (t) => {
  const root = tempRoot(t);
  const sessionPath = path.join(root, 'settings.jsonl');
  const originalBytes = `${JSON.stringify(sessionHeader(root))}\n${JSON.stringify(userEntry())}\n`;
  fs.writeFileSync(sessionPath, originalBytes, 'utf8');
  const manager = SessionManager.open(sessionPath);
  attachLease(manager, sessionPath);
  const previousEntries = manager.getEntries();
  const originalOpenSync = fs.openSync;
  const originalFsyncSync = fs.fsyncSync;
  const directoryDescriptors = new Set<number>();
  const trackDirectoryOpen = ((...args: Parameters<typeof fs.openSync>) => {
    const fd = Reflect.apply(originalOpenSync, fs, args) as number;
    if (args[1] === 'r' && path.resolve(String(args[0])) === path.resolve(root)) directoryDescriptors.add(fd);
    return fd;
  }) as typeof fs.openSync;
  const failDirectoryFsync = ((fd: number) => {
    if (directoryDescriptors.has(fd)) throw errno('EIO', 'simulated post-rename directory fsync failure');
    return Reflect.apply(originalFsyncSync, fs, [fd]);
  }) as typeof fs.fsyncSync;

  const changes = withFsOverrides({ openSync: trackDirectoryOpen, fsyncSync: failDirectoryFsync }, () => (
    manager.appendPieModelSettingsChange('provider-fixture', 'model-fixture', 'high')
  ));
  assert.ok(changes.modelChangeId);
  assert.ok(changes.thinkingLevelChangeId);
  assert.equal(directoryDescriptors.size, 1, 'the injected fsync failure is after atomic rename');
  assert.equal(manager.getEntries().length, previousEntries.length + 2);
  assert.equal(manager.getLeafId(), changes.thinkingLevelChangeId);
  const rows = fs.readFileSync(sessionPath, 'utf8').trimEnd().split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(rows.length, previousEntries.length + 3);
  assert.equal(rows.at(-2)?.type, 'model_change');
  assert.equal(rows.at(-1)?.type, 'thinking_level_change');
  assert.deepEqual(fs.readdirSync(root), [path.basename(sessionPath)]);
});

test('a pre-rename fsync failure rolls back the staged image and leaves manager state unchanged', { concurrency: false }, (t) => {
  const root = tempRoot(t);
  const sessionPath = path.join(root, 'settings.jsonl');
  const originalRows = [sessionHeader(root), userEntry()];
  const originalBytes = `${originalRows.map((row) => JSON.stringify(row)).join('\n')}\n`;
  fs.writeFileSync(sessionPath, originalBytes, 'utf8');
  const manager = SessionManager.open(sessionPath);
  attachLease(manager, sessionPath);
  const previousEntries = manager.getEntries();
  const previousLeaf = manager.getLeafId();
  const failFsync = ((fd: number) => {
    assert.ok(fd >= 0);
    throw errno('EIO', 'simulated staged-image fsync failure');
  }) as typeof fs.fsyncSync;

  assert.throws(
    () => withFsOverrides({ fsyncSync: failFsync }, () => manager.appendPieModelSettingsChange(undefined, undefined, 'high')),
    /simulated staged-image fsync failure/,
  );
  assert.equal(fs.readFileSync(sessionPath, 'utf8'), originalBytes);
  assert.deepEqual(manager.getEntries(), previousEntries);
  assert.equal(manager.getLeafId(), previousLeaf);
  assert.deepEqual(fs.readdirSync(root), [path.basename(sessionPath)]);
});
