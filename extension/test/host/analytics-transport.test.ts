import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  AnalyticsCaptureSubject,
  AnalyticsDetailCapture,
  AnalyticsObservation,
} from '../../../shared/analytics/contracts.js';
import { deriveAnalyticsIdempotencyKey } from '../../../shared/analytics/contracts.js';
import {
  ANALYTICS_ROUTE_CLOSED_EVENT,
  ANALYTICS_TRANSPORT_DETAIL_CHUNK_BYTES,
  ANALYTICS_TRANSPORT_MAX_DETAIL_BYTES,
  ANALYTICS_TRANSPORT_MAX_DETAIL_CHUNKS,
  analyticsProducerIdentity,
  createAnalyticsDetailAbortPacket,
  createAnalyticsDetailPackets,
  createAnalyticsFactPacket,
  type AnalyticsTransportAcknowledgement,
  type AnalyticsTransportDetailChunkPacket,
  type AnalyticsTransportDetailEndPacket,
  type AnalyticsTransportDetailStartPacket,
  type AnalyticsTransportIngressEnvelope,
  type AnalyticsTransportPacket,
  type AnalyticsTransportRoute,
} from '../../../shared/analytics/transport.js';
import {
  HostAnalyticsTransport,
  type AnalyticsTransportBackend,
  type HostAnalyticsRecorder,
} from '../../src/host/analytics-transport.js';
import type { EventEnvelope } from '../../src/shared/protocol.js';
import type { AnalyticsRecorderCaptureDisposition } from '../../src/analytics/recorder-supervisor.js';

const route: AnalyticsTransportRoute = {
  coordinatorGeneration: 1,
  workerId: 'worker-1',
  workerGeneration: 1,
  workerPid: 1234,
  rootSessionPath: 'C:/scratch/session.jsonl',
  leasePath: 'C:/scratch/lease.json',
  leaseRevision: 1,
};

function subject(rootSessionId = 'root-1'): AnalyticsCaptureSubject {
  return { kind: 'session', rootSessionId };
}

function observation(overrides: Partial<AnalyticsObservation<object>> = {}): AnalyticsObservation<object> {
  const value: AnalyticsObservation<object> = {
    schemaVersion: 1,
    generationId: 'generation-1',
    producerKind: 'host',
    stableOriginId: 'host-origin-1',
    sourceSequence: 1,
    sourceKey: 'source-1',
    entityKind: 'toolCall',
    entityKey: 'tool-1',
    observationKind: 'observation',
    idempotencyKey: 'placeholder',
    observedAtMs: 100,
    scope: { workspaceCoverage: 'known', workspaceId: 'workspace-1', rootSessionId: 'root-1', toolCallId: 'tool-1' },
    captureSubject: subject(),
    producer: { buildId: 'build-1', processId: 10, processGeneration: 'process-1' },
    fields: { count: 1 },
    ...overrides,
  };
  value.idempotencyKey = deriveAnalyticsIdempotencyKey(value);
  return value;
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
    observedAtMs: 100,
    captureSubject: subject(),
    mediaType: 'application/x-pie-tool-observation',
    encoding: 'node-v8',
    complete: true,
    bytes,
    metadata: { childId: 'child-1', attemptId: 'attempt-1', captureStage: 'end' },
    ...overrides,
  };
}

function ingress(packet: AnalyticsTransportPacket, routeOverride: Partial<AnalyticsTransportRoute> = {}): AnalyticsTransportIngressEnvelope {
  return { route: { ...route, ...routeOverride }, packet };
}

class FakeBackend implements AnalyticsTransportBackend {
  generation = 1;
  readonly requests: Array<{ method: string; params: unknown }> = [];
  private eventListener?: (event: EventEnvelope) => void;
  private exitListener?: () => void;

  getGeneration(): number {
    return this.generation;
  }

  onEvent(listener: (event: EventEnvelope) => void): { dispose(): void } {
    this.eventListener = listener;
    return { dispose: () => { if (this.eventListener === listener) this.eventListener = undefined; } };
  }

  onExit(listener: () => void): { dispose(): void } {
    this.exitListener = listener;
    return { dispose: () => { if (this.exitListener === listener) this.exitListener = undefined; } };
  }

