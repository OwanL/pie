import type {
  ChatMessage,
  TranscriptPageDirection,
  TranscriptWindow,
} from '../shared/protocol';
import { TRANSCRIPT_WINDOW_BUDGETS } from '../shared/transcript-window';
import { compactDurableMessageDetails } from '../shared/lazy-details';
import { mapTranscript, type SessionEntryLike } from './transcript';

export interface DisplayTranscriptCache {
  /** Full durable projection retained backend-side for detail retrieval. */
  transcript: ChatMessage[];
  /** Compact transport projection used by ordinary transcript windows. */
  transportTranscript?: ChatMessage[];
  hasUserMessages: boolean;
  branchEntryCount: number;
  branchLastEntryId?: string;
}

export interface TranscriptWindowSlice {
  transcript: ChatMessage[];
  transcriptWindow: TranscriptWindow;
}

interface TranscriptRange {
  start: number;
  end: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeRange(start: number, end: number, totalCount: number): TranscriptRange {
  const safeStart = clamp(start, 0, totalCount);
  const safeEnd = clamp(end, safeStart, totalCount);
  return {
    start: safeStart,
    end: safeEnd,
  };
}

function enforceMaxLoadedCount(
  range: TranscriptRange,
  totalCount: number,
  maxLoadedCount: number,
  direction: TranscriptPageDirection,
): TranscriptRange {
  if (range.end - range.start <= maxLoadedCount) {
    return range;
  }

  if (direction === 'older') {
    // Keep the newly requested older edge and drop from the newer side.
    return normalizeRange(range.start, range.start + maxLoadedCount, totalCount);
  }

  if (direction === 'newer') {
    // Keep the newly requested newer edge and drop from the older side.
    return normalizeRange(range.end - maxLoadedCount, range.end, totalCount);
  }

  return normalizeRange(range.end - maxLoadedCount, range.end, totalCount);
}

function enforcePinnedMessage(
  range: TranscriptRange,
  totalCount: number,
  maxLoadedCount: number,
  pinnedIndex: number | null,
): TranscriptRange {
  if (pinnedIndex === null || (pinnedIndex >= range.start && pinnedIndex < range.end)) {
    return range;
  }

  if (pinnedIndex >= range.end) {
    return normalizeRange(pinnedIndex + 1 - maxLoadedCount, pinnedIndex + 1, totalCount);
  }

  return normalizeRange(pinnedIndex, pinnedIndex + maxLoadedCount, totalCount);
}

function buildSlice(
  cache: DisplayTranscriptCache,
  range: TranscriptRange,
): TranscriptWindowSlice {
  const totalCount = cache.transcript.length;
  const transcriptWindow: TranscriptWindow = {
    totalCount,
    loadedStart: range.start,
    loadedEnd: range.end,
    hasOlder: range.start > 0,
    hasNewer: range.end < totalCount,
    isPartial: range.start > 0 || range.end < totalCount,
    hasUserMessages: cache.hasUserMessages,
  };

  return {
    transcript: (cache.transportTranscript ?? cache.transcript).slice(range.start, range.end),
    transcriptWindow,
  };
}

function resolvePinnedIndex(
  cache: DisplayTranscriptCache,
  pinnedMessageId?: string,
): number | null {
  if (!pinnedMessageId) {
    return null;
  }

  const index = cache.transcript.findIndex((message) => message.id === pinnedMessageId);
  return index >= 0 ? index : null;
}

function deriveCacheFingerprint(entries: SessionEntryLike[]): {
  branchEntryCount: number;
  branchLastEntryId?: string;
} {
  const branchEntryCount = entries.length;
  const branchLastEntryId = branchEntryCount > 0 ? entries[branchEntryCount - 1]?.id : undefined;
  return { branchEntryCount, branchLastEntryId };
}

export function buildDisplayTranscriptCache(entries: SessionEntryLike[], sessionPath = ''): DisplayTranscriptCache {
  const transcript = mapTranscript(entries);
  const transportTranscript = transcript.map((message) => compactDurableMessageDetails(message, sessionPath));
  const { branchEntryCount, branchLastEntryId } = deriveCacheFingerprint(entries);
  return {
    transcript,
    transportTranscript,
    hasUserMessages: transcript.some((message) => message.role === 'user'),
    branchEntryCount,
    branchLastEntryId,
  };
}

export function isDisplayTranscriptCacheStale(
  cache: DisplayTranscriptCache | undefined,
  entries: SessionEntryLike[],
): boolean {
  if (!cache) {
    return true;
  }

  const { branchEntryCount, branchLastEntryId } = deriveCacheFingerprint(entries);
  return cache.branchEntryCount !== branchEntryCount || cache.branchLastEntryId !== branchLastEntryId;
}

export function buildTailTranscriptWindow(
  cache: DisplayTranscriptCache,
  options?: {
    tailCount?: number;
    maxLoadedCount?: number;
    pinnedMessageId?: string;
  },
): TranscriptWindowSlice {
  const totalCount = cache.transcript.length;
  const tailCount = options?.tailCount ?? TRANSCRIPT_WINDOW_BUDGETS.tailCount;
  const maxLoadedCount = options?.maxLoadedCount ?? TRANSCRIPT_WINDOW_BUDGETS.maxLoadedCount;
  const pinnedIndex = resolvePinnedIndex(cache, options?.pinnedMessageId);

  const start = Math.max(0, totalCount - tailCount);
  const range = enforcePinnedMessage(
    enforceMaxLoadedCount(
      normalizeRange(start, totalCount, totalCount),
      totalCount,
      maxLoadedCount,
      'latest',
    ),
    totalCount,
    maxLoadedCount,
    pinnedIndex,
  );

  return buildSlice(cache, range);
}

export function buildPagedTranscriptWindow(
  cache: DisplayTranscriptCache,
  options: {
    direction: TranscriptPageDirection;
    loadedStart?: number;
    loadedEnd?: number;
    pageSize?: number;
    tailCount?: number;
    maxLoadedCount?: number;
    pinnedMessageId?: string;
  },
): TranscriptWindowSlice {
  const direction = options.direction;
  if (direction === 'latest') {
    return buildTailTranscriptWindow(cache, {
      tailCount: options.tailCount,
      maxLoadedCount: options.maxLoadedCount,
      pinnedMessageId: options.pinnedMessageId,
    });
  }

  const totalCount = cache.transcript.length;
  const pageSize = options.pageSize ?? TRANSCRIPT_WINDOW_BUDGETS.pageSize;
  const maxLoadedCount = options.maxLoadedCount ?? TRANSCRIPT_WINDOW_BUDGETS.maxLoadedCount;
  const pinnedIndex = resolvePinnedIndex(cache, options.pinnedMessageId);
  const fallbackTail = buildTailTranscriptWindow(cache, {
    tailCount: options.tailCount,
    maxLoadedCount,
    pinnedMessageId: options.pinnedMessageId,
  }).transcriptWindow;

  const currentStart = options.loadedStart ?? fallbackTail.loadedStart;
  const currentEnd = options.loadedEnd ?? fallbackTail.loadedEnd;

  const baseRange = normalizeRange(currentStart, currentEnd, totalCount);
  const requestedRange = direction === 'older'
    ? normalizeRange(baseRange.start - pageSize, baseRange.end, totalCount)
    : normalizeRange(baseRange.start, baseRange.end + pageSize, totalCount);

  const boundedRange = enforceMaxLoadedCount(
    requestedRange,
    totalCount,
    maxLoadedCount,
    direction,
  );

  const pinnedRange = enforcePinnedMessage(
    boundedRange,
    totalCount,
    maxLoadedCount,
    pinnedIndex,
  );

  return buildSlice(cache, pinnedRange);
}
