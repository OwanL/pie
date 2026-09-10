import type { AnalyticsDetailCapture, AnalyticsObservation } from '../../../shared/analytics/contracts.js';
import { SqliteAnalyticsRecorder } from './sqlite-recorder.js';

interface WorkerCommand {
  type: 'record' | 'detail' | 'flush' | 'deleteSession' | 'stats' | 'shutdown';
  requestId: number;
  observations?: AnalyticsObservation[];
  captures?: AnalyticsDetailCapture[];
  rootSessionId?: string;
  sourceKey?: string;
  timestampMs?: number | string | bigint;
}

function send(message: unknown): void {
  if (process.send) process.send(message);
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

const databasePath = process.env.PIE_ANALYTICS_DATABASE_PATH;
if (!databasePath) {
  send({ type: 'fatal', error: 'PIE_ANALYTICS_DATABASE_PATH is required.' });
  process.exitCode = 1;
} else {
  const recorder = new SqliteAnalyticsRecorder(databasePath);
  const configuredDelay = Number(process.env.PIE_ANALYTICS_REHEARSAL_ACK_DELAY_MS ?? 0);
  const acknowledgementDelayMs = Number.isFinite(configuredDelay) && configuredDelay > 0
    ? Math.min(60_000, Math.floor(configuredDelay))
    : 0;
  send({ type: 'ready', pid: process.pid });

  let chain = Promise.resolve();
  process.on('message', (raw: WorkerCommand) => {
    chain = chain.then(async () => {
      switch (raw.type) {
        case 'record':
          recorder.submitBatch(raw.observations ?? []);
          await delay(acknowledgementDelayMs);
          send({ type: 'ack', requestId: raw.requestId });
          return;
        case 'detail':
          for (const capture of raw.captures ?? []) recorder.submitDetail(capture);
          await delay(acknowledgementDelayMs);
          send({ type: 'ack', requestId: raw.requestId });
          return;
        case 'flush':
          recorder.checkpoint();
          send({ type: 'ack', requestId: raw.requestId });
          return;
        case 'deleteSession': {
          const receipt = recorder.deleteSession(raw.rootSessionId!, raw.sourceKey!, raw.timestampMs!);
          send({ type: 'ack', requestId: raw.requestId, receipt });
          return;
        }
        case 'stats':
          send({
            type: 'ack',
            requestId: raw.requestId,
            receipt: {
              process: process.memoryUsage(),
              recorder: recorder.getStats(),
              detailStorage: recorder.detailStorageStats(),
            },
          });
          return;
        case 'shutdown':
          recorder.checkpoint();
          recorder.close();
          send({ type: 'ack', requestId: raw.requestId });
          process.disconnect();
          return;
      }
    }).catch((error) => {
      send({
        type: 'error',
        requestId: raw.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  process.once('disconnect', () => {
    void chain.finally(() => recorder.close());
  });
}
