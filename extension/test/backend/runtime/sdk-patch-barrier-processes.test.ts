import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DURABILITY_SOURCE,
  DURABILITY_SOURCE_WITH_INLINE_RETRY,
  RETRY_RELATIVE_PATH,
  withFixture,
  runBarrierChild,
  cleanupPristineTemplate,
} from './sdk-patch-barrier-shared';

import {
  ensureSdkPatchBarrier,
  removeSdkPatchBarrierDirectory,
  validateSdkPatchBarrier,
} from '../../../src/backend/sdk-patch-barrier';
test.after(async () => { await cleanupPristineTemplate(); });

test('patched create publication never replaces an existing destination', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    await ensureSdkPatchBarrier(sdkPath, { lockRoot });
    const module = await import(`${pathToFileURL(path.join(sdkPath, 'dist', 'core', 'session-manager.js')).href}?collision=${Date.now()}`);
    const sessionDir = path.join(sdkPath, 'collision-sessions');
    await fs.mkdir(sessionDir);
    const RealDate = globalThis.Date;
    class FixedDate extends RealDate {
      constructor(value?: string | number) {
        super(value ?? '2026-01-02T03:04:05.000Z');
      }
      static override now(): number { return new RealDate('2026-01-02T03:04:05.000Z').getTime(); }
    }
    globalThis.Date = FixedDate as DateConstructor;
    let first: { getSessionFile(): string };
    try {
      first = module.SessionManager.create(sdkPath, sessionDir, { id: 'same-path' });
      assert.throws(
        () => module.SessionManager.create(sdkPath, sessionDir, { id: 'same-path' }),
        (error: NodeJS.ErrnoException) => error.code === 'EEXIST',
      );
    } finally {
      globalThis.Date = RealDate;
    }
    const before = await fs.readFile(first!.getSessionFile(), 'utf8');
    assert.equal(await fs.readFile(first.getSessionFile(), 'utf8'), before);
    assert.deepEqual((await fs.readdir(sessionDir)).filter((name) => name.includes('.pie-create-')), []);
  });
});

test('post-publication durability failure removes the uncommitted destination before retry', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    await ensureSdkPatchBarrier(sdkPath, { lockRoot });
    const sessionManagerPath = path.join(sdkPath, 'dist', 'core', 'session-manager.js');
    const patched = await fs.readFile(sessionManagerPath, 'utf8');
    await fs.writeFile(
      sessionManagerPath,
      patched.replace(
        'if (directoryDescriptor !== undefined)\n                closeSync(directoryDescriptor);',
        'if (directoryDescriptor !== undefined)\n                throw Object.assign(new Error("injected directory close failure"), { code: "EIO" });',
      ),
      'utf8',
    );
    const module = await import(`${pathToFileURL(sessionManagerPath).href}?post-publish-failure=${Date.now()}`);
    const sessionDir = path.join(sdkPath, 'failed-sessions');
    await fs.mkdir(sessionDir);

    assert.throws(
      () => module.SessionManager.create(sdkPath, sessionDir, { id: 'failed-path' }),
      /injected directory close failure/,
    );
    assert.deepEqual(await fs.readdir(sessionDir), []);
  });
});

test('two real processes serialize patching and return the same final fingerprints', async () => {
  await withFixture(async (fixture) => {
    const [first, second] = await Promise.all([
      runBarrierChild(fixture),
      runBarrierChild(fixture),
    ]);

    assert.deepEqual(first, second);
    await validateSdkPatchBarrier(fixture.sdkPath, first);
    const lockEntries = await fs.readdir(fixture.lockRoot);
    assert.deepEqual(lockEntries, []);
  });
});

test('lock directory cleanup retries a deterministic transient takeover interleaving', async () => {
  let attempts = 0;
  const delays: number[] = [];

  await removeSdkPatchBarrierDirectory('unused-test-path', {
    retryDelaysMs: [1, 2, 3],
    delay: async (milliseconds) => { delays.push(milliseconds); },
    remove: async () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('directory changed during removal'), { code: 'ENOTEMPTY' });
    },
  });

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1, 2]);

  attempts = 0;
  await assert.rejects(
    removeSdkPatchBarrierDirectory('unused-test-path', {
      retryDelaysMs: [1, 2],
      delay: async () => undefined,
      remove: async () => {
        attempts += 1;
        throw Object.assign(new Error('directory remains busy'), { code: 'EBUSY' });
      },
    }),
    { code: 'EBUSY' },
  );
  assert.equal(attempts, 3, 'cleanup must remain bounded and fail closed');
});

test('coordinator fails closed when every retry candidate has an unsupported shape', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    const durabilityPath = path.join(sdkPath, 'dist', 'core', 'agent-session.js');
    const retryPath = path.join(sdkPath, RETRY_RELATIVE_PATH);
    const beforeDurability = await fs.readFile(durabilityPath, 'utf8');
    const beforeRetry = await fs.readFile(retryPath, 'utf8');

    await assert.rejects(
      ensureSdkPatchBarrier(sdkPath, { lockRoot }),
      /SDK retry-classifier patch failed: unsupported-shape/,
    );
    assert.equal(await fs.readFile(durabilityPath, 'utf8'), beforeDurability);
    assert.equal(await fs.readFile(retryPath, 'utf8'), beforeRetry);
  }, 'const RETRYABLE = ["different fingerprint"];');
});

test('coordinator falls back to a valid legacy inline candidate when the preferred retry candidate has an unsupported shape', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    const retryPath = path.join(sdkPath, RETRY_RELATIVE_PATH);
    const beforeRetry = await fs.readFile(retryPath, 'utf8');

    const identity = await ensureSdkPatchBarrier(sdkPath, { lockRoot });

    assert.equal(identity.retryClassifier.relativePath, 'dist/core/agent-session.js');
    assert.equal(
      await fs.readFile(retryPath, 'utf8'),
      beforeRetry,
      'the unsupported preferred candidate must not be written',
    );
    const patched = await fs.readFile(path.join(sdkPath, 'dist', 'core', 'agent-session.js'), 'utf8');
    assert.match(patched, /stream ended before message_stop\|stream ended before a terminal response event/);
    await validateSdkPatchBarrier(sdkPath, JSON.parse(JSON.stringify(identity)));
  }, 'const RETRYABLE = ["different fingerprint"];', DURABILITY_SOURCE_WITH_INLINE_RETRY);
});
