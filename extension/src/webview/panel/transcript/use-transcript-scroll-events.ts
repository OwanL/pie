import { useEffect, useRef } from 'preact/hooks';

import { isNearBottom, resolveAutoFollowState } from '../auto-scroll';

export function useScrollEventsEffect(
  scrollRef: { current: HTMLDivElement | null },
  autoFollowRef: { current: boolean },
  lastScrollTopRef: { current: number },
  isScrollingTowardBottomRef: { current: boolean },
  setIsAtBottom: (v: boolean) => void,
  setAutoFollow: (v: boolean) => void,
  hasOlder: boolean,
  requestOlderPage: () => void,
  sessionKey: string | null,
) {
  // The paging callback is recreated by the transcript host on ordinary state
  // renders. Keep the bound scroll listener stable for the whole session while
  // still calling the latest paging behavior.
  const hasOlderRef = useRef(hasOlder);
  const requestOlderPageRef = useRef(requestOlderPage);
  hasOlderRef.current = hasOlder;
  requestOlderPageRef.current = requestOlderPage;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    let downwardScrollIdleTimer: number | null = null;
    let pointerGestureActive = false;
    const clearDownwardIdleTimer = () => {
      if (downwardScrollIdleTimer === null) return;
      window.clearTimeout(downwardScrollIdleTimer);
      downwardScrollIdleTimer = null;
    };
    const scheduleDownwardIdleReset = () => {
      clearDownwardIdleTimer();
      if (pointerGestureActive) return;
      downwardScrollIdleTimer = window.setTimeout(() => {
        isScrollingTowardBottomRef.current = false;
        downwardScrollIdleTimer = null;
      }, 180);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.button !== 1) return;
      pointerGestureActive = true;
      clearDownwardIdleTimer();
    };
    const onPointerEnd = () => {
      if (!pointerGestureActive) return;
      pointerGestureActive = false;
      if (isScrollingTowardBottomRef.current) scheduleDownwardIdleReset();
    };
    const onScroll = () => {
      const next = el.scrollTop;
      const previous = lastScrollTopRef.current;
      if (next > previous + 1) {
        isScrollingTowardBottomRef.current = true;
        scheduleDownwardIdleReset();
      } else if (next < previous - 1) {
        isScrollingTowardBottomRef.current = false;
        clearDownwardIdleTimer();
      }
      const metrics = { scrollHeight: el.scrollHeight, scrollTop: next, clientHeight: el.clientHeight };
      const follow = resolveAutoFollowState({
        previousAutoFollow: autoFollowRef.current,
        previousScrollTop: lastScrollTopRef.current,
        nextScrollTop: next,
        metrics,
      });
      setAutoFollow(follow);
      lastScrollTopRef.current = next;
      // Keep the visual bottom state metric-based rather than equating it with
      // follow ownership; the user can be detached while still near the edge.
      setIsAtBottom(isNearBottom(metrics));
      if (el.scrollTop <= 120 && hasOlderRef.current) requestOlderPageRef.current();
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('pointerdown', onPointerDown, { passive: true });
    window.addEventListener('pointerup', onPointerEnd, { passive: true });
    window.addEventListener('pointercancel', onPointerEnd, { passive: true });

    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerEnd);
      window.removeEventListener('pointercancel', onPointerEnd);
      clearDownwardIdleTimer();
      isScrollingTowardBottomRef.current = false;
    };
  }, [scrollRef, sessionKey, autoFollowRef, lastScrollTopRef, isScrollingTowardBottomRef, setIsAtBottom, setAutoFollow]);
}
