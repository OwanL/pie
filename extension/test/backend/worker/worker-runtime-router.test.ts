import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkerRuntimeRouter } from '../../../src/backend/worker-runtime-router';

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
  };
}

test('worker router promotion is single-flight and runtime.ready precedes the initiating command', async () => {
  const sessionPath = `${process.cwd()}/router-a.jsonl`;
  const order: string[] = [];
  let starts = 0;
  const client = {
    start: async () => ({ mode: 'phase2' as const, startedAt: 1 }),
    ping: async () => ({ kind: 'pong' as const }),
    interrupt: async () => ({ kind: 'interrupted' as const }),
    shutdown: async () => ({ kind: 'shutting-down' as const }),
    forceKill: async () => undefined,
    waitForConfirmedExit: async () => ({ code: 0, signal: null }),
    getSnapshot: () => ({ status: 'ready' as const, stdoutTail: '', stderrTail: '' }),
    requestFrame: async (body: any) => {
      order.push(body.kind);
      if (body.kind === 'sync') return { kind: 'sync.ack', requestId: 'x', domain: body.domain, revision: body.revision };
      if (body.kind === 'runtime.promote') return { kind: 'runtime.ready', requestId: 'x', runtimeMetadata: { mode: 'phase4', startedAt: 1 } };
      return { kind: 'response', requestId: 'x', ok: true, result: { kind: 'runtime.command', payload: { requestId: 'run' } } };
    },
    sendFrame: () => true,
    updateLeaseIdentity: () => undefined,
  };
  const supervisor = {
    startWorker: async (root: string, prepare: any) => {
      starts += 1;
      await prepare({ workerId: 'worker-a', workerGeneration: 1, sessionPath: root });
      return { workerId: 'worker-a', workerGeneration: 1, sessionPath: root, client };
    },
    interrupt: async () => ({ soft: true }),
    stopWorker: async () => undefined,
  };
  const coldStore = {
    serializePromotionGrant: (target: string) => ({ grantId: 'grant', coordinatorGeneration: 1, sessionPath: target, sessionPathKey: target, fingerprint: 'f', creationReason: 'resume' }),
    consumePromotionGrant: (grant: any) => grant,
  };
  const ownership = {
    registerHot: async (target: string, owner: any) => ({ ...owner, canonicalSessionPath: target, ownershipRevision: 1, nonce: 'lease' }),
    reconcileCrash: async () => undefined,
  };
  const router = new WorkerRuntimeRouter({
    supervisor: supervisor as any,
    coldStore: coldStore as any,
    ownership: ownership as any,
    emit: () => undefined,
    buildPromotionSnapshot: async () => ({
      sdkPath: '/sdk', agentDir: '/agent', startupCwd: '/', sessionDir: '/sessions',
      openedPayload: opened(sessionPath) as any,
      modelSettings: { defaultModel: 'm', defaultThinkingLevel: 'off' },
    }),
  });
  const request = { id: 'public', method: 'message.send', params: { sessionPath, text: 'x', inputs: [] } };
  const [left, right] = await Promise.all([router.route(request), router.route(request)]);
  assert.equal(starts, 1);
  assert.deepEqual(left, { requestId: 'run' });
  assert.deepEqual(right, { requestId: 'run' });
  assert.equal(order.filter((kind) => kind === 'runtime.promote').length, 1);
  const promoteIndex = order.indexOf('runtime.promote');
  assert.ok(promoteIndex >= 5);
  assert.ok(order.slice(promoteIndex + 1).every((kind) => kind === 'runtime.command'));
});

