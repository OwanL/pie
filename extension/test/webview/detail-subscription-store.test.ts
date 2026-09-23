import assert from 'node:assert/strict';
import test from 'node:test';

import { installDom } from '../_helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import type { HostDetailRoute, LiveSubagentDetailAddress, WebviewToHostMessage } from '../../src/shared/protocol';
import type { DetailPagePayload } from '../../src/shared/protocol/subagent-detail';
import type { JsonStructuralPatchOperation } from '../../src/shared/json-structural-patch';
import type { DetailStreamMessage } from '../../src/webview/panel/transcript/detail-subscription-store';
import {
  clearDetailSubscriptionStore,
  closeDetailSubscription,
  DETAIL_SUBSCRIPTION_LOAD_TIMEOUT_MS as DETAIL_LOAD_TIMEOUT_MS,
  demandDetailValue,
  getDetailStoreDebugState,
  openDetailSubscription,
  receiveDetailImperative,
  resetDetailStoreBudgets,
  resolveDetailTarget,
  setDetailStoreBudgets,
  setDetailStoreContext,
  sha256Hex,
  useDetailSubscription,
  type DetailSubscriptionHandle,
} from '../../src/webview/panel/transcript/detail-subscription-store';

const KEY = 'subagent:msg-1:tool-1';

const ADDRESS: LiveSubagentDetailAddress = {
  sessionPath: '/s.jsonl',
  turnId: 't1',
  rootToolCallId: 'rt1',
  rootAttemptId: 'ra1',
  lineage: [{ childId: 'c1', spawningToolCallId: 'rt1', attemptId: 'a1' }],
};

function route(subscriptionId: string, detailKey = KEY, detailAttempt = 1): HostDetailRoute {
  return {
    hostInstanceId: 'h1',
    hostGeneration: 0,
    viewGeneration: 1,
    rendererId: 'renderer-1',
    rendererGeneration: 1,
    backendGeneration: 1,
    coordinatorGeneration: 1,
    workerId: 'w1',
    workerGeneration: 1,
    detailKey,
    detailAttempt,
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
  detailAttempt: number;
  value: unknown;
  pages: PageFixture[];
}

function makeStream(
  detailKey: string,
  subscriptionId: string,
  value: unknown = childValue(),
  pageCount = 2,
  baselineRevision = 1,
  detailAttempt = 1,
): Stream {
  return {
    detailKey,
    subscriptionId,
    baselineRevision,
    detailAttempt,
    value,
    pages: encodePages(value, pageCount),
  };
}

function streamStart(stream: Stream, overrides?: { totalCodePoints?: number; totalBytes?: number }): DetailStreamMessage {
  return {
    type: 'detail.start',
    ...route(stream.subscriptionId, stream.detailKey, stream.detailAttempt),
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
    ...route(stream.subscriptionId, stream.detailKey, stream.detailAttempt),
    ref: { baselineRevision: stream.baselineRevision, pageIndex: index, pageCount: stream.pages.length },
    payload: overrides?.payload ?? page.payload,
    payloadBytes: overrides?.payloadBytes ?? page.payloadBytes,
    checksum: overrides?.checksum ?? page.checksum,
  };
}

function streamDelta(stream: Stream, baseRevision: number, revision: number, operations: JsonStructuralPatchOperation[]): DetailStreamMessage {
  return {
    type: 'detail.delta',
    ...route(stream.subscriptionId, stream.detailKey, stream.detailAttempt),
    baseRevision,
    revision,
    operations,
  };
}

function install(posts: WebviewToHostMessage[] = []): WebviewToHostMessage[] {
  setDetailStoreContext({
    hostInstanceId: 'h1',
    viewGeneration: 1,
    rendererId: 'renderer-1',
    rendererGeneration: 1,
    postMessage: (message) => posts.push(message),
  });
  return posts;
}

function delivered(subscriptionId: string, detailKey = KEY, detailAttempt = 1): Stream {
  const stream = makeStream(detailKey, subscriptionId, childValue(), 2, 1, detailAttempt);
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

function mountSubscriptionProbe(): {
  host: HTMLElement;
  get handle(): DetailSubscriptionHandle;
  update: (expanded: boolean) => void;
  unmount: () => void;
} {
  const host = document.createElement('div');
  document.body.appendChild(host);
  let handle: DetailSubscriptionHandle | undefined;
  function Probe({ expanded }: { expanded: boolean }) {
    handle = useDetailSubscription({ detailKey: KEY, address: ADDRESS, expanded });
    const value = handle.value as Record<string, unknown> | null;
    return h('div', null,
      h('span', null, `${handle.status}:${handle.error?.message ?? ''}`),
      value !== null ? h('span', null, `value:${String(value.task ?? '')}`) : null,
      handle.error?.retryable ? h('button', { type: 'button', onClick: handle.retry }, 'Retry') : null,
    );
  }
  const update = (expanded: boolean) => act(() => render(h(Probe, { expanded }), host));
  update(true);
  return {
    host,
    get handle() {
      if (!handle) throw new Error('subscription hook has not rendered');
      return handle;
    },
    update,
    unmount: () => {
      act(() => render(null, host));
      host.remove();
    },
  };
}

function installFakeTimers(): {
  advance: (ms: number) => void;
  activeCount: () => number;
  captureCallbacks: () => Array<() => void>;
  restore: () => void;
} {
  interface FakeTimer { due: number; callback: () => void }
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalWindowSetTimeout = window.setTimeout;
  const originalWindowClearTimeout = window.clearTimeout;
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, FakeTimer>();
  const fakeSetTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const id = ++nextId;
    timers.set(id, { due: now + (delay ?? 0), callback: () => callback(...args) });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const fakeClearTimeout = ((timer?: ReturnType<typeof setTimeout>) => {
    timers.delete(Number(timer));
  }) as typeof clearTimeout;
  globalThis.setTimeout = window.setTimeout = fakeSetTimeout;
  globalThis.clearTimeout = window.clearTimeout = fakeClearTimeout;
  return {
    advance(ms) {
      now += ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.due <= now).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) return;
        timers.delete(next[0]);
        next[1].callback();
      }
    },
    activeCount: () => timers.size,
    captureCallbacks: () => [...timers.values()].map((timer) => timer.callback),
    restore() {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      window.setTimeout = originalWindowSetTimeout;
      window.clearTimeout = originalWindowClearTimeout;
    },
  };
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

