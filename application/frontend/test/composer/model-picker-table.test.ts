import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../helpers/dom';
installDom();
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { ModelPicker } from '../../settings/model-picker';
import { ModelFavoritesContext } from '../../settings/model-favorites';
import { orderModelsForPicker, type ModelPickerEntry } from '../../composer/model-list';

function entry(id: string, price?: number, provider = 'p'): ModelPickerEntry {
  return orderModelsForPicker([{ id, name: id, provider, reasoning: false, inputKinds: ['text'],
    ...(price === undefined ? {} : { subagent: { eligible: true, pricing: { input: price, output: price, cacheRead: 0, cacheWrite: 0 } } }),
  }])[0];
}
test('stars and sortable headers retain menu, stable identity, focus and scoped Escape', () => {
  const container = document.createElement('div'); document.body.append(container);
  const selected: string[] = [];
  let favorites: readonly string[] = [];
  let rows = [entry('alpha', 2), entry('beta', 10), entry('beta', 0, 'other')];
  const paint = () => render(h(ModelFavoritesContext.Provider, { value: { favorites, disabled: false, onToggle: (spec: string) => {
    favorites = favorites.includes(spec) ? favorites.filter(s => s !== spec) : [...favorites, spec]; paint();
  } }, children: h(ModelPicker, { entries: rows, value: 'missing', label: 'Select', ariaLabel: 'Model', title: 'Model', onChange: s => selected.push(s) }) }), container);
  const key = (el: Element, key: string, shiftKey = false) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })); });
  let escaped = 0;
  const parentEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') escaped++; };
  document.addEventListener('keydown', parentEscape);
  try {
    act(paint);
    act(() => container.querySelector<HTMLButtonElement>('.model-picker-trigger')!.click());
    const input = document.querySelector<HTMLInputElement>('.model-picker-search')!;
    key(input, 'Enter'); assert.deepEqual(selected, []);
    key(input, 'ArrowDown');
    const active = input.getAttribute('aria-activedescendant');
    const star = document.querySelector<HTMLButtonElement>('[aria-label="Favorite p/beta"]')!;
    star.focus(); act(() => star.click());
    assert.ok(document.activeElement === star, 'favorite reorder retains focused star');
    assert.equal(star.getAttribute('aria-pressed'), 'true');
    assert.equal(input.getAttribute('aria-activedescendant'), active);
    assert.deepEqual(selected, []);
    assert.ok(document.querySelector('.model-picker-dropdown'));
    assert.equal(document.querySelector('[role=option] .model-picker-star'), null);
    const header = document.querySelector<HTMLButtonElement>('[aria-label="Sort by In"]')!;
    const sortDescription = () => document.getElementById(header.getAttribute('aria-describedby')!)?.textContent;
    act(() => header.click()); assert.equal(header.getAttribute('aria-pressed'), 'true');
    assert.equal(sortDescription(), 'Sorted ascending');
    act(() => header.click()); assert.equal(sortDescription(), 'Sorted descending');
    const listbox = document.querySelector('[role=listbox]')!;
    assert.equal(listbox.querySelector('button'), null, 'stars are outside the listbox');
    assert.deepEqual(listbox.getAttribute('aria-owns')?.split(' '), Array.from(document.querySelectorAll('[role=option]'), option => option.id));
    assert.equal(document.querySelector('[role=columnheader]'), null);
    assert.equal(input.getAttribute('aria-activedescendant'), active);
    rows = [...rows].reverse(); act(paint);
    assert.equal(input.getAttribute('aria-activedescendant'), active);
    input.focus(); key(input, 'Tab'); assert.ok(document.querySelector('.model-picker-dropdown'), 'Tab enters interactive controls');
    key(star, 'Escape');
    assert.equal(document.querySelector('.model-picker-dropdown'), null);
    assert.equal(escaped, 0, 'scoped Escape does not bubble to parent settings');
    assert.ok(document.activeElement === container.querySelector('.model-picker-trigger'), 'Escape restores trigger focus');
  } finally {
    document.removeEventListener('keydown', parentEscape);
    act(() => render(null, container)); container.remove();
  }
});
