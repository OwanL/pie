/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { cx } from '../utils/cx';
import { useAnimatedNumber } from '../hooks/use-animated-number';

/**
 * A single animated, fixed-width numeric cell for the aggregate-stats strip.
 *
 * Two guarantees the strip relies on:
 *
 *  1. **Interpolation** — the displayed value eases toward `value` over a short
 *     tween (`useAnimatedNumber`), so numbers tick up/down instead of snapping
 *     between host snapshots.
 *  2. **Constant horizontal alignment** — the cell is right-aligned within a
 *     fixed `minWidth` (in `ch`, paired with `tabular-nums` + the strip's mono
 *     font). When a value grows from `2` to `20` the cell's outer width does
 *     not change, so neighbouring segments never shift rightward. `minWidth`
 *     is a per-field ceiling in characters; if a value ever exceeds it the cell
 *     grows (graceful failure) rather than truncating.
 *
 * Pass an integer-rounding `format` (e.g. `n => String(Math.round(n))`) for
 * discrete counts; the tween then snaps at the midpoint instead of rendering a
 * fraction like `1.7`.
 */
interface NumProps {
  value: number;
  format: (n: number) => string;
  /** Fixed cell width in `ch` characters (mono font → reliable). Should be the
   *  realistic ceiling width for this field so digit-count changes never
   *  resize the cell. */
  width: number;
  class?: string;
}

export function Num({ value, format, width, class: className }: NumProps) {
  const display = useAnimatedNumber(value, format);
  return (
    <span
      class={cx('aggregate-strip-num', className)}
      style={`min-width:${width}ch`}
    >{display}</span>
  );
}