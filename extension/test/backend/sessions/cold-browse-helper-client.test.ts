import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';

import {
  ColdBrowseHelperClient,
  ColdBrowseHelperRequestError,
  type ColdBrowseHelperClientOptions,
} from '../../../src/backend/cold-browse-helper-client';
import type { ColdBrowseHelperFence } from '../../../src/backend/cold-browse-helper-protocol';
import { SessionSnapshotTooLargeError } from '../../../src/shared/transcript-window';

const fixturePath = path.join(process.cwd(), 'test', 'fixtures', 'cold-browse-helper-client-fixture.mjs');
const fence: ColdBrowseHelperFence = {
  coordinatorGeneration: 1,
  sessionPath: path.join(process.cwd(), 'fixture.jsonl'),
  sessionPathKey: 'fixture',
  ownershipRevision: 0,
  fingerprint: 'fixture-fingerprint',
};
const openOptions = {
  modelSettings: { defaultModel: 'model-a', defaultThinkingLevel: 'medium' as const },
  availableModels: [],
};

function client(
  mode: string,
  overrides: Partial<ColdBrowseHelperClientOptions> = {},
): ColdBrowseHelperClient {
  return new ColdBrowseHelperClient({
    entryPath: fixturePath,
    entryArgs: [mode],
    sdkPath: process.cwd(),
    sdkPatchIdentity: {} as any,
    startupCwd: process.cwd(),
    requestTimeoutMs: 2_000,
    ...overrides,
  });
}

test('client keeps correlated operation errors local to the request', async () => {
  const helper = client('error');
  try {
    await helper.warm();
    await assert.rejects(
      helper.openSnapshot(fence, openOptions),
      (error) => error instanceof ColdBrowseHelperRequestError
        && error.code === 'FIXTURE_ERROR'
        && error.message === 'fixture operation failed',
    );
    await assert.rejects(helper.openSnapshot(fence, openOptions), ColdBrowseHelperRequestError);
  } finally {
    await helper.dispose();
  }
});

test('client rejects pending work when the helper crashes', async () => {
  const helper = client('crash');
  try {
    await helper.warm();
    await assert.rejects(helper.openSnapshot(fence, openOptions), /exited unexpectedly|EPIPE/u);
  } finally {
    await helper.dispose();
  }
});

test('client fails the generation closed on an unknown correlation', async () => {
  const helper = client('wrong-correlation');
  try {
    await helper.warm();
    await assert.rejects(helper.openSnapshot(fence, openOptions), /unknown correlation/u);
  } finally {
    await helper.dispose();
  }
});

test('client bounds helper readiness and terminates the hung generation', async () => {
  const helper = client('hang-ready', { startupTimeoutMs: 100, shutdownTimeoutMs: 250 });
  try {
    await assert.rejects(helper.warm(), /readiness timed out/u);
  } finally {
    await helper.dispose();
  }
});

test('client rejects a success frame whose fingerprint does not match its request fence', async () => {
  const helper = client('stale-fingerprint');
  try {
    await helper.warm();
    await assert.rejects(helper.openSnapshot(fence, openOptions), /wrong durable fingerprint/u);
  } finally {
    await helper.dispose();
  }
});

test('client preserves a fenced oversized-snapshot error as the shared typed error', async () => {
  const helper = client('oversized');
  try {
    await helper.warm();
    await assert.rejects(
      helper.openSnapshot(fence, openOptions),
      (error) => error instanceof SessionSnapshotTooLargeError
        && error.code === 'SESSION_SNAPSHOT_TOO_LARGE'
        && error.data.requiredMessageId === 'required',
    );
  } finally {
    await helper.dispose();
  }
});

test('client preserves a fingerprint-change signal only for its exact request fence', async () => {
  const helper = client('fingerprint-changed');
  try {
    await helper.warm();
    await assert.rejects(
      helper.openSnapshot(fence, openOptions),
      (error) => error instanceof ColdBrowseHelperRequestError
        && error.code === 'FINGERPRINT_CHANGED'
        && error.fingerprint === fence.fingerprint,
    );
  } finally {
    await helper.dispose();
  }
});

test('client fails the helper generation on a fingerprint-change signal for the wrong fence', async () => {
  const helper = client('fingerprint-changed-wrong-fence');
  try {
    await helper.warm();
    await assert.rejects(
      helper.openSnapshot(fence, openOptions),
      /invalid fingerprint-change error frame/u,
    );
  } finally {
    await helper.dispose();
  }
});

test('serialized requests receive queue-position-adjusted timeout budgets', async () => {
  const helper = client('delayed', { requestTimeoutMs: 150 });
  try {
    await helper.warm();
    const [first, second] = await Promise.all([
      helper.openSnapshot(fence, openOptions),
      helper.openSnapshot(fence, openOptions),
    ]);
    assert.equal(first.session.path, fence.sessionPath);
    assert.equal(second.session.path, fence.sessionPath);
  } finally {
    await helper.dispose();
  }
});

test('invalidation does not spawn a helper before the first browse', async () => {
  let spawnCalls = 0;
  const helper = new ColdBrowseHelperClient({
    entryPath: fixturePath,
    sdkPath: process.cwd(),
    sdkPatchIdentity: {} as any,
    startupCwd: process.cwd(),
    spawnProcess: (() => {
      spawnCalls += 1;
      throw new Error('must not spawn');
    }) as any,
  });
  await helper.invalidatePath('unused');
  assert.equal(spawnCalls, 0);
  await helper.dispose();
});

test('client performs a correlated request and clean shutdown', async () => {
  const helper = client('success', { shutdownTimeoutMs: 1_000 });
  await helper.warm();
  const result = await helper.openSnapshot(fence, openOptions);
  const childPid = (result as any).fixturePid as number;
  assert.equal(result.session.path, fence.sessionPath);
  const startedAt = Date.now();
  await helper.dispose();
  assert.ok(Date.now() - startedAt < 1_000, 'clean shutdown exits before the forced-kill window');
  assert.equal(isProcessAlive(childPid), false);
});

test('client kills a child that acknowledges shutdown but retains a live handle', async () => {
  const helper = client('sticky-shutdown', { shutdownTimeoutMs: 100 });
  await helper.warm();
  const result = await helper.openSnapshot(fence, openOptions);
  const childPid = (result as any).fixturePid as number;
  await helper.dispose();
  assert.equal(isProcessAlive(childPid), false);
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
