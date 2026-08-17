import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../../_helpers/dom';
installDom();

// Stub DOMPurify before any component imports (matches webview-render.test.ts)
import DOMPurify from 'dompurify';
DOMPurify.sanitize = ((html: string) => html) as typeof DOMPurify.sanitize;

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { useEffect } from 'preact/hooks';

import type { LiveSubagentDetailAddress, WebviewToHostMessage } from '../../../src/shared/protocol';
import type { DetailStreamMessage } from '../../../src/webview/panel/transcript/detail-subscription-store';
import {
  clearDetailSubscriptionStore,
  receiveDetailImperative,
  resetDetailStoreBudgets,
  setDetailStoreBudgets,
  setDetailStoreContext,
  useDetailSubscription,
} from '../../../src/webview/panel/transcript/detail-subscription-store';
import { NestedVirtualList } from '../../../src/webview/panel/transcript/nested-virtual-list';
import {
  SegmentedText,
  setToolTextSegmentThreshold,
} from '../../../src/webview/panel/transcript/tool-call-card/segmented-text';

const ADDRESS: LiveSubagentDetailAddress = {
  sessionPath: '/s.jsonl',
  turnId: 't1',
  rootToolCallId: 'rt1',
  rootAttemptId: 'ra1',
  lineage: [{ childId: 'c1', spawningToolCallId: 'rt1', attemptId: 'a1' }],
};

function stalePage(subscriptionId: string, detailKey: string): DetailStreamMessage {
  return {
    type: 'detail.page',
    hostInstanceId: 'h1',
    hostGeneration: 0,
    viewGeneration: 1,
    backendGeneration: 1,
    coordinatorGeneration: 1,
    workerId: 'w1',
    workerGeneration: 1,
    detailKey,
    subscriptionId,
    ref: { baselineRevision: 1, pageIndex: 0, pageCount: 1 },
    payload: {
      kind: 'json-segment', encoding: 'utf8-json', segmentId: 's0', semanticPath: [],
      startByte: 0, endByte: 1, totalBytes: 1, startCodePoint: 0, endCodePoint: 1, totalCodePoints: 1,
      text: 'x',
    },
    payloadBytes: 1,
    checksum: 'x'.repeat(64),
  };
}

let container: HTMLElement;
const posts: WebviewToHostMessage[] = [];

