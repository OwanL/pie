import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import DOMPurify from 'dompurify';
import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import { TurnActivityStrip } from '../../../src/webview/panel/transcript/turn-activity-strip.tsx';
import { provisionalToolSummary } from '../../../src/webview/panel/transcript/tool-call-card/provisional.ts';
import { ToolCallBody } from '../../../src/webview/panel/transcript/tool-call-card/tool-call-body.tsx';
import { toolDisclosureKey } from '../../../src/webview/panel/transcript/use-collapsible-open.ts';

import {
  DEFAULT_CHAT_PREFS,
  EMPTY_TRANSCRIPT_WINDOW,
  type ChatMessage,
  type ChatMessagePart,
  type SystemPromptEntry,
  type ToolCall,
  type PruningDetails,
} from '../../../src/shared/protocol';
import type { TurnActivityState } from '../../../src/webview/panel/transcript/activity';

DOMPurify.sanitize = ((html: string) => html) as typeof DOMPurify.sanitize;

const noop = () => undefined;
const noopContextMenu = () => undefined;

function assistantMessage(parts: ChatMessagePart[], overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    createdAt: '2026-01-01T12:34:56.000Z',
    markdown: 'fallback',
    parts,
    status: 'streaming',
    modelId: 'claude-sonnet-4-5:cloud',
    thinkingLevel: 'high',
    durationMs: 1500,
    ...overrides,
  };
}

function userMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'user-1',
    role: 'user',
    createdAt: '2026-01-01T12:34:56.000Z',
    markdown: 'Edit me',
    status: 'completed',
    ...overrides,
  };
}

function toolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tool-1',
    name: 'write',
    input: { path: '/repo/src/file.ts', content: 'export const value = 1;\n' },
    result: { content: [{ type: 'text', text: 'ok' }] },
    status: 'completed',
    ...overrides,
  };
}

// Hoist the 6 module loads out of the first test. Dynamic-importing them inside
// the first test billed ~690 ms to that test. Loading synchronously at module
// scope (require) runs them once during module evaluation, which node:test
// does not bill to any test. (Top-level await isn't available here — tsx
// compiles to CJS — and a before() hook's time is billed to the first test, so
// neither of those would actually keep the first case under 200 ms.)
require('../../../src/webview/panel/transcript/register-builtins');
const messageItemModule: typeof import('../../../src/webview/panel/transcript/message-item.tsx') = require('../../../src/webview/panel/transcript/message-item.tsx');
const toolCallCardModule: typeof import('../../../src/webview/panel/transcript/tool-call-card.tsx') = require('../../../src/webview/panel/transcript/tool-call-card.tsx');
const toolCallItemModule: typeof import('../../../src/webview/panel/transcript/tool-call-item.tsx') = require('../../../src/webview/panel/transcript/tool-call-item.tsx');
const virtualRowModule: typeof import('../../../src/webview/panel/transcript/virtual-list-row.tsx') = require('../../../src/webview/panel/transcript/virtual-list-row.tsx');
const systemPromptsModule: typeof import('../../../src/webview/panel/system-prompts.tsx') = require('../../../src/webview/panel/system-prompts.tsx');
const systemPromptToggleMenuModule: typeof import('../../../src/webview/panel/composer/system-prompt-toggle-menu.tsx') = require('../../../src/webview/panel/composer/system-prompt-toggle-menu.tsx');

const webviewModules = {
  MessageItem: messageItemModule.MessageItem,
  ReasoningBlock: messageItemModule.ReasoningBlock,
  ToolCallHeader: toolCallCardModule.ToolCallHeader,
  ToolCallItem: toolCallItemModule.ToolCallItem,
  TranscriptVirtualRow: virtualRowModule.TranscriptVirtualRow,
  SystemPromptMessage: systemPromptsModule.SystemPromptMessage,
  SystemPromptToggleMenu: systemPromptToggleMenuModule.SystemPromptToggleMenu,
};

function loadWebviewModules() {
  return webviewModules;
}

