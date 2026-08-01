import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_FS_RETRY_DELAYS_MS,
  isTransientFsError,
  withTransientFsRetry,
} from '../../src/shared/fs-retry';

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

test('withTransientFsRetry retries transient sharing violations then succeeds', async () => {
  const attempts: number[] = [];
  const delays: number[] = [];

  const result = await withTransientFsRetry(
    async () => {
      attempts.push(attempts.length + 1);
      if (attempts.length === 1) throw errno('EBUSY');
      if (attempts.length === 2) throw errno('EPERM');
      return 'ok';
    },
    { retryDelaysMs: [10, 25, 50], delay: async (ms) => { delays.push(ms); } },
  );

  assert.equal(result, 'ok');
  assert.equal(attempts.length, 3);
  assert.deepEqual(delays, [10, 25]);
});

test('withTransientFsRetry does not retry ENOENT', async () => {
  let attempts = 0;
  await assert.rejects(
    withTransientFsRetry(
      async () => {
        attempts += 1;
        throw errno('ENOENT');
      },
      { retryDelaysMs: [1, 1], delay: async () => undefined },
    ),
    { code: 'ENOENT' },
  );
  assert.equal(attempts, 1, 'ENOENT must surface on the first attempt');
});

test('withTransientFsRetry does not retry code-less permanent errors', async () => {
  let attempts = 0;
  await assert.rejects(
    withTransientFsRetry(
      async () => {
        attempts += 1;
        throw new Error('boom');
      },
      { retryDelaysMs: [1, 1], delay: async () => undefined },
    ),
    /boom/,
  );
  assert.equal(attempts, 1);
});

test('withTransientFsRetry surfaces the last transient error after exhausting the delay budget', async () => {
  let attempts = 0;
  const delays: number[] = [];
  await assert.rejects(
    withTransientFsRetry(
      async () => {
        attempts += 1;
        throw errno('EACCES');
      },
      { retryDelaysMs: [1, 2], delay: async (ms) => { delays.push(ms); } },
    ),
    { code: 'EACCES' },
  );
  // initial attempt + one retry per delay entry
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1, 2]);
});

test('withTransientFsRetry uses the default bounded schedule when none is given', async () => {
  let attempts = 0;
  await assert.rejects(
    withTransientFsRetry(
      async () => {
        attempts += 1;
        throw errno('EBUSY');
      },
      { delay: async () => undefined },
    ),
    { code: 'EBUSY' },
  );
  assert.equal(attempts, DEFAULT_FS_RETRY_DELAYS_MS.length + 1);
});

test('isTransientFsError classifies only EACCES/EBUSY/EPERM', () => {
  assert.equal(isTransientFsError(errno('EACCES')), true);
  assert.equal(isTransientFsError(errno('EBUSY')), true);
  assert.equal(isTransientFsError(errno('EPERM')), true);
  assert.equal(isTransientFsError(errno('ENOENT')), false);
  assert.equal(isTransientFsError(errno('EISDIR')), false);
  assert.equal(isTransientFsError(new Error('no code')), false);
  assert.equal(isTransientFsError(undefined), false);
  assert.equal(isTransientFsError(null), false);
});
