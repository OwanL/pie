import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module from 'node:module';
import test from 'node:test';

import type { WebviewToHostMessage } from '../../../../src/shared/protocol';
import { isPendingTabPath } from '../../../../src/shared/tab-behavior';

/**
 * Phase 5 public routing: `detail.subscribe` / `detail.unsubscribe` /
 * `detail.fetchPages` must reach the reducer as `Command` events with their
 * exact renderer owner identity (`viewGeneration` + `detailKey`) preserved.
 * The reducer stores nothing; stream content returns only as detail
 * imperatives. Same vscode-mock pattern as `message-router-log.test.ts`.
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

function newRouter(dispatched: Array<{ kind: string; cmd?: unknown }>): import('../../../../src/host/core/message-router').MessageRouter {
  return new MessageRouterCtor(
    (event: { kind: string; cmd?: unknown }) => { dispatched.push(event); },
    () => ({ sessions: { activeSessionPath: null, openTabPaths: [] }, settings: {}, transcript: { windowBySession: {} } } as never),
    {
      bumpSessionDataEpoch: () => undefined,
      addFilesystemPaths: async () => undefined,
      createNewSession: () => '/s',
      openSession: () => undefined,
      duplicateSession: () => undefined,
      retryCreateOperation: () => false,
      loadOlderTranscript: async () => undefined,
      loadNewerTranscript: async () => undefined,
      jumpToLatestTranscript: async () => undefined,
      setPrefs: () => undefined,
      setPruningSettings: async () => undefined,
      setToolResultPruningSettings: async () => undefined,
    } as never,
    { reveal: () => undefined, postState: () => undefined, postImperative: () => undefined } as never,
    () => undefined, // scheduleRender
    (text: string) => ({ name: text, isPlaceholder: false }),
    () => false,
  );
}

const ADDRESS = {
  sessionPath: '/workspace/session.jsonl',
  turnId: 'turn-1',
  rootToolCallId: 'tool-1',
  rootAttemptId: 'attempt-1',
  lineage: [{ childId: 'child-1', spawningToolCallId: 'tool-1', attemptId: 'attempt-1' }],
};

test('detail.subscribe dispatches a DetailSubscribe command with the exact renderer owner', async () => {
  const dispatched: Array<{ kind: string; cmd?: unknown }> = [];
  const router = newRouter(dispatched);

  await router.handle({
    type: 'detail.subscribe',
    viewGeneration: 7,
    detailKey: 'subagent:msg-1:tool-1',
    address: ADDRESS,
    cursor: { revision: 3 },
  } as WebviewToHostMessage);

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]?.kind, 'Command');
  const cmd = dispatched[0]?.cmd as { kind: string; viewGeneration: number; detailKey: string; address: unknown; cursor: unknown };
  assert.equal(cmd.kind, 'DetailSubscribe');
  assert.equal(cmd.viewGeneration, 7);
  assert.equal(cmd.detailKey, 'subagent:msg-1:tool-1');
  assert.deepEqual(cmd.address, ADDRESS);
  assert.deepEqual(cmd.cursor, { revision: 3 });
  assert.equal(typeof (cmd as { corrId?: string }).corrId, 'string');
});

test('detail.subscribe without a cursor still dispatches (cursor is optional)', async () => {
  const dispatched: Array<{ kind: string; cmd?: unknown }> = [];
  const router = newRouter(dispatched);

  await router.handle({
    type: 'detail.subscribe',
    viewGeneration: 7,
    detailKey: 'subagent:msg-1:tool-1',
    address: ADDRESS,
  } as WebviewToHostMessage);

  const cmd = dispatched[0]?.cmd as { kind: string; cursor?: unknown };
  assert.equal(cmd.kind, 'DetailSubscribe');
  assert.equal(cmd.cursor, undefined);
});

test('detail.unsubscribe dispatches a DetailUnsubscribe command with the close reason', async () => {
  const dispatched: Array<{ kind: string; cmd?: unknown }> = [];
  const router = newRouter(dispatched);

  await router.handle({
    type: 'detail.unsubscribe',
    viewGeneration: 7,
    detailKey: 'subagent:msg-1:tool-1',
    reason: 'collapse',
  } as WebviewToHostMessage);

  const cmd = dispatched[0]?.cmd as { kind: string; viewGeneration: number; detailKey: string; reason: string };
  assert.equal(cmd.kind, 'DetailUnsubscribe');
  assert.equal(cmd.viewGeneration, 7);
  assert.equal(cmd.detailKey, 'subagent:msg-1:tool-1');
  assert.equal(cmd.reason, 'collapse');
});

test('detail.fetchPages dispatches a DetailFetchPages command with the exact ref', async () => {
  const dispatched: Array<{ kind: string; cmd?: unknown }> = [];
  const router = newRouter(dispatched);

  await router.handle({
    type: 'detail.fetchPages',
    viewGeneration: 7,
    detailKey: 'subagent:msg-1:tool-1',
    ref: { baselineRevision: 5, pageIndex: 3, pageCount: 8 },
  } as WebviewToHostMessage);

  const cmd = dispatched[0]?.cmd as { kind: string; viewGeneration: number; detailKey: string; ref: unknown };
  assert.equal(cmd.kind, 'DetailFetchPages');
  assert.equal(cmd.viewGeneration, 7);
  assert.equal(cmd.detailKey, 'subagent:msg-1:tool-1');
  assert.deepEqual(cmd.ref, { baselineRevision: 5, pageIndex: 3, pageCount: 8 });
  assert.equal(isPendingTabPath('__pending__:1-abc'), true, 'sanity: tab-behavior helper loads');
});
