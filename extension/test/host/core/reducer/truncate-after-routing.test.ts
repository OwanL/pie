import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module from 'node:module';
import test from 'node:test';

import type { WebviewToHostMessage } from '../../../../src/shared/protocol';
import { isPendingTabPath } from '../../../../src/shared/tab-behavior';
import { initialArchState, reducer } from '../../../../src/host/core/reducer';

/**
 * Routing tests for the transcript "Delete from here" (`truncateAfter`) and
 * the changed-file revert (`revertFile`) webview commands.
 *
 * `truncateAfter` is destructive and session-addressed: the router must verify
 * the session is open AND the message exists in that session before
 * dispatching the `TruncateAfter` command, rejecting the browser command
 * explicitly otherwise. `revertFile` must dispatch the `RevertFile` command
 * WITHOUT eagerly removing the changed-file row — the row drops only via the
 * `FileRevertResult` reducer settlement (success carries `filePath`).
 *
 * Same vscode-stub + dynamic-import isolation as
 * `pinned-tab-message-router.test.ts` (the router imports `vscode` at load).
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
  ({ MessageRouter: MessageRouterCtor } = await import('../../../../src/host/core/message-router'));
});

test.after(() => {
  uninstallVscodeMock?.();
});

/** Transcript messages present in the fake ArchState (by session). */
const TRANSCRIPTS: Record<string, Array<{ id: string; role: string }>> = {
  '/sessions/a': [
    { id: 'durable-1', role: 'user' },
    { id: 'durable-2', role: 'assistant' },
  ],
  '/sessions/b': [{ id: 'b-1', role: 'assistant' }],
};

const OPEN_TABS = ['/sessions/a', '/sessions/b', '/__pending__:new-1'];

function newRouter(): {
  router: import('../../../../src/host/core/message-router').MessageRouter;
  events: Array<{ kind: string; cmd?: { kind: string } & Record<string, unknown> }>;
  commands: () => Array<{ kind: string; cmd: Record<string, unknown> }>;
  notices: () => string[];
} {
  const events: Array<{ kind: string; cmd?: { kind: string } & Record<string, unknown> }> = [];
  const router = new MessageRouterCtor(
    (event) => {
      const e = event as { kind: string; cmd?: { kind: string } & Record<string, unknown> };
      events.push(e);
    },
    () => ({
      sessions: {
        activeSessionPath: '/sessions/a',
        openTabPaths: OPEN_TABS,
        pinnedTabPaths: [],
        pinnedTabGroups: [],
        runningSessionPaths: [],
      },
      transcript: { bySession: TRANSCRIPTS },
    }) as never,
    {} as never,
    { reveal: () => undefined, postState: () => undefined, postImperative: () => undefined } as never,
    () => undefined,
    (text: string) => ({ name: text, isPlaceholder: false }),
    isPendingTabPath,
  );
  const commands = () => events
    .filter((e) => e.kind === 'Command')
    .map((e) => ({ kind: e.kind, cmd: (e.cmd ?? {}) as Record<string, unknown> }));
  const notices = () => events
    .filter((e) => e.kind === 'NoticeShown')
    .map((e) => ((e as unknown as { notice?: string }).notice ?? ''));
  return { router, events, commands, notices };
}

function browserContext(): {
  rejections: Array<{ type: string; reason: string }>;
  context: import('../../../../src/shared/protocol').RendererCommandContext;
} {
  const rejections: Array<{ type: string; reason: string }> = [];
  const context = {
    rendererId: 'browser-1',
    kind: 'browser' as const,
    rendererGeneration: 1,
    onBrowserCommandRejected: (type: string, reason: string) => { rejections.push({ type, reason }); },
  };
  return { rejections, context };
}

test('truncateAfter dispatches the TruncateAfter command for a durable message in an open session', async () => {
  const { router, commands, notices } = newRouter();
  await router.handle({ type: 'truncateAfter', sessionPath: '/sessions/a', messageId: 'durable-2' } as never);
  assert.deepStrictEqual(notices(), []);
  assert.equal(commands().length, 1);
  assert.equal(commands()[0].cmd.kind, 'TruncateAfter');
  assert.equal(commands()[0].cmd.sessionPath, '/sessions/a');
  assert.equal(commands()[0].cmd.messageId, 'durable-2');
  assert.ok(typeof commands()[0].cmd.corrId === 'string');
});

