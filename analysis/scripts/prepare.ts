import {
  type RunOutcome,
  type RunSnapshot,
  type AgentReviewSourceEvent,
  type PreparedAnalyticsData,
  type PreparedAgentReviewRow,
  type PreparedBackendErrorRow,
  type PreparedFileExtensionRow,
  type PreparedHistoricalSessionSummary,
  type PreparedPruningEventRow,
  type PreparedPruningSignalRow,
  type PreparedToolResultPruningRow,
  type PreparedWarmBashRewriteRow,
  type PreparedWarmBashSummaryRow,
  type PreparedRunRow,
  type PreparedToolFailureRow,
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
  type VerificationCommandKind,
} from './contracts.ts';
import { existingHashPrefix, hashToPrefix } from './hash.ts';
import { loadModelPricingMap, estimateRunCostUsd, type TokenUsageForCost } from './pricing.ts';
import { loadModelFamilyMap, resolveModelFamily, resolveModelProvider } from './model-family.ts';
import { normalizeSessionPath } from './transcript-source.ts';

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
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
function estimateSubagentCostUsd(
  run: RunSnapshot,
  parentModelId: string | null,
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

    const sampleCost = estimateRunCostUsd(normalizeNullableText(sample.modelId), attributed, pricingMap);
    if (sampleCost === null) {
      return null;
    }
    totalCost = addKnownCosts(totalCost, sampleCost);
  }

  if (hasPositiveTokenUsage(remaining)) {
    const remainderCost = estimateRunCostUsd(parentModelId, remaining, pricingMap);
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

function getRunOutcome(run: RunSnapshot, outcomesByRunId: Map<string, RunOutcome>): RunOutcome | null {
  return run.outcome ?? outcomesByRunId.get(run.runId) ?? null;
}

function outcomeFromAgentReview(review: AgentReviewSourceEvent): RunOutcome | null {
  if (!review.done || !Number.isInteger(review.rating) || review.rating < 1 || review.rating > 5) {
    return null;
  }
  const resolution = review.completion === 'fully'
    ? 'resolved'
    : review.completion === 'partial'
      ? 'partially_resolved'
      : 'unresolved';
  return { resolution, satisfaction: review.rating, source: 'agent' };
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
 *   1. Closed (scored / closed_unscored) over open
 *   2. Newer updatedAt over older updatedAt
 *   3. If both status and updatedAt are equal, prefer the later entry
 *
 * Note: if a run was closed and then reopened, the open version is discarded
 * in favor of the closed version, even though the open version has more recent data.
 * The closed version carries the outcome (satisfaction/resolution) which is preferred
 * for analytics purposes.
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
  outcomesByRunId: Map<string, RunOutcome>,
  pricingMap: ReturnType<typeof loadModelPricingMap>,
  familyMap: ReturnType<typeof loadModelFamilyMap>,
): PreparedRunRow {
  const outcome = getRunOutcome(run, outcomesByRunId);
  const verificationTotalCount = run.verification.totalCount;
  const verificationFailureCount = run.verification.failureCount;
  const startedDay = toStartedDay(run.startedAt);
  const normalizedModelId = normalizeNullableText(run.modelId);
  const modelFamily = resolveModelFamily(normalizedModelId, familyMap);
  const provider = resolveModelProvider(normalizedModelId, familyMap);

  const dims = ['precision', 'creativity', 'reasoning', 'thoroughness'] as const;
  function meanForDim(dim: typeof dims[number]): number | null {
    const s = run.toolUsage.subagentTaskScores[dim];
    return s.count > 0 ? s.sum / s.count : null;
  }
  function maxForDim(dim: typeof dims[number]): number | null {
    const s = run.toolUsage.subagentTaskScores[dim];
    return s.count > 0 ? s.max : null;
  }

  const dimMeans = dims.map((d) => meanForDim(d)).filter((v): v is number => v !== null);
  const compositeMean: number | null = dimMeans.length > 0
    ? dimMeans.reduce((a, b) => a + b, 0) / dimMeans.length
    : null;

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
    ? estimateRunCostUsd(normalizedModelId, parentUsage, pricingMap)
    : null;
  const subagentEstimatedCostUsd = estimateSubagentCostUsd(run, normalizedModelId, {
    inputTokens: subagentInputTokens,
    outputTokens: subagentOutputTokens,
    cacheReadTokens: subagentCacheReadTokens,
    cacheWriteTokens: subagentCacheWriteTokens,
  }, pricingMap);
  const totalEstimatedCostUsd = parentEstimatedCostUsd !== null && subagentEstimatedCostUsd !== null
    ? addKnownCosts(parentEstimatedCostUsd, subagentEstimatedCostUsd)
    : null;

  const scored = run.scored || outcome !== null;
  return {
    runId: run.runId,
    taskGroupId: run.taskGroupId,
    sessionPathHash: hashToPrefix(run.sessionPath, 16),
    status: outcome ? 'scored' : run.status,
    scored,
    startedAt: run.startedAt,
    startedDay,
    updatedAt: run.updatedAt,
    finalizedAt: run.finalizedAt ?? null,
    finalizationReason: outcome ? 'scored' : (run.finalizationReason ?? null),
    resolution: outcome?.resolution ?? null,
    satisfaction: outcome?.satisfaction ?? null,
    outcomeSource: outcome ? (outcome.source ?? 'user') : null,
    modelId: normalizedModelId,
    modelFamily,
    provider,
    thinkingLevel: normalizeThinkingLevel(run.thinkingLevel),
    mixedModelConfig: run.mixedModelConfig,
    mixedTreatmentConfig: run.mixedTreatmentConfig,
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
    timedToolCallCount: run.toolUsage.timedCallCount,
    toolFailureCount: run.toolUsage.failureCount,
    resultIssueCount: run.toolUsage.resultIssueCount,
    subagentCallCount: run.toolUsage.subagentCallCount,
    subagentTaskCount: run.toolUsage.subagentTaskCount,
    subagentAgentCount: run.toolUsage.subagentAgentNames.length,
    subagentScoredTaskCount: run.toolUsage.subagentScoredTaskCount,
    subagentMeanPrecision: meanForDim('precision'),
    subagentMeanCreativity: meanForDim('creativity'),
    subagentMeanReasoning: meanForDim('reasoning'),
    subagentMeanThoroughness: meanForDim('thoroughness'),
    subagentMaxPrecision: maxForDim('precision'),
    subagentMaxCreativity: maxForDim('creativity'),
    subagentMaxReasoning: maxForDim('reasoning'),
    subagentMaxThoroughness: maxForDim('thoroughness'),
    subagentCompositeMean: compositeMean,
    subagentInputTokens,
    subagentOutputTokens,
    subagentCacheReadTokens,
    subagentCacheWriteTokens,
    subagentEstimatedCostUsd,
    totalEstimatedCostUsd,
    compactionCount: run.compactionCount ?? 0,
    autoRetryCount: run.autoRetryCount ?? 0,
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
    firstAttemptSuccess: run.interruptedCount === 0 && run.messageEditCount === 0 && run.truncatedAfterCount === 0 && (outcome?.resolution === 'resolved'),
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

function prepareToolUsage(run: RunSnapshot, outcome: RunOutcome | null): PreparedToolUsageRow[] {
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
      const meanDurationMs = callCount > 0 ? round3(totalDurationMs / callCount) : null;
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
        meanDurationMs,
        startedAt: run.startedAt,
        startedDay,
        modelId: normalizeNullableText(run.modelId),
        thinkingLevel: normalizeThinkingLevel(run.thinkingLevel),
        experimentAssignment: normalizeNullableText(run.experimentAssignment),
        mixedTreatmentConfig: run.mixedTreatmentConfig,
        scored: run.scored || outcome !== null,
        satisfaction: outcome?.satisfaction ?? null,
        resolution: outcome?.resolution ?? null,
      };
    });
}

