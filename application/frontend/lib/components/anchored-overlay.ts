import { useLayoutEffect } from 'preact/hooks';

interface ElementRef<T extends HTMLElement> {
  current: T | null;
}

interface AnchoredOverlayOptions {
  open: boolean;
  triggerRef: ElementRef<HTMLElement>;
  overlayRef: ElementRef<HTMLElement>;
  preferredDirection?: 'up' | 'down';
  gap?: number;
  margin?: number;
  minHeight?: number;
  maxHeight?: number;
  preferredWidth?: number;
}

export function focusAdjacentControl(trigger: HTMLElement | null, backward: boolean): void {
  const controls = Array.from(document.querySelectorAll<HTMLElement>(
    'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
  ));
  const triggerIndex = trigger ? controls.indexOf(trigger) : -1;
  const target = triggerIndex >= 0
    ? controls[triggerIndex + (backward ? -1 : 1)]
    : trigger;
  window.requestAnimationFrame(() => target?.focus());
}

/** Position a portaled picker against its trigger without delayed remeasurement.
 * The overlay flips toward the roomier side, clamps to every viewport edge, and
 * follows nested scrolling. ResizeObserver handles content/font changes without
 * polling or a fixed post-animation timeout. */
export function useAnchoredOverlay({
  open,
  triggerRef,
  overlayRef,
  preferredDirection = 'up',
  gap = 6,
  margin = 8,
  minHeight = 112,
  maxHeight = 420,
  preferredWidth,
}: AnchoredOverlayOptions): void {
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const overlay = overlayRef.current;
    if (!trigger || !overlay) return;

    let frame = 0;
    const position = () => {
      const rect = trigger.getBoundingClientRect();
      const viewportWidth = Math.max(0, window.innerWidth);
      const viewportHeight = Math.max(0, window.innerHeight);
      const horizontalMargin = Math.min(margin, viewportWidth / 2);
      const availableWidth = Math.max(0, viewportWidth - horizontalMargin * 2);
      const desiredWidth = preferredWidth ?? Math.max(rect.width, overlay.scrollWidth);
      const width = Math.min(Math.max(0, desiredWidth), availableWidth);

      overlay.style.width = `${width}px`;
      overlay.style.maxWidth = `${availableWidth}px`;

      const roomAbove = Math.max(0, rect.top - gap - margin);
      const roomBelow = Math.max(0, viewportHeight - rect.bottom - gap - margin);
      const preferDown = preferredDirection === 'down';
      const direction: 'up' | 'down' = preferDown
        ? (roomBelow >= minHeight || roomBelow >= roomAbove ? 'down' : 'up')
        : (roomAbove >= minHeight || roomAbove >= roomBelow ? 'up' : 'down');
      const room = direction === 'down' ? roomBelow : roomAbove;
      const height = Math.min(maxHeight, Math.max(72, room));

      overlay.dataset.placement = direction;
      overlay.style.maxHeight = `${height}px`;
      const renderedHeight = Math.min(overlay.scrollHeight, height);
      const top = direction === 'down'
        ? rect.bottom + gap
        : rect.top - gap - renderedHeight;
      const left = Math.min(
        Math.max(horizontalMargin, rect.left),
        Math.max(horizontalMargin, viewportWidth - width - horizontalMargin),
      );

      overlay.style.left = `${left}px`;
      overlay.style.top = `${Math.max(margin, top)}px`;
      overlay.style.bottom = '';
    };

    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(position);
    };

    position();
    frame = window.requestAnimationFrame(position);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(schedule)
      : null;
    observer?.observe(trigger);
    observer?.observe(overlay);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      observer?.disconnect();
    };
  }, [open, preferredDirection, gap, margin, minHeight, maxHeight, preferredWidth]);
}
