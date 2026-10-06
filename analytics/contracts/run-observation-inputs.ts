/** Privacy-safe settlement evidence shared by analytics owners and the harness RPC DTO. */
export interface AnalyticsAuxiliaryLlmUsageObservation {
  kind: 'assistant_message' | 'history_compaction' | 'branch_summary' | 'session_title' | 'other';
  sourceId: string;
  /** Runtime assistant message id that was streaming when this provider
   * response settled. It is distinct from the canonical invocation identity;
   * the host uses it only for the provisional live-cost handoff. */
  provisionalMessageId?: string;
  occurredAt: string;
  modelId?: string;
  provider?: string;
  parentOperationId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  providerTotalTokens?: number;
  /** Explicit channel completeness from the provider response. */
  tokenChannelsKnown?: boolean;
  tokenChannelPresence?: {
    input: boolean;
    output: boolean;
    cacheRead: boolean;
    cacheWrite: boolean;
  };
  reportedCostUsd?: number;
  durationMs?: number;
  startedAt?: string;
  outcome?: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  instrumentationGap?: boolean;
  instrumentationGapReason?: string;
}

/** Minimal input facts retained by run analytics; never includes transport payload data. */
export type RunInputObservation =
  | { kind: 'filesystemPathRef' }
  | { kind: 'imageBlob'; sizeBytes: number }
  | { kind: 'fileBlob' };

export type AnalyticsInputKind = RunInputObservation['kind'];
