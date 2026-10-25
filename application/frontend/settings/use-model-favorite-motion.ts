import { useLayoutEffect, useRef } from 'preact/hooks';
import type { ModelPickerEntry } from '../composer/model-list';

/** Wire snapshots replace arrays/objects even when the catalog is unchanged.
 * Include metadata, not just membership, so real catalog refreshes invalidate FLIP. */
export function modelMotionCatalogKey(entries: readonly ModelPickerEntry[], removedProviderIds: readonly string[]): string {
  return JSON.stringify([entries, [...removedProviderIds].sort()], (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
      : value);
}

interface MotionContext {
  catalog: string;
  query: string;
  sort: string;
  keys: string[];
  favorites: readonly string[];
}
interface Snapshot {
  context: MotionContext;
  initiatingKey: string;
  positions: Map<string, DOMRect>;
  scrollTop: number;
  width: number;
  height: number;
}

/** Only an explicit favorite gesture may supply the First half of FLIP.
 * Read live rectangles before canceling so interrupted moves retarget smoothly. */
export function useModelFavoriteMotion(
  rowsRef: { current: HTMLDivElement | null },
  context: MotionContext,
) {
  const pending = useRef<Snapshot | null>(null);
  const running = useRef(new Map<HTMLElement, Animation>());
  const media = useRef<MediaQueryList | null>(null);
  const cancel = () => {
    pending.current = null;
    for (const [row, animation] of running.current) {
      animation.cancel();
      row.removeAttribute('data-model-moving');
      row.removeAttribute('data-model-motion-primary');
    }
    running.current.clear();
    for (const row of rows()) row.removeAttribute('data-model-motion-primary');
  };
  const visible = (rect: DOMRect, viewport: DOMRect) => rect.bottom > viewport.top && rect.top < viewport.bottom;
  const rows = () => Array.from(rowsRef.current?.querySelectorAll<HTMLElement>('[data-model-key]') ?? []);

  useLayoutEffect(() => {
    const element = rowsRef.current;
    if (!element) return;
    media.current = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
    const onPreference = () => { if (media.current?.matches) cancel(); };
    media.current?.addEventListener('change', onPreference);
    element.addEventListener('scroll', cancel, { passive: true });
    // Stop before intentional keyboard scrolling, not after measuring translated rows.
    const onKey = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) cancel();
    };
    element.parentElement?.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', cancel);
    window.addEventListener('scroll', cancel, true);
    let width = element.clientWidth;
    let height = element.clientHeight;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      if (width !== element.clientWidth || height !== element.clientHeight) cancel();
      width = element.clientWidth;
      height = element.clientHeight;
    });
    observer?.observe(element);
    const parent = element.parentElement;
    return () => {
      cancel();
      observer?.disconnect();
      media.current?.removeEventListener('change', onPreference);
      element.removeEventListener('scroll', cancel);
      parent?.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', cancel);
      window.removeEventListener('scroll', cancel, true);
    };
  }, []);

  const favoritesKey = JSON.stringify(context.favorites);
  useLayoutEffect(() => {
    const first = pending.current;
    if (!first) {
      // A non-favorite render (search, sorting, catalog refresh) must not retain motion.
      cancel();
      return;
    }
    const element = rowsRef.current;
    const members = new Set(context.keys);
    const sameMembers = first.context.keys.length === context.keys.length &&
      first.context.keys.every(key => members.has(key));
    const eligible = element && !media.current?.matches &&
      first.context.catalog === context.catalog && first.context.query === context.query &&
      first.context.sort === context.sort && sameMembers &&
      first.scrollTop === element.scrollTop && first.width === element.clientWidth && first.height === element.clientHeight;
    // A pointer/highlight or equivalent wire snapshot may render before the
    // asynchronous favorite patch. Keep First until favorites actually change.
    if (eligible && JSON.stringify(first.context.favorites) === favoritesKey) return;
    cancel();
    if (!eligible || !element) return;
    const viewport = element.getBoundingClientRect();
    for (const row of rows()) {
      const before = first.positions.get(row.dataset.modelKey!);
      const after = row.getBoundingClientRect();
      // Never drag historical offscreen rows through the viewport.
      if (!before || !visible(after, viewport)) continue;
      const dy = before.top - after.top;
      if (Math.abs(dy) < 0.5 || typeof row.animate !== 'function') continue;
      row.setAttribute('data-model-moving', '');
      const animation = row.animate([
        { transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' },
      ], { duration: 180, easing: 'ease-out' });
      running.current.set(row, animation);
      animation.onfinish = () => {
        if (running.current.get(row) !== animation) return;
        running.current.delete(row);
        row.removeAttribute('data-model-moving');
        if (running.current.size === 0) {
          for (const activeRow of rows()) activeRow.removeAttribute('data-model-motion-primary');
        }
        animation.cancel();
      };
    }
    if (running.current.size > 0) {
      rows().find(row => row.dataset.modelKey === first.initiatingKey)
        ?.setAttribute('data-model-motion-primary', '');
    }
  }, [context.catalog, context.query, context.sort, context.keys.join('\0'), favoritesKey]);

  return (initiatingKey: string) => {
    const element = rowsRef.current;
    if (!element || media.current?.matches) { cancel(); return; }
    const viewport = element.getBoundingClientRect();
    const positions = new Map<string, DOMRect>();
    for (const row of rows()) {
      const rect = row.getBoundingClientRect();
      if (visible(rect, viewport)) positions.set(row.dataset.modelKey!, rect);
    }
    pending.current = {
      context, initiatingKey, positions, scrollTop: element.scrollTop,
      width: element.clientWidth, height: element.clientHeight,
    };
  };
}
