import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import type { PreparedRunRow } from '../scripts/contracts.ts';
import { deepClone, loadFixture } from './helpers.ts';

test('prepareSourceAnalytics builds the derived row model', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);

  assert.equal(prepared.runs.length, 8);
  assert.ok(prepared.runs.every((run) => typeof run.sessionPathHash === 'string' && run.sessionPathHash.length === 16));
  assert.ok(prepared.runs.every((run) => run.initialUserMessageChars === null), 'historical fixture defaults ex-ante prompt size to unknown');
  assert.ok(prepared.toolUsage.some((row) => row.toolName === 'subagent'));
  assert.ok(prepared.verificationUsage.some((row) => row.kind === 'test'));
});

test('prepareSourceAnalytics preserves privacy-safe initial message size', async () => {
  const fixture = deepClone(await loadFixture());
  (fixture.completedRuns[0] as any).initialUserMessageChars = 321;

  const prepared = prepareSourceAnalytics(fixture);
  const run = prepared.runs.find((row) => row.runId === fixture.completedRuns[0]!.runId);
  assert.equal(run?.initialUserMessageChars, 321);
});

test('prepareSourceAnalytics preserves run timing totals and failure-only tool rows', async () => {
  const fixture = deepClone(await loadFixture());
  const run = fixture.completedRuns[0] as any;
  run.toolUsage.totalCount = 2;
  run.toolUsage.timedCallCount = 2;
  run.toolUsage.totalDurationMs = 12_500;
  run.toolUsage.criticalPathDurationMs = 9_000;
  run.toolUsage.countsByName = { bash: 2 };
  run.toolUsage.durationMsByName = { bash: 500, '(unknown)': 12_000 };
  run.toolUsage.failureCountsByName = { '(unknown)': 3 };
  run.toolUsage.resultIssueCountsByName = { '(unknown)': 1 };

  const prepared = prepareSourceAnalytics(fixture);
  const preparedRun = prepared.runs.find((row) => row.runId === run.runId);
  const unknownUsage = prepared.toolUsage.find(
    (row) => row.runId === run.runId && row.toolName === '(unknown)',
  );

  assert.equal(preparedRun?.toolDurationMs, 12_500);
  assert.equal(preparedRun?.criticalPathDurationMs, 9_000);
  assert.equal(preparedRun?.timedToolCallCount, 2);
  assert.deepEqual(unknownUsage && {
    callCount: unknownUsage.callCount,
    failureCount: unknownUsage.failureCount,
    resultIssueCount: unknownUsage.resultIssueCount,
    totalDurationMs: unknownUsage.totalDurationMs,
    timedCallCount: unknownUsage.timedCallCount,
    meanDurationMs: unknownUsage.meanDurationMs,
  }, {
    callCount: 0,
    failureCount: 3,
    resultIssueCount: 1,
    totalDurationMs: 12_000,
    timedCallCount: 0,
    meanDurationMs: null,
  });
});

test('prepareSourceAnalytics computes per-tool mean duration from per-tool timed call counts', async () => {
  const fixture = deepClone(await loadFixture());
  const run = fixture.completedRuns[0] as any;
  run.toolUsage.totalCount = 4;
  run.toolUsage.timedCallCount = 3;
  run.toolUsage.totalDurationMs = 3000;
  run.toolUsage.countsByName = { bash: 4 };
  run.toolUsage.durationMsByName = { bash: 3000 };
  run.toolUsage.timedCallCountsByName = { bash: 3 };

  const prepared = prepareSourceAnalytics(fixture);
  const bashUsage = prepared.toolUsage.find((row) => row.runId === run.runId && row.toolName === 'bash');
  assert.equal(bashUsage?.callCount, 4);
  assert.equal(bashUsage?.timedCallCount, 3);
  assert.equal(bashUsage?.totalDurationMs, 3000);
  assert.equal(bashUsage?.meanDurationMs, 1000);
});

test('prepareSourceAnalytics preserves treatment-change kinds and last-turn usage scalars', async () => {
  const fixture = deepClone(await loadFixture());
  const run = fixture.completedRuns[0] as any;
  run.treatmentChangeKinds = ['model', 'thinking'];
  run.lastTurnUsage = {
    inputTokens: 100,
    outputTokens: 200,
    cacheReadTokens: 50,
    cacheWriteTokens: 10,
    totalTokens: 360,
    reasoningTokens: 80,
  };

  const prepared = prepareSourceAnalytics(fixture);
  const row = prepared.runs.find((r) => r.runId === run.runId)!;
  assert.deepEqual(row.treatmentChangeKinds, ['model', 'thinking']);
  assert.equal(row.lastTurnInputTokens, 100);
  assert.equal(row.lastTurnOutputTokens, 200);
  assert.equal(row.lastTurnCacheReadTokens, 50);
  assert.equal(row.lastTurnCacheWriteTokens, 10);
  assert.equal(row.lastTurnTotalTokens, 360);
  assert.equal(row.lastTurnReasoningTokens, 80);
});

