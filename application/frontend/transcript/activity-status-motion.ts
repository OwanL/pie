import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';

/** Only the footer's occupied space moves, never a virtual transcript row. */
export function useActivityFooterMotion(active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [retained, setRetained] = useState(active);
  const previous = useRef(active);
  const animation = useRef<Animation | null>(null);
  const height = useRef(0);
  const mounted = useRef(false);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) { previous.current = active; mounted.current = true; return; }
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const stop = () => {
      animation.current?.cancel();
      animation.current = null;
      node.removeAttribute('data-space-moving');
    };
    const settle = () => { stop(); setRetained(active); };
    const onMedia = () => { if (media.matches) settle(); };
    media.addEventListener('change', onMedia);
    const changed = previous.current !== active;
    previous.current = active;
    const wasMounted = mounted.current;
    mounted.current = true;
    if (active) setRetained(true);
    if (changed && wasMounted && !media.matches && typeof node.animate === 'function') {
      const liveHeight = animation.current ? node.getBoundingClientRect().height : active ? 0 : height.current;
      const liveMargin = animation.current ? getComputedStyle(node).marginTop : active ? '' : '0px';
      stop();
      const gap = node.previousElementSibling && node.parentElement
        ? parseFloat(getComputedStyle(node.parentElement).rowGap) || 0 : 0;
      const natural = active ? node.scrollHeight : 0;
      if (active) height.current = natural;
      node.setAttribute('data-space-moving', '');
      const next = node.animate([
        { height: `${liveHeight}px`, marginTop: liveMargin || `${-gap}px` },
        { height: `${natural}px`, marginTop: active ? '0px' : `${-gap}px` },
      ], { duration: 160, easing: 'cubic-bezier(0.2, 0, 0, 1)', fill: 'both' });
      animation.current = next;
      next.onfinish = () => { if (animation.current === next) settle(); };
    } else if (!active || media.matches) settle();
    else height.current = node.getBoundingClientRect().height;
    const observer = active && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
      if (!animation.current) height.current = node.getBoundingClientRect().height;
    }) : null;
    observer?.observe(node);
    // Keep in-flight geometry available across reversals; only detach observers.
    return () => { media.removeEventListener('change', onMedia); observer?.disconnect(); };
  }, [active]);

  useLayoutEffect(() => () => { animation.current?.cancel(); }, []);
  return { ref, visible: active || retained };
}

/** Update the real label immediately, then quietly settle it without replay on mount. */
export function useActivityLabelMotion(ref: RefObject<HTMLDivElement>, label: string, detail?: string) {
  const previous = useRef({ label, detail });
  useLayoutEffect(() => {
    const changed = previous.current.label !== label || previous.current.detail !== detail;
    previous.current = { label, detail };
    const node = ref.current;
    if (!changed || !node || typeof node.animate !== 'function') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (media.matches) return;
    const animation = node.animate([{ opacity: 0.55 }, { opacity: 1 }], { duration: 140, easing: 'ease-out' });
    const stop = () => animation.cancel();
    media.addEventListener('change', stop);
    return () => { stop(); media.removeEventListener('change', stop); };
  }, [label, detail]);
}
