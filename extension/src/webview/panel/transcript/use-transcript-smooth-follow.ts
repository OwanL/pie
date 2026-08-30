import { useCallback, useEffect, useLayoutEffect, useState } from 'preact/hooks';

import type { ChatMessage } from '../../../shared/protocol';
import { isNearBottom } from '../auto-scroll';

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
 * Neither content signal fires during the pin's own `scrollTop` write (the
 * transcript identity is stable and `totalSize` does not change), so exact
 * following adds no repeated forced-layout reads.
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
 * Keeps a followed transcript exactly pinned to the cached bottom.
 *
 * This runs as a layout effect after {@link useRefreshFollowTarget}, so a
 * content or viewport height change is corrected before paint. Follow mode is
 * deliberately binary: while it is active the viewport stays at the bottom;
 * once a user scrolls upward, `autoFollowRef` becomes false and this hook does
 * not touch their reading position. There is no asynchronous catch-up state in
 * between those modes, which prevents expandable tool sections and streaming
 * snapshots from accumulating visible drift.
 *
 * The target refresh owns the single `scrollHeight`/`clientHeight` read per
 * change. This hook only writes `scrollTop` and reads it back after browser
 * clamping, keeping `lastScrollTopRef` exact for manual-scroll detection.
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
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !autoFollowRef.current || hasNewer || navigationActiveRef.current) return;

    const target = cachedTargetRef.current;
    if (el.scrollTop !== target) {
      const priorScrollBehavior = el.style.scrollBehavior;
      const before = el.scrollTop;
      try {
        el.style.scrollBehavior = 'auto';
        el.scrollTop = target;
      } finally {
        el.style.scrollBehavior = priorScrollBehavior;
      }
      programmaticScrollTargetRef.current = el.scrollTop === before ? null : el.scrollTop;
    }

    lastScrollTopRef.current = el.scrollTop;
    setIsAtBottom(Math.abs(el.scrollTop - target) <= 1);
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
