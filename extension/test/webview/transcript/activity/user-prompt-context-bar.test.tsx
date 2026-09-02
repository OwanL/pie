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
  /** Measurement cache, indexed by virtual row index. */
  measurements: Array<{ start: number; end: number }>;
  metrics: ElementMetrics | null;
  /** virtualizer.scrollOffset fallback used while metrics are unavailable. */
  scrollOffset?: number | null;
  hidden?: boolean;
  scrollElement: HTMLDivElement | null;
  onLocate?: (rowIndex: number) => void;
}

function fakeVirtualizer(measurements: Array<{ start: number; end: number }>, scrollOffset: number | null) {
  return {
    measurementsCache: measurements,
    scrollOffset,
  } as unknown as Virtualizer<HTMLDivElement, HTMLDivElement>;
}

function renderBar(container: HTMLDivElement, options: RenderBarOptions): HTMLElement | null {
  const virtualizer = fakeVirtualizer(options.measurements, options.scrollOffset ?? null);
  act(() => {
    render(h(UserPromptContextBar, {
      entries: buildUserPromptEntries(options.rows),
      virtualizer,
      scrollRef: { current: options.scrollElement },
      hidden: options.hidden ?? false,
      onLocate: options.onLocate ?? (() => {}),
    }), container);
  });
  return container.querySelector('.transcript-prompt-context');
}

function previewButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button.transcript-prompt-context-preview');
  assert.ok(button, 'expected a preview button');
  return button;
}

test('same-range scrolling never duplicates a visible prompt and the preview locates it', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const metrics: ElementMetrics = { scrollTop: 50, scrollHeight: 700, clientHeight: 200 };
  const element = makeScrollElement(metrics);
  const measurements = [
    { start: 0, end: 40 },
    { start: 100, end: 300 },
    { start: 320, end: 350 },
  ];
  const rows: TranscriptRow[] = [
    messageRow(userMessage('prompt-1', 'first prompt')),
    messageRow(userMessage('assistant-1', '', { role: 'assistant' })),
    messageRow(userMessage('prompt-2', 'second prompt')),
  ];
  let locatedRow = -1;

  renderBar(container, {
    rows,
    measurements,
    metrics,
    scrollOffset: 50,
    scrollElement: element,
    onLocate: (rowIndex) => { locatedRow = rowIndex; },
  });
  let button = previewButton(container);
  assert.match(button.textContent ?? '', /first prompt/);
  assert.equal(button.getAttribute('aria-label'), null, 'the visible prompt remains the accessible button name');
  const actionDescription = document.getElementById(button.getAttribute('aria-describedby') ?? '');
  assert.match(actionDescription?.textContent ?? '', /Locate this user prompt in the transcript/);
  assert.equal(button.getAttribute('title'), 'Locate user prompt in transcript');
  assert.equal(container.querySelector('.transcript-prompt-context-locate'), null);

  // The second prompt is on screen, so keep showing its offscreen predecessor.
  act(() => {
    metrics.scrollTop = 330;
    element.dispatchEvent(new Event('scroll'));
  });
  assert.match(previewButton(container).textContent ?? '', /first prompt/);

  // Once the second prompt is fully above the viewport, it becomes the context.
  act(() => {
    metrics.scrollTop = 360;
    element.dispatchEvent(new Event('scroll'));
  });
  button = previewButton(container);
  assert.match(button.textContent ?? '', /second prompt/);

  act(() => {
    button.click();
  });
  assert.equal(locatedRow, 2);

  render(null, container);
  container.remove();
});

test('render-time selection changes stay synchronized with same-range scrolling', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const metrics: ElementMetrics = { scrollTop: 50, scrollHeight: 600, clientHeight: 200 };
  const element = makeScrollElement(metrics);
  const rows = [
    messageRow(userMessage('prompt-1', 'first prompt')),
    messageRow(userMessage('prompt-2', 'second prompt')),
  ];

  renderBar(container, {
    rows,
    measurements: [{ start: 0, end: 40 }, { start: 60, end: 200 }],
    metrics,
    scrollElement: element,
  });
  assert.match(previewButton(container).textContent ?? '', /first prompt/);

  // Prime the scroll listener's identity, then simulate a measurement update
  // that changes the render-time owner without requiring a scroll event.
  act(() => {
    element.dispatchEvent(new Event('scroll'));
  });
  metrics.scrollTop = 100;
  renderBar(container, {
    rows,
    measurements: [{ start: 0, end: 40 }, { start: 60, end: 80 }],
    metrics,
    scrollElement: element,
  });
  assert.match(previewButton(container).textContent ?? '', /second prompt/);

  // Returning to the first prompt inside the same virtual range must rerender;
  // a stale listener baseline would incorrectly leave the second prompt shown.
  act(() => {
    metrics.scrollTop = 50;
    element.dispatchEvent(new Event('scroll'));
  });
  assert.match(previewButton(container).textContent ?? '', /first prompt/);

  render(null, container);
  container.remove();
});