  request<Result = unknown>(method: string, params?: unknown): Promise<Result> {
    this.requests.push({ method, params });
    return Promise.resolve(undefined as Result);
  }

  emit(value: AnalyticsTransportIngressEnvelope): void {
    this.eventListener?.({ event: 'analytics.capture', payload: value });
  }

  emitRouteClosed(closedRoute: AnalyticsTransportRoute): void {
    this.eventListener?.({ event: ANALYTICS_ROUTE_CLOSED_EVENT, payload: { route: closedRoute } });
  }

  ready(): void {
    this.eventListener?.({ event: 'backend.ready', payload: {} });
  }

  exit(): void {
    this.exitListener?.();
  }
}

class FakeRecorder implements HostAnalyticsRecorder {
  readonly facts: AnalyticsObservation<object>[] = [];
  readonly details: AnalyticsDetailCapture[] = [];
  readonly factDispositions: Array<(disposition: AnalyticsRecorderCaptureDisposition) => void> = [];
  readonly detailDispositions: Array<(disposition: AnalyticsRecorderCaptureDisposition) => void> = [];

  submitTracked(
    value: AnalyticsObservation<object>,
    onDisposition: (disposition: AnalyticsRecorderCaptureDisposition) => void,
  ): void {
    this.facts.push(value);
    this.factDispositions.push(onDisposition);
  }

  submitTrackedDetail(
    value: AnalyticsDetailCapture,
    onDisposition: (disposition: AnalyticsRecorderCaptureDisposition) => void,
  ): void {
    this.details.push(value);
    this.detailDispositions.push(onDisposition);
  }
}

function fixture(options: {
  maxPendingDetails?: number;
  maxPendingDetailBytes?: number;
  buildId?: string;
  workspaceId?: string;
} = {}): {
  backend: FakeBackend;
  recorder: FakeRecorder;
  transport: HostAnalyticsTransport;
  errors: Error[];
} {
  const backend = new FakeBackend();
  const recorder = new FakeRecorder();
  const errors: Error[] = [];
  const transport = new HostAnalyticsTransport({
    generationId: 'generation-1',
    buildId: options.buildId,
    workspaceId: options.workspaceId,
    backend,
    recorder,
    ...options,
    onError: (error) => errors.push(error),
  });
  return { backend, recorder, transport, errors };
}

function acknowledgement(backend: FakeBackend): AnalyticsTransportAcknowledgement {
  const request = backend.requests.at(-1);
  assert.equal(request?.method, 'analytics.ack');
  return (request?.params as { acknowledgement: AnalyticsTransportAcknowledgement }).acknowledgement;
}

function framedDetail(size: number): {
  capture: AnalyticsDetailCapture;
  start: AnalyticsTransportDetailStartPacket;
  chunks: AnalyticsTransportDetailChunkPacket[];
  end: AnalyticsTransportDetailEndPacket;
} {
  const capture = detail(size);
  const packets = createAnalyticsDetailPackets(capture);
  const start = packets[0];
  const end = packets[packets.length - 1];
  const chunks = packets.filter(
    (packet): packet is AnalyticsTransportDetailChunkPacket => packet.kind === 'detail.chunk',
  );
  if (start?.kind !== 'detail.start' || end?.kind !== 'detail.end') throw new Error('invalid test framing');
  return { capture, start, chunks, end };
}

function durable(): AnalyticsRecorderCaptureDisposition {
  return { status: 'durable', producerReconciliation: [], completeDetailWatermark: '1' };
}

test('fact ACK is sent only after recorder disposition and preserves durable/rejected status', () => {
  const { backend, recorder, transport } = fixture();
  const packet = createAnalyticsFactPacket(observation());
  transport.receive(ingress(packet));
  assert.equal(recorder.facts.length, 1);
  assert.equal(backend.requests.length, 0, 'recorder ownership precedes ACK');

  recorder.factDispositions[0]!(durable());
  assert.equal(acknowledgement(backend).status, 'durable');
  assert.equal(acknowledgement(backend).deliveryId, packet.deliveryId);

  const rejectedPacket = createAnalyticsFactPacket(observation({ sourceKey: 'source-2' }));
  transport.receive(ingress(rejectedPacket));
  recorder.factDispositions[1]!({ status: 'rejected', code: 'capture_capacity', message: 'queue full' });
  assert.deepEqual(acknowledgement(backend), {
    version: 1,
    deliveryId: rejectedPacket.deliveryId,
    generationId: 'generation-1',
    status: 'rejected',
    code: 'capture_capacity',
    message: 'queue full',
  });
});

