import assert from 'node:assert/strict';
import test from 'node:test';

import type { HostDetailRoute, LiveSubagentDetailAddress, WebviewToHostMessage } from '../../src/shared/protocol';
import type { DetailPagePayload } from '../../src/shared/protocol/subagent-detail';
import type { JsonStructuralPatchOperation } from '../../src/shared/json-structural-patch';
import type { DetailStreamMessage } from '../../src/webview/panel/transcript/detail-subscription-store';
import {
  clearDetailSubscriptionStore,
  closeDetailSubscription,
  demandDetailValue,
  getDetailStoreDebugState,
  openDetailSubscription,
  receiveDetailImperative,
  resetDetailStoreBudgets,
  resolveDetailTarget,
  setDetailStoreBudgets,
  setDetailStoreContext,
  sha256Hex,
} from '../../src/webview/panel/transcript/detail-subscription-store';

const KEY = 'subagent:msg-1:tool-1';

const ADDRESS: LiveSubagentDetailAddress = {
  sessionPath: '/s.jsonl',
  turnId: 't1',
  rootToolCallId: 'rt1',
  rootAttemptId: 'ra1',
  lineage: [{ childId: 'c1', spawningToolCallId: 'rt1', attemptId: 'a1' }],
};

function route(subscriptionId: string, detailKey = KEY): HostDetailRoute {
  return {
    hostInstanceId: 'h1',
    hostGeneration: 0,
    viewGeneration: 1,
    backendGeneration: 1,
    coordinatorGeneration: 1,
    workerId: 'w1',
    workerGeneration: 1,
    detailKey,
    subscriptionId,
  };
}

function childValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent: 'worker',
    task: 'do the thing',
    exitCode: -1,
    liveAddressable: true,
    lineage: ADDRESS.lineage.map((identity) => ({ ...identity })),
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'working…' }] },
    ],
    ...overrides,
  };
}

interface PageFixture {
  payload: DetailPagePayload;
  payloadBytes: number;
  checksum: string;
}

function encodePages(value: unknown, pageCount: number): PageFixture[] {
  const text = JSON.stringify(value);
  const points = [...text];
  const perPage = Math.max(1, Math.ceil(points.length / pageCount));
  const totalBytes = new TextEncoder().encode(text).byteLength;
  const pages: PageFixture[] = [];
  let byte = 0;
  let codePoint = 0;
  for (let index = 0; index < pageCount; index += 1) {
    const start = index * perPage;
    const end = Math.min(points.length, start + perPage);
    const segmentText = points.slice(start, end).join('');
    const segmentBytes = new TextEncoder().encode(segmentText).byteLength;
    const payload: DetailPagePayload = {
      kind: 'json-segment',
      encoding: 'utf8-json',
      segmentId: `s${index}`,
      semanticPath: [],
      startByte: byte,
      endByte: byte + segmentBytes,
      totalBytes,
      startCodePoint: codePoint,
      endCodePoint: codePoint + (end - start),
      totalCodePoints: points.length,
      text: segmentText,
    };
    const serialized = JSON.stringify(payload);
    pages.push({
      payload,
      payloadBytes: new TextEncoder().encode(serialized).byteLength,
      checksum: sha256Hex(serialized),
    });
    byte += segmentBytes;
    codePoint += end - start;
  }
  return pages;
}

interface Stream {
  detailKey: string;
  subscriptionId: string;
  baselineRevision: number;
  value: unknown;
  pages: PageFixture[];
}

function makeStream(
  detailKey: string,
  subscriptionId: string,
  value: unknown = childValue(),
  pageCount = 2,
  baselineRevision = 1,
): Stream {
  return {
    detailKey,
    subscriptionId,
    baselineRevision,
    value,
    pages: encodePages(value, pageCount),
  };
}

function streamStart(stream: Stream, overrides?: { totalCodePoints?: number; totalBytes?: number }): DetailStreamMessage {
  return {
    type: 'detail.start',
    ...route(stream.subscriptionId, stream.detailKey),
    address: ADDRESS,
    source: 'live',
    baselineRevision: stream.baselineRevision,
    pageCount: stream.pages.length,
    totalBytes: overrides?.totalBytes ?? stream.pages[0]!.payload.totalBytes,
    totalCodePoints: overrides?.totalCodePoints ?? stream.pages[0]!.payload.totalCodePoints,
  };
}

