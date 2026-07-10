import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';

import { RUN_ANALYTICS_SCHEMA_VERSION, type RunSnapshot, type SourceAnalyticsPayload } from '../scripts/contracts.ts';
import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import {
  coerceOutcomeHistoryEntry,
  coerceRunSnapshot,
  coerceSourceAnalyticsPayload,
  DEFAULT_FIXTURE_PATH,
  loadSourceAnalytics,
  readSourceAnalyticsPayload,
} from '../scripts/source.ts';
import { deepClone, loadFixture, withTempDir } from './helpers.ts';

test('readSourceAnalyticsPayload loads the committed fixture', async () => {
  const fixture = await loadFixture();
  assert.equal(fixture.schemaVersion, RUN_ANALYTICS_SCHEMA_VERSION);
  assert.equal(fixture.completedRuns.length, 7);
  assert.equal(fixture.openRuns.length, 2);
  assert.equal(fixture.outcomes.length, 5);
});

test('readSourceAnalyticsPayload rejects an invalid schema version', async () => {
  await withTempDir(async (dir) => {
    const invalidPayload: SourceAnalyticsPayload = {
      ...(await loadFixture()),
      schemaVersion: 999,
    };
    const filePath = path.join(dir, 'invalid.json');
    await fs.writeFile(filePath, JSON.stringify(invalidPayload), 'utf8');

    await assert.rejects(
      async () => await readSourceAnalyticsPayload(filePath),
      /Unsupported schemaVersion/,
    );
  });
});

test('loadSourceAnalytics can query a storage-dir run store', async () => {
  await withTempDir(async (dir) => {
    const fixture = await loadFixture();
    await fs.mkdir(dir, { recursive: true });
    const completedRuns = fixture.completedRuns.slice(0, 2);
    const openRun = fixture.openRuns[0];

    await fs.writeFile(
      path.join(dir, 'run-snapshots.jsonl'),
      completedRuns.map((run) => JSON.stringify({
        schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
        kind: 'run_snapshot',
        recordedAt: run.updatedAt,
        run,
      })).join('\n') + '\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(dir, 'outcome-history.jsonl'),
      fixture.outcomes.slice(0, 2).map((entry) => JSON.stringify(entry)).join('\n') + '\n',
      'utf8',
    );
    await fs.writeFile(path.join(dir, 'open-runs.gen'), 'a', 'utf8');
    await fs.writeFile(
      path.join(dir, 'open-runs.a.json'),
      JSON.stringify({
        schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
        seq: 1,
        sessions: {
          [openRun.sessionPath]: {
            currentRun: openRun,
            lastRun: null,
            nextTaskIntent: null,
            queuedUnsupportedInputCount: 0,
            busyStartedAt: null,
          },
        },
      }, null, 2),
      'utf8',
    );

    const loaded = await loadSourceAnalytics({ storageDir: dir });
    assert.equal(loaded.sourceKind, 'storage-dir');
    assert.equal(loaded.source.completedRuns.length, 2);
    assert.equal(loaded.source.openRuns.length, 1);
    assert.equal(loaded.source.outcomes.length, 2);
    assert.equal(loaded.source.workspaceKey, path.basename(dir));
  });
});

async function writeRunSnapshotsJsonl(dir: string, runs: RunSnapshot[]): Promise<void> {
  const lines = runs.map((run) => JSON.stringify({
    schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
    kind: 'run_snapshot',
    recordedAt: run.updatedAt,
    run,
  }));
  await fs.writeFile(path.join(dir, 'run-snapshots.jsonl'), `${lines.join('\n')}\n`, 'utf8');
}

