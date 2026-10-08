import test from 'node:test';
import assert from 'node:assert/strict';
import { reducer, createInitialArchState } from '../../../conversation-state/reducer';
import { isQueuedDeliveredPayload } from '../../../../../harness/agent-processes/lib/rpc/event-payload-validation';
import type { ChatMessage } from '../../../../lib/protocol/index.js';
import { onQueuedDelivered } from '../../../session-actions/handlers/streaming';

const SESSION = '/workspace/binding.jsonl';
function row(id: string, status: ChatMessage['status'] = 'completed'): ChatMessage {
  return { id, role: 'user', markdown: 'repeat', createdAt: '2026-01-01T00:00:00.000Z', status };
}
function binding(localId = 'local:target', durableEntryId: unknown = 'entry-1') {
  return { kind: 'QueuedDelivered', sessionPath: SESSION, text: 'expanded', localId, durableEntryId, operationId: 'op-1' } as Parameters<typeof reducer>[1];
}

test('durable user binding requires nonempty local and durable identities at ingress', () => {
  const base = { sessionPath: SESSION, text: 'repeat' };
  assert.equal(isQueuedDeliveredPayload({ ...base, localId: 'local:target', durableEntryId: 'entry-1' }), true);
  for (const localId of [undefined, '', 42]) {
    assert.equal(isQueuedDeliveredPayload({ ...base, localId, durableEntryId: 'entry-1' }), false);
  }
  for (const durableEntryId of ['', 42, null]) {
    assert.equal(isQueuedDeliveredPayload({ ...base, localId: 'local:target', durableEntryId }), false);
  }
  assert.equal(isQueuedDeliveredPayload(base), true, 'legacy delivery remains accepted');
});

test('binding updates only the exact local user, never promotes, reorders or retires rollback ownership', () => {
  const state = createInitialArchState();
  state.transcript.bySession[SESSION] = [row('local:first', 'queued'), row('local:target', 'queued'), row('tail')];
  state.pending.ops['corr-1'] = { sessionPath: SESSION, localId: 'local:target', queued: true, operationId: 'op-1' } as typeof state.pending.ops[string];
  const result = reducer(state, binding());
  assert.deepEqual(result.state.transcript.bySession[SESSION].map((message) => message.id), ['local:first', 'local:target', 'tail']);
  assert.equal(result.state.transcript.bySession[SESSION][1].status, 'queued');
  assert.equal(result.state.transcript.bySession[SESSION][1].durableEntryId, 'entry-1');
  assert.deepEqual(result.state.pending, state.pending);
  assert.deepEqual(result.state.operations, state.operations);
  assert.deepEqual(result.effects, []);
  assert.equal(reducer(result.state, binding()).state, result.state, 'identical duplicate is idempotent');
  assert.equal(reducer(result.state, binding('local:target', 'conflicting-entry')).state, result.state);
  assert.equal(reducer(result.state, binding('missing')).state, result.state, 'no FIFO fallback');
});

test('binding leaves an actual queued send operation awaiting commit', () => {
  const initial = createInitialArchState();
  initial.settings.backendReady = true;
  initial.sessions.runningSessionPaths = [SESSION];
  const sent = reducer(initial, {
    kind: 'Command', cmd: {
      kind: 'Send', corrId: 'corr-1', operationId: 'op-1', operationAttempt: 1,
      operationSource: { kind: 'renderer', rendererId: 'renderer-1', rendererKind: 'vscode', rendererGeneration: 3 },
      backendGeneration: 7, sessionPath: SESSION, text: 'repeat', inputs: [],
      composedText: 'repeat', localId: 'local:target', previousSummary: null, timestamp: 100,
    },
  }).state;
  const accepted = reducer(sent, {
    kind: 'SendResult', corrId: 'corr-1', operationId: 'op-1', backendGeneration: 7,
    sessionPath: SESSION, ok: true, queued: true,
  }).state;
  assert.equal(accepted.operations['op-1'].phase, 'awaiting-commit');
  const result = reducer(accepted, binding());
  assert.equal(result.state.operations['op-1'], accepted.operations['op-1']);
  assert.equal(result.state.pending.promoted['corr-1'], accepted.pending.promoted['corr-1']);
  assert.equal(result.state.transcript.bySession[SESSION][0].status, 'queued');
  assert.deepEqual(result.effects, []);
});

test('handler carries binding and operation attempt unchanged to the reducer', () => {
  const events: Parameters<typeof reducer>[1][] = [];
  onQueuedDelivered({ sessionPath: SESSION, text: 'expanded', localId: 'local:target',
    durableEntryId: 'entry-1', operationId: 'op-1', operationAttempt: 2 }, {
    requireEventSessionPath: (_name: string, sessionPath: string) => sessionPath,
    dispatchArch: (event: Parameters<typeof reducer>[1]) => events.push(event),
  } as any);
  assert.deepEqual(events, [{ kind: 'QueuedDelivered', sessionPath: SESSION, text: 'expanded',
    localId: 'local:target', durableEntryId: 'entry-1', operationId: 'op-1', operationAttempt: 2 }]);
});

test('snapshot-before-binding also recognizes legacy user rows by their SDK entry ID', () => {
  const state = createInitialArchState();
  const canonical = row('entry-1');
  state.transcript.bySession[SESSION] = [canonical, row('local:target')];
  const result = reducer(state, binding());
  assert.deepEqual(result.state.transcript.bySession[SESSION], [canonical]);
});

test('snapshot-before-binding race removes the exact local duplicate and preserves the canonical row', () => {
  const state = createInitialArchState();
  const canonical = { ...row('sdk-user'), durableEntryId: 'entry-1', markdown: 'authoritative expanded input' };
  state.transcript.bySession[SESSION] = [canonical, row('local:target'), row('local:unrelated')];
  state.transcript.windowBySession[SESSION] = { totalCount: 12, loadedStart: 9, loadedEnd: 12, hasOlder: true, hasNewer: false, isPartial: true, hasUserMessages: true };
  const result = reducer(state, binding());
  assert.deepEqual(result.state.transcript.bySession[SESSION], [canonical, row('local:unrelated')]);
  assert.equal(result.state.transcript.windowBySession[SESSION].totalCount, 11);
  assert.equal(result.state.transcript.windowBySession[SESSION].loadedEnd, 11);
});
