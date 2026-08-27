import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  isCoordinatorToHostDetailMessage,
  isHostToCoordinatorDetailMessage,
  isLiveSubagentDetailAddress,
  type BackendDetailFence,
  type LiveSubagentDetailAddress,
} from '../../../src/shared/protocol/subagent-detail';

const address: LiveSubagentDetailAddress = {
  sessionPath: 'C:/sessions/root.jsonl', turnId: 'turn-1', rootToolCallId: 'tool-1', rootAttemptId: 'root-attempt',
  lineage: [{ childId: 'child-1', spawningToolCallId: 'tool-1', attemptId: 'attempt-1' }],
};
const fence: BackendDetailFence = { backendGeneration: 2, coordinatorGeneration: 3, workerId: 'worker-1', workerGeneration: 4 };
const payload = {
  kind: 'json-segment' as const, encoding: 'utf8-json' as const, segmentId: 'segment-1', semanticPath: [],
  startByte: 0, endByte: 4, totalBytes: 4, startCodePoint: 0, endCodePoint: 4, totalCodePoints: 4, text: 'null',
};
const checksum = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
const durableRef = {
  key: 'durable:key', kind: 'tool-result' as const, source: 'durable' as const,
  sessionPath: address.sessionPath, messageId: 'entry-1', toolCallId: 'tool-1',
  sourceRevision: 1, sizeBytes: 4, summary: 'detail', childCount: 1, available: true,
};

test('public detail protocol accepts subscribe/unsubscribe/fetch and exactly six stream variants', () => {
  const inbound = [
    { kind: 'detail.subscribe', requestId: 'request-1', subscriptionId: 'subscription-1', address, cursor: { revision: 1, pageIndex: 0 }, maxPageBytes: 4096 },
    { kind: 'detail.unsubscribe', requestId: 'request-2', subscriptionId: 'subscription-1', reason: 'collapse' },
    { kind: 'detail.fetch', requestId: 'request-3', subscriptionId: 'subscription-1', address, ref: { baselineRevision: 1, pageIndex: 0, pageCount: 1 }, maxPageBytes: 4096 },
  ];
  const outbound = [
    { kind: 'detail.start', subscriptionId: 'subscription-1', address, source: 'live', baselineRevision: 1, pageCount: 1, totalBytes: 4, totalCodePoints: 4, fence },
    { kind: 'detail.page', subscriptionId: 'subscription-1', ref: { baselineRevision: 1, pageIndex: 0, pageCount: 1 }, payload, payloadBytes: Buffer.byteLength(JSON.stringify(payload)), checksum, fence },
    { kind: 'detail.delta', subscriptionId: 'subscription-1', baseRevision: 1, revision: 2, operations: [{ op: 'appendString', path: ['text'], value: 'x' }], fence },
    { kind: 'detail.rebase', subscriptionId: 'subscription-1', currentRevision: 3, reason: 'gap', fence },
    { kind: 'detail.terminal', subscriptionId: 'subscription-1', revision: 3, durableRef, fence },
    { kind: 'detail.error', subscriptionId: 'subscription-1', code: 'UNAVAILABLE', message: 'retry', retryable: true, fence },
  ];
  assert.ok(inbound.every(isHostToCoordinatorDetailMessage));
  assert.ok(outbound.every(isCoordinatorToHostDetailMessage));
  assert.equal(outbound.length, 6);
});

test('closed detail validators reject revision identity, legacy/synthesized lineage, extras, checksum shape, and partial worker fences', () => {
  assert.equal(isLiveSubagentDetailAddress({ ...address, revision: 1 }), false);
  assert.equal(isLiveSubagentDetailAddress({ ...address, lineage: [] }), false);
  assert.equal(isLiveSubagentDetailAddress({ ...address, lineage: [{ childId: 'legacy-index:0', spawningToolCallId: '', attemptId: '' }] }), false);
  assert.equal(isHostToCoordinatorDetailMessage({ kind: 'detail.subscribe', requestId: 'r', subscriptionId: 's', address, maxPageBytes: 1, extra: true }), false);
  assert.equal(isCoordinatorToHostDetailMessage({
    kind: 'detail.page', subscriptionId: 's', ref: { baselineRevision: 1, pageIndex: 0, pageCount: 1 },
    payload, payloadBytes: 3, checksum, fence,
  }), false);
  assert.equal(isCoordinatorToHostDetailMessage({
    kind: 'detail.rebase', subscriptionId: 's', currentRevision: 1, reason: 'gap',
    fence: { backendGeneration: 1, coordinatorGeneration: 1, workerId: 'worker-only' },
  }), false);
});
