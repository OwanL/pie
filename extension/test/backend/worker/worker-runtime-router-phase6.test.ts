import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkerRuntimeRouter } from '../../../src/backend/worker-runtime-router';
import { CoordinatorProviderNetworkLeaseAuthority } from '../../../src/backend/coordinator-provider-network-lease';
import {
  WorkerRequestEnqueueError,
  type WorkerClientScheduler,
} from '../../../src/backend/worker-client';

class FakeRouterClock implements WorkerClientScheduler {
  private current = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  now(): number { return this.current; }

  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const id = this.nextId++;
    this.timers.set(id, { at: this.current + delayMs, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(timer: ReturnType<typeof setTimeout>): void {
    this.timers.delete(timer as unknown as number);
  }

  advance(milliseconds: number): void {
    this.current += milliseconds;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at > this.current) continue;
      this.timers.delete(id);
      timer.callback();
    }
  }
}

function opened(sessionPath: string) {
  return {
    session: { path: sessionPath, name: 'A', cwd: '.', modifiedAt: new Date(0).toISOString(), messageCount: 0 },
    transcript: [],
    transcriptWindow: { totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false },
    busy: false,
    runtimeReady: false,
    systemPrompts: [],
    analyticsFactors: {},
    modelSettings: { defaultModel: 'm', defaultThinkingLevel: 'off' },
    availableModels: [{ id: 'configured-a', name: 'Configured A', provider: 'phase-0', reasoning: false, inputKinds: ['text'] }],
  };
}

function makeClient(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ kind: string; operation?: string; params?: unknown; domain?: string; revision?: number }> = [];
  const client = {
    start: async () => ({ mode: 'phase2' as const, startedAt: 1 }),
    ping: async () => ({ kind: 'pong' as const }),
    interrupt: async () => ({ kind: 'interrupted' as const }),
    shutdown: async () => ({ kind: 'shutting-down' as const }),
    forceKill: async () => undefined,
    waitForConfirmedExit: async () => ({ code: 0, signal: null }),
    getSnapshot: () => ({ status: 'ready' as const, stdoutTail: '', stderrTail: '' }),
    requestFrame: async (body: any) => {
      calls.push(body);
      if (body.kind === 'sync') return { kind: 'sync.ack', requestId: 'x', domain: body.domain, revision: body.revision };
      if (body.kind === 'runtime.promote') return { kind: 'runtime.ready', requestId: 'x', runtimeMetadata: { mode: 'phase4', startedAt: 1 } };
      if (body.kind === 'runtime.command') {
        return { kind: 'response', requestId: 'x', ok: true, result: { kind: 'runtime.command', payload: { ok: true } } };
      }
      throw new Error(`unexpected frame ${body.kind}`);
    },
    sendFrame: () => true,
    updateLeaseIdentity: () => undefined,
    calls,
    ...overrides,
  };
  return client;
}

function makeRouter(client: any, extra: { supervisor?: Record<string, unknown>; options?: Record<string, unknown> } = {}) {
  const sessionPath = `${process.cwd()}/phase6-session.jsonl`;
  const stopped: string[] = [];
  const emitted: Array<[string, any]> = [];
  const supervisor = {
    startWorker: async (root: string, prepare: any) => {
      await prepare({ workerId: client.workerId ?? 'phase6-worker', workerGeneration: client.workerGeneration ?? 1, sessionPath: root });
      return { workerId: client.workerId ?? 'phase6-worker', workerGeneration: client.workerGeneration ?? 1, sessionPath: root, client };
    },
    stopWorker: async (root: string) => { stopped.push(root); },
    listWorkers: () => [{ workerId: client.workerId ?? 'phase6-worker', workerGeneration: client.workerGeneration ?? 1, sessionPath, client }],
    ...extra.supervisor,
  };
  const coldStore = {
    serializePromotionGrant: (target: string) => ({ grantId: 'grant', coordinatorGeneration: 1, sessionPath: target, sessionPathKey: target, fingerprint: 'f', creationReason: 'resume' }),
    consumePromotionGrant: (grant: any) => grant,
    abortPromotionGrant: () => undefined,
  };
  const ownership = {
    registerHot: async (target: string, owner: any) => ({ ...owner, canonicalSessionPath: target, ownershipRevision: 1, nonce: 'lease' }),
    reconcileCrash: async () => undefined,
  };
  const router = new WorkerRuntimeRouter({
    supervisor: supervisor as any,
    coldStore: coldStore as any,
    ownership: ownership as any,
    emit: (event, payload) => emitted.push([event, payload]),
    buildPromotionSnapshot: async () => ({
      sdkPath: '/sdk', agentDir: '/agent', startupCwd: '/', sessionDir: '/sessions',
      openedPayload: opened(sessionPath) as any,
      modelSettings: { defaultModel: 'm', defaultThinkingLevel: 'off' },
      authPath: '/agent/auth.json',
      authFingerprint: 'fp-1',
    }),
    ...extra.options,
  });
  return { router, sessionPath, client, emitted, stopped, supervisor };
}

function eventFrame(route: any, sessionPath: string, event: string, payload: any, seq: number): any {
  return {
    ipcVersion: 1, coordinatorGeneration: 1, workerId: route.owner.workerId,
    workerGeneration: route.owner.workerGeneration, workerPid: 1, rootSessionPath: sessionPath,
    leasePath: sessionPath, leaseRevision: 1, sessionPath, seq, kind: 'runtime.event', event, payload,
  };
}

function providerFrame(route: any, sessionPath: string, kind: string, body: Record<string, unknown>): any {
  return {
    ipcVersion: 1, coordinatorGeneration: 1, workerId: route.owner.workerId,
    workerGeneration: route.owner.workerGeneration, workerPid: 1, rootSessionPath: sessionPath,
    leasePath: sessionPath, leaseRevision: 1, sessionPath, seq: 1, kind, ...body,
  };
}

