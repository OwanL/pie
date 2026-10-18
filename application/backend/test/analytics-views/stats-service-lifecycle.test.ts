import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createEmptyFileMutationRollup,
  createEmptyToolUsageRollup,
  createEmptyVerificationRollup,
} from '../../../../analytics/legacy/run-analytics/coercion.js';
import { StatsService } from '../../analytics-views';
import { legacyPrivacyStorageDirs } from '../../../../analytics/usage-accounting/canonical-accounting';
import { createInitialArchState, type ArchState } from '../../conversation-state/arch-state';
import { CanonicalAnalyticsCapture } from '../../../../analytics/capture/canonical-capture.js';
import type { AnalyticsObservation } from '../../../../analytics/contracts/contracts.js';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-stats-lifecycle-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Preserved historical fixture: startup must neither import nor rewrite it. */
function legacyCompletedRun(runId: string, usage: { inputTokens: number; outputTokens: number }) {
  return {
    sessionPath: `/workspace/${runId}.jsonl`,
    runId,
    taskGroupId: `${runId}-task`,
    status: 'closed',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:10:00.000Z',
    finalizedAt: '2026-01-01T00:10:00.000Z',
    mixedModelConfig: false,
    mixedTreatmentConfig: false,
    treatmentChangeKinds: [],
    experimentAssignment: null,
    analyticsFactors: null,
    functionalSettings: null,
    sendCount: 1,
    assistantTurnCount: 1,
    assistantTurnDurationMs: 1_000,
    interruptedCount: 0,
    messageEditCount: 0,
    truncatedAfterCount: 0,
    backendErrorCodes: [],
    contextTokens: null,
    contextLimit: null,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    tokenReportedTurnCount: 0,
    lastTurnUsage: null,
    turnThroughputSamples: [],
    filesystemPathRefCount: 0,
    imageInputCount: 0,
    imageInputBytes: 0,
    unsupportedInputCount: 0,
    inputKindsUsed: [],
    toolUsage: createEmptyToolUsageRollup(),
    fileMutation: createEmptyFileMutationRollup(),
    fileExtensions: { readCountsByExtension: {}, writeCountsByExtension: {}, editCountsByExtension: {} },
    verification: createEmptyVerificationRollup(),
  };
}

async function seedLegacyRunSnapshots(storageDir: string, runs: ReturnType<typeof legacyCompletedRun>[]) {
  await fs.mkdir(storageDir, { recursive: true });
  const lines = runs.map((run) => JSON.stringify({
    schemaVersion: 1,
    kind: 'run_snapshot',
    recordedAt: '2026-01-01T00:10:00.000Z',
    run,
  }));
  await fs.writeFile(path.join(storageDir, 'run-snapshots.jsonl'), `${lines.join('\n')}\n`, 'utf8');
}

function optionsFor(
  analyticsRoot: string,
  tempDir: string,
  state: ArchState,
  counters: { renders: number },
) {
  return {
    dataOutcomesRootPath: analyticsRoot,
    legacyUsageDataRootPath: tempDir,
    workspaceId: 'workspace-migration-lifecycle',
    getArchState: () => state,
    now: () => new Date(Date.parse('2026-01-01T00:10:00.000Z')),
    scheduleRender: () => { counters.renders += 1; },
  };
}

test('the canonical read model is withheld unless canonical authority is active', async () => {
  await withTempDir(async (tempDir) => {
    const state = createInitialArchState();
    // A read model alone does not establish the admitted capture context.
    // Both the accessor and startup must withhold its reads. Reading data
    // without capture would bypass the admitted canonical context.
    const readModel = {} as NonNullable<ReturnType<StatsService['getAnalyticsReadModel']>>;
    const unavailableStats = new StatsService({
      ...optionsFor(path.join(tempDir, 'analytics-legacy'), tempDir, state, { renders: 0 }),
      analyticsReadModel: readModel,
    });
    try {
      assert.equal(unavailableStats.getAnalyticsReadModel(), undefined, 'unavailable capture must not expose canonical reads');
      await unavailableStats.start();
      assert.equal(unavailableStats.getAnalyticsRevisionRefreshStats(), undefined, 'startup cannot query a read model without capture');
    } finally {
      await unavailableStats.shutdown();
    }

    const capture = new CanonicalAnalyticsCapture({
      authority: 'canonical',
      generationId: 'generation-read-model',
      workspaceId: 'workspace-read-model',
      buildId: 'build-read-model',
      processGeneration: 'process-read-model',
      sink: { submit: () => undefined },
      detailSink: { submitDetail: () => undefined },
      lifecycleSink: {
        bindPendingCreate: async () => undefined,
        deleteSession: async () => undefined,
      },
    });
    const canonicalStats = new StatsService({
      ...optionsFor(path.join(tempDir, 'analytics-canonical'), tempDir, state, { renders: 0 }),
      analyticsCapture: capture,
      analyticsReadModel: readModel,
    });
    try {
      assert.equal(canonicalStats.getAnalyticsReadModel(), readModel, 'canonical authority must expose the wired model');
    } finally {
      await canonicalStats.shutdown();
    }
  });
});