test('a delta immediately following the complete baseline assembles before patching', () => {
  const posts = install();
  setDetailStoreBudgets({ maxGlobalPages: 10, maxGlobalBytes: 10_000_000, maxPagesPerSubscription: 1 });
  openDetailSubscription({ detailKey: KEY, address: ADDRESS });
  const stream = makeStream(KEY, 'sub-1');
  receiveDetailImperative(streamStart(stream));
  receiveDetailImperative(streamPage(stream, 0));
  receiveDetailImperative(streamPage(stream, 1));

  // No render-time demand occurs between the final page and the delta. The
  // FIFO baseline is complete, so the store must assemble it synchronously
  // instead of treating the still-null derived cache as a transport gap.
  receiveDetailImperative(streamDelta(stream, 1, 2, [{ op: 'set', path: ['exitCode'], value: 0 }]));

  assert.equal(subscribePosts(posts).length, 1, 'a complete baseline does not spuriously re-subscribe');
  assert.equal(getDetailStoreDebugState().pages <= 1, true, 'synchronous assembly restores the page-cache bound');
  const ready = demandDetailValue(KEY);
  assert.equal(ready.status, 'ready');
  if (ready.status === 'ready') {
    assert.equal((ready.value as Record<string, unknown>).exitCode, 0);
  }
});

