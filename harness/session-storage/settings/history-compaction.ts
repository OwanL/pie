import { isThinkingLevel } from '../../model-providers/catalog/thinking-level.js';
import type { ThinkingLevel } from '../../model-providers/catalog/thinking-level.js';

/** How proactive history-compaction thresholds are interpreted. */
export type HistoryCompactionThresholdMode = 'percentage' | 'tokens';

/** Per-model token-mode overrides keyed by `${provider}/${id}`. */
export interface HistoryCompactionModelProfile {
  softThreshold: number;
  hardThreshold: number;
  keepRecentTokens: number;
}

/** Explicit non-active model selected for summary generation. */
export interface HistoryCompactionModelSelector {
  provider: string;
  id: string;
}

/** Summary thinking level: use the active model's level or a fixed override. */
export type HistoryCompactionSummaryThinkingLevel = 'inherit' | ThinkingLevel;

/** Proactive history-compaction policy shared by runtime settings and SDK scheduling. */
export interface HistoryCompactionSettings {
  enabled: boolean;
  thresholdMode: HistoryCompactionThresholdMode;
  softThreshold: number;
  hardThreshold: number;
  keepRecentTokens: number;
  summaryInstructions: string;
  summaryThinkingLevel: HistoryCompactionSummaryThinkingLevel;
  summaryModel: null | HistoryCompactionModelSelector;
  modelProfiles: Record<string, HistoryCompactionModelProfile>;
}

export const DEFAULT_HISTORY_COMPACTION_SETTINGS: HistoryCompactionSettings = {
  enabled: true,
  thresholdMode: 'percentage',
  softThreshold: 70,
  hardThreshold: 85,
  keepRecentTokens: 30_000,
  summaryInstructions: '',
  summaryThinkingLevel: 'inherit',
  summaryModel: null,
  modelProfiles: {},
};

export const DEFAULT_HISTORY_COMPACTION_TOKEN_THRESHOLDS = {
  soft: 100_000,
  hard: 120_000,
} as const;

/** Environment key mirrored to the backend for live SDK scheduling. */
export const HISTORY_COMPACTION_ENV = 'PIE_HISTORY_COMPACTION_JSON';

const MAX_KEEP_RECENT_TOKENS = 10_000_000;
const MAX_SUMMARY_INSTRUCTIONS_LENGTH = 4_000;

function isModelProfile(value: unknown): value is HistoryCompactionModelProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  for (const key of ['softThreshold', 'hardThreshold', 'keepRecentTokens']) {
    const n = v[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) return false;
  }
  const soft = v.softThreshold as number;
  const hard = v.hardThreshold as number;
  const keep = v.keepRecentTokens as number;
  return keep >= 0 && soft >= 1_000 && hard <= 10_000_000 && keep < soft && soft < hard;
}

function normalizeModelProfiles(value: unknown): Record<string, HistoryCompactionModelProfile> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, HistoryCompactionModelProfile> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!key || !isModelProfile(entry)) continue;
    out[key] = {
      softThreshold: entry.softThreshold,
      hardThreshold: entry.hardThreshold,
      keepRecentTokens: entry.keepRecentTokens,
    };
  }
  return out;
}

function normalizeSummaryModel(value: unknown): null | HistoryCompactionModelSelector {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const provider = typeof v.provider === 'string' ? v.provider : '';
  const id = typeof v.id === 'string' ? v.id : '';
  return provider && id ? { provider, id } : null;
}

