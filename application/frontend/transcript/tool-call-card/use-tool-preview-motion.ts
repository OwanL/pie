import { useLayoutEffect, useRef } from 'preact/hooks';

/** Animate occupied space, never the current preview text or its semantics. */
export function useToolPreviewMotion(revision: string, open: boolean) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const state = useRef({ height: 0, initialized: false, open, revision, animation: null as Animation | null, target: 0 });
  const retargetRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const content = contentRef.current;
    if (!wrapper || !content) return;
    const s = state.current;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const settle = () => {
      const animation = s.animation;
      s.animation = null;
      animation?.cancel();
      wrapper.style.removeProperty('height');
      wrapper.removeAttribute('data-preview-moving');
      s.height = content.getBoundingClientRect().height;
    };
    const retarget = () => {
      const to = content.getBoundingClientRect().height;
      if (s.animation && Math.abs(to - s.target) < 0.5) return;
      const from = s.animation ? wrapper.getBoundingClientRect().height : s.height;
      if (reduced?.matches || typeof wrapper.animate !== 'function' || Math.abs(to - from) < 0.5) { settle(); return; }
      s.animation?.cancel();
      s.target = to;
      wrapper.style.height = `${to}px`;
      wrapper.setAttribute('data-preview-moving', 'true');
      const animation = wrapper.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 160, easing: 'ease-out', fill: 'both' });
      s.animation = animation;
      void animation.finished.then(() => { if (s.animation === animation) settle(); }, () => undefined);
    };
    retargetRef.current = retarget;
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
      const height = content.getBoundingClientRect().height;
      if (s.animation) { if (Math.abs(height - s.target) >= 0.5) retarget(); }
      else s.height = height; // Idle font/viewport changes do not animate.
    }) : null;
    observer?.observe(content);
    const onChange = () => { if (reduced?.matches) settle(); };
    reduced?.addEventListener?.('change', onChange);
    return () => {
      observer?.disconnect();
      reduced?.removeEventListener?.('change', onChange);
      retargetRef.current = null;
      settle();
    };
  }, []);

  useLayoutEffect(() => {
    const s = state.current;
    const height = contentRef.current?.getBoundingClientRect().height ?? 0;
    const manual = s.open !== open;
    const changed = s.revision !== revision;
    s.open = open;
    s.revision = revision;
    if (!s.initialized || manual) {
      s.initialized = true;
      const animation = s.animation;
      s.animation = null;
      animation?.cancel();
      wrapperRef.current?.style.removeProperty('height');
      wrapperRef.current?.removeAttribute('data-preview-moving');
      s.height = height;
    } else if (changed) retargetRef.current?.();
  });
  return { wrapperRef, contentRef };
}