test('truncateAfter rejects a session that is not open (explicit notice, no command)', async () => {
  const { router, commands, notices } = newRouter();
  await router.handle({ type: 'truncateAfter', sessionPath: '/sessions/gone', messageId: 'durable-1' } as never);
  assert.equal(commands().length, 0);
  assert.equal(notices().length, 1);
  assert.match(notices()[0], /no longer open/);
});

test('truncateAfter rejects a message missing from the addressed session', async () => {
  const { router, commands, notices } = newRouter();
  await router.handle({ type: 'truncateAfter', sessionPath: '/sessions/b', messageId: 'durable-1' } as never);
  assert.equal(commands().length, 0);
  assert.equal(notices().length, 1);
  assert.match(notices()[0], /no longer/);
});

test('truncateAfter rejects a pending-tab sentinel path', async () => {
  const { router, commands, notices } = newRouter();
  await router.handle({ type: 'truncateAfter', sessionPath: '/__pending__:new-1', messageId: 'durable-1' } as never);
  assert.equal(commands().length, 0);
  assert.equal(notices().length, 1);
  assert.match(notices()[0], /still opening/);
});

test('truncateAfter rejects non-durable webview-local message ids', async () => {
  const { router, commands, notices } = newRouter();
  await router.handle({ type: 'truncateAfter', sessionPath: '/sessions/a', messageId: 'local:abc' } as never);
  assert.equal(commands().length, 0);
  assert.equal(notices().length, 1);
  assert.match(notices()[0], /non-durable/);
});

test('truncateAfter rejects a browser command explicitly (session-not-open)', async () => {
  const { router, commands } = newRouter();
  const { rejections, context } = browserContext();
  await router.handle(
    { type: 'truncateAfter', sessionPath: '/sessions/gone', messageId: 'durable-1' } as unknown as WebviewToHostMessage,
    context,
  );
  assert.deepEqual(rejections, [{ type: 'truncateAfter', reason: 'session-not-open' }]);
  assert.equal(commands().length, 0);
});

test('truncateAfter rejects a browser command explicitly (message-not-found)', async () => {
  const { router, commands } = newRouter();
  const { rejections, context } = browserContext();
  await router.handle(
    { type: 'truncateAfter', sessionPath: '/sessions/a', messageId: 'missing-9' } as unknown as WebviewToHostMessage,
    context,
  );
  assert.deepEqual(rejections, [{ type: 'truncateAfter', reason: 'message-not-found' }]);
  assert.equal(commands().length, 0);
});

test('TruncateResult failure surfaces a session-scoped operational notice while success is a no-op', () => {
  const failure = reducer(initialArchState, {
    kind: 'TruncateResult',
    corrId: 'truncate-failed',
    sessionPath: '/sessions/a',
    ok: false,
    error: 'disk full',
  });
  assert.equal(failure.state.settings.noticeKind, 'operational-error');
  assert.equal(failure.state.settings.noticeSessionPath, '/sessions/a');
  assert.match(failure.state.settings.notice ?? '', /Could not delete/);
  assert.equal(failure.state.settings.noticeRaw, 'disk full');

  const success = reducer(initialArchState, {
    kind: 'TruncateResult',
    corrId: 'truncate-ok',
    sessionPath: '/sessions/a',
    ok: true,
  });
  assert.equal(success.state, initialArchState);
  assert.deepEqual(success.effects, []);
});

test('revertFile dispatches RevertFile and no longer eagerly removes the changed-file row', async () => {
  const { router, events, commands } = newRouter();
  await router.handle({ type: 'revertFile', sessionPath: '/sessions/a', filePath: 'src/a.ts' } as never);
  assert.equal(commands().length, 1);
  assert.equal(commands()[0].cmd.kind, 'RevertFile');
  assert.equal(commands()[0].cmd.sessionPath, '/sessions/a');
  assert.equal(commands()[0].cmd.filePath, 'src/a.ts');
  // Row removal moved behind `FileRevertResult` settlement: only the success
  // result (which carries the matching filePath) drops the row in the reducer.
  assert.equal(events.filter((e) => e.kind === 'FileChangeRemoved').length, 0);
});