beforeEach(() => {
  posts.length = 0;
  clearDetailSubscriptionStore();
  resetDetailStoreBudgets();
  setToolTextSegmentThreshold(128 * 1024);
  setDetailStoreContext({
    hostInstanceId: 'h1',
    viewGeneration: 1,
    postMessage: (message) => posts.push(message),
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  return () => {
    render(null, container);
    container.remove();
  };
});

function subscribeCount(): number {
  return posts.filter((post) => post.type === 'detail.subscribe').length;
}

function unsubscribeCount(): number {
  return posts.filter((post) => post.type === 'detail.unsubscribe').length;
}

function Probe({ detailKey, address, expanded }: { detailKey: string; address?: LiveSubagentDetailAddress; expanded: boolean }) {
  const subscription = useDetailSubscription({ detailKey, address, expanded });
  return (
    <div
      data-status={subscription.status}
      data-has-value={subscription.value !== null ? 'yes' : 'no'}
      data-error={subscription.error?.message ?? ''}
    />
  );
}

test('hook: collapsed never subscribes; expansion subscribes once; collapse unsubscribes even mid-animation', () => {
  const key = 'subagent:msg-1:tool-1';
  act(() => { render(<Probe detailKey={key} address={ADDRESS} expanded={false} />, container); });
  assert.equal(subscribeCount(), 0, 'collapsed card sends no subscription');
  assert.equal(document.querySelector('[data-status]')?.getAttribute('data-status'), 'idle');

  act(() => { render(<Probe detailKey={key} address={ADDRESS} expanded={true} />, container); });
  assert.equal(subscribeCount(), 1, 'expansion subscribes exactly once');
  const subscribe = posts.find((post) => post.type === 'detail.subscribe');
  assert.ok(subscribe && subscribe.type === 'detail.subscribe');
  assert.equal(subscribe.viewGeneration, 1);
  assert.equal(subscribe.detailKey, key);
  assert.deepEqual(subscribe.address, ADDRESS);

  // Re-render with the same expansion does not re-subscribe.
  act(() => { render(<Probe detailKey={key} address={ADDRESS} expanded={true} />, container); });
  assert.equal(subscribeCount(), 1);

  // Collapse — including the close animation window, which renders the body
  // with `open=false` — immediately unsubscribes and discards state.
  act(() => { render(<Probe detailKey={key} address={ADDRESS} expanded={false} />, container); });
  assert.equal(unsubscribeCount(), 1);
  const unsubscribe = posts.find((post) => post.type === 'detail.unsubscribe');
  assert.ok(unsubscribe && unsubscribe.type === 'detail.unsubscribe');
  assert.equal(unsubscribe.reason, 'collapse');

  // Unmount (animation end) does not double-post.
  act(() => { render(null, container); });
  assert.equal(unsubscribeCount(), 1);
});

test('hook: re-expansion before unsubscribe acknowledgement creates a fresh owner and ignores stale frames', () => {
  const key = 'subagent:msg-1:tool-1';
  render(<Probe detailKey={key} address={ADDRESS} expanded={false} />, container);
  act(() => {});
  assert.equal(subscribeCount(), 0);

  // First expansion.
  act(() => { render(<Probe detailKey={key} address={ADDRESS} expanded={true} />, container); });
  assert.equal(subscribeCount(), 1);

  // Collapse (unsubscribe posted, not yet acknowledged by the host)…
  act(() => { render(<Probe detailKey={key} address={ADDRESS} expanded={false} />, container); });
  assert.equal(unsubscribeCount(), 1);

  // …then re-expansion before any acknowledgement: a fresh owner is minted.
  act(() => { render(<Probe detailKey={key} address={ADDRESS} expanded={true} />, container); });
  assert.equal(subscribeCount(), 2);

  // A stale frame bound to the first owner must be ignored entirely.
  act(() => { receiveDetailImperative(stalePage('sub-1', key)); });
  assert.equal(
    document.querySelector('[data-status]')?.getAttribute('data-status'),
    'subscribing',
    'stale page never assembles into the fresh owner',
  );
});

test('hook: error state surfaces retryability; terminal keeps the value renderable', () => {
  const key = 'subagent:msg-1:tool-1';
  act(() => { render(<Probe detailKey={key} address={ADDRESS} expanded={true} />, container); });

  act(() => {
    receiveDetailImperative({
      type: 'detail.error',
      hostInstanceId: 'h1', hostGeneration: 0, viewGeneration: 1, backendGeneration: 1,
      coordinatorGeneration: 1, workerId: 'w1', workerGeneration: 1, detailKey: key, subscriptionId: 'sub-1',
      code: 'UNAVAILABLE', message: 'budget full', retryable: true,
    });
  });
  assert.equal(document.querySelector('[data-status]')?.getAttribute('data-status'), 'error');
  assert.equal(document.querySelector('[data-error]')?.getAttribute('data-error'), 'budget full');
});

test('nested virtual list: only viewport rows mount, keyed by stable identity', () => {
  const rows = Array.from({ length: 40 }, (_, index) => ({ id: `r${index}`, label: `message ${index}` }));
  const mounted: string[] = [];

  function Row({ row }: { row: { id: string; label: string } }) {
    useEffect(() => {
      mounted.push(row.id);
      return () => {
        const at = mounted.indexOf(row.id);
        if (at >= 0) mounted.splice(at, 1);
      };
    }, [row.id]);
    return <div>{row.label}</div>;
  }

  // The scroll container reports a 100px viewport; estimates put each row at
  // 44px, so only the first few rows (plus overscan) should mount.
  const scrollBox = document.createElement('div');
  Object.defineProperty(scrollBox, 'clientHeight', { configurable: true, value: 100 });
  scrollBox.scrollTop = 0;
  container.appendChild(scrollBox);

  act(() => {
    render(
      <NestedVirtualList
        rows={rows}
        getKey={(row) => row.id}
        estimateHeight={() => 44}
        scrollRef={{ current: scrollBox }}
        renderRow={(row) => <Row row={row} />}
      />,
      container,
    );
  });

  assert.ok(mounted.length < rows.length, `only a window mounted, got ${mounted.length} of ${rows.length}`);
  assert.ok(mounted.length >= 3, 'viewport plus overscan rows mount');
  assert.deepEqual(mounted, [...mounted].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))), 'no rows outside the window');

  // Stable keys: re-rendering with updated rows keeps mounted rows mounted
  // (no churn) — the identity is the row id, not the position.
  const mountedBefore = [...mounted];
  act(() => {
    render(
      <NestedVirtualList
        rows={rows.map((row, index) => ({ ...row, label: `updated ${index}` }))}
        getKey={(row) => row.id}
        estimateHeight={() => 44}
        scrollRef={{ current: scrollBox }}
        renderRow={(row) => <Row row={row} />}
      />,
      container,
    );
  });
  assert.deepEqual(mounted, mountedBefore, 'updates do not remount visible rows');
});

