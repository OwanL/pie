/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'preact';

import { installDom } from '../helpers/dom';
installDom();

import type { WebviewToHostMessage } from '../../../lib/protocol/index.js';
import {
  beginLocalFileOpen,
  clearLocalFileOpenRequests,
  isLocalHtmlFilePath,
  receiveLocalFileOpenResult,
  readRendererTransportSurface,
  registerLocalFileOpenReporter,
  type LocalFileOpenFeedback,
  type RendererTransportSurface,
} from '../../shell/local-file-open.js';
import { LocalFileOpenFeedbackView } from '../../shell/local-file-open-feedback.js';

interface FakePopup {
  closed: boolean;
  href: string;
  close(): void;
}

function makePopup(): FakePopup & { asWindow(): Window } {
  let closed = false;
  let href = '';
  const asWindow = (): Window => ({
    get closed() { return closed; },
    close: () => { closed = true; },
    location: { set href(next: string) { href = next; }, get href() { return href; } },
  }) as unknown as Window;
  return {
    get closed() { return closed; },
    get href() { return href; },
    close(): void { closed = true; },
    asWindow,
  } as unknown as FakePopup & { asWindow(): Window };
}

function collectorFactory(): { post: (message: WebviewToHostMessage) => boolean; messages: WebviewToHostMessage[] } {
  const messages: WebviewToHostMessage[] = [];
  return { post: (message) => { messages.push(message); return true; }, messages };
}

function setTransportMeta(content: 'browser' | 'vscode'): void {
  let meta = document.querySelector('meta[name="pie-transport"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('name', 'pie-transport');
    document.head.appendChild(meta);
  }
  meta.setAttribute('content', content);
}

test('html detection is leaf-based, extension-bound, and case-insensitive', () => {
  assert.equal(isLocalHtmlFilePath('/workspace/page.HTML'), true);
  assert.equal(isLocalHtmlFilePath('/workspace/a/b/index.htm'), true);
  assert.equal(isLocalHtmlFilePath('C:\\dev\\page.html'), true);
  assert.equal(isLocalHtmlFilePath('/workspace/notes.htmlx'), false);
  assert.equal(isLocalHtmlFilePath('/workspace/page.html.bak'), false);
  assert.equal(isLocalHtmlFilePath('/workspace/'), false);
  assert.equal(isLocalHtmlFilePath(''), false);
});

test('browser surfaces pre-open the popup inside the click activation and navigate it on the verified result', () => {
  setTransportMeta('browser');
  const opened: Array<FakePopup | null> = [];
  (globalThis as { window: { open: () => Window | null } }).window.open = (): Window | null => {
    const popup: FakePopup = { closed: false, href: '', close: () => { popup.closed = true; } };
    opened.push(popup);
    return { closed: popup.closed, close: popup.close, location: { set href(next: string) { popup.href = next; }, get href() { return popup.href; } } } as unknown as Window;
  };
  const collector = collectorFactory();
  const feedbacks: LocalFileOpenFeedback[] = [];
  const unregister = registerLocalFileOpenReporter((feedback) => feedbacks.push(feedback));
  try {
    assert.equal(
      beginLocalFileOpen(collector.post, { path: '/workspace/page.html', reference: 'page.html', workingDirectory: '/workspace' }),
      true,
      'the click still owns its popup handle',
    );
    assert.equal(opened.length, 1, 'a blank placeholder is opened while the user activation is still live');
    assert.equal(collector.messages.length, 1);
    const command = collector.messages[0] as Extract<WebviewToHostMessage, { type: 'prepareLocalFileOpen' }>;
    assert.equal(command.type, 'prepareLocalFileOpen');
    assert.equal(command.path, '/workspace/page.html');
    assert.equal(command.workingDirectory, '/workspace');
    assert.match(command.requestId, /^local-file-open:/u);

    assert.equal(receiveLocalFileOpenResult({
      type: 'localFileOpenResult', requestId: command.requestId, status: 'ready',
      url: 'http://127.0.0.1:41575/page.html', openIn: 'popup',
    }), true);
    assert.equal(opened[0]?.href, 'http://127.0.0.1:41575/page.html', 'the placeholder navigates to the verified origin');
    assert.equal(opened[0]?.closed, false);
    assert.deepEqual(feedbacks, [], 'a successful popup needs no feedback');
  } finally {
    unregister();
    clearLocalFileOpenRequests();
  }
});

test('a blocked popup fails before any host request', () => {
  setTransportMeta('browser');
  (globalThis as { window: { open: () => null } }).window.open = (): null => null;
  const collector = collectorFactory();
  const feedbacks: LocalFileOpenFeedback[] = [];
  const unregister = registerLocalFileOpenReporter((feedback) => feedbacks.push(feedback));
  try {
    assert.equal(beginLocalFileOpen(collector.post, { path: '/x/page.html' }), false);
    assert.deepEqual(collector.messages, [], 'nothing is sent when the popup is blocked');
    assert.equal(feedbacks[0]?.kind, 'error');
    assert.match(feedbacks[0]?.message ?? '', /blocked the popup/u);
  } finally {
    unregister();
    clearLocalFileOpenRequests();
  }
});

