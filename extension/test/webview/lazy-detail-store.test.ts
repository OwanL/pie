import assert from 'node:assert/strict';
import test from 'node:test';

import type { LazyDetailRef, WebviewToHostMessage } from '../../src/shared/protocol';
import {
  LAZY_DETAIL_REQUEST_TIMEOUT_MS,
  clearLazyDetailCache,
  receiveLazyDetailResult,
  requestLazyDetail,
  setLazyDetailPostMessage,
} from '../../src/webview/panel/transcript/lazy-detail-store';

function installFakeTimers(): {
  scheduled: Map<number, { callback: () => void; delay: number }>;
  cleared: Set<number>;
  fireByDelay(delay: number): void;
  restore(): void;
} {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const scheduled = new Map<number, { callback: () => void; delay: number }>();
  const cleared = new Set<number>();
  let nextId = 0;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const id = ++nextId;
    scheduled.set(id, { callback: () => callback(...args), delay: delay ?? 0 });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer?: ReturnType<typeof setTimeout>) => {
    const id = Number(timer);
    cleared.add(id);
    scheduled.delete(id);
  }) as typeof clearTimeout;
  return {
    scheduled,
    cleared,
    fireByDelay(delay: number): void {
      const match = [...scheduled].find(([, timer]) => timer.delay === delay);
      assert.ok(match, `expected a ${delay}ms timer`);
      scheduled.delete(match[0]);
      match[1].callback();
    },
    restore(): void {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}

function ref(key: string): LazyDetailRef {
  return {
    key,
    kind: 'tool-result',
    source: 'durable',
    sessionPath: '/session.jsonl',
    messageId: 'message',
    toolCallId: key,
    sizeBytes: 1,
    summary: key,
    available: true,
  };
}

test('detail requests start only on demand, deduplicate expansions, and reuse loaded cache entries', () => {
  clearLazyDetailCache();
  const posts: WebviewToHostMessage[] = [];
  setLazyDetailPostMessage((message) => posts.push(message));
  const detail = ref('detail-1');

  assert.equal(posts.length, 0, 'compact initial state does not fetch details');
  requestLazyDetail(detail.sessionPath, detail);
  requestLazyDetail(detail.sessionPath, detail);
  assert.equal(posts.length, 1, 'repeated expansion while loading is deduplicated');

  receiveLazyDetailResult({
    sessionPath: detail.sessionPath, key: detail.key, status: 'loaded', value: { complete: true }, sizeBytes: 1,
  });
  requestLazyDetail(detail.sessionPath, detail);
  assert.equal(posts.length, 1, 'loaded detail is served from the bounded cache');
});

test('detail cache is bounded and failed requests can be retried', () => {
  clearLazyDetailCache();
  const posts: WebviewToHostMessage[] = [];
  setLazyDetailPostMessage((message) => posts.push(message));
  const first = ref('detail-0');
  requestLazyDetail(first.sessionPath, first);
  receiveLazyDetailResult({
    sessionPath: first.sessionPath, key: first.key, status: 'loaded', value: 'first', sizeBytes: 1,
  });

  for (let index = 1; index <= 33; index += 1) {
    const item = ref(`detail-${index}`);
    receiveLazyDetailResult({
      sessionPath: item.sessionPath, key: item.key, status: 'loaded', value: index, sizeBytes: 1,
    });
  }
  requestLazyDetail(first.sessionPath, first);
  assert.equal(posts.length, 2, 'oldest detail is evicted after the entry bound is crossed');

  receiveLazyDetailResult({
    sessionPath: first.sessionPath, key: first.key, status: 'failure', message: 'temporary failure',
  });
  requestLazyDetail(first.sessionPath, first, true);
  assert.equal(posts.length, 3, 'retry starts a new request after failure');
});

test('a disconnected transport keeps the request queued without occupying the active slot', () => {
  clearLazyDetailCache();
  const posts: WebviewToHostMessage[] = [];
  setLazyDetailPostMessage(() => false);
  const detail = ref('detail-reconnect');

  requestLazyDetail(detail.sessionPath, detail);
  assert.equal(posts.length, 0);

  setLazyDetailPostMessage((message) => {
    posts.push(message);
    return true;
  });

  assert.equal(posts.length, 1, 'reconnect re-pumps the explicit request once');
  assert.equal(posts[0]?.type, 'requestDetail');
});

test('a lost request times out, releases the serialized lane, and can be retried', () => {
  clearLazyDetailCache();
  const timers = installFakeTimers();
  try {
    const posts: WebviewToHostMessage[] = [];
    setLazyDetailPostMessage((message) => posts.push(message));
    const first = ref('detail-lost');
    const second = ref('detail-next');

    requestLazyDetail(first.sessionPath, first);
    requestLazyDetail(second.sessionPath, second);
    assert.deepEqual(
      posts.filter((message) => message.type === 'requestDetail').map((message) => message.ref.key),
      [first.key],
      'the lost request initially owns the sole active lane',
    );

    timers.fireByDelay(LAZY_DETAIL_REQUEST_TIMEOUT_MS);
    assert.deepEqual(
      posts.filter((message) => message.type === 'requestDetail').map((message) => message.ref.key),
      [first.key, second.key],
      'timing out the lost request immediately pumps the next expansion',
    );

    requestLazyDetail(first.sessionPath, first);
    receiveLazyDetailResult({
      sessionPath: second.sessionPath, key: second.key, status: 'loaded', value: 'next', sizeBytes: 1,
    });
    assert.deepEqual(
      posts.filter((message) => message.type === 'requestDetail').map((message) => message.ref.key),
      [first.key, second.key, first.key],
      'the timeout is a retryable failure rather than a permanent tombstone',
    );
  } finally {
    clearLazyDetailCache();
    timers.restore();
  }
});

test('detail results and cache resets clear request recovery timers', () => {
  clearLazyDetailCache();
  const timers = installFakeTimers();
  try {
    setLazyDetailPostMessage(() => true);
    const settled = ref('detail-settled');
    requestLazyDetail(settled.sessionPath, settled);
    const settledTimerId = [...timers.scheduled.keys()][0];
    assert.ok(settledTimerId);

    receiveLazyDetailResult({
      sessionPath: settled.sessionPath, key: settled.key, status: 'loaded', value: 'done', sizeBytes: 1,
    });
    assert.equal(timers.cleared.has(settledTimerId), true, 'a result cancels its recovery timer');

    const reset = ref('detail-reset');
    requestLazyDetail(reset.sessionPath, reset);
    const resetTimerId = [...timers.scheduled.keys()][0];
    assert.ok(resetTimerId);
    clearLazyDetailCache();
    assert.equal(timers.cleared.has(resetTimerId), true, 'cache reset cancels every active recovery timer');
    assert.equal(timers.scheduled.size, 0);
  } finally {
    clearLazyDetailCache();
    timers.restore();
  }
});
