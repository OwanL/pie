import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type {
  AnalyticsCaptureSubject,
  AnalyticsDetailCapture,
  AnalyticsObservation,
} from '../../../shared/analytics/contracts.js';
import { deriveAnalyticsIdempotencyKey } from '../../../shared/analytics/contracts.js';
import {
  ANALYTICS_TRANSPORT_DETAIL_CHUNK_BYTES,
  ANALYTICS_TRANSPORT_MAX_DETAIL_START_BYTES,
  ANALYTICS_TRANSPORT_MAX_DETAIL_CHUNKS,
  ANALYTICS_TRANSPORT_MAX_FACT_BYTES,
  canonicalAnalyticsToolEntityId,
  createAnalyticsDetailPackets,
  createAnalyticsFactPacket,
  parseAnalyticsTransportAcknowledgement,
  parseAnalyticsTransportIngressEnvelope,
  parseAnalyticsTransportPacket,
  type AnalyticsTransportAcknowledgement,
  type AnalyticsTransportDetailChunkPacket,
  type AnalyticsTransportPacket,
} from '../../../shared/analytics/transport.js';

function subject(rootSessionId = 'root-1'): AnalyticsCaptureSubject {
  return { kind: 'session', rootSessionId };
}

function observation(overrides: Partial<AnalyticsObservation<object>> = {}): AnalyticsObservation<object> {
  const result: AnalyticsObservation<object> = {
    schemaVersion: 1,
    generationId: 'generation-1',
    producerKind: 'host',
    stableOriginId: 'host-origin-1',
    sourceSequence: 1n,
    sourceKey: 'source-1',
    entityKind: 'toolCall',
    entityKey: 'tool-1',
    observationKind: 'observation',
    idempotencyKey: 'idempotency-1',
    observedAtMs: 100n,
    scope: {
      workspaceCoverage: 'known',
      workspaceId: 'workspace-1',
      sessionId: 'root-1',
      rootSessionId: 'root-1',
      toolCallId: 'tool-1',
    },
    captureSubject: subject(),
    producer: {
      buildId: 'build-1',
      processId: 10,
      processGeneration: 'process-1',
    },
    fields: { count: 1n },
    ...overrides,
  };
  result.idempotencyKey = deriveAnalyticsIdempotencyKey(result);
  return result;
}

function detail(size: number, overrides: Partial<AnalyticsDetailCapture> = {}): AnalyticsDetailCapture {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
  return {
    schemaVersion: 1,
    generationId: 'generation-1',
    stableOriginId: 'host-origin-1',
    producerKind: 'host',
    producer: { buildId: 'build-1', processId: 10, processGeneration: 'process-1' },
    payloadId: `payload-${size}`,
    sourceKey: `detail-source-${size}`,
    observedAtMs: 100n,
    captureSubject: subject(),
    mediaType: 'application/x-pie-tool-observation',
    encoding: 'node-v8',
    complete: true,
    bytes,
    metadata: { childId: 'child-1', attemptId: 'attempt-1', captureStage: 'end' },
    ...overrides,
  };
}

function expectPacketRejected(value: unknown): void {
  assert.throws(() => parseAnalyticsTransportPacket(value));
}

function expectAcknowledgementRejected(value: unknown): void {
  assert.throws(() => parseAnalyticsTransportAcknowledgement(value));
}

test('canonical parent tool IDs are stable and session-scoped', () => {
  const first = canonicalAnalyticsToolEntityId('session-a', 'tool-a');
  assert.equal(first, canonicalAnalyticsToolEntityId('session-a', 'tool-a'));
  assert.notEqual(first, canonicalAnalyticsToolEntityId('session-b', 'tool-a'));
  assert.notEqual(first, canonicalAnalyticsToolEntityId('session-a', 'tool-b'));
  assert.match(first, /^tool:[0-9a-f]{64}$/);
  assert.equal(first.includes('tool-a'), false);
  assert.throws(() => canonicalAnalyticsToolEntityId('', 'tool-a'));
  assert.throws(() => canonicalAnalyticsToolEntityId('session-a', '\0tool'));
});

