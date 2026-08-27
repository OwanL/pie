import assert from 'node:assert/strict';
import test from 'node:test';

import { CoordinatorProviderNetworkLeaseAuthority } from '../../../src/backend/coordinator-provider-network-lease';
import { SessionTransitionInProgressError, WorkerRuntimeRouter } from '../../../src/backend/worker-runtime-router';

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('hot transition fences the old worker before interrupt awaits and same truncate joins', async () => {
  const sessionPath = `${process.cwd()}/transition-race.jsonl`;
  const interrupt = deferred<{ soft: boolean }>();
  let starts = 0;
  let runtimeCommands = 0;
  const workers = new Map<string, any>();
  const supervisor = {
    startWorker: async (root: string, prepare: any) => {
      starts += 1;
      const workerId = `worker-${starts}`;
      const assignment = await prepare({ workerId, workerGeneration: starts, sessionPath: root });
      const client = {
        getSnapshot: () => ({ status: 'ready' as const, stdoutTail: '', stderrTail: '' }),
        requestFrame: async (body: any) => {
          if (body.kind === 'sync') return { kind: 'sync.ack', domain: body.domain, revision: body.revision };
          if (body.kind === 'runtime.promote') return { kind: 'runtime.ready', runtimeMetadata: { mode: 'phase4', startedAt: 1 } };
          runtimeCommands += 1;
          return { kind: 'response', ok: true, result: { kind: 'runtime.command', payload: {} } };
        },
        sendFrame: () => true,
      };
      const worker = { workerId, workerGeneration: starts, sessionPath: assignment.leasePath, client };
      workers.set(root, worker);
      return worker;
    },
    interrupt: async () => await interrupt.promise,
    stopWorker: async (root: string) => { workers.delete(root); },
    listWorkers: () => [...workers.values()],
  };
  const router = new WorkerRuntimeRouter({
    supervisor: supervisor as any,
    coldStore: {
      serializePromotionGrant: (target: string) => ({ grantId: `grant-${starts}`, coordinatorGeneration: 1, sessionPath: target, sessionPathKey: target, fingerprint: 'f', creationReason: 'resume' }),
      consumePromotionGrant: (grant: any) => grant,
      abortPromotionGrant: () => undefined,
    } as any,
    ownership: {
      registerHot: async (target: string, owner: any) => ({ ...owner, canonicalSessionPath: target, ownershipRevision: starts, nonce: `lease-${starts}` }),
      reconcileCrash: async () => undefined,
    } as any,
    emit: () => undefined,
    buildPromotionSnapshot: async () => ({
      sdkPath: '/sdk', agentDir: '/agent', startupCwd: '/', sessionDir: '/sessions',
      openedPayload: opened(sessionPath) as any,
      modelSettings: { defaultModel: 'm', defaultThinkingLevel: 'off' },
    }),
  });
  const original = await router.promote(sessionPath);
  const transition = router.runHotTransition(sessionPath, 'hot-truncate:entry-1', async (control) => {
    await control.interrupt('truncate');
    await control.retire('truncate');
    const replacement = await control.promote(sessionPath);
    return replacement.owner.workerId;
  });
  assert.equal(router.getRoute(sessionPath).state, 'transitioning', 'transition publishes before interrupt settles');
  await assert.rejects(
    router.routeExisting({ id: 'concurrent', method: 'message.send', params: { sessionPath, text: 'old worker' } }),
    (error) => error instanceof SessionTransitionInProgressError && error.code === 'SESSION_TRANSITION_IN_PROGRESS',
  );
  assert.equal(runtimeCommands, 0, 'concurrent command never reaches old worker');
  const joined = router.runHotTransition(sessionPath, 'hot-truncate:entry-1', async () => 'must-not-run');
  await assert.rejects(
    router.runHotTransition(sessionPath, 'hot-truncate:entry-2', async () => 'wrong'),
    (error) => error instanceof SessionTransitionInProgressError,
  );
  interrupt.resolve({ soft: true });
  assert.equal(await transition, 'worker-2');
  assert.equal(await joined, 'worker-2');
  const current = router.getRoute(sessionPath);
  assert.equal(current.state, 'hot');
  if (current.state === 'hot') assert.notEqual(current.owner.workerId, original.owner.workerId);
});

