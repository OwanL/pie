import { useCallback, useEffect, useLayoutEffect, useState } from 'preact/hooks';

import type { ChatMessage } from '../../../shared/protocol';
import {
  advanceSmoothScrollTop,
  isNearBottom,
  SMOOTH_SCROLL_SNAP_EPSILON_PX,
} from '../auto-scroll';

/**
 * Keeps the auto-follow target (the true bottom = `scrollHeight - clientHeight`,
 * i.e. the max `scrollTop`) fresh for {@link useAutoFollow} without paying for
 * repeated forced-layout reads.
 *
 * Three complementary signals cover the ways the bottom moves:
 *
 * 1. **Content grows at a snapshot** (the common streaming case): keyed on the
 *    `transcript` array identity. The host posts a fresh JSON-deserialized
 *    array on every ~150ms streaming snapshot, so its identity changes at
 *    commit time — the exact moment the DOM grows — letting a `useLayoutEffect`
 *    re-read the true bottom in the same layout commit. This is the timely
 *    signal: it closes the up-to-one-frame lag `totalSize` alone imposes (the
 *    virtualizer batches ResizeObserver-driven re-measurement to a rAF, so
 *    `totalSize` updates a frame after the DOM already grew).
 *
 * 2. **Content grows outside a snapshot** (collapsible expand/collapse, late
 *    image/table loads, drag-resize): keyed on `totalSize`. These mutate a
 *    row's height without changing the transcript array, so the transcript
 *    signal wouldn't fire; the row's ResizeObserver → `measureElement` →
 *    `totalSize` does, a frame later. It is the broad backstop for every
 *    height-relevant mutation the transcript identity can't see.
 *
 * 3. **Viewport resizes** (panel resized, file-changes rail opening, composer
 *    growing): change `clientHeight` without changing content, so neither
 *    content signal fires. A `ResizeObserver` on the scroll container (its
 *    border-box == `clientHeight`) re-reads the bottom.
 *
 * Neither content signal fires during the follow loop's own `scrollTop` write
 * (the transcript identity is stable and `totalSize` does not change), so
 * frame-based following adds no repeated forced-layout reads.
 */
export function useRefreshFollowTarget(
  scrollRef: { current: HTMLDivElement | null },
  totalSize: number,
  transcript: readonly ChatMessage[],
  sessionKey: string | null,
  cachedTargetRef: { current: number },
  setIsAtBottom: (value: boolean) => void,
): number {
  // totalSize/transcript changes already render the owner and are passed on as
  // wake dependencies. Only a container ResizeObserver notification needs its
  // own revision to wake a quiescent follow effect without another reactive
  // signal. Keeping the common streaming path out of state avoids a second
  // render for every target refresh.
  const [resizeRevision, setResizeRevision] = useState(0);
  const refresh = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return false;
    const scrollHeight = el.scrollHeight;
    const scrollTop = el.scrollTop;
    const clientHeight = el.clientHeight;
    setIsAtBottom(isNearBottom({
      scrollHeight,
      scrollTop,
      clientHeight,
    }));
    const target = Math.max(0, scrollHeight - clientHeight);
    if (target === cachedTargetRef.current) return false;
    cachedTargetRef.current = target;
    return true;
  }, [scrollRef, cachedTargetRef, setIsAtBottom]);

  // Keyed on BOTH totalSize and transcript identity. totalSize catches every
  // height-relevant mutation (row ResizeObserver -> measureElement), but it
  // lags the real bottom by up to a frame: the virtualizer batches
  // ResizeObserver-driven re-measurement to a rAF (`useAnimationFrameWithResizeObserver`),
  // so totalSize only updates a frame after the DOM already grew. On a 150ms
  // streaming snapshot that left follow targeting a ~16ms-stale bottom. The
  // transcript array identity is fresh the
  // instant a snapshot commits (a new JSON-deserialized reference), so keying
  // on it re-reads scrollHeight at commit time — closing the lag. The two are
  // complementary: transcript fires at snapshot commit (bottom-growth, the
  // follow-relevant case); totalSize fires a frame later and also catches
  // non-snapshot growth (collapsible expand/collapse, late image/table loads).
  useLayoutEffect(() => {
    refresh();
  }, [refresh, totalSize, transcript, sessionKey]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (refresh()) setResizeRevision((revision) => revision + 1);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollRef, refresh]);

  return resizeRevision;
}

