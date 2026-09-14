// Spy fixture for the read-only memorySample diagnostic seam. It imports the
// PRODUCTION recorder worker source after wrapping four SqliteAnalyticsRecorder
// prototype methods with call counters persisted to a file, so a parent test can
// observe whether a request touches recorder SQL without changing the worker
// entry itself. The supervisor only forwards PIE_ANALYTICS_* env, so the spy
// file is derived from the forwarded database path.
import { writeFileSync } from 'node:fs';

const spyPath = `${process.env.PIE_ANALYTICS_DATABASE_PATH}.memory-spy-counts.json`;
if (!process.env.PIE_ANALYTICS_DATABASE_PATH) throw new Error('PIE_ANALYTICS_DATABASE_PATH is required.');

const counts = { detailStorageStats: 0, readDeliveryAccounting: 0, getStats: 0, readStatsReplyAccounting: 0 };
const persist = () => {
  try {
    writeFileSync(spyPath, JSON.stringify(counts));
  } catch {
    // The parent polls this file; a transient write race must not kill the worker.
  }
};

const { SqliteAnalyticsRecorder } = await import('../../../src/analytics/sqlite-recorder.ts');
for (const name of Object.keys(counts)) {
  const original = SqliteAnalyticsRecorder.prototype[name];
  if (typeof original !== 'function') throw new Error(`SqliteAnalyticsRecorder.${name} is missing.`);
  SqliteAnalyticsRecorder.prototype[name] = function (...args) {
    counts[name] += 1;
    persist();
    return original.apply(this, args);
  };
}
persist();

await import('../../../src/analytics/recorder-worker-entry.ts');