test('failed promotion preserves the exact durable path and new-session reason for retry', async () => {
  const exactPath = `${process.cwd()}/exact-session.jsonl`;
  const aliasPath = `${process.cwd()}/./exact-session.jsonl`;
  let attempts = 0;
  let commits = 0;
  let aborts = 0;
  const promotedPayloads: any[] = [];
  const client = {
    start: async () => ({ mode: 'phase2' as const, startedAt: 1 }),
    ping: async () => ({ kind: 'pong' as const }),
    interrupt: async () => ({ kind: 'interrupted' as const }),
    shutdown: async () => ({ kind: 'shutting-down' as const }),
    forceKill: async () => undefined,
    waitForConfirmedExit: async () => ({ code: 0, signal: null }),
    getSnapshot: () => ({ status: 'ready' as const, stdoutTail: '', stderrTail: '' }),
    requestFrame: async (body: any) => {
      if (body.kind === 'sync') return { kind: 'sync.ack', domain: body.domain, revision: body.revision };
      if (body.kind === 'runtime.promote') {
        promotedPayloads.push(body.payload);
        attempts += 1;
        if (attempts === 1) throw new Error('fixture bootstrap failed');
        return { kind: 'runtime.ready', runtimeMetadata: { mode: 'phase4', startedAt: 1 } };
      }
      throw new Error('unexpected frame');
    },
  };
  const workers = new Map<string, any>();
  const supervisor = {
    startWorker: async (root: string, prepare: any) => {
      await prepare({ workerId: `worker-${attempts + 1}`, workerGeneration: attempts + 1, sessionPath: root });
      const worker = { workerId: `worker-${attempts + 1}`, workerGeneration: attempts + 1, sessionPath: root, client };
      workers.set(root, worker);
      return worker;
    },
    stopWorker: async (root: string) => { workers.delete(root); },
    listWorkers: () => [...workers.values()],
  };
  const coldStore = {
    serializePromotionGrant: (target: string, creationReason: string) => ({
      grantId: `grant-${attempts}`, coordinatorGeneration: 1, sessionPath: target,
      sessionPathKey: target, fingerprint: 'f', creationReason,
    }),
    consumePromotionGrant: (grant: any) => grant,
    abortPromotionGrant: () => { aborts += 1; },
  };
  const router = new WorkerRuntimeRouter({
    supervisor: supervisor as any,
    coldStore: coldStore as any,
    ownership: {
      registerHot: async (target: string, owner: any) => ({ ...owner, canonicalSessionPath: target, ownershipRevision: attempts + 1, nonce: 'lease' }),
      reconcileCrash: async () => undefined,
    } as any,
    emit: () => undefined,
    buildPromotionSnapshot: async () => ({
      sdkPath: '/sdk', agentDir: '/agent', startupCwd: '/', sessionDir: '/sessions',
      exactSessionPath: exactPath,
      creationReason: 'new',
      openedPayload: opened(exactPath) as any,
      modelSettings: { defaultModel: 'm', defaultThinkingLevel: 'off' },
      commitPromotion: () => { commits += 1; },
      abortPromotion: () => undefined,
    }),
  });
  await assert.rejects(router.promote(aliasPath), /fixture bootstrap failed/);
  const route = await router.promote(aliasPath);
  assert.equal(route.currentLeasePath, exactPath);
  assert.equal(aborts, 1);
  assert.equal(commits, 1);
  assert.deepEqual(promotedPayloads.map((payload) => [payload.sessionPath, payload.creationReason]), [
    [exactPath, 'new'],
    [exactPath, 'new'],
  ]);
});