test('prepareSourceAnalytics aggregates skill-pruning prepass tokens without double-counting parent usage', async () => {
  const fixture = deepClone(await loadFixture());
  const run = fixture.completedRuns[0] as any;
  run.auxiliaryLlmUsage = [
    {
      kind: 'skill_pruning_prepass',
      sourceId: 'prune-1',
      occurredAt: run.startedAt,
      modelId: 'openai/pruner',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 3,
      durationMs: 250,
    },
    {
      kind: 'skill_pruning_prepass',
      sourceId: 'prune-2',
      occurredAt: run.startedAt,
      modelId: 'openai/pruner',
      inputTokens: 50,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  ];
  // Parent usage stays unchanged.
  run.inputTokens = 1000;

  const prepared = prepareSourceAnalytics(fixture);
  const row = prepared.runs.find((r) => r.runId === run.runId)!;
  assert.equal(row.skillPruningPrepassInputTokens, 150);
  assert.equal(row.skillPruningPrepassOutputTokens, 30);
  assert.equal(row.skillPruningPrepassCacheReadTokens, 5);
  assert.equal(row.skillPruningPrepassCacheWriteTokens, 3);
  assert.equal(row.skillPruningPrepassDurationMs, 250);
  assert.equal(row.inputTokens, 1000);
});

test('prepareSourceAnalytics preserves per-turn provider in throughput rows', async () => {
  const fixture = deepClone(await loadFixture());
  const run = fixture.completedRuns[0] as any;
  run.provider = 'openai';
  run.turnThroughputSamples = [
    { endedAt: '2026-05-10T14:08:00.000Z', outputTokens: 100, generationDurationMs: 1000, concurrentBusySessions: 1, status: 'completed', providerQueueMs: 75, providerQueueAttemptCount: 2 },
    { endedAt: '2026-05-10T14:09:00.000Z', outputTokens: 200, generationDurationMs: 2000, concurrentBusySessions: 1, status: 'completed', provider: 'anthropic' },
  ];

  const prepared = prepareSourceAnalytics(fixture);
  const rows = prepared.turnThroughput.filter((row) => row.runId === run.runId);
  assert.equal(rows[0]?.provider, 'openai');
  assert.equal(rows[0]?.providerQueueMs, 75);
  assert.equal(rows[0]?.providerQueueAttemptCount, 2);
  assert.equal(rows[1]?.provider, 'anthropic');
  assert.equal(rows[1]?.providerQueueMs, null);
  assert.equal(rows[1]?.providerQueueAttemptCount, 0);
});

test('prepareSourceAnalytics flattens retry timing with run attribution', async () => {
  const fixture = deepClone(await loadFixture());
  const run = fixture.completedRuns[0] as any;
  run.provider = 'openai';

  const prepared = prepareSourceAnalytics(fixture);
  const retry = prepared.retryTiming.find((row) => row.runId === run.runId);
  assert.deepEqual(retry && {
    sourceId: retry.sourceId,
    attempt: retry.attempt,
    scheduledDelayMs: retry.scheduledDelayMs,
    measuredDelayMs: retry.measuredDelayMs,
    durationMs: retry.durationMs,
    modelId: retry.modelId,
    provider: retry.provider,
  }, {
    sourceId: 'run-001-retry-1',
    attempt: 1,
    scheduledDelayMs: 1000,
    measuredDelayMs: 1080,
    durationMs: 4200,
    modelId: 'gpt-4.1',
    provider: 'openai',
  });
});

test('prepareSourceAnalytics exposes tool result issue rows separate from execution failures', async () => {
  const fixture = deepClone(await loadFixture());
  const run = fixture.completedRuns[0] as any;
  run.toolUsage.resultIssueCountsByNameAndKind = {
    bash: { verification_failure: 2, probe_no_match: 1, verification_pending: 1 },
  };
  run.toolUsage.resultIssueCountsByName = { bash: 4 };
  run.toolUsage.resultIssueCount = 4;
  run.toolUsage.resultIssueSamples = [{
    toolName: 'bash',
    resultIssueKind: 'verification_failure',
    exitCode: 1,
    errorExcerpt: 'tests failed',
    verificationKinds: ['test'],
    occurredAt: run.startedAt,
  }];

  const prepared = prepareSourceAnalytics(fixture);
  const rows = prepared.toolResultIssues.filter((row) => row.runId === run.runId);
  assert.equal(rows.length, 3);
  const verificationRow = rows.find((row) => row.resultIssueKind === 'verification_failure')!;
  assert.equal(verificationRow.toolName, 'bash');
  assert.equal(verificationRow.count, 2);
  assert.equal(verificationRow.exitCode, 1);
  assert.equal(verificationRow.errorExcerpt, 'tests failed');
  assert.deepEqual(verificationRow.verificationKinds, ['test']);
  const pendingRow = rows.find((row) => row.resultIssueKind === 'verification_pending')!;
  assert.equal(pendingRow.count, 1);
});

test('prepareSourceAnalytics derives tool result issue rows from legacy samples when counts are missing', async () => {
  const fixture = deepClone(await loadFixture());
  const run = fixture.completedRuns[0] as any;
  run.toolUsage.resultIssueCountsByNameAndKind = {};
  run.toolUsage.resultIssueCountsByName = {};
  run.toolUsage.resultIssueCount = 0;
  run.toolUsage.resultIssueSamples = [{
    toolName: 'read',
    resultIssueKind: 'probe_no_match',
    exitCode: null,
    errorExcerpt: '',
    verificationKinds: [],
    occurredAt: run.startedAt,
  }];

  const prepared = prepareSourceAnalytics(fixture);
  const rows = prepared.toolResultIssues.filter((row) => row.runId === run.runId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.toolName, 'read');
  assert.equal(rows[0]?.resultIssueKind, 'probe_no_match');
  assert.equal(rows[0]?.count, 1);
});

test('prepareSourceAnalytics exposes tool failure reason rows', async () => {
  const fixture = deepClone(await loadFixture());
  const run = fixture.completedRuns[0] as any;
  run.toolUsage.failureCountsByNameAndKind = {
    edit: { invalid_tool_arguments: 2 },
    bash: { shell_command_error: 1 },
  };
  run.toolUsage.failureSamples = [{
    toolName: 'edit',
    failureKind: 'invalid_tool_arguments',
    exitCode: null,
    errorExcerpt: 'Could not find exact text in D:/repo/src/app.ts.',
    verificationKinds: [],
    occurredAt: run.startedAt,
  }];

  const prepared = prepareSourceAnalytics(fixture);

  assert.ok(prepared.toolFailures.some((row) => (
    row.runId === run.runId
    && row.toolName === 'edit'
    && row.failureKind === 'invalid_tool_arguments'
    && row.count === 2
    && row.errorExcerpt === 'Could not find exact text in D:/repo/src/app.ts.'
  )));
  assert.ok(prepared.toolFailures.some((row) => (
    row.runId === run.runId
    && row.toolName === 'bash'
    && row.failureKind === 'shell_command_error'
    && row.count === 1
  )));
});

test('prepareSourceAnalytics normalizes max thinking level alias to xhigh', async () => {
  const fixture = deepClone(await loadFixture());
  (fixture.completedRuns[0] as any).thinkingLevel = 'max';

  const prepared = prepareSourceAnalytics(fixture);
  assert.equal(prepared.runs[0]?.thinkingLevel, 'xhigh');
});

test('prepareSourceAnalytics deduplicates run ids across completed and open snapshots', async () => {
  const fixture = deepClone(await loadFixture());
  const duplicateOpenRun = {
    ...fixture.completedRuns[0],
    status: 'open',
    updatedAt: '2099-01-01T00:00:00.000Z',
  } as any;
  fixture.openRuns.push(duplicateOpenRun);

  const prepared = prepareSourceAnalytics(fixture);
  const duplicateRunId = fixture.completedRuns[0]?.runId;
  const matchingRuns = prepared.runs.filter((run) => run.runId === duplicateRunId);

  assert.equal(matchingRuns.length, 1);
  assert.equal(matchingRuns[0]?.status, fixture.completedRuns[0]?.status);
});

test('prepareSourceAnalytics uses failureCountsByKind fallback when per-tool breakdown is absent', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);

  // run-008 has failures with failureCountsByKind but no failureCountsByNameAndKind
  const unattributedRows = prepared.toolFailures.filter(
    (row) => row.runId === 'run-008' && row.toolName === '(unattributed)',
  );
  assert.ok(unattributedRows.length > 0, 'should emit unattributed rows when per-tool breakdown is absent');

  const missingFile = unattributedRows.find((row) => row.failureKind === 'missing_file_or_path');
  assert.ok(missingFile, 'should classify missing_file_or_path from aggregate counts');
  assert.equal(missingFile.count, 1);

  const nonzeroExit = unattributedRows.find((row) => row.failureKind === 'nonzero_exit');
  assert.ok(nonzeroExit, 'should classify nonzero_exit from aggregate counts');
  assert.equal(nonzeroExit.count, 1);

  // Also verify that classified failures from runs WITH per-tool breakdown are still correct.
  // After the legacy remap, run-002's verification_project_failure is a non-success
  // result issue (verification_failure) surfaced in tool-usage — not an execution
  // tool-failure row.
  const run002FailureRows = prepared.toolFailures.filter((row) => row.runId === 'run-002');
  assert.equal(run002FailureRows.length, 0, 'run-002 has no execution tool failures');
  const run002BashUsage = prepared.toolUsage.find((row) => row.runId === 'run-002' && row.toolName === 'bash');
  assert.equal(run002BashUsage?.failureCount, 0);
  assert.equal(run002BashUsage?.executionFailureCount, 0);
  assert.equal(run002BashUsage?.verificationProjectFailureCount, 1);
  assert.equal(run002BashUsage?.resultIssueCount, 1);
});

