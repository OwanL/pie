/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';

/** Ease inserted space and lifecycle swaps, independently of each card's fade. */
export function ToolCallRunMotion({ appending, layoutKey, children }: {
  appending: boolean;
  /** A draft can become a full card after its entrance has already finished. */
  layoutKey: string;
  children: ComponentChildren;
}) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const initialAppend = useRef(appending);
  const previousLayoutKey = useRef(layoutKey);
  const updateRef = useRef<((append: boolean) => void) | null>(null);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let animation: Animation | null = null;
    let naturalHeight = inner.getBoundingClientRect().height;
    let targetHeight = naturalHeight;

    const finish = () => {
      const previous = animation;
      animation = null;
      previous?.cancel();
      outer.style.removeProperty('overflow');
      naturalHeight = inner.getBoundingClientRect().height;
    };
    const animate = (from: number, to: number, marginTop = 0) => {
      animation?.cancel();
      // Content is already truthful in the DOM, but must not paint over the
      // existing footer while its occupied space is still opening.
      outer.style.overflow = 'clip';
      targetHeight = to;
      const next = outer.animate([
        { height: `${from}px`, marginTop: `${marginTop}px` },
        { height: `${to}px`, marginTop: '0px' },
      ], { duration: 180, easing: 'ease-out', fill: 'both' });
      animation = next;
      next.onfinish = () => {
        if (animation === next) finish();
      };
    };
    const update = (append: boolean) => {
      const height = inner.getBoundingClientRect().height;
      if (reduced.matches || typeof outer.animate !== 'function') {
        finish();
        return;
      }
      if (animation) {
        if (height !== targetHeight) {
          // Read before cancelling: the underlying auto height already includes
          // the new children, but the animation still holds the rendered height.
          animate(outer.getBoundingClientRect().height, height,
            parseFloat(getComputedStyle(outer).marginTop) || 0);
        }
      } else if (append && height !== naturalHeight) {
        animate(naturalHeight, height);
      }
      naturalHeight = height;
    };
    updateRef.current = update;
    if (initialAppend.current && !reduced.matches && typeof outer.animate === 'function') {
      const gap = outer.previousElementSibling && outer.parentElement
        ? parseFloat(getComputedStyle(outer.parentElement).rowGap) || 0 : 0;
      animate(0, naturalHeight, -gap);
    }
    // Observe only natural content, never the envelope's animated dimensions.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => update(false));
    observer?.observe(inner);
    const onReducedMotion = () => { if (reduced.matches) finish(); };
    reduced.addEventListener('change', onReducedMotion);
    return () => {
      updateRef.current = null;
      observer?.disconnect();
      reduced.removeEventListener('change', onReducedMotion);
      animation?.cancel();
    };
  }, []);

  useLayoutEffect(() => {
    const lifecycleChanged = previousLayoutKey.current !== layoutKey;
    previousLayoutKey.current = layoutKey;
    updateRef.current?.(appending || lifecycleChanged);
  });

  return <div class="tool-call-list" ref={outerRef}>
    <div class="tool-call-list-content" ref={innerRef}>{children}</div>
  </div>;
}