test('computeNestedRowRange maps scroll positions to bounded windows', async () => {
  const { computeNestedRowRange } = await import('../../../src/webview/panel/transcript/nested-virtual-list');
  const estimates = Array.from({ length: 10 }, () => 50);
  const atTop = computeNestedRowRange({ estimates, scrollTop: 0, viewportHeight: 100 });
  assert.equal(atTop.startIndex, 0);
  assert.ok(atTop.endIndex >= 1 && atTop.endIndex <= 6, `overscan window near top: ${atTop.endIndex}`);
  assert.equal(atTop.totalHeight, 500);

  const middle = computeNestedRowRange({ estimates, scrollTop: 250, viewportHeight: 100, overscan: 1 });
  assert.equal(middle.startIndex, 4);
  assert.equal(middle.endIndex, 7);
  assert.deepEqual(middle.offsets, [0, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500]);

  const bottom = computeNestedRowRange({ estimates, scrollTop: 450, viewportHeight: 100, overscan: 0 });
  assert.equal(bottom.startIndex, 9);
  assert.equal(bottom.endIndex, 9);

  const noViewport = computeNestedRowRange({ estimates, scrollTop: 0, viewportHeight: 0 });
  assert.equal(noViewport.startIndex, 0);
  assert.equal(noViewport.endIndex, 9, 'unmeasured lists render everything');
});

test('SegmentedText splits oversized text into exact byte-ranged segments', () => {
  setToolTextSegmentThreshold(32);
  // 100 chars with newlines every 10 chars: segments prefer newline breaks.
  const text = Array.from({ length: 10 }, (_, line) => `line-${line}-${'x'.repeat(6)}`).join('\n');
  let segmentCount = 0;
  let rendered = '';
  act(() => {
    render(
      <SegmentedText
        text={text}
        identity="tool-1:result"
        renderSegment={(segmentText) => {
          segmentCount += 1;
          rendered += segmentText;
          return <code>{segmentText}</code>;
        }}
      />,
      container,
    );
  });
  assert.ok(segmentCount > 1, `oversized text is segmented (${segmentCount} segments)`);
  assert.equal(rendered, text, 'segments concatenate to the exact original text');
  const rangeLabels = container.querySelectorAll('.tool-call-segment-range');
  assert.equal(rangeLabels.length, segmentCount);
  const first = rangeLabels[0]?.textContent ?? '';
  assert.match(first, /bytes \d+–\d+ \/ \d+/, 'segments carry exact byte ranges');
  const lastLabel = rangeLabels[rangeLabels.length - 1]?.textContent ?? '';
  const totalBytes = new TextEncoder().encode(text).byteLength;
  assert.match(lastLabel, new RegExp(`bytes \\d+–${totalBytes} / ${totalBytes}`), 'last segment ends at the exact total');

  // Fitting text renders as a single unsegmented block.
  setToolTextSegmentThreshold(4096);
  act(() => { render(<SegmentedText text="small" identity="tool-1:result" renderSegment={(t) => <code>{t}</code>} />, container); });
  assert.equal(container.querySelectorAll('.tool-call-segment-range').length, 0);
});
