import assert from 'node:assert/strict';
import test from 'node:test';

import { InterruptOperationLedger } from '../interrupt-operation-ledger.js';
import { SendOperationLedger } from '../send-operation-ledger.js';
import { BackendError } from '../server-io.js';

for (const { name, create, result, description } of [
  { name: 'send', create: () => new SendOperationLedger(), result: { operationId: 'op', interrupted: false }, description: 'message mutation' },
  { name: 'interrupt', create: () => new InterruptOperationLedger(), result: { operationId: 'op', interrupted: true }, description: 'interrupt' },
]) {
  test(`${name} joins the exact pending promise and rejects changed intent in every state`, async () => {
    const ledger = create();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute = async () => { calls += 1; await gate; return result; };
    const mismatch = () => assert.throws(
      () => ledger.run('op', 'changed', execute),
      (error: unknown) => error instanceof BackendError
        && error.code === 'OPERATION_INTENT_MISMATCH'
        && error.message === `Operation op was already used for a different ${description} intent.`,
    );
    const first = ledger.run('op', 'intent', execute);
    assert.equal(ledger.run('op', 'intent', execute), first);
    mismatch();
    release();
    assert.equal(await first, result);
    mismatch();
    assert.equal(await ledger.run('op', 'intent', execute), result);
    assert.equal(calls, 1);
  });

  test(`${name} preserves failure replay and isolates ledger instances`, async () => {
    const ledger = create();
    const failure = new BackendError('EXPECTED_FAILURE', 'original failure');
    let calls = 0;
    const execute = async (): Promise<never> => { calls += 1; throw failure; };
    await assert.rejects(ledger.run('op', 'intent', execute), (error) => error === failure);
    assert.throws(() => ledger.run('op', 'changed', execute), /different .* intent/);
    await assert.rejects(ledger.run('op', 'intent', execute), (error: unknown) =>
      error instanceof BackendError && error.code === failure.code && error.message === failure.message);
    assert.equal(calls, 1);
    assert.equal(await create().run('op', 'changed', async () => result), result);
  });
}