test('canonical authority neither reads nor extends the legacy run/ledger layer', async () => {
  await withTempDir(async (tempDir) => {
    const analyticsRoot = path.join(tempDir, 'data', 'outcomes');
    const storageDir = legacyPrivacyStorageDirs({ dataOutcomesRootPath: analyticsRoot, workspaceId: 'workspace-exclusive-authority' })[0]!;
    // A durable legacy run snapshot is present and must stay untouched: the
    // exclusive authority switch never imports or migrates legacy analytics.
    await seedLegacyRunSnapshots(storageDir, [
      legacyCompletedRun('legacy-run-authority', { inputTokens: 100, outputTokens: 10 }),
    ]);
    const retiredFiles = ['run-snapshots.jsonl', 'run-state.json', 'activity-intervals.json'];
    for (const name of retiredFiles.slice(1)) {
      await fs.writeFile(path.join(storageDir, name), `retired ${name}\r\n`, 'utf8');
    }
    const before = await Promise.all(retiredFiles.map((name) => fs.readFile(path.join(storageDir, name))));
    const observations: AnalyticsObservation<object>[] = [];
    const capture = new CanonicalAnalyticsCapture({
      authority: 'canonical',
      generationId: 'generation-exclusive-authority',
      workspaceId: 'workspace-exclusive-authority',
      buildId: 'build-exclusive-authority',
      processGeneration: 'process-exclusive-authority',
      sink: { submit: (observation) => { observations.push(observation); } },
      detailSink: { submitDetail: () => undefined },
      lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
    });
    const stats = new StatsService({
      ...optionsFor(analyticsRoot, tempDir, createInitialArchState(), { renders: 0 }),
      workspaceId: 'workspace-exclusive-authority',
      analyticsCapture: capture,
    });
    const ledgerPath = path.join(storageDir, 'billable-invocations.jsonl');
    const sessionPath = '/sessions/exclusive-authority.jsonl';
    try {
      await stats.start();
      assert.deepEqual(stats.getOpenRuns(), []);
      assert.equal('getPendingCompletedRuns' in stats, false);
      assert.equal(observations.length, 0, 'a durable legacy run snapshot is never imported into canonical capture');

      // One settlement under canonical authority goes to the canonical sink and
      // never falls through to the legacy JSONL ledger.
      stats.prepareForSend(sessionPath, []);
      stats.onAssistantTurnStarted(sessionPath, 'turn-exclusive-authority');
      stats.onAssistantTurnEnded(sessionPath, 'turn-exclusive-authority', 1_000, {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        totalTokens: 125,
        reportedCostUsd: 0.25,
      }, 'completed', undefined, {
        modelId: 'model-authority',
        provider: 'provider-authority',
        occurredAt: '2026-01-01T00:10:00.000Z',
      });
      assert.ok(
        observations.some((observation) => observation.entityKind === 'providerCall'),
        'the settlement is submitted to the canonical recorder',
      );
      await assert.rejects(
        fs.access(ledgerPath),
        { code: 'ENOENT' },
        'canonical capture must never dual-write the legacy invocation ledger',
      );
    } finally {
      await stats.shutdown();
    }
    assert.deepEqual((await fs.readdir(storageDir)).sort(), [...retiredFiles].sort(),
      'startup, capture, and shutdown must create no legacy files');
    for (const [index, name] of retiredFiles.entries()) {
      assert.deepEqual(await fs.readFile(path.join(storageDir, name)), before[index],
        `${name} must remain byte-identical`);
    }
    for (const owner of ['store', 'runStore', 'ledger', 'activityTimeline']) {
      assert.equal(owner in stats, false, `canonical startup must not construct ${owner}`);
    }
  });
});

