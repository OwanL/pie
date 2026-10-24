import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../helpers/dom';
installDom();

import DOMPurify from 'dompurify';
DOMPurify.sanitize = ((html: string) => html) as typeof DOMPurify.sanitize;

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { SystemPromptMessage } from '../../context-inspector/system-prompts';
import type { SystemPromptEntry } from '../../../lib/protocol/index.js';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => {
  act(() => render(null, container));
  container.remove();
});

function prompt(overrides: Partial<SystemPromptEntry> = {}): SystemPromptEntry {
  return { source: 'user', title: 'User instructions', text: '**Prompt body** with `src/example.ts`.', summary: 'Follow the instructions', availability: 'available', ...overrides };
}
function mount(prompts: SystemPromptEntry[]): void {
  act(() => render(h(SystemPromptMessage, { prompts }), container));
}
function button(selector: string): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(selector);
  assert.ok(el, selector);
  return el;
}
function click(el: HTMLButtonElement): void {
  act(() => el.click());
}
function finishClose(selector: string): void {
  const wrap = container.querySelector(selector);
  assert.ok(wrap);
  act(() => { wrap.dispatchEvent(new Event('transitionend', { bubbles: true })); });
}

const groupSelector = '.system-prompts > .collapsible-header';
const cardSelector = '.system-prompt-card > .collapsible-header';

test('group and cards disclose manually, with lazy markdown and no close footers', () => {
  mount([prompt()]);
  const group = button(groupSelector);
  assert.equal(group.getAttribute('aria-expanded'), 'false');
  assert.equal(group.getAttribute('aria-controls'), null);
  assert.equal(container.querySelector('.system-prompt-card'), null);
  click(group);
  const card = button(cardSelector);
  assert.equal(group.getAttribute('aria-expanded'), 'true');
  assert.equal(card.getAttribute('aria-expanded'), 'false');
  assert.equal(container.querySelector('.message-body'), null);
  assert.ok(container.querySelector('.system-prompt-summary'));
  click(card);
  assert.equal(card.getAttribute('aria-expanded'), 'true');
  assert.ok(container.querySelector('.message-body strong'));
  assert.equal(container.querySelector('.file-path-link'), null, 'prompt paths remain noninteractive');
  assert.equal(container.querySelector('.system-prompt-card .system-prompt-summary')?.textContent, 'Follow the instructions', 'expanded card retains its header summary');
  assert.equal(container.querySelector('.collapsible-close-footer'), null);
  assert.equal(container.querySelectorAll('.collapsible-gutter').length, 2);
  click(card);
  finishClose('.system-prompt-card > .collapsible-body-wrap');
  assert.equal(container.querySelector('.message-body'), null);
  assert.equal(group.getAttribute('aria-expanded'), 'true', 'card close does not toggle group');
  click(group);
  finishClose('.system-prompts > .collapsible-body-wrap');
  assert.equal(container.querySelector('.system-prompt-card'), null);
});

test('enabled count and token metadata remain explicit and accessible; disabled prompts stay hidden', () => {
  mount([
    prompt({ text: 'abcde' }),
    prompt({ source: 'provider', title: 'Provider prompt', availability: 'unknown', text: 'x'.repeat(400), summary: 'Unknown' }),
    prompt({ title: 'Disabled prompt', disabled: true, text: 'x'.repeat(400) }),
  ]);
  const group = button(groupSelector);
  assert.equal(container.querySelector('.system-prompts-label')?.textContent, 'System prompts');
  assert.equal(container.querySelector('.system-prompts-meta')?.textContent, '2 entries');
  assert.match(group.getAttribute('aria-label')!, /2 system prompts, 2 tokens/);
  const tokens = container.querySelector('.system-prompts-tokens');
  assert.equal(tokens?.textContent, '2 tokens');
  assert.match(tokens?.getAttribute('title') ?? '', /not included/i);
  click(group);
  assert.equal(container.querySelectorAll('.system-prompt-card').length, 2);
  assert.ok(!container.textContent?.includes('Disabled prompt'));
});

