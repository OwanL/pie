import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import {
  ANALYTICS_SCHEMA_VERSION,
  deriveAnalyticsIdempotencyKey,
  type AnalyticsObservation,
} from '../../../../shared/analytics/contracts.js';
import type { WorkingTimeState } from '../../../src/shared/protocol';
import {
  CanonicalAnalyticsReadModel,
  canonicalAnalyticsDatabasePath,
} from '../../../src/analytics/query-entry.js';
import { SqliteAnalyticsRecorder } from '../../../src/analytics/sqlite-recorder.js';
import { CanonicalAnalyticsCapture } from '../../../src/analytics/canonical-capture.js';
import { createInitialArchState } from '../../../src/host/core/arch-state.js';
import { StatsService } from '../../../src/host/stats-service/index.js';
import { WorkingTimeService } from '../../../src/host/working-time-service';
import { useWorkingTimeIndicator } from '../../../src/webview/panel/composer/use-working-time';

const workerScript = fileURLToPath(new URL('../../../src/analytics/query-worker-entry.ts', import.meta.url));
const execArgv = [
  `--import=${new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url).href}`,
];

function closeFixtureWriter(writer: SqliteAnalyticsRecorder): void {
  const checkpoint = writer.truncateWalAndRead();
  assert.equal(Number(checkpoint.busy), 0, 'fixture writer must finish its WAL checkpoint before close');
  writer.close();
}

/** Durable busy-span fixture observation, shaped exactly like the host's
 * `captureActivity` submit: wall-clock-utc anchors with the terminal evidence
 * carried by `endedAtMs` (null keeps a span open). */
function busySpanObservation(options: {
  spanId: string;
  rootSessionId: string;
  startedAtMs: number;
  endedAtMs: number | null;
  kind?: string;
}): AnalyticsObservation<object> {
  const base: Omit<AnalyticsObservation<object>, 'idempotencyKey'> = {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: 'generation-working-time',
    producerKind: 'test',
    sourceKey: `activity:${options.spanId}:end`,
    entityKind: 'activitySpan',
    entityKey: options.spanId,
    observationKind: options.endedAtMs === null ? 'begin' : 'end',
    observedAtMs: options.endedAtMs ?? options.startedAtMs,
    scope: {
      workspaceCoverage: 'known',
      workspaceId: 'workspace-working-time',
      rootSessionId: options.rootSessionId,
    },
    captureSubject: { kind: 'session', rootSessionId: options.rootSessionId },
    producer: { buildId: 'test-build', processGeneration: 'test-process' },
    fields: {
      spanId: options.spanId,
      kind: options.kind ?? 'busy',
      startedAtMs: options.startedAtMs,
      endedAtMs: options.endedAtMs,
      durationMs: options.endedAtMs === null ? null : options.endedAtMs - options.startedAtMs,
      clockDomain: 'wall-clock-utc',
      coverage: 'observed',
    },
  };
  return { ...base, idempotencyKey: deriveAnalyticsIdempotencyKey(base) };
}

function archStateWithSession(sessionPath: string, sessionId: string | null, at: number) {
  const state = createInitialArchState();
  state.sessions.sessions.push({
    path: sessionPath,
    name: path.basename(sessionPath),
    cwd: '/sessions',
    modifiedAt: new Date(at).toISOString(),
    messageCount: 1,
    ...(sessionId === null ? { identityFallback: true as const } : { sessionId }),
  });
  state.sessions.activeSessionPath = sessionPath;
  state.sessions.openTabPaths = [sessionPath];
  return state;
}