test('current-generation facts with stale producer build or workspace are rejected before recorder ownership', () => {
  for (const overrides of [
    { producer: { buildId: 'stale-build', processId: 10, processGeneration: 'process-1' } },
    { scope: { workspaceCoverage: 'known' as const, workspaceId: 'stale-workspace', rootSessionId: 'root-1' } },
  ]) {
    const { backend, recorder, transport } = fixture({ buildId: 'build-1', workspaceId: 'workspace-1' });
    const packet = createAnalyticsFactPacket(observation(overrides));
    transport.receive(ingress(packet));
    assert.equal(recorder.facts.length, 0);
    assert.equal(acknowledgement(backend).status, 'rejected');
    assert.equal(acknowledgement(backend).code, 'producer_identity');
    transport.dispose();
  }
});

test('shutdown rejects partial detail ownership before late chunks and waits for terminal ACK submission', async () => {
  const framed = framedDetail(ANALYTICS_TRANSPORT_DETAIL_CHUNK_BYTES + 1);
  const { backend, transport } = fixture();
  transport.receive(ingress(framed.start));
  assert.deepEqual(transport.assemblyBacklog, {
    records: 1,
    bytes: framed.start.byteLength,
  });

  await transport.shutdown(100);
  assert.equal(acknowledgement(backend).status, 'rejected');
  assert.equal(acknowledgement(backend).code, 'transport_shutdown');
  assert.deepEqual(transport.assemblyBacklog, { records: 0, bytes: 0 });
  transport.receive(ingress(framed.chunks[0]!));
  assert.equal(backend.requests.length, 1, 'late producer traffic is fenced after shutdown');
  transport.dispose();
});

test('confirmed worker route closure clears only that route detail assemblies', () => {
  const { backend, transport } = fixture();
  const first = framedDetail(1);
  const second = framedDetail(2);
  const secondRoute = { ...route, workerId: 'worker-2', workerGeneration: 2, workerPid: 5678 };
  transport.receive(ingress(first.start));
  transport.receive(ingress(second.start, secondRoute));
  assert.deepEqual(transport.assemblyBacklog, { records: 2, bytes: 3 });

  backend.emitRouteClosed(route);
  assert.deepEqual(transport.assemblyBacklog, { records: 1, bytes: 2 });
  backend.emitRouteClosed({ ...route, workerGeneration: 2 });
  assert.deepEqual(transport.assemblyBacklog, { records: 1, bytes: 2 }, 'nearby identity cannot clear another route');
  backend.emitRouteClosed(secondRoute);
  assert.deepEqual(transport.assemblyBacklog, { records: 0, bytes: 0 });
  assert.equal(backend.requests.length, 0, 'route cleanup does not ACK a dead worker');
  transport.dispose();
});

test('shutdown tracks a deferred recorder disposition before stopping the backend', async () => {
  const { backend, recorder, transport } = fixture();
  const packet = createAnalyticsFactPacket(observation());
  transport.receive(ingress(packet));
  const shutdown = transport.shutdown(200);
  setTimeout(() => recorder.factDispositions[0]!(durable()), 5);
  await shutdown;
  assert.equal(backend.requests.length, 1, 'the deferred disposition is ACKed before shutdown completes');
  assert.equal(acknowledgement(backend).status, 'durable');
});

test('shutdown terminalizes an unresolved recorder disposition and ignores its late callback', async () => {
  const { backend, recorder, transport } = fixture();
  transport.receive(ingress(createAnalyticsFactPacket(observation())));
  await transport.shutdown(15);
  assert.equal(backend.requests.length, 1);
  assert.equal(acknowledgement(backend).code, 'transport_shutdown');
  recorder.factDispositions[0]!(durable());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(backend.requests.length, 1, 'a callback after terminal rejection cannot create a second ACK');
});