test('durable terminal evidence replays with an immutable canonical fingerprint', async () => {
  await withTempDir(async (tempDir) => {
    const state = createInitialArchState();
    const observations: AnalyticsObservation<object>[] = [];
    const capture = new CanonicalAnalyticsCapture({
      authority: 'canonical',
      generationId: 'generation-terminal-replay',
      workspaceId: 'workspace-terminal-replay',
      buildId: 'build-terminal-replay',
      processGeneration: 'process-terminal-replay',
      sink: { submit: (observation) => { observations.push(observation); } },
      detailSink: { submitDetail: () => undefined },
      lifecycleSink: {
        bindPendingCreate: async () => undefined,
        deleteSession: async () => undefined,
      },
    });
    const stats = new StatsService({
      ...optionsFor(path.join(tempDir, 'analytics'), tempDir, state, { renders: 0 }),
      analyticsCapture: capture,
    });
    const watermark = {
      sessionPath: '/sessions/durable-replay.jsonl',
      requestId: 'request-replay',
      turnId: 'turn-replay',
      attemptId: 'attempt-replay',
      finalSeq: 7,
      terminalKind: 'completed' as const,
      durableEntryId: 'assistant-entry-replay',
      occurredAt: 1_800_000_000_007,
    };

    stats.onAssistantTerminalWatermark(watermark, 'operation-replay');
    stats.onAssistantTerminalWatermark(watermark, 'operation-replay');

    assert.equal(observations.length, 2);
    assert.deepEqual(observations[1], observations[0]);
  });
});

test('execution lifecycle uses the accepted operation and settles only at agent.settled', async () => {
  await withTempDir(async (tempDir) => {
    const state = createInitialArchState();
    const observations: AnalyticsObservation<object>[] = [];
    const capture = new CanonicalAnalyticsCapture({
      authority: 'canonical',
      generationId: 'generation-execution-identity',
      workspaceId: 'workspace-execution-identity',
      buildId: 'build-execution-identity',
      processGeneration: 'process-execution-identity',
      sink: { submit: (observation) => { observations.push(observation); } },
      detailSink: { submitDetail: () => undefined },
      lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
    });
    const stats = new StatsService({
      ...optionsFor(path.join(tempDir, 'analytics'), tempDir, state, { renders: 0 }),
      analyticsCapture: capture,
    });
    const sessionPath = '/sessions/execution-identity.jsonl';
    try {
      const runId = stats.prepareForSend(sessionPath, [], 'prompt', 'operation-accepted');
      stats.onAssistantTurnStarted(sessionPath, 'turn-accepted', {
        operationId: 'operation-accepted', requestId: 'request-accepted', attemptId: 'attempt-accepted',
      });
      stats.onAssistantTurnEnded(sessionPath, 'turn-accepted', 25, undefined, 'completed', undefined, {
        operationId: 'operation-accepted', requestId: 'request-accepted', attemptId: 'attempt-accepted',
        occurredAt: '2026-01-01T00:00:01.000Z',
      });

      const beforeSettlement = observations.filter((observation) => observation.entityKind === 'execution');
      assert.ok(beforeSettlement.every((observation) => observation.entityKey === 'operation-accepted'));
      assert.equal(beforeSettlement.some((observation) => observation.observationKind === 'end'), false,
        'turn phase/registry commit must not close the execution');

      // A retry is a second assistant turn under the same accepted operation;
      // it must not select a newer registry operation or create a second
      // execution entity.
      (state.operations as any)['newer-registry-operation'] = {
        operationId: 'newer-registry-operation',
        terminal: false,
        session: { resolvedPath: sessionPath, pendingPath: undefined },
      };
      stats.onAssistantTurnStarted(sessionPath, 'turn-retry', {
        operationId: 'operation-accepted', requestId: 'request-retry', attemptId: 'attempt-retry',
      });
      stats.onAssistantTurnEnded(sessionPath, 'turn-retry', 30, undefined, 'completed', undefined, {
        operationId: 'operation-accepted', requestId: 'request-retry', attemptId: 'attempt-retry',
        occurredAt: '2026-01-01T00:00:02.000Z',
      });
      assert.ok(
        observations.filter((observation) => observation.entityKind === 'execution')
          .every((observation) => observation.entityKey === 'operation-accepted'),
        'retry phases remain bound to their source operation',
      );

      stats.onAgentSettled({
        sessionPath,
        operationId: 'operation-accepted',
        requestId: 'request-retry',
        turnId: 'turn-retry',
        attemptId: 'attempt-retry',
        capabilities: {} as never,
      });
      const ends = observations.filter((observation) => (
        observation.entityKind === 'execution' && observation.observationKind === 'end'
      ));
      assert.equal(ends.length, 1);
      assert.equal(ends[0]?.entityKey, 'operation-accepted');
      assert.equal(ends[0]?.observedAtMs, 0, 'settlement without source time uses stable unknown envelope time');
      assert.deepEqual(ends[0]?.fields, {
        operationId: 'operation-accepted',
        requestId: 'request-retry',
        turnId: 'turn-retry',
        attemptId: 'attempt-retry',
        operationKind: 'agent-run',
        source: 'backend-agent-settled',
        outcome: 'unknown',
      });
      assert.notEqual(runId, 'operation-accepted', 'the local run remains a separate grouping identity');

      // A settlement without its owning operation cannot close the current
      // run, even if a stale registry operation happens to be visible.
      stats.onAgentSettled({ sessionPath, capabilities: {} as never });
      assert.equal(observations.filter((observation) => observation.observationKind === 'end').length, 1);
    } finally {
      await stats.shutdown();
    }
  });
});

