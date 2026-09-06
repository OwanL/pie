/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { h, render } from 'preact';

import type { ChatMessage } from '../../../../src/shared/protocol/messages';
import type { TranscriptWindow } from '../../../../src/shared/protocol';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  Event: dom.window.Event,
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
Object.defineProperty(dom.window, 'requestAnimationFrame', {
  configurable: true,
  writable: true,
  value: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
});
Object.defineProperty(dom.window, 'cancelAnimationFrame', {
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

test.before(async () => {
  ({ TranscriptCommitProvider } = await import('../../../../src/webview/panel/transcript/commit-registry'));
  ({ TranscriptHost } = await import('../../../../src/webview/panel/transcript/transcript-host'));
});

const transcriptWindow: TranscriptWindow = {
  loadedStart: 0,
  loadedEnd: 303,
  totalCount: 303,
  hasOlder: false,
  hasNewer: false,
  isPartial: false,
  hasUserMessages: true,
};

function makeTranscript(): ChatMessage[] {
  return Array.from({ length: transcriptWindow.loadedEnd }, (_, index) => ({
    id: `message-${index}`,
    role: 'user' as const,
    createdAt: '',
    markdown: `row ${index}`,
    status: 'completed' as const,
  }));
}

function hostProps(transcript: ChatMessage[]) {
  return {
    openTabPaths: ['/large'],
    activeSessionPath: '/large',
    transcript,
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
  };
}

test('rendered TranscriptHost commits a valid >256-row transcript when its tail is offscreen', async () => {
  const root = document.getElementById('root')!;
  const transcript = makeTranscript();
  const messages: any[] = [];
  const target = {
    revision: 11,
    viewGeneration: 2,
    expectedTranscriptIdentity: 'large-transcript',
    acceptedAt: 1,
    state: {
      transcript,
      transcriptWindow,
      activeSessionPath: '/large',
      openTabPaths: ['/large'],
    },
  };

  const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
  const scrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop');
  const boundingRect = HTMLElement.prototype.getBoundingClientRect;
  const scrollPositions = new WeakMap<Element, number>();

  try {
    Object.defineProperties(HTMLElement.prototype, {
      offsetWidth: { configurable: true, get: () => 320 },
      offsetHeight: { configurable: true, get: () => 100 },
      clientHeight: {
        configurable: true,
        get() { return this.classList.contains('transcript-virtual') ? 100 : 0; },
      },
      scrollHeight: {
        configurable: true,
        get() {
          if (!this.classList.contains('transcript-virtual')) return 0;
          const inner = this.querySelector('.transcript-virtual-inner') as HTMLElement | null;
          return Number.parseFloat(inner?.style.height ?? '') || 0;
        },
      },
      scrollTop: {
        configurable: true,
        get() { return scrollPositions.get(this) ?? 0; },
        set(value: number) { scrollPositions.set(this, value); },
      },
    });
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.classList.contains('transcript-virtual')) {
        return { width: 320, height: 100, top: 0, left: 0, right: 320, bottom: 100, x: 0, y: 0, toJSON: () => null } as DOMRect;
      }
      return boundingRect.call(this);
    };

    const postMessage = (message: any) => messages.push(message);
    const host = (targetValue: typeof target | null) => h(TranscriptCommitProvider, {
      target: targetValue,
      appSurface: 'transcript',
      postMessage,
      children: h(TranscriptHost, { ...hostProps(transcript), postMessage } as never),
    });

    // Mount first without an accepted target so the test can move the real
    // virtualizer to the top before asking TranscriptHost to prove the target.
    render(host(null), root);
    await new Promise((resolve) => setImmediate(resolve));
    const scrollBox = root.querySelector<HTMLElement>('.transcript-virtual');
    assert.ok(scrollBox, 'the rendered host must mount its virtual transcript');

    scrollBox.scrollTop = 0;
    scrollBox.dispatchEvent(new Event('scroll'));
    await new Promise((resolve) => setImmediate(resolve));

    const mountedIndexes = [...root.querySelectorAll<HTMLElement>('.transcript-virtual-inner > [data-index]')]
      .map((element) => Number(element.dataset.index));
    assert.ok(mountedIndexes.length > 0, 'the virtualizer must mount a top range');
    assert.ok(Math.max(...mountedIndexes) < 256, 'the signed tail must be outside the mounted range');

    render(host(target), root);
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(messages.some((message) => message.type === 'transcriptCommitted'
      && message.payload.revision === target.revision
      && message.payload.evidence === 'offscreen'), 'all rows must be indexed before offscreen evidence is accepted');
  } finally {
    render(null, root);
    if (offsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth);
    if (offsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight);
    if (clientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeight);
    if (scrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollHeight);
    if (scrollTop) Object.defineProperty(HTMLElement.prototype, 'scrollTop', scrollTop);
    HTMLElement.prototype.getBoundingClientRect = boundingRect;
  }
});
