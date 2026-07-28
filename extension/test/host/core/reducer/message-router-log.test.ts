import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module from 'node:module';
import test from 'node:test';

import type { WebviewToHostMessage } from '../../../../src/shared/protocol';
import { setLogLevel } from '../../../../src/host/util/pie-logger';

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
let MessageRouterCtor: typeof import('../../../../src/host/core/message-router').MessageRouter;

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
  ({ MessageRouter: MessageRouterCtor } = await import('../../../../src/host/core/message-router'));
});

test.after(() => {
  uninstallVscodeMock?.();
  setLogLevel('info');
});

function newRouter(): import('../../../../src/host/core/message-router').MessageRouter {
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

test('ready restores running sessions hidden from persisted tabs', async () => {
  const events: unknown[] = [];
  let posts = 0;
  const router = new MessageRouterCtor(
    (event) => events.push(event),
    () => ({
      sessions: { activeSessionPath: null, openTabPaths: ['/idle'], runningSessionPaths: ['/running'] },
      settings: { backendReady: true, notice: null }, transcript: { windowBySession: {} },
    } as never),
    {} as never,
    { reveal: () => undefined, postState: () => { posts += 1; }, postImperative: () => undefined },
    () => undefined,
    (text: string) => ({ name: text, isPlaceholder: false }),
    () => false,
  );

  await router.handle({ type: 'ready' });
  assert.ok(events.some((event) => (event as { kind?: string; sessionPath?: string }).kind === 'TabOpened'
    && (event as { sessionPath?: string }).sessionPath === '/running'));
  assert.ok(events.some((event) => (event as { kind?: string; cmd?: { kind?: string } }).cmd?.kind === 'SelectSession'));
  assert.equal(posts, 1);
});

test('ready does not resurrect a review-closure-hidden running tab (closeSelf)', async () => {
  const events: unknown[] = [];
  const router = new MessageRouterCtor(
    (event) => events.push(event),
    () => ({
      sessions: {
        activeSessionPath: null,
        openTabPaths: [],
        runningSessionPaths: ['/self', '/ordinary'],
        reviewClosedRunningPaths: ['/self'],
      },
      settings: { backendReady: true, notice: null }, transcript: { windowBySession: {} },
    } as never),
    {} as never,
    { reveal: () => undefined, postState: () => undefined, postImperative: () => undefined },
    () => undefined,
    (text: string) => ({ name: text, isPlaceholder: false }),
    () => false,
  );

  await router.handle({ type: 'ready' });
  const opened = events
    .filter((event) => (event as { kind?: string }).kind === 'TabOpened')
    .map((event) => (event as { sessionPath?: string }).sessionPath);
  assert.deepEqual(opened, ['/ordinary'], 'only the ordinary hidden running tab is restored; the review-closure-hidden closeSelf tab stays hidden');
  // The first restored ordinary tab is selected (not the review-closed self).
  const select = events.find((event) => (event as { cmd?: { kind?: string } }).cmd?.kind === 'SelectSession') as { cmd?: { sessionPath?: string } } | undefined;
  assert.equal(select?.cmd?.sessionPath, '/ordinary');
});

test('ready restores a pinned hidden running tab but not its review-closed neighbor', async () => {
  const events: unknown[] = [];
  const router = new MessageRouterCtor(
    (event) => events.push(event),
    () => ({
      sessions: {
        activeSessionPath: null,
        openTabPaths: [],
        runningSessionPaths: ['/pinned', '/closed'],
        reviewClosedRunningPaths: ['/closed'],
      },
      settings: { backendReady: true, notice: null }, transcript: { windowBySession: {} },
    } as never),
    {} as never,
    { reveal: () => undefined, postState: () => undefined, postImperative: () => undefined },
    () => undefined,
    (text: string) => ({ name: text, isPlaceholder: false }),
    () => false,
  );

  await router.handle({ type: 'ready' });
  const opened = events
    .filter((event) => (event as { kind?: string }).kind === 'TabOpened')
    .map((event) => (event as { sessionPath?: string }).sessionPath);
  assert.deepEqual(opened, ['/pinned'], 'the ordinary pinned hidden running tab is restored; the review-closed running tab is not');
});

test('replayed close interaction IDs are deduplicated before command dispatch', async () => {
  const events: unknown[] = [];
  const router = new MessageRouterCtor(
    (event) => events.push(event),
    () => ({ sessions: { activeSessionPath: '/s', openTabPaths: ['/s'], runningSessionPaths: [] } } as never),
    {} as never,
    { reveal: () => undefined, postState: () => undefined, postImperative: () => undefined },
    () => undefined,
    (text: string) => ({ name: text, isPlaceholder: false }),
    () => false,
  );
  const close = { type: 'closeSession' as const, sessionPath: '/s', interactionId: 'interaction-1' };
  await router.handle(close);
  await router.handle(close);
  assert.equal(events.filter((event) => (event as { cmd?: { kind?: string } }).cmd?.kind === 'CloseSession').length, 1);
});

test('an unexpected route failure on a non-send message surfaces a notice', async () => {
  const events: unknown[] = [];
  const router = new MessageRouterCtor(
    (event) => events.push(event),
    () => ({ sessions: { activeSessionPath: '/s', openTabPaths: ['/s'], runningSessionPaths: [] } } as never),
    {
      loadDetail: async () => { throw new Error('detail backend exploded'); },
    } as never,
    { reveal: () => undefined, postState: () => undefined, postImperative: () => undefined },
    () => undefined,
    (text: string) => ({ name: text, isPlaceholder: false }),
    () => false,
  );

  const originalError = console.error;
  console.error = () => undefined;
  try {
    await router.handle({ type: 'requestDetail', sessionPath: '/s', ref: { key: 'k' } } as never);
  } finally {
    console.error = originalError;
  }

  const notices = events.filter((event) => (event as { kind?: string }).kind === 'NoticeShown');
  assert.equal(notices.length, 1, 'a failed requestDetail must not fail silently');
  assert.match(
    (notices[0] as { notice: string }).notice,
    /could not be completed/,
    'the generic route-failure notice is surfaced',
  );
});

test('a route failure on a send message keeps the original send-specific notice', async () => {
  const events: unknown[] = [];
  const router = new MessageRouterCtor(
    (event) => {
      events.push(event);
      if ((event as { cmd?: { kind?: string } }).cmd?.kind === 'Send') throw new Error('dispatch exploded');
    },
    () => ({ sessions: { activeSessionPath: '/s', openTabPaths: ['/s'], runningSessionPaths: [], sessions: [] }, composer: { pendingComposerInputsBySession: {} } } as never),
    { notifyUserInput: () => undefined } as never,
    { reveal: () => undefined, postState: () => undefined, postImperative: () => undefined },
    () => undefined,
    (text: string) => ({ name: text, isPlaceholder: false }),
    () => false,
  );

  const originalError = console.error;
  console.error = () => undefined;
  try {
    await router.handle({ type: 'send', sessionPath: '/s', text: 'hello' } as never);
  } finally {
    console.error = originalError;
  }

  const notices = events.filter((event) => (event as { kind?: string }).kind === 'NoticeShown');
  assert.equal(notices.length, 1);
  assert.match((notices[0] as { notice: string }).notice, /Failed to process your message/);
});

test('transport-evidence route failures stay silent (no notice noise)', async () => {
  const events: unknown[] = [];
  const router = new MessageRouterCtor(
    (event) => events.push(event),
    () => { throw new Error('state read exploded'); },
    {} as never,
    { reveal: () => undefined, postState: () => undefined, postImperative: () => undefined },
    () => undefined,
    (text: string) => ({ name: text, isPlaceholder: false }),
    () => false,
  );

  const originalError = console.error;
  console.error = () => undefined;
  try {
    await router.handle({ type: 'requestSnapshot' } as never);
  } finally {
    console.error = originalError;
  }

  assert.equal(
    events.filter((event) => (event as { kind?: string }).kind === 'NoticeShown').length,
    0,
    'machine-generated handshake/evidence traffic must not raise user notices',
  );
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