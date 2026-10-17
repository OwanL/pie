/** @jsxRuntime automatic */
/** @jsxImportSource preact */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import PhotoSwipe from 'photoswipe';
import { ImageViewer } from '../../transcript/image-viewer';
import { clearImageViewer, inlineViewerSource, openImageViewer } from '../../transcript/image-viewer-store';

test('inline sources reject non-raster and remote bytes', () => {
  assert.equal(inlineViewerSource('https://example.com/image.png'), null);
  assert.equal(inlineViewerSource('data:image/svg+xml;base64,YQ=='), null);
  assert.deepEqual(inlineViewerSource('data:image/png;base64,YQ=='), { kind: 'inline', mimeType: 'image/png', base64: 'YQ==' });
});

/** Minimal PhotoSwipe core stand-in: registers UI elements like the real UI module. */
class FakePswp {
  static instances: FakePswp[] = [];
  static reset(): void { FakePswp.instances.length = 0; }

  options: any;
  inited = false;
  destroyed = false;
  isOpen = false;
  isDestroying = false;
  currSlide: object | undefined = undefined;
  elements: Record<string, HTMLElement> = {};
  handlers = new Map<string, Array<(event: any) => void>>();
  focusTarget: HTMLElement | null = null;

  constructor(options: any) {
    this.options = options;
    FakePswp.instances.push(this);
  }

  init(): boolean {
    this.inited = true;
    this.focusTarget = document.createElement('button');
    document.body.appendChild(this.focusTarget);
    this.focusTarget.focus();
    this.emit('uiRegister');
    if (this.options.showHideAnimationType === 'none') this.isOpen = true;
    else setTimeout(() => { this.isOpen = true; this.emit('openingAnimationEnd'); }, 333);
    return true;
  }

  on(name: string, callback: (event: any) => void): this {
    const handlers = this.handlers.get(name) ?? [];
    handlers.push(callback);
    this.handlers.set(name, handlers);
    return this;
  }

  addFilter(): this { return this; }

  emit(name: string, event: Record<string, unknown> = {}): void {
    for (const handler of this.handlers.get(name) ?? []) handler({ content: {}, ...event });
  }

  close(): void {
    if (!this.isOpen || this.isDestroying) return;
    this.isDestroying = true;
    this.emit('close');
    this.destroy();
  }

  destroy(): void {
    if (!this.isDestroying) {
      this.options.showHideAnimationType = 'none';
      this.close();
      return;
    }
    this.destroyed = true;
    this.emit('destroy');
    this.focusTarget?.remove();
  }

  /** PhotoSwipe UI wiring: mirrors the real constructor of registered UI elements. */
  ui = {
    registerElement: (data: any) => {
      const element = document.createElement(data.isButton ? 'button' : data.tagName ?? 'div');
      if (data.isButton) element.type = 'button';
      if (data.className) element.className = data.className;
      if (typeof data.html === 'string') element.textContent = data.html;
      if (data.ariaLabel) element.setAttribute('aria-label', data.ariaLabel);
      else if (data.title) element.setAttribute('title', data.title);
      data.onInit?.(element, this);
      this.elements[data.name] = element;
      if (typeof data.onClick === 'function') {
        element.addEventListener('click', (event: Event) => (data.onClick as any)(event, element, this));
      }
    },
  };
}

function viewerHarness() {
  const dom = new JSDOM('<body><button id="before">Before</button><div id="mount"></div></body>');
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLImageElement', 'KeyboardEvent'] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : (dom.window as any)[key] });
  }
  const mount = document.getElementById('mount')!;
  return { dom, mount };
}

function adapterHarness() {
  let receive: (message: any) => void = () => {};
  const sent: any[] = [];
  const adapter: any = {
    postMessage: (message: any) => sent.push(message),
    initialState: { imageActionCapabilities: { copy: true, reveal: true, openInBrowser: false } },
    transport: {
      subscribe: (handler: any) => { receive = handler; return () => {}; },
      onConnectionStateChange: () => () => {},
    },
  };
  return { adapter, sent, receive: () => receive };
}

