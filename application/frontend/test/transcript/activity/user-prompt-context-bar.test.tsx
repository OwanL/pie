import assert from 'node:assert/strict';
import test from 'node:test';

import { installDom } from '../../helpers/dom';
installDom();

import type { Virtualizer } from '@tanstack/virtual-core';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { AGENT_MESSAGE_CUSTOM_TYPE, type ChatMessage } from '../../../../lib/protocol/index.js';
import { createSessionControlSender } from '../../../../../harness/agent-processes/lib/rpc/session-control-attribution.js';
import { UserPromptContextBar } from '../../../transcript/user-prompt-context-bar';
import { buildUserPromptEntries } from '../../../transcript/user-prompt-context';
import type { TranscriptRow } from '../../../transcript/virtual-list-rows';

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

test('sequential navigation follows target starts while preview remains offscreen-only', () => {
  const container = document.createElement('div');
  const metrics = { scrollTop: 0, scrollHeight: 700, clientHeight: 100 };
  const element = makeScrollElement(metrics);
  element.style.paddingTop = '6px';
  const rows = [
    messageRow(userMessage('first', 'first')),
    messageRow(userMessage('assistant', '', { role: 'assistant' })),
    messageRow(userMessage('image', '', { userParts: [{ kind: 'image', dataBase64: 'abc', mimeType: 'image/png' }] })),
    messageRow(userMessage('queued', 'queued', { status: 'queued' })),
  ];
  const located: number[] = [];
  const button = (name: string) => {
    const result = container.querySelector<HTMLButtonElement>(`button[aria-label="${name} prompt"]`);
    assert.ok(result);
    assert.equal(result.title, `${name} prompt`);
    return result;
  };
  renderBar(container, {
    rows, metrics, scrollElement: element,
    measurements: [{ start: 0, end: 40 }, { start: 50, end: 90 }, { start: 100, end: 140 }, { start: 200, end: 240 }],
    onLocate: (index) => {
      located.push(index);
      metrics.scrollTop = [0, 50, 100, 200][index]!;
      element.dispatchEvent(new Event('scroll'));
    },
  });
  assert.equal(button('Previous').disabled, true);
  assert.equal(button('Next').disabled, false);
  assert.equal(container.querySelector('.transcript-prompt-context-preview'), null, 'first visible prompt is not duplicated');
  assert.equal(container.querySelector('.transcript-prompt-navigation-position')?.textContent?.trim(), '1 / 3');
  act(() => button('Next').click());
  assert.deepEqual(located, [2]);
  assert.equal(previewButton(container).textContent, 'first');
  assert.equal(container.querySelector('.transcript-prompt-navigation-position')?.getAttribute('aria-label'), 'Prompt 2 of 3');
  act(() => button('Next').click());
  assert.deepEqual(located, [2, 3]);
  assert.equal(previewButton(container).textContent, '(1 image)', 'queued target is still visible');
  assert.equal(button('Next').disabled, true);
  assert.equal(button('Previous').disabled, false);
  assert.equal(container.querySelector('.transcript-prompt-navigation-position')?.textContent?.trim(), '3 / 3');
  act(() => button('Previous').click());
  assert.equal(previewButton(container).textContent, 'first');
  act(() => button('Previous').click());
  assert.deepEqual(located, [2, 3, 2, 0]);
  assert.equal(button('Previous').disabled, true, 'loaded beginning bound');
  assert.equal(container.querySelector('.transcript-prompt-context-preview'), null);
  render(null, container);
});

