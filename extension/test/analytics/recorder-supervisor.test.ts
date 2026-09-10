import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { serialize } from 'node:v8';

import type { AnalyticsDetailCapture, AnalyticsObservation } from '../../../shared/analytics/contracts.js';
import {
  AnalyticsCaptureCapacityError,
  AnalyticsRecorderSupervisor,
} from '../../src/analytics/recorder-supervisor.js';

const workerScript = fileURLToPath(new URL('./fixtures/recorder-supervisor-worker.cjs', import.meta.url));

function observation(sourceKey: string, subject: AnalyticsObservation['captureSubject'] = {
  kind: 'pendingCreate', operationId: 'pending-a',
}): AnalyticsObservation {
  return {
    schemaVersion: 1,
    generationId: 'generation-a',
    producerKind: 'test',
    sourceSequence: 1,
    sourceKey,
    entityKind: 'execution',
    entityKey: sourceKey,
    observationKind: 'end',
    idempotencyKey: sourceKey,
    observedAtMs: 1_780_000_000_000,
    scope: { workspaceCoverage: 'known', workspaceId: 'workspace-a' },
    captureSubject: subject,
    producer: { buildId: 'test-build', processGeneration: 'test-process' },
    fields: { outcome: 'original' },
  };
}

function detail(sourceKey: string, value: unknown): AnalyticsDetailCapture {
  return {
    schemaVersion: 1,
    generationId: 'generation-a',
    stableOriginId: `origin:${sourceKey}`,
    producerKind: 'test',
    producer: { buildId: 'test-build', processGeneration: 'test-process' },
    payloadId: sourceKey,
    sourceKey,
    observedAtMs: 1_780_000_000_001,
    captureSubject: { kind: 'session', rootSessionId: 'root-a' },
    mediaType: 'application/x-pie-subagent-result',
    encoding: 'node-v8',
    complete: true,
    bytes: serialize(value),
    metadata: { captureStage: 'terminal' },
  };
}

function readLog(logPath: string): Array<Record<string, unknown>> {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('supervisor owns immutable serialized capture, accounts retained bytes, and orders lifecycle commands', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-recorder-supervisor-'));
  const logPath = path.join(root, 'capture.log');
  const measurements: Array<{ stage: string; synchronousMs: number; callbackLatencyMs?: number }> = [];
  const supervisor = new AnalyticsRecorderSupervisor({
    enabled: true,
    workerScript,
    databasePath: logPath,
    maxQueueBytes: 8 * 1024 * 1024,
    onProducerWorkMeasured: (measurement) => measurements.push(measurement),
  });
  try {
    await supervisor.start();
    assert.throws(
      () => supervisor.preflightDetail({ text: 'x'.repeat(5 * 1024 * 1024) }),
      AnalyticsCaptureCapacityError,
      'oversized values are rejected before ownership serialization',
    );
    const submitted = observation('pending-observation');
    supervisor.submit(submitted);
    submitted.sourceKey = 'mutated-after-submit';
    (submitted.fields as { outcome: string }).outcome = 'mutated';

    const bind = supervisor.bindPendingCreate('pending-a', 'root-a', 'bind-a', 1_780_000_000_002);
    const small = detail('small-detail', { text: 'small' });
    supervisor.submitDetail(small);
    const bytesAfterSmall = supervisor.backlog.queuedBytes + supervisor.backlog.inFlightBytes;
    const large = detail('large-detail', { text: 'x'.repeat(64 * 1024) });
    supervisor.submitDetail(large);
    const bytesAfterLarge = supervisor.backlog.queuedBytes + supervisor.backlog.inFlightBytes;
    assert.ok(bytesAfterLarge - bytesAfterSmall > 64 * 1024, 'large capture is charged by retained bytes, not a flat estimate');
    small.bytes.fill(0);
    large.bytes.fill(0);

    await bind;
    await supervisor.flush();
    const rows = readLog(logPath);
    assert.deepEqual(rows.map((row) => row.type), ['observation', 'bind', 'detail', 'detail']);
    assert.equal(rows[0]?.sourceKey, 'pending-observation');
    assert.deepEqual(rows[2]?.detail, { text: 'small' });
    assert.equal((rows[3]?.detail as { text?: string }).text?.length, 64 * 1024);
    assert.ok(measurements.some((measurement) => measurement.stage === 'ownership-preflight'));
    assert.ok(measurements.some((measurement) => measurement.stage === 'ownership-serialize'));
    assert.ok(measurements.some((measurement) => measurement.stage === 'ipc-send'
      && typeof measurement.callbackLatencyMs === 'number'));
    assert.ok(measurements.every((measurement) => measurement.synchronousMs >= 0));
    await supervisor.shutdown();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('deletion-fence rejection is visible per record and cannot discard or block unrelated batch members', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-recorder-delete-fence-'));
  const logPath = path.join(root, 'capture.log');
  const supervisor = new AnalyticsRecorderSupervisor({ enabled: true, workerScript, databasePath: logPath });
  try {
    await supervisor.start();
    supervisor.submit(observation('deleted-subject', { kind: 'session', rootSessionId: 'deleted-root' }));
    supervisor.submit(observation('unrelated-after-delete', { kind: 'session', rootSessionId: 'unrelated-root' }));
    await supervisor.flush();
    assert.deepEqual(readLog(logPath).map((row) => row.sourceKey), ['unrelated-after-delete']);
    assert.equal(supervisor.backlog.deliveryFailures, 1);
    assert.match(supervisor.lastDeliveryError?.message ?? '', /subject is deleted/);
    assert.equal(supervisor.backlog.queuedRecords, 0);
    await supervisor.shutdown();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('shutdown recovers an ambiguous helper failure and drains accepted capture before stopping', { timeout: 5_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-recorder-shutdown-recovery-'));
  const logPath = path.join(root, 'capture.log');
  const supervisor = new AnalyticsRecorderSupervisor({
    enabled: true,
    workerScript,
    databasePath: logPath,
    maxAutomaticRestarts: 1,
  });
  try {
    await supervisor.start();
    supervisor.submit(observation('crash-once', { kind: 'session', rootSessionId: 'root-shutdown' }));
    await supervisor.shutdown();
    assert.deepEqual(readLog(logPath).map((row) => row.sourceKey), ['crash-once']);
    assert.ok(supervisor.backlog.replayedRecords >= 1);
    assert.equal(supervisor.backlog.queuedRecords, 0);
    assert.equal(supervisor.workerPid, undefined);
  } finally {
    if (supervisor.workerPid) process.kill(supervisor.workerPid, 'SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});

test('supervisor replays accepted immutable identities after an ambiguous helper failure without loss or reorder', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-recorder-failover-'));
  const logPath = path.join(root, 'capture.log');
  const supervisor = new AnalyticsRecorderSupervisor({
    enabled: true,
    workerScript,
    databasePath: logPath,
    maxAutomaticRestarts: 1,
  });
  try {
    await supervisor.start();
    supervisor.submit(observation('crash-once', { kind: 'session', rootSessionId: 'root-failover' }));
    supervisor.submit(observation('after-crash', { kind: 'session', rootSessionId: 'root-failover' }));
    await supervisor.flush();
    assert.deepEqual(readLog(logPath).map((row) => row.sourceKey), ['crash-once', 'after-crash']);
    assert.ok(supervisor.backlog.deliveryFailures >= 2);
    assert.ok(supervisor.backlog.replayedRecords >= 2);
    assert.equal(supervisor.backlog.peakRecords, 2, 'requeued ownership is not double-counted as queued and in-flight');
    assert.equal(supervisor.backlog.queuedRecords, 0);
    await supervisor.shutdown();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