test('late recorder dispositions after transport disposal never send an ACK', () => {
  const { backend, recorder, transport } = fixture();
  transport.receive(ingress(createAnalyticsFactPacket(observation())));
  transport.dispose();
  recorder.factDispositions[0]!(durable());
  assert.equal(backend.requests.length, 0);
});

test('stale backend generation is rejected before recorder ownership', () => {
  const { backend, recorder, transport, errors } = fixture();
  backend.generation = 2;
  transport.receive(ingress(createAnalyticsFactPacket(observation())));
  assert.equal(recorder.facts.length, 0);
  assert.equal(backend.requests.length, 0);
  assert.match(errors[0]?.message ?? '', /stale backend generation/);
});

test('detail chunks assemble out of order and ACK only after exact complete persistence', () => {
  const { backend, recorder, transport } = fixture();
  const framed = framedDetail(ANALYTICS_TRANSPORT_DETAIL_CHUNK_BYTES + 17);
  transport.receive(ingress(framed.start));
  transport.receive(ingress(framed.chunks[1]!));
  transport.receive(ingress(framed.chunks[0]!));
  assert.equal(recorder.details.length, 0);
  transport.receive(ingress(framed.end));
  assert.equal(recorder.details.length, 1);
  assert.deepEqual(Buffer.from(recorder.details[0]!.bytes), Buffer.from(framed.capture.bytes));
  assert.deepEqual(transport.assemblyBacklog, { records: 0, bytes: 0 }, 'assembly bytes release at recorder handoff');
  assert.equal(backend.requests.length, 0);
  recorder.detailDispositions[0]!(durable());
  const ack = acknowledgement(backend);
  assert.equal(ack.status, 'durable');
  assert.equal(ack.completeDetailPayloadId, framed.start.payloadId);
});

test('detail end before all chunks rejects and clears the incomplete assembly', () => {
  const { backend, recorder, transport } = fixture();
  const framed = framedDetail(1);
  transport.receive(ingress(framed.start));
  transport.receive(ingress(framed.end));
  assert.equal(recorder.details.length, 0);
  assert.equal(acknowledgement(backend).status, 'rejected');
  assert.equal(acknowledgement(backend).code, 'detail_incomplete');
  transport.receive(ingress(framed.chunks[0]!));
  assert.equal(acknowledgement(backend).code, 'detail_sequence');
});

test('cross-packet detail identity mismatches reject without recorder ownership', () => {
  const framed = framedDetail(1);
  const cases: Array<{
    mutate: (packet: AnalyticsTransportDetailChunkPacket) => AnalyticsTransportDetailChunkPacket;
    expectedCode?: string;
  }> = [
    { mutate: (packet) => ({ ...packet, deliveryId: 'other-delivery' }), expectedCode: 'detail_sequence' },
    { mutate: (packet) => ({ ...packet, generationId: 'other-generation' }) },
    { mutate: (packet) => ({ ...packet, payloadId: 'other-payload' }), expectedCode: 'detail_sequence' },
    { mutate: (packet) => ({ ...packet, captureSubject: subject('other-root') }), expectedCode: 'detail_sequence' },
  ];
  for (const { mutate, expectedCode } of cases) {
    const { backend, recorder, transport, errors } = fixture();
    transport.receive(ingress(framed.start));
    transport.receive(ingress(mutate(framed.chunks[0]!)));
    assert.equal(recorder.details.length, 0);
    if (expectedCode) {
      assert.equal(acknowledgement(backend).status, 'rejected');
      assert.equal(acknowledgement(backend).code, expectedCode);
    } else {
      assert.equal(backend.requests.length, 0);
      assert.match(errors[0]?.message ?? '', /stale analytics generation/);
    }
  }
});

