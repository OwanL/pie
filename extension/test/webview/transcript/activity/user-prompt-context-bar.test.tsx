import assert from 'node:assert/strict';
import test from 'node:test';

import { installDom } from '../../../_helpers/dom';
installDom();

import type { Virtualizer } from '@tanstack/virtual-core';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import type { ChatMessage } from '../../../../src/shared/protocol';
import { UserPromptContextBar } from '../../../../src/webview/panel/transcript/user-prompt-context-bar';
import { buildUserPromptEntries } from '../../../../src/webview/panel/transcript/user-prompt-context';
import type { TranscriptRow } from '../../../../src/webview/panel/transcript/virtual-list-rows';

function userMessage(
  id: string,
  markdown = '',
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    role: 'user',
    createdAt: '2026-05-16T00:00:00.000Z',
    markdown,
    status: 'completed',
    ...extra,
  } as ChatMessage;
}

function messageRow(message: ChatMessage): Extract<TranscriptRow, { kind: 'message' }> {
  return { kind: 'message', key: `message:${message.id}`, message };
}

interface ElementMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** A happy-dom div whose scroll metrics the test drives directly. */
function makeScrollElement(metrics: ElementMetrics): HTMLDivElement {
  const element = document.createElement('div');
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => metrics.scrollTop,
  });
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    get: () => metrics.scrollHeight,
  });
  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    get: () => metrics.clientHeight,
  });
  return element;
}

interface RenderBarOptions {
  rows: readonly TranscriptRow[];
  /** Measurement-cache starts, indexed by virtual row index. */
  starts: Array<{ start: number }>;
  metrics: ElementMetrics | null;
  /** virtualizer.scrollOffset fallback used while metrics are unavailable. */
  scrollOffset?: number | null;
  isAtBottom?: boolean;
  hidden?: boolean;
  scrollElement: HTMLDivElement | null;
}

function fakeVirtualizer(starts: Array<{ start: number }>, scrollOffset: number | null) {
  return {
    measurementsCache: starts,
    scrollOffset,
  } as unknown as Virtualizer<HTMLDivElement, HTMLDivElement>;
}

function renderBar(container: HTMLDivElement, options: RenderBarOptions): HTMLElement | null {
  const virtualizer = fakeVirtualizer(options.starts, options.scrollOffset ?? null);
  act(() => {
    render(h(UserPromptContextBar, {
      entries: buildUserPromptEntries(options.rows),
      virtualizer,
      scrollRef: { current: options.scrollElement },
      isAtBottom: options.isAtBottom ?? false,
      hidden: options.hidden ?? false,
      onLocate: () => {},
    }), container);
  });
  return container.querySelector('.transcript-prompt-context');
}

function previewButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button.transcript-prompt-context-preview');
  assert.ok(button, 'expected a preview button');
  return button;
}

test('same-virtual-range scroll events switch the governing prompt', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const metrics: ElementMetrics = { scrollTop: 50, scrollHeight: 600, clientHeight: 200 };
  const element = makeScrollElement(metrics);
  const starts = [{ start: 0 }, { start: 100 }, { start: 320 }];
  const rows: TranscriptRow[] = [
    messageRow(userMessage('prompt-1', 'first prompt')),
    messageRow(userMessage('assistant-1', '', { role: 'assistant' })),
    messageRow(userMessage('prompt-2', 'second prompt')),
  ];

  renderBar(container, { rows, starts, metrics, scrollOffset: 50, scrollElement: element });
  let button = previewButton(container);
  assert.match(button.textContent ?? '', /first prompt/);
  assert.equal(button.getAttribute('aria-label'), 'Expand user prompt');

  // Cross the boundary while the virtual range stays identical: entries,
  // measurement starts, virtualizer offset, and isAtBottom are all unchanged.
  // Only the bar's own element-level scroll listener can see this.
  act(() => {
    metrics.scrollTop = 330;
    element.dispatchEvent(new Event('scroll'));
  });

  button = previewButton(container);
  assert.match(button.textContent ?? '', /second prompt/);
  assert.doesNotMatch(button.textContent ?? '', /first prompt/);

  // The toggle keeps the concise action label; no prompt text is embedded.
  act(() => {
    button.click();
  });
  assert.equal(previewButton(container).getAttribute('aria-label'), 'Collapse user prompt');

  // Further same-identity scrolls must not disturb the selection.
  act(() => {
    metrics.scrollTop = 340;
    element.dispatchEvent(new Event('scroll'));
  });
  assert.match(previewButton(container).textContent ?? '', /second prompt/);

  render(null, container);
  container.remove();
});

