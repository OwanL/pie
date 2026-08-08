import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { installDom } from '../../_helpers/dom';
import { ChoicePicker } from '../../../src/webview/panel/components/choice-picker';

installDom();

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  return () => {
    render(null, container);
    container.remove();
    document.querySelectorAll('.choice-picker-dropdown').forEach((element) => element.remove());
  };
});

const options = [
  { value: 'low', label: 'Low' },
  { value: 'high', label: 'High' },
] as const;

test('ChoicePicker replaces the native select with a themed portaled listbox', () => {
  act(() => {
    render(h(ChoicePicker, {
      value: 'high',
      label: 'High',
      ariaLabel: 'Reasoning level',
      title: 'Reasoning effort',
      options,
      onChange: () => undefined,
    }), container);
  });

  const trigger = container.querySelector<HTMLButtonElement>('.choice-picker-trigger');
  assert.ok(trigger);
  assert.equal(container.querySelector('select'), null);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');

  act(() => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  const dropdown = document.querySelector('.choice-picker-dropdown');
  assert.ok(dropdown);
  assert.equal(dropdown!.closest('.choice-picker'), null, 'listbox is portaled out of toolbar overflow');
  assert.equal(dropdown!.querySelector('[aria-selected="true"]')?.textContent?.includes('High'), true);
  assert.equal(dropdown!.querySelector('.picker-popover-count'), null, 'option count is redundant in a fixed reasoning list');
  assert.equal(dropdown!.querySelector('.choice-picker-description'), null, 'reasoning levels need no explanatory snippets');
});

test('ChoicePicker clamps its portaled listbox inside very narrow viewports', () => {
  const originalWidth = window.innerWidth;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 120 });
  try {
    act(() => {
      render(h(ChoicePicker, {
        value: 'high',
        label: 'High',
        ariaLabel: 'Reasoning level',
        title: 'Reasoning effort',
        options,
        onChange: () => undefined,
      }), container);
    });

    const trigger = container.querySelector<HTMLButtonElement>('.choice-picker-trigger')!;
    act(() => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const dropdown = Array.from(document.querySelectorAll<HTMLElement>('.choice-picker-dropdown')).at(-1);
    assert.ok(dropdown);
    assert.equal(dropdown.style.width, '104px');
    assert.equal(dropdown.style.maxWidth, '104px');
    assert.equal(dropdown.style.left, '8px');
  } finally {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
  }
});

test('ChoicePicker applies a choice immediately and closes', () => {
  const calls: string[] = [];
  act(() => {
    render(h(ChoicePicker, {
      value: 'low',
      label: 'Low',
      ariaLabel: 'Reasoning level',
      title: 'Reasoning effort',
      options,
      onChange: (value) => { calls.push(value); },
    }), container);
  });

  const trigger = container.querySelector<HTMLButtonElement>('.choice-picker-trigger')!;
  act(() => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  const currentDropdown = Array.from(document.querySelectorAll<HTMLElement>('.choice-picker-dropdown')).at(-1);
  assert.ok(currentDropdown);
  const high = Array.from(currentDropdown!.querySelectorAll<HTMLButtonElement>('.choice-picker-option'))
    .find((option) => option.textContent?.includes('High'));
  assert.ok(high);
  act(() => { high!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

  assert.deepEqual(calls, ['high']);
  assert.equal(currentDropdown!.isConnected, false);
  assert.equal(document.activeElement, trigger);
});

test('Tab closes the portaled listbox and advances to the next toolbar control', async () => {
  act(() => {
    render(h('div', null,
      h(ChoicePicker, {
        value: 'low',
        label: 'Low',
        ariaLabel: 'Reasoning level',
        title: 'Reasoning effort',
        options,
        onChange: () => undefined,
      }),
      h('button', { id: 'after-picker', type: 'button' }, 'After'),
    ), container);
  });

  const trigger = container.querySelector<HTMLButtonElement>('.choice-picker-trigger')!;
  act(() => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  const dropdown = Array.from(document.querySelectorAll<HTMLElement>('.choice-picker-dropdown')).at(-1)!;
  await act(async () => {
    dropdown.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  });

  assert.equal(dropdown.isConnected, false);
  assert.equal(document.activeElement, container.querySelector('#after-picker'));
});
