import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../../_helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { scopePendingOverlay, SystemPromptToggleMenu } from '../../../src/webview/panel/composer/system-prompt-toggle-menu';
import type { SystemPromptEntry } from '../../../src/shared/protocol';
import { NoticeContext } from '../../../src/webview/panel/hooks/notice-context';

let container: HTMLElement;

type TestOnSetToggles = (ids: string[]) => unknown;
type ToggleApplyResult = void | boolean | Promise<void | boolean>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  return () => {
    render(null, container);
    container.remove();
    document.querySelectorAll('.system-prompt-toggle-dropdown').forEach((el) => el.remove());
  };
});

function providerEntry(): SystemPromptEntry {
  return {
    source: 'provider',
    id: 'provider',
    availability: 'unknown',
    title: 'Provider system prompt',
    text: 'Not directly exposed.',
    summary: 'provider',
    toggleable: false,
  };
}

function entry(id: string, title: string, disabled = false): SystemPromptEntry {
  return {
    source: 'harness',
    id,
    availability: 'available',
    title,
    text: `${title} body`,
    summary: `${title} summary`,
    disabled,
  };
}

function mount(
  prompts: SystemPromptEntry[],
  onSetToggles: TestOnSetToggles,
  sessionPath: string | null = null,
  notice: string | null = null,
  noticeSessionPath: string | null = null,
): void {
  act(() => {
    render(
      h(NoticeContext.Provider, { value: { notice, sessionPath: noticeSessionPath, dismiss: null } },
        h(SystemPromptToggleMenu, { prompts, sessionPath, onSetToggles: onSetToggles as (ids: string[]) => ToggleApplyResult })),
      container,
    );
  });
}

function rerender(
  prompts: SystemPromptEntry[],
  onSetToggles: TestOnSetToggles,
  sessionPath: string | null = null,
  notice: string | null = null,
  noticeSessionPath: string | null = null,
): void {
  act(() => {
    render(
      h(NoticeContext.Provider, { value: { notice, sessionPath: noticeSessionPath, dismiss: null } },
        h(SystemPromptToggleMenu, { prompts, sessionPath, onSetToggles: onSetToggles as (ids: string[]) => ToggleApplyResult })),
      container,
    );
  });
}

