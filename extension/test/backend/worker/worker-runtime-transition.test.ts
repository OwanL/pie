import assert from 'node:assert/strict';
import test from 'node:test';

import { CoordinatorProviderNetworkLeaseAuthority } from '../../../src/backend/coordinator-provider-network-lease';
import { WORKER_IPC_VERSION } from '../../../src/backend/worker-protocol';
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

  const stop = router.interrupt(sessionPath, 'public stop fence');
  assert.equal(router.getRoute(sessionPath).state, 'transitioning');
  await assert.rejects(
    router.routeExisting({ id: 'send-during-stop', method: 'message.send', params: { sessionPath, text: 'must wait' } }),
    (error) => error instanceof SessionTransitionInProgressError,
  );
  assert.deepEqual(await stop, { soft: true });
  assert.equal(router.getRoute(sessionPath).state, 'hot');
});

test('cancelled replacement promotion restores cold routing for a later send', async () => {
  const sessionPath = `${process.cwd()}/transition-cancelled-promotion.jsonl`;
  const replacementPromotionStarted = deferred<void>();
  let releaseReplacementPromotion!: () => void;
  const replacementPromotion = new Promise<void>((resolve) => {
    releaseReplacementPromotion = resolve;
  });
  let starts = 0;
  const workers = new Map<string, any>();
  const supervisor = {
    startWorker: async (root: string, prepare: any) => {
      starts += 1;
      const workerId = `cancelled-promotion-worker-${starts}`;
      const workerGeneration = starts;
      const assignment = await prepare({ workerId, workerGeneration, sessionPath: root });
      const client = {
        getSnapshot: () => ({ status: 'ready' as const, stdoutTail: '', stderrTail: '' }),
        requestFrame: async (body: any) => {
          if (body.kind === 'sync') {
            return { kind: 'sync.ack', domain: body.domain, revision: body.revision };
          }
          if (body.kind === 'runtime.promote') {
            if (workerGeneration === 2) {
              replacementPromotionStarted.resolve(undefined);
              await replacementPromotion;
            }
            return { kind: 'runtime.ready', runtimeMetadata: { mode: 'phase4', startedAt: workerGeneration } };
          }
          return {
            kind: 'response',
            ok: true,
            result: { kind: 'runtime.command', payload: { requestId: `fresh-request-${workerGeneration}` } },
          };
        },
        sendFrame: () => true,
      };
      const worker = {
        workerId,
        workerGeneration,
        sessionPath: assignment.leasePath,
        client,
      };
      workers.set(root, worker);
      return worker;
    },
    stopWorker: async (root: string) => { workers.delete(root); },
    listWorkers: () => [...workers.values()],
  };
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
    emit: () => undefined,
    buildPromotionSnapshot: async () => ({
      sdkPath: '/sdk', agentDir: '/agent', startupCwd: '/', sessionDir: '/sessions',
      openedPayload: opened(sessionPath) as any,
      modelSettings: { defaultModel: 'm', defaultThinkingLevel: 'off' },
    }),
  });

  await router.promote(sessionPath);
  const transition = router.runHotTransition(sessionPath, 'cancelled-replacement', async (control) => {
    await control.retire('replace source');
    await control.promote(sessionPath);
    return 'unexpected';
  });
  await replacementPromotionStarted.promise;
  assert.equal(router.getRoute(sessionPath).state, 'transitioning');
  assert.equal(router.cancelPendingRuntimeOperations(sessionPath), true);
  releaseReplacementPromotion();

  await assert.rejects(
    transition,
    (error: any) => error?.code === 'SESSION_OPERATION_CANCELLED',
  );
  assert.equal(router.getRoute(sessionPath).state, 'cold');
  assert.equal(router.hasHotOwner(sessionPath), false);

  const response = await router.route({
    id: 'fresh-message',
    method: 'message.send',
    params: { sessionPath, text: 'retry', inputs: [] },
  });
  assert.deepEqual(response, { requestId: 'fresh-request-3' });
  assert.equal(starts, 3, 'the later send must promote a fresh worker');
  assert.equal(router.getRoute(sessionPath).state, 'hot');
});

