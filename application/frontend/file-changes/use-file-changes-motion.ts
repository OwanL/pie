import { useLayoutEffect, useRef } from 'preact/hooks';
import type { RefObject } from 'preact';

/** Animate only pin changes, never initial appearance or ordinary data renders.
 * Measure the old DOM before the commit, then the natural CSS endpoint after it.
 * WAAPI owns the occupied width; no auto-width interpolation is required. */
export function useFileChangesMotion(railRef: RefObject<HTMLDivElement>, pinned: boolean, visible: boolean) {
  const previous = useRef<{ pinned: boolean; visible: boolean }>();
  const stop = useRef<() => void>(() => {});
  const old = previous.current;
  const changing = old?.visible && visible && old.pinned !== pinned;
  const from = changing ? railRef.current?.getBoundingClientRect().width : undefined;
  const oldInnerWidth = changing ? railRef.current?.querySelector<HTMLElement>('.file-changes-drawer-inner')?.getBoundingClientRect().width : undefined;

  useLayoutEffect(() => {
    previous.current = { pinned, visible };
    if (!visible) { stop.current(); return; }
    if (!changing) return;
    const rail = railRef.current;
    if (!rail) return;
    stop.current();
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (media?.matches || !rail.animate || from === undefined) return;
    const to = rail.getBoundingClientRect().width;
    const inner = rail.querySelector<HTMLElement>('.file-changes-drawer-inner');
    if (!inner || from === to) return;
    // Freeze content pixels, not its scale, while the outer rail clips it.
    rail.style.setProperty('--file-changes-motion-width', `${!pinned && oldInnerWidth ? oldInnerWidth : inner.getBoundingClientRect().width}px`);
    rail.setAttribute('data-layout-moving', '');
    if (!pinned) rail.setAttribute('data-layout-closing', '');
    const animation = rail.animate([{ width: `${from}px` }, { width: `${to}px` }], {
      duration: 120, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'both',
    });
    const cancel = () => {
      animation.onfinish = null;
      animation.cancel();
      rail.removeAttribute('data-layout-moving');
      rail.removeAttribute('data-layout-closing');
      rail.style.removeProperty('--file-changes-motion-width');
      media?.removeEventListener('change', cancel);
      window.removeEventListener('resize', cancel);
    };
    stop.current = cancel;
    animation.onfinish = cancel;
    media?.addEventListener('change', cancel);
    window.addEventListener('resize', cancel);
  });
  useLayoutEffect(() => () => stop.current(), []);
  return () => stop.current();
}
