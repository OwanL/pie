/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { cx } from './cx';

interface CollapsibleCloseFooterProps {
  /** Collapse the owning expanded section. */
  onCollapse: () => void;
  /** Visible label. Default "Collapse". */
  label?: string;
  class?: string;
}

/**
 * A thin, full-width "Collapse" strip pinned to the bottom of an expanded
 * section's body. Gives users a clear, always-reachable close target at the
 * BOTTOM of a tall/scrollable section — the header (top) and its trailing
 * chevron (side) are the other two close entry points, so wherever the user's
 * eye lands there is an obvious place to click to close.
 *
 * Now that expandable-section headers are no longer sticky (they used to pin to
 * the top of the viewport, which read as a detaching bar), this footer keeps
 * the close action reachable at the bottom of a tall body without the detach.
 */
export function CollapsibleCloseFooter({ onCollapse, label = 'Collapse', class: className }: CollapsibleCloseFooterProps) {
  return (
    <button
      type="button"
      class={cx('collapsible-close-footer', className)}
      aria-label={label}
      title={label}
      onClick={(e) => {
        // Stop propagation so the click doesn't bubble into the section's own
        // header toggle / outer transcript click handlers.
        e.stopPropagation();
        onCollapse();
      }}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="2,7 5,3 8,7" />
      </svg>
      <span>{label}</span>
    </button>
  );
}
