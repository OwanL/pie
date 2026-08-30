/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { cloneElement, render, toChildArray, type ComponentChildren, type JSX, type VNode } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

let tooltipIdCounter = 0;

function nextTooltipId(): string {
  tooltipIdCounter += 1;
  return `pie-tooltip-${tooltipIdCounter}`;
}

function clearTimer(id: number | undefined): void {
  if (id !== undefined) {
    window.clearTimeout(id);
  }
}

export interface TooltipProps {
  /** Tooltip text. Null/undefined/empty hides the tooltip. Ignored when
   *  `contentNode` is provided. */
  content?: string | null | undefined;
  /** Rich tooltip content (JSX). When provided, the tooltip renders this
   *  subtree into the host via an imperative Preact root (instead of setting
   *  `textContent`), and becomes **hoverable**: the host gets `pointer-events:
   *  auto` with a trigger↔host bridge so interactive content — e.g. a chart
   *  with a hover crosshair — can be inspected without the tooltip dismissing.
   *  `freezeWhileVisible` snapshots the subtree at show time so a live-updating
   *  parent does not re-render the chart mid-hover. */
  contentNode?: ComponentChildren;
  /** Element that triggers the tooltip. */
  children?: ComponentChildren;
  /** Delay before showing, in milliseconds. */
  delayShow?: number;
  /** Delay before hiding, in milliseconds. Bumped to ≥200ms automatically for
   *  rich (hoverable) tooltips so the pointer can cross the trigger→host gap. */
  delayHide?: number;
  /** Preferred placement relative to the trigger. */
  placement?: 'top' | 'bottom';
  /**
   * Extra class(es) for the trigger wrapper. Useful when the wrapper is a flex
   * item and needs layout-only styling (e.g. `margin-left: auto` to pin a
   * status-strip segment to the right edge) that can't live on the inner child.
   */
  triggerClassName?: string;
  /**
   * When true, snapshot the tooltip content the moment it becomes visible and keep
   * showing that snapshot for the rest of the hover, ignoring updates to
   * `content`/`contentNode` while visible. Live indicators (tokens/sec) rebuild their
   * tooltip many times per second; without freezing, each rebuild re-centers
   * the tooltip on its new width and it jumps — unreadable during fast
   * generation. Freezing yields a stable, readable snapshot; the visible chip
   * label keeps updating live, and re-hovering refreshes the snapshot.
   */
  freezeWhileVisible?: boolean;
  /**
   * ARIA role for rich content that contains interactive controls. Ordinary
   * tooltips keep `role="tooltip"`; `region` is a non-modal rich surface so
   * descendants such as provider legend buttons are not placed in a tooltip
   * landmark. Ignored for plain text content.
   */
  richRole?: 'tooltip' | 'region';
}

/**
 * Custom tooltip wrapper.
 *
 * Native `title` tooltips close whenever the titled element re-renders, which
 * makes live indicators (tokens/sec, context window, cost, run status) hard to
 * inspect during active sessions. This component renders an out-of-tree DOM
 * node for the tooltip so it survives parent re-renders and updates its content
 * in place while the pointer is still over the trigger.
 *
 * Two content modes:
 *  - **text** (`content` string): fast path, sets `host.textContent`. Pointer
 *    events are disabled so the tooltip never steals the hover from the trigger.
 *  - **rich** (`contentNode` JSX): renders a Preact subtree into the host via an
 *    imperative `render()` root. The host becomes hoverable (pointer events on,
 *    with a trigger↔host bridge) so interactive content like a chart crosshair
 *    can be used. `freezeWhileVisible` keeps the subtree mounted and stable for
 *    the whole hover.
 */
