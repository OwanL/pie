/**
 * Regression tests for LAN insecure-context UUID failures.
 *
 * Browsers served over plain `http://<lan-ip>` are insecure contexts:
 * `crypto.randomUUID()` exists only in secure contexts, so every unguarded
 * call throws and the mobile renderer cannot send ANY application command
 * (settings, tabs, prompts). These tests simulate that environment —
 * `crypto.getRandomValues` present, `randomUUID` absent — and require the
 * real client-transport command frames and the local-message-id prompt path
 * to still mint UUID v4 ids with secure entropy (never `Math.random`).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

// Side-effect first: install the fake `window.sessionStorage` BEFORE the
// pending-command store singleton is constructed (imports run in order).
import { storageWrites } from './setup-session-storage';
import type { WebviewToHostMessage } from '../../../src/shared/protocol';
import { PIE_BUILD_ID, WEBVIEW_PROTOCOL_VERSION } from '../../../src/shared/protocol';
import { createLocalMessageId } from '../../../src/shared/local-message-id';
import { BrowserClientTransport } from '../../../src/webview/transport/client-transport';

// Augment the fake window installed above with the browser fields the
// transport needs (location, message listeners) WITHOUT replacing its
// `sessionStorage` — the pending-command mirror must keep recording writes.
const installedWindow = (globalThis as Record<string, unknown>).window as Record<string, unknown>;
Object.assign(installedWindow, {
  location: { protocol: 'http:', host: '192.168.1.20:4010' },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  setTimeout: (callback: () => void) => callback(),
  clearTimeout: () => undefined,
});
(globalThis as Record<string, unknown>).document = {
  hidden: false,
  hasFocus: () => true,
  querySelector: () => null,
};

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ─── Fake browser environment (installed before the transport runs) ─────────

let socketInstances: FakeWebSocket[] = [];
class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(public readonly url: string) {
    socketInstances.push(this);
  }

  send(frame: string): void {
    this.sent.push(frame);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
}
(globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;

/**
 * Run `run` in an insecure-context-like environment: `crypto` keeps only
 * `getRandomValues` (available on insecure contexts), `randomUUID` is absent,
 * and `Math.random` throws so any non-crypto entropy source fails loudly.
 */
function withoutRandomUUID<T>(run: () => T): T {
  const originalCrypto = globalThis.crypto;
  const originalRandom = Math.random;
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      getRandomValues: (function () {
        let call = 0;
        return (array: Uint8Array): Uint8Array => {
          for (let index = 0; index < array.length; index += 1) array[index] = ((index * 37 + 11) + call++ * 191) & 0xff;
          return array;
        };
      })(),
    },
  });
  Math.random = () => {
    throw new Error('Math.random must not be used for UUID entropy');
  };
  try {
    return run();
  } finally {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: originalCrypto });
    Math.random = originalRandom;
  }
}

interface Harness {
  transport: BrowserClientTransport;
  socket: FakeWebSocket;
}

function createConnectedTransport(): Harness {
  socketInstances = [];
  const transport = new BrowserClientTransport({
    wsRoute: '/ws',
    now: () => 0,
    setTimeout: () => undefined,
    clearTimeout: () => undefined,
  });
  transport.connect();
  const socket = socketInstances[0]!;
  socket.onopen?.();
  socket.onmessage?.({ data: JSON.stringify({
    type: 'rendererHello',
    protocolVersion: WEBVIEW_PROTOCOL_VERSION,
    buildId: PIE_BUILD_ID,
    hostInstanceId: 'host-1',
    rendererId: 'renderer-9',
    rendererGeneration: 2,
    viewGeneration: 5,
    assetVersion: 'asset-1',
  }) });
  return { transport, socket };
}

function lastFrame(socket: FakeWebSocket): Record<string, unknown> {
  return JSON.parse(socket.sent[socket.sent.length - 1] ?? '{}') as Record<string, unknown>;
}

// ─── Real client transport command frames (settings / tab / send) ───────────

test('insecure context: a settings command frame still mints a UUID v4 clientCommandId', () => {
  withoutRandomUUID(() => {
    const { transport, socket } = createConnectedTransport();
    const sentBefore = socket.sent.length;

    const accepted = transport.postMessage({
      type: 'setPrefs', prefs: { autoExpandReasoning: true },
    } as WebviewToHostMessage);

    assert.equal(accepted, true, 'the settings command crosses the transport');
    const frame = lastFrame(socket);
    assert.equal(frame.type, 'setPrefs');
    assert.match(String(frame.clientCommandId), UUID_V4_PATTERN);
    assert.ok(storageWrites.some((raw) => raw.includes(String(frame.clientCommandId))),
      'the command is tracked in the pending-command mirror');
    assert.equal(socket.sent.length, sentBefore + 1);
  });
});

test('insecure context: a tab command frame still mints a UUID v4 clientCommandId', () => {
  withoutRandomUUID(() => {
    const { transport, socket } = createConnectedTransport();

    const accepted = transport.postMessage({
      type: 'togglePinTab', sessionPath: '/session/a',
    } as WebviewToHostMessage);

    assert.equal(accepted, true, 'the tab command crosses the transport');
    const frame = lastFrame(socket);
    assert.equal(frame.type, 'togglePinTab');
    assert.match(String(frame.clientCommandId), UUID_V4_PATTERN);
  });
});

test('insecure context: a send (prompt) frame still mints a UUID v4 clientCommandId', () => {
  withoutRandomUUID(() => {
    const { transport, socket } = createConnectedTransport();

    const accepted = transport.postMessage({
      type: 'send', sessionPath: '/session/a', text: 'hello', localId: createLocalMessageId(),
    } as WebviewToHostMessage);

    assert.equal(accepted, true, 'the send command crosses the transport');
    const frame = lastFrame(socket);
    assert.equal(frame.type, 'send');
    assert.match(String(frame.clientCommandId), UUID_V4_PATTERN);
    assert.match(String(frame.localId), /^local:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      'the prompt local id is also a UUID v4 on the insecure context');
  });
});

// ─── Local message id prompt path ────────────────────────────────────────────

test('insecure context: createLocalMessageId minted for a prompt is still a UUID v4', () => {
  withoutRandomUUID(() => {
    assert.match(createLocalMessageId(), /^local:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(createLocalMessageId('edit'), /^local:edit:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

test('insecure context: consecutive ids remain unique (entropy comes from getRandomValues)', () => {
  withoutRandomUUID(() => {
    const ids = new Set<string>();
    for (let index = 0; index < 8; index += 1) ids.add(createLocalMessageId());
    assert.equal(ids.size, 8, 'the fallback entropy source still yields unique ids');
  });
});