test('a delayed pre-start frame cannot bind a re-expanded owner attempt', () => {
  const posts = install();
  openDetailSubscription({ detailKey: KEY, address: ADDRESS });
  const retired = makeStream(KEY, 'sub-old', childValue(), 2, 1, 1);

  closeDetailSubscription(KEY, 'collapse');
  openDetailSubscription({ detailKey: KEY, address: ADDRESS });
  assert.equal(subscribePosts(posts).at(-1)?.detailAttempt, 2);

  receiveDetailImperative(streamStart(retired));
  const replacement = makeStream(KEY, 'sub-new', childValue({ exitCode: 0 }), 2, 1, 2);
  receiveDetailImperative(streamStart(replacement));
  receiveDetailImperative(streamPage(replacement, 0));
  receiveDetailImperative(streamPage(replacement, 1));

  const ready = demandDetailValue(KEY);
  assert.equal(ready.status, 'ready');
  if (ready.status === 'ready') assert.equal((ready.value as Record<string, unknown>).exitCode, 0);
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

  const second = makeStream(KEY, 'sub-2', childValue(), 2, 1, 2);
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

  const rebased = makeStream(KEY, 'sub-2', childValue({ exitCode: 0 }), 2, 5, 2);
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

test('terminal synchronous assembly restores transport cache bounds', () => {
  const posts = install();
  setDetailStoreBudgets({ maxGlobalPages: 1, maxGlobalBytes: 10_000_000, maxPagesPerSubscription: 10 });
  openDetailSubscription({ detailKey: KEY, address: ADDRESS });
  const stream = makeStream(KEY, 'sub-1', childValue(), 2, 1, 1);
  receiveDetailImperative(streamStart(stream));
  receiveDetailImperative(streamPage(stream, 0));
  receiveDetailImperative(streamPage(stream, 1));
  assert.equal(getDetailStoreDebugState().pages, 2, 'assembling visible baseline stays pinned');

  receiveDetailImperative({
    type: 'detail.terminal',
    ...route('sub-1', KEY, 1),
    revision: 1,
    durableRef: { sessionPath: '/s.jsonl', messageId: 'msg-1', key: 'durable:subagent:msg-1:tool-1', kind: 'tool-result', source: 'durable', sizeBytes: 10, summary: 'done', available: true },
  });

  assert.equal(demandDetailValue(KEY).status, 'ready');
  assert.equal(getDetailStoreDebugState().pages <= 1, true, 'terminal assembly re-applies the global page bound');
  assert.equal(subscribePosts(posts).length, 1);
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
  const stream = delivered('sub-2', KEY, 2);
  assert.equal(demandDetailValue(KEY).status, 'ready');
  void stream;
});

test('route and generation mismatches are dropped before they touch a record', () => {
  const posts = install();
  openDetailSubscription({ detailKey: KEY, address: ADDRESS });
  const stream = makeStream(KEY, 'sub-1');

  // A pre-start frame for another renderer must not bind this pending owner.
  receiveDetailImperative({ ...streamStart(stream), rendererId: 'other-renderer', rendererGeneration: 99 });
  receiveDetailImperative(streamStart(stream));
  receiveDetailImperative(streamPage(stream, 0));
  receiveDetailImperative(streamPage(stream, 1));

  // Wrong view generation.
  receiveDetailImperative({ ...streamDelta(stream, 1, 2, [{ op: 'set', path: ['exitCode'], value: 0 }]), viewGeneration: 99 });
  // Wrong host instance.
  receiveDetailImperative({ ...streamDelta(stream, 1, 2, [{ op: 'set', path: ['exitCode'], value: 0 }]), hostInstanceId: 'other-host' });
  // Wrong subscription id.
  receiveDetailImperative({ ...streamDelta(stream, 1, 2, [{ op: 'set', path: ['exitCode'], value: 0 }]), subscriptionId: 'sub-other' });
  // Wrong webview owner attempt.
  receiveDetailImperative({ ...streamDelta(stream, 1, 2, [{ op: 'set', path: ['exitCode'], value: 0 }]), detailAttempt: 99 });
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
  const lying = makeStream(KEY, 'sub-2', childValue(), 2, 1, 2);
  receiveDetailImperative(streamStart(lying, { totalCodePoints: 999 }));
  receiveDetailImperative(streamPage(lying, 0));
  receiveDetailImperative(streamPage(lying, 1));
  assert.equal(demandDetailValue(KEY).status, 'pending');
  assert.equal(subscribePosts(posts).length, 3, 'lying start totals also rebase');
});

test('a baseline larger than the per-subscription page cache cap stays pinned until assembly', () => {
  const posts = install();
  setDetailStoreBudgets({ maxGlobalPages: 10, maxGlobalBytes: 10_000_000, maxPagesPerSubscription: 1 });
  openDetailSubscription({ detailKey: KEY, address: ADDRESS });
  const stream = makeStream(KEY, 'sub-1', childValue(), 2, 1);
  receiveDetailImperative(streamStart(stream));
  receiveDetailImperative(streamPage(stream, 0));
  receiveDetailImperative(streamPage(stream, 1));

  const ready = demandDetailValue(KEY);
  assert.equal(ready.status, 'ready', 'the manifest can assemble once even when it exceeds the transport cache cap');
  assert.equal(fetchPagesPosts(posts).length, 0, 'assembly does not enter an impossible evict/refetch loop');
  assert.equal(subscribePosts(posts).length, 1, 'assembly does not trigger a rebase');
});

test('a baseline larger than the global page cache stays pinned until assembly', () => {
  const posts = install();
  setDetailStoreBudgets({ maxGlobalPages: 1, maxGlobalBytes: 10_000_000, maxPagesPerSubscription: 10 });
  openDetailSubscription({ detailKey: KEY, address: ADDRESS });
  const stream = makeStream(KEY, 'sub-1', childValue(), 2, 1);
  receiveDetailImperative(streamStart(stream));
  receiveDetailImperative(streamPage(stream, 0));
  receiveDetailImperative(streamPage(stream, 1));

  const ready = demandDetailValue(KEY);
  assert.equal(ready.status, 'ready', 'page-count pressure cannot make a single manifest impossible to assemble');
  assert.equal(fetchPagesPosts(posts).length, 0);
  assert.equal(getDetailStoreDebugState().pages <= 1, true, 'pages return to the global cap after assembly');
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
  const streamA = makeStream(keyA, 'sub-a', childValue(), 2, 1, 1);
  const streamB = makeStream(keyB, 'sub-b', childValue(), 2, 1, 2);
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

  const streamB = makeStream(keyB, 'sub-b', childValue(), 2, 1, 2);
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

test('a mounted expanded hook reopens its owner after the host advances view generation', () => {
  const posts = install();
  const probe = mountSubscriptionProbe();
  try {
    assert.equal(subscribePosts(posts).length, 1);
    act(() => setDetailStoreContext({
      hostInstanceId: 'h1', viewGeneration: 2, rendererId: 'renderer-1', rendererGeneration: 1,
      postMessage: (message) => { posts.push(message); },
    }));

    const subscribes = subscribePosts(posts);
    assert.equal(subscribes.length, 2, 'the retained expanded card re-subscribes under the new view owner');
    assert.equal(subscribes[1]?.viewGeneration, 2);
    assert.equal(subscribes[1]?.detailAttempt, 1, 'the new route starts a fresh attempt namespace');
    assert.equal(probe.handle.status, 'subscribing');

    const oldRouteStart = streamStart(makeStream(KEY, 'old-subscription'));
    act(() => receiveDetailImperative(oldRouteStart));
    assert.equal(probe.handle.status, 'subscribing', 'a pre-switch start cannot bind the new route');
  } finally {
    probe.unmount();
  }
});

test('renderer reconnect invalidates an owner even when the view generation is unchanged', () => {
  const posts = install();
  openDetailSubscription({ detailKey: KEY, address: ADDRESS });
  delivered('sub-1');
  assert.equal(demandDetailValue(KEY).status, 'ready');

  setDetailStoreContext({
    hostInstanceId: 'h1',
    viewGeneration: 1,
    rendererId: 'renderer-2',
    rendererGeneration: 2,
    postMessage: (message) => { posts.push(message); },
  });

  assert.equal(demandDetailValue(KEY).status, 'pending');
  assert.deepEqual(getDetailStoreDebugState(), {
    records: 0,
    pages: 0,
    pageBytes: 0,
    valueBytes: 0,
    tombstones: 0,
    cursors: 1,
  });

  openDetailSubscription({ detailKey: KEY, address: ADDRESS });
  const replacement = subscribePosts(posts).at(-1)!;
  assert.equal(replacement.viewGeneration, 1);
  assert.deepEqual(replacement.cursor, { revision: 1 });
});

test('a rejected subscribe reaches a retryable hook error and manual retry mints a fresh attempt', async () => {
  const posts: WebviewToHostMessage[] = [];
  setDetailStoreContext({
    hostInstanceId: 'h1',
    viewGeneration: 1,
    rendererId: 'renderer-1',
    rendererGeneration: 1,
    postMessage: (message) => {
      posts.push(message);
      return subscribePosts(posts).length > 1;
    },
  });
  const probe = mountSubscriptionProbe();
  try {
    assert.equal(probe.handle.status, 'error');
    assert.equal(probe.handle.error?.code, 'UNAVAILABLE');
    assert.equal(probe.handle.error?.retryable, true);
    assert.match(probe.host.textContent ?? '', /error:.*transcript/i);
    assert.equal(subscribePosts(posts).length, 1);

    const retry = probe.host.querySelector('button');
    assert.equal(retry?.textContent, 'Retry');
    act(() => retry?.click());
    assert.equal(subscribePosts(posts).length, 2);
    assert.equal(subscribePosts(posts)[1]?.detailAttempt, 2);
    assert.equal(probe.handle.status, 'subscribing');

    // The host answers attempt 2 with a fresh baseline: the hook must surface
    // the actually-loaded transcript value, not merely stop at subscribing.
    const replacement = makeStream(KEY, 'sub-2', childValue({ exitCode: 0, task: 'retry payload' }), 2, 1, 2);
    act(() => {
      receiveDetailImperative(streamStart(replacement));
      receiveDetailImperative(streamPage(replacement, 0));
      receiveDetailImperative(streamPage(replacement, 1));
    });
    assert.equal(probe.handle.status, 'active', 'attempt 2 loads to active');
    assert.equal(probe.handle.error, null, 'a loaded baseline clears the prior error');
    assert.equal((probe.handle.value as Record<string, unknown>).exitCode, 0);
    assert.equal((probe.handle.value as Record<string, unknown>).task, 'retry payload');
    assert.match(probe.host.textContent ?? '', /value:retry payload/, 'the rendered transcript shows the loaded value');
    assert.equal(subscribePosts(posts).length, 2, 'a successful attempt 2 does not re-subscribe');
  } finally {
    probe.unmount();
  }
});

test('a timed-out attempt recovers to a loaded value only through manual retry at the hook seam', async () => {
  const timers = installFakeTimers();
  const posts = install();
  const probe = mountSubscriptionProbe();
  try {
    // Timeout: no start ever arrives for attempt 1.
    await act(async () => timers.advance(DETAIL_LOAD_TIMEOUT_MS));
    assert.equal(probe.handle.status, 'error');
    assert.equal(probe.handle.error?.retryable, true);
    assert.equal(unsubscribePosts(posts).length, 1, 'the timed-out host owner is released');
    assert.equal(timers.activeCount(), 0);

    const retry = probe.host.querySelector('button');
    assert.equal(retry?.textContent, 'Retry');
    act(() => retry?.click());
    assert.equal(subscribePosts(posts).length, 2);
    assert.equal(subscribePosts(posts)[1]?.detailAttempt, 2);
    assert.equal(probe.handle.status, 'subscribing');

    // Attempt 2 delivers a complete baseline and the hook renders its value.
    const attempt2 = makeStream(KEY, 'sub-2', childValue({ exitCode: 0, task: 'after timeout' }), 2, 1, 2);
    act(() => {
      receiveDetailImperative(streamStart(attempt2));
      receiveDetailImperative(streamPage(attempt2, 0));
      receiveDetailImperative(streamPage(attempt2, 1));
    });
    assert.equal(probe.handle.status, 'active');
    assert.equal(probe.handle.error, null);
    assert.equal((probe.handle.value as Record<string, unknown>).exitCode, 0);
    assert.equal((probe.handle.value as Record<string, unknown>).task, 'after timeout');
    assert.match(probe.host.textContent ?? '', /value:after timeout/, 'the rendered transcript shows the recovered value');
    assert.equal(unsubscribePosts(posts).length, 1, 'no spurious unsubscribe after the retry');
    await act(async () => timers.advance(DETAIL_LOAD_TIMEOUT_MS * 3));
    assert.equal(probe.handle.status, 'active', 'the recovered subscription has no pending deadline');
    assert.equal(timers.activeCount(), 0);
  } finally {
    probe.unmount();
    timers.restore();
  }
});

test('a missing start times out to a retryable error without automatically resubscribing', async () => {
  const timers = installFakeTimers();
  const posts = install();
  const probe = mountSubscriptionProbe();
  try {
    assert.equal(probe.handle.status, 'subscribing');
    assert.equal(timers.activeCount(), 1);
    await act(async () => timers.advance(DETAIL_LOAD_TIMEOUT_MS));
    assert.equal(probe.handle.status, 'error');
    assert.equal(probe.handle.error?.retryable, true);
    assert.equal(subscribePosts(posts).length, 1, 'a timeout requires explicit user retry');
    assert.equal(unsubscribePosts(posts).length, 1, 'timed-out host owner is released best-effort');
    assert.equal(timers.activeCount(), 0);
  } finally {
    probe.unmount();
    timers.restore();
  }
});

test('a partial baseline gets a bounded inactivity deadline that advances with valid pages', async () => {
  const timers = installFakeTimers();
  const posts = install();
  const probe = mountSubscriptionProbe();
  try {
    const stream = makeStream(KEY, 'sub-1', childValue(), 2, 1, 1);
    await act(async () => receiveDetailImperative(streamStart(stream)));
    await act(async () => timers.advance(DETAIL_LOAD_TIMEOUT_MS - 10_000));
    await act(async () => receiveDetailImperative(streamPage(stream, 0)));
    assert.equal(probe.handle.status, 'loading');

    await act(async () => timers.advance(DETAIL_LOAD_TIMEOUT_MS - 1));
    assert.equal(probe.handle.status, 'loading', 'a valid page resets the loading deadline');
    await act(async () => timers.advance(1));
    assert.equal(probe.handle.status, 'error');
    assert.equal(probe.handle.error?.retryable, true);
    assert.equal(subscribePosts(posts).length, 1, 'a stalled baseline is not retried automatically');
    assert.equal(unsubscribePosts(posts).length, 1);
  } finally {
    probe.unmount();
    timers.restore();
  }
});

test('a rebase that never receives its replacement start becomes a manual-retry error', async () => {
  const timers = installFakeTimers();
  const posts = install();
  const probe = mountSubscriptionProbe();
  try {
    const first = makeStream(KEY, 'sub-1', childValue(), 2, 1, 1);
    await act(async () => {
      receiveDetailImperative(streamStart(first));
      receiveDetailImperative(streamPage(first, 0));
      receiveDetailImperative(streamPage(first, 1));
    });
    assert.equal(probe.handle.status, 'active');

    await act(async () => receiveDetailImperative({
      type: 'detail.rebase', ...route('sub-1'), currentRevision: 1, reason: 'backpressure',
    }));
    assert.equal(probe.handle.status, 'subscribing');
    assert.equal(subscribePosts(posts).length, 2);
    assert.equal(subscribePosts(posts)[1]?.detailAttempt, 2);

    await act(async () => timers.advance(DETAIL_LOAD_TIMEOUT_MS));
    assert.equal(probe.handle.status, 'error');
    assert.equal(probe.handle.error?.retryable, true);
    assert.equal(subscribePosts(posts).length, 2, 'a rebase timeout does not start an automatic retry loop');
  } finally {
    probe.unmount();
    timers.restore();
  }
});

test('an evicted baseline page fetch that never returns is bounded by the loading deadline', async () => {
  const timers = installFakeTimers();
  const posts = install();
  const keyB = 'subagent:msg-1:tool-b';
  setDetailStoreBudgets({ maxGlobalPages: 2, maxGlobalBytes: 10_000_000, maxPagesPerSubscription: 2 });
  try {
    openDetailSubscription({ detailKey: KEY, address: ADDRESS });
    const first = makeStream(KEY, 'sub-1', childValue(), 2, 1, 1);
    receiveDetailImperative(streamStart(first));
    receiveDetailImperative(streamPage(first, 0));
    receiveDetailImperative(streamPage(first, 1));

    openDetailSubscription({ detailKey: keyB, address: ADDRESS });
    const second = makeStream(keyB, 'sub-2', childValue(), 2, 1, 2);
    receiveDetailImperative(streamStart(second));
    receiveDetailImperative(streamPage(second, 0));
    receiveDetailImperative(streamPage(second, 1));

    const probe = mountSubscriptionProbe();
    try {
      assert.equal(probe.handle.status, 'loading');
      assert.equal(fetchPagesPosts(posts).length, 2);
      await act(async () => timers.advance(DETAIL_LOAD_TIMEOUT_MS));
      assert.equal(probe.handle.status, 'error');
      assert.equal(probe.handle.error?.retryable, true);
      assert.equal(unsubscribePosts(posts).length, 1);
    } finally {
      probe.unmount();
    }
  } finally {
    timers.restore();
  }
});

test('a successful baseline cancels its deadline and remains active through later live time', async () => {
  const timers = installFakeTimers();
  const posts = install();
  const probe = mountSubscriptionProbe();
  try {
    const stream = makeStream(KEY, 'sub-1', childValue(), 2, 1, 1);
    await act(async () => {
      receiveDetailImperative(streamStart(stream));
      receiveDetailImperative(streamPage(stream, 0));
      receiveDetailImperative(streamPage(stream, 1));
    });
    assert.equal(probe.handle.status, 'active');
    assert.equal(timers.activeCount(), 0, 'completed baseline leaves no loading deadline');

    await act(async () => timers.advance(DETAIL_LOAD_TIMEOUT_MS * 3));
    assert.equal(probe.handle.status, 'active', 'a healthy live subscription is not timed out');
    assert.equal(unsubscribePosts(posts).length, 0);
  } finally {
    probe.unmount();
    timers.restore();
  }
});

test('stale timeout callbacks from a collapsed attempt cannot fail its re-expanded owner', () => {
  const timers = installFakeTimers();
  try {
    const posts = install();
    const probe = mountSubscriptionProbe();
    const staleTimeout = timers.captureCallbacks()[0]!;
    probe.update(false);
    probe.update(true);
    assert.equal(subscribePosts(posts).length, 2);
    assert.equal(probe.handle.status, 'subscribing');

    staleTimeout();
    assert.equal(probe.handle.status, 'subscribing');
    assert.equal(timers.activeCount(), 1, 'only the current attempt retains its own deadline');
    probe.unmount();
    assert.equal(timers.activeCount(), 0, 'unmount clears the current attempt deadline');
    openDetailSubscription({ detailKey: KEY, address: ADDRESS });
    assert.equal(timers.activeCount(), 1);
    clearDetailSubscriptionStore();
    assert.equal(timers.activeCount(), 0, 'store reset clears every pending deadline');
  } finally {
    clearDetailSubscriptionStore();
    timers.restore();
  }
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
  openDetailSubscription({ detailKey: KEY, address: ADDRESS });
  const stream = makeStream(KEY, 'sub-1', childValue(), 2, 1);
  const onePageByteBudget = Math.max(...stream.pages.map((page) => page.payloadBytes));
  setDetailStoreBudgets({ maxGlobalPages: 1, maxGlobalBytes: onePageByteBudget, maxPagesPerSubscription: 1 });
  receiveDetailImperative(streamStart(stream));
  receiveDetailImperative(streamPage(stream, 0));
  // page 1 evicts page 0; the value never assembled.
  receiveDetailImperative(streamPage(stream, 1));
  // A delta on the correct base still cannot apply to a missing value.
  receiveDetailImperative(streamDelta(stream, 1, 2, [{ op: 'set', path: ['exitCode'], value: 0 }]));
  assert.equal(subscribePosts(posts).length, 2, 'gap rebase instead of replaying a delta over nothing');
});
