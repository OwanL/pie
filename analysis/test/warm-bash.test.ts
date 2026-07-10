import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import type { SourceAnalyticsPayload, WarmBashRewriteSourceEvent, WarmBashSessionSummarySourceEvent } from '../scripts/contracts.ts';
import { readWarmBashLog } from '../scripts/source.ts';
import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import { buildDuckDbDatabase, runNamedDuckDbQuery } from '../scripts/duckdb.ts';
import { deepClone, loadFixture, withTempDir } from './helpers.ts';

const TS = '2026-07-09T12:00:00.000Z';

function rewrite(sessionId: string, before: string, after: string): WarmBashRewriteSourceEvent {
  return { event: 'auto_prune_rewrite', sessionId, timestamp: TS, before, after };
}

function summary(sessionId: string, over: Partial<WarmBashSessionSummarySourceEvent> = {}): WarmBashSessionSummarySourceEvent {
  return {
    event: 'session_summary',
    sessionId,
    timestamp: TS,
    fastPath: 40,
    warm: 10,
    fallback: 5,
    poolSize: 2,
    warmupFailures: 0,
    autoPruneEnabled: true,
    fastPathEnabled: true,
    gnuGrep: true,
    ...over,
  };
}

test('readWarmBashLog parses valid rewrites + summaries and drops malformed lines', async () => {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const logPath = path.join(dataDir, 'warm-bash.jsonl');
    const lines = [
      JSON.stringify(rewrite('sess-a', 'grep -rn foo .', 'grep --exclude-dir=node_modules -rn foo .')),
      JSON.stringify(summary('sess-a', { fastPath: 7, warm: 3, fallback: 1 })),
      'not-json-at-all',
      JSON.stringify({ event: 'auto_prune_rewrite', sessionId: 'sess-a', timestamp: TS, before: 'x' }), // missing after
      JSON.stringify({ event: 'session_summary', sessionId: 'sess-a', timestamp: TS, fastPath: 1, warm: 1, fallback: 1, poolSize: 1, warmupFailures: 0, autoPruneEnabled: 'yes', fastPathEnabled: true, gnuGrep: true }), // non-boolean autoPruneEnabled
      JSON.stringify({ event: 'something_else', sessionId: 'sess-a', timestamp: TS }), // unknown event
      JSON.stringify(rewrite('sess-b', 'find . -name x', 'find . \\( -name node_modules \\) -prune')),
    ];
    fs.writeFileSync(logPath, lines.join('\n') + '\n');

    const { rewrites, summaries } = readWarmBashLog(dir);
    assert.equal(rewrites.length, 2, 'two well-formed rewrites survive');
    assert.equal(rewrites[0]!.sessionId, 'sess-a');
    assert.ok(rewrites[0]!.after.includes('--exclude-dir=node_modules'));
    assert.equal(rewrites[1]!.sessionId, 'sess-b');
    assert.equal(summaries.length, 1, 'one well-formed summary survives');
    assert.equal(summaries[0]!.fastPath, 7);
    assert.equal(summaries[0]!.warm, 3);
    assert.equal(summaries[0]!.fallback, 1);
  });
});

test('readWarmBashLog returns empty arrays when the log file is absent', async () => {
  await withTempDir(async (dir) => {
    const { rewrites, summaries } = readWarmBashLog(dir);
    assert.deepEqual(rewrites, []);
    assert.deepEqual(summaries, []);
  });
});

test('prepareSourceAnalytics joins warm-bash rewrites + summaries to runs by sessionPathHash', async () => {
  const fixture = deepClone(await loadFixture());
  const targetRun = fixture.completedRuns[0]!;
  const sessionPath = targetRun.sessionPath;

  fixture.warmBashRewrites = [
    rewrite(sessionPath, 'grep -rn foo .', 'grep --exclude-dir=node_modules -rn foo .'),
    rewrite(sessionPath, 'find . -name x', 'find . \\( -name node_modules \\) -prune -o \\( -name x \\) -print'),
  ];
  fixture.warmBashSummaries = [summary(sessionPath, { fastPath: 40, warm: 10, fallback: 5 })];

  const prepared = prepareSourceAnalytics(fixture);
  assert.equal(prepared.warmBashRewrites.length, 2);
  assert.equal(prepared.warmBashSummaries.length, 1);

  for (const row of prepared.warmBashRewrites) {
    assert.equal(row.runId, targetRun.runId, 'rewrite joined to the matched run');
    assert.equal(row.sessionPathHash, prepared.runs[0]!.sessionPathHash);
    assert.equal(row.startedDay, '2026-07-09');
  }
  const srow = prepared.warmBashSummaries[0]!;
  assert.equal(srow.runId, targetRun.runId);
  assert.equal(srow.fastPath, 40);
  assert.equal(srow.warm, 10);
  assert.equal(srow.fallback, 5);
});