test('replacement commit rekeys destination ownership and leaves source independently promotable', async () => {
  const source = `${process.cwd()}/replace-source.jsonl`;
  const destination = `${process.cwd()}/replace-destination.jsonl`;
  const workers = new Map<string, any>();
  let starts = 0;
  let replaced: [string, string] | undefined;
  const supervisor = {
    startWorker: async (root: string, prepare: any) => {
      starts += 1;
      const workerId = `worker-${starts}`;
      const workerGeneration = starts;
      const assignment = await prepare({ workerId, workerGeneration, sessionPath: root });
      const client = {
        getSnapshot: () => ({ status: 'ready' as const, stdoutTail: '', stderrTail: '' }),
        requestFrame: async (body: any) => body.kind === 'sync'
          ? { kind: 'sync.ack', domain: body.domain, revision: body.revision }
          : { kind: 'runtime.ready', runtimeMetadata: { mode: 'phase4', startedAt: 1 } },
        sendFrame: () => true,
        updateLeaseIdentity: () => undefined,
      };
      const worker = { workerId, workerGeneration, sessionPath: assignment.leasePath, client };
      workers.set(root, worker);
      return worker;
    },
    rekeyWorker: (from: string, to: string) => {
      const worker = workers.get(from);
      assert.ok(worker);
      workers.delete(from);
      worker.sessionPath = to;
      workers.set(to, worker);
    },
    listWorkers: () => [...workers.values()],
  };
  const router = new WorkerRuntimeRouter({
    supervisor: supervisor as any,
    coldStore: {
      serializePromotionGrant: (target: string, creationReason: string) => ({ grantId: `grant-${starts}`, coordinatorGeneration: 1, sessionPath: target, sessionPathKey: target, fingerprint: 'f', creationReason }),
      consumePromotionGrant: (grant: any) => grant,
      abortPromotionGrant: () => undefined,
    } as any,
    ownership: {
      registerHot: async (target: string, owner: any) => ({ ...owner, canonicalSessionPath: target, ownershipRevision: 1, nonce: `lease-${owner.workerId}` }),
      commit: async (_owner: any, reservation: any) => ({
        authorizationId: 'authorization', reservationId: reservation.reservationId,
        canonicalDestinationPath: destination, ownershipRevision: 2, nonce: 'authorization-nonce',
        destinationLease: {
          coordinatorGeneration: 1, workerId: 'worker-1', workerGeneration: 1,
          canonicalSessionPath: destination, ownershipRevision: 2, nonce: 'destination-lease',
        },
      }),
      consumeTransfer: async (_owner: any, authorization: any) => authorization.destinationLease,
      createAdapter: () => ({ runtimeReady: async () => undefined }),
    } as any,
    emit: () => undefined,
    onSessionReplaced: (from, to) => { replaced = [from, to]; },
    buildPromotionSnapshot: async (sessionPath) => ({
      sdkPath: '/sdk', agentDir: '/agent', startupCwd: '/', sessionDir: '/sessions',
      exactSessionPath: sessionPath, openedPayload: opened(sessionPath) as any,
      modelSettings: { defaultModel: 'm', defaultThinkingLevel: 'off' },
    }),
  });
  const first = await router.promote(source);
  await router.handleWorkerFrame(source, {
    ipcVersion: 1, coordinatorGeneration: 1, workerId: first.owner.workerId,
    workerGeneration: first.owner.workerGeneration, workerPid: 1, rootSessionPath: source,
    leasePath: source, leaseRevision: 1, sessionPath: source, seq: 1,
    kind: 'ownership.commit', requestId: 'commit',
    reservation: {
      reservationId: 'reservation', operationId: 'replace', canonicalSourcePath: source,
      canonicalDestinationPath: destination, ownershipRevision: 2, nonce: 'reservation-nonce',
      destinationFingerprint: { exists: false, size: 0, sha256: null },
    },
    sourceLease: { ...first.owner, canonicalSessionPath: source, ownershipRevision: 1, nonce: 'lease-worker-1' },
  });
  assert.equal(router.getRoute(source).state, 'cold');
  assert.equal(router.getRoute(destination).state, 'hot');
  assert.deepEqual(replaced, [source, destination]);
  const second = await router.promote(source);
  assert.notEqual(second.owner.workerId, first.owner.workerId);
  const destinationLease = {
    coordinatorGeneration: 1, workerId: first.owner.workerId,
    workerGeneration: first.owner.workerGeneration, canonicalSessionPath: destination,
    ownershipRevision: 2, nonce: 'destination-lease',
  };
  await router.handleWorkerFrame(source, {
    ipcVersion: 1, coordinatorGeneration: 1, workerId: first.owner.workerId,
    workerGeneration: first.owner.workerGeneration, workerPid: 1, rootSessionPath: source,
    leasePath: destination, leaseRevision: 2, sessionPath: source, seq: 2,
    kind: 'ownership.consume', requestId: 'destination-consume',
    authorization: {
      authorizationId: 'authorization', reservationId: 'reservation',
      canonicalDestinationPath: destination, ownershipRevision: 2,
      nonce: 'authorization-nonce', destinationLease,
    },
    canonicalDestinationPath: destination,
  });
  await router.handleWorkerFrame(source, {
    ipcVersion: 1, coordinatorGeneration: 1, workerId: first.owner.workerId,
    workerGeneration: first.owner.workerGeneration, workerPid: 1, rootSessionPath: source,
    leasePath: destination, leaseRevision: 2, sessionPath: source, seq: 3,
    kind: 'ownership.runtimeReady', requestId: 'destination-ready',
    lease: destinationLease,
    canonicalPath: destination,
  });
  assert.equal(router.getRoute(destination).state, 'hot');
  assert.equal(router.getRoute(source).state, 'hot');
});