/**
 * When `failureCountsByNameAndKind` is absent (runs recorded before per-tool
 * classification was added), fall back to `failureCountsByKind` to preserve
 * classification at the aggregate level. Failures that cannot be attributed
 * to a specific tool are emitted as run-level rows (toolName = '(unattributed)').
 */
function prepareToolFailures(run: RunSnapshot, outcome: RunOutcome | null): PreparedToolFailureRow[] {
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
      scored: run.scored || outcome !== null,
      satisfaction: outcome?.satisfaction ?? null,
      resolution: outcome?.resolution ?? null,
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

function prepareVerificationUsage(run: RunSnapshot, outcome: RunOutcome | null): PreparedVerificationUsageRow[] {
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
      scored: run.scored || outcome !== null,
      satisfaction: outcome?.satisfaction ?? null,
      resolution: outcome?.resolution ?? null,
    }));
}

function prepareBackendErrors(run: RunSnapshot, outcome: RunOutcome | null): PreparedBackendErrorRow[] {
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
    scored: run.scored || outcome !== null,
    satisfaction: outcome?.satisfaction ?? null,
    resolution: outcome?.resolution ?? null,
  }));
}

function prepareFileExtensions(run: RunSnapshot, outcome: RunOutcome | null): PreparedFileExtensionRow[] {
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
      scored: run.scored || outcome !== null,
      satisfaction: outcome?.satisfaction ?? null,
      resolution: outcome?.resolution ?? null,
    };
  });
}

