import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom } from '../helpers/dom';
installDom();
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { useActivityFooterMotion } from '../../transcript/activity-status-motion';
import { TurnActivityStrip } from '../../transcript/turn-activity-strip';

test('footer space skips history/mount, reverses live geometry, and cleans up reduced motion', () => {
  const root = document.createElement('div');
  document.body.append(root);
  const originalMedia = window.matchMedia;
  const originalAnimate = HTMLElement.prototype.animate;
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  let reduced = false;
  const listeners = new Set<() => void>();
  const animations: { frames: Keyframe[]; cancelled: boolean; onfinish: null | (() => void); cancel(): void }[] = [];
  window.matchMedia = (() => ({ get matches() { return reduced; }, addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) })) as unknown as typeof window.matchMedia;
  HTMLElement.prototype.getBoundingClientRect = (() => ({ height: 13 })) as unknown as typeof originalRect;
  HTMLElement.prototype.animate = ((frames: Keyframe[]) => {
    const animation = { frames, cancelled: false, onfinish: null, cancel() { this.cancelled = true; } };
    animations.push(animation);
    return animation;
  }) as unknown as typeof originalAnimate;
  function Fixture({ active }: { active: boolean }) {
    const { ref, visible } = useActivityFooterMotion(active);
    return visible ? h('div', { ref, 'aria-hidden': active ? undefined : 'true' }, active ? h('span', { role: 'status' }, 'Running bash') : null) : null;
  }
  const draw = (active: boolean) => act(() => { render(h(Fixture, { active }), root); });
  try {
    draw(false);
    assert.equal(root.childElementCount, 0);
    draw(true);
    assert.equal(animations.length, 1);
    assert.equal(animations[0].frames[0].height, '0px');
    draw(false);
    assert.equal(animations[0].cancelled, true);
    assert.equal(animations[1].frames[0].height, '13px');
    assert.equal(root.querySelector('[role=status]'), null);
    assert.equal(root.firstElementChild?.getAttribute('aria-hidden'), 'true');
    draw(true);
    assert.equal(animations[1].cancelled, true);
    assert.equal(animations[2].frames[0].height, '13px');
    draw(false);
    reduced = true;
    act(() => { for (const listener of [...listeners]) listener(); });
    assert.equal(root.childElementCount, 0);
    assert.equal(animations.at(-1)?.cancelled, true);
    act(() => { render(null, root); });
    draw(true);
    assert.equal(animations.length, 4); // No initial-mount replay.
    act(() => { render(null, root); });
    assert.equal(listeners.size, 0);
  } finally {
    act(() => { render(null, root); });
    root.remove();
    window.matchMedia = originalMedia;
    HTMLElement.prototype.animate = originalAnimate;
    HTMLElement.prototype.getBoundingClientRect = originalRect;
  }
});

test('status replacements expose only the current label and do not replay unchanged renders', () => {
  const root = document.createElement('div');
  document.body.append(root);
  const original = HTMLElement.prototype.animate;
  let count = 0;
  let cancellations = 0;
  HTMLElement.prototype.animate = (() => { count++; return { cancel() { cancellations++; } }; }) as unknown as typeof original;
  const draw = (label: string) => act(() => { render(h(TurnActivityStrip, { label }), root); });
  try {
    draw('Thinking');
    assert.equal(count, 0);
    draw('Running bash');
    assert.equal(count, 1);
    assert.equal(root.querySelectorAll('[role=status]').length, 1);
    assert.equal(root.textContent?.includes('Thinking'), false);
    assert.equal(root.firstElementChild?.getAttribute('aria-label'), 'Activity status: Running bash');
    draw('Running bash');
    assert.equal(count, 1);
    draw('Preparing');
    assert.equal(cancellations, 1);
  } finally {
    act(() => { render(null, root); });
    root.remove();
    HTMLElement.prototype.animate = original;
  }
});