test('prepareSourceAnalytics extracts file extension rows from run data', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);

  assert.ok(prepared.fileExtensions.length > 0, 'should produce file extension rows');

  const tsRow = prepared.fileExtensions.find((row) => row.extension === '.ts' && row.runId === 'run-001');
  assert.ok(tsRow, 'should have a .ts extension row for run-001');
  assert.equal(tsRow.readCount, 2);
  assert.equal(tsRow.writeCount, 1);
  assert.equal(tsRow.editCount, 1);
  assert.equal(tsRow.totalCount, 4);

  const mdRow = prepared.fileExtensions.find((row) => row.extension === '.md' && row.runId === 'run-001');
  assert.ok(mdRow, 'should have a .md extension row for run-001');
  assert.equal(mdRow.readCount, 1);
  assert.equal(mdRow.writeCount, 0);
  assert.equal(mdRow.editCount, 0);
  assert.equal(mdRow.totalCount, 1);
});

test('prepareSourceAnalytics computes derived efficiency metrics', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);

  const byId = new Map<string, PreparedRunRow>(prepared.runs.map((r) => [r.runId, r]));

  // run-001: output=3200, lmt=33 → tokenEfficiency=96.97; cacheRead=4800, input=15200 → ratio=0.24
  //          ctx=18200/200000=0.091
  const r1 = byId.get('run-001')!;
  assert.ok(Math.abs(r1.tokenEfficiency! - 3200 / 33) < 0.01);
  assert.ok(Math.abs(r1.cacheHitRatio! - 4800 / (4800 + 15200)) < 0.001);
  assert.ok(Math.abs(r1.contextUtilization! - 18200 / 200000) < 0.001);

  // run-003: no reported token usage despite lmt=35 → tokenEfficiency=null; cacheHitRatio=null
  //          ctx=16800/200000
  const r3 = byId.get('run-003')!;
  assert.equal(r3.tokenEfficiency, null);
  assert.equal(r3.cacheHitRatio, null);
  assert.ok(Math.abs(r3.contextUtilization! - 16800 / 200000) < 0.001);

  // run-004: lmt=0 → tokenEfficiency=null
  const r4 = byId.get('run-004')!;
  assert.equal(r4.tokenEfficiency, null);

  // run-005: cacheRead=0, input=24500 → cacheHitRatio=0
  const r5 = byId.get('run-005')!;
  assert.equal(r5.cacheHitRatio, 0);

  // run-006: contextTokens=null → contextUtilization=null
  const r6 = byId.get('run-006')!;
  assert.equal(r6.contextUtilization, null);
});

