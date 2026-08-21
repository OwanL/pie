/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { cx } from '../utils/cx';

interface CollapsibleChevronProps {
  /** Whether the controlled content is expanded. */
  open: boolean;
  /** Square pixel size of the chevron. */
  size?: number;
  /** Extra classes (e.g. for color overrides). */
  class?: string;
}

/**
 * Single consistent collapsible chevron for dropdowns and expand/collapse
 * affordances across the panel (model picker, settings expand buttons,
 * pruning raw-output toggles). Points right when closed and rotates 90° to
 * point down when open. Styling lives under `.collapsible-chevron` in the
 * shared stylesheet so every call site stays visually identical.
 */
export function CollapsibleChevron({ open, size = 10, class: className }: CollapsibleChevronProps) {
  return (
    <span
      class={cx('collapsible-chevron', open && 'collapsible-chevron-open', className)}
      style={{ width: `${size}px`, height: `${size}px` }}
      aria-hidden="true"
    />
  );
}
