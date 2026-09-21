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
  type AnalyticsDetailCapture,
  AnalyticsSourceConflictError,
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
 * Production captures flow through the recorder supervisor's bounded queue and
 * commit later than the settle boundary renders (and can be delayed much
 * longer while the queue is saturated). This sink models exactly that: every
 * capture is admitted immediately and only `commit()` makes it durable, as
 * one recorder batch/transaction, which advances the projection revision once.
 */
class DelayedCommitSink {
  private queue: AnalyticsObservation<object>[] = [];
  readonly accepted: AnalyticsObservation<object>[] = [];
  /** Models recorder queue saturation: admitted captures are dropped and the
   * revision never advances until saturation clears. */
  rejecting = false;

  constructor(private readonly writer: SqliteAnalyticsRecorder) {}

  submit(observation: AnalyticsObservation<object>): Promise<void> {
    if (!this.rejecting) {
      this.queue.push(observation);
      this.accepted.push(observation);
    }
    return Promise.resolve();
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  /** Durable settlement: flush the bounded queue to the recorder now. A
 * conflicting replay (production replays the whole branch on every
 * session.opened) is rejected per-record like the recorder's batch
 * processor does; unrelated immutable facts still commit. */
  commit(): void {
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    try {
      this.writer.submitBatch(batch);
    } catch (error) {
      if (!(error instanceof AnalyticsSourceConflictError)) throw error;
      for (const observation of batch) {
        try {
          this.writer.submitBatch([observation]);
        } catch (recordError) {
          if (!(recordError instanceof AnalyticsSourceConflictError)) throw recordError;
        }
      }
    }
  }
}

function closeFixtureWriter(writer: SqliteAnalyticsRecorder): void {
  const checkpoint = writer.truncateWalAndRead();
  assert.equal(Number(checkpoint.busy), 0, 'fixture writer must finish its WAL checkpoint before close');
  writer.close();
}

const ROOT_ID = 'settle-idle-cost-root';
const SESSION_PATH = '/sessions/settle-idle-cost.jsonl';

interface LifecycleFixture {
  stats: StatsService;
  sink: DelayedCommitSink;
  setNow: (ms: number) => void;
  writer: SqliteAnalyticsRecorder;
  readModel: CanonicalAnalyticsReadModel;
  close: () => Promise<void>;
}

async function lifecycleFixture(): Promise<LifecycleFixture> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-settle-idle-cost-'));
  const databasePath = canonicalAnalyticsDatabasePath(path.join(root, 'analytics'));
  let nowMs = Date.parse('2026-01-15T12:00:00.000Z');
  const writer = new SqliteAnalyticsRecorder(databasePath);
  const sink = new DelayedCommitSink(writer);
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical',
    generationId: 'generation-settle-idle',
    workspaceId: 'workspace-settle-idle',
    buildId: 'test-build',
    processGeneration: 'test-process',
    sink,
    detailSink: { submitDetail: (_capture: AnalyticsDetailCapture) => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
  const state = createInitialArchState();
  state.sessions.sessions.push({
    path: SESSION_PATH,
    name: 'settle-idle-cost',
    cwd: '/sessions',
    modifiedAt: new Date(nowMs).toISOString(),
    messageCount: 2,
    sessionId: ROOT_ID,
  });
  state.sessions.activeSessionPath = SESSION_PATH;
  state.sessions.openTabPaths = [SESSION_PATH];
  const readModel = new CanonicalAnalyticsReadModel({ databasePath, workerScript, execArgv });
  const stats = new StatsService({
    dataOutcomesRootPath: path.join(root, 'legacy'),
    workspaceId: 'workspace-settle-idle',
    getArchState: () => state,
    now: () => new Date(nowMs),
    analyticsCapture: capture,
    analyticsReadModel: readModel,
  });
  await stats.start();
  return {
    stats,
    sink,
    setNow: (ms: number) => { nowMs = ms; },
    writer,
    readModel,
    close: async () => {
      await stats.shutdown();
      closeFixtureWriter(writer);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function assistantUsage() {
  return {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 150,
    reportedCostUsd: 0.02,
  };
}

/** One real settle lifecycle turn: a send opens the run, the terminal
 * assistant message settles with provider usage, the durable transcript
 * append is observed (branch edge + selection), the run leaves busy, and the
 * production idle refresh replays the whole branch's usage snapshot. */
function runTurn(
  stats: StatsService,
  turns: readonly { index: number; entryId: string; parentEntryId: string | null; occurredAtMs: number }[],
): void {
  const turn = turns[turns.length - 1]!;
  const operationId = `op-${turn.index}`;
  stats.prepareForSend(SESSION_PATH, [], `prompt ${turn.index}`, operationId);
  stats.onBusyChanged(SESSION_PATH, true);
  stats.onAssistantTurnEnded(
    SESSION_PATH,
    `turn-${turn.index}`,
    1_000,
    assistantUsage(),
    'completed',
    { turnLatencyMs: 120, providerLatencyMs: 100, overheadMs: 20, providerQueueMs: 0 },
    {
      operationId,
      requestId: `req-${turn.index}`,
      attemptId: `attempt-${turn.index}`,
      durableEntryId: turn.entryId,
      occurredAt: new Date(turn.occurredAtMs).toISOString(),
      provider: 'fixture-provider',
      modelId: 'fixture/model',
    },
  );
  stats.onBranchObserved(SESSION_PATH, turn.entryId, turn.parentEntryId, turn.entryId, turn.occurredAtMs);
  stats.onBusyChanged(SESSION_PATH, false);
  // The production idle refresh: after the run leaves busy the host issues a
  // session.opened refresh whose snapshot replays the whole branch's usage.
  idleSessionOpened(stats, turns, turn.occurredAtMs + 500);
}

/** The backend-owned idle `session.opened` snapshot: ledger authority for the
 * whole selected branch, replayed as migration evidence on every open. */
function idleSessionOpened(
  stats: StatsService,
  turns: readonly { index: number; entryId: string; occurredAtMs: number }[],
  observedAtMs: number,
): void {
  const snapshot = {
    samples: turns.map((turn) => ({
      sourceId: `assistant:turn-${turn.index}`,
      kind: 'assistant' as const,
      modelId: 'fixture/model',
      provider: 'fixture-provider',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 150,
      providerTotalTokens: 150,
      reportedCostUsd: 0.02,
      provenance: 'exact' as const,
      outcome: 'succeeded' as const,
      startedAt: new Date(turn.occurredAtMs - 1_000).toISOString(),
      endedAt: new Date(turn.occurredAtMs).toISOString(),
    })),
    authority: 'ledger' as const,
    branchId: turns[turns.length - 1]!.entryId,
    branchEntryIds: turns.map((turn) => turn.entryId),
  };
  stats.onSessionUsageSnapshot(
    SESSION_PATH,
    ROOT_ID,
    snapshot,
    `snapshot:${ROOT_ID}:fix:${observedAtMs}`,
    observedAtMs,
  );
}

/** Bounded wait for the revision refresher (default 1s interval) to observe a
 * durable commit and for the scheduled replacement pass to land. */
async function awaitIdleUsage(
  stats: StatsService,
  expectedSampleCount: number,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  let last = '';
  for (;;) {
    const usage = stats.getSessionUsage(SESSION_PATH);
    last = `authority=${usage.authority} samples=${JSON.stringify(usage.samples.map((sample) => sample.sourceId))}`;
    if (usage.authority === 'canonical'
      && usage.samples.length === expectedSampleCount) {
      return;
    }
    if (Date.now() >= deadline) {
      assert.fail(`idle usage did not settle: ${last}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

/** Wait until any session-usage refresh pass scheduled by an invalidation has
 * settled, so the assertion describes the settled cache, not an in-flight
 * fail-closed fence. */
async function awaitSettlePass(stats: StatsService): Promise<void> {
  const service = stats as unknown as { canonicalSessionUsageRefresh: Promise<void> | null };
  const deadline = Date.now() + 15_000;
  while (service.canonicalSessionUsageRefresh !== null) {
    if (Date.now() >= deadline) assert.fail('session usage refresh did not settle');
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Regression: the live→idle session cost must not lose its last known value
 * while the settle-boundary captures (terminal settlement, branch edge,
 * selection) are still pending durable commitment. Production commits those
 * captures through a delayed recorder queue; the replacement read issued by
 * the settle-boundary invalidation answers from the pre-commit store, where no
 * durable selection exists yet, and must not overwrite the displayed cost with
 * an explicit unknown (the em dash) that then persists until a revision
 * change finally triggers a successful read.
 */
test('the first settled turn keeps the displayed cost known until its delayed commit converges', async () => {
  const fixture = await lifecycleFixture();
  const { stats, sink } = fixture;
  try {
    // Live turn: every capture is submitted but nothing is committed yet, so
    // the settle-boundary invalidation can only read the pre-commit store.
    fixture.setNow(Date.parse('2026-01-15T12:00:05.000Z'));
    const turn1 = [{
      index: 1,
      entryId: 'entry-1',
      parentEntryId: null,
      occurredAtMs: Date.parse('2026-01-15T12:00:06.000Z'),
    }];
    runTurn(stats, turn1);
    const live = stats.getSessionUsage(SESSION_PATH);
    assert.equal(live.authority, 'canonical',
      `the idle render must keep a known read while the commit is pending, got ${live.authority}`);

    // The settle-boundary replacement pass reads the pre-commit store, which
    // has no committed selection yet; the prior complete read must survive
    // instead of being replaced by a sticky unknown (the em dash).
    await awaitSettlePass(stats);
    const cached = stats.getSessionUsage(SESSION_PATH);
    assert.equal(cached.authority, 'canonical',
      `the settled replacement read must keep a known read, got ${cached.authority}`);

    // The delayed durable settlement lands; the revision refresher schedules
    // the replacement pass and the idle cost converges to the full ledger.
    sink.commit();
    await awaitIdleUsage(stats, 1);
    const settled = stats.getSessionUsage(SESSION_PATH);
    assert.equal(settled.authority, 'canonical');
    assert.match(settled.branchId ?? '', /^branch:/);
    assert.equal(settled.samples.length, 1);
  } finally {
    await fixture.close();
  }
});

/**
 * Regression: with the previous turn already durable, a new settle whose
 * commit is delayed (or never lands, as under a saturated recorder queue)
 * must keep showing the last known durable read, not an em dash.
 */
test('a later settle with a still-pending commit keeps the prior durable cost', async () => {
  const fixture = await lifecycleFixture();
  const { stats, sink } = fixture;
  try {
    // Turn 1 commits durably before turn 2 runs, so the durable selection
    // exists and the idle read after turn 2 must fall back to turn 1's rows.
    fixture.setNow(Date.parse('2026-01-15T12:00:05.000Z'));
    const turn1 = [{ index: 1, entryId: 'entry-1', parentEntryId: null, occurredAtMs: Date.parse('2026-01-15T12:00:06.000Z') }];
    runTurn(stats, turn1);
    sink.commit();
    await awaitIdleUsage(stats, 1);

    // Turn 2: captures submitted, commit still pending, session goes idle.
    fixture.setNow(Date.parse('2026-01-15T12:01:00.000Z'));
    runTurn(stats, [
      ...turn1,
      { index: 2, entryId: 'entry-2', parentEntryId: 'entry-1', occurredAtMs: Date.parse('2026-01-15T12:01:01.000Z') },
    ]);
    const idle = stats.getSessionUsage(SESSION_PATH);
    assert.equal(idle.authority, 'canonical',
      `the idle render must keep the last durable read while turn 2 is pending, got ${idle.authority}`);
    await awaitSettlePass(stats);
    const cached = stats.getSessionUsage(SESSION_PATH);
    assert.equal(cached.authority, 'canonical',
      `the settled replacement read must keep the prior durable cost, got ${cached.authority}`);
    assert.equal(cached.samples.length, 1,
      'the prior durable read must stay visible while turn 2 is pending');

    // Convergence once the delayed commit lands.
    sink.commit();
    await awaitIdleUsage(stats, 2);
  } finally {
    await fixture.close();
  }
});

/**
 * Regression: when the settle-boundary captures are permanently rejected (a
 * saturated recorder queue), the durable store never advances. The idle
 * session cost must keep the last known durable read instead of flipping to
 * an em dash that can never converge while the queue stays saturated.
 */
test('a rejected settle keeps the last known durable cost while the commit never lands', async () => {
  const fixture = await lifecycleFixture();
  const { stats, sink } = fixture;
  try {
    fixture.setNow(Date.parse('2026-01-15T12:00:05.000Z'));
    const turn1 = [{ index: 1, entryId: 'entry-1', parentEntryId: null, occurredAtMs: Date.parse('2026-01-15T12:00:06.000Z') }];
    runTurn(stats, turn1);
    sink.commit();
    await awaitIdleUsage(stats, 1);

    // Now the recorder saturates (queue full): turn 2's captures never reach
    // the durable store and the revision never advances.
    fixture.sink.rejecting = true;
    fixture.setNow(Date.parse('2026-01-15T12:02:00.000Z'));
    runTurn(stats, [
      ...turn1,
      { index: 2, entryId: 'entry-2', parentEntryId: 'entry-1', occurredAtMs: Date.parse('2026-01-15T12:02:01.000Z') },
    ]);
    const idle = stats.getSessionUsage(SESSION_PATH);
    assert.equal(idle.authority, 'canonical',
      `the idle render must keep the last durable read when the commit never lands, got ${idle.authority}`);
    await awaitSettlePass(stats);
    const cached = stats.getSessionUsage(SESSION_PATH);
    assert.equal(cached.authority, 'canonical',
      `the settled replacement read must keep the prior durable cost, got ${cached.authority}`);
    assert.equal(cached.samples.length, 1,
      'the last known durable read must stay visible while the commit never lands');
  } finally {
    await fixture.close();
  }
});

/** A foreign-generation selection for the same root makes the durable
 * selection ambiguous (two rows for one root). Mirrors the recorder's
 * branch-selection observation shape. */
function submitForeignGenerationSelection(
  writer: SqliteAnalyticsRecorder,
  observedAtMs: number,
): void {
  const branchId = 'branch:foreign-generation-ambiguous';
  const base: Omit<AnalyticsObservation<object>, 'idempotencyKey'> = {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: 'generation-settle-idle-foreign',
    producerKind: 'test',
    sourceKey: `branch-selection:foreign:${observedAtMs}`,
    entityKind: 'branch',
    entityKey: branchId,
    observationKind: 'phase',
    observedAtMs,
    scope: {
      workspaceCoverage: 'known',
      workspaceId: 'workspace-settle-idle',
      rootSessionId: ROOT_ID,
      sessionId: ROOT_ID,
      branchId,
    },
    captureSubject: { kind: 'session', rootSessionId: ROOT_ID },
    producer: { buildId: 'test-build', processGeneration: 'test-process' },
    fields: { branchId, sourceSelectionId: 'selection:foreign', sourceEntryId: 'entry-foreign' },
  };
  writer.submitBatch([{ ...base, idempotencyKey: deriveAnalyticsIdempotencyKey(base) }]);
}

/**
 * Fail-closed boundary: when the durable store itself reports an ambiguous
 * selection for the root (two selection rows), the read cannot prove a
 * complete selection, so the session cost must stay an explicit unknown even
 * when a prior complete read exists. Only the missing-selection
 * delayed-commit window is pending (retained); genuine ambiguity must not
 * borrow the prior read.
 */
test('an ambiguous durable selection stays fail-closed unknown', async () => {
  const fixture = await lifecycleFixture();
  const { stats, sink } = fixture;
  try {
    fixture.setNow(Date.parse('2026-01-15T12:00:05.000Z'));
    const turn1 = [{ index: 1, entryId: 'entry-1', parentEntryId: null, occurredAtMs: Date.parse('2026-01-15T12:00:06.000Z') }];
    runTurn(stats, turn1);
    sink.commit();
    await awaitIdleUsage(stats, 1);

    // A second selection row (foreign generation) for the same root makes the
    // selection lookup ambiguous; the commit also advances the revision, so
    // the strict revision-dirty refresh reads the ambiguous store.
    fixture.setNow(Date.parse('2026-01-15T12:03:00.000Z'));
    submitForeignGenerationSelection(fixture.writer, Date.parse('2026-01-15T12:03:01.000Z'));
    const deadline = Date.now() + 15_000;
    for (;;) {
      const usage = stats.getSessionUsage(SESSION_PATH);
      if (usage.authority === 'unknown') break;
      if (Date.now() >= deadline) {
        assert.fail(`ambiguous selection must stay fail-closed, got authority=${usage.authority}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    await fixture.close();
  }
});