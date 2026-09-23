/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { installDom } from '../../_helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import {
  DEFAULT_CHAT_PREFS,
  type LazyDetailRef,
  type LiveSubagentDetailAddress,
  type WebviewToHostMessage,
} from '../../../src/shared/protocol';
import {
  clearDetailSubscriptionStore,
  demandDetailValue,
  receiveDetailImperative,
  setDetailStoreContext,
  sha256Hex,
} from '../../../src/webview/panel/transcript/detail-subscription-store';
import { retainSubagentDetailAddresses } from '../../../src/host/core/live-pipeline/subagent-detail-addresses';
import {
  clearLazyDetailCache,
  setLazyDetailPostMessage,
} from '../../../src/webview/panel/transcript/lazy-detail-store';
import { ToolCallItem } from '../../../src/webview/panel/transcript/tool-call-item';
import '../../../src/webview/panel/transcript/tools/subagent-tool';
import { clearCollapsibleCache } from '../../../src/webview/panel/transcript/use-collapsible-open';

let container: HTMLElement;

beforeEach(() => {
  clearDetailSubscriptionStore();
  clearLazyDetailCache();
  clearCollapsibleCache();
  container = document.createElement('div');
  document.body.appendChild(container);
  return () => {
    render(null, container);
    container.remove();
  };
});

test('an address promotion reaches a mounted expanded completed card', async () => {
  const messages: WebviewToHostMessage[] = [];
  const postMessage = (message: WebviewToHostMessage) => messages.push(message);
  setLazyDetailPostMessage(postMessage);
  setDetailStoreContext({
    hostInstanceId: 'host-1', viewGeneration: 1, rendererId: 'renderer-1', rendererGeneration: 1, postMessage,
  });

  const lineage = [{ childId: 'child-1', spawningToolCallId: 'tool-1', attemptId: 'child-attempt-1' }];
  const detailAddress: LiveSubagentDetailAddress = {
    sessionPath: '/session.jsonl', turnId: 'turn-1', rootToolCallId: 'tool-1', rootAttemptId: 'root-attempt-1', lineage,
  };
  const detailRef: LazyDetailRef = {
    key: 'durable:tool:/session.jsonl:tool-1', kind: 'tool-result', source: 'durable',
    sessionPath: '/session.jsonl', messageId: 'assistant-1', toolCallId: 'tool-1',
    sizeBytes: 100_000, summary: '1 subagent child', childCount: 1, available: true,
  };
  const child = {
    agent: 'worker', task: 'inspect', exitCode: 0, messages: [],
    childId: 'child-1', attemptId: 'child-attempt-1', lineage,
  };
  const baseToolCall = {
    id: 'tool-1', name: 'subagent', input: { agent: 'worker', task: 'inspect' },
    result: { details: { mode: 'single', results: [child] } },
    status: 'completed' as const, seq: 7, detailRef,
  };
  const renderProps = {
    prefs: { ...DEFAULT_CHAT_PREFS, autoExpandSubagentCalls: true },
    workingDirectory: '/tmp', onOpenFile: () => undefined, onContextMenu: () => undefined,
    renderToolCall: () => null,
  };
  const addressSource = {
    details: {
      results: [{ ...child, liveAddressable: true, detailAddress }],
    },
  };

  await act(async () => {
    render(h(ToolCallItem, { toolCall: baseToolCall, ...renderProps }), container);
  });
  assert.equal(container.querySelector('[aria-expanded="true"]') !== null, true, 'the card is already expanded');
  assert.equal(messages.filter((message) => message.type === 'requestDetail').length, 1,
    'before address promotion the expanded card is using its generic durable-detail lane');

  const promotedResult = retainSubagentDetailAddresses(baseToolCall.result, addressSource);
  assert.notEqual(promotedResult, baseToolCall.result, 'host terminal reconciliation promotes the producer address');
  await act(async () => {
    render(h(ToolCallItem, { toolCall: { ...baseToolCall, result: promotedResult }, ...renderProps }), container);
  });

  const subscribe = messages.find((message): message is Extract<WebviewToHostMessage, { type: 'detail.subscribe' }> =>
    message.type === 'detail.subscribe');
  assert.ok(subscribe, 'a mounted expanded card must subscribe when terminal reconciliation promotes its address');

  const route = {
    hostInstanceId: 'host-1', hostGeneration: 0, viewGeneration: subscribe.viewGeneration,
    rendererId: 'renderer-1', rendererGeneration: 1, backendGeneration: 1, coordinatorGeneration: 1,
    workerId: 'worker-1', workerGeneration: 1, detailKey: subscribe.detailKey,
    detailAttempt: subscribe.detailAttempt, subscriptionId: 'subscription-1',
  };
  const serializedChild = JSON.stringify({
    agent: 'worker', task: 'inspect', exitCode: 0, lineage,
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'full child transcript' }] }],
  });
  const totalBytes = new TextEncoder().encode(serializedChild).byteLength;
  const totalCodePoints = [...serializedChild].length;
  const payload = {
    kind: 'json-segment' as const, encoding: 'utf8-json' as const, segmentId: 'segment-0', semanticPath: [],
    startByte: 0, endByte: totalBytes, totalBytes, startCodePoint: 0, endCodePoint: totalCodePoints,
    totalCodePoints, text: serializedChild,
  };
  await act(async () => {
    receiveDetailImperative({
      type: 'detail.start', ...route, address: detailAddress, source: 'durable',
      baselineRevision: 1, pageCount: 1, totalBytes, totalCodePoints,
    });
    receiveDetailImperative({
      type: 'detail.page', ...route,
      ref: { baselineRevision: 1, pageIndex: 0, pageCount: 1 }, payload,
      payloadBytes: new TextEncoder().encode(JSON.stringify(payload)).byteLength,
      checksum: sha256Hex(JSON.stringify(payload)),
    });
  });
  const detail = demandDetailValue(subscribe.detailKey);
  assert.equal(detail.status, 'ready', 'the promoted card assembles its page-backed transcript');
  if (detail.status === 'ready') assert.deepEqual((detail.value as { messages: unknown[] }).messages, [
    { role: 'assistant', content: [{ type: 'text', text: 'full child transcript' }] },
  ]);
});

