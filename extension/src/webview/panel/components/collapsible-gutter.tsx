/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { cx } from '../utils/cx';

interface CollapsibleGutterProps {
  /** Collapse the owning expanded section. */
  onCollapse: () => void;
  /** Visible/aria label. Default "Collapse". */
  label?: string;
  /** Extra classes. */
  class?: string;
}

/**
 * A vertical collapse hitbox pinned to the left gutter (the border /
 * indentation area) of an expanded collapsible section. Lets the user
 * collapse a tall, internally-scrollable section from anywhere along its
 * left edge — without scrolling back to the header (top) or the "Collapse"
 * footer (bottom), which were previously the only two close targets.
 *
 * Rendered as an absolutely-positioned `<button>` whose containing block is
 * the section's body clip (`.collapsible-body-clip` / `.tool-call-body-inner`),
 * which must be `position: relative`. The strip sits in the body's left
 * padding / inset gutter — empty space — so it never overlaps selectable
 * body content (text, code, nested controls) and never steals their clicks.
 * Because it is anchored to the (bounded) body wrapper rather than the
 * scrolling content, it stays put while the inner region scrolls, so it is
 * always reachable mid-scroll.
 *
 * Visually unobtrusive by default (transparent, sitting inside the
 * indentation); on hover/focus it washes a subtle accent and reveals a
 * chevron-up so the affordance reads as the same "collapse" intent as the
 * bottom `CollapsibleCloseFooter` (▲) and the header chevron.
 */
export function CollapsibleGutter({ onCollapse, label = 'Collapse', class: className }: CollapsibleGutterProps) {
  return (
    <button
      type="button"
      class={cx('collapsible-gutter', className)}
      aria-label={label}
      title={label}
      // Stop propagation so the click doesn't bubble into the owning
      // section's header toggle / outer transcript click handlers (which
      // would re-toggle and cancel the collapse, or run delegated handlers
      // like code-block copy).
      onClick={(e) => {
        e.stopPropagation();
        onCollapse();
      }}
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 10 10"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <polyline points="2,7 5,3 8,7" />
      </svg>
    </button>
  );
}