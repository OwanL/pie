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
      && JSON.stringify(usage.samples.map((sample) => sample.sourceId))
        === JSON.stringify(expectedSourceIds)) {
      return;
    }
    if (Date.now() >= deadline) {
      assert.fail(`canonical usage did not settle: authority=${usage.authority} samples=${JSON.stringify(usage.samples.map((sample) => sample.sourceId))}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Regression: the session-cost read is a selection lookup plus one
 * selected-branch settlement snapshot. A concurrent commit inside that window
 * must not fail the read: the settlement read already pairs its own projection
 * revision with its rows, its current selection, and its ancestry inside one
 * SQLite snapshot, so fencing its first page against a revision captured in a
 * foreign snapshot only manufactured failures.
 */
test('a commit between the selection lookup and the selected-branch read cannot fail the session cost read', async () => {
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
  let armedReadError: unknown = null;
  const raceWriterRef: { current: SqliteAnalyticsRecorder | null } = { current: null };
  const readModel = Object.create(baseReadModel) as CanonicalAnalyticsReadModel;
  readModel.readScopedProviderSettlements = async (scope, page, signal) => {
    if (raceArmed && scope.kind === 'selectedBranch') {
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
      try {
        return await baseReadModel.readScopedProviderSettlements(scope, page, signal);
      } catch (error) {
        armedReadError = error;
        throw error;
      }
    }
    return baseReadModel.readScopedProviderSettlements(scope, page, signal);
  };
  const stats = statsFixture(state, readModel, at, root);
  try {
    stats.onBranchObserved(SESSION_PATH, 'branch-b', 'branch-a', 'branch-b', at + 3);
    await stats.start();
    const baseline = stats.getSessionUsage(SESSION_PATH);
    assert.equal(baseline.authority, 'canonical');
    assert.equal(baseline.branchId, 'branch-b');
    assert.deepEqual(baseline.samples.map((sample) => sample.sourceId), ['inv-race-a', 'inv-race-b']);

    raceArmed = true;
    await (stats as unknown as { refreshCanonicalSessionUsage(): Promise<void> }).refreshCanonicalSessionUsage();
    assert.equal(armedReadError, null,
      'the raced selected-branch read must succeed on one consistent snapshot');
    // The raced commit also bumps the durable revision, so the invalidation
    // pass may still be repopulating; only the settled state is asserted.
    await awaitCanonicalUsage(stats, SESSION_PATH, ['inv-race-a', 'inv-race-b', 'inv-race-late']);
    const usage = stats.getSessionUsage(SESSION_PATH);
    assert.equal(usage.authority, 'canonical');
    assert.equal(usage.branchId, 'branch-b', 'the abandoned branch must stay excluded');
  } finally {
    raceWriterRef.current?.close();
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Regression: the selection lookup and selected-branch page are separate
 * bounded queries. If the selection changes from B to C between them, the
 * rows and the displayed branch label must both come from the C snapshot.
 */
test('a selection change between lookup and first page uses the atomic branch label', async () => {
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
  let raceArmed = true;
  const raceWriterRef: { current: SqliteAnalyticsRecorder | null } = { current: null };
  const readModel = Object.create(baseReadModel) as CanonicalAnalyticsReadModel;
  readModel.executeQuery = async (request, signal) => {
    const result = await baseReadModel.executeQuery(request, signal);
    if (raceArmed && request.sql.includes('analytics_current_branch_selections')) {
      raceArmed = false;
      raceWriterRef.current ??= new SqliteAnalyticsRecorder(databasePath);
      raceWriterRef.current.submit(branchObservation({
        branchId: 'branch-c',
        parentBranchId: 'branch-a',
        rootSessionId: ROOT_ID,
        observedAtMs: at + 7,
        selection: true,
      }));
    }
    return result;
  };
  const stats = statsFixture(state, readModel, at, root);
  try {
    await stats.start();
    await awaitCanonicalUsage(stats, SESSION_PATH, ['inv-selection-a', 'inv-selection-c']);
    const usage = stats.getSessionUsage(SESSION_PATH);
    assert.equal(usage.authority, 'canonical');
    assert.equal(usage.branchId, 'branch-c');
    assert.deepEqual(usage.samples.map((sample) => sample.sourceId), [
      'inv-selection-a', 'inv-selection-c',
    ]);
  } finally {
    raceWriterRef.current?.close();
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Regression: the post-restart fallback (root read detects branch rows, then
 * selects the durable branch) must keep the same property: a commit between
 * the root read and the selected-branch snapshot read must not fail the
 * session read, and the ancestry-filtered result must still exclude the
 * abandoned branch.
 */
test('a commit between the root fallback read and the selected-branch read cannot fail startup hydration', async () => {
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
  let captureNextSelected = false;
  let armedReadError: unknown = null;
  const raceWriterRef: { current: SqliteAnalyticsRecorder | null } = { current: null };
  const readModel = Object.create(baseReadModel) as CanonicalAnalyticsReadModel;
  readModel.readScopedProviderSettlements = async (scope, page, signal) => {
    if (raceArmed && scope.kind === 'rootSession' && scope.rootSessionId === ROOT_ID) {
      raceArmed = false;
      const result = await baseReadModel.readScopedProviderSettlements(scope, page, signal);
      // Commit after the root snapshot answered, before the host's
      // selection lookup and selected-branch read run.
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
      captureNextSelected = true;
      return result;
    }
    if (captureNextSelected && scope.kind === 'selectedBranch') {
      captureNextSelected = false;
      try {
        return await baseReadModel.readScopedProviderSettlements(scope, page, signal);
      } catch (error) {
        armedReadError = error;
        throw error;
      }
    }
    return baseReadModel.readScopedProviderSettlements(scope, page, signal);
  };
  const stats = statsFixture(state, readModel, at, root);
  try {
    await stats.start();
    assert.equal(armedReadError, null,
      'the raced selected-branch read must succeed on one consistent snapshot');
    // The raced commit also bumps the durable revision, so the invalidation
    // pass may still be repopulating; only the settled state is asserted.
    await awaitCanonicalUsage(stats, SESSION_PATH, [
      'inv-fallback-a', 'inv-fallback-b', 'inv-fallback-late',
    ]);
    const usage = stats.getSessionUsage(SESSION_PATH);
    assert.equal(usage.authority, 'canonical');
    assert.equal(usage.branchId, 'branch-b', 'the abandoned branch must stay excluded');
  } finally {
    raceWriterRef.current?.close();
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});