import {
  type RunOutcome,
  type RunSnapshot,
  type AgentReviewSourceEvent,
  type PreparedAnalyticsData,
  type PreparedAgentReviewRow,
  type PreparedBackendErrorRow,
  type PreparedFileExtensionRow,
  type PreparedPruningEventRow,
  type PreparedPruningSignalRow,
  type PreparedToolResultPruningRow,
  type PreparedRunRow,
  type PreparedToolFailureRow,
  type PreparedToolUsageRow,
  type PreparedTurnThroughputRow,
  type PreparedVerificationUsageRow,
  type PruningSourceDecision,
  type PruningSourceEvent,
  type ToolResultPruningSourceEvent,
  type SourceAnalyticsPayload,
  type ThinkingLevel,
  type VerificationCommandKind,
} from './contracts.ts';
import { existingHashPrefix, hashToPrefix } from './hash.ts';
import { loadModelPricingMap, estimateRunCostUsd } from './pricing.ts';
import { loadModelFamilyMap, resolveModelFamily, resolveModelProvider } from './model-family.ts';

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function normalizeNullableText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
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

  return {
    runId: run.runId,
    taskGroupId: run.taskGroupId,
    sessionPathHash: hashToPrefix(run.sessionPath, 16),
    status: run.status,
    scored: run.scored,
    startedAt: run.startedAt,
    startedDay,
    updatedAt: run.updatedAt,
    finalizedAt: run.finalizedAt ?? null,
    finalizationReason: run.finalizationReason ?? null,
    resolution: outcome?.resolution ?? null,
    satisfaction: outcome?.satisfaction ?? null,
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
    tokenEfficiency: (run.fileMutation.lineAdditions + run.fileMutation.lineDeletions + run.fileMutation.lineModifications) > 0
      ? round3((run.outputTokens ?? 0) / (run.fileMutation.lineAdditions + run.fileMutation.lineDeletions + run.fileMutation.lineModifications))
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
    estimatedCostUsd: estimateRunCostUsd(normalizedModelId, {
      inputTokens: run.inputTokens ?? 0,
      outputTokens: run.outputTokens ?? 0,
      cacheReadTokens: run.cacheReadTokens ?? 0,
      cacheWriteTokens: run.cacheWriteTokens ?? 0,
    }, pricingMap),
  };
}

function prepareToolUsage(run: RunSnapshot, outcome: RunOutcome | null): PreparedToolUsageRow[] {
  const startedDay = toStartedDay(run.startedAt);
  return Object.entries(run.toolUsage.countsByName)
    .filter(([, callCount]) => callCount > 0)
    .map(([toolName, callCount]) => {
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
        scored: run.scored,
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
      scored: run.scored,
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
      scored: run.scored,
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
    scored: run.scored,
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
      scored: run.scored,
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
      userSatisfaction: matchedRun?.satisfaction ?? null,
    };
  });
}

function roundThroughput(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Flatten per-turn throughput samples into analysis rows stamped with the
 * parent run's metadata. `tokensPerSecond` is precomputed for completed turns
 * with reported output tokens and positive generation time (null otherwise so
 * errored / tokenless turns stay countable without polluting the throughput
 * distribution).
 */
function prepareTurnThroughput(run: RunSnapshot): PreparedTurnThroughputRow[] {
  if (!run.turnThroughputSamples || run.turnThroughputSamples.length === 0) {
    return [];
  }
  const modelId = normalizeNullableText(run.modelId);
  const thinkingLevel = normalizeThinkingLevel(run.thinkingLevel);
  const experimentAssignment = normalizeNullableText(run.experimentAssignment);

  return run.turnThroughputSamples.map((sample) => {
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
    };
  });
}

export function prepareSourceAnalytics(source: SourceAnalyticsPayload): PreparedAnalyticsData {
  const outcomesByRunId = new Map<string, RunOutcome>();
  for (const outcome of source.outcomes) {
    outcomesByRunId.set(outcome.runId, outcome.outcome);
  }

  const dedupedRuns = dedupeRunsById([...source.completedRuns, ...source.openRuns]);
  const pricingMap = loadModelPricingMap();
  const familyMap = loadModelFamilyMap();
  const runs = dedupedRuns.map((run) => prepareRun(run, outcomesByRunId, pricingMap, familyMap));
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
    turnThroughput.push(...prepareTurnThroughput(run));
  }

  const pruningEvents = preparePruningEvents(source.pruningDecisions ?? [], runs);
  const pruningSignals = preparePruningSignals(source.pruningEvents ?? [], runs);
  const toolResultPruning = prepareToolResultPruning(source.toolResultPruningEvents ?? [], runs);
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
    agentReviews,
  };
}