test('fact packets normalize bigint values to canonical decimal strings and reject unsafe shape/size', () => {
  const packet = createAnalyticsFactPacket(observation({
    fields: { count: 9007199254740993n, nested: { total: -9223372036854775808n } },
  }));
  assert.equal(packet.observation.sourceSequence, '1');
  assert.deepEqual(packet.observation.fields, {
    count: '9007199254740993',
    nested: { total: '-9223372036854775808' },
  });
  assert.deepEqual(parseAnalyticsTransportPacket(packet), packet);

  const oversized = observation({ fields: { blob: 'x'.repeat(ANALYTICS_TRANSPORT_MAX_FACT_BYTES) } });
  assert.throws(() => createAnalyticsFactPacket(oversized), /transport bound/);

  let complex: Record<string, unknown> = {};
  for (let index = 0; index < 34; index += 1) complex = { next: complex };
  assert.throws(() => createAnalyticsFactPacket(observation({ fields: complex })), /structurally too complex/);
  const unsafe = JSON.parse('{"nested":{"__proto__":{"changed":true}}}') as Record<string, unknown>;
  assert.throws(() => createAnalyticsFactPacket(observation({ fields: unsafe })), /unsafe object key/);

  const fact = createAnalyticsFactPacket(observation());
  expectPacketRejected({ ...fact, generationId: 'generation-2' });
  expectPacketRejected({ ...fact, unexpected: true });
  expectPacketRejected({ ...fact, deliveryId: 'forged-delivery' });
  expectPacketRejected({ ...fact, captureSubject: subject('other-root') });
  expectPacketRejected({
    ...fact,
    observation: { ...fact.observation, captureSubject: subject('other-root') },
  });
  expectPacketRejected({ ...fact, observation: { ...fact.observation, fields: complex } });
  expectPacketRejected({ ...fact, observation: { ...fact.observation, fields: unsafe } });
});

test('detail start/chunk/end packets round-trip empty, boundary and 2MiB payloads', () => {
  for (const size of [0, ANALYTICS_TRANSPORT_DETAIL_CHUNK_BYTES, 2 * 1024 * 1024]) {
    const capture = detail(size);
    const packets = createAnalyticsDetailPackets(capture);
    const parsed = packets.map(parseAnalyticsTransportPacket);
    const start = parsed[0];
    const end = parsed[parsed.length - 1];
    if (start?.kind !== 'detail.start' || end?.kind !== 'detail.end') throw new Error('detail framing is incomplete');
    const chunks = parsed.filter(
      (packet): packet is AnalyticsTransportDetailChunkPacket => packet.kind === 'detail.chunk',
    );
    const expectedChunkCount = Math.max(1, Math.ceil(size / ANALYTICS_TRANSPORT_DETAIL_CHUNK_BYTES));
    assert.equal(start.byteLength, size);
    assert.equal(start.chunkCount, expectedChunkCount);
    assert.equal(chunks.length, expectedChunkCount);
    assert.equal(end.chunkCount, expectedChunkCount);
    assert.equal(start.sha256, createHash('sha256').update(capture.bytes).digest('hex'));
    assert.equal(end.sha256, start.sha256);
    assert.equal(end.payloadId, capture.payloadId);
    assert.equal(start.detail.generationId, capture.generationId);
    assert.equal(start.detail.observedAtMs, '100');
    assert.deepEqual(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data, 'base64'))),
      Buffer.from(capture.bytes),
    );
    for (const [index, chunk] of chunks.entries()) {
      assert.equal(chunk.index, index);
      assert.equal(chunk.deliveryId, start.deliveryId);
      assert.equal(chunk.generationId, start.generationId);
      assert.deepEqual(chunk.captureSubject, start.captureSubject);
      assert.equal(chunk.payloadId, start.payloadId);
    }
  }
});

test('detail packets reject malformed base64, inconsistent metadata and oversized counts', () => {
  const packets = createAnalyticsDetailPackets(detail(1));
  const start = packets[0]!;
  const chunk = packets[1]!;
  const end = packets[packets.length - 1]!;
  assert.equal(start.kind, 'detail.start');
  assert.equal(chunk.kind, 'detail.chunk');
  assert.equal(end.kind, 'detail.end');

  expectPacketRejected({ ...chunk, data: 'A' });
  expectPacketRejected({ ...chunk, data: 'AA' });
  // A chunk is independently shape-valid; its generation/subject/delivery
  // relationship is checked by the bounded host assembler against start.
  expectPacketRejected({ ...start, captureSubject: subject('other-root') });
  expectPacketRejected({ ...start, unexpected: true });
  expectPacketRejected({ ...start, deliveryId: 'forged-delivery' });
  expectPacketRejected({ ...start, detail: { ...(start as Extract<AnalyticsTransportPacket, { kind: 'detail.start' }>).detail, sourceKey: 'wrong-source' } });
  expectPacketRejected({ ...start, chunkCount: ANALYTICS_TRANSPORT_MAX_DETAIL_CHUNKS + 1 });
  expectPacketRejected({ ...start, byteLength: ANALYTICS_TRANSPORT_DETAIL_CHUNK_BYTES + 1, chunkCount: 1 });
  assert.throws(() => createAnalyticsDetailPackets(detail(1, {
    metadata: { captureStage: 'x'.repeat(ANALYTICS_TRANSPORT_MAX_DETAIL_START_BYTES) },
  })), /bounded non-empty string/);
  expectPacketRejected({
    ...start,
    detail: {
      ...(start as Extract<AnalyticsTransportPacket, { kind: 'detail.start' }>).detail,
      metadata: { captureStage: 'x'.repeat(ANALYTICS_TRANSPORT_MAX_DETAIL_START_BYTES) },
    },
  });
  expectPacketRejected({ ...end, sha256: 'not-a-sha256' });
});

