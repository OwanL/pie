/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useCallback, useEffect, useRef } from 'preact/hooks';
import type { RefObject } from 'preact/compat';

const STICK_THRESHOLD = 48;

/**
 * Stick-to-bottom scroll behavior for a scrollable container.
 *
 * Pins the container to the latest content as it streams in, unless the user
 * has scrolled up to read earlier content. Pass the scroll-container ref
 * (typically from `useResizableHeight`) and a dependency that changes when
 * new content arrives (e.g. `text`, `messages`).
 *
 * @example
 * ```tsx
 * const { scrollRef } = useResizableHeight<HTMLDivElement>();
 * const { handleScroll } = useStickToBottom(scrollRef, [messages]);
 * return <div ref={scrollRef} onScroll={handleScroll}>…</div>;
 * ```
 */
export function useStickToBottom<T extends HTMLElement>(
  scrollRef: RefObject<T | null>,
  deps: unknown[],
) {
  const stickToBottomRef = useRef(true);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD;
  }, [scrollRef]);

  // Keep the container pinned to the latest content as it streams in, unless
  // the user has scrolled up to read earlier content.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, deps);

  return { handleScroll };
}
