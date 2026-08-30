import type { ChatMessage, UserContentPart } from '../../../shared/protocol';
import { isNearBottom } from '../auto-scroll';
import { getRenderableUserParts } from './parts';
import type { TranscriptRow } from './virtual-list-rows';

/** The prompt changes once a new user row is close to the viewport's top edge. */
export const USER_PROMPT_SWITCH_THRESHOLD_PX = 10;

export interface UserPromptEntry {
  /** Index into the virtual transcript row list, used by Locate. */
  rowIndex: number;
  messageId: string;
  /**
   * Source message. Normalized text and image count are derived lazily for
   * the selected prompt only (see {@link userPromptDetails}): normalizing
   * every entry here would redo O(transcript) string work on every streaming
   * row-model rebuild.
   */
  message: ChatMessage;
  isQueued: boolean;
  isAutoResume: boolean;
}

export interface UserPromptDetails {
  /** Normalized plain text. It is rendered as a text node, never as markdown. */
  plainText: string;
  imageCount: number;
}

function textParts(parts: readonly UserContentPart[] | undefined): string {
  return parts
    ?.filter((part): part is Extract<UserContentPart, { kind: 'text' }> => part.kind === 'text')
    .map((part) => part.text)
    .join(' ')
    .trim() ?? '';
}

/** Return the source text used by the context bar and other plain-text previews. */
export function userPromptPlainText(message: Pick<ChatMessage, 'role' | 'markdown' | 'userParts'>): string {
  const parts = getRenderableUserParts(message);
  const partText = textParts(parts);
  const source = partText || (parts === undefined ? message.markdown.trim() : '');
  if (source) return source.replace(/\s+/gu, ' ').trim();

  const imageCount = parts?.filter((part) => part.kind === 'image').length ?? 0;
  if (imageCount > 0) return `(${imageCount} image${imageCount === 1 ? '' : 's'})`;
  return '(empty)';
}

/**
 * Derive the display details for one prompt. Only the selected entry calls
 * this — the component memoizes it on the selected message's content fields.
 */
export function userPromptDetails(message: Pick<ChatMessage, 'role' | 'markdown' | 'userParts'>): UserPromptDetails {
  const parts = getRenderableUserParts(message);
  return {
    plainText: userPromptPlainText(message),
    imageCount: parts?.filter((part) => part.kind === 'image').length ?? 0,
  };
}

/**
 * Build the small, ordered index used by the sticky context bar. This is
 * intentionally separate from viewport selection: it runs when the row model
 * changes, while selection only reads the current virtualizer measurements.
 * The index is deliberately cheap — source message references plus row-local
 * flags; no text normalization or parts scans happen here.
 */
export function buildUserPromptEntries(rows: readonly TranscriptRow[]): UserPromptEntry[] {
  const entries: UserPromptEntry[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row?.kind !== 'message' || row.message.role !== 'user') continue;

    const message = row.message;
    entries.push({
      rowIndex,
      messageId: message.id,
      message,
      isQueued: message.status === 'queued',
      isAutoResume: message.customType !== undefined,
    });
  }
  return entries;
}

export interface SelectUserPromptAtViewportOptions {
  entries: readonly UserPromptEntry[];
  /** Read the current start from the virtualizer's dense measurement cache. */
  getRowStart: (rowIndex: number) => number | null;
  scrollOffset: number | null;
  isAtBottom: boolean;
  /** Optional content-origin correction for a padded scroll container. */
  contentOriginPx?: number;
  switchThresholdPx?: number;
}

/**
 * Select the user prompt governing the first meaningful row in the viewport.
 * The entries are already ordered by row index, and virtualizer starts are
 * monotonic, so this remains O(log user-prompts) per render.
 */
export function selectUserPromptAtViewport({
  entries,
  getRowStart,
  scrollOffset,
  isAtBottom,
  contentOriginPx = 0,
  switchThresholdPx = USER_PROMPT_SWITCH_THRESHOLD_PX,
}: SelectUserPromptAtViewportOptions): UserPromptEntry | null {
  if (entries.length === 0) return null;
  if (isAtBottom) return entries[entries.length - 1] ?? null;
  if (scrollOffset === null || !Number.isFinite(scrollOffset)) return null;

  const origin = Number.isFinite(contentOriginPx) ? contentOriginPx : 0;
  const threshold = Number.isFinite(switchThresholdPx)
    ? switchThresholdPx
    : USER_PROMPT_SWITCH_THRESHOLD_PX;
  const viewportBoundary = scrollOffset - origin + threshold;

  let low = 0;
  let high = entries.length - 1;
  let selected = -1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const start = getRowStart(entries[middle]?.rowIndex ?? -1);
    // TanStack's measurements cache is dense. If a caller supplies an
    // incomplete cache, do not invent a preceding prompt from a future row.
    if (start === null || !Number.isFinite(start)) return null;
    if (start <= viewportBoundary) {
      selected = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return selected >= 0 ? entries[selected] ?? null : null;
}

export interface PromptViewportMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * Read the element metrics selection needs, or null when the element cannot
 * be measured (first render before the scroll element mounts, or detached).
 */
export function readPromptMetrics(element: HTMLDivElement | null): PromptViewportMetrics | null {
  if (!element) return null;
  const { scrollTop, scrollHeight, clientHeight } = element;
  if (!Number.isFinite(scrollTop) || scrollHeight <= 0 || clientHeight <= 0) return null;
  return { scrollTop, scrollHeight, clientHeight };
}

export interface SelectPromptFromMetricsOptions {
  entries: readonly UserPromptEntry[];
  getRowStart: (rowIndex: number) => number | null;
  /** Live metrics read from the scroll element, when measurable. */
  metrics: PromptViewportMetrics | null;
  /** Used only while metrics are unavailable (virtualizer offset). */
  fallbackScrollOffset: number | null;
  /** Used only while metrics are unavailable (parent reactive state). */
  fallbackIsAtBottom: boolean;
  contentOriginPx?: number;
}

/**
 * Select the governing prompt from an element's actual scroll position.
 * TanStack's virtualizer only notifies on virtual-range changes, so scroll
 * movement inside one range must be resolved by re-reading these metrics.
 * Near-bottom is measured from the same element metrics (same threshold as
 * the transcript's bottom-follow state), so the latest loadable prompt is
 * selected immediately even when its row starts below the top-edge boundary.
 */
export function selectPromptFromElementMetrics({
  entries,
  getRowStart,
  metrics,
  fallbackScrollOffset,
  fallbackIsAtBottom,
  contentOriginPx = 0,
}: SelectPromptFromMetricsOptions): UserPromptEntry | null {
  if (
    metrics === null
    || !Number.isFinite(metrics.scrollTop)
    || metrics.scrollHeight <= 0
    || metrics.clientHeight <= 0
  ) {
    return selectUserPromptAtViewport({
      entries,
      getRowStart,
      scrollOffset: fallbackScrollOffset,
      isAtBottom: fallbackIsAtBottom,
      contentOriginPx,
    });
  }

  return selectUserPromptAtViewport({
    entries,
    getRowStart,
    scrollOffset: metrics.scrollTop,
    isAtBottom: isNearBottom(metrics),
    contentOriginPx,
  });
}