function inlineSource() {
  return { kind: 'inline' as const, mimeType: 'image/png', base64: 'YQ==' };
}

function pswpFactory(options: any): PhotoSwipe {
  return new FakePswp(options) as unknown as PhotoSwipe;
}

function unmount(mount: HTMLElement) {
  return act(async () => { render(null, mount); });
}

/** Promise continuations schedule rerenders that only flush on a following act. */
async function flush(): Promise<void> { await act(async () => {}); }

test('real PhotoSwipe opener survives immediate lifecycle clearing without a ghost', async () => {
  const { dom, mount } = viewerHarness();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  dom.window.matchMedia = (() => ({ matches: false })) as any;
  const requestFrame = (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as any;
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: requestFrame });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: clearTimeout });
  const instance = new PhotoSwipe({
    dataSource: [{ src: 'data:image/png;base64,YQ==', width: 2, height: 2 }],
    showHideAnimationType: 'none', returnFocus: false,
  });
  instance.init();
  assert.equal(instance.opener.isOpen, true, 'no 333ms opening window remains');
  instance.destroy();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(document.querySelector('.pswp'), null, 'real destroy removes modal after its scheduled close');
  const { adapter } = adapterHarness();
  await act(async () => { render(<ImageViewer adapter={adapter} measure={async () => ({ width: 2, height: 2 })} />, mount); });
  await act(async () => { openImageViewer({ src: 'data:image/png;base64,YQ==', alt: 'Race', source: null }); });
  await flush();
  assert.ok(document.querySelector('.pswp'));
  await act(async () => { clearImageViewer(); });
  const retiring = document.querySelector<HTMLElement>('.pswp');
  if (retiring) assert.equal(retiring.hidden, true, 'clearing hides immediately, before asynchronous destroy');
  await new Promise(resolve => setTimeout(resolve, 20));
  await flush();
  assert.equal(document.querySelector('.pswp'), null, 'clearing within the former 333ms opening window removes the real viewer');
  await unmount(mount);
  dom.window.close();
});

test('viewer opens PhotoSwipe with measured dimensions and library-owned surface', async () => {
  const { dom, mount } = viewerHarness();
  FakePswp.reset();
  const { adapter } = adapterHarness();
  const measure = async () => ({ width: 2, height: 2 });
  await act(async () => { render(<ImageViewer adapter={adapter} measure={measure} pswpFactory={pswpFactory} />, mount); });
  await act(async () => {
    openImageViewer({ src: 'data:image/png;base64,YQ==', alt: 'Chart', source: inlineSource() });
  });
  await flush();
  assert.equal(mount.querySelector('[role="dialog"]'), null, 'PhotoSwipe owns the open modal surface');
  const instance = FakePswp.instances.at(-1)!;
  assert.ok(instance, 'viewer opened');
  assert.deepEqual(instance.options.dataSource, [
    { src: 'data:image/png;base64,YQ==', alt: 'Chart', width: 2, height: 2 },
  ]);
  assert.equal(instance.options.wheelToZoom, true);
  assert.equal(instance.options.bgOpacity, 0.88);
  assert.equal(instance.options.arrowPrev, false);
  assert.equal(instance.options.arrowNext, false);
  assert.equal(instance.options.counter, false);
  assert.equal(instance.options.mainClass, 'pie-image-viewer');
  assert.ok(instance.inited);
  const copy = instance.elements['pie-image-copy'] as HTMLButtonElement | undefined;
  const reveal = instance.elements['pie-image-reveal'] as HTMLButtonElement | undefined;
  const status = instance.elements['pie-image-status'];
  assert.equal(copy?.getAttribute('aria-label'), 'Copy image');
  assert.ok(copy?.classList.contains('image-viewer-action'));
  assert.equal(instance.options.showHideAnimationType, 'none');
  assert.equal(instance.options.returnFocus, false);
  assert.ok(!copy?.classList.contains('image-viewer-action-hidden'));
  assert.equal(reveal?.getAttribute('aria-label'), 'Show in file system');
  assert.ok(!reveal?.classList.contains('image-viewer-action-hidden'));
  assert.ok(instance.elements['pie-image-openInBrowser']?.classList.contains('image-viewer-action-hidden'),
    'Open in browser is not a granted capability');
  assert.equal(status?.getAttribute('role'), 'status');
  assert.equal(status?.textContent, 'Chart');
  await unmount(mount);
  await act(async () => { dom.window.close(); });
});

