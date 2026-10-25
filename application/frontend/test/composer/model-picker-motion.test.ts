import assert from 'node:assert/strict';
import test from 'node:test';
import { h, render } from 'preact';
import { useRef } from 'preact/hooks';
import { act } from 'preact/test-utils';
import { installDom } from '../helpers/dom';
import { modelMotionCatalogKey, useModelFavoriteMotion } from '../../settings/use-model-favorite-motion';
import { orderModelsForPicker } from '../../composer/model-list';
installDom();

test('favorite FLIP retargets live positions, gates unrelated updates, and cancels cleanly', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let capture = (_initiatingKey: string) => {};
  let keys = ['p/a', 'p/b', 'other/a'];
  let activeIndex = 0;
  let favorites: string[] = [];
  let query = '';
  let sort = 'name/false';
  let viewportHeight = 60;
  let catalogEntries = orderModelsForPicker([
    { id: 'a', provider: 'p', name: 'A', reasoning: false, inputKinds: ['text'] },
  ]);
  let removedProviders: string[] = [];
  let catalog = modelMotionCatalogKey(catalogEntries, removedProviders);
  let reduced = false;
  let preferenceChanged = () => {};
  const matchMedia = window.matchMedia;
  window.matchMedia = (() => ({
    get matches() { return reduced; },
    addEventListener: (_: string, callback: () => void) => { preferenceChanged = callback; },
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  const animations: { frames: Keyframe[]; options: KeyframeAnimationOptions; canceled: boolean; onfinish: (() => void) | null; cancel: () => void }[] = [];
  let liveOffset = 0;
  const rect = (top: number, height: number) => ({ top, bottom: top + height, height, width: 100, left: 0, right: 100 }) as DOMRect;
  function Harness() {
    const ref = useRef<HTMLDivElement>(null);
    capture = useModelFavoriteMotion(ref, { catalog, query, sort, keys, favorites });
    return h('div', { ref: (node: HTMLDivElement | null) => {
      ref.current = node;
      if (node) node.getBoundingClientRect = () => rect(0, viewportHeight);
    } }, keys.map((key, index) => h('div', { key, 'data-model-key': key,
      class: index === activeIndex ? 'model-picker-row-active' : 'model-picker-row',
      ref: (node: HTMLDivElement | null) => {
        if (!node) return;
        node.getBoundingClientRect = () => rect(index * 20 + liveOffset, 20);
        node.animate = ((frames: Keyframe[], options: KeyframeAnimationOptions) => {
          const record = { frames, options, canceled: false, onfinish: null as (() => void) | null, cancel: () => { record.canceled = true; } };
          animations.push(record);
          return record as unknown as Animation;
        }) as typeof node.animate;
      } }, key)));
  }
  const update = () => act(() => render(h(Harness, {}), container));
  const toggle = () => {
    capture('other/a');
    favorites = favorites.length ? [] : ['other/a'];
    keys = favorites.length ? ['other/a', 'p/a', 'p/b'] : ['p/a', 'p/b', 'other/a'];
    update();
  };
  try {
    update();
    assert.equal(animations.length, 0, 'opening does not replay motion');
    const original = container.querySelector('[data-model-key="other/a"]');
    capture('other/a');
    // Host snapshots deserialize catalogs and favorites before/with setPrefs.
    catalogEntries = JSON.parse(JSON.stringify(catalogEntries));
    removedProviders = [...removedProviders];
    catalog = modelMotionCatalogKey(catalogEntries, removedProviders);
    favorites = [...favorites];
    activeIndex = 1;
    update();
    assert.equal(animations.length, 0, 'incidental snapshot does not animate or consume First');
    favorites = ['other/a'];
    keys = ['other/a', 'p/a', 'p/b'];
    catalogEntries = JSON.parse(JSON.stringify(catalogEntries));
    catalog = modelMotionCatalogKey(catalogEntries, [...removedProviders]);
    update();
    assert.ok(container.firstElementChild?.firstElementChild === original, 'DOM order and keyed identity change immediately');
    assert.equal(animations.length, 3);
    assert.deepEqual(animations[0].options, { duration: 180, easing: 'ease-out' });
    assert.equal(animations[0].frames[0].transform, 'translateY(40px)');
    const movingRow = container.querySelector<HTMLElement>('[data-model-key="other/a"]')!;
    assert.equal(movingRow.getAttribute('data-model-moving'), '');
    assert.equal(movingRow.getAttribute('data-model-motion-primary'), '', 'initiating row is raised above crossing siblings');
    activeIndex = 1;
    update();
    assert.equal(movingRow.className, 'model-picker-row', 'pointer movement rewrites the active row class');
    assert.equal(movingRow.getAttribute('data-model-moving'), '', 'motion annotation survives the keyed row class rewrite');
    animations[0].onfinish?.();
    assert.equal(movingRow.hasAttribute('data-model-moving'), false, 'finish removes the unowned motion annotation');
    animations[1].onfinish?.();
    animations[2].onfinish?.();
    assert.equal(container.querySelectorAll('[data-model-motion-primary]').length, 0, 'last finish clears the primary stacking annotation');
    // Simulate a current compositor position rather than the previous final layout.
    liveOffset = 7;
    capture('other/a');
    liveOffset = 0;
    favorites = [];
    keys = ['p/a', 'p/b', 'other/a'];
    update();
    assert.ok(animations.slice(0, 3).every(animation => animation.canceled));
    assert.equal(animations[3].frames[0].transform, 'translateY(27px)');
    reduced = true;
    preferenceChanged();
    assert.ok(animations.every(animation => animation.canceled));
    assert.equal(container.querySelectorAll('[data-model-moving]').length, 0);
    assert.equal(container.querySelectorAll('[data-model-motion-primary]').length, 0, 'cancel clears the primary stacking annotation');
    const count = animations.length;
    toggle();
    assert.equal(animations.length, count, 'reduced motion is immediate');
    reduced = false;
    capture('p/a'); query = 'a'; favorites = []; update();
    assert.equal(animations.length, count, 'query changes invalidate pending FLIP');
    capture('p/a'); sort = 'input/false'; favorites = ['p/b']; update();
    assert.equal(animations.length, count, 'cost sorting invalidates pending FLIP');
    capture('p/a');
    catalogEntries = catalogEntries.map(entry => ({ ...entry, title: 'Updated pricing metadata' }));
    catalog = modelMotionCatalogKey(catalogEntries, removedProviders);
    favorites = []; update();
    assert.equal(animations.length, count, 'catalog changes invalidate pending FLIP');
    capture('p/a'); favorites = []; keys = ['p/a']; update();
    assert.equal(animations.length, count, 'membership changes invalidate pending FLIP');
    keys = ['p/a', 'p/b', 'other/a']; update();
    toggle();
    container.firstElementChild!.dispatchEvent(new Event('scroll'));
    assert.ok(animations.every(animation => animation.canceled));
    toggle();
    window.dispatchEvent(new Event('resize'));
    assert.ok(animations.every(animation => animation.canceled));
    viewportHeight = 20;
    const beforeOffscreenToggle = animations.length;
    toggle();
    assert.equal(animations.length, beforeOffscreenToggle, 'rows must be visible both before and after a move');
    viewportHeight = 60;
    toggle();
    act(() => render(null, container));
    assert.ok(animations.every(animation => animation.canceled), 'unmount cancels compositor effects');
  } finally {
    act(() => render(null, container));
    container.remove();
    window.matchMedia = matchMedia;
  }
});
