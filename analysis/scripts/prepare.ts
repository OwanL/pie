import {
  type RunSnapshot,
  type PreparedAnalyticsData,
  type PreparedBackendErrorRow,
  type PreparedFileExtensionRow,
  type PreparedHistoricalSessionSummary,
  type PreparedPruningEventRow,
  type PreparedPruningSignalRow,
  type PreparedRetryTimingRow,
  type PreparedToolResultPruningRow,
  type PreparedWarmBashRewriteRow,
  type PreparedWarmBashSummaryRow,
  type PreparedRunRow,
  type PreparedSessionReviewV2Row,
  type PreparedToolFailureRow,
  type PreparedToolResultIssueRow,
  type PreparedToolUsageRow,
  type PreparedTurnThroughputRow,
  type PreparedVerificationUsageRow,
  type PruningSourceDecision,
  type PruningSourceEvent,
  type ToolResultPruningSourceEvent,
  type WarmBashRewriteSourceEvent,
  type WarmBashSessionSummarySourceEvent,
  type SourceAnalyticsPayload,
  type ThinkingLevel,
  type ToolResultIssueKind,
  type VerificationCommandKind,
} from './contracts.ts';
import { existingHashPrefix, sessionPathHash } from './hash.ts';
import { loadModelPricingMap, estimateRunCostUsd, type TokenUsageForCost } from './pricing.ts';
import { loadModelFamilyMap, resolveModelFamily, resolveModelProvider } from './model-family.ts';
import { normalizeSessionPath } from './transcript-source.ts';
import { deriveReviewAttainment } from './review-analytics.ts';

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function aggregateSkillPruningPrepassTokens(run: RunSnapshot): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  durationMs: number | null;
} {
  const result = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, durationMs: null as number | null };
  for (const sample of run.auxiliaryLlmUsage ?? []) {
    if (sample.kind !== 'skill_pruning_prepass') continue;
    result.inputTokens += normalizeTokenCount(sample.inputTokens);
    result.outputTokens += normalizeTokenCount(sample.outputTokens);
    result.cacheReadTokens += normalizeTokenCount(sample.cacheReadTokens);
    result.cacheWriteTokens += normalizeTokenCount(sample.cacheWriteTokens);
    if (typeof sample.durationMs === 'number' && Number.isFinite(sample.durationMs) && sample.durationMs >= 0) {
      result.durationMs = (result.durationMs ?? 0) + sample.durationMs;
    }
  }
  return result;
}

function normalizeNullableText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

const TOKEN_USAGE_KEYS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
] as const;

function normalizeTokenCount(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function hasPositiveTokenUsage(usage: TokenUsageForCost): boolean {
  return TOKEN_USAGE_KEYS.some((key) => usage[key] > 0);
}

function addKnownCosts(left: number, right: number): number {
  return Math.round((left + right) * 1_000_000) / 1_000_000;
}

/**
 * Price canonical subagent token totals without treating attribution samples as additional usage.
 * Samples consume (and are clipped to) the canonical totals in source order; only the positive
 * remainder uses the parent model. This also makes duplicate/oversized samples unable to inflate
 * cost beyond the authoritative rollup.
 */
function estimateParentCostUsd(
  run: RunSnapshot,
  parentModelId: string | null,
  parentProvider: string | null,
  canonicalUsage: TokenUsageForCost,
  pricingMap: ReturnType<typeof loadModelPricingMap>,
): number | null {
  const remaining: TokenUsageForCost = { ...canonicalUsage };
  let totalCost = 0;
  for (const sample of run.turnThroughputSamples ?? []) {
    const attributed: TokenUsageForCost = {
      inputTokens: Math.min(remaining.inputTokens, normalizeTokenCount(sample.inputTokens)),
      outputTokens: Math.min(remaining.outputTokens, normalizeTokenCount(sample.outputTokens)),
      cacheReadTokens: Math.min(remaining.cacheReadTokens, normalizeTokenCount(sample.cacheReadTokens)),
      cacheWriteTokens: Math.min(remaining.cacheWriteTokens, normalizeTokenCount(sample.cacheWriteTokens)),
    };
    if (!hasPositiveTokenUsage(attributed)) continue;
    for (const key of TOKEN_USAGE_KEYS) remaining[key] = Math.max(0, remaining[key] - attributed[key]);
    const sampleUsage: TokenUsageForCost = {
      inputTokens: normalizeTokenCount(sample.inputTokens),
      outputTokens: normalizeTokenCount(sample.outputTokens),
      cacheReadTokens: normalizeTokenCount(sample.cacheReadTokens),
      cacheWriteTokens: normalizeTokenCount(sample.cacheWriteTokens),
    };
    const exactSample = TOKEN_USAGE_KEYS.every((key) => attributed[key] === sampleUsage[key]);
    if (exactSample && typeof sample.reportedCostUsd === 'number'
      && Number.isFinite(sample.reportedCostUsd) && sample.reportedCostUsd >= 0) {
      totalCost = addKnownCosts(totalCost, sample.reportedCostUsd);
      continue;
    }
    const cost = estimateRunCostUsd(
      normalizeNullableText(sample.modelId) ?? parentModelId,
      attributed,
      pricingMap,
      normalizeNullableText(sample.provider) ?? parentProvider,
    );
    if (cost === null) return null;
    totalCost = addKnownCosts(totalCost, cost);
  }
  if (hasPositiveTokenUsage(remaining)) {
    const cost = estimateRunCostUsd(parentModelId, remaining, pricingMap, parentProvider);
    if (cost === null) return null;
    totalCost = addKnownCosts(totalCost, cost);
  }
  return totalCost;
}

function estimateAuxiliaryCostUsd(
  run: RunSnapshot,
  parentModelId: string | null,
  parentProvider: string | null,
  pricingMap: ReturnType<typeof loadModelPricingMap>,
): number | null {
  let totalCost = 0;
  const seen = new Set<string>();
  for (const sample of run.auxiliaryLlmUsage ?? []) {
    if (sample.kind === 'subagent') continue;
    const sourceKey = `${sample.kind}:${sample.sourceId}`;
    if (seen.has(sourceKey)) continue;
    seen.add(sourceKey);
    if (typeof sample.reportedCostUsd === 'number'
      && Number.isFinite(sample.reportedCostUsd) && sample.reportedCostUsd >= 0) {
      totalCost = addKnownCosts(totalCost, sample.reportedCostUsd);
      continue;
    }
    const usage: TokenUsageForCost = {
      inputTokens: normalizeTokenCount(sample.inputTokens),
      outputTokens: normalizeTokenCount(sample.outputTokens),
      cacheReadTokens: normalizeTokenCount(sample.cacheReadTokens),
      cacheWriteTokens: normalizeTokenCount(sample.cacheWriteTokens),
    };
    if (!hasPositiveTokenUsage(usage)) continue;
    const cost = estimateRunCostUsd(
      normalizeNullableText(sample.modelId) ?? parentModelId,
      usage,
      pricingMap,
      normalizeNullableText(sample.provider) ?? parentProvider,
    );
    if (cost === null) return null;
    totalCost = addKnownCosts(totalCost, cost);
  }
  return totalCost;
}

function estimateSubagentCostUsd(
  run: RunSnapshot,
  parentModelId: string | null,
  parentProvider: string | null,
  canonicalUsage: TokenUsageForCost,
  pricingMap: ReturnType<typeof loadModelPricingMap>,
): number | null {
  if (run.toolUsage.subagentCallCount <= 0) {
    return 0;
  }
  if (!hasPositiveTokenUsage(canonicalUsage)) {
    return null;
  }

  const remaining: TokenUsageForCost = { ...canonicalUsage };
  const seenSourceIds = new Set<string>();
  let totalCost = 0;

  for (const sample of run.auxiliaryLlmUsage ?? []) {
    if (sample.kind !== 'subagent' || seenSourceIds.has(sample.sourceId)) {
      continue;
    }
    seenSourceIds.add(sample.sourceId);

    const attributed: TokenUsageForCost = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    for (const key of TOKEN_USAGE_KEYS) {
      attributed[key] = Math.min(normalizeTokenCount(sample[key]), remaining[key]);
      remaining[key] = Math.max(0, remaining[key] - attributed[key]);
    }
    if (!hasPositiveTokenUsage(attributed)) {
      continue;
    }

    const sampleUsage: TokenUsageForCost = {
      inputTokens: normalizeTokenCount(sample.inputTokens),
      outputTokens: normalizeTokenCount(sample.outputTokens),
      cacheReadTokens: normalizeTokenCount(sample.cacheReadTokens),
      cacheWriteTokens: normalizeTokenCount(sample.cacheWriteTokens),
    };
    const exactSample = TOKEN_USAGE_KEYS.every((key) => attributed[key] === sampleUsage[key]);
    const sampleCost = exactSample && typeof sample.reportedCostUsd === 'number'
      && Number.isFinite(sample.reportedCostUsd) && sample.reportedCostUsd >= 0
      ? sample.reportedCostUsd
      : estimateRunCostUsd(
          normalizeNullableText(sample.modelId),
          attributed,
          pricingMap,
          normalizeNullableText(sample.provider) ?? parentProvider,
        );
    if (sampleCost === null) {
      return null;
    }
    totalCost = addKnownCosts(totalCost, sampleCost);
  }

  if (hasPositiveTokenUsage(remaining)) {
    const remainderCost = estimateRunCostUsd(parentModelId, remaining, pricingMap, parentProvider);
    if (remainderCost === null) {
      return null;
    }
    totalCost = addKnownCosts(totalCost, remainderCost);
  }

  return totalCost;
}

function normalizeVerificationState(totalCount: number, failureCount: number): 'none' | 'passing' | 'failing' {
  if (totalCount <= 0) {
    return 'none';
  }
  return failureCount > 0 ? 'failing' : 'passing';
}

function normalizeThinkingLevel(value: string | null | undefined): ThinkingLevel | null {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case 'off':
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return normalized;
    case 'max':
      return 'xhigh';
    default:
      return null;
  }
}

