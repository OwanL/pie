/**
 * Keyboard context-menu invocation helper: ContextMenu/Menu key and Shift+F10
 * translate into a grounded synthetic `contextmenu` dispatched from the
 * focused trigger, so mouse `onContextMenu` handlers stay the single open path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../../_helpers/dom';
installDom();

import {
  dispatchSyntheticContextMenu,
  handleContextMenuKeyRequest,
  isContextMenuKeyRequest,
} from '../../../src/webview/panel/components/context-menu-key';

function keydown(key: string, shiftKey = false): KeyboardEvent {
  return new window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
}

function stubRect(el: HTMLElement, left = 50, top = 70, width = 120, height = 30): void {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => null }),
  });
}

function captureContextMenus(el: HTMLElement): MouseEvent[] {
  const events: MouseEvent[] = [];
  el.addEventListener('contextmenu', (event) => events.push(event as MouseEvent));
  return events;
}

test('isContextMenuKeyRequest matches ContextMenu, Menu, and Shift+F10 only', () => {
  assert.equal(isContextMenuKeyRequest({ key: 'ContextMenu', shiftKey: false }), true);
  assert.equal(isContextMenuKeyRequest({ key: 'Menu', shiftKey: false }), true);
  assert.equal(isContextMenuKeyRequest({ key: 'F10', shiftKey: true }), true);
  assert.equal(isContextMenuKeyRequest({ key: 'F10', shiftKey: false }), false, 'plain F10 opens a menu bar, not the item menu');
  assert.equal(isContextMenuKeyRequest({ key: 'Enter', shiftKey: false }), false);
});

test('handleContextMenuKeyRequest dispatches a synthetic contextmenu grounded at the trigger rect', () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const trigger = document.createElement('button');
  trigger.type = 'button';
  host.appendChild(trigger);
  const events = captureContextMenus(trigger);
  stubRect(trigger, 50, 70, 120, 30);
  // Wire the helper exactly like the components do (Preact onKeyDown).
  trigger.addEventListener('keydown', handleContextMenuKeyRequest);

  const event = keydown('F10', true);
  trigger.dispatchEvent(event);

  assert.equal(event.defaultPrevented, true, 'the keyboard request is consumed');
  assert.equal(events.length, 1, 'exactly one contextmenu request dispatched');
  assert.equal(events[0].cancelable, true, 'the synthetic event flows through the normal preventDefault protocol');
  // Grounded at the center of the trigger's bounding rect.
  assert.equal(events[0].clientX, 110);
  assert.equal(events[0].clientY, 85);
  host.remove();
});

test('ContextMenu and Menu keys dispatch the same request', () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const trigger = document.createElement('div');
  trigger.setAttribute('tabindex', '0');
  host.appendChild(trigger);
  for (const key of ['ContextMenu', 'Menu']) {
    const events = captureContextMenus(trigger);
    trigger.addEventListener('keydown', handleContextMenuKeyRequest);
    trigger.dispatchEvent(keydown(key));
    assert.equal(events.length, 1, `${key} key issues the context-menu request`);
    events.length = 0;
  }
  host.remove();
});

test('non-menu keys dispatch nothing', () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const trigger = document.createElement('div');
  trigger.setAttribute('tabindex', '0');
  host.appendChild(trigger);
  const events = captureContextMenus(trigger);
  trigger.dispatchEvent(keydown('Enter'));
  trigger.dispatchEvent(keydown('F10', false)); // plain F10 targets the menu bar
  assert.equal(events.length, 0);
  host.remove();
});

test('editable targets keep their native text menu (helper no-ops)', () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const input = document.createElement('input');
  host.appendChild(input);
  const events = captureContextMenus(input);
  const event = keydown('F10', true);
  input.dispatchEvent(event);
  assert.equal(events.length, 0, 'no synthetic dispatch from an editable target');
  assert.equal(event.defaultPrevented, false, 'the native text menu path is untouched');
  host.remove();
});

test('already-handled keydowns are never re-dispatched (nested triggers bubbling)', () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const outer = document.createElement('div');
  const inner = document.createElement('div');
  inner.setAttribute('tabindex', '0');
  outer.appendChild(inner);
  host.appendChild(outer);
  // Inner trigger (e.g. the shell of a nested subagent transcript) handles the
  // bubbling keydown first and dispatches its own grounded request.
  inner.addEventListener('keydown', (event) => {
    event.preventDefault();
    dispatchSyntheticContextMenu(inner);
  });
  // Outer row-level handler (e.g. the transcript message shell).
  outer.addEventListener('keydown', handleContextMenuKeyRequest);
  const seen: MouseEvent[] = [];
  inner.addEventListener('contextmenu', (event) => seen.push(event as MouseEvent));

  inner.dispatchEvent(keydown('ContextMenu'));

  assert.equal(seen.length, 1, 'inner dispatch wins; the outer bubbling handler must not re-dispatch');
  host.remove();
});

test('dispatchSyntheticContextMenu reports dispatch and grounds coordinates', () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const trigger = document.createElement('button');
  host.appendChild(trigger);
  stubRect(trigger, 20, 30, 40, 50);
  const events = captureContextMenus(trigger);
  assert.equal(dispatchSyntheticContextMenu(trigger), true);
  assert.equal(events.length, 1);
  assert.equal(events[0].clientX, 40);
  assert.equal(events[0].clientY, 55);
  host.remove();
});