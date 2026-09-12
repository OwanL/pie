import assert from 'node:assert/strict';
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
  type AnalyticsTransportPacket,
  type InstalledAnalyticsRuntimeBridge,
} from '../../../../shared/analytics/transport.js';
import { AnalyticsWorkerTransport } from '../../../src/backend/analytics-worker-transport.js';

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
