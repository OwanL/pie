import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';

import { RUN_ANALYTICS_SCHEMA_VERSION, type RunSnapshot, type SourceAnalyticsPayload } from '../scripts/contracts.ts';
import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import {
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
  assert.equal(fixture.sessionReviewV2Diagnostics.rawProductionCount, 0);
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

    const loaded = await loadSourceAnalytics({ storageDir: dir, ...withoutLocalSessionDiscovery(dir) });
    assert.equal(loaded.sourceKind, 'storage-dir');
    assert.equal(loaded.source.completedRuns.length, 2);
    assert.equal(loaded.source.openRuns.length, 1);
    assert.equal(loaded.source.workspaceKey, path.basename(dir));
  });
});

function withoutLocalSessionDiscovery(dir: string) {
  return {
    configuredSessionsDir: path.join(dir, 'no-configured-sessions'),
    reviewSidecarPath: path.join(dir, 'no-reviews.jsonl'),
  };
}

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

    const loaded = await loadSourceAnalytics({ outcomesRoot, ...withoutLocalSessionDiscovery(outcomesRoot) });
    assert.equal(loaded.sourceKind, 'all-stores');
    assert.equal(loaded.sourcePath, outcomesRoot);
    assert.equal(loaded.source.workspaceKey, 'all');
    // Merged source carries runs from both stores (dedup happens later in prepare).
    assert.equal(loaded.source.completedRuns.length, runsA.length + runsB.length);
  });
});

test('loadSourceAnalytics derives reviews from the selected outcomes root', async () => {
  await withTempDir(async (outcomesRoot) => {
    const fixture = await loadFixture();
    const store = path.join(outcomesRoot, 'aaaaaaaaaaaaaaaa');
    await fs.mkdir(store, { recursive: true });
    await writeRunSnapshotsJsonl(store, [fixture.completedRuns[0]!]);

    const reviewsDir = path.join(outcomesRoot, 'session-reviews');
    await fs.mkdir(reviewsDir, { recursive: true });
    await fs.writeFile(
      path.join(reviewsDir, 'reviews.jsonl'),
      `${JSON.stringify({ schemaVersion: 2, kind: 'production' })}\n`,
      'utf8',
    );

    const loaded = await loadSourceAnalytics({ outcomesRoot });
    assert.equal(loaded.source.sessionReviewV2Diagnostics.rawProductionCount, 1);
    assert.equal(loaded.source.sessionReviewV2Diagnostics.acceptedCount, 0);
    assert.equal(loaded.source.sessionReviewV2Diagnostics.rejectedCount, 1);
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

    const loaded = await loadSourceAnalytics({ outcomesRoot, ...withoutLocalSessionDiscovery(outcomesRoot) });
    assert.equal(loaded.source.completedRuns.length, 2); // merged before dedup
    const prepared = prepareSourceAnalytics(loaded.source);
    assert.equal(prepared.runs.length, 1); // deduped to a single run
  });
});