test('phase6 provider: a queued admission cancelled via provider.cancel settles exactly once', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const leases = new CoordinatorProviderNetworkLeaseAuthority();
  const { router, sessionPath } = makeRouter(makeClient({ sendFrame: (frame: any) => { sent.push(frame); return true; } }), {
    options: { providerLeases: leases },
  });
  const route = await router.promote(sessionPath);
  // The first acquire takes the sole per-provider slot.
  await router.handleWorkerFrame(sessionPath, providerFrame(route, sessionPath, 'provider.acquire', {
    requestId: 'admission-1',
    request: { provider: 'p', model: 'm', turnId: 't', attemptId: 'a1' },
  }));
  // The second acquire queues behind it while its handler awaits admission.
  const queuedAcquire = router.handleWorkerFrame(sessionPath, providerFrame(route, sessionPath, 'provider.acquire', {
    requestId: 'admission-2',
    request: { provider: 'p', model: 'm', turnId: 't', attemptId: 'a2' },
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(leases.inspect().queued, 1);
  // The worker's AbortSignal cancels the queued admission.
  await router.handleWorkerFrame(sessionPath, providerFrame(route, sessionPath, 'provider.cancel', {
    requestId: 'cancel-1',
    targetRequestId: 'admission-2',
    reason: 'Fetch AbortSignal fired while provider admission was queued.',
  }));
  await queuedAcquire;
  // Exactly one correlated provider.cancelled settles the acquire; a second
  // frame would fatal the worker on an unknown requestId.
  const cancelled = sent.filter((frame) => frame.kind === 'provider.cancelled');
  assert.equal(cancelled.length, 1, 'the correlated cancel must settle the acquire exactly once');
  assert.equal(cancelled[0]!.requestId, 'admission-2');
  const acks = sent.filter((frame) => frame.kind === 'provider.cancelAck');
  assert.equal(acks.length, 1);
  assert.equal((acks[0] as { status?: string }).status, 'queued');
  // The first lease remains active with exactly one delivered grant.
  const granted = sent.filter((frame) => frame.kind === 'provider.granted');
  assert.equal(granted.length, 1);
  assert.equal(granted[0]!.requestId, 'admission-1');
  assert.equal(leases.inspect().providers?.['p']?.active, 1);
});

test('phase6 provider: a duplicate queued acquire cannot later deliver a second terminal frame', async () => {
  const sent: Array<Record<string, any>> = [];
  const leases = new CoordinatorProviderNetworkLeaseAuthority();
  const { router, sessionPath } = makeRouter(makeClient({
    sendFrame: (frame: any) => { sent.push(frame); return true; },
  }), { options: { providerLeases: leases } });
  const route = await router.promote(sessionPath);
  await router.handleWorkerFrame(sessionPath, providerFrame(route, sessionPath, 'provider.acquire', {
    requestId: 'admission-active',
    request: { provider: 'p', model: 'm', turnId: 't', attemptId: 'active' },
  }));
  const duplicate = providerFrame(route, sessionPath, 'provider.acquire', {
    requestId: 'admission-duplicate',
    request: { provider: 'p', model: 'm', turnId: 't', attemptId: 'queued' },
  });
  const queuedAcquire = router.handleWorkerFrame(sessionPath, duplicate);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(leases.inspect().queued, 1);

  await router.handleWorkerFrame(sessionPath, { ...duplicate, seq: 2 });
  await queuedAcquire;
  assert.deepEqual(
    sent.filter((frame) => frame.kind === 'provider.cancelled' && frame.requestId === 'admission-duplicate')
      .map((frame) => frame.reason),
    ['Duplicate provider admission request.'],
  );
  assert.equal(leases.inspect().queued, 0);

  const active = sent.find((frame) => frame.kind === 'provider.granted' && frame.requestId === 'admission-active');
  assert.ok(active?.lease?.leaseId);
  leases.release(route.owner, active.lease.leaseId, 'completed');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    sent.filter((frame) => frame.kind === 'provider.granted' && frame.requestId === 'admission-duplicate').length,
    0,
    'cancelled duplicate authority work must not regain capacity and grant later',
  );
});

test('phase6 provider: an acquire during promotion is granted (not dropped) so the worker does not hang', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const leases = new CoordinatorProviderNetworkLeaseAuthority();
  // Hold `runtime.promote` unresolved so the route stays in the `promoting`
  // state (the hot route is installed in `roots` only after runtime.ready).
  // A `session_start` extension fetch can issue a provider.acquire during this
  // window; it must be granted, not dropped, or the worker's correlated
  // `provider.granted` never arrives and promotion hangs forever.
  let releasePromote!: () => void;
  const promoteGate = new Promise<void>((resolve) => { releasePromote = resolve; });
  const client = makeClient({
    sendFrame: (frame: any) => { sent.push(frame); return true; },
    requestFrame: async (body: any) => {
      if (body.kind === 'sync') return { kind: 'sync.ack', requestId: 'x', domain: body.domain, revision: body.revision };
      if (body.kind === 'runtime.promote') {
        await promoteGate;
        return { kind: 'runtime.ready', requestId: 'x', runtimeMetadata: { mode: 'phase4', startedAt: 1 } };
      }
      throw new Error(`unexpected frame ${body.kind}`);
    },
  });
  const { router, sessionPath } = makeRouter(client, { options: { providerLeases: leases } });
  const promoting = router.promote(sessionPath);
  // Let the promotion reach the point where the worker is spawned and the
  // route is installed in currentPaths/workersById but the root is still
  // `promoting`.
  await new Promise((resolve) => setImmediate(resolve));
  // The worker issues a provider.acquire while still promoting.
  const route = router.getRoute(sessionPath);
  assert.equal(route.state, 'promoting');
  await router.handleWorkerFrame(sessionPath, providerFrame(
    { owner: { workerId: 'phase6-worker', workerGeneration: 1 }, currentLeasePath: sessionPath, currentLeaseRevision: 1, workerRootSessionPath: sessionPath },
    sessionPath,
    'provider.acquire',
    { requestId: 'admission-promo', request: { provider: 'p', model: 'm', turnId: 't', attemptId: 'a' } },
  ));
  // The acquire must be granted (not dropped) even though the root is still
  // `promoting`.
  const granted = sent.filter((frame) => frame.kind === 'provider.granted');
  assert.equal(granted.length, 1, 'provider.acquire during promotion must be granted');
  assert.equal(granted[0]!.requestId, 'admission-promo');
  // Complete promotion; the route flips to hot and the initiating command runs.
  releasePromote();
  await promoting;
  assert.equal(router.getRoute(sessionPath).state, 'hot');
});

test('phase6 provider: an open global circuit still settles the exact acquire', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const leases = new CoordinatorProviderNetworkLeaseAuthority({ defaultPolicy: { circuitFailureThreshold: 1 } });
  const { router, sessionPath } = makeRouter(makeClient({ sendFrame: (frame: any) => { sent.push(frame); return true; } }), {
    options: { providerLeases: leases },
  });
  const route = await router.promote(sessionPath);
  // Open the circuit with an observed retryable failure.
  const first = await leases.acquire(route.owner, 'admission-1', { provider: 'p', model: 'm' });
  leases.observe(route.owner, first.leaseId, { classification: 'transport-error', retryable: true });
  leases.release(route.owner, first.leaseId, 'failed');
  // A fresh acquire is rejected by the open circuit and must still be settled.
  await router.handleWorkerFrame(sessionPath, providerFrame(route, sessionPath, 'provider.acquire', {
    requestId: 'admission-2',
    request: { provider: 'p', model: 'm', turnId: 't', attemptId: 'a2' },
  }));
  const rejected = sent.filter((frame) => frame.kind === 'provider.rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]!.requestId, 'admission-2');
  assert.deepEqual((rejected[0] as any).error, {
    name: 'ProviderCircuitOpenError',
    message: (rejected[0] as any).error.message,
    retryable: true,
    httpStatus: 503,
  });
  assert.match(String((rejected[0] as any).error.message), /circuit is open/);
});

