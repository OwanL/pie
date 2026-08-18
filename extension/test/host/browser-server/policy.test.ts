/**
 * Browser server policy tests (browser server plan §5.3/§6.3/§4.1): pure
 * Host/Origin validation, pre-send gates, and the violation rate tracker.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BROWSER_SERVER_POLICY,
  evaluateSendGate,
  isValidLoopbackHostHeader,
  isValidPort,
  isValidWebSocketOrigin,
  pageUrl,
  servedOrigin,
  ViolationRateTracker,
} from '../../../src/host/browser-server/policy';

test('Host header: exact loopback host:port accepted; everything else rejected', () => {
  assert.equal(isValidLoopbackHostHeader('127.0.0.1:1997', 1997), true);
  assert.equal(isValidLoopbackHostHeader('localhost:1997', 1997), true);
  assert.equal(isValidLoopbackHostHeader('[::1]:1997', 1997), true);
  assert.equal(isValidLoopbackHostHeader('[::1]', 1997), true);

  // Foreign hosts, mismatched ports, and malformed headers.
  assert.equal(isValidLoopbackHostHeader('192.168.1.5:1997', 1997), false);
  assert.equal(isValidLoopbackHostHeader('evil.example:1997', 1997), false);
  assert.equal(isValidLoopbackHostHeader('127.0.0.1:9999', 1997), false);
  assert.equal(isValidLoopbackHostHeader('127.0.0.1', 1997), false, 'loopback ports are ephemeral: the port must be present');
  assert.equal(isValidLoopbackHostHeader('127.0.0.1:1997/path', 1997), false);
  assert.equal(isValidLoopbackHostHeader('user@127.0.0.1:1997', 1997), false);
  assert.equal(isValidLoopbackHostHeader('127.0.0.1:1997?x=1', 1997), false);
  assert.equal(isValidLoopbackHostHeader('127.0.0.1:1997#frag', 1997), false);
  assert.equal(isValidLoopbackHostHeader('127.0.0.1:abc', 1997), false);
  assert.equal(isValidLoopbackHostHeader('', 1997), false);
  assert.equal(isValidLoopbackHostHeader(undefined, 1997), false);
  assert.equal(isValidLoopbackHostHeader('a'.repeat(300), 1997), false);
});

test('WebSocket Origin: only the exact served origin is accepted', () => {
  assert.equal(isValidWebSocketOrigin('http://127.0.0.1:1997', 1997), true);
  assert.equal(isValidWebSocketOrigin('http://localhost:1997', 1997), false, 'the served HTML never uses localhost');
  assert.equal(isValidWebSocketOrigin('http://127.0.0.1:9999', 1997), false);
  assert.equal(isValidWebSocketOrigin('https://127.0.0.1:1997', 1997), false);
  assert.equal(isValidWebSocketOrigin('http://evil.example', 1997), false);
  assert.equal(isValidWebSocketOrigin('null', 1997), false);
  assert.equal(isValidWebSocketOrigin('', 1997), false);
  assert.equal(isValidWebSocketOrigin(undefined, 1997), false);
  assert.equal(isValidWebSocketOrigin('http://127.0.0.1:1997'.padEnd(600, 'x'), 1997), false);
});

test('served origin / page URL / port validation', () => {
  assert.equal(servedOrigin(1997), 'http://127.0.0.1:1997');
  assert.equal(pageUrl(1997), 'http://127.0.0.1:1997/');
  assert.equal(isValidPort(1997), true);
  assert.equal(isValidPort(1), true);
  assert.equal(isValidPort(65535), true);
  assert.equal(isValidPort(0), false);
  assert.equal(isValidPort(65536), false);
  assert.equal(isValidPort(1.5), false);
  assert.equal(isValidPort(Number.NaN), false);
});

test('pre-send gate: high-water and combined-frame bounds', () => {
  const highWater = BROWSER_SERVER_POLICY.bufferedAmountHighWaterBytes;
  const maxFrame = BROWSER_SERVER_POLICY.maxFrameBytes;

  assert.deepEqual(evaluateSendGate(0, 1024), { ok: true });
  assert.deepEqual(evaluateSendGate(highWater, 0), { ok: true }, 'the high-water bound is strictly greater-than');
  assert.deepEqual(evaluateSendGate(highWater + 1, 0), { ok: false, reason: 'buffered-amount-high-water' });
  assert.deepEqual(evaluateSendGate(0, maxFrame), { ok: true });
  assert.deepEqual(evaluateSendGate(0, maxFrame + 1), { ok: false, reason: 'combined-frame-over-limit' });
  // Below the high-water, a frame that pushes the combined total over the
  // frame cap trips the combined bound (the high-water check fires first
  // once bufferedAmount exceeds it).
  assert.deepEqual(evaluateSendGate(highWater - 1, maxFrame - highWater + 2), { ok: false, reason: 'combined-frame-over-limit' });
  assert.deepEqual(evaluateSendGate(-1, 0), { ok: false, reason: 'buffered-amount-high-water' });
  assert.deepEqual(evaluateSendGate(0, Number.NaN), { ok: false, reason: 'combined-frame-over-limit' });
});

test('violation rate tracker: trips at the bound within the window, resets outside', () => {
  let now = 0;
  const tracker = new ViolationRateTracker(5, 60_000, () => now);

  for (let index = 0; index < 4; index += 1) {
    assert.equal(tracker.record(), false, `violation ${index + 1} of 5 must not trip`);
  }
  assert.equal(tracker.record(), true, 'the 5th violation within the window trips');

  // A fresh window (violations older than 60s are dropped) resets the count.
  now = 61_000;
  assert.equal(tracker.record(), false, 'expired violations do not count');
  tracker.reset();
  assert.equal(tracker.record(), false);
});