test('prepareSourceAnalytics distinguishes missing token telemetry from reported free usage', async () => {
  const fixture = deepClone(await loadFixture());
  const noUsage = fixture.completedRuns[0] as any;
  const reportedFree = fixture.completedRuns[1] as any;
  const legacyPositiveTotals = fixture.completedRuns[2] as any;

  for (const run of [noUsage, reportedFree, legacyPositiveTotals]) {
    run.modelId = 'mistral-7b-pi:latest';
    run.toolUsage.subagentCallCount = 0;
    run.toolUsage.subagentInputTokens = 0;
    run.toolUsage.subagentOutputTokens = 0;
    run.toolUsage.subagentCacheReadTokens = 0;
    run.toolUsage.subagentCacheWriteTokens = 0;
    run.inputTokens = 0;
    run.outputTokens = 0;
    run.cacheReadTokens = 0;
    run.cacheWriteTokens = 0;
    run.tokenReportedTurnCount = 0;
    run.fileMutation.lineAdditions = 10;
    run.fileMutation.lineDeletions = 0;
    run.fileMutation.lineModifications = 0;
  }
  reportedFree.tokenReportedTurnCount = 1;
  legacyPositiveTotals.outputTokens = 100;

  const byId = new Map(prepareSourceAnalytics(fixture).runs.map((run) => [run.runId, run]));
  const noUsageRow = byId.get(noUsage.runId)!;
  assert.equal(noUsageRow.estimatedCostUsd, null);
  assert.equal(noUsageRow.totalEstimatedCostUsd, null);
  assert.equal(noUsageRow.tokenEfficiency, null);

  const freeRow = byId.get(reportedFree.runId)!;
  assert.equal(freeRow.estimatedCostUsd, 0);
  assert.equal(freeRow.subagentEstimatedCostUsd, 0);
  assert.equal(freeRow.totalEstimatedCostUsd, 0);
  assert.equal(freeRow.tokenEfficiency, 0);

  const legacyRow = byId.get(legacyPositiveTotals.runId)!;
  assert.equal(legacyRow.estimatedCostUsd, 0, 'positive parent totals establish reported usage even when the turn counter is absent');
  assert.equal(legacyRow.totalEstimatedCostUsd, 0);
  assert.equal(legacyRow.tokenEfficiency, 10);
});

test('prepareSourceAnalytics prices canonical subagent usage by child model with safe remainder handling', async () => {
  const fixture = deepClone(await loadFixture());
  const base = fixture.completedRuns[0] as any;
  fixture.completedRuns = [];
  fixture.openRuns = [];

  const makeRun = (runId: string, parentModelId: string) => {
    const run = deepClone(base) as any;
    run.runId = runId;
    run.taskGroupId = `${runId}-task`;
    run.modelId = parentModelId;
    run.inputTokens = 0;
    run.outputTokens = 0;
    run.cacheReadTokens = 0;
    run.cacheWriteTokens = 0;
    run.tokenReportedTurnCount = 1;
    run.toolUsage.subagentCallCount = 1;
    run.toolUsage.subagentInputTokens = 0;
    run.toolUsage.subagentOutputTokens = 0;
    run.toolUsage.subagentCacheReadTokens = 0;
    run.toolUsage.subagentCacheWriteTokens = 0;
    run.auxiliaryLlmUsage = [];
    return run;
  };
  const sample = (sourceId: string, modelId: string, inputTokens: number) => ({
    kind: 'subagent' as const,
    sourceId,
    occurredAt: base.startedAt,
    modelId,
    inputTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });

  const crossModel = makeRun('subagent-cross-model', 'mistral-7b-pi:latest');
  crossModel.toolUsage.subagentInputTokens = 1_000_000;
  crossModel.auxiliaryLlmUsage = [sample('cross', 'glm-5.2:cloud', 1_000_000)];

  const unknownPricing = makeRun('subagent-unknown-pricing', 'mistral-7b-pi:latest');
  unknownPricing.toolUsage.subagentInputTokens = 1_000;
  unknownPricing.auxiliaryLlmUsage = [sample('unknown', 'not-in-pricing-catalog', 1_000)];

  const unreported = makeRun('subagent-unreported', 'mistral-7b-pi:latest');

  const free = makeRun('subagent-free', 'glm-5.2:cloud');
  free.toolUsage.subagentInputTokens = 1_000_000;
  free.auxiliaryLlmUsage = [sample('free', 'mistral-7b-pi:latest', 1_000_000)];

  const remainder = makeRun('subagent-remainder', 'glm-5.2:cloud');
  remainder.toolUsage.subagentInputTokens = 2_000_000;
  remainder.auxiliaryLlmUsage = [
    sample('duplicate-source', 'mistral-7b-pi:latest', 1_000_000),
    sample('duplicate-source', 'mistral-7b-pi:latest', 1_000_000),
  ];

  fixture.completedRuns.push(crossModel, unknownPricing, unreported, free, remainder);
  const byId = new Map(prepareSourceAnalytics(fixture).runs.map((run) => [run.runId, run]));

  assert.equal(byId.get(crossModel.runId)!.subagentEstimatedCostUsd, 1.12, 'child usage uses the child model rate, not the free parent rate');
  assert.equal(byId.get(crossModel.runId)!.totalEstimatedCostUsd, 1.12);
  assert.equal(byId.get(unknownPricing.runId)!.subagentEstimatedCostUsd, null);
  assert.equal(byId.get(unknownPricing.runId)!.totalEstimatedCostUsd, null, 'unknown child pricing makes the complete total unknown');
  assert.equal(byId.get(unreported.runId)!.subagentEstimatedCostUsd, null, 'calls without canonical token usage are unknown');
  assert.equal(byId.get(unreported.runId)!.totalEstimatedCostUsd, null);
  assert.equal(byId.get(free.runId)!.subagentEstimatedCostUsd, 0, 'reported usage on a known free child remains a priced $0');
  assert.equal(byId.get(free.runId)!.totalEstimatedCostUsd, 0);
  assert.equal(byId.get(remainder.runId)!.subagentEstimatedCostUsd, 1.12, 'duplicate attribution is counted once and the positive remainder uses the parent rate');
  assert.equal(byId.get(remainder.runId)!.totalEstimatedCostUsd, 1.12);
});