test('vscode surfaces never open popups; the verified external result confirms locally', () => {
  setTransportMeta('vscode');
  let opened = 0;
  (globalThis as { window: { open: () => null } }).window.open = (): null => { opened++; return null; };
  const collector = collectorFactory();
  const feedbacks: LocalFileOpenFeedback[] = [];
  const unregister = registerLocalFileOpenReporter((feedback) => feedbacks.push(feedback));
  try {
    assert.equal(beginLocalFileOpen(collector.post, { path: '/x/page.html' }), true);
    assert.equal(opened, 0, 'the sidebar never pops a tab; the host opened externally');
    const command = collector.messages[0] as Extract<WebviewToHostMessage, { type: 'prepareLocalFileOpen' }>;
    assert.equal(receiveLocalFileOpenResult({
      type: 'localFileOpenResult', requestId: command.requestId, status: 'ready',
      url: 'http://127.0.0.1:41576/', openIn: 'external',
    }), true);
    assert.equal(feedbacks.length, 1);
    assert.equal(feedbacks[0]?.kind, 'info');
    assert.match(feedbacks[0]?.message ?? '', /default browser/u);
  } finally {
    unregister();
    clearLocalFileOpenRequests();
  }
});

test('unavailable results close the placeholder and surface the host error', () => {
  setTransportMeta('browser');
  const popup = makePopup();
  (globalThis as { window: { open: () => Window | null } }).window.open = (): Window => popup.asWindow();
  const collector = collectorFactory();
  const feedbacks: LocalFileOpenFeedback[] = [];
  const unregister = registerLocalFileOpenReporter((feedback) => feedbacks.push(feedback));
  try {
    beginLocalFileOpen(collector.post, { path: '/workspace/missing.html' });
    const command = collector.messages[0] as Extract<WebviewToHostMessage, { type: 'prepareLocalFileOpen' }>;
    assert.equal(receiveLocalFileOpenResult({
      type: 'localFileOpenResult', requestId: command.requestId, status: 'unavailable',
      error: 'Could not find file "missing.html".',
    }), true);
    assert.equal(popup.closed, true, 'no blank orphan popup remains');
    assert.equal(popup.href, '', 'an unavailable origin never navigates');
    assert.equal(feedbacks[0]?.kind, 'error');
    assert.match(feedbacks[0]?.message ?? '', /Could not find file/u);
  } finally {
    unregister();
    clearLocalFileOpenRequests();
  }
});

test('unknown results are dropped and disconnects clear placeholders silently', () => {
  setTransportMeta('browser');
  const feedbacks: LocalFileOpenFeedback[] = [];
  const unregister = registerLocalFileOpenReporter((feedback) => feedbacks.push(feedback));
  try {
    assert.equal(receiveLocalFileOpenResult({
      type: 'localFileOpenResult', requestId: 'stale', status: 'ready', url: 'http://127.0.0.1:1/', openIn: 'popup',
    }), false, 'stale results without a pending owner are dropped');
    assert.deepEqual(feedbacks, []);

    const collector = collectorFactory();
    beginLocalFileOpen(collector.post, { path: '/workspace/page.html' });
    clearLocalFileOpenRequests();
    assert.deepEqual(feedbacks, [], 'disconnect is silent');
    assert.equal(receiveLocalFileOpenResult({
      type: 'localFileOpenResult', requestId: 'stale', status: 'unavailable', error: 'late',
    }), false, 'cleared owners never produce feedback');
    assert.deepEqual(feedbacks, []);
  } finally {
    unregister();
    clearLocalFileOpenRequests();
  }
});

test('requests time out when no targeted result arrives', async () => {
  setTransportMeta('browser');
  const feedbacks: LocalFileOpenFeedback[] = [];
  const unregister = registerLocalFileOpenReporter((feedback) => feedbacks.push(feedback));
  const collector = collectorFactory();
  try {
    beginLocalFileOpen(collector.post, { path: '/workspace/page.html' }, 'browser', 20);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(feedbacks[0]?.kind, 'error');
    assert.match(feedbacks[0]?.message ?? '', /timed out/u);
    assert.equal(receiveLocalFileOpenResult({
      type: 'localFileOpenResult', requestId: 'stale', status: 'unavailable', error: 'late',
    }), false, 'settled requests cannot double-report');
  } finally {
    unregister();
    clearLocalFileOpenRequests();
  }
});

test('surface detection follows the server-injected transport meta', () => {
  setTransportMeta('browser');
  assert.equal(readRendererTransportSurface(), 'browser');
  setTransportMeta('vscode');
  assert.equal(readRendererTransportSurface(), 'vscode');
  document.querySelector('meta[name="pie-transport"]')?.remove();
  assert.equal(readRendererTransportSurface(), 'vscode', 'missing meta stays the vscode surface');
});

test('the feedback view renders transient messages and nothing when unset', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  try {
    render(<LocalFileOpenFeedbackView feedback={null} />, container);
    assert.equal(document.getElementById('pie-local-file-open-feedback'), null);
    render(<LocalFileOpenFeedbackView feedback={{ kind: 'error', message: 'boom' }} />, container);
    const element = document.getElementById('pie-local-file-open-feedback');
    assert.match(element?.textContent ?? '', /boom/u);
    assert.equal(element?.getAttribute('role'), 'status');
    render(<LocalFileOpenFeedbackView feedback={null} />, container);
    assert.equal(document.getElementById('pie-local-file-open-feedback'), null, 'feedback vanishes');
  } finally {
    container.remove();
  }
});