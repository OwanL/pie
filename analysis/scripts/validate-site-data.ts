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
  assertNonNegativeInteger(bundle.manifest.completedRunCount, 'manifest.completedRunCount');
  assertNonNegativeInteger(bundle.manifest.openRunCount, 'manifest.openRunCount');

  const overview = bundle.overview;
  assertNonNegativeInteger(overview.totalCompletedRuns, 'overview.totalCompletedRuns');
  assertNonNegativeInteger(overview.totalOpenRuns, 'overview.totalOpenRuns');
  for (const [field, value] of Object.entries({
    medianBusyDurationMs: overview.medianBusyDurationMs,
    p90BusyDurationMs: overview.p90BusyDurationMs,
    p99BusyDurationMs: overview.p99BusyDurationMs,
    totalEstimatedCostUsd: overview.totalEstimatedCostUsd,
    medianEstimatedCostUsd: overview.medianEstimatedCostUsd,
  })) assertFiniteNullableNonNegative(value, `overview.${field}`);
  for (const [field, value] of Object.entries({
    verificationRunRate: overview.verificationRunRate,
    toolFailureRate: overview.toolFailureRate,
    resultIssueRate: overview.resultIssueRate,
    medianTokenEfficiency: overview.medianTokenEfficiency,
    averageContextUtilization: overview.averageContextUtilization,
    averageCacheHitRatio: overview.averageCacheHitRatio,
  })) assertFiniteNullable(value, `overview.${field}`);

  for (const [index, row] of bundle.runSummary.rows.entries()) {
    const prefix = `run-summary.json row ${index}`;
    for (const field of ['toolCallCount', 'toolDurationMs', 'timedToolCallCount', 'toolFailureCount', 'resultIssueCount', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'assistantTurnDurationMs', 'busyDurationMs', 'sendCount', 'assistantTurnCount', 'busyPeriodCount', 'interruptedCount', 'messageEditCount', 'truncatedAfterCount', 'backendErrorCount', 'tokenReportedTurnCount', 'filesystemPathRefCount', 'imageInputCount', 'imageInputBytes', 'unsupportedInputCount', 'subagentCallCount', 'subagentTaskCount', 'subagentAgentCount', 'selectedToolCount', 'skillCount', 'contextFileCount', 'promptGuidelineCount', 'fileWriteCount', 'fileEditCount', 'fileDeleteCount', 'fileRenameCount', 'touchedFileCount', 'lineAdditions', 'lineDeletions', 'lineModifications', 'lineMutationTotal', 'filesReviewedCount'] as const) {
      assertCountField(row[field], `${prefix}.${field}`);
    }
    for (const field of ['criticalPathDurationMs', 'skillPruningPrepassDurationMs', 'estimatedCostUsd', 'subagentEstimatedCostUsd', 'totalEstimatedCostUsd', 'initialUserMessageChars'] as const) assertFiniteNullableNonNegative(row[field], `${prefix}.${field}`);
    for (const field of ['tokenEfficiency', 'contextUtilization', 'cacheHitRatio', 'editRevisitRate', 'readRevisitRate'] as const) assertFiniteNullable(row[field], `${prefix}.${field}`);
    for (const [kind, count] of Object.entries(row.verificationCountsByKind)) assertCountField(count, `${prefix}.verificationCountsByKind.${kind}`);
  }

  for (const [index, row] of bundle.modelQuality.rows.entries()) {
    const prefix = `model-quality.json row ${index}`;
    assertCountField(row.runCount, `${prefix}.runCount`);
    if (row.v2ReviewCount !== undefined) assertCountField(row.v2ReviewCount, `${prefix}.v2ReviewCount`);
    for (const field of ['averageBusyDurationMs', 'medianBusyDurationMs', 'p90BusyDurationMs', 'p99BusyDurationMs'] as const) assertFiniteNullableNonNegative(row[field], `${prefix}.${field}`);
    for (const field of ['averageToolFailures', 'verificationRunRate', 'medianTokenEfficiency', 'averageContextUtilization', 'averageCacheHitRatio'] as const) assertFiniteNullable(row[field], `${prefix}.${field}`);
  }

  for (const [index, row] of bundle.verificationImpact.rows.entries()) assertCountField(row.runCount, `verification-impact.json row ${index}.runCount`);
  for (const [index, row] of bundle.verificationImpact.summaryRows.entries()) assertCountField(row.runCount, `verification-impact.json summary row ${index}.runCount`);
  for (const [index, row] of bundle.toolUsage.summaryRows.entries()) {
    const prefix = `tool-usage.json summary row ${index}`;
    for (const field of ['callCount', 'failureCount', 'executionFailureCount', 'verificationProjectFailureCount', 'probeFailureCount', 'resultIssueCount', 'affectedRunCount'] as const) assertCountField(row[field], `${prefix}.${field}`);
  }
  for (const [index, row] of bundle.treatmentComparison.rows.entries()) assertCountField(row.runCount, `treatment-comparison.json row ${index}.runCount`);
  for (const [index, row] of bundle.timeline.rows.entries()) {
    const prefix = `timeline.json row ${index}`;
    for (const field of ['runCount', 'verificationRunCount', 'toolFailureCount'] as const) assertCountField(row[field], `${prefix}.${field}`);
    assertFiniteNullableNonNegative(row.averageBusyDurationMs, `${prefix}.averageBusyDurationMs`);
    for (const [modelId, count] of Object.entries(row.modelMix)) assertCountField(count, `${prefix}.modelMix.${modelId}`);
  }

  const reviewData = bundle.sessionReviewAnalytics;
  for (const [field, value] of Object.entries(reviewData.diagnostics)) {
    if (field === 'rejectedByReason') continue;
    assertNonNegativeInteger(value, `session-review-analytics.json diagnostics.${field}`);
  }
  for (const [reason, count] of Object.entries(reviewData.diagnostics.rejectedByReason)) assertNonNegativeInteger(count, `session-review-analytics.json diagnostics.rejectedByReason.${reason}`);
  for (const field of ['reviewCount', 'qualityIndexCount', 'notAssessableReviewCount', 'stableIdentityCount', 'identityFallbackCount', 'joinedReviewCount'] as const) assertCountField(reviewData.summary[field], `session-review-analytics.json summary.${field}`);
  assertNullableUnitInterval(reviewData.summary.criterionCoverage, 'session-review-analytics.json summary.criterionCoverage');
  assertNullableUnitInterval(reviewData.summary.externalBlockerRate, 'session-review-analytics.json summary.externalBlockerRate');
  if (reviewData.summary.meanQualityIndexV1 !== null && (!isFiniteNumber(reviewData.summary.meanQualityIndexV1) || reviewData.summary.meanQualityIndexV1 < 0 || reviewData.summary.meanQualityIndexV1 > 100)) throw new Error('session-review-analytics.json summary.meanQualityIndexV1 must be null or a finite number in [0, 100].');
  for (const [index, row] of reviewData.rows.entries()) {
    const prefix = `session-review-analytics.json row ${index}`;
    assertNullableUnitInterval(row.criterionCoverage, `${prefix}.criterionCoverage`);
    assertNullableUnitInterval(row.externalBlockerRate, `${prefix}.externalBlockerRate`);
    const qualityIndex = row.attainment.qualityIndexV1;
    if (qualityIndex !== null && (!isFiniteNumber(qualityIndex) || qualityIndex < 0 || qualityIndex > 100)) throw new Error(`${prefix}.attainment.qualityIndexV1 must be null or a finite number in [0, 100].`);
  }

  for (const [index, row] of bundle.modelLeaderboard.rows.entries()) {
    const prefix = `model-leaderboard.json row ${index}`;
    for (const field of ['runCount', 'attributableRunCount', 'reviewEvidenceCount', 'processEvidenceCount', 'canonicalTaskCount', 'transcriptOnlySessionCount', 'mixedModelExcludedCount', 'mixedTreatmentExcludedCount', 'subagentRunCount', 'v2ReviewCount'] as const) assertCountField(row[field], `${prefix}.${field}`);
    assertFiniteNonNegative(row.effectiveTaskCount, `${prefix}.effectiveTaskCount`);
    assertNonNegativeInteger(row.attributableTaskCount, `${prefix}.attributableTaskCount`);
    for (const field of ['reviewEvidenceMass', 'processEvidenceMass', 'mixedAttributionMass'] as const) assertFiniteNonNegative(row[field], `${prefix}.${field}`);
    for (const [channel, value] of Object.entries({ review: row.reviewChannelScore, process: row.processChannelScore })) assertNullableUnitInterval(value, `${prefix}.${channel}ChannelScore`);
    if (!['review-backed', 'thin-review', 'telemetry-only'].includes(row.evidenceTier)) throw new Error(`${prefix}.evidenceTier is invalid.`);
    if (row.compositeScore !== null) {
      assertUnitInterval(row.scoreInterval80?.lower, `${prefix}.scoreInterval80.lower`);
      assertUnitInterval(row.scoreInterval80?.upper, `${prefix}.scoreInterval80.upper`);
    }
    for (const field of ['compositeScore', 'unadjustedCompositeScore', 'caseMixAdjustment', 'subagentUsageRate', 'avgSubagentTasksPerRun', 'medianTokenEfficiency', 'meanWorkloadIntensity', 'meanTaskComplexity'] as const) assertFiniteNullable(row[field], `${prefix}.${field}`);
    for (const field of ['evidenceWeight', 'reliabilityFactor', 'caseMixOverlap', 'medianDurationMs', 'medianCostUsd', 'meanPreTaskComplexity'] as const) assertFiniteNullableNonNegative(row[field], `${prefix}.${field}`);
    assertNullableUnitInterval(row.scoringCoverage, `${prefix}.scoringCoverage`);
    for (const [band, count] of Object.entries(row.taskComplexityBandCounts)) assertFiniteNonNegative(count, `${prefix}.taskComplexityBandCounts.${band}`);
    for (const [dimensionName, dimension] of Object.entries(row.dimensions)) {
      assertFiniteNullable(dimension.value, `${prefix}.dimensions.${dimensionName}.value`);
      assertFiniteNullable(dimension.lowerBound, `${prefix}.dimensions.${dimensionName}.lowerBound`);
      assertFiniteNullable(dimension.shrunk, `${prefix}.dimensions.${dimensionName}.shrunk`);
      assertCountField(dimension.n, `${prefix}.dimensions.${dimensionName}.n`);
    }
    for (const [providerIndex, provider] of row.providers.entries()) {
      const providerPrefix = `${prefix}.providers[${providerIndex}]`;
      assertCountField(provider.runCount, `${providerPrefix}.runCount`);
      assertCountField(provider.transcriptOnlySessionCount, `${providerPrefix}.transcriptOnlySessionCount`);
      assertFiniteNonNegative(provider.transcriptEvidenceMass, `${providerPrefix}.transcriptEvidenceMass`);
    }
  }
  const leaderboard = bundle.modelLeaderboard;
  for (const [dimension, weight] of Object.entries(leaderboard.weights)) if (!isFiniteNumber(weight)) throw new Error(`model-leaderboard.json weights.${dimension} must be finite, got ${weight}.`);
  for (const [source, weight] of Object.entries(leaderboard.sourceWeights)) assertUnitInterval(weight, `model-leaderboard.json sourceWeights.${source}`);
  if (leaderboard.sourceWeights.review !== 1 || leaderboard.sourceWeights.process !== 0) throw new Error('model-leaderboard.json V2 ranking must be review-only (review=1, process=0).');
  if (Object.values(leaderboard.weights).some((weight) => weight !== 0)) throw new Error('model-leaderboard.json process weights must be zero.');
  assertNonNegativeInteger(leaderboard.minimumEffectiveTasks, 'model-leaderboard.json minimumEffectiveTasks');
  assertUnitInterval(leaderboard.minimumTaskScoringCoverage, 'model-leaderboard.json minimumTaskScoringCoverage');
  assertNonNegativeInteger(leaderboard.caseMix.minimumRatedTasksPerBand, 'model-leaderboard.json caseMix.minimumRatedTasksPerBand');
  assertNonNegativeInteger(leaderboard.caseMix.minimumModelRatedTasksPerBand, 'model-leaderboard.json caseMix.minimumModelRatedTasksPerBand');
  assertFiniteNonNegative(leaderboard.caseMix.minimumTargetBandWeight, 'model-leaderboard.json caseMix.minimumTargetBandWeight');
  assertFiniteNonNegative(leaderboard.caseMix.initialUserMessageCoverage, 'model-leaderboard.json caseMix.initialUserMessageCoverage');
  for (const [band, weight] of Object.entries(leaderboard.caseMix.targetBandWeights)) assertFiniteNonNegative(weight, `model-leaderboard.json caseMix.targetBandWeights.${band}`);

  const pruningSummary = bundle.pruningImpact.summary;
  for (const field of ['totalEvents', 'skillReadCount', 'skillMissCount', 'shadowMissCandidateCount', 'toolRecoveredCount', 'decisionsThatPrunedTools'] as const) assertCountField(pruningSummary[field], `pruning-impact.json summary.${field}`);
  assertFiniteNullable(pruningSummary.pruneRecoveredRate, 'pruning-impact.json summary.pruneRecoveredRate');
  assertFiniteNullable(pruningSummary.skillMissRate, 'pruning-impact.json summary.skillMissRate');
  assertFiniteNullableNonNegative(pruningSummary.medianLlmLatencyMs, 'pruning-impact.json summary.medianLlmLatencyMs');
  for (const [mode, count] of Object.entries(pruningSummary.modeCounts)) assertCountField(count, `pruning-impact.json summary.modeCounts.${mode}`);

  assertCountField(bundle.backendErrors.summary.totalErrorEvents, 'backend-errors.json summary.totalErrorEvents');
  assertCountField(bundle.backendErrors.summary.affectedRunCount, 'backend-errors.json summary.affectedRunCount');
  for (const [index, row] of bundle.backendErrors.summary.byErrorCode.entries()) {
    assertCountField(row.count, `backend-errors.json summary.byErrorCode[${index}].count`);
    assertCountField(row.affectedRunCount, `backend-errors.json summary.byErrorCode[${index}].affectedRunCount`);
  }
  for (const [index, row] of bundle.fileExtensions.summary.entries()) for (const field of ['readCount', 'writeCount', 'editCount', 'totalCount', 'affectedRunCount'] as const) assertCountField(row[field], `file-types.json summary row ${index}.${field}`);
  for (const [index, row] of bundle.tokenThroughput.rows.entries()) {
    const prefix = `token-throughput.json row ${index}`;
    assertFiniteNonNegative(row.generationDurationMs, `${prefix}.generationDurationMs`);
    assertFiniteNonNegative(row.outputTokens, `${prefix}.outputTokens`);
    assertFiniteNonNegative(row.concurrentBusySessions, `${prefix}.concurrentBusySessions`);
    assertFiniteNullableNonNegative(row.providerQueueMs, `${prefix}.providerQueueMs`);
    assertNonNegativeInteger(row.providerQueueAttemptCount, `${prefix}.providerQueueAttemptCount`);
  }
  for (const [index, row] of bundle.retryTiming.rows.entries()) {
    const prefix = `retry-timing.json row ${index}`;
    assertNonNegativeInteger(row.attempt, `${prefix}.attempt`);
    if (row.attempt < 1) throw new Error(`${prefix}.attempt must be at least 1.`);
    assertFiniteNonNegative(row.scheduledDelayMs, `${prefix}.scheduledDelayMs`);
    assertFiniteNullableNonNegative(row.measuredDelayMs, `${prefix}.measuredDelayMs`);
    assertFiniteNullableNonNegative(row.durationMs, `${prefix}.durationMs`);
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
