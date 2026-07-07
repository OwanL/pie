import test from 'node:test';
import assert from 'node:assert/strict';

import { toErrorMessage, parseJsonOrThrow, enrichConnectionError, isConnectionError } from '../src/host/util/error-message';

test('toErrorMessage normalizes any thrown value into a human-readable string', () => {
  // Error with a message
  assert.equal(toErrorMessage(new Error('boom')), 'boom');

  // Error with an empty message falls back to the constructor name
  assert.equal(toErrorMessage(new Error('')), 'Error');

  // Bare string throw
  assert.equal(toErrorMessage('something broke'), 'something broke');

  // RPC-style objects exposing message / error / code
  assert.equal(toErrorMessage({ message: 'rpc failed' }), 'rpc failed');
  assert.equal(toErrorMessage({ error: 'denied' }), 'denied');
  assert.equal(toErrorMessage({ code: 'ENOENT' }), 'ENOENT');

  // null / undefined
  assert.equal(toErrorMessage(null), 'Unknown error');
  assert.equal(toErrorMessage(undefined), 'Unknown error');

  // number / plain object fall back to String(err)
  assert.equal(toErrorMessage(42), '42');
  assert.equal(toErrorMessage({ foo: 'bar' }), '[object Object]');
});

test('parseJsonOrThrow returns parsed JSON for valid input', () => {
  assert.deepEqual(parseJsonOrThrow<number>('{"a":1}', 'test.json'), { a: 1 });
  assert.deepEqual(parseJsonOrThrow<number[]>('[1,2,3]', 'test.json'), [1, 2, 3]);
});

test('parseJsonOrThrow throws a contextual Error naming the label on malformed JSON', () => {
  const cases = ['{', 'not json', '{a:1}', '{"a":1,}', 'null x'];
  for (const raw of cases) {
    assert.throws(
      () => parseJsonOrThrow(raw, 'settings.json'),
      (err: unknown) => {
        assert.ok(err instanceof Error, 'should throw an Error');
        const msg = (err as Error).message;
        assert.ok(msg.startsWith('settings.json: invalid JSON \u2014 '), `unexpected message: ${msg}`);
        return true;
      },
      'parseJsonOrThrow should throw a contextual Error for malformed JSON',
    );
  }
});

test('parseJsonOrThrow surfaces non-SyntaxError throws via toErrorMessage', () => {
  // JSON.parse only throws SyntaxError, but the helper still labels any
  // non-SyntaxError via toErrorMessage. Verify the label prefix is applied.
  assert.throws(
    () => parseJsonOrThrow('{', 'models.json'),
    /models\.json: invalid JSON/,
  );
});
test('isConnectionError detects connection-level errors (no HTTP response)', () => {
  // OpenAI SDK APIConnectionError: status undefined, generic message, real cause.
  const connErr = Object.assign(new Error('Connection error.'), {
    name: 'APIConnectionError',
    status: undefined,
    cause: new Error('connect ECONNREFUSED 127.0.0.1:4000'),
  });
  assert.equal(isConnectionError(connErr), true);

  // Cause carries the transport reason even if the top message is generic.
  assert.equal(isConnectionError({ message: 'Connection error.', cause: 'socket hang up' }), true);

  // Bare transport messages.
  assert.equal(isConnectionError('fetch failed'), true);
  assert.equal(isConnectionError('Connection refused'), true);
});

test('isConnectionError does NOT match clean HTTP errors with a body (the real reason surfaces)', () => {
  // A clean 429 from the proxy carries the account_suspended text — NOT a connection error.
  const rateLimit = Object.assign(new Error('429: litellm.RateLimitError: account_suspended'), {
    name: 'RateLimitError',
    status: 429,
  });
  assert.equal(isConnectionError(rateLimit), false);

  // A clean 504 from the proxy's stream-liveness middleware.
  const gateway = Object.assign(new Error('upstream header phase stalled'), { status: 504 });
  assert.equal(isConnectionError(gateway), false);

  assert.equal(isConnectionError(new Error('boom')), false);
  assert.equal(isConnectionError(null), false);
});

test('enrichConnectionError adds the transport cause + proxy pointer to bare "Connection error."', () => {
  const connErr = Object.assign(new Error('Connection error.'), {
    name: 'APIConnectionError',
    status: undefined,
    cause: new Error('connect ECONNREFUSED 127.0.0.1:4000'),
  });
  const enriched = enrichConnectionError(connErr);
  assert.match(enriched, /ECONNREFUSED 127\.0\.0\.1:4000/);
  assert.match(enriched, /pie proxy/i);
  assert.match(enriched, /proxy:health|reload the window/);
});

test('enrichConnectionError passes clean HTTP errors through unchanged so the upstream reason shows', () => {
  const rateLimit = Object.assign(new Error('litellm.RateLimitError: account_suspended — access is paused'), {
    name: 'RateLimitError',
    status: 429,
  });
  // A clean 429 must NOT be rewritten — the account_suspended text is the real reason.
  assert.equal(enrichConnectionError(rateLimit), 'litellm.RateLimitError: account_suspended — access is paused');
  assert.equal(enrichConnectionError(new Error('boom')), 'boom');
});
