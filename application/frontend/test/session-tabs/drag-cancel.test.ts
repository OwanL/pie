import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { useRef } from 'preact/hooks';

import { useTabDragAndDrop } from '../../session-tabs/use-drag-and-drop';
import type { UseTabDragAndDropResult } from '../../session-tabs/types';

/** Cancellation-path tests for tab drag-and-drop wiring. The user-facing
 *  invariant: once a tab (or pinned group chip / dropdown member) drag is
 *  tracking, the escape hatches — Escape, pointercancel and window blur — must
 *  clear candidate tracking and ghost/reorder state, and a trailing pointerup
 *  (the button is often still down) must commit nothing. With no cancel, the
 *  same pointerup still commits the reorder. */

let container: HTMLDivElement;

afterEach(() => {
  act(() => { render(null, container); });
  container.remove();
});

type MoveSpy = (sessionPath: string | undefined, fromIndex: number, toIndex: number) => void;

function mountHarness(options: { onMove: MoveSpy; onSelect: (path: string) => void; open?: string[] }) {
  const open = options.open ?? ['a', 'b'];
  const noop = () => undefined;
  let rendered: UseTabDragAndDropResult | null = null;
  function Harness() {
    const stripRef = useRef<HTMLDivElement>(null);
    rendered = useTabDragAndDrop({
      openTabPaths: open,
      pinnedTabPaths: [],
      pinnedTabGroups: [],
      onMove: options.onMove,
      onMovePinnedItem: noop,
      onSelect: options.onSelect,
      onClose: noop,
      onDuplicate: noop,
      onTogglePin: noop,
      onPinAndMerge: noop,
      onGroupPinnedTab: noop,
      onMergePinnedGroups: noop,
      onUngroupPinnedTab: noop,
      onRunAction: noop,
      stripRef,
    });
    return h('div', { ref: stripRef, class: 'session-tab-strip' },
      open.map((path, index) => h('div', {
        key: path,
        class: 'session-tab',
        'data-tab-path': path,
        'data-unpinned-tab': 'true',
        onPointerDown: (event: PointerEvent) => rendered!.onPointerDown(event, index, path),
      })));
  }
  act(() => { render(h(Harness, {}), container); });
  const strip = container.querySelector('.session-tab-strip') as HTMLElement;
  defineRect(strip, { left: 0, right: 400, top: 0, bottom: 28, width: 400, height: 28 });
  for (const [index, path] of open.entries()) {
    const tab = container.querySelector(`[data-tab-path="${path}"]`) as HTMLElement;
    assert.ok(tab, `tab element ${path} missing`);
    defineRect(tab, { left: index * 120, right: index * 120 + 100, top: 0, bottom: 28, width: 100, height: 28 });
  }
  assert.ok(rendered, 'hook mount should have run');
  return rendered as UseTabDragAndDropResult;
}

function defineRect(element: Element, rect: { left: number; right: number; top: number; bottom: number; width: number; height: number }): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    value: () => rect,
    configurable: true,
  });
}

function pointerEvent(type: string, init: { clientX: number; clientY: number }): PointerEvent {
  const PointerEventCtor = window.PointerEvent as unknown as (new (
    type: string,
    init: Record<string, unknown>,
  ) => PointerEvent);
  return new PointerEventCtor(type, {
    bubbles: true, cancelable: true, pointerId: 1, isPrimary: true,
    clientX: init.clientX, clientY: init.clientY, button: 0,
  });
}

function keyEvent(key: string): KeyboardEvent {
  return new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
}

function bodyDragging(): boolean {
  return document.body.classList.contains('session-tab-dragging');
}

/** pointerdown on tab 'a', then a pointermove past the drag threshold — the
 *  same start sequence used by real tab, group-chip and dropdown-member
 *  drags (they differ only in their source metadata). */