test('force recovery does not publish a stopped promoted route', async () => {
  const sessionPath = `${process.cwd()}/transition-force-recovery.jsonl`;
  const replacementFinished = deferred<void>();
  const operationGate = deferred<void>();
  let starts = 0;
  const workers = new Map<string, any>();
  const supervisor = {
    startWorker: async (root: string, prepare: any) => {
      starts += 1;
      const workerId = `force-recovery-worker-${starts}`;
      const workerGeneration = starts;
      const assignment = await prepare({ workerId, workerGeneration, sessionPath: root });
      const client = {
        getSnapshot: () => ({ status: 'ready' as const, stdoutTail: '', stderrTail: '' }),
        requestFrame: async (body: any) => {
          if (body.kind === 'sync') {
            return { kind: 'sync.ack', domain: body.domain, revision: body.revision };
          }
          if (body.kind === 'runtime.promote') {
            return { kind: 'runtime.ready', runtimeMetadata: { mode: 'phase4', startedAt: workerGeneration } };
          }
          return {
            kind: 'response',
            ok: true,
            result: { kind: 'runtime.command', payload: { requestId: `fresh-force-request-${workerGeneration}` } },
          };
        },
        sendFrame: () => true,
      };
      const worker = {
        workerId,
        workerGeneration,
        sessionPath: assignment.leasePath,
        client,
      };
      workers.set(root, worker);
      return worker;
    },
    stopWorker: async (root: string) => { workers.delete(root); },
    listWorkers: () => [...workers.values()],
  };
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
    emit: () => undefined,
    buildPromotionSnapshot: async () => ({
      sdkPath: '/sdk', agentDir: '/agent', startupCwd: '/', sessionDir: '/sessions',
      openedPayload: opened(sessionPath) as any,
      modelSettings: { defaultModel: 'm', defaultThinkingLevel: 'off' },
    }),
  });

  await router.promote(sessionPath);
  const transition = router.runHotTransition(sessionPath, 'force-recovery-replacement', async (control) => {
    await control.retire('replace source');
    await control.promote(sessionPath);
    replacementFinished.resolve(undefined);
    await operationGate.promise;
    control.assertActive();
    return 'unexpected';
  });
  await replacementFinished.promise;
  assert.equal(router.getRoute(sessionPath).state, 'transitioning');

  const recovery = router.forceRecoverTransition(sessionPath, 'forced transition recovery');
  operationGate.resolve();
  assert.equal(await recovery, true);
  await assert.rejects(
    transition,
    (error: any) => error?.code === 'SESSION_OPERATION_CANCELLED',
  );
  assert.equal(router.getRoute(sessionPath).state, 'cold');
  assert.equal(router.hasHotOwner(sessionPath), false);

  const response = await router.route({
    id: 'fresh-force-message',
    method: 'message.send',
    params: { sessionPath, text: 'retry after force recovery', inputs: [] },
  });
  assert.deepEqual(response, { requestId: 'fresh-force-request-3' });
  assert.equal(starts, 3, 'force recovery must leave the path retryable');
});

