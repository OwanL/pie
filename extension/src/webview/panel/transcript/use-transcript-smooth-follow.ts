import { useCallback, useEffect, useLayoutEffect, useState } from 'preact/hooks';

import type { ChatMessage } from '../../../shared/protocol';
import {
  SMOOTH_SCROLL_SNAP_EPSILON_PX,
  advanceSmoothScrollTop,
} from '../auto-scroll';

/**
 * Keeps the auto-follow target (the true bottom = `scrollHeight - clientHeight`,
 * i.e. the max `scrollTop`) fresh for {@link useSmoothAutoFollow} without the
 * loop paying for a per-frame forced-layout read.
 *
 * Three complementary signals cover the ways the bottom moves:
 *
 * 1. **Content grows at a snapshot** (the common streaming case): keyed on the
 *    `transcript` array identity. The host posts a fresh JSON-deserialized
 *    array on every ~150ms streaming snapshot, so its identity changes at
 *    commit time — the exact moment the DOM grows — letting a `useLayoutEffect`
 *    re-read the true bottom before the next rAF tick. This is the timely
 *    signal: it closes the up-to-one-frame lag `totalSize` alone imposed (the
 *    virtualizer batches ResizeObserver-driven re-measurement to a rAF, so
 *    `totalSize` updates a frame after the DOM already grew, leaving the loop
 *    easing toward a stale target and trailing the latest content on every
 *    snapshot).
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
 * Neither content signal fires during the auto-follow rAF loop's own
 * programmatic scrolls (the transcript identity is stable and `totalSize`
 * doesn't change on a pure scrollTop move), so there is no per-frame forced
 * reflow while easing — the loop always eases toward a cached target.
 */
export function useRefreshFollowTarget(
  scrollRef: { current: HTMLDivElement | null },
  totalSize: number,
  transcript: readonly ChatMessage[],
  sessionKey: string | null,
  cachedTargetRef: { current: number },
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
    const target = Math.max(0, el.scrollHeight - el.clientHeight);
    if (target === cachedTargetRef.current) return false;
    cachedTargetRef.current = target;
    return true;
  }, [scrollRef, cachedTargetRef]);

  // Keyed on BOTH totalSize and transcript identity. totalSize catches every
  // height-relevant mutation (row ResizeObserver -> measureElement), but it
  // lags the real bottom by up to a frame: the virtualizer batches
  // ResizeObserver-driven re-measurement to a rAF (`useAnimationFrameWithResizeObserver`),
  // so totalSize only updates a frame after the DOM already grew. On a 150ms
  // streaming snapshot that left the loop easing toward a ~16ms-stale target,
  // trailing the latest content. The transcript array identity is fresh the
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
 * Event-woken rAF easing that moves the transcript toward its bottom whenever
 * auto-follow is active, replacing the previous hard
 * `scrollTop = scrollHeight` snaps that produced visible jumps as streaming
 * content grew. Each frame advances
 * scrollTop a bounded step toward the target (see `advanceSmoothScrollTop`),
 * so following feels continuous instead of snapping. CSS `scroll-behavior` is
 * forced to instant while auto-following so each frame is deterministic, then
 * the inline override is cleared when the loop stops.
 *
 * The loop is GATED on follow state and distance: it self-cancels whenever the
 * user is not following the bottom (or newer messages are not loaded), and
 * sleeps once it reaches the cached target. In particular, an active agent
 * must not leave a no-op rAF running at ~60fps while the user reads earlier
 * content or while the transcript is already pinned. Reactive follow/content
 * signals and the container ResizeObserver restart it when work appears.
 * `scrollToBottom` / `jumpToLatest` keep doing their own synchronous snaps and
 * do not depend on this loop.
 *
 * Target freshness: the loop NEVER reads `scrollHeight`/`clientHeight` itself
 * (no per-frame forced reflow). It eases toward `cachedTargetRef` — the true
 * bottom (`scrollHeight - clientHeight`) — which {@link useRefreshFollowTarget}
 * refreshes on every content/viewport height change. Easing toward the bottom
 * (not `scrollHeight`) is load-bearing: a viewport already pinned at the
 * bottom has `delta == 0`, so there is no phantom `clientHeight`-sized ease
 * each idle frame, no clamped no-op write, and therefore no drift between the
 * real `scrollTop` and `lastScrollTopRef` — which keeps the scroll handler's
 * disengage detection exact (the old ease-toward-`scrollHeight` path could
 * stale `lastScrollTopRef` by a capped step every pinned-but-idle frame).
 */