test('prepareSourceAnalytics flattens functional settings into fs* columns', async () => {
  const fixture = deepClone(await loadFixture());
  const trackedRun = fixture.completedRuns[0] as any;
  trackedRun.functionalSettings = {
    subagentAlwaysParentModel: true,
    pruningMode: 'shadow',
    extensionToggles: { subagent: true, safeguard: false },
    toolResultPruningEnabled: true,
    toolResultPruningProfile: 'security',
  };
  const offRun = fixture.completedRuns[1] as any;
  offRun.functionalSettings = {
    subagentAlwaysParentModel: false,
    pruningMode: 'off',
    extensionToggles: {},
    toolResultPruningEnabled: false,
    toolResultPruningProfile: 'default',
  };

  const prepared = prepareSourceAnalytics(fixture);
  const byId = new Map(prepared.runs.map((r) => [r.runId, r]));

  const trackedRow = byId.get(trackedRun.runId)!;
  assert.equal(trackedRow.fsSubagentAlwaysParentModel, true);
  assert.equal(trackedRow.fsPruningMode, 'shadow');
  assert.equal(trackedRow.fsPruningEnabled, true);
  assert.deepEqual(trackedRow.fsExtensionToggles, { subagent: true, safeguard: false });
  assert.equal(trackedRow.fsToolResultPruningEnabled, true);
  assert.equal(trackedRow.fsToolResultPruningProfile, 'security');

  const offRow = byId.get(offRun.runId)!;
  assert.equal(offRow.fsSubagentAlwaysParentModel, false);
  assert.equal(offRow.fsPruningMode, 'off');
  assert.equal(offRow.fsPruningEnabled, false);
  assert.deepEqual(offRow.fsExtensionToggles, {});
  assert.equal(offRow.fsToolResultPruningEnabled, false);
  assert.equal(offRow.fsToolResultPruningProfile, 'default');

  // Runs recorded before tracking existed flatten to null / empty.
  const untrackedRun = fixture.completedRuns[2] as any;
  const untrackedRow = byId.get(untrackedRun.runId)!;
  assert.equal(untrackedRow.fsSubagentAlwaysParentModel, null);
  assert.equal(untrackedRow.fsPruningMode, null);
  assert.equal(untrackedRow.fsPruningEnabled, null);
  assert.deepEqual(untrackedRow.fsExtensionToggles, {});
  assert.equal(untrackedRow.fsToolResultPruningEnabled, null);
  assert.equal(untrackedRow.fsToolResultPruningProfile, null);
});

test('prepareSourceAnalytics flattens per-turn throughput samples and precomputes tokensPerSecond', async () => {
  const fixture = deepClone(await loadFixture());
  const run = fixture.completedRuns[0] as any;
  run.turnThroughputSamples = [
    { endedAt: '2026-05-10T14:08:00.000Z', outputTokens: 1800, generationDurationMs: 28000, concurrentBusySessions: 1, status: 'completed' },
    { endedAt: '2026-05-10T14:12:00.000Z', outputTokens: 1400, generationDurationMs: 33000, concurrentBusySessions: 3, status: 'completed' },
    { endedAt: '2026-05-10T14:13:00.000Z', outputTokens: 0, generationDurationMs: 1200, concurrentBusySessions: 3, status: 'error' },
  ];

  const prepared = prepareSourceAnalytics(fixture);
  const rows = prepared.turnThroughput.filter((row) => row.runId === run.runId);

  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.tokensPerSecond, Math.round((1800 / 28000) * 1000 * 100) / 100);
  assert.equal(rows[0]?.concurrentBusySessions, 1);
  assert.equal(rows[0]?.status, 'completed');
  assert.equal(rows[1]?.concurrentBusySessions, 3);
  // Errored turns are retained but excluded from the throughput distribution.
  assert.equal(rows[2]?.status, 'error');
  assert.equal(rows[2]?.tokensPerSecond, null);
});

