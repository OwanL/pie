import assert from 'node:assert/strict';
import test from 'node:test';

import { ANALYTICS_SCHEMA_VERSION, deriveAnalyticsIdempotencyKey, type AnalyticsObservation } from '../../../../shared/analytics/contracts.js';
import { ANALYTICS_ROUTE_CLOSED_EVENT, createAnalyticsFactPacket } from '../../../../shared/analytics/transport.js';
import type { AnalyticsBranchObservedPayload } from '../../../src/shared/protocol/sessions.js';
import { WORKER_IPC_VERSION, parseWorkerToCoordinatorFrame } from '../../../src/backend/worker-protocol.js';
import { WorkerRuntimeRouter } from '../../../src/backend/worker-runtime-router.js';

function opened(sessionPath: string, sessionId: string) {
  return {
    session: {
      path: sessionPath,
      sessionId,
      name: 'Analytics', cwd: '.', modifiedAt: new Date(0).toISOString(), messageCount: 0,
    },
    transcript: [],
    transcriptWindow: {
      totalCount: 0, loadedStart: 0, loadedEnd: 0,
      hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false,
    },
    busy: false,
    runtimeReady: true,
  };
}

function observation(rootSessionId: string, sourceKey: string): AnalyticsObservation<object> {
  const base: Omit<AnalyticsObservation<object>, 'idempotencyKey'> = {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: 'analytics-generation-1',
    producerKind: 'subagent',
    stableOriginId: 'origin-1',
    sourceSequence: 1,
    sourceKey,
    entityKind: 'execution',
    entityKey: 'execution-1',
    observationKind: 'end',
    observedAtMs: 100,
    scope: { workspaceCoverage: 'known', rootSessionId },
    captureSubject: { kind: 'session', rootSessionId },
    producer: { buildId: 'build-1', processGeneration: 'worker-1:1' },
    fields: { outcome: 'succeeded' },
  };
  return { ...base, idempotencyKey: deriveAnalyticsIdempotencyKey(base) };
}

