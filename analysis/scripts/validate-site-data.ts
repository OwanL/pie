#!/usr/bin/env node
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { SiteDataBundle } from './contracts.ts';
import { toErrorMessage } from '../../shared/error-message.js';
import { parseCliOptions, formatUsage } from './cli.ts';
import { DEFAULT_SITE_DATA_DIR, loadSourceAnalytics } from './source.ts';
import { prepareSourceAnalytics } from './prepare.ts';
import { buildSiteDataBundle, readSiteDataBundle, validateSiteDataBundle, writeSiteData } from './site-data.ts';

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function assertFiniteNonNegative(value: unknown, label: string): void {
  if (!isFiniteNumber(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number, got ${value}.`);
  }
}

function assertFiniteNullable(value: unknown, label: string): void {
  if (value !== null && !isFiniteNumber(value)) {
    throw new Error(`${label} must be null or a finite number, got ${value}.`);
  }
}

function assertFiniteNullableNonNegative(value: unknown, label: string): void {
  if (value !== null && (!isFiniteNumber(value) || value < 0)) {
    throw new Error(`${label} must be null or a finite non-negative number, got ${value}.`);
  }
}

function assertSatisfaction(value: unknown, label: string): void {
  if (value !== null && (!isFiniteNumber(value) || value < 1 || value > 5)) {
    throw new Error(`${label} must be null or a finite number in [1, 5], got ${value}.`);
  }
}

function assertCountField(value: unknown, label: string): void {
  assertFiniteNonNegative(value, label);
}

function assertNonNegativeInteger(value: unknown, label: string): void {
  if (!isFiniteNumber(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative integer, got ${value}.`);
  }
}

