import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { memo } from 'preact/compat';
import { useLayoutEffect } from 'preact/hooks';
import type { ChatMessage, ToolCall } from '../../../../lib/protocol/messages';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  Node: dom.window.Node,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  MutationObserver: dom.window.MutationObserver,
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

let TranscriptCommitProvider: typeof import('../../../transcript/commit-registry').TranscriptCommitProvider;
let BufferedTextPart: typeof import('../../../transcript/buffered-text-part').BufferedTextPart;
let ReasoningBlock: typeof import('../../../transcript/message-item/reasoning-block').ReasoningBlock;
let TranscriptHost: typeof import('../../../transcript/transcript-host').TranscriptHost;
let commitRegistryModule: typeof import('../../../transcript/commit-registry');

test.before(async () => {
  commitRegistryModule = await import('../../../transcript/commit-registry');
  ({ TranscriptCommitProvider } = commitRegistryModule);
  ({ BufferedTextPart } = await import('../../../transcript/buffered-text-part'));
  ({ ReasoningBlock } = await import('../../../transcript/message-item/reasoning-block'));
  ({ TranscriptHost } = await import('../../../transcript/transcript-host'));
});

function installFakeTimers(startAt: number) {
  const originalWindowSetTimeout = window.setTimeout;
  const originalWindowClearTimeout = window.clearTimeout;
  const originalGlobalClearTimeout = globalThis.clearTimeout;
  const originalNow = Date.now;
  let now = startAt;
  let nextId = 1;
  const timers = new Map<number, { callback: TimerHandler; dueAt: number }>();
  const fakeSetTimeout = ((callback: TimerHandler, delay = 0) => {
    const id = nextId++;
    timers.set(id, { callback, dueAt: now + Math.max(0, Number(delay) || 0) });
    return id;
  }) as typeof window.setTimeout;
  const fakeClearTimeout = ((id: number) => { timers.delete(Number(id)); }) as typeof window.clearTimeout;
  window.setTimeout = fakeSetTimeout;
  window.clearTimeout = fakeClearTimeout;
  globalThis.clearTimeout = fakeClearTimeout as typeof globalThis.clearTimeout;
  Date.now = () => now;

  return {
    get pendingCount() {
      return timers.size;
    },
    async advanceBy(milliseconds: number) {
      now += milliseconds;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.dueAt <= now)
          .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
        if (!due) return;
        const [id, timer] = due;
        timers.delete(id);
        await act(async () => {
          if (typeof timer.callback === 'function') timer.callback();
          await Promise.resolve();
        });
      }
    },
    restore() {
      window.setTimeout = originalWindowSetTimeout;
      window.clearTimeout = originalWindowClearTimeout;
      globalThis.clearTimeout = originalGlobalClearTimeout;
      Date.now = originalNow;
      timers.clear();
    },
  };
}

function firstTextNode(element: Element): Text {
  const walker = document.createTreeWalker(element, dom.window.NodeFilter.SHOW_TEXT);
  return walker.nextNode() as Text;
}

function CommitLeafProbe({ leafKey, capture }: { leafKey: string; capture: (leaf: unknown) => void }) {
  const registry = commitRegistryModule.useTranscriptCommitRegistry();
  useLayoutEffect(() => capture(registry.leaves.get(leafKey)), [registry.version, registry.leaves, leafKey, capture]);
  return null;
}

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

  try {
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

    assert.equal(Math.max(...observedSizes), 513, 'message plus 512 live tool leaves must exceed the old boundary');
    assert.equal(toolLeafRenders, tools.length, 'registry bookkeeping must not rerender every leaf consumer');
  } finally {
    render(null, root);
  }
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

  let firstMap: ReadonlyMap<string, unknown> | undefined;
  try {
    render(h(TranscriptCommitProvider, {
      target: target(1), appSurface: 'transcript', postMessage() {}, children: h(RegistryMapProbe, {}),
    }), root);
    await new Promise((resolve) => setImmediate(resolve));
    firstMap = maps.at(-1);
    assert.ok(firstMap);
    assert.equal(firstMap.size, 2);

    render(h(TranscriptCommitProvider, {
      target: target(2), appSurface: 'transcript', postMessage() {}, children: h(RegistryMapProbe, {}),
    }), root);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(maps.at(-1), firstMap, 'an unchanged mounted DOM leaf map must survive a snapshot revision');
    assert.equal(maps.at(-1)?.size, 2);
  } finally {
    render(null, root);
  }
  assert.equal(firstMap?.size, 0, 'unmounted DOM leaves must be released from preserved evidence');
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

