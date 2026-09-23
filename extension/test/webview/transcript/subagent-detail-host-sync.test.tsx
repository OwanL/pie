/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

import { installDom } from '../../_helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import DOMPurify from 'dompurify';
DOMPurify.sanitize = ((html: string) => html) as typeof DOMPurify.sanitize;

import {
  DEFAULT_CHAT_PREFS,
  EMPTY_TRANSCRIPT_WINDOW,
  PIE_BUILD_ID,
  WEBVIEW_PROTOCOL_VERSION,
  type ChatMessage,
  type HostToWebviewMessage,
  type LiveSubagentDetailAddress,
  type ToolCall,
  type ViewState,
  type WebviewToHostMessage,
} from '../../../src/shared/protocol';
import { useHostSync, EMPTY_VIEW_STATE } from '../../../src/webview/panel/hooks/use-host-sync';
import type { ClientConnectionState, ClientTransport } from '../../../src/webview/transport/client-transport';
import { ToolCallItem } from '../../../src/webview/panel/transcript/tool-call-item';
import {
  clearDetailSubscriptionStore,
  demandDetailValue,
  getDetailStoreDebugState,
  sha256Hex,
} from '../../../src/webview/panel/transcript/detail-subscription-store';
import { clearLazyDetailCache } from '../../../src/webview/panel/transcript/lazy-detail-store';
import { clearCollapsibleCache } from '../../../src/webview/panel/transcript/use-collapsible-open';
import '../../../src/webview/panel/transcript/register-builtins';

const ADDRESS: LiveSubagentDetailAddress = {
  sessionPath: '/session.jsonl',
  turnId: 'turn-1',
  rootToolCallId: 'root-tool',
  rootAttemptId: 'root-attempt',
  lineage: [{ childId: 'child-1', spawningToolCallId: 'root-tool', attemptId: 'child-attempt' }],
};

class HostSyncTransport implements ClientTransport {
  readonly posted: WebviewToHostMessage[] = [];
  private readonly handlers = new Set<(message: HostToWebviewMessage) => void>();

  postMessage(message: WebviewToHostMessage): boolean {
    this.posted.push(message);
    return true;
  }

