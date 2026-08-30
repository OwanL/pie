import { useLayoutEffect } from 'preact/hooks';

import type { MessageScrollAnchor } from './scroll-anchor';

export function useSessionResetEffect(
  sessionKey: string | null,
  scrollRef: { current: HTMLDivElement | null },
  scrollToBottom: () => void,
  setIsInitialPositioning: (v: boolean) => void,
  isInitialPositioningRef: { current: boolean },
  setIsLoadingOlder: (v: boolean) => void,
  setIsLoadingNewer: (v: boolean) => void,
  loadedStart: number,
  loadedEnd: number,
  autoFollowRef: { current: boolean },
  setAutoFollow: (v: boolean) => void,
  lastScrollTopRef: { current: number },
  pendingJumpToLatestSnapRef: { current: boolean },
  pendingOlderAnchorRef: { current: MessageScrollAnchor | null },
  loadingOlderRef: { current: boolean },
  loadingNewerRef: { current: boolean },
  previousLoadedStartRef: { current: number },
  previousLoadedEndRef: { current: number },
  navigationActiveRef: { current: boolean },
) {
  useLayoutEffect(() => {
    setAutoFollow(true);
    lastScrollTopRef.current = 0;
    pendingJumpToLatestSnapRef.current = false;
    navigationActiveRef.current = false;
    pendingOlderAnchorRef.current = null;
    loadingOlderRef.current = false;
    loadingNewerRef.current = false;
    setIsLoadingOlder(false);
    setIsLoadingNewer(false);
    previousLoadedStartRef.current = loadedStart;
    previousLoadedEndRef.current = loadedEnd;
    // Keep the opacity mask (transcript-positioning) active until the
    // virtualizer's totalSize has actually settled. The virtualizer starts from
    // rough per-row estimates (estimateTranscriptRowSize) and keeps growing as
    // late ResizeObserver measurements arrive; clearing the mask after a single
    // rAF exposes a middle-then-crawl. Instead, snap to the bottom every frame
    // and only clear once `scrollHeight` stops changing — positioned-at-bottom
    // is trivially true immediately after a snap (the browser clamps scrollTop
    // to scrollHeight - clientHeight), so height stability is the real settled
    // signal. A safety timeout guarantees the mask can never hang the transcript
    // invisible (e.g. a session streaming a token every single frame).
    isInitialPositioningRef.current = true;
    setIsInitialPositioning(true);
    scrollToBottom();

    const startedAt = Date.now();
    const POSITIONING_SAFETY_TIMEOUT_MS = 600;
    const STABLE_FRAMES_REQUIRED = 2;
    let prevScrollHeight = Number.NaN;
    let stableFrames = 0;

    let frame: number | null = requestAnimationFrame(function tick() {
      frame = null;
      // If the user has taken manual scroll control during the positioning
      // window (e.g. switched to a streaming session and scrolled up within
      // the 600ms safety window), stop fighting them: clear the opacity mask at
      // their current scroll position, cancel the per-frame snap loop, and do
      // NOT scrollToBottom(). onScroll (useScrollEventsEffect ->
      // resolveAutoFollowState) flips autoFollowRef.current to false when the
      // user scrolls away from the bottom, so this reveals the transcript at
      // their position immediately instead of snapping back for up to 600ms.
      if (!autoFollowRef.current) {
        isInitialPositioningRef.current = false;
        setIsInitialPositioning(false);
        return;
      }
      scrollToBottom();
      const el = scrollRef.current;
      const scrollHeight = el ? el.scrollHeight : 0;
      if (scrollHeight > 0 && scrollHeight === prevScrollHeight) {
        stableFrames++;
      } else {
        stableFrames = 0;
      }
      prevScrollHeight = scrollHeight;
      const settled = stableFrames >= STABLE_FRAMES_REQUIRED;
      const timedOut = Date.now() - startedAt >= POSITIONING_SAFETY_TIMEOUT_MS;
      if (settled || timedOut) {
        isInitialPositioningRef.current = false;
        setIsInitialPositioning(false);
        return;
      }
      frame = requestAnimationFrame(tick);
    });

    return () => { if (frame !== null) cancelAnimationFrame(frame); };
  }, [sessionKey]);
}
