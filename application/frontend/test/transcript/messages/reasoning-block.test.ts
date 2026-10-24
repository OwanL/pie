import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { installDom } from '../../helpers/dom';
installDom();

import DOMPurify from 'dompurify';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import type { ComponentProps } from 'preact';
import type { LazyDetailRef, WebviewToHostMessage } from '../../../../lib/protocol/index.js';
import { ReasoningBlock } from '../../../transcript/message-item/reasoning-block';
import { reasoningPreview } from '../../../transcript/markdown';
import { clearCollapsibleCache } from '../../../transcript/use-collapsible-open';
import {
  clearLazyDetailCache,
  receiveLazyDetailResult,
  setLazyDetailPostMessage,
} from '../../../transcript/lazy-detail-store';

type Props = ComponentProps<typeof ReasoningBlock>;
let host: HTMLDivElement;
let props: Props;
let rows: (element: HTMLElement) => number;
let requests: WebviewToHostMessage[];
let restore: Array<() => void>;
const observers = new Set<TestResizeObserver>();

class TestResizeObserver {
  targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) { observers.add(this); }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); observers.delete(this); }
  notify(target: Element) {
    if (this.targets.has(target)) {
      this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
  }
}

function stub(object: object, key: PropertyKey, descriptor: PropertyDescriptor): void {
  const original = Object.getOwnPropertyDescriptor(object, key);
  Object.defineProperty(object, key, { configurable: true, ...descriptor });
  restore.push(() => {
    if (original) Object.defineProperty(object, key, original);
    else Reflect.deleteProperty(object, key);
  });
}

