import type { ChatMessage, PruningDetails, PruningMode } from '../../../shared/protocol';
import { pruningTotals } from '../../../shared/pruning.js';
// Re-export the shared numeric helper so existing import paths (e.g.
// pruning-header.tsx) keep working while the math lives in one place.
export { pruningTotals };

export type PruningHeaderState =
  | { kind: 'pending'; label: string }
  | { kind: 'result'; details: PruningDetails; fallbackText?: string };

import { isRecord } from '../../../shared/type-guards';


function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function pruningMode(value: unknown): PruningMode {
  return value === 'auto' || value === 'shadow' || value === 'off' ? value : 'auto';
}

/**
 * The skill-pruner custom message is best-effort: error payloads from older
 * versions can omit candidate arrays. Normalize those payloads so rendering can
 * still attach the failure/diagnostics to the assistant turn instead of showing
 * a raw system message in the transcript.
 */
export function normalizePruningDetails(value: unknown): PruningDetails | null {
  if (!isRecord(value)) return null;

  const hasCandidateArrays =
    Array.isArray(value.includedSkills) ||
    Array.isArray(value.excludedSkills) ||
    Array.isArray(value.includedTools) ||
    Array.isArray(value.excludedTools);
  const hasPrepassError = typeof value.prepassError === 'string' && value.prepassError.trim().length > 0;

  if (!hasCandidateArrays && !hasPrepassError) {
    return null;
  }

  return {
    includedSkills: stringArray(value.includedSkills),
    excludedSkills: stringArray(value.excludedSkills),
    includedTools: stringArray(value.includedTools),
    excludedTools: stringArray(value.excludedTools),
    mode: pruningMode(value.mode),
    skillTokensSaved: optionalNumber(value.skillTokensSaved) ?? 0,
    toolTokensSaved: optionalNumber(value.toolTokensSaved) ?? 0,
    prepassModel: optionalString(value.prepassModel),
    prepassThinkingLevel: optionalString(value.prepassThinkingLevel),
    prepassResponse: optionalString(value.prepassResponse),
    prepassSystemPrompt: optionalString(value.prepassSystemPrompt),
    prepassUserMessage: optionalString(value.prepassUserMessage),
    prepassThinking: optionalString(value.prepassThinking),
    prepassLatencyMs: optionalNumber(value.prepassLatencyMs),
    prepassInputTokens: optionalNumber(value.prepassInputTokens),
    prepassOutputTokens: optionalNumber(value.prepassOutputTokens),
    prepassCacheReadTokens: optionalNumber(value.prepassCacheReadTokens),
    prepassCacheWriteTokens: optionalNumber(value.prepassCacheWriteTokens),
    prepassError: optionalString(value.prepassError),
    prepassSafeguardReason: optionalString(value.prepassSafeguardReason),
  };
}

export function pruningDetailsFromMessage(message: ChatMessage): PruningDetails | null {
  if (message.customType !== 'pruning-result') return null;
  return normalizePruningDetails(message.customDetails);
}

export function isPruningResultMessage(message: ChatMessage): boolean {
  return message.customType === 'pruning-result';
}

// Numeric totals live in the shared helper; this module re-exports it.
export function formatPruningSummary(details: PruningDetails, fallbackText = 'No skills or tools evaluated'): string {
  if (details.prepassError) {
    return 'Pruning failed';
  }

  const { skillsKept, skillsTotal, toolsKept, toolsTotal, tokensSaved } = pruningTotals(details);
  const summaryParts: string[] = [];

  if (skillsTotal > 0) {
    summaryParts.push(`Kept ${skillsKept}/${skillsTotal} skills`);
  }
  if (toolsTotal > 0) {
    summaryParts.push(`Kept ${toolsKept}/${toolsTotal} tools`);
  }

  const summaryCore = summaryParts.length > 0 ? summaryParts.join(', ') : fallbackText;
  const tokenSuffix = tokensSaved > 0 ? ` · Saved ${tokensSaved} tokens` : '';

  return `${summaryCore}${tokenSuffix}`;
}