test('an addressable terminal subagent subscribes instead of issuing a generic detail request', async () => {
  const messages: WebviewToHostMessage[] = [];
  const postMessage = (message: WebviewToHostMessage) => messages.push(message);
  setLazyDetailPostMessage(postMessage);
  setDetailStoreContext({
    hostInstanceId: 'host-1',
    viewGeneration: 1,
    rendererId: 'renderer-1',
    rendererGeneration: 1,
    postMessage,
  });

  const lineage = [{
    childId: 'child-1',
    spawningToolCallId: 'tool-1',
    attemptId: 'child-attempt-1',
  }];
  const detailAddress: LiveSubagentDetailAddress = {
    sessionPath: '/session.jsonl',
    turnId: 'turn-1',
    rootToolCallId: 'tool-1',
    rootAttemptId: 'root-attempt-1',
    lineage,
  };
  const detailRef: LazyDetailRef = {
    key: 'live:tool:/session.jsonl:tool-1:4',
    kind: 'tool-result',
    source: 'live',
    sessionPath: '/session.jsonl',
    messageId: 'assistant-1',
    toolCallId: 'tool-1',
    executionId: 'execution-1',
    sourceRevision: 4,
    sizeBytes: 100_000,
    summary: '1 subagent child',
    childCount: 1,
    available: true,
  };

  await act(async () => {
    render(h(ToolCallItem, {
      toolCall: {
        id: 'tool-1',
        name: 'subagent',
        input: { agent: 'worker', task: 'inspect' },
        result: {
          details: {
            mode: 'single',
            results: [{
              agent: 'worker', task: 'inspect', exitCode: 0, messages: [],
              childId: 'child-1', attemptId: 'child-attempt-1', lineage,
              liveAddressable: true, detailAddress,
            }],
          },
        },
        status: 'completed',
        executionId: 'execution-1',
        detailRef,
      },
      prefs: { ...DEFAULT_CHAT_PREFS, autoExpandSubagentCalls: false },
      workingDirectory: '/tmp',
      onOpenFile: () => undefined,
      onContextMenu: () => undefined,
      renderToolCall: () => null,
    }), container);
  });

  const toggle = container.querySelector('.tool-call-subagent [role="button"]') as HTMLElement | null;
  assert.ok(toggle);
  assert.equal(messages.some((message) => message.type === 'requestDetail'), false);

  await act(async () => toggle.click());

  const subscribes = messages.filter((message): message is Extract<WebviewToHostMessage, { type: 'detail.subscribe' }> =>
    message.type === 'detail.subscribe');
  assert.equal(subscribes.length, 1);
  assert.deepEqual(subscribes[0]?.address, detailAddress);
  assert.equal(messages.some((message) => message.type === 'requestDetail'), false,
    'the legacy one-shot path must stay idle when an immutable producer address is available');

  act(() => receiveDetailImperative({
    type: 'detail.error',
    hostInstanceId: 'host-1', hostGeneration: 0, viewGeneration: 1,
    rendererId: 'renderer-1', rendererGeneration: 1,
    backendGeneration: 1, coordinatorGeneration: 1,
    workerId: 'worker-1', workerGeneration: 1,
    detailKey: subscribes[0]!.detailKey,
    detailAttempt: subscribes[0]!.detailAttempt,
    subscriptionId: 'subscription-1',
    code: 'UNAVAILABLE', message: 'Subagent transcript temporarily unavailable.', retryable: true,
  }));
  assert.match(container.textContent ?? '', /Subagent transcript temporarily unavailable/,
    'subscription failures must not look like an empty transcript');
  const retry = [...container.querySelectorAll('button')]
    .find((button) => button.textContent?.trim() === 'Retry') as HTMLButtonElement | undefined;
  assert.ok(retry, 'a retryable subscription error keeps an explicit recovery action');

  await act(async () => retry.click());
  assert.equal(messages.filter((message) => message.type === 'detail.subscribe').length, 2);
});