test('the latest visible prompt does not replace its predecessor at the bottom boundary', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const metrics: ElementMetrics = { scrollTop: 400, scrollHeight: 600, clientHeight: 200 };

  renderBar(container, {
    rows: [
      messageRow(userMessage('prompt-1', 'preceding prompt')),
      messageRow(userMessage('assistant-1', '', { role: 'assistant' })),
      messageRow(userMessage('prompt-2', 'latest visible prompt')),
    ],
    measurements: [
      { start: 0, end: 40 },
      { start: 50, end: 370 },
      { start: 380, end: 520 },
    ],
    metrics,
    scrollElement: makeScrollElement(metrics),
  });

  const button = previewButton(container);
  assert.match(button.textContent ?? '', /preceding prompt/);
  assert.doesNotMatch(button.textContent ?? '', /latest visible prompt/);

  render(null, container);
  container.remove();
});

test('the section stays hidden while the first prompt is on screen', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const metrics: ElementMetrics = { scrollTop: 20, scrollHeight: 600, clientHeight: 200 };

  const section = renderBar(container, {
    rows: [messageRow(userMessage('prompt-1', 'visible prompt'))],
    measurements: [{ start: 0, end: 40 }],
    metrics,
    scrollElement: makeScrollElement(metrics),
  });
  assert.equal(section, null);

  render(null, container);
  container.remove();
});

test('empty sessions render no bar', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const metrics: ElementMetrics = { scrollTop: 0, scrollHeight: 600, clientHeight: 200 };

  const section = renderBar(container, {
    rows: [],
    measurements: [],
    metrics,
    scrollOffset: 0,
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
    measurements: [{ start: 0, end: 180 }, { start: 200, end: 240 }],
    metrics,
    scrollOffset: 0,
    scrollElement: makeScrollElement(metrics),
  });
  assert.equal(idle, null, 'no prompt governs a window whose prompt is still below the boundary');

  const detached = renderBar(container, {
    rows,
    measurements: [{ start: 0, end: 180 }, { start: 200, end: 240 }],
    metrics: null,
    scrollOffset: null,
    scrollElement: null,
  });
  assert.equal(detached, null, 'no owner and no fallback signal still renders nothing');

  render(null, container);
  container.remove();
});

test('initial positioning keeps the bar reserved but hidden while a prompt exists', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const metrics: ElementMetrics = { scrollTop: 50, scrollHeight: 600, clientHeight: 200 };

  const bar = renderBar(container, {
    rows: [messageRow(userMessage('prompt-1', 'js prompt'))],
    measurements: [{ start: 0, end: 40 }],
    metrics,
    scrollOffset: 50,
    hidden: true,
    scrollElement: makeScrollElement(metrics),
  });
  assert.ok(bar, 'positioning with a selected prompt reserves the bar');
  assert.ok(bar.classList.contains('is-hidden'));
  assert.equal(bar.getAttribute('aria-hidden'), 'true');
  assert.equal(bar.querySelector('.transcript-header-label'), null, 'the user-style bubble needs no redundant heading');

  const emptyHidden = renderBar(container, {
    rows: [],
    measurements: [],
    metrics,
    hidden: true,
    scrollElement: makeScrollElement(metrics),
  });
  assert.equal(emptyHidden, null, 'positioning without a prompt must not reserve the bar');

  render(null, container);
  container.remove();
});

test('short prompts compact the original row while long prompts keep its full height', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const metrics: ElementMetrics = { scrollTop: 50, scrollHeight: 600, clientHeight: 200 };
  const element = makeScrollElement(metrics);
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  const originalScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');

  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return this.classList.contains('transcript-prompt-context-row') ? 400 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get() {
      if (this.classList.contains('transcript-prompt-context-preview')) {
        return (this.textContent?.length ?? 0) * 8 + 16;
      }
      return 0;
    },
  });

  try {
    const shortBar = renderBar(container, {
      rows: [messageRow(userMessage('short', 'continue'))],
      measurements: [{ start: 0, end: 40 }],
      metrics,
      scrollElement: element,
    });
    assert.ok(shortBar?.classList.contains('is-compact'));

    const longBar = renderBar(container, {
      rows: [messageRow(userMessage('long', 'A prompt long enough to occupy well over half of the available context row width.'))],
      measurements: [{ start: 0, end: 40 }],
      metrics,
      scrollElement: element,
    });
    assert.equal(longBar?.classList.contains('is-compact'), false);
  } finally {
    if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
    else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
    if (originalScrollWidth) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', originalScrollWidth);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollWidth');
    render(null, container);
    container.remove();
  }
});