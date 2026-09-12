import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ANALYTICS_SCHEMA_VERSION,
  deriveAnalyticsIdempotencyKey,
  type AnalyticsObservation,
} from '../../../../shared/analytics/contracts.js';
import {
  CanonicalAnalyticsReadModel,
  canonicalAnalyticsDatabasePath,
} from '../../../src/analytics/query-entry.js';
import { SqliteAnalyticsRecorder } from '../../../src/analytics/sqlite-recorder.js';
import { CanonicalAnalyticsCapture } from '../../../src/analytics/canonical-capture.js';
import { AggregateStatsService } from '../../../src/host/aggregate-stats-service.js';
import { createInitialArchState } from '../../../src/host/core/arch-state.js';
import { StatsService } from '../../../src/host/stats-service/index.js';
import { EMPTY_PROVIDER_GATE_STATS } from '../../../src/shared/protocol/aggregate-stats.js';

const workerScript = fileURLToPath(new URL('../../../src/analytics/query-worker-entry.ts', import.meta.url));
const execArgv = [
  `--import=${new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url).href}`,
];

/**
 * The recorder API is synchronous, but a fixture should also leave a clean
 * WAL boundary before a separate read-only helper opens the database. The
 * checkpoint is the completion observation; no wall-clock sleep is used.
 */
function closeFixtureWriter(writer: SqliteAnalyticsRecorder): void {
  const checkpoint = writer.truncateWalAndRead();
  assert.equal(Number(checkpoint.busy), 0, 'fixture writer must finish its WAL checkpoint before close');
  writer.close();
}

function settlement(options: {
  invocationId: string;
  rootSessionId: string;
  purpose: string;
  settledAtMs: number;
  inputTokens: number;
  outputTokens?: number;
  reportedCostUsd: number;
  generationId?: string;
  branchId?: string;
}): AnalyticsObservation<object> {
  const base: Omit<AnalyticsObservation<object>, 'idempotencyKey'> = {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: options.generationId ?? 'generation-historical',
    producerKind: 'test',
    sourceKey: options.invocationId,
    entityKind: 'providerCall',
    entityKey: options.invocationId,
    observationKind: 'providerSettlement',
    observedAtMs: options.settledAtMs,
    scope: {
      workspaceCoverage: 'known',
      workspaceId: 'workspace-historical',
      rootSessionId: options.rootSessionId,
      invocationId: options.invocationId,
      ...(options.branchId ? { branchId: options.branchId } : {}),
    },
    captureSubject: { kind: 'session', rootSessionId: options.rootSessionId },
    producer: { buildId: 'test-build', processGeneration: 'test-process' },
    fields: {
      invocationId: options.invocationId,
      sourceId: options.invocationId,
      provider: 'fixture-provider',
      dispatchedModel: 'fixture/model',
      reportedModel: 'fixture/model',
      purpose: options.purpose,
      outcome: options.purpose === 'retry' ? 'failed' : 'succeeded',
      startedAtMs: options.settledAtMs - 1_000,
      endedAtMs: options.settledAtMs,
      settledAtMs: options.settledAtMs,
      inputTokens: options.inputTokens,
      ...(options.outputTokens === undefined ? {} : { outputTokens: options.outputTokens }),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      providerTotalTokens: options.inputTokens + (options.outputTokens ?? 0),
      reportedCostUsd: options.reportedCostUsd,
      inputIncludesCache: false,
      outputIncludesReasoning: true,
      cacheChannelsOmittedAsZero: false,
      coverage: options.outputTokens === undefined ? 'unknown' : 'known',
    },
  };
  return { ...base, idempotencyKey: deriveAnalyticsIdempotencyKey(base) };
}