test('phase6 provider: a bounded queue rejection preserves retryability and HTTP status', async () => {
  const clock = new FakeRouterClock();
  const sent: Array<Record<string, any>> = [];
  const leases = new CoordinatorProviderNetworkLeaseAuthority({
    now: () => clock.now(),
    setTimeout: (callback, delayMs) => clock.setTimeout(callback, delayMs),
    clearTimeout: (timer) => clock.clearTimeout(timer as ReturnType<typeof setTimeout>),
    defaultPolicy: { queueWaitMs: 50 },
  });
  const { router, sessionPath } = makeRouter(makeClient({
    sendFrame: (frame: any) => { sent.push(frame); return true; },
  }), { options: { providerLeases: leases } });
  const route = await router.promote(sessionPath);
  await router.handleWorkerFrame(sessionPath, providerFrame(route, sessionPath, 'provider.acquire', {
    requestId: 'admission-active',
    request: { provider: 'p', model: 'm', turnId: 't', attemptId: 'active' },
  }));
  const queuedAcquire = router.handleWorkerFrame(sessionPath, providerFrame(route, sessionPath, 'provider.acquire', {
    requestId: 'admission-queued',
    request: { provider: 'p', model: 'm', turnId: 't', attemptId: 'queued' },
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(leases.inspect().queued, 1);

  clock.advance(51);
  await queuedAcquire;

  const rejected = sent.filter((frame) => frame.kind === 'provider.rejected'
    && frame.requestId === 'admission-queued');
  assert.deepEqual(rejected.map((frame) => frame.error), [{
    name: 'ProviderGateSaturatedError',
    message: 'Provider "p" concurrency cap reached: waited 50ms without a slot. Retry after a brief delay.',
    retryable: true,
    httpStatus: 429,
  }]);
  assert.equal(sent.some((frame) => frame.kind === 'provider.cancelled'
    && frame.requestId === 'admission-queued'), false);
});

test('phase6 extension UI: exact owner routes once, settles, and duplicates are typed stale', async () => {
  const { router, sessionPath, client } = makeRouter(makeClient());
  const route = await router.promote(sessionPath);
  await router.handleWorkerFrame(sessionPath, eventFrame(route, sessionPath, 'extension_ui.request', {
    id: 'ui-1', method: 'select', sessionPath, title: 'Pick', options: ['a'], subagentCallId: 'sub-1', toolCallId: 'tool-1', timeout: 30_000,
  }, 1));
  assert.deepEqual(router.inspectExtensionUiOwners().map((entry) => entry.uiRequestId), ['ui-1']);
  const response = await router.route({
    id: 'public-1', method: 'extension_ui.response',
    params: { sessionPath, response: { id: 'ui-1', value: 'a' } },
  });
  assert.deepEqual(response, { ok: true });
  const command = client.calls.find((call: any) => call.kind === 'runtime.command') as any;
  assert.equal(command.operation, 'extension_ui.response');
  assert.deepEqual(command.payload.params, { sessionPath, response: { id: 'ui-1', value: 'a' } });
  // The first settlement cleared the owner: a duplicate is typed stale and
  // never reaches the worker again.
  const commandCount = client.calls.filter((call: any) => call.kind === 'runtime.command').length;
  await assert.rejects(
    router.route({ id: 'public-2', method: 'extension_ui.response', params: { sessionPath, response: { id: 'ui-1', value: 'b' } } }),
    /no longer pending/,
  );
  assert.equal(client.calls.filter((call: any) => call.kind === 'runtime.command').length, commandCount);
  assert.deepEqual(router.inspectExtensionUiOwners(), []);
});

test('phase6 extension UI: unknown/mismatched responses are typed stale without worker invocation', async () => {
  const { router, sessionPath, client } = makeRouter(makeClient());
  const route = await router.promote(sessionPath);
  await router.handleWorkerFrame(sessionPath, eventFrame(route, sessionPath, 'extension_ui.request', {
    id: 'ui-2', method: 'confirm', sessionPath, title: 'Sure?', message: 'm',
  }, 1));
  await assert.rejects(
    router.route({ id: 'public-3', method: 'extension_ui.response', params: { sessionPath, response: { id: 'other-id', confirmed: true } } }),
    /no longer pending/,
  );
  assert.equal(client.calls.some((call: any) => call.kind === 'runtime.command'), false);
  // notify dialogs are fire-and-forget and never recorded.
  await router.handleWorkerFrame(sessionPath, eventFrame(route, sessionPath, 'extension_ui.request', {
    id: 'ui-notify', method: 'notify', sessionPath, message: 'hi',
  }, 2));
  assert.deepEqual(router.inspectExtensionUiOwners().map((entry) => entry.uiRequestId), ['ui-2']);
  await assert.rejects(
    router.route({ id: 'public-4', method: 'extension_ui.response', params: { sessionPath, response: { id: 'ui-notify' } } }),
    /no longer pending/,
  );
});

test('phase6 extension UI: worker crash clears owners and a late response is typed stale', async () => {
  const { router, sessionPath, client, emitted } = makeRouter(makeClient());
  const route = await router.promote(sessionPath);
  await router.handleWorkerFrame(sessionPath, eventFrame(route, sessionPath, 'extension_ui.request', {
    id: 'ui-3', method: 'input', sessionPath, title: 'Type', placeholder: 'p',
  }, 1));
  assert.equal(router.inspectExtensionUiOwners().length, 1);
  const crashed = { ...client, getSnapshot: () => ({ status: 'exited' as const, stdoutTail: '', stderrTail: '' }) };
  await router.handleWorkerStateChange(sessionPath, crashed.getSnapshot(), { workerId: route.owner.workerId, workerGeneration: 1 });
  assert.deepEqual(router.inspectExtensionUiOwners(), []);
  assert.ok(emitted.some(([event, payload]) => event === 'operational-error' && payload.code === 'SESSION_WORKER_EXITED'));
  // A late response after the crash is typed stale (the route is cold; a
  // fresh response must not invoke the dead generation's callback).
  await assert.rejects(
    router.route({ id: 'public-5', method: 'extension_ui.response', params: { sessionPath, response: { id: 'ui-3', value: 'x' } } }),
    /no longer pending|No hot worker owns/,
  );
});

test('phase6 checkpoint: usage, durable watermark, and detail manifest are bounded and reported on crash', async () => {
  const detailClient = makeClient();
  const baseRequest = detailClient.requestFrame.bind(detailClient);
  (detailClient as any).requestFrame = async (body: any) => {
    if (body.kind === 'detail.subscribe') {
      return { kind: 'detail.start', requestId: 'x', subscriptionId: body.subscriptionId, address: body.address, source: 'live', baselineRevision: 5, pageCount: 1, totalBytes: 64, totalCodePoints: 64 };
    }
    return await baseRequest(body);
  };
  const { router, sessionPath, emitted } = makeRouter(detailClient);
  const route = await router.promote(sessionPath);
  await router.handleWorkerFrame(sessionPath, eventFrame(route, sessionPath, 'busy.changed', { sessionPath, busy: true, seq: 3 }, 1));
  await router.handleWorkerFrame(sessionPath, eventFrame(route, sessionPath, 'message.started', { sessionPath, requestId: 'request-1', messageId: 'message-1' }, 2));
  await router.handleWorkerFrame(sessionPath, eventFrame(route, sessionPath, 'tool.started', { sessionPath, requestId: 'request-1', messageId: 'message-1', toolCallId: 'tool-1', name: 'bash' }, 3));
  await router.handleWorkerFrame(sessionPath, eventFrame(route, sessionPath, 'contextUsage.changed', {
    sessionPath, contextUsage: { tokens: 1200, contextWindow: 8192, percent: 15 },
  }, 4));
  await router.handleWorkerFrame(sessionPath, eventFrame(route, sessionPath, 'tool.finished', {
    sessionPath, requestId: 'request-1', toolCallId: 'tool-1', status: 'success', result: {}, durableEntryId: 'entry-42',
  }, 5));
  await router.handleWorkerFrame(sessionPath, eventFrame(route, sessionPath, 'tool.started', {
    sessionPath, requestId: 'request-1', messageId: 'message-1', toolCallId: 'tool-2', name: 'read',
  }, 6));
  // A live detail subscription contributes a bounded manifest entry.
  const address = {
    sessionPath,
    turnId: 'turn-1',
    rootToolCallId: 'root-tool-1',
    rootAttemptId: 'attempt-1',
    lineage: [{ childId: 'child-1', spawningToolCallId: 'spawn-1', attemptId: 'attempt-1' }],
  };
  await router.subscribeDetail({ kind: 'detail.subscribe', requestId: 'sub-1', subscriptionId: 'subscription-1', address, maxPageBytes: 4096 });
  const crashedClient = { ...detailClient, getSnapshot: () => ({ status: 'exited' as const, stdoutTail: '', stderrTail: '' }) };
  await router.handleWorkerStateChange(sessionPath, crashedClient.getSnapshot(), { workerId: route.owner.workerId, workerGeneration: 1 });
  const incident = emitted.find(([event]) => event === 'operational-error')?.[1];
  assert.ok(incident);
  assert.equal(incident.code, 'SESSION_WORKER_EXITED');
  // Checkpoints expose the coordinator-owned public sequence, not the
  // worker-local counter (which restarts after every cold re-promotion).
  assert.equal(incident.checkpoint.busySeq, 1);
  assert.equal(incident.checkpoint.requestId, 'request-1');
  assert.deepEqual(incident.checkpoint.tools, [{ requestId: 'request-1', messageId: 'message-1', toolCallId: 'tool-2', name: 'read' }]);
  assert.deepEqual(incident.checkpoint.usage, { tokens: 1200, contextWindow: 8192, percent: 15 });
  assert.equal(incident.checkpoint.durableWatermark, 'entry-42');
  assert.deepEqual(incident.checkpoint.detailManifest, [{ subscriptionId: 'subscription-1', state: 'active', revision: 5, pageCount: 1 }]);
});

test('phase6 runtime.report is retained without replacing configured authority', async () => {
  const { router, sessionPath } = makeRouter(makeClient());
  const route = await router.promote(sessionPath);
  await router.handleWorkerFrame(sessionPath, {
    ipcVersion: 1, coordinatorGeneration: 1, workerId: route.owner.workerId,
    workerGeneration: route.owner.workerGeneration, workerPid: 1, rootSessionPath: sessionPath,
    leasePath: sessionPath, leaseRevision: 1, sessionPath, seq: 1,
    kind: 'runtime.report', domain: 'catalog',
    payload: { models: [{ id: 'runtime-discovered', name: 'Runtime', provider: 'phase-0', reasoning: true }] },
  });
  const reports = router.inspectRuntimeReports();
  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.workerId, route.owner.workerId);
  assert.equal((reports[0]!.models[0] as { id: string }).id, 'runtime-discovered');
  // A stale/cross-session report is dropped by the identity fence.
  await router.handleWorkerFrame('/other', {
    ipcVersion: 1, coordinatorGeneration: 1, workerId: 'stale', workerGeneration: 9, workerPid: 1,
    rootSessionPath: '/other', leasePath: '/other', leaseRevision: 1, sessionPath: '/other', seq: 1,
    kind: 'runtime.report', domain: 'catalog', payload: { models: [] },
  });
  assert.equal(router.inspectRuntimeReports().length, 1);
});

test('phase6 auth refresh retries slow ACKs but retires definite worker failures', async () => {
  const { router, sessionPath, stopped } = makeRouter(makeClient());
  const route = await router.promote(sessionPath);
  const result = await router.refreshAuth('fp-2', '/agent/auth.json');
  assert.deepEqual(result, { bumped: true, retiredWorkers: 0 });
  const sync = [...(route.worker.client as any).calls].reverse().find((call: any) => call.kind === 'sync' && call.domain === 'auth');
  assert.ok(sync);
  assert.equal(sync.revision, 2);
  assert.deepEqual(sync.payload, { authPath: '/agent/auth.json', fingerprint: 'fp-2' });
  // An unchanged fingerprint does not bump again.
  assert.deepEqual(await router.refreshAuth('fp-2', '/agent/auth.json'), { bumped: false, retiredWorkers: 0 });
  // A definite worker/transport failure remains fail-closed; only an ACK
  // deadline or bounded queue pressure is retryable.
  const failingClient = makeClient({
    requestFrame: async (body: any) => {
      if (body.kind === 'sync' && body.domain === 'auth' && body.payload?.fingerprint === 'fp-3') throw new Error('worker is wedged');
      if (body.kind === 'sync') return { kind: 'sync.ack', requestId: 'x', domain: body.domain, revision: body.revision };
      if (body.kind === 'runtime.promote') return { kind: 'runtime.ready', requestId: 'x', runtimeMetadata: { mode: 'phase4', startedAt: 1 } };
      throw new Error(`unexpected frame ${body.kind}`);
    },
  });
  const failing = makeRouter(failingClient);
  await failing.router.promote(sessionPath);
  const failed = await failing.router.refreshAuth('fp-3', '/agent/auth.json');
  assert.equal(failed.bumped, true);
  assert.equal(failed.retiredWorkers, 1);
  assert.ok(stopped.length >= 0);
  assert.ok(failing.stopped.includes(sessionPath));
});

test('phase6 live auth refresh survives a transient delay beyond the startup ACK boundary', async () => {
  const clock = new FakeRouterClock();
  let releaseAuth!: () => void;
  const authGate = new Promise<void>((resolve) => { releaseAuth = resolve; });
  const client = makeClient({
    requestFrame: async (body: any) => {
      client.calls.push(body);
      if (body.kind === 'sync') {
        if (body.domain === 'auth' && body.revision === 2) await authGate;
        return { kind: 'sync.ack', requestId: 'x', domain: body.domain, revision: body.revision };
      }
      if (body.kind === 'runtime.promote') {
        return { kind: 'runtime.ready', requestId: 'x', runtimeMetadata: { mode: 'phase4', startedAt: 1 } };
      }
      throw new Error(`unexpected frame ${body.kind}`);
    },
  });
  const { router, sessionPath, stopped, emitted } = makeRouter(client, {
    options: {
      scheduler: clock,
      syncAckTimeoutMs: 50,
      broadcastSyncAckTimeoutMs: 500,
    },
  });
  await router.promote(sessionPath);

  const refresh = router.refreshAuth('fp-2', '/agent/auth.json');
  for (let turn = 0; turn < 4 && !client.calls.some((body: any) =>
    body.kind === 'sync' && body.domain === 'auth' && body.revision === 2); turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  clock.advance(51);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(router.getRoute(sessionPath).state, 'hot');
  assert.deepEqual(stopped, []);
  assert.equal(emitted.some(([event, payload]) => event === 'operational-error'
    && payload.code === 'SESSION_WORKER_SYNC_FAILED'), false);

  releaseAuth();
  assert.deepEqual(await refresh, { bumped: true, retiredWorkers: 0 });
  assert.equal(router.getRoute(sessionPath).state, 'hot');
});

test('phase6 settings/catalog sync broadcasts the configured authority to every worker', async () => {
  const { router, sessionPath } = makeRouter(makeClient(), {
    options: {
      readModelSettings: async () => ({ defaultModel: 'm', defaultThinkingLevel: 'off' }),
    },
  });
  await router.promote(sessionPath);
  await router.syncSettings();
  await router.syncCatalog([{ id: 'configured-b', name: 'Configured B', provider: 'phase-0', reasoning: false }]);
  const client = (await router.getRoute(sessionPath) as any).worker.client;
  const settingsSync = [...client.calls].reverse().find((call: any) => call.kind === 'sync' && call.domain === 'settings');
  const catalogSync = [...client.calls].reverse().find((call: any) => call.kind === 'sync' && call.domain === 'catalog');
  assert.ok(settingsSync);
  assert.equal(settingsSync.revision, 2);
  assert.ok(settingsSync.payload.values);
  assert.ok(catalogSync);
  assert.equal(catalogSync.revision, 2);
  assert.deepEqual(catalogSync.payload.models, [{ id: 'configured-b', name: 'Configured B', provider: 'phase-0', reasoning: false }]);
});

test('phase6 session registry sync is present at startup and host revisions are latest-wins', async () => {
  const { router, sessionPath, client } = makeRouter(makeClient());
  await router.promote(sessionPath);

  const startup = client.calls.find((call: any) => call.kind === 'sync' && call.domain === 'sessionRegistry') as any;
  assert.ok(startup, 'every promoted worker receives the retained registry domain before runtime startup');
  assert.equal(startup.revision, 1);
  assert.deepEqual(startup.payload, { tabs: [] });

  const first = await router.syncSessionRegistry([
    { path: '/sessions/a.jsonl', pinned: true, isRunning: false },
  ], 7);
  assert.deepEqual(first, { applied: true, revision: 2, retiredWorkers: 0 });

  const duplicate = await router.syncSessionRegistry([
    { path: '/sessions/a.jsonl', pinned: true, isRunning: false },
  ], 7);
  assert.deepEqual(duplicate, { applied: false, revision: 2, retiredWorkers: 0 });

  const stale = await router.syncSessionRegistry([
    { path: '/sessions/stale.jsonl', pinned: false, isRunning: false },
  ], 6);
  assert.deepEqual(stale, { applied: false, revision: 2, retiredWorkers: 0 });

  const latest = await router.syncSessionRegistry([
    { path: '/sessions/a.jsonl', pinned: false, isRunning: true },
  ], 8);
  assert.deepEqual(latest, { applied: true, revision: 3, retiredWorkers: 0 });

  const registrySyncs = client.calls.filter((call: any) => call.kind === 'sync' && call.domain === 'sessionRegistry') as any[];
  assert.deepEqual(registrySyncs.map((call) => [call.revision, call.payload.tabs]), [
    [1, []],
    [2, [{ path: '/sessions/a.jsonl', pinned: true, isRunning: false }]],
    [3, [{ path: '/sessions/a.jsonl', pinned: false, isRunning: true }]],
  ]);
});

test('phase6 session registry timeout keeps a busy worker hot and retries the latest revision', async () => {
  const clock = new FakeRouterClock();
  let registryAttempts = 0;
  let transportStatus: 'ready' | 'unresponsive' = 'ready';
  const client = makeClient({
    getSnapshot: () => ({ status: transportStatus, stdoutTail: '', stderrTail: '' }),
    requestFrame: async (body: any) => {
      client.calls.push(body);
      if (body.kind === 'sync') {
        if (body.domain === 'sessionRegistry' && body.revision === 2) {
          registryAttempts += 1;
          if (registryAttempts === 1) return await new Promise(() => undefined);
        }
        return { kind: 'sync.ack', requestId: 'x', domain: body.domain, revision: body.revision };
      }
      if (body.kind === 'runtime.promote') {
        return { kind: 'runtime.ready', requestId: 'x', runtimeMetadata: { mode: 'phase4', startedAt: 1 } };
      }
      throw new Error(`unexpected frame ${body.kind}`);
    },
  });
  const { router, sessionPath, emitted, stopped } = makeRouter(client, {
    options: { scheduler: clock, syncAckTimeoutMs: 50 },
  });
  const route = await router.promote(sessionPath);
  await router.handleWorkerFrame(sessionPath, eventFrame(
    route, sessionPath, 'busy.changed', { sessionPath, busy: true, seq: 1 }, 1,
  ));
  await router.handleWorkerFrame(sessionPath, eventFrame(
    route, sessionPath, 'message.started',
    { sessionPath, requestId: 'review-request', messageId: 'review-message' }, 2,
  ));
  emitted.length = 0;

  const result = await router.syncSessionRegistry([
    { path: sessionPath, pinned: true, isRunning: true },
  ], 10);
  assert.deepEqual(result, { applied: true, revision: 2, retiredWorkers: 0 });
  assert.equal(router.getRoute(sessionPath).state, 'hot');

  transportStatus = 'unresponsive';
  clock.advance(51);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(stopped, [], 'auxiliary registry timeout must not retire active work');
  assert.equal(emitted.some(([event]) => event === 'message.aborted' || event === 'preflight.failed'), false);

  clock.advance(1_000);
  await new Promise((resolve) => setImmediate(resolve));
  transportStatus = 'ready';
  assert.equal(registryAttempts, 2, 'the newest registry revision is retried after the worker responds again');
  assert.equal(router.getRoute(sessionPath).state, 'hot');
  assert.equal(emitted.some(([event, payload]) => event === 'operational-error'
    && payload.code === 'SESSION_WORKER_SYNC_FAILED'), false);
});

test('phase6 live sync retries bounded enqueue pressure without retiring healthy work', async () => {
  const clock = new FakeRouterClock();
  let runtimePrefsAttempts = 0;
  const client = makeClient({
    requestFrame: async (body: any, _expectedKind: string, options: any) => {
      client.calls.push(body);
      if (body.kind === 'sync') {
        if (body.domain === 'runtimePrefs' && body.revision === 2) {
          runtimePrefsAttempts += 1;
          assert.equal(options.fatalOnEnqueueRejection, false);
          if (runtimePrefsAttempts === 1) {
            throw new WorkerRequestEnqueueError('capacity', 'control lane is temporarily full');
          }
        }
        return { kind: 'sync.ack', requestId: 'x', domain: body.domain, revision: body.revision };
      }
      if (body.kind === 'runtime.promote') {
        return { kind: 'runtime.ready', requestId: 'x', runtimeMetadata: { mode: 'phase4', startedAt: 1 } };
      }
      throw new Error(`unexpected frame ${body.kind}`);
    },
  });
  const { router, sessionPath, stopped, emitted } = makeRouter(client, {
    options: { scheduler: clock, syncAckTimeoutMs: 50 },
  });
  await router.promote(sessionPath);

  await router.syncRuntimePrefs({ compact: true });
  assert.equal(router.getRoute(sessionPath).state, 'hot');
  assert.deepEqual(stopped, []);
  assert.equal(emitted.some(([event, payload]) => event === 'operational-error'
    && payload.code === 'SESSION_WORKER_SYNC_FAILED'), false);

  clock.advance(1_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtimePrefsAttempts, 2);
  assert.equal(router.getRoute(sessionPath).state, 'hot');
});

test('phase6 live-sync retry never targets a replacement worker generation at the same path', async () => {
  const clock = new FakeRouterClock();
  let runtimePrefsAttempts = 0;
  const oldClient = makeClient({
    requestFrame: async (body: any) => {
      oldClient.calls.push(body);
      if (body.kind === 'sync') {
        if (body.domain === 'runtimePrefs' && body.revision === 2) {
          runtimePrefsAttempts += 1;
          return new Promise(() => undefined);
        }
        return { kind: 'sync.ack', requestId: 'x', domain: body.domain, revision: body.revision };
      }
      if (body.kind === 'runtime.promote') {
        return { kind: 'runtime.ready', requestId: 'x', runtimeMetadata: { mode: 'phase4', startedAt: 1 } };
      }
      throw new Error(`unexpected frame ${body.kind}`);
    },
  });
  const replacementClient = makeClient();
  let supervisedWorker: any;
  const { router, sessionPath } = makeRouter(oldClient, {
    supervisor: {
      startWorker: async (root: string, prepare: any) => {
        await prepare({ workerId: 'old-worker', workerGeneration: 1, sessionPath: root });
        supervisedWorker = {
          workerId: 'old-worker', workerGeneration: 1, sessionPath: root, client: oldClient,
        };
        return supervisedWorker;
      },
      listWorkers: () => supervisedWorker ? [supervisedWorker] : [],
    },
    options: { scheduler: clock, syncAckTimeoutMs: 50 },
  });
  await router.promote(sessionPath);

  const sync = router.syncRuntimePrefs({ compact: true });
  await new Promise((resolve) => setImmediate(resolve));
  clock.advance(51);
  await sync;
  assert.equal(runtimePrefsAttempts, 1);

  supervisedWorker = {
    workerId: 'replacement-worker', workerGeneration: 2, sessionPath, client: replacementClient,
  };
  clock.advance(1_000);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(runtimePrefsAttempts, 1, 'the retired generation receives no retry');
  assert.equal(replacementClient.calls.length, 0, 'startup synchronization alone may address the replacement');
});

test('phase6 simultaneous registry and settings delay does not kill a healthy review at the old 5s boundary', async () => {
  const clock = new FakeRouterClock();
  let releaseSettings!: () => void;
  const settingsGate = new Promise<void>((resolve) => { releaseSettings = resolve; });
  const client = makeClient({
    requestFrame: async (body: any) => {
      client.calls.push(body);
      if (body.kind === 'sync') {
        if (body.domain === 'sessionRegistry' && body.revision === 2) {
          return await new Promise(() => undefined);
        }
        if (body.domain === 'settings' && body.revision === 2) await settingsGate;
        return { kind: 'sync.ack', requestId: 'x', domain: body.domain, revision: body.revision };
      }
      if (body.kind === 'runtime.promote') {
        return { kind: 'runtime.ready', requestId: 'x', runtimeMetadata: { mode: 'phase4', startedAt: 1 } };
      }
      throw new Error(`unexpected frame ${body.kind}`);
    },
  });
  const { router, sessionPath, stopped, emitted } = makeRouter(client, {
    options: {
      scheduler: clock,
      syncAckTimeoutMs: 50,
      broadcastSyncAckTimeoutMs: 500,
      readModelSettings: async () => ({ defaultModel: 'm', defaultThinkingLevel: 'off' }),
    },
  });
  await router.promote(sessionPath);

  await router.syncSessionRegistry([{ path: sessionPath, pinned: true, isRunning: true }], 1);
  const settings = router.syncSettings();
  for (let turn = 0; turn < 4 && !client.calls.some((body: any) =>
    body.kind === 'sync' && body.domain === 'settings' && body.revision === 2); turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  clock.advance(51);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(router.getRoute(sessionPath).state, 'hot');
  assert.deepEqual(stopped, [], 'the auxiliary timeout and transient settings delay must not retire the review');
  assert.equal(emitted.some(([event, payload]) => event === 'operational-error'
    && payload.code === 'SESSION_WORKER_SYNC_FAILED'), false);

  releaseSettings();
  await settings;
  assert.equal(router.getRoute(sessionPath).state, 'hot');
  assert.deepEqual(stopped, []);
});

test('phase6 broadcasts skip supervisor-owned workers until their transport is ready', async () => {
  const readyClient = makeClient();
  const unavailableCalls: any[] = [];
  const unresponsiveCalls: any[] = [];
  const startingWorker = {
    workerId: 'starting-worker',
    workerGeneration: 2,
    sessionPath: '/sessions/starting.jsonl',
    client: {
      getSnapshot: () => ({ status: 'starting' as const, stdoutTail: '', stderrTail: '' }),
      requestFrame: async (body: any) => {
        unavailableCalls.push(body);
        throw new Error('Worker is unavailable');
      },
    },
  };
  const unresponsiveWorker = {
    workerId: 'unresponsive-worker',
    workerGeneration: 3,
    sessionPath: '/sessions/unresponsive.jsonl',
    client: {
      getSnapshot: () => ({ status: 'unresponsive' as const, stdoutTail: '', stderrTail: '' }),
      requestFrame: async (body: any) => {
        unresponsiveCalls.push(body);
        return { kind: 'sync.ack', requestId: 'x', domain: body.domain, revision: body.revision };
      },
    },
  };
  let liveWorker: any;
  const { router, sessionPath, stopped } = makeRouter(readyClient, {
    supervisor: {
      startWorker: async (root: string, prepare: any) => {
        await prepare({ workerId: 'ready-worker', workerGeneration: 1, sessionPath: root });
        liveWorker = { workerId: 'ready-worker', workerGeneration: 1, sessionPath: root, client: readyClient };
        return liveWorker;
      },
      listWorkers: () => [liveWorker, startingWorker, unresponsiveWorker].filter(Boolean),
    },
  });
  await router.promote(sessionPath);

  await router.syncSessionRegistry([{ path: sessionPath, pinned: true, isRunning: false }], 1);
  await router.syncRuntimePrefs({ compact: true });

  assert.equal(unavailableCalls.length, 0, 'startup ownership is not yet a usable broadcast route');
  assert.deepEqual(stopped, []);
  assert.ok(readyClient.calls.some((call: any) => call.kind === 'sync'
    && call.domain === 'sessionRegistry' && call.revision === 2));
  assert.ok(unresponsiveCalls.some((call: any) => call.kind === 'sync'
    && call.domain === 'sessionRegistry' && call.revision === 2));
  assert.ok(unresponsiveCalls.some((call: any) => call.kind === 'sync'
    && call.domain === 'runtimePrefs' && call.revision === 2),
  'critical broadcasts still reach a transiently unresponsive transport');
});

test('phase6 late old-generation sync failure cannot stop a replacement at the same path', async () => {
  const sessionPath = `${process.cwd()}/phase6-session.jsonl`;
  const replacementClient = makeClient();
  const replacementWorker = {
    workerId: 'replacement-worker',
    workerGeneration: 2,
    sessionPath,
    client: replacementClient,
  };
  const stopped: string[] = [];
  const { router, emitted } = makeRouter(replacementClient, {
    supervisor: {
      listWorkers: () => [replacementWorker],
      stopWorker: async (target: string) => { stopped.push(target); },
    },
  });
  const staleWorker = {
    workerId: 'retired-worker',
    workerGeneration: 1,
    sessionPath,
    client: makeClient(),
  };

  await (router as unknown as {
    quarantineSyncFailure(
      settlement: { worker: typeof staleWorker; domain: 'settings'; revision: number; completion: Promise<void> },
      error: unknown,
    ): Promise<void>;
  }).quarantineSyncFailure({
    worker: staleWorker,
    domain: 'settings',
    revision: 2,
    completion: Promise.resolve(),
  }, new Error('late old-generation settlement'));

  assert.deepEqual(stopped, [], 'path reuse must not let a stale failure stop the replacement generation');
  assert.equal(emitted.some(([event, payload]) => event === 'operational-error'
    && payload.code === 'SESSION_WORKER_SYNC_FAILED'), false);
});

test('phase6 concurrent sync failures terminalize a busy checkpoint and retire its worker once', async () => {
  const client = makeClient({
    requestFrame: async (body: any) => {
      if (body.kind === 'sync') {
        if ((body.domain === 'runtimePrefs' || body.domain === 'catalog') && body.revision === 2) {
          throw new Error('worker response lane exceeded reserved capacity');
        }
        return { kind: 'sync.ack', requestId: 'x', domain: body.domain, revision: body.revision };
      }
      if (body.kind === 'runtime.promote') {
        return { kind: 'runtime.ready', requestId: 'x', runtimeMetadata: { mode: 'phase4', startedAt: 1 } };
      }
      throw new Error(`unexpected frame ${body.kind}`);
    },
  });
  const { router, sessionPath, emitted, stopped } = makeRouter(client);
  const route = await router.promote(sessionPath);
  await router.handleWorkerFrame(sessionPath, eventFrame(
    route, sessionPath, 'busy.changed', { sessionPath, busy: true, seq: 1 }, 1,
  ));
  await router.handleWorkerFrame(sessionPath, eventFrame(
    route, sessionPath, 'message.started',
    { sessionPath, requestId: 'request-sync-failure', messageId: 'message-sync-failure' }, 2,
  ));
  await router.handleWorkerFrame(sessionPath, eventFrame(
    route, sessionPath, 'tool.started', {
      sessionPath,
      requestId: 'request-sync-failure',
      messageId: 'message-sync-failure',
      toolCallId: 'tool-sync-failure-1',
      name: 'bash',
    }, 3,
  ));
  await router.handleWorkerFrame(sessionPath, eventFrame(
    route, sessionPath, 'tool.started', {
      sessionPath,
      requestId: 'request-sync-failure',
      messageId: 'message-sync-failure',
      toolCallId: 'tool-sync-failure-2',
      name: 'read',
    }, 4,
  ));
  emitted.length = 0;

  await Promise.all([
    router.syncRuntimePrefs({ compact: true }),
    router.syncCatalog([{ id: 'catalog-update-during-worker-loss' }]),
  ]);

  const toolTerminals = emitted.filter(([event]) => event === 'tool.finished');
  assert.equal(toolTerminals.length, 2);
  assert.deepEqual(toolTerminals.map(([, payload]) => [payload.toolCallId, payload.status]), [
    ['tool-sync-failure-1', 'failed'],
    ['tool-sync-failure-2', 'failed'],
  ]);
  assert.ok(toolTerminals.every(([, payload]) => payload.result?.error
    === 'The session worker exited before live work settled.'));
  assert.deepEqual(
    emitted.filter(([event]) => event === 'message.aborted').map(([, payload]) => payload),
    [{
      requestId: 'request-sync-failure',
      sessionPath,
      messageId: 'message-sync-failure',
      reason: 'The session worker exited before live work settled.',
    }],
  );
  assert.equal(emitted.filter(([event]) => event === 'preflight.failed').length, 0);
  assert.deepEqual(
    emitted.filter(([event, payload]) => event === 'busy.changed' && payload.busy === false)
      .map(([, payload]) => payload.sessionPath),
    [sessionPath],
  );
  assert.equal(emitted.filter(([event, payload]) => event === 'operational-error'
    && payload.code === 'SESSION_WORKER_SYNC_FAILED').length, 1);
  assert.equal(emitted.filter(([event, payload]) => event === 'operational-error'
    && payload.code === 'SESSION_WORKER_EXITED').length, 0);
  assert.deepEqual(stopped, [sessionPath], 'duplicate quarantines must join the first retirement');
  assert.equal(router.getRoute(sessionPath).state, 'cold');

  const emissionCount = emitted.length;
  await router.handleWorkerStateChange(
    sessionPath,
    { status: 'exited', stdoutTail: '', stderrTail: '' },
    { workerId: route.owner.workerId, workerGeneration: route.owner.workerGeneration },
  );
  assert.equal(emitted.length, emissionCount, 'the eventual exited callback must not terminalize or notify twice');
});

test('phase6 intentional retirement does not terminalize a live checkpoint', async () => {
  const { router, sessionPath, emitted } = makeRouter(makeClient());
  const route = await router.promote(sessionPath);
  await router.handleWorkerFrame(sessionPath, eventFrame(
    route, sessionPath, 'busy.changed', { sessionPath, busy: true, seq: 1 }, 1,
  ));
  await router.handleWorkerFrame(sessionPath, eventFrame(
    route, sessionPath, 'message.started',
    { sessionPath, requestId: 'request-intentional-retire', messageId: 'message-intentional-retire' }, 2,
  ));
  await router.handleWorkerFrame(sessionPath, eventFrame(
    route, sessionPath, 'tool.started', {
      sessionPath,
      requestId: 'request-intentional-retire',
      messageId: 'message-intentional-retire',
      toolCallId: 'tool-intentional-retire',
      name: 'bash',
    }, 3,
  ));
  emitted.length = 0;

  await router.retire(sessionPath, 'intentional test retirement');

  assert.equal(router.getRoute(sessionPath).state, 'cold');
  assert.deepEqual(emitted, [], 'intentional retirement must not synthesize interruption events');
});

test('phase6 sync failure terminalizes an early-acknowledged send as preflight failed', async () => {
  const client = makeClient({
    requestFrame: async (body: any) => {
      if (body.kind === 'sync') {
        if (body.domain === 'runtimePrefs' && body.revision === 2) throw new Error('worker sync failed');
        return { kind: 'sync.ack', requestId: 'x', domain: body.domain, revision: body.revision };
      }
      if (body.kind === 'runtime.promote') {
        return { kind: 'runtime.ready', requestId: 'x', runtimeMetadata: { mode: 'phase4', startedAt: 1 } };
      }
      if (body.kind === 'runtime.command' && body.operation === 'message.send') {
        return {
          kind: 'response',
          requestId: 'x',
          ok: true,
          result: { kind: 'runtime.command', payload: { requestId: 'request-preflight-sync-failure' } },
        };
      }
      throw new Error(`unexpected frame ${body.kind}`);
    },
  });
  const { router, sessionPath, emitted } = makeRouter(client);
  const route = await router.promote(sessionPath);
  await router.route({
    id: 'public-preflight-sync-failure',
    method: 'message.send',
    params: { sessionPath, text: 'hello', inputs: [] },
  });
  await router.handleWorkerFrame(sessionPath, eventFrame(
    route, sessionPath, 'busy.changed', { sessionPath, busy: true, seq: 1 }, 1,
  ));
  emitted.length = 0;

  await router.syncRuntimePrefs({ compact: true });

  assert.deepEqual(
    emitted.filter(([event]) => event === 'preflight.failed').map(([, payload]) => payload),
    [{
      requestId: 'request-preflight-sync-failure',
      sessionPath,
      error: 'The session worker exited before live work settled.',
    }],
  );
  assert.equal(emitted.filter(([event]) => event === 'message.aborted').length, 0);
  assert.equal(emitted.filter(([event, payload]) => event === 'busy.changed' && payload.busy === false).length, 1);
  assert.equal(router.getRoute(sessionPath).state, 'cold');
});

test('phase6 sync: a timed-out live ACK preserves active work, retries, and does not block another promotion', async () => {
  const clock = new FakeRouterClock();
  const sessionA = `${process.cwd()}/phase6-stalled-a.jsonl`;
  const sessionB = `${process.cwd()}/phase6-healthy-b.jsonl`;
  const workers = new Map<string, any>();
  const calls = new Map<string, any[]>();
  const stopped: string[] = [];
  const emitted: Array<[string, any]> = [];
  let generation = 0;
  let stalledRuntimePrefsAttempts = 0;

  const supervisor = {
    startWorker: async (root: string, prepare: any) => {
      generation += 1;
      const workerId = `isolation-worker-${generation}`;
      const assignment = await prepare({ workerId, workerGeneration: generation, sessionPath: root });
      const workerCalls: any[] = [];
      calls.set(root, workerCalls);
      const client = {
        requestFrame: (body: any) => {
          workerCalls.push(body);
          if (body.kind === 'sync') {
            if (root === sessionA && body.domain === 'runtimePrefs' && body.revision === 2) {
              stalledRuntimePrefsAttempts += 1;
              if (stalledRuntimePrefsAttempts === 1) return new Promise(() => undefined);
            }
            return Promise.resolve({ kind: 'sync.ack', domain: body.domain, revision: body.revision });
          }
          if (body.kind === 'runtime.promote') {
            return Promise.resolve({ kind: 'runtime.ready', runtimeMetadata: { mode: 'phase4', startedAt: 1 } });
          }
          throw new Error(`unexpected frame ${body.kind}`);
        },
        getSnapshot: () => ({ status: 'ready' as const, stdoutTail: '', stderrTail: '' }),
        sendFrame: () => true,
      };
      const worker = {
        workerId,
        workerGeneration: generation,
        sessionPath: assignment.leasePath,
        client,
      };
      workers.set(root, worker);
      return worker;
    },
    stopWorker: async (root: string) => {
      stopped.push(root);
      workers.delete(root);
    },
    listWorkers: () => [...workers.values()],
  };
  const router = new WorkerRuntimeRouter({
    supervisor: supervisor as any,
    coldStore: {
      serializePromotionGrant: (target: string) => ({
        grantId: `grant-${target}`,
        coordinatorGeneration: 1,
        sessionPath: target,
        sessionPathKey: target,
        fingerprint: 'f',
        creationReason: 'resume',
      }),
      consumePromotionGrant: (grant: any) => grant,
      abortPromotionGrant: () => undefined,
    } as any,
    ownership: {
      registerHot: async (target: string, owner: any) => ({
        ...owner,
        canonicalSessionPath: target,
        ownershipRevision: owner.workerGeneration,
        nonce: `lease-${owner.workerGeneration}`,
      }),
      reconcileCrash: async () => undefined,
    } as any,
    emit: (event, payload) => emitted.push([event, payload]),
    scheduler: clock,
    syncAckTimeoutMs: 50,
    buildPromotionSnapshot: async (target) => ({
      sdkPath: '/sdk',
      agentDir: '/agent',
      startupCwd: '/',
      sessionDir: '/sessions',
      openedPayload: opened(target) as any,
      modelSettings: { defaultModel: 'm', defaultThinkingLevel: 'off' },
    }),
  });

  const routeA = await router.promote(sessionA);
  await router.handleWorkerFrame(sessionA, eventFrame(
    routeA, sessionA, 'busy.changed', { sessionPath: sessionA, busy: true, seq: 1 }, 1,
  ));
  await router.handleWorkerFrame(sessionA, eventFrame(
    routeA, sessionA, 'message.started',
    { sessionPath: sessionA, requestId: 'healthy-request', messageId: 'healthy-message' }, 2,
  ));
  emitted.length = 0;
  const stalledBroadcast = router.syncRuntimePrefs({ compact: true });
  for (let turn = 0; turn < 4 && !calls.get(sessionA)?.some((body) =>
    body.kind === 'sync' && body.domain === 'runtimePrefs' && body.revision === 2); turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(calls.get(sessionA)?.some((body) =>
    body.kind === 'sync' && body.domain === 'runtimePrefs' && body.revision === 2));

  let secondPromotionSettled = false;
  const secondPromotion = router.promote(sessionB).then((route) => {
    secondPromotionSettled = true;
    return route;
  });
  for (let turn = 0; turn < 6 && !secondPromotionSettled; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(secondPromotionSettled, true, 'session B startup must not join session A\'s missing ACK');
  const healthyRoute = await secondPromotion;
  assert.equal(healthyRoute.state, 'hot');
  assert.ok(calls.get(sessionB)?.some((body) =>
    body.kind === 'sync' && body.domain === 'runtimePrefs' && body.revision === 2),
  'the replacement startup observes the latest monotonic revision');

  clock.advance(51);
  await stalledBroadcast;
  assert.deepEqual(stopped, [], 'a missed live-sync ACK must not retire the active worker');
  assert.equal(router.getRoute(sessionA).state, 'hot');
  assert.equal(router.getRoute(sessionB).state, 'hot');
  assert.equal(emitted.some(([event]) =>
    event === 'tool.finished' || event === 'message.aborted' || event === 'preflight.failed'), false);
  assert.equal(emitted.some(([event, payload]) => event === 'operational-error'
    && payload.code === 'SESSION_WORKER_SYNC_FAILED'), false);

  clock.advance(1_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stalledRuntimePrefsAttempts, 2, 'the exact retained preference revision is retried');
  assert.equal(router.getRoute(sessionA).state, 'hot');

  // The failed completion is rejection-neutral in both the global revision
  // lock and worker-local tails; unrelated authoritative updates keep flowing.
  await router.syncCatalog([{ id: 'after-timeout' }]);
  assert.ok(calls.get(sessionB)?.some((body) =>
    body.kind === 'sync' && body.domain === 'catalog' && body.revision === 2));
});

test('phase6 concurrent settings mutations serialize revisions so no worker skips a newer value', async () => {
  let current = { defaultModel: 'm', defaultThinkingLevel: 'off' };
  const { router, sessionPath } = makeRouter(makeClient(), {
    options: {
      writeModelSettings: async (updates: any) => { current = { ...current, ...updates }; return current; },
      readModelSettings: async () => current,
    },
  });
  const route = await router.promote(sessionPath);
  const calls: any[] = [];
  const original = (route.worker.client as any).requestFrame.bind(route.worker.client);
  (route.worker.client as any).requestFrame = async (body: any) => {
    calls.push(body);
    return await original(body);
  };
  const originalSend = route.worker.client.sendFrame!.bind(route.worker.client);
  (route.worker.client as any).sendFrame = (body: any) => {
    calls.push(body);
    return originalSend(body);
  };
  await Promise.all([
    router.handleWorkerFrame(sessionPath, {
      ipcVersion: 1, coordinatorGeneration: 1, workerId: route.owner.workerId,
      workerGeneration: route.owner.workerGeneration, workerPid: 1, rootSessionPath: sessionPath,
      leasePath: sessionPath, leaseRevision: 1, sessionPath, seq: 1,
      kind: 'settings.mutate', requestId: 'mutate-1', updates: { defaultModel: 'one' },
    }),
    router.handleWorkerFrame(sessionPath, {
      ipcVersion: 1, coordinatorGeneration: 1, workerId: route.owner.workerId,
      workerGeneration: route.owner.workerGeneration, workerPid: 1, rootSessionPath: sessionPath,
      leasePath: sessionPath, leaseRevision: 1, sessionPath, seq: 2,
      kind: 'settings.mutate', requestId: 'mutate-2', updates: { defaultModel: 'two' },
    }),
  ]);
  const syncs = calls.filter((call) => call.kind === 'sync' && call.domain === 'settings');
  assert.equal(syncs.length, 2);
  assert.deepEqual([...new Set(syncs.map((call) => call.revision))].sort(), [2, 3]);
  const authoritatives = calls.filter((call) => call.kind === 'settings.authoritative');
  assert.equal(authoritatives.length, 2);
  assert.deepEqual([...new Set(authoritatives.map((call) => call.revision))].sort(), [2, 3]);
});