export function Tooltip({
  content,
  contentNode,
  children,
  delayShow = 350,
  delayHide = 50,
  placement = 'bottom',
  freezeWhileVisible = false,
  richRole = 'tooltip',
  triggerClassName,
}: TooltipProps): JSX.Element {
  const [isVisible, setIsVisible] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const hostIdRef = useRef<string>(nextTooltipId());
  const timersRef = useRef<{ show?: number; hide?: number }>({});
  /**
   * Frozen tooltip snapshot (only used when `freezeWhileVisible` is set).
   * `undefined` = no snapshot yet (not hovering, or freeze disabled); a
   * string/null = the value captured at show time, displayed for the rest of
   * the hover so live `content` updates are ignored. Captured once per show
   * (the `=== undefined` guard) and cleared on hide.
   */
  const frozenContentRef = useRef<string | null | undefined>(undefined);
  /** Frozen rich-content snapshot (parallel to {@link frozenContentRef}). */
  const frozenContentNodeRef = useRef<ComponentChildren | undefined>(undefined);
  /** Whether the host currently mounts a Preact subtree (rich mode). Tracked so
   *  hide/unmount can `render(null, host)` to tear it down cleanly instead of
   *  clobbering Preact-managed DOM with `textContent`. */
  const richMountedRef = useRef(false);
  /** The trigger's viewport rect captured the last time the host was positioned.
   *  Used by the scroll handler to tell whether the trigger actually moved on
   *  scroll — tooltips in fixed containers (bottom status strip, composer
   *  toolbar) don't move when the transcript auto-scrolls during a run, so
   *  they stay open; transcript-message tooltips whose triggers scroll with the
   *  content still dismiss (a fixed tooltip would otherwise detach and float). */
  const lastTriggerRectRef = useRef<{ top: number; bottom: number } | null>(null);

  const hasRich = contentNode !== undefined && contentNode !== null && contentNode !== '';
  // Rich tooltips are hoverable: give the pointer enough time to cross the
  // trigger→host gap before the hide fires.
  const effectiveDelayHide = hasRich ? Math.max(delayHide, 200) : delayHide;

  const showTooltip = useCallback(() => {
    clearTimer(timersRef.current.hide);
    timersRef.current.hide = undefined;
    if (timersRef.current.show) return;
    timersRef.current.show = window.setTimeout(() => {
      timersRef.current.show = undefined;
      setIsVisible(true);
    }, delayShow);
  }, [delayShow]);

  const hideTooltip = useCallback(() => {
    clearTimer(timersRef.current.show);
    timersRef.current.show = undefined;
    if (timersRef.current.hide) return;
    timersRef.current.hide = window.setTimeout(() => {
      timersRef.current.hide = undefined;
      setIsVisible(false);
    }, effectiveDelayHide);
  }, [effectiveDelayHide]);

  /** Close immediately for keyboard dismissal. Pointer leave keeps its small
   * bridge delay so the pointer can cross the trigger→host gap. */
  const dismissTooltip = useCallback(() => {
    clearTimer(timersRef.current.show);
    clearTimer(timersRef.current.hide);
    timersRef.current.show = undefined;
    timersRef.current.hide = undefined;
    setIsVisible(false);
  }, []);

  // Refs so the imperatively-attached host bridge listeners always call the
  // latest callbacks without re-binding on every render.
  const hideTooltipRef = useRef(hideTooltip);
  hideTooltipRef.current = hideTooltip;

  // Snapshot the tooltip content when it becomes visible (and clear it on hide)
  // so a frozen tooltip ignores further `content`/`contentNode` updates for the
  // rest of the hover. Captured once per show (the `=== undefined` guard).
  useEffect(() => {
    if (!freezeWhileVisible) return;
    if (isVisible) {
      if (frozenContentRef.current === undefined) {
        frozenContentRef.current = content ?? null;
      }
      if (frozenContentNodeRef.current === undefined) {
        frozenContentNodeRef.current = contentNode;
      }
    } else {
      frozenContentRef.current = undefined;
      frozenContentNodeRef.current = undefined;
    }
  }, [isVisible, content, contentNode, freezeWhileVisible]);

  // The content actually displayed: the frozen snapshot while a frozen tooltip
  // is visible, otherwise the live value.
  const effectiveContent = freezeWhileVisible && frozenContentRef.current !== undefined
    ? frozenContentRef.current
    : content;
  const effectiveContentNode = freezeWhileVisible && frozenContentNodeRef.current !== undefined
    ? frozenContentNodeRef.current
    : contentNode;
  const effectiveHasRich = effectiveContentNode !== undefined && effectiveContentNode !== null && effectiveContentNode !== '';

  // Create host lazily and update its content/position whenever visibility or
  // the displayed content changes. Keeping the host outside the React tree means
  // parent re-renders never unmount or recreate the tooltip while the pointer
  // is hovering, and re-using the same DOM node while visible avoids flicker
  // when live values update frequently (e.g. the tokens/sec indicator).
  useEffect(() => {
    let host = hostRef.current;
    if (!host) {
      host = document.createElement('div');
      host.id = hostIdRef.current;
      host.className = 'pie-tooltip-host';
      host.role = 'tooltip';
      host.style.position = 'fixed';
      host.style.zIndex = '300';
      // Bridge: moving the pointer from the trigger onto a rich tooltip cancels
      // the pending hide (so it stays open while inspected); leaving the host
      // starts the hide. Text tooltips keep pointer-events:none so these never
      // fire (the pointer-events style is toggled per-show below).
      host.addEventListener('mouseenter', () => {
        clearTimer(timersRef.current.hide);
        timersRef.current.hide = undefined;
      });
      host.addEventListener('mouseleave', () => {
        hideTooltipRef.current();
      });
      // Keyboard focus can move from the trigger into the out-of-tree rich
      // surface. Treat that as one focus boundary, just like the pointer
      // trigger↔host bridge, so nested legend controls remain reachable.
      const tooltipHost = host as HTMLDivElement;
      tooltipHost.addEventListener('focusin', () => {
        clearTimer(timersRef.current.hide);
        timersRef.current.hide = undefined;
      });
      tooltipHost.addEventListener('focusout', (event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && (tooltipHost === next || tooltipHost.contains(next) || triggerRef.current?.contains(next))) return;
        dismissTooltip();
      });
      document.body.appendChild(host);
      hostRef.current = host;
    }

    const trigger = triggerRef.current;
    const showRich = effectiveHasRich;
    const hostRole = showRich ? richRole : 'tooltip';
    host.setAttribute('role', hostRole);
    const triggerLabel = trigger?.getAttribute('aria-label')
      ?? trigger?.firstElementChild?.getAttribute('aria-label');
    if (showRich && hostRole === 'region' && triggerLabel) {
      host.setAttribute('aria-label', triggerLabel);
    } else {
      host.removeAttribute('aria-label');
    }

    if (!isVisible || (!effectiveContent && !showRich) || !trigger) {
      host.style.display = 'none';
      if (richMountedRef.current) {
        render(null, host);
        richMountedRef.current = false;
      } else {
        host.textContent = '';
      }
      lastTriggerRectRef.current = null;
      return;
    }

    host.style.display = 'block';
    host.style.pointerEvents = showRich ? 'auto' : 'none';
    host.className = showRich ? 'pie-tooltip-host pie-tooltip-host--rich' : 'pie-tooltip-host';

    if (showRich) {
      // Render the rich subtree into the host via an isolated Preact root.
      // Synchronous, so the host is sized before we measure below. With
      // `freezeWhileVisible`, `effectiveContentNode` is a stable snapshot, so
      // this mounts the chart once per hover and its internal hover state
      // persists for the rest of the hover.
      render(effectiveContentNode as ComponentChildren, host);
      richMountedRef.current = true;
    } else {
      host.textContent = effectiveContent ?? '';
      richMountedRef.current = false;
    }

    const rect = trigger.getBoundingClientRect();
    // Snapshot the trigger rect so the scroll handler can detect whether the
    // trigger actually moved on scroll (vs. a fixed container that stayed put).
    lastTriggerRectRef.current = { top: rect.top, bottom: rect.bottom };
    const hostRect = host.getBoundingClientRect();
    const gap = 6;

    let top =
      placement === 'bottom'
        ? rect.bottom + gap
        : rect.top - hostRect.height - gap;
    let left = rect.left + rect.width / 2 - hostRect.width / 2;

    // Keep inside the viewport.
    const maxLeft = window.innerWidth - hostRect.width - gap;
    left = Math.max(gap, Math.min(left, maxLeft));
    if (top + hostRect.height + gap > window.innerHeight) {
      top = rect.top - hostRect.height - gap;
    }
    top = Math.max(gap, top);

    host.style.top = `${top}px`;
    host.style.left = `${left}px`;
  }, [isVisible, effectiveContent, effectiveContentNode, effectiveHasRich, placement, richRole, dismissTooltip]);

  // Remove the host when the component unmounts, and tear down any pending timers.
  useEffect(() => {
    return () => {
      const host = hostRef.current;
      if (host) {
        if (richMountedRef.current) {
          render(null, host);
        }
        hostRef.current = null;
        document.body.removeChild(host);
      }
      clearTimer(timersRef.current.show);
      clearTimer(timersRef.current.hide);
    };
  }, []);

  // Hide on Escape or viewport resize. For scroll, only dismiss when the
  // trigger actually moved with the scroll. The transcript auto-follows during a
  // run (scroll events fire ~continuously while content streams), but tooltips
  // in fixed containers — the bottom status strip and the composer toolbar —
  // don't move with that scroll, so they must stay open and inspectable instead
  // of dismissing on every content update. Compare the trigger's current rect
  // against the one captured at positioning time; a >1px shift means the trigger
  // scrolled (e.g. a transcript-message tooltip) and the fixed tooltip would
  // detach, so dismiss. Capture phase so it catches scroll within nested
  // scrollable containers like the transcript.
  useEffect(() => {
    if (!isVisible) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismissTooltip();
    };
    const handleResize = () => setIsVisible(false);
    const handleScroll = () => {
      const trigger = triggerRef.current;
      const last = lastTriggerRectRef.current;
      if (!trigger || !last) return;
      const r = trigger.getBoundingClientRect();
      if (Math.abs(r.top - last.top) > 1 || Math.abs(r.bottom - last.bottom) > 1) {
        setIsVisible(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [isVisible, dismissTooltip]);

  const childArray = toChildArray(children);
  const singleChild = childArray.length === 1 ? childArray[0] : null;
  const singleVNode =
    singleChild && typeof singleChild === 'object' && 'props' in singleChild
      ? (singleChild as VNode)
      : null;

  // Clone a single element child so keyboard focus on interactive triggers
  // (buttons, selects) also opens/closes the tooltip. The wrapper still owns the
  // mouse/pointer events and the positioning ref.
  const originalDescribedBy = singleVNode
    ? (singleVNode.props as { 'aria-describedby'?: string })['aria-describedby']
    : undefined;
  const describedBy = isVisible
    ? (originalDescribedBy ? `${originalDescribedBy} ${hostIdRef.current}` : hostIdRef.current)
    : originalDescribedBy;

  const wrappedChildren = singleVNode
    ? cloneElement(singleVNode, {
        'aria-describedby': describedBy,
        onFocus: (e: FocusEvent) => {
          (singleVNode.props as { onFocus?: (event: FocusEvent) => void }).onFocus?.(e);
          showTooltip();
        },
        onKeyDown: (e: KeyboardEvent) => {
          (singleVNode.props as { onKeyDown?: (event: KeyboardEvent) => void }).onKeyDown?.(e);
          if (e.key === 'Escape') {
            e.preventDefault();
            dismissTooltip();
            return;
          }
          // Rich aggregate surfaces live in an out-of-tree host. Move Tab
          // into their first control explicitly; otherwise the browser visits
          // the rest of the panel, blurs the trigger, and hides the host before
          // its provider legend controls can be reached.
          if (e.key !== 'Tab' || e.shiftKey || !isVisible || richRole !== 'region') return;
          const host = hostRef.current;
          const firstControl = host?.querySelector<HTMLElement>(
            'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
          );
          if (!firstControl) return;
          e.preventDefault();
          firstControl.focus();
        },
        onBlur: (e: FocusEvent) => {
          (singleVNode.props as { onBlur?: (event: FocusEvent) => void }).onBlur?.(e);
          const relatedTarget = e.relatedTarget;
          const host = hostRef.current;
          // Moving into the out-of-tree rich surface is still inside the
          // tooltip's keyboard interaction boundary. Any other blur closes
          // immediately; pointer leave retains its existing delayed behavior.
          if (host && relatedTarget instanceof Node && (host === relatedTarget || host.contains(relatedTarget))) return;
          dismissTooltip();
        },
      })
    : children;

  return (
    <span
      ref={triggerRef}
      class={triggerClassName ? `pie-tooltip-trigger ${triggerClassName}` : 'pie-tooltip-trigger'}
      aria-describedby={singleVNode ? undefined : (isVisible ? hostIdRef.current : undefined)}
      onMouseEnter={showTooltip}
      onMouseLeave={hideTooltip}
      onPointerEnter={showTooltip}
      onPointerLeave={hideTooltip}
    >
      {wrappedChildren}
    </span>
  );
}
