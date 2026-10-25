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
test('row favorites and sortable headers retain menu, stable identity, focus and scoped Escape', () => {
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
    const row = Array.from(document.querySelectorAll<HTMLElement>('[role=option]')).find(el => el.getAttribute('aria-label')?.includes('p/beta'))!;
    input.focus();
    const context = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
    act(() => { row.dispatchEvent(context); });
    assert.equal(context.defaultPrevented, true);
    assert.ok(document.activeElement === input, 'favorite reorder retains search focus');
    assert.match(row.getAttribute('aria-label')!, /favorited/);
    assert.equal(row.querySelector('.model-picker-favorite')?.textContent, '★');
    assert.deepEqual(favorites, ['p/beta']);
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
    assert.equal(listbox.querySelector('button'), null);
    assert.equal(listbox.getAttribute('aria-owns'), null);
    assert.equal(listbox.children.length, rows.length);
    assert.ok(Array.from(listbox.children).every(el => el.getAttribute('role') === 'option'));
    assert.equal(document.querySelector('[role=columnheader]'), null);
    assert.equal(input.getAttribute('aria-activedescendant'), active);
    rows = [...rows].reverse(); act(paint);
    assert.equal(input.getAttribute('aria-activedescendant'), active);
    input.focus(); key(input, 'Tab'); assert.ok(document.querySelector('.model-picker-dropdown'), 'Tab enters interactive controls');
    key(input, 'Escape');
    assert.equal(document.querySelector('.model-picker-dropdown'), null);
    assert.equal(escaped, 0, 'scoped Escape does not bubble to parent settings');
    assert.ok(document.activeElement === container.querySelector('.model-picker-trigger'), 'Escape restores trigger focus');
  } finally {
    document.removeEventListener('keydown', parentEscape);
    act(() => render(null, container)); container.remove();
  }
});


test('favorite keyboard shortcuts require an active catalog identity and honor disabled context', () => {
  const container = document.createElement('div'); document.body.append(container);
  let favorites: readonly string[] = ['unknown/missing'];
  let disabled = false;
  const toggled: string[] = [];
  const paint = () => {
    render(h(ModelFavoritesContext.Provider, { value: { favorites, disabled, onToggle: (spec: string) => {
      toggled.push(spec);
      favorites = favorites.includes(spec) ? favorites.filter(s => s !== spec) : [...favorites, spec];
      paint();
    } }, children: h(ModelPicker, { entries: [entry('same', 1, 'a'), entry('same', 1, 'b')],
      value: 'unknown/missing', label: 'Unknown', ariaLabel: 'Model', title: 'Model',
      onChange: () => assert.fail('favorite shortcuts must not select') }) }), container);
  };
  const key = (input: HTMLInputElement, key: string, shiftKey = false) => {
    const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
    act(() => { input.dispatchEvent(event); });
    return event;
  };
  try {
    act(paint);
    act(() => { container.querySelector<HTMLButtonElement>('button')!.click(); });
    const input = document.querySelector<HTMLInputElement>('.model-picker-search')!;
    input.focus();
    assert.match(input.getAttribute('aria-description')!, /Shift\+F10/);
    assert.equal(key(input, 'ContextMenu').defaultPrevented, true);
    key(input, 'F10', true);
    assert.deepEqual(toggled, []);
    key(input, 'Home');
    const active = input.getAttribute('aria-activedescendant');
    key(input, 'F10', true);
    assert.deepEqual(favorites, ['unknown/missing', 'a/same']);
    assert.equal(input.getAttribute('aria-activedescendant'), active);
    assert.equal(document.querySelectorAll('.model-picker-favorite').length, 1);
    assert.ok(document.activeElement === input);
    key(input, 'ContextMenu');
    assert.deepEqual(favorites, ['unknown/missing']);
    disabled = true; act(paint);
    key(input, 'ContextMenu');
    const row = document.querySelector('[role=option]')!;
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    act(() => { row.dispatchEvent(event); });
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(toggled, ['a/same', 'a/same']);
    assert.ok(document.querySelector('.model-picker-dropdown'));
  } finally { act(() => { render(null, container); }); container.remove(); }
});
