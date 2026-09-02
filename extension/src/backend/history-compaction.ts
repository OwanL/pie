import { COMPACTION_METRICS_CUSTOM_TYPE } from '../shared/protocol';
import type { SessionEntryLike } from './transcript';
import type { MessageLike } from './transcript/types';

const OVERFLOW_PATTERNS = [
  /prompt is too long/i,
  /request_too_large/i,
  /input is too long for requested model/i,
  /range of input length should be/i,
  /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length/i,
  /input token count.*exceeds the maximum/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds (?:the )?maximum allowed input length/i,
  /is longer than the model'?s context length/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /too large for model with \d+ maximum context length/i,
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i,
  /model_context_window_exceeded/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /context[_ ]length[_ ]exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
  /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i,
];

const NON_OVERFLOW_PATTERNS = [
  /^(Throttling error|Service unavailable):/i,
  /rate limit/i,
  /too many requests/i,
];

function finiteUsage(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Mirror the pinned SDK's provider-overflow classification at the seams Pie
 * owns. Keeping this pure lets transcript affordances and zero-prompt
 * continuation agree after a runtime rebuild. */
export function isContextOverflowMessage(
  message: Pick<MessageLike, 'stopReason' | 'errorMessage' | 'usage'>,
  _contextWindow?: number,
): boolean {
  const errorMessage = message.errorMessage;
  if (message.stopReason === 'error' && errorMessage) {
    if (NON_OVERFLOW_PATTERNS.some((pattern) => pattern.test(errorMessage))) return false;
    if (OVERFLOW_PATTERNS.some((pattern) => pattern.test(errorMessage))) return true;
  }

  const input = finiteUsage(message.usage?.input) + finiteUsage(message.usage?.cacheRead);
  const output = finiteUsage(message.usage?.output);
  // A successful stop is a completed answer even when the provider reports an
  // over-window usage estimate. Only a no-output length stop is resumable.
  // Treat that shape consistently with and without a known model window so the
  // transcript affordance and backend continuation gate cannot disagree.
  if (message.stopReason === 'length' && output === 0 && input > 0) return true;
  return false;
}

function nestedReason(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as { reason?: unknown; pieCompaction?: { reason?: unknown } };
  const reason = raw.pieCompaction?.reason ?? raw.reason;
  return typeof reason === 'string' ? reason : undefined;
}

function overflowCompactionIds(entries: SessionEntryLike[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.type === 'compaction' && nestedReason(entry.details) === 'overflow') ids.add(entry.id);
    if (entry.type !== 'custom' || entry.customType !== COMPACTION_METRICS_CUSTOM_TYPE
        || !entry.data || typeof entry.data !== 'object') continue;
    const data = entry.data as { compactionEntryId?: unknown; reason?: unknown };
    if (data.reason === 'overflow' && typeof data.compactionEntryId === 'string') {
      ids.add(data.compactionEntryId);
    }
  }
  return ids;
}

/** IDs of provider assistant rows that native overflow recovery persisted but
 * removed from its live prompt before appending the matching compaction. These
 * rows must stay out of every rebuilt prompt and transcript projection too. */
export function consumedOverflowMessageEntryIds(entries: SessionEntryLike[]): Set<string> {
  const compactionIds = overflowCompactionIds(entries);
  const consumed = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.type !== 'compaction') continue;
    for (let previousIndex = index - 1; previousIndex >= 0; previousIndex -= 1) {
      const previous = entries[previousIndex];
      if (previous.type !== 'message') continue;
      const message = previous.message;
      const explicitlyOverflow = compactionIds.has(entry.id);
      // Older/native compactions can predate Pie's reason metadata. The exact
      // consumed provider row still proves the overflow shape before the
      // metrics sidecar exists, including during the live context rebuild.
      if (message?.role === 'assistant'
          && message.stopReason !== 'stop'
          && (explicitlyOverflow || isContextOverflowMessage(message))) {
        consumed.add(previous.id);
      }
      break;
    }
  }
  return consumed;
}