test('failed promoted-route cleanup keeps the transition fenced for stop and reconciliation rejection', async () => {
  for (const failurePhase of ['stop', 'reconcile'] as const) {
    const aliasPath = `${process.cwd()}/./transition-cleanup-${failurePhase}.jsonl`;
    const operationGate = deferred<void>();
    const replacementFinished = deferred<void>();
    let starts = 0;
    const workers = new Map<string, any>();
    const supervisor = {
      startWorker: async (root: string, prepare: any) => {
        starts += 1;
        const workerId = `cleanup-${failurePhase}-worker-${starts}`;
        const workerGeneration = starts;
        const assignment = await prepare({ workerId, workerGeneration, sessionPath: root });
        const client = {
          getSnapshot: () => ({ status: 'ready' as const, stdoutTail: '', stderrTail: '' }),
          requestFrame: async (body: any) => {
            if (body.kind === 'sync') {
              return { kind: 'sync.ack', domain: body.domain, revision: body.revision };
            }
            if (body.kind === 'runtime.promote') {
              return { kind: 'runtime.ready', runtimeMetadata: { mode: 'phase4', startedAt: workerGeneration } };
            }
            return {
              kind: 'response',
              ok: true,
              result: { kind: 'runtime.command', payload: { requestId: `cleanup-request-${workerGeneration}` } },
            };
          },
          sendFrame: () => true,
        };
        const worker = {
          workerId,
          workerGeneration,
          sessionPath: assignment.leasePath,
          client,
        };
        workers.set(worker.sessionPath, worker);
        return worker;
      },
      stopWorker: async (root: string) => {
        const worker = workers.get(root);
        if (failurePhase === 'stop' && worker?.workerGeneration === 2) {
          throw new Error('replacement stop could not confirm exit');
        }
        workers.delete(root);
      },
      listWorkers: () => [...workers.values()],
    };
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
        reconcileCrash: async ({ owner }: any) => {
          if (failurePhase === 'reconcile' && owner.workerGeneration === 2) {
            throw new Error('replacement ownership reconciliation failed');
          }
        },
      } as any,
      emit: () => undefined,
      buildPromotionSnapshot: async (target) => ({
        sdkPath: '/sdk', agentDir: '/agent', startupCwd: '/', sessionDir: '/sessions',
        openedPayload: opened(target) as any,
        modelSettings: { defaultModel: 'm', defaultThinkingLevel: 'off' },
      }),
    });

    await router.promote(aliasPath);
    const transition = router.runHotTransition(aliasPath, `cleanup-failure-${failurePhase}`, async (control) => {
      await control.retire('replace source');
      await control.promote(aliasPath);
      replacementFinished.resolve(undefined);
      await operationGate.promise;
      control.assertActive();
      return 'unexpected';
    });
    await replacementFinished.promise;

    const recovery = router.forceRecoverTransition(aliasPath, `recover ${failurePhase}`);
    operationGate.resolve();
    await assert.rejects(
      recovery,
      new RegExp(failurePhase === 'stop' ? 'could not confirm exit' : 'reconciliation failed'),
    );
    await assert.rejects(
      transition,
      (error: any) => error?.code === 'SESSION_OPERATION_CANCELLED',
    );

    assert.equal(router.getRoute(aliasPath).state, 'transitioning');
    assert.equal(router.hasHotOwner(aliasPath), false);
    assert.equal(starts, 2, 'an ambiguous promoted route must not admit a concurrent writer');
    await assert.rejects(
      router.promote(aliasPath),
      (error) => error instanceof SessionTransitionInProgressError,
    );
  }
});

test('failed source recovery never restores an ambiguous source as hot', async () => {
  const sessionPath = `${process.cwd()}/transition-source-recovery-failure.jsonl`;
  const operationGate = deferred<void>();
  let stopAttempts = 0;
  const client = {
    getSnapshot: () => ({ status: 'ready' as const, stdoutTail: '', stderrTail: '' }),
    requestFrame: async (body: any) => body.kind === 'sync'
      ? { kind: 'sync.ack', domain: body.domain, revision: body.revision }
      : body.kind === 'runtime.promote'
        ? { kind: 'runtime.ready', runtimeMetadata: { mode: 'phase4', startedAt: 1 } }
        : { kind: 'response', ok: true, result: { kind: 'runtime.command', payload: { requestId: 'unexpected' } } },
  };
  const router = new WorkerRuntimeRouter({
    supervisor: {
      startWorker: async (root: string, prepare: any) => {
        const assignment = await prepare({ workerId: 'source-recovery-worker', workerGeneration: 1, sessionPath: root });
        return { workerId: 'source-recovery-worker', workerGeneration: 1, sessionPath: assignment.leasePath, client };
      },
      stopWorker: async () => {
        stopAttempts += 1;
        throw new Error('source stop could not confirm exit');
      },
    } as any,
    coldStore: {
      serializePromotionGrant: (target: string) => ({
        grantId: 'source-recovery-grant', coordinatorGeneration: 1, sessionPath: target,
        sessionPathKey: target, fingerprint: 'f', creationReason: 'resume',
      }),
      consumePromotionGrant: (grant: any) => grant,
      abortPromotionGrant: () => undefined,
    } as any,
    ownership: {
      registerHot: async (target: string, owner: any) => ({
        ...owner, canonicalSessionPath: target, ownershipRevision: 1, nonce: 'source-recovery-lease',
      }),
      reconcileCrash: async () => undefined,
    } as any,
    emit: () => undefined,
    buildPromotionSnapshot: async () => ({
      sdkPath: '/sdk', agentDir: '/agent', startupCwd: '/', sessionDir: '/sessions',
      openedPayload: opened(sessionPath) as any,
      modelSettings: { defaultModel: 'm', defaultThinkingLevel: 'off' },
    }),
  });

  await router.promote(sessionPath);
  const transition = router.runHotTransition(sessionPath, 'source-recovery-failure', async (control) => {
    await operationGate.promise;
    control.assertActive();
    return 'unexpected';
  });
  const recovery = router.forceRecoverTransition(sessionPath, 'recover source stop failure');
  await assert.rejects(recovery, /source stop could not confirm exit/);
  operationGate.resolve();
  await assert.rejects(transition, (error: any) => error?.code === 'SESSION_OPERATION_CANCELLED');

  assert.equal(stopAttempts, 1);
  assert.equal(router.getRoute(sessionPath).state, 'transitioning');
  assert.equal(router.hasHotOwner(sessionPath), false, 'a failed source stop must remain fenced');
});

