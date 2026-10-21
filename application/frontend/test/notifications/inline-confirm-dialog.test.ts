import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { installDom } from '../helpers/dom';
import { InlineConfirmDialog, type InlineConfirmState } from '../../notifications/inline-confirm-dialog';

installDom();

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  render(null, container);
  container.remove();
  document.querySelector('[data-inline-confirm]')?.remove();
});

const baseConfirm: InlineConfirmState = {
  type: 'inlineConfirm',
  confirmId: 'confirm-1',
  kind: 'model-switch',
  message: 'Switch model to o3?',
  confirmChoice: 'Switch',
};

const key = (target: Element, init: KeyboardEventInit) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
};

test('Cancel takes initial focus and the dialog is named by its message', () => {
  const responses: boolean[] = [];
  act(() => {
    render(h(InlineConfirmDialog, { confirm: baseConfirm, onRespond: (c) => { responses.push(c); } }), container);
  });

  const dialog = container.querySelector('[role="dialog"]');
  assert.ok(dialog);
  assert.equal(dialog!.getAttribute('aria-modal'), 'true');
  const cancel = container.querySelector<HTMLButtonElement>('[data-inline-confirm-cancel]')!;
  assert.equal(document.activeElement, cancel, 'initial focus must land on Cancel');

  const messageId = dialog!.getAttribute('aria-labelledby');
  assert.ok(messageId);
  const message = container.querySelector<HTMLDivElement>(`#${messageId}`);
  assert.ok(message, 'accessible name must resolve to an existing element');
  assert.equal(message!.textContent, 'Switch model to o3?');
  assert.ok(dialog!.contains(message!), 'the message lives inside the dialog it names');
  assert.equal(responses.length, 0, 'mounting must not auto-answer');
});

test('Escape answers Cancel and buttons reply exactly once through the mock', () => {
  const responses: boolean[] = [];
  const onRespond = (confirmed: boolean) => { responses.push(confirmed); };
  act(() => {
    render(h(InlineConfirmDialog, { confirm: baseConfirm, onRespond }), container);
  });

  const dialog = container.querySelector('[role="dialog"]')!;
  key(dialog, { key: 'Escape' });
  assert.deepEqual(responses, [false]);

  act(() => {
    container.querySelector<HTMLButtonElement>('[data-inline-confirm-ok]')!.click();
  });
  assert.deepEqual(responses, [false, true]);

  {
    const next: boolean[] = [];
    act(() => {
      render(h(InlineConfirmDialog, { confirm: { ...baseConfirm, confirmId: 'confirm-2' }, onRespond: (c) => { next.push(c); } }), container);
    });
    key(document.querySelector('[role="dialog"]')!, { key: 'Escape' });
    assert.deepEqual(next, [false], 'fresh mount must reply exactly once');
  }
});

test('Tab wraps inside the dialog so focus cannot escape', () => {
  act(() => {
    render(h(InlineConfirmDialog, { confirm: baseConfirm, onRespond: () => undefined }), container);
  });

  const cancel = container.querySelector<HTMLButtonElement>('[data-inline-confirm-cancel]')!;
  const ok = container.querySelector<HTMLButtonElement>('[data-inline-confirm-ok]')!;
  assert.equal(document.activeElement, cancel);

  // Tab from the last control wraps to the first.
  act(() => { ok.focus(); });
  const forward = key(ok, { key: 'Tab' });
  assert.equal(forward.defaultPrevented, true, 'trap owns the edge-crossing Tab');
  assert.equal(document.activeElement, cancel, 'Tab from the choice button wraps back to Cancel');
  // Shift+Tab from the first control wraps to the last.
  const backward = key(cancel, { key: 'Tab', shiftKey: true });
  assert.equal(backward.defaultPrevented, true);
  assert.equal(document.activeElement, ok, 'Shift+Tab from Cancel wraps to the choice button');
});

test('focus returns to the previously focused element on unmount', () => {
  const outside = document.createElement('button');
  document.body.appendChild(outside);
  try {
    act(() => { outside.focus(); });
    act(() => {
      render(h(InlineConfirmDialog, { confirm: baseConfirm, onRespond: () => undefined }), container);
    });
    assert.notEqual(document.activeElement, outside, 'dialog must own focus while open');
    act(() => { render(null, container); });
    assert.equal(document.activeElement, outside, 'unmount must restore prior focus');
  } finally {
    outside.remove();
  }
});