test('rendered MessageItem covers assistant, editable user, and image-user branches', async () => {
  const { MessageItem, ReasoningBlock } = await loadWebviewModules();
  const prefs = {
    ...DEFAULT_CHAT_PREFS,
    autoExpandReasoning: true,
  };

  const assistantHtml = renderToString(h(MessageItem, {
    message: assistantMessage([
      { kind: 'reasoning', text: '**Plan** the fix' },
      { kind: 'text', text: 'Hello **world**' },
      { kind: 'toolCall', toolCall: toolCall({ id: 'tool-inline', name: 'read', input: { path: '/repo/README.md' }, result: undefined, status: 'running' }) },
    ]),
    isStreaming: true,
    prefs,
    readonly: true,
    workingDirectory: '/repo',
    editingId: null,
    onEditRequest: noop,
    onEditConfirm: noop,
    onEditCancel: noop,
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => h('span', { class: 'rendered-tool' }, 'rendered tool'),
    isLastAssistantMessage: true,
    requestCreatedAt: '2026-01-01T12:34:56.000Z',
  }));

  assert.match(assistantHtml, /Reasoning/);
  assert.match(assistantHtml, /rendered-tool/);
  assert.match(assistantHtml, /Hello <strong>world<\/strong>/);
  assert.match(assistantHtml, /Agent is responding/);
  assert.match(assistantHtml, /claude-sonnet-4-5:cloud high/);
  assert.match(assistantHtml, /datetime="2026-01-01T12:34:56\.000Z"/);
  assert.match(assistantHtml, /title="Request made /);

  const editingHtml = renderToString(h(MessageItem, {
    message: userMessage(),
    isStreaming: false,
    prefs: DEFAULT_CHAT_PREFS,
    readonly: false,
    workingDirectory: '/repo',
    editingId: 'user-1',
    onEditRequest: noop,
    onEditConfirm: noop,
    onEditCancel: noop,
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
    isLastAssistantMessage: false,
  }));

  assert.match(editingHtml, /inline-editor-textarea/);
  assert.match(editingHtml, />Save</);
  assert.match(editingHtml, />Cancel</);
  assert.match(editingHtml, /self-end/);

  const imageHtml = renderToString(h(MessageItem, {
    message: userMessage({
      markdown: 'See attachment',
      userParts: [
        { kind: 'text', text: 'See attachment' },
        { kind: 'image', mimeType: 'image/png', dataBase64: 'ZmFrZQ==', name: 'diagram.png', width: 100, height: 50 },
      ],
    }),
    isStreaming: false,
    prefs: DEFAULT_CHAT_PREFS,
    readonly: true,
    workingDirectory: '/repo',
    editingId: null,
    onEditRequest: noop,
    onEditConfirm: noop,
    onEditCancel: noop,
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
    isLastAssistantMessage: false,
  }));

  assert.match(imageHtml, /message-user-image/);
  assert.match(imageHtml, /diagram\.png/);
  assert.match(imageHtml, /100×50/);

  const reasoningHtml = renderToString(h(ReasoningBlock, {
    text: 'Collapsed summary text',
    autoExpand: false,
    collapsibleKey: 'reasoning:test',
    onContextMenu: noop,
  }));
  assert.match(reasoningHtml, /Reasoning/);
  assert.match(reasoningHtml, /Collapsed summary text/);
});

test('parallel tool calls share a parallel-group strip while sequential calls do not', async () => {
  const { MessageItem } = await loadWebviewModules();
  const renderToolRun = (parts: ChatMessagePart[]) => renderToString(h(MessageItem, {
    message: assistantMessage(parts),
    isStreaming: false,
    prefs: DEFAULT_CHAT_PREFS,
    readonly: true,
    workingDirectory: '/repo',
    editingId: null,
    onEditRequest: noop,
    onEditConfirm: noop,
    onEditCancel: noop,
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: (toolCall: ToolCall) => h('span', { class: 'rendered-tool' }, toolCall.id),
    isLastAssistantMessage: false,
  }));

  const provisionalHtml = renderToolRun([
    { kind: 'toolCall', toolCall: toolCall({ id: 'p-a', name: 'bash', status: 'drafting' }) },
    { kind: 'toolCall', toolCall: toolCall({ id: 'p-b', name: 'bash', status: 'drafting' }) },
  ]);
  const parallelHtml = renderToolRun([
    { kind: 'toolCall', toolCall: toolCall({ id: 'p-a', name: 'bash', status: 'drafting', parallelGroupId: 'batch-1' }) },
    { kind: 'toolCall', toolCall: toolCall({ id: 'p-b', name: 'bash', status: 'drafting', parallelGroupId: 'batch-1' }) },
  ]);

  // The provisional run already has the final first-tool-keyed parent/child
  // shape. Verification annotates only the children; it never creates a new
  // batch parent that would reparent mounted tool cards.
  assert.doesNotMatch(provisionalHtml, /tool-call-parallel-child|data-parallel-group-id/);
  assert.doesNotMatch(parallelHtml, /tool-call-parallel-group/);
  assert.equal((parallelHtml.match(/data-parallel-group-id="batch-1"/g) ?? []).length, 2);
  assert.equal((parallelHtml.match(/tool-call-parallel-child/g) ?? []).length, 2);
  assert.equal((parallelHtml.match(/tool-call-parallel-start/g) ?? []).length, 1);
  assert.equal((parallelHtml.match(/tool-call-parallel-end/g) ?? []).length, 1);
  assert.match(parallelHtml, /rendered-tool">p-a[\s\S]*rendered-tool">p-b/);

  const sequentialHtml = renderToString(h(MessageItem, {
    message: assistantMessage([
      { kind: 'toolCall', toolCall: toolCall({ id: 's-a', name: 'bash', parallelGroupId: 'batch-2' }) },
      { kind: 'toolCall', toolCall: toolCall({ id: 's-b', name: 'bash', parallelGroupId: 'batch-3' }) },
    ]),
    isStreaming: false,
    prefs: DEFAULT_CHAT_PREFS,
    readonly: true,
    workingDirectory: '/repo',
    editingId: null,
    onEditRequest: noop,
    onEditConfirm: noop,
    onEditCancel: noop,
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: (toolCall: ToolCall) => h('span', { class: 'rendered-tool' }, toolCall.id),
    isLastAssistantMessage: false,
  }));

  // Distinct batch ids → no parallel strip; each call renders independently.
  assert.doesNotMatch(sequentialHtml, /tool-call-parallel-child|data-parallel-group-id/);

  const mixedHtml = renderToolRun([
    { kind: 'toolCall', toolCall: toolCall({ id: 'm-a1', name: 'bash', parallelGroupId: 'batch-A' }) },
    { kind: 'toolCall', toolCall: toolCall({ id: 'm-a2', name: 'read', parallelGroupId: 'batch-A' }) },
    { kind: 'toolCall', toolCall: toolCall({ id: 'm-b', name: 'read', parallelGroupId: 'batch-B' }) },
  ]);
  assert.equal((mixedHtml.match(/data-parallel-group-id="batch-A"/g) ?? []).length, 2, 'A keeps its verified strip');
  assert.doesNotMatch(mixedHtml, /data-parallel-group-id="batch-B"/, 'solo B remains flat');
  assert.match(mixedHtml, /m-a1[\s\S]*m-a2[\s\S]*m-b/, 'mixed children retain one run order');

  const disjointHtml = renderToolRun([
    { kind: 'toolCall', toolCall: toolCall({ id: 'd-a1', name: 'bash', parallelGroupId: 'batch-A' }) },
    { kind: 'toolCall', toolCall: toolCall({ id: 'd-b', name: 'read', parallelGroupId: 'batch-B' }) },
    { kind: 'toolCall', toolCall: toolCall({ id: 'd-a2', name: 'read', parallelGroupId: 'batch-A' }) },
  ]);
  assert.doesNotMatch(disjointHtml, /tool-call-parallel-child|data-parallel-group-id/, 'non-contiguous solo ids do not falsely group');

  const legacyHtml = renderToString(h(MessageItem, {
    message: assistantMessage([
      { kind: 'toolCall', toolCall: toolCall({ id: 'l-a', name: 'bash' }) },
      { kind: 'toolCall', toolCall: toolCall({ id: 'l-b', name: 'bash' }) },
    ]),
    isStreaming: false,
    prefs: DEFAULT_CHAT_PREFS,
    readonly: true,
    workingDirectory: '/repo',
    editingId: null,
    onEditRequest: noop,
    onEditConfirm: noop,
    onEditCancel: noop,
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: (toolCall: ToolCall) => h('span', { class: 'rendered-tool' }, toolCall.id),
    isLastAssistantMessage: false,
  }));

  // Calls without a parallelGroupId (legacy sessions) never group.
  assert.doesNotMatch(legacyHtml, /tool-call-parallel-child|data-parallel-group-id/);

  const contentSource = await readFile(new URL('../../../src/webview/panel/transcript/message-item/content.tsx', import.meta.url), 'utf8');
  // Preact does not include keys in its SSR output, so verify both stable keys
  // directly: the run parent is anchored to its first call and each card to
  // its own call id.
  assert.match(contentSource, /key={`tool-run-\$\{firstCall\.id\}`}/);
  assert.match(contentSource, /key={`tool-\$\{part\.toolCall\.id\}`}/);
  assert.doesNotMatch(contentSource, /key={`tool-\$\{part\.toolCall\.id\}-\$\{index\}`}/);
});

test('message and nested-list render keys use host-projected identity while protocol ids stay authoritative', async () => {
  const { MessageItem } = await loadWebviewModules();
  const html = renderToString(h(MessageItem, {
    message: assistantMessage([], { id: 'durable-id', renderIdentity: 'live-row-id' }),
    isStreaming: false,
    prefs: DEFAULT_CHAT_PREFS,
    readonly: true,
    workingDirectory: '/repo',
    editingId: null,
    onEditRequest: noop,
    onEditConfirm: noop,
    onEditCancel: noop,
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
  }));
  assert.match(html, /data-message-id="durable-id"/);
  assert.match(html, /data-scroll-anchor-id="live-row-id"/);

  const rowSource = await readFile(new URL('../../../src/webview/panel/transcript/rows/message-row.tsx', import.meta.url), 'utf8');
  const nestedSource = await readFile(new URL('../../../src/webview/panel/transcript/transcript-message-list.tsx', import.meta.url), 'utf8');
  const anchorSource = await readFile(new URL('../../../src/webview/panel/transcript/scroll-anchor.ts', import.meta.url), 'utf8');
  assert.match(rowSource, /key=\{messageRenderIdentity\(row\.message\)\}/);
  assert.match(nestedSource, /key=\{collapsibleKey \? `\$\{messageRenderIdentity\(message\)\}-\$\{collapsibleKey\}` : messageRenderIdentity\(message\)\}/);
  assert.match(anchorSource, /\[data-scroll-anchor-id\]/);
  assert.doesNotMatch(anchorSource, /\[data-message-id\]/);
});

test('tool renderers share one disclosure key behind a stable ToolCallItem lifecycle boundary', async () => {
  assert.equal(toolDisclosureKey('call-1'), 'tool:call-1');
  const [itemSource, genericSource, searchSource] = await Promise.all([
    readFile(new URL('../../../src/webview/panel/transcript/tool-call-item.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../../src/webview/panel/transcript/tool-call-card/tool-call-card.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../../src/webview/panel/transcript/tools/web-search-tool.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(itemSource, /key=\{lifecycleKey\}/);
  assert.match(itemSource, /data-tool-lifecycle-key=\{lifecycleKey\}/);
  assert.match(itemSource, /useCollapsibleOpen\(toolDisclosureKey\(toolCall\.id\), prefs\.autoExpandSubagentCalls\)/);
  assert.match(genericSource, /useCollapsibleOpen\(toolDisclosureKey\(toolCall\.id\), autoExpand && !isProvisional\)/);
  assert.match(searchSource, /useCollapsibleOpen\(toolDisclosureKey\(toolCall\.id\), prefs\.autoExpandToolCalls\)/);
  assert.doesNotMatch(itemSource, /`subagent:\$\{toolCall\.id\}/);

  const { ToolCallItem } = await loadWebviewModules();
  const html = renderToString(h(ToolCallItem, {
    toolCall: toolCall({ id: 'stable-call', name: 'unknown_tool', status: 'drafting' }),
    prefs: DEFAULT_CHAT_PREFS,
    workingDirectory: '/repo',
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
  }));
  assert.match(html, /class="tool-call-lifecycle-boundary"/);
  assert.match(html, /data-tool-call-id="stable-call"/);
  assert.match(html, /data-tool-lifecycle-key="tool:stable-call"/);
});

test('provisional tool summaries safely handle partial JSON and prefer useful known fields', () => {
  const partial = provisionalToolSummary(toolCall({
    status: 'drafting',
    argumentsText: '{"command":"npm test -- --filter <unsafe',
    input: '{"command":"npm test -- --filter <unsafe',
  }));
  assert.deepEqual(partial, {
    field: 'command',
    text: 'npm test -- --filter <unsafe',
  });

  const ready = provisionalToolSummary(toolCall({
    status: 'ready',
    argumentsText: '{"query":"safe lifecycle rendering","count":5}',
    input: '{"query":"safe lifecycle rendering","count":5}',
  }));
  assert.deepEqual(ready, { field: 'query', text: 'safe lifecycle rendering' });

  const malformed = provisionalToolSummary(toolCall({
    status: 'drafting',
    argumentsText: '{not-json: <img src=x onerror=alert(1)>',
    input: '{not-json: <img src=x onerror=alert(1)>',
  }));
  assert.equal(malformed?.field, undefined);
  assert.match(malformed?.text ?? '', /<img src=x/);
});

test('ToolCallCard keeps provisional states badge-free while retaining accessible lifecycle labels', () => {
  const draftingHtml = renderToString(h(toolCallCardModule.ToolCallCard, {
    toolCall: toolCall({
      id: 'draft-card',
      name: 'bash',
      status: 'drafting',
      input: '{"command":"npm te',
      argumentsText: '{"command":"npm te',
      result: undefined,
    }),
    autoExpand: true,
    workingDirectory: '/repo',
    onOpenFile: noop,
    onContextMenu: noop,
  }));
  assert.match(draftingHtml, /data-status="drafting"/);
  assert.match(draftingHtml, /data-provisional="true"/);
  assert.match(draftingHtml, /command: npm te/);
  assert.match(draftingHtml, /aria-label="bash tool call, Drafting/);
  assert.doesNotMatch(draftingHtml, /status-chip-neutral|tool-call-draft-cursor|>Drafting<|tool-call-body-terminal|Raw arguments/);

  const readyHtml = renderToString(h(toolCallCardModule.ToolCallCard, {
    toolCall: toolCall({
      id: 'ready-card',
      name: 'bash',
      status: 'ready',
      input: '{"command":"npm test"}',
      argumentsText: '{"command":"npm test"}',
      result: undefined,
    }),
    autoExpand: true,
    workingDirectory: '/repo',
    onOpenFile: noop,
    onContextMenu: noop,
  }));
  assert.match(readyHtml, /data-status="ready"/);
  assert.match(readyHtml, /aria-label="bash tool call, Ready/);
  assert.doesNotMatch(readyHtml, /status-chip-neutral|tool-call-draft-cursor|>Ready<|tool-call-body-terminal|Raw arguments/);
});

test('provisional raw arguments render as escaped text even when malformed', () => {
  const html = renderToString(h(ToolCallBody, {
    toolCall: toolCall({
      status: 'drafting',
      input: '<img src=x onerror=alert(1)>',
      argumentsText: '{"path":"<img src=x onerror=alert(1)>',
      result: undefined,
    }),
    onOpenFile: noop,
  }));
  assert.match(html, />Input</);
  assert.match(html, /tool-call-pre tool-call-provisional-input/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)>/);
  assert.doesNotMatch(html, /<img\b/);
  assert.doesNotMatch(html, /dangerouslySetInnerHTML/);
});

test('collapsed running non-shell tools own their live result preview inline', () => {
  const html = renderToString(h(toolCallCardModule.ToolCallCard, {
    toolCall: toolCall({
      id: 'running-read-preview',
      name: 'read',
      status: 'running',
      input: { path: '/repo/src/a.ts' },
      result: { content: [{ type: 'text', text: 'latest streamed result' }], details: {} },
    }),
    autoExpand: false,
    activityTailLines: 2,
    workingDirectory: '/repo',
    onOpenFile: noop,
    onContextMenu: noop,
  }));
  assert.match(html, /data-status="running"/);
  assert.match(html, /tool-call-live-preview/);
  assert.match(html, /latest streamed result/);
  assert.doesNotMatch(html, /data-provisional/);

  const awaitingOutputHtml = renderToString(h(toolCallCardModule.ToolCallCard, {
    toolCall: toolCall({
      id: 'running-read-awaiting-output',
      name: 'read',
      status: 'running',
      input: { path: '/repo/src/pending.ts' },
      result: undefined,
    }),
    autoExpand: false,
    activityTailLines: 3,
    workingDirectory: '/repo',
    onOpenFile: noop,
    onContextMenu: noop,
  }));
  assert.match(awaitingOutputHtml, /tool-call-live-preview/);
  assert.match(awaitingOutputHtml, /data-empty="true"/);
});

test('rendered tool-call components cover collapsed summaries, expanded bodies, and subagent metadata', async () => {
  const { ToolCallHeader, ToolCallItem } = await loadWebviewModules();

  const headerHtml = renderToString(h(ToolCallHeader, {
    open: false,
    name: 'read',
    nameTitle: 'Read file',
    status: 'failed',
    summary: 'src/example.ts',
    summaryPath: '/repo/src/example.ts',
    sizeHint: '+3 lines',
    errorDetail: 'boom',
    durationMs: 1500,
    onToggle: noop,
    onOpenFile: noop,
  }));

  assert.match(headerHtml, /title="\/repo\/src\/example.ts"/);
  assert.match(headerHtml, /example\.ts/);
  assert.match(headerHtml, /Failed/);
  assert.match(headerHtml, /role="button"/);
  assert.match(headerHtml, /tabindex="0"/);
  assert.match(headerHtml, /Copy tool-call error detail/);
  assert.match(headerHtml, /\+3 lines/);
  assert.match(headerHtml, /Tool execution time/);
  assert.match(headerHtml, /1\.5s/);

  const expandedToolHtml = renderToString(h(ToolCallItem, {
    toolCall: toolCall(),
    prefs: { ...DEFAULT_CHAT_PREFS, autoExpandToolCalls: true },
    workingDirectory: '/repo',
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
  }));

  assert.match(expandedToolHtml, /tool-call-body/);
  assert.match(expandedToolHtml, /tool-call-section-label/);
  assert.match(expandedToolHtml, /Result/);
  assert.match(expandedToolHtml, /export const value = 1/);

  const subagentHtml = renderToString(h(ToolCallItem, {
    toolCall: toolCall({
      id: 'sub-1',
      name: 'subagent',
      input: { agent: 'reviewer', task: 'Inspect regression' },
      result: {
        details: {
          mode: 'single',
          results: [{
            agent: 'reviewer',
            agentSource: 'user',
            task: 'Inspect regression',
            exitCode: 0,
            messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Looks good.' }], model: 'claude-sonnet-4-5:cloud' }],
            stderr: '',
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 50, turns: 1 },
            selectedModel: 'claude-sonnet-4-5:cloud',
            thinkingLevel: 'high',
          }],
        },
      },
    }),
    prefs: { ...DEFAULT_CHAT_PREFS, autoExpandSubagentCalls: true, autoExpandReasoning: true },
    workingDirectory: '/repo',
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
  }));

  assert.match(subagentHtml, /subagent-agent-name/);
  assert.match(subagentHtml, /subagent-model-label/);
  assert.match(subagentHtml, /claude-sonnet-4-5/);
  assert.doesNotMatch(subagentHtml, /subagent-model-tag/);
  assert.doesNotMatch(subagentHtml, /subagent-thinking-tag/);
  assert.match(subagentHtml, /Looks good/);

  const runningSubagentHtml = renderToString(h(ToolCallItem, {
    toolCall: toolCall({
      id: 'sub-running',
      name: 'subagent',
      status: 'running',
      input: { agent: 'worker', task: 'Keep working' },
      result: {
        details: {
          mode: 'single',
          results: [{
            agent: 'worker',
            task: 'Keep working',
            exitCode: 0,
            messages: [],
            runningTools: ['bash'],
          }],
        },
      },
    }),
    prefs: { ...DEFAULT_CHAT_PREFS, autoExpandSubagentCalls: true },
    workingDirectory: '/repo',
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
  }));
  assert.doesNotMatch(runningSubagentHtml, /status-chip-running/);
  assert.doesNotMatch(runningSubagentHtml, /status-chip-label">Running/);
  assert.doesNotMatch(runningSubagentHtml, /subagent-running-tool/);
  // Expanded cards show the full child transcript without repeating the
  // collapsed task/live-output preview above it.
  assert.doesNotMatch(runningSubagentHtml, /subagent-live-preview/);
  assert.doesNotMatch(runningSubagentHtml, /→ bash/);
  assert.match(runningSubagentHtml, /subagent-messages/);

  const parallelSubagentHtml = renderToString(h(ToolCallItem, {
    toolCall: toolCall({
      id: 'sub-parallel',
      name: 'subagent',
      input: { tasks: [{ agent: 'scout', task: 'A' }, { agent: 'reviewer', task: 'B' }] },
      result: {
        details: {
          mode: 'parallel',
          results: [
            { agent: 'scout', task: 'A', exitCode: 0, messages: [] },
            { agent: 'reviewer', task: 'B', exitCode: 1, messages: [], stderr: 'boom', stopReason: 'error' },
          ],
        },
      },
    }),
    prefs: { ...DEFAULT_CHAT_PREFS, autoExpandSubagentCalls: true },
    workingDirectory: '/repo',
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
  }));
  assert.match(parallelSubagentHtml, /subagent-parallel-group/);
  assert.match(parallelSubagentHtml, /Failed/);

  const fallbackSubagentHtml = renderToString(h(ToolCallItem, {
    toolCall: toolCall({
      id: 'sub-fallback',
      name: 'subagent',
      status: 'failed',
      input: { tasks: [{ agent: 'worker', task: 'Do it' }] },
      result: {
        content: [{ type: 'text', text: 'Too many parallel tasks.' }],
        details: { mode: 'parallel', results: [] },
        isError: true,
      },
    }),
    prefs: { ...DEFAULT_CHAT_PREFS, autoExpandSubagentCalls: false },
    workingDirectory: '/repo',
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
  }));
  assert.match(fallbackSubagentHtml, /tool-call-subagent/);
  assert.match(fallbackSubagentHtml, /Too many parallel tasks/);
});

test('session-review batch results do not render as failed subagents', async () => {
  const { ToolCallItem } = await loadWebviewModules();
  const html = renderToString(h(ToolCallItem, {
    toolCall: toolCall({
      id: 'review-close-batch',
      name: 'session_review',
      input: { action: 'closeReviewedBatch' },
      result: {
        content: [{ type: 'text', text: 'Requested closure batch: 2 succeeded, 0 failed.' }],
        details: {
          results: [
            { index: 0, sessionId: 'session-1', reviewId: 'review-1', status: 'pending' },
            { index: 1, sessionId: 'session-2', reviewId: 'review-2', status: 'pending' },
          ],
        },
      },
      status: 'completed',
    }),
    prefs: { ...DEFAULT_CHAT_PREFS, autoExpandToolCalls: true },
    workingDirectory: '/repo',
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
  }));

  assert.match(html, /Requested closure batch: 2 succeeded, 0 failed/);
  assert.doesNotMatch(html, /tool-call-subagent/);
  assert.doesNotMatch(html, /context task only/);
  assert.doesNotMatch(html, />Failed</);
});

test('rendered ToolCallItem hides subagent model-selection badges in collapsed headers', async () => {
  const { ToolCallItem } = await loadWebviewModules();

  const html = renderToString(h(ToolCallItem, {
    toolCall: toolCall({
      id: 'sub-actual-model',
      name: 'subagent',
      input: { agent: 'reviewer', task: 'Inspect runtime model' },
      result: {
        details: {
          mode: 'single',
          results: [{
            agent: 'reviewer',
            task: 'Inspect runtime model',
            exitCode: 0,
            model: 'gpt-5.4',
            messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Done.' }], model: 'gpt-5.4' }],
            selectedModel: 'claude-opus-4.6',
            thinkingLevel: 'high',
            startedAt: 1_000,
            completedAt: 66_000,
            contextWindow: 200_000,
            usage: { input: 1_200, output: 345, cacheRead: 50, cacheWrite: 0, contextTokens: 1_595, cost: 0.0123, turns: 2 },
          }],
        },
      },
    }),
    prefs: DEFAULT_CHAT_PREFS,
    workingDirectory: '/repo',
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
  }));

  assert.match(html, /Inspect runtime model/);
  assert.doesNotMatch(html, /gpt-5\.4/);  // actual execution model not shown when selectedModel present
  assert.match(html, /claude-opus-4\.6/);  // selectedModel is now visible in header
  assert.match(html, /subagent-model-label/);
  assert.match(html, />1m 5s</);
  assert.match(html, />ctx 1\.6k \/ 200k/);
  assert.match(html, />tok 1\.6k</);
  assert.doesNotMatch(html, />in 1\.2k<|>out 345<|>cache 50<|>2t</);
  assert.match(html, />\$0\.012</);
  assert.doesNotMatch(html, /subagent-model-tag/);
});

test('rendered ToolCallItem covers collapsed and parallel subagent branches without inferring from foreign results', async () => {
  const { ToolCallItem } = await loadWebviewModules();

  const collapsedHtml = renderToString(h(ToolCallItem, {
    toolCall: toolCall({
      id: 'sub-collapsed',
      name: 'subagent',
      input: { agent: 'reviewer', task: 'Inspect regression' },
      result: {
        details: {
          mode: 'single',
          results: [{
            agent: 'reviewer',
            task: 'Inspect regression',
            exitCode: 0,
            messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }],
            selectedModel: 'claude-sonnet-4-5:cloud',
            thinkingLevel: 'high',
          }],
        },
      },
    }),
    prefs: DEFAULT_CHAT_PREFS,
    workingDirectory: '/repo',
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
  }));

  assert.doesNotMatch(collapsedHtml, /subagent-header-summary/);
  assert.match(collapsedHtml, /subagent-live-preview/);
  assert.match(collapsedHtml, /Inspect regression/);
  assert.doesNotMatch(collapsedHtml, /reviewer: Inspect regression/);
  assert.doesNotMatch(collapsedHtml, /subagent-secondary-meta/);
  assert.doesNotMatch(collapsedHtml, /subagent-model-tag/);
  assert.doesNotMatch(collapsedHtml, /subagent-thinking-tag/);
  assert.match(collapsedHtml, /claude-sonnet-4-5/);  // model now shown in header
  assert.match(collapsedHtml, /subagent-model-label/);
  assert.doesNotMatch(collapsedHtml, /subagent-messages/);

  const foreignResultHtml = renderToString(h(ToolCallItem, {
    toolCall: toolCall({
      id: 'foreign-results',
      name: 'bash',
      input: { command: 'echo delegate' },
      result: {
        details: {
          mode: 'single',
          results: [{
            agent: 'planner',
            task: 'Plan the fix',
            exitCode: 0,
            messages: [],
          }],
        },
      },
    }),
    prefs: DEFAULT_CHAT_PREFS,
    workingDirectory: '/repo',
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
  }));

  assert.match(foreignResultHtml, />bash</);
  assert.doesNotMatch(foreignResultHtml, /tool-call-subagent|context task only/);

  const failedParentHtml = renderToString(h(ToolCallItem, {
    toolCall: toolCall({
      id: 'sub-parent-failed',
      name: 'subagent',
      status: 'failed',
      input: { agent: 'reviewer', task: 'Inspect regression' },
      result: {
        details: {
          mode: 'single',
          results: [{
            agent: 'reviewer',
            task: 'Inspect regression',
            exitCode: 0,
            messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Partial output.' }] }],
          }],
        },
      },
    }),
    prefs: DEFAULT_CHAT_PREFS,
    workingDirectory: '/repo',
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
  }));

  assert.match(failedParentHtml, /status-chip-failed/);
  assert.doesNotMatch(failedParentHtml, /has-error-detail/);

  const runningParentHtml = renderToString(h(ToolCallItem, {
    toolCall: toolCall({
      id: 'sub-parent-running',
      name: 'subagent',
      status: 'running',
      input: { agent: 'scout', task: 'Gather logs' },
      result: {
        details: {
          mode: 'single',
          results: [{
            agent: 'scout',
            task: 'Gather logs',
            exitCode: 0,
            messages: [],
            selectedModel: 'gpt-4.1:local',
            provider: 'openai',
            contextWindow: 200_000,
            usage: { input: 51_000, output: 2_400, cacheRead: 38_600, cacheWrite: 0, cost: 0.1234, contextTokens: 51_000, turns: 2 },
            turnThroughputSamples: [{ endedAt: '2026-01-01T12:34:56.000Z', outputTokens: 120, generationDurationMs: 10_000, status: 'completed', modelId: 'gpt-4.1:local' }],
            retryCount: 1,
          }],
        },
      },
    }),
    prefs: DEFAULT_CHAT_PREFS,
    workingDirectory: '/repo',
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
  }));

  assert.doesNotMatch(runningParentHtml, /status-chip-label">Running/);
  assert.doesNotMatch(runningParentHtml, /subagent-model-tag/);
  assert.match(runningParentHtml, /gpt-4\.1/);  // model now shown in header
  assert.match(runningParentHtml, /status-chip-completed[^>]*>.*Finished/);
  assert.doesNotMatch(runningParentHtml, /Starting|waiting for first status update/);
  assert.match(runningParentHtml, /subagent-runtime-telemetry/);
  assert.match(runningParentHtml, /ctx 51k \/ 200k/);
  assert.match(runningParentHtml, /26%/);
  assert.match(runningParentHtml, /tok 92k/);
  assert.doesNotMatch(runningParentHtml, />in 51k<|>out 2\.4k<|>cache 38\.6k<|>2t</);
  assert.match(runningParentHtml, /last 12\.0 tok\/s/);
  assert.match(runningParentHtml, /retry 1/);

  const abortedHtml = renderToString(h(ToolCallItem, {
    toolCall: toolCall({
      id: 'sub-aborted',
      name: 'subagent',
      status: 'completed',
      input: { agent: 'reviewer', task: 'Inspect cancellation' },
      result: {
        details: {
          mode: 'single',
          results: [{
            agent: 'reviewer',
            task: 'Inspect cancellation',
            exitCode: 1,
            messages: [],
            stopReason: 'aborted',
            stderr: 'cancelled by caller',
          }],
        },
      },
    }),
    prefs: DEFAULT_CHAT_PREFS,
    workingDirectory: '/repo',
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
  }));

  assert.match(abortedHtml, /status-chip-interrupted has-error-detail/);
  assert.match(abortedHtml, /role="button"/);
  assert.match(abortedHtml, /tabindex="0"/);
  assert.match(abortedHtml, /Copy subagent interruption detail/);
  assert.match(abortedHtml, /Interrupted: cancelled by caller/);

  const fallbackHtml = renderToString(h(ToolCallItem, {
    toolCall: toolCall({
      id: 'sub-fallback',
      name: 'subagent',
      status: 'completed',
      input: { agent: 'reviewer', task: 'Inspect regression' },
      result: {
        details: {
          mode: 'single',
          results: [],
        },
      },
    }),
    prefs: DEFAULT_CHAT_PREFS,
    workingDirectory: '/repo',
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
  }));

  assert.match(fallbackHtml, /tool-call-subagent/);
  assert.match(fallbackHtml, /subagent-agent-name/);
  assert.match(fallbackHtml, /reviewer/);
  assert.match(fallbackHtml, /status-chip-failed/);
  assert.match(fallbackHtml, /Subagent failed before reporting child results/);

  const parallelHtml = renderToString(h(ToolCallItem, {
    toolCall: toolCall({
      id: 'sub-parallel',
      name: 'subagent',
      status: 'completed',
      input: {
        tasks: [
          { agent: 'scout', task: 'Gather logs' },
          { agent: 'reviewer', task: 'Review output' },
        ],
      },
      result: {
        details: {
          mode: 'parallel',
          results: [
            {
              agent: 'scout',
              task: 'Gather logs',
              exitCode: -1,
              messages: [],
              runningTools: ['bash'],
            },
            {
              agent: 'reviewer',
              task: 'Review output',
              exitCode: 1,
              messages: [],
              stopReason: 'error',
              errorMessage: 'spawn EPERM',
              stderr: 'permission denied',
            },
          ],
        },
      },
    }),
    prefs: { ...DEFAULT_CHAT_PREFS, autoExpandSubagentCalls: true },
    workingDirectory: '/repo',
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
  }));

  assert.match(parallelHtml, /subagent-parallel-group/);
  assert.doesNotMatch(parallelHtml, /subagent-running-tool">bash…/);
  assert.doesNotMatch(parallelHtml, /status-chip-label">Running/);
  assert.match(parallelHtml, /status-chip-failed has-error-detail/);
  assert.match(parallelHtml, /Error: spawn EPERM: permission denied/);
});

test('interrupted subagent renders a terminal warning state without live activity', async () => {
  const { ToolCallItem } = await loadWebviewModules();

  const html = renderToString(h(ToolCallItem, {
    toolCall: toolCall({
      id: 'sub-interrupted',
      name: 'subagent',
      status: 'failed',
      input: { agent: 'reviewer', task: 'Review output' },
      result: {
        details: {
          mode: 'single',
          results: [{
            agent: 'reviewer',
            task: 'Review output',
            exitCode: 1,
            messages: [],
            runningTools: ['bash'],
            streaming: true,
            stopReason: 'aborted',
            activityPhase: 'cancelled',
            errorMessage: 'Subagent was interrupted by the parent',
          }],
        },
      },
    }),
    prefs: DEFAULT_CHAT_PREFS,
    workingDirectory: '/repo',
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
  }));

  assert.match(html, /tool-call-subagent[^>]*interrupted/);
  assert.match(html, /status-chip-interrupted/);
  assert.match(html, /status-chip-label">Interrupted/);
  assert.match(html, /aria-label="reviewer interrupted output"/);
  assert.doesNotMatch(html, /subagent-activity/);
  assert.doesNotMatch(html, /turn-activity-tail-cursor/);
  assert.doesNotMatch(html, /\brunning\b/);
});

test('rendered parallel subagent cards keep per-child summaries and statuses while the parent is still running', async () => {
  const { ToolCallItem } = await loadWebviewModules();

  const html = renderToString(h(ToolCallItem, {
    toolCall: toolCall({
      id: 'sub-parallel-running-state',
      name: 'subagent',
      status: 'running',
      input: {
        tasks: [
          { agent: 'scout', task: 'Gather logs' },
          { agent: 'reviewer', task: 'Review output' },
        ],
      },
      result: {
        details: {
          mode: 'parallel',
          results: [
            {
              agent: 'scout',
              task: 'Gather logs',
              exitCode: -1,
              messages: [],
              runningTools: ['bash'],
            },
            {
              agent: 'reviewer',
              task: 'Review output',
              exitCode: 1,
              messages: [],
              stopReason: 'error',
              stderr: 'boom',
            },
          ],
        },
      },
    }),
    prefs: DEFAULT_CHAT_PREFS,
    workingDirectory: '/repo',
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
  }));

  assert.match(html, /subagent-agent-name[^>]*>scout<\/span>/);
  assert.match(html, /subagent-agent-name[^>]*>reviewer<\/span>/);
  assert.match(html, /Gather logs/);
  assert.match(html, /Review output/);
  assert.doesNotMatch(html, /scout: Gather logs/);
  assert.doesNotMatch(html, /reviewer: Review output/);
  assert.equal((html.match(/\btool-call\b[^>]*\btool-call-subagent\b[^>]*\brunning\b/g) ?? []).length, 1);
  assert.equal((html.match(/\btool-call\b[^>]*\btool-call-subagent\b[^>]*\bfailed\b/g) ?? []).length, 1);
  assert.equal((html.match(/status-chip-running/g) ?? []).length, 0);
  assert.equal((html.match(/status-chip-failed/g) ?? []).length, 1);
});

test('subagent card shows preview rows only while collapsed', async () => {
  const { ToolCallItem } = await loadWebviewModules();

  function runningSingle(): ToolCall {
    return toolCall({
      id: 'sub-running-expanded',
      name: 'subagent',
      status: 'running',
      input: { agent: 'worker', task: 'Keep working' },
      result: {
        details: {
          mode: 'single',
          results: [{
            agent: 'worker',
            task: 'Keep working',
            exitCode: 0,
            messages: [],
            runningTools: ['bash'],
          }],
        },
      },
    });
  }

  // Expanded + running: only the full child transcript renders.
  const expandedRunningHtml = renderToString(h(ToolCallItem, {
    toolCall: runningSingle(),
    prefs: { ...DEFAULT_CHAT_PREFS, autoExpandSubagentCalls: true },
    workingDirectory: '/repo',
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
  }));
  assert.doesNotMatch(expandedRunningHtml, /subagent-live-preview/);
  assert.match(expandedRunningHtml, /subagent-messages/);
  assert.match(expandedRunningHtml, /Keep working/);
  assert.doesNotMatch(expandedRunningHtml, /→ bash/);

  // Collapsed + running: the compact preview renders instead of the body.
  const collapsedRunningHtml = renderToString(h(ToolCallItem, {
    toolCall: runningSingle(),
    prefs: { ...DEFAULT_CHAT_PREFS, autoExpandSubagentCalls: false },
    workingDirectory: '/repo',
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
  }));
  assert.match(collapsedRunningHtml, /subagent-live-preview/);
  assert.match(collapsedRunningHtml, /turn-activity-tail-composite/);
  assert.match(collapsedRunningHtml, /Keep working/);
  assert.doesNotMatch(collapsedRunningHtml, /Running bash\.\.\./);
  assert.doesNotMatch(collapsedRunningHtml, /Generating\.\.\./);
  assert.doesNotMatch(collapsedRunningHtml, /pending\.\.\./);
  assert.doesNotMatch(collapsedRunningHtml, /→ bash/);
  assert.doesNotMatch(collapsedRunningHtml, /subagent-messages/);

  const completed = toolCall({
    id: 'sub-completed',
    name: 'subagent',
    status: 'completed',
    input: { agent: 'reviewer', task: 'Inspect regression' },
    result: {
      details: {
        mode: 'single',
        results: [{
          agent: 'reviewer',
          task: 'Inspect regression',
          exitCode: 0,
          messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Looks good.' }] }],
        }],
      },
    },
  });
  const completedExpandedHtml = renderToString(h(ToolCallItem, {
    toolCall: completed,
    prefs: { ...DEFAULT_CHAT_PREFS, autoExpandSubagentCalls: true },
    workingDirectory: '/repo',
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
  }));
  assert.doesNotMatch(completedExpandedHtml, /subagent-live-preview/);
  assert.match(completedExpandedHtml, /Inspect regression/);
  assert.match(completedExpandedHtml, /subagent-messages/);

  // Completed + collapsed retains the task preview without mounting the body.
  const completedCollapsedHtml = renderToString(h(ToolCallItem, {
    toolCall: completed,
    prefs: { ...DEFAULT_CHAT_PREFS, autoExpandSubagentCalls: false },
    workingDirectory: '/repo',
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
  }));
  assert.match(completedCollapsedHtml, /subagent-live-preview/);
  assert.match(completedCollapsedHtml, /Inspect regression/);
  assert.match(completedCollapsedHtml, /status-chip-completed[^>]*>.*Finished/);
  assert.doesNotMatch(completedCollapsedHtml, /subagent-messages/);
});

test('a completed parallel child shows the same finished UI while its sibling keeps running', async () => {
  const { ToolCallItem } = await loadWebviewModules();

  const html = renderToString(h(ToolCallItem, {
    toolCall: toolCall({
      id: 'sub-parallel-partial-completion',
      name: 'subagent',
      status: 'running',
      input: { tasks: [{ agent: 'scout', task: 'A' }, { agent: 'reviewer', task: 'B' }] },
      result: {
        details: {
          mode: 'parallel',
          results: [
            { agent: 'scout', task: 'A', exitCode: 0, messages: [], runningTools: ['read'] },
            { agent: 'reviewer', task: 'B', exitCode: -1, messages: [], streaming: true },
          ],
        },
      },
    }),
    prefs: DEFAULT_CHAT_PREFS,
    workingDirectory: '/repo',
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
  }));

  assert.equal((html.match(/tool-call-subagent[^"]* completed/g) ?? []).length, 1);
  assert.equal((html.match(/status-chip-completed/g) ?? []).length, 1);
  assert.match(html, /Finished/);
  assert.match(html, /Waiting for output/);
});

test('parallel subagent children share one minimally indented batch wrapper', async () => {
  const { ToolCallItem } = await loadWebviewModules();

  const html = renderToString(h(ToolCallItem, {
    toolCall: toolCall({
      id: 'sub-parallel-connector',
      name: 'subagent',
      status: 'completed',
      input: { tasks: [{ agent: 'scout', task: 'A' }, { agent: 'reviewer', task: 'B' }] },
      result: {
        details: {
          mode: 'parallel',
          results: [
            { agent: 'scout', task: 'A', exitCode: 0, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'done A' }] }] },
            { agent: 'reviewer', task: 'B', exitCode: 0, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'done B' }] }] },
          ],
        },
      },
    }),
    prefs: DEFAULT_CHAT_PREFS,
    workingDirectory: '/repo',
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
  }));

  assert.match(html, /subagent-parallel-group/);
  // Exactly one wrapper per parallel child.
  assert.equal((html.match(/class="subagent-parallel-child"/g) ?? []).length, 2);
  // Each child card still renders inside its wrapper.
  assert.equal((html.match(/subagent-agent-name/g) ?? []).length, 2);
});

test('parallel-group CSS uses one thin shallow spine without connector ticks', async () => {
  const css = await readFile(new URL('../../../src/webview/panel/styles/tool-call.css', import.meta.url), 'utf8');
  assert.match(css, /\.subagent-parallel-group\s*\{[^}]*gap:\s*3px/);
  assert.match(css, /\.subagent-parallel-group\s*\{[^}]*padding-left:\s*7px/);
  assert.match(css, /\.subagent-parallel-group\s*\{[^}]*border-left:\s*1px solid color-mix/);
  assert.doesNotMatch(css, /\.subagent-parallel-child::before\s*\{/);

  assert.match(css, /\.tool-call-parallel-child\s*\{[^}]*padding-left:\s*7px/);
  assert.match(css, /\.tool-call-parallel-child::before\s*\{[^}]*top:\s*-3px[^}]*bottom:\s*-3px[^}]*width:\s*1px/);
  assert.doesNotMatch(css, /\.tool-call-parallel-child::after\s*\{/);
  assert.match(css, /\.tool-call-parallel-start::before\s*\{[^}]*top:\s*0/);
  assert.match(css, /\.tool-call-parallel-end::before\s*\{[^}]*bottom:\s*0/);
  assert.doesNotMatch(css, /\.tool-call-parallel-group\s*\{/);
});

test('rendered SystemPromptMessage covers summary fallbacks, suppressed summaries, and token estimate branches', async () => {
  const { SystemPromptMessage } = await loadWebviewModules();

  const prompts: SystemPromptEntry[] = [
    {
      source: 'harness',
      availability: 'available',
      title: 'Harness system prompt',
      text: '**Plan** carefully before editing.\n\nKeep notes.',
      summary: '',
    },
    {
      source: 'provider',
      availability: 'unknown',
      title: 'Provider prompt',
      text: 'Configured elsewhere.',
      summary: 'Configured elsewhere.',
    },
    {
      source: 'user',
      availability: 'hidden',
      title: 'User prompt',
      text: 'Unavailable to the webview.',
      summary: 'Unavailable',
    },
  ];

  const html = renderToString(h(SystemPromptMessage, { prompts }));

  // The collapsed group shows a count and summary, not full markdown content
  assert.match(html, /3 system prompts/);
  assert.match(html, /Harness system prompt/);
  assert.doesNotMatch(html, /Configured elsewhere\.<\/span>/);
  assert.doesNotMatch(html, />Unavailable<\/span>/);
  assert.match(html, /10 tokens/);
  assert.match(html, /not included/i);

  const zeroTokenHtml = renderToString(h(SystemPromptMessage, {
    prompts: [{
      source: 'harness',
      availability: 'available',
      title: 'Blank prompt',
      text: '   ',
      summary: '',
    }],
  }));

  assert.match(zeroTokenHtml, /1 system prompt/);
  assert.doesNotMatch(zeroTokenHtml, /~\d+ tokens/);
});

test('SystemPromptToggleMenu hides display-only entries like the provider card', async () => {
  const { SystemPromptToggleMenu } = await loadWebviewModules();
  const providerEntry: SystemPromptEntry = {
    source: 'provider',
    id: 'provider',
    availability: 'unknown',
    title: 'Provider system prompt',
    text: 'Not directly exposed.',
    summary: 'umans',
    toggleable: false,
  };
  const harnessEntry: SystemPromptEntry = {
    source: 'harness',
    id: 'harness',
    availability: 'available',
    title: 'Harness system prompt',
    text: 'Harness instructions',
    summary: 'Harness instructions',
  };

  // With only the non-toggleable provider card, there is nothing to toggle,
  // so the menu renders nothing (no trigger button).
  const emptyHtml = renderToString(h(SystemPromptToggleMenu, {
    prompts: [providerEntry],
    onSetToggles: () => undefined,
  }));
  assert.equal(emptyHtml, '');

  // Once a toggleable entry exists the trigger renders. The dropdown only mounts
  // when open (SSR defaults to closed); the backend test covers the invariant
  // that the provider entry carries `toggleable: false` and is never disabled.
  const triggerHtml = renderToString(h(SystemPromptToggleMenu, {
    prompts: [providerEntry, harnessEntry],
    onSetToggles: () => undefined,
  }));
  assert.match(triggerHtml, /system-prompt-toggle-trigger/);
});

test('rendered SystemPromptMessage and TranscriptVirtualRow cover prompt and gap rows', async () => {
  const { SystemPromptMessage, TranscriptVirtualRow } = await loadWebviewModules();
  const prompt: SystemPromptEntry = {
    source: 'harness',
    availability: 'available',
    title: 'Harness system prompt',
    text: 'Always validate changes.',
    summary: 'Always validate changes.',
  };

  const systemPromptHtml = renderToString(h(SystemPromptMessage, { prompts: [prompt] }));
  assert.match(systemPromptHtml, /1 system prompt/);
  assert.match(systemPromptHtml, /self-stretch.*flex-col.*rounded-xl.*bg-card/);
  assert.match(systemPromptHtml, /data-scroll-anchor-id="system-prompts"/);
  // Prompt title appears in collapsed summary line
  assert.match(systemPromptHtml, /Harness system prompt/);

  const hiddenSummaryHtml = renderToString(h(SystemPromptMessage, {
    prompts: [
      {
        source: 'provider',
        availability: 'unknown',
        title: 'Provider system prompt',
        text: 'unknown',
        summary: 'unknown',
      },
      {
        source: 'user',
        availability: 'missing',
        title: 'Custom system prompt',
        text: '',
        summary: 'none configured',
      },
    ],
  }));
  assert.match(hiddenSummaryHtml, /2 system prompts/);
  // Titles only visible in expanded content, which SSR doesn't render (groupOpen defaults to false)
  assert.doesNotMatch(hiddenSummaryHtml, /Provider system prompt/);
  assert.doesNotMatch(hiddenSummaryHtml, /max-w-\[var\(--tool-call-summary-column-width\)\]/);

  const topGapHtml = renderToString(h(TranscriptVirtualRow, {
    row: { kind: 'topGap', key: 'top-gap' },
    busy: false,
    prefs: DEFAULT_CHAT_PREFS,
    systemPrompts: [prompt],
    pruningResult: null,
    workingDirectory: '/repo',
    editingId: null,
    isLoadingOlder: false,
    isLoadingNewer: false,
    isLastRow: false,
    onEditRequest: noop,
    onEditConfirm: noop,
    onEditCancel: noop,
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    onRequestOlder: noop,
    onRequestNewer: noop,
    renderToolCall: () => null,
  }));
  assert.match(topGapHtml, /Load older messages/);

  const bottomGapHtml = renderToString(h(TranscriptVirtualRow, {
    row: { kind: 'bottomGap', key: 'bottom-gap' },
    busy: false,
    prefs: DEFAULT_CHAT_PREFS,
    systemPrompts: [prompt],
    pruningResult: null,
    workingDirectory: '/repo',
    editingId: null,
    isLoadingOlder: false,
    isLoadingNewer: true,
    isLastRow: false,
    onEditRequest: noop,
    onEditConfirm: noop,
    onEditCancel: noop,
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    onRequestOlder: noop,
    onRequestNewer: noop,
    renderToolCall: () => null,
  }));
  assert.match(bottomGapHtml, /Loading newer messages…/);

  const pruningActivityState: TurnActivityState = {
    phase: 'pruning',
    label: 'pruning skills/tools',
    tone: 'processing',
    ariaLabel: 'Agent is pruning skills and tools',
  };

  const typingRowHtml = renderToString(h(TranscriptVirtualRow, {
    row: { kind: 'typingIndicator', key: 'typing-row', activityState: pruningActivityState },
    busy: true,
    prefs: DEFAULT_CHAT_PREFS,
    systemPrompts: [prompt],
    pruningResult: null,
    workingDirectory: '/repo',
    editingId: null,
    isLoadingOlder: false,
    isLoadingNewer: false,
    isLastRow: true,
    onEditRequest: noop,
    onEditConfirm: noop,
    onEditCancel: noop,
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    onRequestOlder: noop,
    onRequestNewer: noop,
    renderToolCall: () => null,
  }));
  assert.match(typingRowHtml, /activity-status-row/);
  assert.match(typingRowHtml, /aria-label="Agent is pruning skills and tools"/);
  assert.match(typingRowHtml, /turn-activity-strip warning standalone/);
  assert.match(typingRowHtml, /turn-activity-strip-label">pruning skills\/tools</);
  assert.doesNotMatch(typingRowHtml, /turn-activity-strip-dot running/);

  const thinkingActivityState: TurnActivityState = {
    phase: 'thinking',
    label: 'thinking',
    tone: 'processing',
    ariaLabel: 'Agent is thinking',
  };

  const messageRowHtml = renderToString(h(TranscriptVirtualRow, {
    row: { kind: 'message', key: 'message-row', message: assistantMessage([{ kind: 'text', text: 'Rendered row' }], { status: 'completed' }), activityState: thinkingActivityState },
    busy: true,
    prefs: DEFAULT_CHAT_PREFS,
    systemPrompts: [prompt],
    pruningResult: null,
    workingDirectory: '/repo',
    editingId: null,
    isLoadingOlder: false,
    isLoadingNewer: false,
    isLastRow: true,
    onEditRequest: noop,
    onEditConfirm: noop,
    onEditCancel: noop,
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    onRequestOlder: noop,
    onRequestNewer: noop,
    renderToolCall: () => null,
  }));
  assert.match(messageRowHtml, /Rendered row/);
  assert.match(messageRowHtml, /turn-activity-strip warning/);
  assert.match(messageRowHtml, /turn-activity-strip-label">thinking</);
  assert.match(messageRowHtml, /turn-activity-strip-dot running/);

  const emptyPromptHtml = renderToString(h(SystemPromptMessage, { prompts: [] }));
  assert.equal(emptyPromptHtml, '');
  assert.deepEqual(EMPTY_TRANSCRIPT_WINDOW, {
    totalCount: 0,
    loadedStart: 0,
    loadedEnd: 0,
    hasOlder: false,
    hasNewer: false,
    isPartial: false,
    hasUserMessages: false,
  });
});

test('rendered assistant pruning header shows compact counts and expanded diagnostics', async () => {
  const { MessageItem } = await loadWebviewModules();
  const { PruningHeaderButton, PruningHeaderChip, PruningHeaderPanel } = await import('../../../src/webview/panel/transcript/pruning-header.tsx');
  const { formatPruningSummary, normalizePruningDetails } = await import('../../../src/webview/panel/transcript/pruning.ts');

  const details: PruningDetails = {
    includedSkills: ['debugging', 'tests', 'review'],
    excludedSkills: Array.from({ length: 11 }, (_, i) => `skill-${i}`),
    includedTools: ['read', 'edit', 'bash', 'write', 'search'],
    excludedTools: Array.from({ length: 8 }, (_, i) => `tool-${i}`),
    mode: 'auto',
    skillTokensSaved: 1200,
    toolTokensSaved: 880,
    prepassModel: 'gpt-5-mini',
    prepassThinkingLevel: 'minimal',
    prepassLatencyMs: 52,
    prepassThinking: 'Keep code-editing tools and remove unrelated discovery tools.',
    prepassSystemPrompt: 'You are a pruner.',
    prepassUserMessage: 'Choose skills and tools.',
    prepassResponse: '{"skills":["debugging"]}',
  };

  assert.equal(
    formatPruningSummary(details),
    'Kept 3/14 skills, Kept 5/13 tools · Saved 2080 tokens',
  );

  const messageHtml = renderToString(h(MessageItem, {
    message: assistantMessage([{ kind: 'text', text: 'Done' }], { status: 'completed' }),
    isStreaming: false,
    prefs: DEFAULT_CHAT_PREFS,
    readonly: false,
    workingDirectory: '/repo',
    editingId: null,
    onEditRequest: noop,
    onEditConfirm: noop,
    onEditCancel: noop,
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
    isLastAssistantMessage: false,
    pruningHeaderState: { kind: 'result', details },
  }));

  assert.match(messageHtml, /aria-label="Kept 3\/14 skills, Kept 5\/13 tools · Saved 2080 tokens"/);
  assert.match(messageHtml, /Kept 3\/14 skills, Kept 5\/13 tools · Saved 2080 tokens/);
  assert.doesNotMatch(messageHtml, /Skills pruned/);

  const chipHtml = renderToString(h(PruningHeaderButton, {
    details,
    expanded: true,
    onToggle: noop,
  }));
  const pendingChipHtml = renderToString(h(PruningHeaderChip, {
    state: { kind: 'pending', label: 'pruning skills/tools' },
    expanded: false,
    onToggle: noop,
  }));
  assert.match(chipHtml, /aria-expanded="true"/);
  assert.match(chipHtml, /Kept 3\/14 skills/);
  assert.match(pendingChipHtml, /role="status"/);
  assert.match(pendingChipHtml, /aria-live="polite"/);
  assert.match(pendingChipHtml, /agent-activity-text">pruning skills\/tools<\/span>/);
  assert.doesNotMatch(pendingChipHtml, /aria-expanded=/);

  const panelHtml = renderToString(h(PruningHeaderPanel, {
    details,
    rawExpanded: true,
    onRawToggle: noop,
  }));
  assert.match(panelHtml, /Prepass/);
  assert.match(panelHtml, /gpt-5-mini · minimal · 52ms/);
  assert.match(panelHtml, /3\/14/);
  assert.match(panelHtml, /5\/13/);
  assert.match(panelHtml, /tokens saved/);
  assert.match(panelHtml, /Skills/);
  assert.match(panelHtml, /skill-0/);
  assert.match(panelHtml, /Reasoning/);
  assert.match(panelHtml, /Prepass prompts and output/);
  assert.match(panelHtml, /You are a pruner\./);
  // Reasoning lives in a collapsed sub-section by default, so its body text
  // is absent until the section is expanded (unlike the always-open raw
  // prompts, whose system prompt is present via rawExpanded: true).
  assert.doesNotMatch(panelHtml, /Keep code-editing tools/);

  assert.deepEqual(normalizePruningDetails({ prepassError: 'timeout' })?.includedSkills, []);
});

test('rendered MessageItem keeps pruning pending state in the header without an inline body indicator', async () => {
  const { MessageItem } = await loadWebviewModules();

  const html = renderToString(h(MessageItem, {
    message: assistantMessage([], { status: 'completed', modelId: 'gpt-5.4', thinkingLevel: 'xhigh' }),
    isStreaming: false,
    prefs: DEFAULT_CHAT_PREFS,
    readonly: false,
    workingDirectory: '/repo',
    editingId: null,
    onEditRequest: noop,
    onEditConfirm: noop,
    onEditCancel: noop,
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
    isLastAssistantMessage: true,
    pruningHeaderState: { kind: 'pending', label: 'pruning skills/tools' },
  }));

  assert.match(html, /role="status"/);
  assert.match(html, /gpt-5\.4 xhigh/);
  assert.match(html, /agent-activity-text">pruning skills\/tools<\/span>/);
  assert.doesNotMatch(html, /message-typing-indicator/);
});

test('rendered failed assistant turn exposes copyable error detail without a redundant edit-previous-prompt action', async () => {
  const { MessageItem } = await loadWebviewModules();

  const failedAssistant = assistantMessage([{ kind: 'text', text: 'Partial' }], {
    id: 'assistant-99',
    status: 'error',
    errorDetail: 'Backend connection reset',
  });

  const html = renderToString(h(MessageItem, {
    message: failedAssistant,
    isStreaming: false,
    prefs: DEFAULT_CHAT_PREFS,
    readonly: false,
    workingDirectory: '/repo',
    editingId: null,
    onEditRequest: noop,
    onEditConfirm: noop,
    onEditCancel: noop,
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
    isLastAssistantMessage: false,
  }));

  assert.match(html, /Backend connection reset/);
  assert.match(html, /aria-label="Copy error detail"/);
  assert.doesNotMatch(html, /Edit previous prompt/);
  assert.doesNotMatch(html, /Load older messages to retry/);
});

test('rendered TurnActivityStrip covers all tones, standalone/inline variants, and runningDot states', async () => {
  // Neutral tone - inline (no standalone class)
  const neutralInlineHtml = renderToString(h(TurnActivityStrip, {
    label: 'thinking',
    tone: 'neutral',
    runningDot: false,
    standalone: false,
  }));
  assert.match(neutralInlineHtml, /turn-activity-strip/);
  assert.doesNotMatch(neutralInlineHtml, /standalone/);
  assert.doesNotMatch(neutralInlineHtml, /\.accent/);
  assert.doesNotMatch(neutralInlineHtml, /\.warning/);
  assert.match(neutralInlineHtml, /role="status"/);
  assert.match(neutralInlineHtml, /turn-activity-strip-dot/);
  assert.match(neutralInlineHtml, /turn-activity-strip-label">thinking</);
  assert.doesNotMatch(neutralInlineHtml, /turn-activity-strip-dot running/);

  // Neutral tone - standalone
  const neutralStandaloneHtml = renderToString(h(TurnActivityStrip, {
    label: 'preparing response',
    tone: 'neutral',
    runningDot: false,
    standalone: true,
  }));
  assert.match(neutralStandaloneHtml, /turn-activity-strip.*standalone/);
  assert.match(neutralStandaloneHtml, /role="status"/);

  // Accent tone with runningDot
  const accentHtml = renderToString(h(TurnActivityStrip, {
    label: 'running read',
    tone: 'accent',
    runningDot: true,
    standalone: false,
  }));
  assert.match(accentHtml, /turn-activity-strip.*accent/);
  assert.match(accentHtml, /turn-activity-strip-dot running/);
  assert.match(accentHtml, /turn-activity-strip-label">running read</);

  // Warning tone with detail
  const warningHtml = renderToString(h(TurnActivityStrip, {
    label: 'thinking',
    detail: 'Planning the fix',
    tone: 'warning',
    runningDot: true,
    standalone: false,
  }));
  assert.match(warningHtml, /turn-activity-strip.*warning/);
  assert.match(warningHtml, /turn-activity-strip-detail">Planning the fix</);
  assert.match(warningHtml, /aria-label="Activity status: thinking, Planning the fix"/);

  // Error tone
  const errorHtml = renderToString(h(TurnActivityStrip, {
    label: 'failed',
    tone: 'error',
    runningDot: false,
    standalone: true,
  }));
  assert.match(errorHtml, /turn-activity-strip.*error.*standalone/);
  assert.match(errorHtml, /turn-activity-strip-dot/);

  // Success tone
  const successHtml = renderToString(h(TurnActivityStrip, {
    label: 'completed',
    tone: 'success',
    runningDot: false,
    standalone: true,
  }));
  assert.match(successHtml, /turn-activity-strip.*success.*standalone/);

  // Without detail, aria-label uses the Activity status prefix
  const noDetailHtml = renderToString(h(TurnActivityStrip, {
    label: 'running tools',
    tone: 'accent',
    runningDot: true,
    standalone: false,
  }));
  assert.match(noDetailHtml, /aria-label="Activity status: running tools"/);
  assert.doesNotMatch(noDetailHtml, /turn-activity-strip-detail/);
});

// ── Terminal footer: exit code, clickable full-log, truncation ──────────────
// The SDK's bash tool throws on non-zero exit, appending "Command exited with
// code N" to the result text; the footer recovers that code via extractExitCode
// and renders a danger-tinted badge. The old plain-text "Full log: path" is now
// a ClickablePathButton. Only non-zero codes are surfaced (alert on failure).

test('ToolCallCard terminal footer surfaces exit code, clickable full-log path, and truncation', () => {
  const html = renderToString(h(toolCallCardModule.ToolCallCard, {
    toolCall: toolCall({
      id: 'footer-exit-trunc',
      name: 'bash',
      input: { command: 'grep missing src' },
      status: 'failed',
      result: {
        content: [{ type: 'text', text: 'no matches\n\nCommand exited with code 1' }],
        details: {
          truncation: { truncated: true, totalLines: 100, outputLines: 10 },
          fullOutputPath: '/tmp/bash-output-abc.log',
        },
      },
    }),
    autoExpand: true,
    workingDirectory: '/repo',
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
  }));

  assert.match(html, /tool-call-terminal-footer/);
  assert.match(html, /tool-call-terminal-exit/);
  assert.match(html, /exit 1/);
  assert.match(html, /Output truncated.+showing 10 of 100 lines/);
  assert.match(html, /Full log:/);
  // The full-log path is a ClickablePathButton: the file leaf is a link button.
  assert.match(html, /transcript-header-summary-link/);
  assert.match(html, /bash-output-abc\.log/);
});

test('ToolCallCard terminal footer shows the exit-code badge without a truncation notice when output fits', () => {
  const html = renderToString(h(toolCallCardModule.ToolCallCard, {
    toolCall: toolCall({
      id: 'footer-exit-only',
      name: 'bash',
      input: { command: 'false' },
      status: 'failed',
      result: { content: [{ type: 'text', text: 'Command exited with code 2' }] },
    }),
    autoExpand: true,
    workingDirectory: '/repo',
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
  }));

  assert.match(html, /tool-call-terminal-footer/);
  assert.match(html, /exit 2/);
  assert.doesNotMatch(html, /Output truncated/);
  assert.doesNotMatch(html, /Full log:/);
});

test('ToolCallCard omits the terminal output row when a bash call has no output', () => {
  const cases = [
    toolCall({
      id: 'terminal-empty-running',
      name: 'bash',
      input: { command: 'sleep 1' },
      status: 'running',
      result: undefined,
    }),
    toolCall({
      id: 'terminal-empty-completed',
      name: 'bash',
      input: { command: 'true' },
      status: 'completed',
      result: { content: [{ type: 'text', text: '' }] },
    }),
  ];

  for (const emptyCall of cases) {
    const html = renderToString(h(toolCallCardModule.ToolCallCard, {
      toolCall: emptyCall,
      autoExpand: true,
      workingDirectory: '/repo',
      onOpenFile: noop,
      onContextMenu: noopContextMenu,
    }));

    assert.match(html, /tool-call-terminal-command/);
    assert.doesNotMatch(html, /class="tool-call-terminal"/);
    assert.doesNotMatch(html, /Executing…|\(no output\)|tool-call-terminal-empty/);
  }
});

test('ToolCallCard terminal footer is absent for a successful command with no exit signal', () => {
  const html = renderToString(h(toolCallCardModule.ToolCallCard, {
    toolCall: toolCall({
      id: 'footer-success',
      name: 'bash',
      input: { command: 'echo hi' },
      status: 'completed',
      result: { content: [{ type: 'text', text: 'hi' }] },
    }),
    autoExpand: true,
    workingDirectory: '/repo',
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
  }));

  assert.doesNotMatch(html, /tool-call-terminal-footer/);
  assert.doesNotMatch(html, /tool-call-terminal-exit/);
});

test('ToolCallCard terminal footer does not badge a successful command whose output coincidentally contains the exit phrase', () => {
  // The SDK only surfaces a non-zero exit by throwing (status 'failed') with
  // "Command exited with code N" appended. A completed command whose own
  // output contains that phrase must NOT trigger a false-positive badge.
  const html = renderToString(h(toolCallCardModule.ToolCallCard, {
    toolCall: toolCall({
      id: 'footer-false-positive',
      name: 'bash',
      input: { command: 'echo "Command exited with code 5"' },
      status: 'completed',
      result: { content: [{ type: 'text', text: 'Command exited with code 5' }] },
    }),
    autoExpand: true,
    workingDirectory: '/repo',
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
  }));

  assert.doesNotMatch(html, /tool-call-terminal-exit/);
  assert.doesNotMatch(html, /exit 5/);
  assert.doesNotMatch(html, /tool-call-terminal-footer/);
});

test('ToolCallCard terminal footer badges a non-zero exit code carried in a result field', () => {
  const html = renderToString(h(toolCallCardModule.ToolCallCard, {
    toolCall: toolCall({
      id: 'footer-exit-field',
      name: 'bash',
      input: { command: 'npm test' },
      status: 'failed',
      result: { exitCode: 7, content: [{ type: 'text', text: 'tests failed' }] },
    }),
    autoExpand: true,
    workingDirectory: '/repo',
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
  }));

  assert.match(html, /tool-call-terminal-exit/);
  assert.match(html, /exit 7/);
});

test('ToolCallCard terminal pane strips ANSI escape sequences from streamed output', () => {
  const html = renderToString(h(toolCallCardModule.ToolCallCard, {
    toolCall: toolCall({
      id: 'footer-ansi',
      name: 'bash',
      input: { command: 'ls --color=always' },
      status: 'completed',
      result: { content: [{ type: 'text', text: '\x1b[31mred banner\x1b[0m\nfile.txt' }] },
    }),
    autoExpand: true,
    workingDirectory: '/repo',
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
  }));

  assert.match(html, /red banner/);
  assert.match(html, /file\.txt/);
  assert.ok(!html.includes('\x1b'), 'raw ANSI ESC sequences must not reach the rendered terminal pane');
});

// ── Reasoning: collapsed size hint + expanded streaming cursor ──────────────

test('ReasoningBlock shows a line-count hint when collapsed for multi-line reasoning', () => {
  const html = renderToString(h(messageItemModule.ReasoningBlock, {
    text: 'first line of reasoning\nsecond line\nthird line',
    autoExpand: false,
    collapsibleKey: 'reasoning:hint-multi',
    onContextMenu: noopContextMenu,
  }));
  assert.match(html, /Reasoning/);
  assert.match(html, /3 lines/);
});

test('ReasoningBlock omits the size hint for single-line reasoning', () => {
  const html = renderToString(h(messageItemModule.ReasoningBlock, {
    text: 'a single short thought',
    autoExpand: false,
    collapsibleKey: 'reasoning:hint-single',
    onContextMenu: noopContextMenu,
  }));
  assert.doesNotMatch(html, /~1 line/);
  assert.doesNotMatch(html, /~\d+ lines/);
});

test('ReasoningBlock renders a streaming cursor while open and streaming', () => {
  const html = renderToString(h(messageItemModule.ReasoningBlock, {
    text: 'thinking through the plan',
    autoExpand: true,
    collapsibleKey: 'reasoning:cursor-streaming',
    streaming: true,
    onContextMenu: noopContextMenu,
  }));
  assert.match(html, /reasoning-stream-cursor/);
  assert.match(html, /data-streaming="true"/);
  assert.match(html, /data-provisional="true"/);
});

test('ReasoningBlock omits the streaming cursor when not streaming', () => {
  const html = renderToString(h(messageItemModule.ReasoningBlock, {
    text: 'thinking through the plan',
    autoExpand: true,
    collapsibleKey: 'reasoning:cursor-idle',
    onContextMenu: noopContextMenu,
  }));
  assert.doesNotMatch(html, /reasoning-stream-cursor/);
});
