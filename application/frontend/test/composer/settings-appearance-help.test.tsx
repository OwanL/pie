import assert from 'node:assert/strict';
import test from 'node:test';

import { installDom } from '../helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { DEFAULT_CHAT_PREFS } from '../../../lib/protocol/index.js';
import { AppearanceSection } from '../../settings/ui-appearance-settings';
import { SliderRow } from '../../settings/slider-row';

let pending: Array<{ fn: () => void; id: number }> = [];
let nextId = 1;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const container = document.createElement('div');
document.body.appendChild(container);

test('appearance descriptions are label-adjacent help controls, not extra hint rows', () => {
  act(() => render(h(AppearanceSection, { prefs: DEFAULT_CHAT_PREFS, onSetPrefs: () => undefined }), container));

  const helpButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('.toolbar-settings-help-button'));
  assert.equal(helpButtons.length, 19);
  assert.ok(helpButtons.every((button) => button.closest('.pie-tooltip-trigger')?.parentElement?.querySelector('.toolbar-settings-ui-control-label')));
  assert.equal(container.querySelectorAll('.toolbar-settings-item-hint').length, 0);

  const inlineRows = Array.from(container.querySelectorAll<HTMLElement>('.toolbar-settings-ui-inline-control'));
  assert.equal(inlineRows.length, 10);
  for (const row of inlineRows) {
    assert.equal(row.children.length, 2);
    assert.ok(row.children[0].querySelector('.toolbar-settings-ui-control-label'));
    assert.ok(row.children[0].querySelector('.toolbar-settings-help-button'));
  }
  const colorControls = container.querySelectorAll('.toolbar-settings-color-controls');
  assert.equal(colorControls.length, 6);
  for (const controls of colorControls) assert.equal(controls.children.length, 2);
  for (const select of container.querySelectorAll('.toolbar-settings-ui-inline-control > select')) {
    assert.equal(select.parentElement?.children.length, 2);
  }
});

test('keyboard-focused appearance help reveals its description without changing the control value', async () => {
  pending = [];
  nextId = 1;
  globalThis.setTimeout = window.setTimeout = ((fn: () => void) => {
    const id = nextId++;
    pending.push({ fn, id });
    return id as unknown as number;
  }) as typeof globalThis.setTimeout;
  globalThis.clearTimeout = window.clearTimeout = ((id: number) => {
    pending = pending.filter((timer) => timer.id !== id);
  }) as typeof globalThis.clearTimeout;

  try {
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Corner radius"]');
    assert.ok(input);
    const valueBefore = input.value;
    const help = container.querySelector<HTMLButtonElement>('button[aria-label="About Corner radius"]');
    assert.ok(help);

    await act(async () => {
      help.dispatchEvent(new Event('focus'));
      const timers = pending;
      pending = [];
      timers.forEach((timer) => timer.fn());
    });

    const tooltip = Array.from(document.querySelectorAll<HTMLElement>('[role="tooltip"]'))
      .find((element) => element.style.display === 'block');
    assert.ok(tooltip);
    assert.match(tooltip.textContent ?? '', /Roundness of cards, buttons, and inputs across the panel\./);
    assert.equal(input.value, valueBefore);
  } finally {
    globalThis.setTimeout = window.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = window.clearTimeout = originalClearTimeout;
  }
});

test('SliderRow preserves native range attributes, disabled state, formatted value, and callback', () => {
  const values: number[] = [];
  act(() => render(h(SliderRow, {
    label: 'Test range',
    value: 7,
    min: 1,
    max: 10,
    step: 2,
    formatValue: (value) => `${value} units`,
    hint: 'Range description.',
    disabled: true,
    onChange: (value) => values.push(value),
  }), container));

  const row = container.querySelector<HTMLElement>('.toolbar-settings-slider-row');
  assert.ok(row);
  assert.equal(row.children.length, 3);
  assert.ok(row.children[0].classList.contains('toolbar-settings-ui-control-head'));
  assert.equal(row.children[1].tagName, 'INPUT');
  assert.equal(row.children[2].className, 'toolbar-settings-ui-control-value');
  const input = container.querySelector<HTMLInputElement>('input[type="range"]');
  assert.ok(input);
  assert.equal(input.getAttribute('aria-label'), 'Test range');
  assert.equal(input.getAttribute('aria-valuetext'), '7 units');
  assert.equal(input.min, '1');
  assert.equal(input.max, '10');
  assert.equal(input.step, '2');
  assert.equal(input.value, '7');
  assert.equal(input.disabled, true);
  assert.equal(container.querySelector('.toolbar-settings-ui-control-value')?.textContent, '7 units');
  act(() => {
    input.value = '9';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.deepEqual(values, [9]);
});