test('sticky context identifies agent notes, results, and assignments instead of calling them auto-resume', () => {
  const cases = [
    {
      id: 'note', kind: 'note',
      sender: createSessionControlSender({ sessionId: 'sender-note', identityFallback: false }, 'Note sender'),
      details: { kind: 'note' },
    },
    {
      id: 'result', kind: 'result',
      sender: createSessionControlSender({ sessionId: 'sender-result', identityFallback: false }, 'Result sender'),
      details: { kind: 'result' },
    },
    {
      id: 'task', kind: 'Task',
      sender: createSessionControlSender({ sessionId: 'sender-task', identityFallback: false }, 'Task sender', {
        sentAt: 1, expectReply: false, kind: 'assignment', taskId: 'task-1', taskRevision: 2,
      }),
      details: undefined,
    },
  ] as const;

  for (const entry of cases) {
    const container = document.createElement('div');
    renderBar(container, {
      rows: [
        messageRow(userMessage(entry.id, 'agent content', {
          customType: AGENT_MESSAGE_CUSTOM_TYPE, sender: entry.sender, customDetails: entry.details,
        })),
        messageRow(userMessage('next', 'next prompt')),
      ],
      measurements: [{ start: 0, end: 40 }, { start: 100, end: 140 }],
      metrics: { scrollTop: 50, scrollHeight: 300, clientHeight: 100 },
      scrollElement: makeScrollElement({ scrollTop: 50, scrollHeight: 300, clientHeight: 100 }),
    });
    const metadata = container.querySelector<HTMLElement>('.transcript-prompt-context-meta');
    assert.ok(metadata, `${entry.kind} agent message should render sticky metadata`);
    assert.match(metadata.textContent ?? '', /Agent/u);
    assert.match(metadata.textContent ?? '', new RegExp(entry.sender.title!, 'u'));
    assert.match(metadata.textContent ?? '', new RegExp(entry.kind, 'iu'));
    assert.match(metadata.innerHTML, /session-tab-agent-icon/u);
    assert.doesNotMatch(metadata.textContent ?? '', /Auto-resume/u);
    if (entry.id === 'task') {
      assert.equal(metadata.querySelector('[title]')?.getAttribute('title'), 'Task assignment · revision 2');
    }
    render(null, container);
  }
});

test('sticky context keeps the Auto-resume label for real host auto-resume prompts', () => {
  const container = document.createElement('div');
  renderBar(container, {
    rows: [
      messageRow(userMessage('resume', 'continue the turn', { customType: 'auto-resume' })),
      messageRow(userMessage('next', 'next prompt')),
    ],
    measurements: [{ start: 0, end: 40 }, { start: 100, end: 140 }],
    metrics: { scrollTop: 50, scrollHeight: 300, clientHeight: 100 },
    scrollElement: makeScrollElement({ scrollTop: 50, scrollHeight: 300, clientHeight: 100 }),
  });
  const metadata = container.querySelector<HTMLElement>('.transcript-prompt-context-meta');
  assert.ok(metadata);
  assert.match(metadata.textContent ?? '', /Auto-resume/u);
  assert.doesNotMatch(metadata.textContent ?? '', /Agent|Note|Result|Task/u);
  render(null, container);
});

