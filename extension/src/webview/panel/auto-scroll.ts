export interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 24;
const AUTO_FOLLOW_BOTTOM_EPSILON_PX = 1;
const SCROLL_TOP_DELTA_EPSILON_PX = 1;
const SCROLL_ANCHOR_VISIBILITY_EPSILON_PX = 1;

/**
 * Bounds each auto-follow movement so a burst of rendered content glides into
 * view instead of moving the whole viewport in one frame. The interpolation
 * handles small updates without a visible stutter. Large backlogs relax the
 * ordinary cap so a fast producer cannot outrun follow indefinitely.
 */
export const SMOOTH_SCROLL_INTERPOLATION = 0.35;
export const SMOOTH_SCROLL_MIN_STEP_PX = 2;
export const SMOOTH_SCROLL_MAX_STEP_PX = 48;
export const SMOOTH_SCROLL_SNAP_EPSILON_PX = 1;

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

/**
 * Return the next bounded bottom-follow position. Explicit navigation and the
 * initial session placement intentionally do not use this helper: they retain
 * their immediate snap semantics. This is only for ordinary content/viewport
 * growth while the user has chosen to follow the live edge.
 */
export function advanceSmoothScrollTop(
  currentScrollTop: number,
  targetScrollTop: number,
  interpolation = SMOOTH_SCROLL_INTERPOLATION,
  minStepPx = SMOOTH_SCROLL_MIN_STEP_PX,
  maxStepPx = SMOOTH_SCROLL_MAX_STEP_PX,
  snapEpsilonPx = SMOOTH_SCROLL_SNAP_EPSILON_PX,
): number {
  const delta = targetScrollTop - currentScrollTop;
  if (Math.abs(delta) <= snapEpsilonPx) return targetScrollTop;

  // Preserve gentle ordinary bursts, but catch up proportionally when a
  // producer adds content faster than the ordinary per-frame cap can follow.
  const catchUpCap = Math.max(maxStepPx, Math.abs(delta) / 16);
  const step = Math.min(catchUpCap, Math.max(minStepPx, Math.abs(delta) * interpolation));
  const next = currentScrollTop + Math.sign(delta) * step;
  return delta > 0
    ? Math.min(next, targetScrollTop)
    : Math.max(next, targetScrollTop);
}
