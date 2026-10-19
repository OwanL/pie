import { createSettledDetailStore } from './live-detail-settlement-helper';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { applyJsonPatch } from '../../../../lib/json-structural-patch';
import {
  WorkerLiveDetailStore,
  type DetailBaselinePage,
} from '../worker-live-detail-store';
import { reassembleDetailPages, segmentDetailPages } from '../../../session-storage/transcripts/detail-segmentation';
import type { LiveSubagentDetailAddress } from '../../lib/rpc/subagent-detail';
import { PassThrough } from 'node:stream';

import {
  type WorkerIpcFrame,
  type WorkerToCoordinatorFrameBody,
} from '../../lib/rpc/worker-protocol.js';
import type { WorkerIpcWriteTarget } from '../../lib/rpc/worker-frame-io.js';
import { WorkerServer } from '../../lib/rpc/worker-server.js';

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

function liveDetailSpools(): string[] {
  return readdirSync(tmpdir()).filter((entry) => entry.startsWith('pie-live-detail-'));
}

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
  const { store } = createSettledDetailStore({ emit: (frame) => { frames.push(frame as DetailFrame); return true; } });
  const recursive = {} as Record<string, unknown>;
  Object.defineProperty(recursive, 'details', { enumerable: true, get: () => { throw new Error('traversed'); } });
  store.observe({ ...root, details: recursive });
  assert.equal(frames.length, 0);
  assert.deepEqual(store.debugState(), { sources: 1, subscriptions: 0, canonicalBytes: 0 });
});

test('baseline pages reassemble huge non-ASCII strings exactly under a tiny injected page budget', async () => {
  const frames: DetailFrame[] = [];
  const { store, settle } = createSettledDetailStore({
    emit: (frame) => { frames.push(frame as DetailFrame); return true; },
    budgets: { maxPageBytes: 768, maxCanonicalBytes: 1024 },
  });
  const text = '🙂é漢字\\\"\n\t'.repeat(800);
  store.observe({ ...root, details: details(text) });
  store.subscribe('request-1', 'subscription-1', address, undefined, 768);
  await settle();
  const start = frames.find((frame) => frame.kind === 'detail.start');
  const pages = frames.filter((frame): frame is Extract<DetailFrame, { kind: 'detail.page' }> => frame.kind === 'detail.page')
    .map((frame) => ({ ref: frame.ref, payload: frame.payload, payloadBytes: frame.payloadBytes, checksum: frame.checksum } as DetailBaselinePage));
  assert.ok(start && start.kind === 'detail.start');
  assert.ok(pages.length > 10);
  assert.equal(start.pageCount, pages.length);
  assert.equal(start.totalBytes, pages[0]?.payload.totalBytes);
  assert.deepEqual(pages, segmentDetailPages(
    pages.map((page) => page.payload.text).join(''), pages[0]!.ref.baselineRevision,
    768, pages[0]!.payload.segmentId,
  ), 'file-backed delivery exactly matches the shared string reader');
  assert.equal(start.totalCodePoints, pages[0]?.payload.totalCodePoints);
  assert.ok(Buffer.byteLength(JSON.stringify(start), 'utf8') < 2_048, 'baseline manifest is bounded independently of total detail bytes');
  const rebuilt = reassembleDetailPages(pages) as any;
  assert.equal(rebuilt.messages[0].content[0].text, text);
  assert.equal(store.debugState().canonicalBytes, 0, 'oversized canonical value is not retained in the bounded delta window');
  // Independent fetch cursors must match real delivered baseline pages even
  // when requests arrive in reverse or deterministic pseudo-random order.
  let seed = 17;
  const shuffled = [...pages];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const other = seed % (index + 1);
    [shuffled[index], shuffled[other]] = [shuffled[other]!, shuffled[index]!];
  }
  for (const page of [...pages].reverse().concat(shuffled)) {
    store.fetch('fetch-page', 'subscription-1', address, page.ref, 768);
    const fetched = frames.at(-1)!;
    assert.equal(fetched.kind, 'detail.page');
    assert.deepEqual(fetched, { kind: 'detail.page', requestId: 'fetch-page', subscriptionId: 'subscription-1', ...page });
  }
  store.dispose();
});