test('correlated actions route through PhotoSwipe custom buttons with pending and error states', async () => {
  const { dom, mount } = viewerHarness();
  FakePswp.reset();
  const { adapter, sent, receive } = adapterHarness();
  const measure = async () => ({ width: 2, height: 2 });
  await act(async () => { render(<ImageViewer adapter={adapter} measure={measure} pswpFactory={pswpFactory} />, mount); });
  await act(async () => {
    openImageViewer({ src: 'data:image/png;base64,YQ==', alt: 'Chart', source: inlineSource() });
  });
  await flush();
  const instance = FakePswp.instances.at(-1)!;
  const copy = instance.elements['pie-image-copy'] as HTMLButtonElement;
  const status = instance.elements['pie-image-status'];
  await act(async () => { copy.click(); });
  assert.equal(sent[0].type, 'performImageAction');
  assert.equal(sent[0].action, 'copy');
  assert.deepEqual(sent[0].source, inlineSource());
  assert.match(sent[0].requestId, /^image-action:/);
  assert.equal(copy.disabled, true, 'pending action disables the button');
  assert.equal(status.textContent, 'Working…');
  await act(async () => { receive()({ type: 'imageActionResult', requestId: 'stale', success: false, error: 'Wrong' }); });
  assert.doesNotMatch(status.textContent ?? '', /Wrong/);
  await act(async () => { receive()({ type: 'imageActionResult', requestId: sent[0].requestId, success: false, error: 'Clipboard unavailable' }); });
  assert.match(status.textContent ?? '', /Clipboard unavailable/);
  instance.currSlide = { marker: true };
  await act(async () => { instance.emit('loadError'); });
  assert.match(status.textContent ?? '', /could not be loaded/);
  await act(async () => { instance.emit('loadComplete', { isError: false, slide: instance.currSlide }); });
  assert.equal(status.textContent, 'Chart', 'a successful load of the current slide clears the error');
  const reveal = instance.elements['pie-image-reveal'] as HTMLButtonElement;
  await act(async () => { reveal.click(); });
  assert.equal(sent[1].action, 'reveal');
  assert.deepEqual(sent[1].source, inlineSource());
  await unmount(mount);
  await act(async () => { dom.window.close(); });
});

test('session switch tears the PhotoSwipe instance down instantly and restores focus', async () => {
  const { dom, mount } = viewerHarness();
  FakePswp.reset();
  const { adapter, receive } = adapterHarness();
  const measure = async () => ({ width: 2, height: 2 });
  await act(async () => { render(<ImageViewer adapter={adapter} measure={measure} pswpFactory={pswpFactory} />, mount); });
  const before = document.getElementById('before')!;
  before.focus();
  await act(async () => {
    openImageViewer({ src: 'data:image/png;base64,YQ==', alt: 'Chart', source: inlineSource() });
  });
  const instance = FakePswp.instances.at(-1)!;
  assert.notEqual(document.activeElement, before, 'PhotoSwipe owns the focus while open');
  await act(async () => { receive()({ type: 'state', hostInstanceId: 'h1', state: { activeSessionPath: '/a' } }); });
  await act(async () => { receive()({ type: 'state', hostInstanceId: 'h1', state: { activeSessionPath: '/b' } }); });
  assert.equal(instance.destroyed, true, 'session switch destroys the instance without waiting for an animation');
  assert.equal(document.activeElement, before, 'focus returns to the previously focused element');
  // A subsequent real PhotoSwipe close animation must not destroy it early.
  await act(async () => { openImageViewer({ src: 'data:image/png;base64,YQ==', alt: 'Second', source: inlineSource() }); });
  await flush();
  const second = FakePswp.instances.at(-1)!;
  assert.notEqual(second, instance);
  assert.equal(second.destroyed, false);
  await act(async () => { second.close(); });
  assert.equal(second.destroyed, true, 'non-animated library close destroys synchronously');
  await act(async () => { second.emit('destroy'); });
  assert.ok(true, 'destroy after animated close retires the instance');
  await unmount(mount);
  await act(async () => { dom.window.close(); });
});

