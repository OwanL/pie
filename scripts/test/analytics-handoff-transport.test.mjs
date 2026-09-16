import assert from 'node:assert/strict';
import { createConnection, createServer } from 'node:net';
import test from 'node:test';

import { retryStalledAnalyticsDiscovery, sendBoundedAnalyticsFrame } from '../analytics-handoff-transport.mjs';

/** The script-owned transport regression suite. The compiled sender's
 * combined `socket.end(frame)` write+half-close races the extension host's
 * end-without-frame guard and closes the connection without a response; the
 * script-owned sender must half-close only after the frame write flushes.
 * Servers mirror the host control endpoint: allowHalfOpen, reading, and
 * held-socket cleanup so `server.close` can always settle. */

function recordingSocket() {
  const events = new Map();
  const callOrder = [];
  return {
    socket: {
      setEncoding() { callOrder.push('setEncoding'); },
      setTimeout(_ms, handler) { events.set('timeout', handler); },
      once(event, handler) { events.set(event, handler); },
      on(event, handler) { events.set(event, handler); },
      write(frame, flushed) { callOrder.push(`write:${frame}`); setImmediate(() => flushed()); },
      end(data) { callOrder.push(data === undefined ? 'end' : `end:${data}`); },
      destroy() { this.destroyedFlag = true; callOrder.push('destroy'); },
      get destroyed() { return this.destroyedFlag === true; },
      destroyedFlag: false,
    },
    emit(event, ...payload) { const handler = events.get(event); if (handler) handler(...payload); },
    callOrder: () => callOrder,
  };
}

function localEndpointFactory() {
  return (name) => {
    const [host, port] = name.split(':');
    return createConnection({ host, port: Number(port) });
  };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `127.0.0.1:${server.address().port}`;
}