function canonicalCapture(): CanonicalAnalyticsCapture {
  return new CanonicalAnalyticsCapture({
    authority: 'canonical',
    generationId: 'generation-working-time',
    workspaceId: 'workspace-working-time',
    buildId: 'test-build',
    processGeneration: 'test-process',
    sink: { submit: () => undefined },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
}

function IndicatorHarness(props: {
  sessionPath: string | null;
  workingTimeBySession: Record<string, WorkingTimeState>;
}): string {
  const indicator = useWorkingTimeIndicator(props);
  return `${indicator.label ?? ''}`;
}

test('canonical cold hydration restores the elapsed busy wall-time union and the indicator renders it', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-canonical-working-time-'));
  const databasePath = canonicalAnalyticsDatabasePath(path.join(root, 'analytics'));
  const at = Date.parse('2026-01-15T12:00:00.000Z');
  // Overlapping busy cycles: the union of the first two is 2_000ms and the
  // additive measured sum would be 2_400ms, then a separate 200ms cycle and a
  // still-open busy interval whose incomplete evidence must not own the live clock.
  const writer = new SqliteAnalyticsRecorder(databasePath);
  writer.submitBatch([
    busySpanObservation({ spanId: 'busy-1', rootSessionId: 'root-cold-time', startedAtMs: at, endedAtMs: at + 1_000 }),
    busySpanObservation({ spanId: 'busy-2', rootSessionId: 'root-cold-time', startedAtMs: at + 600, endedAtMs: at + 2_000 }),
    busySpanObservation({ spanId: 'busy-3', rootSessionId: 'root-cold-time', startedAtMs: at + 3_000, endedAtMs: at + 3_200 }),
    busySpanObservation({
      spanId: 'busy-open',
      rootSessionId: 'root-cold-time',
      startedAtMs: at - 7 * 24 * 60 * 60 * 1_000,
      endedAtMs: null,
    }),
    // Non-busy activity must never own the wall clock, and another root's
    // busy history must never leak into this session.
    busySpanObservation({ spanId: 'tool-1', rootSessionId: 'root-cold-time', startedAtMs: at, endedAtMs: at + 900, kind: 'tool' }),
    busySpanObservation({ spanId: 'busy-other-root', rootSessionId: 'root-cold-time-other', startedAtMs: at, endedAtMs: at + 10_000 }),
  ]);
  closeFixtureWriter(writer);

  const readModel = new CanonicalAnalyticsReadModel({ databasePath, workerScript, execArgv, timeoutMs: 20_000, revisionPollIntervalMs: 25 });
  const sessionPath = '/sessions/cold-time.jsonl';
  const state = archStateWithSession(sessionPath, 'root-cold-time', at);
  const capture = canonicalCapture();
  const stats = new StatsService({
    dataOutcomesRootPath: path.join(root, 'legacy'),
    workspaceId: 'workspace-working-time',
    getArchState: () => state,
    now: () => new Date(at + 6_000),
    analyticsCapture: capture,
    analyticsReadModel: readModel,
  });
  try {
    await stats.start();
    const workingTime = stats.getWorkingTimeBySession();
    const restored = workingTime[sessionPath];
    assert.ok(restored, 'cold canonical session must restore a working-time state');
    // Interval union, not the additive measured sum (2_600).
    assert.equal(restored.accumulatedMs, 2_200);
    // A historical open span is incomplete evidence, not a live interval:
    // cold restore must never count the days of offline downtime.
    assert.equal(restored.activeSince, null);
    // Measured attribution is not restored; only the wall clock is.
    assert.equal(restored.breakdown, undefined);
    assert.equal(restored.activeToolSince, undefined);

    // View projection -> indicator: the restored state renders a visible chip.
    const label = renderToString(h(IndicatorHarness, {
      sessionPath,
      workingTimeBySession: workingTime,
    }));
    assert.ok(label.length > 0, 'restored working time must render an indicator label');
    const missing = renderToString(h(IndicatorHarness, {
      sessionPath,
      workingTimeBySession: {} as Record<string, WorkingTimeState>,
    }));
    assert.equal(missing, '', 'an unrestored session must stay without an indicator');
  } finally {
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('WorkingTimeService restores canonical unions as replacement clocks and preserves a live busy interval', () => {
  const at = Date.parse('2026-01-15T12:00:00.000Z');
  let current = at + 10_000;
  let renders = 0;
  const workingTime = new WorkingTimeService({
    now: () => new Date(current),
    onChanged: () => { renders += 1; },
  });
  const stateOf = (sessionPath: string): WorkingTimeState | undefined => workingTime.getStates()[sessionPath];

  workingTime.restoreCanonicalBusyUnion('/sessions/p.jsonl', 2_000);
  assert.equal(stateOf('/sessions/p.jsonl')?.accumulatedMs, 2_000);
  // Re-delivering the same union is a no-op, not a double count.
  workingTime.restoreCanonicalBusyUnion('/sessions/p.jsonl', 2_000);
  assert.equal(stateOf('/sessions/p.jsonl')?.accumulatedMs, 2_000);
  // A newer union replaces the prior restored contribution.
  workingTime.restoreCanonicalBusyUnion('/sessions/p.jsonl', 2_700);
  assert.equal(stateOf('/sessions/p.jsonl')?.accumulatedMs, 2_700);

  // A live busy interval keeps its own clock; the union never clobbers it.
  current = at + 20_000;
  workingTime.onBusyChanged('/sessions/p.jsonl', true);
  assert.equal(stateOf('/sessions/p.jsonl')?.activeSince, at + 20_000);
  workingTime.restoreCanonicalBusyUnion('/sessions/p.jsonl', 4_000);
  assert.equal(stateOf('/sessions/p.jsonl')?.activeSince, at + 20_000);
  assert.equal(stateOf('/sessions/p.jsonl')?.accumulatedMs, 4_000);
  // Closing the live interval accumulates only its own delta on top.
  current = at + 20_500;
  workingTime.onBusyChanged('/sessions/p.jsonl', false);
  assert.equal(stateOf('/sessions/p.jsonl')?.accumulatedMs, 4_500);

  // A durable open busy span does not re-arm an idle session or grow while
  // this process is offline.
  workingTime.restoreCanonicalBusyUnion('/sessions/q.jsonl', 0);
  assert.equal(stateOf('/sessions/q.jsonl'), undefined);
  assert.ok(renders > 0);
});

test('a delayed restore reconciles a durable union that already includes live closed cycles', () => {
  const at = Date.parse('2026-01-15T12:00:00.000Z');
  let current = at + 10_000;
  const workingTime = new WorkingTimeService({
    now: () => new Date(current),
    onChanged: () => {},
  });
  const sessionPath = '/sessions/delayed.jsonl';

  workingTime.restoreCanonicalBusyUnion(sessionPath, 1_000);
  current = at + 20_000;
  workingTime.onBusyChanged(sessionPath, true);
  current += 350;
  workingTime.onBusyChanged(sessionPath, false);
  // The first lazy query sees both the historical span and this process's
  // durable cycle. Replacing with that union must not add the live cycle again.
  workingTime.restoreCanonicalBusyUnion(sessionPath, 1_350);
  assert.equal(workingTime.getStates()[sessionPath]?.accumulatedMs, 1_350);
});

test('canonical busy restore unions more than 2000 nested spans in one scalar read', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-canonical-working-time-many-'));
  const databasePath = canonicalAnalyticsDatabasePath(path.join(root, 'analytics'));
  const at = Date.parse('2026-01-15T12:00:00.000Z');
  const writer = new SqliteAnalyticsRecorder(databasePath);
  const observations = [
    busySpanObservation({ spanId: 'busy-island-outer', rootSessionId: 'root-many', startedAtMs: at, endedAtMs: at + 10_000 }),
    ...Array.from({ length: 2_101 }, (_, index) => {
      const startedAtMs = at + 100 + index * 4;
      return busySpanObservation({
        spanId: `busy-nested-${index}`,
        rootSessionId: 'root-many',
        startedAtMs,
        endedAtMs: startedAtMs + 1,
      });
    }),
  ];
  writer.submitBatch(observations);
  closeFixtureWriter(writer);

  const readModel = new CanonicalAnalyticsReadModel({ databasePath, workerScript, execArgv, timeoutMs: 20_000, revisionPollIntervalMs: 25 });
  const sessionPath = '/sessions/many.jsonl';
  const state = archStateWithSession(sessionPath, 'root-many', at);
  const stats = new StatsService({
    dataOutcomesRootPath: path.join(root, 'legacy'),
    workspaceId: 'workspace-working-time',
    getArchState: () => state,
    now: () => new Date(at + 20_000),
    analyticsCapture: canonicalCapture(),
    analyticsReadModel: readModel,
  });
  try {
    await stats.start();
    assert.equal(stats.getWorkingTimeBySession()[sessionPath]?.accumulatedMs, 10_000,
      'nested spans stay one interval island; the scalar query must not drop rows above the old page bound');
  } finally {
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a lazily hydrated cold session restores its working-time clock on first view', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-canonical-working-time-lazy-'));
  const databasePath = canonicalAnalyticsDatabasePath(path.join(root, 'analytics'));
  const at = Date.parse('2026-01-15T12:00:00.000Z');
  const writer = new SqliteAnalyticsRecorder(databasePath);
  writer.submitBatch([
    busySpanObservation({ spanId: 'busy-lazy-1', rootSessionId: 'root-lazy', startedAtMs: at, endedAtMs: at + 1_800 }),
  ]);
  closeFixtureWriter(writer);
  const readModel = new CanonicalAnalyticsReadModel({ databasePath, workerScript, execArgv, timeoutMs: 20_000, revisionPollIntervalMs: 25 });
  const lazyPath = '/sessions/lazy-time.jsonl';
  const state = createInitialArchState();
  // Not displayed at startup: outside activeSessionPath/openTabPaths, exactly
  // like a session the renderer opens after the host came up.
  state.sessions.sessions.push({
    path: lazyPath,
    name: 'lazy-time',
    cwd: '/sessions',
    modifiedAt: new Date(at).toISOString(),
    messageCount: 1,
    sessionId: 'root-lazy',
  });
  const stats = new StatsService({
    dataOutcomesRootPath: path.join(root, 'legacy'),
    workspaceId: 'workspace-working-time',
    getArchState: () => state,
    now: () => new Date(at + 2_000),
    analyticsCapture: canonicalCapture(),
    analyticsReadModel: readModel,
  });
  try {
    await stats.start();
    assert.equal(stats.getWorkingTimeBySession()[lazyPath], undefined);
    // The first view read triggers the bounded lazy durable read, which also
    // restores the canonical busy wall-time union for this path.
    for (let attempt = 0; attempt < 200 && stats.getSessionUsage(lazyPath).authority !== 'canonical'; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(stats.getSessionUsage(lazyPath).authority, 'canonical');
    let restored: WorkingTimeState | undefined;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      restored = stats.getWorkingTimeBySession()[lazyPath];
      if (restored) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(restored?.accumulatedMs, 1_800);
    assert.equal(restored?.activeSince, null);
  } finally {
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});


test('canonical busy restore retries transient failure without rearming incomplete spans', async () => {
  const at = Date.parse('2026-01-15T12:00:00.000Z');
  const executeQueryCalls: string[] = [];
  const attemptsByRoot = new Map<string, number>();
  const makeReadModel = (failingRoot: string, truncatedRoot: string) => ({
    getMaxConcurrentQueries: () => 2,
    readRevision: async () => '7',
    readScopedProviderSettlements: async (scope: { kind: string; rootSessionId: string }) => ({
      revision: '7',
      settlements: [],
      truncated: false,
      scope,
    }),
    executeQuery: async (request: { parameters: readonly unknown[] }) => {
      const rootSessionId = String(request.parameters[0]);
      executeQueryCalls.push(rootSessionId);
      const attempts = (attemptsByRoot.get(rootSessionId) ?? 0) + 1;
      attemptsByRoot.set(rootSessionId, attempts);
      if (rootSessionId === failingRoot && attempts === 1) throw new Error('helper unavailable');
      if (rootSessionId === truncatedRoot) {
        return {
          databaseSchemaVersion: 1,
          projectionRevision: '7',
          snapshotWatermark: '7',
          generationIds: [],
          generationIdsTruncated: false,
          pendingDetailCoverage: {},
          truncation: { rowLimit: true, byteLimit: false, cellLimit: false },
          columns: ['union_ms'],
          rows: [],
          returnedRows: 0,
        };
      }
      return {
        databaseSchemaVersion: 1,
        projectionRevision: '7',
        snapshotWatermark: '7',
        generationIds: [],
        generationIdsTruncated: false,
        pendingDetailCoverage: {},
        truncation: { rowLimit: false, byteLimit: false, cellLimit: false },
        columns: ['union_ms'],
        rows: [{ union_ms: 750 }],
        returnedRows: 1,
      };
    },
  } as unknown as CanonicalAnalyticsReadModel);
  const readModel = makeReadModel('root-fail', 'root-truncated');
  const state = createInitialArchState();
  const failPath = '/sessions/fail.jsonl';
  const truncatedPath = '/sessions/truncated.jsonl';
  state.sessions.sessions.push(
    { path: failPath, name: 'fail', cwd: '/sessions', modifiedAt: new Date(at).toISOString(), messageCount: 1, sessionId: 'root-fail' },
    { path: truncatedPath, name: 'truncated', cwd: '/sessions', modifiedAt: new Date(at).toISOString(), messageCount: 1, sessionId: 'root-truncated' },
  );
  state.sessions.activeSessionPath = failPath;
  state.sessions.openTabPaths = [failPath, truncatedPath];
  const stats = new StatsService({
    dataOutcomesRootPath: path.join(os.tmpdir(), 'pie-canonical-working-time-failover'),
    workspaceId: 'workspace-working-time',
    getArchState: () => state,
    now: () => new Date(at + 1_000),
    analyticsCapture: canonicalCapture(),
    analyticsReadModel: readModel,
  });
  try {
    await stats.start();
    assert.equal(stats.getWorkingTimeBySession()[failPath], undefined, 'a failed read must keep the clock unknown');
    assert.equal(stats.getWorkingTimeBySession()[truncatedPath], undefined, 'a truncated busy page must not restore a partial union');
    const callsAfterStart = executeQueryCalls.length;
    // A later cold access retries the transient failure, while the truncated
    // result remains unknown rather than publishing a partial union.
    await (stats as unknown as {
      restoreCanonicalWorkingTimeForPaths(paths: readonly string[]): Promise<void>;
    }).restoreCanonicalWorkingTimeForPaths([failPath, truncatedPath]);
    assert.ok(executeQueryCalls.length > callsAfterStart);
    assert.equal(stats.getWorkingTimeBySession()[failPath]?.accumulatedMs, 750);
    assert.equal(stats.getWorkingTimeBySession()[failPath]?.activeSince, null);
    assert.equal(stats.getWorkingTimeBySession()[truncatedPath], undefined);
    await (stats as unknown as {
      restoreCanonicalWorkingTimeForPaths(paths: readonly string[]): Promise<void>;
    }).restoreCanonicalWorkingTimeForPaths([failPath, truncatedPath]);
    assert.equal(attemptsByRoot.get('root-fail'), 2, 'a successful recovery is latched once');
  } finally {
    await stats.shutdown();
  }
});

test('a canonical privacy close discards the restored clock and a rename keeps it on the rebound path', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-canonical-working-time-close-'));
  const databasePath = canonicalAnalyticsDatabasePath(path.join(root, 'analytics'));
  const at = Date.parse('2026-01-15T12:00:00.000Z');
  const writer = new SqliteAnalyticsRecorder(databasePath);
  writer.submitBatch([
    busySpanObservation({ spanId: 'busy-close-1', rootSessionId: 'root-close', startedAtMs: at, endedAtMs: at + 1_500 }),
  ]);
  closeFixtureWriter(writer);
  const readModel = new CanonicalAnalyticsReadModel({ databasePath, workerScript, execArgv, timeoutMs: 20_000, revisionPollIntervalMs: 25 });
  const sessionPath = '/sessions/close-time.jsonl';
  const state = archStateWithSession(sessionPath, 'root-close', at);
  const stats = new StatsService({
    dataOutcomesRootPath: path.join(root, 'legacy'),
    workspaceId: 'workspace-working-time',
    getArchState: () => state,
    now: () => new Date(at + 2_000),
    analyticsCapture: canonicalCapture(),
    analyticsReadModel: readModel,
  });
  try {
    await stats.start();
    assert.equal(stats.getWorkingTimeBySession()[sessionPath]?.accumulatedMs, 1_500);

    const renamedPath = '/sessions/close-time-renamed.jsonl';
    stats.replaceSessionPath(sessionPath, renamedPath, 'root-close');
    assert.equal(stats.getWorkingTimeBySession()[renamedPath]?.accumulatedMs, 1_500, 'rename must keep the restored clock');
    assert.equal(stats.getWorkingTimeBySession()[sessionPath], undefined);

    await stats.closePrivateSessionAnalytics(renamedPath, undefined, 'root-close');
    assert.equal(stats.getWorkingTimeBySession()[renamedPath], undefined, 'privacy close must discard the restored clock');
  } finally {
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});