function branchObservation(options: {
  branchId: string;
  parentBranchId: string | null;
  rootSessionId: string;
  observedAtMs: number;
  selection?: boolean;
}): AnalyticsObservation<object> {
  const base: Omit<AnalyticsObservation<object>, 'idempotencyKey'> = {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: 'generation-historical',
    producerKind: 'test',
    sourceKey: `${options.selection ? 'selection' : 'edge'}:${options.branchId}`,
    entityKind: 'branch',
    entityKey: options.branchId,
    observationKind: options.selection ? 'phase' : 'observation',
    observedAtMs: options.observedAtMs,
    scope: {
      workspaceCoverage: 'known',
      workspaceId: 'workspace-historical',
      rootSessionId: options.rootSessionId,
      branchId: options.branchId,
    },
    captureSubject: { kind: 'session', rootSessionId: options.rootSessionId },
    producer: { buildId: 'test-build', processGeneration: 'test-process' },
    fields: {
      branchId: options.branchId,
      parentBranchId: options.parentBranchId,
      sourceEntryId: options.branchId,
      ...(options.selection ? { sourceSelectionId: `selection:${options.branchId}` } : {}),
    },
  };
  return { ...base, idempotencyKey: deriveAnalyticsIdempotencyKey(base) };
}

test('canonical historical session and aggregate projections survive a new host and revision refresh', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-canonical-historical-'));
  const databasePath = canonicalAnalyticsDatabasePath(path.join(root, 'analytics'));
  const writer = new SqliteAnalyticsRecorder(databasePath);
  const at = Date.parse('2026-01-15T12:00:00.000Z');
  writer.submitBatch([
    settlement({ invocationId: 'inv-conversation', rootSessionId: 'root-historical', purpose: 'conversation', settledAtMs: at, inputTokens: 100, outputTokens: 50, reportedCostUsd: 0.04 }),
    settlement({ invocationId: 'inv-retry', rootSessionId: 'root-historical', purpose: 'retry', settledAtMs: at + 1_000, inputTokens: 200, reportedCostUsd: 0.01 }),
  ]);
  closeFixtureWriter(writer);

  const readModel = new CanonicalAnalyticsReadModel({ databasePath, workerScript, execArgv, timeoutMs: 20_000, revisionPollIntervalMs: 25 });
  const state = createInitialArchState();
  state.sessions.sessions.push({
    path: '/sessions/historical.jsonl',
    name: 'historical',
    cwd: '/sessions',
    modifiedAt: new Date(at).toISOString(),
    messageCount: 2,
    sessionId: 'root-historical',
  });
  state.sessions.activeSessionPath = '/sessions/historical.jsonl';
  state.sessions.openTabPaths = ['/sessions/historical.jsonl'];
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical',
    generationId: 'generation-historical',
    workspaceId: 'workspace-historical',
    buildId: 'test-build',
    processGeneration: 'test-process',
    sink: { submit: () => undefined },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
  const stats = new StatsService({
    dataOutcomesRootPath: path.join(root, 'legacy'),
    workspaceId: 'workspace-historical',
    getArchState: () => state,
    now: () => new Date(at + 2_000),
    analyticsCapture: capture,
    analyticsReadModel: readModel,
  });
  const aggregate = new AggregateStatsService({
    getArchState: () => state,
    statsService: stats,
    tokenRateService: { getRates: () => ({}) } as never,
    getAgentDir: () => null,
    fetchProviderGateStats: async () => EMPTY_PROVIDER_GATE_STATS,
    onChanged: () => undefined,
    now: () => new Date(at + 2_000),
  });
  try {
    await stats.start();
    const usage = stats.getSessionUsage('/sessions/historical.jsonl');
    assert.equal(usage.authority, 'canonical');
    assert.deepEqual(usage.samples.map((sample) => sample.kind), ['conversation', 'retry']);
    assert.equal(usage.samples.find((sample) => sample.kind === 'retry')?.instrumentationGap, true);
    assert.deepEqual(await stats.queryPersistedRunAnalytics(), { completedRuns: [], openRuns: [] });

    await (aggregate as unknown as { recompute(): Promise<void> }).recompute();
    const first = aggregate.getAggregateStats();
    assert.equal(first.ready, true);
    assert.equal(first.totalCost, 0.05);
    assert.equal(first.totalInputTokens, 300);
    assert.equal(first.totalOutputTokens, 50);
    assert.equal(first.sessionCount, 1);
    assert.equal(first.billableAccounting?.invocationCount, 2);

    const lateWriter = new SqliteAnalyticsRecorder(databasePath);
    lateWriter.submit(settlement({ invocationId: 'inv-late', rootSessionId: 'root-historical', purpose: 'conversation', settledAtMs: at + 1_500, inputTokens: 25, outputTokens: 10, reportedCostUsd: 0.02 }));
    lateWriter.close();
    const revision = await readModel.waitForRevision(await readModel.readRevision(), { maxWaitMs: 2_000 });
    assert.ok(BigInt(revision) > 0n);
    await (aggregate as unknown as { recompute(): Promise<void> }).recompute();
    assert.equal(aggregate.getAggregateStats().totalCost, 0.07);
    assert.equal(stats.getSessionUsage('/sessions/historical.jsonl').samples.length, 3);

    const deleteWriter = new SqliteAnalyticsRecorder(databasePath);
    deleteWriter.deleteSession('root-historical', 'private-close-historical', at + 3_000);
    deleteWriter.close();
    // SqliteAnalyticsRecorder.close() is synchronous: deleteSession commits
    // before it returns and Database.close() releases the writer handles.
    // The read helper is separately awaited by waitForRevision and shutdown.
    const deletedRevision = await readModel.waitForRevision(revision, { maxWaitMs: 2_000 });
    assert.ok(BigInt(deletedRevision) > BigInt(revision));
    await (aggregate as unknown as { recompute(): Promise<void> }).recompute();
    assert.equal(aggregate.getAggregateStats().totalCost, 0);
    for (let index = 0; index < 50 && stats.getSessionUsage('/sessions/historical.jsonl').samples.length > 0; index += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(stats.getSessionUsage('/sessions/historical.jsonl').samples.length, 0);
  } finally {
    aggregate.dispose();
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('open private usage remains visible until close and a peer delete cannot resurrect local rows', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-canonical-private-peer-'));
  const databasePath = canonicalAnalyticsDatabasePath(path.join(root, 'analytics'));
  const at = Date.parse('2026-01-15T12:00:00.000Z');
  const writerA = new SqliteAnalyticsRecorder(databasePath);
  writerA.submit(settlement({
    invocationId: 'inv-private',
    rootSessionId: 'root-private',
    purpose: 'conversation',
    settledAtMs: at,
    inputTokens: 10,
    outputTokens: 5,
    reportedCostUsd: 0.03,
  }));
  closeFixtureWriter(writerA);

  const stateA = createInitialArchState();
  const sessionPath = '/sessions/private.jsonl';
  stateA.sessions.privacyModeBySession[sessionPath] = true;
  stateA.sessions.sessions.push({
    path: sessionPath,
    name: 'private',
    cwd: '/sessions',
    modifiedAt: new Date(at).toISOString(),
    messageCount: 1,
    sessionId: 'root-private',
  });
  stateA.sessions.activeSessionPath = sessionPath;
  stateA.sessions.openTabPaths = [sessionPath];
  const lifecycleEvents: unknown[] = [];
  const readModel = new CanonicalAnalyticsReadModel({
    databasePath,
    workerScript,
    execArgv,
    revisionPollIntervalMs: 25,
    onQueryLifecycle: (event) => lifecycleEvents.push(structuredClone(event)),
  });
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical',
    generationId: 'generation-historical',
    workspaceId: 'workspace-historical',
    buildId: 'test-build',
    processGeneration: 'test-process',
    sink: { submit: () => undefined },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
  const statsA = new StatsService({
    dataOutcomesRootPath: path.join(root, 'legacy'),
    workspaceId: 'workspace-historical',
    getArchState: () => stateA,
    now: () => new Date(at + 2_000),
    analyticsCapture: capture,
    analyticsReadModel: readModel,
  });
  try {
    statsA.onAssistantTurnEnded(sessionPath, 'pre-hydration-local', 100, {
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 30,
      reportedCostUsd: 0.07,
    }, 'completed', undefined, { occurredAt: new Date(at + 500).toISOString() });
    assert.equal(statsA.getSessionUsage(sessionPath).authority, 'unknown', 'canonical hydration must fail closed before durable read');
    await statsA.start();
    assert.equal(
      statsA.getSessionUsage(sessionPath).authority,
      'canonical',
      JSON.stringify({ databasePath, lifecycleEvents }),
    );
    assert.equal(statsA.getSessionUsage(sessionPath).samples.length, 1, 'open private usage must remain queryable');

    // Keep a stale process-local observation that would have been merged by
    // the old adapter after the peer deletion.
    statsA.onAssistantTurnEnded(sessionPath, 'stale-local-turn', 100, {
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 30,
      reportedCostUsd: 0.07,
    }, 'completed', undefined, { occurredAt: new Date(at + 1_000).toISOString() });
    assert.equal(statsA.getSessionUsage(sessionPath).samples.length, 1, 'durable cache must remain authoritative');

    const beforeDelete = await readModel.readRevision();
    const writerB = new SqliteAnalyticsRecorder(databasePath);
    writerB.deleteSession('root-private', 'private-close-peer', at + 3_000);
    writerB.close();
    await readModel.waitForRevision(beforeDelete, { maxWaitMs: 2_000 });
    for (let index = 0; index < 160; index += 1) {
      const candidate = statsA.getSessionUsage(sessionPath);
      if (candidate.authority === 'canonical' && candidate.samples.length === 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    const afterDelete = statsA.getSessionUsage(sessionPath);
    assert.equal(afterDelete.authority, 'canonical');
    assert.equal(afterDelete.samples.length, 0, 'peer private delete must tombstone local durable usage');
  } finally {
    await statsA.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical refresh rejects a delayed pre-delete response instead of resurrecting rows', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-canonical-refresh-race-'));
  const databasePath = canonicalAnalyticsDatabasePath(path.join(root, 'analytics'));
  const at = Date.parse('2026-01-15T12:00:00.000Z');
  const writer = new SqliteAnalyticsRecorder(databasePath);
  writer.submit(settlement({
    invocationId: 'inv-race',
    rootSessionId: 'root-race',
    purpose: 'conversation',
    settledAtMs: at,
    inputTokens: 10,
    outputTokens: 5,
    reportedCostUsd: 0.03,
  }));
  closeFixtureWriter(writer);
  const state = createInitialArchState();
  const sessionPath = '/sessions/race.jsonl';
  state.sessions.sessions.push({
    path: sessionPath,
    name: 'race',
    cwd: '/sessions',
    modifiedAt: new Date(at).toISOString(),
    messageCount: 1,
    sessionId: 'root-race',
  });
  state.sessions.activeSessionPath = sessionPath;
  state.sessions.openTabPaths = [sessionPath];
  const lifecycleEvents: unknown[] = [];
  const baseReadModel = new CanonicalAnalyticsReadModel({
    databasePath,
    workerScript,
    execArgv,
    timeoutMs: 5_000,
    revisionPollIntervalMs: 25,
    onQueryLifecycle: (event) => lifecycleEvents.push(structuredClone(event)),
  });
  const originalRead = baseReadModel.readScopedProviderSettlements.bind(baseReadModel);
  let holdNextRead = false;
  let captureOldRead: () => void = () => undefined;
  let rejectOldRead: (reason?: unknown) => void = () => undefined;
  const oldReadCaptured = new Promise<void>((resolve, reject) => {
    captureOldRead = () => resolve();
    rejectOldRead = reject;
  });
  // Keep a rejection handler attached while the delayed helper is starting;
  // the test later awaits the same promise to preserve the original failure.
  void oldReadCaptured.catch(() => undefined);
  let releaseOldRead: () => void = () => undefined;
  const heldReadReleased = new Promise<void>((resolve) => {
    releaseOldRead = resolve;
  });
  const delayedReadModel = Object.create(baseReadModel) as CanonicalAnalyticsReadModel;
  delayedReadModel.readScopedProviderSettlements = async (scope, page, signal) => {
    let result: Awaited<ReturnType<typeof originalRead>>;
    try {
      result = await originalRead(scope, page, signal);
    } catch (error) {
      if (holdNextRead) {
        holdNextRead = false;
        rejectOldRead(error);
      }
      throw error;
    }
    if (!holdNextRead) return result;
    holdNextRead = false;
    captureOldRead();
    await heldReadReleased;
    return result;
  };
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical',
    generationId: 'generation-historical',
    workspaceId: 'workspace-historical',
    buildId: 'test-build',
    processGeneration: 'test-process',
    sink: { submit: () => undefined },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
  const stats = new StatsService({
    dataOutcomesRootPath: path.join(root, 'legacy'),
    workspaceId: 'workspace-historical',
    getArchState: () => state,
    now: () => new Date(at + 2_000),
    analyticsCapture: capture,
    analyticsReadModel: delayedReadModel,
  });
  try {
    await stats.start();
    assert.equal(stats.getSessionUsage(sessionPath).samples.length, 1);
    holdNextRead = true;
    const refresh = (stats as unknown as { refreshCanonicalSessionUsage(): Promise<void> }).refreshCanonicalSessionUsage();
    const handshakeTimeout = setTimeout(() => {
      rejectOldRead(new Error(
        `Timed out waiting for delayed canonical read (database=${databasePath}, rootSessionId=root-race, workerLifecycle=${JSON.stringify(lifecycleEvents)}).`,
      ));
    }, 5_000);
    try {
      await oldReadCaptured;
    } catch (error) {
      throw new Error(
        `Delayed canonical read handshake failed (database=${databasePath}, rootSessionId=root-race, workerLifecycle=${JSON.stringify(lifecycleEvents)}): ${String(error)}`,
        { cause: error },
      );
    } finally {
      clearTimeout(handshakeTimeout);
    }
    const beforeDelete = await baseReadModel.readRevision();
    const deleteWriter = new SqliteAnalyticsRecorder(databasePath);
    deleteWriter.deleteSession('root-race', 'private-close-race', at + 3_000);
    deleteWriter.close();
    const deletedRevision = await baseReadModel.readRevision();
    assert.ok(BigInt(deletedRevision) > BigInt(beforeDelete), 'peer delete must advance the durable revision');
    (stats as unknown as { markCanonicalRevisionDirty(revision: string): void })
      .markCanonicalRevisionDirty(deletedRevision);
    assert.equal(stats.getSessionUsage(sessionPath).authority, 'unknown');
    assert.equal(stats.getSessionUsage(sessionPath).samples.length, 0);
    releaseOldRead();
    await refresh;
    assert.equal(stats.getSessionUsage(sessionPath).authority, 'canonical');
    assert.equal(stats.getSessionUsage(sessionPath).samples.length, 0);
  } finally {
    // The delayed helper may still be between its capture handshake and the
    // held-read release when an assertion or timeout fails. Resolve this gate
    // before StatsService.shutdown() drains tracked work, so cleanup cannot
    // wait forever on a deliberately paused response.
    releaseOldRead();
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical hydration uses the durable selected branch and excludes abandoned branches', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-canonical-selected-branch-'));
  const databasePath = canonicalAnalyticsDatabasePath(path.join(root, 'analytics'));
  const at = Date.parse('2026-01-15T12:00:00.000Z');
  const writer = new SqliteAnalyticsRecorder(databasePath);
  writer.submitBatch([
    branchObservation({ branchId: 'branch-a', parentBranchId: null, rootSessionId: 'root-branch', observedAtMs: at }),
    branchObservation({ branchId: 'branch-b', parentBranchId: 'branch-a', rootSessionId: 'root-branch', observedAtMs: at + 1 }),
    branchObservation({ branchId: 'branch-c', parentBranchId: 'branch-a', rootSessionId: 'root-branch', observedAtMs: at + 2 }),
    branchObservation({ branchId: 'branch-b', parentBranchId: 'branch-a', rootSessionId: 'root-branch', observedAtMs: at + 3, selection: true }),
    settlement({ invocationId: 'inv-branch-a', rootSessionId: 'root-branch', purpose: 'conversation', settledAtMs: at + 4, inputTokens: 10, outputTokens: 5, reportedCostUsd: 0.01, branchId: 'branch-a' }),
    settlement({ invocationId: 'inv-branch-b', rootSessionId: 'root-branch', purpose: 'conversation', settledAtMs: at + 5, inputTokens: 20, outputTokens: 5, reportedCostUsd: 0.02, branchId: 'branch-b' }),
    settlement({ invocationId: 'inv-branch-c', rootSessionId: 'root-branch', purpose: 'conversation', settledAtMs: at + 6, inputTokens: 30, outputTokens: 5, reportedCostUsd: 0.03, branchId: 'branch-c' }),
  ]);
  closeFixtureWriter(writer);
  const state = createInitialArchState();
  const sessionPath = '/sessions/branch.jsonl';
  state.sessions.sessions.push({
    path: sessionPath,
    name: 'branch',
    cwd: '/sessions',
    modifiedAt: new Date(at).toISOString(),
    messageCount: 3,
    sessionId: 'root-branch',
  });
  state.sessions.activeSessionPath = sessionPath;
  state.sessions.openTabPaths = [sessionPath];
  const readModel = new CanonicalAnalyticsReadModel({ databasePath, workerScript, execArgv, revisionPollIntervalMs: 25 });
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical',
    generationId: 'generation-historical',
    workspaceId: 'workspace-historical',
    buildId: 'test-build',
    processGeneration: 'test-process',
    sink: { submit: () => undefined },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
  const stats = new StatsService({
    dataOutcomesRootPath: path.join(root, 'legacy'),
    workspaceId: 'workspace-historical',
    getArchState: () => state,
    now: () => new Date(at + 2_000),
    analyticsCapture: capture,
    analyticsReadModel: readModel,
  });
  try {
    stats.onBranchObserved(sessionPath, 'branch-b', 'branch-a', 'branch-b', at + 3);
    await stats.start();
    const usage = stats.getSessionUsage(sessionPath);
    assert.equal(usage.authority, 'canonical');
    assert.equal(usage.branchId, 'branch-b');
    assert.deepEqual(usage.samples.map((sample) => sample.sourceId), ['inv-branch-a', 'inv-branch-b']);
  } finally {
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical startup hydrates visible sessions within query capacity and isolates one failed session', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-canonical-hydration-bound-'));
  const databasePath = canonicalAnalyticsDatabasePath(path.join(root, 'analytics'));
  const at = Date.parse('2026-01-15T12:00:00.000Z');
  const writer = new SqliteAnalyticsRecorder(databasePath);
  writer.submitBatch(Array.from({ length: 11 }, (_, index) => settlement({
    invocationId: `inv-hydration-${index}`,
    rootSessionId: index === 5 ? 'root-fail' : `root-hydration-${index}`,
    purpose: 'conversation',
    settledAtMs: at + index,
    inputTokens: 10,
    outputTokens: 5,
    reportedCostUsd: 0.01,
  })));
  closeFixtureWriter(writer);

  const state = createInitialArchState();
  for (let index = 0; index < 11; index += 1) {
    const rootSessionId = index === 5 ? 'root-fail' : `root-hydration-${index}`;
    state.sessions.sessions.push({
      path: `/sessions/hydration-${index}.jsonl`,
      name: `hydration-${index}`,
      cwd: '/sessions',
      modifiedAt: new Date(at).toISOString(),
      messageCount: 1,
      sessionId: rootSessionId,
    });
  }
  const activePath = '/sessions/hydration-0.jsonl';
  state.sessions.activeSessionPath = activePath;
  state.sessions.openTabPaths = [activePath];
  const requestedRootSessionIds: string[] = [];
  const baseReadModel = new CanonicalAnalyticsReadModel({ databasePath, workerScript, execArgv, revisionPollIntervalMs: 25 });
  let active = 0;
  let maximumActive = 0;
  const boundedReadModel = Object.create(baseReadModel) as CanonicalAnalyticsReadModel;
  const originalRead = baseReadModel.readScopedProviderSettlements.bind(baseReadModel);
  boundedReadModel.readScopedProviderSettlements = async (scope, page, signal) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    if (scope.kind === 'rootSession') requestedRootSessionIds.push(scope.rootSessionId);
    try {
      if (scope.kind === 'rootSession' && scope.rootSessionId === 'root-fail') {
        throw new Error('synthetic one-session read failure');
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      return await originalRead(scope, page, signal);
    } finally {
      active -= 1;
    }
  };
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical',
    generationId: 'generation-historical',
    workspaceId: 'workspace-historical',
    buildId: 'test-build',
    processGeneration: 'test-process',
    sink: { submit: () => undefined },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
  const stats = new StatsService({
    dataOutcomesRootPath: path.join(root, 'legacy'),
    workspaceId: 'workspace-historical',
    getArchState: () => state,
    now: () => new Date(at + 2_000),
    analyticsCapture: capture,
    analyticsReadModel: boundedReadModel,
  });
  try {
    await stats.start();
    assert.ok(maximumActive <= baseReadModel.getMaxConcurrentQueries());
    assert.deepEqual(requestedRootSessionIds, ['root-hydration-0'], 'startup reads only the active catalog session');
    assert.equal(stats.getSessionUsage(activePath).authority, 'canonical');
    assert.equal(stats.getSessionUsage(activePath).samples.length, 1);
    for (const index of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const usage = stats.getSessionUsage(`/sessions/hydration-${index}.jsonl`);
      assert.equal(usage.authority, 'unknown', `catalog session ${index} remains lazy`);
    }
    const lazyPath = '/sessions/hydration-1.jsonl';
    assert.equal(stats.getSessionUsage(lazyPath).authority, 'unknown');
    for (let attempt = 0; attempt < 100 && stats.getSessionUsage(lazyPath).authority !== 'canonical'; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(stats.getSessionUsage(lazyPath).authority, 'canonical');
    assert.equal(stats.getSessionUsage(lazyPath).samples.length, 1);
    const failedPath = '/sessions/hydration-5.jsonl';
    assert.equal(stats.getSessionUsage(failedPath).authority, 'unknown');
    for (let attempt = 0; attempt < 100 && !requestedRootSessionIds.includes('root-fail'); attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(requestedRootSessionIds.includes('root-fail'), 'lazy failed session read must be attempted');
    assert.equal(stats.getSessionUsage(failedPath).authority, 'unknown');
  } finally {
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical revision refresh keeps the active session current with a large catalog', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-canonical-revision-bound-'));
  const state = createInitialArchState();
  const activePath = '/sessions/active.jsonl';
  state.sessions.activeSessionPath = activePath;
  state.sessions.openTabPaths = [activePath];
  for (let index = 0; index < 320; index += 1) {
    const sessionPath = index === 0 ? activePath : `/sessions/catalog-${index}.jsonl`;
    state.sessions.sessions.push({
      path: sessionPath,
      name: `catalog-${index}`,
      cwd: '/sessions',
      modifiedAt: new Date(1_700_000_000_000 + index).toISOString(),
      messageCount: 1,
      sessionId: index === 0 ? 'root-active' : `root-catalog-${index}`,
    });
  }
  let revision = '1';
  const requestedRootSessionIds: string[] = [];
  let holdNextRead = false;
  let signalReadStarted: () => void = () => undefined;
  const readStarted = new Promise<void>((resolve) => { signalReadStarted = resolve; });
  let releaseHeldRead: () => void = () => undefined;
  const heldReadReleased = new Promise<void>((resolve) => { releaseHeldRead = resolve; });
  const readModel = {
    getMaxConcurrentQueries: () => 1,
    readRevision: async () => revision,
    readScopedProviderSettlements: async (scope: { rootSessionId: string }) => {
      const snapshotRevision = revision;
      requestedRootSessionIds.push(scope.rootSessionId);
      if (holdNextRead) {
        holdNextRead = false;
        signalReadStarted();
        await heldReadReleased;
      }
      return {
        revision: snapshotRevision,
        settlements: [],
        truncated: false,
        scope: { kind: 'rootSession' as const, rootSessionId: scope.rootSessionId },
      };
    },
  } as unknown as CanonicalAnalyticsReadModel;
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical',
    generationId: 'generation-revision-bound',
    workspaceId: 'workspace-revision-bound',
    buildId: 'test-build',
    processGeneration: 'test-process',
    sink: { submit: () => undefined },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
  const stats = new StatsService({
    dataOutcomesRootPath: path.join(root, 'legacy'),
    workspaceId: 'workspace-revision-bound',
    getArchState: () => state,
    analyticsCapture: capture,
    analyticsReadModel: readModel,
  });
  const internals = stats as unknown as {
    refreshCanonicalSessionUsage(): Promise<void>;
    markCanonicalRevisionDirty(nextRevision: string): void;
    canonicalSessionUsageByPath: Map<string, { revision: string }>;
  };
  try {
    await stats.start();
    assert.deepEqual(requestedRootSessionIds, ['root-active']);
    assert.equal(stats.getSessionUsage(activePath).authority, 'canonical');

    state.sessions.openTabPaths = [activePath, ...[1, 2, 3].map((index) => `/sessions/catalog-${index}.jsonl`)];
    holdNextRead = true;
    revision = '2';
    const refresh = internals.refreshCanonicalSessionUsage();
    await readStarted;
    for (let nextRevision = 3; nextRevision <= 12; nextRevision += 1) {
      revision = String(nextRevision);
      internals.markCanonicalRevisionDirty(revision);
    }
    releaseHeldRead();
    await refresh;

    assert.deepEqual(
      requestedRootSessionIds,
      ['root-active', 'root-active', 'root-active', 'root-catalog-1', 'root-catalog-2', 'root-catalog-3'],
      'an invalidated pass skips its remaining tabs and refreshes the active path first at the latest revision',
    );
    assert.equal(internals.canonicalSessionUsageByPath.get(activePath)?.revision, '12');
    assert.equal(stats.getSessionUsage('/sessions/catalog-319.jsonl').authority, 'unknown');
  } finally {
    releaseHeldRead();
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical lazy hydration never starts a query after terminal shutdown', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-canonical-shutdown-lazy-'));
  const state = createInitialArchState();
  let queryCount = 0;
  const readModel = {
    getMaxConcurrentQueries: () => 2,
    readScopedProviderSettlements: async () => {
      queryCount += 1;
      throw new Error('post-shutdown query must not start');
    },
  } as unknown as CanonicalAnalyticsReadModel;
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical',
    generationId: 'generation-shutdown-lazy',
    workspaceId: 'workspace-shutdown-lazy',
    buildId: 'test-build',
    processGeneration: 'test-process',
    sink: { submit: () => undefined },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
  const stats = new StatsService({
    dataOutcomesRootPath: path.join(root, 'legacy'),
    workspaceId: 'workspace-shutdown-lazy',
    getArchState: () => state,
    analyticsCapture: capture,
    analyticsReadModel: readModel,
  });
  try {
    await stats.shutdown();
    assert.equal(stats.getSessionUsage('/sessions/late-render.jsonl').authority, 'unknown');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(queryCount, 0, 'a final renderer read must not spawn a helper');
  } finally {
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical lazy hydration bounds distinct paths and reclaims epoch tokens', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-canonical-lazy-bound-'));
  const state = createInitialArchState();
  let active = 0;
  let maximumActive = 0;
  let queryCount = 0;
  let holdReads = true;
  const blockedResolvers: Array<() => void> = [];
  const readModel = {
    getMaxConcurrentQueries: () => 2,
    readScopedProviderSettlements: async (scope: { rootSessionId: string }) => {
      queryCount += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (holdReads) {
        await new Promise<void>((resolve) => blockedResolvers.push(resolve));
      }
      active -= 1;
      return {
        revision: '1',
        settlements: [],
        truncated: false,
        scope: { kind: 'rootSession' as const, rootSessionId: scope.rootSessionId },
      };
    },
  } as unknown as CanonicalAnalyticsReadModel;
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical',
    generationId: 'generation-lazy-bound',
    workspaceId: 'workspace-lazy-bound',
    buildId: 'test-build',
    processGeneration: 'test-process',
    sink: { submit: () => undefined },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
  const stats = new StatsService({
    dataOutcomesRootPath: path.join(root, 'legacy'),
    workspaceId: 'workspace-lazy-bound',
    getArchState: () => state,
    analyticsCapture: capture,
    analyticsReadModel: readModel,
  });
  const internals = stats as unknown as {
    canonicalSessionPathRefreshes: Map<string, Promise<void>>;
    canonicalSessionPathEpochs: Map<string, number>;
  };
  try {
    const paths = Array.from({ length: 320 }, (_, index) => `/sessions/lazy-${index}.jsonl`);
    for (const sessionPath of paths.slice(0, 4)) {
      assert.equal(stats.getSessionUsage(sessionPath).authority, 'unknown');
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(queryCount, 2, 'distinct lazy paths must share the bounded read capacity');
    assert.equal(maximumActive, 2);
    assert.equal(internals.canonicalSessionPathRefreshes.size, 2);

    holdReads = false;
    blockedResolvers.splice(0).forEach((resolve) => resolve());
    for (let attempt = 0; attempt < 100 && internals.canonicalSessionPathRefreshes.size > 0; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(internals.canonicalSessionPathRefreshes.size, 0);

    for (const sessionPath of paths.slice(2)) {
      assert.equal(stats.getSessionUsage(sessionPath).authority, 'unknown');
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (stats.getSessionUsage(sessionPath).authority === 'canonical'
          && internals.canonicalSessionPathRefreshes.size === 0) break;
      }
      assert.equal(stats.getSessionUsage(sessionPath).authority, 'canonical');
    }
    assert.ok(internals.canonicalSessionPathEpochs.size <= 256, 'epoch tokens must follow bounded cache retention');
  } finally {
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});
