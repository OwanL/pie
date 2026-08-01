import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { queryRunAnalyticsStore } from '../../../src/host/run-analytics/query';

/**
 * Boundary tests for the run-snapshots JSONL store reader. The store is an
 * append-only JSONL log where each line is `{ kind: 'run_snapshot', run: {...} }`.
 * Real stores accumulate across crashes, partial writes, and schema drift, so
 * the reader must skip malformed/non-snapshot/uncoercible lines and surface
 * only the valid snapshots (last write wins per runId). These tests pin that
 * resilience without exercising the full StatsService pipeline.
 */

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-jsonl-robustness-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** A complete run snapshot that passes the extension's strict coerceRunSnapshot. */
function validRun(runId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'run_snapshot',
    run: {
      sessionPath: `/workspace/${runId}.jsonl`,
      runId,
      taskGroupId: 'task-group-1',
      status: 'closed',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:10:00.000Z',
      mixedModelConfig: false,
      sendCount: 1,
      assistantTurnCount: 1,
      assistantTurnDurationMs: 1000,
      interruptedCount: 0,
      messageEditCount: 0,
      truncatedAfterCount: 0,
      filesystemPathRefCount: 1,
      imageInputCount: 0,
      imageInputBytes: 0,
      unsupportedInputCount: 0,
      backendErrorCodes: [],
      inputKindsUsed: [],
      ...overrides,
    },
  };
}

function writeJsonl(dir: string, lines: string[]): Promise<void> {
  return fs.writeFile(path.join(dir, 'run-snapshots.jsonl'), `${lines.join('\n')}\n`, 'utf8');
}

test('valid snapshots survive alongside malformed, non-snapshot, and uncoercible lines', async () => {
  await withTempDir(async (dir) => {
    await writeJsonl(dir, [
      JSON.stringify(validRun('run-good-1')),
      'this is not valid json and must be skipped',
      JSON.stringify({ kind: 'unrelated_event', run: { runId: 'ignored' } }),
      JSON.stringify({ kind: 'run_snapshot', run: { runId: 'no-identity', status: 'closed' } }), // uncoercible (missing required fields)
      JSON.stringify(validRun('run-good-2', { status: 'open', sendCount: 5 })),
      '', // blank line
      '   ', // whitespace-only line
      JSON.stringify({ kind: 'run_snapshot', run: null }), // null run payload
      JSON.stringify({ kind: 'run_snapshot' }), // missing run field
      '{ "kind": "run_snapshot", "run": { "runId": "truncated"', // broken JSON mid-line
      JSON.stringify(validRun('run-good-3')),
    ]);

    const result = await queryRunAnalyticsStore(dir);
    const runIds = result.completedRuns.map((r) => r.runId).sort();
    assert.deepEqual(runIds, ['run-good-1', 'run-good-2', 'run-good-3']);
    assert.equal(result.openRuns.length, 0, 'no checkpoint present → no open runs');

    const good2 = result.completedRuns.find((r) => r.runId === 'run-good-2')!;
    assert.equal(good2.status, 'open');
    assert.equal(good2.sendCount, 5);
  });
});

test('duplicate runIds collapse to the last appended snapshot (last-write-wins)', async () => {
  await withTempDir(async (dir) => {
    await writeJsonl(dir, [
      JSON.stringify(validRun('dup-1', { sendCount: 1 })),
      JSON.stringify(validRun('dup-1', { sendCount: 9, updatedAt: '2026-01-02T00:00:00.000Z' })),
      JSON.stringify(validRun('dup-1', { sendCount: 4, updatedAt: '2026-01-01T12:00:00.000Z' })),
    ]);

    const result = await queryRunAnalyticsStore(dir);
    assert.equal(result.completedRuns.length, 1);
    // The JSONL reader keys by runId and overwrites on each append, so the final
    // line for a runId wins regardless of recency (recency only governs the
    // checkpoint lastRun fallback, not intra-JSONL dedup).
    assert.equal(result.completedRuns[0]?.sendCount, 4);
  });
});

test('an empty or missing store yields an empty result without throwing', async () => {
  await withTempDir(async (dir) => {
    // Missing file entirely.
    const missing = await queryRunAnalyticsStore(dir);
    assert.deepEqual(missing.completedRuns, []);
    assert.deepEqual(missing.openRuns, []);

    // Empty file.
    await fs.writeFile(path.join(dir, 'run-snapshots.jsonl'), '', 'utf8');
    const empty = await queryRunAnalyticsStore(dir);
    assert.deepEqual(empty.completedRuns, []);
    assert.deepEqual(empty.openRuns, []);
  });
});

test('a store containing only garbage yields an empty result', async () => {
  await withTempDir(async (dir) => {
    await writeJsonl(dir, [
      'not json',
      '{}',
      JSON.stringify({ kind: 'other' }),
      JSON.stringify({ kind: 'run_snapshot', run: { status: 'closed' } }),
      'null',
    ]);
    const result = await queryRunAnalyticsStore(dir);
    assert.deepEqual(result.completedRuns, []);
    assert.deepEqual(result.openRuns, []);
  });
});