function assertUnitInterval(value: unknown, label: string): void {
  if (!isFiniteNumber(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a finite number in [0, 1], got ${value}.`);
  }
}

function assertNullableUnitInterval(value: unknown, label: string): void {
  if (value !== null) assertUnitInterval(value, label);
}

/**
 * Post-validation pass that rejects NaN, Infinity, and clearly invalid negative
 * values in numeric fields. This complements the structural checks in
 * site-data.ts without modifying the shared validators there.
 */
export function validateSiteDataBundleNumericFields(bundle: SiteDataBundle): void {
  assertFiniteNonNegative(bundle.manifest.completedRunCount, 'manifest.completedRunCount');
  assertFiniteNonNegative(bundle.manifest.openRunCount, 'manifest.openRunCount');
  assertFiniteNonNegative(bundle.manifest.scoredRunCount, 'manifest.scoredRunCount');

  const overview = bundle.overview;
  assertFiniteNonNegative(overview.totalCompletedRuns, 'overview.totalCompletedRuns');
  assertFiniteNonNegative(overview.totalOpenRuns, 'overview.totalOpenRuns');
  assertFiniteNonNegative(overview.totalScoredRuns, 'overview.totalScoredRuns');
  assertSatisfaction(overview.averageSatisfaction, 'overview.averageSatisfaction');
  assertFiniteNullableNonNegative(overview.medianBusyDurationMs, 'overview.medianBusyDurationMs');
  assertFiniteNullableNonNegative(overview.p90BusyDurationMs, 'overview.p90BusyDurationMs');
  assertFiniteNullableNonNegative(overview.p99BusyDurationMs, 'overview.p99BusyDurationMs');
  assertFiniteNullable(overview.verificationRunRate, 'overview.verificationRunRate');
  assertFiniteNullable(overview.toolFailureRate, 'overview.toolFailureRate');
  assertFiniteNullable(overview.resultIssueRate, 'overview.resultIssueRate');
  assertFiniteNullable(overview.medianTokenEfficiency, 'overview.medianTokenEfficiency');
  assertFiniteNullable(overview.averageContextUtilization, 'overview.averageContextUtilization');
  assertFiniteNullable(overview.averageCacheHitRatio, 'overview.averageCacheHitRatio');
  assertFiniteNullable(overview.firstAttemptSuccessRate, 'overview.firstAttemptSuccessRate');
  assertFiniteNullableNonNegative(overview.totalEstimatedCostUsd, 'overview.totalEstimatedCostUsd');
  assertFiniteNullableNonNegative(overview.medianEstimatedCostUsd, 'overview.medianEstimatedCostUsd');

  for (const [index, row] of bundle.runSummary.rows.entries()) {
    const prefix = `run-summary.json row ${index}`;
    assertCountField(row.toolCallCount, `${prefix}.toolCallCount`);
    assertFiniteNonNegative(row.toolDurationMs, `${prefix}.toolDurationMs`);
    assertCountField(row.timedToolCallCount, `${prefix}.timedToolCallCount`);
    assertCountField(row.toolFailureCount, `${prefix}.toolFailureCount`);
    assertCountField(row.inputTokens, `${prefix}.inputTokens`);
    assertCountField(row.outputTokens, `${prefix}.outputTokens`);
    assertCountField(row.cacheReadTokens, `${prefix}.cacheReadTokens`);
    assertCountField(row.cacheWriteTokens, `${prefix}.cacheWriteTokens`);
    assertFiniteNullableNonNegative(row.estimatedCostUsd, `${prefix}.estimatedCostUsd`);
    assertFiniteNullableNonNegative(row.subagentEstimatedCostUsd, `${prefix}.subagentEstimatedCostUsd`);
    assertFiniteNullableNonNegative(row.totalEstimatedCostUsd, `${prefix}.totalEstimatedCostUsd`);
    assertFiniteNonNegative(row.assistantTurnDurationMs, `${prefix}.assistantTurnDurationMs`);
    assertFiniteNonNegative(row.busyDurationMs, `${prefix}.busyDurationMs`);
    assertCountField(row.sendCount, `${prefix}.sendCount`);
    assertCountField(row.assistantTurnCount, `${prefix}.assistantTurnCount`);
    assertCountField(row.busyPeriodCount, `${prefix}.busyPeriodCount`);
    assertCountField(row.interruptedCount, `${prefix}.interruptedCount`);
    assertCountField(row.messageEditCount, `${prefix}.messageEditCount`);
    assertCountField(row.truncatedAfterCount, `${prefix}.truncatedAfterCount`);
    assertCountField(row.backendErrorCount, `${prefix}.backendErrorCount`);
    assertCountField(row.tokenReportedTurnCount, `${prefix}.tokenReportedTurnCount`);
    assertCountField(row.filesystemPathRefCount, `${prefix}.filesystemPathRefCount`);
    assertCountField(row.imageInputCount, `${prefix}.imageInputCount`);
    assertCountField(row.imageInputBytes, `${prefix}.imageInputBytes`);
    assertCountField(row.unsupportedInputCount, `${prefix}.unsupportedInputCount`);
    assertCountField(row.subagentCallCount, `${prefix}.subagentCallCount`);
    assertCountField(row.subagentTaskCount, `${prefix}.subagentTaskCount`);
    assertCountField(row.subagentAgentCount, `${prefix}.subagentAgentCount`);
    assertCountField(row.subagentScoredTaskCount, `${prefix}.subagentScoredTaskCount`);
    assertCountField(row.verificationTotalCount, `${prefix}.verificationTotalCount`);
    assertCountField(row.verificationFailureCount, `${prefix}.verificationFailureCount`);
    for (const [kind, count] of Object.entries(row.verificationCountsByKind)) {
      assertCountField(count, `${prefix}.verificationCountsByKind.${kind}`);
    }
    assertSatisfaction(row.satisfaction, `${prefix}.satisfaction`);
    assert(
      row.outcomeSource === null || row.outcomeSource === 'user' || row.outcomeSource === 'agent',
      `${prefix}.outcomeSource must be user, agent, or null.`,
    );
    assertFiniteNullable(row.subagentMeanPrecision, `${prefix}.subagentMeanPrecision`);
    assertFiniteNullable(row.subagentMeanCreativity, `${prefix}.subagentMeanCreativity`);
    assertFiniteNullable(row.subagentMeanReasoning, `${prefix}.subagentMeanReasoning`);
    assertFiniteNullable(row.subagentMeanThoroughness, `${prefix}.subagentMeanThoroughness`);
    assertFiniteNullable(row.subagentMaxPrecision, `${prefix}.subagentMaxPrecision`);
    assertFiniteNullable(row.subagentMaxCreativity, `${prefix}.subagentMaxCreativity`);
    assertFiniteNullable(row.subagentMaxReasoning, `${prefix}.subagentMaxReasoning`);
    assertFiniteNullable(row.subagentMaxThoroughness, `${prefix}.subagentMaxThoroughness`);
    assertFiniteNullable(row.subagentCompositeMean, `${prefix}.subagentCompositeMean`);
    assertCountField(row.selectedToolCount, `${prefix}.selectedToolCount`);
    assertCountField(row.skillCount, `${prefix}.skillCount`);
    assertCountField(row.contextFileCount, `${prefix}.contextFileCount`);
    assertCountField(row.promptGuidelineCount, `${prefix}.promptGuidelineCount`);
    assertFiniteNullableNonNegative(row.initialUserMessageChars, `${prefix}.initialUserMessageChars`);
    assertCountField(row.fileWriteCount, `${prefix}.fileWriteCount`);
    assertCountField(row.fileEditCount, `${prefix}.fileEditCount`);
    assertCountField(row.fileDeleteCount, `${prefix}.fileDeleteCount`);
    assertCountField(row.fileRenameCount, `${prefix}.fileRenameCount`);
    assertCountField(row.touchedFileCount, `${prefix}.touchedFileCount`);
    assertCountField(row.lineAdditions, `${prefix}.lineAdditions`);
    assertCountField(row.lineDeletions, `${prefix}.lineDeletions`);
    assertCountField(row.lineModifications, `${prefix}.lineModifications`);
    assertCountField(row.lineMutationTotal, `${prefix}.lineMutationTotal`);
    assertFiniteNullable(row.tokenEfficiency, `${prefix}.tokenEfficiency`);
    assertFiniteNullable(row.contextUtilization, `${prefix}.contextUtilization`);
    assertFiniteNullable(row.cacheHitRatio, `${prefix}.cacheHitRatio`);
    assertFiniteNullable(row.editRevisitRate, `${prefix}.editRevisitRate`);
    assertFiniteNullable(row.readRevisitRate, `${prefix}.readRevisitRate`);
    assertCountField(row.filesReviewedCount, `${prefix}.filesReviewedCount`);
  }

  for (const [index, row] of bundle.modelQuality.rows.entries()) {
    const prefix = `model-quality.json row ${index}`;
    assertCountField(row.runCount, `${prefix}.runCount`);
    assertCountField(row.scoredRunCount, `${prefix}.scoredRunCount`);
    if (row.agentOutcomeCount !== undefined) {
      assertCountField(row.agentOutcomeCount, `${prefix}.agentOutcomeCount`);
    }
    if (row.mixedModelExcludedOutcomeCount !== undefined) {
      assertCountField(row.mixedModelExcludedOutcomeCount, `${prefix}.mixedModelExcludedOutcomeCount`);
    }
    if (row.mixedTreatmentExcludedOutcomeCount !== undefined) {
      assertCountField(row.mixedTreatmentExcludedOutcomeCount, `${prefix}.mixedTreatmentExcludedOutcomeCount`);
    }
    assertSatisfaction(row.averageSatisfaction, `${prefix}.averageSatisfaction`);
    assertFiniteNullableNonNegative(row.averageBusyDurationMs, `${prefix}.averageBusyDurationMs`);
    assertFiniteNullableNonNegative(row.medianBusyDurationMs, `${prefix}.medianBusyDurationMs`);
    assertFiniteNullableNonNegative(row.p90BusyDurationMs, `${prefix}.p90BusyDurationMs`);
    assertFiniteNullableNonNegative(row.p99BusyDurationMs, `${prefix}.p99BusyDurationMs`);
    assertFiniteNullable(row.averageToolFailures, `${prefix}.averageToolFailures`);
    assertFiniteNullable(row.verificationRunRate, `${prefix}.verificationRunRate`);
    assertFiniteNullable(row.medianTokenEfficiency, `${prefix}.medianTokenEfficiency`);
    assertFiniteNullable(row.averageContextUtilization, `${prefix}.averageContextUtilization`);
    assertFiniteNullable(row.averageCacheHitRatio, `${prefix}.averageCacheHitRatio`);
    assertFiniteNullable(row.firstAttemptSuccessRate, `${prefix}.firstAttemptSuccessRate`);
  }

  for (const [index, row] of bundle.verificationImpact.rows.entries()) {
    const prefix = `verification-impact.json row ${index}`;
    assertCountField(row.runCount, `${prefix}.runCount`);
    assertCountField(row.scoredRunCount, `${prefix}.scoredRunCount`);
    assertSatisfaction(row.averageSatisfaction, `${prefix}.averageSatisfaction`);
  }
  for (const [index, row] of bundle.verificationImpact.summaryRows.entries()) {
    const prefix = `verification-impact.json summary row ${index}`;
    assertCountField(row.runCount, `${prefix}.runCount`);
    assertCountField(row.scoredRunCount, `${prefix}.scoredRunCount`);
    assertSatisfaction(row.averageSatisfaction, `${prefix}.averageSatisfaction`);
  }

  for (const [index, row] of bundle.toolUsage.summaryRows.entries()) {
    const prefix = `tool-usage.json summary row ${index}`;
    assertCountField(row.callCount, `${prefix}.callCount`);
    assertCountField(row.failureCount, `${prefix}.failureCount`);
    assertCountField(row.executionFailureCount, `${prefix}.executionFailureCount`);
    assertCountField(row.verificationProjectFailureCount, `${prefix}.verificationProjectFailureCount`);
    assertCountField(row.probeFailureCount, `${prefix}.probeFailureCount`);
    assertCountField(row.resultIssueCount, `${prefix}.resultIssueCount`);
    assertCountField(row.affectedRunCount, `${prefix}.affectedRunCount`);
    assertSatisfaction(row.averageSatisfactionWhenUsed, `${prefix}.averageSatisfactionWhenUsed`);
    assertSatisfaction(row.averageSatisfactionWhenUnused, `${prefix}.averageSatisfactionWhenUnused`);
  }

  for (const [index, row] of bundle.treatmentComparison.rows.entries()) {
    const prefix = `treatment-comparison.json row ${index}`;
    assertCountField(row.runCount, `${prefix}.runCount`);
    assertCountField(row.scoredRunCount, `${prefix}.scoredRunCount`);
    assertSatisfaction(row.averageSatisfaction, `${prefix}.averageSatisfaction`);
  }

  for (const [index, row] of bundle.timeline.rows.entries()) {
    const prefix = `timeline.json row ${index}`;
    assertCountField(row.runCount, `${prefix}.runCount`);
    assertCountField(row.scoredRunCount, `${prefix}.scoredRunCount`);
    assertCountField(row.verificationRunCount, `${prefix}.verificationRunCount`);
    assertCountField(row.toolFailureCount, `${prefix}.toolFailureCount`);
    assertSatisfaction(row.averageSatisfaction, `${prefix}.averageSatisfaction`);
    assertFiniteNullableNonNegative(row.averageBusyDurationMs, `${prefix}.averageBusyDurationMs`);
    for (const [modelId, count] of Object.entries(row.modelMix)) {
      assertCountField(count, `${prefix}.modelMix.${modelId}`);
    }
  }

  for (const [index, row] of bundle.modelLeaderboard.rows.entries()) {
    const prefix = `model-leaderboard.json row ${index}`;
    assertCountField(row.runCount, `${prefix}.runCount`);
    assertCountField(row.scoredRunCount, `${prefix}.scoredRunCount`);
    assertNonNegativeInteger(row.effectiveTaskCount, `${prefix}.effectiveTaskCount`);
    assertCountField(row.attributableRunCount, `${prefix}.attributableRunCount`);
    assertNonNegativeInteger(row.attributableTaskCount, `${prefix}.attributableTaskCount`);
    assertFiniteNonNegative(row.userOutcomeCount, `${prefix}.userOutcomeCount`);
    assertFiniteNonNegative(row.agentOutcomeCount, `${prefix}.agentOutcomeCount`);
    assertCountField(row.userEvidenceCount, `${prefix}.userEvidenceCount`);
    assertFiniteNonNegative(row.userEvidenceMass, `${prefix}.userEvidenceMass`);
    assertCountField(row.agentEvidenceCount, `${prefix}.agentEvidenceCount`);
    assertFiniteNonNegative(row.agentEvidenceMass, `${prefix}.agentEvidenceMass`);
    assertCountField(row.processEvidenceCount, `${prefix}.processEvidenceCount`);
    assertFiniteNonNegative(row.processEvidenceMass, `${prefix}.processEvidenceMass`);
    assertCountField(row.canonicalTaskCount, `${prefix}.canonicalTaskCount`);
    assertCountField(row.transcriptOnlySessionCount, `${prefix}.transcriptOnlySessionCount`);
    assertFiniteNonNegative(row.mixedAttributionMass, `${prefix}.mixedAttributionMass`);
    for (const [channel, value] of Object.entries({ user: row.userChannelScore, agent: row.agentChannelScore, process: row.processChannelScore })) {
      assertNullableUnitInterval(value, `${prefix}.${channel}ChannelScore`);
    }
    if (!['outcome-backed', 'thin-outcome', 'telemetry-only'].includes(row.evidenceTier)) throw new Error(`${prefix}.evidenceTier is invalid.`);
    if (row.compositeScore !== null) {
      assertUnitInterval(row.scoreInterval80?.lower, `${prefix}.scoreInterval80.lower`);
      assertUnitInterval(row.scoreInterval80?.upper, `${prefix}.scoreInterval80.upper`);
    }
    assertCountField(row.mixedModelExcludedCount, `${prefix}.mixedModelExcludedCount`);
    assertCountField(row.mixedTreatmentExcludedCount, `${prefix}.mixedTreatmentExcludedCount`);
    assertCountField(row.subagentRunCount, `${prefix}.subagentRunCount`);
    assertFiniteNullable(row.compositeScore, `${prefix}.compositeScore`);
    assertFiniteNullable(row.unadjustedCompositeScore, `${prefix}.unadjustedCompositeScore`);
    assertFiniteNullable(row.caseMixAdjustment, `${prefix}.caseMixAdjustment`);
    assertFiniteNullableNonNegative(row.evidenceWeight, `${prefix}.evidenceWeight`);
    assertFiniteNullableNonNegative(row.reliabilityFactor, `${prefix}.reliabilityFactor`);
    assertNullableUnitInterval(row.scoringCoverage, `${prefix}.scoringCoverage`);
    assertFiniteNullableNonNegative(row.caseMixOverlap, `${prefix}.caseMixOverlap`);
    assertFiniteNullable(row.subagentUsageRate, `${prefix}.subagentUsageRate`);
    assertFiniteNullable(row.avgSubagentTasksPerRun, `${prefix}.avgSubagentTasksPerRun`);
    assertFiniteNullableNonNegative(row.medianDurationMs, `${prefix}.medianDurationMs`);
    assertFiniteNullable(row.medianTokenEfficiency, `${prefix}.medianTokenEfficiency`);
    assertFiniteNullableNonNegative(row.medianCostUsd, `${prefix}.medianCostUsd`);
    assertFiniteNullableNonNegative(row.meanPreTaskComplexity, `${prefix}.meanPreTaskComplexity`);
    assertFiniteNullableNonNegative(row.meanWorkloadIntensity, `${prefix}.meanWorkloadIntensity`);
    assertFiniteNullableNonNegative(row.meanTaskComplexity, `${prefix}.meanTaskComplexity`);
    for (const [band, count] of Object.entries(row.taskComplexityBandCounts)) {
      assertNonNegativeInteger(count, `${prefix}.taskComplexityBandCounts.${band}`);
    }
    for (const [dimName, dim] of Object.entries(row.dimensions)) {
      assertFiniteNullable(dim.value, `${prefix}.dimensions.${dimName}.value`);
      assertFiniteNullable(dim.lowerBound, `${prefix}.dimensions.${dimName}.lowerBound`);
      assertFiniteNullable(dim.shrunk, `${prefix}.dimensions.${dimName}.shrunk`);
      assertCountField(dim.n, `${prefix}.dimensions.${dimName}.n`);
    }
    for (const [pIndex, provider] of row.providers.entries()) {
      const pPrefix = `${prefix}.providers[${pIndex}]`;
      assertCountField(provider.runCount, `${pPrefix}.runCount`);
      assertCountField(provider.scoredRunCount, `${pPrefix}.scoredRunCount`);
      assertCountField(provider.transcriptOnlySessionCount, `${pPrefix}.transcriptOnlySessionCount`);
      assertFiniteNonNegative(provider.transcriptEvidenceMass, `${pPrefix}.transcriptEvidenceMass`);
    }
  }

  const weights = bundle.modelLeaderboard.weights;
  for (const [dimension, weight] of Object.entries(weights)) {
    if (!isFiniteNumber(weight)) {
      throw new Error(`model-leaderboard.json weights.${dimension} must be finite, got ${weight}.`);
    }
  }
  for (const [source, weight] of Object.entries(bundle.modelLeaderboard.sourceWeights)) {
    assertUnitInterval(weight, `model-leaderboard.json sourceWeights.${source}`);
  }
  if (Math.abs(Object.values(bundle.modelLeaderboard.sourceWeights).reduce((sum, value) => sum + value, 0) - 1) > 1e-9) {
    throw new Error('model-leaderboard.json sourceWeights must sum to 1.');
  }
  if (weights.fileChurn !== 0 || weights.toolReliability !== 0 || weights.verificationPassRate !== 0 || weights.tokenEfficiency !== 0) {
    throw new Error('model-leaderboard.json process weights must be zero.');
  }
  if (Math.abs(weights.satisfaction + weights.resolutionRate - 1) > 1e-9) {
    throw new Error('model-leaderboard.json satisfaction and resolution weights must sum to 1.');
  }
  assertNonNegativeInteger(bundle.modelLeaderboard.minimumScoredRuns, 'model-leaderboard.json minimumScoredRuns');
  assertNonNegativeInteger(bundle.modelLeaderboard.minimumEffectiveTasks, 'model-leaderboard.json minimumEffectiveTasks');
  assertUnitInterval(bundle.modelLeaderboard.minimumTaskScoringCoverage, 'model-leaderboard.json minimumTaskScoringCoverage');
  assertNonNegativeInteger(bundle.modelLeaderboard.caseMix.minimumRatedTasksPerBand, 'model-leaderboard.json caseMix.minimumRatedTasksPerBand');
  assertNonNegativeInteger(bundle.modelLeaderboard.caseMix.minimumModelRatedTasksPerBand, 'model-leaderboard.json caseMix.minimumModelRatedTasksPerBand');
  assertFiniteNonNegative(bundle.modelLeaderboard.caseMix.minimumTargetBandWeight, 'model-leaderboard.json caseMix.minimumTargetBandWeight');
  assertFiniteNonNegative(bundle.modelLeaderboard.caseMix.initialUserMessageCoverage, 'model-leaderboard.json caseMix.initialUserMessageCoverage');
  for (const [band, weight] of Object.entries(bundle.modelLeaderboard.caseMix.targetBandWeights)) {
    assertFiniteNonNegative(weight, `model-leaderboard.json caseMix.targetBandWeights.${band}`);
  }
  for (const [band, count] of Object.entries(bundle.modelLeaderboard.caseMix.scoredBandCounts)) {
    assertNonNegativeInteger(count, `model-leaderboard.json caseMix.scoredBandCounts.${band}`);
  }

  const pruningSummary = bundle.pruningImpact.summary;
  assertCountField(pruningSummary.totalEvents, 'pruning-impact.json summary.totalEvents');
  assertCountField(pruningSummary.skillReadCount, 'pruning-impact.json summary.skillReadCount');
  assertCountField(pruningSummary.skillMissCount, 'pruning-impact.json summary.skillMissCount');
  assertCountField(pruningSummary.shadowMissCandidateCount, 'pruning-impact.json summary.shadowMissCandidateCount');
  assertCountField(pruningSummary.toolRecoveredCount, 'pruning-impact.json summary.toolRecoveredCount');
  assertCountField(pruningSummary.decisionsThatPrunedTools, 'pruning-impact.json summary.decisionsThatPrunedTools');
  assertFiniteNullable(pruningSummary.pruneRecoveredRate, 'pruning-impact.json summary.pruneRecoveredRate');
  assertFiniteNullable(pruningSummary.skillMissRate, 'pruning-impact.json summary.skillMissRate');
  assertFiniteNullableNonNegative(pruningSummary.medianLlmLatencyMs, 'pruning-impact.json summary.medianLlmLatencyMs');
  for (const [mode, count] of Object.entries(pruningSummary.modeCounts)) {
    assertCountField(count, `pruning-impact.json summary.modeCounts.${mode}`);
  }

  assertCountField(bundle.backendErrors.summary.totalErrorEvents, 'backend-errors.json summary.totalErrorEvents');
  assertCountField(bundle.backendErrors.summary.affectedRunCount, 'backend-errors.json summary.affectedRunCount');
  for (const [index, row] of bundle.backendErrors.summary.byErrorCode.entries()) {
    const prefix = `backend-errors.json summary.byErrorCode[${index}]`;
    assertCountField(row.count, `${prefix}.count`);
    assertCountField(row.affectedRunCount, `${prefix}.affectedRunCount`);
  }

  for (const [index, row] of bundle.fileExtensions.summary.entries()) {
    const prefix = `file-types.json summary row ${index}`;
    assertCountField(row.readCount, `${prefix}.readCount`);
    assertCountField(row.writeCount, `${prefix}.writeCount`);
    assertCountField(row.editCount, `${prefix}.editCount`);
    assertCountField(row.totalCount, `${prefix}.totalCount`);
    assertCountField(row.affectedRunCount, `${prefix}.affectedRunCount`);
  }

  for (const [index, row] of bundle.tokenThroughput.rows.entries()) {
    const prefix = `token-throughput.json row ${index}`;
    assertFiniteNonNegative(row.generationDurationMs, `${prefix}.generationDurationMs`);
    assertFiniteNonNegative(row.outputTokens, `${prefix}.outputTokens`);
    assertFiniteNonNegative(row.concurrentBusySessions, `${prefix}.concurrentBusySessions`);
  }
}

function normalizedForComparison(
  bundle: SiteDataBundle,
  options: { ignoreSourceExportedAt?: boolean } = {},
): SiteDataBundle {
  return {
    ...bundle,
    manifest: {
      ...bundle.manifest,
      generatedAt: '__normalized__',
      sourceExportedAt: options.ignoreSourceExportedAt ? '__normalized__' : bundle.manifest.sourceExportedAt,
    },
  };
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.help) {
    console.log(formatUsage('npm run validate-site-data --', 'Validate generated site data and site-data invariants.'));
    return;
  }

  const hasExplicitSource = Boolean(options.exportPath || options.storageDir);
  const outputDir = options.outputDir ?? DEFAULT_SITE_DATA_DIR;
  const outputDirExists = fs.existsSync(outputDir);

  if (outputDirExists) {
    const existingBundle = await readSiteDataBundle(outputDir);
    validateSiteDataBundle(existingBundle);
    validateSiteDataBundleNumericFields(existingBundle);

    if (!hasExplicitSource) {
      console.log('Validated existing generated site data.');
      console.log(`Directory: ${outputDir}`);
      return;
    }
  }

  const loaded = await loadSourceAnalytics({ exportPath: options.exportPath, storageDir: options.storageDir });
  const prepared = prepareSourceAnalytics(loaded.source);
  const bundle = buildSiteDataBundle(prepared);
  validateSiteDataBundle(bundle);
  validateSiteDataBundleNumericFields(bundle);

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pie-analysis-site-data-'));

  try {
    await writeSiteData(tempDir, bundle);
    const roundTrip = await readSiteDataBundle(tempDir);
    validateSiteDataBundle(roundTrip);
    validateSiteDataBundleNumericFields(roundTrip);

    if (outputDirExists) {
      const existingBundle = await readSiteDataBundle(outputDir);
      validateSiteDataBundle(existingBundle);
      validateSiteDataBundleNumericFields(existingBundle);
      assert.deepEqual(
        normalizedForComparison(existingBundle, { ignoreSourceExportedAt: loaded.sourceKind === 'storage-dir' }),
        normalizedForComparison(bundle, { ignoreSourceExportedAt: loaded.sourceKind === 'storage-dir' }),
        `Existing site data at ${outputDir} does not match the selected source. Regenerate it with npm run export-site-data.`,
      );
    }

    console.log(`Validated site data for workspace ${loaded.source.workspaceKey}.`);
    console.log(`Source: ${loaded.sourceKind} (${loaded.sourcePath})`);
    console.log(`Directory: ${outputDirExists ? outputDir : '(temporary output from source build)'}`);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error('validate-site-data failed:', toErrorMessage(error));
    process.exitCode = 1;
  });
}
