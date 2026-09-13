import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rm as rmAsync } from 'node:fs/promises';
import { createRequire } from 'node:module';
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
  AnalyticsRecorderWorkerRequestError,
  AnalyticsRecorderSupervisor,
  type AnalyticsRecorderCaptureDisposition,
  type AnalyticsWorkerLifecycleEvent,
} from '../../src/analytics/recorder-supervisor.js';
import { SqliteAnalyticsRecorder } from '../../src/analytics/sqlite-recorder.js';
import { SQLITE_NATIVE_BUSY_TIMEOUT_MS } from '../../src/analytics/sqlite-lock-retry.js';

const workerScript = fileURLToPath(new URL('./fixtures/recorder-supervisor-worker.cjs', import.meta.url));
const lifecycleWorkerScript = fileURLToPath(new URL('./fixtures/recorder-supervisor-lifecycle-worker.cjs', import.meta.url));
const sqliteWorkerScript = fileURLToPath(new URL('./fixtures/production-recorder-worker.mjs', import.meta.url));
const sqliteWorkerExecArgv = [`--import=${new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url).href}`];
const { DatabaseSync } = createRequire(process.execPath)('node:sqlite') as {
  DatabaseSync: new (location: string, options?: { timeout?: number }) => {
    exec(sql: string): void;
    close(): void;
  };
};

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