test('confirmed worker crash reconciles only checkpointed live identities and clears busy without replay', async () => {
  const sessionPath = `${process.cwd()}/crash-session.jsonl`;
  const emitted: Array<[string, any]> = [];
  const client = {
    getSnapshot: () => ({ status: 'exited' as const, stdoutTail: '', stderrTail: '' }),
    requestFrame: async (body: any) => body.kind === 'sync'
      ? { kind: 'sync.ack', domain: body.domain, revision: body.revision }
      : { kind: 'runtime.ready', runtimeMetadata: { mode: 'phase4', startedAt: 1 } },
    sendFrame: () => true,
  };
  const router = new WorkerRuntimeRouter({
    supervisor: {
      startWorker: async (root: string, prepare: any) => {
        await prepare({ workerId: 'crash-worker', workerGeneration: 1, sessionPath: root });
        return { workerId: 'crash-worker', workerGeneration: 1, sessionPath: root, client };
      },
      stopWorker: async () => undefined,
    } as any,
    coldStore: {
      serializePromotionGrant: (target: string) => ({ grantId: 'grant', coordinatorGeneration: 1, sessionPath: target, sessionPathKey: target, fingerprint: 'f', creationReason: 'resume' }),
      consumePromotionGrant: (grant: any) => grant,
      abortPromotionGrant: () => undefined,
    } as any,
    ownership: { registerHot: async (target: string, owner: any) => ({ ...owner, canonicalSessionPath: target, ownershipRevision: 1, nonce: 'lease' }), reconcileCrash: async () => undefined } as any,
    emit: (event, payload) => emitted.push([event, payload]),
    buildPromotionSnapshot: async () => ({
      sdkPath: '/sdk', agentDir: '/agent', startupCwd: '/', sessionDir: '/sessions',
      openedPayload: opened(sessionPath) as any,
      modelSettings: { defaultModel: 'm', defaultThinkingLevel: 'off' },
    }),
  });
  const route = await router.promote(sessionPath);
  const frame = (event: any, payload: any, seq: number): any => ({
    ipcVersion: 1, coordinatorGeneration: 1, workerId: route.owner.workerId,
    workerGeneration: route.owner.workerGeneration, workerPid: 1, rootSessionPath: sessionPath,
    leasePath: sessionPath, leaseRevision: 1, sessionPath, seq, kind: 'runtime.event', event, payload,
  });
  await router.handleWorkerFrame(sessionPath, frame('busy.changed', { sessionPath, busy: true, seq: 7 }, 1));
  await router.handleWorkerFrame(sessionPath, frame('message.started', { sessionPath, requestId: 'request-1', messageId: 'message-1' }, 2));
  await router.handleWorkerFrame(sessionPath, frame('tool.started', { sessionPath, requestId: 'request-1', messageId: 'message-1', toolCallId: 'tool-1', name: 'bash', input: {}, startedAt: 1 }, 3));
  emitted.length = 0;
  await router.handleWorkerStateChange(sessionPath, client.getSnapshot(), { workerId: route.owner.workerId, workerGeneration: 1 });
  assert.deepEqual(emitted.map(([event]) => event), ['tool.finished', 'message.aborted', 'busy.changed', 'operational-error']);
  assert.equal(emitted.find(([event]) => event === 'message.aborted')?.[1].messageId, 'message-1');
  assert.equal(emitted.find(([event]) => event === 'busy.changed')?.[1].seq, 2);
  assert.equal(router.getRoute(sessionPath).state, 'cold');
});

