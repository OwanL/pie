import type { SystemPromptEntry } from '../../shared/protocol';
import { estimateTextTokens } from '../../shared/tokenize';
import { formatTokensCompact } from './utils/format-tokens';

// `estimateTextTokens` now lives in shared/tokenize.ts (it is reused by the
// host-side token-rate measurement). Re-export it here so the existing webview
// importers (context-window breakdown, token usage, system-prompt rows) keep
// their `from '../system-prompt-tokens'` imports unchanged.
export { estimateTextTokens };

export function estimateSystemPromptTokens(prompts: readonly SystemPromptEntry[]): number {
  return prompts.reduce((total, prompt) => {
    if (prompt.availability !== 'available' || prompt.disabled === true) {
      return total;
    }

    return total + estimateTextTokens(prompt.text);
  }, 0);
}

export function formatSystemPromptTokenLabel(tokenCount: number): string {
  const formatted = tokenCount >= 1000
    ? formatTokensCompact(tokenCount)
    : tokenCount.toLocaleString();

  return `${formatted} ${tokenCount === 1 ? 'token' : 'tokens'}`;
}

export function getSystemPromptTokenEstimateTitle(
  prompts: readonly SystemPromptEntry[],
): string {
  const hasUnavailablePrompt = prompts.some((prompt) => prompt.availability !== 'available');

  return hasUnavailablePrompt
    ? 'Estimated from available system prompt text only; hidden or unavailable prompt text is not included.'
    : 'Estimated from available system prompt text.';
}