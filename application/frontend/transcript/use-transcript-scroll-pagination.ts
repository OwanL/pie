import { useLayoutEffect } from 'preact/hooks';

import {
  restoreMessageScrollAnchor,
  type MessageScrollAnchor,
} from './scroll-anchor';

export function usePaginationTrackingEffect(
  scrollRef: { current: HTMLDivElement | null },
  scrollToBottom: () => void,
  transcriptLength: number,
  loadedStart: number,
  loadedEnd: number,
  hasNewer: boolean,
  hasOlder: boolean,
  loadingOlderRef: { current: boolean },
  loadingNewerRef: { current: boolean },
  pendingOlderAnchorRef: { current: MessageScrollAnchor | null },
  setIsLoadingOlder: (v: boolean) => void,
  setIsLoadingNewer: (v: boolean) => void,
  previousLoadedStartRef: { current: number },
  previousLoadedEndRef: { current: number },
  pendingJumpToLatestSnapRef: { current: boolean },
  setAutoFollow: (v: boolean) => void,
  manualScrollActive: boolean,
  programmaticScrollTargetRef: { current: number | null },
) {
  useLayoutEffect(() => {
    const prevStart = previousLoadedStartRef.current;
    const prevEnd = previousLoadedEndRef.current;

    const el = scrollRef.current;
    if (!el) return;

    const olderPageArrived = loadingOlderRef.current && loadedStart < prevStart;
    const latestPageArrived = pendingJumpToLatestSnapRef.current && !hasNewer;
    // A native thumb drag owns scrollTop. Keep the previous window markers and
    // pending anchors intact so this effect retries once the interaction ends.
    if (manualScrollActive && (olderPageArrived || latestPageArrived)) return;

    previousLoadedStartRef.current = loadedStart;
    previousLoadedEndRef.current = loadedEnd;

    if (olderPageArrived) {
      restoreMessageScrollAnchor(el, pendingOlderAnchorRef.current, programmaticScrollTargetRef);
      loadingOlderRef.current = false;
      setIsLoadingOlder(false);
      pendingOlderAnchorRef.current = null;
    }
    if (loadingNewerRef.current && loadedEnd > prevEnd) {
      loadingNewerRef.current = false;
      setIsLoadingNewer(false);
    }
    if (!hasOlder) {
      loadingOlderRef.current = false;
      setIsLoadingOlder(false);
      pendingOlderAnchorRef.current = null;
    }
    if (!hasNewer) {
      loadingNewerRef.current = false;
      setIsLoadingNewer(false);
    }

    if (pendingJumpToLatestSnapRef.current && !hasNewer) {
      pendingJumpToLatestSnapRef.current = false;
      setAutoFollow(true);
      scrollToBottom();
    }
  }, [scrollToBottom, transcriptLength, hasNewer, hasOlder, loadedEnd, loadedStart, manualScrollActive, programmaticScrollTargetRef]);
}
