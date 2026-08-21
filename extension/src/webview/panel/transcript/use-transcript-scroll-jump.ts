import { useCallback, useEffect, useRef } from 'preact/hooks';

const JUMP_SETTLE_MINIMUM_MS = 1_500;
const JUMP_SETTLE_SAFETY_TIMEOUT_MS = 2_500;
const JUMP_STABLE_FRAMES_REQUIRED = 2;

export function useJumpToLatest(
  scrollRef: { current: HTMLDivElement | null },
  autoFollowRef: { current: boolean },
  setAutoFollow: (v: boolean) => void,
  hasNewer: boolean,
  onJumpToLatest: () => void,
  scrollToBottom: () => void,
  pendingJumpToLatestSnapRef: { current: boolean },
) {
  const settleFrameRef = useRef<number | null>(null);
  const cancelSettle = useCallback(() => {
    if (settleFrameRef.current === null) return;
    cancelAnimationFrame(settleFrameRef.current);
    settleFrameRef.current = null;
  }, []);
  useEffect(() => cancelSettle, [cancelSettle]);

  /** A virtual transcript's first bottom snap mounts a different row range.
   * Those rows can replace estimates with larger measured heights on the next
   * frames, moving the true bottom after the initial write. Re-snap for a
   * bounded settling window; a real user scroll flips autoFollowRef false and
   * cancels ownership immediately. */
  const settleAtBottom = useCallback(() => {
    cancelSettle();
    scrollToBottom();
    const startedAt = Date.now();
    let previousScrollHeight = Number.NaN;
    let stableFrames = 0;

    settleFrameRef.current = requestAnimationFrame(function tick() {
      settleFrameRef.current = null;
      if (!autoFollowRef.current) return;
      const element = scrollRef.current;
      const scrollHeight = element?.scrollHeight ?? 0;
      if (element && Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) > 1) {
        scrollToBottom();
      }
      if (scrollHeight > 0 && scrollHeight === previousScrollHeight) stableFrames += 1;
      else stableFrames = 0;
      previousScrollHeight = scrollHeight;
      const elapsedMs = Date.now() - startedAt;
      if (
        (stableFrames >= JUMP_STABLE_FRAMES_REQUIRED && elapsedMs >= JUMP_SETTLE_MINIMUM_MS)
        || elapsedMs >= JUMP_SETTLE_SAFETY_TIMEOUT_MS
      ) return;
      settleFrameRef.current = requestAnimationFrame(tick);
    });
  }, [autoFollowRef, cancelSettle, scrollRef, scrollToBottom]);

  return useCallback(() => {
    setAutoFollow(true);
    if (hasNewer) {
      pendingJumpToLatestSnapRef.current = true;
      onJumpToLatest();
      return;
    }
    settleAtBottom();
  }, [hasNewer, onJumpToLatest, pendingJumpToLatestSnapRef, setAutoFollow, settleAtBottom]);
}
