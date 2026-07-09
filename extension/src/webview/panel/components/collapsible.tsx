/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ComponentChildren } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';

import { cx } from '../utils/cx';
import { CollapsibleChevron } from './chevron';
import { CollapsibleCloseFooter } from './collapsible-close-footer';

export interface CollapsibleProps {
  /** Controlled open state. Callers own this (useCollapsibleOpen or useState). */
  open: boolean;
  onToggle: (open: boolean) => void;
  /** Header content rendered on the leading side (label, summary, meta).
   *  Caller controls the full layout; Collapsible appends a trailing chevron. */
  header: ComponentChildren;
  /** Show the rotating chevron affordance. Default true. */
  chevron?: boolean;
  ariaLabel?: string;
  /** Outer wrapper classes (card surface, layout). */
  class?: string;
  /** Classes for the header `<button>` (padding, site-specific layout). */
  headerClass?: string;
  bodyClass?: string;
  /** Render the "Collapse" footer strip at the bottom of the open body
   *  (default true). Opt out for trivially short bodies where a footer would
   *  just be chrome. The header (top) + chevron (side) remain close targets. */
  closeFooter?: boolean;
  onContextMenu?: (e: MouseEvent) => void;
  /** Optional data-* attributes for the outer wrapper (e.g. scroll anchors). */
  dataAttrs?: Record<string, string>;
  children: ComponentChildren;
}

/** Duration (ms) of the open→closed grid-track animation. Keep in sync with the
 *  `transition` on `.collapsible-body-wrap` in styles/highlight.css. */
const COLLAPSIBLE_CLOSE_MS = 200;

/**
 * Generic, consistent expand/collapse container for transcript sections
 * (reasoning, system prompts, pruning, …). Provides multiple clear close
 * affordances:
 *  - TOP: the header `<button>` (native keyboard + a11y, no div-onClick) — a
 *    full-width toggle with hover/focus states, `aria-expanded`, and a trailing
 *    chevron. Its `title` flips to "Collapse"/"Expand" so the click intent is
 *    obvious.
 *  - SIDE: the trailing chevron on the right of the header (part of the header
 *    hitbox), clearly a collapse control when open.
 *  - BOTTOM: a `CollapsibleCloseFooter` "Collapse ▲" strip at the bottom of the
 *    body (default on), so a tall/scrollable body always has a reachable close
 *    at its end — the header is no longer sticky (it used to pin to the top of
 *    the viewport, which read as a detaching bar), so this footer preserves
 *    reachability without the detach.
 *
 * The body is a sibling of the header button — never nested inside it — so
 * expanded content stays selectable and nested collapsibles compose without
 * propagation hacks.
 *
 * Closing animates: the body stays mounted with `data-closing` while a
 * grid-track `1fr→0fr` transition collapses it, then unmounts (with a timer
 * fallback for environments where `transitionend` doesn't fire). Opening
 * mounts instantly — animating `0fr→1fr` against freshly-laid-out content
 * stuttered (the 1fr reference shifts mid-animation), so open stays a plain
 * mount, matching the tool-call card's manual-open behaviour.
 *
 * Controlled only — callers own the open state so streaming/auto-show sites
 * (tool calls, subagents) can keep their own open/close logic and still reuse
 * the same visual affordance via `CollapsibleChevron` + `.collapsible-*` classes.
 */
export function Collapsible({
  open,
  onToggle,
  header,
  chevron = true,
  ariaLabel,
  class: className,
  headerClass,
  bodyClass,
  closeFooter = true,
  onContextMenu,
  dataAttrs,
  children,
}: CollapsibleProps) {
  // `closing` keeps the body mounted while the grid-track close animation runs,
  // then clears (on transitionend or a fallback timer) to unmount it.
  const [closing, setClosing] = useState(false);
  const closeFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable id for the body region so the header button can reference it via
  // `aria-controls`. Only set on the header when the body is actually mounted
  // (open or closing) — referencing a missing id when collapsed would be
  // invalid per WAI-ARIA.
  const bodyId = useId();

  const renderBody = open || closing;

  // Opening clears any lingering closing state.
  useEffect(() => {
    if (open) setClosing(false);
  }, [open]);

  // Clear the fallback timer on unmount.
  useEffect(
    () => () => {
      if (closeFallbackRef.current) clearTimeout(closeFallbackRef.current);
    },
    [],
  );

  const beginClose = () => {
    // Guard re-entry: clicking the footer while already closing is a no-op.
    if (closing && !open) return;
    if (closeFallbackRef.current) clearTimeout(closeFallbackRef.current);
    setClosing(true);
    onToggle(false);
    // Fallback: if transitionend doesn't fire (the tab is backgrounded, etc.)
    // the body must still unmount.
    closeFallbackRef.current = setTimeout(() => {
      closeFallbackRef.current = null;
      setClosing(false);
    }, COLLAPSIBLE_CLOSE_MS + 60);
  };

  const toggle = () => {
    if (open) beginClose();
    else onToggle(true);
  };

  const onTransitionEnd = (e: TransitionEvent) => {
    // Only react to transitions on the wrapper itself, not children.
    if (e.target !== e.currentTarget) return;
    if (closing && !open) {
      if (closeFallbackRef.current) {
        clearTimeout(closeFallbackRef.current);
        closeFallbackRef.current = null;
      }
      setClosing(false);
    }
  };

  return (
    <div
      class={cx('collapsible', open && 'collapsible-open', className)}
      {...(dataAttrs as Record<string, string> | undefined)}
      onContextMenu={onContextMenu ? (e) => { e.preventDefault(); onContextMenu(e as unknown as MouseEvent); } : undefined}
    >
      <button
        type="button"
        class={cx('collapsible-header', headerClass)}
        aria-expanded={open}
        aria-controls={renderBody ? bodyId : undefined}
        aria-label={ariaLabel}
        title={open ? 'Collapse' : 'Expand'}
        onClick={toggle}
      >
        <div class="collapsible-header-content">{header}</div>
        {chevron && <CollapsibleChevron open={open} />}
      </button>
      {renderBody && (
        <div
          class="collapsible-body-wrap"
          data-closing={!open && closing ? 'true' : undefined}
          onTransitionEnd={onTransitionEnd}
        >
          <div class="collapsible-body-clip">
            <div id={bodyId} class={cx('collapsible-body', bodyClass)}>
              {children}
              {closeFooter && renderBody && (
                <CollapsibleCloseFooter onCollapse={beginClose} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
