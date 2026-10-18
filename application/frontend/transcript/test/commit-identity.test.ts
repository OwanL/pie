import assert from 'node:assert/strict';
import test from 'node:test';

import { boundedTextIdentity, equalBoundedTextIdentity } from '../commit-identity';

test('bounded text equality rejects equal-length stale text and changed lengths', () => {
  const identity = boundedTextIdentity('abc123');
  assert.equal(equalBoundedTextIdentity(identity, boundedTextIdentity('abc123')), true);
  assert.equal(equalBoundedTextIdentity(identity, boundedTextIdentity('xyz789')), false);
  assert.equal(equalBoundedTextIdentity(identity, { ...identity, length: 7 }), false);
  assert.equal(equalBoundedTextIdentity(boundedTextIdentity(''), boundedTextIdentity('')), true);
});

test('short text is fully hashed, including at the three-sample boundary', () => {
  const text = 'abcdef';
  for (let index = 0; index < text.length; index += 1) {
    const changed = `${text.slice(0, index)}!${text.slice(index + 1)}`;
    assert.equal(equalBoundedTextIdentity(boundedTextIdentity(text, 2), boundedTextIdentity(changed, 2)), false);
  }
});

test('long text hashes bounded head, middle and tail samples, not unvisited content', () => {
  const text = 'a'.repeat(10000);
  const identity = boundedTextIdentity(text);
  assert.equal(identity.length, text.length);
  assert.match(identity.hash, /^[0-9a-f]{8}$/);
  for (const index of [0, 5000, 9999]) {
    const changed = `${text.slice(0, index)}b${text.slice(index + 1)}`;
    assert.equal(equalBoundedTextIdentity(identity, boundedTextIdentity(changed)), false);
  }
  const unsampledChange = `${text.slice(0, 1000)}b${text.slice(1001)}`;
  assert.deepEqual(boundedTextIdentity(unsampledChange), identity);
});

test('zero sample budget retains length without hashing text', () => {
  assert.deepEqual(boundedTextIdentity('aaa', 0), boundedTextIdentity('bbb', 0));
  assert.equal(equalBoundedTextIdentity(boundedTextIdentity('a', 0), boundedTextIdentity('aa', 0)), false);
});

test('text sample size rejects negative, fractional and unsafe values', () => {
  for (const sampleChars of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => boundedTextIdentity('text', sampleChars), RangeError);
  }
});
