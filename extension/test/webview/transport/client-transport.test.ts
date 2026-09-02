/**
 * Client transport tests (browser server plan §4.3): the browser transport's
 * rendererHello identity replacement, ready/refreshState handshake, reconnect
 * backoff, outbound bounds, and lifecycle sends; the VS Code transport's
 * HTML-stamped metadata and window-message channel.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { HostToWebviewMessage, WebviewToHostMessage } from '../../../src/shared/protocol';
import { PIE_BUILD_ID, WEBVIEW_PROTOCOL_VERSION } from '../../../src/shared/protocol';
import { BrowserClientTransport, VsCodeClientTransport } from '../../../src/webview/transport/client-transport';
import { pendingCommandStore } from '../../../src/webview/transport/pending-command-store';

// ─── Fake browser environment (installed before the transports run) ─────────

const windowMessageListeners: Array<(event: { data: unknown }) => void> = [];
const metaTags = new Map<string, string>();
const vscodePosted: WebviewToHostMessage[] = [];

(globalThis as Record<string, unknown>).window = {
  location: { protocol: 'http:', host: '127.0.0.1:1997' },
  addEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
    if (type === 'message') windowMessageListeners.push(listener);
  },
  removeEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
    if (type === 'message') {
      const index = windowMessageListeners.indexOf(listener);
      if (index >= 0) windowMessageListeners.splice(index, 1);
    }
  },
};
(globalThis as Record<string, unknown>).document = {
  hidden: false,
  hasFocus: () => true,
  querySelector: (selector: string) => {
    const name = /name="([^"]+)"/.exec(selector)?.[1];
    const content = name === undefined ? undefined : metaTags.get(name);
    return content === undefined
      ? null
      : { getAttribute: (attr: string) => (attr === 'content' ? content : null) };
  },
};
(globalThis as Record<string, unknown>).acquireVsCodeApi = () => ({
  postMessage: (message: WebviewToHostMessage) => vscodePosted.push(message),
  getState: () => null,
  setState: () => undefined,
});

let socketInstances: FakeWebSocket[] = [];
class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  throwOnSend = false;
  closed: Array<{ code: number; reason: string }> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public readonly url: string) {
    socketInstances.push(this);
  }

  send(frame: string): void {
    if (this.throwOnSend) throw new Error('socket closed during send');
    this.sent.push(frame);
  }

  close(code: number, reason: string): void {
    this.closed.push({ code, reason });
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  peerClose(code = 1006, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}
(globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;

interface Harness {
  transport: BrowserClientTransport;
  timers: Array<{ callback: () => void; delayMs: number }>;
  handshakes: Array<{ rendererId: string; viewGeneration: number }>;
  states: string[];
}

function createBrowserHarness(): Harness {
  socketInstances = [];
  const timers: Array<{ callback: () => void; delayMs: number }> = [];
  const handshakes: Array<{ rendererId: string; viewGeneration: number }> = [];
  const states: string[] = [];
  const transport = new BrowserClientTransport({
    wsRoute: '/ws',
    onHandshake: (identity) => handshakes.push({ rendererId: identity.rendererId, viewGeneration: identity.viewGeneration }),
    now: () => 0,
    setTimeout: (callback, delayMs) => {
      timers.push({ callback, delayMs });
      return timers.length;
    },
    clearTimeout: () => undefined,
  });
  transport.onConnectionStateChange((state) => states.push(state));
  return { transport, timers, handshakes, states };
}

function sendHello(socket: FakeWebSocket, viewGeneration = 5): void {
  socket.onmessage?.({ data: JSON.stringify({
    type: 'rendererHello',
    protocolVersion: WEBVIEW_PROTOCOL_VERSION,
    buildId: PIE_BUILD_ID,
    hostInstanceId: 'host-1',
    rendererId: 'renderer-9',
    rendererGeneration: 2,
    viewGeneration,
    assetVersion: 'asset-1',
  }) });
}

test('connect(): stays connecting until rendererHello completes the application handshake', () => {
  const { transport, states } = createBrowserHarness();
  assert.equal(transport.getConnectionState(), 'connecting', 'the initial state is connecting');
  transport.connect();
  assert.equal(socketInstances.length, 1);
  assert.equal(socketInstances[0]?.url, 'ws://127.0.0.1:1997/ws');
  assert.deepEqual(states, ['connecting'], 'subscription receives the current state');
  socketInstances[0]?.onopen?.();
  assert.deepEqual(states, ['connecting'], 'an open socket is not connected before rendererHello');
  sendHello(socketInstances[0]!);
  assert.deepEqual(states, ['connecting', 'connected']);
});

test('a rendererHello from another build remains connected when the protocol matches', () => {
  const { transport, states, timers, handshakes } = createBrowserHarness();
  transport.connect();
  const socket = socketInstances[0]!;
  socket.onmessage?.({ data: JSON.stringify({
    type: 'rendererHello',
    protocolVersion: WEBVIEW_PROTOCOL_VERSION,
    buildId: 'stale-build',
    hostInstanceId: 'host-1',
    rendererId: 'renderer-9',
    rendererGeneration: 2,
    viewGeneration: 5,
    assetVersion: 'asset-1',
  }) });

  assert.equal(transport.getConnectionState(), 'connected');
  assert.deepEqual(states, ['connecting', 'connected']);
  assert.deepEqual(handshakes, [{ rendererId: 'renderer-9', viewGeneration: 5 }]);
  assert.equal(socket.sent.length, 4, 'the ordinary handshake completes across build skew');
  assert.deepEqual(socket.closed, []);
  assert.equal(timers.length, 0);
});

test('an incompatible rendererHello protocol fails closed', () => {
  const { transport, states, timers, handshakes } = createBrowserHarness();
  transport.connect();
  const socket = socketInstances[0]!;
  socket.onmessage?.({ data: JSON.stringify({
    type: 'rendererHello',
    protocolVersion: WEBVIEW_PROTOCOL_VERSION + 1,
    buildId: PIE_BUILD_ID,
    hostInstanceId: 'host-1',
    rendererId: 'renderer-9',
    rendererGeneration: 2,
    viewGeneration: 5,
    assetVersion: 'asset-1',
  }) });

  assert.equal(transport.getConnectionState(), 'reload-required');
  assert.deepEqual(states, ['connecting', 'reload-required']);
  assert.deepEqual(handshakes, []);
  assert.deepEqual(socket.sent, [], 'no frame crosses an incompatible protocol boundary');
  assert.equal(socket.closed[0]?.reason, 'protocol-violation');
  assert.equal(timers.length, 0);
});

test('a malformed or duplicate rendererHello never replaces live identity', () => {
  const malformed = createBrowserHarness();
  malformed.transport.connect();
  const malformedSocket = socketInstances[0]!;
  malformedSocket.onmessage?.({ data: JSON.stringify({
    type: 'rendererHello', protocolVersion: WEBVIEW_PROTOCOL_VERSION, buildId: PIE_BUILD_ID,
  }) });
  assert.equal(malformed.transport.getConnectionState(), 'reload-required');
  assert.equal(malformedSocket.closed[0]?.reason, 'invalid-renderer-hello');

  const duplicate = createBrowserHarness();
  duplicate.transport.connect();
  const duplicateSocket = socketInstances[0]!;
  sendHello(duplicateSocket);
  sendHello(duplicateSocket, 6);
  assert.equal(duplicate.transport.getConnectionState(), 'reload-required');
  assert.equal(duplicateSocket.closed[0]?.reason, 'invalid-renderer-hello');
});

test('a subscriber attached after rendererHello immediately observes connected', () => {
  socketInstances = [];
  const transport = new BrowserClientTransport({ wsRoute: '/ws' });
  transport.connect();
  sendHello(socketInstances[0]!);

  const states: string[] = [];
  transport.onConnectionStateChange((state) => states.push(state));

  assert.deepEqual(states, ['connected']);
  transport.dispose();
});

test('rendererHello replaces the identity and sends ready + refreshState with the LIVE view generation', () => {
  const { transport, handshakes } = createBrowserHarness();
  transport.connect();
  const socket = socketInstances[0]!;
  socket.onopen?.();
  sendHello(socket, 5);

  assert.deepEqual(handshakes, [{ rendererId: 'renderer-9', viewGeneration: 5 }]);
  const frames = socket.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  assert.equal(frames.length, 4);
  assert.deepEqual(frames[0], { type: 'ready', buildId: PIE_BUILD_ID, viewGeneration: 5 });
  assert.deepEqual(frames[1], { type: 'refreshState', buildId: PIE_BUILD_ID, viewGeneration: 5 });
  assert.deepEqual(frames[2], { type: 'rendererVisibilityChanged', visible: true, viewGeneration: 5 });
  assert.deepEqual(frames[3], { type: 'rendererFocusChanged', focused: true, viewGeneration: 5 });
});

test('rendererHello sends ready before an onHandshake reconciliation command', () => {
  socketInstances = [];
  let readyPrecededConnectedObserver = false;
  const transport = new BrowserClientTransport({
    wsRoute: '/ws',
    onHandshake: () => {
      assert.equal(transport.postMessage({
        type: 'commandStatusRequest',
        clientCommandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }), true);
    },
  });
  transport.onConnectionStateChange((state) => {
    if (state !== 'connected') return;
    const firstFrame = socketInstances[0]?.sent[0];
    readyPrecededConnectedObserver = firstFrame !== undefined
      && (JSON.parse(firstFrame) as { type?: string }).type === 'ready';
  });
  transport.connect();
  const socket = socketInstances[0]!;

  sendHello(socket, 5);

  const frames = socket.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  assert.deepEqual(frames[0], {
    type: 'ready',
    buildId: PIE_BUILD_ID,
    viewGeneration: 5,
  }, 'ready remains the first client frame even when reconciliation posts synchronously');
  assert.deepEqual(frames[1], {
    type: 'commandStatusRequest',
    clientCommandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    viewGeneration: 5,
  });
  assert.equal(readyPrecededConnectedObserver, true, 'ready also precedes connected-state observers');
  transport.dispose();
});

test('postMessage(): dropped while disconnected or before the hello; stamped after', () => {
  const { transport } = createBrowserHarness();
  transport.connect();
  const socket = socketInstances[0]!;

  assert.equal(transport.postMessage({ type: 'refreshState' }), false, 'no socket identity yet');
  socket.onopen?.();
  assert.equal(transport.postMessage({ type: 'refreshState' }), false, 'hello not yet received');
  sendHello(socket, 5);

  assert.equal(transport.postMessage({ type: 'refreshState' }), true);
  const frame = JSON.parse(socket.sent[socket.sent.length - 1] ?? '{}') as Record<string, unknown>;
  assert.equal(frame.viewGeneration, 5, 'outbound messages carry the live view generation');

  socket.readyState = FakeWebSocket.CLOSED;
  assert.equal(transport.postMessage({ type: 'refreshState' }), false, 'a closed socket never posts');
});

test('application commands are minted a clientCommandId and tracked', () => {
  const { transport } = createBrowserHarness();
  transport.connect();
  const socket = socketInstances[0]!;
  socket.onopen?.();
  sendHello(socket, 5);

  assert.equal(transport.postMessage({ type: 'newSession' }), true);
  const frame = JSON.parse(socket.sent[socket.sent.length - 1] ?? '{}') as Record<string, unknown>;
  assert.match(String(frame.clientCommandId), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(frame.viewGeneration, 5);
});

test('an oversize outbound frame is dropped before send (32 MiB bound)', () => {
  const { transport } = createBrowserHarness();
  transport.connect();
  const socket = socketInstances[0]!;
  socket.onopen?.();
  sendHello(socket, 5);

  const huge = 'x'.repeat(33 * 1024 * 1024);
  assert.equal(transport.postMessage({ type: 'send', sessionPath: '/session/a', text: huge, localId: 'l' }), false);
  assert.equal(socket.sent.length, 4, 'only the handshake/lifecycle frames were sent');
});

test('a socket-close send race drops the command without retaining an uncertain decision', () => {
  const { transport } = createBrowserHarness();
  transport.connect();
  const socket = socketInstances[0]!;
  socket.onopen?.();
  sendHello(socket, 5);

  const pendingBefore = pendingCommandStore.size();
  socket.throwOnSend = true;

  assert.equal(transport.postMessage({ type: 'newSession' }), false);
  assert.equal(
    pendingCommandStore.size(),
    pendingBefore,
    'a command the socket never accepted is not left pending for reconciliation',
  );
});

test('onclose: disconnected state + exponential reconnect backoff (1s → 2s → 4s, capped at 30s)', () => {
  const originalRandom = Math.random;
  Math.random = () => 0.5; // deterministic jitter
  try {
    const { transport, timers, states } = createBrowserHarness();
    transport.connect();
    socketInstances[0]?.onopen?.();
    sendHello(socketInstances[0]!);
    socketInstances[0]?.peerClose();

    assert.deepEqual(states, ['connecting', 'connected', 'disconnected']);
    assert.equal(timers.length, 1);
    assert.equal(timers[0]?.delayMs, 1000);

    timers[0]?.callback();
    assert.equal(socketInstances.length, 2, 'reconnect opens a fresh socket');
    socketInstances[1]?.peerClose();
    assert.equal(timers[1]?.delayMs, 2000);

    timers[1]?.callback();
    socketInstances[2]?.peerClose();
    assert.equal(timers[2]?.delayMs, 4000);

    // Cap: drive the attempt counter to the max and assert the 30s ceiling.
    for (let index = 3; index < 8; index += 1) {
      timers[index - 1]?.callback();
      socketInstances[index]?.peerClose();
    }
    assert.equal(timers[7]?.delayMs, 30_000, 'backoff is capped at 30s');
  } finally {
    Math.random = originalRandom;
  }
});

test('a failed ready send does not reset reconnect backoff', () => {
  const originalRandom = Math.random;
  Math.random = () => 0.5;
  try {
    const { transport, timers } = createBrowserHarness();
    transport.connect();
    socketInstances[0]?.peerClose();
    assert.equal(timers[0]?.delayMs, 1000);

    timers[0]?.callback();
    const retrySocket = socketInstances[1]!;
    retrySocket.throwOnSend = true;
    sendHello(retrySocket);

    assert.equal(retrySocket.sent.length, 0, 'the ready frame never reached the socket');
    assert.equal(retrySocket.closed[0]?.reason, 'ready-send-failed');
    assert.equal(timers[1]?.delayMs, 2000, 'the failed application handshake retains exponential backoff');
  } finally {
    Math.random = originalRandom;
  }
});

test('terminal policy closes latch reload-required and never reconnect', () => {
  for (const reason of ['ready-required', 'renderer-asset-mismatch', 'protocol-violation', 'invalid-renderer-hello']) {
    const { transport, timers, states } = createBrowserHarness();
    transport.connect();
    socketInstances[0]?.peerClose(1008, reason);

    assert.equal(transport.getConnectionState(), 'reload-required', reason);
    assert.deepEqual(states, ['connecting', 'reload-required'], reason);
    assert.equal(timers.length, 0, `${reason} must not arm a reconnect`);
    transport.connect();
    assert.equal(socketInstances.length, 1, `${reason} must remain latched`);
  }
});

test('dispose(): cancels the reconnect timer and closes the socket permanently', () => {
  const { transport, timers } = createBrowserHarness();
  transport.connect();
  const socket = socketInstances[0]!;

  // Dispose while connected: the socket is closed with the dispose reason.
  transport.dispose();
  assert.equal(socket.closed[0]?.reason, 'client-dispose');
  assert.equal(timers.length, 0, 'no reconnect is scheduled after dispose');

  // Dispose after a peer close: the reconnect timer is cancelled.
  const second = createBrowserHarness();
  second.transport.connect();
  socketInstances[0]?.peerClose();
  assert.equal(second.timers.length, 1);
  second.transport.dispose();
  second.timers[0]?.callback();
  assert.equal(socketInstances.length, 1, 'no reconnect after dispose');
});

test('sendLifecycle(): visibility/focus carry the live view generation', () => {
  const { transport } = createBrowserHarness();
  transport.connect();
  const socket = socketInstances[0]!;
  socket.onopen?.();
  sendHello(socket, 5);

  transport.sendLifecycle('rendererVisibilityChanged', false);
  transport.sendLifecycle('rendererFocusChanged', true);
  const frames = socket.sent.slice(4).map((frame) => JSON.parse(frame) as Record<string, unknown>);
  assert.deepEqual(frames, [
    { type: 'rendererVisibilityChanged', visible: false, viewGeneration: 5 },
    { type: 'rendererFocusChanged', focused: true, viewGeneration: 5 },
  ]);
});

test('VsCodeClientTransport: HTML-stamped metadata on handshake messages, window-message dispatch', () => {
  metaTags.set('pie-asset-version', 'asset-9');
  metaTags.set('pie-view-generation', '3');
  vscodePosted.length = 0;

  const transport = new VsCodeClientTransport();
  assert.equal(transport.getConnectionState(), 'connected');

  const received: HostToWebviewMessage[] = [];
  transport.subscribe((message) => received.push(message));

  transport.postMessage({ type: 'ready' });
  assert.deepEqual(vscodePosted[0], {
    type: 'ready', assetVersion: 'asset-9', buildId: PIE_BUILD_ID, viewGeneration: 3,
  });

  transport.postMessage({ type: 'send', sessionPath: '/session/a', text: 'hi', localId: 'l' });
  assert.equal((vscodePosted[1] as { viewGeneration?: number }).viewGeneration, 3, 'commands carry the stamped generation');

  // Host messages arrive through the window channel; malformed frames are dropped.
  windowMessageListeners.forEach((listener) => listener({ data: { type: 'state', revision: 1 } }));
  windowMessageListeners.forEach((listener) => listener({ data: { notTyped: true } }));
  assert.equal(received.length, 1);
  assert.equal((received[0] as { type?: string }).type, 'state');

  transport.dispose();
  windowMessageListeners.forEach((listener) => listener({ data: { type: 'state', revision: 2 } }));
  assert.equal(received.length, 1, 'disposed transports stop dispatching');
});
