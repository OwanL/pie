import assert from 'node:assert/strict';
import test from 'node:test';
import { options } from 'preact';

import { installDom } from '../../_helpers/dom';
installDom();

const sent: unknown[] = [];
(globalThis as typeof globalThis & { acquireVsCodeApi?: () => unknown }).acquireVsCodeApi = () => ({
  postMessage(message: unknown) {
    sent.push(message);
  },
  getState: () => undefined,
  setState: () => undefined,
});

// panel.tsx is Vite's entrypoint and imports its stylesheet. Node's focused
// webview tests execute the TypeScript module directly, so make that asset a
// no-op before loading the entrypoint.
(require as NodeRequire).extensions['.css'] = () => undefined;
const panel: typeof import('../../../src/webview/panel/panel') = require('../../../src/webview/panel/panel');

function setGenerationMeta(value: string | null): void {
  document.querySelector('meta[name="pie-view-generation"]')?.remove();
  if (value === null) return;
  const meta = document.createElement('meta');
  meta.name = 'pie-view-generation';
  meta.content = value;
  document.head.appendChild(meta);
}

test('reads the host-stamped view generation and rejects malformed values', () => {
  setGenerationMeta('42');
  assert.equal(panel.getViewGeneration(), 42);
  setGenerationMeta('-1');
  assert.equal(panel.getViewGeneration(), undefined);
  setGenerationMeta('not-a-generation');
  assert.equal(panel.getViewGeneration(), undefined);
});

test('ready, refresh, and snapshot requests carry the stamped generation', () => {
  setGenerationMeta('42');
  const handshakes = [
    panel.withHandshakeMetadata({ type: 'ready' }),
    panel.withHandshakeMetadata({ type: 'refreshState' }),
    panel.withHandshakeMetadata({ type: 'requestSnapshot', sessionPath: '/session/a' }),
  ];
  assert.deepEqual(handshakes.map((message) => ('viewGeneration' in message ? message.viewGeneration : undefined)), [42, 42, 42]);
  const snapshot = handshakes[2] as Extract<typeof handshakes[number], { type: 'requestSnapshot' }>;
  assert.equal(snapshot.type, 'requestSnapshot');
  assert.equal(snapshot.sessionPath, '/session/a');
  assert.equal(sent.length, 0, 'metadata construction must not post by itself');
});

test('ordinary control messages carry the stamped generation', () => {
  setGenerationMeta('43');
  assert.deepEqual(panel.withViewGeneration({ type: 'newSession' }), {
    type: 'newSession',
    viewGeneration: 43,
  });
});

test('ambient window errors are logged with diagnostics without requesting a reload', () => {
  sent.length = 0;
  const previousConsoleError = console.error;
  console.error = () => undefined;
  try {
    window.dispatchEvent(new window.ErrorEvent('error', {
      message: 'async callback failed',
      error: new TypeError('async callback failed'),
      filename: 'https://localhost/assets/panel.js?token=secret',
      lineno: 17,
      colno: 4,
    }));
  } finally {
    console.error = previousConsoleError;
  }

  assert.equal(sent.some((message) => (
    typeof message === 'object'
    && message !== null
    && (message as { type?: unknown }).type === 'renderFailure'
  )), false);
  assert.equal(sent.length, 1);
  const log = sent[0] as {
    type: string;
    level: string;
    scope: string;
    message: string;
    data: Record<string, unknown>;
  };
  assert.deepEqual({ ...log, data: { ...log.data, stack: undefined } }, {
    type: 'log',
    level: 'error',
    scope: 'panel',
    message: 'uncaught_error',
    viewGeneration: 43,
    data: {
      errorName: 'TypeError',
      errorMessage: 'async callback failed',
      stack: undefined,
      source: 'https://localhost/assets/panel.js',
      line: 17,
      column: 4,
      fatal: false,
      benign: false,
    },
  });
  assert.equal(typeof log.data.stack, 'string');
});

test('ResizeObserver loop notices are nonfatal warnings', () => {
  sent.length = 0;
  const previousConsoleWarn = console.warn;
  console.warn = () => undefined;
  try {
    window.dispatchEvent(new window.ErrorEvent('error', {
      message: 'ResizeObserver loop completed with undelivered notifications.',
    }));
  } finally {
    console.warn = previousConsoleWarn;
  }

  assert.deepEqual(sent, [{
    type: 'log',
    level: 'warn',
    scope: 'panel',
    message: 'uncaught_error',
    data: {
      errorMessage: 'ResizeObserver loop completed with undelivered notifications.',
      fatal: false,
      benign: true,
    },
    viewGeneration: 43,
  }]);
});

test('unhandled rejections are diagnostic-only', () => {
  sent.length = 0;
  const event = new window.Event('unhandledrejection');
  Object.defineProperty(event, 'reason', { value: new Error('rejected async work') });
  const previousConsoleError = console.error;
  console.error = () => undefined;
  try {
    window.dispatchEvent(event);
  } finally {
    console.error = previousConsoleError;
  }

  assert.equal(sent.length, 1);
  const log = sent[0] as { type: string; message: string; data: Record<string, unknown> };
  assert.equal(log.type, 'log');
  assert.equal(log.message, 'unhandled_rejection');
  assert.equal(log.data.errorMessage, 'rejected async work');
  assert.equal(log.data.fatal, false);
});

test('ambient diagnostics are deduplicated until their rate-limit window expires', () => {
  sent.length = 0;
  const previousNow = Date.now;
  const previousConsoleError = console.error;
  let now = 1_000;
  Date.now = () => now;
  console.error = () => undefined;
  const dispatch = () => window.dispatchEvent(new window.ErrorEvent('error', {
    message: 'repeated callback failure',
  }));
  try {
    dispatch();
    dispatch();
    now += 10_001;
    dispatch();
  } finally {
    Date.now = previousNow;
    console.error = previousConsoleError;
  }

  assert.equal(sent.length, 2);
  assert.equal(sent.every((message) => (
    typeof message === 'object'
    && message !== null
    && (message as { type?: unknown }).type === 'log'
  )), true);
});

test('Preact component errors remain fatal renderer evidence', () => {
  sent.length = 0;
  const previousConsoleError = console.error;
  const componentError = new Error('component render failed');
  console.error = () => undefined;
  try {
    try {
      (options as { __e?: (error: unknown, vnode: unknown, oldVNode: unknown) => void }).__e?.(
        componentError,
        {},
        {},
      );
    } catch {
      // Preact's previous global handler may rethrow after Pie records failure.
    }
    const sentBeforeWindowRethrow = sent.length;
    window.dispatchEvent(new window.ErrorEvent('error', {
      message: componentError.message,
      error: componentError,
    }));
    assert.equal(sent.length, sentBeforeWindowRethrow, 'the window rethrow is not logged as nonfatal');
  } finally {
    console.error = previousConsoleError;
  }

  const log = sent.find((message) => (
    typeof message === 'object'
    && message !== null
    && (message as { type?: unknown }).type === 'log'
  )) as { data?: Record<string, unknown> } | undefined;
  const failure = sent.find((message) => (
    typeof message === 'object'
    && message !== null
    && (message as { type?: unknown }).type === 'renderFailure'
  ));
  assert.equal(log?.data?.fatal, true);
  assert.notEqual(failure, undefined);
});
