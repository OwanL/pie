import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../helpers/dom';
installDom();

import { createRef, render } from 'preact';
import { act } from 'preact/test-utils';

import type { WebviewToHostMessage } from '../../../lib/protocol/index.js';
import { ImagePathPreview } from '../../transcript/image-path-preview';
import {
  clearImagePreviewRequests,
  receiveImagePreviewResult,
} from '../../transcript/image-preview-store';

function installFakeTimers(): {
  scheduled: Map<number, { callback: () => void; delay: number }>;
  fireByDelay(delay: number): void;
  restore(): void;
} {
  const originals = {
    globalSet: globalThis.setTimeout,
    globalClear: globalThis.clearTimeout,
    windowSet: window.setTimeout,
    windowClear: window.clearTimeout,
  };
  const scheduled = new Map<number, { callback: () => void; delay: number }>();
  let nextId = 0;
  const set = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const id = ++nextId;
    scheduled.set(id, { callback: () => callback(...args), delay: delay ?? 0 });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const clear = ((timer?: ReturnType<typeof setTimeout>) => { scheduled.delete(Number(timer)); }) as typeof clearTimeout;
  globalThis.setTimeout = set;
  globalThis.clearTimeout = clear;
  window.setTimeout = set as typeof window.setTimeout;
  window.clearTimeout = clear as typeof window.clearTimeout;
  return {
    scheduled,
    fireByDelay(delay) {
      const match = [...scheduled].find(([, timer]) => timer.delay === delay);
      assert.ok(match, `expected a ${delay}ms timer`);
      scheduled.delete(match[0]);
      match[1].callback();
    },
    restore() {
      globalThis.setTimeout = originals.globalSet;
      globalThis.clearTimeout = originals.globalClear;
      window.setTimeout = originals.windowSet;
      window.clearTimeout = originals.windowClear;
    },
  };
}

let host: HTMLDivElement;
let anchor: HTMLAnchorElement;
let renderTarget: HTMLDivElement;
let posts: WebviewToHostMessage[];
let timers: ReturnType<typeof installFakeTimers>;

beforeEach(() => {
  clearImagePreviewRequests();
  posts = [];
  timers = installFakeTimers();
  host = document.createElement('div');
  anchor = document.createElement('a');
  anchor.setAttribute('data-pie-file-path', 'image.png');
  anchor.href = '#';
  host.appendChild(anchor);
  renderTarget = document.createElement('div');
  host.appendChild(renderTarget);
  document.body.appendChild(host);
  const rootRef = createRef<HTMLDivElement>();
  rootRef.current = host;
  act(() => render(
    <ImagePathPreview
      rootRef={rootRef}
      sessionPath="/sessions/a.jsonl"
      workingDirectory="/workspace"
      postMessage={(message) => posts.push(message)}
    />,
    renderTarget,
  ));
});

afterEach(() => {
  act(() => render(null, renderTarget));
  clearImagePreviewRequests();
  host.remove();
  timers.restore();
});

function fire(type: string, target: EventTarget = anchor, relatedTarget?: EventTarget | null): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  if (relatedTarget !== undefined) Object.defineProperty(event, 'relatedTarget', { value: relatedTarget });
  target.dispatchEvent(event);
}

function setRect(element: Element, rect: { left: number; top: number; width: number; height: number }): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }),
  });
}

function startPointerPreview(): Extract<WebviewToHostMessage, { type: 'requestImagePreview' }> {
  act(() => fire('pointerover'));
  act(() => timers.fireByDelay(350));
  const request = posts.find((post) => post.type === 'requestImagePreview');
  assert.ok(request && request.type === 'requestImagePreview');
  return request;
}

