import type { AssistantUsage } from '../../../analytics/contracts/legacy-run-analytics-contracts.js';
import type { ModelInfo, ModelInputKind, ModelSettings, ModelSubagentInfo } from '../../../harness/model-providers/catalog/model-contract.js';
import type { ThinkingLevel } from '../../../harness/model-providers/catalog/thinking-level.js';
import type { ContextWindowUsage, InitialContextEstimate } from '../../../harness/agent-processes/lib/rpc/session-events.js';

export type {
  AssistantUsage,
  ContextWindowUsage,
  InitialContextEstimate,
  ModelInfo,
  ModelInputKind,
  ModelSettings,
  ModelSubagentInfo,
  ThinkingLevel,
};

/** Compare model settings for a read-only hydration update. */
export function modelSettingsMatchForHydration(
  current: ModelSettings | null | undefined,
  hydrated: ModelSettings,
): boolean {
  if (!current) return false;
  const providersMatch = current.defaultProvider === undefined
    || hydrated.defaultProvider === undefined
    || current.defaultProvider === hydrated.defaultProvider;
  return current.defaultModel === hydrated.defaultModel
    && providersMatch
    && current.defaultThinkingLevel === hydrated.defaultThinkingLevel;
}