/**
 * Follows the cached bottom over animation frames rather than writing the
 * whole arriving block into `scrollTop` in one layout commit. Ordinary
 * streaming and late measurement therefore remain readable while the target
 * is still reached promptly. The target refresh owns the only
 * `scrollHeight`/`clientHeight` reads; this loop only reads/writes `scrollTop`.
 *
 * Initial session placement and explicit jump-to-bottom actions intentionally
 * retain their synchronous snap semantics in `scrollToBottom` and the
 * navigation hooks. This hook is only the ordinary follow path.
 *
 * The loop is event-woken and stops as soon as it reaches the cached target.
 * It never runs while detached, navigating, the latest page is unavailable, or
 * the document is hidden. A user scroll changes `autoFollowRef` synchronously,
 * so the next frame cannot pull the reader back to the live edge.
 */
export function useAutoFollow(
  scrollRef: { current: HTMLDivElement | null },
  autoFollowRef: { current: boolean },
  autoFollow: boolean,
  lastScrollTopRef: { current: number },
  setIsAtBottom: (v: boolean) => void,
  hasNewer: boolean,
  cachedTargetRef: { current: number },
  targetRevision: number,
  totalSize: number,
  transcript: readonly ChatMessage[],
  sessionKey: string | null,
  programmaticScrollTargetRef: { current: number | null },
  navigationActiveRef: { current: boolean },
) {
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const ownerDocument = el.ownerDocument;
    let frame: number | null = null;
    let disposed = false;

    const isVisible = () => !ownerDocument.hidden;
    const prefersReducedMotion = () => {
      const view = ownerDocument.defaultView;
      if (!view || typeof view.matchMedia !== 'function') return false;
      try {
        return view.matchMedia('(prefers-reduced-motion: reduce)').matches;
      } catch {
        return false;
      }
    };
    const cancelFrame = () => {
      if (frame === null) return;
      cancelAnimationFrame(frame);
      frame = null;
    };
    const writeScrollTop = (next: number): number => {
      const priorScrollBehavior = el.style.scrollBehavior;
      const before = el.scrollTop;
      try {
        // Do not let a theme's smooth behavior turn each bounded frame into a
        // second, browser-owned animation. Manual input and anchor restoration
        // remain immediate as well.
        el.style.scrollBehavior = 'auto';
        el.scrollTop = next;
      } finally {
        el.style.scrollBehavior = priorScrollBehavior;
      }
      const actual = el.scrollTop;
      programmaticScrollTargetRef.current = actual === before ? null : actual;
      lastScrollTopRef.current = actual;
      return actual;
    };

    const tick = () => {
      frame = null;
      if (
        disposed
        || !isVisible()
        || !autoFollowRef.current
        || hasNewer
        || navigationActiveRef.current
      ) return;

      const target = cachedTargetRef.current;
      const current = el.scrollTop;
      if (prefersReducedMotion()) {
        // Reduced motion still follows, but without an animated transition.
        writeScrollTop(target);
        setIsAtBottom(true);
        return;
      }

      const delta = target - current;
      if (Math.abs(delta) <= SMOOTH_SCROLL_SNAP_EPSILON_PX) {
        if (current !== target) writeScrollTop(target);
        else lastScrollTopRef.current = current;
        setIsAtBottom(true);
        return;
      }

      writeScrollTop(advanceSmoothScrollTop(current, target));
      // While follow ownership is active, suppress a transient Bottom button
      // during the bounded catch-up. It represents user detachment, not the
      // short visual easing interval between two host snapshots.
      setIsAtBottom(true);
      frame = requestAnimationFrame(tick);
    };

    const schedule = () => {
      if (
        disposed
        || frame !== null
        || !isVisible()
        || !autoFollowRef.current
        || hasNewer
        || navigationActiveRef.current
        || el.scrollTop === cachedTargetRef.current
      ) return;
      if (prefersReducedMotion()) tick();
      else frame = requestAnimationFrame(tick);
    };

    const onVisibilityChange = () => {
      cancelFrame();
      if (isVisible()) schedule();
    };

    ownerDocument.addEventListener('visibilitychange', onVisibilityChange);
    schedule();
    return () => {
      disposed = true;
      cancelFrame();
      ownerDocument.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [
    scrollRef,
    autoFollowRef,
    autoFollow,
    lastScrollTopRef,
    setIsAtBottom,
    hasNewer,
    cachedTargetRef,
    targetRevision,
    totalSize,
    transcript,
    sessionKey,
    programmaticScrollTargetRef,
    navigationActiveRef,
  ]);
}
