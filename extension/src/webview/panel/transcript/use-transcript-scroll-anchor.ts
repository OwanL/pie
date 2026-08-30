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
  /** True while manual scrolling owns scrollTop in either direction. */
  manualScrollActiveRef: { current: boolean };
  /** Browser scroll events expected from app-owned scrollTop writes. */
  programmaticScrollTargetRef: { current: number | null };
  totalSize: number;
  /** Ordered row identities for detecting structure changes that happen to
   * preserve the same aggregate virtual height. */
  rowKeys: readonly string[];
  /** Bounded message navigation owns scrollTop until its target settles. */
  navigationActiveRef: { current: boolean };
  /** Pagination in flight — anchoring is suppressed to avoid fighting the
   *  dedicated load-older scroll-anchor restore. */
  isLoadingOlder: boolean;
  isLoadingNewer: boolean;
}

const RESTORE_EPSILON_PX = 1;

export function shouldApplyScrollAnchorDelta(
  delta: number | null,
  manualScrollActive: boolean,
): delta is number {
  return !manualScrollActive
    && delta !== null
    && Math.abs(delta) >= RESTORE_EPSILON_PX;
}

export function didScrollAnchorGeometryChange(
  previousTotalSize: number,
  nextTotalSize: number,
  previousRowKeys: readonly string[],
  nextRowKeys: readonly string[],
): boolean {
  if (previousTotalSize !== nextTotalSize || previousRowKeys.length !== nextRowKeys.length) {
    return true;
  }
  return previousRowKeys.some((key, index) => key !== nextRowKeys[index]);
}

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
 * with the virtualizer's absolutely-positioned rows), and `useAutoFollow`
 * only acts when the user is pinned to the bottom.
 * So when the user has scrolled UP to read earlier content and a tool body
 * ABOVE the viewport grows or shrinks (streaming output, expand/collapse),
 * the viewport content would visibly shift with no correction — a "jump".
 *
 * This hook pins the topmost visible virtual row: it continuously captures
 * that row's key + viewport-relative offset (on scroll and after each layout
 * commit), and whenever total height or row identity changes while NOT
 * auto-following (and not paginating) it re-pins the row by adjusting
 * `scrollTop` by the row's shift. Bottom-following is left entirely to
 * `useAutoFollow`; the two
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
  manualScrollActiveRef,
  programmaticScrollTargetRef,
  totalSize,
  rowKeys,
  navigationActiveRef,
  isLoadingOlder,
  isLoadingNewer,
}: UseTranscriptScrollAnchorArgs) {
  const anchorRef = useRef<ScrollAnchorSnapshot | null>(null);
  const prevTotalSizeRef = useRef(totalSize);
  const prevRowKeysRef = useRef<readonly string[]>(rowKeys);

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
    const geometryChanged = didScrollAnchorGeometryChange(
      prevTotalSizeRef.current,
      totalSize,
      prevRowKeysRef.current,
      rowKeys,
    );
    prevTotalSizeRef.current = totalSize;
    prevRowKeysRef.current = rowKeys;
    const prev = anchorRef.current;
    if (
      prev
      && geometryChanged
      && !autoFollowRef.current
      && !navigationActiveRef.current
      && !isLoadingOlder
      && !isLoadingNewer
    ) {
      const candidates = buildCandidates(virtualizer.getVirtualItems());
      const delta = resolveScrollAnchorDelta(prev, candidates, el.scrollTop);
      // An anchor restore preserves reading position while idle, but manual
      // scrollbar/wheel/touch/keyboard interaction owns scrollTop in either
      // direction until it settles.
      if (shouldApplyScrollAnchorDelta(delta, manualScrollActiveRef.current)) {
        // Force an instant restore even if a theme or future style adds smooth
        // scrolling. Save/override/restore inline `scroll-behavior` the same
        // way `scrollToBottom` does, wrapped in try/finally so the prior value
        // is always restored.
        const prior = el.style.scrollBehavior;
        const before = el.scrollTop;
        try {
          el.style.scrollBehavior = 'auto';
          el.scrollTop += delta;
        } finally {
          el.style.scrollBehavior = prior;
        }
        programmaticScrollTargetRef.current = el.scrollTop === before ? null : el.scrollTop;
      }
    }
    captureAnchor();
  }, [totalSize, rowKeys, scrollRef, virtualizer, autoFollowRef, manualScrollActiveRef, programmaticScrollTargetRef, navigationActiveRef, captureAnchor, isLoadingOlder, isLoadingNewer]);
}
