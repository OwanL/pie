/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useRef, useState } from 'preact/hooks';

import { renderMarkdown, reasoningSummary } from '../markdown';
import { Collapsible } from '../../lib/components/collapsible';
import { ResizeHandle } from '../../lib/components/resize-handle';
import { useResizableHeight } from '../../lib/components/use-resizable-height';
import { useCollapsibleOpen } from '../use-collapsible-open';
import { countTextLines } from '../tool-call-analysis';
import { useCommittedReasoningLeaf } from '../commit-registry';
import { useLazyDetail } from '../lazy-detail-store';
import { hasSelectionOverlapping } from '../selection-overlap';
import type { LazyDetailRef } from '../../../lib/protocol/index.js';

interface ReasoningBlockProps {
  text: string;
  detailRef?: LazyDetailRef;
  autoExpand: boolean;
  collapsibleKey: string;
  /** Context-menu request. The block supplies its CURRENT display text —
   *  the lazily-loaded detail when one has been fetched, otherwise the
   *  summary/complete `text` — so the menu's copy actions always target what
   *  the block actually shows, not the compacted summary. */
  onContextMenu: (e: MouseEvent, displayText: string) => void;
  /** True while the owning assistant message is still streaming AND this is the
   *  actively-growing part. Drives the expanded streaming cursor. */
  streaming?: boolean;
}

/** Reasoning streams token-by-token; re-parsing the full markdown on every
 *  token is wasteful (marked + DOMPurify over a growing string) and flickers.
 *  Re-parse at most this often (ms) while text keeps changing. Mirrors the
 *  throttle constant in buffered-text-part.tsx. */
const REASONING_PARSE_THROTTLE_MS = 100;
/** Trailing parse delay (ms) after the last text change so the final text is
 *  always rendered, even without an explicit streaming-end signal. */
const REASONING_PARSE_TRAILING_MS = 120;
/** Poll until a selection overlapping the reasoning body clears. */
const SELECTION_DEFER_POLL_MS = 200;

/** The commit leaf must describe the text actually visible under its policy. */
export function reasoningCommitEvidence(text: string, open: boolean): {
  text: string;
  policy: 'displayed' | 'collapsed';
} {
  return open
    ? { text, policy: 'displayed' }
    : { text: reasoningSummary(text), policy: 'collapsed' };
}