function beginTrackedDrag(drag: UseTabDragAndDropResult): void {
  const tabA = container.querySelector('[data-tab-path="a"]') as HTMLElement;
  act(() => { tabA.dispatchEvent(pointerEvent('pointerdown', { clientX: 50, clientY: 14 })); });
  assert.ok(drag.dragCandidateRef.current, 'pointerdown records the drag candidate');
  act(() => { window.dispatchEvent(pointerEvent('pointermove', { clientX: 80, clientY: 14 })); });
  assert.ok(drag.dragStateRef.current, 'drag tracking enters the ghost/drop state');
  assert.ok(bodyDragging(), 'dragging body class marks the in-flight drag');
}

test('normal pointerup without a cancel commits the reorder', () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  const moves: unknown[][] = [];
  const drag = mountHarness({ onMove: (...args: unknown[]) => { moves.push(args); }, onSelect: () => undefined });
  beginTrackedDrag(drag);
  act(() => { window.dispatchEvent(pointerEvent('pointerup', { clientX: 80, clientY: 14 })); });
  assert.equal(moves.length, 1, 'a plain pointerup commits the pending drop');
  assert.ok(!bodyDragging(), 'commit clears the dragging body class');
});

test('Escape during drag cancels tracking and ghost state; trailing pointerup commits nothing', () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  const moves: unknown[][] = [];
  const selects: string[] = [];
  const drag = mountHarness({
    onMove: (path, from, to) => { moves.push([path, from, to]); },
    onSelect: (path) => { selects.push(path); },
  });
  beginTrackedDrag(drag);

  act(() => { window.dispatchEvent(keyEvent('Escape')); });
  assert.equal(drag.dragCandidateRef.current, null, 'Escape clears candidate tracking');
  assert.equal(drag.dragStateRef.current, null, 'Escape clears ghost/drop state');
  assert.ok(!bodyDragging(), 'Escape clears the dragging body class');

  // The mouse button is still down after Escape: pointerup must not commit,
  // and further moves must not resurrect tracking.
  act(() => { window.dispatchEvent(pointerEvent('pointermove', { clientX: 120, clientY: 14 })); });
  act(() => { window.dispatchEvent(pointerEvent('pointerup', { clientX: 120, clientY: 14 })); });
  assert.deepEqual(moves, [], 'no reorder commit after an Escape-cancelled drag');
  assert.deepEqual(selects, [], 'no selection commit after an Escape-cancelled drag');
  assert.ok(!bodyDragging(), 'tracking stays torn down');
});

test('pointercancel cancels tracking; trailing pointerup commits nothing', () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  const moves: unknown[][] = [];
  const drag = mountHarness({ onMove: (...args: unknown[]) => { moves.push(args); }, onSelect: () => undefined });
  beginTrackedDrag(drag);

  act(() => { window.dispatchEvent(pointerEvent('pointercancel', { clientX: 80, clientY: 14 })); });
  assert.equal(drag.dragCandidateRef.current, null);
  assert.equal(drag.dragStateRef.current, null);
  assert.ok(!bodyDragging());

  act(() => { window.dispatchEvent(pointerEvent('pointerup', { clientX: 80, clientY: 14 })); });
  assert.deepEqual(moves, [], 'pointercancel must leave nothing for pointerup to commit');
});

test('window blur cancels tracking; trailing pointerup commits nothing', () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  const moves: unknown[][] = [];
  const drag = mountHarness({ onMove: (...args: unknown[]) => { moves.push(args); }, onSelect: () => undefined });
  beginTrackedDrag(drag);

  act(() => { window.dispatchEvent(new window.Event('blur')); });
  assert.equal(drag.dragStateRef.current, null);
  assert.ok(!bodyDragging());

  act(() => { window.dispatchEvent(pointerEvent('pointerup', { clientX: 80, clientY: 14 })); });
  assert.deepEqual(moves, [], 'blur must leave nothing for pointerup to commit');
});

test('Escape outside drag tracking is inert', () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  const drag = mountHarness({ onMove: () => undefined, onSelect: () => undefined });
  act(() => { window.dispatchEvent(keyEvent('Escape')); });
  assert.equal(drag.dragStateRef.current, null);
  assert.equal(drag.dragCandidateRef.current, null);
  assert.ok(!bodyDragging());
});