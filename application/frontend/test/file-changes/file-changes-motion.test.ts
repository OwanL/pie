import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom } from '../helpers/dom';
installDom();
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { useRef } from 'preact/hooks';
import { useFileChangesMotion } from '../../file-changes/use-file-changes-motion';

test('rail motion reverses from rendered width and releases clipping on reduced motion / lifecycle', () => {
  const root = document.createElement('div');
  document.body.append(root);
  const originalMedia = window.matchMedia;
  let reduced = false;
  const listeners = new Set<() => void>();
  window.matchMedia = (() => ({ matches: reduced, addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) })) as unknown as typeof window.matchMedia;
  let currentWidth = 130;
  const animations: { frames: Keyframe[]; cancelled: boolean; onfinish: null | (() => void); cancel: () => void }[] = [];
  function Fixture({ pinned, visible = true, marker = '' }: { pinned: boolean; visible?: boolean; marker?: string }) {
    const ref = useRef<HTMLDivElement>(null);
    useFileChangesMotion(ref, pinned, visible);
    return visible ? h('div', { ref, class: ['file-changes-rail', pinned ? 'pinned' : '', marker].filter(Boolean).join(' ') }, h('div', { class: 'file-changes-drawer-inner' })) : null;
  }
  const draw = (pinned: boolean, visible = true, marker = '') => act(() => render(h(Fixture, { pinned, visible, marker }), root));
  try {
    draw(false);
    const rail = root.firstElementChild as HTMLElement;
    rail.getBoundingClientRect = () => ({ width: rail.hasAttribute('data-layout-moving') ? currentWidth : rail.classList.contains('pinned') ? 261 : 48 }) as DOMRect;
    (rail.firstElementChild as HTMLElement).getBoundingClientRect = () => ({ width: 260 }) as DOMRect;
    rail.animate = ((frames: Keyframe[], options: KeyframeAnimationOptions) => {
      assert.equal(options.duration, 120);
      const animation = { frames, cancelled: false, onfinish: null, cancel() { this.cancelled = true; } };
      animations.push(animation);
      return animation;
    }) as unknown as typeof rail.animate;
    draw(true);
    assert.deepEqual(animations[0].frames, [{ width: '48px' }, { width: '261px' }]);
    assert.equal(rail.hasAttribute('data-layout-moving'), true);
    // A component render rewrites its owned class attribute during motion;
    // hook-owned data attributes must continue to activate clipping/fixed content.
    draw(true, true, 'updated-component-class');
    assert.equal(rail.classList.contains('updated-component-class'), true);
    assert.equal(rail.hasAttribute('data-layout-moving'), true);
    assert.equal(rail.matches('.file-changes-rail[data-layout-moving]'), true);
    draw(false);
    assert.equal(animations[0].cancelled, true);
    assert.deepEqual(animations[1].frames, [{ width: '130px' }, { width: '48px' }]);
    // An ordinary read/data render does not restart motion.
    draw(false);
    assert.equal(animations.length, 2);
    reduced = true;
    for (const listener of [...listeners]) listener();
    assert.equal(rail.hasAttribute('data-layout-moving'), false);
    assert.equal(rail.hasAttribute('data-layout-closing'), false);
    assert.equal(rail.style.getPropertyValue('--file-changes-motion-width'), '');
    draw(true);
    assert.equal(animations.length, 2);
    reduced = false;
    draw(false);
    draw(false, false);
    assert.equal(animations.at(-1)?.cancelled, true);
    draw(true);
    assert.equal(animations.length, 3); // Reappearance is not a pin animation.
    act(() => render(null, root));
    assert.equal(listeners.size, 0);
  } finally {
    act(() => render(null, root));
    root.remove();
    window.matchMedia = originalMedia;
  }
});
