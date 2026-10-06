import type { SubagentAttemptSample } from './legacy-run-analytics-contracts.js';
import type { ToolCallCaptureInput } from './tool-call-analysis-input.js';
import type { SubagentBillingCaptureReceipt } from './subagent-billing-capture-receipt.js';

/** Compact subagent billing facts shared by the live RPC boundary and analytics. */
export interface SubagentBillingUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens?: number;
  /** Number of provider turns represented by an aggregate legacy usage record. */
  turns?: number;
  /** False when one or more numeric channel values are placeholders. */
  tokenChannelsKnown?: boolean;
  tokenChannelPresence?: {
    input: boolean;
    output: boolean;
    cacheRead: boolean;
    cacheWrite: boolean;
  };
  /** Legacy compact alias for explicit provider-reported billing. */
  cost?: number;
  /** Explicit provider/invoice billing evidence. */
  reportedCostUsd?: number;
  providerReportedCostUsd?: number;
}

export interface SubagentBillingAttempt {
  attemptId: string;
  model?: string;
  provider?: string;
  usage?: SubagentBillingUsage;
  providerResponseObserved?: boolean;
  outcome?: 'success' | 'failure' | 'aborted';
  startedAt?: number;
  completedAt?: number;
  analyticsCaptureReceipt?: SubagentBillingCaptureReceipt;
}

export interface SubagentBillingInvocation extends SubagentBillingAttempt {
  invocationId: string;
  canonicalInvocationId?: string;
}

export interface SubagentBillingEntry {
  /** Stable recursive position within the terminal subagent result. */
  path: string;
  model?: string;
  selectedModel?: string;
  provider?: string;
  /** Epoch milliseconds of the latest observed child provider response. */
  occurredAt?: number;
  usage?: SubagentBillingUsage;
  attempts?: SubagentBillingAttempt[];
  invocations?: SubagentBillingInvocation[];
  /** Observable responses omitted from bounded transport; consumers emit one
   * explicit gap settlement per omitted response. */
  omittedInvocationCount?: number;
}

/** Original RPC observation statuses represented in the analytics-owned input. */
export type RunToolObservationStatus = 'drafting' | 'ready' | 'running' | 'completed' | 'failed';

/** The tracker-facing tool facts; excludes renderer and transport-only metadata. */
export type RunToolObservation = Pick<
  ToolCallCaptureInput,
  'id' | 'name' | 'input' | 'result' | 'startedAt' | 'endedAt' | 'durationMs' | 'durationClockDomain'
> & { status: RunToolObservationStatus };

export interface SubagentRenderableUsageObservation {
  input?: number | undefined;
  output?: number | undefined;
  cacheRead?: number | undefined;
  cacheWrite?: number | undefined;
  tokenChannelsKnown?: boolean | undefined;
  tokenChannelPresence?: {
    input: boolean;
    output: boolean;
    cacheRead: boolean;
    cacheWrite: boolean;
  } | undefined;
  cost?: SubagentCostEvidenceObservation | undefined;
  reportedCostUsd?: number | undefined;
  providerReportedCostUsd?: number | undefined;
}

export interface SubagentReportedCostObservation {
  providerReportedCostUsd?: unknown;
  reportedCostUsd?: unknown;
}

export type SubagentCostEvidenceObservation = SubagentReportedCostObservation
  | number
  | string
  | boolean
  | null
  | readonly unknown[];

export interface SubagentAttemptCostUsageObservation {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  providerReportedCostUsd?: unknown;
  reportedCostUsd?: unknown;
  cost?: SubagentCostEvidenceObservation;
}

export type SubagentAttemptUsageObservation = SubagentAttemptCostUsageObservation
  | null
  | string
  | number
  | boolean
  | readonly unknown[];

export interface SubagentAttemptCostObservation {
  attemptId?: unknown;
  model?: unknown;
  provider?: unknown;
  usage?: SubagentAttemptUsageObservation;
}

export interface SubagentThroughputObservation {
  endedAt: string;
  outputTokens: number;
  generationDurationMs: number;
  status: string;
  modelId?: string | undefined;
  provider?: string | undefined;
}

export interface SubagentMessageObservation {
  role: string;
  toolName?: string | undefined;
  details?: unknown;
}

/** Parsed child facts consumed by legacy run-analytics tracking only. */
export interface SubagentResultObservation {
  usage?: SubagentRenderableUsageObservation | undefined;
  model?: string | undefined;
  selectedModel?: string | undefined;
  provider?: string | undefined;
  turnThroughputSamples?: readonly SubagentThroughputObservation[] | undefined;
  /** Legacy attempt evidence consumed by the cost fallback when no billing sideband exists. */
  attemptRecords?: readonly SubagentAttemptCostObservation[] | undefined;
  messages?: readonly SubagentMessageObservation[] | undefined;
}

export interface RenderableSubagentResultObservation {
  results: readonly SubagentResultObservation[];
}

/** Analytics-owned ports around the harness's canonical subagent parsers. */
export interface SubagentObservationSource {
  getSubagentBillingEntries(rawResult: unknown): readonly SubagentBillingEntry[];
  getRenderableSubagentResult(rawResult: unknown): RenderableSubagentResultObservation | undefined;
  getTerminalSubagentAttemptSamplesFromToolCall(
    toolCall: Pick<RunToolObservation, 'id' | 'result' | 'status'>,
  ): { samples: readonly SubagentAttemptSample[]; coverageComplete: boolean };
  readProviderReportedCostUsd(value: unknown): number | undefined;
}