function streamPage(stream: Stream, index: number, overrides?: { payload?: DetailPagePayload; checksum?: string; payloadBytes?: number }): DetailStreamMessage {
  const page = stream.pages[index]!;
  return {
    type: 'detail.page',
    ...route(stream.subscriptionId, stream.detailKey),
    ref: { baselineRevision: stream.baselineRevision, pageIndex: index, pageCount: stream.pages.length },
    payload: overrides?.payload ?? page.payload,
    payloadBytes: overrides?.payloadBytes ?? page.payloadBytes,
    checksum: overrides?.checksum ?? page.checksum,
  };
}

function streamDelta(stream: Stream, baseRevision: number, revision: number, operations: JsonStructuralPatchOperation[]): DetailStreamMessage {
  return {
    type: 'detail.delta',
    ...route(stream.subscriptionId, stream.detailKey),
    baseRevision,
    revision,
    operations,
  };
}

function install(posts: WebviewToHostMessage[] = []): WebviewToHostMessage[] {
  setDetailStoreContext({
    hostInstanceId: 'h1',
    viewGeneration: 1,
    postMessage: (message) => posts.push(message),
  });
  return posts;
}

function delivered(subscriptionId: string, detailKey = KEY): Stream {
  const stream = makeStream(detailKey, subscriptionId);
  receiveDetailImperative(streamStart(stream));
  for (let index = 0; index < stream.pages.length; index += 1) {
    receiveDetailImperative(streamPage(stream, index));
  }
  return stream;
}

function subscribePosts(posts: WebviewToHostMessage[]): Extract<WebviewToHostMessage, { type: 'detail.subscribe' }>[] {
  return posts.filter((post): post is Extract<WebviewToHostMessage, { type: 'detail.subscribe' }> => post.type === 'detail.subscribe');
}

function unsubscribePosts(posts: WebviewToHostMessage[]): Extract<WebviewToHostMessage, { type: 'detail.unsubscribe' }>[] {
  return posts.filter((post): post is Extract<WebviewToHostMessage, { type: 'detail.unsubscribe' }> => post.type === 'detail.unsubscribe');
}

function fetchPagesPosts(posts: WebviewToHostMessage[]): Extract<WebviewToHostMessage, { type: 'detail.fetchPages' }>[] {
  return posts.filter((post): post is Extract<WebviewToHostMessage, { type: 'detail.fetchPages' }> => post.type === 'detail.fetchPages');
}

test.beforeEach(() => {
  clearDetailSubscriptionStore();
  resetDetailStoreBudgets();
});

test('collapsed cards never subscribe; expansion subscribes exactly once; collapse unsubscribes immediately', () => {
  const posts = install();
  assert.equal(posts.length, 0, 'no subscription while collapsed');

  openDetailSubscription({ detailKey: KEY, address: ADDRESS });
  openDetailSubscription({ detailKey: KEY, address: ADDRESS });
  assert.equal(posts.length, 1, 'repeated expansion of the same owner is idempotent');
  const subscribe = subscribePosts(posts)[0]!;
  assert.equal(subscribe.viewGeneration, 1);
  assert.equal(subscribe.detailKey, KEY);
  assert.deepEqual(subscribe.address, ADDRESS);
  assert.equal(subscribe.cursor, undefined, 'first subscribe carries no cursor');

  closeDetailSubscription(KEY, 'collapse');
  assert.equal(unsubscribePosts(posts).length, 1);
  const unsubscribe = unsubscribePosts(posts)[0]!;
  assert.equal(unsubscribe.viewGeneration, 1);
  assert.equal(unsubscribe.reason, 'collapse');

  closeDetailSubscription(KEY, 'collapse');
  assert.equal(unsubscribePosts(posts).length, 1, 'closing an already-closed key is idempotent');
});

