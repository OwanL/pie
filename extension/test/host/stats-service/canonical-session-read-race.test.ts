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
import { createInitialArchState } from '../../../src/host/core/arch-state.js';
import { StatsService } from '../../../src/host/stats-service/index.js';

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
  branchId?: string;
}): AnalyticsObservation<object> {
  const base: Omit<AnalyticsObservation<object>, 'idempotencyKey'> = {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: 'generation-historical',
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
      outcome: 'succeeded',
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
      coverage: 'known',
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

const ROOT_ID = 'root-read-race';
const SESSION_PATH = '/sessions/read-race.jsonl';

function fixtureState(): ReturnType<typeof createInitialArchState> {
  const state = createInitialArchState();
  state.sessions.sessions.push({
    path: SESSION_PATH,
    name: 'read-race',
    cwd: '/sessions',
    modifiedAt: new Date(Date.parse('2026-01-15T12:00:00.000Z')).toISOString(),
    messageCount: 2,
    sessionId: ROOT_ID,
  });
  state.sessions.activeSessionPath = SESSION_PATH;
  state.sessions.openTabPaths = [SESSION_PATH];
  return state;
}

function captureFixture(): CanonicalAnalyticsCapture {
  return new CanonicalAnalyticsCapture({
    authority: 'canonical',
    generationId: 'generation-historical',
    workspaceId: 'workspace-historical',
    buildId: 'test-build',
    processGeneration: 'test-process',
    sink: { submit: () => undefined },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
}

function statsFixture(
  state: ReturnType<typeof fixtureState>,
  readModel: CanonicalAnalyticsReadModel,
  at: number,
  root: string,
): StatsService {
  return new StatsService({
    dataOutcomesRootPath: path.join(root, 'legacy'),
    workspaceId: 'workspace-historical',
    getArchState: () => state,
    now: () => new Date(at + 2_000),
    analyticsCapture: captureFixture(),
    analyticsReadModel: readModel,
  });
}

/** A committed revision invalidates the cache and schedules a replacement
 * pass, so the post-race cache state can settle on that pass; poll bounded
 * instead of asserting mid-flight. */
async function awaitCanonicalUsage(
  stats: StatsService,
  sessionPath: string,
  expectedSourceIds: readonly string[],
): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const usage = stats.getSessionUsage(sessionPath);
    if (usage.authority === 'canonical'
      && JSON.stringify(usage.samples.map((sample) => sample.sourceId).sort())
        === JSON.stringify([...expectedSourceIds].sort())) {
      return;
    }
    if (Date.now() >= deadline) {
      assert.fail(`canonical usage did not settle: authority=${usage.authority} samples=${JSON.stringify(usage.samples.map((sample) => sample.sourceId))}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Regression: session-cost hydration is one root-session snapshot. A
 * concurrent commit around that read must not make the root projection fail
 * or switch to selected-branch ownership.
 */
test('a concurrent commit cannot fail the root-owned session cost read', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-canonical-read-race-'));
  const databasePath = canonicalAnalyticsDatabasePath(path.join(root, 'analytics'));
  const at = Date.parse('2026-01-15T12:00:00.000Z');
  const writer = new SqliteAnalyticsRecorder(databasePath);
  writer.submitBatch([
    branchObservation({ branchId: 'branch-a', parentBranchId: null, rootSessionId: ROOT_ID, observedAtMs: at }),
    branchObservation({ branchId: 'branch-b', parentBranchId: 'branch-a', rootSessionId: ROOT_ID, observedAtMs: at + 1 }),
    branchObservation({ branchId: 'branch-c', parentBranchId: 'branch-a', rootSessionId: ROOT_ID, observedAtMs: at + 2 }),
    branchObservation({ branchId: 'branch-b', parentBranchId: 'branch-a', rootSessionId: ROOT_ID, observedAtMs: at + 3, selection: true }),
    settlement({ invocationId: 'inv-race-a', rootSessionId: ROOT_ID, purpose: 'conversation', settledAtMs: at + 4, inputTokens: 10, outputTokens: 5, reportedCostUsd: 0.01, branchId: 'branch-a' }),
    settlement({ invocationId: 'inv-race-b', rootSessionId: ROOT_ID, purpose: 'conversation', settledAtMs: at + 5, inputTokens: 20, outputTokens: 5, reportedCostUsd: 0.02, branchId: 'branch-b' }),
    settlement({ invocationId: 'inv-race-c', rootSessionId: ROOT_ID, purpose: 'conversation', settledAtMs: at + 6, inputTokens: 30, outputTokens: 5, reportedCostUsd: 0.03, branchId: 'branch-c' }),
  ]);
  closeFixtureWriter(writer);

  const state = fixtureState();
  const baseReadModel = new CanonicalAnalyticsReadModel({ databasePath, workerScript, execArgv });
  let raceArmed = false;
  const raceWriterRef: { current: SqliteAnalyticsRecorder | null } = { current: null };
  const readModel = Object.create(baseReadModel) as CanonicalAnalyticsReadModel;
  readModel.readScopedProviderSettlements = async (scope, page, signal) => {
    if (raceArmed && scope.kind === 'rootSession') {
      raceArmed = false;
      raceWriterRef.current ??= new SqliteAnalyticsRecorder(databasePath);
      raceWriterRef.current.submit(settlement({
        invocationId: 'inv-race-late',
        rootSessionId: ROOT_ID,
        purpose: 'conversation',
        settledAtMs: at + 9,
        inputTokens: 40,
        outputTokens: 5,
        reportedCostUsd: 0.04,
        branchId: 'branch-b',
      }));
      return await baseReadModel.readScopedProviderSettlements(scope, page, signal);
    }
    return baseReadModel.readScopedProviderSettlements(scope, page, signal);
  };
  const stats = statsFixture(state, readModel, at, root);
  try {
    stats.onBranchObserved(SESSION_PATH, 'branch-b', 'branch-a', 'branch-b', at + 3);
    await stats.start();
    const baseline = stats.getSessionUsage(SESSION_PATH);
    assert.equal(baseline.authority, 'canonical');
    assert.equal(baseline.branchId, undefined);
    assert.deepEqual(baseline.samples.map((sample) => sample.sourceId).sort(), [
      'inv-race-a', 'inv-race-b', 'inv-race-c',
    ].sort());

    raceArmed = true;
    await (stats as unknown as { refreshCanonicalSessionUsage(): Promise<void> }).refreshCanonicalSessionUsage();
    // The raced commit also bumps the durable revision, so the replacement
    // pass may still be repopulating; only the settled state is asserted.
    await awaitCanonicalUsage(stats, SESSION_PATH, [
      'inv-race-a', 'inv-race-b', 'inv-race-c', 'inv-race-late',
    ]);
    const usage = stats.getSessionUsage(SESSION_PATH);
    assert.equal(usage.authority, 'canonical');
    assert.equal(usage.branchId, undefined, 'root usage must not claim selected-branch ownership');
  } finally {
    raceWriterRef.current?.close();
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Root-owned session usage is independent of the currently selected branch.
 * Explicit selected-branch consumers continue to use their own scoped query
 * (covered by the read-model contract) rather than this session indicator.
 */
test('a selection change does not change root-owned session usage', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-canonical-selection-race-'));
  const databasePath = canonicalAnalyticsDatabasePath(path.join(root, 'analytics'));
  const at = Date.parse('2026-01-15T12:00:00.000Z');
  const writer = new SqliteAnalyticsRecorder(databasePath);
  writer.submitBatch([
    branchObservation({ branchId: 'branch-a', parentBranchId: null, rootSessionId: ROOT_ID, observedAtMs: at }),
    branchObservation({ branchId: 'branch-b', parentBranchId: 'branch-a', rootSessionId: ROOT_ID, observedAtMs: at + 1 }),
    branchObservation({ branchId: 'branch-c', parentBranchId: 'branch-a', rootSessionId: ROOT_ID, observedAtMs: at + 2 }),
    branchObservation({ branchId: 'branch-b', parentBranchId: 'branch-a', rootSessionId: ROOT_ID, observedAtMs: at + 3, selection: true }),
    settlement({ invocationId: 'inv-selection-a', rootSessionId: ROOT_ID, purpose: 'conversation', settledAtMs: at + 4, inputTokens: 10, outputTokens: 5, reportedCostUsd: 0.01, branchId: 'branch-a' }),
    settlement({ invocationId: 'inv-selection-b', rootSessionId: ROOT_ID, purpose: 'conversation', settledAtMs: at + 5, inputTokens: 20, outputTokens: 5, reportedCostUsd: 0.02, branchId: 'branch-b' }),
    settlement({ invocationId: 'inv-selection-c', rootSessionId: ROOT_ID, purpose: 'conversation', settledAtMs: at + 6, inputTokens: 30, outputTokens: 5, reportedCostUsd: 0.03, branchId: 'branch-c' }),
  ]);
  closeFixtureWriter(writer);

  const state = fixtureState();
  const baseReadModel = new CanonicalAnalyticsReadModel({ databasePath, workerScript, execArgv });
  const raceWriterRef: { current: SqliteAnalyticsRecorder | null } = { current: null };
  const stats = statsFixture(state, baseReadModel, at, root);
  try {
    await stats.start();
    await awaitCanonicalUsage(stats, SESSION_PATH, [
      'inv-selection-a', 'inv-selection-b', 'inv-selection-c',
    ]);
    const usage = stats.getSessionUsage(SESSION_PATH);
    assert.equal(usage.authority, 'canonical');
    assert.equal(usage.branchId, undefined);
    assert.deepEqual(usage.samples.map((sample) => sample.sourceId).sort(), [
      'inv-selection-a', 'inv-selection-b', 'inv-selection-c',
    ].sort());
    // A caller that explicitly asks for the selected branch still receives
    // the branch-aware ancestry projection; only the session indicator is
    // root-owned. Change the durable selection for this explicit query.
    raceWriterRef.current ??= new SqliteAnalyticsRecorder(databasePath);
    raceWriterRef.current.submit(branchObservation({
      branchId: 'branch-c',
      parentBranchId: 'branch-a',
      rootSessionId: ROOT_ID,
      observedAtMs: at + 7,
      selection: true,
    }));
    const explicitBranch = await baseReadModel.readScopedProviderSettlements({
      kind: 'selectedBranch',
      generationId: 'generation-historical',
      rootSessionId: ROOT_ID,
    });
    assert.equal(explicitBranch.scope.kind, 'selectedBranch');
    assert.equal(explicitBranch.selectionCoverage, 'known');
    assert.deepEqual(explicitBranch.settlements.map((settlement) => settlement.invocationId).sort(), [
      'inv-selection-a', 'inv-selection-c',
    ].sort());
  } finally {
    raceWriterRef.current?.close();
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Regression: a root read that races a commit must converge on the complete
 * root snapshot rather than falling back to an automatically selected branch.
 */
test('a raced root read converges without an artificial branch reset', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-canonical-fallback-race-'));
  const databasePath = canonicalAnalyticsDatabasePath(path.join(root, 'analytics'));
  const at = Date.parse('2026-01-15T12:00:00.000Z');
  const writer = new SqliteAnalyticsRecorder(databasePath);
  writer.submitBatch([
    branchObservation({ branchId: 'branch-a', parentBranchId: null, rootSessionId: ROOT_ID, observedAtMs: at }),
    branchObservation({ branchId: 'branch-b', parentBranchId: 'branch-a', rootSessionId: ROOT_ID, observedAtMs: at + 1 }),
    branchObservation({ branchId: 'branch-c', parentBranchId: 'branch-a', rootSessionId: ROOT_ID, observedAtMs: at + 2 }),
    branchObservation({ branchId: 'branch-b', parentBranchId: 'branch-a', rootSessionId: ROOT_ID, observedAtMs: at + 3, selection: true }),
    settlement({ invocationId: 'inv-fallback-a', rootSessionId: ROOT_ID, purpose: 'conversation', settledAtMs: at + 4, inputTokens: 10, outputTokens: 5, reportedCostUsd: 0.01, branchId: 'branch-a' }),
    settlement({ invocationId: 'inv-fallback-b', rootSessionId: ROOT_ID, purpose: 'conversation', settledAtMs: at + 5, inputTokens: 20, outputTokens: 5, reportedCostUsd: 0.02, branchId: 'branch-b' }),
    settlement({ invocationId: 'inv-fallback-c', rootSessionId: ROOT_ID, purpose: 'conversation', settledAtMs: at + 6, inputTokens: 30, outputTokens: 5, reportedCostUsd: 0.03, branchId: 'branch-c' }),
  ]);
  closeFixtureWriter(writer);

  const state = fixtureState();
  const baseReadModel = new CanonicalAnalyticsReadModel({ databasePath, workerScript, execArgv });
  let raceArmed = true;
  const raceWriterRef: { current: SqliteAnalyticsRecorder | null } = { current: null };
  const readModel = Object.create(baseReadModel) as CanonicalAnalyticsReadModel;
  readModel.readScopedProviderSettlements = async (scope, page, signal) => {
    if (raceArmed && scope.kind === 'rootSession' && scope.rootSessionId === ROOT_ID) {
      raceArmed = false;
      const result = await baseReadModel.readScopedProviderSettlements(scope, page, signal);
      // Commit after the first root snapshot answered, before the host's
      // revision-fenced replacement read runs.
      raceWriterRef.current ??= new SqliteAnalyticsRecorder(databasePath);
      raceWriterRef.current.submit(settlement({
        invocationId: 'inv-fallback-late',
        rootSessionId: ROOT_ID,
        purpose: 'conversation',
        settledAtMs: at + 9,
        inputTokens: 40,
        outputTokens: 5,
        reportedCostUsd: 0.04,
        branchId: 'branch-b',
      }));
      return result;
    }
    return baseReadModel.readScopedProviderSettlements(scope, page, signal);
  };
  const stats = statsFixture(state, readModel, at, root);
  try {
    await stats.start();
    await awaitCanonicalUsage(stats, SESSION_PATH, [
      'inv-fallback-a', 'inv-fallback-b', 'inv-fallback-c', 'inv-fallback-late',
    ]);
    const usage = stats.getSessionUsage(SESSION_PATH);
    assert.equal(usage.authority, 'canonical');
    assert.equal(usage.branchId, undefined, 'root usage must not claim selected-branch ownership');
  } finally {
    raceWriterRef.current?.close();
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

/** Regression: startup may finish before the opened session enters the
 * displayed-session set. The opened payload must bind its stable root and
 * trigger a completed canonical read even when no branch/pending cache exists. */
test('a cold session opened after an empty startup pass hydrates by payload root identity', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-canonical-cold-open-'));
  const databasePath = canonicalAnalyticsDatabasePath(path.join(root, 'analytics'));
  const at = Date.parse('2026-01-15T12:00:00.000Z');
  const writer = new SqliteAnalyticsRecorder(databasePath);
  writer.submit(settlement({
    invocationId: 'inv-cold-open',
    rootSessionId: ROOT_ID,
    purpose: 'conversation',
    settledAtMs: at,
    inputTokens: 10,
    outputTokens: 5,
    reportedCostUsd: 0.01,
  }));
  closeFixtureWriter(writer);

  const state = createInitialArchState();
  const readModel = new CanonicalAnalyticsReadModel({ databasePath, workerScript, execArgv });
  const stats = statsFixture(state, readModel, at, root);
  try {
    await stats.start();
    // The startup pass saw no active/open session. Model the placeholder that
    // is replaced by session.opened; the explicit payload ID is the only valid
    // root identity available to this test state.
    state.sessions.sessions.push({
      path: SESSION_PATH,
      name: 'read-race',
      cwd: '/sessions',
      modifiedAt: new Date(at).toISOString(),
      messageCount: 1,
    });
    state.sessions.activeSessionPath = SESSION_PATH;
    state.sessions.openTabPaths = [SESSION_PATH];
    stats.onSessionOpened(SESSION_PATH, ROOT_ID);

    await awaitCanonicalUsage(stats, SESSION_PATH, ['inv-cold-open']);
    assert.equal(stats.getSessionUsage(SESSION_PATH).authority, 'canonical');
  } finally {
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});