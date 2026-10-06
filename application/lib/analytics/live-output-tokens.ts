import type { ChatMessage } from '../protocol/messages.js';
import { estimateTextTokens } from '../../../lib/token-estimation.js';

/** Char bound beyond which fields are tail-sampled. Matches the backend's
 * live subagent counter's bounded-estimate strategy. */
export const TOKEN_SAMPLE_CHARS = 8_192;

/**
 * Bounded BPE estimate: exact tokenization for short text and a tail-density
 * estimate for long text. The optional tokenizer seam lets the host sampler
 * retain its work counter without changing the shared calculation.
 */
export function estimateBoundedTokens(
  text: string,
  countTokens: (value: string) => number = estimateTextTokens,
): number {
  if (typeof text !== 'string' || text.length <= TOKEN_SAMPLE_CHARS) {
    return countTokens(text);
  }
  const tail = text.slice(-TOKEN_SAMPLE_CHARS);
  const tailTokens = countTokens(tail);
  return Math.round(tailTokens * (text.length / tail.length));
}

/**
 * Estimate visible output on one message using the host token-rate sampler's
 * exact field and tool-draft rules. Provider-reported usage remains authoritative.
 */
export function estimateLiveAssistantOutputTokens(
  message: ChatMessage | null,
  countTokens: (value: string) => number = estimateTextTokens,
): number {
  if (!message) return 0;
  let total = estimateBoundedTokens(message.markdown ?? '', countTokens)
    + estimateBoundedTokens(message.thinking ?? '', countTokens);
  const drafts = (message.toolCalls ?? [])
    .filter((toolCall) => toolCall.status === 'drafting' || toolCall.status === 'ready')
    .map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      argsText: toolCall.argumentsText ?? (typeof toolCall.input === 'string' ? toolCall.input : ''),
    }));
  const legacy = message.draftingToolCall;
  if (legacy && !drafts.some((draft) => draft.id === legacy.id)) {
    drafts.push({ id: legacy.id, name: legacy.name, argsText: legacy.argumentsText });
  }
  for (const draft of drafts) {
    total += estimateBoundedTokens(draft.name, countTokens)
      + estimateBoundedTokens(draft.argsText, countTokens);
  }
  return total;
}