test('exact detail redelivery is idempotent while changed starts/chunks reject', () => {
  const framed = framedDetail(1);
  const startFixture = fixture();
  startFixture.transport.receive(ingress(framed.start));
  const reorderedStart = {
    detail: {
      ...framed.start.detail,
      metadata: {
        captureStage: framed.start.detail.metadata.captureStage,
        attemptId: framed.start.detail.metadata.attemptId,
        childId: framed.start.detail.metadata.childId,
      },
    },
    sha256: framed.start.sha256,
    chunkCount: framed.start.chunkCount,
    byteLength: framed.start.byteLength,
    sourceKey: framed.start.sourceKey,
    payloadId: framed.start.payloadId,
    captureSubject: framed.start.captureSubject,
    generationId: framed.start.generationId,
    deliveryId: framed.start.deliveryId,
    kind: framed.start.kind,
    version: framed.start.version,
  };
  startFixture.transport.receive(ingress(reorderedStart));
  assert.equal(startFixture.backend.requests.length, 0);
  const changedStart = {
    ...framed.start,
    payloadId: 'changed-payload',
    detail: { ...framed.start.detail, payloadId: 'changed-payload' },
  };
  startFixture.transport.receive(ingress(changedStart));
  assert.equal(acknowledgement(startFixture.backend).code, 'detail_conflict');
  startFixture.transport.receive(ingress(framed.chunks[0]!));
  startFixture.transport.receive(ingress(framed.end));
  assert.equal(startFixture.recorder.details.length, 1, 'conflicting start must preserve the accepted assembly');

  const chunkFixture = fixture();
  chunkFixture.transport.receive(ingress(framed.start));
  chunkFixture.transport.receive(ingress(framed.chunks[0]!));
  chunkFixture.transport.receive(ingress(framed.chunks[0]!));
  assert.equal(chunkFixture.backend.requests.length, 0);
  chunkFixture.transport.receive(ingress({ ...framed.chunks[0]!, data: 'AQ==' }));
  assert.equal(acknowledgement(chunkFixture.backend).code, 'detail_conflict');
  chunkFixture.transport.receive(ingress(framed.end));
  assert.equal(chunkFixture.recorder.details.length, 1, 'conflicting chunk must preserve the accepted bytes');

  const endFixture = fixture();
  endFixture.transport.receive(ingress(framed.start));
  endFixture.transport.receive(ingress(framed.chunks[0]!));
  endFixture.transport.receive(ingress({ ...framed.end, sha256: 'f'.repeat(64) }));
  assert.equal(acknowledgement(endFixture.backend).code, 'detail_conflict');
  endFixture.transport.receive(ingress(framed.end));
  assert.equal(endFixture.recorder.details.length, 1, 'conflicting end must preserve the accepted assembly');
});

test('invalid chunk and mismatched abort preserve the accepted assembly for exact continuation', () => {
  const framed = framedDetail(ANALYTICS_TRANSPORT_DETAIL_CHUNK_BYTES + 1);
  const { backend, recorder, transport } = fixture();
  transport.receive(ingress(framed.start));
  transport.receive(ingress({ ...framed.chunks[0]!, data: 'AA==' }));
  assert.equal(acknowledgement(backend).code, 'detail_length');
  transport.receive(ingress({
    ...createAnalyticsDetailAbortPacket(framed.start, 'transport_incomplete', 'changed abort'),
    payloadId: 'other-payload',
  }));
  assert.equal(acknowledgement(backend).code, 'detail_conflict');
  for (const chunk of framed.chunks) transport.receive(ingress(chunk));
  transport.receive(ingress(framed.end));
  assert.equal(recorder.details.length, 1);
});

test('detail abort rejects even without an admitted start and clears a partial assembly', () => {
  for (const admitStart of [false, true]) {
    const framed = framedDetail(ANALYTICS_TRANSPORT_DETAIL_CHUNK_BYTES + 1);
    const { backend, transport } = fixture();
    if (admitStart) {
      transport.receive(ingress(framed.start));
      transport.receive(ingress(framed.chunks[0]!));
      assert.ok(transport.assemblyBacklog.bytes > 0);
    }
    transport.receive(ingress(createAnalyticsDetailAbortPacket(
      framed.start,
      'transport_incomplete',
      'writer admission rejected',
    )));
    assert.equal(acknowledgement(backend).code, 'transport_incomplete');
    assert.deepEqual(transport.assemblyBacklog, { records: 0, bytes: 0 });
  }
});

