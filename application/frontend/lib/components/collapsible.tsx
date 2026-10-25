/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ComponentChildren } from 'preact';
import { useId, useRef } from 'preact/hooks';
import { useDisclosureMotion } from './use-disclosure-motion';

import { cx } from './cx';
import { toMouseEvent } from './preact-events';
import { CollapsibleChevron } from './chevron';
import { CollapsibleCloseFooter } from './collapsible-close-footer';
import { CollapsibleGutter } from './collapsible-gutter';

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
 * The measured body retains its last open content until closing settles.
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
  const disclosure = useDisclosureMotion(open);
  const bodyId = useId();
  // Parents may clear lazy HTML as soon as they commit closed state.
  const lastOpenChildren = useRef(children);
  if (!disclosure.mounted) lastOpenChildren.current = null;
  else if (open) lastOpenChildren.current = children;
  const renderBody = disclosure.mounted;
  const beginClose = () => { if (open) onToggle(false); };
  const toggle = () => onToggle(!open);

  return (
    <div
      class={cx('collapsible', open && 'collapsible-open', className)}
      {...(dataAttrs as Record<string, string> | undefined)}
      onContextMenu={onContextMenu ? (e) => { e.preventDefault(); onContextMenu(toMouseEvent(e)); } : undefined}
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
          ref={disclosure.bodyRef}
          inert={!open}
          aria-hidden={!open}
        >
          <div ref={disclosure.contentRef} class="collapsible-body-clip">
            <div id={bodyId} class={cx('collapsible-body', bodyClass)}>
              {open ? children : lastOpenChildren.current}
              {closeFooter && renderBody && (
                <CollapsibleCloseFooter onCollapse={beginClose} />
              )}
            </div>
            {/* Side collapse hitbox: the left border/indentation gutter. Only
                while actually open (not during the close animation), so it
                vanishes with the body instead of lingering on a collapsing
                track. */}
            {open && <CollapsibleGutter onCollapse={beginClose} />}
          </div>
        </div>
      )}
    </div>
  );
}