test('router emits capture only for the exact live route and routes host ACK back to that worker', async () => {
  const sessionPath = `${process.cwd()}/analytics-route.jsonl`;
  const sent: unknown[] = [];
  const emitted: Array<[string, unknown]> = [];
  const client = {
    getSnapshot: () => ({ status: 'ready' as const, pid: 123, stdoutTail: '', stderrTail: '' }),
    requestFrame: async (body: any) => body.kind === 'sync'
      ? { kind: 'sync.ack', domain: body.domain, revision: body.revision }
      : { kind: 'runtime.ready', runtimeMetadata: { mode: 'phase4', startedAt: 1 } },
    sendFrame: (frame: unknown) => { sent.push(frame); return true; },
  };
  const router = new WorkerRuntimeRouter({
    supervisor: {
      startWorker: async (root: string, prepare: any) => {
        await prepare({ workerId: 'worker-1', workerGeneration: 1, sessionPath: root });
        return { workerId: 'worker-1', workerGeneration: 1, sessionPath: root, client };
      },
      stopWorker: async () => undefined,
    } as any,
    coldStore: {
      serializePromotionGrant: (target: string) => ({
        grantId: 'grant-1', coordinatorGeneration: 7, sessionPath: target,
        sessionPathKey: target, fingerprint: 'fixture', creationReason: 'resume',
      }),
      consumePromotionGrant: () => undefined,
      abortPromotionGrant: () => undefined,
    } as any,
    ownership: {
      registerHot: async (target: string, owner: any) => ({
        ...owner, canonicalSessionPath: target, ownershipRevision: 3, nonce: 'lease-1',
      }),
      reconcileCrash: async () => undefined,
    } as any,
    coordinatorGeneration: 7,
    analyticsActivation: {
      generationId: 'analytics-generation-1', workspaceId: 'workspace-1', buildId: 'build-1',
    },
    emit: (event, payload) => emitted.push([event, payload]),
    buildPromotionSnapshot: async () => ({
      sdkPath: '/sdk', agentDir: '/agent', startupCwd: '/', sessionDir: '/sessions',
      openedPayload: opened(sessionPath, 'root-1'),
      modelSettings: { defaultModel: 'model', defaultThinkingLevel: 'off' },
    }),
  });
  const route = await router.promote(sessionPath);
  const packet = createAnalyticsFactPacket(observation('root-1', 'fact-1'));
  const frameBase = {
    ipcVersion: WORKER_IPC_VERSION,
    coordinatorGeneration: 7,
    workerId: route.owner.workerId,
    workerGeneration: route.owner.workerGeneration,
    workerPid: 123,
    rootSessionPath: sessionPath,
    leasePath: sessionPath,
    leaseRevision: 3,
    sessionPath,
  };
  await router.handleWorkerFrame(sessionPath, { ...frameBase, seq: 1, kind: 'analytics.capture', packet });
  const capture = emitted.find(([event]) => event === 'analytics.capture');
  assert.ok(capture);
  const envelope = capture[1] as { route: any; packet: typeof packet };
  assert.equal(envelope.route.workerPid, 123);
  assert.deepEqual(envelope.packet, packet);
  await router.handleWorkerFrame(sessionPath, {
    ...frameBase,
    seq: 2,
    kind: 'analytics.rebind',
    requestId: 'rebind-1',
    captureSubject: { kind: 'session', rootSessionId: 'root-2' },
  });
  assert.deepEqual(sent.at(-1), {
    kind: 'analytics.rebound',
    requestId: 'rebind-1',
    captureSubject: { kind: 'session', rootSessionId: 'root-2' },
  });

  const acknowledgement = {
    version: 1 as const,
    deliveryId: packet.deliveryId,
    generationId: packet.generationId,
    status: 'durable' as const,
  };
  assert.equal(router.acknowledgeAnalytics(envelope.route, acknowledgement), true);
  assert.deepEqual(sent.at(-1), { kind: 'analytics.ack', acknowledgement });
  assert.equal(router.acknowledgeAnalytics({ ...envelope.route, leaseRevision: 2 }, acknowledgement), false);

  const before = emitted.filter(([event]) => event === 'analytics.capture').length;
  await router.handleWorkerFrame(sessionPath, { ...frameBase, seq: 3, kind: 'analytics.capture', packet });
  await router.handleWorkerFrame(sessionPath, {
    ...frameBase,
    seq: 4,
    kind: 'analytics.capture',
    packet: createAnalyticsFactPacket(observation('root-2', 'fact-2')),
  });
  assert.equal(emitted.filter(([event]) => event === 'analytics.capture').length, before + 1);

  await router.handleWorkerFrame(sessionPath, {
    ...frameBase,
    seq: 5,
    kind: 'runtime.event',
    event: 'session.opened',
    payload: opened(sessionPath, 'root-3') as any,
  });
  const branchPayload = {
    sessionPath,
    entryId: 'entry-B',
    parentEntryId: 'entry-A',
    selectedEntryId: 'entry-B',
    observedAt: 1_767_225_600_000,
  } satisfies AnalyticsBranchObservedPayload;
  const branchDecoded = parseWorkerToCoordinatorFrame({
    ...frameBase,
    seq: 6,
    kind: 'runtime.event',
    event: 'analytics.branch',
    payload: branchPayload,
  }, { ...frameBase, expectedSeq: 6 });
  assert.equal(branchDecoded.status, 'accepted');
  if (branchDecoded.status === 'accepted') {
    await router.handleWorkerFrame(sessionPath, branchDecoded.frame);
    assert.deepEqual(emitted.at(-1), ['analytics.branch', branchPayload]);
  }
  await router.handleWorkerFrame(sessionPath, {
    ...frameBase,
    seq: 7,
    kind: 'analytics.capture',
    packet: createAnalyticsFactPacket(observation('root-3', 'fact-3')),
  });
  assert.equal(emitted.filter(([event]) => event === 'analytics.capture').length, before + 2);

  const internals = route as unknown as {
    workerRootSessionPath: string;
    currentLeasePath: string;
    currentLeaseRevision: number;
    analyticsPendingDeliveries: Map<string, unknown>;
    analyticsPendingBytes: number;
  };
  internals.analyticsPendingDeliveries.clear();
  internals.analyticsPendingBytes = 0;
  const longPath = `C:/${'a'.repeat(30_000)}.jsonl`;
  internals.workerRootSessionPath = longPath;
  internals.currentLeasePath = longPath;
  const longFrameBase = { ...frameBase, rootSessionPath: longPath, leasePath: longPath };
  const largeFact = createAnalyticsFactPacket(observation('root-3', 'large-fact'));
  largeFact.observation.fields = { payload: 'x'.repeat(100_000) };
  largeFact.observation.idempotencyKey = deriveAnalyticsIdempotencyKey(largeFact.observation);
  await router.handleWorkerFrame(sessionPath, { ...longFrameBase, seq: 8, kind: 'analytics.capture', packet: largeFact });
  assert.equal(internals.analyticsPendingDeliveries.size, 1);
  assert.ok(internals.analyticsPendingBytes < 70_000, 'coordinator retains route identity, not the large fact payload');
  let sequence = 9;
  while (!sent.some((frame: any) => frame.kind === 'analytics.ack'
      && frame.acknowledgement?.code === 'router_capacity')) {
    const sourceKey = `capacity-${sequence}`;
    await router.handleWorkerFrame(sessionPath, {
      ...longFrameBase,
      seq: sequence,
      kind: 'analytics.capture',
      packet: createAnalyticsFactPacket(observation('root-3', sourceKey)),
    });
    sequence += 1;
    assert.ok(sequence < 1_000, 'byte capacity must reject before the count ceiling');
  }
  assert.ok(internals.analyticsPendingDeliveries.size < 4_096);
  assert.ok(internals.analyticsPendingBytes <= 8 * 1024 * 1024);

  internals.workerRootSessionPath = sessionPath;
  internals.currentLeasePath = sessionPath;
  await router.handleWorkerStateChange(sessionPath, {
    status: 'exited',
    pid: 123,
    exitCode: 0,
    exitSignal: null,
    stdoutTail: '',
    stderrTail: '',
  } as any, { workerId: 'worker-1', workerGeneration: 1 });
  const routeClosed = emitted.filter(([event]) => event === ANALYTICS_ROUTE_CLOSED_EVENT);
  assert.equal(routeClosed.length, 1, 'confirmed worker retirement emits one exact route cleanup event');
  assert.deepEqual((routeClosed[0]![1] as { route: unknown }).route, {
    coordinatorGeneration: 7,
    workerId: 'worker-1',
    workerGeneration: 1,
    workerPid: 123,
    rootSessionPath: longPath,
    leasePath: longPath,
    leaseRevision: 3,
  });
  assert.equal(internals.analyticsPendingDeliveries.size, 0, 'route cleanup releases coordinator retention');
});
