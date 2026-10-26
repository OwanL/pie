import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readInitialContextHistory } from './initial-context-history.js';
import type { CanonicalAnalyticsReadModel } from './query-entry.js';
import type { AnalyticsReadOnlyQueryResult } from '../recording/sqlite-recorder.js';

test('canonical envelope query filters window/dimensions, deduplicates roots, and interpolates quantiles', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE analytics_feature_observations (
      observation_registry_key TEXT, root_session_id TEXT, feature TEXT,
      decision TEXT, rule_version TEXT, payload_json TEXT)`);
    const now = 2_000_000_000_000;
    let key = 0;
    const insert = (root: string | null, tokens: unknown, options: {
      cohort?: string; time?: number | string; feature?: string; decision?: string; rule?: string;
    } = {}) => db.prepare('INSERT INTO analytics_feature_observations VALUES (?, ?, ?, ?, ?, ?)').run(
      String(++key), root, options.feature ?? 'initialContext', options.decision ?? 'post-pruning',
      options.rule ?? 'request-prefix-v1', JSON.stringify({ observedAtMs: options.time ?? now,
        fields: { initialContext: { cohortKey: options.cohort ?? 'cohort', tokens } } }),
    );
    const reader: Pick<CanonicalAnalyticsReadModel, 'executeQuery'> = {
      executeQuery: async (request, _signal, priority) => {
        assert.equal(request.maxRows, 1000);
        assert.equal(priority, 'background');
        const rows = db.prepare(request.sql).all(...request.parameters as [string, number, number]);
        return { rows, truncation: { rowLimit: false, byteLimit: false, cellLimit: false } } as AnalyticsReadOnlyQueryResult;
      },
    };
    for (let i = 0; i < 19; i++) insert(`root-${i}`, i * 10, { time: String(now - 1) });
    assert.equal(await readInitialContextHistory(reader, 'cohort', now), undefined);
    insert('root-19', 190);
    for (let i = 0; i < 50; i++) insert('root-19', 9999, { time: now - 5 });
    insert(null, 9999);
    insert('other-cohort', 9999, { cohort: 'other' });
    insert('old', 9999, { time: now - 30 * 86400000 - 1 });
    insert('future', 9999, { time: now + 1 });
    insert('bad-time', 9999, { time: `${now}junk` });
    insert('bad-feature', 9999, { feature: 'pruning' });
    insert('bad-decision', 9999, { decision: 'pre-pruning' });
    insert('bad-rule', 9999, { rule: 'v0' });
    for (const value of [-1, 1.5, '9999', null]) insert(`invalid-${key}`, value);
    assert.deepEqual(await readInitialContextHistory(reader, 'cohort', now), {
      medianTokens: 95, p25Tokens: 48, p75Tokens: 143,
    });
    // Only newest 1000 matching observations are considered, not unbounded roots.
    for (let i = 0; i < 1000; i++) insert('repeated', 123, { time: now + 10 });
    assert.equal(await readInitialContextHistory(reader, 'cohort', now + 10), undefined);
  } finally { db.close(); }
});

test('truncated results never establish history', async () => {
  for (const flag of ['rowLimit', 'byteLimit', 'cellLimit']) {
    const reader = { executeQuery: async () => ({
      rows: Array.from({ length: 20 }, (_, i) => ({ root_session_id: String(i), tokens: i })),
      truncation: { rowLimit: false, byteLimit: false, cellLimit: false, [flag]: true },
    } as AnalyticsReadOnlyQueryResult) };
    assert.equal(await readInitialContextHistory(reader, 'cohort'), undefined);
  }
});