test('execution lifecycle records one host start and the backend settlement time', async () => {
  await withTempDir(async (tempDir) => {
    const state = createInitialArchState();
    const observations: AnalyticsObservation<object>[] = [];
    const capture = new CanonicalAnalyticsCapture({
      authority: 'canonical',
      generationId: 'generation-execution-times',
      workspaceId: 'workspace-execution-times',
      buildId: 'build-execution-times',
      processGeneration: 'process-execution-times',
      sink: { submit: (observation) => { observations.push(observation); } },
      detailSink: { submitDetail: () => undefined },
      lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
    });
    const stats = new StatsService({
      ...optionsFor(path.join(tempDir, 'analytics'), tempDir, state, { renders: 0 }),
      analyticsCapture: capture,
    });
    try {
      stats.prepareForSend('/sessions/execution-times.jsonl', [], 'prompt', 'operation-times');
      const begin = observations.find((observation) => observation.observationKind === 'begin');
      const beginFields = begin?.fields as { startedAtMs?: unknown } | undefined;
      assert.equal(beginFields?.startedAtMs, begin?.observedAtMs,
        'the canonical begin envelope and field share one source sample');

      stats.onAgentSettled({
        sessionPath: '/sessions/execution-times.jsonl',
        operationId: 'operation-times',
        capabilities: {} as never,
        occurredAt: 1_800_000_000_100,
        endedAt: 1_800_000_000_101,
      });
      const end = observations.find((observation) => observation.observationKind === 'end');
      assert.equal(end?.observedAtMs, 1_800_000_000_101);
      const endFields = end?.fields as { endedAtMs?: unknown; outcome?: unknown } | undefined;
      assert.equal(endFields?.endedAtMs, 1_800_000_000_101);
      assert.equal(endFields?.outcome, 'unknown');
    } finally {
      await stats.shutdown();
    }
  });
});