test('smaller fetch caps never reshape a same-count live manifest', async () => {
  for (const index of [0, 1]) {
    const frames: DetailFrame[] = [];
    const { store, settle } = createSettledDetailStore({ emit: (frame) => { frames.push(frame as DetailFrame); return true; } });
    try {
      store.observe({ ...root, details: details('x'.repeat(5000)) });
      store.subscribe('s', 's', address, undefined, 4096);
      await settle();
      const baseline = frames.filter((frame): frame is Extract<DetailFrame, { kind: 'detail.page' }> => frame.kind === 'detail.page');
      const reshaped = segmentDetailPages(baseline.map((page) => page.payload.text).join(''), baseline[0]!.ref.baselineRevision, 4000, baseline[0]!.payload.segmentId);
      assert.equal(reshaped.length, baseline.length);
      assert.notDeepEqual(reshaped[0]!.payload, baseline[0]!.payload);
      const page = baseline[index]!;
      frames.length = 0;
      store.fetch('f', 's', address, page.ref, 4000);
      if (page.payloadBytes > 4000) {
        assert.deepEqual(frames.map((frame) => frame.kind), ['detail.rebase']);
      } else {
        assert.deepEqual(frames, [{ ...page, requestId: 'f' }]);
      }
    } finally {
      store.dispose();
    }
  }
});

test('fetch rejects incorrect page counts and invalid indices without emitting a page', async () => {
  for (const invalid of [
    { pageCount: 1 }, { pageCount: 999_999 },
    { pageIndex: -1 }, { pageIndex: 0.5 }, { pageIndex: 999_999 },
  ]) {
    const frames: DetailFrame[] = [];
    const { store, settle } = createSettledDetailStore({
      emit: (frame) => { frames.push(frame as DetailFrame); return true; },
      budgets: { maxPageBytes: 768 },
    });
    store.observe({ ...root, details: details('🙂é漢字'.repeat(80)) });
    store.subscribe('subscribe', 'subscription', address, undefined, 768);
    await settle();
    const page = frames.find((frame) => frame.kind === 'detail.page');
    assert.ok(page && page.kind === 'detail.page');
    frames.length = 0;
    store.fetch('fetch', 'subscription', address, { ...page.ref, ...invalid }, 768);
    assert.equal(frames.some((frame) => frame.kind === 'detail.page'), false);
    assert.equal(frames.at(-1)?.kind, 'detail.rebase');
    store.dispose();
  }
});

