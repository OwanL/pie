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
import { clearCollapsibleCache } from '../../../src/webview/panel/transcript/use-collapsible-open';
import {
  clearLazyDetailCache,
  receiveLazyDetailResult,
  setLazyDetailPostMessage,
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

test('running subagent placeholders route expansion through detail retrieval', async () => {
  const messages: WebviewToHostMessage[] = [];
  setLazyDetailPostMessage((message) => messages.push(message));
  const detailRef: LazyDetailRef = {
    key: 'live:tool:/session:tool:1', kind: 'tool-result', source: 'live',
    sessionPath: '/session', messageId: 'message', toolCallId: 'tool', executionId: 'execution',
    sourceRevision: 1, sizeBytes: 100_000, summary: '1 subagent child', childCount: 1, available: true,
  };
  const renderItem = (ref: LazyDetailRef, seq: number) => act(() => {
    render(h(ToolCallItem, {
      toolCall: {
        id: 'tool', name: 'subagent', input: { agent: 'worker', task: 'work' },
        status: 'running', executionId: 'execution', seq, detailRef: ref,
      },
      prefs: { ...DEFAULT_CHAT_PREFS, autoExpandSubagentCalls: false },
      workingDirectory: '/tmp',
      onOpenFile: () => undefined,
      onContextMenu: () => undefined,
      renderToolCall: () => null,
    }), container);
  });
  renderItem(detailRef, 1);
  let toggle = container.querySelector('[role="button"]') as HTMLElement | null;
  assert.ok(toggle);
  await act(async () => toggle?.click());
  assert.equal(messages.filter((message) => message.type === 'requestDetail').length, 1);

  const nextRef = { ...detailRef, key: 'live:tool:/session:tool:2', sourceRevision: 2 };
  renderItem(nextRef, 2);
  assert.equal(messages.filter((message) => message.type === 'requestDetail').length, 1,
    'an open streaming row must not fetch the full preview again on every revision');
  toggle = container.querySelector('[role="button"]') as HTMLElement | null;
  await act(async () => toggle?.click());
  await act(async () => toggle?.click());
  assert.equal(messages.filter((message) => message.type === 'requestDetail').length, 2,
    'a deliberate close/re-expand fetches the newest revision');
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
