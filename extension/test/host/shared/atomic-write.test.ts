import assert from 'node:assert/strict';
import test from 'node:test';

import { renameWithTransientRetry } from '../../../src/shared/atomic-write';

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

test('renameWithTransientRetry retries transient Windows sharing violations', async () => {
  const attempts: number[] = [];
  const delays: number[] = [];

  await renameWithTransientRetry('source.tmp', 'target.json', {
    retryDelaysMs: [10, 25, 50],
    rename: async () => {
      attempts.push(attempts.length + 1);
      if (attempts.length === 1) throw errno('EPERM');
      if (attempts.length === 2) throw errno('EBUSY');
    },
    delay: async (milliseconds) => {
      delays.push(milliseconds);
    },
  });

  assert.equal(attempts.length, 3);
  assert.deepEqual(delays, [10, 25]);
});

test('renameWithTransientRetry does not retry permanent failures', async () => {
  let attempts = 0;
  await assert.rejects(
    renameWithTransientRetry('source.tmp', 'target.json', {
      retryDelaysMs: [1, 1],
      rename: async () => {
        attempts += 1;
        throw errno('ENOENT');
      },
      delay: async () => undefined,
    }),
    { code: 'ENOENT' },
  );
  assert.equal(attempts, 1);
});

test('renameWithTransientRetry surfaces a persistent sharing violation after bounded retries', async () => {
  let attempts = 0;
  await assert.rejects(
    renameWithTransientRetry('source.tmp', 'target.json', {
      retryDelaysMs: [1, 2],
      rename: async () => {
        attempts += 1;
        throw errno('EACCES');
      },
      delay: async () => undefined,
    }),
    { code: 'EACCES' },
  );
  assert.equal(attempts, 3);
});
