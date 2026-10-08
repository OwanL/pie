import assert from 'node:assert/strict';
import test from 'node:test';

import { MESSAGE_REQUEST_HANDLERS } from '../../coordinator/request-handler-message';
import type { BackendRequestHandlerDeps } from '../../coordinator/request-handler-shared';
import type { SessionContext } from '../../coordinator/server-types';
import type { SdkSessionEvent } from '../../lib/sdk-integration/sdk';
import { FENCED_ENTRY_ID } from '../../../session-storage/ownership/session-manager-fence';
import { CONTENT_TOOL_SDK_EVENT_HANDLERS } from '../session-event-content-tool';
import type { BackendSessionEventHandlerDeps } from '../session-event-shared';

function fixture() {
  const events: Array<{ kind: string; payload: any }> = [];
  const context = {
    runtime: {}, sessionPath: '/workspace/session.jsonl', unsubscribe() {}, busySeq: 0,
    session: {
      isStreaming: false,
      prompt: () => new Promise<void>(() => {}),
      followUp: async () => {},
      steer: async () => {},
    },
  } as unknown as SessionContext;
  const deps: BackendSessionEventHandlerDeps = {
    emit: (kind, payload) => { events.push({ kind, payload }); },
    emitBusyChanged() {}, emitContextUsageChanged() {},
    emitSessionOpened: async () => {}, emitSessionListChanged: async () => {},
  };
  const requestDeps = { ...deps, ensureSessionContext: async () => context } as unknown as BackendRequestHandlerDeps;
  const send = async (localId: string) => MESSAGE_REQUEST_HANDLERS['message.send'](requestDeps, {
    id: localId, method: 'message.send', params: { sessionPath: context.sessionPath, text: 'same text', localId },
  });
  const user = (type: 'message_start' | 'message_end', sessionEntryId?: string) => {
    CONTENT_TOOL_SDK_EVENT_HANDLERS[type](deps, context, {
      type, message: { role: 'user', content: [{ type: 'text', text: 'same text' }] }, sessionEntryId,
    } as SdkSessionEvent);
  };
  const deliveries = () => events.filter((event) => event.kind === 'message.queuedDelivered').map((event) => event.payload);
  return { context, deps, events, send, user, deliveries };
}

test('direct normal, deferred, and agent local IDs bind at the actual user append boundary', async () => {
  for (const localId of ['local:normal:1', 'local:deferred-trigger:1', 'local:agent-session:1']) {
    const f = fixture();
    await f.send(localId);
    assert.equal(f.context.activeRequest?.userMessageLocalId, localId);
    f.user('message_start');
    assert.deepEqual(f.deliveries(), [], 'initial start is not queue promotion');
    if (localId.startsWith('local:agent-session:')) {
      f.context.activeRequest!.agentMessageProvenanceEntryId = 'durable-direct';
    }
    f.user('message_end', 'durable-direct');
    f.user('message_end', 'durable-direct');
    assert.deepEqual(f.deliveries(), [{
      sessionPath: f.context.sessionPath, text: 'same text', localId, durableEntryId: 'durable-direct',
    }]);
    assert.equal(f.events.some((event) => event.kind === 'operational-error'), false);
  }
});

test('identical direct and queued prompts retain exact FIFO IDs; end binding does not promote or settle again', async () => {
  const f = fixture();
  await f.send('local:direct');
  await f.send('local:queued:first');
  await f.send('local:agent-session:queued-second');
  f.user('message_start');
  assert.deepEqual(f.context.queuedLocalIds, ['local:queued:first', 'local:agent-session:queued-second']);
  f.user('message_end', 'durable-direct');
  // The SDK injects queued user messages only after assistant output starts.
  f.context.activeRequest!.messageIndex = 1;
  let commits = 0;
  f.context.sendOperationLedger = { markCommitted: () => { commits += 1; } } as SessionContext['sendOperationLedger'];
  f.context.queuedOperationIds = ['op-first', 'op-second'];
  f.context.queuedOperationAttempts = [1, 2];
  f.user('message_start');
  assert.equal(f.context.activeRequest!.userMessageLocalId, 'local:queued:first');
  const accumulator = f.context.activeRequest!.liveTurnAccumulator;
  const beforeEnd = accumulator?.currentSeq;
  f.user('message_end', 'durable-first');
  f.user('message_end', 'durable-first');
  assert.equal(commits, 1);
  assert.equal(accumulator?.currentSeq, beforeEnd, 'binding produces no live lifecycle event');
  assert.deepEqual(f.context.queuedLocalIds, ['local:agent-session:queued-second']);
  f.user('message_start');
  f.context.activeRequest!.agentMessageProvenanceEntryId = 'durable-second';
  f.user('message_end', 'durable-first'); // late replay cannot steal the next ID
  assert.equal(f.context.activeRequest!.userMessageLocalId, 'local:agent-session:queued-second');
  f.user('message_end', 'durable-second');
  assert.equal(commits, 2);
  assert.deepEqual(f.deliveries().filter((payload) => payload.durableEntryId), [
    { sessionPath: f.context.sessionPath, text: 'same text', localId: 'local:direct', durableEntryId: 'durable-direct' },
    { sessionPath: f.context.sessionPath, text: 'same text', localId: 'local:queued:first', durableEntryId: 'durable-first' },
    { sessionPath: f.context.sessionPath, text: 'same text', localId: 'local:agent-session:queued-second', durableEntryId: 'durable-second' },
  ]);
  assert.equal(f.deliveries().filter((payload) => !payload.durableEntryId).length, 2, 'queue starts still promote exactly once');
});

test('missing or fenced append identity never fabricates a user binding; missing agent provenance still fails', async () => {
  for (const localId of ['local:normal', 'local:agent-session:missing']) {
    for (const entryId of [undefined, FENCED_ENTRY_ID]) {
      const f = fixture();
      await f.send(localId);
      f.user('message_start');
      f.user('message_end', entryId);
      assert.deepEqual(f.deliveries(), []);
      if (localId.startsWith('local:agent-session:') && entryId === undefined) {
        assert.equal(f.events.filter((event) => event.payload?.code === 'AGENT_MESSAGE_PROVENANCE_UNAVAILABLE').length, 1);
      }
    }
  }
});
