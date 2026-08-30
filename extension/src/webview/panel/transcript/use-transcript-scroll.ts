import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

import type { ChatMessage, TranscriptWindow } from '../../../shared/protocol';
import { useJumpToLatest } from './use-transcript-scroll-jump';
import { usePaginationTrackingEffect } from './use-transcript-scroll-pagination';
import { useSessionResetEffect } from './use-transcript-scroll-reset';
import { useScrollEventsEffect } from './use-transcript-scroll-events';
import {
  usePaginationState,
  useScrollState,
} from './use-transcript-scroll-state';
import {
  useAutoFollow,
  useRefreshFollowTarget,
} from './use-transcript-smooth-follow';

interface UseTranscriptScrollOptions {
  /** Owned by the caller (`virtual-list`) so the virtualizer can be created from
   *  it before this hook runs — letting the hook receive `totalSize` as a
   *  reactive prop. Attached to the scroll container `<div ref={scrollRef}>`. */
  scrollRef: { current: HTMLDivElement | null };
  sessionKey: string | null;
  transcriptWindow: TranscriptWindow;
  transcriptLength: number;
  busy: boolean;
  onLoadOlder: () => void;
  onLoadNewer: () => void;
  onJumpToLatest: () => void;
  /** True while an inline editor owns a row-local draft. Paging responses may
   * be deferred by the host, so clear any webview-local loading latch. */
  pagingSuspended?: boolean;
  /**
   * The live transcript array (reference identity matters, not contents).
   * The host posts a fresh JSON-deserialized array on every streaming snapshot
   * (~150ms cadence), so its identity changes once per snapshot — making it a
   * timely, non-per-frame signal for {@link useRefreshFollowTarget} to re-read
   * the true bottom the moment content grows, instead of waiting up to a frame
   * for the virtualizer's deferred re-measurement (`totalSize`) to catch up.
   * During auto-follow's own `scrollTop` write the transcript identity is
   * stable, so this never adds repeated forced reflows.
   */
  transcript: readonly ChatMessage[];
  /**
   * The virtualizer's current total content height (`virtualizer.getTotalSize()`).
   * Every height-relevant change in the transcript — streaming markdown,
   * tool-body output, reasoning/preview expand-collapse, late image/table
   * loads, drag-resizes — flows through a row ResizeObserver → `measureElement`
   * → `totalSize`. The follow-target refresh effect keys on it to re-read the
   * true bottom exactly once per height change, replacing the previous
   * data-model content signature (which only saw streaming-message prose and
   * so drifted up to a 250ms fallback cadence for every other growth source —
   * the root cause of "scroll drifts from the bottom during regular agent
   * work": tool output, reasoning, and previews grew unseen between reads).
   */
  totalSize: number;
}

function useFollowOnPromptSendEffect(
  transcript: readonly ChatMessage[],
  sessionKey: string | null,
  jumpToLatest: () => void,
) {
  const observedTailIdRef = useRef<string | null | undefined>(undefined);
  const observedSessionRef = useRef(sessionKey);

  useLayoutEffect(() => {
    // Optimistic sends are always appended by useMergedTranscript, so the tail
    // is the exact O(1) signal. Avoid scanning up to 240 loaded messages in a
    // layout effect on every ~150 ms streaming snapshot.
    const tail = transcript[transcript.length - 1];
    const currentTailId = tail?.role === 'user'
      && tail.id.startsWith('local:')
      && !tail.id.startsWith('local:edit:')
      ? tail.id
      : null;

    if (observedTailIdRef.current === undefined || observedSessionRef.current !== sessionKey) {
      observedTailIdRef.current = currentTailId;
      observedSessionRef.current = sessionKey;
      return;
    }

    const hasNewSend = currentTailId !== null && currentTailId !== observedTailIdRef.current;
    observedTailIdRef.current = currentTailId;
    if (hasNewSend) jumpToLatest();
  }, [jumpToLatest, sessionKey, transcript]);
}

interface UseTranscriptScrollResult {
  /** Live ref to the auto-follow state (true while pinned to the bottom).
   *  Read by scroll-anchoring to know when NOT to pin the top visible row. */
  autoFollowRef: { current: boolean };
  /** True while a manual scrollbar/wheel/touch/keyboard interaction owns scroll. */
  manualScrollActiveRef: { current: boolean };
  /** Count of browser scroll events expected from app-owned scrollTop writes. */
  programmaticScrollTargetRef: { current: number | null };
  /** True while a bounded message-rail jump owns scrollTop. Manual input and
   * bottom navigation clear it synchronously. */
  navigationActiveRef: { current: boolean };
  /** Reactive setter for auto-follow. Used by the user-message rail to
   *  disengage stick-to-bottom before jumping to a prompt so exact follow does
   *  not immediately re-pin to the bottom. */
  setAutoFollow: (v: boolean) => void;
  isAtBottom: boolean;
  isInitialPositioning: boolean;
  isLoadingOlder: boolean;
  isLoadingNewer: boolean;
  requestOlderPage: () => void;
  requestNewerPage: () => void;
  jumpToLatest: () => void;
}

