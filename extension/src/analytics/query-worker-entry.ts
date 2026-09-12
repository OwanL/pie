import { serialize } from 'node:v8';

import type {
  AnalyticsQueryRequest,
  AnalyticsQueryWorkerTelemetry,
  AnalyticsQueryWorkerTelemetrySamplePhase,
} from './query-client.js';
import { SqliteAnalyticsRecorder } from './sqlite-recorder.js';

const databasePath = process.env.PIE_ANALYTICS_DATABASE_PATH;
if (!databasePath) throw new Error('PIE_ANALYTICS_DATABASE_PATH is required.');
const workerInstanceId = process.env.PIE_ANALYTICS_WORKER_INSTANCE_ID;
const workerSpawnedAtMs = Number(process.env.PIE_ANALYTICS_WORKER_SPAWNED_AT_MS);
if (!workerInstanceId || !Number.isSafeInteger(workerSpawnedAtMs) || workerSpawnedAtMs <= 0) {
  throw new Error('Analytics query worker identity is required.');
}
const workerIdentity = Object.freeze({ pid: process.pid, spawnedAtMs: workerSpawnedAtMs, instanceId: workerInstanceId });

let recorder: SqliteAnalyticsRecorder | undefined;
try {
  recorder = new SqliteAnalyticsRecorder(databasePath, { readOnly: true });
} catch (error) {
  process.send?.({
    type: 'fatal',
    error: error instanceof Error ? error.message : String(error),
  }, () => process.disconnect());
}

type QueryMessage = AnalyticsQueryRequest & { requestId: number };

const DEFAULT_ROW_LIMIT = 200;
const MAX_ROW_LIMIT = 10_000;
const DEFAULT_RESULT_BYTES = 256 * 1024;

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Analytics query limit must be a non-negative safe integer.');
  return Math.min(value, maximum);
}

function send(message: unknown): void {
  if (process.connected) process.send?.(message);
}

/** Capture the disposable helper's own high-water memory after the result has
 * been encoded. A forced kill has no opportunity to produce this sample. */
function sampleWorkerTelemetry(
  runtimeSamplePhase: AnalyticsQueryWorkerTelemetrySamplePhase,
): AnalyticsQueryWorkerTelemetry | undefined {
  try {
    const resourceUsage = process.resourceUsage();
    const currentMemory = process.memoryUsage();
    if (!Number.isSafeInteger(resourceUsage.maxRSS) || resourceUsage.maxRSS <= 0
      || resourceUsage.maxRSS > Math.floor(Number.MAX_SAFE_INTEGER / 1024)
      || !Number.isSafeInteger(resourceUsage.userCPUTime) || resourceUsage.userCPUTime < 0
      || !Number.isSafeInteger(resourceUsage.systemCPUTime) || resourceUsage.systemCPUTime < 0
      || !Number.isSafeInteger(currentMemory.rss) || currentMemory.rss <= 0
      || !Number.isSafeInteger(currentMemory.heapTotal) || currentMemory.heapTotal < 0
      || !Number.isSafeInteger(currentMemory.heapUsed) || currentMemory.heapUsed < 0
      || !Number.isSafeInteger(currentMemory.external) || currentMemory.external < 0
      || !Number.isSafeInteger(currentMemory.arrayBuffers) || currentMemory.arrayBuffers < 0) {
      return undefined;
    }
    return {
      workerIdentity,
      maxRssBytes: resourceUsage.maxRSS * 1024,
      userCpuTimeMicros: resourceUsage.userCPUTime,
      systemCpuTimeMicros: resourceUsage.systemCPUTime,
      currentMemory: {
        rssBytes: currentMemory.rss,
        heapTotalBytes: currentMemory.heapTotal,
        heapUsedBytes: currentMemory.heapUsed,
        externalBytes: currentMemory.external,
        arrayBuffersBytes: currentMemory.arrayBuffers,
      },
      runtimeSamplePhase,
    };
  } catch {
    return undefined;
  }
}

process.on('message', (raw: unknown) => {
  if (!recorder) return;
  const message = raw as QueryMessage;
  if (!Number.isSafeInteger(message.requestId)) return;
  try {
    const maximum = boundedInteger(message.maxResultBytes, DEFAULT_RESULT_BYTES, 16 * 1024 * 1024);
    let result: unknown;
    if (message.type === 'schema') {
      result = recorder.describeSchema();
    } else if (message.type === 'query') {
      result = recorder.executeReadOnlyQuery(message.sql, message.parameters, {
        maxRows: message.maxRows,
        maxBytes: Math.min(message.maxQueryBytes ?? Number.MAX_SAFE_INTEGER, Math.max(1, maximum - 32 * 1024)),
        maxCellBytes: message.maxCellBytes,
      });
    } else if (message.type === 'detail') {
      result = recorder.readDetailRange(
        message.payloadId,
        message.offset,
        Math.min(message.maxBytes ?? 64 * 1024, Math.max(1, maximum - 8 * 1024)),
      );
    } else if (message.type === 'storage') {
      result = recorder.readStorageReadModel();
    } else if (message.type === 'providerSettlements') {
      const limit = boundedInteger(message.limit, DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT);
      result = recorder.readProviderSettlements(message.rootSessionId, limit);
    } else if (message.type === 'scopedProviderSettlements') {
      const limit = boundedInteger(message.limit, DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT);
      result = recorder.readScopedProviderSettlements(message.scope, {
        limit,
        offset: message.offset,
        expectedRevision: message.expectedRevision,
      });
    } else if (message.type === 'providerAccounting') {
      result = recorder.readProviderAccountingSummary(message.rootSessionId);
    } else if (message.type === 'providerAggregate') {
      const maxGroups = message.maxGroups === undefined
        ? undefined
        : boundedInteger(message.maxGroups, DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT);
      result = recorder.readProviderAggregateSummary({
        todayStartMs: message.todayStartMs,
        todayEndMs: message.todayEndMs,
        weekStartMs: message.weekStartMs,
        weekEndMs: message.weekEndMs,
        timeZone: message.timeZone,
        dailyWindowStartMs: message.dailyWindowStartMs,
        dailyWindowEndMs: message.dailyWindowEndMs,
        maxGroups,
      });
    } else if (message.type === 'historicalDimensions') {
      result = recorder.readHistoricalDimensionSummary();
    } else if (message.type === 'qualificationSpin') {
      // Disposable cancellation seam. Production callers never issue this
      // request; it proves a CPU-bound query can be terminated independently.
      let value = 0;
      const iterations = boundedInteger(message.iterations, 100_000_000, 2_000_000_000);
      for (let index = 0; index < iterations; index += 1) value = (value + index) % 2_147_483_647;
      result = value;
    } else {
      throw new Error('Unsupported analytics query type.');
    }
    const bytes = serialize(result);
    if (bytes.byteLength > maximum) {
      throw new Error(`Analytics query result exceeds ${maximum} bytes.`);
    }
    const telemetry = sampleWorkerTelemetry('after-result-serialization');
    send({
      type: 'result',
      requestId: message.requestId,
      bytes,
      ...(telemetry ? { telemetry } : { telemetryStatus: 'unavailable-runtime' }),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const telemetry = sampleWorkerTelemetry('after-error-message-formatting');
    send({
      type: 'error',
      requestId: message.requestId,
      error: errorMessage,
      ...(telemetry ? { telemetry } : { telemetryStatus: 'unavailable-runtime' }),
    });
  }
});

if (recorder) {
  process.once('disconnect', () => {
    recorder?.close();
    process.exit(0);
  });

  send({ type: 'ready', workerIdentity });
}