test('a multi-KB streaming snapshot reaches the DOM and commit registry without a body typewriter backlog', async () => {
  const root = document.getElementById('root')!;
  const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  const originalRaf = window.requestAnimationFrame;
  const originalCaf = window.cancelAnimationFrame;
  const originalSetTimeout = window.setTimeout;
  const originalClearTimeout = window.clearTimeout;
  const pendingRaf = new Map<number, FrameRequestCallback>();
  const pendingTimers = new Map<number, { callback: TimerHandler; delay: number }>();
  let nextRaf = 1;
  let nextTimer = 1;
  const messages: any[] = [];

  window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    const id = nextRaf++;
    pendingRaf.set(id, callback);
    return id;
  }) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) => { pendingRaf.delete(id); }) as typeof window.cancelAnimationFrame;
  window.setTimeout = ((callback: TimerHandler, delay?: number) => {
    const id = nextTimer++;
    pendingTimers.set(id, { callback, delay: delay ?? 0 });
    return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((id: number) => { pendingTimers.delete(id); }) as typeof window.clearTimeout;
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
    hasUserMessages: false,
  };
  const seed = 'seed';
  const snapshotText = 'A multi-KB reply that must be available as soon as the bounded markdown parse runs. '.repeat(256);
  const message = (markdown: string): ChatMessage => ({
    id: 'streaming-reply',
    role: 'assistant',
    createdAt: '',
    markdown,
    parts: [{ kind: 'text', text: markdown }],
    status: 'streaming',
  });
  const target = (revision: number, current: ChatMessage) => ({
    revision,
    viewGeneration: 1,
    expectedTranscriptIdentity: `identity-${revision}`,
    acceptedAt: 1,
    state: {
      transcript: [current],
      transcriptWindow,
      activeSessionPath: '/streaming',
      openTabPaths: ['/streaming'],
    },
  });
  const hostProps = (current: ChatMessage) => ({
    openTabPaths: ['/streaming'],
    activeSessionPath: '/streaming',
    transcript: [current],
    transcriptWindow,
    transcriptLoaded: true,
    busy: true,
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
  });
  const flushRaf = () => {
    const callbacks = [...pendingRaf.values()];
    pendingRaf.clear();
    for (const callback of callbacks) callback(0);
  };
  const flushMarkdownTimer = () => {
    for (const [id, timer] of [...pendingTimers]) {
      if (timer.delay !== 100) continue;
      pendingTimers.delete(id);
      if (typeof timer.callback === 'function') timer.callback();
    }
  };

  try {
    const firstMessage = message(seed);
    render(h(TranscriptCommitProvider, {
      target: target(1, firstMessage),
      appSurface: 'transcript',
      postMessage: (message: any) => messages.push(message),
      children: h(TranscriptHost, hostProps(firstMessage) as never),
    }), root);
    await new Promise((resolve) => setImmediate(resolve));
    flushRaf();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(root.querySelector('.message-body')?.textContent?.trim(), seed);

    const latestMessage = message(snapshotText);
    await act(async () => {
      render(h(TranscriptCommitProvider, {
        target: target(2, latestMessage),
        appSurface: 'transcript',
        postMessage: (message: any) => messages.push(message),
        children: h(TranscriptHost, hostProps(latestMessage) as never),
      }), root);
      await Promise.resolve();
    });
    await new Promise((resolve) => setImmediate(resolve));

    // The body parser is deliberately throttled, but it must not add a second
    // per-frame reveal queue behind that bounded parse. With the old buffered
    // body, no rAF is allowed to run here, so the later parse still sees only
    // the seed prefix and the latest target cannot receive truthful evidence.
    assert.equal(root.querySelector('.message-body')?.textContent?.trim(), seed);
    assert.equal(messages.some((message) => message.type === 'transcriptCommitted'
      && message.payload.revision === 2), false, 'the registry must not acknowledge host text before it reaches the DOM');
    await act(async () => {
      flushMarkdownTimer();
      await Promise.resolve();
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(root.querySelector('.message-body')?.textContent?.trim(), snapshotText.trim());
    assert.ok(messages.some((message) => message.type === 'transcriptCommitted'
      && message.payload.revision === 2
      && message.payload.identity === 'identity-2'), 'commit evidence must follow the text actually mounted in the DOM');
  } finally {
    render(null, root);
    pendingRaf.clear();
    pendingTimers.clear();
    window.requestAnimationFrame = originalRaf;
    window.cancelAnimationFrame = originalCaf;
    window.setTimeout = originalSetTimeout;
    window.clearTimeout = originalClearTimeout;
    Object.defineProperties(HTMLElement.prototype, {
      offsetWidth: offsetWidth!,
      offsetHeight: offsetHeight!,
    });
  }
});

test('streaming markdown timers are latest-wins, terminal-safe, and canceled on unmount', async () => {
  const root = document.getElementById('root')!;
  const originalSetTimeout = window.setTimeout;
  const originalClearTimeout = window.clearTimeout;
  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  const pendingTimers = new Map<number, { callback: TimerHandler; delay: number }>();
  let nextTimer = 1;
  window.setTimeout = ((callback: TimerHandler, delay?: number) => {
    const id = nextTimer++;
    pendingTimers.set(id, { callback, delay: delay ?? 0 });
    return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((id: number) => { pendingTimers.delete(id); }) as typeof window.clearTimeout;

  const renderPart = (text: string, streaming: boolean) => render(h(TranscriptCommitProvider, {
    target: null,
    appSurface: 'transcript',
    postMessage() {},
    children: h(BufferedTextPart, {
      messageId: 'streaming-text',
      index: 0,
      text,
      streaming,
      workingDirectory: null,
      onOpenFile() {},
      onContextMenu() {},
      onFilePathContextMenu() {},
    }),
  }), root);
  const flushMarkdown = async () => {
    const callbacks = [...pendingTimers.entries()]
      .filter(([, timer]) => timer.delay === 100)
      .map(([id, timer]) => {
        pendingTimers.delete(id);
        return timer.callback;
      });
    await act(async () => {
      for (const callback of callbacks) {
        if (typeof callback === 'function') callback();
      }
      await Promise.resolve();
    });
  };

  try {
    await act(async () => {
      renderPart('seed', true);
      await Promise.resolve();
    });
    now = 1050;
    await act(async () => {
      renderPart('first replacement', true);
      await Promise.resolve();
    });
    assert.equal([...pendingTimers.values()].filter((timer) => timer.delay === 100).length, 1);

    await act(async () => {
      renderPart('latest replacement', true);
      await Promise.resolve();
    });
    assert.equal([...pendingTimers.values()].filter((timer) => timer.delay === 100).length, 1, 'a replacement re-arms one current-generation parse');
    await flushMarkdown();
    assert.equal(root.querySelector('.message-body')?.textContent?.trim(), 'latest replacement');

    await act(async () => {
      renderPart('terminal text', false);
      await Promise.resolve();
    });
    assert.equal(root.querySelector('.message-body')?.textContent?.trim(), 'terminal text');
    assert.equal([...pendingTimers.values()].some((timer) => timer.delay === 100), false, 'terminal rendering clears streaming work');

    await act(async () => {
      renderPart('deferred before unmount', true);
      await Promise.resolve();
    });
    assert.equal([...pendingTimers.values()].some((timer) => timer.delay === 100), true);
    render(null, root);
    assert.equal([...pendingTimers.values()].some((timer) => timer.delay === 100), false, 'unmount clears deferred markdown work');
  } finally {
    render(null, root);
    pendingTimers.clear();
    window.setTimeout = originalSetTimeout;
    window.clearTimeout = originalClearTimeout;
    Date.now = originalNow;
  }
});

test('streaming text preserves reverse cross-body selections beyond 1500ms and then applies the latest snapshot', async () => {
  const root = document.getElementById('root')!;
  const timers = installFakeTimers(5000);
  const renderPair = (left: string, right: string) => render(h(TranscriptCommitProvider, {
    target: null,
    appSurface: 'transcript',
    postMessage() {},
    children: h('div', {}, [
      h(BufferedTextPart, {
        messageId: 'selection-left', index: 0, text: left, streaming: true,
        workingDirectory: null, onOpenFile() {}, onContextMenu() {}, onFilePathContextMenu() {},
      }),
      h(BufferedTextPart, {
        messageId: 'selection-right', index: 0, text: right, streaming: true,
        workingDirectory: null, onOpenFile() {}, onContextMenu() {}, onFilePathContextMenu() {},
      }),
    ]),
  }), root);

  try {
    await act(async () => {
      renderPair('original left', 'original right');
      await Promise.resolve();
    });
    const bodies = [...root.querySelectorAll('.message-body')];
    assert.equal(bodies.length, 2);
    const leftText = firstTextNode(bodies[0]!);
    const rightText = firstTextNode(bodies[1]!);
    const selection = document.getSelection()!;
    // Backward selection: the anchor is in the later block and the focus is
    // in the earlier one, so checking only the anchor loses the first body.
    selection.setBaseAndExtent(rightText, rightText.length, leftText, 0);

    await act(async () => {
      renderPair('intermediate left', 'intermediate right');
      await Promise.resolve();
    });
    await timers.advanceBy(100);
    await act(async () => {
      renderPair('latest left', 'latest right');
      await Promise.resolve();
    });
    await timers.advanceBy(100);
    for (let poll = 0; poll < 9; poll += 1) await timers.advanceBy(200);

    assert.equal(bodies[0]?.textContent?.trim(), 'original left');
    assert.equal(bodies[1]?.textContent?.trim(), 'original right');
    assert.equal(selection.anchorNode, rightText, 'the backward selection anchor remains mounted');
    assert.equal(selection.focusNode, leftText, 'the backward selection focus remains mounted');

    selection.removeAllRanges();
    await timers.advanceBy(200);
    assert.equal(bodies[0]?.textContent?.trim(), 'latest left');
    assert.equal(bodies[1]?.textContent?.trim(), 'latest right');

    const latestLeftText = firstTextNode(bodies[0]!);
    selection.setBaseAndExtent(latestLeftText, 0, latestLeftText, latestLeftText.length);
    await act(async () => {
      renderPair('deferred until unmount', 'latest right');
      await Promise.resolve();
    });
    await timers.advanceBy(100);
    assert.equal(timers.pendingCount, 1, 'a selection poll is armed while a stream update is deferred');
    render(null, root);
    assert.equal(timers.pendingCount, 0, 'unmount clears the selection poll');
  } finally {
    document.getSelection()?.removeAllRanges();
    render(null, root);
    timers.restore();
  }
});

test('reasoning text and streaming cursor wait for selection, then commit the latest terminal body', async () => {
  const root = document.getElementById('root')!;
  const timers = installFakeTimers(9000);
  let reasoningLeaf: unknown;
  const captureLeaf = (leaf: unknown) => { reasoningLeaf = leaf; };
  const renderReasoning = (text: string, streaming: boolean) => render(h(TranscriptCommitProvider, {
    target: null,
    appSurface: 'transcript',
    postMessage() {},
    children: h('div', {}, [
      h(ReasoningBlock, {
        text,
        autoExpand: true,
        collapsibleKey: 'reasoning:selection-preservation:0',
        streaming,
        onContextMenu() {},
      }),
      h(CommitLeafProbe, { leafKey: 'reasoning:selection-preservation:0', capture: captureLeaf }),
    ]),
  }), root);

  try {
    await act(async () => {
      renderReasoning('original reasoning', true);
      await Promise.resolve();
    });
    const body = root.querySelector('.reasoning-scroll')!;
    const originalText = firstTextNode(body);
    const selection = document.getSelection()!;
    selection.setBaseAndExtent(originalText, 0, originalText, originalText.length);
    assert.ok(body.querySelector('.reasoning-stream-cursor'));
    assert.equal((reasoningLeaf as { text?: string } | undefined)?.text, 'original reasoning');

    await act(async () => {
      renderReasoning('intermediate reasoning', true);
      await Promise.resolve();
    });
    await act(async () => {
      renderReasoning('latest terminal reasoning', false);
      await Promise.resolve();
    });
    await timers.advanceBy(120);
    for (let poll = 0; poll < 9; poll += 1) await timers.advanceBy(200);

    assert.equal(body.textContent?.trim(), 'original reasoning');
    assert.ok(body.querySelector('.reasoning-stream-cursor'), 'terminal cursor removal must not replace selected markup');
    assert.equal((reasoningLeaf as { text?: string } | undefined)?.text, 'original reasoning', 'commit evidence stays with the displayed selection-safe text');

    selection.removeAllRanges();
    await timers.advanceBy(200);
    assert.equal(body.textContent?.trim(), 'latest terminal reasoning');
    assert.equal(body.querySelector('.reasoning-stream-cursor'), null);
    assert.equal((reasoningLeaf as { text?: string } | undefined)?.text, 'latest terminal reasoning');

    const latestReasoningText = firstTextNode(body);
    selection.setBaseAndExtent(latestReasoningText, 0, latestReasoningText, latestReasoningText.length);
    await act(async () => {
      renderReasoning('deferred before unmount', true);
      await Promise.resolve();
    });
    assert.ok(timers.pendingCount > 0, 'the selected reasoning update schedules a deferred apply');
    render(null, root);
    assert.equal(timers.pendingCount, 0, 'unmount clears reasoning selection and markdown timers');
  } finally {
    document.getSelection()?.removeAllRanges();
    render(null, root);
    timers.restore();
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

  try {
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
    // Session switching remounts the keyed virtualizer. Its first range change
    // is delivered through a timer-backed rAF in this DOM harness, so wait one
    // timer turn before asserting the new leaf evidence.
    await new Promise((resolve) => setTimeout(resolve, 0));
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
  } finally {
    render(null, root);
    Object.defineProperties(HTMLElement.prototype, {
      offsetWidth: offsetWidth!,
      offsetHeight: offsetHeight!,
    });
    window.requestAnimationFrame = originalWindowRaf;
    window.cancelAnimationFrame = originalWindowCaf;
  }
});
