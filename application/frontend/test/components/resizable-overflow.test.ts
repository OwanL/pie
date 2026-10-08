import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../helpers/dom';
installDom();

// Stub DOMPurify before any component imports (matches webview-render.test.ts)
import DOMPurify from 'dompurify';
DOMPurify.sanitize = ((html: string) => html) as typeof DOMPurify.sanitize;

import type { ComponentChildren } from 'preact';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { ResizablePre } from '../../lib/components/resizable-pre';
import { ToolCallBody } from '../../transcript/tool-call-card/tool-call-body';
import type { ToolCall } from '../../../lib/protocol/index.js';

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  render(null, container);
  container.remove();
});

function scrollEl(): HTMLPreElement | null {
  return container.querySelector('pre.resizable-scroll-area-scroll');
}

function handles(): Element[] {
  return Array.from(container.querySelectorAll('.resize-handle'));
}

/** Override the scroll element's box metrics so the resize hook's overflow
 *  check (`scrollHeight - clientHeight > 1`) reports the desired state.
 *  happy-dom does no real layout, so both default to 0. */
function mockOverflow(el: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
}

function renderPre(children: ComponentChildren, scrollHint?: string): void {
  // Wrap in act() so the hook's useLayoutEffect (which calls setState to
  // publish its overflow measurement) flushes synchronously before the
  // assertion reads the DOM.
  act(() => {
    render(h(ResizablePre, { minHeight: 80, children, scrollHint }), container);
  });
}

const hintText = 'Swipe to scroll output';
function hint(): Element | null { return container.querySelector('.resizable-scroll-hint'); }
function mockWidth(el: HTMLElement, scrollWidth: number, clientWidth: number): void {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scrollWidth });
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: clientWidth });
}

test('scroll cue is opt-in, outside code, and absent for short results', () => {
  renderPre(h('code', null, 'short'), hintText);
  const pre = scrollEl()!;
  mockOverflow(pre, 100, 240);
  mockWidth(pre, 100, 200);
  renderPre(h('code', null, 'short'), hintText);
  assert.equal(hint(), null);
  mockWidth(pre, 500, 200);
  renderPre(h('code', null, 'wide'));
  assert.equal(hint(), null, 'other viewers do not opt in');
  renderPre(h('code', null, 'wide'), hintText);
  assert.equal(hint()?.textContent, hintText);
  assert.equal(pre.querySelector('.resizable-scroll-hint'), null);
  assert.equal(handles().length, 0, 'horizontal overflow does not alter shared vertical resizing');
  renderPre(h('code', null, 'wide'));
  assert.equal(hint(), null, 'removing opt-in removes cue');
});

test('cue updates on vertical resize-to-fit and reset, independent of persistent handles', () => {
  renderPre(h('code', null, 'tall'), hintText);
  const pre = scrollEl()!;
  mockOverflow(pre, 600, 240);
  renderPre(h('code', null, 'tall'), hintText);
  assert.ok(hint());
  mockOverflow(pre, 200, 400);
  act(() => {
    container.querySelector('.resize-handle-bottom')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
  });
  assert.equal(hint(), null, 'user height fitting content removes cue');
  assert.equal(handles().length, 2, 'handles remain available after resize');
  mockOverflow(pre, 600, 240);
  act(() => { container.querySelector('.resize-handle-bottom')!.dispatchEvent(new MouseEvent('dblclick')); });
  assert.ok(hint(), 'reset overflowing CSS height restores cue');
});

test('cue remeasures width on observer/window resize and cleans up observers', () => {
  const original = globalThis.ResizeObserver;
  let notify: (() => void) | undefined;
  let observed: Element | undefined;
  let disconnected = false;
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) { notify = callback; }
    observe(el: Element) { observed = el; }
    disconnect() { disconnected = true; }
    unobserve() {}
  } as unknown as typeof ResizeObserver;
  try {
    renderPre(h('code', null, 'wide'), hintText);
    const pre = scrollEl()!;
    assert.equal(observed, pre);
    mockWidth(pre, 500, 200);
    act(() => { notify!(); });
    assert.ok(hint());
    mockWidth(pre, 500, 600);
    act(() => { window.dispatchEvent(new Event('resize')); });
    assert.equal(hint(), null, 'orientation width fitting content removes cue');
    mockWidth(pre, 500, 200);
    act(() => { window.dispatchEvent(new Event('resize')); });
    assert.ok(hint());
    act(() => { render(null, container); });
    assert.equal(disconnected, true);
  } finally { globalThis.ResizeObserver = original; }
});

