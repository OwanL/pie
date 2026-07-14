import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../../_helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { ModelPicker } from '../../../src/webview/panel/components/model-picker';
import type { ModelPickerEntry } from '../../../src/webview/panel/composer/model-list';

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  return () => {
    render(null, container);
    container.remove();
    // Defensive: clear any portaled dropdown that escaped Preact's cleanup.
    document.querySelectorAll('.model-picker-dropdown').forEach((el) => el.remove());
  };
});

function entry(id: string): ModelPickerEntry {
  return {
    model: {
      id,
      name: id,
      provider: 'test',
      reasoning: false,
      inputKinds: ['text'],
    } as ModelPickerEntry['model'],
    label: id,
    selectedLabel: id,
    ineligible: false,
    title: '',
    tokenInPrice: '$1.00',
    tokenOutPrice: '$2.00',
    supportsImages: false,
  };
}

function click(el: Element | null): void {
  assert.ok(el, 'target element not found');
  el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

// Regression: the ModelPicker dropdown (min-width 380px in compact mode) used
// to be clipped when rendered inside the settings menu, because the menu's
// scroll container forces overflow-x to auto (CSS spec) and the inline dropdown
// extended past the menu's right edge. The fix portals the dropdown to
// document.body. This test pins the structural invariant: the open dropdown
// lives in the document but is NOT a descendant of its .model-picker wrapper
// (the overflow context that would clip it).
test('ModelPicker dropdown is portaled to document.body, escaping its wrapper overflow context', () => {
  act(() => {
    render(
      h(ModelPicker, {
        value: 'm1',
        label: 'Model One',
        ariaLabel: 'Model',
        title: 'Select model',
        entries: [entry('m1'), entry('m2')],
        onChange: () => undefined,
        compact: true,
        dropdownDirection: 'down',
      }),
      container,
    );
  });

  const wrapper = container.querySelector('.model-picker');
  assert.ok(wrapper, '.model-picker wrapper should render');

  // Closed initially: no dropdown in the document.
  assert.ok(!document.querySelector('.model-picker-dropdown'));

  act(() => {
    click(wrapper!.querySelector('.model-picker-trigger'));
  });

  const dropdown = document.querySelector('.model-picker-dropdown');
  assert.ok(dropdown, 'dropdown should render when the trigger is clicked');

  // Portaled: present in the document but NOT inside the .model-picker wrapper.
  assert.ok(
    document.body.contains(dropdown),
    'dropdown should be attached to the document',
  );
  assert.equal(
    dropdown!.closest('.model-picker'),
    null,
    'dropdown must be portaled out of .model-picker so an overflow ancestor cannot clip it',
  );
});