/** Coerce persisted or wire-provided settings into a valid, non-inverted policy. */
export function resolveHistoryCompactionSettings(value: unknown): HistoryCompactionSettings {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const thresholdMode: HistoryCompactionThresholdMode = raw.thresholdMode === 'tokens' ? 'tokens' : 'percentage';
  const fallbackSoft = thresholdMode === 'tokens'
    ? DEFAULT_HISTORY_COMPACTION_TOKEN_THRESHOLDS.soft
    : DEFAULT_HISTORY_COMPACTION_SETTINGS.softThreshold;
  const fallbackHard = thresholdMode === 'tokens'
    ? DEFAULT_HISTORY_COMPACTION_TOKEN_THRESHOLDS.hard
    : DEFAULT_HISTORY_COMPACTION_SETTINGS.hardThreshold;
  const minimum = thresholdMode === 'tokens' ? 1_000 : 1;
  const maximum = thresholdMode === 'tokens' ? 10_000_000 : 99;
  const candidateSoft = typeof raw.softThreshold === 'number' && Number.isFinite(raw.softThreshold)
    ? raw.softThreshold
    : fallbackSoft;
  const candidateHard = typeof raw.hardThreshold === 'number' && Number.isFinite(raw.hardThreshold)
    ? raw.hardThreshold
    : fallbackHard;
  const validPair = candidateSoft >= minimum
    && candidateHard <= maximum
    && candidateHard > minimum
    && candidateSoft < candidateHard;
  const rawKeep = raw.keepRecentTokens;
  const candidateKeep = typeof rawKeep === 'number' && Number.isFinite(rawKeep) && Number.isInteger(rawKeep)
    ? Math.max(0, Math.min(rawKeep, MAX_KEEP_RECENT_TOKENS))
    : DEFAULT_HISTORY_COMPACTION_SETTINGS.keepRecentTokens;
  const effectiveSoft = validPair ? candidateSoft : fallbackSoft;
  const keepRecentTokens = thresholdMode === 'tokens'
    ? Math.min(candidateKeep, Math.max(0, Math.floor(effectiveSoft) - 1))
    : candidateKeep;
  const rawInstructions = raw.summaryInstructions;
  const summaryInstructions = typeof rawInstructions === 'string'
    ? rawInstructions.slice(0, MAX_SUMMARY_INSTRUCTIONS_LENGTH)
    : DEFAULT_HISTORY_COMPACTION_SETTINGS.summaryInstructions;
  const rawThinking = raw.summaryThinkingLevel;
  const summaryThinkingLevel: HistoryCompactionSummaryThinkingLevel = rawThinking === 'inherit' || isThinkingLevel(rawThinking)
    ? rawThinking as HistoryCompactionSummaryThinkingLevel
    : DEFAULT_HISTORY_COMPACTION_SETTINGS.summaryThinkingLevel;

  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_HISTORY_COMPACTION_SETTINGS.enabled,
    thresholdMode,
    softThreshold: validPair ? candidateSoft : fallbackSoft,
    hardThreshold: validPair ? candidateHard : fallbackHard,
    keepRecentTokens,
    summaryInstructions,
    summaryThinkingLevel,
    summaryModel: normalizeSummaryModel(raw.summaryModel),
    modelProfiles: normalizeModelProfiles(raw.modelProfiles),
  };
}

export function resolveHistoryCompactionThresholdTokens(
  settings: HistoryCompactionSettings,
  contextWindow: number,
  trigger: 'soft' | 'hard',
): number {
  const value = trigger === 'soft' ? settings.softThreshold : settings.hardThreshold;
  return settings.thresholdMode === 'percentage'
    ? Math.floor(contextWindow * value / 100)
    : Math.floor(value);
}

export function resolveHistoryCompactionEffectiveSettings(
  settings: HistoryCompactionSettings,
  modelKey: string,
): Pick<HistoryCompactionSettings, 'softThreshold' | 'hardThreshold' | 'keepRecentTokens'> {
  const profile = settings.thresholdMode === 'tokens' ? settings.modelProfiles[modelKey] : undefined;
  return profile
    ? {
        softThreshold: profile.softThreshold,
        hardThreshold: profile.hardThreshold,
        keepRecentTokens: profile.keepRecentTokens,
      }
    : {
        softThreshold: settings.softThreshold,
        hardThreshold: settings.hardThreshold,
        keepRecentTokens: settings.keepRecentTokens,
      };
}