test('start → pages → delta lifecycle assembles and applies the canonical child record', () => {
  const posts = install();
  openDetailSubscription({ detailKey: KEY, address: ADDRESS });
  const stream = makeStream(KEY, 'sub-1');
  receiveDetailImperative(streamStart(stream));
  assert.equal(demandDetailValue(KEY).status, 'pending', 'no pages yet: explicit loading');

  receiveDetailImperative(streamPage(stream, 0));
  assert.equal(demandDetailValue(KEY).status, 'pending', 'partial baseline: still loading');
  receiveDetailImperative(streamPage(stream, 1));
  const ready = demandDetailValue(KEY);
  assert.equal(ready.status, 'ready');
  if (ready.status === 'ready') {
    const value = ready.value as Record<string, unknown>;
    assert.equal(value.agent, 'worker');
    assert.deepEqual(value.lineage, ADDRESS.lineage);
    assert.equal((value.messages as unknown[]).length, 2);
  }

  receiveDetailImperative(streamDelta(stream, 1, 2, [{ op: 'set', path: ['exitCode'], value: 0 }]));
  const afterDelta = demandDetailValue(KEY);
  assert.equal(afterDelta.status, 'ready');
  if (afterDelta.status === 'ready') {
    assert.equal((afterDelta.value as Record<string, unknown>).exitCode, 0);
  }
  assert.equal(posts.filter((post) => post.type === 'detail.subscribe').length, 1, 'no re-subscribe on the happy path');
});

test('stale frames from a retired owner are ignored after collapse/re-expansion', () => {
  const posts = install();
  openDetailSubscription({ detailKey: KEY, address: ADDRESS });
  const first = delivered('sub-1');
  assert.equal(demandDetailValue(KEY).status, 'ready');

  closeDetailSubscription(KEY, 'collapse');
  openDetailSubscription({ detailKey: KEY, address: ADDRESS });
  assert.equal(subscribePosts(posts).length, 2, 're-expansion mints a fresh owner');

  // A late page bound to the retired owner must not mutate the fresh record.
  receiveDetailImperative(streamPage(first, 0));
  assert.equal(demandDetailValue(KEY).status, 'pending', 'stale frame did not assemble into the new owner');

  const second = makeStream(KEY, 'sub-2');
  receiveDetailImperative(streamStart(second));
  receiveDetailImperative(streamPage(second, 0));
  receiveDetailImperative(streamPage(second, 1));
  assert.equal(demandDetailValue(KEY).status, 'ready', 'fresh owner assembles normally');
});

test('gap or out-of-order deltas rebase: new owner, tombstoned subscription id, fresh baseline', () => {
  const posts = install();
  openDetailSubscription({ detailKey: KEY, address: ADDRESS });
  const stream = makeStream(KEY, 'sub-1');
  receiveDetailImperative(streamStart(stream));
  receiveDetailImperative(streamPage(stream, 0));
  receiveDetailImperative(streamPage(stream, 1));
  assert.equal(demandDetailValue(KEY).status, 'ready');

  // Delta declares base 3 while the record is at revision 1 → gap.
  receiveDetailImperative(streamDelta(stream, 3, 4, [{ op: 'set', path: ['exitCode'], value: 0 }]));
  assert.equal(subscribePosts(posts).length, 2, 'rebase re-subscribes');
  assert.equal(demandDetailValue(KEY).status, 'pending', 'value discarded during rebase');

  // A late start for the retired subscription id can never bind the owner.
  const staleStart = makeStream(KEY, 'sub-1', childValue(), 1, 1);
  receiveDetailImperative(streamStart(staleStart));
  assert.equal(demandDetailValue(KEY).status, 'pending', 'tombstoned id did not bind');

  const rebased = makeStream(KEY, 'sub-2', childValue({ exitCode: 0 }), 2, 5);
  receiveDetailImperative(streamStart(rebased));
  receiveDetailImperative(streamPage(rebased, 0));
  receiveDetailImperative(streamPage(rebased, 1));
  const ready = demandDetailValue(KEY);
  assert.equal(ready.status, 'ready');
  if (ready.status === 'ready') {
    assert.equal((ready.value as Record<string, unknown>).exitCode, 0);
  }
});

