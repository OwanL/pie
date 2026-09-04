import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BoundedEventLoopHistogram,
  createBoundedLivePipelineTraceFingerprint,
  createHardenedLivePipelineTraceIdentifier,
  createLivePipelineTraceRecord,
  isLivePipelineTraceKind,
  isLivePipelineTraceOutcome,
  isLivePipelineTraceStage,
  LIVE_PIPELINE_TRACE_EVENT_LOOP_BUCKET_MS,
  LIVE_PIPELINE_TRACE_KINDS,
  LIVE_PIPELINE_TRACE_OUTCOMES,
  LIVE_PIPELINE_TRACE_SCHEMA_VERSION,
  LIVE_PIPELINE_TRACE_STAGES,
} from '../../../src/shared/live-pipeline-trace';

test('schema locks stage and kind to explicit operation allowlists', () => {
  for (const stage of LIVE_PIPELINE_TRACE_STAGES) assert.equal(isLivePipelineTraceStage(stage), true);
  for (const kind of LIVE_PIPELINE_TRACE_KINDS) assert.equal(isLivePipelineTraceKind(kind), true);
  for (const outcome of LIVE_PIPELINE_TRACE_OUTCOMES) assert.equal(isLivePipelineTraceOutcome(outcome), true);
  assert.equal(isLivePipelineTraceStage('command'), false);
  assert.equal(isLivePipelineTraceKind('raw error'), false);
  assert.equal(isLivePipelineTraceOutcome('unchanged'), false);
});

test('hardened identifiers are stable for a key and resist low-entropy guessing', () => {
  const first = createHardenedLivePipelineTraceIdentifier('private-session-id', 'test-key');
  assert.equal(first, createHardenedLivePipelineTraceIdentifier('private-session-id', 'test-key'));
  assert.notEqual(first, createHardenedLivePipelineTraceIdentifier('private-session-id', 'other-key'));
  assert.equal(first.includes('private-session-id'), false);
});

test('bounded fingerprints contain only length, bounded bytes, and hash', () => {
  const fingerprint = createBoundedLivePipelineTraceFingerprint('😀'.repeat(5_000), 64);
  assert.deepEqual(Object.keys(fingerprint).sort(), ['bytes', 'hash', 'length']);
  assert.equal(fingerprint.length, 10_000);
  assert.ok(fingerprint.bytes <= 64);
  assert.match(fingerprint.hash, /^[a-f0-9]{64}$/u);
});

test('record creation joins hardened IDs while copying only closed metadata', () => {
  const fingerprint = createBoundedLivePipelineTraceFingerprint('sensitive payload', 32);
  const record = createLivePipelineTraceRecord({
    process: 'backend',
    stage: 'backend.mapped',
    kind: 'success',
    identifiers: { session: 'private-session-id', turn: 'turn-1' },
    eventKind: 'text',
    eventSeq: 3,
    durationMs: 12,
    fingerprint,
  }, { hmacKey: 'test-key', wallTimestampMs: 1_234, monoMs: 25 });

  assert.equal(record.schemaVersion, LIVE_PIPELINE_TRACE_SCHEMA_VERSION);
  assert.equal(record.ts, new Date(1_234).toISOString());
  assert.equal(record.monoMs, 25);
  assert.equal(record.sessionHash, createHardenedLivePipelineTraceIdentifier('private-session-id', 'test-key'));
  assert.equal(record.turnHash, createHardenedLivePipelineTraceIdentifier('turn-1', 'test-key'));
  assert.equal(record.eventSeq, 3);
  assert.equal(JSON.stringify(record).includes('private-session-id'), false);
  assert.equal(JSON.stringify(record).includes('sensitive payload'), false);
  assert.equal('error' in record || 'path' in record || 'command' in record, false);
});