export function useSmoothAutoFollow(
  scrollRef: { current: HTMLDivElement | null },
  autoFollowRef: { current: boolean },
  autoFollow: boolean,
  lastScrollTopRef: { current: number },
  setIsAtBottom: (v: boolean) => void,
  hasNewer: boolean,
  isInitialPositioningRef: { current: boolean },
  isInitialPositioning: boolean,
  busy: boolean,
  cachedTargetRef: { current: number },
  targetRevision: number,
  totalSize: number,
  transcript: readonly ChatMessage[],
  sessionKey: string | null,
) {
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const tick = () => {
      // Stop immediately when there is no bottom to follow. Keeping this loop
      // alive merely because the agent is busy wastes a main-thread callback
      // every frame while the user reads earlier content, making manual scroll
      // input noticeably laggy. The reactive autoFollow/hasNewer deps restart
      // it when following becomes meaningful again.
      if (!autoFollowRef.current || hasNewer) {
        if (el.style.scrollBehavior === 'auto') el.style.scrollBehavior = '';
        raf = 0;
        return;
      }
      if (el.style.scrollBehavior !== 'auto') el.style.scrollBehavior = 'auto';
      const target = cachedTargetRef.current;
      // During the post-session-switch positioning window, snap to the bottom
      // every frame instead of easing. The virtualizer's totalSize grows in
      // sub-200px increments as late ResizeObserver measurements arrive; the
      // opacity mask (transcript-positioning) hides the reflow, and
      // useRefreshFollowTarget keeps `target` fresh with each increment, so
      // snapping pins the transcript to the bottom while it settles. Scoped to
      // this window only; once isInitialPositioningRef clears, normal easing
      // resumes. hasNewer sessions return above, so this never snaps a
      // newer-not-loaded session to its partial bottom.
      if (isInitialPositioningRef.current) {
        if (el.scrollTop !== target) {
          el.scrollTop = target;
          lastScrollTopRef.current = target;
        }
        setIsAtBottom(true);
        // Positioning owns a short settling window while the virtualizer is
        // still measuring and may synchronously snap to scrollHeight. Keep
        // correcting during that bounded window; normal settled follow below
        // is event-driven and does not retain a frame callback.
        raf = requestAnimationFrame(tick);
        return;
      }
      const current = el.scrollTop;
      const delta = target - current;
      if (Math.abs(delta) <= SMOOTH_SCROLL_SNAP_EPSILON_PX) {
        if (current !== target) {
          el.scrollTop = target;
          lastScrollTopRef.current = target;
        }
        // Settled follow is event-driven: transcript/measurement dependencies
        // restart this effect, while container resizes bump targetRevision. Do
        // not burn a no-op rAF every frame at an unchanged bottom.
        raf = 0;
        return;
      }
      const next = advanceSmoothScrollTop(current, target);
      el.scrollTop = next;
      // Read back the actual (possibly browser-clamped) scrollTop so
      // `lastScrollTopRef` stays exact on BOTH growth (next <= bottom, no clamp)
      // and shrink (next can exceed the new bottom → browser clamps to it). A
      // stale-high ref would make the scroll handler's disengage detection
      // fragile for one frame. scrollTop reads are cheap (no forced reflow,
      // unlike scrollHeight/clientHeight); scrollToBottom uses the same pattern.
      lastScrollTopRef.current = el.scrollTop;
      setIsAtBottom(true);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      el.style.scrollBehavior = '';
    };
  }, [scrollRef, hasNewer, autoFollowRef, autoFollow, lastScrollTopRef, setIsAtBottom, isInitialPositioningRef, isInitialPositioning, busy, cachedTargetRef, targetRevision, totalSize, transcript, sessionKey]);
}
