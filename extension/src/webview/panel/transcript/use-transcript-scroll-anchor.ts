import { useCallback, useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import type { VirtualItem, Virtualizer } from '@tanstack/virtual-core';
import {
  captureScrollAnchor,
  resolveScrollAnchorDelta,
  type ScrollAnchorCandidate,
  type ScrollAnchorSnapshot,
} from '../auto-scroll';

interface UseTranscriptScrollAnchorArgs {
  scrollRef: { current: HTMLDivElement | null };
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>;
  /** True while pinned to the bottom; anchoring only runs when this is false. */
  autoFollowRef: { current: boolean };
  totalSize: number;
  /** Pagination in flight — anchoring is suppressed to avoid fighting the
   *  dedicated load-older scroll-anchor restore. */
  isLoadingOlder: boolean;
  isLoadingNewer: boolean;
}

const RESTORE_EPSILON_PX = 1;

function buildCandidates(items: ReadonlyArray<VirtualItem>): ScrollAnchorCandidate[] {
  const out: ScrollAnchorCandidate[] = [];
  for (const v of items) {
    if (v.size <= 0) continue;
    out.push({ key: String(v.key), top: v.start, bottom: v.start + v.size });
  }
  return out;
}

/**
 * In-place scroll anchoring for the scrolled-up case.
 *
 * The transcript disables the browser's native `overflow-anchor` (incompatible
 * with the virtualizer's absolutely-positioned rows), and the auto-follow rAF
 * loop (`useSmoothAutoFollow`) only acts when the user is pinned to the bottom.
 * So when the user has scrolled UP to read earlier content and a tool body
 * ABOVE the viewport grows or shrinks (streaming output, expand/collapse),
 * the viewport content would visibly shift with no correction — a "jump".
 *
 * This hook pins the topmost visible virtual row: it continuously captures
 * that row's key + viewport-relative offset (on scroll and after each layout
 * commit), and whenever the total height changes while NOT auto-following (and
 * not paginating) it re-pins the row by adjusting `scrollTop` by the row's
 * shift. Bottom-following is left entirely to `useSmoothAutoFollow`; the two
 * regimes are mutually exclusive (autoFollow true → bottom-follow; false →
 * anchor).
 *
 * Builds candidates from the virtualizer's measured items (key/start/size) so
 * no DOM queries are needed and there is no layout thrash. Reuses the
 * `captureScrollAnchor` / `resolveScrollAnchorDelta` primitives from
 * `auto-scroll.ts` (which were previously dead code).
 */
export function useTranscriptScrollAnchor({
  scrollRef,
  virtualizer,
  autoFollowRef,
  totalSize,
  isLoadingOlder,
  isLoadingNewer,
}: UseTranscriptScrollAnchorArgs) {
  const anchorRef = useRef<ScrollAnchorSnapshot | null>(null);
  const prevTotalSizeRef = useRef(totalSize);

  const captureAnchor = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const candidates = buildCandidates(virtualizer.getVirtualItems());
    anchorRef.current = captureScrollAnchor(candidates, el.scrollTop);
  }, [scrollRef, virtualizer]);

  // Track the top visible row as the user scrolls so the anchor follows the
  // viewport instead of pinning a now-off-screen row.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => captureAnchor();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scrollRef, captureAnchor]);

  // On layout commits, if NOT auto-following/paginating and the anchor row
  // shifted, re-pin it by adjusting scrollTop. Then re-capture for next cycle.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const heightChanged = totalSize !== prevTotalSizeRef.current;
    prevTotalSizeRef.current = totalSize;
    const prev = anchorRef.current;
    if (
      prev
      && heightChanged
      && !autoFollowRef.current
      && !isLoadingOlder
      && !isLoadingNewer
    ) {
      const candidates = buildCandidates(virtualizer.getVirtualItems());
      const delta = resolveScrollAnchorDelta(prev, candidates, el.scrollTop);
      if (delta !== null && Math.abs(delta) >= RESTORE_EPSILON_PX) {
        // Force an instant restore even if a theme or future style adds smooth
        // scrolling. Save/override/restore inline `scroll-behavior` the same
        // way `scrollToBottom` does, wrapped in try/finally so the prior value
        // is always restored.
        const prior = el.style.scrollBehavior;
        try {
          el.style.scrollBehavior = 'auto';
          el.scrollTop += delta;
        } finally {
          el.style.scrollBehavior = prior;
        }
      }
    }
    captureAnchor();
  }, [totalSize, scrollRef, virtualizer, autoFollowRef, captureAnchor, isLoadingOlder, isLoadingNewer]);
}
