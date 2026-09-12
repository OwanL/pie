import { deserialize } from 'node:v8';

import {
  AnalyticsSourceConflictError,
  type AnalyticsDetailCapture,
  type AnalyticsObservation,
} from '../../../shared/analytics/contracts.js';
import { AnalyticsPrivacyScrubPendingError, SqliteAnalyticsRecorder } from './sqlite-recorder.js';
import {
  createSqliteLockRetryBudget,
  isSqliteLockContention,
  retrySqliteLock,
  type SqliteLockRetryBudget,
} from './sqlite-lock-retry.js';

type RecorderWorkerRequest = {
  type: 'captureBatch';
  requestId: number;
  items: Uint8Array[];
} | {
  type: 'prepareProviderDailyProjection';
  requestId: number;
  timeZone: string;
  windowStartMs: number | string | bigint;
  windowEndMs: number | string | bigint;
  allowTimeZoneChange?: boolean;
} | {
  type: 'bindPendingCreate';
  requestId: number;
  pendingOperationId: string;
  rootSessionId: string;
  sourceKey: string;
  timestampMs: number | string | bigint;
} | {
  type: 'deleteSession';
  requestId: number;
  rootSessionId: string;
  sourceKey: string;
  timestampMs: number | string | bigint;
  pendingOperationId?: string;
} | {
  type: 'flush' | 'stats' | 'shutdown';
  requestId: number;
};

interface SerializedCaptureEnvelope {
  kind: 'observation' | 'detail';
  subject: string;
  value: AnalyticsObservation | AnalyticsDetailCapture;
}

interface PendingCreateRecorder {
  bindPendingCreate(
    pendingOperationId: string,
    rootSessionId: string,
    sourceKey: string,
    timestampMs: number | string | bigint,
  ): unknown;
}

const configuredDatabasePath = process.env.PIE_ANALYTICS_DATABASE_PATH;
if (!configuredDatabasePath) throw new Error('PIE_ANALYTICS_DATABASE_PATH is required.');
const databasePath: string = configuredDatabasePath;
const workerInstanceId = process.env.PIE_ANALYTICS_WORKER_INSTANCE_ID;
const workerSpawnedAtMs = Number(process.env.PIE_ANALYTICS_WORKER_SPAWNED_AT_MS);
if (!workerInstanceId || !Number.isSafeInteger(workerSpawnedAtMs) || workerSpawnedAtMs <= 0) {
  throw new Error('Analytics recorder worker identity is required.');
}
const workerIdentity = Object.freeze({ pid: process.pid, spawnedAtMs: workerSpawnedAtMs, instanceId: workerInstanceId });
const acknowledgementDelayMs = Math.max(0, Number(process.env.PIE_ANALYTICS_REHEARSAL_ACK_DELAY_MS ?? 0) || 0);
const STARTUP_LOCK_RETRY_MS = 8_000;
const STARTUP_LOCK_RETRY_MAX_DELAY_MS = 200;

let recorder: SqliteAnalyticsRecorder;
let startupPrivacyRecovery: ReturnType<SqliteAnalyticsRecorder['resumePendingPrivacyScrubs']>;

function send(message: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) {
      reject(new Error('Analytics recorder IPC channel is unavailable.'));
      return;
    }
    process.send(message, (error) => error ? reject(error) : resolve());
  });
}

async function acknowledge(requestId: number, receipt?: unknown): Promise<void> {
  if (acknowledgementDelayMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, acknowledgementDelayMs));
  }
  await send({ type: 'ack', requestId, receipt });
}

function deletedSubjectError(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith('Analytics capture subject is deleted:') ? message : undefined;
}

/** `node:sqlite` exposes BUSY/LOCKED through either SQLite errcodes or a
 * generic ERR_SQLITE_ERROR plus text. Retry only those transient ownership
 * races; schema, corruption, path, and configuration failures stay fatal. */
