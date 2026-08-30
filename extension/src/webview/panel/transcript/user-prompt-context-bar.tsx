/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { Virtualizer } from '@tanstack/virtual-core';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

import {
  readPromptMetrics,
  selectPromptFromElementMetrics,
  type UserPromptEntry,
  userPromptDetails,
} from './user-prompt-context';

interface UserPromptContextBarProps {
  entries: readonly UserPromptEntry[];
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>;
  scrollRef: { current: HTMLDivElement | null };
  isAtBottom: boolean;
  hidden?: boolean;
  onLocate: (rowIndex: number) => void;
}

function useTranscriptContentOrigin(scrollRef: { current: HTMLDivElement | null }): number {
  const [contentOriginPx, setContentOriginPx] = useState(0);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const readOrigin = () => {
      const next = Number.parseFloat(window.getComputedStyle(element).paddingTop);
      if (Number.isFinite(next)) {
        setContentOriginPx((previous) => previous === next ? previous : next);
      }
    };
    readOrigin();

    // The top padding is responsive, so refresh the one scalar correction when
    // the viewport changes size. This reads style, not transcript DOM rows.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(readOrigin);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [scrollRef]);

  return contentOriginPx;
}

function imageLabel(count: number): string {
  return `${count} image${count === 1 ? '' : 's'}`;
}

/** A non-scrolling context bar for the user prompt owning the viewport. */
export function UserPromptContextBar({
  entries,
  virtualizer,
  scrollRef,
  isAtBottom,
  hidden = false,
  onLocate,
}: UserPromptContextBarProps) {
  const contentOriginPx = useTranscriptContentOrigin(scrollRef);
  const [expandedMessageId, setExpandedMessageId] = useState<string | null>(null);

  // TanStack's virtualizer only notifies on virtual-range changes, so a same
  // -range scroll never re-renders this component from the parent. The bar
  // therefore owns its reactivity: each render selects from the element's
  // actual scroll position, and the passive listener below re-runs selection
  // on every scroll event, triggering a component update only when the
  // governing prompt's identity changes. The element keeps the listener
  // stable across streaming rebuilds via the ref indirection.
  const [, setPromptRevision] = useState(0);
  const selectedMessageIdRef = useRef<string | null>(null);
  const scrollSelectRef = useRef<(() => void) | null>(null);
  scrollSelectRef.current = () => {
    const element = scrollRef.current;
    if (!element) return;
    const next = selectPromptFromElementMetrics({
      entries,
      getRowStart: (rowIndex) => virtualizer.measurementsCache[rowIndex]?.start ?? null,
      metrics: readPromptMetrics(element),
      fallbackScrollOffset: null,
      fallbackIsAtBottom: false,
      contentOriginPx,
    });
    const nextId = next?.messageId ?? null;
    if (selectedMessageIdRef.current === nextId) return;
    selectedMessageIdRef.current = nextId;
    setPromptRevision((revision) => revision + 1);
  };

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onScroll = () => scrollSelectRef.current?.();
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, [scrollRef]);

  const getRowStart = useCallback(
    (rowIndex: number) => virtualizer.measurementsCache[rowIndex]?.start ?? null,
    [virtualizer],
  );

  // Render-time selection prefers the element's live metrics; the virtualizer
  // offset plus the parent's isAtBottom only covers the unmeasurable window
  // (first render before the scroll element exists).
  const selected = selectPromptFromElementMetrics({
    entries,
    getRowStart,
    metrics: readPromptMetrics(scrollRef.current),
    fallbackScrollOffset: virtualizer.scrollOffset ?? null,
    fallbackIsAtBottom: isAtBottom,
    contentOriginPx,
  });

  // Normalized text and image count are derived for the selected prompt only.
  // A streaming snapshot re-creates message objects, so the memo keys on the
  // fields that determine those values rather than on message identity.
  const selectedMessage = selected?.message ?? null;
  const selectedDetails = useMemo(
    () => selectedMessage === null ? null : userPromptDetails(selectedMessage),
    [selectedMessage?.id, selectedMessage?.markdown, selectedMessage?.userParts],
  );

  const expanded = selected !== null && expandedMessageId === selected.messageId;

  const toggleExpanded = useCallback(() => {
    if (!selected) return;
    setExpandedMessageId((current) => current === selected.messageId ? null : selected.messageId);
  }, [selected]);
  const locate = useCallback(() => {
    if (selected) onLocate(selected.rowIndex);
  }, [onLocate, selected]);

  // No governing prompt: render no bar at all, so genuinely empty sessions or
  // a loaded window with no preceding prompt never reserve a blank bar. The
  // hidden passthrough still reserves space (visibility: hidden) during
  // initial positioning while a prompt is selected, keeping the virtualizer's
  // viewport height stable.
  if (selected === null || selectedDetails === null) {
    return null;
  }

  return (
    <section
      class={`transcript-prompt-context${hidden ? ' is-hidden' : ''}`}
      role="region"
      aria-label="User prompt context"
      aria-hidden={hidden ? 'true' : undefined}
    >
      <div class="transcript-prompt-context-heading">
        <span class="transcript-header-label">User prompt</span>
        <div class="transcript-prompt-context-meta" aria-label="Prompt metadata">
          {selectedDetails.imageCount > 0 && (
            <span title={`${selectedDetails.imageCount} image attachment${selectedDetails.imageCount === 1 ? '' : 's'}`}>
              {imageLabel(selectedDetails.imageCount)}
            </span>
          )}
          {selected.isQueued && <span>Queued</span>}
          {selected.isAutoResume && <span>Auto-resume</span>}
        </div>
      </div>
      <div class="transcript-prompt-context-row">
        <button
          type="button"
          class={`transcript-prompt-context-preview${expanded ? ' is-expanded' : ''}`}
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse user prompt' : 'Expand user prompt'}
          title={expanded ? 'Collapse user prompt' : 'Expand user prompt'}
          onClick={toggleExpanded}
        >
          {selectedDetails.plainText}
        </button>
        <button
          type="button"
          class="transcript-prompt-context-locate"
          aria-label="Locate user prompt in transcript"
          title="Locate user prompt in transcript"
          onClick={locate}
        >
          Locate
        </button>
      </div>
    </section>
  );
}