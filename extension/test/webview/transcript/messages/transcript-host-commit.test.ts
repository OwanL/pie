import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { h, render } from 'preact';
import { memo } from 'preact/compat';
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

function ToolCommitLeaf({ tool, onRender }: { tool: ToolCall; onRender?: () => void }) {
  onRender?.();
  commitRegistryModule.useCommittedToolLeaf(tool);
  return null;
}

const MemoizedToolLeafList = memo(function MemoizedToolLeafList({
  message,
  onToolLeafRender,
}: {
  message: ChatMessage;
  onToolLeafRender?: () => void;
}) {
  return h(commitRegistryModule.MessageCommitContext.Provider, {
    value: { messageId: message.id, toolStateRevision: message.toolStateRevision ?? 0 },
    children: message.toolCalls?.map((tool) => h(ToolCommitLeaf, { key: tool.id, tool, onRender: onToolLeafRender })),
  });
});

function CommitRegistryProbe({
  message,
  observe,
  onToolLeafRender,
}: {
  message: ChatMessage;
  observe: (size: number) => void;
  onToolLeafRender?: () => void;
}) {
  commitRegistryModule.useCommittedMessageLeaf(message);
  const registry = commitRegistryModule.useTranscriptCommitRegistry();
  useLayoutEffect(() => observe(registry.leaves.size), [registry.version, registry.leaves, observe]);
  return h(MemoizedToolLeafList, { message, onToolLeafRender });
}