test('inline clicks open the viewer, SVG stays view-only, and probe failures use PhotoSwipe', async () => {
  const { dom, mount } = viewerHarness();
  FakePswp.reset();
  const { adapter, sent } = adapterHarness();
  const measure = (src: string) => src.includes('broken')
    ? Promise.reject(new Error('no'))
    : Promise.resolve({ width: 2, height: 2 });
  await act(async () => { render(<ImageViewer adapter={adapter} measure={measure} pswpFactory={pswpFactory} />, mount); });
  const thumbnail = document.createElement('img');
  thumbnail.className = 'message-user-image-element'; thumbnail.tabIndex = 0;
  thumbnail.src = 'data:image/png;base64,YQ=='; document.body.appendChild(thumbnail);
  let bubbled = false;
  thumbnail.addEventListener('click', () => { bubbled = true; });
  await act(async () => { thumbnail.click(); });
  await flush();
  assert.equal(bubbled, false, 'delegated clicks never fall through to link handlers');
  const opened = FakePswp.instances.at(-1)!;
  assert.deepEqual(opened.options.dataSource[0].src, thumbnail.src);
  await act(async () => { opened.close(); });
  assert.equal(document.activeElement, thumbnail, 'click trigger regains focus after library removal');
  await act(async () => { clearImageViewer(); });
  await act(async () => { opened.emit('destroy'); });
  thumbnail.src = 'data:image/svg+xml;base64,PHN2Zy8+';
  await act(async () => { thumbnail.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  await flush();
  const svgInstance = FakePswp.instances.at(-1)!;
  assert.notEqual(svgInstance, opened, 'rendered SVG opens the viewer');
  assert.ok(svgInstance.elements['pie-image-copy']?.classList.contains('image-viewer-action-hidden'),
    'SVG embeds grant no native raster actions');
  assert.ok(svgInstance.elements['pie-image-reveal']?.classList.contains('image-viewer-action-hidden'));
  await act(async () => { (svgInstance.elements['pie-image-copy'] as HTMLButtonElement).click(); });
  assert.equal(sent.length, 0, 'SVG never requests native actions');
  await act(async () => { svgInstance.close(); });
  assert.equal(document.activeElement, thumbnail, 'keyboard trigger regains focus');

  await act(async () => {
    openImageViewer({ src: 'data:image/png;base64,broken', alt: 'Broken cached image', source: null });
  });
  await flush();
  assert.equal(FakePswp.instances.length, 3, 'a failed probe opens a library error slide');
  const broken = FakePswp.instances.at(-1)!;
  assert.match(broken.elements['pie-image-status'].textContent!, /could not be loaded/);
  await act(async () => { broken.close(); });
  assert.equal(mount.querySelector('[role="dialog"]'), null, 'closing the shell dismisses it');
  await act(async () => {
    openImageViewer({ src: 'data:image/png;base64,YQ==', alt: 'Loaded replacement', source: null });
  });
  await flush();
  const valid = FakePswp.instances.at(-1)!;
  assert.ok(valid, 'changing images opens the viewer for a valid image');
  await unmount(mount);
  assert.equal(valid.destroyed, true, 'unmount destroys the document.body-owned PhotoSwipe instance');
  await act(async () => { dom.window.close(); });
});