for (const clientHeight of [100, 400]) {
  test(`clamped navigation retains requested identity with viewport height ${clientHeight}`, () => {
    const container = document.createElement('div');
    const metrics = { scrollTop: 0, scrollHeight: 300, clientHeight };
    const element = makeScrollElement(metrics);
    const viewport = document.createElement('div');
    viewport.className = 'transcript-viewport';
    viewport.append(element);
    const rail = document.createElement('button');
    viewport.append(rail);
    const rows = ['first', 'second', 'last'].map((id) => messageRow(userMessage(id, id)));
    const measurements = [{ start: 0, end: 40 }, { start: 100, end: 140 }, { start: 250, end: 290 }];
    const located: number[] = [];
    const options = {
      rows, measurements, metrics, scrollElement: element,
      onLocate: (index: number) => {
        located.push(index);
        metrics.scrollTop = Math.max(0, Math.min(measurements[index]!.start, metrics.scrollHeight - clientHeight));
        element.dispatchEvent(new Event('scroll'));
      },
    };
    renderBar(container, options);
    const button = (direction: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${direction} prompt"]`)!;
    const position = () => container.querySelector('.transcript-prompt-navigation-position')?.textContent?.trim();
    const click = (direction: string) => act(() => button(direction).click());
    click('Next');
    assert.equal(position(), '2 / 3');
    click('Next');
    assert.equal(position(), '3 / 3');
    click('Next');
    assert.deepEqual(located, [1, 2], 'ending bound does not repeat the clamped target');
    if (clientHeight === 400) assert.equal(container.querySelector('.transcript-prompt-context-preview'), null);
    else assert.equal(previewButton(container).textContent, 'second', 'preview remains metrics based');
    click('Previous');
    click('Previous');
    click('Previous');
    assert.deepEqual(located, [1, 2, 1, 0], 'beginning bound');
    assert.equal(position(), '1 / 3');

    for (const event of [new Event('wheel'), new Event('touchstart'), new Event('pointerdown'), new KeyboardEvent('keydown', { key: 'PageDown' })]) {
      click('Next');
      click('Next');
      assert.equal(position(), '3 / 3');
      act(() => { rail.dispatchEvent(event); });
      assert.equal(position(), clientHeight === 400 ? '1 / 3' : '2 / 3', 'manual viewport input clears cursor');
      act(() => {
        metrics.scrollTop = 0;
        element.dispatchEvent(new Event('scroll'));
      });
      assert.equal(position(), '1 / 3', 'subsequent manual scroll follows metrics');
    }
    click('Next');
    click('Next');
    renderBar(container, { ...options, rows: rows.slice(0, 2) });
    assert.equal(position(), clientHeight === 400 ? '1 / 2' : '2 / 2', 'removed identity invalidates cursor');
    render(null, container);
  });
}

test('Enter clears the prompt cursor only for viewport activations, including the rail', () => {
  const container = document.createElement('div');
  const metrics: ElementMetrics = { scrollTop: 0, scrollHeight: 400, clientHeight: 100 };
  const element = makeScrollElement(metrics);
  const viewport = document.createElement('div');
  viewport.className = 'transcript-viewport';
  viewport.append(element, container);
  const latest = document.createElement('button');
  const rail = document.createElement('button');
  const input = document.createElement('input');
  viewport.append(latest, rail, input);
  const rows = ['first', 'second', 'last'].map((id) => messageRow(userMessage(id, id)));
  const measurements = [{ start: 0, end: 40 }, { start: 100, end: 140 }, { start: 250, end: 290 }];
  renderBar(container, { rows, measurements, metrics, scrollElement: element });
  const navigateToLast = () => {
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Next prompt"]')!.click());
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Next prompt"]')!.click());
    assert.equal(container.querySelector('.transcript-prompt-navigation-position')?.textContent?.trim(), '3 / 3');
  };
  const position = () => container.querySelector('.transcript-prompt-navigation-position')?.textContent?.trim();
  const enter = (target: HTMLElement) => act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });

  navigateToLast();
  metrics.scrollTop = 0;
  enter(input);
  assert.equal(position(), '3 / 3', 'typing Enter does not discard the explicit prompt target');

  enter(latest);
  assert.equal(position(), '1 / 3', 'Enter activation of Jump to latest clears the explicit target');

  navigateToLast();
  metrics.scrollTop = 0;
  enter(rail);
  assert.equal(position(), '1 / 3', 'Enter activation of a rail marker clears the explicit target');

  render(null, container);
  container.remove();
});

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
  assert.equal(container.querySelector('.transcript-prompt-navigation-position')?.textContent?.trim(), '2 / 2', 'same-range navigation changes even with unchanged context');
  assert.equal(container.querySelector<HTMLButtonElement>('button[aria-label="Next prompt"]')?.disabled, true);

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
  assert.equal(bar.querySelectorAll('button').length, 3);
  for (const button of bar.querySelectorAll('button')) assert.equal(button.disabled, true);
  assert.equal(bar.querySelector('.transcript-header-label'), null, 'the user-style bubble needs no redundant heading');

  metrics.scrollTop = 0;
  const navigationOnlyHidden = renderBar(container, {
    rows: [messageRow(userMessage('first', 'first')), messageRow(userMessage('second', 'second'))],
    measurements: [{ start: 0, end: 40 }, { start: 100, end: 140 }],
    metrics,
    hidden: true,
    scrollElement: makeScrollElement(metrics),
  });
  assert.ok(navigationOnlyHidden, 'navigation controls reserve the hidden bar');
  assert.ok(navigationOnlyHidden.classList.contains('is-hidden'));
  assert.equal(navigationOnlyHidden.querySelector('.transcript-prompt-context-preview'), null);
  assert.equal(navigationOnlyHidden.querySelectorAll('button').length, 2);
  for (const button of navigationOnlyHidden.querySelectorAll('button')) assert.equal(button.disabled, true);

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
      if (this.classList.contains('transcript-prompt-navigation')) return 100;
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

    const controlsBar = renderBar(container, {
      rows: [messageRow(userMessage('medium', 'A medium prompt'))],
      measurements: [{ start: 0, end: 40 }],
      metrics,
      scrollElement: element,
    });
    assert.equal(controlsBar?.classList.contains('is-compact'), false, 'navigation width counts toward compact threshold');

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
