import type { ContextWindowUsage } from '../shared/protocol';
import type { SessionEntryLike } from './transcript';
import { usageFromMessage } from './transcript/content';

function normalizeContextWindow(contextWindow: number | undefined): number | undefined {
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return undefined;
  }
  return Math.trunc(contextWindow);
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, value));
}

/**
 * Canonical context-window usage derivation.
 *
 * `tokens` is the **prompt footprint** of the most recent assistant usage —
 * `input + cacheRead + cacheWrite` — i.e. the tokens that actually counted
 * against the context window on the last API call. Output tokens are excluded
 * (they don't consume the window) and no chars/4 trailing estimate is added
 * (that estimate disagreed with the real usage reported on completion, making
 * the indicator jump). The footprint is stable during a turn and only steps
 * forward when a new assistant usage lands, so the indicator reflects actual
 * window use consistently. Returns `undefined` when no assistant usage exists
 * yet (first turn / post-compaction before a new response).
 */
export function deriveContextUsageFromBranch(
  entries: SessionEntryLike[] | undefined,
  contextWindow: number | undefined,
): ContextWindowUsage | undefined {
  const normalizedContextWindow = normalizeContextWindow(contextWindow);
  if (!normalizedContextWindow || !entries || entries.length === 0) {
    return undefined;
  }

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    // A compaction entry replaces the earlier conversation context. Usage on
    // assistant messages before that boundary describes the pre-compaction
    // prompt and must not keep the context indicator artificially full. The
    // next assistant response will provide a fresh measured footprint.
    if (entry.type === 'compaction') {
      return undefined;
    }
    if (entry.type !== 'message' || entry.message?.role !== 'assistant') {
      continue;
    }

    const usage = usageFromMessage(entry.message);
    if (!usage) {
      continue;
    }

    const promptFootprint = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    const tokens = promptFootprint > 0 ? promptFootprint : usage.totalTokens;
    const percent = clampPercent((tokens / normalizedContextWindow) * 100);

    return {
      tokens,
      contextWindow: normalizedContextWindow,
      percent,
    };
  }

  return undefined;
}