test('delayed pointer preview shows loading and then the host image without changing open-file requests', () => {
  const request = startPointerPreview();
  assert.equal(request.path, '/workspace/image.png');
  assert.equal(request.reference, 'image.png');
  assert.equal(request.workingDirectory, '/workspace');
  assert.match(host.textContent ?? '', /Loading preview/);

  act(() => receiveImagePreviewResult({
    type: 'imagePreviewResult',
    requestId: request.requestId,
    sessionPath: request.sessionPath,
    viewGeneration: 1,
    status: 'ready',
    data: { mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
  }));
  const image = host.querySelector<HTMLImageElement>('.image-path-preview img');
  assert.equal(image?.getAttribute('src'), 'data:image/png;base64,iVBORw0KGgo=');
});

test('image decode errors switch to the quiet unavailable state', () => {
  const request = startPointerPreview();
  act(() => receiveImagePreviewResult({
    type: 'imagePreviewResult',
    requestId: request.requestId,
    sessionPath: request.sessionPath,
    viewGeneration: 1,
    status: 'ready',
    data: { mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
  }));
  const image = host.querySelector('img');
  assert.ok(image);
  act(() => { image.dispatchEvent(new Event('error')); });
  assert.match(host.textContent ?? '', /Preview unavailable/);
});

test('unavailable results remain quiet and Escape dismisses the hover preview', () => {
  const request = startPointerPreview();
  act(() => receiveImagePreviewResult({
    type: 'imagePreviewResult',
    requestId: request.requestId,
    sessionPath: request.sessionPath,
    viewGeneration: 1,
    status: 'unavailable',
  }));
  assert.match(host.textContent ?? '', /Preview unavailable/);

  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
  assert.equal(host.querySelector('[data-testid="image-path-preview"]'), null);
});

test('keyboard focus starts a preview; timeout marks it unavailable and ignores late results', () => {
  anchor.tabIndex = 0;
  act(() => fire('focusin'));
  act(() => timers.fireByDelay(350));
  const request = posts.find((post) => post.type === 'requestImagePreview');
  assert.ok(request && request.type === 'requestImagePreview');
  assert.match(host.textContent ?? '', /Loading preview/);

  act(() => timers.fireByDelay(8_000));
  assert.match(host.textContent ?? '', /Preview unavailable/);
  act(() => receiveImagePreviewResult({
    type: 'imagePreviewResult',
    requestId: request.requestId,
    sessionPath: request.sessionPath,
    viewGeneration: 1,
    status: 'ready',
    data: { mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
  }));
  assert.match(host.textContent ?? '', /Preview unavailable/);
});

test('a disconnected anchor dismisses its preview and ignores the result', () => {
  const request = startPointerPreview();
  act(() => anchor.remove());
  act(() => receiveImagePreviewResult({
    type: 'imagePreviewResult',
    requestId: request.requestId,
    sessionPath: request.sessionPath,
    viewGeneration: 1,
    status: 'ready',
    data: { mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
  }));
  assert.equal(host.querySelector('[data-testid="image-path-preview"]'), null);
});

test('leaving dismisses a pending preview and discards late results', () => {
  const request = startPointerPreview();
  act(() => fire('pointerout'));
  act(() => timers.fireByDelay(220));
  act(() => receiveImagePreviewResult({
    type: 'imagePreviewResult',
    requestId: request.requestId,
    sessionPath: request.sessionPath,
    viewGeneration: 1,
    status: 'ready',
    data: { mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
  }));
  assert.equal(host.querySelector('[data-testid="image-path-preview"]'), null);
});

test('moving from the anchor through the popover and out dismisses the preview', () => {
  startPointerPreview();
  const popover = host.querySelector<HTMLElement>('[data-testid="image-path-preview"]');
  assert.ok(popover);

  act(() => fire('pointerout', anchor, popover));
  act(() => fire('mouseenter', popover, anchor));
  act(() => fire('mouseleave', popover, document.body));
  act(() => timers.fireByDelay(220));

  assert.equal(host.querySelector('[data-testid="image-path-preview"]'), null);
});

test('image load reclamps the preview to transcript width and height', () => {
  setRect(host, { left: 100, top: 100, width: 200, height: 180 });
  setRect(anchor, { left: 250, top: 245, width: 40, height: 20 });
  const request = startPointerPreview();
  let imageLoaded = false;
  const popover = host.querySelector<HTMLElement>('[data-testid="image-path-preview"]');
  assert.ok(popover);
  Object.defineProperty(popover, 'getBoundingClientRect', {
    configurable: true,
    value: () => {
      const maxWidth = Number.parseFloat(popover.style.maxWidth) || 1_000;
      const maxHeight = Number.parseFloat(popover.style.maxHeight) || 1_000;
      const width = imageLoaded ? 400 : 80;
      const height = imageLoaded ? 300 : 60;
      return {
        left: 0,
        top: 0,
        right: Math.min(width, maxWidth),
        bottom: Math.min(height, maxHeight),
        width: Math.min(width, maxWidth),
        height: Math.min(height, maxHeight),
        x: 0,
        y: 0,
        toJSON: () => ({}),
      };
    },
  });
  act(() => receiveImagePreviewResult({
    type: 'imagePreviewResult',
    requestId: request.requestId,
    sessionPath: request.sessionPath,
    viewGeneration: 1,
    status: 'ready',
    data: { mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
  }));
  const image = host.querySelector<HTMLImageElement>('.image-path-preview img');
  assert.ok(image);
  assert.equal(popover.style.maxWidth, '184px');
  assert.equal(popover.style.maxHeight, '164px');
  assert.equal(popover.style.left, '212px');
  assert.equal(popover.style.top, '177px');

  imageLoaded = true;
  act(() => fire('load', image));
  assert.equal(popover.style.left, '108px');
  assert.equal(popover.style.top, '108px');
});

test('removing a ready preview anchor dismisses without another response or scroll', async () => {
  const request = startPointerPreview();
  act(() => receiveImagePreviewResult({
    type: 'imagePreviewResult',
    requestId: request.requestId,
    sessionPath: request.sessionPath,
    viewGeneration: 1,
    status: 'ready',
    data: { mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
  }));
  assert.ok(host.querySelector('[data-testid="image-path-preview"]'));

  act(() => anchor.remove());
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(host.querySelector('[data-testid="image-path-preview"]'), null);
});

test('tooltip description is cleaned up and click activation is preserved', () => {
  anchor.setAttribute('aria-describedby', 'existing-help');
  const request = startPointerPreview();
  const popover = host.querySelector<HTMLElement>('[data-testid="image-path-preview"]');
  assert.ok(popover);
  assert.equal(anchor.getAttribute('aria-describedby'), `existing-help ${request.requestId}`);

  let activated = false;
  let preventedBeforeBubbling = true;
  anchor.addEventListener('click', (event) => {
    activated = true;
    preventedBeforeBubbling = event.defaultPrevented;
    event.preventDefault();
    event.stopPropagation();
  });
  act(() => fire('click'));
  assert.equal(activated, true);
  assert.equal(preventedBeforeBubbling, false);
  assert.equal(anchor.getAttribute('aria-describedby'), 'existing-help');
  assert.equal(host.querySelector('[data-testid="image-path-preview"]'), null);

  anchor.addEventListener('contextmenu', (event) => event.stopPropagation());
  startPointerPreview();
  act(() => fire('contextmenu'));
  assert.equal(anchor.getAttribute('aria-describedby'), 'existing-help');
  assert.equal(host.querySelector('[data-testid="image-path-preview"]'), null);
});
