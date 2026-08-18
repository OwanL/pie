/**
 * Browser renderer transport unit tests (browser server plan §4.2/§4.3/§5.3):
 * hello-first ordering, fail-closed ingress, pre-send gates, recovery, and
 * the RFC 6455 close-reason clamp — against a fake socket with a
 * deterministic clock.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket } from 'ws';

import { BrowserRendererTransport, BROWSER_CLOSE_REASONS } from '../../../src/host/browser-server/browser-renderer-transport';
import type { RendererRegistration } from '../../../src/host/renderers/types';
import type { HostToWebviewMessage, WebviewToHostMessage } from '../../../src/shared/protocol';
import { WEBVIEW_PROTOCOL_VERSION } from '../../../src/shared/protocol';

class FakeSocket {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: string[] = [];
  closed: Array<{ code: number; reason: string }> = [];
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

  on(event: string, listener: (...args: unknown[]) => void): void {
    (this.listeners[event] ??= []).push(listener);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners[event] ?? []) listener(...args);
  }

  send(frame: string): void {
    this.sent.push(frame);
  }

  close(code: number, reason: string): void {
    this.closed.push({ code, reason });
    // Real ws emits the close event after close(); the transport's onClose
    // bookkeeping runs from that event.
    this.emit('close', code, Buffer.from(reason));
  }
}

interface FakeRegistration {
  registration: RendererRegistration;
  resolved: boolean[];
  disposed: boolean[];
  visible: boolean[];
  focused: boolean[];
}

function createRegistration(): FakeRegistration {
  const state: FakeRegistration = {
    registration: null as unknown as RendererRegistration,
    resolved: [],
    disposed: [],
    visible: [],
    focused: [],
  };
  state.registration = {
    rendererId: 'renderer-1',
    kind: 'browser',
    getHostInstanceId: () => 'host-1',
    getViewGeneration: () => 7,
    getRendererGeneration: () => 3,
    getDebugState: () => ({ viewGeneration: 7 } as never),
    requestState: () => undefined,
    postSelectionState: () => undefined,
    postImperative: () => undefined,
    handleMessage: () => undefined,
    handleViewResolved: (visible: boolean) => state.resolved.push(visible),
    handleViewDisposed: () => state.disposed.push(true),
    handleReloadStart: () => undefined,
    setVisible: (visible: boolean) => state.visible.push(visible),
    setFocused: (focused: boolean) => state.focused.push(focused),
  } as unknown as RendererRegistration;
  return state;
}

interface Harness {
  socket: FakeSocket;
  transport: BrowserRendererTransport;
  registration: FakeRegistration;
  routed: WebviewToHostMessage[];
  timers: Array<() => void>;
  closed: Array<{ rendererId: string; code: number; reason: string }>;
}

function createHarness(): Harness {
  const socket = new FakeSocket();
  const registration = createRegistration();
  const routed: WebviewToHostMessage[] = [];
  const timers: Array<() => void> = [];
  const closed: Array<{ rendererId: string; code: number; reason: string }> = [];
  const transport = new BrowserRendererTransport(socket as unknown as WebSocket, {
    assetVersion: 'asset-1',
    now: () => 0,
    setTimeout: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout: (handle) => {
      // Real clearTimeout cancels the callback; the fake must too, or a
      // cleared handshake timer would still fire.
      const index = Number(handle) - 1;
      if (index >= 0 && index < timers.length) timers[index] = () => undefined;
    },
    onClose: (info) => closed.push(info),
  });
  transport.onMessage((message) => routed.push(message as WebviewToHostMessage));
  return { socket, transport, registration, routed, timers, closed };
}

test('start(): the hello is the first frame and carries the POST-resolution generation', () => {
  const { socket, transport, registration } = createHarness();
  transport.start(registration.registration);

  assert.equal(registration.resolved.length, 1, 'the view is resolved first (generation bump)');
  assert.equal(socket.sent.length, 1, 'exactly one frame on start');
  const hello = JSON.parse(socket.sent[0] ?? '{}') as Record<string, unknown>;
  assert.equal(hello.type, 'rendererHello');
  assert.equal(hello.protocolVersion, WEBVIEW_PROTOCOL_VERSION);
  assert.equal(hello.hostInstanceId, 'host-1');
  assert.equal(hello.rendererId, 'renderer-1');
  assert.equal(hello.rendererGeneration, 3);
  assert.equal(hello.viewGeneration, 7);
  assert.equal(hello.assetVersion, 'asset-1');
});

test('post(): gated until the hello is sent; dropped when the socket is not open or the frame is oversize', () => {
  const { socket, transport, registration } = createHarness();
  const message: HostToWebviewMessage = {
    type: 'state',
    protocolVersion: WEBVIEW_PROTOCOL_VERSION,
    hostInstanceId: 'host-1',
    rendererId: 'r',
    rendererGeneration: 1,
    viewGeneration: 1,
    revision: 1,
    expectedTranscriptIdentity: 'x',
    snapshotBytes: 10,
    state: {} as never,
  };

  assert.equal(transport.post(message), false, 'posts before start are gated (hello not sent yet)');
  transport.start(registration.registration);
  assert.equal(transport.post(message), true, 'posts after start are sent');
  assert.equal(socket.sent.length, 2);

  socket.readyState = WebSocket.CLOSED;
  assert.equal(transport.post(message), false, 'a closed socket never posts');
  socket.readyState = WebSocket.OPEN;
  socket.bufferedAmount = 8 * 1024 * 1024 + 1;
  assert.equal(transport.post(message), false, 'high-water gate drops the post (latest-wins)');
  assert.equal(socket.sent.length, 2, 'the dropped post never reaches the socket');
  socket.bufferedAmount = 0;
});

test('ingress: valid messages route; lifecycle messages update the session directly', () => {
  const { socket, transport, registration, routed } = createHarness();
  transport.start(registration.registration);

  socket.emit('message', JSON.stringify({ type: 'ready', viewGeneration: 7 }), false);
  assert.equal(routed.length, 1);
  assert.equal(routed[0]?.type, 'ready');

  socket.emit('message', JSON.stringify({ type: 'rendererVisibilityChanged', visible: false }), false);
  assert.equal(routed.length, 1, 'lifecycle messages never route');
  assert.deepEqual(registration.visible, [false]);

  socket.emit('message', JSON.stringify({ type: 'rendererFocusChanged', focused: true }), false);
  assert.equal(routed.length, 1);
  assert.deepEqual(registration.focused, [true]);
});

test('ingress: binary frames, unparseable JSON, and unknown fields are never routed', () => {
  const { socket, transport, registration, routed } = createHarness();
  transport.start(registration.registration);

  socket.emit('message', Buffer.from('binary'), true);
  socket.emit('message', '{not json', false);
  socket.emit('message', JSON.stringify({ type: 'newSession', clientCommandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', evil: true }), false);
  socket.emit('message', JSON.stringify({ type: 'newSession' }), false);

  assert.equal(routed.length, 0, 'nothing invalid is ever routed');
});

test('ingress: the violation rate bound closes the socket with a typed reason', () => {
  const { socket, transport, registration, closed } = createHarness();
  transport.start(registration.registration);

  for (let index = 0; index < 5; index += 1) {
    socket.emit('message', '{not json', false);
  }
  assert.equal(closed.length, 1);
  assert.equal(closed[0]?.reason, BROWSER_CLOSE_REASONS.malformedRate);
  assert.equal(closed[0]?.code, 1008);
  assert.equal(closed[0]?.rendererId, 'renderer-1');
  assert.equal(socket.closed[0]?.reason, BROWSER_CLOSE_REASONS.malformedRate);
});

test('handshake bound: a socket that never sends a valid message is closed by the deterministic clock', () => {
  const { socket, transport, registration, timers, closed } = createHarness();
  transport.start(registration.registration);
  assert.equal(timers.length, 1, 'the handshake timer is armed on start');

  for (const timer of timers.splice(0)) timer();
  assert.equal(closed.length, 1);
  assert.equal(closed[0]?.reason, BROWSER_CLOSE_REASONS.handshakeTimeout);

  // A valid inbound message clears the bound.
  const second = createHarness();
  second.transport.start(second.registration.registration);
  second.socket.emit('message', JSON.stringify({ type: 'ready', viewGeneration: 7 }), false);
  for (const timer of second.timers.splice(0)) timer();
  assert.equal(second.closed.length, 0, 'a live socket is never handshake-closed');
});

test('recover(): closes the socket; a recovery: prefix is preserved', () => {
  const { socket, transport, registration, closed } = createHarness();
  transport.start(registration.registration);

  transport.recover('recovery:watchdog');
  assert.equal(closed.length, 1);
  assert.equal(closed[0]?.reason, 'recovery:watchdog');

  const second = createHarness();
  second.transport.start(second.registration.registration);
  second.transport.recover('some-other-reason');
  assert.equal(second.closed[0]?.reason, BROWSER_CLOSE_REASONS.recovery);
});

test('closeSocket(): idempotent, typed, and clamps the reason to 123 UTF-8 bytes', () => {
  const { socket, transport, registration, closed } = createHarness();
  transport.start(registration.registration);

  const longReason = 'x'.repeat(300);
  transport.closeSocket(longReason);
  assert.equal(closed.length, 1);
  assert.equal(closed[0]?.reason, longReason, 'the onClose report keeps the full reason');
  assert.ok(Buffer.byteLength(socket.closed[0]?.reason ?? '', 'utf8') <= 123, 'the wire reason is clamped to RFC 6455');

  transport.closeSocket('again');
  assert.equal(closed.length, 1, 'close is idempotent');
});

test('dispose(): closes with server-shutdown and disposes the session view', () => {
  const { socket, transport, registration, closed } = createHarness();
  transport.start(registration.registration);

  transport.dispose();
  assert.equal(closed.length, 1);
  assert.equal(closed[0]?.reason, BROWSER_CLOSE_REASONS.serverShutdown);
  assert.equal(registration.disposed.length, 1);
  assert.equal(transport.isAttached(), false);
});

test('a peer close runs the same teardown and reports the peer reason', () => {
  const { socket, transport, registration, closed } = createHarness();
  transport.start(registration.registration);

  socket.emit('close', 1006, Buffer.from('peer-gone'));
  assert.equal(closed.length, 1);
  assert.equal(closed[0]?.code, 1006);
  assert.equal(closed[0]?.reason, 'peer-gone');
  assert.equal(registration.disposed.length, 1);
  assert.equal(transport.isAttached(), false);
});
