import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { h, render } from 'preact';

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

test.before(async () => {
  ({ TranscriptCommitProvider } = await import('../../../../src/webview/panel/transcript/commit-registry'));
  ({ TranscriptHost } = await import('../../../../src/webview/panel/transcript/transcript-host'));
});

test('app commit without a mounted transcript leaf emits a classified transcript block', () => {
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
    openTabPaths: ['/actual'],
    activeSessionPath: '/actual',
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
  render(null, root);

  assert.ok(messages.some((message) => message.type === 'appCommitted' && message.payload.revision === 7));
  assert.deepEqual(
    messages.filter((message) => message.type === 'transcriptCommitBlocked').map((message) => message.payload.reason),
    ['leaf_missing'],
  );
});