async function initializeRecorder(): Promise<{
  recorder: SqliteAnalyticsRecorder;
  startupPrivacyRecovery: ReturnType<SqliteAnalyticsRecorder['resumePendingPrivacyScrubs']>;
}> {
  const deadline = Date.now() + STARTUP_LOCK_RETRY_MS;
  let delayMs = 10;
  while (true) {
    try {
      const opened = new SqliteAnalyticsRecorder(databasePath);
      try {
        return { recorder: opened, startupPrivacyRecovery: opened.resumePendingPrivacyScrubs(16) };
      } catch (error) {
        opened.close();
        throw error;
      }
    } catch (error) {
      if (!isSqliteLockContention(error) || Date.now() >= deadline) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(STARTUP_LOCK_RETRY_MAX_DELAY_MS, delayMs * 2);
    }
  }
}

function decodeCaptures(items: readonly Uint8Array[]): SerializedCaptureEnvelope[] {
  return items.map((item) => {
    if (!(item instanceof Uint8Array)) throw new Error('Invalid serialized analytics capture.');
    // `deserialize` accepts the Uint8Array view directly; no copy is needed.
    const envelope = deserialize(item) as SerializedCaptureEnvelope;
    if (!envelope || (envelope.kind !== 'observation' && envelope.kind !== 'detail')) {
      throw new Error('Invalid analytics capture envelope.');
    }
    return envelope;
  });
}

