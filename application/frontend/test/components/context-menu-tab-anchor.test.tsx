import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom } from '../helpers/dom';
installDom();
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { ContextMenu } from '../../lib/components/context-menu';
import type { ChatPrefs } from '../../../lib/protocol/index.js';

test('Tab can anchor at a nonfocusable context target without changing its tab order', () => {
  const trigger = document.createElement('div');
  const container = document.createElement('div');
  document.body.append(trigger, container);
  try {
    act(() => render(h(ContextMenu, {
      menu: { type: 'message', rawData: '', sessionPath: null, selectionText: '', x: 0, y: 0, triggerEl: trigger },
      prefs: {} as ChatPrefs, onSetPrefs: () => {}, onOpenFile: () => {},
      onEditMessage: () => {}, onTruncateAfter: () => {}, onClose: () => {},
    }), container));
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    act(() => document.activeElement!.dispatchEvent(event));
    assert.equal(event.defaultPrevented, false);
    assert.equal(document.activeElement, trigger);
    assert.equal(trigger.hasAttribute('tabindex'), false);
    assert.ok(container.querySelector('[role="menu"]')!.hasAttribute('inert'));
  } finally {
    act(() => render(null, container));
    trigger.remove(); container.remove();
  }
});
