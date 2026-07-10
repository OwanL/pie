import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module from 'node:module';
import test from 'node:test';

import type { WebviewToHostMessage } from '../src/shared/protocol';
import { setLogLevel } from '../src/host/util/pie-logger';

/**
 * Backend structured logger overhaul — webview `log` → host `appendPieLog`
 * routing. The webview posts a `{ type: 'log', level, scope, message, data }`
 * message (`webview/panel/utils/log.ts`); the host `MessageRouter` routes it
 * through `appendPieLog(level, 'webview', message, data)` so the log is durable
 * (pie.log) and visible in the pie OutputChannel without devtools.
 *
 * Lives in its own file (vscode mock + dynamic `MessageRouter` import isolated
 * to this process — same pattern as `backend-client-dropped-line.test.ts`).
 * The router does not spawn a backend, so no `child_process` mock is needed;
 * only the top-level `import * as vscode from 'vscode'` requires a stub.
 */

let uninstallVscodeMock: (() => void) | undefined;
let MessageRouterCtor: typeof import('../src/host/core/message-router').MessageRouter;

function installVscodeMock(): () => void {
  const moduleWithLoad = Module as typeof Module & { _load: (...args: any[]) => unknown };
  const originalLoad = moduleWithLoad._load;
  moduleWithLoad._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === 'vscode') {
      return {
        version: '1.102.3-test',
        EventEmitter: class<TValue> {
          private readonly emitter = new EventEmitter();

          readonly event = (listener: (value: TValue) => void) => {
            this.emitter.on('event', listener);
            return { dispose: () => this.emitter.off('event', listener) };
          };

          fire(value: TValue): void {
            this.emitter.emit('event', value);
          }

          dispose(): void {
            this.emitter.removeAllListeners();
          }
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  return () => {
    moduleWithLoad._load = originalLoad;
  };
}

test.before(async () => {
  uninstallVscodeMock = installVscodeMock();
  // Ensure all levels pass the console gate so the spy captures warn + error.
  setLogLevel('debug');
  ({ MessageRouter: MessageRouterCtor } = await import('../src/host/core/message-router'));
});

test.after(() => {
  uninstallVscodeMock?.();
  setLogLevel('info');
});

function newRouter(): import('../src/host/core/message-router').MessageRouter {
  return new MessageRouterCtor(
    () => undefined, // dispatchEvent (no reducer effects needed for `log`)
    () => ({ sessions: { activeSessionPath: null, openTabPaths: [] }, settings: {}, transcript: { windowBySession: {} } } as never),
    // Minimal service stub — `log` never calls it.
    {
      bumpSessionDataEpoch: () => undefined,
      addFilesystemPaths: async () => undefined,
      createNewSession: () => '/s',
      openSession: () => undefined,
      duplicateSession: () => undefined,
      loadOlderTranscript: async () => undefined,
      loadNewerTranscript: async () => undefined,
      jumpToLatestTranscript: async () => undefined,
      setPrefs: () => undefined,
      setPruningSettings: async () => undefined,
      setToolResultPruningSettings: async () => undefined,
      notifyUserInput: () => undefined,
      cancelDeferredTrigger: () => undefined,
    } as never,
    { reveal: () => undefined, postState: () => undefined, postImperative: () => undefined } as never,
    () => undefined, // scheduleRender
    (text: string) => ({ name: text, isPlaceholder: false }),
    () => false,
  );
}

test('webview `log` message with warn level is routed through appendPieLog at warn', async () => {
  const router = newRouter();

  const originalWarn = console.warn;
  const captured: unknown[][] = [];
  console.warn = (...args: unknown[]) => captured.push(args);
  try {
    const msg: WebviewToHostMessage = {
      type: 'log',
      level: 'warn',
      scope: 'panel',
      message: 'render took too long',
      data: { ms: 420 },
    };
    await router.handle(msg);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(captured.length, 1, 'appendPieLog should emit exactly one console.warn');
  const prefix = captured[0][0] as string;
  assert.ok(prefix.includes('[pie:webview]'), `console prefix should attribute to the webview scope: ${prefix}`);
  assert.ok(prefix.includes('render took too long'), `message should be preserved: ${prefix}`);
});

test('webview `log` message with error level is routed through appendPieLog at error', async () => {
  const router = newRouter();

  const originalError = console.error;
  const captured: unknown[][] = [];
  console.error = (...args: unknown[]) => captured.push(args);
  try {
    const msg: WebviewToHostMessage = {
      type: 'log',
      level: 'error',
      scope: 'composer',
      message: 'unhandled paste failure',
    };
    await router.handle(msg);
  } finally {
    console.error = originalError;
  }

  assert.equal(captured.length, 1, 'appendPieLog should emit exactly one console.error');
  const prefix = captured[0][0] as string;
  assert.ok(prefix.includes('[pie:webview]'), `console prefix should attribute to the webview scope: ${prefix}`);
  assert.ok(prefix.includes('unhandled paste failure'), `message should be preserved: ${prefix}`);
});

test('webview `log` data payload is forwarded to the host logger', async () => {
  const router = newRouter();

  const originalWarn = console.warn;
  const captured: unknown[][] = [];
  console.warn = (...args: unknown[]) => captured.push(args);
  try {
    const msg: WebviewToHostMessage = {
      type: 'log',
      level: 'warn',
      scope: 'panel',
      message: 'drift detected',
      data: { detail: 'scroll', n: 3 },
    };
    await router.handle(msg);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(captured.length, 1);
  const dataArg = captured[0][1] as Record<string, unknown> | undefined;
  assert.ok(dataArg, 'data payload should be forwarded as the second console arg');
  assert.equal(dataArg?.detail, 'scroll');
  assert.equal(dataArg?.n, 3);
});