function preparePruningEvents(
  pruningDecisions: PruningSourceDecision[],
  runs: PreparedRunRow[],
): PreparedPruningEventRow[] {
  const runBySessionHash = new Map<string, PreparedRunRow>();
  for (const run of runs) {
    runBySessionHash.set(run.sessionPathHash, run);
  }

  return pruningDecisions.map((d) => {
    const sessionPathHash = hashToPrefix(d.sessionPath || d.sessionId, 16);
    const matchedRun = runBySessionHash.get(sessionPathHash);
    const runId = matchedRun?.runId ?? `pruning-${sessionPathHash}`;

    const skillKept = d.included.length;
    const skillPruned = d.excluded.length;
    const skillTokensSaved = d.originalBlockTokens - d.skillBlockTokens;
    const toolKept = d.toolIncluded?.length ?? 0;
    const toolPruned = d.toolExcluded?.length ?? 0;
    const toolTokensSaved = (d.originalToolBlockTokens ?? 0) - (d.toolBlockTokens ?? 0);

    return {
      runId,
      sessionPathHash,
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
  const runBySessionHash = new Map<string, PreparedRunRow>();
  for (const run of runs) {
    runBySessionHash.set(run.sessionPathHash, run);
  }

  return pruningEvents.map((e) => {
    const sessionPathHash = hashToPrefix(e.sessionId, 16);
    const matchedRun = runBySessionHash.get(sessionPathHash);
    const runId = matchedRun?.runId ?? `pruning-${sessionPathHash}`;
    return {
      runId,
      sessionPathHash,
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
  const runBySessionHash = new Map<string, PreparedRunRow>();
  for (const run of runs) {
    runBySessionHash.set(run.sessionPathHash, run);
  }
  return events.map((e) => {
    const sessionPathHash = hashToPrefix(e.sessionId, 16);
    const matchedRun = runBySessionHash.get(sessionPathHash);
    const runId = matchedRun?.runId ?? `pruning-${sessionPathHash}`;
    return {
      runId,
      sessionPathHash,
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
  const runBySessionHash = new Map<string, PreparedRunRow>();
  for (const run of runs) {
    runBySessionHash.set(run.sessionPathHash, run);
  }
  return events.map((e) => {
    const sessionPathHash = hashToPrefix(e.sessionId, 16);
    const matchedRun = runBySessionHash.get(sessionPathHash);
    const runId = matchedRun?.runId ?? `warm-bash-${sessionPathHash}`;
    return {
      runId,
      sessionPathHash,
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
  const runBySessionHash = new Map<string, PreparedRunRow>();
  for (const run of runs) {
    runBySessionHash.set(run.sessionPathHash, run);
  }
  return events.map((e) => {
    const sessionPathHash = hashToPrefix(e.sessionId, 16);
    const matchedRun = runBySessionHash.get(sessionPathHash);
    const runId = matchedRun?.runId ?? `warm-bash-${sessionPathHash}`;
    return {
      runId,
      sessionPathHash,
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

/** Join agent-review events to runs by sessionPathHash + runId (the event carries both).
 *  Mirrors how outcomes are joined to runs, but disambiguates same-session runs via runId:
 *  the composite key `${sessionPathHash}::${runId}` picks the exact run whose session path
 *  hashes to the same prefix and whose runId matches. Unjoined reviews keep the event's runId
 *  with null model/satisfaction (they still surface in totals but not in agreement). */
function prepareAgentReviews(
  events: AgentReviewSourceEvent[],
  runs: PreparedRunRow[],
): PreparedAgentReviewRow[] {
  const runByKey = new Map<string, PreparedRunRow>();
  for (const run of runs) {
    runByKey.set(`${run.sessionPathHash}::${run.runId}`, run);
  }
  return events.map((e) => {
    const sessionPathHash = hashToPrefix(e.sessionPath, 16);
    const matchedRun = runByKey.get(`${sessionPathHash}::${e.runId}`);
    return {
      runId: e.runId,
      sessionPathHash,
      taskGroupId: e.taskGroupId,
      recordedAt: e.recordedAt,
      evaluatedAt: e.evaluatedAt,
      startedDay: e.recordedAt.slice(0, 10),
      modelFamily: matchedRun?.modelFamily ?? null,
      agentRating: e.rating,
      agentCompletion: e.completion,
      agentDone: e.done,
      reviewerBuckets: [...e.reviewerBuckets].sort(),
      reviewerCount: e.reviewerCount,
      userSatisfaction: matchedRun?.outcomeSource === 'user' ? matchedRun.satisfaction : null,
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
      inputTokens: sample.inputTokens ?? 0,
      cacheReadTokens: sample.cacheReadTokens ?? 0,
      cacheWriteTokens: sample.cacheWriteTokens ?? 0,
      contextTokens: sample.contextTokens ?? null,
    };
  });
}

export function prepareSourceAnalytics(source: SourceAnalyticsPayload): PreparedAnalyticsData {
  const outcomesByRunId = new Map<string, RunOutcome>();
  const explicitOutcomeRunIds = new Set<string>();
  for (const outcome of source.outcomes) {
    outcomesByRunId.set(outcome.runId, outcome.outcome);
    explicitOutcomeRunIds.add(outcome.runId);
  }
  // Backfill reviews recorded before agent outcomes were persisted directly.
  // Explicit run outcomes always win; among agent reviews the latest source
  // event wins for the same run.
  for (const review of source.agentReviews ?? []) {
    const outcome = outcomeFromAgentReview(review);
    if (outcome && !explicitOutcomeRunIds.has(review.runId)) {
      outcomesByRunId.set(review.runId, outcome);
    }
  }

  const dedupedRuns = dedupeRunsById([...source.completedRuns, ...source.openRuns]);
  const pricingMap = loadModelPricingMap();
  const familyMap = loadModelFamilyMap();
  const runs = dedupedRuns.map((run) => prepareRun(run, outcomesByRunId, pricingMap, familyMap));
  const canonicalRunBySessionPath = new Map<string, PreparedRunRow>();
  dedupedRuns.forEach((run, index) => canonicalRunBySessionPath.set(normalizeSessionPath(run.sessionPath), runs[index]!));
  const historicalByPath = new Map<string, PreparedHistoricalSessionSummary>();
  for (const summary of source.historicalSessions ?? []) {
    const normalizedPath = normalizeSessionPath(summary.normalizedSessionPath);
    const canonicalRun = canonicalRunBySessionPath.get(normalizedPath);
    const { normalizedSessionPath: _privatePath, ...safeSummary } = summary;
    const prepared: PreparedHistoricalSessionSummary = {
      ...safeSummary,
      attributions: safeSummary.attributions.map((attribution) => ({
        ...attribution,
        modelFamily: resolveModelFamily(attribution.modelId, familyMap) ?? '(unknown)',
      })),
      sessionPathHash: canonicalRun?.sessionPathHash ?? hashToPrefix(normalizedPath, 16),
      matchedCanonical: canonicalRun !== undefined,
      transcriptOnly: canonicalRun === undefined,
    };
    const existing = historicalByPath.get(normalizedPath);
    if (existing) {
      prepared.sourceProvenance = [...new Set([...existing.sourceProvenance, ...prepared.sourceProvenance])].sort();
      if (!prepared.review) prepared.review = existing.review;
    }
    historicalByPath.set(normalizedPath, prepared);
  }
  const historicalSessions = [...historicalByPath.values()];
  const toolUsage: PreparedToolUsageRow[] = [];
  const toolFailures: PreparedToolFailureRow[] = [];
  const verificationUsage: PreparedVerificationUsageRow[] = [];
  const backendErrors: PreparedBackendErrorRow[] = [];
  const fileExtensions: PreparedFileExtensionRow[] = [];
  const turnThroughput: PreparedTurnThroughputRow[] = [];

  for (const run of dedupedRuns) {
    const outcome = getRunOutcome(run, outcomesByRunId);
    toolUsage.push(...prepareToolUsage(run, outcome));
    toolFailures.push(...prepareToolFailures(run, outcome));
    verificationUsage.push(...prepareVerificationUsage(run, outcome));
    backendErrors.push(...prepareBackendErrors(run, outcome));
    fileExtensions.push(...prepareFileExtensions(run, outcome));
    turnThroughput.push(...prepareTurnThroughput(run, familyMap));
  }

  const pruningEvents = preparePruningEvents(source.pruningDecisions ?? [], runs);
  const pruningSignals = preparePruningSignals(source.pruningEvents ?? [], runs);
  const toolResultPruning = prepareToolResultPruning(source.toolResultPruningEvents ?? [], runs);
  const warmBashRewrites = prepareWarmBashRewrites(source.warmBashRewrites ?? [], runs);
  const warmBashSummaries = prepareWarmBashSummaries(source.warmBashSummaries ?? [], runs);
  const agentReviews = prepareAgentReviews(source.agentReviews ?? [], runs);

  return {
    sourceSchemaVersion: source.schemaVersion,
    sourceExportedAt: source.exportedAt,
    sourceWorkspaceKey: source.workspaceKey,
    runs,
    toolUsage,
    toolFailures,
    verificationUsage,
    backendErrors,
    fileExtensions,
    turnThroughput,
    pruningEvents,
    pruningSignals,
    toolResultPruning,
    warmBashRewrites,
    warmBashSummaries,
    agentReviews,
    historicalSessions,
  };
}
