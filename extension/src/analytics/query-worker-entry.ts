import { serialize } from 'node:v8';

import type { AnalyticsQueryRequest } from './query-client.js';
import { SqliteAnalyticsRecorder } from './sqlite-recorder.js';

const databasePath = process.env.PIE_ANALYTICS_DATABASE_PATH;
if (!databasePath) throw new Error('PIE_ANALYTICS_DATABASE_PATH is required.');

const recorder = new SqliteAnalyticsRecorder(databasePath, { readOnly: true });

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

process.on('message', (raw: unknown) => {
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
      result = { storage: recorder.readStorageSummary(), delivery: recorder.readDeliveryAccounting() };
    } else if (message.type === 'providerSettlements') {
      const limit = boundedInteger(message.limit, DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT);
      result = recorder.readProviderSettlements(message.rootSessionId, limit);
    } else if (message.type === 'providerAccounting') {
      result = recorder.readProviderAccountingSummary(message.rootSessionId);
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
    send({ type: 'result', requestId: message.requestId, bytes });
  } catch (error) {
    send({
      type: 'error',
      requestId: message.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

process.once('disconnect', () => {
  recorder.close();
  process.exit(0);
});

send({ type: 'ready' });
