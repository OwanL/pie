import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WorkerLiveDetailStore,
  reassembleDetailPages,
  type DetailBaselinePage,
} from '../../../src/backend/worker-live-detail-store';
import type { LiveSubagentDetailAddress } from '../../../src/shared/protocol/subagent-detail';
import type { WorkerToCoordinatorFrameBody } from '../../../src/backend/worker-protocol';

const root = {
  sessionPath: 'C:/sessions/root.jsonl',
  turnId: 'turn-1',
  rootToolCallId: 'tool-root',
  rootAttemptId: 'root-attempt',
};
const parent = { childId: 'child-parent', spawningToolCallId: 'tool-root', attemptId: 'attempt-parent' };
const target = { childId: 'child-target', spawningToolCallId: 'tool-nested', attemptId: 'attempt-target' };
const address: LiveSubagentDetailAddress = { ...root, lineage: [parent, target] };

type DetailFrame = Extract<WorkerToCoordinatorFrameBody, { kind: `detail.${string}` }>;

function child(identity: typeof parent, lineage: readonly (typeof parent)[], text: string, generation = 1) {
  return {
    ...identity,
    lineage: lineage.map((entry) => ({ ...entry })),
    liveAddressable: true,
    agent: 'worker', task: 'task', exitCode: -1, progressGeneration: generation,
    messages: [{ role: 'assistant', content: [{ type: 'text', text }] }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  };
}

function details(text: string, generation = 1, reorder = false) {
  const sibling = child({ childId: 'sibling', spawningToolCallId: 'tool-root', attemptId: 'sibling-attempt' }, [
    { childId: 'sibling', spawningToolCallId: 'tool-root', attemptId: 'sibling-attempt' },
  ], 'sibling');
  const nested = child(target, [parent, target], text, generation);
  const top = child(parent, [parent], 'parent', generation);
  (top.messages[0]!.content as unknown[]).push({
    type: 'toolCall', id: 'tool-nested', name: 'subagent',
    result: { details: { mode: 'single', results: [nested] } },
  });
  return { details: { mode: 'parallel', results: reorder ? [sibling, top] : [top, sibling] } };
}

test('no subscriber produces zero heavy detail traffic and does not traverse recursive getters', () => {
  const frames: DetailFrame[] = [];
  const store = new WorkerLiveDetailStore({ emit: (frame) => { frames.push(frame as DetailFrame); return true; } });
  const recursive = {} as Record<string, unknown>;
  Object.defineProperty(recursive, 'details', { enumerable: true, get: () => { throw new Error('traversed'); } });
  store.observe({ ...root, details: recursive });
  assert.equal(frames.length, 0);
  assert.deepEqual(store.debugState(), { sources: 1, subscriptions: 0, canonicalBytes: 0 });
});

test('baseline pages reassemble huge non-ASCII strings exactly under a tiny injected page budget', () => {
  const frames: DetailFrame[] = [];
  const store = new WorkerLiveDetailStore({
    emit: (frame) => { frames.push(frame as DetailFrame); return true; },
    budgets: { maxPageBytes: 768, maxCanonicalBytes: 1024 },
  });
  const text = '🙂é漢字'.repeat(800);
  store.observe({ ...root, details: details(text) });
  store.subscribe('request-1', 'subscription-1', address, undefined, 768);
  const start = frames.find((frame) => frame.kind === 'detail.start');
  const pages = frames.filter((frame): frame is Extract<DetailFrame, { kind: 'detail.page' }> => frame.kind === 'detail.page')
    .map((frame) => ({ ref: frame.ref, payload: frame.payload, payloadBytes: frame.payloadBytes, checksum: frame.checksum } as DetailBaselinePage));
  assert.ok(start && start.kind === 'detail.start');
  assert.ok(pages.length > 10);
  assert.equal(start.pageCount, pages.length);
  assert.ok(Buffer.byteLength(JSON.stringify(start), 'utf8') < 2_048, 'baseline manifest is bounded independently of total detail bytes');
  const rebuilt = reassembleDetailPages(pages) as any;
  assert.equal(rebuilt.messages[0].content[0].text, text);
  assert.equal(store.debugState().canonicalBytes, 0, 'oversized canonical value is not retained in the bounded delta window');
});

test('stable lineage survives source reorder and changed revisions emit one ordered structural delta', () => {
  const frames: DetailFrame[] = [];
  const store = new WorkerLiveDetailStore({ emit: (frame) => { frames.push(frame as DetailFrame); return true; } });
  store.observe({ ...root, details: details('before', 1) });
  store.subscribe('request-1', 'subscription-1', address, undefined, 4096);
  frames.length = 0;
  store.observe({ ...root, details: details('after', 2, true) });
  const deltas = frames.filter((frame): frame is Extract<DetailFrame, { kind: 'detail.delta' }> => frame.kind === 'detail.delta');
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0]!.baseRevision, 1);
  assert.equal(deltas[0]!.revision, 2);
  assert.ok(deltas[0]!.operations.length > 0);
});