test('supervisor holds durable admission until capture and lifecycle writes settle', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-recorder-admission-'));
  let activeLeases = 0;
  let acquiredLeases = 0;
  let acquiredStartupLeases = 0;
  const supervisor = new AnalyticsRecorderSupervisor({
    enabled: true,
    workerScript,
    databasePath: path.join(root, 'capture.log'),
    writerAdmission: {
      acquire: () => {
        activeLeases += 1;
        acquiredLeases += 1;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          activeLeases -= 1;
        };
      },
      acquireStartup: () => {
        activeLeases += 1;
        acquiredStartupLeases += 1;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          activeLeases -= 1;
        };
      },
    },
  });
  try {
    await supervisor.start();
    const bind = supervisor.bindPendingCreate('pending-a', 'root-a', 'bind-a', 1_780_000_000_002);
    assert.equal(activeLeases, 1);
    await bind;
    assert.equal(activeLeases, 0);

    supervisor.submit(observation('admitted-observation'));
    assert.equal(activeLeases, 1);
    const fence = supervisor.fence();
    assert.throws(() => supervisor.submit(observation('rejected-after-fence')), /not accepting/);
    await fence;
    assert.equal(activeLeases, 0);
    assert.equal(acquiredLeases, 2);
    assert.equal(acquiredStartupLeases, 1);
    await supervisor.shutdown();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('supervisor reports immutable worker instance identity through authoritative terminal exit', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-recorder-worker-lifecycle-'));
  const events: AnalyticsWorkerLifecycleEvent[] = [];
  const supervisor = new AnalyticsRecorderSupervisor({
    enabled: true,
    workerScript,
    databasePath: path.join(root, 'capture.log'),
    onWorkerLifecycle: (event) => events.push(structuredClone(event)),
  });
  try {
    await supervisor.start();
    await supervisor.shutdown();
    assert.deepEqual(events.map((event) => event.state), ['spawned', 'ready', 'terminal']);
    assert.deepEqual(events[0]?.identity, events[1]?.identity);
    assert.deepEqual(events[1]?.identity, events[2]?.identity);
    assert.ok((events[0]?.identity.pid ?? 0) > 0);
    assert.ok((events[0]?.identity.spawnedAtMs ?? 0) > 0);
    assert.match(events[0]?.identity.instanceId ?? '', /^[0-9a-f-]{36}$/iu);
  } finally {
    if (supervisor.workerPid) process.kill(supervisor.workerPid, 'SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});

test('tracked capture settles each durable replay or deletion rejection from the real SQLite worker', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-recorder-tracked-disposition-'));
  const databasePath = path.join(root, 'analytics.sqlite');
  const supervisor = new AnalyticsRecorderSupervisor({
    enabled: true,
    workerScript: sqliteWorkerScript,
    databasePath,
    execArgv: sqliteWorkerExecArgv,
  });
  const dispositions: AnalyticsRecorderCaptureDisposition[] = [];
  const sessionSubject = { kind: 'session' as const, rootSessionId: 'tracked-root' };
  const captured = observation('tracked-source', sessionSubject, { stableOriginId: 'tracked-origin' });
  try {
    await supervisor.start();
    supervisor.submitTracked(captured, (disposition) => dispositions.push(disposition));
    await supervisor.flush();
    supervisor.submitTracked(structuredClone(captured), (disposition) => dispositions.push(disposition));
    await supervisor.flush();
    const beforeDelete = new SqliteAnalyticsRecorder(databasePath, { readOnly: true });
    try {
      assert.equal(beforeDelete.countObservations('tracked-root'), 1, 'exact replay must receive a second durable disposition without duplicating storage');
    } finally {
      beforeDelete.close();
    }
    await supervisor.deleteSession('tracked-root', 'tracked-delete', 1_780_000_000_100);
    supervisor.submitTracked(
      observation('tracked-late', sessionSubject, { stableOriginId: 'tracked-origin' }),
      (disposition) => dispositions.push(disposition),
    );
    await supervisor.flush();
    assert.deepEqual(dispositions.map((entry) => entry.status), ['durable', 'durable', 'rejected']);
    assert.ok(dispositions[0]?.status === 'durable' && dispositions[0].producerReconciliation.length > 0);
    assert.ok(dispositions[1]?.status === 'durable' && dispositions[1].producerReconciliation.length > 0);
    assert.deepEqual(dispositions[2], {
      status: 'rejected',
      code: 'subject_deleted',
      message: 'Analytics capture subject is deleted: tracked-root',
    });
    await supervisor.shutdown();
    const reader = new SqliteAnalyticsRecorder(databasePath, { readOnly: true });
    try {
      assert.equal(reader.countObservations('tracked-root'), 0);
    } finally {
      reader.close();
    }
  } finally {
    if (supervisor.workerPid) process.kill(supervisor.workerPid, 'SIGKILL');
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

test('worker request failure retains bounded request and worker identity context', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-recorder-request-error-'));
  const logPath = path.join(root, 'capture.log');
  const lifecycle: AnalyticsWorkerLifecycleEvent[] = [];
  const supervisor = new AnalyticsRecorderSupervisor({
    enabled: true,
    workerScript,
    databasePath: logPath,
    maxAutomaticRestarts: 0,
    onWorkerLifecycle: (event) => lifecycle.push(event),
  });
  try {
    await supervisor.start();
    supervisor.submit(observation('request-error'));
    await eventually(() => supervisor.lastDeliveryError instanceof AnalyticsRecorderWorkerRequestError, 'worker request failure was not retained');
    const failure = supervisor.lastDeliveryError;
    assert.ok(failure instanceof AnalyticsRecorderWorkerRequestError);
    assert.equal(failure.message, 'database is locked');
    assert.equal(failure.code, 'SQLITE_BUSY');
    assert.equal(failure.requestId, 1);
    assert.equal(failure.requestType, 'captureBatch');
    const spawned = lifecycle.find((event) => event.state === 'spawned');
    assert.ok(spawned?.state === 'spawned');
    assert.deepEqual(failure.workerIdentity, spawned.identity);
    assert.equal(supervisor.backlog.queuedRecords, 1, 'failed capture remains owned for diagnosis/recovery');
  } finally {
    await supervisor.shutdown().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('worker request failure bounds child diagnostic text without losing its request identity', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-recorder-request-error-long-'));
  const supervisor = new AnalyticsRecorderSupervisor({
    enabled: true,
    workerScript,
    databasePath: path.join(root, 'capture.log'),
    maxAutomaticRestarts: 0,
  });
  try {
    await supervisor.start();
    supervisor.submit(observation('request-error-long'));
    await eventually(() => supervisor.lastDeliveryError instanceof AnalyticsRecorderWorkerRequestError, 'long worker request failure was not retained');
    const failure = supervisor.lastDeliveryError;
    assert.ok(failure instanceof AnalyticsRecorderWorkerRequestError);
    assert.ok(failure.message.length <= 2_051, 'child diagnostic text must stay bounded');
    assert.match(failure.message, /^database is locked/u);
    assert.equal(failure.requestId, 1);
    assert.equal(failure.requestType, 'captureBatch');
  } finally {
    await supervisor.shutdown().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('malformed worker error payload is normalized while preserving bounded request context', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-recorder-request-error-malformed-'));
  const supervisor = new AnalyticsRecorderSupervisor({
    enabled: true,
    workerScript,
    databasePath: path.join(root, 'capture.log'),
    maxAutomaticRestarts: 0,
  });
  try {
    await supervisor.start();
    supervisor.submit(observation('request-error-malformed'));
    await eventually(() => supervisor.lastDeliveryError instanceof AnalyticsRecorderWorkerRequestError, 'malformed worker request failure was not retained');
    const failure = supervisor.lastDeliveryError;
    assert.ok(failure instanceof AnalyticsRecorderWorkerRequestError);
    assert.equal(failure.message, 'Analytics recorder returned a malformed error message.');
    assert.equal(failure.code, undefined);
    assert.equal(failure.requestId, 1);
    assert.equal(failure.requestType, 'captureBatch');
  } finally {
    await supervisor.shutdown().catch(() => {});
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
      execArgv: sqliteWorkerExecArgv,
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

test('worker retries a capture transaction after the native busy window without dropping it', { timeout: 20_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-recorder-capture-lock-retry-'));
  const databasePath = path.join(root, 'analytics.sqlite');
  const supervisor = new AnalyticsRecorderSupervisor({
    enabled: true,
    workerScript: sqliteWorkerScript,
    databasePath,
    startupTimeoutMs: 10_000,
    shutdownTimeoutMs: 10_000,
    execArgv: sqliteWorkerExecArgv,
    maxAutomaticRestarts: 0,
  });
  const blocker = new DatabaseSync(databasePath, { timeout: 100 });
  let blockerClosed = false;
  let releaseTimer: NodeJS.Timeout | undefined;
  try {
    await supervisor.start();
    // Hold the write reservation beyond the recorder's existing 5 s native
    // busy timeout. The worker must therefore receive SQLITE_BUSY once, yield,
    // and retry the same idempotent transaction after this explicit release.
    blocker.exec('BEGIN IMMEDIATE');
    releaseTimer = setTimeout(() => {
      try { blocker.exec('ROLLBACK'); } finally {
        blocker.close();
        blockerClosed = true;
      }
    }, SQLITE_NATIVE_BUSY_TIMEOUT_MS + 1_200);
    supervisor.submit(observation(
      'lock-retry-source',
      { kind: 'session', rootSessionId: 'lock-retry-root' },
      { stableOriginId: 'lock-retry-origin', processGeneration: 'lock-retry-process' },
    ));
    await supervisor.flush();
    assert.equal(supervisor.backlog.deliveryFailures, 0, 'transient contention must not become a delivery failure');
    assert.equal(supervisor.backlog.queuedRecords, 0, 'the retried capture must leave no retained ownership');
    const workerStats = await supervisor.workerStats();
    assert.equal(workerStats?.recorder.accepted, 1, 'the retried transaction must be accepted exactly once');
    assert.equal(workerStats?.recorder.duplicates, 0, 'a lock retry must not replay a committed capture');
    const delivery = workerStats?.delivery as {
      observations?: { accepted?: number | string; replayed?: number | string };
    } | undefined;
    assert.equal(String(delivery?.observations?.accepted), '1');
    assert.equal(String(delivery?.observations?.replayed), '0');
    const reader = new SqliteAnalyticsRecorder(databasePath, { readOnly: true });
    try {
      assert.equal(reader.countTypedEntityObservations('execution', 'lock-retry-root'), 1);
    } finally {
      reader.close();
    }
    await supervisor.shutdown();
  } finally {
    if (releaseTimer) clearTimeout(releaseTimer);
    if (!blockerClosed) {
      try { blocker.exec('ROLLBACK'); } catch { /* preserve the primary failure */ }
      blocker.close();
    }
    await supervisor.shutdown().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('worker exhausts the shared lock window and retains the failed batch for recovery', { timeout: 20_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-recorder-capture-lock-exhausted-'));
  const databasePath = path.join(root, 'analytics.sqlite');
  const supervisor = new AnalyticsRecorderSupervisor({
    enabled: true,
    workerScript: sqliteWorkerScript,
    databasePath,
    startupTimeoutMs: 10_000,
    shutdownTimeoutMs: 10_000,
    execArgv: sqliteWorkerExecArgv,
    maxAutomaticRestarts: 0,
  });
  const blocker = new DatabaseSync(databasePath, { timeout: 100 });
  try {
    await supervisor.start();
    blocker.exec('BEGIN IMMEDIATE');
    supervisor.submit(observation(
      'lock-exhausted-source',
      { kind: 'session', rootSessionId: 'lock-exhausted-root' },
      { stableOriginId: 'lock-exhausted-origin', processGeneration: 'lock-exhausted-process' },
    ));
    await eventually(
      () => supervisor.lastDeliveryError instanceof AnalyticsRecorderWorkerRequestError,
      'the exhausted worker lock window was not reported',
      12_000,
    );
    const failure = supervisor.lastDeliveryError;
    assert.ok(failure instanceof AnalyticsRecorderWorkerRequestError);
    assert.equal(failure.code, 'database_locked');
    assert.equal(failure.requestType, 'captureBatch');
    assert.equal(supervisor.backlog.queuedRecords, 1, 'an exhausted lock retains the immutable capture');
    assert.equal(supervisor.backlog.deliveryFailures, 1);
  } finally {
    try { blocker.exec('ROLLBACK'); } catch { /* preserve the primary failure */ }
    blocker.close();
    await supervisor.shutdown().catch(() => {});
    rmSync(root, { recursive: true, force: true });
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
    execArgv: sqliteWorkerExecArgv,
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

const heapWorkerScript = fileURLToPath(new URL('./fixtures/recorder-heap-limit-worker.cjs', import.meta.url));

test('leaves the recorder child execArgv empty unless a heap ceiling is requested', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-recorder-heap-default-'));
  const databasePath = path.join(root, 'heap-default.sqlite');
  const supervisor = new AnalyticsRecorderSupervisor({
    enabled: true,
    workerScript: heapWorkerScript,
    databasePath,
  });
  try {
    await supervisor.start();
    const stats = await supervisor.workerStats() as unknown as {
      heap: { heapSizeLimitMb: number; flag: string | null; execArgv: string[] };
    };
    // The recorder deliberately inherits no parent flags, so no ceiling is
    // applied by default and the limit stays at V8's unbounded ~4288 MiB.
    assert.equal(stats.heap.flag, null, 'no ceiling flag may be added by default');
    assert.deepEqual(stats.heap.execArgv, [], 'the recorder child must keep an empty execArgv');
    assert.ok(
      stats.heap.heapSizeLimitMb > 1_000,
      `an unbounded child keeps the large default, got ${stats.heap.heapSizeLimitMb} MiB`,
    );
  } finally {
    await supervisor.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('applies an explicitly requested recorder heap ceiling and preserves caller execArgv', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-recorder-heap-explicit-'));
  const databasePath = path.join(root, 'heap-explicit.sqlite');
  const supervisor = new AnalyticsRecorderSupervisor({
    enabled: true,
    workerScript: heapWorkerScript,
    databasePath,
    execArgv: ['--no-warnings'],
    maxOldSpaceMb: 96,
  });
  try {
    await supervisor.start();
    const stats = await supervisor.workerStats() as unknown as {
      heap: { heapSizeLimitMb: number; flag: string | null; execArgv: string[] };
    };
    assert.equal(stats.heap.flag, '--max-old-space-size=96');
    assert.ok(
      stats.heap.execArgv.includes('--no-warnings'),
      'a caller-supplied execArgv entry must survive alongside the ceiling',
    );
    assert.ok(
      stats.heap.heapSizeLimitMb < 1_000,
      `expected a bounded ceiling well under the 4288 MiB default, got ${stats.heap.heapSizeLimitMb}`,
    );
  } finally {
    await supervisor.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a recorder heap ceiling below the supported floor', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-recorder-heap-floor-'));
  const supervisor = new AnalyticsRecorderSupervisor({
    enabled: true,
    workerScript: heapWorkerScript,
    databasePath: path.join(root, 'heap-floor.sqlite'),
    maxOldSpaceMb: 16,
  });
  try {
    await assert.rejects(
      supervisor.start(),
      /maxOldSpaceMb must be a safe integer of at least 64/u,
    );
  } finally {
    if (supervisor.workerPid) process.kill(supervisor.workerPid, 'SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});

const slowAckWorkerScript = fileURLToPath(new URL('./fixtures/recorder-slow-ack-worker.cjs', import.meta.url));

test('a control timeout reports why the worker was killed, not a bare SIGTERM', { timeout: 15_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-recorder-control-timeout-'));
  const databasePath = path.join(root, 'control-timeout.sqlite');
  const supervisor = new AnalyticsRecorderSupervisor({
    enabled: true,
    workerScript: slowAckWorkerScript,
    databasePath,
    // The fixture never acknowledges within this window, so the supervisor must
    // escalate exactly as it would in production after 30 seconds.
    controlRequestTimeoutMs: 200,
    rehearsalAcknowledgementDelayMs: 5_000,
  });
  try {
    await supervisor.start();
    const error = await supervisor.workerStats().then(
      () => undefined,
      (reason: unknown) => reason,
    );
    assert.ok(error instanceof Error, 'the control request must reject');
    assert.match(
      error.message,
      /exceeded 200 ms/u,
      'the timeout message must name the bound that was exceeded',
    );
    // Give the exit event a moment to convert the kill into a terminal failure,
    // then read it through the public surface: any later command must report the
    // same reason the worker died for.
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    const terminalError = await supervisor.flush().then(
      () => undefined,
      (reason: unknown) => reason,
    );
    assert.ok(terminalError instanceof Error, 'a dead worker must reject further commands');
    assert.match(
      `${error.message}\n${terminalError.message}`,
      /exceeded 200 ms/u,
      'the deliberate cause must survive into the terminal failure',
    );
    assert.doesNotMatch(
      terminalError.message,
      /^Analytics recorder worker exited \(SIGTERM\)\.$/u,
      'a bare SIGTERM must never be the whole explanation for a deliberate kill',
    );
  } finally {
    await supervisor.shutdown().catch(() => {});
    if (supervisor.workerPid) process.kill(supervisor.workerPid, 'SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});
