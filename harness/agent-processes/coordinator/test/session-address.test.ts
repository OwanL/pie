import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionControlSender, createSessionReplyReference } from '../../lib/rpc/session-control-attribution.js';
import { createSessionAddress, resolveSessionAddress } from '../session-address.js';

test('compact addresses are short, stable, and distinguish identities sharing long prefixes', () => {
  const first = { sessionId: `${'a'.repeat(75)}-one`, identityFallback: false };
  const second = { sessionId: `${'a'.repeat(75)}-two`, identityFallback: false };
  const firstAddress = createSessionAddress(first);
  const secondAddress = createSessionAddress(second);
  assert.match(firstAddress, /^pie-session:v1:[0-9a-f]{16}$/);
  assert.equal(firstAddress.length, 31);
  assert.notEqual(firstAddress, secondAddress);
  assert.equal(createSessionAddress(first), firstAddress);
  assert.equal(createSessionControlSender(first).address, firstAddress,
    'sender guidance and coordinator target resolution share the same derived address');
});

test('resolution accepts historical references and unknown compact addresses never degrade to titles', () => {
  const identity = { sessionId: 'stable-live-id', identityFallback: false };
  const candidates = [{ identity, value: '/live/session' }];
  assert.deepEqual(resolveSessionAddress(createSessionAddress(identity), candidates), { status: 'resolved', value: '/live/session' });
  assert.deepEqual(resolveSessionAddress(createSessionReplyReference(identity), candidates), { status: 'resolved', value: '/live/session' });
  assert.deepEqual(resolveSessionAddress('pie-session:v1:0000000000000000', candidates), { status: 'unavailable' });
  assert.deepEqual(resolveSessionAddress('pie-session:v1:000000000000000Z', candidates), { status: 'invalid' });
  assert.deepEqual(resolveSessionAddress('Some Agent Title', candidates), { status: 'invalid' });
});

test('duplicate candidate matches fail closed as ambiguous', () => {
  const identity = { sessionId: 'same-identity', identityFallback: true };
  assert.deepEqual(resolveSessionAddress(createSessionAddress(identity), [
    { identity, value: '/first' },
    { identity: { ...identity }, value: '/second' },
  ]), { status: 'ambiguous' });
});
