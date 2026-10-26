import { useLayoutEffect, useState } from 'preact/hooks';
import { AUTO_SCROLL_BOTTOM_THRESHOLD_PX } from './auto-scroll';

/** Presentation only: follow and jump continue to use the real viewport bottom. */
export function useTranscriptLatestDock({
  scrollRef,
  autoFollowRef,
  hasNewer,
  hidden,
  totalSize,
  isAtBottom,
}: {
  scrollRef: { current: HTMLDivElement | null };
  autoFollowRef: { current: boolean };
  hasNewer: boolean;
  hidden: boolean;
  totalSize: number;
  isAtBottom: boolean;
}) {
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const visible = !hidden && (hasNewer || awayFromBottom);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const update = () => {
      // The floating control never changes the viewport's scroll geometry.
      const distance = element.scrollHeight - element.clientHeight - element.scrollTop;
      // Streaming's bounded smooth follow may intentionally lag the target.
      // That lag is not a reader navigating away from the latest content.
      setAwayFromBottom(!autoFollowRef.current && distance > AUTO_SCROLL_BOTTOM_THRESHOLD_PX);
    };
    update();
    element.addEventListener('scroll', update);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      element.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, [scrollRef, autoFollowRef, hasNewer, hidden, totalSize, isAtBottom]);

  return { visible };
}
