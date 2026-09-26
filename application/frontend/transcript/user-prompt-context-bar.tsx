/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { Virtualizer } from '@tanstack/virtual-core';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

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
  hidden = false,
  onLocate,
}: UserPromptContextBarProps) {
  const contentOriginPx = useTranscriptContentOrigin(scrollRef);

  // TanStack's virtualizer only notifies on virtual-range changes, so a same
  // -range scroll never re-renders this component from the parent. The bar
  // therefore owns its reactivity: each render selects from the element's
  // actual scroll position, and the passive listener below re-runs selection
  // on every scroll event, triggering a component update only when the
  // governing prompt's identity changes. The element keeps the listener
  // stable across streaming rebuilds via the ref indirection.
  const [, setPromptRevision] = useState(0);
  const [isCompact, setIsCompact] = useState(false);
  const selectedMessageIdRef = useRef<string | null>(null);
  const scrollSelectRef = useRef<(() => void) | null>(null);
  const contextRowRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLButtonElement | null>(null);
  scrollSelectRef.current = () => {
    const element = scrollRef.current;
    if (!element) return;
    const next = selectPromptFromElementMetrics({
      entries,
      getRowEnd: (rowIndex) => virtualizer.measurementsCache[rowIndex]?.end ?? null,
      metrics: readPromptMetrics(element),
      fallbackScrollOffset: null,
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

  const getRowEnd = useCallback(
    (rowIndex: number) => virtualizer.measurementsCache[rowIndex]?.end ?? null,
    [virtualizer],
  );

  // Render-time selection prefers the element's live metrics; the virtualizer
  // offset covers the unmeasurable window before the scroll element exists.
  const selected = selectPromptFromElementMetrics({
    entries,
    getRowEnd,
    metrics: readPromptMetrics(scrollRef.current),
    fallbackScrollOffset: virtualizer.scrollOffset ?? null,
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

  // Keep the original row treatment, but reclaim vertical space when its
  // complete contents use less than half the available width. scrollWidth
  // measures the prompt before ellipsis, so long prompts never compact merely
  // because their button is capped by max-width.
  useLayoutEffect(() => {
    const row = contextRowRef.current;
    const preview = previewRef.current;
    if (!row || !preview || selectedDetails === null) {
      setIsCompact(false);
      return;
    }

    const measure = () => {
      const metadata = row.querySelector<HTMLElement>('.transcript-prompt-context-meta');
      const parsedGap = Number.parseFloat(window.getComputedStyle(row).columnGap);
      const occupiedWidth = preview.scrollWidth
        + (metadata?.scrollWidth ?? 0)
        + (metadata && Number.isFinite(parsedGap) ? parsedGap : 0);
      const next = row.clientWidth > 0 && occupiedWidth <= row.clientWidth * 0.5;
      setIsCompact((previous) => previous === next ? previous : next);
    };

    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(row);
    observer?.observe(preview);
    return () => observer?.disconnect();
  }, [selected?.messageId, selected?.isAutoResume, selected?.isQueued, selectedDetails?.plainText]);

  // Data and measurement updates can change the render-time selection without
  // a scroll event. Keep the listener's comparison baseline aligned with what
  // is actually rendered so the next same-range scroll cannot be ignored.
  selectedMessageIdRef.current = selected?.messageId ?? null;

  const locateDescriptionId = useId();
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

  const hasMetadata = selectedDetails.imageCount > 0 || selected.isQueued || selected.isAutoResume;

  return (
    <section
      class={`transcript-prompt-context${isCompact ? ' is-compact' : ''}${hidden ? ' is-hidden' : ''}`}
      role="region"
      aria-label="User prompt context"
      aria-hidden={hidden ? 'true' : undefined}
    >
      <span id={locateDescriptionId} class="transcript-prompt-context-action-description">
        Locate this user prompt in the transcript
      </span>
      <div class="transcript-prompt-context-row" ref={contextRowRef}>
        {hasMetadata && (
          <div class="transcript-prompt-context-meta" aria-label="Prompt metadata">
            {selectedDetails.imageCount > 0 && (
              <span title={`${selectedDetails.imageCount} image attachment${selectedDetails.imageCount === 1 ? '' : 's'}`}>
                {imageLabel(selectedDetails.imageCount)}
              </span>
            )}
            {selected.isQueued && <span>Queued</span>}
            {selected.isAutoResume && <span>Auto-resume</span>}
          </div>
        )}
        <button
          type="button"
          class="transcript-prompt-context-preview"
          ref={previewRef}
          aria-describedby={locateDescriptionId}
          title="Locate user prompt in transcript"
          onClick={locate}
        >
          {selectedDetails.plainText}
        </button>
      </div>
    </section>
  );
}