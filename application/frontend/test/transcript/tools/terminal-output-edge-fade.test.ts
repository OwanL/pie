import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../../helpers/dom';
installDom();

// Stub DOMPurify before any component imports (matches webview-render.test.ts)
import DOMPurify from 'dompurify';
DOMPurify.sanitize = ((html: string) => html) as typeof DOMPurify.sanitize;

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { TerminalOutput } from '../../../transcript/tool-call-card/terminal-output';

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  render(null, container);
  container.remove();
});

function terminal(): HTMLPreElement | null {
  return container.querySelector('pre.tool-call-terminal-pre');
}

/** happy-dom does no real layout; feed the component's scroll metrics. */
function mockScrollBox(el: HTMLElement, scrollWidth: number, clientWidth: number, scrollLeft: number): void {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scrollWidth });
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: clientWidth });
  Object.defineProperty(el, 'scrollLeft', { configurable: true, value: scrollLeft });
}

function renderTerminal(text: string): void {
  act(() => {
    render(h(TerminalOutput, { text, running: false, identity: 't' }), container);
  });
}

test('long terminal lines fade the clipped right edge and regain it after scrolling back', () => {
  renderTerminal('short');
  const pre = terminal()!;
  mockScrollBox(pre, 900, 200, 0);
  // Terminal output re-measures on scroll (the streaming/stick-to-bottom pane
  // has no unrelated re-render loop to lean on).
  act(() => { pre.dispatchEvent(new Event('scroll')); });
  assert.ok(pre.classList.contains('fade-right'), 'clipped right columns fade as a visible scroll cue');
  assert.ok(!pre.classList.contains('fade-left'));

  mockScrollBox(pre, 900, 200, 700);
  act(() => { pre.dispatchEvent(new Event('scroll')); });
  assert.ok(!pre.classList.contains('fade-right'), 'fade clears once the direction is scrolled to the end');
  assert.ok(pre.classList.contains('fade-left'));

  // Whitespace preservation is untouched: horizontal scroll, never wrapping.
  assert.equal(pre.getAttribute('tabindex'), '0');
  assert.equal(pre.getAttribute('aria-label'), 'Terminal output');
});

test('terminal output that fits fades nothing and stays scroll-region-free', () => {
  renderTerminal('short');
  const pre = terminal()!;
  mockScrollBox(pre, 200, 200, 0);
  act(() => { pre.dispatchEvent(new Event('scroll')); });
  assert.ok(!pre.classList.contains('fade-left') && !pre.classList.contains('fade-right'));
  assert.equal(pre.hasAttribute('tabindex'), false);
});