test('mounted commit provider retains every accepted leaf above the former 512-leaf boundary', async () => {
  const root = document.getElementById('root')!;
  const tools: ToolCall[] = Array.from({ length: 512 }, (_, index) => ({
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
    toolStateRevision: 512,
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
  let toolLeafRenders = 0;

  render(h(TranscriptCommitProvider, {
    target,
    appSurface: 'transcript',
    postMessage() {},
    children: h(CommitRegistryProbe, {
      message,
      observe: (size) => observedSizes.push(size),
      onToolLeafRender: () => { toolLeafRenders += 1; },
    }),
  }), root);
  await new Promise((resolve) => setImmediate(resolve));
  render(null, root);

  assert.equal(Math.max(...observedSizes), 513, 'message plus 512 live tool leaves must exceed the old boundary');
  assert.equal(toolLeafRenders, tools.length, 'registry bookkeeping must not rerender every leaf consumer');
});

test('commit registry preserves mounted leaf evidence across revision-only targets', async () => {
  const root = document.getElementById('root')!;
  const tool: ToolCall = { id: 'stable-tool', name: 'read', input: {}, status: 'completed' };
  const message: ChatMessage = {
    id: 'stable-message',
    role: 'assistant',
    createdAt: new Date(0).toISOString(),
    markdown: '',
    status: 'completed',
    toolCalls: [tool],
    parts: [{ kind: 'toolCall', toolCall: tool }],
  };
  const window = {
    loadedStart: 0, loadedEnd: 1, totalCount: 1,
    hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false,
  };
  const maps: Array<ReadonlyMap<string, unknown>> = [];
  function RegistryMapProbe() {
    commitRegistryModule.useCommittedMessageLeaf(message);
    const registry = commitRegistryModule.useTranscriptCommitRegistry();
    useLayoutEffect(() => {
      maps.push(registry.leaves);
    }, [registry.target, registry.leaves]);
    return h(commitRegistryModule.MessageCommitContext.Provider, {
      value: { messageId: message.id, toolStateRevision: 0 },
      children: h(ToolCommitLeaf, { tool }),
    });
  }
  const target = (revision: number) => ({
    revision,
    viewGeneration: 1,
    expectedTranscriptIdentity: `identity-${revision}`,
    acceptedAt: 1,
    state: {
      transcript: [message], transcriptWindow: window,
      activeSessionPath: '/stable', openTabPaths: ['/stable'],
    },
  });

  render(h(TranscriptCommitProvider, {
    target: target(1), appSurface: 'transcript', postMessage() {}, children: h(RegistryMapProbe, {}),
  }), root);
  await new Promise((resolve) => setImmediate(resolve));
  const firstMap = maps.at(-1);
  assert.ok(firstMap);
  assert.equal(firstMap.size, 2);

  render(h(TranscriptCommitProvider, {
    target: target(2), appSurface: 'transcript', postMessage() {}, children: h(RegistryMapProbe, {}),
  }), root);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(maps.at(-1), firstMap, 'an unchanged mounted DOM leaf map must survive a snapshot revision');
  assert.equal(maps.at(-1)?.size, 2);
  render(null, root);
  assert.equal(firstMap.size, 0, 'unmounted DOM leaves must be released from preserved evidence');
});

test('app commit reports only a transcript block that survives the render grace period', async () => {
  const messages: any[] = [];
  const root = document.getElementById('root')!;
  const pendingTimers = new Map<number, TimerHandler>();
  const originalSetTimeout = window.setTimeout;
  const originalClearTimeout = window.clearTimeout;
  let nextTimer = 1;
  window.setTimeout = ((callback: TimerHandler) => {
    const id = nextTimer++;
    pendingTimers.set(id, callback);
    return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((id: number) => { pendingTimers.delete(id); }) as typeof window.clearTimeout;
  const flushTimers = () => {
    const callbacks = [...pendingTimers.values()];
    pendingTimers.clear();
    for (const callback of callbacks) {
      if (typeof callback === 'function') callback();
    }
  };
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

  try {
    render(h(TranscriptCommitProvider, {
      target,
      appSurface: 'transcript',
      postMessage: (message: any) => messages.push(message),
      children: h(TranscriptHost, hostProps as never),
    }), root);

    assert.ok(messages.some((message) => message.type === 'appCommitted' && message.payload.revision === 7));
    assert.equal(messages.some((message) => message.type === 'transcriptCommitBlocked'), false);
    await new Promise((resolve) => setImmediate(resolve));
    flushTimers();
    assert.equal(
      messages.some((message) => message.type === 'transcriptCommitBlocked'),
      false,
      'the transient first layout must cancel its warning timer',
    );
    assert.ok(messages.some((message) => message.type === 'transcriptCommitted' && message.payload.revision === 7));

    // Webview-local optimistic rows and tab selection may change after the
    // authoritative target was already proven. They must not retroactively
    // reopen that settled target and emit the structure_mismatch warnings seen
    // in the live log.
    messages.length = 0;
    const optimistic: ChatMessage = {
      id: 'local-pending', role: 'user', createdAt: '', markdown: 'Pending', status: 'completed',
    };
    render(h(TranscriptCommitProvider, {
      target,
      appSurface: 'transcript',
      postMessage: (message: any) => messages.push(message),
      children: h(TranscriptHost, {
        ...hostProps,
        openTabPaths: ['/local'],
        activeSessionPath: '/local',
        transcript: [optimistic],
      } as never),
    }), root);
    flushTimers();
    assert.equal(
      messages.some((message) => message.type === 'transcriptCommitBlocked'),
      false,
      'local optimistic transcript and tab state cannot invalidate a target that already committed',
    );

    const uncommittedTarget = { ...target, revision: 8 };
    render(h(TranscriptCommitProvider, {
      target: uncommittedTarget,
      appSurface: 'transcript',
      postMessage: (message: any) => messages.push(message),
      children: h(TranscriptHost, {
        ...hostProps,
        openTabPaths: ['/actual'],
        activeSessionPath: '/actual',
      } as never),
    }), root);
    flushTimers();

    assert.deepEqual(
      messages.filter((message) => message.type === 'transcriptCommitBlocked').map((message) => message.payload.reason),
      ['structure_mismatch'],
    );
  } finally {
    render(null, root);
    window.setTimeout = originalSetTimeout;
    window.clearTimeout = originalClearTimeout;
  }
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
