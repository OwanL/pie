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
  assert.ok(prepared.toolUsage.some((row) => row.toolName === 'subagent'));
  assert.ok(prepared.verificationUsage.some((row) => row.kind === 'test'));
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
    scored: false,
    outcome: undefined,
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
  //          ctx=18200/200000=0.091; interrupted=0, edited=1 → firstAttemptSuccess=false
  const r1 = byId.get('run-001')!;
  assert.ok(Math.abs(r1.tokenEfficiency! - 3200 / 33) < 0.01);
  assert.ok(Math.abs(r1.cacheHitRatio! - 4800 / (4800 + 15200)) < 0.001);
  assert.ok(Math.abs(r1.contextUtilization! - 18200 / 200000) < 0.001);
  assert.equal(r1.firstAttemptSuccess, false);

  // run-003: output=0, lmt=35 → tokenEfficiency=0; both tokens 0 → cacheHitRatio=null
  //          ctx=16800/200000; interrupted=0, edited=0, truncated=0, resolved → firstAttemptSuccess=true
  const r3 = byId.get('run-003')!;
  assert.equal(r3.tokenEfficiency, 0);
  assert.equal(r3.cacheHitRatio, null);
  assert.ok(Math.abs(r3.contextUtilization! - 16800 / 200000) < 0.001);
  assert.equal(r3.firstAttemptSuccess, true);

  // run-004: lmt=0 → tokenEfficiency=null; no outcome → firstAttemptSuccess=false
  const r4 = byId.get('run-004')!;
  assert.equal(r4.tokenEfficiency, null);
  assert.equal(r4.firstAttemptSuccess, false);

  // run-005: cacheRead=0, input=24500 → cacheHitRatio=0; interrupted=1 → firstAttemptSuccess=false
  const r5 = byId.get('run-005')!;
  assert.equal(r5.cacheHitRatio, 0);
  assert.equal(r5.firstAttemptSuccess, false);

  // run-006: contextTokens=null → contextUtilization=null
  const r6 = byId.get('run-006')!;
  assert.equal(r6.contextUtilization, null);
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

test('prepareSourceAnalytics buckets verification counts and falls back to outcome history', async () => {
  const fixture = deepClone(await loadFixture());
  const runWithOutcomeFallback = fixture.completedRuns[0] as any;
  delete runWithOutcomeFallback.outcome;
  runWithOutcomeFallback.verification.totalCount = 1;
  runWithOutcomeFallback.verification.failureCount = 0;
  runWithOutcomeFallback.verification.countsByKind = {
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
  const fallbackOutcome = fixture.outcomes.find((outcome) => outcome.runId === runWithOutcomeFallback.runId)?.outcome;

  assert.equal(byId.get(runWithOutcomeFallback.runId)?.verificationCountBucket, '1');
  assert.equal(byId.get(runWithOutcomeFallback.runId)?.verificationState, 'passing');
  assert.equal(byId.get(runWithOutcomeFallback.runId)?.resolution, fallbackOutcome?.resolution ?? null);
  assert.equal(byId.get(runWithOutcomeFallback.runId)?.satisfaction, fallbackOutcome?.satisfaction ?? null);

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
    scored: false,
    outcome: undefined,
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
