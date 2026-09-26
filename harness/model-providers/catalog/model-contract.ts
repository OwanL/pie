import type { ThinkingLevel } from './thinking-level.js';

/** Host/backend setting selecting a provider-qualified default reasoning mode. */
export interface ModelSettings {
  defaultModel: string;
  defaultThinkingLevel: ThinkingLevel;
  defaultProvider?: string;
}

export type ModelInputKind = 'text' | 'image';

export interface ModelSubagentInfo {
  eligible: boolean;
  disabledReason?: string;
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

/** JSON-safe provider-qualified model descriptor returned by model discovery. */
export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  thinkingLevels?: ThinkingLevel[];
  inputKinds: ModelInputKind[];
  contextWindow?: number;
  maxTokens?: number;
  subagent?: ModelSubagentInfo;
}