test('busy sequence remains monotonic when a durable session is re-promoted to a new worker', async () => {
  const sessionPath = `${process.cwd()}/busy-repromotion.jsonl`;
  const emitted: Array<[string, any]> = [];
  let starts = 0;
  const workers = new Map<string, any>();
  const router = new WorkerRuntimeRouter({
    supervisor: {
      startWorker: async (root: string, prepare: any) => {
        starts += 1;
        const workerId = `busy-worker-${starts}`;
        await prepare({ workerId, workerGeneration: starts, sessionPath: root });
        const client = {
          getSnapshot: () => ({ status: 'ready' as const, stdoutTail: '', stderrTail: '' }),
          requestFrame: async (body: any) => body.kind === 'sync'
            ? { kind: 'sync.ack', domain: body.domain, revision: body.revision }
            : { kind: 'runtime.ready', runtimeMetadata: { mode: 'phase4', startedAt: 1 } },
          sendFrame: () => true,
        };
        const worker = { workerId, workerGeneration: starts, sessionPath: root, client };
        workers.set(root, worker);
        return worker;
      },
      stopWorker: async (root: string) => { workers.delete(root); },
    } as any,
    coldStore: {
      serializePromotionGrant: (target: string) => ({ grantId: `grant-${starts}`, coordinatorGeneration: 1, sessionPath: target, sessionPathKey: target, fingerprint: 'f', creationReason: 'resume' }),
      consumePromotionGrant: (grant: any) => grant,
      abortPromotionGrant: () => undefined,
    } as any,
    ownership: {
      registerHot: async (target: string, owner: any) => ({ ...owner, canonicalSessionPath: target, ownershipRevision: starts, nonce: `lease-${starts}` }),
      reconcileCrash: async () => undefined,
    } as any,
    emit: (event, payload) => emitted.push([event, payload]),
    buildPromotionSnapshot: async () => ({
      sdkPath: '/sdk', agentDir: '/agent', startupCwd: '/', sessionDir: '/sessions',
      openedPayload: opened(sessionPath) as any,
      modelSettings: { defaultModel: 'm', defaultThinkingLevel: 'off' },
    }),
  });

  const emitBusy = async (route: Awaited<ReturnType<typeof router.promote>>, busy: boolean) => {
    await router.handleWorkerFrame(sessionPath, {
      ipcVersion: 1, coordinatorGeneration: 1, workerId: route.owner.workerId,
      workerGeneration: route.owner.workerGeneration, workerPid: 1, rootSessionPath: sessionPath,
      leasePath: sessionPath, leaseRevision: route.currentLeaseRevision, sessionPath, seq: 1,
      kind: 'runtime.event', event: 'busy.changed', payload: { sessionPath, busy, seq: 1 },
    });
  };

  const first = await router.promote(sessionPath);
  await emitBusy(first, true);
  await router.retire(sessionPath, 'test cold boundary');
  const second = await router.promote(sessionPath);
  await emitBusy(second, false);

  assert.deepEqual(
    emitted.filter(([event]) => event === 'busy.changed').map(([, payload]) => payload.seq),
    [1, 2],
  );
});

test('worker router drops stale and cross-session events', async () => {
  // The protocol parser is the first fence; this focused assertion pins the
  // router's second exact owner/path/generation fence independently.
  const emitted: unknown[] = [];
  const router = new WorkerRuntimeRouter({
    supervisor: {} as any,
    coldStore: {} as any,
    ownership: {} as any,
    emit: (_event, payload) => emitted.push(payload),
    buildPromotionSnapshot: async () => { throw new Error('unused'); },
  });
  await router.handleWorkerFrame('/root', {
    ipcVersion: 1, coordinatorGeneration: 1, workerId: 'stale', workerGeneration: 1, workerPid: 1,
    rootSessionPath: '/root', leasePath: '/other', leaseRevision: 1, sessionPath: '/root', seq: 1,
    kind: 'runtime.event', event: 'busy.changed', payload: { sessionPath: '/other', busy: true },
  });
  assert.deepEqual(emitted, []);
});