function normalizeVerificationBucket(totalCount: number): '0' | '1' | '2-3' | '4+' {
  if (totalCount <= 0) {
    return '0';
  }
  if (totalCount === 1) {
    return '1';
  }
  if (totalCount <= 3) {
    return '2-3';
  }
  return '4+';
}

function toStartedDay(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function runStatusPriority(status: RunSnapshot['status']): number {
  return status === 'open' ? 0 : 1;
}

function updatedAtMs(run: RunSnapshot): number {
  const parsed = Date.parse(run.updatedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Deduplicate runs by runId, preferring finalized over open and newer over older.
 *
 * Priority rules for same runId:
 *   1. Closed over open
 *   2. Newer updatedAt over older updatedAt
 *   3. If both status and updatedAt are equal, prefer the later entry
 *
 * Note: if a run was closed and then reopened, the open version is discarded
 * in favor of the closed version, even though the open version has more recent data.
 */
function pickPreferredRun(left: RunSnapshot, right: RunSnapshot): RunSnapshot {
  const leftPriority = runStatusPriority(left.status);
  const rightPriority = runStatusPriority(right.status);
  if (leftPriority !== rightPriority) {
    return leftPriority > rightPriority ? left : right;
  }

  if (updatedAtMs(left) !== updatedAtMs(right)) {
    return updatedAtMs(left) >= updatedAtMs(right) ? left : right;
  }

  return right;
}

function dedupeRunsById(runs: RunSnapshot[]): RunSnapshot[] {
  const deduped = new Map<string, RunSnapshot>();
  for (const run of runs) {
    const existing = deduped.get(run.runId);
    deduped.set(run.runId, existing ? pickPreferredRun(existing, run) : run);
  }
  return [...deduped.values()];
}

function prepareRun(
  run: RunSnapshot,
  pricingMap: ReturnType<typeof loadModelPricingMap>,
  familyMap: ReturnType<typeof loadModelFamilyMap>,
  identity: { sessionId: string; identityFallback: boolean },
): PreparedRunRow {
  const verificationTotalCount = run.verification.totalCount;
  const verificationFailureCount = run.verification.failureCount;
  const startedDay = toStartedDay(run.startedAt);
  const normalizedModelId = normalizeNullableText(run.modelId);
  const runtimeProvider = normalizeNullableText(run.provider);
  const provider = runtimeProvider ?? resolveModelProvider(normalizedModelId, familyMap);
  const modelFamily = resolveModelFamily(
    normalizedModelId && provider && !normalizedModelId.startsWith(`${provider}/`)
      ? `${provider}/${normalizedModelId}`
      : normalizedModelId,
    familyMap,
  );

  const subagentInputTokens = normalizeTokenCount(run.toolUsage.subagentInputTokens);
  const subagentOutputTokens = normalizeTokenCount(run.toolUsage.subagentOutputTokens);
  const subagentCacheReadTokens = normalizeTokenCount(run.toolUsage.subagentCacheReadTokens);
  const subagentCacheWriteTokens = normalizeTokenCount(run.toolUsage.subagentCacheWriteTokens);
  const parentUsage: TokenUsageForCost = {
    inputTokens: normalizeTokenCount(run.inputTokens),
    outputTokens: normalizeTokenCount(run.outputTokens),
    cacheReadTokens: normalizeTokenCount(run.cacheReadTokens),
    cacheWriteTokens: normalizeTokenCount(run.cacheWriteTokens),
  };
  const parentUsageReported = (run.tokenReportedTurnCount ?? 0) > 0 || hasPositiveTokenUsage(parentUsage);
  const parentEstimatedCostUsd = parentUsageReported
    ? estimateParentCostUsd(run, normalizedModelId, provider, parentUsage, pricingMap)
    : null;
  const subagentEstimatedCostUsd = estimateSubagentCostUsd(run, normalizedModelId, provider, {
    inputTokens: subagentInputTokens,
    outputTokens: subagentOutputTokens,
    cacheReadTokens: subagentCacheReadTokens,
    cacheWriteTokens: subagentCacheWriteTokens,
  }, pricingMap);
  const auxiliaryEstimatedCostUsd = estimateAuxiliaryCostUsd(
    run,
    normalizedModelId,
    provider,
    pricingMap,
  );
  const totalEstimatedCostUsd = parentEstimatedCostUsd !== null
    && subagentEstimatedCostUsd !== null
    && auxiliaryEstimatedCostUsd !== null
    ? addKnownCosts(addKnownCosts(parentEstimatedCostUsd, subagentEstimatedCostUsd), auxiliaryEstimatedCostUsd)
    : null;

  const prepassTokens = aggregateSkillPruningPrepassTokens(run);

  return {
    runId: run.runId,
    taskGroupId: run.taskGroupId,
    sessionId: identity.sessionId,
    identityFallback: identity.identityFallback,
    sessionPathHash: sessionPathHash(run.sessionPath),
    status: run.status,
    startedAt: run.startedAt,
    startedDay,
    updatedAt: run.updatedAt,
    finalizedAt: run.finalizedAt ?? null,
    finalizationReason: run.finalizationReason ?? null,
    modelId: normalizedModelId,
    modelFamily,
    provider,
    thinkingLevel: normalizeThinkingLevel(run.thinkingLevel),
    mixedModelConfig: run.mixedModelConfig,
    mixedTreatmentConfig: run.mixedTreatmentConfig,
    treatmentChangeKinds: [...run.treatmentChangeKinds],
    experimentAssignment: normalizeNullableText(run.experimentAssignment),
    promptFamily: normalizeNullableText(run.analyticsFactors?.promptFamily),
    promptHashPrefix: existingHashPrefix(run.analyticsFactors?.promptHash),
    promptCapturedAt: normalizeNullableText(run.analyticsFactors?.promptCapturedAt),
    toolSetHashPrefix: existingHashPrefix(run.analyticsFactors?.toolSetHash),
    skillSetHashPrefix: existingHashPrefix(run.analyticsFactors?.skillSetHash),
    skillEntries: (run.analyticsFactors?.skills ?? []).map((s) => ({
      name: s.name,
      lastModifiedAt: s.lastModifiedAt,
    })),
    activeExtensions: run.analyticsFactors?.activeExtensions ?? [],
    selectedToolCount: run.analyticsFactors?.selectedToolIds.length ?? 0,
    skillCount: run.analyticsFactors?.skills.length ?? 0,
    contextFileCount: run.analyticsFactors?.contextFiles.length ?? 0,
    promptGuidelineCount: run.analyticsFactors?.promptGuidelineHashes.length ?? 0,
    initialUserMessageChars: typeof run.initialUserMessageChars === 'number'
      && Number.isFinite(run.initialUserMessageChars)
      ? Math.max(0, Math.trunc(run.initialUserMessageChars))
      : null,
    fsSubagentAlwaysParentModel: run.functionalSettings?.subagentAlwaysParentModel ?? null,
    fsPruningMode: run.functionalSettings?.pruningMode ?? null,
    fsPruningEnabled: run.functionalSettings ? run.functionalSettings.pruningMode !== 'off' : null,
    fsExtensionToggles: { ...(run.functionalSettings?.extensionToggles ?? {}) },
    fsToolResultPruningEnabled: run.functionalSettings?.toolResultPruningEnabled ?? null,
    fsToolResultPruningProfile: run.functionalSettings?.toolResultPruningProfile ?? null,
    sendCount: run.sendCount,
    assistantTurnCount: run.assistantTurnCount,
    assistantTurnDurationMs: run.assistantTurnDurationMs,
    busyDurationMs: run.busyDurationMs,
    busyPeriodCount: run.busyPeriodCount,
    interruptedCount: run.interruptedCount,
    messageEditCount: run.messageEditCount,
    truncatedAfterCount: run.truncatedAfterCount,
    backendErrorCount: run.backendErrorCodes.length,
    contextTokens: run.contextTokens,
    contextLimit: run.contextLimit,
    inputTokens: run.inputTokens ?? 0,
    outputTokens: run.outputTokens ?? 0,
    cacheReadTokens: run.cacheReadTokens ?? 0,
    cacheWriteTokens: run.cacheWriteTokens ?? 0,
    tokenReportedTurnCount: run.tokenReportedTurnCount ?? 0,
    filesystemPathRefCount: run.filesystemPathRefCount,
    imageInputCount: run.imageInputCount,
    imageInputBytes: run.imageInputBytes,
    unsupportedInputCount: run.unsupportedInputCount,
    inputKindsUsed: [...run.inputKindsUsed],
    toolCallCount: run.toolUsage.totalCount,
    toolDurationMs: run.toolUsage.totalDurationMs,
    criticalPathDurationMs: run.toolUsage.criticalPathDurationMs ?? null,
    timedToolCallCount: run.toolUsage.timedCallCount,
    toolFailureCount: run.toolUsage.failureCount,
    resultIssueCount: run.toolUsage.resultIssueCount,
    subagentCallCount: run.toolUsage.subagentCallCount,
    subagentTaskCount: run.toolUsage.subagentTaskCount,
    subagentAgentCount: run.toolUsage.subagentAgentNames.length,
    subagentInputTokens,
    subagentOutputTokens,
    subagentCacheReadTokens,
    subagentCacheWriteTokens,
    subagentEstimatedCostUsd,
    totalEstimatedCostUsd,
    compactionCount: run.compactionCount ?? 0,
    autoRetryCount: run.autoRetryCount ?? 0,
    skillPruningPrepassInputTokens: prepassTokens.inputTokens,
    skillPruningPrepassOutputTokens: prepassTokens.outputTokens,
    skillPruningPrepassCacheReadTokens: prepassTokens.cacheReadTokens,
    skillPruningPrepassCacheWriteTokens: prepassTokens.cacheWriteTokens,
    skillPruningPrepassDurationMs: prepassTokens.durationMs,
    lastTurnInputTokens: run.lastTurnUsage?.inputTokens ?? null,
    lastTurnOutputTokens: run.lastTurnUsage?.outputTokens ?? null,
    lastTurnCacheReadTokens: run.lastTurnUsage?.cacheReadTokens ?? null,
    lastTurnCacheWriteTokens: run.lastTurnUsage?.cacheWriteTokens ?? null,
    lastTurnTotalTokens: run.lastTurnUsage?.totalTokens ?? null,
    lastTurnReasoningTokens: run.lastTurnUsage?.reasoningTokens ?? null,
    verificationTotalCount,
    verificationFailureCount,
    verificationState: normalizeVerificationState(verificationTotalCount, verificationFailureCount),
    verificationCountBucket: normalizeVerificationBucket(verificationTotalCount),
    verificationCountsByKind: {
      test: run.verification.countsByKind.test ?? 0,
      build: run.verification.countsByKind.build ?? 0,
      lint: run.verification.countsByKind.lint ?? 0,
      typecheck: run.verification.countsByKind.typecheck ?? 0,
      format: run.verification.countsByKind.format ?? 0,
      other: run.verification.countsByKind.other ?? 0,
    },
    fileWriteCount: run.fileMutation.writeCount,
    fileEditCount: run.fileMutation.editCount,
    fileDeleteCount: run.fileMutation.deleteCount,
    fileRenameCount: run.fileMutation.renameCount,
    touchedFileCount: run.fileMutation.touchedFileCount,
    lineAdditions: run.fileMutation.lineAdditions,
    lineDeletions: run.fileMutation.lineDeletions,
    lineModifications: run.fileMutation.lineModifications,
    lineMutationTotal:
      run.fileMutation.lineAdditions + run.fileMutation.lineDeletions + run.fileMutation.lineModifications,
    tokenEfficiency: parentUsageReported
      && (run.fileMutation.lineAdditions + run.fileMutation.lineDeletions + run.fileMutation.lineModifications) > 0
      ? round3(parentUsage.outputTokens / (run.fileMutation.lineAdditions + run.fileMutation.lineDeletions + run.fileMutation.lineModifications))
      : null,
    contextUtilization: (run.contextTokens != null && run.contextLimit != null && run.contextLimit > 0)
      ? round3(run.contextTokens / run.contextLimit)
      : null,
    cacheHitRatio: ((run.cacheReadTokens ?? 0) + (run.inputTokens ?? 0)) > 0
      ? round3((run.cacheReadTokens ?? 0) / ((run.cacheReadTokens ?? 0) + (run.inputTokens ?? 0)))
      : null,
    editRevisitRate: (() => {
      // File churn: fraction of attributed EDIT ops that revisited an already-edited file.
      // 0 = every edit touched a fresh file (no churn); →1 = kept re-editing the same files.
      // Null when no edits were attributable to a path (legacy runs lack per-file data).
      const editCountsByFile = run.fileMutation.editCountsByFile ?? {};
      const counts = Object.values(editCountsByFile);
      const totalEditOps = counts.reduce((sum, count) => sum + count, 0);
      if (totalEditOps <= 0) return null;
      const distinctEditedFiles = counts.length;
      const revisitOps = totalEditOps - distinctEditedFiles;
      return round3(Math.max(0, revisitOps) / totalEditOps);
    })(),
    filesReviewedCount: (() => {
      // Distinct files reviewed (read) — breadth-of-investigation signal. Counts
      // distinct path hashes; legacy runs without per-file read data coerce to 0.
      const readCountsByFile = run.fileMutation.readCountsByFile ?? {};
      return Object.keys(readCountsByFile).length;
    })(),
    readRevisitRate: (() => {
      // Re-read churn: fraction of attributed READ ops that revisited an already-read file.
      // 0 = every read touched a fresh file (no churn); →1 = kept re-reading the same files.
      // Null when no reads were attributable to a path (legacy runs lack per-file data).
      const readCountsByFile = run.fileMutation.readCountsByFile ?? {};
      const counts = Object.values(readCountsByFile);
      const totalReadOps = counts.reduce((sum, count) => sum + count, 0);
      if (totalReadOps <= 0) return null;
      const distinctReadFiles = counts.length;
      const revisitOps = totalReadOps - distinctReadFiles;
      return round3(Math.max(0, revisitOps) / totalReadOps);
    })(),
    estimatedCostUsd: parentEstimatedCostUsd,
  };
}

function prepareToolUsage(run: RunSnapshot): PreparedToolUsageRow[] {
  const startedDay = toStartedDay(run.startedAt);
  // Terminal events from older hosts sometimes lost their name while the
  // corresponding tool.started count remained correctly attributed. Preserve
  // duration/failure-only sentinel rows instead of silently dropping them.
  const toolNames = new Set([
    ...Object.keys(run.toolUsage.countsByName),
    ...Object.keys(run.toolUsage.failureCountsByName),
    ...Object.keys(run.toolUsage.resultIssueCountsByName),
    ...Object.keys(run.toolUsage.durationMsByName),
  ]);
  return [...toolNames]
    .map((toolName) => {
      const callCount = run.toolUsage.countsByName[toolName] ?? 0;
      // Result-issue breakdown (verification failure / empty probe) now lives in
      // the result-issue rollup after the legacy remap; failureCountsByNameAndKind
      // is execution-only. failureCount is execution-only, so executionFailureCount
      // equals failureCount (the old failureCount − verification − probe subtraction
      // no longer applies).
      const resultIssueByKind = run.toolUsage.resultIssueCountsByNameAndKind[toolName];
      const verificationProjectFailureCount = resultIssueByKind?.verification_failure ?? 0;
      const probeFailureCount = resultIssueByKind?.probe_no_match ?? 0;
      const failureCount = run.toolUsage.failureCountsByName[toolName] ?? 0;
      const resultIssueCount = run.toolUsage.resultIssueCountsByName[toolName]
        ?? (verificationProjectFailureCount + probeFailureCount);
      const totalDurationMs = run.toolUsage.durationMsByName[toolName] ?? 0;
      const timedCallCount = run.toolUsage.timedCallCountsByName[toolName] ?? 0;
      const meanDurationMs = timedCallCount > 0 ? round3(totalDurationMs / timedCallCount) : null;
      return {
        runId: run.runId,
        toolName,
        callCount,
        failureCount,
        executionFailureCount: failureCount,
        verificationProjectFailureCount,
        probeFailureCount,
        resultIssueCount,
        totalDurationMs,
        timedCallCount,
        meanDurationMs,
        startedAt: run.startedAt,
        startedDay,
        modelId: normalizeNullableText(run.modelId),
        thinkingLevel: normalizeThinkingLevel(run.thinkingLevel),
        experimentAssignment: normalizeNullableText(run.experimentAssignment),
        mixedTreatmentConfig: run.mixedTreatmentConfig,
      };
    });
}

/**
 * When `failureCountsByNameAndKind` is absent (runs recorded before per-tool
 * classification was added), fall back to `failureCountsByKind` to preserve
 * classification at the aggregate level. Failures that cannot be attributed
 * to a specific tool are emitted as run-level rows (toolName = '(unattributed)').
 */
function prepareToolFailures(run: RunSnapshot): PreparedToolFailureRow[] {
  const startedDay = toStartedDay(run.startedAt);
  const rows: PreparedToolFailureRow[] = [];
  const sampleByKey = new Map<string, (typeof run.toolUsage.failureSamples)[number]>(
    run.toolUsage.failureSamples.map((sample) => [`${sample.toolName}\u0000${sample.failureKind}`, sample]),
  );

  const pushFailureRow = (toolName: string, failureKind: PreparedToolFailureRow['failureKind'], count: number): void => {
    if (count <= 0) {
      return;
    }
    const sample = sampleByKey.get(`${toolName}\u0000${failureKind}`);
    rows.push({
      runId: run.runId,
      toolName,
      failureKind,
      count,
      exitCode: sample?.exitCode ?? null,
      errorExcerpt: sample?.errorExcerpt || null,
      verificationKinds: sample?.verificationKinds ?? [],
      startedAt: run.startedAt,
      startedDay,
      modelId: normalizeNullableText(run.modelId),
      thinkingLevel: normalizeThinkingLevel(run.thinkingLevel),
      experimentAssignment: normalizeNullableText(run.experimentAssignment),
      mixedTreatmentConfig: run.mixedTreatmentConfig,
    });
  };

  const hasNameAndKindBreakdown = Object.keys(run.toolUsage.failureCountsByNameAndKind).length > 0;

  if (hasNameAndKindBreakdown) {
    // Per-tool classified breakdown is available — use it directly.
    const classifiedTools = new Set<string>();
    for (const [toolName, countsByKind] of Object.entries(run.toolUsage.failureCountsByNameAndKind)) {
      classifiedTools.add(toolName);
      let classifiedCount = 0;
      for (const [failureKind, count] of Object.entries(countsByKind)) {
        classifiedCount += count;
        pushFailureRow(toolName, failureKind as PreparedToolFailureRow['failureKind'], count);
      }
      const totalFailureCount = run.toolUsage.failureCountsByName[toolName] ?? 0;
      pushFailureRow(toolName, 'unknown', Math.max(0, totalFailureCount - classifiedCount));
    }

    for (const [toolName, totalFailureCount] of Object.entries(run.toolUsage.failureCountsByName)) {
      if (!classifiedTools.has(toolName)) {
        pushFailureRow(toolName, 'unknown', totalFailureCount);
      }
    }
  } else {
    // Per-tool breakdown unavailable (runs recorded before classification was added).
    // Fall back to aggregate failureCountsByKind to preserve failure-kind classification
    // at the run level. Assign to a sentinel tool name since we can't attribute per-tool.
    for (const [failureKind, count] of Object.entries(run.toolUsage.failureCountsByKind)) {
      pushFailureRow('(unattributed)', failureKind as PreparedToolFailureRow['failureKind'], count);
    }
    // Emit any remaining unclassified count once at the run level. Per-tool counts are
    // unavailable in this legacy branch, so attributing the full per-tool totals would
    // double-count failures already emitted by kind above.
    let classifiedTotal = 0;
    for (const count of Object.values(run.toolUsage.failureCountsByKind)) {
      classifiedTotal += count;
    }
    const unclassifiedTotal = run.toolUsage.failureCount - classifiedTotal;
    pushFailureRow('(unattributed)', 'unknown', unclassifiedTotal);
  }

  return rows;
}

function prepareToolResultIssues(run: RunSnapshot): PreparedToolResultIssueRow[] {
  const startedDay = toStartedDay(run.startedAt);
  const rows: PreparedToolResultIssueRow[] = [];
  const emittedKeys = new Set<string>();
  const sampleByKey = new Map<string, (typeof run.toolUsage.resultIssueSamples)[number]>(
    run.toolUsage.resultIssueSamples.map((sample) => [`${sample.toolName}\u0000${sample.resultIssueKind}`, sample]),
  );

  const pushRow = (toolName: string, resultIssueKind: ToolResultIssueKind, count: number): void => {
    const key = `${toolName}\u0000${resultIssueKind}`;
    if (emittedKeys.has(key)) return;
    emittedKeys.add(key);
    const sample = sampleByKey.get(key);
    rows.push({
      runId: run.runId,
      toolName,
      resultIssueKind,
      count,
      exitCode: sample?.exitCode ?? null,
      errorExcerpt: sample?.errorExcerpt || null,
      verificationKinds: sample?.verificationKinds ?? [],
      startedAt: run.startedAt,
      startedDay,
      modelId: normalizeNullableText(run.modelId),
      thinkingLevel: normalizeThinkingLevel(run.thinkingLevel),
      experimentAssignment: normalizeNullableText(run.experimentAssignment),
      mixedTreatmentConfig: run.mixedTreatmentConfig,
    });
  };

  const kinds: ToolResultIssueKind[] = ['verification_failure', 'probe_no_match'];
  for (const toolName of Object.keys(run.toolUsage.resultIssueCountsByNameAndKind)) {
    const countsByKind = run.toolUsage.resultIssueCountsByNameAndKind[toolName];
    if (!countsByKind) continue;
    for (const kind of kinds) {
      const count = countsByKind[kind] ?? 0;
      if (count <= 0) continue;
      pushRow(toolName, kind, count);
    }
  }

  // Backward compatibility: legacy snapshots may carry result-issue samples
  // without a per-tool per-kind breakdown. Emit a count-1 row for each unique
  // sample tool+kind so the detail is not lost.
  for (const sample of run.toolUsage.resultIssueSamples) {
    const key = `${sample.toolName}\u0000${sample.resultIssueKind}`;
    if (!emittedKeys.has(key)) {
      pushRow(sample.toolName, sample.resultIssueKind, 1);
    }
  }

  return rows;
}

function prepareVerificationUsage(run: RunSnapshot): PreparedVerificationUsageRow[] {
  const startedDay = toStartedDay(run.startedAt);
  const kinds: VerificationCommandKind[] = ['test', 'build', 'lint', 'typecheck', 'format', 'other'];
  return kinds
    .map((kind) => [kind, run.verification.countsByKind[kind] ?? 0] as const)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => ({
      runId: run.runId,
      kind,
      count,
      runHadAnyFailure: run.verification.failureCount > 0,
      startedAt: run.startedAt,
      startedDay,
      modelId: normalizeNullableText(run.modelId),
      thinkingLevel: normalizeThinkingLevel(run.thinkingLevel),
      experimentAssignment: normalizeNullableText(run.experimentAssignment),
      mixedTreatmentConfig: run.mixedTreatmentConfig,
    }));
}

function prepareBackendErrors(run: RunSnapshot): PreparedBackendErrorRow[] {
  if (run.backendErrorCodes.length === 0) {
    return [];
  }

  const counts = new Map<string, number>();
  for (const errorCode of run.backendErrorCodes) {
    const trimmed = errorCode.trim();
    if (!trimmed) {
      continue;
    }
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
  }

  const startedDay = toStartedDay(run.startedAt);
  return [...counts.entries()].map(([errorCode, count]) => ({
    runId: run.runId,
    errorCode,
    count,
    startedAt: run.startedAt,
    startedDay,
    modelId: normalizeNullableText(run.modelId),
    thinkingLevel: normalizeThinkingLevel(run.thinkingLevel),
    experimentAssignment: normalizeNullableText(run.experimentAssignment),
  }));
}

function prepareFileExtensions(run: RunSnapshot): PreparedFileExtensionRow[] {
  const exts = run.fileExtensions;
  if (!exts) {
    return [];
  }

  const allExtensions = new Set<string>([
    ...Object.keys(exts.readCountsByExtension ?? {}),
    ...Object.keys(exts.writeCountsByExtension ?? {}),
    ...Object.keys(exts.editCountsByExtension ?? {}),
  ]);

  if (allExtensions.size === 0) {
    return [];
  }

  const startedDay = toStartedDay(run.startedAt);
  return [...allExtensions].map((extension) => {
    const readCount = exts.readCountsByExtension?.[extension] ?? 0;
    const writeCount = exts.writeCountsByExtension?.[extension] ?? 0;
    const editCount = exts.editCountsByExtension?.[extension] ?? 0;
    return {
      runId: run.runId,
      extension,
      readCount,
      writeCount,
      editCount,
      totalCount: readCount + writeCount + editCount,
      startedAt: run.startedAt,
      startedDay,
      modelId: normalizeNullableText(run.modelId),
      thinkingLevel: normalizeThinkingLevel(run.thinkingLevel),
      experimentAssignment: normalizeNullableText(run.experimentAssignment),
      mixedTreatmentConfig: run.mixedTreatmentConfig,
    };
  });
}

function preparePruningEvents(
  pruningDecisions: PruningSourceDecision[],
  runs: PreparedRunRow[],
): PreparedPruningEventRow[] {
  const runBySessionHash = new Map(runs.map((run) => [run.sessionPathHash, run]));
  const runBySessionId = new Map(runs.map((run) => [run.sessionId, run]));

  return pruningDecisions.map((d) => {
    const pathHash = sessionPathHash(d.sessionPath || d.sessionId);
    const matchedRun = runBySessionId.get(d.sessionId) ?? runBySessionHash.get(pathHash);
    const joinedPathHash = matchedRun?.sessionPathHash ?? pathHash;
    const runId = matchedRun?.runId ?? `pruning-${joinedPathHash}`;

    const skillKept = d.included.length;
    const skillPruned = d.excluded.length;
    const skillTokensSaved = d.originalBlockTokens - d.skillBlockTokens;
    const toolKept = d.toolIncluded?.length ?? 0;
    const toolPruned = d.toolExcluded?.length ?? 0;
    const toolTokensSaved = (d.originalToolBlockTokens ?? 0) - (d.toolBlockTokens ?? 0);

    return {
      runId,
      sessionPathHash: joinedPathHash,
      timestamp: d.timestamp,
      startedDay: d.timestamp.slice(0, 10),
      pruningMode: d.mode,
      query: d.query,
      llmModel: d.llmModel,
      llmThinkingLevel: d.llmThinkingLevel,
      llmLatencyMs: d.llmLatencyMs,
      skillCountKept: skillKept,
      skillCountPruned: skillPruned,
      skillCountTotal: skillKept + skillPruned,
      skillTokensSaved: Math.max(0, skillTokensSaved),
      skillTokensOriginal: d.originalBlockTokens,
      toolCountKept: toolKept,
      toolCountPruned: toolPruned,
      toolCountTotal: toolKept + toolPruned,
      toolTokensSaved: Math.max(0, toolTokensSaved),
      toolTokensOriginal: d.originalToolBlockTokens ?? 0,
      keptSkillNames: d.included,
      prunedSkillNames: d.excluded,
      keptToolNames: d.toolIncluded ?? [],
      prunedToolNames: d.toolExcluded ?? [],
      prepassInputTokens: d.prepassInputTokens,
      prepassOutputTokens: d.prepassOutputTokens,
      prepassCacheReadTokens: d.prepassCacheReadTokens,
      prepassCacheWriteTokens: d.prepassCacheWriteTokens,
      prepassInputEstimateTokens: d.prepassInputEstimateTokens,
      codeVersion: d.codeVersion,
    };
  });
}

function preparePruningSignals(
  pruningEvents: PruningSourceEvent[],
  runs: PreparedRunRow[],
): PreparedPruningSignalRow[] {
  const runBySessionHash = new Map(runs.map((run) => [run.sessionPathHash, run]));
  const runBySessionId = new Map(runs.map((run) => [run.sessionId, run]));

  return pruningEvents.map((e) => {
    const fallbackHash = sessionPathHash(e.sessionId);
    const matchedRun = runBySessionId.get(e.sessionId) ?? runBySessionHash.get(fallbackHash);
    const joinedPathHash = matchedRun?.sessionPathHash ?? fallbackHash;
    const runId = matchedRun?.runId ?? `pruning-${joinedPathHash}`;
    return {
      runId,
      sessionPathHash: joinedPathHash,
      timestamp: e.timestamp,
      startedDay: e.timestamp.slice(0, 10),
      event: e.event,
      skillName: e.skillName ?? null,
      toolName: e.toolName ?? null,
    };
  });
}

function prepareToolResultPruning(
  events: ToolResultPruningSourceEvent[],
  runs: PreparedRunRow[],
): PreparedToolResultPruningRow[] {
  const runBySessionHash = new Map(runs.map((run) => [run.sessionPathHash, run]));
  const runBySessionId = new Map(runs.map((run) => [run.sessionId, run]));
  return events.map((e) => {
    const fallbackHash = sessionPathHash(e.sessionId);
    const matchedRun = runBySessionId.get(e.sessionId) ?? runBySessionHash.get(fallbackHash);
    const joinedPathHash = matchedRun?.sessionPathHash ?? fallbackHash;
    const runId = matchedRun?.runId ?? `pruning-${joinedPathHash}`;
    return {
      runId,
      sessionPathHash: joinedPathHash,
      timestamp: e.timestamp,
      startedDay: e.timestamp.slice(0, 10),
      toolName: e.toolName,
      rules: e.rules,
      beforeTokens: e.beforeTokens,
      afterTokens: e.afterTokens,
      tokensSaved: e.tokensSaved,
    };
  });
}

/** Join warm-bash auto-prune rewrite events to runs by sessionPathHash (same
 *  mechanism as pruning signals — the event carries sessionId, which hashes to
 *  the run's sessionPathHash). One row per transparent command rewrite. */
function prepareWarmBashRewrites(
  events: WarmBashRewriteSourceEvent[],
  runs: PreparedRunRow[],
): PreparedWarmBashRewriteRow[] {
  const runBySessionHash = new Map(runs.map((run) => [run.sessionPathHash, run]));
  const runBySessionId = new Map(runs.map((run) => [run.sessionId, run]));
  return events.map((e) => {
    const fallbackHash = sessionPathHash(e.sessionId);
    const matchedRun = runBySessionId.get(e.sessionId) ?? runBySessionHash.get(fallbackHash);
    const joinedPathHash = matchedRun?.sessionPathHash ?? fallbackHash;
    const runId = matchedRun?.runId ?? `warm-bash-${joinedPathHash}`;
    return {
      runId,
      sessionPathHash: joinedPathHash,
      timestamp: e.timestamp,
      startedDay: e.timestamp.slice(0, 10),
      before: e.before,
      after: e.after,
    };
  });
}

/** Join warm-bash per-session routing-counter summaries to runs by sessionPathHash.
 *  Counters are session-cumulative (one row per session that used bash). */
function prepareWarmBashSummaries(
  events: WarmBashSessionSummarySourceEvent[],
  runs: PreparedRunRow[],
): PreparedWarmBashSummaryRow[] {
  const runBySessionHash = new Map(runs.map((run) => [run.sessionPathHash, run]));
  const runBySessionId = new Map(runs.map((run) => [run.sessionId, run]));
  return events.map((e) => {
    const fallbackHash = sessionPathHash(e.sessionId);
    const matchedRun = runBySessionId.get(e.sessionId) ?? runBySessionHash.get(fallbackHash);
    const joinedPathHash = matchedRun?.sessionPathHash ?? fallbackHash;
    const runId = matchedRun?.runId ?? `warm-bash-${joinedPathHash}`;
    return {
      runId,
      sessionPathHash: joinedPathHash,
      timestamp: e.timestamp,
      startedDay: e.timestamp.slice(0, 10),
      fastPath: e.fastPath,
      warm: e.warm,
      fallback: e.fallback,
      poolSize: e.poolSize,
      warmupFailures: e.warmupFailures,
      autoPruneEnabled: e.autoPruneEnabled,
      fastPathEnabled: e.fastPathEnabled,
      gnuGrep: e.gnuGrep,
    };
  });
}

function roundThroughput(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Flatten per-turn throughput samples into analysis rows. `modelId` is attributed
 * from `sample.modelId` when present (per-sample provider attribution, e.g. a
 * sub-agent turn or a mid-run model swap), falling back to the parent run's
 * `modelId`. `tokensPerSecond` is precomputed for completed turns with reported
 * output tokens and positive generation time (null otherwise so errored /
 * tokenless turns stay countable without polluting the throughput distribution).
 */
function prepareTurnThroughput(
  run: RunSnapshot,
  familyMap: ReturnType<typeof loadModelFamilyMap>,
): PreparedTurnThroughputRow[] {
  if (!run.turnThroughputSamples || run.turnThroughputSamples.length === 0) {
    return [];
  }
  const runModelId = normalizeNullableText(run.modelId);
  const thinkingLevel = normalizeThinkingLevel(run.thinkingLevel);
  const experimentAssignment = normalizeNullableText(run.experimentAssignment);

  return run.turnThroughputSamples.map((sample) => {
    const modelId = normalizeNullableText(sample.modelId) ?? runModelId;
    const provider = normalizeNullableText(sample.provider) ?? run.provider ?? null;
    const modelFamily = resolveModelFamily(modelId, familyMap);
    const tokensPerSecond =
      sample.status === 'completed'
      && sample.outputTokens > 0
      && sample.generationDurationMs > 0
        ? roundThroughput((sample.outputTokens / sample.generationDurationMs) * 1000)
        : null;
    return {
      runId: run.runId,
      endedAt: sample.endedAt,
      startedDay: toStartedDay(sample.endedAt),
      modelId,
      provider,
      modelFamily,
      thinkingLevel,
      experimentAssignment,
      outputTokens: sample.outputTokens,
      generationDurationMs: sample.generationDurationMs,
      concurrentBusySessions: sample.concurrentBusySessions,
      status: sample.status,
      tokensPerSecond,
      turnLatencyMs: sample.turnLatencyMs,
      overheadMs: sample.overheadMs,
      providerLatencyMs: sample.providerLatencyMs,
      providerQueueMs: sample.providerQueueMs ?? null,
      providerQueueAttemptCount: sample.providerQueueAttemptCount ?? 0,
      inputTokens: sample.inputTokens ?? 0,
      cacheReadTokens: sample.cacheReadTokens ?? 0,
      cacheWriteTokens: sample.cacheWriteTokens ?? 0,
      contextTokens: sample.contextTokens ?? null,
    };
  });
}

function prepareRetryTiming(
  run: RunSnapshot,
  familyMap: ReturnType<typeof loadModelFamilyMap>,
): PreparedRetryTimingRow[] {
  const modelId = normalizeNullableText(run.modelId);
  const provider = normalizeNullableText(run.provider);
  return (run.retryTimingSamples ?? []).map((sample) => ({
    runId: run.runId,
    sourceId: sample.sourceId,
    occurredAt: sample.occurredAt,
    startedDay: toStartedDay(sample.occurredAt),
    attempt: sample.attempt,
    scheduledDelayMs: sample.scheduledDelayMs,
    measuredDelayMs: sample.measuredDelayMs,
    durationMs: sample.durationMs,
    modelId,
    modelFamily: resolveModelFamily(modelId, familyMap),
    provider,
    thinkingLevel: normalizeThinkingLevel(run.thinkingLevel),
    experimentAssignment: normalizeNullableText(run.experimentAssignment),
  }));
}

export function prepareSourceAnalytics(source: SourceAnalyticsPayload): PreparedAnalyticsData {
  const dedupedRuns = dedupeRunsById([...source.completedRuns, ...source.openRuns]);
  const pricingMap = loadModelPricingMap();
  const familyMap = loadModelFamilyMap();
  const stableIdByPath = new Map((source.historicalSessions ?? []).map((summary) => [normalizeSessionPath(summary.normalizedSessionPath), summary.sessionId]));
  for (const review of source.sessionReviewsV2 ?? []) {
    if (!review.identityFallback) stableIdByPath.set(normalizeSessionPath(review.sessionPathAtReview), review.sessionId);
  }
  const runs = dedupedRuns.map((run) => {
    const headerSessionId = run.sessionId?.trim();
    const stableId = headerSessionId || stableIdByPath.get(normalizeSessionPath(run.sessionPath));
    return prepareRun(run, pricingMap, familyMap, stableId
      ? { sessionId: stableId, identityFallback: false }
      : { sessionId: sessionPathHash(run.sessionPath), identityFallback: true });
  });
  const canonicalRunBySessionPath = new Map<string, PreparedRunRow>();
  const canonicalRunBySessionId = new Map<string, PreparedRunRow>();
  dedupedRuns.forEach((run, index) => {
    canonicalRunBySessionPath.set(normalizeSessionPath(run.sessionPath), runs[index]!);
    if (!runs[index]!.identityFallback) canonicalRunBySessionId.set(runs[index]!.sessionId, runs[index]!);
  });
  const historicalBySessionId = new Map<string, PreparedHistoricalSessionSummary>();
  for (const summary of source.historicalSessions ?? []) {
    const normalizedPath = normalizeSessionPath(summary.normalizedSessionPath);
    const canonicalRun = canonicalRunBySessionId.get(summary.sessionId) ?? canonicalRunBySessionPath.get(normalizedPath);
    const { normalizedSessionPath: _privatePath, ...safeSummary } = summary;
    const prepared: PreparedHistoricalSessionSummary = {
      ...safeSummary,
      attributions: safeSummary.attributions.map((attribution) => ({
        ...attribution,
        modelFamily: resolveModelFamily(attribution.modelId, familyMap) ?? '(unknown)',
      })),
      sessionPathHash: canonicalRun?.sessionPathHash ?? sessionPathHash(normalizedPath),
      matchedCanonical: canonicalRun !== undefined,
      transcriptOnly: canonicalRun === undefined,
    };
    const existing = historicalBySessionId.get(summary.sessionId);
    if (existing) {
      prepared.sourceProvenance = [...new Set([...existing.sourceProvenance, ...prepared.sourceProvenance])].sort();
    }
    historicalBySessionId.set(summary.sessionId, prepared);
  }
  const historicalSessions = [...historicalBySessionId.values()];
  const toolUsage: PreparedToolUsageRow[] = [];
  const toolFailures: PreparedToolFailureRow[] = [];
  const toolResultIssues: PreparedToolResultIssueRow[] = [];
  const verificationUsage: PreparedVerificationUsageRow[] = [];
  const backendErrors: PreparedBackendErrorRow[] = [];
  const fileExtensions: PreparedFileExtensionRow[] = [];
  const turnThroughput: PreparedTurnThroughputRow[] = [];
  const retryTiming: PreparedRetryTimingRow[] = [];

  for (const run of dedupedRuns) {
    toolUsage.push(...prepareToolUsage(run));
    toolFailures.push(...prepareToolFailures(run));
    toolResultIssues.push(...prepareToolResultIssues(run));
    verificationUsage.push(...prepareVerificationUsage(run));
    backendErrors.push(...prepareBackendErrors(run));
    fileExtensions.push(...prepareFileExtensions(run));
    turnThroughput.push(...prepareTurnThroughput(run, familyMap));
    retryTiming.push(...prepareRetryTiming(run, familyMap));
  }

  const pruningEvents = preparePruningEvents(source.pruningDecisions ?? [], runs);
  const pruningSignals = preparePruningSignals(source.pruningEvents ?? [], runs);
  const toolResultPruning = prepareToolResultPruning(source.toolResultPruningEvents ?? [], runs);
  const warmBashRewrites = prepareWarmBashRewrites(source.warmBashRewrites ?? [], runs);
  const warmBashSummaries = prepareWarmBashSummaries(source.warmBashSummaries ?? [], runs);
  const runsBySessionId = new Map<string, PreparedRunRow[]>();
  for (const run of runs) {
    const matches = runsBySessionId.get(run.sessionId) ?? [];
    matches.push(run);
    runsBySessionId.set(run.sessionId, matches);
  }
  const sessionReviewsV2: PreparedSessionReviewV2Row[] = (source.sessionReviewsV2 ?? []).map((review) => {
    const matchedRuns = runsBySessionId.get(review.sessionId) ?? [];
    const attainment = deriveReviewAttainment(review.ledger);
    const activeCriteria = review.ledger.filter((criterion) => criterion.status !== 'superseded');
    const assessable = activeCriteria.filter((criterion) => criterion.status !== 'not_assessable').length;
    const externalBlocked = activeCriteria.filter((criterion) => criterion.status === 'blocked' && criterion.reason === 'external_blocker').length;
    return {
      cohort: 'v2_production', schemaVersion: review.schemaVersion, reviewId: review.reviewId,
      sessionId: review.sessionId, identityFallback: review.identityFallback, rubricVersion: review.rubricVersion,
      indexVersion: 'v1', reviewedAt: review.reviewedAt, startedDay: review.reviewedAt.slice(0, 10),
      joinKey: matchedRuns.length ? (review.identityFallback ? 'path_fallback' : 'session_id') : 'unmatched',
      runIds: matchedRuns.map((run) => run.runId).sort(),
      modelFamilies: [...new Set(matchedRuns.map((run) => run.modelFamily).filter((family): family is string => family !== null))].sort(),
      criteria: review.ledger.map((criterion) => ({
        criterionId: criterion.criterionId, importance: criterion.importance, origin: criterion.origin,
        activity: criterion.taxonomy.activity, surfaces: criterion.taxonomy.surface,
        evidenceModes: criterion.taxonomy.evidenceMode, status: criterion.status, reason: criterion.reason,
      })),
      attainment,
      criterionCoverage: activeCriteria.length ? assessable / activeCriteria.length : null,
      externalBlockerRate: activeCriteria.length ? externalBlocked / activeCriteria.length : null,
      process: review.process, evidence: review.evidence,
      humanCheckStatus: review.humanCheckStatus, confidence: review.confidence,
      disagreement: review.disagreement, reviewers: review.reviewers,
      diversityAchieved: review.diversityAchieved, blindingApplied: review.blindingApplied,
    };
  });
  return {
    sourceSchemaVersion: source.schemaVersion,
    sourceExportedAt: source.exportedAt,
    sourceWorkspaceKey: source.workspaceKey,
    runs,
    toolUsage,
    toolFailures,
    toolResultIssues,
    verificationUsage,
    backendErrors,
    fileExtensions,
    turnThroughput,
    retryTiming,
    pruningEvents,
    pruningSignals,
    toolResultPruning,
    warmBashRewrites,
    warmBashSummaries,
    sessionReviewsV2,
    sessionReviewV2Diagnostics: source.sessionReviewV2Diagnostics,
    historicalSessions,
  };
}