test('gap fetch, canonical eviction, and detail queue backpressure produce explicit rebases', () => {
  const frames: DetailFrame[] = [];
  const store = new WorkerLiveDetailStore({
    emit: (frame) => {
      frames.push(frame as DetailFrame);
      return true;
    },
    budgets: { maxCanonicalBytes: 4096, maxDeltaBytes: 4096, maxPageBytes: 1024 },
  });
  store.observe({ ...root, details: details('before') });
  store.subscribe('request-1', 'subscription-1', address, undefined, 1024);
  const start = frames.find((frame): frame is Extract<DetailFrame, { kind: 'detail.start' }> => frame.kind === 'detail.start')!;
  frames.length = 0;
  store.fetch('fetch-gap', 'subscription-1', address, { baselineRevision: start.baselineRevision + 1, pageIndex: 0, pageCount: start.pageCount }, 1024);
  assert.equal(frames.at(-1)?.kind, 'detail.rebase');

  const backpressureFrames: DetailFrame[] = [];
  const backpressure = new WorkerLiveDetailStore({ emit: (frame) => {
    backpressureFrames.push(frame as DetailFrame);
    return frame.kind !== 'detail.delta';
  } });
  backpressure.observe({ ...root, details: details('before', 1) });
  backpressure.subscribe('request-2', 'subscription-2', address, undefined, 4096);
  backpressureFrames.length = 0;
  backpressure.observe({ ...root, details: details('after', 2) });
  assert.deepEqual(backpressureFrames.map((frame) => frame.kind), ['detail.delta', 'detail.rebase']);
});

test('tiny canonical budget evicts an older subscribed revision with an explicit rebase', () => {
  const frames: DetailFrame[] = [];
  const store = new WorkerLiveDetailStore({
    emit: (frame) => { frames.push(frame as DetailFrame); return true; },
    budgets: { maxCanonicalBytes: 900, maxPageBytes: 1024 },
  });
  const root2 = { ...root, rootToolCallId: 'tool-root-2' };
  const parent2 = { ...parent, childId: 'child-parent-2', spawningToolCallId: 'tool-root-2' };
  const address2: LiveSubagentDetailAddress = { ...root2, lineage: [parent2] };
  store.observe({ ...root, details: details('first') });
  store.subscribe('request-1', 'subscription-1', address, undefined, 1024);
  store.observe({ ...root2, details: { details: { results: [child(parent2, [parent2], 'second')] } } });
  store.subscribe('request-2', 'subscription-2', address2, undefined, 1024);
  assert.ok(frames.some((frame) => frame.kind === 'detail.rebase'
    && frame.subscriptionId === 'subscription-1' && frame.reason === 'evicted'));
  assert.ok(store.debugState().canonicalBytes <= 900);
});

test('terminal emits only after durable ref exists and a restarted store has no live authority', () => {
  const frames: DetailFrame[] = [];
  const store = new WorkerLiveDetailStore({ emit: (frame) => { frames.push(frame as DetailFrame); return true; } });
  store.observe({ ...root, details: details('terminal') });
  store.subscribe('request-1', 'subscription-1', address, undefined, 4096);
  frames.length = 0;
  store.terminal(root, 'durable-entry-1');
  const terminal = frames[0];
  assert.ok(terminal && terminal.kind === 'detail.terminal');
  if (terminal.kind === 'detail.terminal') {
    assert.equal(terminal.durableRef.source, 'durable');
    assert.equal(terminal.durableRef.messageId, 'durable-entry-1');
  }
  assert.equal(store.debugState().subscriptions, 0);

  const restartedFrames: DetailFrame[] = [];
  const restarted = new WorkerLiveDetailStore({ emit: (frame) => { restartedFrames.push(frame as DetailFrame); return true; } });
  restarted.subscribe('restart', 'subscription-restart', address, undefined, 4096);
  assert.equal(restartedFrames[0]?.kind, 'detail.error');
  assert.equal((restartedFrames[0] as any).code, 'NOT_FOUND');
});