  subscribe(handler: (message: HostToWebviewMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  getConnectionState(): ClientConnectionState {
    return 'connected';
  }

  onConnectionStateChange(handler: (state: ClientConnectionState) => void): () => void {
    handler('connected');
    return () => undefined;
  }

  emit(message: HostToWebviewMessage): void {
    for (const handler of this.handlers) handler(message);
  }

  dispose(): void {
    this.handlers.clear();
  }
}

function liveToolCall(seq: number, text: string): ToolCall {
  return {
    id: 'root-tool',
    name: 'subagent',
    input: { agent: 'worker', task: 'inspect the repository' },
    result: {
      kind: 'subagent',
      mode: 'single',
      omittedChildren: 0,
      children: [{
        id: 'child-1',
        childId: 'child-1',
        attemptId: 'child-attempt',
        lineage: ADDRESS.lineage,
        liveAddressable: true,
        detailAddress: ADDRESS,
        phase: 'running',
        agent: 'worker',
        task: 'inspect the repository',
        exitCode: -1,
        streaming: true,
        streamingText: text,
      }],
    },
    detailRef: {
      key: `live:tool:/session.jsonl:root-tool:${seq}`,
      kind: 'tool-result',
      source: 'live',
      sessionPath: ADDRESS.sessionPath,
      messageId: 'assistant-1',
      toolCallId: 'root-tool',
      executionId: 'execution-1',
      sourceRevision: seq,
      sizeBytes: 200_000,
      summary: '1 subagent child',
      childCount: 1,
      available: true,
    },
    status: 'running',
    executionId: 'execution-1',
    seq,
  };
}

function viewState(toolCall: ToolCall): ViewState {
  const message: ChatMessage = {
    id: 'assistant-1',
    role: 'assistant',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown: '',
    parts: [{ kind: 'toolCall', toolCall }],
    toolCalls: [toolCall],
    toolStateRevision: toolCall.seq,
    status: 'streaming',
  };
  return {
    ...EMPTY_VIEW_STATE,
    activeSession: {
      path: ADDRESS.sessionPath,
      name: 'Session',
      cwd: '/workspace',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      messageCount: 1,
    },
    openTabPaths: [ADDRESS.sessionPath],
    transcript: [message],
    transcriptWindow: {
      ...EMPTY_TRANSCRIPT_WINDOW,
      loadedStart: 0,
      loadedEnd: 1,
      totalCount: 1,
    },
    transcriptLoaded: true,
    prefs: { ...DEFAULT_CHAT_PREFS, autoExpandSubagentCalls: false },
  };
}

function stateEnvelope(revision: number, toolCall: ToolCall): Extract<HostToWebviewMessage, { type: 'state' }> {
  return {
    type: 'state',
    protocolVersion: WEBVIEW_PROTOCOL_VERSION,
    buildId: PIE_BUILD_ID,
    hostInstanceId: 'host-1',
    rendererId: 'renderer-1',
    rendererGeneration: 1,
    viewGeneration: 1,
    revision,
    expectedTranscriptIdentity: `transcript-${revision}`,
    snapshotBytes: 1024,
    state: viewState(toolCall),
  };
}

function HostSyncedTranscript({ transport }: { transport: HostSyncTransport }) {
  const { viewState: state } = useHostSync(transport);
  const toolCall = state.transcript[0]?.parts?.find((part) => part.kind === 'toolCall');
  if (!toolCall || toolCall.kind !== 'toolCall') return null;
  const renderToolCall = (call: ToolCall) => h(ToolCallItem, {
    toolCall: call,
    prefs: state.prefs,
    workingDirectory: '/workspace',
    onOpenFile: () => undefined,
    onContextMenu: () => undefined,
    renderToolCall,
  });
  return renderToolCall(toolCall.toolCall);
}

let container: HTMLElement;
let transport: HostSyncTransport;

beforeEach(() => {
  clearDetailSubscriptionStore();
  clearLazyDetailCache();
  clearCollapsibleCache();
  transport = new HostSyncTransport();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => { render(null, container); });
  transport.dispose();
  clearDetailSubscriptionStore();
  clearLazyDetailCache();
  container.remove();
});

test('expanded lazy subagent survives host snapshots and renders live detail through the host-sync transport', async () => {
  act(() => { render(h(HostSyncedTranscript, { transport }), container); });
  transport.emit(stateEnvelope(1, liveToolCall(1, 'preview one')));
  await act(async () => { await Promise.resolve(); });

  const toggle = container.querySelector('.tool-call-subagent [role="button"]') as HTMLElement | null;
  assert.ok(toggle, 'the real ToolCallItem renders the live compact subagent preview');
  await act(async () => { toggle.click(); });
  assert.match(container.textContent ?? '', /Loading subagent transcript/);

  const subscribe = transport.posted.find((message): message is Extract<WebviewToHostMessage, { type: 'detail.subscribe' }> =>
    message.type === 'detail.subscribe');
  assert.ok(subscribe, 'expansion must post detail.subscribe through useHostSync transport');
  assert.deepEqual(subscribe.address, ADDRESS);
  assert.equal(transport.posted.some((message) => message.type === 'requestDetail'), false,
    'an addressable live child must not fall back to the one-shot lazy-detail lane');

  // Host snapshots are structured-clone boundaries in production. Advance the
  // active tool revision repeatedly while the subscribe is still in flight.
  for (let seq = 2; seq <= 5; seq += 1) {
    transport.emit(stateEnvelope(seq, liveToolCall(seq, `preview ${seq}`)));
    await act(async () => { await Promise.resolve(); });
  }
  assert.equal(transport.posted.filter((message) => message.type === 'detail.subscribe').length, 1,
    'repeated streamed host snapshots must not churn the expanded subscription');
  assert.equal(container.querySelector('.tool-call-subagent [role="button"]')?.getAttribute('aria-expanded'), 'true');
  assert.match(container.textContent ?? '', /Loading subagent transcript/,
    `the in-flight UI must remain explicit across snapshots; DOM=${container.innerHTML}`);

  const route = {
    hostInstanceId: 'host-1',
    hostGeneration: 0,
    viewGeneration: subscribe.viewGeneration,
    rendererId: 'renderer-1',
    rendererGeneration: 1,
    backendGeneration: 1,
    coordinatorGeneration: 1,
    workerId: 'worker-1',
    workerGeneration: 1,
    detailKey: subscribe.detailKey,
    detailAttempt: subscribe.detailAttempt,
    subscriptionId: 'subscription-1',
  };
  const serializedChild = JSON.stringify({
    agent: 'worker',
    task: 'inspect the repository',
    exitCode: -1,
    attemptId: ADDRESS.lineage[0]!.attemptId,
    liveAddressable: true,
    lineage: ADDRESS.lineage,
    messages: [{ role: 'assistant', content: 'baseline child transcript' }],
  });
  const totalBytes = new TextEncoder().encode(serializedChild).byteLength;
  const totalCodePoints = [...serializedChild].length;
  const payload = {
    kind: 'json-segment' as const,
    encoding: 'utf8-json' as const,
    segmentId: 'segment-0',
    semanticPath: [],
    startByte: 0,
    endByte: totalBytes,
    totalBytes,
    startCodePoint: 0,
    endCodePoint: totalCodePoints,
    totalCodePoints,
    text: serializedChild,
  };
  await act(async () => {
    transport.emit({
      type: 'detail.start', ...route, address: ADDRESS, source: 'live',
      baselineRevision: 1, pageCount: 1, totalBytes, totalCodePoints,
    });
    transport.emit({
      type: 'detail.page', ...route,
      ref: { baselineRevision: 1, pageIndex: 0, pageCount: 1 },
      payload,
      payloadBytes: new TextEncoder().encode(JSON.stringify(payload)).byteLength,
      checksum: sha256Hex(JSON.stringify(payload)),
    });
    await Promise.resolve();
  });
  assert.ok(getDetailStoreDebugState().valueBytes > 0, 'the hook assembled the received baseline');
  const assembled = demandDetailValue(subscribe.detailKey);
  assert.equal(assembled.status, 'ready');
  if (assembled.status === 'ready') assert.deepEqual(assembled.value, {
    agent: 'worker', task: 'inspect the repository', exitCode: -1,
    attemptId: ADDRESS.lineage[0]!.attemptId, liveAddressable: true,
    lineage: ADDRESS.lineage, messages: [{ role: 'assistant', content: 'baseline child transcript' }],
  });
  assert.match(container.textContent ?? '', /baseline child transcript/,
    `the streamed child baseline must replace the loading state in the real tool-call DOM; DOM=${container.innerHTML}`);

  // A later host snapshot and child delta interleave just as they do during a
  // live Pi subagent turn. The subscription remains bound while both sources
  // update independently.
  transport.emit(stateEnvelope(6, liveToolCall(6, 'preview while streaming')));
  await act(async () => { await Promise.resolve(); });
  await act(async () => {
    transport.emit({
      type: 'detail.delta', ...route,
      baseRevision: 1,
      revision: 2,
      operations: [{ op: 'set', path: ['messages', 0, 'content'], value: 'updated live child transcript' }],
    });
    await Promise.resolve();
  });
  assert.match(container.textContent ?? '', /updated live child transcript/,
    'the expanded transcript keeps receiving live detail deltas across host snapshots');
  assert.equal(transport.posted.filter((message) => message.type === 'detail.subscribe').length, 1);
});
