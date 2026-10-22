/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'MutationObserver'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'window' ? dom.window : dom.window[key] });
}

import { createRef, render } from 'preact';
import { act } from 'preact/test-utils';
import type { WebviewToHostMessage } from '../../../lib/protocol/index.js';
import { InlineMarkdownImages, MAX_INLINE_IMAGE_OWNERS } from '../../transcript/inline-markdown-images';
import { clearImagePreviewRequests, receiveImagePreviewResult } from '../../transcript/image-preview-store';

type Request = Extract<WebviewToHostMessage, { type: 'requestImagePreview' }>;
let root: HTMLDivElement;
let target: HTMLDivElement;
let rootRef: ReturnType<typeof createRef<HTMLDivElement>>;
let requests: Request[];
const post = (message: WebviewToHostMessage) => { if (message.type === 'requestImagePreview') requests.push(message); };
async function markdown(text: string, enabled = true) {
  const { renderMarkdown } = await import('../../transcript/markdown');
  return renderMarkdown(text, true, enabled);
}
function mount(sessionPath: string | null = '/sessions/a', workingDirectory: string | null = 'C:/workspace') {
  act(() => render(<InlineMarkdownImages rootRef={rootRef} sessionPath={sessionPath} workingDirectory={workingDirectory} postMessage={post} />, target));
}
function reply(request: Request, status: 'ready' | 'unavailable' = 'ready', sessionPath = request.sessionPath) {
  act(() => receiveImagePreviewResult({
    type: 'imagePreviewResult', requestId: request.requestId, sessionPath, viewGeneration: 1, status,
    ...(status === 'ready' ? { data: { mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' } } : {}),
  }));
}
async function mutations() { await Promise.resolve(); await Promise.resolve(); }
beforeEach(() => {
  clearImagePreviewRequests();
  requests = [];
  root = document.createElement('div');
  target = document.createElement('div');
  rootRef = createRef<HTMLDivElement>();
  rootRef.current = root;
  document.body.append(root, target);
});
afterEach(() => {
  act(() => render(null, target));
  clearImagePreviewRequests();
  root.remove();
  target.remove();
  delete (globalThis as any).IntersectionObserver;
});

test('Windows markdown hydrates the actual placeholder with bounded targeted data and alt/title', async () => {
  const source = '![Chart & details](C:/workspace/chart.png "A & title")';
  root.innerHTML = await markdown(source);
  assert.equal(root.querySelector('img'), null);
  mount();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, 'C:/workspace/chart.png');
  assert.equal(requests[0].reference, 'C:/workspace/chart.png');
  assert.equal(requests[0].workingDirectory, 'C:/workspace');
  reply(requests[0]);
  const image = root.querySelector('img');
  assert.equal(image?.getAttribute('src'), 'data:image/png;base64,iVBORw0KGgo=');
  assert.equal(image?.alt, 'Chart & details');
  assert.equal(image?.title, 'A & title');
  assert.equal(root.querySelector('.inline-markdown-image-fallback')?.hasAttribute('hidden'), true);
  assert.doesNotMatch(await markdown(source), /data:image|<img/);
  image?.dispatchEvent(new dom.window.Event('error'));
  assert.equal(root.querySelector('img'), null);
  assert.match(root.textContent ?? '', /Chart & details/);
  await mutations();
  assert.equal(requests.length, 1);
});

test('linked hydrated images remain native anchor labels rather than separate button tab stops', async () => {
  root.innerHTML = await markdown('[![preview](./preview.png)](actual.ts) ![standalone](./other.png)');
  mount();
  assert.equal(requests.length, 2);
  reply(requests[0]);
  reply(requests[1]);
  const anchor = root.querySelector('a[href]')!;
  const linked = anchor.querySelector('img')!;
  assert.ok(linked);
  assert.equal(anchor.getAttribute('href'), 'actual.ts');
  assert.equal(linked.hasAttribute('tabindex'), false, 'Enter targets the native anchor, not a dead image tab stop');
  assert.equal(linked.hasAttribute('role'), false);
  assert.equal(linked.hasAttribute('aria-label'), false);
  assert.equal(linked.alt, 'preview');
  const standalone = root.querySelectorAll('img')[1];
  assert.equal(standalone.tabIndex, 0);
  assert.equal(standalone.getAttribute('role'), 'button');
  assert.equal(standalone.getAttribute('aria-label'), 'View standalone');
});

test('the transcript-style parent ref is ready when the child hydrator mounts', async () => {
  const html = await markdown('![chart](chart.png)');
  const parentRef = createRef<HTMLDivElement>();
  act(() => render(<div ref={parentRef}>
    <div dangerouslySetInnerHTML={{ __html: html }} />
    <InlineMarkdownImages rootRef={parentRef} sessionPath="/sessions/a" workingDirectory="C:/workspace" postMessage={post} />
  </div>, target));
  assert.equal(requests.length, 1);
  reply(requests[0]);
  assert.ok(parentRef.current?.querySelector('img'));
});

test('disabled contexts and remote/SVG images never request local hydration', async () => {
  root.innerHTML = await markdown('![disabled](C:/chart.png)', false)
    + await markdown('![remote](https://example.com/chart.png) ![vector](C:/chart.svg)');
  mount();
  assert.equal(requests.length, 0);
  assert.equal(root.querySelector('img')?.getAttribute('src'), 'https://example.com/chart.png');
});

test('missing files, wrong-session and malformed replies stay readable without retries', async () => {
  root.innerHTML = await markdown('![missing](missing.png) ![other](other.png) ![malformed](bad.png)');
  mount();
  assert.equal(requests.length, 2);
  reply(requests[0], 'unavailable');
  assert.equal(requests.length, 3);
  reply(requests[1], 'ready', '/sessions/wrong');
  act(() => receiveImagePreviewResult({
    type: 'imagePreviewResult', requestId: requests[2].requestId, sessionPath: '/sessions/a', viewGeneration: 1,
    status: 'ready', data: { mimeType: 'image/svg+xml', dataUrl: 'data:image/svg+xml;base64,AAAA' },
  }));
  await mutations();
  assert.equal(root.querySelector('img'), null);
  assert.match(root.textContent ?? '', /missing.*other.*malformed/);
  assert.equal(requests.length, 3);
});

test('session and cwd changes erase ready bytes and reject old replies', async () => {
  root.innerHTML = await markdown('![chart](chart.png) ![later](later.png)');
  mount();
  const old = [...requests];
  reply(old[0]);
  mount('/sessions/b', 'D:/new');
  assert.equal(root.querySelector('img'), null);
  assert.equal(requests[2].path, 'D:/new/chart.png');
  reply(old[1]);
  assert.equal(root.querySelector('img'), null);
  reply(requests[2]);
  assert.ok(root.querySelector('img'));
  mount('/sessions/b', 'E:/changed');
  assert.equal(root.querySelector('img'), null);
  assert.equal(requests[4].path, 'E:/changed/chart.png');
});

test('unmount, row removal and disconnect discard stale replies and reset ready DOM', async () => {
  root.innerHTML = await markdown('![chart](chart.png) ![later](later.png) ![queued](queued.png)');
  mount();
  const old = [...requests];
  reply(old[0]);
  assert.ok(root.querySelector('img'));
  const beforeClear = requests.length;
  act(() => clearImagePreviewRequests());
  assert.equal(root.querySelector('img'), null);
  reply(old[1]);
  await mutations();
  assert.equal(requests.length, beforeClear);
  assert.equal(root.querySelector('img'), null);
  act(() => render(null, target));
  reply(requests.at(-1)!);
  assert.equal(root.querySelector('img'), null);
  root.innerHTML = await markdown('![new](new.png)');
  mount();
  const removedRequest = requests.at(-1)!;
  root.replaceChildren();
  reply(removedRequest);
  assert.equal(root.querySelector('img'), null);
});

test('mounted queue and ready byte owners are bounded; only two requests run concurrently', async () => {
  root.innerHTML = await markdown(Array.from({ length: 30 }, (_, i) => `![${i}](${i}.png)`).join(' '));
  mount();
  assert.equal(requests.length, 2);
  for (let i = 0; i < MAX_INLINE_IMAGE_OWNERS; i++) {
    assert.ok(requests[i]);
    reply(requests[i]);
  }
  await mutations();
  assert.equal(requests.length, MAX_INLINE_IMAGE_OWNERS);
  assert.equal(root.querySelectorAll('img').length, MAX_INLINE_IMAGE_OWNERS);
  // Culling a mounted row drops its bytes and frees one bounded slot.
  root.querySelector('[data-pie-inline-image]')?.remove();
  await mutations();
  assert.equal(requests.length, MAX_INLINE_IMAGE_OWNERS + 1);
  const beforeReset = requests.length;
  act(() => clearImagePreviewRequests());
  await mutations();
  assert.equal(root.querySelectorAll('img').length, 0);
  assert.equal(requests.length, beforeReset);
});

test('eight unavailable visible images release slots for a valid ninth without retries', async () => {
  let callback: IntersectionObserverCallback | undefined;
  const observed: Element[] = [];
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: class {
    constructor(cb: IntersectionObserverCallback) { callback = cb; }
    observe(node: Element) { observed.push(node); }
    unobserve() {}
    disconnect() {}
  } });
  root.innerHTML = await markdown(Array.from({ length: 9 }, (_, i) => `![${i}](${i}.png)`).join(' '));
  mount();
  act(() => callback!(observed.map(target => ({ target, isIntersecting: true } as IntersectionObserverEntry)), {} as IntersectionObserver));
  assert.equal(requests.length, 2);
  for (let i = 0; i < 8; i++) {
    assert.ok(requests[i]);
    reply(requests[i], 'unavailable');
    await mutations();
    assert.ok(requests.length <= i + 3, 'at most two requests remain pending');
  }
  assert.equal(requests.length, 9);
  reply(requests[8]);
  await mutations();
  assert.equal(root.querySelectorAll('img').length, 1);
  assert.equal(requests[8].reference, '8.png');
  assert.equal(requests.length, 9);
});