async function handle(raw: unknown): Promise<void> {
  const request = raw as RecorderWorkerRequest;
  if (!request || typeof request.requestId !== 'number' || typeof request.type !== 'string') return;
  try {
    switch (request.type) {
      case 'captureBatch': {
        const captures = decodeCaptures(request.items);
        const firstKind = captures[0]?.kind;
        if (captures.some((capture) => capture.kind !== firstKind)) {
          throw new Error('Mixed analytics capture batch is not supported.');
        }
        const lockRetryBudget: SqliteLockRetryBudget = createSqliteLockRetryBudget();
        const rejections: Array<{ index: number; code: 'subject_deleted' | 'source_conflict'; error: string }> = [];
        if (firstKind === 'observation') {
          // Preserve global queue order while retaining batch transactions for
          // contiguous captures owned by the same subject. A deletion fence can
          // reject that subject without discarding unrelated records in the IPC
          // batch.
          for (let start = 0; start < captures.length;) {
            let end = start + 1;
            while (end < captures.length && captures[end]!.subject === captures[start]!.subject) end += 1;
            try {
              await retrySqliteLock(() => recorder.submitBatch(
                captures.slice(start, end).map((capture) => capture.value as AnalyticsObservation),
              ), lockRetryBudget);
            } catch (error) {
              const deleted = deletedSubjectError(error);
              if (deleted) {
                for (let index = start; index < end; index += 1) {
                  rejections.push({ index, code: 'subject_deleted', error: deleted });
                }
              } else if (error instanceof AnalyticsSourceConflictError) {
                // The batch transaction retained every original row. Replay the
                // bounded slice record-by-record so only changed identities are
                // rejected and unrelated immutable facts still advance.
                for (let index = start; index < end; index += 1) {
                  try {
                    await retrySqliteLock(
                      () => recorder.submit(captures[index]!.value as AnalyticsObservation),
                      lockRetryBudget,
                    );
                  } catch (recordError) {
                    const recordDeleted = deletedSubjectError(recordError);
                    if (recordDeleted) rejections.push({ index, code: 'subject_deleted', error: recordDeleted });
                    else if (recordError instanceof AnalyticsSourceConflictError) {
                      rejections.push({ index, code: 'source_conflict', error: recordError.message });
                    } else throw recordError;
                  }
                }
              } else {
                throw error;
              }
            }
            start = end;
          }
        } else if (firstKind === 'detail') {
          for (let index = 0; index < captures.length; index += 1) {
            const detail = captures[index]!.value as AnalyticsDetailCapture;
            try {
              // The exclusion is enforced once, at the last off-producer
              // boundary before any manifest, digest, SQLite page, or WAL record
              // can see content. Recording enforces it inside the same
              // transaction that writes those records, so a producer or
              // transport that skipped redaction still cannot persist private
              // bytes. The earlier worker-side deserialize/re-sanitize/
              // re-serialize hop was a proven byte-level fixed point (redaction
              // is idempotent and both producer and worker sanitize the same
              // value) and only added native v8 allocation per payload.
              await retrySqliteLock(() => recorder.submitDetail(detail), lockRetryBudget);
            } catch (error) {
              const deleted = deletedSubjectError(error);
              if (deleted) rejections.push({ index, code: 'subject_deleted', error: deleted });
              else if (error instanceof AnalyticsSourceConflictError) {
                rejections.push({ index, code: 'source_conflict', error: error.message });
              } else throw error;
            }
          }
        }
        // Only the watermark is needed here, and it is an already-maintained
        // counter. Reading the full delivery accounting here also computed two
        // unbounded whole-table detail aggregates and discarded them, once per
        // ingested batch, which is quadratic in the tier.
        const completeDetailWatermark = await retrySqliteLock(
          () => recorder.readCompleteDetailWatermark(),
          lockRetryBudget,
        );
        await acknowledge(request.requestId, {
          rejections,
          producerReconciliation: firstKind === 'observation'
            ? await retrySqliteLock(() => recorder.readProducerAcknowledgements(
                captures.map((capture) => capture.value as AnalyticsObservation),
              ), lockRetryBudget)
            : [],
          completeDetailWatermark,
        });
        return;
      }
      case 'bindPendingCreate': {
        const bind = (recorder as SqliteAnalyticsRecorder & Partial<PendingCreateRecorder>).bindPendingCreate;
        if (typeof bind !== 'function') throw new Error('Recorder does not support pending-create binding.');
        const receipt = bind.call(
          recorder,
          request.pendingOperationId,
          request.rootSessionId,
          request.sourceKey,
          request.timestampMs,
        );
        await acknowledge(request.requestId, receipt);
        return;
      }
      case 'prepareProviderDailyProjection': {
        recorder.prepareProviderDailyProjection(
          request.timeZone,
          request.windowStartMs,
          request.windowEndMs,
          request.allowTimeZoneChange === true,
        );
        await acknowledge(request.requestId);
        return;
      }
      case 'deleteSession': {
        const receipt = recorder.deleteSession(
          request.rootSessionId,
          request.sourceKey,
          request.timestampMs,
          request.pendingOperationId,
        );
        await acknowledge(request.requestId, receipt);
        return;
      }
      case 'flush':
        recorder.checkpoint();
        await acknowledge(request.requestId);
        return;
      case 'stats':
        await acknowledge(request.requestId, {
          process: {
            ...process.memoryUsage(),
            cpuUsage: process.cpuUsage(),
            workerIdentity,
          },
          recorder: recorder.getStats(),
          detailStorage: recorder.detailStorageStats(),
          delivery: recorder.readDeliveryAccounting(),
          startupPrivacyRecovery,
        });
        return;
      case 'shutdown':
        recorder.checkpoint();
        recorder.close();
        await acknowledge(request.requestId);
        process.disconnect();
        return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Preserve machine-readable error identity across the IPC boundary. The
    // supervisor converts any worker failure into a generic request error, so
    // without a code a caller cannot distinguish a retryable condition (a
    // privacy scrub whose fence is committed and pending) from a hard failure.
    let errorCode: string | undefined;
    if (message.startsWith('Analytics capture subject is deleted:')) errorCode = 'subject_deleted';
    else if (error instanceof AnalyticsPrivacyScrubPendingError) errorCode = 'privacy_scrub_pending';
    else if (error instanceof AnalyticsSourceConflictError) errorCode = 'source_conflict';
    else if (isSqliteLockContention(error)) errorCode = 'database_locked';
    await send({
      type: 'error',
      requestId: request.requestId,
      error: message,
      ...(errorCode === undefined ? {} : { errorCode }),
    }).catch(() => undefined);
  }
}

void initializeRecorder().then((initialized) => {
  recorder = initialized.recorder;
  startupPrivacyRecovery = initialized.startupPrivacyRecovery;
  return send({ type: 'ready', startupPrivacyRecovery, workerIdentity }).then(() => {
    let processing = Promise.resolve();
    process.on('message', (message: unknown) => {
      processing = processing.then(() => handle(message));
    });
  });
}).catch((error) => {
  return send({ type: 'fatal', error: error instanceof Error ? error.message : String(error) })
    .finally(() => process.exitCode = 1);
});