test('half-closes only after the frame write flushes', async () => {
  const recording = recordingSocket();
  const pending = sendBoundedAnalyticsFrame('pie-test-pipe', { requestId: 'r1' }, 1_000, () => recording.socket);
  assert.deepEqual(recording.callOrder(), ['setEncoding']);
  recording.emit('connect');
  const writeIndex = recording.callOrder().findIndex((entry) => entry.startsWith('write:'));
  assert.equal(writeIndex, 1, 'frame is written immediately on connect');
  assert.match(recording.callOrder()[writeIndex], /"requestId":"r1"/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(recording.callOrder().filter((entry) => entry.startsWith('end')), ['end'],
    'end() is called with no data, from the write flush callback');
  recording.emit('data', '{"ok":true}\n');
  assert.deepEqual(await pending, { ok: true });
});

test('resolves the single newline-terminated response frame', async () => {
  const heldSockets = new Set();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    heldSockets.add(socket);
    socket.once('close', () => heldSockets.delete(socket));
    socket.setEncoding('utf8');
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      if (!chunk.includes('\n')) return;
      const request = JSON.parse(chunk.slice(0, chunk.indexOf('\n')));
      socket.end(JSON.stringify({ ok: true, requestId: request.requestId, saw: 'frame-then-end' }) + '\n');
    });
  });
  const endpoint = await listen(server);
  try {
    const response = await sendBoundedAnalyticsFrame(endpoint, { requestId: 'probe-1' }, 5_000, localEndpointFactory());
    assert.deepEqual(response, { ok: true, requestId: 'probe-1', saw: 'frame-then-end' });
  } finally {
    for (const socket of heldSockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('an end-before-frame guard host still answers the deferred half-close', async () => {
  const heldSockets = new Set();
  // Mimic the extension host guard: if the half-close arrives before the
  // frame is accepted, destroy silently. The compiled sender loses this race
  // on the extension host runtime; the script-owned sender must not.
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    heldSockets.add(socket);
    socket.once('close', () => heldSockets.delete(socket));
    let frameAccepted = false;
    socket.setEncoding('utf8');
    socket.once('end', () => { if (!frameAccepted) socket.destroy(); });
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      frameAccepted = true;
      socket.end(JSON.stringify({ ok: true, guarded: chunk.trimEnd().endsWith('}') }) + '\n');
    });
  });
  const endpoint = await listen(server);
  try {
    const response = await sendBoundedAnalyticsFrame(endpoint, { requestId: 'guarded' }, 5_000, localEndpointFactory());
    assert.deepEqual(response, { ok: true, guarded: true });
  } finally {
    for (const socket of heldSockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('rejects when the endpoint never answers within the timeout', async () => {
  const heldSockets = new Set();
  // Mirrors the host control endpoint: allowHalfOpen, reads, never replies;
  // the client's idle timeout is the only way out.
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    heldSockets.add(socket);
    socket.once('close', () => heldSockets.delete(socket));
    socket.setEncoding('utf8');
    socket.on('data', () => undefined);
    socket.on('error', () => undefined);
  });
  const endpoint = await listen(server);
  try {
    await assert.rejects(
      sendBoundedAnalyticsFrame(endpoint, { requestId: 'slow' }, 250, localEndpointFactory()),
      /timed out/,
    );
  } finally {
    for (const socket of heldSockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('discovery retry re-runs only while every reason is an authenticated-probe failure', async () => {
  const stallResult = { complete: false, hosts: [], reasons: [{ code: 'host-authentication-failed', hostInstanceId: 'h1', processId: 1 }] };
  let calls = 0;
  const recovered = await retryStalledAnalyticsDiscovery(() => {
    calls += 1;
    return calls < 3 ? stallResult : { complete: true, hosts: [{ hostInstanceId: 'h1' }], reasons: [] };
  }, 4, 1);
  assert.equal(calls, 3, 'retries until the census completes');
  assert.deepEqual(recovered, { complete: true, hosts: [{ hostInstanceId: 'h1' }], reasons: [] });

  let realFailureCalls = 0;
  const leaseMismatch = { complete: false, hosts: [], reasons: [
    { code: 'host-authentication-failed', hostInstanceId: 'h1', processId: 1 },
    { code: 'runtime-lease-identity-mismatch', processId: 1 },
  ] };
  await retryStalledAnalyticsDiscovery(() => {
    realFailureCalls += 1;
    return leaseMismatch;
  }, 4, 1);
  assert.equal(realFailureCalls, 1, 'a non-probe reason stops retrying immediately');

  let exhaustedCalls = 0;
  const stillStalled = await retryStalledAnalyticsDiscovery(() => {
    exhaustedCalls += 1;
    return stallResult;
  }, 3, 1);
  assert.equal(exhaustedCalls, 3, 'stalls stop at the attempt bound');
  assert.deepEqual(stillStalled, stallResult, 'the last honest result is returned unchanged');
});

test('discovery retry waits use the requested spacing, not a hardcoded value', async () => {
  const stallResult = { complete: false, hosts: [], reasons: [{ code: 'host-authentication-failed', hostInstanceId: 'h1', processId: 1 }] };
  const attemptAt = [];
  await retryStalledAnalyticsDiscovery(() => {
    attemptAt.push(Date.now());
    return stallResult;
  }, 3, 150);
  assert.equal(attemptAt.length, 3, 'two stalls produce two waits');
  const firstGapMs = attemptAt[1] - attemptAt[0];
  const secondGapMs = attemptAt[2] - attemptAt[1];
  assert.ok(firstGapMs >= 140, `the first wait honors the 150ms spacing (gap ${firstGapMs}ms)`);
  assert.ok(secondGapMs >= 140, `the second wait honors the 150ms spacing (gap ${secondGapMs}ms)`);
  const totalMs = attemptAt[2] - attemptAt[0];
  assert.ok(totalMs < 2_000, `spacing stays bounded for the suite (total ${totalMs}ms)`);
});

test('rejects oversized request frames without connecting', async () => {
  await assert.rejects(
    sendBoundedAnalyticsFrame('pie-test-pipe', { payload: 'x'.repeat(64 * 1024) }, 1_000),
    /frame bound/,
  );
});

test('rejects multi-frame and malformed responses', async () => {
  const malformedRecording = recordingSocket();
  const malformed = sendBoundedAnalyticsFrame('pie-test-pipe', {}, 1_000, () => malformedRecording.socket);
  malformedRecording.emit('connect');
  malformedRecording.emit('data', 'not-json\n');
  await assert.rejects(malformed, SyntaxError);

  const multiRecording = recordingSocket();
  const twoFrames = sendBoundedAnalyticsFrame('pie-test-pipe', {}, 1_000, () => multiRecording.socket);
  multiRecording.emit('connect');
  multiRecording.emit('data', '{"ok":true}\n{"ok":true}\n');
  await assert.rejects(twoFrames, /more than one frame/);
});