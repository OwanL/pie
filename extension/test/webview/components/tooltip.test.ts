import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { installDom } from '../../_helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { Tooltip } from '../../../src/webview/panel/components/tooltip';

let container: HTMLDivElement;
let previousContainer: HTMLDivElement | null = null;

// Minimal fake-timer registry so the Tooltip show/hide delays (delayShow /
// delayHide) can be flushed deterministically instead of waiting out real
// 30 ms macrotasks.
interface PendingTimeout { fn: () => void; ms: number; id: number }
let pending: PendingTimeout[] = [];
let nextId = 1;
let originalSetTimeout: typeof globalThis.setTimeout;
let originalClearTimeout: typeof globalThis.clearTimeout;

function installFakeTimers() {
  originalSetTimeout = globalThis.setTimeout;
  originalClearTimeout = globalThis.clearTimeout;
  pending = [];
  nextId = 1;
  globalThis.setTimeout = window.setTimeout = ((fn: () => void, ms?: number) => {
    const id = nextId++;
    pending.push({ fn, ms: ms ?? 0, id });
    return id as unknown as number;
  }) as typeof globalThis.setTimeout;
  globalThis.clearTimeout = window.clearTimeout = ((id: number) => {
    pending = pending.filter((t) => t.id !== id);
  }) as typeof globalThis.clearTimeout;
}

function restoreTimers() {
  globalThis.setTimeout = window.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = window.clearTimeout = originalClearTimeout;
}

/** Flush every pending timer in registration order. */
function flushTimers() {
  const ready = pending;
  pending = [];
  for (const t of ready) t.fn();
}

beforeEach(() => {
  // node:test never invokes a function returned from beforeEach, so teardown
  // of the previous test's container and any leaked tooltip hosts must run
  // inline at the start of each hook — otherwise hosts accumulate in
  // document.body and pollute later tests' host() lookups.
  if (previousContainer) {
    render(null, previousContainer);
    previousContainer.remove();
  }
  Array.from(document.querySelectorAll('.pie-tooltip-host')).forEach((el) => el.remove());
  container = document.createElement('div');
  document.body.appendChild(container);
  previousContainer = container;
});

test('Tooltip renders trigger children and a hidden out-of-tree host', () => {
  act(() => {
    render(h(Tooltip, { content: 'Hello world' }, h('span', { class: 'trigger' }, 'target')), container);
  });

  const trigger = container.querySelector('.pie-tooltip-trigger');
  assert.ok(trigger, 'Trigger wrapper should render');
  assert.ok(trigger?.contains(container.querySelector('.trigger')), 'Tooltip should wrap the children');

  const host = document.querySelector('.pie-tooltip-host');
  assert.ok(host, 'Tooltip host should be appended to body');
  assert.equal(host.textContent, '');
  assert.equal((host as HTMLElement).style.display, 'none');
  assert.match(host.id, /^pie-tooltip-\d+$/);
});

test('Tooltip does not set a native title on the trigger', () => {
  act(() => {
    render(h(Tooltip, { content: 'Hello' }, h('span', null, 'x')), container);
  });

  const trigger = container.querySelector('.pie-tooltip-trigger');
  assert.equal(trigger?.getAttribute('title'), null);
});

test('triggerClassName is appended to the wrapper class when provided', () => {
  act(() => {
    render(h(Tooltip, { content: 'Hello', triggerClassName: 'strip-counts-trigger' }, h('span', null, 'x')), container);
  });

  const trigger = container.querySelector('.pie-tooltip-trigger');
  assert.equal(trigger?.className, 'pie-tooltip-trigger strip-counts-trigger');
});

test('triggerClassName omitted yields the bare wrapper class', () => {
  act(() => {
    render(h(Tooltip, { content: 'Hello' }, h('span', null, 'x')), container);
  });

  const trigger = container.querySelector('.pie-tooltip-trigger');
  assert.equal(trigger?.className, 'pie-tooltip-trigger');
});

test('Tooltip creates a distinct host for each instance', () => {
  const hostsBefore = document.querySelectorAll('.pie-tooltip-host').length;

  act(() => {
    render(
      h(
        'div',
        null,
        h(Tooltip, { content: 'A' }, h('span', null, 'a')),
        h(Tooltip, { content: 'B' }, h('span', null, 'b')),
      ),
      container,
    );
  });

  const hosts = Array.from(document.querySelectorAll('.pie-tooltip-host'));
  const newHosts = hosts.slice(hostsBefore);
  assert.ok(newHosts.length >= 2, 'Each tooltip should create its own host');
  const ids = new Set(newHosts.map((h) => h.id));
  assert.equal(ids.size, newHosts.length, 'Hosts should have unique ids');
});

