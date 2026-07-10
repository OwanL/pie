/** @jsxRuntime automatic */

import { useEffect, useRef, useState } from 'preact/hooks';

/**
 * Animate a numeric value toward its latest target, rendering an
 * interpolated string every animation frame.
 *
 * Used by the aggregate-stats strip so its headline numbers (cost, tokens,
 * tok/s, …) *tick* up and down between host snapshots instead of snapping.
 * The host recompute cadence (see `RECOMPUTE_MS`) is the rate at which new
 * targets arrive; this hook fills the gaps with a short ease-out tween driven
 * by `requestAnimationFrame`, so the eye sees continuous motion.
 *
 * Retargeting: when a new `value` arrives mid-tween, the animation restarts
 * from the *currently displayed* value (chase) — never jumps to the new
 * target. This keeps motion smooth even when targets arrive faster than the
 * tween duration (e.g. 7 snapshots/sec during streaming).
 *
 * The `format` function is read through a ref so callers may pass an inline
 * arrow without retriggering the effect; only `value` changes restart the
 * tween. Intermediate fractional values are passed to `format` — formatters
 * that render integers should round (e.g. `n => String(Math.round(n))`), in
 * which case the tween snaps at the midpoint rather than showing a fraction.
 */
const DEFAULT_DURATION_MS = 260;

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function useAnimatedNumber(
  value: number,
  format: (n: number) => string,
  durationMs: number = DEFAULT_DURATION_MS,
): string {
  const [display, setDisplay] = useState(() => format(value));
  const fromRef = useRef(value);
  const toRef = useRef(value);
  const startRef = useRef(0);
  const rafRef = useRef<number>(0);
  const curRef = useRef(value);
  const fmtRef = useRef(format);
  fmtRef.current = format;

  useEffect(() => {
    // No numeric change → nothing to tween (also covers the initial mount,
    // where display was already initialised from `format(value)`).
    if (value === toRef.current) return;
    fromRef.current = curRef.current;
    toRef.current = value;
    startRef.current = performance.now();
    cancelAnimationFrame(rafRef.current);
    const tick = (now: number): void => {
      const t = Math.min(1, (now - startRef.current) / durationMs);
      const eased = easeOutCubic(t);
      const cur = fromRef.current + (toRef.current - fromRef.current) * eased;
      curRef.current = cur;
      setDisplay(fmtRef.current(cur));
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [value, durationMs]);

  // Cancel any pending frame on unmount.
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  return display;
}