test('loadSourceAnalytics aggregates every run store under an outcomes root', async () => {
  await withTempDir(async (outcomesRoot) => {
    const fixture = await loadFixture();
    // Two distinct workspace-hash stores under the outcomes root.
    const storeA = path.join(outcomesRoot, 'aaaaaaaaaaaaaaaa');
    const storeB = path.join(outcomesRoot, 'bbbbbbbbbbbbbbbb');
    await fs.mkdir(storeA, { recursive: true });
    await fs.mkdir(storeB, { recursive: true });

    const runsA = fixture.completedRuns.slice(0, 3);
    const runsB = fixture.completedRuns.slice(3, 6);
    await writeRunSnapshotsJsonl(storeA, runsA);
    await writeRunSnapshotsJsonl(storeB, runsB);
    // outcome-history.jsonl presence is what makes a dir qualify as a store.
    await fs.writeFile(path.join(storeA, 'outcome-history.jsonl'), '', 'utf8');
    await fs.writeFile(path.join(storeB, 'outcome-history.jsonl'), '', 'utf8');

    const loaded = await loadSourceAnalytics({ outcomesRoot });
    assert.equal(loaded.sourceKind, 'all-stores');
    assert.equal(loaded.sourcePath, outcomesRoot);
    assert.equal(loaded.source.workspaceKey, 'all');
    // Merged source carries runs from both stores (dedup happens later in prepare).
    assert.equal(loaded.source.completedRuns.length, runsA.length + runsB.length);
  });
});

test('loadSourceAnalytics dedupes the same runId across stores via prepare', async () => {
  await withTempDir(async (outcomesRoot) => {
    const fixture = await loadFixture();
    const storeA = path.join(outcomesRoot, 'aaaaaaaaaaaaaaaa');
    const storeB = path.join(outcomesRoot, 'bbbbbbbbbbbbbbbb');
    await fs.mkdir(storeA, { recursive: true });
    await fs.mkdir(storeB, { recursive: true });

    // Same run written to both stores (e.g. a run whose analytics landed in two places).
    const sharedRun = fixture.completedRuns[0]!;
    await writeRunSnapshotsJsonl(storeA, [sharedRun]);
    await writeRunSnapshotsJsonl(storeB, [sharedRun]);
    await fs.writeFile(path.join(storeA, 'outcome-history.jsonl'), '', 'utf8');
    await fs.writeFile(path.join(storeB, 'outcome-history.jsonl'), '', 'utf8');

    const loaded = await loadSourceAnalytics({ outcomesRoot });
    assert.equal(loaded.source.completedRuns.length, 2); // merged before dedup
    const prepared = prepareSourceAnalytics(loaded.source);
    assert.equal(prepared.runs.length, 1); // deduped to a single run
  });
});

test('loadSourceAnalytics falls back to the fixture when no run stores exist', async () => {
  await withTempDir(async (outcomesRoot) => {
    const loaded = await loadSourceAnalytics({ outcomesRoot });
    assert.equal(loaded.sourceKind, 'fixture');
    assert.equal(loaded.sourcePath, DEFAULT_FIXTURE_PATH);
  });
});

test('missing optional fields are coerced safely', async () => {
  await withTempDir(async (dir) => {
    const fixture = deepClone(await loadFixture());
    delete (fixture.completedRuns[0] as Partial<typeof fixture.completedRuns[0]>).thinkingLevel;
    delete (fixture.completedRuns[0] as Partial<typeof fixture.completedRuns[0]>).analyticsFactors;
    const filePath = path.join(dir, 'missing-optionals.json');
    await fs.writeFile(filePath, JSON.stringify(fixture), 'utf8');

    const loaded = await readSourceAnalyticsPayload(filePath);
    assert.equal(loaded.completedRuns[0]?.thinkingLevel, undefined);
    assert.equal(loaded.completedRuns[0]?.analyticsFactors, null);
  });
});

test('max thinking level alias is accepted and normalized to xhigh', async () => {
  await withTempDir(async (dir) => {
    const fixture = deepClone(await loadFixture());
    (fixture.completedRuns[0] as any).thinkingLevel = 'max';
    const filePath = path.join(dir, 'max-thinking-level.json');
    await fs.writeFile(filePath, JSON.stringify(fixture), 'utf8');

    const loaded = await readSourceAnalyticsPayload(filePath);
    assert.equal(loaded.completedRuns[0]?.thinkingLevel, 'xhigh');
  });
});

