import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { AnalyticsObservation } from '../../../shared/analytics/contracts.js';
import { CanonicalAnalyticsCapture } from '../../src/analytics/canonical-capture.js';
import { SqliteAnalyticsRecorder } from '../../src/analytics/sqlite-recorder.js';
import { BillableAccounting } from '../../src/host/billable-accounting/service.js';

test('activity capture retains missing and reversed source bounds without fabricated observed duration', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-activity-timestamps-'));
  const recorder = new SqliteAnalyticsRecorder(path.join(root, 'analytics.sqlite'));
  const errors: Error[] = [];
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical', generationId: 'activity-generation',
    workspaceId: 'workspace', buildId: 'build', processGeneration: 'process',
    sink: { submit: (observation) => recorder.submit(observation) },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
    onCaptureError: (error) => errors.push(error),
  });
  try {
    const cases = [
      { startedAt: 'invalid', endedAt: 'invalid' },
      { startedAt: '1970-01-01T00:00:00Z', endedAt: 'invalid' },
      { startedAt: '1970-01-01T00:00:02Z', endedAt: '1970-01-01T00:00:01Z' },
      { startedAt: '1970-01-01T00:00:00Z', endedAt: '1970-01-01T00:00:00Z' },
      { startedAt: '1970-01-01T00:00:00Z' },
      { startedAt: '1970-01-01T00:00:01Z', durationMs: 7 },
      {
        startedAt: '1970-01-01T00:00:02Z', endedAt: '1970-01-01T00:00:01Z',
        durationMs: 7, durationClockDomain: 'monotonic-same-process' as const,
      },
      {
        startedAt: '1970-01-01T00:00:02Z', durationMs: 7,
        durationClockDomain: 'monotonic-same-process' as const,
      },
    ];
    for (const [index, times] of cases.entries()) {
      const interval = {
        schemaVersion: 1 as const, intervalId: `span-${index}`, sessionId: 'session',
        sessionPath: '/session', parentRunId: null, parentOperationId: 'operation',
        invocationId: null, toolId: null, kind: 'busy' as const, ...times,
      };
      const context = { sessionId: 'session', sessionPath: '/session', operationId: 'operation' };
      assert.equal(capture.captureActivity(context, interval), 'submitted');
      assert.equal(capture.captureActivity(context, interval), 'submitted');
    }
    assert.deepEqual(errors, [], 'unchanged evidence is replayable without receipt-clock conflicts');
    const rows = recorder.executeReadOnlyQuery(`
      SELECT started_at_ms, ended_at_ms, duration_ms, coverage
      FROM analytics_activity_states ORDER BY span_id
    `).rows;
    assert.deepEqual(rows.map((row) => Object.values(row)), [
      [null, null, null, 'unknown'],
      ['0', null, null, 'unknown'],
      ['2000', '1000', null, 'unknown'],
      ['0', '0', 0, 'observed'],
      ['0', null, null, 'observed'],
      ['1000', '1007', 7, 'observed'],
      ['2000', '1000', 7, 'observed'],
      ['2000', null, 7, 'observed'],
    ]);
  } finally {
    recorder.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('provider capture keeps unavailable source dates undated and preserves a real epoch settlement', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-capture-timestamps-'));
  const recorder = new SqliteAnalyticsRecorder(path.join(root, 'analytics.sqlite'));
  const observations: AnalyticsObservation<object>[] = [];
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical', generationId: 'timestamp-generation',
    workspaceId: 'workspace', buildId: 'build', processGeneration: 'process',
    sink: { submit: (observation) => { observations.push(observation); recorder.submit(observation); } },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
  try {
    for (const [index, sourceTime] of ['', 'invalid-time', '1970-01-01T00:00:00.000Z'].entries()) {
      assert.equal(capture.captureProviderSettlement({
        schemaVersion: 1, invocationId: `invocation-${index}`, sourceId: `source-${index}`,
        sessionId: 'session', sessionPath: null, branchId: null,
        parentOperationId: null, parentRunId: null, parentToolId: null,
        kind: 'conversation', provider: 'provider', model: 'model',
        provenance: 'exact', evidenceOrigin: 'live', instrumentationGap: false,
        startedAt: sourceTime, endedAt: sourceTime, outcome: 'succeeded',
        inputTokens: 1, outputTokens: 2, providerReportedCostUsd: 0.25,
      }), 'submitted');
    }
    assert.deepEqual(observations.map(({ fields }) => {
      const times = fields as { startedAtMs: unknown; endedAtMs: unknown; settledAtMs: unknown };
      return [times.startedAtMs, times.endedAtMs, times.settledAtMs];
    }), [[null, null, null], [null, null, null], [0, 0, 0]]);
    assert.deepEqual(observations.map((observation) => observation.observedAtMs), [0, 0, 0],
      'unavailable source time cannot vary with the clock on redelivery');
    const { settlements } = recorder.readProviderSettlements();
    assert.equal(settlements.length, 3, 'undated usage remains in durable accounting');
    assert.deepEqual(settlements.map((row) => row.settledAtMs), [null, null, 0]);
    assert.equal(settlements.reduce((sum, row) => sum + (row.effectiveCostUsd ?? 0), 0), 0.75);
  } finally {
    recorder.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('retry timing separates monotonic measured durations from wall-derived evidence', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-retry-timing-'));
  const recorder = new SqliteAnalyticsRecorder(path.join(root, 'analytics.sqlite'));
  const observations: AnalyticsObservation<object>[] = [];
  const errors: Error[] = [];
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical', generationId: 'retry-timing-generation',
    workspaceId: 'workspace', buildId: 'build', processGeneration: 'process',
    sink: { submit: (observation) => { observations.push(observation); recorder.submit(observation); } },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
    onCaptureError: (error) => errors.push(error),
  });
  const spanByKind = (pair: number, kind: 'retry_wait' | 'retry_episode') => {
    const spans = observations.filter((entry) => entry.entityKind === 'activitySpan'
      && (entry.fields as { kind?: string }).kind === kind);
    return spans[pair]!.fields as {
      startedAtMs: unknown; endedAtMs: unknown; durationMs: unknown;
      clockDomain: unknown; coverage: unknown;
    };
  };
  try {
    const context = { sessionId: 'session', sessionPath: '/session', operationId: 'operation' };
    // Monotonic-measured durations stay observed even when their wall bounds
    // reversed across a clock jump; the span names the measured duration's
    // domain while the bounds remain wall-clock-utc correlation anchors.
    assert.equal(capture.captureRetryTiming(context, 'request-1:1', {
      startedAt: 3_000, providerAttemptStartedAt: 2_000, endedAt: 1_000,
      measuredDelayMs: 500, durationMs: 2_500,
      durationClockDomain: 'monotonic-same-process',
    }), 'submitted');
    // Missing wall bounds entirely; the measured durations are the evidence.
    assert.equal(capture.captureRetryTiming(context, 'request-1:2', {
      measuredDelayMs: 120, durationMs: 800,
      durationClockDomain: 'monotonic-same-process',
    }), 'submitted');
    // A genuine monotonic zero is a real sub-millisecond measurement.
    assert.equal(capture.captureRetryTiming(context, 'request-1:3', {
      measuredDelayMs: 0, durationMs: 0,
      durationClockDomain: 'monotonic-same-process',
    }), 'submitted');
    // Nonfinite or negative measured values stay unknown even when marked.
    assert.equal(capture.captureRetryTiming(context, 'request-1:4', {
      startedAt: 1_000, endedAt: 1_500, measuredDelayMs: Number.NaN, durationMs: -5,
      durationClockDomain: 'monotonic-same-process',
    }), 'submitted');
    // Unmarked wall-derived durations inherit the wall bounds' failure modes:
    // a producer clamp of reversed wall endpoints is never promoted, and a
    // finite duration against reversed bounds is unknown, not observed.
    assert.equal(capture.captureRetryTiming(context, 'request-2:1', {
      startedAt: 3_000, providerAttemptStartedAt: 2_000, endedAt: 1_000,
      measuredDelayMs: 0, durationMs: 0,
    }), 'submitted');
    // Valid preexisting wall payloads remain truthful with ordered bounds.
    assert.equal(capture.captureRetryTiming(context, 'request-2:2', {
      startedAt: 1_000, providerAttemptStartedAt: 1_200, endedAt: 1_500,
      measuredDelayMs: 200, durationMs: 500,
    }), 'submitted');
    // A wait stays absent until dispatch; an episode duration never fills it.
    assert.equal(capture.captureRetryTiming(context, 'request-2:3', {
      startedAt: 1_000, endedAt: 1_500, durationMs: 500,
    }), 'submitted');
    // Exact redelivery stays idempotent.
    assert.equal(capture.captureRetryTiming(context, 'request-1:1', {
      startedAt: 3_000, providerAttemptStartedAt: 2_000, endedAt: 1_000,
      measuredDelayMs: 500, durationMs: 2_500,
      durationClockDomain: 'monotonic-same-process',
    }), 'submitted');
    assert.deepEqual(errors, []);
    assert.deepEqual([
      spanByKind(0, 'retry_wait'), spanByKind(0, 'retry_episode'),
    ].map(({ startedAtMs, endedAtMs, durationMs, clockDomain, coverage }) => (
      { startedAtMs, endedAtMs, durationMs, clockDomain, coverage }
    )), [
      { startedAtMs: 3_000, endedAtMs: 2_000, durationMs: 500, clockDomain: 'monotonic-same-process', coverage: 'observed' },
      { startedAtMs: 3_000, endedAtMs: 1_000, durationMs: 2_500, clockDomain: 'monotonic-same-process', coverage: 'observed' },
    ]);
    assert.deepEqual([
      spanByKind(1, 'retry_wait'), spanByKind(1, 'retry_episode'),
    ].map(({ startedAtMs, endedAtMs, durationMs, clockDomain, coverage }) => (
      { startedAtMs, endedAtMs, durationMs, clockDomain, coverage }
    )), [
      { startedAtMs: null, endedAtMs: null, durationMs: 120, clockDomain: 'monotonic-same-process', coverage: 'observed' },
      { startedAtMs: null, endedAtMs: null, durationMs: 800, clockDomain: 'monotonic-same-process', coverage: 'observed' },
    ]);
    assert.deepEqual([spanByKind(2, 'retry_wait'), spanByKind(2, 'retry_episode')].map((span) => [
      span.durationMs, span.clockDomain, span.coverage,
    ]), [[0, 'monotonic-same-process', 'observed'], [0, 'monotonic-same-process', 'observed']]);
    assert.deepEqual([spanByKind(3, 'retry_wait'), spanByKind(3, 'retry_episode')].map((span) => [
      span.durationMs, span.clockDomain, span.coverage,
    ]), [[null, 'wall-clock-utc', 'unknown'], [null, 'wall-clock-utc', 'unknown']]);
    assert.deepEqual([spanByKind(4, 'retry_wait'), spanByKind(4, 'retry_episode')].map((span) => [
      span.durationMs, span.clockDomain, span.coverage,
    ]), [[null, 'wall-clock-utc', 'unknown'], [null, 'wall-clock-utc', 'unknown']]);
    const preservedWait = spanByKind(5, 'retry_wait');
    assert.deepEqual([preservedWait.startedAtMs, preservedWait.endedAtMs, preservedWait.durationMs,
      preservedWait.clockDomain, preservedWait.coverage], [1_000, 1_200, 200, 'wall-clock-utc', 'observed']);
    const preservedEpisode = spanByKind(5, 'retry_episode');
    assert.deepEqual([preservedEpisode.startedAtMs, preservedEpisode.endedAtMs, preservedEpisode.durationMs,
      preservedEpisode.clockDomain, preservedEpisode.coverage], [1_000, 1_500, 500, 'wall-clock-utc', 'observed']);
    const dispatchWait = spanByKind(6, 'retry_wait');
    assert.deepEqual([dispatchWait.durationMs, dispatchWait.endedAtMs, dispatchWait.clockDomain,
      dispatchWait.coverage], [null, null, 'wall-clock-utc', 'unknown']);
    const dispatchEpisode = spanByKind(6, 'retry_episode');
    assert.deepEqual([dispatchEpisode.startedAtMs, dispatchEpisode.endedAtMs, dispatchEpisode.durationMs,
      dispatchEpisode.coverage], [1_000, 1_500, 500, 'observed']);
    const spans = observations.filter((entry) => entry.entityKind === 'activitySpan');
    assert.equal(new Set(spans.map((span) => span.entityKey)).size, 14,
      'each measured pair stays a distinct wait/episode identity');
    assert.equal(spans.length, 16, 'redelivery re-emits into the sink while identities stay stable');
    assert.equal(recorder.getStats().duplicates, 2, 'exact redelivery is a no-op, not a conflict');
  } finally {
    recorder.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('accounting adapter does not replace missing producer dates with its clock before canonical capture', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-accounting-timestamps-'));
  const recorder = new SqliteAnalyticsRecorder(path.join(root, 'analytics.sqlite'));
  const captureErrors: Error[] = [];
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical', generationId: 'accounting-timestamp-generation',
    workspaceId: 'workspace', buildId: 'build', processGeneration: 'process',
    sink: { submit: (observation) => recorder.submit(observation) },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
    onCaptureError: (error) => { captureErrors.push(error); },
  });
  const accounting = new BillableAccounting({
    getStorageDir: () => root, now: () => new Date('2026-09-12T12:00:00Z'),
    scheduleRender: () => undefined, dispatchArchEvent: () => undefined,
    getAgentDir: () => null, isPrivateSession: () => false,
    sessionIdentity: () => ({ sessionId: 'session' }), currentRunId: () => null,
    activeOperationId: () => null, markDerivedExportDirty: () => assert.fail('legacy export'),
    canonicalCapture: capture,
  });
  try {
    for (const [index, occurredAt] of ['', 'invalid-time', '1970-01-01T00:00:00.000Z'].entries()) {
      const sample = {
        kind: 'assistant_message' as const, sourceId: `accounting-source-${index}`, occurredAt,
        provider: 'provider', modelId: 'model', inputTokens: 1, outputTokens: 2,
        reportedCostUsd: 0.25, outcome: 'succeeded' as const,
      };
      accounting.observeAuxiliaryLlmUsage('/session.jsonl', sample);
      accounting.observeAuxiliaryLlmUsage('/session.jsonl', sample);
    }
    const { settlements } = recorder.readProviderSettlements();
    assert.equal(settlements.length, 3);
    assert.deepEqual(captureErrors, [], 'exact redelivery stays idempotent with missing producer dates');
    assert.equal(settlements.filter((row) => row.settledAtMs === null).length, 2);
    assert.equal(settlements.filter((row) => row.settledAtMs === 0).length, 1);
    assert.equal(settlements.reduce((sum, row) => sum + (row.effectiveCostUsd ?? 0), 0), 0.75);
  } finally {
    recorder.close();
    rmSync(root, { recursive: true, force: true });
  }
});