test('prepareSourceAnalytics attributes per-turn modelId from the sample, falling back to the run model', async () => {
  const fixture = deepClone(await loadFixture());
  const run = fixture.completedRuns[0] as any;
  run.modelId = 'gpt-4.1';
  run.turnThroughputSamples = [
    { endedAt: '2026-05-10T14:08:00.000Z', outputTokens: 1800, generationDurationMs: 28000, concurrentBusySessions: 1, status: 'completed' },
    { endedAt: '2026-05-10T14:09:00.000Z', outputTokens: 900, generationDurationMs: 14000, concurrentBusySessions: 1, status: 'completed', modelId: 'claude-sonnet-4.5' },
    { endedAt: '2026-05-10T14:10:00.000Z', outputTokens: 500, generationDurationMs: 9000, concurrentBusySessions: 2, status: 'completed', modelId: '   ' },
  ];

  const prepared = prepareSourceAnalytics(fixture);
  const rows = prepared.turnThroughput.filter((row) => row.runId === run.runId);

  assert.equal(rows.length, 3);
  // No sample.modelId → falls back to the parent run's model and family.
  assert.equal(rows[0]?.modelId, 'gpt-4.1');
  assert.equal(rows[0]?.modelFamily, 'gpt-4.1');
  // sample.modelId present → per-sample (child) attribution wins, even when it
  // differs from the parent run's model (e.g. a sub-agent or mid-run swap).
  assert.equal(rows[1]?.modelId, 'claude-sonnet-4.5');
  assert.equal(rows[1]?.modelFamily, 'claude-sonnet-4.5');
  // A blank sample.modelId normalizes to null → falls back to the run model.
  assert.equal(rows[2]?.modelId, 'gpt-4.1');
  assert.equal(rows[2]?.modelFamily, 'gpt-4.1');
});

test('prepareSourceAnalytics sets tokenEfficiency to null when lineMutationTotal is zero', async () => {
  const fixture = deepClone(await loadFixture());
  (fixture.completedRuns[0] as any).fileMutation.lineAdditions = 0;
  (fixture.completedRuns[0] as any).fileMutation.lineDeletions = 0;
  (fixture.completedRuns[0] as any).fileMutation.lineModifications = 0;

  const prepared = prepareSourceAnalytics(fixture);
  const r = prepared.runs[0]!;
  assert.equal(r.tokenEfficiency, null);
  // cacheHitRatio unaffected by line mutations
  assert.ok(r.cacheHitRatio !== null);
});

test('prepareSourceAnalytics buckets verification counts', async () => {
  const fixture = deepClone(await loadFixture());
  const runWithPassingVerification = fixture.completedRuns[0] as any;
  runWithPassingVerification.verification.totalCount = 1;
  runWithPassingVerification.verification.failureCount = 0;
  runWithPassingVerification.verification.countsByKind = {
    test: 1,
    build: 0,
    lint: 0,
    typecheck: 0,
    format: 0,
    other: 0,
  };

  const runWithFailingVerification = fixture.completedRuns[1] as any;
  runWithFailingVerification.verification.totalCount = 2;
  runWithFailingVerification.verification.failureCount = 1;
  runWithFailingVerification.verification.countsByKind = {
    test: 2,
    build: 0,
    lint: 0,
    typecheck: 0,
    format: 0,
    other: 0,
  };

  const runWithManyVerifications = fixture.completedRuns[2] as any;
  runWithManyVerifications.verification.totalCount = 4;
  runWithManyVerifications.verification.failureCount = 0;
  runWithManyVerifications.verification.countsByKind = {
    test: 4,
    build: 0,
    lint: 0,
    typecheck: 0,
    format: 0,
    other: 0,
  };

  const prepared = prepareSourceAnalytics(fixture);
  const byId = new Map<string, PreparedRunRow>(prepared.runs.map((run) => [run.runId, run]));
  assert.equal(byId.get(runWithPassingVerification.runId)?.verificationCountBucket, '1');
  assert.equal(byId.get(runWithPassingVerification.runId)?.verificationState, 'passing');

  assert.equal(byId.get(runWithFailingVerification.runId)?.verificationCountBucket, '2-3');
  assert.equal(byId.get(runWithFailingVerification.runId)?.verificationState, 'failing');

  assert.equal(byId.get(runWithManyVerifications.runId)?.verificationCountBucket, '4+');
  assert.equal(byId.get(runWithManyVerifications.runId)?.verificationState, 'passing');
});