test('provider placeholders are suppressed but resolved provider summaries remain on cards only', () => {
  const provider = prompt({ source: 'provider', title: 'Provider prompt', availability: 'unknown', summary: 'Unavailable', text: 'Unknown' });
  mount([provider]);
  assert.equal(container.querySelector('.system-prompt-summary'), null);
  assert.equal(container.querySelector('.system-prompts-tokens'), null);
  click(button(groupSelector));
  assert.equal(container.querySelector('.system-prompt-summary'), null);
  mount([{ ...provider, summary: 'Resolved provider name' }]);
  assert.equal(container.querySelector('.system-prompt-card .system-prompt-summary')?.textContent, 'Resolved provider name');
  click(button(groupSelector));
  finishClose('.system-prompts > .collapsible-body-wrap');
  assert.equal(container.querySelector('.system-prompt-summary'), null, 'provider stays out of group preview');
});

test('group keeps one clear label until expanded; card title leads its accessible summary', () => {
  const title = 'Long primary prompt title '.repeat(12);
  const summary = 'Secondary summary '.repeat(20);
  mount([prompt({ title, summary })]);
  const group = button(groupSelector);
  assert.equal(container.querySelector('.system-prompts-label')?.textContent, 'System prompts');
  assert.equal(container.querySelector('.system-prompts-meta')?.textContent, '1 entry');
  assert.equal(container.querySelector('.system-prompt-summary'), null, 'collapsed group has no competing prompt-title preview');

  click(group);
  const titleEl = container.querySelector('.system-prompt-title');
  const summaryEl = container.querySelector('.system-prompt-card .system-prompt-summary');
  assert.equal(titleEl?.textContent, title);
  assert.equal(titleEl?.getAttribute('title'), title);
  assert.equal(summaryEl?.textContent, summary);
  assert.ok(titleEl!.compareDocumentPosition(summaryEl!) & Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(button(cardSelector).getAttribute('aria-label'), `Toggle system prompt: ${title}`);
});

test('headers and side close targets retain native keyboard-focusable button semantics and body wiring', () => {
  mount([prompt()]);
  const group = button(groupSelector);
  group.focus();
  assert.ok(document.activeElement === group);
  assert.equal(group.tagName, 'BUTTON');
  assert.equal(group.type, 'button');
  assert.equal(group.tabIndex, 0);
  click(group); // Native activation; happy-dom does not synthesize Enter/Space clicks.
  const card = button(cardSelector);
  card.focus();
  assert.ok(document.activeElement === card);
  assert.equal(card.type, 'button');
  assert.equal(card.tabIndex, 0);
  click(card);
  for (const header of [group, card]) {
    const id = header.getAttribute('aria-controls');
    assert.ok(id);
    assert.ok(container.querySelector(`[id="${id}"]`));
  }
  const gutter = button('.system-prompt-card .collapsible-gutter');
  gutter.focus();
  assert.ok(document.activeElement === gutter);
  assert.equal(gutter.type, 'button');
  assert.equal(gutter.tabIndex, 0);
  click(gutter);
  assert.equal(card.getAttribute('aria-expanded'), 'false');
  assert.equal(group.getAttribute('aria-expanded'), 'true');
});

test('visibility changes preserve a stable group disclosure lifecycle', () => {
  mount([]);
  assert.equal(container.childElementCount, 0);
  mount([prompt()]);
  assert.equal(button(groupSelector).getAttribute('aria-expanded'), 'false');
  click(button(groupSelector));
  mount([prompt({ disabled: true })]);
  assert.equal(container.childElementCount, 0);
  mount([prompt()]);
  assert.equal(button(groupSelector).getAttribute('aria-expanded'), 'true');
  assert.ok(container.querySelector('.system-prompt-card'));
});

test('empty and entirely disabled prompt lists render nothing', () => {
  mount([]);
  assert.equal(container.childElementCount, 0);
  mount([prompt({ disabled: true })]);
  assert.equal(container.childElementCount, 0);
});
