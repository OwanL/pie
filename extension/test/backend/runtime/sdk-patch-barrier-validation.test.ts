import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  RETRY_RELATIVE_PATH,
  withFixture,
  exitedProcessId,
  cleanupPristineTemplate,
} from './sdk-patch-barrier-shared';

import {
  ensureSdkPatchBarrier,
  resolveSdkPatchBarrierLockPath,
  validateSdkPatchBarrier,
} from '../../../src/backend/sdk-patch-barrier';
test.after(async () => { void cleanupPristineTemplate(); });

test('coordinator rejects an already-patched runtime missing any quiescence abort seam', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    const runtimePath = path.join(sdkPath, 'dist', 'core', 'agent-session-runtime.js');
    const changed = (await fs.readFile(runtimePath, 'utf8')).replace(
      '        this.session.abortBash?.();\n',
      '',
    );
    await fs.writeFile(runtimePath, changed, 'utf8');

    await assert.rejects(
      ensureSdkPatchBarrier(sdkPath, { lockRoot }),
      /SDK semantic fingerprint is unsupported for dist\/core\/agent-session-runtime\.js/,
    );
    assert.equal(await fs.readFile(runtimePath, 'utf8'), changed);
  });
});

test('worker validation rejects a wrong file fingerprint and never repairs it', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    const identity = await ensureSdkPatchBarrier(sdkPath, { lockRoot });
    const retryPath = path.join(sdkPath, RETRY_RELATIVE_PATH);
    const changed = `${await fs.readFile(retryPath, 'utf8')}\n// changed after coordinator handoff\n`;
    await fs.writeFile(retryPath, changed, 'utf8');

    await assert.rejects(
      validateSdkPatchBarrier(sdkPath, identity),
      /SDK semantic fingerprint is unsupported/,
    );
    assert.equal(await fs.readFile(retryPath, 'utf8'), changed, 'worker validation must never write');
  });
});

test('worker rejects a changed cold-create file fingerprint without repairing it', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    const identity = await ensureSdkPatchBarrier(sdkPath, { lockRoot });
    const sessionManagerPath = path.join(sdkPath, 'dist', 'core', 'session-manager.js');
    const changed = `${await fs.readFile(sessionManagerPath, 'utf8')}\n// changed after handoff\n`;
    await fs.writeFile(sessionManagerPath, changed, 'utf8');

    await assert.rejects(validateSdkPatchBarrier(sdkPath, identity), /SDK semantic fingerprint is unsupported/);
    assert.equal(await fs.readFile(sessionManagerPath, 'utf8'), changed);
  });
});

test('worker validation rejects wrong identity version, SDK path/version, and extra fields', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    const identity = await ensureSdkPatchBarrier(sdkPath, { lockRoot });
    for (const changed of [
      { ...identity, identityVersion: 1 },
      { ...identity, identityVersion: 3 },
      { ...identity, sdkPath: `${identity.sdkPath}-other` },
      { ...identity, sdkVersion: '0.80.7' },
      { ...identity, unexpected: true },
    ]) {
      await assert.rejects(validateSdkPatchBarrier(sdkPath, changed), /SDK patch identity/);
    }
  });
});

test('coordinator confirms stale owner death before taking over its cross-process lock', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    const canonicalPath = await fs.realpath(sdkPath);
    const lockPath = resolveSdkPatchBarrierLockPath(canonicalPath, '0.80.6-test', lockRoot);
    const stalePid = await exitedProcessId();
    await fs.mkdir(lockPath, { recursive: true });
    await fs.writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({
      ownerVersion: 1,
      pid: stalePid,
      token: 'dead-owner-token',
      createdAt: new Date(0).toISOString(),
      sdkPath: canonicalPath,
      sdkVersion: '0.80.6-test',
    }), 'utf8');

    const identity = await ensureSdkPatchBarrier(sdkPath, {
      lockRoot,
      lockTimeoutMs: 2_000,
      lockPollMs: 5,
    });
    assert.equal(identity.sdkVersion, '0.80.6-test');
    await assert.rejects(fs.access(lockPath));
  });
});

test('coordinator does not take over a lock whose owner death cannot be confirmed', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    const canonicalPath = await fs.realpath(sdkPath);
    const lockPath = resolveSdkPatchBarrierLockPath(canonicalPath, '0.80.6-test', lockRoot);
    await fs.mkdir(lockPath, { recursive: true });
    await fs.writeFile(path.join(lockPath, 'owner.json'), '{not-json', 'utf8');

    await assert.rejects(
      ensureSdkPatchBarrier(sdkPath, { lockRoot, lockTimeoutMs: 20, lockPollMs: 2 }),
      /ownership cannot be confirmed/,
    );
    await fs.access(lockPath);
  });
});