test('loadSourceAnalytics falls back to the fixture when no run stores exist', async () => {
  await withTempDir(async (outcomesRoot) => {
    const loaded = await loadSourceAnalytics({ outcomesRoot, ...withoutLocalSessionDiscovery(outcomesRoot) });
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

test('max thinking level is accepted and preserved', async () => {
  await withTempDir(async (dir) => {
    const fixture = deepClone(await loadFixture());
    (fixture.completedRuns[0] as any).thinkingLevel = 'max';
    const filePath = path.join(dir, 'max-thinking-level.json');
    await fs.writeFile(filePath, JSON.stringify(fixture), 'utf8');

    const loaded = await readSourceAnalyticsPayload(filePath);
    assert.equal(loaded.completedRuns[0]?.thinkingLevel, 'max');
  });
});

test('coerceRunSnapshot rejects legacy run statuses', async () => {
  const fixture = await loadFixture();
  const run = deepClone(fixture.completedRuns[0]) as any;
  run.status = 'scored';
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
  run.compactionCount = -1;
  run.autoRetryCount = 'invalid';
  run.retryTimingSamples = undefined;

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
  assert.equal(coerced?.toolUsage.subagentInputTokens, 0);
  assert.equal(coerced?.toolUsage.subagentOutputTokens, 0);
  assert.equal(coerced?.toolUsage.subagentCacheReadTokens, 0);
  assert.equal(coerced?.toolUsage.subagentCacheWriteTokens, 0);
  assert.equal(coerced?.compactionCount, 0);
  assert.equal(coerced?.autoRetryCount, 0);
  assert.deepEqual(coerced?.retryTimingSamples, []);
  assert.equal(coerced?.toolUsage.criticalPathDurationMs, undefined);

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

test('coerceRunSnapshot preserves harness revision and fingerprint', async () => {
  const fixture = await loadFixture();
  const run = deepClone(fixture.completedRuns[0]) as any;

  const stamped = coerceRunSnapshot({
    ...run,
    harnessRevision: 'pie-harness-2026-08',
    harnessFingerprint: 'f0'.repeat(32),
  });
  assert.ok(stamped);
  assert.equal(stamped?.harnessRevision, 'pie-harness-2026-08');
  assert.equal(stamped?.harnessFingerprint, 'f0'.repeat(32));

  // Historical snapshots without the fields coerce cleanly (absent, not null).
  const legacy = coerceRunSnapshot(run);
  assert.ok(legacy);
  assert.equal(legacy?.harnessRevision, undefined);
  assert.equal(legacy?.harnessFingerprint, undefined);

  // Non-string values are dropped, not accepted.
  const malformed = coerceRunSnapshot({
    ...run,
    harnessRevision: 42,
    harnessFingerprint: ['not-a-string'],
  });
  assert.ok(malformed);
  assert.equal(malformed?.harnessRevision, undefined);
  assert.equal(malformed?.harnessFingerprint, undefined);
});

test('coerceRunSnapshot preserves neutral verification-pending result issues', async () => {
  const fixture = await loadFixture();
  const raw = deepClone(fixture.completedRuns[0]) as any;
  raw.toolUsage.resultIssueCount = 1;
  raw.toolUsage.resultIssueCountsByName = { bash: 1 };
  raw.toolUsage.resultIssueCountsByKind = { verification_pending: 1 };
  raw.toolUsage.resultIssueCountsByNameAndKind = { bash: { verification_pending: 1 } };
  raw.toolUsage.resultIssueSamples = [{
    toolName: 'bash',
    resultIssueKind: 'verification_pending',
    exitCode: 8,
    errorExcerpt: 'checks are still pending',
    verificationKinds: ['other'],
    occurredAt: raw.startedAt,
  }];

  const coerced = coerceRunSnapshot(raw);
  assert.equal(coerced?.toolUsage.failureCount, 0);
  assert.equal(coerced?.toolUsage.executionFailureCount, 0);
  assert.equal(coerced?.toolUsage.verificationProjectFailureCount, 0);
  assert.equal(coerced?.toolUsage.probeFailureCount, 0);
  assert.equal(coerced?.toolUsage.resultIssueCount, 1);
  assert.equal(coerced?.toolUsage.resultIssueCountsByKind.verification_pending, 1);
  assert.equal(coerced?.toolUsage.resultIssueCountsByNameAndKind.bash?.verification_pending, 1);
  assert.equal(coerced?.toolUsage.resultIssueSamples[0]?.resultIssueKind, 'verification_pending');
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
  assert.deepEqual(coerced.completedRuns[0]?.backendErrorCodes, []);
  assert.equal(coerced.completedRuns[0]?.cacheReadTokens, 0);
  assert.equal(coerced.completedRuns[0]?.tokenReportedTurnCount, 0);
  assert.deepEqual(coerced.completedRuns[0]?.fileExtensions.readCountsByExtension, {});
  assert.deepEqual(coerced.completedRuns[1]?.fileExtensions.readCountsByExtension, {});
});

test('loadSourceAnalytics preserves embedded side channels for portable exports', async () => {
  await withTempDir(async (configRoot) => {
    const fixture = await loadFixture();
    const exportPath = path.join(configRoot, 'portable-export.json');
    const embedded: SourceAnalyticsPayload = {
      ...fixture,
      workspaceKey: 'portable',
      pruningDecisions: [
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          sessionId: 'embedded',
          sessionPath: 'embedded',
          mode: 'auto',
          query: 'q',
          llmModel: 'm',
          llmThinkingLevel: 'low',
          llmLatencyMs: 0,
          included: ['skill-a'],
          excluded: [],
          skillBlockTokens: 0,
          originalBlockTokens: 0,
        },
      ],
      pruningEvents: [
        { event: 'skill_miss', sessionId: 'embedded', timestamp: '2026-01-01T00:00:01.000Z' },
      ],
      toolResultPruningEvents: [
        {
          event: 'tool_result_pruned',
          sessionId: 'embedded',
          toolName: 'bash',
          rules: ['strip'],
          beforeTokens: 10,
          afterTokens: 5,
          tokensSaved: 5,
          timestamp: '2026-01-01T00:00:02.000Z',
        },
      ],
      warmBashRewrites: [
        {
          event: 'auto_prune_rewrite',
          sessionId: 'embedded',
          timestamp: '2026-01-01T00:00:03.000Z',
          before: 'b',
          after: 'a',
        },
      ],
      warmBashSummaries: [
        {
          event: 'session_summary',
          sessionId: 'embedded',
          timestamp: '2026-01-01T00:00:04.000Z',
          fastPath: 0,
          warm: 1,
          fallback: 0,
          poolSize: 2,
          warmupFailures: 0,
          autoPruneEnabled: true,
          fastPathEnabled: true,
          gnuGrep: true,
        },
      ],
    };
    await fs.writeFile(exportPath, JSON.stringify(embedded), 'utf8');

    // Plant local side-channel logs that must be ignored for a portable export.
    await fs.mkdir(path.join(configRoot, 'data'), { recursive: true });
    await fs.writeFile(
      path.join(configRoot, 'data', 'pruning.jsonl'),
      JSON.stringify({ event: 'skill_read', sessionId: 'local', timestamp: '2026-01-02T00:00:00.000Z' }) + '\n',
      'utf8',
    );

    const loaded = await loadSourceAnalytics({ exportPath });
    assert.equal(loaded.sourceKind, 'export');
    assert.equal(loaded.source.pruningDecisions.length, 1);
    assert.equal(loaded.source.pruningDecisions[0]?.sessionId, 'embedded');
    assert.equal(loaded.source.pruningEvents.length, 1);
    assert.equal(loaded.source.pruningEvents[0]?.sessionId, 'embedded');
    assert.equal(loaded.source.toolResultPruningEvents.length, 1);
    assert.equal(loaded.source.toolResultPruningEvents[0]?.sessionId, 'embedded');
    assert.equal(loaded.source.warmBashRewrites?.length, 1);
    assert.equal(loaded.source.warmBashRewrites?.[0]?.sessionId, 'embedded');
    assert.equal(loaded.source.warmBashSummaries?.length, 1);
    assert.equal(loaded.source.warmBashSummaries?.[0]?.sessionId, 'embedded');
    // Historical sessions are not embedded and cannot be safely reconstructed,
    // so they must not be silently replaced by the analyzer's local transcripts.
    assert.deepEqual(loaded.source.historicalSessions, []);
  });
});

test('coerceRunSnapshot preserves lastTurnUsage reasoning tokens and clamps them to output tokens', async () => {
  const fixture = await loadFixture();
  const run = deepClone(fixture.completedRuns[0]) as any;
  run.lastTurnUsage = {
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 5,
    cacheWriteTokens: 2,
    totalTokens: 37,
    reasoningTokens: 15,
  };
  const coerced = coerceRunSnapshot(run);
  assert.equal(coerced?.lastTurnUsage?.reasoningTokens, 15);

  const excessive = deepClone(run);
  excessive.lastTurnUsage.reasoningTokens = 25;
  assert.equal(coerceRunSnapshot(excessive)?.lastTurnUsage?.reasoningTokens, 20);
});

test('coerceRunSnapshot preserves per-turn throughput provider attribution', async () => {
  const fixture = await loadFixture();
  const run = deepClone(fixture.completedRuns[0]) as any;
  run.turnThroughputSamples = [
    {
      endedAt: '2026-05-10T15:00:00.000Z',
      outputTokens: 10,
      generationDurationMs: 500,
      concurrentBusySessions: 1,
      status: 'completed',
      provider: 'openai',
    },
  ];
  const coerced = coerceRunSnapshot(run);
  assert.equal(coerced?.turnThroughputSamples[0]?.provider, 'openai');
});

test('coerceRunSnapshot preserves measured runtime timing and legacy absence', async () => {
  const fixture = await loadFixture();
  const run = deepClone(fixture.completedRuns[0]) as any;
  run.provider = 'openai';
  run.auxiliaryLlmUsage[0].durationMs = 350.9;
  run.turnThroughputSamples[0].providerQueueMs = 120.8;
  run.turnThroughputSamples[0].providerQueueAttemptCount = 2.9;
  run.retryTimingSamples.push({ sourceId: '', occurredAt: run.startedAt, attempt: 2, scheduledDelayMs: 10 });

  const coerced = coerceRunSnapshot(run)!;
  assert.equal(coerced.provider, 'openai');
  assert.equal(coerced.auxiliaryLlmUsage?.[0]?.durationMs, 350);
  assert.equal(coerced.turnThroughputSamples[0]?.providerQueueMs, 120);
  assert.equal(coerced.turnThroughputSamples[0]?.providerQueueAttemptCount, 2);
  assert.equal(coerced.retryTimingSamples?.length, 1, 'malformed retry timing is dropped');
  assert.equal(coerced.retryTimingSamples?.[0]?.scheduledDelayMs, 1000);
  assert.equal(coerced.toolUsage.criticalPathDurationMs, 6200);

  delete run.auxiliaryLlmUsage[0].durationMs;
  delete run.turnThroughputSamples[0].providerQueueMs;
  delete run.turnThroughputSamples[0].providerQueueAttemptCount;
  delete run.toolUsage.criticalPathDurationMs;
  delete run.retryTimingSamples;
  const legacy = coerceRunSnapshot(run)!;
  assert.equal(legacy.auxiliaryLlmUsage?.[0]?.durationMs, undefined);
  assert.equal(legacy.turnThroughputSamples[0]?.providerQueueMs, null);
  assert.equal(legacy.turnThroughputSamples[0]?.providerQueueAttemptCount, undefined);
  assert.equal(legacy.toolUsage.criticalPathDurationMs, undefined);
  assert.deepEqual(legacy.retryTimingSamples, []);
});

test('coerceRunSnapshot coerces per-tool timed call counts compatibly', async () => {
  const fixture = await loadFixture();
  const run = deepClone(fixture.completedRuns[0]) as any;
  run.toolUsage.timedCallCountsByName = { bash: 2.9, read: -1, invalid: 'x' };
  const coerced = coerceRunSnapshot(run);
  assert.deepEqual(coerced?.toolUsage.timedCallCountsByName, { bash: 2 });
});

test('loadSourceAnalytics attaches local side-channel logs for storage-dir sources', async () => {
  await withTempDir(async (configRoot) => {
    const fixture = await loadFixture();
    const store = path.join(configRoot, 'data', 'outcomes', 'store-hash');
    await fs.mkdir(store, { recursive: true });

    const run = fixture.completedRuns[0]!;
    await fs.writeFile(
      path.join(store, 'run-snapshots.jsonl'),
      JSON.stringify({
        schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
        kind: 'run_snapshot',
        recordedAt: run.updatedAt,
        run,
      }) + '\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(store, 'open-runs.a.json'),
      JSON.stringify({ schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION, seq: 1, sessions: {} }),
      'utf8',
    );
    await fs.writeFile(path.join(store, 'open-runs.gen'), 'a', 'utf8');

    await fs.mkdir(path.join(configRoot, 'data'), { recursive: true });
    await fs.writeFile(
      path.join(configRoot, 'data', 'pruning.jsonl'),
      JSON.stringify({ event: 'skill_read', sessionId: 'local', timestamp: '2026-01-02T00:00:00.000Z' }) + '\n',
      'utf8',
    );

    const loaded = await loadSourceAnalytics({ storageDir: store, ...withoutLocalSessionDiscovery(configRoot) });
    assert.equal(loaded.sourceKind, 'storage-dir');
    assert.equal(loaded.source.pruningEvents.length, 1);
    assert.equal(loaded.source.pruningEvents[0]?.sessionId, 'local');
  });
});
