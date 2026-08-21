import assert from 'node:assert/strict';
import test from 'node:test';

import type { LazyDetailRef, WebviewToHostMessage } from '../../src/shared/protocol';
import {
  clearLazyDetailCache,
  receiveLazyDetailResult,
  requestLazyDetail,
  setLazyDetailPostMessage,
} from '../../src/webview/panel/transcript/lazy-detail-store';

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