test('subject deletion fence clears only matching partial assemblies before recorder deletion', () => {
  const first = framedDetail(ANALYTICS_TRANSPORT_DETAIL_CHUNK_BYTES + 1);
  const secondCapture = detail(1, {
    payloadId: 'payload-other',
    sourceKey: 'detail-source-other',
    captureSubject: subject('root-2'),
  });
  const secondPackets = createAnalyticsDetailPackets(secondCapture);
  const secondStart = secondPackets[0];
  assert.ok(secondStart?.kind === 'detail.start');
  const { backend, transport } = fixture();
  transport.receive(ingress(first.start));
  transport.receive(ingress(secondStart));
  transport.fenceCaptureSubject(subject('root-1'));
  assert.equal(acknowledgement(backend).code, 'subject_deleted');
  assert.deepEqual(transport.assemblyBacklog, { records: 1, bytes: secondStart.byteLength });
});

test('fact ACK projection is one exact producer entry per record for a full batch', () => {
  const { backend, recorder, transport } = fixture();
  const count = 256;
  for (let index = 0; index < count; index += 1) {
    transport.receive(ingress(createAnalyticsFactPacket(observation({
      stableOriginId: `origin-${index}`,
      sourceSequence: 1,
      sourceKey: `source-${index}`,
      entityKey: `tool-${index}`,
    }))));
  }
  const producerReconciliation = Array.from({ length: count }, (_entry, index) => ({
    producerIdentity: analyticsProducerIdentity('generation-1', 'host', `origin-${index}`),
    contiguousWatermark: 1,
    highestObservedSequence: 1,
    visibleGaps: [],
    pendingReceiptCount: 0,
  }));
  for (const disposition of recorder.factDispositions) {
    disposition({ status: 'durable', producerReconciliation, completeDetailWatermark: 0 });
  }
  assert.equal(backend.requests.length, count);
  const entries = backend.requests.flatMap((request) => {
    const ack = (request.params as { acknowledgement: AnalyticsTransportAcknowledgement }).acknowledgement;
    return ack.producerReconciliation ?? [];
  });
  assert.equal(entries.length, count, 'ACK payload work remains linear in batch size');
  assert.equal(new Set(entries.map((entry) => entry.producerIdentity)).size, count);
});

test('a stale detail route cannot replace the active assembly route', () => {
  const framed = framedDetail(1);
  const { backend, recorder, transport } = fixture();
  transport.receive(ingress(framed.start));
  transport.receive(ingress(framed.start, { workerGeneration: 2 }));
  assert.equal(acknowledgement(backend).code, 'detail_route');
  transport.receive(ingress(framed.chunks[0]!));
  transport.receive(ingress(framed.end));
  assert.equal(recorder.details.length, 1);
});

test('rejected ACK messages are truncated at a UTF-8 boundary', () => {
  const { backend, recorder, transport } = fixture();
  transport.receive(ingress(createAnalyticsFactPacket(observation())));
  recorder.factDispositions[0]!({
    status: 'rejected',
    code: 'capture_submission',
    message: '🙂'.repeat(600),
  });
  const message = acknowledgement(backend).message!;
  assert.ok(Buffer.byteLength(message, 'utf8') <= 2_048);
  assert.equal(Buffer.from(message, 'utf8').toString('utf8'), message);
  assert.equal(message.endsWith('�'), false);
});

test('stale detail route cannot clear the active assembly', () => {
  const framed = framedDetail(1);
  const { backend, recorder, transport } = fixture();
  transport.receive(ingress(framed.start));
  transport.receive(ingress(framed.end, { leaseRevision: 2 }));
  assert.equal(acknowledgement(backend).code, 'detail_route');
  transport.receive(ingress(framed.chunks[0]!));
  transport.receive(ingress(framed.end));
  assert.equal(recorder.details.length, 1, 'stale route must preserve the current-route assembly');
});

test('exact durable detail redelivery receives another recorder-owned disposition', () => {
  const framed = framedDetail(1);
  const { backend, recorder, transport } = fixture();
  for (const packet of [framed.start, ...framed.chunks, framed.end]) transport.receive(ingress(packet));
  recorder.detailDispositions[0]!(durable());
  assert.equal(acknowledgement(backend).status, 'durable');
  for (const packet of [framed.start, ...framed.chunks, framed.end]) transport.receive(ingress(packet));
  assert.equal(recorder.details.length, 2);
  recorder.detailDispositions[1]!(durable());
  assert.equal(acknowledgement(backend).status, 'durable');
});

