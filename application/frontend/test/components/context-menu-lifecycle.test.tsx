import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom } from '../helpers/dom';
installDom();
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { ContextMenu, type ContextMenuState } from '../../lib/components/context-menu';
import type { ChatPrefs } from '../../../lib/protocol/index.js';

const opening = (): ContextMenuState => ({
  type: 'message', rawData: '', sessionPath: '/session', selectionText: 'selection',
  message: { messageId: 'one', plainText: 'text', canTruncate: true },
  x: 10, y: 10, triggerEl: null,
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

for (const outcome of ['success', 'failure'] as const) {
  test(`late clipboard ${outcome} cannot affect a replacement opening`, async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    let closes = 0;
    const draw = (menu: ContextMenuState) => act(() => render(h(ContextMenu, {
      menu, prefs: {} as ChatPrefs, onSetPrefs: () => {}, onOpenFile: () => {},
      onEditMessage: () => {}, onTruncateAfter: () => {}, onClose: () => { closes++; },
    }), container));
    try {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: () => new Promise<void>((yes, no) => { resolve = yes; reject = no; }),
      } });
      draw(opening());
      act(() => container.querySelector<HTMLButtonElement>('button')!.click());
      const deleteButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Delete from here')!;
      act(() => deleteButton.click());
      assert.match(container.textContent!, /Confirm delete/);
      // Same target, fresh opening: even this must discard armed confirmation.
      draw(opening());
      assert.doesNotMatch(container.textContent!, /Confirm delete/);
      if (outcome === 'success') resolve();
      else reject(new Error('denied'));
      await tick();
      assert.equal(closes, 0);
      assert.equal(container.querySelector('[role="status"]'), null);
    } finally {
      act(() => render(null, container));
      container.remove();
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
    }
  });
}

for (const shiftKey of [false, true]) {
test(`${shiftKey ? 'Shift+Tab' : 'Tab'} exits a multi-item menu from its logical trigger`, async () => {
  const container = document.createElement('div');
  const trigger = document.createElement('button');
  const before = document.createElement('button');
  const after = document.createElement('button');
  document.body.append(before, trigger, container, after);
  try {
    act(() => render(h(ContextMenu, {
      menu: { ...opening(), triggerEl: trigger }, prefs: {} as ChatPrefs,
      onSetPrefs: () => {}, onOpenFile: () => {}, onEditMessage: () => {}, onTruncateAfter: () => {},
      onClose: () => render(null, container),
    }), container));
    assert.ok(container.querySelectorAll('button').length > 1);
    assert.equal(document.activeElement?.textContent, 'Copy');
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
    act(() => document.activeElement!.dispatchEvent(event));
    assert.equal(event.defaultPrevented, false);
    assert.equal(document.activeElement, trigger, 'keydown must re-anchor before native Tab');
    assert.ok(container.querySelector('[role="menu"]')!.hasAttribute('inert'));
    // The DOM harness has no native Tab action. Model sequential navigation
    // from the actual active element, rather than forcing a chosen destination.
    const candidates = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .filter((button) => button.tabIndex >= 0 && !button.closest('[inert]'));
    const index = candidates.indexOf(document.activeElement as HTMLButtonElement);
    candidates[index + (shiftKey ? -1 : 1)]!.focus();
    const destination = shiftKey ? before : after;
    assert.equal(document.activeElement, destination);
    await act(async () => { await tick(); });
    assert.equal(container.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, destination);
  } finally {
    act(() => render(null, container));
    before.remove(); trigger.remove(); container.remove(); after.remove();
  }
});
}