test('semantic operation and incident records HMAC IDs and reject free-form metadata', () => {
  const record = createLivePipelineTraceRecord({
    process: 'host',
    processRole: 'host',
    stage: 'host.operation.transition',
    kind: 'success',
    identifiers: {
      session: '/private/session.jsonl?authorization=secret',
      operation: 'operation-internal-123',
      incident: 'incident-internal-456',
    },
    operationKind: 'message.edit',
    previousOperationPhase: 'ambiguous',
    operationPhase: 'settled',
    operationAcceptance: 'accepted',
    operationCommit: 'committed',
    operationTerminalOutcome: 'settled',
    operationTerminalReason: 'durable-commit-observed',
  }, { hmacKey: 'test-key', wallTimestampMs: 1, monoMs: 2 });

  assert.equal(record.operationHash, createHardenedLivePipelineTraceIdentifier('operation-internal-123', 'test-key'));
  assert.equal(record.incidentHash, createHardenedLivePipelineTraceIdentifier('incident-internal-456', 'test-key'));
  assert.equal(record.operationKind, 'message.edit');
  assert.equal(record.operationPhase, 'settled');
  const serialized = JSON.stringify(record);
  assert.doesNotMatch(serialized, /private|authorization|secret|internal-123|internal-456/u);
  assert.equal('requestId' in record || 'operationId' in record || 'detail' in record || 'message' in record, false);

  assert.throws(() => createLivePipelineTraceRecord({
    process: 'host', stage: 'host.operation.transition', kind: 'transition',
    operationKind: 'credential=secret' as never,
  }, { hmacKey: 'key', wallTimestampMs: 1, monoMs: 1 }), RangeError);
});

test('Phase 0 schema carries process, event-loop, writer, and bounded recursive metrics without content', () => {
  const record = createLivePipelineTraceRecord({
    process: 'backend',
    processRole: 'coordinator',
    pid: 42,
    coordinatorGeneration: 3,
    workerGeneration: 2,
    stage: 'backend.event_loop',
    kind: 'observation',
    identifiers: { workerId: 'worker-a', session: 'private-session' },
    phase: 'service_loading',
    writerLane: 'control',
    queueDepth: 4,
    queueBytes: 128,
    queueOldestAgeMs: 12,
    writeDurationMs: 3,
    eventLoopDelayMs: 4,
    eventLoopMaxDelayMs: 9,
    sourcePayloadBytes: 512,
    producedPayloadBytes: 96,
    childCount: 2,
    messageCount: 7,
    maxRecursiveDepth: 3,
    detailSubscriberCount: 1,
  }, { hmacKey: 'test-key', wallTimestampMs: 1, monoMs: 2 });

  assert.equal(record.processRole, 'coordinator');
  assert.equal(record.pid, 42);
  assert.equal(record.workerIdHash, createHardenedLivePipelineTraceIdentifier('worker-a', 'test-key'));
  assert.equal(record.eventLoopMaxDelayMs, 9);
  assert.equal(record.writerLane, 'control');
  assert.equal(record.maxRecursiveDepth, 3);
  assert.equal(JSON.stringify(record).includes('private-session'), false);
  assert.equal('prompt' in record || 'payload' in record || 'body' in record, false);
});

test('Phase 0 writer evidence carries stable identity, active-write lane, and ahead-of-response booleans', () => {
  const record = createLivePipelineTraceRecord({
    process: 'backend',
    stage: 'backend.writer.queued',
    kind: 'start',
    writerLane: 'progress',
    writerSeq: 7,
    activeWriteSeq: 4,
    activeWriteLane: 'response',
    aheadOfResponse: false,
    queuedBehindResponse: true,
    queueDepth: 3,
    producedPayloadBytes: 96,
  }, { hmacKey: 'key', wallTimestampMs: 1, monoMs: 1 });
  assert.equal(record.writerSeq, 7);
  assert.equal(record.activeWriteSeq, 4);
  assert.equal(record.activeWriteLane, 'response');
  assert.equal(record.aheadOfResponse, false);
  assert.equal(record.queuedBehindResponse, true);

  const settled = createLivePipelineTraceRecord({
    process: 'backend',
    stage: 'backend.writer.settled',
    kind: 'success',
    writerSeq: 7,
    aheadOfResponse: true,
  }, { hmacKey: 'key', wallTimestampMs: 1, monoMs: 1 });
  assert.equal(settled.writerSeq, 7);
  assert.equal(settled.aheadOfResponse, true);

  assert.throws(() => createLivePipelineTraceRecord({
    process: 'backend', stage: 'backend.writer.queued', kind: 'start',
    activeWriteLane: 'unknown' as never,
  }, { hmacKey: 'key', wallTimestampMs: 1, monoMs: 1 }), RangeError);
  assert.throws(() => createLivePipelineTraceRecord({
    process: 'backend', stage: 'backend.writer.queued', kind: 'start',
    writerSeq: -1,
  }, { hmacKey: 'key', wallTimestampMs: 1, monoMs: 1 }), RangeError);
  assert.throws(() => createLivePipelineTraceRecord({
    process: 'backend', stage: 'backend.writer.queued', kind: 'start',
    activeWriteSeq: 1.5,
  }, { hmacKey: 'key', wallTimestampMs: 1, monoMs: 1 }), RangeError);
});