test('coerceRunSnapshot rejects snapshots with invalid embedded outcomes', async () => {
  const fixture = await loadFixture();
  const run = deepClone(fixture.completedRuns[0]) as any;
  run.outcome = { resolution: 'invalid', satisfaction: 3 };

  assert.equal(coerceRunSnapshot(run), null);
});

test('coerceRunSnapshot sanitizes nested rollups and optional fields', async () => {
  const fixture = await loadFixture();
  const run = deepClone(fixture.completedRuns[0]) as any;

  run.finalizationReason = 'not-a-real-reason';
  run.experimentAssignment = '   ';
  run.backendErrorCodes = 'not-an-array';
  run.inputKindsUsed = ['filesystemPathRef', 'bogus', 42];
  run.cacheReadTokens = -2;
  run.tokenReportedTurnCount = 4.9;

  run.analyticsFactors = {
    promptFamily: 42,
    promptHash: 'prompt_hash',
    harnessPromptHash: null,
    customPromptHash: 7,
    appendSystemPromptHash: 'append_hash',
    promptGuidelineHashes: 'not-array',
    contextFiles: [
      { path: 'src/index.ts', hash: 'ctx-1' },
      { path: '', hash: 'ctx-2' },
      { path: 'src/other.ts', hash: 1 },
    ],
    selectedToolIds: ['read', 9],
    toolSnippetHashes: [
      { toolId: 'read', hash: 'tool-1' },
      { toolId: '', hash: 'tool-2' },
      { toolId: 'edit', hash: null },
    ],
    toolSetHash: 123,
    skills: [
      {
        name: 'skill-a',
        contentHash: 'content-a',
        sourceHash: 99,
        disableModelInvocation: true,
        lastModifiedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        name: '',
        contentHash: 'ignored',
        sourceHash: 'ignored',
        disableModelInvocation: false,
      },
    ],
    skillSetHash: null,
    activeExtensions: 'subagent',
  };

  run.toolUsage = {
    totalCount: 5.9,
    failureCount: -3,
    executionFailureCount: 'bad',
    verificationProjectFailureCount: 1.7,
    probeFailureCount: 2.2,
    countsByName: { read: 2.4, write: -1, bad: 'x' },
    failureCountsByName: { read: 1.9, write: -1 },
    failureCountsByKind: { timeout: 2.4, unknown: 1.2, nonzero_exit: -1 },
    failureCountsByNameAndKind: {
      bash: { timeout: 1.7, unknown: 0.9, shell_command_error: -1 },
      read: 'invalid',
    },
    failureSamples: [
      {
        toolName: 'bash',
        failureKind: 'timeout',
        exitCode: 1.9,
        errorExcerpt: 42,
        verificationKinds: ['test', 'bogus', 'build'],
        occurredAt: '2026-01-01T00:00:00.000Z',
      },
      {
        toolName: 22,
        failureKind: 'timeout',
        occurredAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    subagentCallCount: 1,
    subagentTaskCount: 2,
    subagentAgentNames: ['planner', 2],
    subagentScoredTaskCount: 1.2,
    subagentTaskScores: {
      precision: { sum: 3.8, count: 2.2, max: 5.7 },
      creativity: null,
      reasoning: { sum: -1, count: 3, max: 4 },
      thoroughness: { sum: 4, count: 2, max: 5 },
    },
  };

  run.fileExtensions = {
    readCountsByExtension: null,
    writeCountsByExtension: { '.ts': 2.8, '.js': -1 },
    editCountsByExtension: { '.md': 0.4 },
  };
  run.verification = {
    totalCount: 2.6,
    failureCount: -1,
    countsByKind: 'invalid',
  };

  const coerced = coerceRunSnapshot(run);
  assert.ok(coerced);
  assert.equal(coerced?.finalizationReason, undefined);
  assert.equal(coerced?.experimentAssignment, null);
  assert.deepEqual(coerced?.backendErrorCodes, []);
  assert.deepEqual(coerced?.inputKindsUsed, ['filesystemPathRef']);
  assert.equal(coerced?.cacheReadTokens, 0);
  assert.equal(coerced?.tokenReportedTurnCount, 4);

  assert.equal(coerced?.toolUsage.totalCount, 5);
  assert.equal(coerced?.toolUsage.failureCount, 3);
  assert.equal(coerced?.toolUsage.executionFailureCount, 3);
  assert.equal(coerced?.toolUsage.verificationProjectFailureCount, 1);
  assert.equal(coerced?.toolUsage.probeFailureCount, 2);
  assert.equal(coerced?.toolUsage.resultIssueCount, 3);
  assert.deepEqual(coerced?.toolUsage.countsByName, { read: 2 });
  assert.deepEqual(coerced?.toolUsage.failureCountsByName, { read: 1 });
  assert.equal(coerced?.toolUsage.failureSamples.length, 1);
  assert.equal(coerced?.toolUsage.failureSamples[0]?.errorExcerpt, '');
  assert.deepEqual(coerced?.toolUsage.failureSamples[0]?.verificationKinds, ['test', 'build']);
  assert.deepEqual(coerced?.toolUsage.subagentAgentNames, ['planner']);
  assert.equal(coerced?.toolUsage.subagentTaskScores.precision.sum, 3);
  assert.equal(coerced?.toolUsage.subagentTaskScores.creativity.sum, 0);
  assert.equal(coerced?.toolUsage.subagentTaskScores.reasoning.sum, 0);
  assert.equal(coerced?.toolUsage.subagentInputTokens, 0);
  assert.equal(coerced?.toolUsage.subagentOutputTokens, 0);
  assert.equal(coerced?.toolUsage.subagentCacheReadTokens, 0);
  assert.equal(coerced?.toolUsage.subagentCacheWriteTokens, 0);
  assert.equal(coerced?.compactionCount, 0);
  assert.equal(coerced?.autoRetryCount, 0);

  assert.deepEqual(coerced?.fileExtensions.readCountsByExtension, {});
  assert.deepEqual(coerced?.fileExtensions.writeCountsByExtension, { '.ts': 2 });
  assert.deepEqual(coerced?.fileExtensions.editCountsByExtension, { '.md': 0 });
  assert.equal(coerced?.verification.totalCount, 2);
  assert.equal(coerced?.verification.failureCount, 0);
  assert.deepEqual(coerced?.verification.countsByKind, {
    test: 0,
    build: 0,
    lint: 0,
    typecheck: 0,
    format: 0,
    other: 0,
  });

  assert.equal(coerced?.analyticsFactors?.promptFamily, null);
  assert.equal(coerced?.analyticsFactors?.promptHash, 'prompt_hash');
  assert.equal(coerced?.analyticsFactors?.customPromptHash, null);
  assert.deepEqual(coerced?.analyticsFactors?.promptGuidelineHashes, []);
  assert.deepEqual(coerced?.analyticsFactors?.contextFiles, [{ path: 'src/index.ts', hash: 'ctx-1' }]);
  assert.deepEqual(coerced?.analyticsFactors?.selectedToolIds, ['read']);
  assert.deepEqual(coerced?.analyticsFactors?.toolSnippetHashes, [{ toolId: 'read', hash: 'tool-1' }]);
  assert.deepEqual(coerced?.analyticsFactors?.activeExtensions, []);

  const fallback = coerceRunSnapshot({
    ...run,
    analyticsFactors: undefined,
    toolUsage: null,
    fileMutation: null,
    fileExtensions: null,
    verification: null,
  });
  assert.ok(fallback);
  assert.equal(fallback?.analyticsFactors, null);
  assert.equal(fallback?.toolUsage.totalCount, 0);
  assert.equal(fallback?.fileMutation.editCount, 0);
  assert.deepEqual(fallback?.fileExtensions.readCountsByExtension, {});
  assert.equal(fallback?.verification.totalCount, 0);
});

test('coerceRunSnapshot remaps legacy failure kinds into result-issue rollups', async () => {
  // Pre-split data: verification_project_failure and probe_no_match were counted
  // under the failure rollups, and no resultIssue* fields existed.
  const fixture = await loadFixture();
  const run = deepClone(fixture.completedRuns[0]) as any;
  run.toolUsage = {
    totalCount: 5,
    failureCount: 4,
    executionFailureCount: 2,
    verificationProjectFailureCount: 1,
    probeFailureCount: 1,
    countsByName: { bash: 3, read: 2 },
    failureCountsByName: { bash: 3, read: 1 },
    failureCountsByKind: {
      timeout: 1,
      nonzero_exit: 1,
      verification_project_failure: 1,
      probe_no_match: 1,
    },
    failureCountsByNameAndKind: {
      bash: { timeout: 1, verification_project_failure: 1, probe_no_match: 1 },
      read: { nonzero_exit: 1 },
    },
    failureSamples: [
      { toolName: 'bash', failureKind: 'timeout', exitCode: 124, errorExcerpt: 'timed out', verificationKinds: [], occurredAt: '2026-01-01T00:00:00.000Z' },
      { toolName: 'bash', failureKind: 'verification_project_failure', exitCode: 1, errorExcerpt: 'tests failed', verificationKinds: ['test'], occurredAt: '2026-01-02T00:00:00.000Z' },
      { toolName: 'bash', failureKind: 'probe_no_match', exitCode: 1, errorExcerpt: '', verificationKinds: [], occurredAt: '2026-01-03T00:00:00.000Z' },
    ],
  };

  const coerced = coerceRunSnapshot(run);
  assert.ok(coerced);
  const tu = coerced!.toolUsage;

  // Execution-only failure counts (verification/probe no longer counted as failures).
  assert.equal(tu.failureCount, 2);
  assert.equal(tu.executionFailureCount, 2);
  assert.equal(tu.verificationProjectFailureCount, 1);
  assert.equal(tu.probeFailureCount, 1);
  assert.equal(tu.resultIssueCount, 2);

  // Legacy kinds removed from the failure by-kind rollup...
  assert.equal(tu.failureCountsByKind.timeout, 1);
  assert.equal(tu.failureCountsByKind.nonzero_exit, 1);
  assert.equal(('verification_project_failure' in tu.failureCountsByKind), false);
  assert.equal(('probe_no_match' in tu.failureCountsByKind), false);

  // ...and remapped into the result-issue by-kind rollup.
  assert.equal(tu.resultIssueCountsByKind.verification_failure, 1);
  assert.equal(tu.resultIssueCountsByKind.probe_no_match, 1);

  // Per-tool split: bash keeps execution kinds, gains result-issue kinds.
  assert.equal(tu.failureCountsByNameAndKind.bash?.timeout, 1);
  assert.equal(('verification_project_failure' in (tu.failureCountsByNameAndKind.bash ?? {})), false);
  assert.equal(tu.resultIssueCountsByNameAndKind.bash?.verification_failure, 1);
  assert.equal(tu.resultIssueCountsByNameAndKind.bash?.probe_no_match, 1);

  // Per-tool failure counts recomputed to execution-only (bash: 3 legacy − 2 result issues).
  assert.equal(tu.failureCountsByName.bash, 1);
  assert.equal(tu.failureCountsByName.read, 1);

  // Samples split: execution sample stays; verification/probe move to result-issue samples.
  assert.equal(tu.failureSamples.length, 1);
  assert.equal(tu.failureSamples[0]?.failureKind, 'timeout');
  assert.equal(tu.resultIssueSamples.length, 2);
  assert.equal(tu.resultIssueSamples[0]?.resultIssueKind, 'verification_failure');
  assert.deepEqual(tu.resultIssueSamples[0]?.verificationKinds, ['test']);
  assert.equal(tu.resultIssueSamples[1]?.resultIssueKind, 'probe_no_match');
});

test('coerceRunSnapshot preserves functional settings and defaults missing ones to null', async () => {
  const fixture = await loadFixture();
  const run = deepClone(fixture.completedRuns[0]) as any;

  // Absent on historical runs -> null (untracked).
  assert.equal(coerceRunSnapshot(run)?.functionalSettings, null);

  // Present and valid -> coerced, dropping non-boolean toggle values.
  run.functionalSettings = {
    subagentAlwaysParentModel: true,
    pruningMode: 'auto',
    extensionToggles: { subagent: true, safeguard: 'no' },
    toolResultPruningEnabled: true,
    toolResultPruningProfile: 'security',
  };
  assert.deepEqual(coerceRunSnapshot(run)?.functionalSettings, {
    subagentAlwaysParentModel: true,
    pruningMode: 'auto',
    extensionToggles: { subagent: true },
    toolResultPruningEnabled: true,
    toolResultPruningProfile: 'security',
  });

  // Invalid pruningMode -> treated as untracked (null), even if other fields are present.
  run.functionalSettings = { subagentAlwaysParentModel: true, pruningMode: 'bogus', extensionToggles: {} };
  assert.equal(coerceRunSnapshot(run)?.functionalSettings, null);
});

test('coerceOutcomeHistoryEntry validates schema, kind, and outcome shape', async () => {
  const fixture = await loadFixture();
  const valid = coerceOutcomeHistoryEntry(fixture.outcomes[0]);
  assert.ok(valid);

  const invalidKind = { ...fixture.outcomes[0], kind: 'not-run-outcome' } as any;
  assert.equal(coerceOutcomeHistoryEntry(invalidKind), null);

  const invalidOutcome = {
    ...fixture.outcomes[0],
    outcome: { resolution: 'broken', satisfaction: 2 },
  } as any;
  assert.equal(coerceOutcomeHistoryEntry(invalidOutcome), null);
});

test('coerceSourceAnalyticsPayload enforces array and element validation', async () => {
  const fixture = deepClone(await loadFixture()) as any;

  assert.throws(
    () => coerceSourceAnalyticsPayload(null),
    /Source analytics payload must be a JSON object/,
  );

  const missingExportedAt = { ...fixture };
  delete missingExportedAt.exportedAt;
  assert.throws(
    () => coerceSourceAnalyticsPayload(missingExportedAt),
    /missing exportedAt/,
  );

  assert.throws(
    () => coerceSourceAnalyticsPayload({ ...fixture, completedRuns: {} }),
    /Expected completedRuns to be an array/,
  );

  assert.throws(
    () => coerceSourceAnalyticsPayload({ ...fixture, completedRuns: [{ ...fixture.completedRuns[0], runId: 123 }] }),
    /Invalid run snapshot at completedRuns\[0\]/,
  );

  assert.throws(
    () => coerceSourceAnalyticsPayload({ ...fixture, outcomes: {} }),
    /Expected outcomes to be an array/,
  );

  assert.throws(
    () => coerceSourceAnalyticsPayload({ ...fixture, outcomes: [{ ...fixture.outcomes[0], kind: 'broken' }] }),
    /Invalid outcome history entry at outcomes\[0\]/,
  );
});

test('coerceSourceAnalyticsPayload returns normalized payloads for valid inputs', async () => {
  const fixture = deepClone(await loadFixture()) as any;
  delete fixture.completedRuns[0].backendErrorCodes;
  fixture.completedRuns[0].cacheReadTokens = undefined;
  fixture.completedRuns[0].tokenReportedTurnCount = undefined;
  fixture.completedRuns[0].fileExtensions.readCountsByExtension = undefined;
  fixture.completedRuns[1].fileExtensions = null;

  const coerced = coerceSourceAnalyticsPayload(fixture);

  assert.equal(coerced.completedRuns.length, fixture.completedRuns.length);
  assert.equal(coerced.outcomes[0]?.recordedAt, fixture.outcomes[0].recordedAt);
  assert.deepEqual(coerced.completedRuns[0]?.backendErrorCodes, []);
  assert.equal(coerced.completedRuns[0]?.cacheReadTokens, 0);
  assert.equal(coerced.completedRuns[0]?.tokenReportedTurnCount, 0);
  assert.deepEqual(coerced.completedRuns[0]?.fileExtensions.readCountsByExtension, {});
  assert.deepEqual(coerced.completedRuns[1]?.fileExtensions.readCountsByExtension, {});
});
