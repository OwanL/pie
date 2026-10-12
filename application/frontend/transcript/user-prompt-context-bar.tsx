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

/** Navigation follows jump-controller row starts, not fully offscreen row ends.
 * Do not subtract content padding: jumps align measurement.start with scrollTop.
 */
function navigationIndex(
  entries: readonly UserPromptEntry[],
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>,
  scrollTop: number | null,
): number {
  if (entries.length === 0) return -1;
  if (scrollTop === null || !Number.isFinite(scrollTop)) return 0;
  let low = 0;
  let high = entries.length - 1;
  let selected = 0;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const start = virtualizer.measurementsCache[entries[middle]!.rowIndex]?.start;
    if (start === undefined || !Number.isFinite(start)) return selected;
    if (start <= scrollTop) {
      selected = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return selected;
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
  const navigationMessageIdRef = useRef<string | null>(null);
  const requestedMessageIdRef = useRef<string | null>(null);
  if (requestedMessageIdRef.current !== null && !entries.some((entry) => entry.messageId === requestedMessageIdRef.current)) {
    requestedMessageIdRef.current = null;
  }
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
    const nextNavigationId = requestedMessageIdRef.current
      ?? entries[navigationIndex(entries, virtualizer, element.scrollTop)]?.messageId ?? null;
    if (selectedMessageIdRef.current === nextId && navigationMessageIdRef.current === nextNavigationId) return;
    selectedMessageIdRef.current = nextId;
    navigationMessageIdRef.current = nextNavigationId;
    setPromptRevision((revision) => revision + 1);
  };

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onScroll = () => scrollSelectRef.current?.();
    // Capture manual intent before rail/scrollbar/latest handlers initiate a
    // programmatic jump. Scroll events alone must not discard clamped targets.
    const viewport = element.closest('.transcript-viewport') ?? element;
    const onManualNavigation = () => {
      requestedMessageIdRef.current = null;
      scrollSelectRef.current?.();
    };
    const onKeyDown = (event: Event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar'].includes(keyboardEvent.key)) {
        onManualNavigation();
        return;
      }
      if (keyboardEvent.key !== 'Enter' || !(event.target instanceof Element)) return;
      const activation = event.target.closest('button, [role="button"], a[href]');
      if (!activation || !viewport.contains(activation)) return;
      if (activation instanceof HTMLButtonElement && activation.disabled) return;
      onManualNavigation();
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    viewport.addEventListener('wheel', onManualNavigation, { passive: true, capture: true });
    viewport.addEventListener('touchstart', onManualNavigation, { passive: true, capture: true });
    viewport.addEventListener('pointerdown', onManualNavigation, true);
    viewport.addEventListener('keydown', onKeyDown, true);
    return () => {
      element.removeEventListener('scroll', onScroll);
      viewport.removeEventListener('wheel', onManualNavigation, true);
      viewport.removeEventListener('touchstart', onManualNavigation, true);
      viewport.removeEventListener('pointerdown', onManualNavigation, true);
      viewport.removeEventListener('keydown', onKeyDown, true);
    };
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

  const selectedIndex = requestedMessageIdRef.current === null
    ? navigationIndex(entries, virtualizer,
      readPromptMetrics(scrollRef.current)?.scrollTop ?? virtualizer.scrollOffset ?? null)
    : entries.findIndex((entry) => entry.messageId === requestedMessageIdRef.current);
  const navigate = (prompt: UserPromptEntry | undefined) => {
    if (hidden || !prompt) return;
    requestedMessageIdRef.current = prompt.messageId;
    setPromptRevision((revision) => revision + 1);
    onLocate(prompt.rowIndex);
  };
  const previousPrompt = entries[selectedIndex - 1];
  const nextPrompt = selectedIndex < 0 ? undefined : entries[selectedIndex + 1];

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
      const navigation = row.querySelector<HTMLElement>('.transcript-prompt-navigation');
      const occupiedWidth = preview.scrollWidth
        + (metadata?.scrollWidth ?? 0)
        + (navigation?.scrollWidth ?? 0)
        + ((metadata ? 1 : 0) + (navigation ? 1 : 0)) * (Number.isFinite(parsedGap) ? parsedGap : 0);
      const next = row.clientWidth > 0 && occupiedWidth <= row.clientWidth * 0.5;
      setIsCompact((previous) => previous === next ? previous : next);
    };

    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(row);
    observer?.observe(preview);
    const navigation = row.querySelector<HTMLElement>('.transcript-prompt-navigation');
    if (navigation) observer?.observe(navigation);
    return () => observer?.disconnect();
  }, [selected?.messageId, selected?.isAutoResume, selected?.isQueued, selectedDetails?.plainText, entries.length]);

  // Data and measurement updates can change the render-time selection without
  // a scroll event. Keep the listener's comparison baseline aligned with what
  // is actually rendered so the next same-range scroll cannot be ignored.
  selectedMessageIdRef.current = selected?.messageId ?? null;
  navigationMessageIdRef.current = entries[selectedIndex]?.messageId ?? null;

  const locateDescriptionId = useId();
  const locate = useCallback(() => {
    if (selected && !hidden) {
      requestedMessageIdRef.current = selected.messageId;
      setPromptRevision((revision) => revision + 1);
      onLocate(selected.rowIndex);
    }
  }, [onLocate, selected, hidden]);

  // Multiple loaded prompts retain navigation even when there is no offscreen
  // context. Never duplicate the visible prompt just to provide controls.
  if (selected === null && entries.length < 2) {
    return null;
  }

  const hasMetadata = selectedDetails !== null && selected !== null
    && (selectedDetails.imageCount > 0 || selected.isQueued || selected.isAutoResume);

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
        {hasMetadata && selectedDetails && selected && (
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
        {selectedDetails && <button
          type="button"
          class="transcript-prompt-context-preview"
          ref={previewRef}
          aria-describedby={locateDescriptionId}
          title="Locate user prompt in transcript"
          disabled={hidden}
          onClick={locate}
        >
          {selectedDetails.plainText}
        </button>}
        <div class="transcript-prompt-navigation">
          <button
            type="button"
            class="transcript-prompt-navigation-button"
            aria-label="Previous prompt"
            title="Previous prompt"
            disabled={hidden || !previousPrompt}
            onClick={() => navigate(previousPrompt)}
          >
            ‹
          </button>
          <span
            class="transcript-prompt-navigation-position"
            aria-label={`Prompt ${selectedIndex + 1} of ${entries.length}`}
          >
            {selectedIndex + 1} / {entries.length}
          </span>
          <button
            type="button"
            class="transcript-prompt-navigation-button"
            aria-label="Next prompt"
            title="Next prompt"
            disabled={hidden || !nextPrompt}
            onClick={() => navigate(nextPrompt)}
          >
            ›
          </button>
        </div>
      </div>
    </section>
  );
}