test('terminal keeps the durable value and ref; terminal without a value re-subscribes for the durable answer', () => {
  const posts = install();
  openDetailSubscription({ detailKey: KEY, address: ADDRESS });
  const stream = delivered('sub-1');
  receiveDetailImperative({
    type: 'detail.terminal',
    ...route('sub-1'),
    revision: 2,
    durableRef: { sessionPath: '/s.jsonl', messageId: 'msg-1', key: 'durable:subagent:msg-1:tool-1', kind: 'tool-result', source: 'durable', sizeBytes: 10, summary: 'done', available: true },
  });
  assert.equal(demandDetailValue(KEY).status, 'ready', 'terminal value remains renderable');
  assert.equal(subscribePosts(posts).length, 1, 'no re-subscribe when the live value is intact');

  // Terminal before any page arrived: the live baseline was never assembled,
  // so the webview re-subscribes and the host answers from the durable store.
  clearDetailSubscriptionStore();
  const posts2 = install();
  openDetailSubscription({ detailKey: KEY, address: ADDRESS });
  const early = makeStream(KEY, 'sub-1', childValue(), 2, 1);
  receiveDetailImperative(streamStart(early));
  receiveDetailImperative({
    type: 'detail.terminal',
    ...route('sub-1'),
    revision: 1,
    durableRef: { sessionPath: '/s.jsonl', messageId: 'msg-1', key: 'durable:subagent:msg-1:tool-1', kind: 'tool-result', source: 'durable', sizeBytes: 10, summary: 'done', available: true },
  });
  assert.equal(subscribePosts(posts2).length, 2, 'terminal without value re-subscribes');
});

test('error is explicit, and retry mints a fresh owner with a new attempt', () => {
  const posts = install();
  openDetailSubscription({ detailKey: KEY, address: ADDRESS });
  receiveDetailImperative({
    type: 'detail.error',
    ...route('sub-1'),
    code: 'NOT_FOUND',
    message: 'gone',
    retryable: false,
  });
  assert.equal(demandDetailValue(KEY).status, 'pending');
  assert.equal(subscribePosts(posts).length, 1, 'error does not auto-re-subscribe');

  // Retry: same address, new owner.
  openDetailSubscription({ detailKey: KEY, address: ADDRESS });
  assert.equal(subscribePosts(posts).length, 2);
  const stream = delivered('sub-2');
  assert.equal(demandDetailValue(KEY).status, 'ready');
  void stream;
});

test('route and generation mismatches are dropped before they touch a record', () => {
  const posts = install();
  openDetailSubscription({ detailKey: KEY, address: ADDRESS });
  const stream = makeStream(KEY, 'sub-1');
  receiveDetailImperative(streamStart(stream));
  receiveDetailImperative(streamPage(stream, 0));
  receiveDetailImperative(streamPage(stream, 1));

  // Wrong view generation.
  receiveDetailImperative({ ...streamDelta(stream, 1, 2, [{ op: 'set', path: ['exitCode'], value: 0 }]), viewGeneration: 99 });
  // Wrong host instance.
  receiveDetailImperative({ ...streamDelta(stream, 1, 2, [{ op: 'set', path: ['exitCode'], value: 0 }]), hostInstanceId: 'other-host' });
  // Wrong subscription id.
  receiveDetailImperative({ ...streamDelta(stream, 1, 2, [{ op: 'set', path: ['exitCode'], value: 0 }]), subscriptionId: 'sub-other' });
  // Wrong detail key.
  receiveDetailImperative({ ...streamDelta(stream, 1, 2, [{ op: 'set', path: ['exitCode'], value: 0 }]), detailKey: 'subagent:other' });

  const ready = demandDetailValue(KEY);
  assert.equal(ready.status, 'ready');
  if (ready.status === 'ready') {
    assert.equal((ready.value as Record<string, unknown>).exitCode, -1, 'no rejected delta was applied');
  }
});

test('corrupt pages (checksum, byte range, code-point totals) are rejected and force a fresh baseline', () => {
  const posts = install();
  openDetailSubscription({ detailKey: KEY, address: ADDRESS });
  const stream = makeStream(KEY, 'sub-1');
  receiveDetailImperative(streamStart(stream));

  // Corrupt checksum.
  receiveDetailImperative(streamPage(stream, 0, { checksum: '0'.repeat(64) }));
  // Wrong startByte.
  receiveDetailImperative(streamPage(stream, 1, { payload: { ...stream.pages[1]!.payload, startByte: 1 } }));
  assert.equal(demandDetailValue(KEY).status, 'pending');
  assert.equal(subscribePosts(posts).length, 2, 'unassemblable baseline rebases');

  // Start with a lying totalCodePoints — every page is then unassemblable.
  const lying = makeStream(KEY, 'sub-2');
  receiveDetailImperative(streamStart(lying, { totalCodePoints: 999 }));
  receiveDetailImperative(streamPage(lying, 0));
  receiveDetailImperative(streamPage(lying, 1));
  assert.equal(demandDetailValue(KEY).status, 'pending');
  assert.equal(subscribePosts(posts).length, 3, 'lying start totals also rebase');
});

