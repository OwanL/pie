/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { installDom } from '../../_helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { DEFAULT_CHAT_PREFS, type LazyDetailRef, type WebviewToHostMessage } from '../../../src/shared/protocol';
import { ToolCallCard } from '../../../src/webview/panel/transcript/tool-call-card/tool-call-card';
import { ToolCallItem } from '../../../src/webview/panel/transcript/tool-call-item';
import '../../../src/webview/panel/transcript/tools/subagent-tool';
import { clearCollapsibleCache } from '../../../src/webview/panel/transcript/use-collapsible-open';
import {
  LAZY_DETAIL_REQUEST_TIMEOUT_MS,
  clearLazyDetailCache,
  receiveLazyDetailResult,
  requestLazyDetail,
  setLazyDetailPostMessage,
  useLazyDetail,
} from '../../../src/webview/panel/transcript/lazy-detail-store';

let container: HTMLElement;

beforeEach(() => {
  clearLazyDetailCache();
  clearCollapsibleCache();
  container = document.createElement('div');
  document.body.appendChild(container);
  return () => {
    render(null, container);
    container.remove();
  };
});

test('lazy subagents render a lightweight collapsed preview and load detail only when expanded', async () => {
  const messages: WebviewToHostMessage[] = [];
  setLazyDetailPostMessage((message) => messages.push(message));
  const detailRef: LazyDetailRef = {
    key: 'durable:subagent:/session:entry:tool:0', kind: 'tool-result', source: 'durable',
    sessionPath: '/session', messageId: 'message', toolCallId: 'tool', executionId: 'execution',
    sizeBytes: 100_000, summary: '1 subagent child', childCount: 1, available: true,
  };

  await act(async () => {
    render(h(ToolCallItem, {
      toolCall: {
        id: 'tool', name: 'subagent', input: { agent: 'worker', task: 'work' },
        result: {
          details: {
            mode: 'single',
            results: [{
              agent: 'worker',
              task: 'work',
              exitCode: 0,
              messages: [],
              model: 'preview-model',
              streamingText: 'short retained preview',
            }],
          },
        },
        status: 'completed', executionId: 'execution', detailRef,
      },
      prefs: { ...DEFAULT_CHAT_PREFS, autoExpandSubagentCalls: false },
      workingDirectory: '/tmp',
      onOpenFile: () => undefined,
      onContextMenu: () => undefined,
      renderToolCall: () => null,
    }), container);
  });

  const card = container.querySelector('.tool-call-subagent');
  assert.ok(card, 'lazy detail must not degrade a subagent into the generic tool card');
  let toggle = card.querySelector('[role="button"]') as HTMLElement | null;
  assert.equal(toggle?.getAttribute('aria-expanded'), 'false');
  assert.match(container.textContent ?? '', /preview-model/);
  assert.match(container.textContent ?? '', /short retained preview/);
  assert.equal(messages.filter((message) => message.type === 'requestDetail').length, 0,
    'the collapsed preview does not fetch the recursive child transcript');

  await act(async () => toggle?.click());
  toggle = container.querySelector('.tool-call-subagent [role="button"]') as HTMLElement | null;
  assert.equal(toggle?.getAttribute('aria-expanded'), 'true');
  assert.ok(container.querySelector('.tool-call-subagent'));
  assert.match(container.textContent ?? '', /Loading subagent transcript/);
  assert.equal(messages.filter((message) => message.type === 'requestDetail').length, 1,
    'opening the subagent requests its full transcript once');
  await act(async () => toggle?.click());
  toggle = container.querySelector('.tool-call-subagent [role="button"]') as HTMLElement | null;
  assert.equal(toggle?.getAttribute('aria-expanded'), 'false');
  assert.equal(messages.filter((message) => message.type === 'requestDetail').length, 1);
});

test('several expanded details are serialized so large responses cannot queue together', () => {
  const messages: WebviewToHostMessage[] = [];
  setLazyDetailPostMessage((message) => messages.push(message));
  const first: LazyDetailRef = {
    key: 'durable:first', kind: 'tool-result', source: 'durable',
    sessionPath: '/session', messageId: 'message', toolCallId: 'first',
    sizeBytes: 20 * 1024 * 1024, summary: 'first', available: true,
  };
  const second: LazyDetailRef = {
    ...first, key: 'durable:second', toolCallId: 'second', summary: 'second',
  };

  requestLazyDetail(first.sessionPath, first);
  requestLazyDetail(second.sessionPath, second);
  assert.deepEqual(
    messages.filter((message) => message.type === 'requestDetail').map((message) => message.ref.key),
    [first.key],
  );

  receiveLazyDetailResult({
    sessionPath: first.sessionPath, key: first.key, status: 'loaded', value: 'first', sizeBytes: first.sizeBytes,
  });
  assert.deepEqual(
    messages.filter((message) => message.type === 'requestDetail').map((message) => message.ref.key),
    [first.key, second.key],
  );
});

