/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useLayoutEffect, useState } from 'preact/hooks';
import { cx } from '../../lib/components/cx';
import { ResizeHandle } from '../../lib/components/resize-handle';
import { useResizableHeight } from '../../lib/components/use-resizable-height';
import { useStickToBottom } from '../use-stick-to-bottom';
import { SegmentedText } from './segmented-text';

export function TerminalOutput({ text, running, identity }: { text: string; running: boolean; identity: string }) {
  const { scrollRef, height, startResize, minHeight, maxHeight, canResize, resizeBy, reset } = useResizableHeight<HTMLPreElement>();
  const { handleScroll } = useStickToBottom<HTMLPreElement>(scrollRef, [text]);

  const [overflows, setOverflows] = useState(false);
  // Conditional edge fades (Tabs-4 pattern, classes styled in tool-call.css):
  // while clipped columns sit towards an edge, fade it as a visible scroll
  // affordance; fades clear once that direction is scrolled to the end.
  const [fades, setFades] = useState({ left: false, right: false });
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      setOverflows(el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
      const nextLeft = el.scrollLeft > 1;
      const nextRight = el.scrollWidth - el.clientWidth - el.scrollLeft > 1;
      setFades((previous) => previous.left === nextLeft && previous.right === nextRight ? previous : { left: nextLeft, right: nextRight });
    };
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : undefined;
    observer?.observe(el);
    window.addEventListener('resize', measure);
    // Horizontal scroll position only changes which edge (if any) is clipped;
    // keep the fades faithful while the user scrolls.
    el.addEventListener('scroll', measure, { passive: true });
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); el.removeEventListener('scroll', measure); };
  }, [text, height, scrollRef]);

  return (
    <div class="resizable-scroll-area">
      {canResize && (
        <ResizeHandle
          edge="top"
          onMouseDown={startResize('top')}
          height={height}
          minHeight={minHeight}
          maxHeight={maxHeight}
          onResizeBy={resizeBy}
          onReset={reset}
        />
      )}
      <pre
        ref={scrollRef}
        tabIndex={overflows ? 0 : undefined}
        role={overflows ? 'region' : undefined}
        aria-label={overflows ? 'Terminal output' : undefined}
        class={cx('tool-call-terminal-pre', fades.left && 'fade-left', fades.right && 'fade-right')}
        onScroll={handleScroll}
        style={height ? { height: `${height}px`, maxHeight: 'none' } : undefined}
      >
        <SegmentedText
          text={text}
          identity={identity}
          renderSegment={(segmentText) => <code>{segmentText}</code>}
        />
        {running && <span class="tool-call-terminal-cursor" aria-hidden="true" />}
      </pre>
      {canResize && (
        <ResizeHandle
          edge="bottom"
          onMouseDown={startResize('bottom')}
          height={height}
          minHeight={minHeight}
          maxHeight={maxHeight}
          onResizeBy={resizeBy}
          onReset={reset}
        />
      )}
    </div>
  );
}
