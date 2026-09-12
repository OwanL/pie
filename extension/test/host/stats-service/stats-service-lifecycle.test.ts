import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  RUN_ANALYTICS_SCHEMA_VERSION,
  createEmptyFileMutationRollup,
  createEmptyToolUsageRollup,
  createEmptyVerificationRollup,
} from '../../../src/host/run-analytics';
import { StatsService } from '../../../src/host/stats-service';
import { workspaceHash } from '../../../src/host/stats-service/helpers';
import { createInitialArchState, type ArchState } from '../../../src/host/core/arch-state';
import { CanonicalAnalyticsCapture } from '../../../src/analytics/canonical-capture.js';
import type { AnalyticsObservation } from '../../../../shared/analytics/contracts.js';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-stats-lifecycle-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** A completed legacy run snapshot that survives coerceRunSnapshot and carries
 *  token usage so the historical migration emits one conversation-residual row
 *  (`legacy-run:<runId>:conversation-residual`) per run. */
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
    schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
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

async function pumpMacrotasks(ticks = 25): Promise<void> {
  for (let index = 0; index < ticks; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
}

test('the canonical read model is withheld unless canonical authority is active', async () => {
  await withTempDir(async (tempDir) => {
    const state = createInitialArchState();
    // The host wires a read model at startup regardless of authority, so the
    // accessor is what has to withhold it. A consumer that read canonical data
    // under legacy authority would be reading a store nothing is writing.
    const readModel = {} as NonNullable<ReturnType<StatsService['getAnalyticsReadModel']>>;
    const legacyStats = new StatsService({
      ...optionsFor(path.join(tempDir, 'analytics-legacy'), tempDir, state, { renders: 0 }),
      analyticsReadModel: readModel,
    });
    try {
      assert.equal(legacyStats.getAnalyticsReadModel(), undefined, 'legacy authority must not expose canonical reads');
    } finally {
      await legacyStats.shutdown();
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

test('shutdown during historical migration stops writes and renders at the run boundary and blocks start reactivation', async () => {
  await withTempDir(async (tempDir) => {
    const analyticsRoot = path.join(tempDir, 'data', 'outcomes');
    const storageDir = path.join(analyticsRoot, workspaceHash('workspace-migration-lifecycle'));
    const runA = legacyCompletedRun('legacy-run-a', { inputTokens: 100, outputTokens: 10 });
    const runB = legacyCompletedRun('legacy-run-b', { inputTokens: 200, outputTokens: 20 });
    await seedLegacyRunSnapshots(storageDir, [runA, runB]);

    const counters = { renders: 0 };
    const state = createInitialArchState();
    const stats = new StatsService(optionsFor(analyticsRoot, tempDir, state, counters));

    // Start without awaiting: the migration processes run A, then yields via
    // setImmediate between runs.
    const startPromise = stats.start();

    // Deterministically wait until run A's migration row exists. At this
    // moment the migration is suspended at its inter-run yield.
    const residualA = `legacy-run:${runA.runId}:conversation-residual`;
    const residualB = `legacy-run:${runB.runId}:conversation-residual`;
    let ticks = 0;
    while (!stats.getBillableInvocationRecords().some((record) => record.sourceId === residualA)) {
      if (++ticks > 10_000) {
        throw new Error('historical migration never processed the first legacy run');
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    // Shutdown synchronously marks the service disposed (cancelling the
    // suspended migration) and drains at the run boundary instead of waiting
    // out the remaining catalogue.
    const baselineRenders = counters.renders;
    await stats.shutdown();
    await startPromise;

    const ledgerPath = path.join(stats.getStorageDir(), 'billable-invocations.jsonl');
    const rowsAfterShutdown = (await fs.readFile(ledgerPath, 'utf8')).trim().split('\n');
    assert.equal(rowsAfterShutdown.length, 1, 'exactly the first legacy run must have migrated');
    const records = stats.getBillableInvocationRecords();
    assert.ok(records.some((record) => record.sourceId === residualA), 'run A migrated before shutdown');
    assert.equal(
      records.some((record) => record.sourceId === residualB),
      false,
      'shutdown must cancel the remaining migration instead of waiting for the full catalogue',
    );

    await pumpMacrotasks();
    assert.equal(counters.renders, baselineRenders, 'no render may be scheduled after shutdown');
    assert.equal(
      (await fs.readFile(ledgerPath, 'utf8')).trim().split('\n').length,
      1,
      'no ledger row may be written after shutdown',
    );

    // A late start() call must not reactivate the disposed service.
    await stats.start();
    await pumpMacrotasks();
    assert.equal(counters.renders, baselineRenders, 'start after shutdown must not render');
    assert.equal(
      stats.getBillableInvocationRecords().some((record) => record.sourceId === residualB),
      false,
      'start after shutdown must not re-run the historical migration',
    );
    assert.equal(
      (await fs.readFile(ledgerPath, 'utf8')).trim().split('\n').length,
      1,
      'start after shutdown must not write ledger rows',
    );
  });
});

test('a rejected persisted query after shutdown skips healing, migration, and render', async () => {
  await withTempDir(async (tempDir) => {
    const analyticsRoot = path.join(tempDir, 'data', 'outcomes');
    const counters = { renders: 0 };
    const stats = new StatsService(optionsFor(
      analyticsRoot,
      tempDir,
      createInitialArchState(),
      counters,
    ));
    const seams = stats as unknown as {
      storage: { queryPersistedRunAnalytics: () => Promise<never> };
      accounting: {
        healActivityFromLedger: (options?: { shouldContinue?: () => boolean }) => Promise<unknown>;
        migrateHistoricalRunUsage: () => Promise<void>;
      };
    };
    let healCalls = 0;
    let migrationCalls = 0;
    seams.accounting.healActivityFromLedger = () => {
      healCalls += 1;
      return Promise.resolve({
        ledgerRowsConsidered: 0,
        healedIntervals: 0,
        activityBatchFlushes: 0,
        durationMs: 0,
        cancelled: false,
      });
    };
    seams.accounting.migrateHistoricalRunUsage = async () => { migrationCalls += 1; };

    let rejectQuery!: (reason?: unknown) => void;
    let resolveQueryStarted!: () => void;
    const queryStarted = new Promise<void>((resolve) => { resolveQueryStarted = resolve; });
    seams.storage.queryPersistedRunAnalytics = () => {
      resolveQueryStarted();
      return new Promise<never>((_, reject) => { rejectQuery = reject; });
    };

    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => { unhandledRejections.push(reason); };
    process.on('unhandledRejection', onUnhandledRejection);
    const startPromise = stats.start();
    try {
      await queryStarted;
      await stats.shutdown();
      rejectQuery(new Error('controlled persisted-query failure after shutdown'));
      await startPromise;
      await pumpMacrotasks();

      assert.equal(healCalls, 0, 'shutdown must prevent activity healing after a rejected query');
      assert.equal(migrationCalls, 0, 'shutdown must prevent migration after a rejected query');
      assert.equal(counters.renders, 0, 'shutdown must prevent rendering after a rejected query');
      assert.deepEqual(unhandledRejections, [], 'the rejected query must be handled by start()');
    } finally {
      rejectQuery(new Error('release controlled persisted query'));
      await startPromise.catch(() => undefined);
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});

test('start() after shutdown never reactivates storage or migrates', async () => {
  await withTempDir(async (tempDir) => {
    const analyticsRoot = path.join(tempDir, 'data', 'outcomes');
    const storageDir = path.join(analyticsRoot, workspaceHash('workspace-migration-lifecycle'));
    const runA = legacyCompletedRun('legacy-run-a', { inputTokens: 100, outputTokens: 10 });
    await seedLegacyRunSnapshots(storageDir, [runA]);

    const counters = { renders: 0 };
    const state = createInitialArchState();
    const stats = new StatsService(optionsFor(analyticsRoot, tempDir, state, counters));
    await stats.shutdown();
    const baselineRenders = counters.renders;

    await stats.start();
    await pumpMacrotasks();

    assert.equal(counters.renders, baselineRenders, 'start after shutdown must be a no-op');
    await assert.rejects(
      fs.access(path.join(stats.getStorageDir(), 'billable-invocations.jsonl')),
      { code: 'ENOENT' },
      'start after shutdown must not restore/migrate storage',
    );
  });
});
