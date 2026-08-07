export interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 24;
const AUTO_FOLLOW_BOTTOM_EPSILON_PX = 1;
const SCROLL_TOP_DELTA_EPSILON_PX = 1;
const SCROLL_ANCHOR_VISIBILITY_EPSILON_PX = 1;

export interface ScrollAnchorSnapshot {
  key: string;
  offsetTop: number;
}

export interface ScrollAnchorCandidate {
  key: string;
  top: number;
  bottom: number;
}

export function distanceFromBottom({ scrollHeight, scrollTop, clientHeight }: ScrollMetrics): number {
  return Math.max(0, scrollHeight - scrollTop - clientHeight);
}

export function isNearBottom(
  metrics: ScrollMetrics,
  thresholdPx = AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
): boolean {
  return distanceFromBottom(metrics) <= thresholdPx;
}

interface ResolveAutoFollowArgs {
  previousAutoFollow: boolean;
  previousScrollTop: number;
  nextScrollTop: number;
  metrics: ScrollMetrics;
  scrollTopDeltaEpsilonPx?: number;
}

/**
 * Decides whether auto-follow (stick-to-bottom) stays engaged after a scroll
 * event. Detection is input-device-agnostic: any movement away from the
 * bottom disengages, so keyboard scroll-up (Page Up / Home / ↑ / Shift+Space)
 * — which fires no wheel/touch/pointer event — is caught just like wheel,
 * touch, and scrollbar drag.
 *
 * Auto-follow's own programmatic write only moves `scrollTop` to the bottom,
 * so it cannot trip the "scrolled up" branch. A prior
 * `hasManualScrollIntent` gate let keyboard scroll-up slip through and allowed
 * follow to re-pin the viewport, fighting the reader.
 *
 * Reaching the exact bottom (within a one-pixel browser rounding tolerance)
 * engages follow. Any meaningful upward movement disengages it, even inside
 * the wider 24px visual "near bottom" zone, so a small deliberate user scroll
 * is never overridden by later content growth. A content-shrink clamp remains
 * safe because the browser clamps `scrollTop` to the new exact bottom.
 */
export function resolveAutoFollowState({
  previousAutoFollow,
  previousScrollTop,
  nextScrollTop,
  metrics,
  scrollTopDeltaEpsilonPx = SCROLL_TOP_DELTA_EPSILON_PX,
}: ResolveAutoFollowArgs): boolean {
  if (distanceFromBottom(metrics) <= AUTO_FOLLOW_BOTTOM_EPSILON_PX) {
    return true;
  }

  if (nextScrollTop < previousScrollTop - scrollTopDeltaEpsilonPx) {
    return false;
  }

  return previousAutoFollow;
}

export function captureScrollAnchor(
  candidates: readonly ScrollAnchorCandidate[],
  containerTop = 0,
  visibilityEpsilonPx = SCROLL_ANCHOR_VISIBILITY_EPSILON_PX,
): ScrollAnchorSnapshot | null {
  const firstVisible = candidates.find((candidate) => candidate.bottom > containerTop + visibilityEpsilonPx);
  if (!firstVisible) {
    return null;
  }

  return {
    key: firstVisible.key,
    offsetTop: firstVisible.top - containerTop,
  };
}

export function resolveScrollAnchorDelta(
  previousAnchor: ScrollAnchorSnapshot | null,
  candidates: readonly ScrollAnchorCandidate[],
  containerTop = 0,
): number | null {
  if (!previousAnchor) {
    return null;
  }

  const nextAnchor = candidates.find((candidate) => candidate.key === previousAnchor.key);
  if (!nextAnchor) {
    return null;
  }

  return nextAnchor.top - containerTop - previousAnchor.offsetTop;
}
