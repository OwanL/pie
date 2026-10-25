import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { animateHeightChange, cancelHeightMotion } from './height-motion';

/** Own occupied space while the separate flow-root content stays natural. */
export function useDisclosureMotion(open: boolean, enabled = true) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [retained, setRetained] = useState(open);
  const state = useRef({ open, height: 0, initialized: false });
  const currentOpen = useRef(open);
  currentOpen.current = open;
  const mounted = open || retained;

  const measure = () => {
    const s = state.current;
    const changed = s.open !== open;
    s.open = open;
    const body = bodyRef.current;
    const content = contentRef.current;
    if (!body || !content) { s.initialized = false; return; }
    const height = content.getBoundingClientRect().height;
    const previousHeight = s.height;
    const initialized = s.initialized;
    s.initialized = true;
    s.height = height;
    if (!enabled) {
      cancelHeightMotion(body);
      body.style.removeProperty('height');
      body.style.removeProperty('--disclosure-height');
      setRetained(open);
      return;
    }
    // Keep occupied space owned between observer deliveries, not just during
    // motion. Otherwise a descendant's async Markdown commit exposes its full
    // natural height for one paint before this observer can hold the old box.
    // A variable lets animateHeightChange restore the inline style while its
    // destination remains the newly measured size, including reduced motion.
    body.style.height = 'var(--disclosure-height)';
    const commit = () => body.style.setProperty('--disclosure-height', `${open ? height : 0}px`);
    if (changed) {
      if (open) setRetained(true);
      animateHeightChange(body, commit, open ? { from: 0 } : undefined);
      if (!body.hasAttribute('data-height-moving')) setRetained(open);
    } else if (open && initialized && Math.abs(height - previousHeight) >= 0.5) {
      // An idle parent follows a child's animated space without adding a second
      // interpolation. A moving parent retargets instead of exposing its body.
      if (!body.hasAttribute('data-height-moving')
        && content.querySelector('[data-height-moving], [data-preview-moving]')) commit();
      else animateHeightChange(body, commit, { from: previousHeight, duration: 160, easing: 'ease-out' });
    } else if (!initialized || !body.style.getPropertyValue('--disclosure-height')) commit();
  };
  const measureRef = useRef(measure);
  measureRef.current = measure;

  // React-owned changes must be held before the virtualizer's row observer can
  // cache their expanded natural height. RO alone runs too late for that frame.
  useLayoutEffect(measure);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const content = contentRef.current;
    if (!body || !content) return;
    const settle = () => setRetained(currentOpen.current);
    body.addEventListener('height-motion-end', settle);
    const observer = typeof ResizeObserver === 'undefined' ? undefined
      : new ResizeObserver(() => measureRef.current());
    observer?.observe(content);
    return () => {
      observer?.disconnect();
      body.removeEventListener('height-motion-end', settle);
      cancelHeightMotion(body);
    };
  }, [mounted]);

  return { bodyRef, contentRef, mounted };
}
