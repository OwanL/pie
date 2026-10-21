import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

import { installDom } from '../helpers/dom';
installDom();

import { h, render } from 'preact';
import { useState } from 'preact/hooks';
import { act } from 'preact/test-utils';

import { EMPTY_AGGREGATE_STATS } from '../../../lib/protocol/index.js';
import type { DeferredTriggerView } from '../../../lib/protocol/index.js';
import { AggregateStatsStrip } from '../../analytics/aggregate-stats-strip';
import { DeferredTriggersMenu } from '../../analytics/aggregate-stats-strip/deferred-triggers-menu';

let container: HTMLElement;
let originalRect: typeof HTMLElement.prototype.getBoundingClientRect;

beforeEach(() => {
  // The strip relies on layout measurement (MeasuredRow): the test DOM has no
  // stylesheet, so stub the row to an ample width like the sibling strip tests
  // do — every item becomes genuinely interactive and inspectable.
  originalRect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { width: this.classList.contains('aggregate-strip-metrics') ? 10000 : 80 } as DOMRect;
  };
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => render(null, container));
  container.remove();
  HTMLElement.prototype.getBoundingClientRect = originalRect;
});

const pending: DeferredTriggerView = {
  id: 'foreign-target-wakeup',
  sessionPath: '/workspace/creator.jsonl',
  targetSession: '/workspace/target.jsonl',
  triggers: [{ kind: 'timer', ms: 60_000 }],
  note: 'legacy note',
  message: 'Resume the target work',
  registeredAt: '2026-09-03T10:00:00.000Z',
  deliveryState: 'pending',
  wakeupMode: true,
};

test('strip click opens wakeup menu and foreign-target cancel emits creator path and id', () => {
  const cancellations: [string, string][] = [];
  function Fixture() {
    const [menu, setMenu] = useState<{ x: number; y: number; triggerEl: HTMLElement } | null>(null);
    const [triggers, setTriggers] = useState([pending]);
    return h('div', {},
      h(AggregateStatsStrip, {
        stats: EMPTY_AGGREGATE_STATS,
        deferredTriggers: triggers,
        onOpenDeferredMenu: (x, y, triggerEl) => setMenu({ x, y, triggerEl }),
      }),
      menu && h(DeferredTriggersMenu, {
        ...menu, triggers, sessionByPath: new Map(),
        onCancel: (sessionPath, id) => {
          cancellations.push([sessionPath, id]);
          setTriggers(triggers.filter((trigger) => trigger.id !== id));
          setMenu(null);
        },
        onClose: () => setMenu(null),
      }),
    );
  }
  act(() => render(h(Fixture, {}), container));
  const trigger = container.querySelector<HTMLButtonElement>('.aggregate-strip-deferred');
  assert.ok(trigger);
  assert.match(trigger.getAttribute('aria-label')!, /1 pending wakeup timer/);
  assert.equal(container.querySelector('[role="menu"]'), null);
  act(() => trigger.click());
  const menu = container.querySelector('[role="menu"]');
  assert.ok(menu, 'strip click opens the real menu component');
  assert.equal(menu.getAttribute('aria-label'), 'Pending wakeup timers');
  assert.match(menu.textContent!, /Waiting for response to finish/);
  assert.match(menu.textContent!, /Resume the target work/);
  assert.match(menu.textContent!, /created by creator.jsonl/);
  const cancel = menu.querySelector<HTMLButtonElement>('[aria-label="Cancel wakeup timer for target.jsonl"]');
  assert.ok(cancel);
  act(() => cancel.click());
  assert.deepEqual(cancellations, [[pending.sessionPath, pending.id]], 'cancel addresses owner, not target');
  assert.equal(container.querySelector('[role="menu"]'), null);
  assert.equal(container.querySelector('.aggregate-strip-deferred'), null);
});

test('strip tooltip refreshes after memoized snapshots change wakeup mode or timer start', async () => {
  const mount = (trigger: DeferredTriggerView) => act(() => render(h(AggregateStatsStrip, {
    stats: EMPTY_AGGREGATE_STATS,
    deferredTriggers: [trigger],
    onOpenDeferredMenu: () => undefined,
  }), container));
  const inspect = async () => {
    const button = container.querySelector<HTMLButtonElement>('.aggregate-strip-deferred');
    assert.ok(button);
    await act(async () => {
      button.focus();
      await new Promise((resolve) => window.setTimeout(resolve, 400));
    });
    const region = document.getElementById(button.getAttribute('aria-describedby')!);
    assert.ok(region, 'keyboard focus opens the rich timer tooltip');
    const text = region.textContent!;
    act(() => { button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    act(() => button.blur());
    return text;
  };
  mount({ ...pending, wakeupMode: false });
  assert.doesNotMatch(await inspect(), /Waiting for response to finish/);
  mount({ ...pending });
  assert.match(await inspect(), /Waiting for response to finish/);
  mount({ ...pending, timerStartedAt: '2026-09-03T10:01:00.000Z' });
  assert.doesNotMatch(await inspect(), /Waiting for response to finish/);
});
