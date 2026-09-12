import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { AnalyticsObservation } from '../../../../shared/analytics/contracts.js';
import { CanonicalAnalyticsCapture } from '../../../src/analytics/canonical-capture.js';
import type { CanonicalAnalyticsReadModel } from '../../../src/analytics/query-entry.js';
import { SqliteAnalyticsRecorder } from '../../../src/analytics/sqlite-recorder.js';
import { createInitialArchState } from '../../../src/host/core/arch-state.js';
import { StatsService } from '../../../src/host/stats-service/service.js';

function sessionState(sessionPath: string) {
  const state = createInitialArchState();
  state.sessions.privacyModeBySession[sessionPath] = true;
  state.sessions.activeSessionPath = sessionPath;
  state.sessions.openTabPaths = [sessionPath];
  state.sessions.sessions = [{ path: sessionPath, sessionId: 'private-root', name: 'private',
    cwd: path.dirname(sessionPath), modifiedAt: '2026-09-10T00:00:00.000Z', messageCount: 0 }];
  return state;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

for (const authority of ['canonical', 'legacy'] as const) {
  test(`${authority} authority preserves its open private live-event policy`, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pie-private-live-'));
    const sessionPath = path.join(root, 'private.jsonl');
    const state = sessionState(sessionPath);
    const observations: AnalyticsObservation<object>[] = [];
    let nowMs = Date.parse('2026-09-10T00:00:00.000Z');
    const capture = new CanonicalAnalyticsCapture({
      authority, generationId: 'generation', workspaceId: 'workspace', buildId: 'build', processGeneration: 'process',
      sink: { submit: (observation) => { observations.push(observation); } },
      detailSink: { submitDetail: () => undefined },
      lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
    });
    const stats = new StatsService({ dataOutcomesRootPath: path.join(root, 'legacy'),
      workspaceId: 'workspace', getArchState: () => state, now: () => new Date(nowMs), analyticsCapture: capture });
    try {
      stats.prepareForSend(sessionPath, []);
      stats.onModelConfigChanged(sessionPath, 'fixture-model', undefined, 'fixture-provider');
      stats.onContextUsageChanged(sessionPath, 42, 1_000);
      stats.onBusyChanged(sessionPath, true);
      nowMs += 20;
      stats.onAutoRetry(sessionPath);
      stats.onAutoRetryMeasured(sessionPath, 'retry', 5, 5);
      stats.onCompaction(sessionPath);
      stats.onInterrupted(sessionPath);
      stats.onUnsupportedInputAttempt(sessionPath);
      stats.onBusyChanged(sessionPath, false);
      const open = stats.getOpenRuns();
      if (authority === 'canonical') {
        assert.equal(open.length, 1, 'an open private run remains part of the live surface');
        assert.equal(open[0]?.modelId, 'fixture-model');
        assert.equal(open[0]?.contextTokens, 42);
        assert.equal(open[0]?.autoRetryCount, 1);
        assert.equal(open[0]?.compactionCount, 1);
        assert.equal(open[0]?.interruptedCount, 1);
        assert.equal(open[0]?.unsupportedInputCount, 1);
        const spans = observations.filter((observation) => observation.entityKind === 'activitySpan');
        assert.ok(spans.some(({ fields }) => (fields as { kind: string }).kind === 'retry_wait'));
        assert.equal(spans.filter(({ fields }) => (fields as { kind: string }).kind === 'busy').length, 2);
        await stats.closePrivateSessionAnalytics(sessionPath, undefined, 'private-root');
        assert.equal(stats.getOpenRuns().length, 0);
        assert.equal(stats.getWorkingTimeBySession()[sessionPath], undefined);
      } else {
        assert.equal(open.length, 0, 'legacy privacy continues suppressing analytics');
        assert.equal(observations.length, 0);
      }
    } finally {
      await stats.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('private close prevents cache rehydration while deletion is in flight', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-private-close-display-'));
  const sessionPath = path.join(root, 'private.jsonl');
  const state = sessionState(sessionPath);
  const recorder = new SqliteAnalyticsRecorder(path.join(root, 'analytics.sqlite'));
  let releaseDelete!: () => void;
  const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
  let reads = 0;
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical', generationId: 'generation', workspaceId: 'workspace', buildId: 'build', processGeneration: 'process',
    sink: { submit: (observation) => { recorder.submit(observation); } },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async (...args) => {
      await deleteGate;
      recorder.deleteSession(...args);
    } },
  });
  capture.captureProviderSettlement({
    schemaVersion: 1, invocationId: 'invocation', sourceId: 'source', sessionId: 'private-root',
    sessionPath, branchId: null, parentOperationId: null, parentRunId: null, parentToolId: null,
    kind: 'conversation', provider: 'provider', model: 'model', provenance: 'exact', instrumentationGap: false,
    startedAt: '2026-09-10T00:00:00.000Z', endedAt: '2026-09-10T00:00:01.000Z', outcome: 'succeeded',
    inputTokens: 1, outputTokens: 2, providerReportedCostUsd: 0.25,
  });
  // Keep the read seam deterministic; the real recorder supplies its typed
  // snapshot, while the test deliberately holds only the close acknowledgement.
  const readModel = {
    getMaxConcurrentQueries: () => 1,
    readRevision: async () => String(recorder.getProjectionRevision()),
    readScopedProviderSettlements: async (...args: Parameters<SqliteAnalyticsRecorder['readScopedProviderSettlements']>) => {
      reads += 1;
      return recorder.readScopedProviderSettlements(...args);
    },
  } as unknown as CanonicalAnalyticsReadModel;
  const stats = new StatsService({ dataOutcomesRootPath: path.join(root, 'legacy'), workspaceId: 'workspace',
    getArchState: () => state, analyticsCapture: capture, analyticsReadModel: readModel });
  let closing: Promise<void> | undefined;
  try {
    await stats.start();
    assert.equal(stats.getSessionUsage(sessionPath).samples.length, 1);
    closing = stats.closePrivateSessionAnalytics(sessionPath, undefined, 'private-root');
    const readsBefore = reads;
    for (let index = 0; index < 3; index++) {
      assert.deepEqual(stats.getSessionUsage(sessionPath), { samples: [], authority: 'unknown' });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(reads, readsBefore, 'renders must not reload still-present private facts during close');
    releaseDelete();
    await closing;
    stats.getSessionUsage(sessionPath);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stats.getSessionUsage(sessionPath).samples.length, 0);
    assert.equal(recorder.readProviderSettlements().settlements.length, 0);
  } finally {
    releaseDelete();
    await closing;
    await stats.shutdown();
    recorder.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed canonical private close restores the live display state', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-private-close-failed-'));
  const sessionPath = path.join(root, 'private.jsonl');
  const state = sessionState(sessionPath);
  let deleteCalls = 0;
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical', generationId: 'generation-failed', workspaceId: 'workspace-failed',
    buildId: 'build', processGeneration: 'process',
    sink: { submit: () => undefined },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: {
      bindPendingCreate: async () => undefined,
      deleteSession: async () => {
        deleteCalls += 1;
        throw new Error('delete failed');
      },
    },
  });
  const stats = new StatsService({ dataOutcomesRootPath: path.join(root, 'legacy'), workspaceId: 'workspace-failed',
    getArchState: () => state, analyticsCapture: capture });
  try {
    stats.prepareForSend(sessionPath, []);
    stats.onBusyChanged(sessionPath, true);
    const before = stats.getWorkingTimeBySession()[sessionPath];
    assert.ok(before);
    await assert.rejects(
      stats.closePrivateSessionAnalytics(sessionPath, undefined, 'private-root'),
      /delete failed/,
    );
    assert.equal(deleteCalls, 1);
    assert.equal(stats.getOpenRuns().length, 1, 'failed deletion keeps the run eligible for display');
    assert.deepEqual(stats.getWorkingTimeBySession()[sessionPath], before);
    stats.onContextUsageChanged(sessionPath, 42, 100);
    assert.equal(stats.getOpenRuns()[0]?.contextTokens, 42, 'retryable state remains live after failure');
  } finally {
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical private close coalesces identical identities and rejects conflicts', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-private-close-coalesce-'));
  const sessionPath = path.join(root, 'private.jsonl');
  const state = sessionState(sessionPath);
  const deleteGate = deferred<void>();
  let deleteCalls = 0;
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical', generationId: 'generation-coalesce', workspaceId: 'workspace-coalesce',
    buildId: 'build', processGeneration: 'process',
    sink: { submit: () => undefined },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: {
      bindPendingCreate: async () => undefined,
      deleteSession: async () => {
        deleteCalls += 1;
        await deleteGate.promise;
      },
    },
  });
  const stats = new StatsService({ dataOutcomesRootPath: path.join(root, 'legacy'), workspaceId: 'workspace-coalesce',
    getArchState: () => state, analyticsCapture: capture });
  const internals = stats as unknown as {
    canonicalPrivateClosesByPath: Map<string, { phase: string }>;
  };
  try {
    stats.prepareForSend(sessionPath, []);
    const first = stats.closePrivateSessionAnalytics(sessionPath, undefined, 'private-root');
    await Promise.resolve();
    const second = stats.closePrivateSessionAnalytics(sessionPath, undefined, 'private-root');
    assert.equal(deleteCalls, 1, 'same identity shares one durable delete');
    await assert.rejects(
      stats.closePrivateSessionAnalytics(sessionPath, 'other-operation', 'other-root'),
      /identity conflicts/,
    );
    assert.equal(internals.canonicalPrivateClosesByPath.get(sessionPath)?.phase, 'closing');
    deleteGate.resolve();
    await Promise.all([first, second]);
    assert.equal(internals.canonicalPrivateClosesByPath.get(sessionPath)?.phase, 'deleted');
    stats.onSessionClosed(sessionPath);
    assert.equal(internals.canonicalPrivateClosesByPath.has(sessionPath), false, 'runtime retirement releases the fence');
  } finally {
    deleteGate.resolve();
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('late private events cannot repopulate local state during the close fence', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-private-close-late-events-'));
  const sessionPath = path.join(root, 'private.jsonl');
  const state = sessionState(sessionPath);
  const deleteGate = deferred<void>();
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical', generationId: 'generation-late-events', workspaceId: 'workspace-late-events',
    buildId: 'build', processGeneration: 'process',
    sink: { submit: () => undefined },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: {
      bindPendingCreate: async () => undefined,
      deleteSession: async () => deleteGate.promise,
    },
  });
  const stats = new StatsService({ dataOutcomesRootPath: path.join(root, 'legacy'), workspaceId: 'workspace-late-events',
    getArchState: () => state, analyticsCapture: capture });
  try {
    stats.prepareForSend(sessionPath, []);
    stats.onBusyChanged(sessionPath, true);
    const closing = stats.closePrivateSessionAnalytics(sessionPath, undefined, 'private-root');
    stats.onAssistantTurnStarted(sessionPath, 'late-turn');
    stats.onAssistantTurnEnded(sessionPath, 'late-turn', 25);
    stats.onToolStarted(sessionPath, { id: 'late-tool', name: 'fixture', input: {}, status: 'running' });
    stats.onToolFinished(sessionPath, {
      id: 'late-tool', name: 'fixture', input: {}, status: 'completed', durationMs: 5,
    });
    stats.onBusyChanged(sessionPath, false);
    stats.onContextUsageChanged(sessionPath, 99, 100);
    stats.onSessionUsageSnapshot(sessionPath, 'private-root', {
      samples: [],
      authority: 'canonical',
    });
    assert.equal(stats.getOpenRuns().length, 0, 'closing paths stay hidden');
    assert.equal(stats.getWorkingTimeBySession()[sessionPath], undefined, 'closing paths stay out of live timing');
    deleteGate.resolve();
    await closing;
    assert.equal(stats.getOpenRuns().length, 0);
    stats.onSessionClosed(sessionPath);
  } finally {
    deleteGate.resolve();
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('shutdown drains stale private reads and releases canonical maps', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-private-close-shutdown-'));
  const sessionPath = path.join(root, 'private.jsonl');
  const state = sessionState(sessionPath);
  const readGate = deferred<{
    revision: string;
    settlements: [];
    truncated: false;
    scope: { kind: 'rootSession'; rootSessionId: string };
  }>();
  const readModel = {
    getMaxConcurrentQueries: () => 1,
    readScopedProviderSettlements: async () => readGate.promise,
  } as unknown as CanonicalAnalyticsReadModel;
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical', generationId: 'generation-shutdown', workspaceId: 'workspace-shutdown',
    buildId: 'build', processGeneration: 'process',
    sink: { submit: () => undefined },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
  const stats = new StatsService({ dataOutcomesRootPath: path.join(root, 'legacy'), workspaceId: 'workspace-shutdown',
    getArchState: () => state, analyticsCapture: capture, analyticsReadModel: readModel });
  const internals = stats as unknown as {
    canonicalSessionUsageByPath: Map<string, unknown>;
    canonicalSessionPathRefreshes: Map<string, unknown>;
    canonicalSessionPathEpochs: Map<string, unknown>;
    canonicalBranchEntriesBySession: Map<string, unknown>;
    pendingCreateOperationBySessionPath: Map<string, unknown>;
  };
  try {
    stats.getSessionUsage(sessionPath);
    await Promise.resolve();
    const shuttingDown = stats.shutdown();
    readGate.resolve({ revision: '1', settlements: [], truncated: false,
      scope: { kind: 'rootSession', rootSessionId: 'private-root' } });
    await shuttingDown;
    assert.equal(internals.canonicalSessionUsageByPath.size, 0);
    assert.equal(internals.canonicalSessionPathRefreshes.size, 0);
    assert.equal(internals.canonicalSessionPathEpochs.size, 0);
    assert.equal(internals.canonicalBranchEntriesBySession.size, 0);
    assert.equal(internals.pendingCreateOperationBySessionPath.size, 0);
  } finally {
    readGate.resolve({ revision: '1', settlements: [], truncated: false,
      scope: { kind: 'rootSession', rootSessionId: 'private-root' } });
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});
