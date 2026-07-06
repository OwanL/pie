/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { cloneElement, toChildArray, type ComponentChildren, type JSX, type VNode } from 'preact';
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
  /** Tooltip text. Null/undefined/empty hides the tooltip. */
  content: string | null | undefined;
  /** Element that triggers the tooltip. */
  children?: ComponentChildren;
  /** Delay before showing, in milliseconds. */
  delayShow?: number;
  /** Delay before hiding, in milliseconds. */
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
   * When true, snapshot the tooltip text the moment it becomes visible and keep
   * showing that snapshot for the rest of the hover, ignoring updates to
   * `content` while visible. Live indicators (e.g. tokens/sec) rebuild their
   * tooltip many times per second; without freezing, each rebuild re-centers
   * the tooltip on its new width and it jumps — unreadable during fast
   * generation. Freezing yields a stable, readable snapshot; the visible chip
   * label keeps updating live, and re-hovering refreshes the snapshot.
   */
  freezeWhileVisible?: boolean;
}

/**
 * Custom tooltip wrapper.
 *
 * Native `title` tooltips close whenever the titled element re-renders, which
 * makes live indicators (tokens/sec, context window, cost, run status) hard to
 * inspect during active sessions. This component renders an out-of-tree DOM
 * node for the tooltip so it survives parent re-renders and updates its text
 * in place while the pointer is still over the trigger.
 */
export function Tooltip({
  content,
  children,
  delayShow = 350,
  delayHide = 50,
  placement = 'bottom',
  freezeWhileVisible = false,
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
    }, delayHide);
  }, [delayHide]);

  // Snapshot the tooltip text when it becomes visible (and clear it on hide)
  // so a frozen tooltip ignores further `content` updates for the rest of the
  // hover. `content` is in the deps so we read the latest text at show time,
  // but the `=== undefined` guard captures it only once per hover — subsequent
  // live updates re-run this effect but skip the assignment, leaving the
  // snapshot intact.
  useEffect(() => {
    if (!freezeWhileVisible) return;
    if (isVisible) {
      if (frozenContentRef.current === undefined) {
        frozenContentRef.current = content ?? null;
      }
    } else {
      frozenContentRef.current = undefined;
    }
  }, [isVisible, content, freezeWhileVisible]);

  // The text actually displayed: the frozen snapshot while a frozen tooltip is
  // visible, otherwise the live `content`.
  const effectiveContent = freezeWhileVisible && frozenContentRef.current !== undefined
    ? frozenContentRef.current
    : content;

  // Create host lazily and update its content/position whenever visibility or
  // the displayed text changes. Keeping the host outside the React tree means
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
      host.style.pointerEvents = 'none';
      document.body.appendChild(host);
      hostRef.current = host;
    }

    const trigger = triggerRef.current;

    if (!isVisible || !effectiveContent || !trigger) {
      host.style.display = 'none';
      host.textContent = '';
      return;
    }

    host.style.display = 'block';
    host.textContent = effectiveContent;

    const rect = trigger.getBoundingClientRect();
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
  }, [isVisible, effectiveContent, placement]);

  // Remove the host when the component unmounts, and tear down any pending timers.
  useEffect(() => {
    return () => {
      const host = hostRef.current;
      if (host) {
        hostRef.current = null;
        document.body.removeChild(host);
      }
      clearTimer(timersRef.current.show);
      clearTimer(timersRef.current.hide);
    };
  }, []);

  // Hide on Escape, viewport resize, or any scroll (capture phase so it
  // catches scroll within nested scrollable containers like the transcript,
  // which auto-scrolls during a run and would leave the fixed tooltip
  // detached from its trigger).
  useEffect(() => {
    if (!isVisible) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsVisible(false);
    };
    const handleResize = () => setIsVisible(false);
    const handleScroll = () => setIsVisible(false);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [isVisible]);

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
        onBlur: (e: FocusEvent) => {
          (singleVNode.props as { onBlur?: (event: FocusEvent) => void }).onBlur?.(e);
          hideTooltip();
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
