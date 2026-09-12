import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { AnalyticsObservation } from '../../../shared/analytics/contracts.js';
import { CanonicalAnalyticsCapture } from '../../src/analytics/canonical-capture.js';
import { SqliteAnalyticsRecorder } from '../../src/analytics/sqlite-recorder.js';
import { BillableAccounting } from '../../src/host/billable-accounting/service.js';

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
