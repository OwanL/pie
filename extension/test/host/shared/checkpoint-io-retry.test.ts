import assert from 'node:assert/strict';
import test from 'node:test';

import fs from 'node:fs/promises';

import { readOptionalText } from '../../../src/host/shared/checkpoint-io';
import { DEFAULT_FS_RETRY_DELAYS_MS } from '../../../src/shared/fs-retry';

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

test('readOptionalText retries a transient sharing violation then returns content', async () => {
  let attempts = 0;
  const readFile = (async () => {
    attempts += 1;
    if (attempts === 1) throw errno('EBUSY');
    return '{"ok":true}';
  }) as unknown as typeof fs.readFile;

  const result = await readOptionalText('/ignored/path.jsonl', {
    readFile,
    delay: async () => undefined,
  });

  assert.equal(result, '{"ok":true}');
  assert.equal(attempts, 2);
});

test('readOptionalText maps ENOENT to null without retrying', async () => {
  let attempts = 0;
  const readFile = (async () => {
    attempts += 1;
    throw errno('ENOENT');
  }) as unknown as typeof fs.readFile;

  const result = await readOptionalText('/missing/path.jsonl', {
    readFile,
    delay: async () => undefined,
  });

  assert.equal(result, null);
  assert.equal(attempts, 1, 'ENOENT must not be retried');
});

test('readOptionalText rethrows a permanent error without retrying', async () => {
  let attempts = 0;
  const readFile = (async () => {
    attempts += 1;
    throw errno('EISDIR');
  }) as unknown as typeof fs.readFile;

  await assert.rejects(
    readOptionalText('/permanent/path.jsonl', {
      readFile,
      delay: async () => undefined,
    }),
    { code: 'EISDIR' },
  );
  assert.equal(attempts, 1);
});

test('readOptionalText surfaces a persistent transient error after exhausting retries', async () => {
  let attempts = 0;
  const readFile = (async () => {
    attempts += 1;
    throw errno('EACCES');
  }) as unknown as typeof fs.readFile;

  await assert.rejects(
    readOptionalText('/stuck/path.jsonl', {
      readFile,
      delay: async () => undefined,
    }),
    { code: 'EACCES' },
  );
  assert.equal(attempts, DEFAULT_FS_RETRY_DELAYS_MS.length + 1);
});
