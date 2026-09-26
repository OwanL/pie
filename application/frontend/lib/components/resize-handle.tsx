/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { cx } from './cx';

type ResizeEdge = 'top' | 'bottom' | 'left' | 'right';

interface ResizeHandleProps {
  edge: ResizeEdge;
  onMouseDown: (e: MouseEvent) => void;
  class?: string;
  label?: string;
  /** Current height in px (vertical handles); null until the user resizes. */
  height?: number | null;
  /** Min/max height for aria-valuemin/aria-valuemax (vertical handles). */
  minHeight?: number;
  maxHeight?: number;
  /** Current width in px (horizontal handles); null until the user resizes. */
  width?: number | null;
  /** Min/max width for aria-valuemin/aria-valuemax (horizontal handles). */
  minWidth?: number;
  maxWidth?: number;
  /** Keyboard resize: adjust the relevant dimension by delta px (clamped to
   *  min/max). Direction matches the edge — see keyboard handler below. */
  onResizeBy?: (delta: number) => void;
  /** Reset to the CSS default (double-click). */
  onReset?: () => void;
}

/**
 * Visual + a11y wrapper for a resize drag handle, vertical (top/bottom edges,
 * resizes height, paired with `useResizableHeight`) or horizontal (left/right
 * edges, resizes width, paired with `useResizableWidth`). Styling lives under
 * `.resize-handle` in styles/highlight.css so every handle looks identical.
 *
 * Beyond pointer drag, the handle is keyboard-operable (role="separator"):
 *  - vertical: ArrowUp/ArrowDown nudge height by 10px (up grows a top handle,
 *    down grows a bottom handle)
 *  - horizontal: ArrowLeft/ArrowRight nudge width by 10px (left grows a left
 *    handle, right grows a right handle)
 * Double-click resets to the CSS default.
 */
export function ResizeHandle({
  edge,
  onMouseDown,
  class: className,
  label = 'Drag to resize',
  height,
  minHeight = 0,
  maxHeight,
  width,
  minWidth = 0,
  maxWidth,
  onResizeBy,
  onReset,
}: ResizeHandleProps) {
  const isVertical = edge === 'top' || edge === 'bottom';

  const handleKeyDown = (e: KeyboardEvent) => {
    if (!onResizeBy) return;
    if (isVertical) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        // Up grows a top handle (pull its edge up) and shrinks a bottom handle.
        onResizeBy(edge === 'top' ? 10 : -10);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        onResizeBy(edge === 'top' ? -10 : 10);
      }
    } else {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        // Left grows a left handle (pull its edge left) and shrinks a right handle.
        onResizeBy(edge === 'left' ? 10 : -10);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        onResizeBy(edge === 'left' ? -10 : 10);
      }
    }
  };

  return (
    <div
      class={cx('resize-handle', `resize-handle-${edge}`, className)}
      role="separator"
      aria-orientation={isVertical ? 'horizontal' : 'vertical'}
      aria-label={label}
      title={label}
      tabIndex={0}
      aria-valuemin={isVertical ? minHeight : minWidth}
      aria-valuemax={isVertical ? maxHeight : maxWidth}
      aria-valuenow={(isVertical ? height : width) ?? undefined}
      onMouseDown={onMouseDown}
      onKeyDown={handleKeyDown}
      onDblClick={onReset}
    />
  );
}