export function ReasoningBlock({ text, detailRef, autoExpand, collapsibleKey, onContextMenu, streaming = false }: ReasoningBlockProps) {
  const [open, setOpen] = useCollapsibleOpen(collapsibleKey, autoExpand);
  const lazyDetail = useLazyDetail(detailRef, open);
  const displayText = lazyDetail.state.status === 'loaded' && typeof lazyDetail.state.value === 'string'
    ? lazyDetail.state.value
    : text;
  const { scrollRef, height, startResize, minHeight, maxHeight, canResize, resizeBy, reset } = useResizableHeight<HTMLDivElement>();

  // Fence queued parses synchronously when text, disclosure, or streaming
  // state changes so an older callback cannot replace the newest render.
  const renderGenerationRef = useRef({ displayText, open, streaming, generation: 0 });
  if (
    renderGenerationRef.current.displayText !== displayText
    || renderGenerationRef.current.open !== open
    || renderGenerationRef.current.streaming !== streaming
  ) {
    renderGenerationRef.current = {
      displayText,
      open,
      streaming,
      generation: renderGenerationRef.current.generation + 1,
    };
  }
  const renderGeneration = renderGenerationRef.current.generation;

  // Throttled markdown re-parse: leading parse at most once per
  // REASONING_PARSE_THROTTLE_MS while text keeps changing, plus a trailing
  // parse REASONING_PARSE_TRAILING_MS after the last change so the final text
  // is always rendered. When closed, render '' (no parse). This mirrors the
  // BufferedTextPart throttle but reasoning reveals the full text immediately
  // (no progressive reveal), so only the parse is throttled.
  const [rendered, setRendered] = useState(() => ({
    html: open ? renderMarkdown(displayText, true, false) : '',
    text: displayText,
    cursor: open && streaming,
  }));
  const lastParseAtRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const deferTimerRef = useRef<number | null>(null);
  const pendingRenderRef = useRef<{ html: string; text: string; cursor: boolean } | null>(null);
  // Latest text read by the scheduled parse so it always reflects the most
  // recent token, not the token that scheduled it.
  const textRef = useRef(displayText);
  textRef.current = displayText;

  function scheduleDeferredApply() {
    deferTimerRef.current = window.setTimeout(() => {
      deferTimerRef.current = null;
      if (pendingRenderRef.current === null) return;
      if (!hasSelectionOverlapping(scrollRef.current)) {
        setRendered(pendingRenderRef.current);
        pendingRenderRef.current = null;
        return;
      }
      scheduleDeferredApply();
    }, SELECTION_DEFER_POLL_MS);
  }

  function applyRendered(next: { html: string; text: string; cursor: boolean }) {
    pendingRenderRef.current = next;
    if (deferTimerRef.current !== null) return;
    if (!hasSelectionOverlapping(scrollRef.current)) {
      setRendered(next);
      pendingRenderRef.current = null;
      return;
    }
    scheduleDeferredApply();
  }

  useEffect(() => {
    if (!open) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      applyRendered({ html: '', text: textRef.current, cursor: false });
      return;
    }

    // Leading parse: at most once per throttle window.
    const now = Date.now();
    if (now - lastParseAtRef.current >= REASONING_PARSE_THROTTLE_MS) {
      lastParseAtRef.current = now;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      applyRendered({
        html: renderMarkdown(textRef.current, true, false),
        text: textRef.current,
        cursor: streaming,
      });
      return;
    }

    // Trailing parse: (re)schedule so it fires REASONING_PARSE_TRAILING_MS
    // after the last text change, guaranteeing the final text renders even
    // without a streaming-end signal.
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    const generation = renderGeneration;
    const timerId = window.setTimeout(() => {
      if (timerRef.current === timerId) {
        timerRef.current = null;
      }
      if (renderGenerationRef.current.generation !== generation || !renderGenerationRef.current.open) return;
      lastParseAtRef.current = Date.now();
      applyRendered({
        html: renderMarkdown(textRef.current, true, false),
        text: textRef.current,
        cursor: renderGenerationRef.current.streaming,
      });
    }, REASONING_PARSE_TRAILING_MS);
    timerRef.current = timerId;
  }, [displayText, open, streaming, renderGeneration]);

  // Clear pending markdown and selection-deferred updates on unmount.
  useEffect(() => () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (deferTimerRef.current !== null) {
      clearTimeout(deferTimerRef.current);
      deferTimerRef.current = null;
    }
    pendingRenderRef.current = null;
  }, []);

  // Collapsed size hint mirrors tool calls (`~543 lines`): a quick magnitude
  // signal before expanding. Only for multi-line reasoning — a single line is
  // trivially small and a hint would just be noise.
  const lineCount = detailRef?.lineCount ?? countTextLines(displayText);
  const showLineHint = !open && lineCount > 1;
  // Streaming cursor (polish): a blinking block at the end of the rendered
  // markdown while the assistant is still emitting reasoning tokens. Appended
  // after sanitization so the trusted span survives DOMPurify.
  const renderedHtml = rendered.cursor
    ? `${rendered.html}<span class="reasoning-stream-cursor" aria-hidden="true"></span>`
    : rendered.html;
  const keyMatch = /^reasoning:(.*):(\d+)$/.exec(collapsibleKey);
  const messageId = keyMatch?.[1] ?? collapsibleKey;
  const partIndex = Number(keyMatch?.[2] ?? 0);
  const commitEvidence = reasoningCommitEvidence(detailRef ? text : (open ? rendered.text : text), open);
  useCommittedReasoningLeaf(messageId, partIndex, commitEvidence.text, commitEvidence.policy);

  return (
    <Collapsible
      open={open}
      onToggle={setOpen}
      ariaLabel="Toggle reasoning details"
      class="reasoning-block"
      dataAttrs={streaming ? { 'data-streaming': 'true', 'data-provisional': 'true' } : undefined}
      headerClass="px-2 py-1"
      bodyClass="px-2 pb-2 leading-relaxed text-foreground"
      onContextMenu={(e) => onContextMenu(e, displayText)}
      header={
        <>
          <span class="transcript-header-label">Reasoning</span>
          {!open ? (
            <span class="transcript-header-summary min-w-0 flex-1 truncate">{detailRef?.summary ?? reasoningSummary(displayText)}</span>
          ) : null}
          {showLineHint && (
            <span
              class="ml-auto flex-none whitespace-nowrap font-mono text-[10px] text-muted/50"
              title={`${lineCount} lines`}
            >{lineCount} lines</span>
          )}
        </>
      }
    >
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
        {detailRef && lazyDetail.state.status !== 'loaded' ? (
          <div ref={scrollRef} class="message-body reasoning-scroll" role="status">
            {lazyDetail.state.status === 'loading' || lazyDetail.state.status === 'idle'
              ? 'Loading reasoning…'
              : (
                <div>
                  <div>{lazyDetail.state.message}</div>
                  <button type="button" class="mt-2 text-accent underline" onClick={lazyDetail.retry}>Retry</button>
                </div>
              )}
          </div>
        ) : (
          <div
            ref={scrollRef}
            class="message-body reasoning-scroll"
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
            aria-live="polite"
            style={height ? { height: `${height}px`, maxHeight: 'none' } : undefined}
          />
        )}
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
    </Collapsible>
  );
}
