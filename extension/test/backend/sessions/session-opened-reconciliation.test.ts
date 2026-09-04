import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSessionOpenedLiveSnapshot, normalizeDanglingTranscript, stripActiveAssistantTail } from '../../../src/backend/session-opened';
import { isSessionOpenedPayload } from '../../../src/shared/protocol/event-payloads';

test('session.opened accepts an additive create operation identity for late reconciliation', () => {
  const payload = {
    session: { path: '/workspace/session.jsonl', name: 'Session', cwd: '/workspace', modifiedAt: '2026-01-01T00:00:00.000Z', messageCount: 0 },
    transcript: [],
    transcriptWindow: { totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false },
    busy: false,
    capabilities: { billableActivity: false, canContinue: false, canInterrupt: false, canCompact: true },
    selectionToken: 'selection-1',
    operationId: 'create-operation-1',
    operationAttempt: 2,
  };
  assert.equal(isSessionOpenedPayload(payload), true);
  assert.equal(isSessionOpenedPayload({ ...payload, operationId: undefined, operationAttempt: undefined }), true);
  assert.equal(isSessionOpenedPayload({ ...payload, operationAttempt: 0 }), false);
});

test('session.opened validates the additive cold initial-context estimate independently of live usage', () => {
  const payload = {
    session: { path: '/workspace/session.jsonl', name: 'Session', cwd: '/workspace', modifiedAt: '2026-01-01T00:00:00.000Z', messageCount: 0 },
    transcript: [],
    transcriptWindow: { totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false },
    busy: false,
    capabilities: { billableActivity: false, canContinue: false, canInterrupt: false, canCompact: true },
    runtimeReady: false,
    initialContextEstimate: { tokens: 12_345, contextWindow: 200_000 },
  };
  assert.equal(isSessionOpenedPayload(payload), true);
  assert.equal(isSessionOpenedPayload({ ...payload, initialContextEstimate: { tokens: -1, contextWindow: 200_000 } }), false);
  assert.equal(isSessionOpenedPayload({ ...payload, initialContextEstimate: { tokens: 1, contextWindow: 0 } }), false);
});

test('busy session snapshots omit the persisted active assistant bubble owned by LivePipelineState', () => {
  const rows = [
    { id: 'user', role: 'user' as const, createdAt: '2026-01-01T00:00:00.000Z', markdown: 'go', status: 'completed' as const },
    { id: 'assistant', role: 'assistant' as const, createdAt: '2026-01-01T00:00:01.000Z', markdown: 'partial', status: 'completed' as const },
  ];
  assert.deepEqual(stripActiveAssistantTail(rows), [rows[0]]);
  assert.deepEqual(stripActiveAssistantTail([
    rows[1]!,
    { ...rows[0]!, id: 'new-user' },
  ]), [rows[1], { ...rows[0]!, id: 'new-user' }], 'a prior durable assistant before the active user is preserved');
});

test('oversized busy checkpoint still retains bounded recovery identity', () => {
  const checkpoint = {
    terminal: false,
    turnId: 'turn-oversized',
    attemptId: 'attempt-oversized',
    checkpointBytes: 1,
    turn: { checkpointBytes: 1 },
  };
  const snapshot = buildSessionOpenedLiveSnapshot({
    activeRequest: {
      liveTurnAccumulator: { checkpoint: () => checkpoint },
    },
  } as any);

  assert.equal(snapshot.checkpoint, undefined);
  assert.deepEqual(snapshot.recoveryIdentity, {
    turnId: 'turn-oversized',
    attemptId: 'attempt-oversized',
  });
});

test('inactive session reopen interrupts dangling tools but preserves durability-confirmed terminals', () => {
  const transcript = normalizeDanglingTranscript([{
    id: 'assistant', role: 'assistant', createdAt: '2026-01-01T00:00:00.000Z',
    markdown: '', status: 'completed',
    toolCalls: [
      { id: 'done', name: 'write', input: {}, result: 'ok', status: 'completed', durableEntryId: 'tool-result-entry' },
      { id: 'dangling', name: 'bash', input: {}, status: 'running' },
    ],
    parts: [
      { kind: 'toolCall', toolCall: { id: 'done', name: 'write', input: {}, result: 'ok', status: 'completed', durableEntryId: 'tool-result-entry' } },
      { kind: 'toolCall', toolCall: { id: 'dangling', name: 'bash', input: {}, status: 'running' } },
    ],
  }]);

  assert.equal(transcript[0]?.status, 'interrupted');
  assert.equal(transcript[0]?.toolCalls?.[0]?.status, 'completed');
  assert.equal(transcript[0]?.toolCalls?.[0]?.durableEntryId, 'tool-result-entry');
  assert.equal(transcript[0]?.toolCalls?.[1]?.status, 'failed');
  const danglingPart = transcript[0]?.parts?.[1];
  assert.equal(danglingPart?.kind === 'toolCall' ? danglingPart.toolCall.status : undefined, 'failed');
});