test('checksum failures reject before detail recorder ownership', () => {
  const framed = framedDetail(1);
  const { backend, recorder, transport } = fixture();
  transport.receive(ingress(framed.start));
  transport.receive(ingress({ ...framed.chunks[0]!, data: 'AQ==' }));
  transport.receive(ingress(framed.end));
  assert.equal(recorder.details.length, 0);
  assert.equal(acknowledgement(backend).code, 'detail_hash');
});

test('pending detail count and bytes are bounded before assembly allocation', () => {
  const largeStart = framedDetail(0).start;
  const boundedStart: AnalyticsTransportDetailStartPacket = {
    ...largeStart,
    byteLength: ANALYTICS_TRANSPORT_MAX_DETAIL_BYTES,
    chunkCount: ANALYTICS_TRANSPORT_MAX_DETAIL_CHUNKS,
  };
  const smallStart = framedDetail(1).start;

  const countFixture = fixture({
    maxPendingDetails: 1,
    maxPendingDetailBytes: ANALYTICS_TRANSPORT_MAX_DETAIL_BYTES,
  });
  countFixture.transport.receive(ingress(boundedStart));
  countFixture.transport.receive(ingress(smallStart));
  assert.equal(acknowledgement(countFixture.backend).code, 'detail_capacity');

  const byteFixture = fixture({ maxPendingDetails: 2, maxPendingDetailBytes: ANALYTICS_TRANSPORT_MAX_DETAIL_BYTES });
  byteFixture.transport.receive(ingress(boundedStart));
  byteFixture.transport.receive(ingress(smallStart));
  assert.equal(acknowledgement(byteFixture.backend).code, 'detail_capacity');
});

test('backend exit clears pending assembly and dispose prevents later ingress', () => {
  const framed = framedDetail(1);
  const exitFixture = fixture();
  exitFixture.transport.receive(ingress(framed.start));
  exitFixture.backend.exit();
  exitFixture.transport.receive(ingress(framed.chunks[0]!));
  assert.equal(exitFixture.backend.requests.length, 0, 'backend exit suppresses late ACKs');
  assert.match(exitFixture.errors[0]?.message ?? '', /matching bounded start/);

  const disposedFixture = fixture();
  disposedFixture.transport.receive(ingress(framed.start));
  disposedFixture.transport.dispose();
  disposedFixture.transport.receive(ingress(framed.chunks[0]!));
  assert.equal(disposedFixture.backend.requests.length, 0);
});

test('late recorder dispositions after backend replacement, exit, or dispose do not send ACKs', () => {
  for (const terminate of ['generation', 'exit', 'dispose'] as const) {
    const { backend, recorder, transport } = fixture();
    transport.receive(ingress(createAnalyticsFactPacket(observation())));
    if (terminate === 'generation') backend.generation += 1;
    else if (terminate === 'exit') backend.exit();
    else transport.dispose();
    recorder.factDispositions[0]!(durable());
    assert.equal(backend.requests.length, 0);
  }
});

test('backend ready re-arms the retained transport for a replacement coordinator generation', () => {
  const { backend, recorder, transport } = fixture();
  transport.receive(ingress(createAnalyticsFactPacket(observation())));
  backend.exit();
  recorder.factDispositions[0]!(durable());
  assert.equal(backend.requests.length, 0, 'the dead generation cannot receive a late ACK');

  backend.generation = 2;
  backend.ready();
  const replacement = createAnalyticsFactPacket(observation({ sourceKey: 'replacement-source' }));
  transport.receive(ingress(replacement, { coordinatorGeneration: 2 }));
  assert.equal(recorder.facts.length, 2);
  recorder.factDispositions[1]!(durable());
  assert.equal(acknowledgement(backend).deliveryId, replacement.deliveryId);
});

test('rejection messages are truncated on a UTF-8 boundary', () => {
  const { backend, recorder, transport } = fixture();
  transport.receive(ingress(createAnalyticsFactPacket(observation())));
  recorder.factDispositions[0]!({ status: 'rejected', code: 'capture_failed', message: '💥'.repeat(2_000) });
  const message = acknowledgement(backend).message ?? '';
  assert.ok(Buffer.byteLength(message, 'utf8') <= 2_048);
  assert.equal(message.includes('�'), false);
  assert.ok(message.length > 0);
});
