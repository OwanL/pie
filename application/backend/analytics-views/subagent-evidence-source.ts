import { providerReportedCostUsd } from '../../../harness/model-providers/pricing/provider-cost.js';
import {
  getRenderableSubagentResult,
  getSubagentBillingEntries,
  getTerminalSubagentAttemptSamplesFromToolCall,
} from '../../../harness/agent-processes/workers/subagent-result.js';
import type {
  SubagentAttemptCostObservation,
  SubagentAttemptUsageObservation,
  SubagentCostEvidenceObservation,
  SubagentObservationSource,
  SubagentResultObservation,
} from '../../../analytics/contracts/subagent-observation.js';
import { isRecord } from '../../../lib/validation/type-guards.js';

type HarnessRenderableSubagentResult = NonNullable<ReturnType<typeof getRenderableSubagentResult>>;
type HarnessRenderableSubagentChild = HarnessRenderableSubagentResult['results'][number];

const subagentResultObservationCache = new WeakMap<object, SubagentResultObservation>();

function observeSubagentCostEvidence(value: unknown): SubagentCostEvidenceObservation | undefined {
  if (value === undefined) return undefined;
  if (isRecord(value)) {
    return {
      providerReportedCostUsd: value.providerReportedCostUsd,
      reportedCostUsd: value.reportedCostUsd,
    };
  }
  if (value === null || typeof value === 'string' || typeof value === 'number'
    || typeof value === 'boolean' || Array.isArray(value)) return value;
  return undefined;
}

function observeSubagentAttemptUsage(value: unknown): SubagentAttemptUsageObservation | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    if (value === null || typeof value === 'string' || typeof value === 'number'
      || typeof value === 'boolean' || Array.isArray(value)) return value;
    return undefined;
  }
  const cost = observeSubagentCostEvidence(value.cost);
  return {
    input: value.input,
    output: value.output,
    cacheRead: value.cacheRead,
    cacheWrite: value.cacheWrite,
    providerReportedCostUsd: value.providerReportedCostUsd,
    reportedCostUsd: value.reportedCostUsd,
    ...(cost === undefined ? {} : { cost }),
  };
}

function observeSubagentAttemptRecords(
  records: readonly unknown[] | undefined,
): readonly SubagentAttemptCostObservation[] | undefined {
  if (records === undefined) return undefined;
  return records.map((attempt) => {
    if (!isRecord(attempt)) return {};
    const usage = observeSubagentAttemptUsage(attempt.usage);
    return {
      attemptId: attempt.attemptId,
      model: attempt.model,
      provider: attempt.provider,
      ...(usage === undefined ? {} : { usage }),
    };
  });
}

function observeSubagentResult(result: HarnessRenderableSubagentChild): SubagentResultObservation {
  const cached = subagentResultObservationCache.get(result);
  if (cached) return cached;

  const observation: SubagentResultObservation = {
    get usage() {
      if (!result.usage) return undefined;
      const cost = observeSubagentCostEvidence(result.usage.cost);
      return {
        input: result.usage.input,
        output: result.usage.output,
        cacheRead: result.usage.cacheRead,
        cacheWrite: result.usage.cacheWrite,
        tokenChannelsKnown: result.usage.tokenChannelsKnown,
        tokenChannelPresence: result.usage.tokenChannelPresence,
        ...(cost === undefined ? {} : { cost }),
        reportedCostUsd: result.usage.reportedCostUsd,
        providerReportedCostUsd: result.usage.providerReportedCostUsd,
      };
    },
    get model() { return result.model; },
    get selectedModel() { return result.selectedModel; },
    get provider() { return result.provider; },
    get turnThroughputSamples() { return result.turnThroughputSamples; },
    get attemptRecords() { return observeSubagentAttemptRecords(result.attemptRecords); },
    get messages() {
      if (result.messages === undefined) return undefined;
      return result.messages.map((message) => {
        const messageWithToolName = message as typeof message & { toolName?: unknown };
        return {
          role: message.role,
          ...(typeof messageWithToolName.toolName === 'string'
            ? { toolName: messageWithToolName.toolName } : {}),
          details: message.details,
        };
      });
    },
  };
  subagentResultObservationCache.set(result, observation);
  return observation;
}

/** Adapts harness results to analytics evidence without snapshotting mutable results. */
export const subagentObservationSource: SubagentObservationSource = {
  getSubagentBillingEntries,
  getRenderableSubagentResult: (rawResult) => {
    const renderable = getRenderableSubagentResult(rawResult);
    return renderable ? { results: renderable.results.map(observeSubagentResult) } : undefined;
  },
  getTerminalSubagentAttemptSamplesFromToolCall,
  readProviderReportedCostUsd: providerReportedCostUsd,
};
