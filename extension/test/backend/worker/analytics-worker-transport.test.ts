import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  ANALYTICS_SCHEMA_VERSION,
  deriveAnalyticsIdempotencyKey,
  type AnalyticsCaptureSubject,
  type AnalyticsDetailCapture,
  type AnalyticsObservation,
} from '../../../../shared/analytics/contracts.js';
import {
  ANALYTICS_RUNTIME_BRIDGE_KEY,
  ANALYTICS_TRANSPORT_VERSION,
  analyticsProducerIdentity,
  type AnalyticsTransportPacket,
  type InstalledAnalyticsRuntimeBridge,
} from '../../../../shared/analytics/transport.js';
import { AnalyticsWorkerTransport, type AnalyticsTransportFrameSettlement } from '../../../src/backend/analytics-worker-transport.js';
import {
  BoundedWorkerIpcWriter,
  type WorkerIpcWriteTarget,
} from '../../../src/backend/worker-frame-io.js';
import { WORKER_IPC_VERSION } from '../../../src/backend/worker-protocol.js';

function observation(
  rootSessionId: string,
  sourceKey = 'fact-1',
  stableOriginId = 'origin-1',
  sourceSequence = 1,
  overrides: Partial<AnalyticsObservation<object>> = {},
): AnalyticsObservation<object> {
  const base: Omit<AnalyticsObservation<object>, 'idempotencyKey'> = {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: 'generation-1',
    producerKind: 'subagent',
    stableOriginId,
    sourceSequence,
    sourceKey,
    entityKind: 'execution',
    entityKey: `execution-${sourceKey}`,
    observationKind: 'end',
    observedAtMs: 100,
    scope: { workspaceCoverage: 'known', workspaceId: 'workspace-1', rootSessionId },
    captureSubject: { kind: 'session', rootSessionId },
    producer: { buildId: 'build-1', processGeneration: 'process-1' },
    fields: { outcome: 'succeeded' },
  };
  const value = { ...base, ...overrides };
  return { ...value, idempotencyKey: deriveAnalyticsIdempotencyKey(value) };
}

function detail(rootSessionId: string, byteLength = 3): AnalyticsDetailCapture {
  return {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: 'generation-1',
    producerKind: 'subagent',
    stableOriginId: 'detail-origin-1',
    producer: { buildId: 'build-1', processGeneration: 'process-1' },
    payloadId: 'payload-1',
    sourceKey: 'detail-1',
    observedAtMs: 101,
    captureSubject: { kind: 'session', rootSessionId },
    mediaType: 'application/x-pie-subagent-result',
    encoding: 'node-v8',
    complete: true,
    bytes: new Uint8Array(byteLength),
    metadata: { attemptId: 'attempt-1', captureStage: 'terminal' },
  };
}