test('prepareSourceAnalytics attributes unjoined warm-bash events to a warm-bash-<hash> runId', async () => {
  const fixture = deepClone(await loadFixture());
  // A sessionId that matches no run → unjoined.
  fixture.warmBashRewrites = [rewrite('no-such-session', 'grep -rn foo .', 'grep --exclude-dir=x -rn foo .')];
  fixture.warmBashSummaries = [];
  const prepared = prepareSourceAnalytics(fixture);
  assert.equal(prepared.warmBashRewrites.length, 1);
  const row = prepared.warmBashRewrites[0]!;
  assert.match(row.runId, /^warm-bash-/);
  assert.ok(row.sessionPathHash.length > 0);
});

test('prepareSourceAnalytics tolerates a missing warm-bash array (optional field)', async () => {
  const fixture = deepClone(await loadFixture());
  delete fixture.warmBashRewrites;
  delete fixture.warmBashSummaries;
  const prepared = prepareSourceAnalytics(fixture);
  assert.deepEqual(prepared.warmBashRewrites, []);
  assert.deepEqual(prepared.warmBashSummaries, []);
});

test('warm_bash named query returns the routing breakdown + rewrite headline', async () => {
  const fixture = deepClone(await loadFixture());
  const sessionPath = fixture.completedRuns[0]!.sessionPath;
  fixture.warmBashRewrites = [
    rewrite(sessionPath, 'grep -rn a .', 'grep --exclude-dir=node_modules -rn a .'),
    rewrite(sessionPath, 'find . -name x', 'find . \\( -name node_modules \\) -prune'),
  ];
  // 40 fast + 10 warm + 5 fallback = 55; fast_path_pct = 72.7; fallback_pct = 9.1.
  fixture.warmBashSummaries = [summary(sessionPath, { fastPath: 40, warm: 10, fallback: 5 })];

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pie-warm-bash-query-'));
  try {
    const dbPath = path.join(tempDir, 'usage.duckdb');
    const exportsDir = path.join(tempDir, 'exports');
    await buildDuckDbDatabase({ dbPath, exportsDir, prepared: prepareSourceAnalytics(fixture) });

    const rows = await runNamedDuckDbQuery(dbPath, 'warm_bash');
    assert.equal(rows.length, 1);
    const r = rows[0]!;
    assert.equal(Number(r['fast_path_calls']), 40);
    assert.equal(Number(r['warm_calls']), 10);
    assert.equal(Number(r['fallback_calls']), 5);
    assert.equal(Number(r['total_bash_calls']), 55);
    assert.equal(Number(r['fast_path_pct']), 72.7);
    assert.equal(Number(r['fallback_pct']), 9.1);
    assert.equal(Number(r['summarized_sessions']), 1);
    assert.equal(Number(r['auto_prune_enabled_sessions']), 1);
    assert.equal(Number(r['fast_path_enabled_sessions']), 1);
    assert.equal(Number(r['gnu_grep_sessions']), 1);
    assert.equal(Number(r['warmup_failures']), 0);
    assert.equal(Number(r['rewrite_count']), 2);
    assert.equal(Number(r['sessions_with_rewrites']), 1);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('warm_bash query returns zeros (not nulls) when warm-bash never ran', async () => {
  const fixture = deepClone(await loadFixture());
  fixture.warmBashRewrites = [];
  fixture.warmBashSummaries = [];

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pie-warm-bash-empty-'));
  try {
    const dbPath = path.join(tempDir, 'usage.duckdb');
    const exportsDir = path.join(tempDir, 'exports');
    await buildDuckDbDatabase({ dbPath, exportsDir, prepared: prepareSourceAnalytics(fixture) });
    const rows = await runNamedDuckDbQuery(dbPath, 'warm_bash');
    assert.equal(rows.length, 1);
    const r = rows[0]!;
    assert.equal(Number(r['fast_path_calls']), 0);
    assert.equal(Number(r['total_bash_calls']), 0);
    assert.equal(r['fast_path_pct'], null); // no calls → NULL pct (guarded)
    assert.equal(Number(r['rewrite_count']), 0);
    assert.equal(Number(r['summarized_sessions']), 0);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('full pipeline ingests warm-bash data attached via loadSourceAnalytics-style fields', async () => {
  // Mirrors how loadSourceAnalytics attaches readWarmBashLog output to the source.
  const fixture: SourceAnalyticsPayload = deepClone(await loadFixture());
  const sessionPath = fixture.completedRuns[0]!.sessionPath;
  const { rewrites, summaries } = (() => {
    const dataDir = path.join(os.tmpdir(), `pie-warm-bash-pipe-${Date.now()}`, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'warm-bash.jsonl'),
      `${JSON.stringify(rewrite(sessionPath, 'grep -rn foo .', 'grep --exclude-dir=node_modules -rn foo .'))}\n` +
      `${JSON.stringify(summary(sessionPath))}\n`,
    );
    return readWarmBashLog(path.dirname(dataDir));
  })();
  fixture.warmBashRewrites = rewrites;
  fixture.warmBashSummaries = summaries;

  const prepared = prepareSourceAnalytics(fixture);
  assert.equal(prepared.warmBashRewrites.length, 1);
  assert.equal(prepared.warmBashSummaries.length, 1);
  assert.equal(prepared.warmBashRewrites[0]!.runId, fixture.completedRuns[0]!.runId);
  assert.equal(prepared.warmBashSummaries[0]!.fastPath, 40);
});