test('delayed confirmed exit retries failed promoted cleanup before settling cold', async () => {
  const aliasPath = `${process.cwd()}/./transition-delayed-promoted-exit.jsonl`;
  const operationGate = deferred<void>();
  const replacementReady = deferred<void>();
  const workers = new Map<string, any>();
  const reconciledGenerations: number[] = [];
  let starts = 0;
  let failReplacementStop = true;
  const supervisor = {
    startWorker: async (root: string, prepare: any) => {
      starts += 1;
      const workerId = `delayed-exit-worker-${starts}`;
      const workerGeneration = starts;
      const assignment = await prepare({ workerId, workerGeneration, sessionPath: root });
      const client = {
        getSnapshot: () => ({ status: 'ready' as const, stdoutTail: '', stderrTail: '' }),
        requestFrame: async (body: any) => {
          if (body.kind === 'sync') return { kind: 'sync.ack', domain: body.domain, revision: body.revision };
          if (body.kind === 'runtime.promote') {
            return { kind: 'runtime.ready', runtimeMetadata: { mode: 'phase4', startedAt: workerGeneration } };
          }
          return {
            kind: 'response', ok: true,
            result: { kind: 'runtime.command', payload: { requestId: `delayed-exit-request-${workerGeneration}` } },
          };
        },
        sendFrame: () => true,
      };
      const worker = { workerId, workerGeneration, sessionPath: assignment.leasePath, client };
      workers.set(worker.sessionPath, worker);
      return worker;
    },
    stopWorker: async (root: string) => {
      const worker = workers.get(root);
      if (worker?.workerGeneration === 2 && failReplacementStop) {
        failReplacementStop = false;
        throw new Error('replacement stop raced confirmed exit');
      }
      workers.delete(root);
    },
    listWorkers: () => [...workers.values()],
  };
  const router = new WorkerRuntimeRouter({
    supervisor: supervisor as any,
    coldStore: {
      serializePromotionGrant: (target: string) => ({
        grantId: `delayed-exit-grant-${starts}`, coordinatorGeneration: 1, sessionPath: target,
        sessionPathKey: target, fingerprint: 'f', creationReason: 'resume',
      }),
      consumePromotionGrant: (grant: any) => grant,
      abortPromotionGrant: () => undefined,
    } as any,
    ownership: {
      registerHot: async (target: string, owner: any) => ({
        ...owner, canonicalSessionPath: target, ownershipRevision: owner.workerGeneration,
        nonce: `delayed-exit-lease-${owner.workerGeneration}`,
      }),
      reconcileCrash: async ({ owner }: any) => { reconciledGenerations.push(owner.workerGeneration); },
    } as any,
    emit: () => undefined,
    buildPromotionSnapshot: async (target) => ({
      sdkPath: '/sdk', agentDir: '/agent', startupCwd: '/', sessionDir: '/sessions',
      openedPayload: opened(target) as any,
      modelSettings: { defaultModel: 'm', defaultThinkingLevel: 'off' },
    }),
  });

  await router.promote(aliasPath);
  let replacement: any;
  const transition = router.runHotTransition(aliasPath, 'delayed-promoted-exit', async (control) => {
    await control.retire('replace source');
    replacement = await control.promote(aliasPath);
    replacementReady.resolve();
    await operationGate.promise;
    control.assertActive();
    return 'unexpected';
  });
  await replacementReady.promise;

  const recovery = router.forceRecoverTransition(aliasPath, 'recover before replacement exit');
  await assert.rejects(recovery, /replacement stop raced confirmed exit/);
  operationGate.resolve();
  await assert.rejects(transition, (error: any) => error?.code === 'SESSION_OPERATION_CANCELLED');
  assert.equal(router.getRoute(aliasPath).state, 'transitioning');

  await router.handleWorkerStateChange(
    aliasPath,
    { status: 'exited', exitCode: 23, exitSignal: null, stdoutTail: '', stderrTail: '' },
    { workerId: replacement.owner.workerId, workerGeneration: replacement.owner.workerGeneration },
  );

  assert.equal(router.getRoute(aliasPath).state, 'cold');
  assert.equal(router.hasHotOwner(aliasPath), false);
  assert.deepEqual(reconciledGenerations, [1, 2], 'cold settlement requires the retried ownership reconcile');
  assert.equal(workers.size, 0, 'delayed exit must retry supervisor cleanup before cold settlement');
  await router.promote(aliasPath);
  assert.equal(starts, 3, 'the path is promotable only after delayed cleanup completes');
});