test('large live baseline drains through the bounded detail queue without a rebase loop', async () => {
  const emitted: DetailFrame[] = [];
  const target: WorkerIpcWriteTarget & {
    readonly sent: WorkerIpcFrame[];
    readonly callbacks: Array<(error?: Error | null) => void>;
  } = {
    writable: true,
    sent: [],
    callbacks: [],
    write(data, callback) {
      this.sent.push(JSON.parse(data) as WorkerIpcFrame);
      this.callbacks.push(callback);
      return false;
    },
  };
  const server = new WorkerServer({
    coordinatorGeneration: 1,
    workerId: 'worker',
    workerGeneration: 1,
    sessionPath: root.sessionPath,
    rootSessionPath: root.sessionPath,
    leasePath: root.sessionPath,
    leaseRevision: 1,
    ipcReadFd: 3,
    ipcWriteFd: 4,
  }, {
    pid: 1234,
    exit: () => undefined as never,
  }, {
    readable: new PassThrough(),
    writable: target as never,
  });
  const prefillPage = segmentDetailPages(JSON.stringify({ filler: 'x'.repeat(120_000) }), 1, 128 * 1024, 'worker-prefill-fixture')[0]!;
  let prefillCount = 0;
  for (let index = 0; index < 32; index += 1) {
    if (!server.sendDetailFrame({
      kind: 'detail.page', subscriptionId: `prefill-${index}`, ...prefillPage,
    })) break;
    prefillCount += 1;
  }
  assert.ok(prefillCount >= 15, 'the test must begin with a materially occupied detail queue');

  const store = new WorkerLiveDetailStore({
    emit: (frame, onSettled) => {
      emitted.push(frame as DetailFrame);
      return server.sendDetailFrame(frame, onSettled);
    },
    onDrain: (listener) => server.onDetailDrain(listener),
    // Exercise the streaming path: the baseline is intentionally larger than
    // the whole canonical retention budget.
    budgets: { maxCanonicalBytes: 1_024 },
  });
  store.observe({ ...root, details: details('x'.repeat(2_300_000)) });
  store.subscribe('request-large', 'subscription-large', address, undefined, 128 * 1024);

  const start = emitted.find((frame): frame is Extract<DetailFrame, { kind: 'detail.start' }> => frame.kind === 'detail.start');
  assert.ok(start);
  assert.equal(emitted.filter((frame) => frame.kind === 'detail.page').length, 0,
    'pages wait behind the correlated baseline manifest');
  const settleNextWrite = async (): Promise<void> => {
    const callback = target.callbacks.shift();
    assert.ok(callback, 'the blocked descriptor should retain one bounded active write');
    callback?.(null);
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  await settleNextWrite();
  while (emitted.filter((frame) => frame.kind === 'detail.page').length < start.pageCount) {
    await settleNextWrite();
  }
  await settleNextWrite();
  const pages = emitted.filter((frame) => frame.kind === 'detail.page');
  assert.ok(start.pageCount > 15, 'the baseline must exceed the bounded detail queue');
  assert.equal(pages.length, start.pageCount,
    'every baseline page should remain queued for progressive delivery instead of being abandoned');
  const rebuilt = reassembleDetailPages(pages.map((frame) => ({
    ref: frame.ref, payload: frame.payload, payloadBytes: frame.payloadBytes, checksum: frame.checksum,
  })));
  assert.equal((rebuilt as any).messages[0].content[0].text, 'x'.repeat(2_300_000),
    'the bounded cursor must preserve the complete oversized baseline');
  assert.equal(emitted.some((frame) => frame.kind === 'detail.rebase'), false,
    'queue pressure must not turn a healthy baseline into a rebase loop');
  assert.equal(store.debugState().canonicalBytes, 0,
    'an oversized baseline must not leave an unaccounted full snapshot retained');
});

test('continuous streaming delivers one stable oversized baseline with ordered deltas instead of a rebase loop', async () => {
  const before = liveDetailSpools();
  const emitted: DetailFrame[] = [];
  const pending: Array<() => void> = [];
  const listeners = new Set<() => void>();
  const store = new WorkerLiveDetailStore({
    emit: (frame, onSettled) => {
      emitted.push(frame as DetailFrame);
      if (onSettled) pending.push(() => onSettled({ status: 'sent' }));
      return true;
    },
    onDrain: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // Cheap injected budgets reproduce the oversized-transcript regime: the
    // canonical value can never be retained in memory, so every producer
    // update used to force a full rebase instead of continuing the stable
    // live baseline it was delivered against.
    budgets: { maxCanonicalBytes: 1_024, maxDeltaBytes: 4_096, maxPageBytes: 1_024 },
  });
  try {
    let generation = 1;
    const streamed = (suffix: string) => details(`stream ${suffix} ${'y'.repeat(1_800)}`, generation);
    store.observe({ ...root, details: streamed('zero') });
    store.subscribe('request-stream', 'subscription-stream', address, undefined, 1_024);
    const start = emitted.find((frame): frame is Extract<DetailFrame, { kind: 'detail.start' }> => frame.kind === 'detail.start');
    assert.ok(start && start.pageCount > 1, 'the oversized baseline spans several bounded pages');

    const settle = async (): Promise<void> => {
      pending.shift()?.();
      for (const listener of listeners) listener();
      await new Promise<void>((resolve) => setImmediate(resolve));
    };

    // Simulated continuous streaming: a producer update lands between every
    // delivery step while the oversized baseline drains, exactly like a live
    // transcript that keeps growing while its pages are queued.
    const updatesDuringDelivery = 3;
    let updates = 0;
    while (emitted.filter((frame) => frame.kind === 'detail.page').length < start.pageCount) {
      if (updates < updatesDuringDelivery) {
        generation += 1;
        updates += 1;
        store.observe({ ...root, details: streamed(String(updates)) });
      }
      await settle();
    }
    // The final page settlement is where the deferred update must surface.
    await settle();

    assert.equal(emitted.some((frame) => frame.kind === 'detail.rebase'), false,
      'continuous streaming must not starve the stable baseline in a rebase loop');
    const deltas = emitted.filter((frame): frame is Extract<DetailFrame, { kind: 'detail.delta' }> => frame.kind === 'detail.delta');
    assert.equal(deltas.length, 1, 'updates observed during delivery coalesce into one ordered delta');
    assert.equal(deltas[0]!.baseRevision, start.baselineRevision);
    assert.equal(deltas[0]!.revision, generation);

    // Post-baseline streaming must continue on the same stable subscription.
    generation += 1;
    store.observe({ ...root, details: streamed('tail') });
    const tail = emitted.at(-1);
    assert.equal(tail?.kind, 'detail.delta', 'an update after completion is a delta, not a rebase');
    if (tail?.kind === 'detail.delta') {
      assert.equal(tail.baseRevision, deltas[0]!.revision, 'the delta chain is contiguous');
      assert.equal(tail.revision, generation);
    }

    const pages = emitted.filter((frame): frame is Extract<DetailFrame, { kind: 'detail.page' }> => frame.kind === 'detail.page')
      .map((frame) => ({ ref: frame.ref, payload: frame.payload, payloadBytes: frame.payloadBytes, checksum: frame.checksum }));
    assert.equal(pages.length, start.pageCount, 'the original baseline finished intact');
    let applied = applyJsonPatch(reassembleDetailPages(pages), deltas[0]!.operations);
    assert.ok(applied.ok, `the first delta applies: ${applied.ok ? '' : applied.reason}`);
    const tailDelta = tail as Extract<DetailFrame, { kind: 'detail.delta' }>;
    applied = applyJsonPatch(applied.ok ? applied.value : null, tailDelta.operations);
    assert.ok(applied.ok, `the tail delta applies: ${applied.ok ? '' : applied.reason}`);
    assert.equal((applied.value as any).messages[0].content[0].text, `stream tail ${'y'.repeat(1_800)}`);

    assert.equal(store.debugState().canonicalBytes, 0,
      'an oversized live stream never retains an unaccounted canonical value');
  } finally {
    store.dispose();
  }
  assert.deepEqual(liveDetailSpools(), before, 'the spool-backed delta authority is released with the subscription');
});

test('source updates during an oversized baseline are delivered as one ordered delta after every original page settles', async () => {
  const emitted: DetailFrame[] = [];
  const pending: Array<{ settle: (value: { status: 'sent' }) => void }> = [];
  const listeners = new Set<() => void>();
  const store = new WorkerLiveDetailStore({
    emit: (frame, onSettled) => {
      emitted.push(frame as DetailFrame);
      if (onSettled) pending.push({ settle: () => onSettled({ status: 'sent' }) });
      return true;
    },
    onDrain: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    budgets: { maxCanonicalBytes: 1_024 },
  });
  const settle = async (): Promise<void> => {
    const write = pending.shift();
    assert.ok(write);
    write?.settle({ status: 'sent' });
    for (const listener of listeners) listener();
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const beforeText = 'before🙂é漢字'.repeat(500);
  store.observe({ ...root, details: details(beforeText, 1) });
  store.subscribe('request-update', 'subscription-update', address, undefined, 1024);
  const start = emitted.find((frame): frame is Extract<DetailFrame, { kind: 'detail.start' }> => frame.kind === 'detail.start');
  assert.ok(start && start.pageCount > 1, 'the update must race an oversized baseline');
  await settle();
  assert.equal(emitted.filter((frame) => frame.kind === 'detail.page').length, 1);
  store.observe({ ...root, details: details('after'.repeat(500), 2) });
  assert.equal(emitted.some((frame) => frame.kind === 'detail.rebase'), false,
    'a revision change must not overtake the already admitted page');
  while (emitted.filter((frame) => frame.kind === 'detail.page').length < start!.pageCount) {
    await settle();
  }
  const originalPages = emitted.filter((frame): frame is Extract<DetailFrame, { kind: 'detail.page' }> => frame.kind === 'detail.page')
    .map((frame) => ({ ref: frame.ref, payload: frame.payload, payloadBytes: frame.payloadBytes, checksum: frame.checksum }));
  assert.equal((reassembleDetailPages(originalPages) as any).messages[0].content[0].text, beforeText,
    'the original Unicode baseline must remain byte-exact while updates are deferred');
  // The final page is only complete after its settlement callback, which is
  // where the deferred update is delivered as one ordered delta against the
  // stable baseline the receiver just assembled.
  await settle();
  assert.equal(emitted.filter((frame) => frame.kind === 'detail.page').length, start!.pageCount,
    'the immutable original baseline must finish before the deferred delta');
  const delta = emitted.at(-1);
  assert.equal(delta?.kind, 'detail.delta');
  assert.equal(emitted.some((frame) => frame.kind === 'detail.rebase'), false,
    'the stable baseline is continued with a delta instead of being rebased');
  if (delta?.kind === 'detail.delta') {
    assert.equal(delta.baseRevision, start!.baselineRevision);
    assert.equal(delta.revision, 2);
    const applied = applyJsonPatch(reassembleDetailPages(originalPages), delta.operations);
    assert.ok(applied.ok, `the deferred delta applies: ${applied.ok ? '' : applied.reason}`);
    assert.equal((applied.value as any).messages[0].content[0].text, 'after'.repeat(500));
  }
});

test('terminal during an in-flight spooled baseline is ordered after the page and releases the spool without later pages', async () => {
  const before = liveDetailSpools();
  const emitted: DetailFrame[] = [];
  const pending: Array<() => void> = [];
  const listeners = new Set<() => void>();
  const store = new WorkerLiveDetailStore({
    emit: (frame, onSettled) => {
      emitted.push(frame as DetailFrame);
      if (onSettled) pending.push(() => onSettled({ status: 'sent' }));
      return true;
    },
    onDrain: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    budgets: { maxCanonicalBytes: 1_024 },
  });
  try {
    store.observe({ ...root, details: details('terminal'.repeat(1_000)) });
    store.subscribe('request-terminal', 'subscription-terminal', address, undefined, 1_024);
    const start = emitted.find((frame): frame is Extract<DetailFrame, { kind: 'detail.start' }> => frame.kind === 'detail.start');
    assert.ok(start && start.pageCount > 1, 'terminal must race a multi-page baseline');
    assert.ok(liveDetailSpools().length > before.length, 'the in-flight baseline must use a private spool');

    assert.deepEqual(emitted.map((frame) => frame.kind), ['detail.start']);
    pending.shift()?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(emitted.map((frame) => frame.kind), ['detail.start', 'detail.page']);
    assert.equal((emitted[1] as Extract<DetailFrame, { kind: 'detail.page' }>).ref.pageIndex, 0);

    // Terminal is requested while page zero is still in flight. It must wait
    // for that admitted page rather than overtaking it or allowing later pages
    // to escape after the durable handoff.
    store.terminal(root, 'durable-terminal');
    assert.deepEqual(emitted.map((frame) => frame.kind), ['detail.start', 'detail.page']);
    assert.equal(pending.length, 1, 'the admitted page remains the only unsettled frame');

    pending.shift()?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(emitted.map((frame) => frame.kind), ['detail.start', 'detail.page', 'detail.terminal']);
    assert.equal(store.debugState().subscriptions, 0, 'terminal drops the live owner after handoff');
    assert.deepEqual(liveDetailSpools(), before, 'terminal releases the private spool before completing the handoff');

    for (const listener of listeners) listener();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(emitted.map((frame) => frame.kind), ['detail.start', 'detail.page', 'detail.terminal'],
      'no page may be emitted after the durable terminal');
  } finally {
    store.dispose();
  }
});

test('in-place producer mutation cannot alter a stable baseline already in flight', async () => {
  const emitted: DetailFrame[] = [];
  const pending: Array<() => void> = [];
  const mutableTarget = child(target, [parent, target], 'original🙂é漢字'.repeat(500));
  const store = new WorkerLiveDetailStore({
    emit: (frame, onSettled) => {
      emitted.push(frame as DetailFrame);
      if (onSettled) pending.push(() => onSettled({ status: 'sent' }));
      return true;
    },
    onDrain: (listener) => {
      const listeners = [listener];
      return () => { listeners.length = 0; };
    },
    budgets: { maxCanonicalBytes: 1_024 },
  });
  store.observe({ ...root, details: { details: { results: [mutableTarget] } } });
  store.subscribe('request-in-place', 'subscription-in-place', address, undefined, 1_024);
  const start = emitted.find((frame): frame is Extract<DetailFrame, { kind: 'detail.start' }> => frame.kind === 'detail.start');
  assert.ok(start && start.pageCount > 1);
  pending.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));

  (mutableTarget.messages[0]!.content[0] as { text: string }).text = 'mutated-after-subscribe'.repeat(500);
  while (emitted.filter((frame) => frame.kind === 'detail.page').length < start!.pageCount) {
    assert.ok(pending.length > 0, 'the next page should remain the only pending delivery');
    pending.shift()?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.ok(pending.length > 0, 'the final page settlement should release the snapshot');
  pending.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const pages = emitted.filter((frame): frame is Extract<DetailFrame, { kind: 'detail.page' }> => frame.kind === 'detail.page')
    .map((frame) => ({ ref: frame.ref, payload: frame.payload, payloadBytes: frame.payloadBytes, checksum: frame.checksum }));
  const rebuilt = reassembleDetailPages(pages) as any;
  assert.equal(rebuilt.messages[0].content[0].text, 'original🙂é漢字'.repeat(500));
  assert.equal(emitted.some((frame) => frame.kind === 'detail.rebase'), false);
});

test('above-budget snapshots use a private spool and release it on unsubscribe, dispose, and completion', async () => {
  const before = liveDetailSpools();
  const createStore = (id: string) => {
    const pending: Array<() => void> = [];
    const emitted: DetailFrame[] = [];
    const store = new WorkerLiveDetailStore({
      emit: (frame, onSettled) => {
        emitted.push(frame as DetailFrame);
        if (onSettled) pending.push(() => onSettled({ status: 'sent' }));
        return true;
      },
      onDrain: (listener) => {
        const listeners = [listener];
        return () => { listeners.length = 0; };
      },
      budgets: { maxCanonicalBytes: 1_024 },
    });
    store.observe({ ...root, details: details('spooled'.repeat(1_000)) });
    store.subscribe(`request-${id}`, `subscription-${id}`, address, undefined, 1_024);
    return { emitted, pending, store };
  };

  const unsubscribed = createStore('unsubscribe');
  assert.ok(liveDetailSpools().length > before.length, 'the oversized baseline should create a temp spool');
  unsubscribed.store.unsubscribe('unsubscribe', 'subscription-unsubscribe');
  assert.deepEqual(liveDetailSpools(), before, 'unsubscribe removes the private spool');

  const disposed = createStore('dispose');
  disposed.store.dispose();
  assert.deepEqual(liveDetailSpools(), before, 'dispose removes the private spool');

  const completed = createStore('complete');
  const start = completed.emitted.find((frame): frame is Extract<DetailFrame, { kind: 'detail.start' }> => frame.kind === 'detail.start')!;
  completed.pending.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  while (completed.emitted.filter((frame) => frame.kind === 'detail.page').length < start.pageCount) {
    completed.pending.shift()?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  // The final page is emitted before its write settlement releases the spool.
  completed.pending.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(liveDetailSpools().length > before.length,
    'completion keeps the delivered spool as the zero-memory delta authority');
  completed.store.dispose();
  assert.deepEqual(liveDetailSpools(), before, 'dispose removes the retained delta authority spool');
});

test('global retention accounting charges in-memory baselines and spools later snapshots', () => {
  const before = liveDetailSpools();
  const pending: Array<() => void> = [];
  const store = new WorkerLiveDetailStore({
    emit: (_frame, onSettled) => {
      if (onSettled) pending.push(() => onSettled({ status: 'sent' }));
      return true;
    },
    onDrain: (listener) => {
      const listeners = [listener];
      return () => { listeners.length = 0; };
    },
    budgets: { maxCanonicalBytes: 1_500 },
  });
  store.observe({ ...root, details: details('accounted'.repeat(50)) });
  store.subscribe('request-accounted-1', 'subscription-accounted-1', address, undefined, 1_024);
  const firstBytes = store.debugState().canonicalBytes;
  assert.ok(firstBytes > 0 && firstBytes <= 1_500, `first retained bytes: ${firstBytes}`);
  store.subscribe('request-accounted-2', 'subscription-accounted-2', address, undefined, 1_024);
  assert.ok(store.debugState().canonicalBytes <= 1_500, 'retained baseline bytes stay globally bounded');
  assert.ok(liveDetailSpools().length > before.length, `the second snapshot does not bypass the global memory budget (first=${firstBytes}, retained=${store.debugState().canonicalBytes})`);
  store.dispose();
  assert.equal(store.debugState().canonicalBytes, 0);
  assert.deepEqual(liveDetailSpools(), before);
  assert.ok(pending.length >= 2);
});

test('unsubscribe and disposal fence pending baseline delivery', async () => {
  const createPendingStore = async () => {
    const emitted: DetailFrame[] = [];
    const pending: Array<(value: { status: 'sent' }) => void> = [];
    const listeners = new Set<() => void>();
    const store = new WorkerLiveDetailStore({
      emit: (frame, onSettled) => {
        emitted.push(frame as DetailFrame);
        if (onSettled) pending.push(() => onSettled({ status: 'sent' }));
        return true;
      },
      onDrain: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    store.observe({ ...root, details: details('pending') });
    store.subscribe('request-pending', 'subscription-pending', address, undefined, 1024);
    const start = pending.shift();
    assert.ok(start);
    start?.({ status: 'sent' });
    for (const listener of listeners) listener();
    await new Promise<void>((resolve) => setImmediate(resolve));
    return { emitted, pending, store, listeners };
  };

  const unsubscribed = await createPendingStore();
  unsubscribed.store.unsubscribe('unsubscribe', 'subscription-pending');
  unsubscribed.pending.shift()?.({ status: 'sent' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(unsubscribed.store.debugState().subscriptions, 0);
  assert.equal(unsubscribed.emitted.filter((frame) => frame.kind === 'detail.page').length, 1);

  const disposed = await createPendingStore();
  disposed.store.dispose();
  disposed.pending.shift()?.({ status: 'sent' });
  for (const listener of disposed.listeners) listener();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(disposed.store.debugState(), { sources: 0, subscriptions: 0, canonicalBytes: 0 });
  assert.equal(disposed.emitted.filter((frame) => frame.kind === 'detail.page').length, 1);
});

test('stable lineage survives source reorder and changed revisions emit one ordered structural delta', async () => {
  const frames: DetailFrame[] = [];
  const { store, settle } = createSettledDetailStore({ emit: (frame) => { frames.push(frame as DetailFrame); return true; } });
  store.observe({ ...root, details: details('before', 1) });
  store.subscribe('request-1', 'subscription-1', address, undefined, 4096);
  await settle();
  frames.length = 0;
  store.observe({ ...root, details: details('after', 2, true) });
  const deltas = frames.filter((frame): frame is Extract<DetailFrame, { kind: 'detail.delta' }> => frame.kind === 'detail.delta');
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0]!.baseRevision, 1);
  assert.equal(deltas[0]!.revision, 2);
  assert.ok(deltas[0]!.operations.length > 0);
});

test('gap fetch, canonical eviction, and detail queue backpressure produce explicit rebases', async () => {
  const frames: DetailFrame[] = [];
  const { store, settle } = createSettledDetailStore({
    emit: (frame) => {
      frames.push(frame as DetailFrame);
      return true;
    },
    budgets: { maxCanonicalBytes: 4096, maxDeltaBytes: 4096, maxPageBytes: 1024 },
  });
  store.observe({ ...root, details: details('before') });
  store.subscribe('request-1', 'subscription-1', address, undefined, 1024);
  await settle();
  const start = frames.find((frame): frame is Extract<DetailFrame, { kind: 'detail.start' }> => frame.kind === 'detail.start')!;
  frames.length = 0;
  store.fetch('fetch-gap', 'subscription-1', address, { baselineRevision: start.baselineRevision + 1, pageIndex: 0, pageCount: start.pageCount }, 1024);
  assert.equal(frames.at(-1)?.kind, 'detail.rebase');

  const backpressureFrames: DetailFrame[] = [];
  const { store: backpressure, settle: settleBackpressure } = createSettledDetailStore({ emit: (frame) => {
    backpressureFrames.push(frame as DetailFrame);
    return frame.kind !== 'detail.delta';
  } });
  backpressure.observe({ ...root, details: details('before', 1) });
  backpressure.subscribe('request-2', 'subscription-2', address, undefined, 4096);
  await settleBackpressure();
  backpressureFrames.length = 0;
  backpressure.observe({ ...root, details: details('after', 2) });
  assert.deepEqual(backpressureFrames.map((frame) => frame.kind), ['detail.delta', 'detail.rebase']);
});

test('tiny canonical budget evicts an older subscribed revision with an explicit rebase', async () => {
  const frames: DetailFrame[] = [];
  const { store, settle } = createSettledDetailStore({
    emit: (frame) => { frames.push(frame as DetailFrame); return true; },
    budgets: { maxCanonicalBytes: 900, maxPageBytes: 1024 },
  });
  const root2 = { ...root, rootToolCallId: 'tool-root-2' };
  const parent2 = { ...parent, childId: 'child-parent-2', spawningToolCallId: 'tool-root-2' };
  const address2: LiveSubagentDetailAddress = { ...root2, lineage: [parent2] };
  store.observe({ ...root, details: details('first') });
  store.subscribe('request-1', 'subscription-1', address, undefined, 1024);
  await settle();
  store.observe({ ...root2, details: { details: { results: [child(parent2, [parent2], 'second')] } } });
  store.subscribe('request-2', 'subscription-2', address2, undefined, 1024);
  await settle();
  assert.ok(frames.some((frame) => frame.kind === 'detail.rebase'
    && frame.subscriptionId === 'subscription-1' && frame.reason === 'evicted'));
  assert.ok(store.debugState().canonicalBytes <= 900);
});

test('terminal emits only after durable ref exists and a restarted store has no live authority', async () => {
  const frames: DetailFrame[] = [];
  const { store, settle } = createSettledDetailStore({ emit: (frame) => { frames.push(frame as DetailFrame); return true; } });
  store.observe({ ...root, details: details('terminal') });
  store.subscribe('request-1', 'subscription-1', address, undefined, 4096);
  await settle();
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
  const { store: restarted, settle: settleRestarted } = createSettledDetailStore({ emit: (frame) => { restartedFrames.push(frame as DetailFrame); return true; } });
  restarted.subscribe('restart', 'subscription-restart', address, undefined, 4096);
  await settleRestarted();
  assert.equal(restartedFrames[0]?.kind, 'detail.error');
  assert.equal((restartedFrames[0] as any).code, 'NOT_FOUND');
});

test('retryable page settlement waits for drain and retries the immutable page', async () => {
  const frames: DetailFrame[] = [];
  const pending: Array<(settlement: import('../worker-live-detail-store').WorkerLiveDetailEmitSettlement) => void> = [];
  let drain: (() => void) | undefined;
  const store = new WorkerLiveDetailStore({
    emit(frame, settled) {
      frames.push(frame as DetailFrame);
      if (settled) pending.push(settled);
      return true;
    },
    onDrain(listener) {
      drain = listener;
      return () => { drain = undefined; };
    },
    budgets: { maxCanonicalBytes: 128, maxPageBytes: 768 },
  });
  try {
    store.observe({ ...root, details: details('retry 🙂'.repeat(100)) });
    store.subscribe('request-retry', 'subscription-retry', address, undefined, 768);
    pending.shift()!({ status: 'sent' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const page = frames.at(-1);
    assert.equal(page?.kind, 'detail.page');
    pending.shift()!({ status: 'rejected', retryable: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(frames.length, 2, 'rejection must not spin without a drain');
    store.observe({ ...root, details: details('new revision', 2) });
    drain!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(frames.at(-1), page, 'drain retries the exact retained baseline page despite a new revision');
    store.unsubscribe('unsubscribe-retry', 'subscription-retry');
    pending.shift()!({ status: 'sent' });
    drain!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(frames.at(-1)?.kind, 'detail.unsubscribed', 'late settlements cannot resurrect an unsubscribed cursor');
    assert.equal(store.debugState().canonicalBytes, 0);
  } finally {
    store.dispose();
  }
  assert.equal(drain, undefined);
});