export function useTranscriptScroll({
  scrollRef,
  sessionKey,
  transcriptWindow,
  transcript,
  transcriptLength,
  onLoadOlder,
  onLoadNewer,
  onJumpToLatest,
  pagingSuspended = false,
  totalSize,
}: UseTranscriptScrollOptions): UseTranscriptScrollResult {
  const [isInitialPositioning, setIsInitialPositioning] = useState(true);
  // Live mirror used by the bounded post-session-switch positioning loop.
  // Scroll events can synchronously cancel that loop when the user takes
  // control before the virtualizer finishes measuring.
  const isInitialPositioningRef = useRef(true);
  const previousLoadedStartRef = useRef(transcriptWindow.loadedStart);
  const previousLoadedEndRef = useRef(transcriptWindow.loadedEnd);
  const pendingJumpToLatestSnapRef = useRef(false);
  const navigationActiveRef = useRef(false);
  // App-owned scrollTop writes tag the browser scroll event they produce so
  // the pointerless native-thumb fallback does not misclassify them as manual.
  const programmaticScrollTargetRef = useRef<number | null>(null);

  // The true bottom (scrollHeight - clientHeight) used by exact auto-follow.
  // Refreshed on every content/viewport height change (keyed on totalSize + a
  // container ResizeObserver), then applied in the same layout commit.
  const cachedTargetRef = useRef(0);

  const {
    isAtBottom,
    setIsAtBottom,
    autoFollow,
    setAutoFollow,
    autoFollowRef,
    lastScrollTopRef,
    manualScrollActive,
    manualScrollActiveRef,
    setManualScrollActive,
    scrollToBottom,
  } = useScrollState(scrollRef, programmaticScrollTargetRef);
  const {
    isLoadingOlder,
    setIsLoadingOlder,
    isLoadingNewer,
    setIsLoadingNewer,
    loadingOlderRef,
    loadingNewerRef,
    pendingOlderAnchorRef,
    requestOlderPage: requestOlderPageRaw,
    requestNewerPage: requestNewerPageRaw,
  } = usePaginationState(scrollRef, onLoadOlder, onLoadNewer);

  const requestOlderPage = useCallback(() => {
    if (!pagingSuspended) requestOlderPageRaw();
  }, [pagingSuspended, requestOlderPageRaw]);
  const requestNewerPage = useCallback(() => {
    if (!pagingSuspended) requestNewerPageRaw();
  }, [pagingSuspended, requestNewerPageRaw]);

  useEffect(() => {
    if (!pagingSuspended) return;
    loadingOlderRef.current = false;
    loadingNewerRef.current = false;
    pendingOlderAnchorRef.current = null;
    pendingJumpToLatestSnapRef.current = false;
    setIsLoadingOlder(false);
    setIsLoadingNewer(false);
  }, [
    loadingNewerRef,
    loadingOlderRef,
    pagingSuspended,
    pendingJumpToLatestSnapRef,
    pendingOlderAnchorRef,
    setIsLoadingNewer,
    setIsLoadingOlder,
  ]);

  const jumpToLatestRaw = useJumpToLatest(
    scrollRef,
    autoFollowRef,
    setAutoFollow,
    transcriptWindow.hasNewer,
    onJumpToLatest,
    scrollToBottom,
    pendingJumpToLatestSnapRef,
  );
  const jumpToLatest = useCallback(() => {
    navigationActiveRef.current = false;
    if (!pagingSuspended) jumpToLatestRaw();
  }, [jumpToLatestRaw, navigationActiveRef, pagingSuspended]);

  useSessionResetEffect(
    sessionKey,
    scrollRef,
    scrollToBottom,
    setIsInitialPositioning,
    isInitialPositioningRef,
    setIsLoadingOlder,
    setIsLoadingNewer,
    transcriptWindow.loadedStart,
    transcriptWindow.loadedEnd,
    autoFollowRef,
    setAutoFollow,
    lastScrollTopRef,
    pendingJumpToLatestSnapRef,
    pendingOlderAnchorRef,
    loadingOlderRef,
    loadingNewerRef,
    previousLoadedStartRef,
    previousLoadedEndRef,
    navigationActiveRef,
  );

  useScrollEventsEffect(
    scrollRef,
    autoFollowRef,
    lastScrollTopRef,
    manualScrollActiveRef,
    setManualScrollActive,
    programmaticScrollTargetRef,
    setIsAtBottom,
    setAutoFollow,
    transcriptWindow.hasOlder,
    requestOlderPage,
    sessionKey,
    navigationActiveRef,
  );

  useFollowOnPromptSendEffect(transcript, sessionKey, jumpToLatest);

  usePaginationTrackingEffect(
    scrollRef,
    scrollToBottom,
    transcriptLength,
    transcriptWindow.loadedStart,
    transcriptWindow.loadedEnd,
    transcriptWindow.hasNewer,
    transcriptWindow.hasOlder,
    loadingOlderRef,
    loadingNewerRef,
    pendingOlderAnchorRef,
    setIsLoadingOlder,
    setIsLoadingNewer,
    previousLoadedStartRef,
    previousLoadedEndRef,
    pendingJumpToLatestSnapRef,
    setAutoFollow,
    manualScrollActive,
    programmaticScrollTargetRef,
  );

  const followTargetRevision = useRefreshFollowTarget(
    scrollRef,
    totalSize,
    transcript,
    sessionKey,
    cachedTargetRef,
    setIsAtBottom,
  );

  useAutoFollow(
    scrollRef,
    autoFollowRef,
    autoFollow,
    lastScrollTopRef,
    setIsAtBottom,
    transcriptWindow.hasNewer,
    cachedTargetRef,
    followTargetRevision,
    totalSize,
    transcript,
    sessionKey,
    programmaticScrollTargetRef,
    navigationActiveRef,
  );

  return {
    autoFollowRef,
    manualScrollActiveRef,
    programmaticScrollTargetRef,
    navigationActiveRef,
    setAutoFollow,
    isAtBottom,
    isInitialPositioning,
    isLoadingOlder,
    isLoadingNewer,
    requestOlderPage,
    requestNewerPage,
    jumpToLatest,
  };
}
