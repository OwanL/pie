
import type { AssistantUsage, ThinkingLevel } from '../../../../shared/run-analytics-contracts.js';

export type { AssistantUsage, ThinkingLevel };

export interface ModelSettings {
  defaultModel: string;
  defaultThinkingLevel: ThinkingLevel;
  /**
   * Provider for `defaultModel`, used by the SDK to restore the model on new
   * sessions (`modelRegistry.find(defaultProvider, defaultModel)`). Persisted
   * alongside `defaultModel` when the picker sends a `provider/id` spec to
   * disambiguate models that exist under multiple providers.
   */
  defaultProvider?: string;
}

/**
 * Compare model settings for a read-only hydration update.
 *
 * Provider identity is part of the model identity when both sides carry it.
 * Older settings/state snapshots may omit `defaultProvider`, so an omitted
 * provider remains a wildcard for compatibility with those snapshots.
 */
export function modelSettingsMatchForHydration(
  current: ModelSettings | null | undefined,
  hydrated: ModelSettings,
): boolean {
  if (!current) {
    return false;
  }

  const providersMatch = current.defaultProvider === undefined
    || hydrated.defaultProvider === undefined
    || current.defaultProvider === hydrated.defaultProvider;

  return current.defaultModel === hydrated.defaultModel
    && providersMatch
    && current.defaultThinkingLevel === hydrated.defaultThinkingLevel;
}

export type ModelInputKind = 'text' | 'image';

/**
 * Per-model metadata sourced from the shared `<agentDir>/model-profiles.{yaml,json}`.
 * Drives ordering and warning badges in the model picker.
 */
export interface ModelSubagentInfo {
  /** True when the model is allowed as a subagent target (profile `eligible`). */
  eligible: boolean;
  /** Optional human-readable reason recorded in the profile when ineligible. */
  disabledReason?: string;
  /** Real token pricing in USD per 1M tokens, when known. */
  pricing?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    tiers?: Array<{
      inputTokensAbove: number;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    }>;
  };
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  /** Exact Pi reasoning controls supported by this provider-qualified model.
   * `xhigh` and `max` remain distinct; unsupported levels are omitted. */
  thinkingLevels?: ThinkingLevel[];
  /** Explicit input capabilities. Backends must default to `['text']` when unsure. */
  inputKinds: ModelInputKind[];
  contextWindow?: number;
  maxTokens?: number;
  /** Present when a matching subagent profile exists; absent for unprofiled models. */
  subagent?: ModelSubagentInfo;
}

export interface ContextWindowUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}


