import { useLayoutEffect, useRef, useState } from 'preact/hooks';
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
  const dockRef = useRef<HTMLDivElement>(null);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const visible = !hidden && (hasNewer || awayFromBottom);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const update = () => {
      // Recover the viewport height WITHOUT the dock. Otherwise mounting it
      // moves the apparent bottom by more than the 24px near-bottom threshold,
      // and removing it can repeatedly toggle the control on and off.
      const dockHeight = dockRef.current?.getBoundingClientRect().height ?? 0;
      const distance = element.scrollHeight - element.clientHeight - dockHeight - element.scrollTop;
      // Streaming's bounded smooth follow may intentionally lag the target.
      // That lag is not a reader navigating away from the latest content.
      setAwayFromBottom(!autoFollowRef.current && distance > AUTO_SCROLL_BOTTOM_THRESHOLD_PX);
    };
    update();
    element.addEventListener('scroll', update);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    if (dockRef.current) observer.observe(dockRef.current);
    return () => {
      element.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, [scrollRef, autoFollowRef, hasNewer, hidden, totalSize, isAtBottom, visible]);

  return { dockRef, visible };
}
