import { useEffect, useRef } from 'preact/hooks';

import { isNearBottom, resolveAutoFollowState } from '../auto-scroll';

export function useScrollEventsEffect(
  scrollRef: { current: HTMLDivElement | null },
  autoFollowRef: { current: boolean },
  lastScrollTopRef: { current: number },
  manualScrollActiveRef: { current: boolean },
  setManualScrollActive: (v: boolean) => void,
  programmaticScrollTargetRef: { current: number | null },
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

    let manualScrollIdleTimer: number | null = null;
    let pointerGestureActive = false;
    let inputIntentActive = false;
    const clearManualIdleTimer = () => {
      if (manualScrollIdleTimer === null) return;
      window.clearTimeout(manualScrollIdleTimer);
      manualScrollIdleTimer = null;
    };
    const finishManualInteraction = () => {
      inputIntentActive = false;
      setManualScrollActive(false);
      manualScrollIdleTimer = null;
      // Loading older rows changes the scroll range and thumb mapping. Defer
      // that request until the user has released the native thumb.
      if (el.scrollTop <= 120 && hasOlderRef.current) requestOlderPageRef.current();
    };
    const scheduleManualIdleReset = () => {
      clearManualIdleTimer();
      if (pointerGestureActive) return;
      manualScrollIdleTimer = window.setTimeout(finishManualInteraction, 220);
    };
    const beginManualInteraction = () => {
      setManualScrollActive(true);
      clearManualIdleTimer();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.button !== 1) return;
      pointerGestureActive = true;
      beginManualInteraction();
    };
    const onPointerEnd = () => {
      if (!pointerGestureActive) return;
      pointerGestureActive = false;
      scheduleManualIdleReset();
    };
    const onWheel = () => {
      inputIntentActive = true;
      beginManualInteraction();
      scheduleManualIdleReset();
    };
    const onTouchStart = () => {
      inputIntentActive = true;
      beginManualInteraction();
    };
    const onTouchEnd = () => scheduleManualIdleReset();
    const onKeyDown = (event: KeyboardEvent) => {
      if (!['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return;
      inputIntentActive = true;
      beginManualInteraction();
      scheduleManualIdleReset();
    };
    const onScroll = () => {
      const next = el.scrollTop;
      const previous = lastScrollTopRef.current;
      const expectedProgrammaticTop = programmaticScrollTargetRef.current;
      const programmatic = expectedProgrammaticTop !== null
        && Math.abs(next - expectedProgrammaticTop) <= 1;
      // Consume the expectation even on mismatch. A different position means
      // browser coalescing included genuine thumb movement, which must win.
      if (expectedProgrammaticTop !== null) programmaticScrollTargetRef.current = null;
      // Pointer/input intent owns both scroll directions. Once detached from
      // auto-follow, any untagged movement is also treated as manual; this
      // covers Chromium builds that omit pointerdown for the native scrollbar
      // gutter without mistaking Pie's own anchor/follow writes for dragging.
      // The upward clause handles the first move away from a followed bottom.
      if (!programmatic && (
        pointerGestureActive
        || inputIntentActive
        || next < previous - 1
        || (!autoFollowRef.current && Math.abs(next - previous) > 1)
      )) {
        beginManualInteraction();
        scheduleManualIdleReset();
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
      if (!manualScrollActiveRef.current && el.scrollTop <= 120 && hasOlderRef.current) {
        requestOlderPageRef.current();
      }
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('pointerdown', onPointerDown, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });
    el.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerup', onPointerEnd, { passive: true });
    window.addEventListener('pointercancel', onPointerEnd, { passive: true });

    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
      el.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerup', onPointerEnd);
      window.removeEventListener('pointercancel', onPointerEnd);
      clearManualIdleTimer();
      setManualScrollActive(false);
      programmaticScrollTargetRef.current = null;
    };
  }, [scrollRef, sessionKey, autoFollowRef, lastScrollTopRef, manualScrollActiveRef, setManualScrollActive, programmaticScrollTargetRef, setIsAtBottom, setAutoFollow]);
}
