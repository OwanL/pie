import { useRef, useState } from 'preact/hooks';

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
  useRefreshFollowTarget,
  useSmoothAutoFollow,
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
  /**
   * The live transcript array (reference identity matters, not contents).
   * The host posts a fresh JSON-deserialized array on every streaming snapshot
   * (~150ms cadence), so its identity changes once per snapshot — making it a
   * timely, non-per-frame signal for {@link useRefreshFollowTarget} to re-read
   * the true bottom the moment content grows, instead of waiting up to a frame
   * for the virtualizer's deferred re-measurement (`totalSize`) to catch up.
   * During the auto-follow rAF loop's own programmatic scrolls the transcript
   * identity is stable, so this never adds a per-frame forced reflow.
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

interface UseTranscriptScrollResult {
  /** Live ref to the auto-follow state (true while pinned to the bottom).
   *  Read by scroll-anchoring to know when NOT to pin the top visible row. */
  autoFollowRef: { current: boolean };
  /** Reactive setter for auto-follow. Used by the user-message rail to
   *  disengage stick-to-bottom before jumping to a prompt so the smooth-follow
   *  rAF loop doesn't immediately re-pin to the bottom. */
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
  busy,
  onLoadOlder,
  onLoadNewer,
  onJumpToLatest,
  totalSize,
}: UseTranscriptScrollOptions): UseTranscriptScrollResult {
  const [isInitialPositioning, setIsInitialPositioning] = useState(true);
  // Live mirror of `isInitialPositioning` readable inside the useSmoothAutoFollow
  // rAF loop's tick (the positioning snap branch). `isInitialPositioning` (the
  // state) is now also a dep of that effect so the loop restarts when the
  // positioning window opens/closes; the ref still lets tick see the current
  // value synchronously, within the same frame, before the effect re-runs.
  const isInitialPositioningRef = useRef(true);
  const previousLoadedStartRef = useRef(transcriptWindow.loadedStart);
  const previousLoadedEndRef = useRef(transcriptWindow.loadedEnd);
  const pendingJumpToLatestSnapRef = useRef(false);

  // The true bottom (scrollHeight - clientHeight) the auto-follow rAF loop
  // eases toward. Refreshed by useRefreshFollowTarget on every content/viewport
  // height change (keyed on totalSize + a container ResizeObserver), so the
  // loop never reads scrollHeight/clientHeight itself — no per-frame forced
  // reflow, and no stale target drifting a quarter-second behind tool/reasoning/
  // preview growth.
  const cachedTargetRef = useRef(0);

  const { isAtBottom, setIsAtBottom, autoFollow, setAutoFollow, autoFollowRef, lastScrollTopRef, scrollToBottom } = useScrollState(scrollRef);
  const {
    isLoadingOlder,
    setIsLoadingOlder,
    isLoadingNewer,
    setIsLoadingNewer,
    loadingOlderRef,
    loadingNewerRef,
    pendingOlderAnchorRef,
    requestOlderPage,
    requestNewerPage,
  } = usePaginationState(scrollRef, onLoadOlder, onLoadNewer);

  const jumpToLatest = useJumpToLatest(
    scrollRef,
    setAutoFollow,
    transcriptWindow.hasNewer,
    onJumpToLatest,
    scrollToBottom,
    pendingJumpToLatestSnapRef,
  );

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
  );

  useScrollEventsEffect(
    scrollRef,
    autoFollowRef,
    lastScrollTopRef,
    setIsAtBottom,
    setAutoFollow,
    transcriptWindow.hasOlder,
    requestOlderPage,
    sessionKey,
  );

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
  );

  useRefreshFollowTarget(scrollRef, totalSize, transcript, sessionKey, cachedTargetRef);

  useSmoothAutoFollow(
    scrollRef,
    autoFollowRef,
    autoFollow,
    lastScrollTopRef,
    setIsAtBottom,
    transcriptWindow.hasNewer,
    isInitialPositioningRef,
    isInitialPositioning,
    busy,
    cachedTargetRef,
  );

  return {
    autoFollowRef,
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
