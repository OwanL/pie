/** @jsxRuntime automatic */
/** @jsxImportSource preact */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import type Viewer from '../../vendor/viewerjs/viewer.esm';
import { ImageViewer, type ViewerFactory } from '../../transcript/image-viewer';
import { clearImageViewer, inlineViewerSource, openImageViewer } from '../../transcript/image-viewer-store';

function harness() {
  const dom = new JSDOM('<body><button id="before">Before</button><div id="mount"></div></body>');
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLImageElement', 'KeyboardEvent', 'MouseEvent'] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : (dom.window as any)[key] });
  }
  let receive: (message: any) => void = () => {};
  let connection: (state: string) => void = () => {};
  const sent: any[] = [];
  const instances: Array<{ source: HTMLImageElement; options: Viewer.Options; shown: boolean; destroyed: number }> = [];
  const factory: ViewerFactory = (source, options) => {
    const instance = { source, options, shown: false, destroyed: 0 };
    instances.push(instance);
    return { show() { instance.shown = true; }, destroy() { instance.destroyed++; } };
  };
  const adapter: any = {
    initialState: { imageActionCapabilities: { copy: true, reveal: true, openInBrowser: false } },
    postMessage: (message: any) => sent.push(message),
    transport: {
      subscribe: (handler: any) => { receive = handler; return () => {}; },
      onConnectionStateChange: (handler: any) => { connection = handler; return () => {}; },
    },
  };
  const mount = document.getElementById('mount')!;
  const start = () => act(async () => { render(<ImageViewer adapter={adapter} viewerFactory={factory} />, mount); });
  const stop = async () => { await act(async () => { render(null, mount); clearImageViewer(); }); dom.window.close(); };
  const thumbnail = (src = 'data:image/gif;base64,YQ==') => {
    const image = document.createElement('img'); image.className = 'message-user-image-element'; image.tabIndex = 0; image.src = src;
    document.body.appendChild(image); return image;
  };
  return { dom, mount, adapter, factory, instances, sent, start, stop, thumbnail, receive: (message: any) => receive(message), connection: (state: string) => connection(state) };
}
const flush = () => act(async () => {});

test('inline native sources exclude remote URLs and SVG', () => {
  assert.equal(inlineViewerSource('https://example.com/image.png'), null);
  assert.equal(inlineViewerSource('data:image/svg+xml;base64,YQ=='), null);
  assert.deepEqual(inlineViewerSource('data:image/gif;base64,YQ=='), { kind: 'inline', mimeType: 'image/gif', base64: 'YQ==' });
});

test('stock library receives original animated bytes without dimension measurement or toolbar customization', async () => {
  const h = harness(); await h.start();
  try {
    const thumb = h.thumbnail();
    await act(async () => { thumb.click(); });
    const instance = h.instances[0];
    assert.ok(instance.shown);
    assert.equal(instance.source.src, thumb.src);
    assert.equal(instance.options.toolbar, undefined);
    assert.equal(instance.options.navbar, undefined);
    assert.equal(instance.options.className, undefined);
    assert.equal(instance.options.transition, false);
    assert.equal(h.mount.querySelector('[role="dialog"]'), null);
    await act(async () => { instance.options.hidden?.(new h.dom.window.CustomEvent('hidden') as any); });
    assert.equal(instance.destroyed, 1);
    assert.equal(document.activeElement, thumb);
  } finally { await h.stop(); }
});

test('explicit links own image activation; click, Enter and Space open standalone SVG view-only', async () => {
  const h = harness(); await h.start();
  try {
    const thumb = h.thumbnail('data:image/svg+xml;base64,PHN2Zy8+');
    const link = document.createElement('a'); link.href = '#'; document.body.appendChild(link); link.appendChild(thumb);
    link.addEventListener('click', event => event.preventDefault());
    for (const event of [new MouseEvent('click', { bubbles: true, cancelable: true }), new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })]) {
      await act(async () => { thumb.dispatchEvent(event); });
      assert.equal(h.instances.length, 0);
    }
    document.body.appendChild(thumb);
    for (const event of [new MouseEvent('click', { bubbles: true, cancelable: true }), ...['Enter', ' '].map(key => new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))]) {
      const count = h.instances.length;
      await act(async () => { thumb.dispatchEvent(event); });
      assert.equal(event.defaultPrevented, true);
      assert.equal(h.instances.length, count + 1);
      await act(async () => { clearImageViewer(); });
    }
    await act(async () => { thumb.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.equal(h.sent.length, 0);
  } finally { await h.stop(); }
});

