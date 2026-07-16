import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { h, render } from 'preact';
import { useLayoutEffect } from 'preact/hooks';
import type { ChatMessage, ToolCall } from '../../../../src/shared/protocol/messages';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  Node: dom.window.Node,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
})) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
Object.defineProperty(globalThis, 'requestAnimationFrame', {
  configurable: true,
  writable: true,
  value: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
});
Object.defineProperty(globalThis, 'cancelAnimationFrame', {
  configurable: true,
  writable: true,
  value: (handle: number) => clearTimeout(handle),
});

let TranscriptCommitProvider: typeof import('../../../../src/webview/panel/transcript/commit-registry').TranscriptCommitProvider;
let TranscriptHost: typeof import('../../../../src/webview/panel/transcript/transcript-host').TranscriptHost;
let commitRegistryModule: typeof import('../../../../src/webview/panel/transcript/commit-registry');

test.before(async () => {
  commitRegistryModule = await import('../../../../src/webview/panel/transcript/commit-registry');
  ({ TranscriptCommitProvider } = commitRegistryModule);
  ({ TranscriptHost } = await import('../../../../src/webview/panel/transcript/transcript-host'));
});

function ToolCommitLeaf({ tool }: { tool: ToolCall }) {
  commitRegistryModule.useCommittedToolLeaf(tool);
  return null;
}

function CommitRegistryProbe({ message, observe }: { message: ChatMessage; observe: (size: number) => void }) {
  commitRegistryModule.useCommittedMessageLeaf(message);
  const registry = commitRegistryModule.useTranscriptCommitRegistry();
  useLayoutEffect(() => observe(registry.leaves.size), [registry.version, registry.leaves, observe]);
  return h(commitRegistryModule.MessageCommitContext.Provider, {
    value: { messageId: message.id, toolStateRevision: message.toolStateRevision ?? 0 },
    children: message.toolCalls?.map((tool) => h(ToolCommitLeaf, { key: tool.id, tool })),
  });
}

test('mounted commit provider retains every accepted leaf above the former 512-leaf boundary', async () => {
  const root = document.getElementById('root')!;
  const tools: ToolCall[] = Array.from({ length: 600 }, (_, index) => ({
    id: `tool-${index}`,
    name: 'read',
    input: { index },
    status: 'running',
    executionId: `execution-${index}`,
    seq: index + 1,
    phase: 'running',
  }));
  const message: ChatMessage = {
    id: 'large-live-owner',
    role: 'assistant',
    createdAt: new Date(0).toISOString(),
    markdown: '',
    status: 'streaming',
    toolCalls: tools,
    parts: tools.map((tool) => ({ kind: 'toolCall' as const, toolCall: tool })),
    toolStateRevision: 600,
  };
  const window = {
    loadedStart: 0, loadedEnd: 1, totalCount: 1,
    hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false,
  };
  const target = {
    revision: 9,
    viewGeneration: 4,
    expectedTranscriptIdentity: 'large-live-owner',
    acceptedAt: 1,
    state: {
      transcript: [message], transcriptWindow: window,
      activeSessionPath: '/large', openTabPaths: ['/large'],
    },
  };
  const observedSizes: number[] = [];

  render(h(TranscriptCommitProvider, {
    target,
    appSurface: 'transcript',
    postMessage() {},
    children: h(CommitRegistryProbe, { message, observe: (size) => observedSizes.push(size) }),
  }), root);
  await new Promise((resolve) => setImmediate(resolve));
  render(null, root);

  assert.equal(Math.max(...observedSizes), 601, 'message plus all 600 live tool leaves must remain registered');
});

test('app commit reports only a transcript block that survives the render grace period', async () => {
  const messages: any[] = [];
  const root = document.getElementById('root')!;
  const target = {
    revision: 7,
    viewGeneration: 3,
    expectedTranscriptIdentity: 'identity',
    acceptedAt: 1,
    state: {
      transcript: [],
      transcriptWindow: {
        loadedStart: 0, loadedEnd: 0, totalCount: 0,
        hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false,
      },
      activeSessionPath: '/expected',
      openTabPaths: ['/expected'],
    },
  };
  const hostProps = {
    openTabPaths: ['/expected'],
    activeSessionPath: '/expected',
    transcript: [],
    transcriptWindow: target.state.transcriptWindow,
    transcriptLoaded: true,
    busy: false,
    prefs: { showPruningMessages: true },
    pruningSettings: {},
    systemPrompts: [],
    pruningResult: null,
    workingDirectory: null,
    editingId: null,
    onEditRequest() {},
    onEditConfirm() {},
    onEditCancel() {},
    onOpenFile() {},
    onContextMenu() {},
    postMessage: (message: any) => messages.push(message),
  };

  render(h(TranscriptCommitProvider, {
    target,
    appSurface: 'transcript',
    postMessage: (message: any) => messages.push(message),
    children: h(TranscriptHost, hostProps as never),
  }), root);

  assert.ok(messages.some((message) => message.type === 'appCommitted' && message.payload.revision === 7));
  assert.equal(messages.some((message) => message.type === 'transcriptCommitBlocked'), false);
  await new Promise((resolve) => setTimeout(resolve, 275));
  assert.equal(
    messages.some((message) => message.type === 'transcriptCommitBlocked'),
    false,
    'the transient first layout must settle without a warning',
  );

  render(h(TranscriptCommitProvider, {
    target,
    appSurface: 'transcript',
    postMessage: (message: any) => messages.push(message),
    children: h(TranscriptHost, {
      ...hostProps,
      openTabPaths: ['/actual'],
      activeSessionPath: '/actual',
    } as never),
  }), root);
  await new Promise((resolve) => setTimeout(resolve, 275));
  render(null, root);

  assert.deepEqual(
    messages.filter((message) => message.type === 'transcriptCommitBlocked').map((message) => message.payload.reason),
    ['structure_mismatch'],
  );
});

test('switching the active session remounts the transcript surface', () => {
  const root = document.getElementById('root')!;
  const window = {
    loadedStart: 0,
    loadedEnd: 0,
    totalCount: 0,
    hasOlder: false,
    hasNewer: false,
    isPartial: false,
    hasUserMessages: false,
  };
  const props = {
    openTabPaths: ['/session/a', '/session/b'],
    activeSessionPath: '/session/a',
    transcript: [],
    transcriptWindow: window,
    transcriptLoaded: true,
    busy: false,
    prefs: { showPruningMessages: true },
    pruningSettings: {},
    systemPrompts: [],
    pruningResult: null,
    workingDirectory: null,
    editingId: null,
    onEditRequest() {},
    onEditConfirm() {},
    onEditCancel() {},
    onOpenFile() {},
    onContextMenu() {},
    postMessage() {},
  };

  render(h(TranscriptHost, props as never), root);
  const firstSurface = root.querySelector('.transcript-surface');
  assert.ok(firstSurface);

  render(h(TranscriptHost, {
    ...props,
    activeSessionPath: '/session/b',
  } as never), root);
  const secondSurface = root.querySelector('.transcript-surface');
  assert.ok(secondSurface);

  assert.notEqual(secondSurface, firstSurface, 'session identity must be a component remount boundary');
  render(null, root);
});
