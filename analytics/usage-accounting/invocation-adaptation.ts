import * as crypto from 'node:crypto';
import { appendPieLog } from '../../lib/structured-logging/pie-logger';
import type { BillableInvocationKind, BillableInvocationRecord } from './billable-invocation';
import type { SessionUsageSample } from './session-usage';

/** Persistence-free invocation identity, evidence normalization, and pruning
 * adaptation. Kept independent of the retired ledger and timeline owners. */
export function validTokenChannel(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}


export function validIso(value: string | undefined): string | undefined {
  if (!value || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(Date.parse(value)).toISOString();
}

export function stableEvidenceTime(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

export function normalizeInvocationTimes(
  startedAtValue: string | undefined,
  endedAtValue: string | undefined,
  now: Date,
  sourceId: string,
): { startedAt: string; endedAt: string } {
  const endedAt = validIso(endedAtValue) ?? validIso(startedAtValue) ?? now.toISOString();
  const originalStartedAt = validIso(startedAtValue);
  if (originalStartedAt && Date.parse(endedAt) < Date.parse(originalStartedAt)) {
    appendPieLog('warn', 'billable-accounting', 'provider usage timestamps were reversed; clamping start to end', {
      sourceId,
      startedAt: originalStartedAt,
      endedAt,
    });
    return { startedAt: endedAt, endedAt };
  }
  return {
    startedAt: originalStartedAt ?? endedAt,
    endedAt,
  };
}

export function stableInvocationId(sessionIdentity: string, kind: BillableInvocationKind, sourceId: string): string {
  return `inv:${crypto.createHash('sha256').update(`${sessionIdentity}\0${kind}\0${sourceId}`).digest('hex')}`;
}

export function ledgerKind(kind: SessionUsageSample['kind']): BillableInvocationKind {
  if (kind === 'assistant') return 'conversation';
  return kind;
}

export function pruningUsageSamples(messageId: string, occurredAt: string, details: unknown): SessionUsageSample[] {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return [];
  const value = details as Record<string, unknown>;
  const invocations = Array.isArray(value.prepassInvocations) ? value.prepassInvocations : undefined;
  if (invocations) {
    return invocations.flatMap((candidate, index) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
      const invocation = candidate as Record<string, unknown>;
      const read = (key: string): number | undefined => typeof invocation[key] === 'number'
        && Number.isFinite(invocation[key]) && (invocation[key] as number) >= 0
        ? invocation[key] as number : undefined;
      const input = read('input');
      const output = read('output');
      const cacheRead = read('cacheRead');
      const cacheWrite = read('cacheWrite');
      const tokenChannelPresence = {
        input: input !== undefined,
        output: output !== undefined,
        cacheRead: cacheRead !== undefined,
        cacheWrite: cacheWrite !== undefined,
      };
      const usageKnown = Object.values(tokenChannelPresence).every(Boolean);
      const sourceId = typeof invocation.invocationId === 'string' && invocation.invocationId.trim()
        ? invocation.invocationId : `skill-pruning:${messageId}:attempt:${index}`;
      const startedAt = validIso(typeof invocation.startedAt === 'string' ? invocation.startedAt : undefined);
      const endedAt = validIso(typeof invocation.endedAt === 'string' ? invocation.endedAt : undefined);
      const reportedCost = read('reportedCostUsd');
      return [{
        sourceId,
        kind: 'skill_pruning_prepass',
        modelId: typeof value.prepassModel === 'string' ? value.prepassModel : undefined,
        provider: typeof value.prepassProvider === 'string' ? value.prepassProvider : undefined,
        inputTokens: input ?? 0,
        outputTokens: output ?? 0,
        cacheReadTokens: cacheRead ?? 0,
        cacheWriteTokens: cacheWrite ?? 0,
        totalTokens: usageKnown ? input! + output! + cacheRead! + cacheWrite! : 0,
        ...(reportedCost !== undefined ? { reportedCostUsd: reportedCost } : {}),
        ...(!usageKnown ? { tokenChannelsKnown: false, tokenChannelPresence } : {}),
        provenance: usageKnown ? (reportedCost !== undefined ? 'exact' : 'estimated') : 'unknown',
        instrumentationGap: !usageKnown,
        ...(!usageKnown ? { instrumentationGapReason: 'The pruning provider invocation returned no usage.' } : {}),
        outcome: invocation.outcome === 'failed' || invocation.outcome === 'cancelled'
          ? invocation.outcome : 'succeeded',
        ...(startedAt ? { startedAt } : {}),
        ...(endedAt ? { endedAt } : {}),
      } satisfies SessionUsageSample];
    });
  }

  if (value.cacheHit === true) return [];
  const readOptional = (key: string): number | undefined => typeof value[key] === 'number'
    && Number.isFinite(value[key]) && (value[key] as number) >= 0 ? value[key] as number : undefined;
  const inputRaw = value.prepassInputTokens;
  const outputRaw = value.prepassOutputTokens;
  const cacheReadRaw = value.prepassCacheReadTokens;
  const cacheWriteRaw = value.prepassCacheWriteTokens;
  const inputTokens = readOptional('prepassInputTokens') ?? 0;
  const outputTokens = readOptional('prepassOutputTokens') ?? 0;
  const cacheReadTokens = readOptional('prepassCacheReadTokens') ?? 0;
  const cacheWriteTokens = readOptional('prepassCacheWriteTokens') ?? 0;
  const declaredPresence = value.prepassTokenChannelPresence && typeof value.prepassTokenChannelPresence === 'object'
    && !Array.isArray(value.prepassTokenChannelPresence)
    ? value.prepassTokenChannelPresence as Record<string, unknown> : undefined;
  const hasChannelValues = [inputRaw, outputRaw, cacheReadRaw, cacheWriteRaw].some((channel) => channel !== undefined);
  const inferredPresence = (raw: unknown): boolean => value.prepassTokenChannelsKnown === false
    ? false : hasChannelValues ? validTokenChannel(raw) : true;
  const tokenChannelPresence = {
    input: typeof declaredPresence?.input === 'boolean'
      ? declaredPresence.input && validTokenChannel(inputRaw) : inferredPresence(inputRaw),
    output: typeof declaredPresence?.output === 'boolean'
      ? declaredPresence.output && validTokenChannel(outputRaw) : inferredPresence(outputRaw),
    cacheRead: typeof declaredPresence?.cacheRead === 'boolean'
      ? declaredPresence.cacheRead && validTokenChannel(cacheReadRaw) : inferredPresence(cacheReadRaw),
    cacheWrite: typeof declaredPresence?.cacheWrite === 'boolean'
      ? declaredPresence.cacheWrite && validTokenChannel(cacheWriteRaw) : inferredPresence(cacheWriteRaw),
  };
  const tokenChannelsKnown = value.prepassTokenChannelsKnown !== false
    && Object.values(tokenChannelPresence).every(Boolean);
  const reportedCostUsd = typeof value.prepassReportedCostUsd === 'number'
    && Number.isFinite(value.prepassReportedCostUsd) && value.prepassReportedCostUsd >= 0
    ? value.prepassReportedCostUsd : undefined;
  const totalTokens = tokenChannelsKnown
    ? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens : 0;
  const hasUsage = totalTokens > 0 || reportedCostUsd !== undefined || !tokenChannelsKnown;
  const instrumentationGap = !tokenChannelsKnown || !hasUsage;
  if (!value.prepassModel && !hasUsage && !value.prepassError) return [];
  return [{
    sourceId: `skill-pruning:${messageId}`,
    kind: 'skill_pruning_prepass',
    modelId: typeof value.prepassModel === 'string' ? value.prepassModel : undefined,
    provider: typeof value.prepassProvider === 'string' ? value.prepassProvider : undefined,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    ...(reportedCostUsd !== undefined ? { reportedCostUsd } : {}),
    ...(!tokenChannelsKnown ? { tokenChannelsKnown: false, tokenChannelPresence } : {}),
    provenance: instrumentationGap ? 'unknown'
      : reportedCostUsd !== undefined ? 'exact' : 'estimated',
    instrumentationGap,
    ...(instrumentationGap ? { instrumentationGapReason: !tokenChannelsKnown
      ? 'The pruning provider response omitted one or more token channels.'
      : 'The pruning prepass completed without provider usage.' } : {}),
    outcome: value.prepassError ? 'failed' : 'succeeded',
    // This legacy aggregate has only result time, not a proven invocation start.
    endedAt: occurredAt,
  }];
}

/** Adapt a live or compatibility sample without reading or writing storage. */
export function adaptInvocationRecord(
  sessionPath: string,
  sample: SessionUsageSample,
  context: {
    invocationId: string;
    sessionId: string | null;
    kind: BillableInvocationKind;
    identity: { provider?: string; modelId?: string };
    now: () => Date;
    getPricingFacts: () => import('../contracts/model-pricing-facts').CapturedPricingFacts | undefined;
    resolveInvocationPricing: import('../contracts/invocation-pricing-resolver').InvocationPricingResolver;
    branchId?: string | null;
    operationId?: string | null;
    toolId?: string | null;
    runId: string | null;
    migration?: boolean;
    stableMissingTime?: boolean;
    outcome?: BillableInvocationRecord['outcome'];
  },
): BillableInvocationRecord {
  const { invocationId, kind, identity } = context;
  const stableSessionId = context.sessionId;
    const declaredPresence = sample.tokenChannelPresence;
    // An undeclared channel presence means "present" only when the sample does
    // not explicitly declare its token channels unknown. Otherwise the
    // normalized zero stand-ins are placeholders for missing channels and must
    // not masquerade as known zeros (missing usage channels are unknown, not
    // zero).
    const presenceDefault = sample.tokenChannelsKnown !== false;
    const tokenChannelPresence = {
      input: validTokenChannel(sample.inputTokens) && (declaredPresence?.input ?? presenceDefault),
      output: validTokenChannel(sample.outputTokens) && (declaredPresence?.output ?? presenceDefault),
      cacheRead: validTokenChannel(sample.cacheReadTokens) && (declaredPresence?.cacheRead ?? presenceDefault),
      cacheWrite: validTokenChannel(sample.cacheWriteTokens) && (declaredPresence?.cacheWrite ?? presenceDefault),
    };
    const channelsKnown = sample.tokenChannelsKnown !== false
      && Object.values(tokenChannelPresence).every(Boolean);
    const inputTokens = validTokenChannel(sample.inputTokens) ? sample.inputTokens : 0;
    const outputTokens = validTokenChannel(sample.outputTokens) ? sample.outputTokens : 0;
    const cacheReadTokens = validTokenChannel(sample.cacheReadTokens) ? sample.cacheReadTokens : 0;
    const cacheWriteTokens = validTokenChannel(sample.cacheWriteTokens) ? sample.cacheWriteTokens : 0;
    const reportedCostUsd = validTokenChannel(sample.reportedCostUsd)
      ? sample.reportedCostUsd : undefined;
    sample = {
      ...sample,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens: validTokenChannel(sample.totalTokens)
        ? sample.totalTokens
        : channelsKnown ? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens : 0,
      tokenChannelsKnown: channelsKnown,
      tokenChannelPresence,
      ...(validTokenChannel(sample.providerTotalTokens)
        ? { providerTotalTokens: sample.providerTotalTokens }
        : { providerTotalTokens: undefined }),
      ...(reportedCostUsd !== undefined ? { reportedCostUsd } : { reportedCostUsd: undefined }),
    };
    const normalizedTimes = normalizeInvocationTimes(
      sample.startedAt,
      sample.endedAt,
      context.stableMissingTime ? new Date(0) : context.now(),
      sample.sourceId,
    );
    const { startedAt, endedAt } = normalizedTimes;
    const provider = sample.provider ?? identity.provider ?? 'unknown-provider';
    const model = sample.modelId ?? identity.modelId ?? 'unknown-model';
    const gap = sample.instrumentationGap === true || sample.provenance === 'unknown' || !channelsKnown;
    const pricing = gap || !channelsKnown
      || sample.provenance === 'unpriced' || sample.provenance === 'unknown'
      ? undefined : context.resolveInvocationPricing({
        facts: context.getPricingFacts(),
        modelId: model,
        provider,
        usage: sample,
      });
    const provenance = sample.provenance
      ?? (sample.reportedCostUsd !== undefined ? 'exact'
        : gap ? 'unknown'
          : pricing ? 'estimated' : 'unpriced');
    const base = {
      schemaVersion: 1 as const,
      invocationId,
      sourceId: sample.sourceId,
      sessionId: stableSessionId,
      sessionPath,
      branchId: context.branchId ?? null,
      parentOperationId: context.operationId ?? sample.parentOperationId ?? null,
      parentRunId: sample.parentRunId ?? context.runId,
      parentToolId: context.toolId ?? sample.parentToolId ?? null,
      kind,
      provider,
      model,
      provenance,
      evidenceOrigin: context.migration ? 'migration' as const : 'live' as const,
      startedAt,
      endedAt,
      outcome: context.outcome ?? sample.outcome ?? 'succeeded',
    };
    const costEvidence = {
      ...(sample.reportedCostUsd !== undefined ? { providerReportedCostUsd: sample.reportedCostUsd } : {}),
      ...(pricing ? { pricing } : {}),
    };
    const record: BillableInvocationRecord = gap ? {
      ...base,
      instrumentationGap: true,
      instrumentationGapReason: sample.instrumentationGapReason
        ?? 'This provider seam did not expose complete per-invocation usage.',
      ...(sample.tokenChannelPresence?.input ? { inputTokens: sample.inputTokens } : {}),
      ...(sample.tokenChannelPresence?.output ? { outputTokens: sample.outputTokens } : {}),
      ...(sample.tokenChannelPresence?.cacheRead ? { cacheReadTokens: sample.cacheReadTokens } : {}),
      ...(sample.tokenChannelPresence?.cacheWrite ? { cacheWriteTokens: sample.cacheWriteTokens } : {}),
      ...(sample.providerTotalTokens !== undefined ? { providerTotalTokens: sample.providerTotalTokens } : {}),
      ...costEvidence,
    } : {
      ...base,
      instrumentationGap: false,
      inputTokens: sample.inputTokens,
      outputTokens: sample.outputTokens,
      cacheReadTokens: sample.cacheReadTokens,
      cacheWriteTokens: sample.cacheWriteTokens,
      ...(sample.reasoningTokens !== undefined ? { reasoningTokens: sample.reasoningTokens } : {}),
      providerTotalTokens: sample.providerTotalTokens ?? sample.totalTokens,
      ...costEvidence,
    };
  return record;
}