test('worker transport installs one process bridge and advances only exact pending durable acknowledgements', async () => {
  const sent: AnalyticsTransportPacket[] = [];
  let resolveRebind!: (subject: { kind: 'session'; rootSessionId: string }) => void;
  const rebind = new Promise<{ kind: 'session'; rootSessionId: string }>((resolve) => {
    resolveRebind = resolve;
  });
  const transport = new AnalyticsWorkerTransport(
    {
      sendAnalyticsFrame: (packet, onSettled) => {
        sent.push(packet);
        onSettled?.({ status: 'sent' });
        return true;
      },
      requestAnalyticsSubjectRebind: async () => rebind,
    },
    {
      generationId: 'generation-1',
      captureSubject: { kind: 'session', rootSessionId: 'root-1' },
      workspaceId: 'workspace-1',
      buildId: 'build-1',
    },
    'worker-1:1',
  );
  transport.install();
  try {
    const bridge = (globalThis as unknown as Record<PropertyKey, unknown>)[ANALYTICS_RUNTIME_BRIDGE_KEY] as InstalledAnalyticsRuntimeBridge;
    bridge.submitObservation(observation('root-1'));
    const fact = sent[0]!;
    assert.equal(fact.kind, 'fact');
    transport.acknowledge({
      version: ANALYTICS_TRANSPORT_VERSION,
      deliveryId: 'unknown-delivery',
      generationId: 'generation-1',
      status: 'durable',
      producerReconciliation: [{
        producerIdentity: JSON.stringify(['generation-1', 'subagent', 'origin-1']),
        contiguousWatermark: 99,
        highestObservedSequence: 99,
        visibleGaps: [],
        pendingReceiptCount: 0,
      }],
    });
    assert.equal(bridge.readFactAcknowledgement('generation-1', 'origin-1'), undefined);
    transport.acknowledge({
      version: ANALYTICS_TRANSPORT_VERSION,
      deliveryId: fact.deliveryId,
      generationId: 'generation-1',
      status: 'durable',
      producerReconciliation: [{
        producerIdentity: JSON.stringify(['generation-1', 'subagent', 'origin-1']),
        contiguousWatermark: 1,
        highestObservedSequence: 1,
        visibleGaps: [],
        pendingReceiptCount: 0,
      }],
    });
    assert.equal(bridge.readFactAcknowledgement('generation-1', 'origin-1'), 1);

    bridge.submitDetail(detail('root-1'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const detailStart = sent.find((packet) => packet.kind === 'detail.start');
    assert.ok(detailStart?.kind === 'detail.start');
    transport.acknowledge({
      version: ANALYTICS_TRANSPORT_VERSION,
      deliveryId: detailStart.deliveryId,
      generationId: 'generation-1',
      status: 'durable',
      completeDetailPayloadId: 'wrong-payload',
    });
    assert.equal(bridge.isDetailComplete('payload-1'), false);
    transport.acknowledge({
      version: ANALYTICS_TRANSPORT_VERSION,
      deliveryId: detailStart.deliveryId,
      generationId: 'generation-1',
      status: 'durable',
      completeDetailPayloadId: 'payload-1',
    });
    assert.equal(bridge.isDetailComplete('payload-1'), true);

    transport.rebindCaptureSubject({ kind: 'session', rootSessionId: 'root-2' });
    assert.throws(() => bridge.submitObservation(observation('root-2')), /transition is pending/);
    resolveRebind({ kind: 'session', rootSessionId: 'root-2' });
    await rebind;
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    bridge.submitObservation(observation('root-2'));
  } finally {
    transport.dispose();
  }
  assert.equal((globalThis as unknown as Record<PropertyKey, unknown>)[ANALYTICS_RUNTIME_BRIDGE_KEY], undefined);
});

test('worker transport rejects current-generation observations with stale build or workspace provenance', () => {
  for (const overrides of [
    { producer: { buildId: 'stale-build', processGeneration: 'process-1' } },
    { scope: { workspaceCoverage: 'known' as const, workspaceId: 'stale-workspace', rootSessionId: 'root-1' } },
  ]) {
    const transport = new AnalyticsWorkerTransport({
      sendAnalyticsFrame: () => true,
      requestAnalyticsSubjectRebind: async (captureSubject) => captureSubject,
    }, {
      generationId: 'generation-1',
      captureSubject: { kind: 'session', rootSessionId: 'root-1' },
      workspaceId: 'workspace-1',
      buildId: 'build-1',
    }, 'worker-1:1');
    transport.install();
    try {
      const bridge = (globalThis as unknown as Record<PropertyKey, unknown>)[ANALYTICS_RUNTIME_BRIDGE_KEY] as InstalledAnalyticsRuntimeBridge;
      assert.throws(
        () => bridge.submitObservation(observation('root-1', 'stale-source', 'stale-origin', 1, overrides)),
        /producer (build|workspace)/,
      );
    } finally {
      transport.dispose();
    }
  }
});

test('worker transport keeps a dropped subject rebind pending without blocking the caller', () => {
  const transport = new AnalyticsWorkerTransport({
    sendAnalyticsFrame: () => true,
    requestAnalyticsSubjectRebind: () => new Promise<AnalyticsCaptureSubject>(() => {}),
  }, {
    generationId: 'generation-1', captureSubject: { kind: 'session', rootSessionId: 'root-1' }, buildId: 'build-1',
  }, 'worker-1:1');
  transport.install();
  try {
    const bridge = (globalThis as unknown as Record<PropertyKey, unknown>)[ANALYTICS_RUNTIME_BRIDGE_KEY] as InstalledAnalyticsRuntimeBridge;
    assert.equal(transport.rebindCaptureSubject({ kind: 'session', rootSessionId: 'root-2' }), undefined);
    assert.throws(() => bridge.submitObservation(observation('root-2')), /transition is pending/);
  } finally {
    transport.dispose();
  }
});

test('worker transport disables capture on rejected or mismatched subject rebind ACKs', async () => {
  for (const outcome of ['rejected', 'mismatched'] as const) {
    const transport = new AnalyticsWorkerTransport({
      sendAnalyticsFrame: () => true,
      requestAnalyticsSubjectRebind: async () => {
        if (outcome === 'rejected') throw new Error('coordinator rejected rebind');
        return { kind: 'session', rootSessionId: 'wrong-root' };
      },
    }, {
      generationId: 'generation-1', captureSubject: { kind: 'session', rootSessionId: 'root-1' }, buildId: 'build-1',
    }, 'worker-1:1');
    transport.install();
    try {
      const bridge = (globalThis as unknown as Record<PropertyKey, unknown>)[ANALYTICS_RUNTIME_BRIDGE_KEY] as InstalledAnalyticsRuntimeBridge;
      transport.rebindCaptureSubject({ kind: 'session', rootSessionId: 'root-2' });
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      assert.throws(() => bridge.submitObservation(observation('root-2')), /transition is disabled/);
    } finally {
      transport.dispose();
    }
  }
});

test('worker transport lets only the newest subject rebind ACK activate capture', async () => {
  let resolveFirst!: (subject: AnalyticsCaptureSubject) => void;
  let resolveSecond!: (subject: AnalyticsCaptureSubject) => void;
  let requestCount = 0;
  const first = new Promise<AnalyticsCaptureSubject>((resolve) => { resolveFirst = resolve; });
  const second = new Promise<AnalyticsCaptureSubject>((resolve) => { resolveSecond = resolve; });
  const transport = new AnalyticsWorkerTransport({
    sendAnalyticsFrame: () => true,
    requestAnalyticsSubjectRebind: () => ++requestCount === 1 ? first : second,
  }, {
    generationId: 'generation-1', captureSubject: { kind: 'session', rootSessionId: 'root-1' }, buildId: 'build-1',
  }, 'worker-1:1');
  transport.install();
  try {
    const bridge = (globalThis as unknown as Record<PropertyKey, unknown>)[ANALYTICS_RUNTIME_BRIDGE_KEY] as InstalledAnalyticsRuntimeBridge;
    transport.rebindCaptureSubject({ kind: 'session', rootSessionId: 'root-2' });
    transport.rebindCaptureSubject({ kind: 'session', rootSessionId: 'root-3' });
    resolveFirst({ kind: 'session', rootSessionId: 'root-2' });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.throws(() => bridge.submitObservation(observation('root-3')), /transition is pending/);
    resolveSecond({ kind: 'session', rootSessionId: 'root-3' });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    bridge.submitObservation(observation('root-3'));
  } finally {
    transport.dispose();
  }
});

test('worker transport surfaces synchronous writer admission rejection without installing an acknowledgement', () => {
  const transport = new AnalyticsWorkerTransport(
    {
      sendAnalyticsFrame: () => false,
      requestAnalyticsSubjectRebind: async (captureSubject) => captureSubject,
    },
    { generationId: 'generation-1', captureSubject: { kind: 'session', rootSessionId: 'root-1' }, buildId: 'build-1' },
    'worker-1:1',
  );
  transport.install();
  try {
    const bridge = (globalThis as unknown as Record<PropertyKey, unknown>)[ANALYTICS_RUNTIME_BRIDGE_KEY] as InstalledAnalyticsRuntimeBridge;
    assert.throws(() => bridge.submitObservation(observation('root-1')), /rejected fact/);
    assert.equal(bridge.readFactAcknowledgement('generation-1', 'origin-1'), undefined);
  } finally {
    transport.dispose();
  }
});

test('detail transport serializes a legal large payload and aborts explicit initial or midstream rejection', async () => {
  for (const rejectAt of [0, 2] as const) {
    const sent: AnalyticsTransportPacket[] = [];
    const transport = new AnalyticsWorkerTransport({
      sendAnalyticsFrame: (packet, onSettled) => {
        sent.push(packet);
        const index = sent.length - 1;
        if (packet.kind !== 'detail.abort' && index === rejectAt) return false;
        queueMicrotask(() => onSettled?.({ status: 'sent' }));
        return true;
      },
      requestAnalyticsSubjectRebind: async (captureSubject) => captureSubject,
    }, {
      generationId: 'generation-1', captureSubject: { kind: 'session', rootSessionId: 'root-1' }, buildId: 'build-1',
    }, 'worker-1:1');
    transport.install();
    try {
      const bridge = (globalThis as unknown as Record<PropertyKey, unknown>)[ANALYTICS_RUNTIME_BRIDGE_KEY] as InstalledAnalyticsRuntimeBridge;
      bridge.submitDetail(detail('root-1', 2 * 1024 * 1024));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(sent.at(-1)?.kind, 'detail.abort');
      const start = sent.find((packet) => packet.kind === 'detail.start');
      assert.ok(start);
      transport.acknowledge({
        version: 1, deliveryId: start.deliveryId, generationId: 'generation-1', status: 'rejected',
        code: 'transport_incomplete', message: 'incomplete',
      });
      assert.equal(bridge.isDetailComplete('payload-1'), false);
    } finally {
      transport.dispose();
    }
  }

  const sent: AnalyticsTransportPacket[] = [];
  let inFlight = 0;
  let maximumInFlight = 0;
  const transport = new AnalyticsWorkerTransport({
    sendAnalyticsFrame: (packet, onSettled) => {
      sent.push(packet);
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      queueMicrotask(() => {
        inFlight -= 1;
        onSettled?.({ status: 'sent' });
      });
      return true;
    },
    requestAnalyticsSubjectRebind: async (captureSubject) => captureSubject,
  }, {
    generationId: 'generation-1', captureSubject: { kind: 'session', rootSessionId: 'root-1' }, buildId: 'build-1',
  }, 'worker-1:1');
  transport.install();
  try {
    const bridge = (globalThis as unknown as Record<PropertyKey, unknown>)[ANALYTICS_RUNTIME_BRIDGE_KEY] as InstalledAnalyticsRuntimeBridge;
    bridge.submitDetail(detail('root-1', 2 * 1024 * 1024));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sent[0]?.kind, 'detail.start');
    assert.equal(sent.at(-1)?.kind, 'detail.end');
    assert.ok(sent.filter((packet) => packet.kind === 'detail.chunk').length > 1);
    assert.equal(maximumInFlight, 1);
  } finally {
    transport.dispose();
  }
});

test('queued detail bytes and metadata survive producer mutation while frames await backpressure', async () => {
  const sent: AnalyticsTransportPacket[] = [];
  const callbacks: Array<(settlement: AnalyticsTransportFrameSettlement) => void> = [];
  const transport = new AnalyticsWorkerTransport({
    sendAnalyticsFrame: (packet, onSettled) => {
      sent.push(packet);
      if (onSettled) callbacks.push(onSettled);
      return true;
    },
    requestAnalyticsSubjectRebind: async (subject) => subject,
  }, {
    generationId: 'generation-1', captureSubject: { kind: 'session', rootSessionId: 'root-1' }, buildId: 'build-1',
  }, 'worker-1:1');
  transport.install();
  try {
    const bridge = (globalThis as unknown as Record<PropertyKey, unknown>)[ANALYTICS_RUNTIME_BRIDGE_KEY] as InstalledAnalyticsRuntimeBridge;
    const bytes = Buffer.alloc(2 * 1024 * 1024, 71);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const captureSubject = { kind: 'session' as const, rootSessionId: 'root-1' };
    const metadata = { attemptId: 'attempt-original', captureStage: 'terminal' };
    bridge.submitDetail({ ...detail('root-1'), bytes, captureSubject, metadata });
    assert.equal(sent.length, 1, 'only the start frame is sent before its callback');
    bytes.fill(0);
    captureSubject.rootSessionId = 'mutated-after-submit';
    metadata.attemptId = 'mutated-after-submit';
    while (callbacks.length > 0) {
      assert.equal(callbacks.length, 1, 'at most one frame awaits settlement');
      callbacks.shift()!({ status: 'sent' });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const start = sent[0];
    assert.ok(start?.kind === 'detail.start');
    assert.equal(start.detail.metadata.attemptId, 'attempt-original');
    const received = createHash('sha256');
    let byteLength = 0;
    for (const packet of sent) {
      assert.deepEqual(packet.captureSubject, { kind: 'session', rootSessionId: 'root-1' });
      if (packet.kind === 'detail.chunk') {
        const chunk = Buffer.from(packet.data, 'base64');
        received.update(chunk);
        byteLength += chunk.byteLength;
      }
    }
    assert.equal(byteLength, bytes.byteLength);
    assert.equal(received.digest('hex'), digest);
    assert.equal(start.sha256, digest);
    assert.equal(sent.at(-1)?.kind, 'detail.end');
  } finally { transport.dispose(); }
});

test('host rejection and disposal stop unsent detail frames and release queue admission', async () => {
  const sent: AnalyticsTransportPacket[] = [];
  const callbacks: Array<(settlement: AnalyticsTransportFrameSettlement) => void> = [];
  const transport = new AnalyticsWorkerTransport({
    sendAnalyticsFrame: (packet, onSettled) => {
      sent.push(packet);
      if (onSettled) callbacks.push(onSettled);
      return true;
    },
    requestAnalyticsSubjectRebind: async (subject) => subject,
  }, {
    generationId: 'generation-1', captureSubject: { kind: 'session', rootSessionId: 'root-1' }, buildId: 'build-1',
  }, 'worker-1:1');
  transport.install();
  try {
    const bridge = (globalThis as unknown as Record<PropertyKey, unknown>)[ANALYTICS_RUNTIME_BRIDGE_KEY] as InstalledAnalyticsRuntimeBridge;
    const large = detail('root-1', 16 * 1024 * 1024);
    bridge.submitDetail(large);
    assert.throws(() => bridge.submitDetail({ ...large, sourceKey: 'other', payloadId: 'other' }), /capacity exceeded/);
    const start = sent[0]!;
    transport.acknowledge({ version: 1, deliveryId: start.deliveryId, generationId: 'generation-1', status: 'rejected', code: 'subject_deleted', message: 'closed' });
    callbacks.shift()!({ status: 'sent' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 1, 'late frame callback must not resume a rejected detail');
    bridge.submitDetail({ ...large, sourceKey: 'other', payloadId: 'other' });
    assert.equal(sent.length, 2, 'rejected delivery released its capacity');
    const disposal = transport.dispose();
    callbacks.shift()!({ status: 'sent' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 3, 'disposed transport emits one ordered abort for the admitted frame');
    assert.equal(sent[2]!.kind, 'detail.abort');
    callbacks.shift()!({ status: 'sent' });
    await disposal;
  } finally { transport.dispose(); }
});

test('an early rejected ACK cannot start another detail before the admitted frame settles', async () => {
  const sent: AnalyticsTransportPacket[] = [];
  const callbacks: Array<(settlement: AnalyticsTransportFrameSettlement) => void> = [];
  const transport = new AnalyticsWorkerTransport({
    sendAnalyticsFrame: (packet, onSettled) => {
      sent.push(packet);
      if (onSettled) callbacks.push(onSettled);
      return true;
    },
    requestAnalyticsSubjectRebind: async (subject) => subject,
  }, {
    generationId: 'generation-1', captureSubject: { kind: 'session', rootSessionId: 'root-1' }, buildId: 'build-1',
  }, 'worker-1:1');
  transport.install();
  try {
    const bridge = (globalThis as unknown as Record<PropertyKey, unknown>)[ANALYTICS_RUNTIME_BRIDGE_KEY] as InstalledAnalyticsRuntimeBridge;
    bridge.submitDetail(detail('root-1'));
    bridge.submitDetail({ ...detail('root-1'), sourceKey: 'second', payloadId: 'second' });
    transport.acknowledge({ version: 1, deliveryId: sent[0]!.deliveryId, generationId: 'generation-1', status: 'rejected', code: 'subject_deleted', message: 'closed' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 1);
    assert.equal(callbacks.length, 1);
    callbacks.shift()!({ status: 'sent' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 2);
    assert.equal(sent[1]!.kind, 'detail.start');
    assert.equal(callbacks.length, 1);
  } finally { transport.dispose(); }
});

test('a queued fact envelope retains the same detached subject as its observation', () => {
  const sent: AnalyticsTransportPacket[] = [];
  const transport = new AnalyticsWorkerTransport({
    sendAnalyticsFrame: (packet) => { sent.push(packet); return true; },
    requestAnalyticsSubjectRebind: async (subject) => subject,
  }, {
    generationId: 'generation-1', captureSubject: { kind: 'session', rootSessionId: 'root-1' }, buildId: 'build-1',
  }, 'worker-1:1');
  transport.install();
  try {
    const bridge = (globalThis as unknown as Record<PropertyKey, unknown>)[ANALYTICS_RUNTIME_BRIDGE_KEY] as InstalledAnalyticsRuntimeBridge;
    const captureSubject = { kind: 'session' as const, rootSessionId: 'root-1' };
    bridge.submitObservation(observation('root-1', 'fact-1', 'origin-1', 1, { captureSubject }));
    captureSubject.rootSessionId = 'mutated-after-submit';
    const packet = sent[0];
    assert.ok(packet?.kind === 'fact');
    assert.deepEqual(packet.captureSubject, { kind: 'session', rootSessionId: 'root-1' });
    assert.deepEqual(packet.captureSubject, packet.observation.captureSubject);
  } finally { transport.dispose(); }
});

test('synchronous fact acknowledgement sees pending ownership registered before send', () => {
  const transport = new AnalyticsWorkerTransport({
    sendAnalyticsFrame: (packet) => {
      transport.acknowledge({
        version: 1, deliveryId: packet.deliveryId, generationId: packet.generationId, status: 'durable',
        producerReconciliation: [{
          producerIdentity: analyticsProducerIdentity('generation-1', 'subagent', 'origin-1'),
          contiguousWatermark: 1, highestObservedSequence: 1, visibleGaps: [], pendingReceiptCount: 0,
        }],
      });
      return true;
    },
    requestAnalyticsSubjectRebind: async (subject) => subject,
  }, {
    generationId: 'generation-1', captureSubject: { kind: 'session', rootSessionId: 'root-1' }, buildId: 'build-1',
  }, 'worker-1:1');
  transport.install();
  try {
    const bridge = (globalThis as unknown as Record<PropertyKey, unknown>)[ANALYTICS_RUNTIME_BRIDGE_KEY] as InstalledAnalyticsRuntimeBridge;
    bridge.submitObservation(observation('root-1'));
    assert.equal(bridge.readFactAcknowledgement('generation-1', 'origin-1'), 1);
    assert.equal(bridge.readFactAcknowledgement('generation-1', 'origin-1'), undefined);
  } finally { transport.dispose(); }
});

test('fact disposal reports writer settlement separately from recorder durability', async () => {
  const sent: AnalyticsTransportPacket[] = [];
  let settleFact!: (settlement: AnalyticsTransportFrameSettlement) => void;
  const transport = new AnalyticsWorkerTransport({
    sendAnalyticsFrame: (packet, onSettled) => {
      sent.push(packet);
      if (packet.kind === 'fact' && onSettled) settleFact = onSettled;
      return true;
    },
    requestAnalyticsSubjectRebind: async (subject) => subject,
  }, {
    generationId: 'generation-1', captureSubject: { kind: 'session', rootSessionId: 'root-1' }, buildId: 'build-1',
  }, 'worker-1:1');
  transport.install();
  try {
    const bridge = (globalThis as unknown as Record<PropertyKey, unknown>)[ANALYTICS_RUNTIME_BRIDGE_KEY] as InstalledAnalyticsRuntimeBridge;
    bridge.submitObservation(observation('root-1'));
    const disposal = transport.dispose();
    settleFact({ status: 'sent' });
    const report = await disposal;
    assert.equal(sent[0]?.kind, 'fact');
    assert.deepEqual(report, {
      status: 'drained',
      facts: {
        admitted: 1,
        writerSent: 1,
        rejected: 0,
        failed: 0,
        unsettledTimeout: 0,
        durableAcksObserved: 0,
      },
    }, 'writer settlement must not be reported as recorder durability');
  } finally {
    await transport.dispose();
  }
});

test('fact disposal keeps duplicate delivery IDs as independent writer admissions', async () => {
  const sent: AnalyticsTransportPacket[] = [];
  const callbacks: Array<(settlement: AnalyticsTransportFrameSettlement) => void> = [];
  const transport = new AnalyticsWorkerTransport({
    sendAnalyticsFrame: (packet, onSettled) => {
      sent.push(packet);
      if (packet.kind === 'fact' && onSettled) callbacks.push(onSettled);
      return true;
    },
    requestAnalyticsSubjectRebind: async (subject) => subject,
  }, {
    generationId: 'generation-1', captureSubject: { kind: 'session', rootSessionId: 'root-1' }, buildId: 'build-1',
  }, 'worker-1:1');
  transport.install();
  try {
    const bridge = (globalThis as unknown as Record<PropertyKey, unknown>)[ANALYTICS_RUNTIME_BRIDGE_KEY] as InstalledAnalyticsRuntimeBridge;
    bridge.submitObservation(observation('root-1'));
    bridge.submitObservation(observation('root-1'));
    assert.equal(callbacks.length, 2, 'replayed facts must retain two writer callback tokens');
    callbacks[0]!({ status: 'sent' });
    callbacks[1]!({ status: 'sent' });
    for (const packet of sent) {
      assert.equal(packet.kind, 'fact');
      transport.acknowledge({
        version: ANALYTICS_TRANSPORT_VERSION,
        deliveryId: packet.deliveryId,
        generationId: packet.generationId,
        status: 'durable',
        producerReconciliation: [{
          producerIdentity: analyticsProducerIdentity('generation-1', 'subagent', 'origin-1'),
          contiguousWatermark: 1,
          highestObservedSequence: 1,
          visibleGaps: [],
          pendingReceiptCount: 0,
        }],
      });
    }
    assert.equal(sent.length, 2);
    const disposal = transport.dispose();
    const report = await disposal;
    assert.equal(report.status, 'drained');
    assert.equal(report.facts.admitted, 2);
    assert.equal(report.facts.writerSent, 2);
    assert.equal(report.facts.durableAcksObserved, 2, 'each duplicate delivery receives its own durable ACK');
    assert.equal(report.facts.unsettledTimeout, 0);
  } finally {
    await transport.dispose();
  }
});

test('fact disposal reports an explicit timeout and ignores a late writer callback', async () => {
  const callbacks: Array<(settlement: AnalyticsTransportFrameSettlement) => void> = [];
  const originalSetTimeout = globalThis.setTimeout;
  let deadlineCallback: (() => void) | undefined;
  globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number) => {
    assert.equal(delay, 1_000, 'fact disposal must use a finite bounded deadline');
    deadlineCallback = callback as () => void;
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const transport = new AnalyticsWorkerTransport({
    sendAnalyticsFrame: (packet, onSettled) => {
      if (packet.kind === 'fact' && onSettled) callbacks.push(onSettled);
      return true;
    },
    requestAnalyticsSubjectRebind: async (subject) => subject,
  }, {
    generationId: 'generation-1', captureSubject: { kind: 'session', rootSessionId: 'root-1' }, buildId: 'build-1',
  }, 'worker-1:1');
  transport.install();
  try {
    const bridge = (globalThis as unknown as Record<PropertyKey, unknown>)[ANALYTICS_RUNTIME_BRIDGE_KEY] as InstalledAnalyticsRuntimeBridge;
    bridge.submitObservation(observation('root-1'));
    const disposal = transport.dispose();
    assert.ok(deadlineCallback, 'fact disposal must install a deadline');
    deadlineCallback!();
    const report = await disposal;
    assert.equal(report.status, 'timed-out');
    assert.equal(report.facts.admitted, 1);
    assert.equal(report.facts.writerSent, 0);
    assert.equal(report.facts.unsettledTimeout, 1);
    callbacks[0]!({ status: 'sent' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(report.facts.writerSent, 0, 'late callbacks cannot mutate the terminal report');
  } finally {
    deadlineCallback?.();
    globalThis.setTimeout = originalSetTimeout;
    await transport.dispose();
  }
});

test('fact disposal records explicit writer admission rejection', async () => {
  const transport = new AnalyticsWorkerTransport({
    sendAnalyticsFrame: () => false,
    requestAnalyticsSubjectRebind: async (subject) => subject,
  }, {
    generationId: 'generation-1', captureSubject: { kind: 'session', rootSessionId: 'root-1' }, buildId: 'build-1',
  }, 'worker-1:1');
  transport.install();
  try {
    const bridge = (globalThis as unknown as Record<PropertyKey, unknown>)[ANALYTICS_RUNTIME_BRIDGE_KEY] as InstalledAnalyticsRuntimeBridge;
    assert.throws(() => bridge.submitObservation(observation('root-1')), /rejected fact/);
    const report = await transport.dispose();
    assert.equal(report.status, 'drained');
    assert.equal(report.facts.admitted, 0);
    assert.equal(report.facts.rejected, 1);
    assert.equal(report.facts.unsettledTimeout, 0);
  } finally {
    await transport.dispose();
  }
});

test('a sender that throws even for abort does not retain failed detail admission', () => {
  const transport = new AnalyticsWorkerTransport({
    sendAnalyticsFrame: () => { throw new Error('transport unavailable'); },
    requestAnalyticsSubjectRebind: async (subject) => subject,
  }, {
    generationId: 'generation-1', captureSubject: { kind: 'session', rootSessionId: 'root-1' }, buildId: 'build-1',
  }, 'worker-1:1');
  transport.install();
  try {
    const bridge = (globalThis as unknown as Record<PropertyKey, unknown>)[ANALYTICS_RUNTIME_BRIDGE_KEY] as InstalledAnalyticsRuntimeBridge;
    for (let retry = 0; retry < 3; retry += 1) {
      bridge.submitDetail(detail('root-1'));
      assert.equal(bridge.isDetailComplete('payload-1'), false);
    }
  } finally { transport.dispose(); }
});

test('acknowledgement state is consumed or released and lost ACK admission is bounded', () => {
  const sent: AnalyticsTransportPacket[] = [];
  const transport = new AnalyticsWorkerTransport({
    sendAnalyticsFrame: (packet) => { sent.push(packet); return true; },
    requestAnalyticsSubjectRebind: async (captureSubject) => captureSubject,
  }, {
    generationId: 'generation-1', captureSubject: { kind: 'session', rootSessionId: 'root-1' }, buildId: 'build-1',
  }, 'worker-1:1');
  transport.install();
  try {
    const bridge = (globalThis as unknown as Record<PropertyKey, unknown>)[ANALYTICS_RUNTIME_BRIDGE_KEY] as InstalledAnalyticsRuntimeBridge;
    for (let index = 0; index < 9_000; index += 1) {
      const stableOriginId = `origin-${index}`;
      bridge.submitObservation(observation('root-1', `fact-${index}`, stableOriginId));
      const packet = sent.at(-1)!;
      transport.acknowledge({
        version: 1, deliveryId: packet.deliveryId, generationId: 'generation-1', status: 'durable',
        producerReconciliation: [{
          producerIdentity: JSON.stringify(['generation-1', 'subagent', stableOriginId]),
          contiguousWatermark: 1, highestObservedSequence: 1, visibleGaps: [], pendingReceiptCount: 0,
        }],
      });
      assert.equal(bridge.readFactAcknowledgement('generation-1', stableOriginId), 1);
    }
    for (let index = 0; index < 8_192; index += 1) {
      bridge.submitObservation(observation('root-1', `lost-${index}`, `lost-origin-${index}`));
    }
    assert.throws(
      () => bridge.submitObservation(observation('root-1', 'lost-overflow', 'lost-overflow-origin')),
      /acknowledgement capacity/,
    );
  } finally {
    transport.dispose();
  }
});

test('terminal release drains every pending fact and detail disposition without retaining caches', async () => {
  const sent: AnalyticsTransportPacket[] = [];
  const transport = new AnalyticsWorkerTransport({
    sendAnalyticsFrame: (packet, onSettled) => {
      sent.push(packet);
      queueMicrotask(() => onSettled?.({ status: 'sent' }));
      return true;
    },
    requestAnalyticsSubjectRebind: async (captureSubject) => captureSubject,
  }, {
    generationId: 'generation-1', captureSubject: { kind: 'session', rootSessionId: 'root-1' }, buildId: 'build-1',
  }, 'worker-1:1');
  transport.install();
  try {
    const bridge = (globalThis as unknown as Record<PropertyKey, unknown>)[ANALYTICS_RUNTIME_BRIDGE_KEY] as InstalledAnalyticsRuntimeBridge;
    const stableOriginId = 'shared-origin';
    for (let sequence = 1; sequence <= 4; sequence += 1) {
      bridge.submitObservation(observation('root-1', `pending-${sequence}`, stableOriginId, sequence));
    }
    bridge.submitDetail(detail('root-1'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const factPackets = sent.filter((packet) => packet.kind === 'fact');
    const detailStart = sent.find((packet) => packet.kind === 'detail.start');
    assert.equal(factPackets.length, 4);
    assert.ok(detailStart?.kind === 'detail.start');

    bridge.releaseAcknowledgementInterest('generation-1', stableOriginId, 'payload-1');
    const producerIdentity = JSON.stringify(['generation-1', 'subagent', stableOriginId]);
    for (const packet of [...factPackets].reverse()) {
      transport.acknowledge({
        version: ANALYTICS_TRANSPORT_VERSION,
        deliveryId: packet.deliveryId,
        generationId: 'generation-1',
        status: 'durable',
        producerReconciliation: [{
          producerIdentity,
          contiguousWatermark: 4,
          highestObservedSequence: 4,
          visibleGaps: [],
          pendingReceiptCount: 0,
        }],
      });
    }
    transport.acknowledge({
      version: ANALYTICS_TRANSPORT_VERSION,
      deliveryId: detailStart.deliveryId,
      generationId: 'generation-1',
      status: 'durable',
      completeDetailPayloadId: 'payload-1',
    });
    assert.equal(bridge.readFactAcknowledgement('generation-1', stableOriginId), undefined);
    assert.equal(bridge.isDetailComplete('payload-1'), false);
  } finally {
    transport.dispose();
  }
});

test('disposal abort follows a queued detail start in the real writer lane order', async () => {
  class DeferredTarget implements WorkerIpcWriteTarget {
    writable = true;
    readonly frames: Array<Record<string, unknown>> = [];
    readonly callbacks: Array<(error?: Error | null) => void> = [];

    write(data: string, callback: (error?: Error | null) => void): boolean {
      this.frames.push(JSON.parse(data) as Record<string, unknown>);
      this.callbacks.push(callback);
      return true;
    }
  }

  const target = new DeferredTarget();
  const writer = new BoundedWorkerIpcWriter(target);
  const frameBase = {
    ipcVersion: WORKER_IPC_VERSION,
    coordinatorGeneration: 1,
    workerId: 'worker-1',
    workerGeneration: 1,
    workerPid: process.pid,
    rootSessionPath: '/worker-root.jsonl',
    leasePath: '/worker-lease.json',
    leaseRevision: 1,
    sessionPath: '/worker-root.jsonl',
  };
  const sender = {
    sendAnalyticsFrame: (packet: AnalyticsTransportPacket, onSettled?: (settlement: AnalyticsTransportFrameSettlement) => void): boolean => {
      const result = writer.enqueue({ ...frameBase, kind: 'analytics.capture', packet } as never, {
        onSettled: (settlement) => {
          if (settlement.status === 'sent') onSettled?.({ status: 'sent' });
          else if (settlement.status === 'rejected') onSettled?.({ status: 'rejected', reason: settlement.reason, detail: settlement.detail });
          else if (settlement.status === 'failed') onSettled?.({ status: 'failed', error: settlement.error });
        },
      });
      return result.accepted;
    },
    requestAnalyticsSubjectRebind: async (captureSubject: AnalyticsCaptureSubject) => captureSubject,
  };
  writer.enqueue({
    ...frameBase,
    kind: 'response',
    requestId: 'blocker',
    ok: true,
    result: { kind: 'pong' },
  } as never);
  const transport = new AnalyticsWorkerTransport(sender, {
    generationId: 'generation-1', captureSubject: { kind: 'session', rootSessionId: 'root-1' }, buildId: 'build-1',
  }, 'worker-1:1');
  transport.install();
  try {
    const bridge = (globalThis as unknown as Record<PropertyKey, unknown>)[ANALYTICS_RUNTIME_BRIDGE_KEY] as InstalledAnalyticsRuntimeBridge;
    bridge.submitDetail(detail('root-1'));
    bridge.submitObservation(observation('root-1', 'mixed-fact', 'mixed-origin'));
    assert.deepEqual(target.frames.map((frame) => frame.kind), ['response'], 'detail start is queued behind the active writer frame');

    const disposed = transport.dispose();
    assert.deepEqual(target.frames.map((frame) => frame.kind), ['response'], 'dispose does not overtake the queued start with an abort');
    target.callbacks.shift()!(null);
    assert.deepEqual(target.frames.map((frame) => frame.kind), ['response', 'analytics.capture']);
    assert.equal((target.frames[1]!.packet as { kind: string }).kind, 'detail.start');
    target.callbacks.shift()!(null);
    assert.deepEqual(target.frames.map((frame) => frame.kind), ['response', 'analytics.capture', 'analytics.capture']);
    assert.equal((target.frames[2]!.packet as { kind: string }).kind, 'detail.abort');
    target.callbacks.shift()!(null);
    assert.deepEqual(target.frames.map((frame) => frame.kind), [
      'response', 'analytics.capture', 'analytics.capture', 'analytics.capture',
    ]);
    assert.equal((target.frames[3]!.packet as { kind: string }).kind, 'fact');
    target.callbacks.shift()!(null);
    const report = await disposed;
    assert.equal(report.status, 'drained');
    assert.equal(report.facts.admitted, 1);
    assert.equal(report.facts.writerSent, 1);
    writer.enqueue({
      ...frameBase,
      kind: 'response',
      requestId: 'shutdown',
      ok: true,
      result: { kind: 'shutting-down' },
    } as never);
    assert.deepEqual(target.frames.map((frame) => frame.kind), [
      'response', 'analytics.capture', 'analytics.capture', 'analytics.capture', 'response',
    ], 'shutdown response is admitted only after the ordered abort settles');
  } finally {
    await transport.dispose();
  }
});

test('disposal deadline resolves an admitted detail whose writer callback never settles', async () => {
  const sent: AnalyticsTransportPacket[] = [];
  const callbacks: Array<(settlement: AnalyticsTransportFrameSettlement) => void> = [];
  const originalSetTimeout = globalThis.setTimeout;
  let deadlineCallback: (() => void) | undefined;
  globalThis.setTimeout = ((callback: (...args: any[]) => void) => {
    deadlineCallback = callback as () => void;
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const transport = new AnalyticsWorkerTransport({
    sendAnalyticsFrame: (packet, onSettled) => {
      sent.push(packet);
      if (onSettled) callbacks.push(onSettled);
      return true;
    },
    requestAnalyticsSubjectRebind: async (captureSubject) => captureSubject,
  }, {
    generationId: 'generation-1',
    captureSubject: { kind: 'session', rootSessionId: 'root-1' },
    buildId: 'build-1',
  }, 'worker-1:1');
  transport.install();
  try {
    const bridge = (globalThis as unknown as Record<PropertyKey, unknown>)[ANALYTICS_RUNTIME_BRIDGE_KEY] as InstalledAnalyticsRuntimeBridge;
    bridge.submitDetail(detail('root-1'));

    const disposed = transport.dispose();
    assert.ok(deadlineCallback, 'disposal must install a finite settlement deadline');
    deadlineCallback!();
    await disposed;
    assert.deepEqual(sent.map((packet) => packet.kind), ['detail.start']);
    assert.equal(callbacks.length, 1);

    callbacks[0]!({ status: 'sent' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(sent.map((packet) => packet.kind), ['detail.start'], 'a late writer callback cannot resume a disposed transport or emit an abort');
  } finally {
    deadlineCallback?.();
    globalThis.setTimeout = originalSetTimeout;
    await transport.dispose();
  }
});
