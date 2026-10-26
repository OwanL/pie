import type { InitialContextEstimate } from './session-events.js';

const tokenCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export function isInitialContextEstimate(value: unknown): value is InitialContextEstimate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const estimate = value as Record<string, unknown>;
  if (!tokenCount(estimate.tokens) || !tokenCount(estimate.contextWindow) || estimate.contextWindow === 0) return false;
  if (estimate.cohortKey !== undefined && (typeof estimate.cohortKey !== 'string'
    || !/^request-prefix-v1:[a-f0-9]{64}$/u.test(estimate.cohortKey))) return false;
  if (estimate.afterPruning === undefined) return true;
  if (!estimate.afterPruning || typeof estimate.afterPruning !== 'object' || Array.isArray(estimate.afterPruning)) return false;
  const stats = estimate.afterPruning as Record<string, unknown>;
  return tokenCount(stats.p25Tokens) && tokenCount(stats.medianTokens) && tokenCount(stats.p75Tokens)
    && stats.p25Tokens <= stats.medianTokens && stats.medianTokens <= stats.p75Tokens;
}
