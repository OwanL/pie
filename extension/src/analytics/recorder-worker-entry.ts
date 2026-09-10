import { deserialize, serialize } from 'node:v8';

import type {
  AnalyticsDetailCapture,
  AnalyticsObservation,
} from '../../../shared/analytics/contracts.js';
import { sanitizeAnalyticsDetail } from '../../../shared/sensitive-redaction.js';
import { SqliteAnalyticsRecorder } from './sqlite-recorder.js';

type RecorderWorkerRequest = {
  type: 'captureBatch';
  requestId: number;
  items: Uint8Array[];
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

const databasePath = process.env.PIE_ANALYTICS_DATABASE_PATH;
if (!databasePath) throw new Error('PIE_ANALYTICS_DATABASE_PATH is required.');
const acknowledgementDelayMs = Math.max(0, Number(process.env.PIE_ANALYTICS_REHEARSAL_ACK_DELAY_MS ?? 0) || 0);

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

function decodeCaptures(items: readonly Uint8Array[]): SerializedCaptureEnvelope[] {
  return items.map((item) => {
    if (!(item instanceof Uint8Array)) throw new Error('Invalid serialized analytics capture.');
    const envelope = deserialize(Buffer.from(item)) as SerializedCaptureEnvelope;
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
        const rejections: Array<{ index: number; code: 'subject_deleted'; error: string }> = [];
        if (firstKind === 'observation') {
          // Preserve global queue order while retaining batch transactions for
          // contiguous captures owned by the same subject. A deletion fence can
          // reject that subject without discarding unrelated records in the IPC
          // batch.
          for (let start = 0; start < captures.length;) {
            let end = start + 1;
            while (end < captures.length && captures[end]!.subject === captures[start]!.subject) end += 1;
            try {
              recorder.submitBatch(captures.slice(start, end).map((capture) => capture.value as AnalyticsObservation));
            } catch (error) {
              const deleted = deletedSubjectError(error);
              if (!deleted) throw error;
              for (let index = start; index < end; index += 1) {
                rejections.push({ index, code: 'subject_deleted', error: deleted });
              }
            }
            start = end;
          }
        } else if (firstKind === 'detail') {
          for (let index = 0; index < captures.length; index += 1) {
            const detail = captures[index]!.value as AnalyticsDetailCapture;
            try {
              // Re-enforce the exclusion at the last off-producer boundary
              // before any manifest, digest, SQLite page, or WAL record can see
              // content.
              const scrubbed = sanitizeAnalyticsDetail(deserialize(Buffer.from(detail.bytes)));
              recorder.submitDetail({ ...detail, bytes: serialize(scrubbed) });
            } catch (error) {
              const deleted = deletedSubjectError(error);
              if (!deleted) throw error;
              rejections.push({ index, code: 'subject_deleted', error: deleted });
            }
          }
        }
        const delivery = recorder.readDeliveryAccounting();
        await acknowledge(request.requestId, {
          rejections,
          producerReconciliation: firstKind === 'observation'
            ? recorder.readProducerAcknowledgements(
                captures.map((capture) => capture.value as AnalyticsObservation),
              )
            : [],
          completeDetailWatermark: delivery.completeDetailWatermark,
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
          process: { ...process.memoryUsage(), cpuUsage: process.cpuUsage() },
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
    await send({
      type: 'error',
      requestId: request.requestId,
      error: message,
      ...(message.startsWith('Analytics capture subject is deleted:') ? { errorCode: 'subject_deleted' } : {}),
    }).catch(() => undefined);
  }
}

try {
  recorder = new SqliteAnalyticsRecorder(databasePath);
  startupPrivacyRecovery = recorder.resumePendingPrivacyScrubs(16);
  void send({ type: 'ready', startupPrivacyRecovery }).then(() => {
    let processing = Promise.resolve();
    process.on('message', (message: unknown) => {
      processing = processing.then(() => handle(message));
    });
  }).catch(() => process.exitCode = 1);
} catch (error) {
  void send({ type: 'fatal', error: error instanceof Error ? error.message : String(error) })
    .finally(() => process.exitCode = 1);
}