test('running lazy subagents retain their last preview across live revisions and refresh at the durable terminal', async () => {
  const messages: WebviewToHostMessage[] = [];
  setLazyDetailPostMessage((message) => messages.push(message));
  const liveRef = (revision: number): LazyDetailRef => ({
    key: `live:tool:/session:tool:${revision}`, kind: 'tool-result', source: 'live',
    sessionPath: '/session', messageId: 'message', toolCallId: 'tool', executionId: 'execution',
    sourceRevision: revision, sizeBytes: 100_000, summary: '1 subagent child', childCount: 1, available: true,
  });
  const LazyProbe = ({ detailRef }: { detailRef: LazyDetailRef }) => {
    const { state } = useLazyDetail(detailRef, true);
    return h('div', {}, state.status === 'loaded' ? String(state.value) : state.status);
  };
  const renderRef = async (detailRef: LazyDetailRef) => act(async () => {
    render(h(LazyProbe, { detailRef }), container);
  });

  const firstRef = liveRef(1);
  await renderRef(firstRef);
  assert.equal(messages.filter((message) => message.type === 'requestDetail').length, 1);
  act(() => receiveLazyDetailResult({
    sessionPath: '/session', key: firstRef.key, status: 'loaded', sizeBytes: 12, value: 'LIVE_PREVIEW',
  }));
  assert.match(container.textContent ?? '', /LIVE_PREVIEW/);

  await renderRef(liveRef(2));
  assert.match(container.textContent ?? '', /LIVE_PREVIEW/,
    'a new live detail key must not erase the last useful collapsed preview');
  assert.equal(messages.filter((message) => message.type === 'requestDetail').length, 1,
    'rapid live revisions do not repeatedly transfer the full recursive transcript');

  const durableRef: LazyDetailRef = {
    ...liveRef(3), key: 'durable:tool:/session:entry:tool:0', source: 'durable', sourceRevision: undefined,
  };
  await renderRef(durableRef);
  assert.equal(messages.filter((message) => message.type === 'requestDetail').length, 2,
    'the stable durable terminal detail is fetched once');
  act(() => clearLazyDetailCache());
  assert.doesNotMatch(container.textContent ?? '', /LIVE_PREVIEW/,
    'host/session cache resets must also discard the component-local live fallback');
});

test('tool detail is absent initially, requested on expansion, and rendered after retrieval', async () => {
  const messages: WebviewToHostMessage[] = [];
  setLazyDetailPostMessage((message) => messages.push(message));
  const detailRef: LazyDetailRef = {
    key: 'durable:tool:/session:entry:tool:0',
    kind: 'tool-result',
    source: 'durable',
    sessionPath: '/session',
    messageId: 'message',
    toolCallId: 'tool',
    sizeBytes: 100_000,
    summary: 'large result',
    available: true,
  };

  act(() => {
    render(h(ToolCallCard, {
      toolCall: { id: 'tool', name: 'read', input: { path: '/tmp/a' }, status: 'completed', detailRef },
      autoExpand: false,
      workingDirectory: '/tmp',
      onOpenFile: () => undefined,
      onContextMenu: () => undefined,
    }), container);
  });
  assert.equal(messages.some((message) => message.type === 'requestDetail'), false);
  assert.equal(container.textContent?.includes('COMPLETE_DETAIL'), false);

  const toggle = container.querySelector('[role="button"]') as HTMLElement | null;
  assert.ok(toggle);
  await act(async () => toggle.click());
  assert.equal(messages.filter((message) => message.type === 'requestDetail').length, 1);
  assert.match(container.textContent ?? '', /Loading details/);

  act(() => receiveLazyDetailResult({
    sessionPath: '/session', key: detailRef.key, status: 'loaded', value: 'COMPLETE_DETAIL', sizeBytes: 15,
  }));
  assert.match(container.textContent ?? '', /COMPLETE_DETAIL/);
});

test('a lost tool-detail request surfaces a retry action instead of loading forever', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const fakeHandle = { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
  let timeoutCallback: (() => void) | undefined;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay === LAZY_DETAIL_REQUEST_TIMEOUT_MS) {
      timeoutCallback = () => callback(...args);
      return fakeHandle;
    }
    return (originalSetTimeout as unknown as (callback: () => void, delay?: number) => ReturnType<typeof setTimeout>)(
      () => callback(...args),
      delay,
    );
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer?: ReturnType<typeof setTimeout>) => {
    if (timer === fakeHandle) {
      timeoutCallback = undefined;
      return;
    }
    originalClearTimeout(timer);
  }) as typeof clearTimeout;

  try {
    const messages: WebviewToHostMessage[] = [];
    setLazyDetailPostMessage((message) => messages.push(message));
    const detailRef: LazyDetailRef = {
      key: 'durable:tool:/session:entry:lost:0',
      kind: 'tool-result',
      source: 'durable',
      sessionPath: '/session',
      messageId: 'message',
      toolCallId: 'lost-tool',
      sizeBytes: 100_000,
      summary: 'lost detail',
      available: true,
    };

    act(() => {
      render(h(ToolCallCard, {
        toolCall: { id: 'lost-tool', name: 'read', input: { path: '/tmp/lost' }, status: 'completed', detailRef },
        autoExpand: true,
        workingDirectory: '/tmp',
        onOpenFile: () => undefined,
        onContextMenu: () => undefined,
      }), container);
    });
    assert.equal(messages.filter((message) => message.type === 'requestDetail').length, 1);
    assert.ok(timeoutCallback, 'accepted detail request arms bounded recovery');

    act(() => timeoutCallback?.());
    assert.match(container.textContent ?? '', /Detail loading timed out/);
    const retry = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Retry') as HTMLButtonElement | undefined;
    assert.ok(retry, 'timeout failure is explicitly retryable');

    await act(async () => retry.click());
    assert.equal(messages.filter((message) => message.type === 'requestDetail').length, 2);
    assert.match(container.textContent ?? '', /Loading details/);
  } finally {
    clearLazyDetailCache();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