test('branch snapshot hydration submits each durable ancestry edge once across long-session refreshes', async () => {
  await withTempDir(async (tempDir) => {
    const observations: AnalyticsObservation<object>[] = [];
    const capture = new CanonicalAnalyticsCapture({
      authority: 'canonical',
      generationId: 'generation-branch-cardinality',
      workspaceId: 'workspace-branch-cardinality',
      buildId: 'build-branch-cardinality',
      processGeneration: 'process-branch-cardinality',
      sink: { submit: (observation) => { observations.push(observation); } },
      detailSink: { submitDetail: () => undefined },
      lifecycleSink: {
        bindPendingCreate: async () => undefined,
        deleteSession: async () => undefined,
      },
    });
    const sessionPath = '/sessions/long-branch.jsonl';
    const stats = new StatsService({
      ...optionsFor(
        path.join(tempDir, 'analytics'),
        tempDir,
        createInitialArchState(),
        { renders: 0 },
      ),
      analyticsCapture: capture,
    });
    const branchEntryIds = Array.from({ length: 10_000 }, (_, index) => `entry-${index}`);

    stats.onSessionUsageSnapshot(
      sessionPath,
      'session-long-branch',
      { samples: [], branchId: branchEntryIds.at(-1), branchEntryIds },
      'snapshot-initial',
      1_800_000_000_000,
    );
    const initialEdges = observations.filter((observation) => (
      observation.entityKind === 'branch' && observation.observationKind === 'observation'
    ));
    assert.equal(initialEdges.length, branchEntryIds.length);

    let unchangedEntryReads = 0;
    const unchangedEntries = new Proxy(branchEntryIds, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) unchangedEntryReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    stats.onSessionUsageSnapshot(
      sessionPath,
      'session-long-branch',
      { samples: [], branchId: branchEntryIds.at(-1), branchEntryIds: unchangedEntries },
      'snapshot-refresh',
      1_800_000_001_000,
    );
    assert.equal(unchangedEntryReads, 0, 'an unchanged refresh must not scan branch entries');
    assert.equal(observations.filter((observation) => (
      observation.entityKind === 'branch' && observation.observationKind === 'observation'
    )).length, branchEntryIds.length, 'an unchanged refresh must not resend ancestry');

    const appendedEntryIds = [...branchEntryIds, 'entry-10000'];
    let appendedEntryReads = 0;
    const appendedEntries = new Proxy(appendedEntryIds, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) appendedEntryReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    stats.onSessionUsageSnapshot(
      sessionPath,
      'session-long-branch',
      { samples: [], branchId: appendedEntryIds.at(-1), branchEntryIds: appendedEntries },
      'snapshot-appended',
      1_800_000_002_000,
    );
    assert.ok(appendedEntryReads <= 6, `one appended edge read ${appendedEntryReads} ancestry entries`);
    const finalEdges = observations.filter((observation) => (
      observation.entityKind === 'branch' && observation.observationKind === 'observation'
    ));
    assert.equal(finalEdges.length, appendedEntryIds.length, 'only the appended edge is submitted');
    const appendedEdge = finalEdges.at(-1);
    assert.ok(appendedEdge);
    assert.ok('sourceEntryId' in appendedEdge.fields);
    assert.equal(appendedEdge.fields.sourceEntryId, 'entry-10000');
  });
});

test('host replacement retains the exact pending-create origin through bind and private close', async () => {
  await withTempDir(async (tempDir) => {
    const state = createInitialArchState();
    const boundSubjects: string[] = [];
    const deletedSubjects: Array<string | undefined> = [];
    const deletedRoots: string[] = [];
    const capture = new CanonicalAnalyticsCapture({
      authority: 'canonical',
      generationId: 'generation-host-pending',
      workspaceId: 'workspace-host-pending',
      buildId: 'build-host-pending',
      processGeneration: 'process-host-pending',
      sink: { submit: () => undefined },
      detailSink: { submitDetail: () => undefined },
      lifecycleSink: {
        bindPendingCreate: async (pendingOperationId) => { boundSubjects.push(pendingOperationId); },
        deleteSession: async (root, _source, _timestamp, pendingOperationId) => {
          deletedRoots.push(root);
          deletedSubjects.push(pendingOperationId);
        },
      },
    });
    const stats = new StatsService({
      ...optionsFor(path.join(tempDir, 'analytics'), tempDir, state, { renders: 0 }),
      analyticsCapture: capture,
    });

    stats.replaceSessionPath(
      'pending:shared-path-alias',
      '/sessions/root-private.jsonl',
      'root-private',
      'actual-create-origin',
    );
    await stats.closePrivateSessionAnalytics(
      '/sessions/root-private.jsonl',
      undefined,
      'root-private',
    );

    assert.deepEqual(deletedRoots, ['root-private']);
    assert.equal(boundSubjects.length, 1);
    assert.deepEqual(deletedSubjects, boundSubjects);
    assert.notEqual(boundSubjects[0], 'actual-create-origin');
    assert.notEqual(boundSubjects[0], 'cleanup-close-operation');
  });
});