test('prepareSourceAnalytics prefers newer same-status duplicates and later ties', async () => {
  const fixture = deepClone(await loadFixture());
  const template = deepClone((fixture.openRuns[0] ?? fixture.completedRuns[0]) as any);
  const duplicateBase = {
    ...template,
    runId: 'duplicate-open-run',
    taskGroupId: 'duplicate-open-task',
    status: 'open',
    finalizationReason: undefined,
    finalizedAt: undefined,
    updatedAt: 'not-a-timestamp',
    assistantTurnCount: 7,
  };
  const newerDuplicate = {
    ...duplicateBase,
    updatedAt: '2026-05-12T00:00:00.000Z',
    assistantTurnCount: 11,
  };
  const laterTieDuplicate = {
    ...newerDuplicate,
    assistantTurnCount: 19,
  };

  fixture.openRuns.push(duplicateBase, newerDuplicate, laterTieDuplicate);

  const prepared = prepareSourceAnalytics(fixture);
  const matchingRuns = prepared.runs.filter((run) => run.runId === duplicateBase.runId);

  assert.equal(matchingRuns.length, 1);
  assert.equal(matchingRuns[0]?.assistantTurnCount, 19, 'later identical-status duplicate should win ties');
  assert.equal(matchingRuns[0]?.updatedAt, '2026-05-12T00:00:00.000Z');
});

test('prepareSourceAnalytics computes execution failures and unknown fallback failures', async () => {
  const fixture = deepClone(await loadFixture());
  const classifiedRun = fixture.completedRuns[0] as any;
  classifiedRun.toolUsage.countsByName = { bash: 5, edit: 2 };
  classifiedRun.toolUsage.failureCountsByName = { bash: 2, edit: 0 };
  classifiedRun.toolUsage.failureCountsByNameAndKind = {
    bash: { shell_command_error: 2 },
  };
  classifiedRun.toolUsage.resultIssueCountsByNameAndKind = {
    bash: { verification_failure: 2, probe_no_match: 1 },
  };
  classifiedRun.toolUsage.resultIssueCountsByName = { bash: 3 };
  classifiedRun.toolUsage.resultIssueCount = 3;

  const fallbackRun = fixture.completedRuns[1] as any;
  fallbackRun.toolUsage.failureCount = 3;
  fallbackRun.toolUsage.failureCountsByName = { bash: 2, read: 1 };
  fallbackRun.toolUsage.failureCountsByKind = { timeout: 1 };
  fallbackRun.toolUsage.failureCountsByNameAndKind = {};
  fallbackRun.toolUsage.failureSamples = [];

  const prepared = prepareSourceAnalytics(fixture);
  const classifiedBashUsage = prepared.toolUsage.find((row) => row.runId === classifiedRun.runId && row.toolName === 'bash');
  const classifiedEditUsage = prepared.toolUsage.find((row) => row.runId === classifiedRun.runId && row.toolName === 'edit');
  const fallbackUnknownRows = prepared.toolFailures
    .filter((row) => row.runId === fallbackRun.runId && row.failureKind === 'unknown')
    .map((row) => [row.toolName, row.count] as const)
    .sort(([left], [right]) => left.localeCompare(right));

  assert.equal(classifiedBashUsage?.failureCount, 2);
  assert.equal(classifiedBashUsage?.executionFailureCount, 2);
  assert.equal(classifiedBashUsage?.verificationProjectFailureCount, 2);
  assert.equal(classifiedBashUsage?.probeFailureCount, 1);
  assert.equal(classifiedBashUsage?.resultIssueCount, 3);
  assert.equal(classifiedEditUsage?.executionFailureCount, 0);
  assert.equal(classifiedEditUsage?.resultIssueCount, 0);
  // Legacy branch has no per-tool classification: the unclassified remainder
  // (failureCount - classifiedTotal = 3 - 1 = 2) is emitted once at the run level,
  // not per-tool, so failures already counted by kind are not double-counted.
  assert.deepEqual(fallbackUnknownRows, [['(unattributed)', 2]]);
});

test('prepareSourceAnalytics legacy tool-failure branch does not double-count failures', async () => {
  const fixture = deepClone(await loadFixture());
  const fallbackRun = fixture.completedRuns[1] as any;
  fallbackRun.toolUsage.failureCount = 5;
  fallbackRun.toolUsage.failureCountsByName = { bash: 3, read: 2 };
  fallbackRun.toolUsage.failureCountsByKind = { timeout: 2, missing_file_or_path: 1 };
  fallbackRun.toolUsage.failureCountsByNameAndKind = {};
  fallbackRun.toolUsage.failureSamples = [];

  const prepared = prepareSourceAnalytics(fixture);
  const fallbackRows = prepared.toolFailures.filter((row) => row.runId === fallbackRun.runId);

  const totalEmitted = fallbackRows.reduce((sum, row) => sum + row.count, 0);
  assert.equal(totalEmitted, 5, 'total emitted counts should equal run-level failureCount');

  const classifiedTotal = fallbackRows
    .filter((row) => row.toolName === '(unattributed)' && row.failureKind !== 'unknown')
    .reduce((sum, row) => sum + row.count, 0);
  assert.equal(classifiedTotal, 3, 'classified by-kind total should be emitted');

  const unknownRow = fallbackRows.find((row) => row.toolName === '(unattributed)' && row.failureKind === 'unknown');
  assert.ok(unknownRow, 'a single unknown row should cover the unclassified remainder');
  assert.equal(unknownRow.count, 2, 'unknown row should be failureCount - classifiedTotal');

  const perToolUnknownRows = fallbackRows.filter((row) => row.toolName !== '(unattributed)' && row.failureKind === 'unknown');
  assert.equal(perToolUnknownRows.length, 0, 'legacy branch should not emit per-tool unknown rows');
});