test('only normalized read direct text results opt in to the scroll cue', () => {
  for (const [name, result, expected] of [
    ['read', 'file text', true],
    [' READ ', { content: [{ type: 'text', text: 'file text' }] }, true],
    ['cat', 'file text', false],
    ['write', 'file text', false],
    ['read', { custom: 'structured result' }, false],
    ['read', { content: [{ type: 'text', text: 'caption' }, { type: 'image', data: 'YWJj', mimeType: 'image/png' }] }, false],
  ] as const) {
    act(() => { render(null, container); });
    const call: ToolCall = { id: 'result', name, input: {}, result, status: 'completed' };
    const renderBody = () => act(() => { render(h(ToolCallBody, { toolCall: call, onOpenFile: () => {} }), container); });
    renderBody();
    const pre = container.querySelector('pre');
    if (pre) mockOverflow(pre, 600, 240);
    renderBody();
    assert.equal(Boolean(hint()), expected, `${name} ${JSON.stringify(result)}`);
  }
});

test('hides resize handles when content fits naturally (no overflow)', () => {
  renderPre(h('code', null, 'single line'));
  const pre = scrollEl();
  assert.ok(pre, 'scroll <pre> rendered');
  // Content fits within the visible area → no overflow.
  mockOverflow(pre!, 100, 240);
  // Re-render so the hook's layout effect re-measures with the mocked metrics.
  renderPre(h('code', null, 'single line'));
  assert.deepEqual(handles(), [], 'no resize handles when content fits');
});

test('shows resize handles when content overflows the visible area', () => {
  renderPre(h('code', null, 'line\n'.repeat(50)));
  const pre = scrollEl();
  assert.ok(pre, 'scroll <pre> rendered');
  // Content taller than the visible area → overflows.
  mockOverflow(pre!, 600, 240);
  renderPre(h('code', null, 'line\n'.repeat(50)));
  const found = handles();
  assert.equal(found.length, 2, 'top + bottom handles render when content overflows');
  assert.ok(found[0]!.classList.contains('resize-handle-top'), 'top handle present');
  assert.ok(found[1]!.classList.contains('resize-handle-bottom'), 'bottom handle present');
});

test('keeps handles after a user resize even when content no longer overflows', () => {
  // First render: content overflows → handles appear.
  renderPre(h('code', null, 'line\n'.repeat(50)));
  const pre = scrollEl()!;
  mockOverflow(pre, 600, 240);
  renderPre(h('code', null, 'line\n'.repeat(50)));
  assert.equal(handles().length, 2, 'handles appear once content overflows');

  // Simulate the user dragging the height tall enough to fit all content.
  // `height !== null` (user has resized) should keep the handles available so
  // the user is not stuck unable to shrink the pane back.
  mockOverflow(pre, 200, 400);
  // Drive a resize via the bottom handle's keyboard handler (ArrowDown grows
  // a bottom handle by 10px), which sets an explicit `height`.
  act(() => {
    container.querySelector('.resize-handle-bottom')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
  });
  renderPre(h('code', null, 'line\n'.repeat(50)));
  assert.equal(handles().length, 2, 'handles stay after a user resize even if content fits');
});

test('reset (double-click) hides handles again when content no longer overflows', () => {
  // Start with overflowing content so handles appear and the user resizes.
  renderPre(h('code', null, 'line\n'.repeat(50)));
  const pre = scrollEl()!;
  mockOverflow(pre, 600, 240);
  renderPre(h('code', null, 'line\n'.repeat(50)));
  assert.equal(handles().length, 2, 'handles appear once content overflows');

  // User grows the pane (sets an explicit height).
  act(() => {
    container.querySelector('.resize-handle-bottom')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
  });
  // Content now fits the grown pane.
  mockOverflow(pre, 200, 400);
  renderPre(h('code', null, 'line\n'.repeat(50)));
  assert.equal(handles().length, 2, 'handles stay while a user height is set');

  // Double-click reset reverts to the CSS default; with no overflow the
  // handles should disappear.
  act(() => {
    container.querySelector('.resize-handle-bottom')!
      .dispatchEvent(new MouseEvent('dblclick'));
  });
  renderPre(h('code', null, 'line\n'.repeat(50)));
  assert.equal(handles().length, 0, 'handles hide after reset when content fits');
});
