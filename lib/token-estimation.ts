import { countTokens as bpeCountTokens } from 'gpt-tokenizer/encoding/cl100k_base';

/**
 * Real BPE token counting via `gpt-tokenizer` (cl100k_base).
 *
 * cl100k_base is the GPT-4 / text-embedding encoding and a reasonable
 * token-count approximation for the other BPE model families this project
 * targets (Claude, GLM, Llama, Qwen, ...) — far closer than the chars/4
 * heuristic it replaces. It is NOT the active model's exact tokenizer:
 * provider `usage` blocks remain the source of truth where available
 * (see `src/backend/context-usage.ts`). Callers that previously divided
 * character counts by 4 should call this instead.
 */
/**
 * Estimate output tokens for a chunk of model-produced text: a real BPE
 * (cl100k_base) count of the trimmed text, with guards for empty or non-string
 * input. Shared between the webview (context-window / token breakdowns) and
 * the host (token-rate measurement), so the host-side rate measurement uses the
 * exact same token magnitudes as the webview did.
 */
export function estimateTextTokens(text: string): number {
  if (typeof text !== 'string') {
    return 0;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }
  // Real BPE count (cl100k_base); approximate for the active model but far
  // closer than the chars/4 heuristic. Exact attribution comes from provider
  // usage (see backend/context-usage.ts), so these rows stay "estimated".
  return bpeCountTokens(trimmed);
}