function openMenu(): void {
  const trigger = container.querySelector('.system-prompt-toggle-trigger') as HTMLButtonElement | null;
  assert.ok(trigger, 'toggle trigger should render');
  act(() => {
    trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function items(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.toolbar-settings-item'));
}

function findItem(title: string): HTMLElement {
  const match = items().find((el) => el.querySelector('.system-prompt-toggle-entry-title')?.textContent === title);
  assert.ok(match, `toggle item "${title}" should be rendered`);
  return match!;
}

function clickItem(title: string): void {
  act(() => {
    findItem(title).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function isChecked(el: HTMLElement): boolean {
  return el.getAttribute('aria-checked') === 'true';
}

function badgeText(): string | null {
  const badge = container.querySelector('.system-prompt-toggle-badge');
  return badge?.textContent ?? null;
}

function triggerHasDisabled(): boolean {
  return container.querySelector('.system-prompt-toggle-trigger')?.classList.contains('has-disabled') ?? false;
}

test('toggle applies optimistically — checkbox + badge update before the backend round-trip', () => {
  const calls: string[][] = [];
  const onSet = (ids: string[]) => calls.push(ids);
  // Backend still reports the harness as enabled (round-trip not yet landed).
  mount([providerEntry(), entry('harness', 'Harness')], onSet);
  openMenu();

  const harnessItem = findItem('Harness');
  assert.equal(isChecked(harnessItem), true, 'harness starts enabled');
  assert.equal(badgeText(), null, 'no badge when nothing disabled');
  assert.equal(triggerHasDisabled(), false);

  clickItem('Harness');

  assert.equal(isChecked(findItem('Harness')), false, 'checkbox unchecks instantly on click');
  assert.equal(badgeText(), '1', 'badge appears instantly');
  assert.equal(triggerHasDisabled(), true, 'trigger is accented instantly');
  assert.deepEqual(calls, [['harness']], 'posts the single disabled id');
});

test('rapid successive toggles accumulate (lost-update regression)', () => {
  // Regression: the previous version derived each toggle's "next" set from the
  // stale `prompts` prop, so a second click before the backend re-emitted
  // `session.opened` computed its set WITHOUT the first toggle and clobbered
  // it. The effective set must carry the first toggle along.
  const calls: string[][] = [];
  const onSet = (ids: string[]) => calls.push(ids);
  // Backend reports both enabled throughout (simulating neither round-trip has
  // landed yet).
  mount(
    [providerEntry(), entry('harness', 'Harness'), entry('tools', 'Tools')],
    onSet,
  );
  openMenu();

  clickItem('Harness'); // disable harness
  clickItem('Tools');   // disable tools — must NOT drop harness

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['harness']);
  assert.deepEqual(
    calls[1].sort(),
    ['harness', 'tools'],
    'second toggle carries the first along instead of clobbering it',
  );
  assert.equal(isChecked(findItem('Harness')), false, 'harness stays disabled');
  assert.equal(isChecked(findItem('Tools')), false, 'tools now disabled');
  assert.equal(badgeText(), '2');
});

test('toggling an already-disabled entry back on re-enables it optimistically', () => {
  const calls: string[][] = [];
  const onSet = (ids: string[]) => calls.push(ids);
  mount(
    [providerEntry(), entry('harness', 'Harness', true)],
    onSet,
  );
  openMenu();

  assert.equal(isChecked(findItem('Harness')), false, 'starts disabled (remote truth)');

  clickItem('Harness');

  assert.equal(isChecked(findItem('Harness')), true, 're-enables instantly');
  assert.deepEqual(calls, [[]], 'posts an empty set to re-enable');
  assert.equal(badgeText(), null);
});

test('reconcile: backend confirmation clears pending without flicker', () => {
  const calls: string[][] = [];
  const onSet = (ids: string[]) => calls.push(ids);
  const prompts0 = [providerEntry(), entry('harness', 'Harness'), entry('tools', 'Tools')];
  mount(prompts0, onSet);
  openMenu();

  clickItem('Harness');
  clickItem('Tools');
  assert.deepEqual(calls[1].sort(), ['harness', 'tools']);

  // Backend now confirms both disabled (the round-trip lands).
  rerender(
    [providerEntry(), entry('harness', 'Harness', true), entry('tools', 'Tools', true)],
    onSet,
  );
  assert.equal(isChecked(findItem('Harness')), false, 'harness still disabled after ack');
  assert.equal(isChecked(findItem('Tools')), false, 'tools still disabled after ack');
  assert.equal(badgeText(), '2');

  // Pending has been acked, so a fresh toggle posts the effective set cleanly.
  clickItem('Harness'); // re-enable harness only
  assert.deepEqual(
    calls[2],
    ['tools'],
    'after ack, toggling harness back on keeps tools disabled',
  );
});

test('reconcile prunes pending entries that vanish from the prompt list', () => {
  const calls: string[][] = [];
  const onSet = (ids: string[]) => calls.push(ids);
  mount(
    [providerEntry(), entry('harness', 'Harness'), entry('tools', 'Tools')],
    onSet,
  );
  openMenu();
  clickItem('Tools'); // disable tools (pending)

  // Backend re-emits with the tools entry gone entirely (e.g. no tools loaded).
  rerender([providerEntry(), entry('harness', 'Harness')], onSet);

  assert.equal(items().length, 1, 'tools entry is gone');
  assert.equal(badgeText(), null, 'pending tools intent is pruned, not stuck');
});

test('Reset clears every disabled entry optimistically', () => {
  const calls: string[][] = [];
  const onSet = (ids: string[]) => calls.push(ids);
  // Both already disabled per remote truth.
  mount(
    [providerEntry(), entry('harness', 'Harness', true), entry('tools', 'Tools', true)],
    onSet,
  );
  openMenu();

  const reset = container.querySelector('.system-prompt-toggle-reset') as HTMLButtonElement | null;
  assert.ok(reset, 'reset button renders when entries are disabled');
  act(() => {
    reset!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

  assert.equal(isChecked(findItem('Harness')), true, 'harness re-enabled instantly');
  assert.equal(isChecked(findItem('Tools')), true, 'tools re-enabled instantly');
  assert.equal(badgeText(), null, 'badge clears instantly');
  assert.deepEqual(calls, [[]], 'posts an empty set');
});

test('survives the 0 -> N entries transition without throwing (hook-count stability)', () => {
  const calls: string[][] = [];
  const onSet = (ids: string[]) => calls.push(ids);
  // Only the non-toggleable provider card: nothing to toggle -> renders null.
  mount([providerEntry()], onSet);
  assert.ok(!container.querySelector('.system-prompt-toggle-trigger'), 'no trigger when nothing is toggleable');

  // Session resolves and toggleable entries appear. Hook count must stay
  // stable across this transition (the early return used to sit before a
  // useEffect, changing the hook count between renders).
  assert.doesNotThrow(() => {
    rerender([providerEntry(), entry('harness', 'Harness'), entry('tools', 'Tools')], onSet);
  });
  assert.ok(container.querySelector('.system-prompt-toggle-trigger'), 'trigger appears once entries exist');

  // And it still works after the transition.
  openMenu();
  clickItem('Harness');
  assert.deepEqual(calls, [['harness']]);
});

test('Escape closes the dropdown and returns focus to the trigger', () => {
  mount([providerEntry(), entry('harness', 'Harness')], () => undefined);
  openMenu();
  assert.ok(container.querySelector('.system-prompt-toggle-dropdown'), 'dropdown is open');

  const trigger = container.querySelector('.system-prompt-toggle-trigger') as HTMLButtonElement;
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

  assert.ok(!container.querySelector('.system-prompt-toggle-dropdown'), 'dropdown closes on Escape');
  assert.equal(document.activeElement, trigger, 'focus returns to the trigger');
});

test('survives the N -> 0 entries transition without throwing (hook-count stability, downward)', () => {
  const calls: string[][] = [];
  const onSet = (ids: string[]) => calls.push(ids);
  mount([providerEntry(), entry('harness', 'Harness'), entry('tools', 'Tools')], onSet);
  openMenu();
  clickItem('Harness'); // leaves a pending intent

  // All toggleable entries vanish (e.g. session de-resolved to provider card
  // only). Hook count must stay stable; the pending overlay is retained, not
  // crashed on.
  assert.doesNotThrow(() => rerender([providerEntry()], onSet));
  assert.ok(!container.querySelector('.system-prompt-toggle-trigger'), 'trigger hides when nothing is toggleable');

  // And it recovers when entries come back.
  assert.doesNotThrow(() => rerender([providerEntry(), entry('harness', 'Harness')], onSet));
  assert.ok(container.querySelector('.system-prompt-toggle-trigger'), 'trigger reappears');
});

test('partial backend ack: confirming one pending entry keeps the other pending', () => {
  const calls: string[][] = [];
  const onSet = (ids: string[]) => calls.push(ids);
  mount([providerEntry(), entry('harness', 'Harness'), entry('tools', 'Tools')], onSet);
  openMenu();
  clickItem('Harness');
  clickItem('Tools');
  assert.deepEqual(calls[1].sort(), ['harness', 'tools']);

  // Backend confirms ONLY harness (tools still enabled remotely).
  rerender([providerEntry(), entry('harness', 'Harness', true), entry('tools', 'Tools')], onSet);
  assert.equal(isChecked(findItem('Harness')), false, 'harness acked, still disabled');
  assert.equal(isChecked(findItem('Tools')), false, 'tools stays disabled via pending overlay');
  assert.equal(badgeText(), '2');

  // Backend now confirms tools too.
  rerender([providerEntry(), entry('harness', 'Harness', true), entry('tools', 'Tools', true)], onSet);
  assert.equal(isChecked(findItem('Harness')), false);
  assert.equal(isChecked(findItem('Tools')), false);
  assert.equal(badgeText(), '2');

  // Pending is fully acked: a fresh toggle posts the clean effective set.
  clickItem('Harness');
  assert.deepEqual(calls[2], ['tools'], 're-enabling harness leaves tools disabled');
});

test('a backend-driven flip on one entry does not disturb a pending intent on another', () => {
  const calls: string[][] = [];
  const onSet = (ids: string[]) => calls.push(ids);
  mount([providerEntry(), entry('harness', 'Harness'), entry('tools', 'Tools')], onSet);
  openMenu();
  clickItem('Harness'); // pending { harness: true }

  // Backend independently disables tools (no user toggle) while harness's
  // pending intent is still unconfirmed.
  rerender([providerEntry(), entry('harness', 'Harness'), entry('tools', 'Tools', true)], onSet);
  assert.equal(isChecked(findItem('Harness')), false, 'harness disabled via pending overlay');
  assert.equal(isChecked(findItem('Tools')), false, 'tools disabled via remote flip');
  assert.equal(badgeText(), '2');

  // Toggling tools back on must carry the still-pending harness intent along.
  clickItem('Tools');
  assert.deepEqual(calls[1], ['harness'], 're-enabling tools keeps harness disabled');
  assert.equal(isChecked(findItem('Tools')), true, 'tools re-enabled optimistically');
  assert.equal(isChecked(findItem('Harness')), false, 'harness still disabled');
  assert.equal(badgeText(), '1');
});

test('rapid off -> on of the same entry cancels out before the round-trip', () => {
  const calls: string[][] = [];
  const onSet = (ids: string[]) => calls.push(ids);
  mount([providerEntry(), entry('harness', 'Harness')], onSet);
  openMenu();

  clickItem('Harness'); // disable
  clickItem('Harness'); // re-enable (before backend confirms)

  assert.deepEqual(calls, [['harness'], []], 'net effect is a no-op empty set');
  assert.equal(isChecked(findItem('Harness')), true, 'back to enabled');
  assert.equal(badgeText(), null);
});

test('Reset clears pending overlays, not just remote-disabled entries', () => {
  const calls: string[][] = [];
  const onSet = (ids: string[]) => calls.push(ids);
  // Both enabled remotely; user disables both via pending overlay only.
  mount([providerEntry(), entry('harness', 'Harness'), entry('tools', 'Tools')], onSet);
  openMenu();
  clickItem('Harness');
  clickItem('Tools');
  assert.equal(badgeText(), '2');

  const reset = container.querySelector('.system-prompt-toggle-reset') as HTMLButtonElement;
  act(() => {
    reset.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

  assert.deepEqual(calls[2], [], 'reset posts an empty set');
  assert.equal(isChecked(findItem('Harness')), true, 'harness re-enabled optimistically');
  assert.equal(isChecked(findItem('Tools')), true, 'tools re-enabled optimistically');
  assert.equal(badgeText(), null);

  // Backend confirms (both still enabled): pending overlays ack cleanly, no flicker.
  rerender([providerEntry(), entry('harness', 'Harness'), entry('tools', 'Tools')], onSet);
  assert.equal(isChecked(findItem('Harness')), true);
  assert.equal(isChecked(findItem('Tools')), true);
  assert.equal(badgeText(), null);
});

test('session changes clear pending prompt intents before rendering the next tab', () => {
  const calls: string[][] = [];
  const onSet = (ids: string[]) => calls.push(ids);
  mount([providerEntry(), entry('harness', 'Harness')], onSet, '/sessions/a');
  openMenu();
  clickItem('Harness');
  assert.equal(isChecked(findItem('Harness')), false);

  rerender([providerEntry(), entry('harness', 'Harness')], onSet, '/sessions/b');

  assert.ok(!container.querySelector('.system-prompt-toggle-dropdown'), 'session switch closes the old menu');
  openMenu();
  assert.equal(isChecked(findItem('Harness')), true, 'session B must not inherit session A pending state');
  assert.equal(badgeText(), null);
});

test('pending overlay derivation rejects an old session state before effects run', () => {
  const state = {
    sessionPath: '/sessions/a',
    sessionGeneration: 0,
    intents: { harness: true },
  };

  assert.deepEqual(
    scopePendingOverlay(state, '/sessions/b', 1),
    {},
    'session B must render without A intents even before the reset effect runs',
  );
  assert.deepEqual(
    scopePendingOverlay(state, '/sessions/a', 2),
    {},
    'returning to A under a newer generation must not resurrect stale intents',
  );
});

test('async rollback is fenced across A -> B -> A', async () => {
  const rejectors: Array<(reason?: unknown) => void> = [];
  const onSet = (_ids: string[]) => new Promise<void>((_resolve, reject) => {
    rejectors.push(reject);
  });
  mount([providerEntry(), entry('harness', 'Harness')], onSet, '/sessions/a');
  openMenu();
  clickItem('Harness');

  rerender([providerEntry(), entry('harness', 'Harness')], onSet, '/sessions/b');
  rerender([providerEntry(), entry('harness', 'Harness')], onSet, '/sessions/a');
  openMenu();
  clickItem('Harness');

  rejectors[0]?.(new Error('late A request failed'));
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(isChecked(findItem('Harness')), false, 'old A rejection must not roll back the new A intent');
});

test('a synchronous failed prompt-toggle write rolls back the optimistic overlay', () => {
  const onSet = (_ids: string[]) => false;
  mount([providerEntry(), entry('harness', 'Harness')], onSet, '/sessions/a');
  openMenu();

  clickItem('Harness');

  assert.equal(isChecked(findItem('Harness')), true, 'failed transport writes do not remain optimistic');
  assert.equal(badgeText(), null);
});

test('the authoritative prompt-toggle failure notice rolls back pending state', () => {
  const calls: string[][] = [];
  const onSet = (ids: string[]) => calls.push(ids);
  mount([providerEntry(), entry('harness', 'Harness')], onSet, '/sessions/a');
  openMenu();
  clickItem('Harness');
  assert.equal(isChecked(findItem('Harness')), false);

  rerender(
    [providerEntry(), entry('harness', 'Harness')],
    onSet,
    '/sessions/a',
    'Failed to save the system-prompt setting. See the pie log for details.',
  );

  assert.equal(isChecked(findItem('Harness')), true, 'failed persistence must return to remote truth');
  assert.equal(badgeText(), null);
});

test('a late failure notice for session A does not clear session B pending state', () => {
  const calls: string[][] = [];
  const onSet = (ids: string[]) => calls.push(ids);
  mount([providerEntry(), entry('harness', 'Harness')], onSet, '/sessions/a');
  openMenu();
  clickItem('Harness');

  rerender([providerEntry(), entry('harness', 'Harness')], onSet, '/sessions/b');
  openMenu();
  clickItem('Harness');
  assert.equal(isChecked(findItem('Harness')), false);

  rerender(
    [providerEntry(), entry('harness', 'Harness')],
    onSet,
    '/sessions/b',
    'Failed to save the system-prompt setting. See the pie log for details.',
    '/sessions/a',
  );

  assert.equal(isChecked(findItem('Harness')), false, 'session A failure must not erase B optimistic state');
  assert.equal(badgeText(), '1');
});
