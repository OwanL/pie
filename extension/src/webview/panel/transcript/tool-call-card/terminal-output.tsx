/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { ResizeHandle } from '../../components/resize-handle';
import { useResizableHeight } from '../../components/use-resizable-height';
import { useStickToBottom } from '../use-stick-to-bottom';
import { SegmentedText } from './segmented-text';

export function TerminalOutput({ text, running, identity }: { text: string; running: boolean; identity: string }) {
  const { scrollRef, height, startResize, minHeight, maxHeight, canResize, resizeBy, reset } = useResizableHeight<HTMLPreElement>();
  const { handleScroll } = useStickToBottom<HTMLPreElement>(scrollRef, [text]);

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
        class="tool-call-terminal-pre"
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