test('acknowledgements preserve reordered object fields and reject malformed int64/count shapes', () => {
  const reconciliation = {
    producerIdentity: 'producer-1',
    contiguousWatermark: 3,
    highestObservedSequence: 12,
    visibleGaps: [{ from: '4', to: '6' }],
    pendingReceiptCount: 6,
  };
  const acknowledgement: AnalyticsTransportAcknowledgement = {
    version: 1,
    deliveryId: 'delivery-1',
    generationId: 'generation-1',
    status: 'durable',
    producerReconciliation: [reconciliation],
  };
  const reordered = {
    producerReconciliation: acknowledgement.producerReconciliation,
    status: acknowledgement.status,
    generationId: acknowledgement.generationId,
    deliveryId: acknowledgement.deliveryId,
    version: acknowledgement.version,
  };
  assert.deepEqual(parseAnalyticsTransportAcknowledgement(reordered), reordered);

  for (const value of ['01', '+1', '1.0', '1e3', '', Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 1, '9223372036854775808']) {
    expectAcknowledgementRejected({
      ...acknowledgement,
      producerReconciliation: [{ ...reconciliation, contiguousWatermark: value }],
    });
  }
  expectAcknowledgementRejected({
    ...acknowledgement,
    producerReconciliation: Array.from({ length: 257 }, () => reconciliation),
  });
  expectAcknowledgementRejected({
    ...acknowledgement,
    producerReconciliation: [{ ...reconciliation, visibleGaps: Array.from({ length: 4_097 }, (_entry, index) => ({
      from: 4 + index * 2,
      to: 4 + index * 2,
    })) }],
  });
  expectAcknowledgementRejected({
    ...acknowledgement,
    producerReconciliation: [{ ...reconciliation, pendingReceiptCount: Number.MAX_SAFE_INTEGER + 1 }],
  });
  expectAcknowledgementRejected({ ...acknowledgement, producerReconciliation: {} });
  expectAcknowledgementRejected({ ...acknowledgement, producerReconciliation: [reconciliation, reconciliation] });
  for (const invalid of [
    { ...reconciliation, contiguousWatermark: -1 },
    { ...reconciliation, contiguousWatermark: 13 },
    { ...reconciliation, visibleGaps: [{ from: 6, to: 4 }] },
    { ...reconciliation, visibleGaps: [{ from: 3, to: 4 }] },
    { ...reconciliation, visibleGaps: [{ from: 4, to: 13 }] },
    { ...reconciliation, visibleGaps: [{ from: 7, to: 8 }, { from: 5, to: 6 }] },
    { ...reconciliation, visibleGaps: [{ from: 4, to: 7 }, { from: 7, to: 8 }] },
    { ...reconciliation, pendingReceiptCount: 5 },
  ]) expectAcknowledgementRejected({ ...acknowledgement, producerReconciliation: [invalid] });
  expectAcknowledgementRejected({ ...acknowledgement, unexpected: true });
  expectAcknowledgementRejected({ ...acknowledgement, code: 'bad', message: 'bad' });
  expectAcknowledgementRejected({ ...acknowledgement, completeDetailPayloadId: 'payload-1' });
  expectAcknowledgementRejected({ ...acknowledgement, status: 'rejected' });
  expectAcknowledgementRejected({ ...acknowledgement, status: 'rejected', code: 'bad', message: 'bad' });
  assert.deepEqual(parseAnalyticsTransportAcknowledgement({
    version: 1,
    deliveryId: 'delivery-2',
    generationId: 'generation-1',
    status: 'rejected',
    code: 'subject_deleted',
    message: 'deleted',
  }), {
    version: 1,
    deliveryId: 'delivery-2',
    generationId: 'generation-1',
    status: 'rejected',
    code: 'subject_deleted',
    message: 'deleted',
  });
});

test('ingress route parser rejects malformed and broadened route identities', () => {
  const packet = createAnalyticsFactPacket(observation());
  const route = {
    coordinatorGeneration: 1,
    workerId: 'worker-1',
    workerGeneration: 2,
    workerPid: 123,
    rootSessionPath: 'C:/sessions/root.jsonl',
    leasePath: 'C:/sessions/root.jsonl',
    leaseRevision: 3,
  };
  assert.deepEqual(parseAnalyticsTransportIngressEnvelope({ route, packet }), { route, packet });
  for (const invalidRoute of [
    { ...route, workerPid: 0 },
    { ...route, leaseRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...route, leasePath: '' },
    { ...route, unexpected: true },
  ]) assert.throws(() => parseAnalyticsTransportIngressEnvelope({ route: invalidRoute, packet }));
});