beforeEach(() => {
  clearCollapsibleCache();
  clearLazyDetailCache();
  restore = [];
  rows = () => 7;
  requests = [];
  setLazyDetailPostMessage((message) => { requests.push(message); return true; });
  stub(DOMPurify, 'sanitize', { value: (html: string) => html, writable: true });
  const style = () => ({ lineHeight: '20px' } as CSSStyleDeclaration);
  stub(globalThis, 'getComputedStyle', { value: style, writable: true });
  stub(window, 'getComputedStyle', { value: style, writable: true });
  stub(globalThis, 'ResizeObserver', { value: TestResizeObserver, writable: true });
  stub(window, 'ResizeObserver', { value: TestResizeObserver, writable: true });
  // happy-dom has no layout: keep the rendered markdown as the source of
  // height, so a measurement of stale HTML cannot pass the streaming test.
  stub(HTMLElement.prototype, 'scrollHeight', {
    get(this: HTMLElement) { return this.classList.contains('reasoning-scroll') ? rows(this) * 20 : 0; },
  });
  stub(HTMLElement.prototype, 'getBoundingClientRect', {
    value(this: HTMLElement) {
      const height = this.classList.contains('reasoning-scroll') ? rows(this) * 20 : 0;
      return { x: 0, y: 0, left: 0, top: 0, right: 300, bottom: height, width: 300, height, toJSON: () => ({}) };
    },
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  props = {
    text: 'A **short** thought.\n\nAnother paragraph.',
    autoExpand: false,
    collapsibleKey: 'reasoning:test:0',
    onContextMenu: () => {},
  };
});

afterEach(() => {
  act(() => { render(null, host); });
  host.remove();
  clearCollapsibleCache();
  clearLazyDetailCache();
  setLazyDetailPostMessage(() => false);
  for (const undo of restore.reverse()) undo();
  observers.clear();
});

function mount(patch: Partial<Props> = {}): void {
  props = { ...props, ...patch };
  act(() => { render(h(ReasoningBlock, props), host); });
}

function header(): HTMLButtonElement {
  const element = host.querySelector<HTMLButtonElement>('.reasoning-block .collapsible-header');
  assert.ok(element, 'long reasoning has a disclosure header');
  return element;
}

function toggle(): void {
  act(() => { header().click(); });
}

async function flushMarkdown(): Promise<void> {
  await act(async () => { await delay(160); });
}

test('seven rendered rows show full inline markdown even with autoExpand disabled, without chrome', () => {
  mount();
  const body = host.querySelector('.reasoning-inline .reasoning-scroll');
  assert.ok(body);
  assert.equal(body.querySelector('strong')?.textContent, 'short');
  assert.equal(body.querySelectorAll('p').length, 2);
  assert.match(body.textContent ?? '', /Another paragraph\./);
  assert.ok(host.querySelector('.collapsible-header, .resize-handle, .collapsible-close-footer') === null);
  assert.equal(requests.length, 0);
  mount({ autoExpand: true });
  assert.ok(host.querySelector('.reasoning-inline .reasoning-scroll'));
  assert.ok(host.querySelector('.collapsible-header, .resize-handle, .collapsible-close-footer') === null);
});

test('eight rendered rows collapse to an icon and an unbounded normalized preview without a label', () => {
  rows = () => 8;
  const text = `**First**\n\n${'more words '.repeat(25)}the final words`;
  mount({ text });
  assert.equal(header().getAttribute('aria-expanded'), 'false');
  assert.ok(header().querySelector('.reasoning-icon'));
  assert.ok(header().querySelector('.transcript-header-label') === null);
  const expected = `First ${'more words '.repeat(25)}the final words`;
  assert.equal(reasoningPreview(text), expected);
  assert.equal(header().querySelector('.reasoning-preview')?.textContent, expected);
  assert.ok(host.querySelector('.reasoning-inline') === null);
});

test('width-driven wrapping is measured by the inline ResizeObserver and overflow stays latched', () => {
  mount();
  const body = host.querySelector<HTMLElement>('.reasoning-inline .reasoning-scroll')!;
  const watching = [...observers].filter((observer) => observer.targets.has(body));
  assert.ok(watching.length > 0, 'inline body is observed for width-driven wrapping');
  rows = () => 8;
  act(() => { for (const observer of watching) observer.notify(body); });
  assert.equal(header().getAttribute('aria-expanded'), 'false');
  rows = () => 1;
  mount({ text: 'Now short' });
  assert.equal(header().getAttribute('aria-expanded'), 'false');
  assert.ok(host.querySelector('.reasoning-inline') === null);
  assert.ok(watching.every((observer) => !observer.targets.has(body)), 'inline observer is disconnected after overflow');
});

test('growing streaming markdown is remeasured after rendering and does not close a manually opened row', async () => {
  rows = (element) => element.textContent?.includes('threshold reached') ? 8 : 7;
  mount({ streaming: true });
  assert.ok(host.querySelector('.reasoning-inline .reasoning-scroll'));
  mount({ text: `${props.text}\n\nthreshold reached` });
  await flushMarkdown();
  assert.equal(header().getAttribute('aria-expanded'), 'false');
  toggle();
  assert.equal(header().getAttribute('aria-expanded'), 'true');
  mount({ text: `${props.text}\n\nLater streaming tokens` });
  await flushMarkdown();
  assert.equal(header().getAttribute('aria-expanded'), 'true');
  assert.match(host.querySelector('.reasoning-scroll')?.textContent ?? '', /Later streaming tokens/);
  toggle();
  assert.equal(header().getAttribute('aria-expanded'), 'false');
});

test('long reasoning honors autoExpand and reuses manual disclosure state on remount', () => {
  rows = () => 8;
  mount({ autoExpand: true });
  assert.equal(header().getAttribute('aria-expanded'), 'true');
  assert.ok(host.querySelector('.reasoning-scroll strong'));
  toggle();
  assert.equal(header().getAttribute('aria-expanded'), 'false');
  act(() => { render(null, host); });
  mount();
  assert.equal(header().getAttribute('aria-expanded'), 'false');
  toggle();
  assert.equal(header().getAttribute('aria-expanded'), 'true');
});

test('a compact lazy summary stays collapsible and fetches detail only on expansion', async () => {
  rows = () => 1;
  const detailRef: LazyDetailRef = {
    key: 'durable:reasoning:test:0', kind: 'reasoning', source: 'durable',
    sessionPath: '/session', messageId: 'test', partIndex: 0,
    sizeBytes: 1200, summary: 'Compact summary', available: true,
  };
  mount({ text: detailRef.summary, detailRef });
  assert.equal(header().getAttribute('aria-expanded'), 'false');
  assert.ok(host.querySelector('.reasoning-inline') === null);
  assert.equal(requests.length, 0, 'short compact summary must not auto-fetch');
  toggle();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].type, 'requestDetail');
  act(() => {
    receiveLazyDetailResult({ sessionPath: '/session', key: detailRef.key,
      status: 'loaded', value: '**Full** reasoning detail', sizeBytes: 1200 });
  });
  await flushMarkdown();
  assert.equal(host.querySelector('.reasoning-scroll strong')?.textContent, 'Full');
  const menus: string[] = [];
  mount({ onContextMenu: (_event, text) => { menus.push(text); } });
  act(() => { header().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
  assert.deepEqual(menus, ['**Full** reasoning detail']);
});

test('right-clicking inline markdown supplies the complete current display text', () => {
  const menus: string[] = [];
  mount({ onContextMenu: (_event, text) => { menus.push(text); } });
  const body = host.querySelector('.reasoning-inline .reasoning-scroll strong');
  assert.ok(body);
  act(() => { body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
  assert.deepEqual(menus, [props.text]);
});
