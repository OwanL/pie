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
Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  writable: true,
  value: class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
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
  return h(commitRegistryModule.CommittedToolLeaf, { toolCall: tool });
}

const MemoizedToolLeafList = memo(function MemoizedToolLeafList({
  message,
  onToolLeafRender,
}: {
  message: ChatMessage;
  onToolLeafRender?: () => void;
}) {
  return h(commitRegistryModule.MessageCommitContext.Provider, {
    value: { messageId: message.id },
    children: h(commitRegistryModule.MessageToolRevisionContext.Provider, {
      value: message.toolStateRevision ?? 0,
      children: message.toolCalls?.map((tool) => h(ToolCommitLeaf, { key: tool.id, tool, onRender: onToolLeafRender })),
    }),
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
      value: { messageId: message.id },
      children: h(commitRegistryModule.MessageToolRevisionContext.Provider, {
        value: 0,
        children: h(ToolCommitLeaf, { tool }),
      }),
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

    // A reconnect keeps this mounted tree and its leaves, but supplies a new
    // target from a fresh ledger. Numeric revision/generation and semantic
    // identity may all coincide with the preceding socket's last snapshot.
    messages.length = 0;
    const reconnectedTarget = { ...target };
    render(h(TranscriptCommitProvider, {
      target: reconnectedTarget,
      appSurface: 'transcript',
      postMessage: (message: any) => messages.push(message),
      children: h(TranscriptHost, hostProps as never),
    }), root);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(messages.some((message) => message.type === 'appCommitted'), 'the new target gets fresh app evidence');
    assert.ok(messages.some((message) => message.type === 'transcriptCommitted'), 'the new ledger gets fresh transcript evidence');

    // Webview-local optimistic rows and tab selection may change after the
    // authoritative target was already proven. They must not retroactively
    // reopen that settled target and emit the structure_mismatch warnings seen
    // in the live log.
    messages.length = 0;
    const optimistic: ChatMessage = {
      id: 'local-pending', role: 'user', createdAt: '', markdown: 'Pending', status: 'completed',
    };
    render(h(TranscriptCommitProvider, {
      target: reconnectedTarget,
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

test('switching session props preserves the transcript host and surface while committing the new session content', async () => {
  const root = document.getElementById('root')!;
  const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  const originalWindowRaf = window.requestAnimationFrame;
  const originalWindowCaf = window.cancelAnimationFrame;
  window.requestAnimationFrame = globalThis.requestAnimationFrame;
  window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: { configurable: true, get: () => 320 },
    offsetHeight: { configurable: true, get: () => 640 },
  });
  const transcriptWindow = {
    loadedStart: 0,
    loadedEnd: 1,
    totalCount: 1,
    hasOlder: false,
    hasNewer: false,
    isPartial: false,
    hasUserMessages: true,
  };
  const sessionA: ChatMessage[] = [{
    id: 'message-a', role: 'user', createdAt: '', markdown: 'Session A content', status: 'completed',
  }];
  const sessionB: ChatMessage[] = [{
    id: 'message-b', role: 'user', createdAt: '', markdown: 'Session B content', status: 'completed',
  }];
  const messages: any[] = [];
  const props = {
    openTabPaths: ['/session/a', '/session/b'],
    activeSessionPath: '/session/a',
    transcript: sessionA,
    transcriptWindow,
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
  const target = (revision: number, activeSessionPath: string, transcript: ChatMessage[], identity: string) => ({
    revision,
    viewGeneration: 1,
    expectedTranscriptIdentity: identity,
    acceptedAt: 1,
    state: { transcript, transcriptWindow, activeSessionPath, openTabPaths: props.openTabPaths },
  });
  const renderHost = (commitTarget: ReturnType<typeof target>, hostProps: typeof props) => render(h(TranscriptCommitProvider, {
    target: commitTarget,
    appSurface: 'transcript',
    postMessage: props.postMessage,
    children: h(TranscriptHost, hostProps as never),
  }), root);

  renderHost(target(1, '/session/a', sessionA, 'identity-a'), props);
  await new Promise((resolve) => setImmediate(resolve));
  const firstHost = root.querySelector('.transcript-host');
  const firstSurface = root.querySelector('.transcript-surface');
  const firstView = root.querySelector('.transcript-virtual-wrap');
  assert.ok(firstHost);
  assert.ok(firstSurface);
  assert.ok(firstView);
  assert.match(root.textContent ?? '', /Session A content/);
  assert.ok(messages.some((message) => message.type === 'transcriptCommitted' && message.payload.revision === 1));

  renderHost(target(2, '/session/b', sessionB, 'identity-b'), {
    ...props,
    activeSessionPath: '/session/b',
    transcript: sessionB,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const secondHost = root.querySelector('.transcript-host');
  const secondSurface = root.querySelector('.transcript-surface');
  const secondView = root.querySelector('.transcript-virtual-wrap');

  assert.equal(secondHost, firstHost, 'the transcript host must stay mounted across session switches');
  assert.equal(secondSurface, firstSurface, 'the transcript surface must stay mounted across session switches');
  assert.notEqual(secondView, firstView, 'the session-owned transcript view must reset its virtualizer at the new tab bottom');
  assert.equal(secondSurface?.getAttribute('data-session-path'), '/session/b');
  assert.match(root.textContent ?? '', /Session B content/);
  assert.doesNotMatch(root.textContent ?? '', /Session A content/);
  assert.ok(messages.some((message) => message.type === 'transcriptCommitted'
    && message.payload.revision === 2 && message.payload.identity === 'identity-b'));
  render(null, root);
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: offsetWidth!,
    offsetHeight: offsetHeight!,
  });
  window.requestAnimationFrame = originalWindowRaf;
  window.cancelAnimationFrame = originalWindowCaf;
});
