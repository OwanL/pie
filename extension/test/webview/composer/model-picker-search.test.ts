import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../../_helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { ModelPicker } from '../../../src/webview/panel/components/model-picker';
import type { ModelPickerEntry } from '../../../src/webview/panel/composer/model-list';

let container: HTMLElement;

beforeEach(() => {
  // Defensive: clear any portaled dropdowns left over from a prior test so
  // document.querySelector never grabs a stale one.
  document.querySelectorAll('.model-picker-dropdown').forEach((el) => el.remove());
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  render(null, container);
  container.remove();
  document.querySelectorAll('.model-picker-dropdown').forEach((el) => el.remove());
});

interface Seed {
  id: string;
  name: string;
  provider: string;
}

const MODELS: Seed[] = [
  { id: 'gpt-5', name: 'GPT-5', provider: 'openai' },
  { id: 'claude-opus', name: 'Claude Opus 4', provider: 'anthropic' },
  { id: 'claude-sonnet', name: 'Claude Sonnet 4', provider: 'anthropic' },
  { id: 'gemini-pro', name: 'Gemini 2.5 Pro', provider: 'google' },
];

function entries(): ModelPickerEntry[] {
  return MODELS.map((m) => ({
    model: { id: m.id, name: m.name, provider: m.provider, reasoning: false, inputKinds: ['text'] } as ModelPickerEntry['model'],
    label: m.name,
    selectedLabel: m.name,
    ineligible: false,
    title: '',
    tokenInPrice: '$1.00',
    tokenOutPrice: '$2.00',
    supportsImages: false,
  }));
}

function click(el: Element | null): void {
  assert.ok(el, 'target element not found');
  el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** Open the dropdown and return the (portaled) dropdown element for this test. */
function openDropdown(): HTMLElement {
  const before = new Set(Array.from(document.querySelectorAll('.model-picker-dropdown')));
  const wrapper = container.querySelector('.model-picker');
  assert.ok(wrapper, '.model-picker wrapper should render');
  act(() => click(wrapper!.querySelector('.model-picker-trigger')));
  // Pick the dropdown that was added by this click, ignoring any stale leftovers.
  const dropdown = Array.from(document.querySelectorAll('.model-picker-dropdown')).find(
    (el) => !before.has(el),
  ) as HTMLElement | undefined;
  assert.ok(dropdown, 'dropdown should render when opened');
  return dropdown!;
}

function searchInput(dropdown: HTMLElement): HTMLInputElement {
  const input = dropdown.querySelector('.model-picker-search') as HTMLInputElement | null;
  assert.ok(input, 'search input should be present');
  return input!;
}

function rowLabels(dropdown: HTMLElement): string[] {
  return Array.from(dropdown.querySelectorAll('.model-picker-rows .model-picker-col-name')).map((el) =>
    (el as HTMLElement).textContent?.trim(),
  ).filter((t): t is string => Boolean(t));
}

function type(input: HTMLInputElement, value: string): void {
  act(() => {
    input.value = value;
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
}

function keydown(input: HTMLInputElement, key: string): void {
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

test('ModelPicker dropdown renders a search input when opened', () => {
  act(() => {
    render(
      h(ModelPicker, {
        value: 'gpt-5',
        label: 'GPT-5',
        ariaLabel: 'Model',
        title: 'Select model',
        entries: entries(),
        onChange: () => undefined,
      }),
      container,
    );
  });

  // Closed initially: no search input.
  assert.ok(!document.querySelector('.model-picker-search'));

  const dropdown = openDropdown();
  const input = searchInput(dropdown);
  assert.equal(input.getAttribute('placeholder'), 'Search models…');
  assert.equal(input.getAttribute('role'), 'combobox');
  assert.equal(input.getAttribute('aria-haspopup'), 'listbox');
  // The combobox references its listbox via aria-controls, and that element is the listbox.
  const controlsId = input.getAttribute('aria-controls');
  assert.ok(controlsId, 'combobox should reference its listbox via aria-controls');
  const listbox = document.getElementById(controlsId!);
  assert.ok(listbox, 'aria-controls should point to an existing listbox element');
  assert.equal(listbox!.getAttribute('role'), 'listbox');
});

test('typing into the search input filters the visible rows', () => {
  act(() => {
    render(
      h(ModelPicker, {
        value: 'gpt-5',
        label: 'GPT-5',
        ariaLabel: 'Model',
        title: 'Select model',
        entries: entries(),
        onChange: () => undefined,
      }),
      container,
    );
  });

  const dropdown = openDropdown();
  assert.equal(rowLabels(dropdown).length, 4);

  const input = searchInput(dropdown);
  // "claude" matches the two Anthropic models (matched against name / id / provider).
  type(input, 'claude');
  assert.deepEqual(rowLabels(dropdown), ['Claude Opus 4', 'Claude Sonnet 4']);

  // Narrowing further to a single match.
  type(input, 'sonnet');
  assert.deepEqual(rowLabels(dropdown), ['Claude Sonnet 4']);
});

test('a query with no matches shows an empty state and no rows', () => {
  act(() => {
    render(
      h(ModelPicker, {
        value: 'gpt-5',
        label: 'GPT-5',
        ariaLabel: 'Model',
        title: 'Select model',
        entries: entries(),
        onChange: () => undefined,
      }),
      container,
    );
  });

  const dropdown = openDropdown();
  const input = searchInput(dropdown);
  type(input, 'zzz-nomatch');
  assert.equal(rowLabels(dropdown).length, 0);
  const empty = dropdown.querySelector('.model-picker-empty');
  assert.ok(empty, 'empty state should render when nothing matches');
  assert.match(empty!.textContent ?? '', /No models match/);

  keydown(input, 'Tab');
  assert.equal(document.querySelector('.model-picker-dropdown'), null, 'Tab should close an empty result list');
});

test('Enter selects the top filtered match', () => {
  let selected: string | undefined;
  act(() => {
    render(
      h(ModelPicker, {
        value: 'gpt-5',
        label: 'GPT-5',
        ariaLabel: 'Model',
        title: 'Select model',
        entries: entries(),
        onChange: (spec: string) => {
          selected = spec;
        },
      }),
      container,
    );
  });

  const dropdown = openDropdown();
  const input = searchInput(dropdown);
  // Filter to a single match, then commit with Enter.
  type(input, 'sonnet');
  assert.deepEqual(rowLabels(dropdown), ['Claude Sonnet 4']);
  keydown(input, 'Enter');
  // The picker emits `provider/id` so callers can route unambiguously.
  assert.equal(selected, 'anthropic/claude-sonnet');
  // Selecting closes this dropdown (it is unmounted from the document).
  assert.equal(dropdown.isConnected, false);
});

test('clearing the query restores the full list', () => {
  act(() => {
    render(
      h(ModelPicker, {
        value: 'gpt-5',
        label: 'GPT-5',
        ariaLabel: 'Model',
        title: 'Select model',
        entries: entries(),
        onChange: () => undefined,
      }),
      container,
    );
  });

  const dropdown = openDropdown();
  const input = searchInput(dropdown);
  type(input, 'sonnet');
  assert.equal(rowLabels(dropdown).length, 1);
  type(input, '');
  assert.equal(rowLabels(dropdown).length, 4);
});
