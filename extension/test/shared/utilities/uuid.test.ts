/**
 * Focused tests for the browser-safe UUID v4 helper: RFC 4122 format,
 * version/variant bits, native `randomUUID` delegation, and the
 * insecure-context `getRandomValues` fallback (never `Math.random`).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createUuidV4, isUuidV4 } from '../../../src/shared/uuid';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('createUuidV4(): output matches the RFC 4122 UUID v4 format', () => {
  for (let index = 0; index < 32; index += 1) {
    assert.match(createUuidV4(), UUID_V4_PATTERN);
  }
});

test('createUuidV4(): version nibble is 4 and the variant top bits are 10', () => {
  for (let index = 0; index < 32; index += 1) {
    const uuid = createUuidV4();
    assert.equal(uuid[14], '4', 'the version nibble is fixed at 4');
    assert.ok(['8', '9', 'a', 'b'].includes(uuid[19]!), 'the variant nibble is 10xx');
  }
});

test('createUuidV4(): ids are unique across many generations', () => {
  const ids = new Set<string>();
  for (let index = 0; index < 256; index += 1) ids.add(createUuidV4());
  assert.equal(ids.size, 256);
});

test('createUuidV4(): delegates to native randomUUID when available', (t) => {
  const native = t.mock.method(crypto, 'randomUUID', () => 'native-delegated-id');
  assert.equal(createUuidV4(), 'native-delegated-id');
  assert.equal(native.mock.callCount(), 1);
});

test('createUuidV4(): falls back to getRandomValues on insecure contexts (no Math.random)', (t) => {
  const originalCrypto = globalThis.crypto;
  const originalRandom = Math.random;
  const getRandomValuesCalls: number[] = [];
  let stubCounter = 0;
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      getRandomValues: (array: Uint8Array): Uint8Array => {
        getRandomValuesCalls.push(array.length);
        for (let index = 0; index < array.length; index += 1) array[index] = ((index * 41 + 7) + stubCounter++ * 191) & 0xff;
        return array;
      },
    },
  });
  Math.random = () => {
    throw new Error('Math.random must not be used for UUID entropy');
  };
  try {
    assert.equal(getRandomValuesCalls.length, 0);
    const uuid = createUuidV4();
    assert.match(uuid, UUID_V4_PATTERN, 'the fallback still produces a standards-compliant UUID v4');
    assert.equal(getRandomValuesCalls.length, 1, 'entropy came from one getRandomValues call');
    assert.equal(getRandomValuesCalls[0], 16, 'the fallback requests 16 random bytes');
    for (let index = 0; index < 16; index += 1) {
      const uuid2 = createUuidV4();
      assert.match(uuid2, UUID_V4_PATTERN);
    }
    assert.ok(new Set(Array.from({ length: 16 }, () => createUuidV4())).size === 16);
  } finally {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: originalCrypto });
    Math.random = originalRandom;
  }
});

test('createUuidV4(): throws a clear error when no secure entropy source exists', (t) => {
  const originalCrypto = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
  try {
    assert.throws(() => createUuidV4(), /no secure entropy source/i);
  } finally {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: originalCrypto });
  }
});

test('isUuidV4(): accepts compliant ids and rejects malformed or wrong-version ids', () => {
  assert.equal(isUuidV4(createUuidV4()), true);
  assert.equal(isUuidV4('aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa'), false, 'version 1 is not v4');
  assert.equal(isUuidV4('aaaaaaaa-aaaa-4aaa-caaa-aaaaaaaaaaaa'), false, 'variant c is not 10xx');
  assert.equal(isUuidV4('aaaaaaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), false, 'wrong segment lengths');
  assert.equal(isUuidV4(''), false);
  assert.equal(isUuidV4('not-a-uuid'), false);
});