test('tiny budgets evict; visible assembling records refetch evicted pages via fetchPages', () => {
  const posts = install();
  // Budget holds 2 pages globally. Two 2-page baselines stream in while both
  // records are still assembling (no demand yet): the first record's pages
  // are evicted to their last-resort class, then re-fetched exactly once
  // through `detail.fetchPages` once the renderer demands the value.
  setDetailStoreBudgets({ maxGlobalPages: 2, maxGlobalBytes: 10_000_000, maxPagesPerSubscription: 2 });
  const keyA = 'subagent:msg-1:tool-a';
  const keyB = 'subagent:msg-1:tool-b';
  openDetailSubscription({ detailKey: keyA, address: ADDRESS });
  openDetailSubscription({ detailKey: keyB, address: ADDRESS });
  const streamA = makeStream(keyA, 'sub-a', childValue(), 2, 1);
  const streamB = makeStream(keyB, 'sub-b', childValue(), 2, 1);
  receiveDetailImperative(streamStart(streamA));
  receiveDetailImperative(streamPage(streamA, 0));
  receiveDetailImperative(streamPage(streamA, 1));
  receiveDetailImperative(streamStart(streamB));
  receiveDetailImperative(streamPage(streamB, 0));
  receiveDetailImperative(streamPage(streamB, 1));

  // 4 pages > 2: A's pages were evicted while A was still assembling.
  assert.equal(demandDetailValue(keyA).status, 'pending');
  const fetches = fetchPagesPosts(posts);
  assert.equal(fetches.length, 2, 'each evicted page is refetched exactly once');
  assert.deepEqual(fetches.map((post) => post.ref.pageIndex).sort(), [0, 1]);

  // Refetch delivery: each arrival re-balances the budget (B loses a page in
  // turn, then re-fetches on ITS demand).
  receiveDetailImperative(streamPage(streamA, 0));
  receiveDetailImperative(streamPage(streamA, 1));
  assert.equal(demandDetailValue(keyA).status, 'ready');

  assert.equal(demandDetailValue(keyB).status, 'pending', 'B refetches only on demand');
  const fetchesB = fetchPagesPosts(posts);
  assert.equal(fetchesB.length, 4, 'B refetches its two evicted pages');
  receiveDetailImperative(streamPage(streamB, 0));
  receiveDetailImperative(streamPage(streamB, 1));
  assert.equal(demandDetailValue(keyB).status, 'ready');

  // A second demand does not re-fetch already-present pages.
  assert.equal(demandDetailValue(keyA).status, 'ready');
  assert.equal(fetchPagesPosts(posts).length, 4);
});

test('visible pinning: assembled records lose their transport pages first, assembling records last', () => {
  const posts = install();
  setDetailStoreBudgets({ maxGlobalPages: 2, maxGlobalBytes: 10_000_000, maxPagesPerSubscription: 2 });
  const keyA = 'subagent:msg-1:tool-a';
  const keyB = 'subagent:msg-1:tool-b';
  openDetailSubscription({ detailKey: keyA, address: ADDRESS });
  openDetailSubscription({ detailKey: keyB, address: ADDRESS });

  const streamA = makeStream(keyA, 'sub-a', childValue(), 2, 1);
  receiveDetailImperative(streamStart(streamA));
  receiveDetailImperative(streamPage(streamA, 0));
  receiveDetailImperative(streamPage(streamA, 1));
  assert.equal(demandDetailValue(keyA).status, 'ready', 'A assembled');

  const streamB = makeStream(keyB, 'sub-b', childValue(), 2, 1);
  receiveDetailImperative(streamStart(streamB));
  receiveDetailImperative(streamPage(streamB, 0));
  receiveDetailImperative(streamPage(streamB, 1));

  // 4 pages, budget 2: A (value ready) and B (assembling) are both visible.
  // A's transport pages are the first eviction class.
  assert.equal(demandDetailValue(keyA).status, 'ready', 'A keeps rendering from its value');
  const fetches = fetchPagesPosts(posts);
  assert.equal(fetches.length, 0, 'assembled A needs no refetch');
  assert.equal(demandDetailValue(keyB).status, 'ready', 'B was pinned while assembling and kept all its pages');
});