test('Phase 0 schema rejects invalid process and writer metadata', () => {
  assert.throws(() => createLivePipelineTraceRecord({
    process: 'backend', stage: 'backend.event_loop', kind: 'observation',
    processRole: 'not-a-role' as never,
  }, { hmacKey: 'key', wallTimestampMs: 1, monoMs: 1 }), RangeError);
  assert.throws(() => createLivePipelineTraceRecord({
    process: 'backend', stage: 'backend.writer.queued', kind: 'start',
    writerLane: 'unknown' as never,
  }, { hmacKey: 'key', wallTimestampMs: 1, monoMs: 1 }), RangeError);
});

test('record creation rejects invalid numeric and arbitrary classification metadata', () => {
  assert.throws(() => createLivePipelineTraceRecord({
    process: 'host', stage: 'host.post.timeout', kind: 'timeout', durationMs: -1,
  }, { hmacKey: 'key', wallTimestampMs: 1, monoMs: 1 }), RangeError);
  assert.throws(() => createLivePipelineTraceRecord({
    process: 'host', stage: 'host.recovery.action', kind: 'recovery', reasonCode: 'raw body' as never,
  }, { hmacKey: 'key', wallTimestampMs: 1, monoMs: 1 }), RangeError);
});

test('Phase 0 records carry shared run identity and process-local sequence', () => {
  const record = createLivePipelineTraceRecord({
    process: 'backend', stage: 'backend.event_loop', kind: 'observation',
  }, { hmacKey: 'test-key', wallTimestampMs: 1, monoMs: 2, runId: 'run-abc', processSeq: 7 });
  assert.equal(record.runIdHash, createHardenedLivePipelineTraceIdentifier('run-abc', 'test-key'));
  assert.equal(record.processSeq, 7);
  assert.equal(JSON.stringify(record).includes('run-abc'), false);
  const without = createLivePipelineTraceRecord({
    process: 'backend', stage: 'backend.event_loop', kind: 'observation',
  }, { hmacKey: 'test-key', wallTimestampMs: 1, monoMs: 2 });
  assert.equal('runIdHash' in without, false);
  assert.equal('processSeq' in without, false);
  assert.throws(() => createLivePipelineTraceRecord({
    process: 'backend', stage: 'backend.event_loop', kind: 'observation',
  }, { hmacKey: 'key', wallTimestampMs: 1, monoMs: 1, processSeq: -1 }), RangeError);
});

test('Phase 0 payload classification and semantic-change outcome are closed and optional', () => {
  for (const outcome of LIVE_PIPELINE_TRACE_OUTCOMES) {
    const record = createLivePipelineTraceRecord({
      process: 'backend', stage: 'backend.subagent', kind: 'observation',
      outcome, payloadClass: 'compact', sourcePayloadBytes: 10, producedPayloadBytes: 4,
    }, { hmacKey: 'key', wallTimestampMs: 1, monoMs: 1 });
    assert.equal(record.outcome, outcome);
    assert.equal(record.payloadClass, 'compact');
    assert.equal(record.sourcePayloadBytes, 10);
    assert.equal(record.producedPayloadBytes, 4);
  }
  assert.throws(() => createLivePipelineTraceRecord({
    process: 'backend', stage: 'backend.subagent', kind: 'observation',
    outcome: 'unchanged' as never,
  }, { hmacKey: 'key', wallTimestampMs: 1, monoMs: 1 }), RangeError);
  assert.throws(() => createLivePipelineTraceRecord({
    process: 'backend', stage: 'backend.subagent', kind: 'observation',
    outcome: 'raw body' as never,
  }, { hmacKey: 'key', wallTimestampMs: 1, monoMs: 1 }), RangeError);
  assert.throws(() => createLivePipelineTraceRecord({
    process: 'backend', stage: 'backend.subagent', kind: 'observation',
    payloadClass: 'raw body' as never,
  }, { hmacKey: 'key', wallTimestampMs: 1, monoMs: 1 }), RangeError);
  assert.throws(() => createLivePipelineTraceRecord({
    process: 'backend', stage: 'backend.subagent', kind: 'observation',
    detailDelivery: 'fabricated' as never,
  }, { hmacKey: 'key', wallTimestampMs: 1, monoMs: 1 }), RangeError);

  const terminalTransport = createLivePipelineTraceRecord({
    process: 'backend', stage: 'backend.subagent', kind: 'success',
    payloadClass: 'terminal_transport', producedPayloadBytes: 128,
  }, { hmacKey: 'key', wallTimestampMs: 1, monoMs: 1 });
  assert.equal(terminalTransport.payloadClass, 'terminal_transport');
  assert.equal(terminalTransport.producedPayloadBytes, 128);

  for (const payloadClass of ['detail_baseline', 'detail_page'] as const) {
    const unavailable = createLivePipelineTraceRecord({
      process: 'backend', stage: 'backend.subagent', kind: 'observation', payloadClass,
      availabilityReason: 'detail_delivery_not_implemented_until_phase_5',
    }, { hmacKey: 'key', wallTimestampMs: 1, monoMs: 1 });
    assert.equal(unavailable.producedPayloadBytes, undefined);
    assert.equal(unavailable.availabilityReason, 'detail_delivery_not_implemented_until_phase_5');
  }
  assert.throws(() => createLivePipelineTraceRecord({
    process: 'backend', stage: 'backend.subagent', kind: 'observation',
    payloadClass: 'terminal_append', availabilityReason: 'made-up' as never,
  }, { hmacKey: 'key', wallTimestampMs: 1, monoMs: 1 }), RangeError);
});

