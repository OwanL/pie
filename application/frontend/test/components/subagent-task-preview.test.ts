import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { beforeEach, afterEach } from 'node:test';

import { installDom } from '../helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { SubagentTaskPreview } from '../../transcript/subagent-task-preview';

const task = '  Inspect `raw code` exactly.\n\nKeep paragraphs.\n' + 'Long prompt line.\n'.repeat(100);
let container: HTMLDivElement;
let pending: Array<{ id: number; fn: () => void }>;
let nextId: number;
let originalSetTimeout: typeof globalThis.setTimeout;
let originalClearTimeout: typeof globalThis.clearTimeout;
let parentClicks: number;
let parentKeys: number;

beforeEach(() => {
  pending = [];
  nextId = 1;
  parentClicks = parentKeys = 0;
  originalSetTimeout = globalThis.setTimeout;
  originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = window.setTimeout = ((fn: () => void) => {
    const id = nextId++;
    pending.push({ id, fn });
    return id;
  }) as typeof globalThis.setTimeout;
  globalThis.clearTimeout = window.clearTimeout = ((id: number) => {
    pending = pending.filter((timer) => timer.id !== id);
  }) as typeof globalThis.clearTimeout;
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => render(h('div', {
    onClick: () => { parentClicks++; },
    onKeyDown: () => { parentKeys++; },
  }, h(SubagentTaskPreview, { task, agent: 'scout' })), container));
});

afterEach(() => {
  act(() => render(null, container));
  container.remove();
  globalThis.setTimeout = window.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = window.clearTimeout = originalClearTimeout;
});

const trigger = () => container.querySelector('.subagent-task') as HTMLElement;
const wrapper = () => container.querySelector('.subagent-task-trigger') as HTMLElement;
const host = () => document.querySelector('.pie-tooltip-host') as HTMLElement;
async function flush() {
  await act(async () => {
    const timers = pending;
    pending = [];
    timers.forEach(({ fn }) => fn());
  });
}
function dispatch(target: EventTarget, event: Event): void {
  act(() => { target.dispatchEvent(event); });
}
async function open() {
  dispatch(wrapper(), new MouseEvent('mouseenter'));
  await flush();
}

test('shows the complete unedited prompt in a labelled rich region and cleans up', async () => {
  assert.equal(trigger().textContent, task);
  assert.equal(trigger().tabIndex, 0);
  assert.equal(trigger().getAttribute('aria-label'), 'Task for scout');
  assert.ok(container.querySelector('button') === null);
  await open();
  assert.equal(host().getAttribute('role'), 'region');
  assert.equal(host().getAttribute('aria-label'), 'Task for scout');
  const popover = host().querySelector('.subagent-task-popover')!;
  assert.ok(popover, 'the entire popup, including its caption, owns the height budget');
  assert.equal(popover.querySelector('.subagent-task-popover-heading')?.textContent, 'Delegated prompt · scout');
  assert.equal(popover.querySelector('.subagent-task-tooltip')?.textContent, task);
  assert.equal(popover.querySelectorAll('[tabindex]').length, 1, 'only the raw text is a keyboard scroll surface');
  assert.ok(host().style.getPropertyValue('--pie-tooltip-available-height'));
  act(() => render(null, container));
  assert.ok(document.querySelector('.pie-tooltip-host') === null);
  await flush();
  assert.ok(document.querySelector('.pie-tooltip-host') === null);
});

test('focus opens, Tab enters the scroll surface, and Escape returns to the excerpt', async () => {
  act(() => trigger().focus());
  await flush();
  const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  dispatch(trigger(), tab);
  const scrollRegion = host().querySelector('.subagent-task-tooltip') as HTMLElement;
  assert.equal(scrollRegion.tabIndex, 0);
  assert.ok(document.activeElement === scrollRegion);
  assert.equal(tab.defaultPrevented, true);
  const end = new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true });
  dispatch(scrollRegion, end);
  assert.equal(end.defaultPrevented, false, 'native scrolling keys remain available');
  dispatch(scrollRegion, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.ok(document.activeElement === trigger());
  assert.equal(host().style.display, 'none');
  await flush();
  assert.equal(host().style.display, 'none');
});

test('pointer bridge keeps the raw selectable surface open', async () => {
  await open();
  dispatch(wrapper(), new MouseEvent('mouseleave'));
  dispatch(host(), new MouseEvent('mouseenter'));
  await flush();
  assert.equal(host().style.display, 'block');
  const text = host().querySelector('.subagent-task-tooltip')!;
  const range = document.createRange();
  range.selectNodeContents(text);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  assert.equal(selection.toString(), task);
  dispatch(text, new MouseEvent('click', { bubbles: true }));
  assert.equal(parentClicks, 0);
  selection.removeAllRanges();
  dispatch(host(), new MouseEvent('mouseleave'));
  await flush();
  assert.equal(host().style.display, 'none');
});

test('task popup bounds its complete content and keeps one raw-text scroll owner', async () => {
  const css = await readFile(new URL('../../styles/tool-call.css', import.meta.url), 'utf8');
  const rule = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    assert.notEqual(start, -1, `missing ${selector}`);
    return css.slice(start, css.indexOf('}', start));
  };
  const outer = rule('.subagent-task-popover');
  assert.match(outer, /display:\s*flex;/);
  assert.match(outer, /flex-direction:\s*column;/);
  assert.match(outer, /max-height:[^;]*var\(--pie-tooltip-available-height/);
  assert.doesNotMatch(outer, /overflow:\s*(auto|scroll)/);
  const text = rule('.subagent-task-tooltip');
  assert.match(text, /min-height:\s*0;/);
  assert.match(text, /overflow:\s*auto;/);
  assert.match(text, /white-space:\s*pre-wrap;/);
  assert.match(text, /user-select:\s*text;/);
  assert.doesNotMatch(text, /--pie-tooltip-available-height/);
  const hostSkin = rule('.pie-tooltip-host:has(.subagent-task-popover)');
  assert.match(hostSkin, /width:\s*min\(420px, calc\(100vw - 16px\)\);/);
  assert.match(hostSkin, /box-sizing:\s*border-box;/);
  assert.match(hostSkin, /padding:\s*10px;/);
  assert.match(hostSkin, /box-shadow:\s*none;/);
});

test('click and keyboard activation dismiss without activating the parent card', async () => {
  await open();
  dispatch(trigger(), new MouseEvent('click', { bubbles: true }));
  assert.equal(host().style.display, 'none');
  assert.equal(parentClicks, 0);
  for (const key of ['Enter', ' ']) {
    await open();
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    dispatch(trigger(), event);
    assert.equal(host().style.display, 'none');
    assert.equal(event.defaultPrevented, true);
  }
  assert.equal(parentKeys, 0);
});