test('hot transition restores the same route when interrupt fails before retirement', async () => {
  const sessionPath = `${process.cwd()}/transition-restore.jsonl`;
  const client = {
    getSnapshot: () => ({ status: 'ready' as const, stdoutTail: '', stderrTail: '' }),
    requestFrame: async (body: any) => body.kind === 'sync'
      ? { kind: 'sync.ack', domain: body.domain, revision: body.revision }
      : body.kind === 'runtime.promote'
        ? { kind: 'runtime.ready', runtimeMetadata: { mode: 'phase4', startedAt: 1 } }
        : { kind: 'response', ok: true, result: { kind: 'runtime.command', payload: { restored: true } } },
  };
  const router = new WorkerRuntimeRouter({
    supervisor: {
      startWorker: async (root: string, prepare: any) => {
        const assignment = await prepare({ workerId: 'worker-restore', workerGeneration: 1, sessionPath: root });
        return { workerId: 'worker-restore', workerGeneration: 1, sessionPath: assignment.leasePath, client };
      },
      interrupt: async () => { throw new Error('interrupt transport failed'); },
    } as any,
    coldStore: {
      serializePromotionGrant: (target: string) => ({ grantId: 'grant', coordinatorGeneration: 1, sessionPath: target, sessionPathKey: target, fingerprint: 'f', creationReason: 'resume' }),
      consumePromotionGrant: (grant: any) => grant,
      abortPromotionGrant: () => undefined,
    } as any,
    ownership: { registerHot: async (target: string, owner: any) => ({ ...owner, canonicalSessionPath: target, ownershipRevision: 1, nonce: 'lease' }) } as any,
    emit: () => undefined,
    buildPromotionSnapshot: async () => ({
      sdkPath: '/sdk', agentDir: '/agent', startupCwd: '/', sessionDir: '/sessions',
      openedPayload: opened(sessionPath) as any,
      modelSettings: { defaultModel: 'm', defaultThinkingLevel: 'off' },
    }),
  });
  const original = await router.promote(sessionPath);
  await assert.rejects(
    router.runHotTransition(sessionPath, 'hot-truncate:entry', async (control) => {
      await control.interrupt('truncate');
      throw new Error('unreachable');
    }),
    /interrupt transport failed/,
  );
  assert.equal(router.getRoute(sessionPath), original);
  assert.deepEqual(await router.routeExisting({ id: 'after', method: 'models.list', params: { sessionPath } }), { restored: true });
});

test('replacement worker provider acquire is correlated beneath a transitioning root', async () => {
  const sessionPath = `${process.cwd()}/transition-provider-acquire.jsonl`;
  const replacementPromote = deferred<void>();
  const sentByWorker = new Map<string, any[]>();
  const workers = new Map<string, any>();
  let starts = 0;
  let replacementPromoteStarted = false;

  const supervisor = {
    startWorker: async (root: string, prepare: any) => {
      starts += 1;
      const workerId = `transition-provider-worker-${starts}`;
      const assignment = await prepare({ workerId, workerGeneration: starts, sessionPath: root });
      const sent: any[] = [];
      sentByWorker.set(workerId, sent);
      const client = {
        getSnapshot: () => ({ status: 'ready' as const, stdoutTail: '', stderrTail: '' }),
        requestFrame: async (body: any) => {
          if (body.kind === 'sync') {
            return { kind: 'sync.ack', domain: body.domain, revision: body.revision };
          }
          if (body.kind === 'runtime.promote') {
            if (starts === 2) {
              replacementPromoteStarted = true;
              await replacementPromote.promise;
            }
            return { kind: 'runtime.ready', runtimeMetadata: { mode: 'phase4', startedAt: 1 } };
          }
          throw new Error(`unexpected frame ${body.kind}`);
        },
        sendFrame: (frame: any) => { sent.push(frame); return true; },
      };
      const worker = {
        workerId,
        workerGeneration: starts,
        sessionPath: assignment.leasePath,
        client,
      };
      workers.set(root, worker);
      return worker;
    },
    interrupt: async () => ({ soft: true }),
    stopWorker: async (root: string) => { workers.delete(root); },
    listWorkers: () => [...workers.values()],
  };
  const providerLeases = new CoordinatorProviderNetworkLeaseAuthority();
  const router = new WorkerRuntimeRouter({
    supervisor: supervisor as any,
    coldStore: {
      serializePromotionGrant: (target: string) => ({
        grantId: `grant-${starts}`,
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
    providerLeases,
    emit: () => undefined,
    buildPromotionSnapshot: async () => ({
      sdkPath: '/sdk',
      agentDir: '/agent',
      startupCwd: '/',
      sessionDir: '/sessions',
      openedPayload: opened(sessionPath) as any,
      modelSettings: { defaultModel: 'm', defaultThinkingLevel: 'off' },
    }),
  });

  await router.promote(sessionPath);
  const transition = router.runHotTransition(sessionPath, 'provider-replacement', async (control) => {
    await control.interrupt('replace');
    await control.retire('replace');
    return (await control.promote(sessionPath)).owner.workerId;
  });
  for (let turn = 0; turn < 6 && !replacementPromoteStarted; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(replacementPromoteStarted, true);
  assert.equal(router.getRoute(sessionPath).state, 'transitioning');

  await router.handleWorkerFrame(sessionPath, {
    ipcVersion: 1,
    coordinatorGeneration: 1,
    workerId: 'transition-provider-worker-2',
    workerGeneration: 2,
    workerPid: 2,
    rootSessionPath: sessionPath,
    leasePath: sessionPath,
    leaseRevision: 2,
    sessionPath,
    seq: 1,
    kind: 'provider.acquire',
    requestId: 'replacement-provider-request',
    request: { provider: 'p', model: 'm', turnId: 'turn', attemptId: 'attempt' },
  });
  const replacementFrames = sentByWorker.get('transition-provider-worker-2') ?? [];
  assert.deepEqual(
    replacementFrames.filter((frame) => frame.kind === 'provider.granted').map((frame) => frame.requestId),
    ['replacement-provider-request'],
    'the sole replacement owner must receive its correlated provider grant before runtime.ready',
  );

  replacementPromote.resolve();
  assert.equal(await transition, 'transition-provider-worker-2');
  assert.equal(router.getRoute(sessionPath).state, 'hot');
});