test('thumbnail actions are capability gated, source targeted and result correlated', async () => {
  const h = harness(); await h.start();
  try {
    const thumb = h.thumbnail(); thumb.dataset.pieImagePath = '/workspace/demo.gif';
    thumb.dataset.pieImageReference = 'demo.gif'; thumb.dataset.pieImageCwd = '/workspace';
    await act(async () => { thumb.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 24 })); });
    assert.equal(h.instances.length, 0, 'right click never opens viewer');
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    assert.deepEqual(buttons.map(button => button.textContent), ['Copy image', 'Show in file system']);
    await act(async () => { buttons[0].click(); buttons[0].click(); });
    assert.equal(h.sent.length, 1, 'pending guard is synchronous');
    assert.deepEqual(h.sent[0].source, { kind: 'file', path: '/workspace/demo.gif', reference: 'demo.gif', workingDirectory: '/workspace' });
    assert.equal(buttons[0].disabled, true);
    assert.match(document.querySelector('[role="status"]')!.textContent!, /Working/);
    await act(async () => { h.receive({ type: 'imageActionResult', requestId: 'stale', success: false, error: 'Wrong' }); });
    assert.doesNotMatch(document.body.textContent!, /Wrong/);
    await act(async () => { h.receive({ type: 'imageActionResult', requestId: h.sent[0].requestId, success: false, error: 'Clipboard unavailable' }); });
    assert.equal(buttons[0].disabled, false);
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /Clipboard unavailable/);
    h.adapter.postMessage = () => { throw new Error('offline'); };
    await act(async () => { buttons[1].click(); });
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /Image action unavailable/);
  } finally { await h.stop(); }
});

test('decoder failure retires library and exposes accessible dismissible error; stale errors do not close replacement', async () => {
  const h = harness(); await h.start();
  try {
    const thumb = h.thumbnail();
    await act(async () => { thumb.click(); });
    const first = h.instances[0];
    const rendered = document.createElement('img');
    await act(async () => { first.options.view?.(new h.dom.window.CustomEvent('view', { detail: { image: rendered } }) as any); });
    await act(async () => { rendered.dispatchEvent(new h.dom.window.Event('error')); });
    assert.equal(first.destroyed, 1);
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /Image could not be loaded/);
    assert.equal(document.activeElement, thumb);
    await act(async () => { thumb.click(); });
    assert.equal(document.querySelector('[role="status"]'), null);
    const second = h.instances[1];
    await act(async () => { first.source.dispatchEvent(new h.dom.window.Event('error')); rendered.dispatchEvent(new h.dom.window.Event('error')); });
    assert.equal(second.destroyed, 0);
    await act(async () => { second.source.dispatchEvent(new h.dom.window.Event('error')); });
    assert.equal(second.destroyed, 1, 'source errors also handle pre-view loading failure');
    await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="Dismiss image error"]')!.click(); });
    assert.equal(document.querySelector('[role="status"]'), null);
  } finally { await h.stop(); }
});

test('session, host, disconnect and unmount retire even a still-loading viewer exactly once', async () => {
  const h = harness(); await h.start();
  try {
    await act(async () => { h.receive({ type: 'state', hostInstanceId: 'h1', state: { activeSessionPath: '/a' } }); });
    for (const dismiss of [
      () => h.receive({ type: 'state', hostInstanceId: 'h1', state: { activeSessionPath: '/b' } }),
      () => h.receive({ type: 'state', hostInstanceId: 'h2', state: { activeSessionPath: '/b' } }),
      () => h.connection('disconnected'),
    ]) {
      await act(async () => { openImageViewer({ src: 'data:image/png;base64,YQ==', alt: 'Loading', source: null }); });
      const instance = h.instances.at(-1)!;
      await act(async () => { dismiss(); });
      assert.equal(instance.destroyed, 1);
      assert.equal(instance.source.hasAttribute('src'), false);
      await act(async () => { instance.options.hidden?.(new h.dom.window.CustomEvent('hidden') as any); });
      assert.equal(instance.destroyed, 1);
    }
    await act(async () => { openImageViewer({ src: 'data:image/png;base64,YQ==', alt: 'Loading', source: null }); });
    const last = h.instances.at(-1)!;
    await act(async () => { render(null, h.mount); }); await flush();
    assert.equal(last.destroyed, 1);
  } finally { await h.stop(); }
});

test('replacement while loading ignores retiring callbacks and preserves unrelated focus', async () => {
  const h = harness(); await h.start();
  try {
    await act(async () => { openImageViewer({ src: 'data:image/gif;base64,YQ==', alt: 'First', source: null }); });
    const first = h.instances[0];
    const other = document.getElementById('before')!; other.focus();
    await act(async () => { openImageViewer({ src: 'data:image/webp;base64,Yg==', alt: 'Second', source: null }); });
    const second = h.instances[1];
    assert.equal(first.destroyed, 1);
    assert.equal(second.source.src, 'data:image/webp;base64,Yg==');
    await act(async () => { first.options.hidden?.(new h.dom.window.CustomEvent('hidden') as any); first.source.dispatchEvent(new h.dom.window.Event('error')); });
    assert.equal(second.destroyed, 0);
    await act(async () => { clearImageViewer(); });
    assert.equal(document.activeElement, other);
  } finally { await h.stop(); }
});