test('bounded event-loop histogram folds delays into fixed buckets with max and drift', () => {
  const histogram = new BoundedEventLoopHistogram();
  histogram.record(0.5);
  histogram.record(1);
  histogram.record(4.9);
  histogram.record(25);
  histogram.record(9_999);
  histogram.record(-1);
  histogram.record(Number.NaN);
  histogram.recordDrift(3);
  histogram.recordDrift(Number.NaN);
  const snapshot = histogram.snapshot();
  assert.equal(snapshot.samples, 5);
  assert.equal(snapshot.maxMs, 9_999);
  assert.equal(snapshot.driftMs, 3);
  assert.equal(snapshot.counts.length, LIVE_PIPELINE_TRACE_EVENT_LOOP_BUCKET_MS.length);
  assert.deepEqual(snapshot.counts, [1, 2, 0, 0, 1, 0, 0, 0, 0, 1]);
  assert.throws(() => new BoundedEventLoopHistogram([]), RangeError);
  assert.throws(() => new BoundedEventLoopHistogram([5, 1]), RangeError);
  assert.throws(() => new BoundedEventLoopHistogram([Number.NaN]), RangeError);
  histogram.reset();
  assert.deepEqual(histogram.snapshot(), {
    bucketMs: [...LIVE_PIPELINE_TRACE_EVENT_LOOP_BUCKET_MS],
    counts: new Array(LIVE_PIPELINE_TRACE_EVENT_LOOP_BUCKET_MS.length).fill(0),
    samples: 0,
    maxMs: 0,
  });
});

test('event-loop histogram record validation is bounded and rejects malformed snapshots', () => {
  const valid = createLivePipelineTraceRecord({
    process: 'backend', stage: 'backend.event_loop', kind: 'observation',
    eventLoopHistogram: { bucketMs: [1, 5], counts: [2, 3], samples: 5, maxMs: 4, driftMs: 0.5 },
  }, { hmacKey: 'key', wallTimestampMs: 1, monoMs: 1 });
  assert.deepEqual(valid.eventLoopHistogram, { bucketMs: [1, 5], counts: [2, 3], samples: 5, maxMs: 4, driftMs: 0.5 });
  const base = { process: 'backend' as const, stage: 'backend.event_loop' as const, kind: 'observation' as const };
  const options = { hmacKey: 'key', wallTimestampMs: 1, monoMs: 1 };
  assert.throws(() => createLivePipelineTraceRecord({
    ...base, eventLoopHistogram: { bucketMs: [1, 5], counts: [1], samples: 1, maxMs: 1 },
  }, options), RangeError);
  assert.throws(() => createLivePipelineTraceRecord({
    ...base, eventLoopHistogram: { bucketMs: [1, 5], counts: [1, -2], samples: 1, maxMs: 1 },
  }, options), RangeError);
  assert.throws(() => createLivePipelineTraceRecord({
    ...base, eventLoopHistogram: { bucketMs: [5, 1], counts: [1, 1], samples: 2, maxMs: 5 },
  }, options), RangeError);
  assert.throws(() => createLivePipelineTraceRecord({
    ...base, eventLoopHistogram: { bucketMs: [1, 5], counts: [1, 1], samples: 2, maxMs: Number.NaN },
  }, options), RangeError);
  assert.throws(() => createLivePipelineTraceRecord({
    ...base, eventLoopHistogram: { bucketMs: [1, 5], counts: [1, 1], samples: 2, maxMs: 5, driftMs: Number.NaN },
  }, options), RangeError);
});