test('freezeWhileVisible keeps the show-time text while content updates mid-hover', async () => {
  // A live indicator (e.g. tokens/sec) rebuilds its tooltip many times per
  // second. Without freezing the visible tooltip jumps on every rebuild;
  // freezeWhileVisible snapshots the text at show time and ignores further
  // updates until the pointer leaves and re-enters.
  const props = (content: string) => ({
    content,
    freezeWhileVisible: true,
    delayShow: 0,
    delayHide: 0,
  });

  installFakeTimers();
  try {
    act(() => {
      render(h(Tooltip, props('v1'), h('span', { class: 'trigger' }, 'target')), container);
    });
    const host = () => document.querySelector('.pie-tooltip-host') as HTMLElement;
    const trigger = () => container.querySelector('.pie-tooltip-trigger') as HTMLElement;

    // Show the tooltip (delayShow: 0 fires synchronously via flushTimers).
    await act(async () => {
      trigger().dispatchEvent(new MouseEvent('mouseenter'));
      flushTimers();
    });
    assert.equal(host().textContent, 'v1');

    // Live content updates while still hovering must NOT change the frozen text.
    await act(async () => {
      render(h(Tooltip, props('v2'), h('span', { class: 'trigger' }, 'target')), container);
    });
    assert.equal(host().textContent, 'v1', 'frozen tooltip should keep the show-time text');

    // Re-hovering (leave + re-enter) refreshes the snapshot. The leave and
    // re-enter are separate act() blocks so the hide flushes (clearing the
    // frozen snapshot) before the show re-snapshots — a single act would batch
    // the false->true transitions and skip the hide render.
    await act(async () => {
      trigger().dispatchEvent(new MouseEvent('mouseleave'));
      flushTimers();
    });
    await act(async () => {
      trigger().dispatchEvent(new MouseEvent('mouseenter'));
      flushTimers();
    });
    assert.equal(host().textContent, 'v2', 're-hover should refresh the snapshot');
  } finally {
    restoreTimers();
  }
});

test('without freezeWhileVisible the tooltip text follows live content updates', async () => {
  installFakeTimers();
  try {
    act(() => {
      render(h(Tooltip, { content: 'v1', delayShow: 0, delayHide: 0 }, h('span', { class: 'trigger' }, 'target')), container);
    });
    const host = () => document.querySelector('.pie-tooltip-host') as HTMLElement;
    const trigger = () => container.querySelector('.pie-tooltip-trigger') as HTMLElement;

    await act(async () => {
      trigger().dispatchEvent(new MouseEvent('mouseenter'));
      flushTimers();
    });
    assert.equal(host().textContent, 'v1');

    await act(async () => {
      render(h(Tooltip, { content: 'v2', delayShow: 0, delayHide: 0 }, h('span', { class: 'trigger' }, 'target')), container);
    });
    assert.equal(host().textContent, 'v2', 'non-frozen tooltip should follow live content');
  } finally {
    restoreTimers();
  }
});

test('scroll does not dismiss a tooltip whose trigger did not move (fixed container)', async () => {
  // Regression: the bottom status strip and composer toolbar sit in fixed
  // containers, so their triggers don't move when the transcript auto-scrolls
  // during a run. The tooltip must stay open instead of dismissing on every
  // scroll event (which fires ~continuously while content streams).
  installFakeTimers();
  try {
    act(() => {
      render(h(Tooltip, { content: 'stable', delayShow: 0, delayHide: 0 }, h('span', { class: 'trigger' }, 'target')), container);
    });
    const host = () => document.querySelector('.pie-tooltip-host') as HTMLElement;
    const trigger = () => container.querySelector('.pie-tooltip-trigger') as HTMLElement;

    // Pin a fixed layout rect that does not change across the scroll.
    Object.defineProperty(trigger(), 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 200, bottom: 220, left: 0, right: 40, width: 40, height: 20, x: 0, y: 200 }),
    });

    await act(async () => {
      trigger().dispatchEvent(new MouseEvent('mouseenter'));
      flushTimers();
    });
    assert.equal(host().style.display, 'block');

    // The transcript auto-scrolls; the trigger's rect is unchanged, so the
    // tooltip must survive the scroll instead of closing.
    await act(async () => {
      window.dispatchEvent(new Event('scroll'));
    });
    assert.equal(host().style.display, 'block', 'a tooltip whose trigger did not move should survive scroll');
  } finally {
    restoreTimers();
  }
});

test('scroll dismisses a tooltip whose trigger moved with the content', async () => {
  // A transcript-message tooltip's trigger scrolls with the content; a fixed
  // tooltip would detach and float over unrelated UI, so it should dismiss when
  // the trigger actually moves on scroll (preserves the pre-fix behavior for
  // scrolling triggers).
  installFakeTimers();
  try {
    act(() => {
      render(h(Tooltip, { content: 'moves', delayShow: 0, delayHide: 0 }, h('span', { class: 'trigger' }, 'target')), container);
    });
    const host = () => document.querySelector('.pie-tooltip-host') as HTMLElement;
    const trigger = () => container.querySelector('.pie-tooltip-trigger') as HTMLElement;

    // Simulate a trigger that reports a real layout rect, then moves on scroll.
    let top = 100;
    Object.defineProperty(trigger(), 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top, bottom: top + 20, left: 0, right: 40, width: 40, height: 20, x: 0, y: top }),
    });

    await act(async () => {
      trigger().dispatchEvent(new MouseEvent('mouseenter'));
      flushTimers();
    });
    assert.equal(host().style.display, 'block');

    // The trigger scrolls up by 50px — well beyond the 1px tolerance.
    top = 50;
    await act(async () => {
      window.dispatchEvent(new Event('scroll'));
    });
    assert.equal(host().style.display, 'none', 'a tooltip whose trigger scrolled should dismiss');
  } finally {
    restoreTimers();
  }
});