test('post-promotion transition failure preserves the live replacement through an alias', async () => {
  const aliasPath = `${process.cwd()}/./transition-post-promotion.jsonl`;
  let starts = 0;
  const workers = new Map<string, any>();
  const supervisor = {
    startWorker: async (root: string, prepare: any) => {
      starts += 1;
      const workerId = `post-promotion-worker-${starts}`;
      const workerGeneration = starts;
      const assignment = await prepare({ workerId, workerGeneration, sessionPath: root });
      const client = {
        getSnapshot: () => ({ status: 'ready' as const, stdoutTail: '', stderrTail: '' }),
        requestFrame: async (body: any) => {
          if (body.kind === 'sync') {
            return { kind: 'sync.ack', domain: body.domain, revision: body.revision };
          }
          if (body.kind === 'runtime.promote') {
            return { kind: 'runtime.ready', runtimeMetadata: { mode: 'phase4', startedAt: workerGeneration } };
          }
          return {
            kind: 'response',
            ok: true,
            result: { kind: 'runtime.command', payload: { requestId: `post-promotion-request-${workerGeneration}` } },
          };
        },
        sendFrame: () => true,
      };
      const worker = {
        workerId,
        workerGeneration,
        sessionPath: assignment.leasePath,
        client,
      };
      workers.set(worker.sessionPath, worker);
      return worker;
    },
    stopWorker: async (root: string) => { workers.delete(root); },
    listWorkers: () => [...workers.values()],
  };
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
    emit: () => undefined,
    buildPromotionSnapshot: async (target) => ({
      sdkPath: '/sdk', agentDir: '/agent', startupCwd: '/', sessionDir: '/sessions',
      openedPayload: opened(target) as any,
      modelSettings: { defaultModel: 'm', defaultThinkingLevel: 'off' },
    }),
  });

  await router.promote(aliasPath);
  await assert.rejects(
    router.runHotTransition(aliasPath, 'post-promotion-throw', async (control) => {
      await control.retire('replace source');
      await control.promote(aliasPath);
      throw new Error('compound command failed after promotion');
    }),
    /compound command failed after promotion/,
  );

  const current = router.getRoute(aliasPath);
  assert.equal(current.state, 'hot');
  if (current.state === 'hot') {
    assert.equal(current.owner.workerGeneration, 2);
  }
  assert.equal(router.hasHotOwner(aliasPath), true);
  assert.equal(workers.size, 1);
  assert.deepEqual(
    await router.route({
      id: 'post-promotion-send',
      method: 'message.send',
      params: { sessionPath: aliasPath, text: 'still live', inputs: [] },
    }),
    { requestId: 'post-promotion-request-2' },
  );
});

test('hot transition remains fenced when escalated interrupt cannot confirm worker exit', async () => {
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
  await router.promote(sessionPath);
  await assert.rejects(
    router.runHotTransition(sessionPath, 'hot-truncate:entry', async (control) => {
      await control.interrupt('truncate');
      throw new Error('unreachable');
    }),
    /interrupt transport failed/,
  );
  assert.equal(router.getRoute(sessionPath).state, 'transitioning');
  await assert.rejects(
    router.routeExisting({ id: 'after', method: 'models.list', params: { sessionPath } }),
    (error) => error instanceof SessionTransitionInProgressError,
  );
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
    ipcVersion: WORKER_IPC_VERSION,
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