test('prepareSourceAnalytics trims backend errors and skips empty file-extension rollups', async () => {
  const fixture = deepClone(await loadFixture());
  const runWithBlankBackendErrors = fixture.completedRuns[0] as any;
  runWithBlankBackendErrors.backendErrorCodes = [' ECONNRESET ', ' ', 'ECONNRESET', '\t'];
  runWithBlankBackendErrors.fileExtensions = {
    readCountsByExtension: {},
    writeCountsByExtension: {},
    editCountsByExtension: {},
  };

  const runWithoutFileExtensions = fixture.completedRuns[1] as any;
  runWithoutFileExtensions.fileExtensions = null;

  const prepared = prepareSourceAnalytics(fixture);
  const backendRows = prepared.backendErrors
    .filter((row) => row.runId === runWithBlankBackendErrors.runId)
    .map((row) => [row.errorCode, row.count] as const);

  assert.deepEqual(backendRows, [['ECONNRESET', 2]]);
  assert.ok(!prepared.fileExtensions.some((row) => row.runId === runWithBlankBackendErrors.runId));
  assert.ok(!prepared.fileExtensions.some((row) => row.runId === runWithoutFileExtensions.runId));
});

test('prepareSourceAnalytics normalizes all supported thinking levels and blank values', async () => {
  const fixture = deepClone(await loadFixture());
  const targetRuns = [...fixture.completedRuns.slice(0, 7), fixture.openRuns[0]!];
  const expectedLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', '   '] as const;

  expectedLevels.forEach((level, index) => {
    (targetRuns[index] as any).thinkingLevel = level;
  });

  const prepared = prepareSourceAnalytics(fixture);
  const byId = new Map<string, PreparedRunRow>(prepared.runs.map((run) => [run.runId, run]));

  assert.equal(byId.get(targetRuns[0]!.runId)?.thinkingLevel, 'off');
  assert.equal(byId.get(targetRuns[1]!.runId)?.thinkingLevel, 'minimal');
  assert.equal(byId.get(targetRuns[2]!.runId)?.thinkingLevel, 'low');
  assert.equal(byId.get(targetRuns[3]!.runId)?.thinkingLevel, 'medium');
  assert.equal(byId.get(targetRuns[4]!.runId)?.thinkingLevel, 'high');
  assert.equal(byId.get(targetRuns[5]!.runId)?.thinkingLevel, 'xhigh');
  assert.equal(byId.get(targetRuns[6]!.runId)?.thinkingLevel, 'xhigh');
  assert.equal(byId.get(targetRuns[7]!.runId)?.thinkingLevel, null);
});

test('prepareSourceAnalytics derives editRevisitRate (file churn) from per-file edit counts', async () => {
  const fixture = deepClone(await loadFixture());

  // run-001: 5 edits across 2 distinct files → 3 revisits → rate 3/5 = 0.6
  const fm1 = (fixture.completedRuns[0] as any).fileMutation;
  fm1.editCount = 5;
  fm1.editCountsByFile = { aaa: 3, bbb: 2 };

  // run-002: single edit to one file → 0 revisits → rate 0
  const fm2 = (fixture.completedRuns[1] as any).fileMutation;
  fm2.editCountsByFile = { ccc: 1 };

  // run-003: editCount > 0 but no per-file attribution (legacy run) → null
  const fm3 = (fixture.completedRuns[2] as any).fileMutation;
  fm3.editCount = 4;
  delete fm3.editCountsByFile;

  const prepared = prepareSourceAnalytics(fixture);
  const byId = new Map<string, PreparedRunRow>(prepared.runs.map((r) => [r.runId, r]));

  assert.ok(Math.abs(byId.get('run-001')!.editRevisitRate! - 0.6) < 1e-3, '5 edits / 2 files → 0.6 revisit rate');
  assert.equal(byId.get('run-002')!.editRevisitRate, 0, 'single edit to one file → 0 churn');
  assert.equal(byId.get('run-003')!.editRevisitRate, null, 'legacy run without per-file data → null');
});

test('prepareSourceAnalytics derives filesReviewedCount and readRevisitRate (re-read churn) from per-file read counts', async () => {
  const fixture = deepClone(await loadFixture());

  // run-001: 5 reads across 2 distinct files → 3 re-reads → rate 3/5 = 0.6, 2 files reviewed
  const fm1 = (fixture.completedRuns[0] as any).fileMutation;
  fm1.readCountsByFile = { aaa: 3, bbb: 2 };

  // run-002: single read of one file → 0 re-reads → rate 0, 1 file reviewed
  const fm2 = (fixture.completedRuns[1] as any).fileMutation;
  fm2.readCountsByFile = { ccc: 1 };

  // run-003: reads occurred but no per-file attribution (legacy run) → rate null, 0 files
  const fm3 = (fixture.completedRuns[2] as any).fileMutation;
  delete fm3.readCountsByFile;

  const prepared = prepareSourceAnalytics(fixture);
  const byId = new Map<string, PreparedRunRow>(prepared.runs.map((r) => [r.runId, r]));

  assert.equal(byId.get('run-001')!.filesReviewedCount, 2, '5 reads / 2 files → 2 distinct files reviewed');
  assert.ok(Math.abs(byId.get('run-001')!.readRevisitRate! - 0.6) < 1e-3, '5 reads / 2 files → 0.6 re-read rate');
  assert.equal(byId.get('run-002')!.filesReviewedCount, 1, 'single read → 1 file reviewed');
  assert.equal(byId.get('run-002')!.readRevisitRate, 0, 'single read of one file → 0 churn');
  assert.equal(byId.get('run-003')!.filesReviewedCount, 0, 'legacy run without per-file data → 0 files');
  assert.equal(byId.get('run-003')!.readRevisitRate, null, 'legacy run without per-file data → null');
});