test('keyboard focus opens a rich tooltip and blur or Escape closes it', async () => {
  installFakeTimers();
  try {
    act(() => {
      render(
        h(Tooltip, {
          contentNode: h('div', { class: 'rich-body' }, 'details'),
          delayShow: 0,
          delayHide: 0,
        }, h('span', { class: 'trigger', tabIndex: 0, 'aria-label': 'Usage details' }, 'usage')),
        container,
      );
    });
    const host = () => document.querySelector('.pie-tooltip-host') as HTMLElement;
    const trigger = () => container.querySelector('.trigger') as HTMLElement;

    await act(async () => {
      trigger().dispatchEvent(new Event('focus'));
      flushTimers();
    });
    assert.equal(host().style.display, 'block', 'focus should open the tooltip');

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    assert.equal(host().style.display, 'none', 'Escape should close the tooltip immediately');

    await act(async () => {
      trigger().dispatchEvent(new Event('focus'));
      flushTimers();
      trigger().dispatchEvent(new Event('blur'));
    });
    assert.equal(host().style.display, 'none', 'blur should close the tooltip');
  } finally {
    restoreTimers();
  }
});

test('Escape cancels a delayed keyboard tooltip before it opens', async () => {
  installFakeTimers();
  try {
    act(() => {
      render(h(Tooltip, {
        content: 'details',
        delayShow: 100,
      }, h('span', { tabIndex: 0, 'aria-label': 'Delayed details' }, 'details')), container);
    });
    const trigger = container.querySelector('[aria-label="Delayed details"]') as HTMLElement;
    await act(async () => {
      trigger.dispatchEvent(new Event('focus'));
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
      flushTimers();
    });
    assert.equal((document.querySelector('.pie-tooltip-host') as HTMLElement).style.display, 'none');
  } finally {
    restoreTimers();
  }
});

test('richRole region keeps interactive rich content out of tooltip semantics', async () => {
  installFakeTimers();
  try {
    act(() => {
      render(h(Tooltip, {
        contentNode: h('div', null, h('button', { type: 'button' }, 'model detail')),
        richRole: 'region',
        delayShow: 0,
        delayHide: 0,
      }, h('span', { tabIndex: 0, 'aria-label': 'Cost details' }, 'cost')), container);
    });
    const host = () => document.querySelector('.pie-tooltip-host') as HTMLElement;
    const trigger = () => container.querySelector('[aria-label="Cost details"]') as HTMLElement;
    await act(async () => {
      trigger().dispatchEvent(new Event('focus'));
      flushTimers();
    });
    assert.equal(host().getAttribute('role'), 'region');
    assert.equal(host().getAttribute('aria-label'), 'Cost details');
    const inner = host().querySelector('button') as HTMLButtonElement;
    assert.ok(inner, 'interactive rich content remains reachable');
    await act(async () => {
      trigger().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }));
    });
    assert.equal(document.activeElement, inner, 'Tab from the trigger enters the rich surface');
  } finally {
    restoreTimers();
  }
});

test('contentNode renders a rich JSX tooltip (hoverable, not textContent)', async () => {
  // A rich tooltip renders its JSX subtree into the host via an imperative
  // Preact root (not textContent), gets the --rich class + pointer events so
  // interactive content can be hovered, and unmounts the subtree on hide.
  installFakeTimers();
  try {
    const contentNode = h('div', { class: 'rich-body' }, 'graph here');
    act(() => {
      render(h(Tooltip, { contentNode, delayShow: 0, delayHide: 0 }, h('span', { class: 'trigger' }, 'target')), container);
    });
    const host = () => document.querySelector('.pie-tooltip-host') as HTMLElement;
    const trigger = () => container.querySelector('.pie-tooltip-trigger') as HTMLElement;

    await act(async () => {
      trigger().dispatchEvent(new MouseEvent('mouseenter'));
      flushTimers();
    });
    assert.ok(host().classList.contains('pie-tooltip-host--rich'), 'host should get the rich class');
    assert.equal(host().style.pointerEvents, 'auto', 'rich tooltip should be hoverable');
    assert.equal(host().getAttribute('role'), 'tooltip', 'ordinary rich tooltips keep tooltip semantics');
    const body = host().querySelector('.rich-body');
    assert.ok(body, 'rich JSX subtree should be mounted in the host');
    assert.equal(body?.textContent, 'graph here');

    // Hide unmounts the subtree (not just cleared text).
    await act(async () => {
      trigger().dispatchEvent(new MouseEvent('mouseleave'));
      flushTimers();
    });
    assert.equal(host().style.display, 'none');
    assert.equal(host().querySelector('.rich-body'), null, 'subtree should unmount on hide');
  } finally {
    restoreTimers();
  }
});
