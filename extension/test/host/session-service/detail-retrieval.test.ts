import assert from 'node:assert/strict';
import test from 'node:test';

import { createInitialArchState } from '../../../src/host/core/arch-state';
import { applyLiveSemanticEnvelope } from '../../../src/host/core/live-pipeline/transitions';
import { resolveLiveDetail } from '../../../src/host/session-service/detail-retrieval';
import type { LazyDetailRef } from '../../../src/shared/protocol';
import type { TurnSemanticEnvelope } from '../../../src/shared/live-pipeline-protocol';

const base = {
  protocolVersion: 7,
  sessionPath: '/session.jsonl',
  requestId: 'request',
  turnId: 'turn',
  attemptId: 'attempt',
  occurredAt: 100,
  checkpointBytes: 30 * 1024 * 1024,
} as const;

function apply(state: ReturnType<typeof createInitialArchState>, event: TurnSemanticEnvelope) {
  return {
    ...state,
    livePipeline: applyLiveSemanticEnvelope(state.livePipeline, event, 10_000).state,
  };
}

function reasoningRef(sourceRevision: number): LazyDetailRef {
  return {
    key: `live:reasoning:${sourceRevision}`, kind: 'reasoning', source: 'live',
    sessionPath: base.sessionPath, messageId: 'message', partIndex: 0, sourceRevision,
    sizeBytes: sourceRevision, summary: 'reasoning', available: true,
  };
}

test('live reasoning retrieval ignores unrelated turn sequence changes but rejects changed reasoning', () => {
  let state = createInitialArchState();
  state = apply(state, { ...base, kind: 'turn.started', seq: 1, canonicalMessageId: 'message', startedAt: 90 });
  state = apply(state, { ...base, kind: 'turn.reasoning', seq: 2, delta: 'reasoning' });
  const ref = reasoningRef(Buffer.byteLength('reasoning', 'utf8'));

  state = apply(state, { ...base, kind: 'turn.phase', seq: 3, phase: 'waiting_provider' });
  assert.equal(resolveLiveDetail(state, base.sessionPath, ref).status, 'loaded');

  state = apply(state, { ...base, kind: 'turn.reasoning', seq: 4, delta: ' changed' });
  assert.equal(resolveLiveDetail(state, base.sessionPath, ref).status, 'stale');
});

test('live tool detail retrieval is revision-bound', () => {
  let state = createInitialArchState();
  state = apply(state, { ...base, kind: 'turn.started', seq: 1, canonicalMessageId: 'message', startedAt: 90 });
  state = apply(state, {
    ...base, kind: 'tool.started', seq: 2, executionId: 'execution', parentExecutionId: null,
    rootExecutionId: 'execution', toolCallId: 'tool', name: 'subagent', input: {}, startedAt: 95,
  });
  const preview = { kind: 'generic' as const, summary: 'first' };
  const previewBytes = Buffer.byteLength(JSON.stringify(preview), 'utf8');
  state = apply(state, {
    ...base, kind: 'tool.progress', seq: 3, baseSeq: 2, executionId: 'execution',
    baseProgressRevision: 0, progressRevision: 1, previewBytes, aggregatePreviewBytes: previewBytes,
    update: { kind: 'snapshot', preview },
  });
  const ref: LazyDetailRef = {
    key: 'live:tool:1', kind: 'tool-result', source: 'live', sessionPath: base.sessionPath,
    messageId: 'message', toolCallId: 'tool', executionId: 'execution', sourceRevision: 1,
    sizeBytes: previewBytes, summary: 'first', available: true,
  };
  assert.equal(resolveLiveDetail(state, base.sessionPath, ref).status, 'loaded');

  state = apply(state, {
    ...base, kind: 'tool.progress', seq: 4, baseSeq: 3, executionId: 'execution',
    baseProgressRevision: 1, progressRevision: 2, previewBytes: previewBytes + 1,
    aggregatePreviewBytes: previewBytes + 1,
    update: { kind: 'patch', operations: [{ op: 'appendString', path: ['summary'], value: '!' }] },
  });
  assert.equal(resolveLiveDetail(state, base.sessionPath, ref).status, 'stale');
});