test('cursor survives collapse and is re-sent with the next subscribe', () => {
  const posts = install();
  openDetailSubscription({ detailKey: KEY, address: ADDRESS });
  const stream = delivered('sub-1');
  assert.equal(demandDetailValue(KEY).status, 'ready');
  void stream;

  closeDetailSubscription(KEY, 'collapse');
  openDetailSubscription({ detailKey: KEY, address: ADDRESS });
  const subscribes = subscribePosts(posts);
  assert.equal(subscribes.length, 2);
  assert.deepEqual(subscribes[1]!.cursor, { revision: 1 }, 'cheap cursor metadata survives collapse');
});

test('generation reset (host restart) discards records, pages, tombstones, and cursors', () => {
  const posts = install();
  openDetailSubscription({ detailKey: KEY, address: ADDRESS });
  const stream = delivered('sub-1');
  assert.equal(demandDetailValue(KEY).status, 'ready');
  closeDetailSubscription(KEY, 'collapse');

  assert.deepEqual(getDetailStoreDebugState(), { records: 0, pages: 0, pageBytes: 0, valueBytes: 0, tombstones: 1, cursors: 1 });

  clearDetailSubscriptionStore();
  assert.deepEqual(getDetailStoreDebugState(), { records: 0, pages: 0, pageBytes: 0, valueBytes: 0, tombstones: 0, cursors: 0 });
  // A late frame after the restart can never recreate state.
  receiveDetailImperative(streamPage(stream, 0));
  assert.deepEqual(getDetailStoreDebugState(), { records: 0, pages: 0, pageBytes: 0, valueBytes: 0, tombstones: 0, cursors: 0 });
});

test('receiveDetailImperative for an unknown or never-opened key is a no-op', () => {
  const posts = install();
  receiveDetailImperative(streamStart(makeStream(KEY, 'sub-1')));
  receiveDetailImperative(streamPage(makeStream(KEY, 'sub-1'), 0));
  assert.deepEqual(getDetailStoreDebugState(), { records: 0, pages: 0, pageBytes: 0, valueBytes: 0, tombstones: 0, cursors: 0 });
  assert.equal(posts.length, 0);
});

test('resolveDetailTarget canonicalizes the addressed child inside an envelope', () => {
  const child = childValue({ exitCode: 0 });
  const envelope = { schemaVersion: 1, details: { c1: child } };
  const resolved = resolveDetailTarget(envelope, ADDRESS);
  assert.equal(resolved, child);

  const wrongAddress: LiveSubagentDetailAddress = { ...ADDRESS, lineage: [{ childId: 'other', spawningToolCallId: 'rt1', attemptId: 'a1' }] };
  assert.equal(resolveDetailTarget(envelope, wrongAddress), undefined, 'lineage mismatch does not resolve');

  assert.equal(resolveDetailTarget('not an object', ADDRESS), undefined);
  assert.equal(resolveDetailTarget(child, ADDRESS), child, 'direct child record resolves');
});

test('address change replaces the owner instead of reusing it', () => {
  const posts = install();
  openDetailSubscription({ detailKey: KEY, address: ADDRESS });
  const otherAddress: LiveSubagentDetailAddress = {
    ...ADDRESS,
    lineage: [{ childId: 'c2', spawningToolCallId: 'rt1', attemptId: 'a1' }],
  };
  openDetailSubscription({ detailKey: KEY, address: otherAddress });
  assert.equal(subscribePosts(posts).length, 2);
  assert.deepEqual(subscribePosts(posts)[1]!.address, otherAddress);
});

test('delta against an evicted (unassembled) value rebases instead of replaying', () => {
  const posts = install();
  setDetailStoreBudgets({ maxGlobalPages: 1, maxGlobalBytes: 10_000_000, maxPagesPerSubscription: 1 });
  openDetailSubscription({ detailKey: KEY, address: ADDRESS });
  const stream = makeStream(KEY, 'sub-1', childValue(), 2, 1);
  receiveDetailImperative(streamStart(stream));
  receiveDetailImperative(streamPage(stream, 0));
  // page 1 evicts page 0; the value never assembled.
  receiveDetailImperative(streamPage(stream, 1));
  // A delta on the correct base still cannot apply to a missing value.
  receiveDetailImperative(streamDelta(stream, 1, 2, [{ op: 'set', path: ['exitCode'], value: 0 }]));
  assert.equal(subscribePosts(posts).length, 2, 'gap rebase instead of replaying a delta over nothing');
});
