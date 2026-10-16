/** @jsxRuntime automatic */
/** @jsxImportSource preact */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { ImageViewer } from '../../transcript/image-viewer';
import { clearImageViewer, inlineViewerSource, openImageViewer } from '../../transcript/image-viewer-store';

test('inline sources reject non-raster and remote bytes', () => {
  assert.equal(inlineViewerSource('https://example.com/image.png'), null);
  assert.equal(inlineViewerSource('data:image/svg+xml;base64,YQ=='), null);
  assert.deepEqual(inlineViewerSource('data:image/png;base64,YQ=='), { kind: 'inline', mimeType: 'image/png', base64: 'YQ==' });
});

test('viewer fits, zooms, routes correlated actions, exposes errors and restores focus', () => {
  const dom = new JSDOM('<body><button id="before">Before</button><div id="mount"></div></body>');
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLImageElement', 'KeyboardEvent'] as const) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
  const mount = document.getElementById('mount')!;
  const before = document.getElementById('before')!;
  before.focus();
  let receive: (message: any) => void = () => {};
  const sent: any[] = [];
  const adapter: any = { postMessage: (message: any) => sent.push(message), initialState: { imageActionCapabilities: { copy: true, reveal: true, openInBrowser: false } }, transport: { subscribe: (handler: any) => { receive = handler; return () => {}; }, onConnectionStateChange: () => () => {} } };
  act(() => render(<ImageViewer adapter={adapter} />, mount));
  act(() => openImageViewer({ src: 'data:image/png;base64,YQ==', alt: 'Chart', source: { kind: 'inline', mimeType: 'image/png', base64: 'YQ==' } }));
  assert.ok(mount.querySelector('[role="dialog"]'));
  const button = (label: string) => Array.from(mount.querySelectorAll('button')).find(node => node.textContent === label)!;
  assert.equal(button('Open in browser').disabled, true);
  act(() => button('+').click());
  assert.match(mount.querySelector('img')!.style.transform, /scale\(1.25\)/);
  act(() => button('Copy image').click());
  assert.equal(sent[0].type, 'performImageAction');
  act(() => receive({ type: 'imageActionResult', requestId: 'stale', success: false, error: 'Wrong' }));
  assert.doesNotMatch(mount.textContent!, /Wrong/);
  act(() => receive({ type: 'imageActionResult', requestId: sent[0].requestId, success: false, error: 'Clipboard unavailable' }));
  assert.match(mount.textContent!, /Clipboard unavailable/);
  act(() => { document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  assert.equal(mount.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, before);
  const thumbnail = document.createElement('img');
  thumbnail.className = 'message-user-image-element'; thumbnail.tabIndex = 0;
  thumbnail.src = 'data:image/png;base64,YQ=='; document.body.appendChild(thumbnail);
  let bubbled = false;
  thumbnail.addEventListener('click', () => { bubbled = true; });
  act(() => thumbnail.click());
  assert.equal(bubbled, false);
  assert.ok(mount.querySelector('[role="dialog"]'));
  before.focus();
  assert.notEqual(document.activeElement, before);
  act(() => receive({ type: 'state', hostInstanceId: 'h1', state: { activeSessionPath: '/a' } }));
  act(() => receive({ type: 'state', hostInstanceId: 'h1', state: { activeSessionPath: '/b' } }));
  assert.equal(mount.querySelector('img'), null);
  act(() => clearImageViewer());
  act(() => render(null, mount));
  dom.window.close();
});
