import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rm as rmAsync } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { serialize } from 'node:v8';

import {
  ANALYTICS_SCHEMA_VERSION,
  deriveAnalyticsIdempotencyKey,
  type AnalyticsDetailCapture,
  type AnalyticsObservation,
} from '../../../shared/analytics/contracts.js';
import {
  AnalyticsCaptureCapacityError,
  AnalyticsRecorderSupervisor,
} from '../../src/analytics/recorder-supervisor.js';
import { SqliteAnalyticsRecorder } from '../../src/analytics/sqlite-recorder.js';

const workerScript = fileURLToPath(new URL('./fixtures/recorder-supervisor-worker.cjs', import.meta.url));
const lifecycleWorkerScript = fileURLToPath(new URL('./fixtures/recorder-supervisor-lifecycle-worker.cjs', import.meta.url));
const sqliteWorkerScript = fileURLToPath(new URL('../../src/analytics/recorder-worker-entry.ts', import.meta.url));

async function eventually(predicate: () => boolean, message: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function observation(
  sourceKey: string,
  subject: AnalyticsObservation['captureSubject'] = { kind: 'pendingCreate', operationId: 'pending-a' },
  producer: { stableOriginId?: string; processGeneration?: string } = {},
): AnalyticsObservation {
  const base: Omit<AnalyticsObservation, 'idempotencyKey'> = {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: 'generation-a',
    producerKind: 'test',
    sourceSequence: 1,
    sourceKey,
    ...(producer.stableOriginId ? { stableOriginId: producer.stableOriginId } : {}),
    entityKind: 'execution',
    entityKey: sourceKey,
    observationKind: 'end',
    observedAtMs: 1_780_000_000_000,
    scope: {
      workspaceCoverage: 'known',
      workspaceId: 'workspace-a',
      ...(subject.kind === 'session' ? { rootSessionId: subject.rootSessionId } : {}),
    },
    captureSubject: subject,
    producer: { buildId: 'test-build', processGeneration: producer.processGeneration ?? 'test-process' },
    fields: { outcome: 'original' },
  };
  return { ...base, idempotencyKey: deriveAnalyticsIdempotencyKey(base) };
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

test('one, two, and four cold supervisors open one new SQLite database within one startup window', { timeout: 45_000 }, async () => {
  for (const hostCount of [1, 2, 4]) {
    const root = mkdtempSync(path.join(tmpdir(), `pie-recorder-cold-${hostCount}-`));
    const databasePath = path.join(root, 'analytics.sqlite');
    const supervisors = Array.from({ length: hostCount }, () => new AnalyticsRecorderSupervisor({
      enabled: true,
      workerScript: sqliteWorkerScript,
      databasePath,
      startupTimeoutMs: 10_000,
      shutdownTimeoutMs: 10_000,
      maxAutomaticRestarts: 0,
    }));
    let primaryFailure: unknown;
    try {
      const startedAt = Date.now();
      await Promise.all(supervisors.map((supervisor) => supervisor.start()));
      assert.ok(Date.now() - startedAt < 10_000, `${hostCount} cold workers exceeded one startup window`);
      assert.equal(supervisors.every((supervisor) => supervisor.running), true);
      const workerPids = supervisors.map((supervisor) => supervisor.workerPid!);
      supervisors.forEach((supervisor, index) => {
        const capture = observation(
          `cold-host-${hostCount}-${index}`,
          { kind: 'session', rootSessionId: `cold-root-${hostCount}` },
          {
            stableOriginId: `cold-host-origin-${hostCount}-${index}`,
            processGeneration: `cold-process-${hostCount}-${index}`,
          },
        );
        supervisor.submit(capture);
      });
      await Promise.all(supervisors.map((supervisor) => supervisor.flush()));
      await Promise.all(supervisors.map((supervisor) => supervisor.shutdown()));
      assert.equal(supervisors.every((supervisor) => supervisor.workerPid === undefined), true);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      assert.equal(supervisors.every((supervisor) => supervisor.workerPid === undefined), true);
      for (const workerPid of workerPids) {
        assert.throws(() => process.kill(workerPid, 0), `worker ${workerPid} remained alive after shutdown`);
      }
      const reader = new SqliteAnalyticsRecorder(databasePath, { readOnly: true });
      try {
        assert.equal(reader.countTypedEntityObservations('execution', `cold-root-${hostCount}`), hostCount);
      } finally {
        reader.close();
      }
    } catch (error) {
      primaryFailure = error;
    }
    let cleanupFailure: unknown;
    try {
      for (const supervisor of supervisors) {
        if (supervisor.workerPid) process.kill(supervisor.workerPid, 'SIGKILL');
      }
      await rmAsync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    } catch (error) {
      cleanupFailure = error;
    }
    if (primaryFailure !== undefined) throw primaryFailure;
    if (cleanupFailure !== undefined) throw cleanupFailure;
  }
});

test('shutdown cancels a not-ready start, waits for child exit, and permits no later replacement', { timeout: 5_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-recorder-slow-start-'));
  const databasePath = path.join(root, 'slow-start.sqlite');
  const lifecycleLog = `${databasePath}.lifecycle.jsonl`;
  const supervisor = new AnalyticsRecorderSupervisor({
    enabled: true,
    workerScript: lifecycleWorkerScript,
    databasePath,
    startupTimeoutMs: 2_000,
    shutdownTimeoutMs: 2_000,
  });
  try {
    const start = supervisor.start();
    await eventually(() => readLog(lifecycleLog).length === 1, 'slow worker did not start');
    const startedPid = Number(readLog(lifecycleLog)[0]?.pid);
    await supervisor.shutdown();
    await assert.rejects(start, /exited during startup/u);
    await new Promise<void>((resolve) => setTimeout(resolve, 600));
    assert.equal(readLog(lifecycleLog).length, 1, 'shutdown must not permit a replacement worker');
    assert.equal(supervisor.workerPid, undefined);
    assert.throws(() => process.kill(startedPid, 0), 'shutdown returns only after the starting child exits');
  } finally {
    if (supervisor.workerPid) process.kill(supervisor.workerPid, 'SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});

test('shutdown fences scheduled recovery, retains ambiguous capture, and reports the failure', { timeout: 5_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-recorder-recovery-fence-'));
  const databasePath = path.join(root, 'crash-recovery.sqlite');
  const lifecycleLog = `${databasePath}.lifecycle.jsonl`;
  const supervisor = new AnalyticsRecorderSupervisor({
    enabled: true,
    workerScript: lifecycleWorkerScript,
    databasePath,
    startupTimeoutMs: 2_000,
    shutdownTimeoutMs: 2_000,
    maxAutomaticRestarts: 1,
  });
  try {
    await supervisor.start();
    supervisor.submit(observation('retained-after-crash', { kind: 'session', rootSessionId: 'recovery-root' }));
    await eventually(
      () => supervisor.terminalError !== undefined && supervisor.workerPid === undefined,
      'worker failure was not observed before recovery fencing',
    );
    await assert.rejects(supervisor.shutdown(), /exited/u);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal(readLog(lifecycleLog).filter((entry) => entry.type === 'started').length, 1);
    assert.equal(supervisor.workerPid, undefined);
    assert.equal(supervisor.backlog.queuedRecords, 1, 'ambiguous accepted capture remains owned and visible');
  } finally {
    if (supervisor.workerPid) process.kill(supervisor.workerPid, 'SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});

test('shutdown rejects a queued control when it cancels recovery with no capture backlog', { timeout: 5_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-recorder-control-fence-'));
  const databasePath = path.join(root, 'control-crash.sqlite');
  const lifecycleLog = `${databasePath}.lifecycle.jsonl`;
  const supervisor = new AnalyticsRecorderSupervisor({
    enabled: true,
    workerScript: lifecycleWorkerScript,
    databasePath,
    startupTimeoutMs: 2_000,
    shutdownTimeoutMs: 2_000,
    maxAutomaticRestarts: 1,
  });
  try {
    await supervisor.start();
    const flush = supervisor.flush().then(
      () => ({ resolved: true as const, error: undefined }),
      (error: unknown) => ({ resolved: false as const, error }),
    );
    await eventually(
      () => supervisor.terminalError !== undefined && supervisor.workerPid === undefined,
      'control failure was not observed before recovery fencing',
    );
    await supervisor.shutdown();
    const result = await flush;
    assert.equal(result.resolved, false);
    assert.match(result.error instanceof Error ? result.error.message : String(result.error), /exited/u);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal(readLog(lifecycleLog).filter((entry) => entry.type === 'started').length, 1);
    assert.equal(supervisor.workerPid, undefined);
  } finally {
    if (supervisor.workerPid) process.kill(supervisor.workerPid, 'SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});

test('non-lock startup failures remain immediate and visible', { timeout: 5_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-recorder-corrupt-start-'));
  const databasePath = path.join(root, 'corrupt.sqlite');
  writeFileSync(databasePath, Buffer.from('not a sqlite database'));
  const supervisor = new AnalyticsRecorderSupervisor({
    enabled: true,
    workerScript: sqliteWorkerScript,
    databasePath,
    startupTimeoutMs: 10_000,
    maxAutomaticRestarts: 0,
  });
  try {
    const startedAt = Date.now();
    await assert.rejects(supervisor.start(), /file is not a database|malformed/u);
    assert.ok(Date.now() - startedAt < 4_000, 'non-lock corruption must not consume the 8 second retry window');
    await supervisor.shutdown();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.equal(supervisor.workerPid, undefined);
  } finally {
    if (supervisor.workerPid) process.kill(supervisor.workerPid, 'SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unconfirmed terminal exit keeps the stop fence latched until explicit cleanup', { timeout: 5_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-recorder-shutdown-timeout-'));
  const databasePath = path.join(root, 'shutdown-slow-exit.sqlite');
  const lifecycleLog = `${databasePath}.lifecycle.jsonl`;
  const supervisor = new AnalyticsRecorderSupervisor({
    enabled: true,
    workerScript: lifecycleWorkerScript,
    databasePath,
    shutdownTimeoutMs: 25,
  });
  try {
    await supervisor.start();
    await assert.rejects(supervisor.shutdown(), /shutdown timed out/u);
    await assert.rejects(supervisor.start(), /shutting down/u);
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    assert.equal(readLog(lifecycleLog).filter((entry) => entry.type === 'started').length, 1);
    assert.equal(supervisor.workerPid, undefined);
    await supervisor.shutdown();
  } finally {
    if (supervisor.workerPid) process.kill(supervisor.workerPid, 'SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});