test('near-bottom scroll events promote the latest prompt immediately from element metrics', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const metrics: ElementMetrics = { scrollTop: 50, scrollHeight: 600, clientHeight: 200 };
  const element = makeScrollElement(metrics);
  // The latest prompt's start is far below the maximum reachable top-edge
  // boundary (maxScroll 400 + threshold 10 = 410 < 580), so only the metric
  // near-bottom check can promote it.
  const starts = [{ start: 0 }, { start: 50 }, { start: 580 }];
  const rows: TranscriptRow[] = [
    messageRow(userMessage('prompt-1', 'earlier prompt')),
    messageRow(userMessage('assistant-1', '', { role: 'assistant' })),
    messageRow(userMessage('prompt-2', 'latest prompt')),
  ];

  renderBar(container, { rows, starts, metrics, scrollOffset: 50, scrollElement: element });
  assert.match(previewButton(container).textContent ?? '', /earlier prompt/);

  act(() => {
    metrics.scrollTop = 398;
    element.dispatchEvent(new Event('scroll'));
  });

  assert.match(previewButton(container).textContent ?? '', /latest prompt/);

  render(null, container);
  container.remove();
});

test('empty sessions render no bar', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const metrics: ElementMetrics = { scrollTop: 0, scrollHeight: 600, clientHeight: 200 };

  const section = renderBar(container, {
    rows: [],
    starts: [],
    metrics,
    scrollOffset: 0,
    isAtBottom: true,
    scrollElement: makeScrollElement(metrics),
  });
  assert.equal(section, null, 'an empty session must not reserve the bar');

  render(null, container);
  container.remove();
});

test('sessions with no preceding loaded prompt render no bar', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const metrics: ElementMetrics = { scrollTop: 0, scrollHeight: 600, clientHeight: 200 };
  const rows: TranscriptRow[] = [
    messageRow(userMessage('assistant-prelude', '', { role: 'assistant' })),
    messageRow(userMessage('prompt-2', 'unowned yet')),
  ];

  const idle = renderBar(container, {
    rows,
    starts: [{ start: 0 }, { start: 200 }],
    metrics,
    scrollOffset: 0,
    scrollElement: makeScrollElement(metrics),
  });
  assert.equal(idle, null, 'no prompt governs a window whose prompt is still below the boundary');

  const detached = renderBar(container, {
    rows,
    starts: [{ start: 0 }, { start: 200 }],
    metrics: null,
    scrollOffset: null,
    isAtBottom: false,
    scrollElement: null,
  });
  assert.equal(detached, null, 'no owner and no fallback signal still renders nothing');

  render(null, container);
  container.remove();
});

test('initial positioning keeps the bar reserved but hidden while a prompt exists', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const metrics: ElementMetrics = { scrollTop: 0, scrollHeight: 600, clientHeight: 200 };

  const bar = renderBar(container, {
    rows: [messageRow(userMessage('prompt-1', 'js prompt'))],
    starts: [{ start: 0 }],
    metrics,
    scrollOffset: 0,
    isAtBottom: false,
    hidden: true,
    scrollElement: makeScrollElement(metrics),
  });
  assert.ok(bar, 'positioning with a selected prompt reserves the bar');
  assert.ok(bar.classList.contains('is-hidden'));
  assert.equal(bar.getAttribute('aria-hidden'), 'true');

  const emptyHidden = renderBar(container, {
    rows: [],
    starts: [],
    metrics,
    hidden: true,
    isAtBottom: true,
    scrollElement: makeScrollElement(metrics),
  });
  assert.equal(emptyHidden, null, 'positioning without a prompt must not reserve the bar');

  render(null, container);
  container.remove();
});