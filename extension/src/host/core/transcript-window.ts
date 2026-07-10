import type {
  ChatMessage,
  TranscriptPageDirection,
  TranscriptWindow,
} from '../../shared/protocol';
import { EMPTY_TRANSCRIPT_WINDOW } from '../../shared/protocol';
import { TRANSCRIPT_WINDOW_BUDGETS } from '../../shared/transcript-window';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function buildFullTranscriptWindow(transcript: ChatMessage[]): TranscriptWindow {
  const totalCount = transcript.length;
  return {
    totalCount,
    loadedStart: 0,
    loadedEnd: totalCount,
    hasOlder: false,
    hasNewer: false,
    isPartial: false,
    hasUserMessages: transcript.some((message) => message.role === 'user'),
  };
}

export function normalizeTranscriptWindow(
  transcript: ChatMessage[],
  window: TranscriptWindow | undefined,
): TranscriptWindow {
  if (!window) {
    return buildFullTranscriptWindow(transcript);
  }

  const totalCount = Math.max(window.totalCount, transcript.length);
  const loadedStart = clamp(window.loadedStart, 0, totalCount);
  const loadedEnd = clamp(window.loadedEnd, loadedStart, totalCount);

  return {
    totalCount,
    loadedStart,
    loadedEnd,
    hasOlder: window.hasOlder || loadedStart > 0,
    hasNewer: window.hasNewer || loadedEnd < totalCount,
    isPartial: window.isPartial || loadedStart > 0 || loadedEnd < totalCount,
    hasUserMessages: window.hasUserMessages,
  };
}

export function withIncrementedWindowCounts(window: TranscriptWindow | undefined): TranscriptWindow {
  if (!window) {
    return {
      ...EMPTY_TRANSCRIPT_WINDOW,
      totalCount: 1,
      loadedEnd: 1,
      hasUserMessages: false,
    };
  }

  const totalCount = window.totalCount + 1;
  const loadedEnd = Math.min(totalCount, window.loadedEnd + 1);
  const hasOlder = window.hasOlder || window.loadedStart > 0;
  const hasNewer = window.hasNewer || loadedEnd < totalCount;

  return {
    ...window,
    totalCount,
    loadedEnd,
    hasOlder,
    hasNewer,
    isPartial: hasOlder || hasNewer,
  };
}

export function withDecrementedWindowCounts(window: TranscriptWindow | undefined): TranscriptWindow | undefined {
  if (!window) {
    return undefined;
  }

  const totalCount = Math.max(0, window.totalCount - 1);
  const loadedEnd = Math.max(window.loadedStart, Math.min(window.loadedEnd - 1, totalCount));
  const hasOlder = window.hasOlder || window.loadedStart > 0;
  const hasNewer = window.hasNewer || loadedEnd < totalCount;

  return {
    ...window,
    totalCount,
    loadedEnd,
    hasOlder,
    hasNewer,
    isPartial: hasOlder || hasNewer,
  };
}

export function cullTranscriptWindowAroundActiveTurn(options: {
  transcript: ChatMessage[];
  transcriptWindow: TranscriptWindow;
  activeTurnMessageId?: string;
  maxLoadedCount?: number;
}): { transcript: ChatMessage[]; transcriptWindow: TranscriptWindow } {
  const maxLoadedCount = options.maxLoadedCount ?? TRANSCRIPT_WINDOW_BUDGETS.maxLoadedCount;
  const transcript = options.transcript;
  const transcriptWindow = options.transcriptWindow;

  if (transcript.length <= maxLoadedCount) {
    return { transcript, transcriptWindow };
  }

  const activeIndex = options.activeTurnMessageId
    ? transcript.findIndex((message) => message.id === options.activeTurnMessageId)
    : -1;

  const keepEnd = transcript.length;
  let keepStart = Math.max(0, keepEnd - maxLoadedCount);

  if (activeIndex >= 0 && activeIndex < keepStart) {
    keepStart = activeIndex;
  }

  const boundedStart = Math.max(0, Math.min(keepStart, keepEnd - maxLoadedCount));
  const nextTranscript = transcript.slice(boundedStart, keepEnd);
  const droppedCount = boundedStart;
  const nextLoadedStart = transcriptWindow.loadedStart + droppedCount;
  const nextLoadedEnd = nextLoadedStart + nextTranscript.length;

  return {
    transcript: nextTranscript,
    transcriptWindow: {
      ...transcriptWindow,
      loadedStart: nextLoadedStart,
      loadedEnd: nextLoadedEnd,
      hasOlder: true,
      hasNewer: nextLoadedEnd < transcriptWindow.totalCount,
      isPartial: true,
    },
  };
}

export function buildTranscriptPageRequest(window: TranscriptWindow, direction: TranscriptPageDirection): {
  direction: TranscriptPageDirection;
  loadedStart: number;
  loadedEnd: number;
} {
  return {
    direction,
    loadedStart: window.loadedStart,
    loadedEnd: window.loadedEnd,
  };
}