test('timeout releases capacity, ignores late bytes and does not retry a missing image', async () => {
  const originalSet = window.setTimeout;
  const originalClear = window.clearTimeout;
  const timers = new Map<number, () => void>();
  let id = 0;
  window.setTimeout = ((callback: () => void) => { timers.set(++id, callback); return id; }) as typeof window.setTimeout;
  window.clearTimeout = ((timer: number) => { timers.delete(timer); }) as typeof window.clearTimeout;
  try {
    root.innerHTML = await markdown(Array.from({ length: 9 }, (_, i) => `![${i}](${i}.png)`).join(' '));
    mount();
    const old = requests[0];
    const first = [...timers][0];
    timers.delete(first[0]);
    act(() => first[1]());
    assert.equal(requests.length, 3);
    reply(old);
    assert.equal(root.querySelector('img'), null);
    for (let i = 1; i < 8; i++) {
      const next = [...timers][0];
      assert.ok(next);
      timers.delete(next[0]);
      act(() => next[1]());
      await mutations();
    }
    assert.equal(requests.length, 9);
    reply(requests[8]);
    await mutations();
    assert.equal(root.querySelectorAll('img').length, 1);
    assert.equal(requests.length, 9);
    assert.equal(timers.size, 0);
  } finally {
    act(() => render(null, target));
    window.setTimeout = originalSet;
    window.clearTimeout = originalClear;
  }
});

