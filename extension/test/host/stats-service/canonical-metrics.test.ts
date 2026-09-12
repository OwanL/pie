import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { AnalyticsObservation } from '../../../../shared/analytics/contracts.js';
import { CanonicalAnalyticsCapture } from '../../../src/analytics/canonical-capture.js';
import { createInitialArchState } from '../../../src/host/core/arch-state.js';
import { StatsService } from '../../../src/host/stats-service/index.js';
import { SqliteAnalyticsRecorder } from '../../../src/analytics/sqlite-recorder.js';

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-canonical-metrics-'));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function createCapture(observations: AnalyticsObservation<object>[]): CanonicalAnalyticsCapture {
  return new CanonicalAnalyticsCapture({
    authority: 'canonical',
    generationId: 'generation-metrics',
    workspaceId: 'workspace-metrics',
    buildId: 'build-metrics',
    processGeneration: 'process-metrics',
    sink: { submit: (observation) => { observations.push(observation); } },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
}

test('canonical capture preserves point context evidence and nullable latency components', () => {
  const observations: AnalyticsObservation<object>[] = [];
  const capture = createCapture(observations);
  const context = {
    sessionId: 'session-metrics',
    sessionPath: '/sensitive/path/session.jsonl',
    runId: 'run-metrics',
    operationId: 'operation-metrics',
  };

  assert.equal(capture.captureContextObservation(context, 'context-observation-1', 100, {
    source: 'provider',
    provider: 'fixture-provider',
    modelId: 'fixture-model',
    contextLimitTokens: 100_000,
    inputTokens: null,
    estimate: false,
  }), 'submitted');
  assert.equal(capture.captureLatency(context, 'operation-metrics', 'turn-metrics',
    'latency:operation-metrics:turn-metrics', 200, {
      requestToFirstOutputMs: 80,
      providerFirstOutputWaitMs: 65,
      providerHeaderWaitMs: null,
      fullOperationMs: null,
      generationDurationMs: 1_200,
      coverage: 'known',
    }), 'submitted');

  assert.equal(observations.length, 2);
  const contextObservation = observations[0]!;
  assert.equal(contextObservation.entityKind, 'contextObservation');
  assert.equal(contextObservation.observationKind, 'observation');
  assert.deepEqual(contextObservation.fields, {
    source: 'provider',
    provider: 'fixture-provider',
    modelId: 'fixture-model',
    contextLimitTokens: 100_000,
    inputTokens: null,
    observedAtMs: 100,
    estimate: false,
  });
  assert.equal(JSON.stringify(contextObservation).includes('/sensitive/path'), false);

  const latencyObservation = observations[1]!;
  assert.equal(latencyObservation.entityKind, 'execution');
  assert.equal((latencyObservation.fields as { operationId: string }).operationId, 'operation-metrics');
  assert.deepEqual((latencyObservation.fields as { latency: object }).latency, {
    requestToFirstOutputMs: 80,
    providerFirstOutputWaitMs: 65,
    providerHeaderWaitMs: null,
    fullOperationMs: null,
    generationDurationMs: 1_200,
    coverage: 'known',
  });
});

test('equal context readings remain distinct source observations while exact replay stays idempotent', async () => {
  await withTempDir(async (root) => {
    const recorder = new SqliteAnalyticsRecorder(path.join(root, 'analytics.sqlite'));
    const errors: Error[] = [];
    const capture = new CanonicalAnalyticsCapture({
      authority: 'canonical', generationId: 'context-generation', workspaceId: 'workspace',
      buildId: 'build', processGeneration: 'process', sink: recorder,
      detailSink: recorder,
      lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
      onCaptureError: (error) => errors.push(error),
    });
    try {
      const context = { sessionId: 'session', sessionPath: '/session', operationId: 'operation' };
      const fields = { source: 'provider', inputTokens: 100, contextLimitTokens: 1000, estimate: false };
      capture.captureContextObservation(context, 'source-1', 100, fields);
      capture.captureContextObservation(context, 'source-2', 200, fields);
      capture.captureContextObservation(context, 'source-1', 100, fields);
      capture.captureContextObservation(context, 'source-3', 300, { ...fields, source: 'postCompactionEstimate', estimate: true });
      assert.deepEqual(errors, []);
      assert.equal(recorder.countObservations(), 3);
      assert.equal(recorder.getStats().duplicates, 1);
      const rows = recorder.executeReadOnlyQuery(`
        SELECT observed_at_ms, json_extract(payload_json, '$.fields.estimate') AS estimated
        FROM analytics_observations ORDER BY commit_sequence
      `).rows;
      assert.deepEqual(rows.map((row) => [row.observed_at_ms, row.estimated]), [['100', 0], ['200', 0], ['300', 1]]);
    } finally { recorder.close(); }
  });
});

test('StatsService gives repeated busy cycles distinct canonical spans and keeps retry evidence nullable', async () => {
  await withTempDir(async (root) => {
    const sessionPath = '/workspace/metrics-session.jsonl';
    const state = createInitialArchState();
    state.sessions.sessions = [{
      path: sessionPath,
      sessionId: 'session-metrics',
      name: 'Metrics',
      cwd: '/workspace',
      modifiedAt: '2026-09-13T00:00:00.000Z',
      messageCount: 0,
      modelId: 'fixture-model',
      provider: 'fixture-provider',
    }];
    const observations: AnalyticsObservation<object>[] = [];
    const capture = createCapture(observations);
    let nowMs = Date.parse('2026-09-13T00:00:00.000Z');
    let id = 0;
    const stats = new StatsService({
      dataOutcomesRootPath: path.join(root, 'outcomes'),
      legacyUsageDataRootPath: root,
      workspaceId: 'workspace-metrics',
      getArchState: () => state,
      now: () => new Date(nowMs),
      createId: () => `id-${++id}`,
      analyticsCapture: capture,
    });
    try {
      stats.prepareForSend(sessionPath, []);
      stats.onContextUsageChanged(sessionPath, null, 100_000);
      stats.onContextUsageChanged(sessionPath, 1_234, 100_000, {
        observationId: 'context-estimate', observedAt: 10,
        source: 'postCompactionEstimate', modelId: 'source-model', provider: 'source-provider',
      });
      const contextPoints = observations.filter((entry) => entry.entityKind === 'contextObservation');
      assert.equal((contextPoints[0]!.fields as { estimate: unknown }).estimate, null);
      assert.equal(contextPoints[1]!.observedAtMs, 10, 'source time must not become host receipt time');
      assert.equal((contextPoints[1]!.fields as { estimate: unknown }).estimate, true);
      assert.equal((contextPoints[1]!.fields as { modelId: unknown }).modelId, 'source-model');
      stats.onContextUsageChanged(sessionPath, 400, 100_000, {
        observationId: 'context-unknown-footprint', observedAt: 11,
        source: 'unknown', canonicalInputTokens: null,
      });
      stats.onContextUsageChanged(sessionPath, 4, 100_000, {
        observationId: 'context-zero-footprint', observedAt: 12,
        source: 'provider', canonicalInputTokens: 0,
      });
      const qualified = observations.filter((entry) => entry.entityKind === 'contextObservation').slice(-2);
      assert.deepEqual(qualified.map((entry) => (entry.fields as { inputTokens: unknown }).inputTokens), [null, 0]);
      stats.onAssistantTurnEnded(sessionPath, 'latency-turn', 0, undefined, 'completed', {
        turnLatencyMs: 80, providerLatencyMs: 65, overheadMs: 15, providerQueueMs: 0,
      }, { operationId: 'source-operation', occurredAt: '2026-09-13T00:00:00.000Z' });
      stats.onAssistantTurnEnded(sessionPath, 'zero-duration-turn', 0, undefined, 'completed', undefined, {
        operationId: 'source-operation', generationDurationMs: 0,
      });
      const latencyFacets = observations.filter((entry) => (entry.fields as { source?: string }).source === 'host-latency')
        .map((entry) => (entry.fields as { latency: Record<string, unknown> }).latency);
      assert.deepEqual(latencyFacets[0], {
        turnBoundaryToFirstOutputMs: 80, turnStartToFirstOutputMs: 65,
        turnPreparationMs: 15, providerQueueMs: 0, generationDurationMs: null,
        requestToFirstOutputMs: null, providerFirstOutputWaitMs: null,
        providerHeaderWaitMs: null, fullOperationMs: null, coverage: 'unknown',
      });
      assert.equal(latencyFacets[1]!.generationDurationMs, 0, 'explicit measured zero survives');
      const missingTimePhase = observations.find((entry) => entry.sourceKey === 'turn:zero-duration-turn:end');
      assert.equal(missingTimePhase?.observedAtMs, 0, 'missing source time uses a stable envelope sentinel');
      assert.equal((missingTimePhase?.fields as { endedAtMs?: unknown }).endedAtMs, null);
      const sourcedPhase = observations.find((entry) => entry.sourceKey === 'turn:latency-turn:end');
      assert.equal((sourcedPhase?.fields as { endedAtMs?: unknown }).endedAtMs, null,
        'message creation time must not become an observed terminal time');

      stats.onBusyChanged(sessionPath, true);
      nowMs += 25;
      stats.onBusyChanged(sessionPath, false);
      nowMs += 25;
      stats.onBusyChanged(sessionPath, true);
      nowMs += 35;
      stats.onBusyChanged(sessionPath, false);

      stats.onAutoRetry(sessionPath, {
        sourceId: 'request-1:retry-1',
        occurredAt: new Date(nowMs - 30).toISOString(),
        attempt: 1,
        scheduledDelayMs: 50,
      });
      stats.onAutoRetryMeasured(sessionPath, 'request-1:retry-1', undefined, 30, {
        operationId: 'source-operation', startedAt: 100, endedAt: 130,
      });

      const busySpans = observations.filter((observation) => (
        observation.entityKind === 'activitySpan'
        && (observation.fields as { kind?: string }).kind === 'busy'
        && observation.observationKind === 'begin'
      ));
      assert.equal(busySpans.length, 2);
      assert.equal(new Set(busySpans.map((span) => span.entityKey)).size, 2);
      assert.equal(new Set(busySpans.map((span) => span.sourceKey)).size, 2);

      const retrySpan = observations.find((observation) => (
        observation.entityKind === 'activitySpan'
        && (observation.fields as { kind?: string }).kind === 'retry_wait'
        && observation.observationKind === 'end'
      ));
      assert.ok(retrySpan);
      assert.equal((retrySpan.fields as { durationMs: unknown }).durationMs, null,
        'full retry episode duration cannot fill an unmeasured wait');
      assert.equal((retrySpan.fields as { endedAtMs: unknown }).endedAtMs, null);
      const episode = observations.find((entry) => (entry.fields as { kind?: string }).kind === 'retry_episode')!;
      assert.equal((episode.fields as { durationMs: unknown }).durationMs, 30);
      assert.equal((episode.fields as { endedAtMs: unknown }).endedAtMs, 130);
      assert.equal(episode.observedAtMs, 130);
      const run = stats.getOpenRuns()[0]!;
      assert.equal(run.retryTimingSamples?.[0]?.measuredDelayMs, null);
      assert.equal(run.retryTimingSamples?.[0]?.durationMs, 30);
      assert.equal((run.retryTimingSamples?.[0]?.scheduledDelayMs), 50);
    } finally {
      await stats.shutdown();
    }
  });
});
