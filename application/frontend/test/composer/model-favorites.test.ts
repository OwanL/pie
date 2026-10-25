import assert from 'node:assert/strict';
import test from 'node:test';
import { h, render } from 'preact';
import { useContext } from 'preact/hooks';
import { act } from 'preact/test-utils';
import { installDom } from '../helpers/dom';
import { ModelFavoritesContext, ModelFavoritesProvider } from '../../settings/model-favorites';

installDom();

function Consumer({ id }: { id: string }) {
  const { favorites, onToggle, disabled } = useContext(ModelFavoritesContext);
  return h('button', {
    'data-consumer': id,
    disabled,
    onClick: () => onToggle(id),
  }, favorites.join(','));
}

test('all model pickers share rapid favorite intent and reconcile delayed host echoes', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const commits: string[][] = [];
  const paint = (favorites: string[], disabled = false) => act(() => render(h(ModelFavoritesProvider, {
    favorites, disabled, onChange: (next: string[]) => { commits.push(next); },
    children: [h(Consumer, { id: 'one/shared' }), h(Consumer, { id: 'two/shared' })],
  }), container));
  const buttons = () => [...container.querySelectorAll<HTMLButtonElement>('button')];
  try {
    paint(['absent/model']);
    // Both edits happen before rendering, so the second must build on intent,
    // not on the previous host echo or the previous render's closure.
    act(() => { buttons()[0].click(); buttons()[1].click(); });
    assert.deepEqual(commits, [
      ['absent/model', 'one/shared'],
      ['absent/model', 'one/shared', 'two/shared'],
    ]);
    assert.ok(buttons().every((button) => button.textContent === 'absent/model,one/shared,two/shared'));
    paint(commits[0]);
    assert.ok(buttons().every((button) => button.textContent === 'absent/model,one/shared,two/shared'));
    paint(commits[1]);
    act(() => buttons()[0].click());
    assert.deepEqual(commits[2], ['absent/model', 'two/shared']);
    paint(commits[2]);
    paint(['external/change']);
    assert.ok(buttons().every((button) => button.textContent === 'external/change'));
    paint(['external/change'], true);
    act(() => buttons()[0].click());
    assert.equal(commits.length, 3, 'disconnected pickers cannot emit a write');
  } finally {
    act(() => render(null, container));
    container.remove();
  }
});

test('remount restores the authoritative saved favorites, not earlier local intent', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const paint = (key: string, favorites: string[]) => act(() => render(h(ModelFavoritesProvider, {
    key, favorites, onChange: () => {}, children: h(Consumer, { id: 'one/shared' }),
  }), container));
  try {
    paint('host-one', []);
    act(() => container.querySelector<HTMLButtonElement>('button')!.click());
    assert.equal(container.textContent, 'one/shared');
    paint('host-two', ['saved/model']);
    assert.equal(container.textContent, 'saved/model');
  } finally {
    act(() => render(null, container));
    container.remove();
  }
});