test('a refused transport request stays fallback-only and releases its subscription', async () => {
  root.innerHTML = await markdown('![chart](chart.png)');
  act(() => render(<InlineMarkdownImages rootRef={rootRef} sessionPath="/sessions/a" workingDirectory="C:/workspace"
    postMessage={(message) => { post(message); return false; }} />, target));
  assert.equal(requests.length, 1);
  reply(requests[0]);
  await mutations();
  assert.equal(root.querySelector('img'), null);
  assert.equal(requests.length, 1);
});

for (const failure of ['refused', 'throw', 'synchronous unavailable'] as const) {
  test(`${failure} requests release empty slots without synchronous reentrancy or retries`, async () => {
    root.innerHTML = await markdown(Array.from({ length: 9 }, (_, i) => `![${i}](${i}.png)`).join(' '));
    let depth = 0;
    let maxDepth = 0;
    const transport = (message: WebviewToHostMessage) => {
      post(message);
      if (message.type !== 'requestImagePreview') return;
      depth++;
      maxDepth = Math.max(maxDepth, depth);
      try {
        if (message.reference === '8.png') return;
        if (failure === 'refused') return false;
        if (failure === 'throw') throw new Error('transport unavailable');
        receiveImagePreviewResult({
          type: 'imagePreviewResult', requestId: message.requestId, sessionPath: message.sessionPath,
          viewGeneration: 1, status: 'unavailable',
        });
      } finally {
        depth--;
      }
    };
    act(() => render(<InlineMarkdownImages rootRef={rootRef} sessionPath="/sessions/a" workingDirectory="C:/workspace"
      postMessage={transport} />, target));
    await mutations();
    assert.equal(requests.length, 9);
    assert.equal(maxDepth, 1);
    reply(requests[8]);
    await mutations();
    assert.equal(root.querySelectorAll('img').length, 1);
    assert.equal(requests.length, 9);
  });
}

test('IntersectionObserver gates requests on visible mounted placeholders', async () => {
  let callback: IntersectionObserverCallback | undefined;
  const observed: Element[] = [];
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: class {
    constructor(cb: IntersectionObserverCallback) { callback = cb; }
    observe(node: Element) { observed.push(node); }
    unobserve() {}
    disconnect() {}
  } });
  root.innerHTML = await markdown('![chart](chart.png) ![later](later.png)');
  mount();
  assert.equal(requests.length, 0);
  assert.equal(observed.length, 2);
  act(() => callback!([{ target: observed[1], isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].reference, 'later.png');
});
