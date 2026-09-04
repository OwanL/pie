import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SendOperationLedger,
  canonicalSendIntentFingerprint,
} from '../../../src/backend/send-operation-ledger';
import { BackendError } from '../../../src/backend/server-io';
import type { ComposerInput } from '../../../src/shared/protocol';

const intent: { sessionPath: string; text: string; inputs: ComposerInput[]; localId: string } = {
  sessionPath: '/repo/session.jsonl',
  text: 'hello',
  inputs: [{ id: 'input-1', kind: 'filesystemPathRef', path: '/repo/a.ts', name: 'a.ts', source: 'picker' }],
  localId: 'local-1',
};

test('send ledger joins an in-flight retry and replays one acceptance', async () => {
  const ledger = new SendOperationLedger();
  const fingerprint = canonicalSendIntentFingerprint(intent);
  let executeCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const execute = async () => {
    executeCalls += 1;
    await gate;
    return { operationId: 'op-1', requestId: 'request-1' };
  };

  const first = ledger.run('op-1', fingerprint, execute);
  const retry = ledger.run('op-1', fingerprint, execute);
  release();

  assert.deepEqual(await first, { operationId: 'op-1', requestId: 'request-1' });
  assert.deepEqual(await retry, { operationId: 'op-1', requestId: 'request-1' });
  assert.equal(executeCalls, 1);
  assert.deepEqual(await ledger.run('op-1', fingerprint, execute), {
    operationId: 'op-1', requestId: 'request-1',
  });
  assert.equal(executeCalls, 1, 'accepted replay must not execute another prompt');
});

test('send ledger rejects operationId reuse with a changed canonical intent', async () => {
  const ledger = new SendOperationLedger();
  await ledger.run('op-1', canonicalSendIntentFingerprint(intent), async () => ({ operationId: 'op-1' }));

  await assert.rejects(
    async () => await ledger.run(
      'op-1', canonicalSendIntentFingerprint({ ...intent, text: 'changed' }),
      async () => ({ operationId: 'op-1' }),
    ),
    (error: unknown) => error instanceof BackendError && error.code === 'OPERATION_INTENT_MISMATCH',
  );
});

test('send ledger exposes acceptance and commit as distinct monotonic states', async () => {
  const ledger = new SendOperationLedger();
  await ledger.run('op-1', canonicalSendIntentFingerprint(intent), async () => ({
    operationId: 'op-1', requestId: 'request-1',
  }));
  assert.deepEqual(ledger.status('op-1'), {
    operationId: 'op-1', state: 'accepted', requestId: 'request-1', queued: false, committed: false,
  });

  ledger.markCommitted('op-1');
  ledger.markCommitted('op-1');
  ledger.markFailed('op-1', 'LATE_FAILURE', 'must not replace commit');
  assert.deepEqual(ledger.status('op-1'), {
    operationId: 'op-1', state: 'accepted', requestId: 'request-1', queued: false, committed: true,
  });
});

test('send ledger preserves synchronous semantic commit before acknowledgement settles', async () => {
  const ledger = new SendOperationLedger();
  const fingerprint = canonicalSendIntentFingerprint(intent);
  await ledger.run('op-1', fingerprint, async () => {
    ledger.markCommitted('op-1');
    return { operationId: 'op-1', requestId: 'request-1' };
  });
  assert.deepEqual(ledger.status('op-1'), {
    operationId: 'op-1', state: 'accepted', requestId: 'request-1', queued: false, committed: true,
  });
});

test('canonical send intent ignores object property insertion order', () => {
  const reordered = {
    localId: intent.localId,
    inputs: [{
      source: 'picker' as const,
      name: 'a.ts',
      path: '/repo/a.ts',
      kind: 'filesystemPathRef' as const,
      id: 'input-1',
    }],
    text: intent.text,
    sessionPath: intent.sessionPath,
  };
  assert.equal(
    canonicalSendIntentFingerprint(intent),
    canonicalSendIntentFingerprint(reordered),
  );
});

test('send ledger replays the same typed failure without executing again', async () => {
  const ledger = new SendOperationLedger();
  const fingerprint = canonicalSendIntentFingerprint(intent);
  let calls = 0;
  const reject = async (): Promise<never> => {
    calls += 1;
    throw new BackendError('REQUEST_IN_PROGRESS', 'busy');
  };
  await assert.rejects(ledger.run('op-1', fingerprint, reject), /busy/);
  await assert.rejects(
    ledger.run('op-1', fingerprint, reject),
    (error: unknown) => error instanceof BackendError && error.code === 'REQUEST_IN_PROGRESS',
  );
  assert.equal(calls, 1);
});
