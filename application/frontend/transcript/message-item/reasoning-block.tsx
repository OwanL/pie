/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

import { renderMarkdown, reasoningPreview } from '../markdown';
import { Collapsible } from '../../lib/components/collapsible';
import { ResizeHandle } from '../../lib/components/resize-handle';
import { useResizableHeight } from '../../lib/components/use-resizable-height';
import { useCollapsibleOpen } from '../use-collapsible-open';
import { toMouseEvent } from '../../lib/components/preact-events';
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
/** Approximate prose rows, including wrapping and paragraph spacing. */
const INLINE_REASONING_ROWS = 8;

/** The commit leaf must describe the text actually visible under its policy. */
export function reasoningCommitEvidence(text: string, open: boolean): {
  text: string;
  policy: 'displayed' | 'collapsed';
} {
  return open
    ? { text, policy: 'displayed' }
    : { text: reasoningPreview(text), policy: 'collapsed' };
}

export function ReasoningBlock({ text, detailRef, autoExpand, collapsibleKey, onContextMenu, streaming = false }: ReasoningBlockProps) {
  const [disclosureOpen, setOpen] = useCollapsibleOpen(collapsibleKey, autoExpand);
  // Once a part grows past the threshold, keep its disclosure stable while it
  // streams or the sidebar resizes. Lazy refs already represent large bodies:
  // never fetch them merely to decide whether their compact summary fits.
  const [hasOverflow, setHasOverflow] = useState(false);
  const collapsible = Boolean(detailRef) || hasOverflow;
  const open = !collapsible || disclosureOpen;
  const lazyDetail = useLazyDetail(detailRef, collapsible && disclosureOpen);
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

  // Measure the rendered prose, not source newlines or a character budget.
  // Layout effects catch throttled streaming parses before paint; observation
  // also catches wrapping changes when the sidebar/font size changes.
  const measureInline = () => {
    const body = scrollRef.current;
    if (collapsible || !body || hasSelectionOverlapping(body)) return;
    const lineHeight = Number.parseFloat(window.getComputedStyle(body).lineHeight);
    if (lineHeight > 0 && body.scrollHeight >= lineHeight * INLINE_REASONING_ROWS - 1) {
      setHasOverflow(true);
    }
  };
  useLayoutEffect(measureInline);
  useEffect(() => {
    if (collapsible || !scrollRef.current) return;
    const observer = new ResizeObserver(measureInline);
    observer.observe(scrollRef.current);
    // A selection can delay the automatic collapse until the reader releases it.
    document.addEventListener('selectionchange', measureInline);
    return () => {
      observer.disconnect();
      document.removeEventListener('selectionchange', measureInline);
    };
  }, [collapsible]);
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

  if (!collapsible) {
    return (
      <div
        class="reasoning-block reasoning-inline"
        data-streaming={streaming ? 'true' : undefined}
        data-provisional={streaming ? 'true' : undefined}
        onContextMenu={(e) => { e.preventDefault(); onContextMenu(toMouseEvent(e), displayText); }}
      >
        <div
          ref={scrollRef}
          class="message-body reasoning-scroll"
          dangerouslySetInnerHTML={{ __html: renderedHtml }}
          aria-live="polite"
        />
      </div>
    );
  }

  return (
    <Collapsible
      open={open}
      onToggle={setOpen}
      ariaLabel="Toggle reasoning details"
      class="reasoning-block"
      dataAttrs={streaming ? { 'data-streaming': 'true', 'data-provisional': 'true' } : undefined}
      headerClass="px-2 py-1"
      bodyClass="px-2 pb-2 leading-relaxed"
      onContextMenu={(e) => onContextMenu(e, displayText)}
      header={
        <>
          <svg class="reasoning-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M9 18h6M10 21h4M8.5 15.5a6 6 0 1 1 7 0C14.5 16.2 14 17 14 18h-4c0-1-.5-1.8-1.5-2.5Z" />
          </svg>
          <span class="reasoning-preview">{detailRef?.summary ?? reasoningPreview(displayText)}</span>
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
