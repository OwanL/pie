import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionService } from '../../session-actions/service';
import { BackendClient } from '../../agent-connection/client';
import { createInitialArchState } from '../../conversation-state/arch-state';
import { applyLiveSemanticEnvelope } from '../../conversation-state/live-pipeline/transitions';
import type { DetailResult, LazyDetailRef } from '../../../lib/protocol/index.js';
import type { TurnSemanticEnvelope } from '../../../../harness/agent-processes/lib/rpc/live-pipeline';

const sessionPath = '/detail-pending.jsonl';
const durable: LazyDetailRef = {
  key: 'detail', kind: 'tool-result', source: 'durable', sessionPath,
  messageId: 'message', toolCallId: 'tool', sourceRevision: 1,
  sizeBytes: 1, summary: 'detail', available: true,
};
const loaded: DetailResult = { sessionPath, key: durable.key, status: 'loaded', value: 'value', sizeBytes: 5 };

function harness() {
  let state = createInitialArchState();
  const backend = new BackendClient();
  const service = new SessionService({
    storage: { get: () => undefined, update: async () => {} },
    extensionPath: '/test-extension', getRuntimeOutputDirectory: () => '/test-out',
    getWorkspaceCwd: () => '/test-workspace', getSetting: () => undefined,
    requestWindowAttention: () => {},
    backendStartup: {
      prepareDevelopmentEnvironment: () => { throw new Error('unexpected startup'); },
      resolveBackendLaunchPaths: async () => { throw new Error('unexpected startup'); },
      prepareBackendEnvironment: () => { throw new Error('unexpected startup'); },
    },
  }, backend, () => {}, () => {}, () => {}, () => state);
  const internals = service as unknown as {
    clearDetailCacheForSession(path: string): void;
    detailGeneration: number;
    detailRequests: Map<string, unknown>;
  };
  return { service, backend, internals, apply(event: TurnSemanticEnvelope) {
    state = { ...state, livePipeline: applyLiveSemanticEnvelope(state.livePipeline, event, 10_000).state };
  } };
}

for (const fence of ['epoch', 'generation'] as const) {
  test(`durable ${fence} replacement survives old completion and deduplicates current requests`, async () => {
    const h = harness();
    const completions: Array<(result: DetailResult) => void> = [];
    h.backend.request = (() => new Promise<DetailResult>((resolve) => completions.push(resolve))) as typeof h.backend.request;
    const a = h.service.loadDetail(sessionPath, durable);
    await Promise.resolve();
    if (fence === 'epoch') h.internals.clearDetailCacheForSession(sessionPath);
    else h.internals.detailGeneration += 1;
    const b = h.service.loadDetail(sessionPath, durable);
    await Promise.resolve();
    assert.equal(completions.length, 2);
    completions[0]!(loaded);
    assert.equal((await a).status, 'stale');
    const c = h.service.loadDetail(sessionPath, durable);
    await Promise.resolve();
    assert.equal(completions.length, 2, 'C joins B, not a third RPC');
    completions[1]!(loaded);
    assert.deepEqual(await b, loaded);
    assert.deepEqual(await c, loaded);
    assert.equal(h.internals.detailRequests.size, 0);
    assert.deepEqual(await h.service.loadDetail(sessionPath, durable), loaded);
    assert.equal(completions.length, 2, 'only the current result is cached');
  });
}

test('durable rejection and synchronous throw release ownership for retry', async () => {
  const h = harness();
  let calls = 0;
  h.backend.request = (() => {
    calls += 1;
    if (calls === 1) throw new Error('synchronous');
    if (calls === 2) return Promise.reject(new Error('asynchronous'));
    return Promise.resolve(loaded);
  }) as typeof h.backend.request;
  for (let i = 0; i < 2; i += 1) {
    assert.deepEqual(await h.service.loadDetail(sessionPath, durable), {
      sessionPath, key: durable.key, status: 'failure', message: 'Could not load details. Retry to try again.',
    });
    assert.equal(h.internals.detailRequests.size, 0);
  }
  assert.deepEqual(await h.service.loadDetail(sessionPath, durable), loaded);
  assert.equal(calls, 3);
});

test('old rejection cannot release a replacement owner', async () => {
  const h = harness();
  let rejectOld!: (error: Error) => void;
  let resolveNew!: (result: DetailResult) => void;
  let calls = 0;
  h.backend.request = (() => {
    calls += 1;
    return calls === 1
      ? new Promise<DetailResult>((_resolve, reject) => { rejectOld = reject; })
      : new Promise<DetailResult>((resolve) => { resolveNew = resolve; });
  }) as typeof h.backend.request;
  const a = h.service.loadDetail(sessionPath, durable);
  await Promise.resolve();
  h.internals.detailGeneration += 1;
  const b = h.service.loadDetail(sessionPath, durable);
  await Promise.resolve();
  rejectOld(new Error('old request'));
  assert.equal((await a).status, 'failure');
  const c = h.service.loadDetail(sessionPath, durable);
  await Promise.resolve();
  assert.equal(calls, 2);
  resolveNew(loaded);
  assert.deepEqual(await b, loaded);
  assert.deepEqual(await c, loaded);
});

test('model exchanges remain excluded from durable result caching', async () => {
  const h = harness();
  let calls = 0;
  h.backend.request = (async () => { calls += 1; return loaded; }) as typeof h.backend.request;
  const ref = { ...durable, kind: 'model-exchange' as const };
  await h.service.loadDetail(sessionPath, ref);
  await h.service.loadDetail(sessionPath, ref);
  assert.equal(calls, 2);
});

test('live same-ref retries read updated progress and recover from stale', async () => {
  const h = harness();
  h.backend.request = (() => { throw new Error('live detail must not call RPC'); }) as typeof h.backend.request;
  const base = { protocolVersion: 7, sessionPath, requestId: 'request', turnId: 'turn', attemptId: 'attempt', occurredAt: 100, checkpointBytes: 1024 } as const;
  const ref: LazyDetailRef = { ...durable, key: 'live:tool:1', source: 'live', executionId: 'execution' };
  assert.equal((await h.service.loadDetail(sessionPath, ref)).status, 'stale');
  h.apply({ ...base, kind: 'turn.started', seq: 1, canonicalMessageId: 'message', startedAt: 90 });
  h.apply({ ...base, kind: 'tool.started', seq: 2, executionId: 'execution', parentExecutionId: null, rootExecutionId: 'execution', toolCallId: 'tool', name: 'subagent', input: {}, startedAt: 95 });
  const preview = { kind: 'generic' as const, summary: 'first' };
  const previewBytes = Buffer.byteLength(JSON.stringify(preview));
  h.apply({ ...base, kind: 'tool.progress', seq: 3, baseSeq: 2, executionId: 'execution', baseProgressRevision: 0, progressRevision: 1, previewBytes, aggregatePreviewBytes: previewBytes, update: { kind: 'snapshot', preview } });
  const first = await h.service.loadDetail(sessionPath, ref);
  assert.equal(first.status, 'loaded');
  h.apply({ ...base, kind: 'tool.progress', seq: 4, baseSeq: 3, executionId: 'execution', baseProgressRevision: 1, progressRevision: 2, previewBytes: previewBytes + 1, aggregatePreviewBytes: previewBytes + 1, update: { kind: 'patch', operations: [{ op: 'appendString', path: ['summary'], value: '!' }] } });
  const next = await h.service.loadDetail(sessionPath, ref);
  assert.equal(next.status, 'loaded');
  assert.deepEqual(next.status === 'loaded' && next.value, { ...preview, summary: 'first!' });
  assert.equal(h.internals.detailRequests.size, 0);
});
