import { useLayoutEffect, useRef, useState } from 'preact/hooks';

/** Only logical disclosure changes animate; settled content uses natural height. */
export function useToolDisclosureMotion(open: boolean, enabled: boolean) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [retained, setRetained] = useState(open);
  const previous = useRef(open);

  useLayoutEffect(() => {
    const changed = previous.current !== open;
    previous.current = open;
    const body = bodyRef.current;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!body || !enabled || !changed || reduced?.matches || typeof body.animate !== 'function') {
      setRetained(open);
      if (body) body.style.removeProperty('height');
      return;
    }

    setRetained(true);
    // A cancelled transition leaves its current pixel height for reversal.
    const from = body.style.height ? body.getBoundingClientRect().height : open ? 0 : body.getBoundingClientRect().height;
    const to = open ? body.scrollHeight : 0;
    const animation = body.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      duration: 200, easing: 'ease-in-out', fill: 'both',
    });
    let active = true;
    const finish = () => {
      if (!active) return;
      active = false;
      animation.cancel();
      body.style.removeProperty('height');
      setRetained(open);
    };
    void animation.finished.then(finish, () => undefined);
    const onMotionChange = () => { if (reduced?.matches) finish(); };
    reduced?.addEventListener('change', onMotionChange);
    return () => {
      reduced?.removeEventListener('change', onMotionChange);
      if (active) {
        body.style.height = `${body.getBoundingClientRect().height}px`;
        active = false;
        animation.cancel();
      }
    };
  }, [open, enabled]);

  return { bodyRef, mounted: open || retained };
}
