import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { WorkerRuntimeRouter } from '../../../src/backend/worker-runtime-router';
import type { CoordinatorToHostDetailMessage, LiveSubagentDetailAddress } from '../../../src/shared/protocol/subagent-detail';

function opened(sessionPath: string) {
  return {
    session: { path: sessionPath, name: 'A', cwd: '.', modifiedAt: new Date(0).toISOString(), messageCount: 0 },
    transcript: [], transcriptWindow: { totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false },
    busy: false, runtimeReady: false, systemPrompts: [], analyticsFactors: {},
    modelSettings: { defaultModel: 'm', defaultThinkingLevel: 'off' },
  };
}

test('router fences detail generation/path/address/subscription ownership and forwards imperative streams only', async () => {
  const sessionPath = `${process.cwd()}/detail-router.jsonl`;
  const forwarded: CoordinatorToHostDetailMessage[] = [];
  const sent: any[] = [];
  let worker: any;
  const address: LiveSubagentDetailAddress = {
    sessionPath, turnId: 'turn-1', rootToolCallId: 'tool-1', rootAttemptId: 'root-attempt',
    lineage: [{ childId: 'child-1', spawningToolCallId: 'tool-1', attemptId: 'attempt-1' }],
  };
  const client = {
    getSnapshot: () => ({ status: 'ready' as const, stdoutTail: '', stderrTail: '' }),
    requestFrame: async (body: any) => {
      if (body.kind === 'sync') return { kind: 'sync.ack', domain: body.domain, revision: body.revision };
      if (body.kind === 'runtime.promote') return { kind: 'runtime.ready', runtimeMetadata: { mode: 'phase4', startedAt: 1 } };
      if (body.kind === 'detail.subscribe') return {
        kind: 'detail.start', subscriptionId: body.subscriptionId, address, source: 'live', baselineRevision: 1, pageCount: 1, totalBytes: 4, totalCodePoints: 4,
      };
      if (body.kind === 'detail.unsubscribe') return { kind: 'detail.unsubscribed', subscriptionId: body.subscriptionId };
      throw new Error(`unexpected ${body.kind}`);
    },
    sendFrame: (body: any) => { sent.push(body); return true; },
  };
  const supervisor = {
    startWorker: async (root: string, prepare: any) => {
      await prepare({ workerId: 'worker-detail', workerGeneration: 1, sessionPath: root });
      worker = { workerId: 'worker-detail', workerGeneration: 1, sessionPath: root, client };
      return worker;
    },
    listWorkers: () => worker ? [worker] : [],
  };
  const router = new WorkerRuntimeRouter({
    supervisor: supervisor as any,
    coldStore: {
      serializePromotionGrant: (target: string) => ({ grantId: 'grant', coordinatorGeneration: 1, sessionPath: target, sessionPathKey: target, fingerprint: 'f', creationReason: 'resume' }),
      consumePromotionGrant: (grant: any) => grant,
      abortPromotionGrant: () => undefined,
    } as any,
    ownership: {
      registerHot: async (target: string, owner: any) => ({ ...owner, canonicalSessionPath: target, ownershipRevision: 1, nonce: 'lease' }),
    } as any,
    emit: () => undefined,
    emitDetail: (message) => forwarded.push(message),
    buildPromotionSnapshot: async () => ({ sdkPath: '/sdk', agentDir: '/agent', startupCwd: '/', sessionDir: '/sessions', openedPayload: opened(sessionPath) as any, modelSettings: { defaultModel: 'm', defaultThinkingLevel: 'off' } }),
  });
  const hot = await router.promote(sessionPath);
  await router.subscribeDetail({ kind: 'detail.subscribe', requestId: 'public-subscribe', subscriptionId: 'subscription-1', address, maxPageBytes: 4096 });
  assert.equal(forwarded[0]?.kind, 'detail.start');
  assert.deepEqual(forwarded[0]?.fence, { backendGeneration: 1, coordinatorGeneration: 1, workerId: 'worker-detail', workerGeneration: 1 });

  const payload = { kind: 'json-segment' as const, encoding: 'utf8-json' as const, segmentId: 'segment', semanticPath: [], startByte: 0, endByte: 4, totalBytes: 4, startCodePoint: 0, endCodePoint: 4, totalCodePoints: 4, text: 'null' };
  const checksum = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const frameBase = {
    ipcVersion: 1 as const, coordinatorGeneration: 1, workerId: hot.owner.workerId, workerGeneration: hot.owner.workerGeneration,
    workerPid: 1, rootSessionPath: sessionPath, leasePath: sessionPath, leaseRevision: 1, sessionPath, seq: 1,
  };
  await router.handleWorkerFrame(sessionPath, { ...frameBase, kind: 'detail.page', subscriptionId: 'subscription-1', ref: { baselineRevision: 1, pageIndex: 0, pageCount: 1 }, payload, payloadBytes: Buffer.byteLength(JSON.stringify(payload)), checksum });
  await router.handleWorkerFrame(sessionPath, { ...frameBase, seq: 2, kind: 'detail.delta', subscriptionId: 'subscription-1', baseRevision: 1, revision: 2, operations: [{ op: 'set', path: ['exitCode'], value: 0 }] });
  assert.deepEqual(forwarded.slice(1).map((message) => message.kind), ['detail.page', 'detail.delta']);

  await assert.rejects(router.subscribeDetail({ kind: 'detail.subscribe', requestId: 'cross', subscriptionId: 'subscription-cross', address: { ...address, sessionPath: `${sessionPath}.other` }, maxPageBytes: 4096 }), /No hot worker|not owned/);
  await router.handleWorkerFrame(sessionPath, { ...frameBase, seq: 3, workerGeneration: 0, kind: 'detail.delta', subscriptionId: 'subscription-1', baseRevision: 2, revision: 3, operations: [] });
  assert.equal(forwarded.length, 3, 'stale worker generation is dropped');

  router.fetchDetail({ kind: 'detail.fetch', requestId: 'fetch-1', subscriptionId: 'subscription-1', address, ref: { baselineRevision: 1, pageIndex: 0, pageCount: 1 }, maxPageBytes: 4096 });
  assert.equal(sent.at(-1)?.kind, 'detail.fetch');
  await router.unsubscribeDetail({ kind: 'detail.unsubscribe', requestId: 'unsubscribe-1', subscriptionId: 'subscription-1', reason: 'collapse' });
  await router.handleWorkerFrame(sessionPath, { ...frameBase, seq: 4, kind: 'detail.delta', subscriptionId: 'subscription-1', baseRevision: 2, revision: 3, operations: [] });
  assert.equal(forwarded.length, 3, 'post-unsubscribe traffic cannot recreate ownership');
});
