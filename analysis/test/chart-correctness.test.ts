import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  PreparedPruningEventRow,
  PreparedPruningSignalRow,
  PreparedRunRow,
  PreparedTurnThroughputRow,
} from '../scripts/contracts.ts';
import { modelFamilyKey } from '../site/lib.ts';
import { pruningRecoveryMetrics, pruningRecoverySpec, toolResultPruningImpactHtml } from '../site/charts/pruning.ts';
import { runtimeFrictionTimingRows, toolTimeOverlapRows } from '../site/charts/latency-friction.ts';
import { toolDurationRows } from '../site/charts/toolduration.ts';
import {
  effectiveThroughputRows,
  throughputByModelRows,
  throughputConcurrencyRows,
  throughputVsConcurrencySpec,
} from '../site/charts/throughput.ts';

test('modelFamilyKey is canonical, trimmed, and falls back safely', () => {
  assert.equal(modelFamilyKey({ modelFamily: ' shared-family ', modelId: 'provider-id' }), 'shared-family');
  assert.equal(modelFamilyKey({ modelFamily: ' ', modelId: ' provider-id ' }), 'provider-id');
  assert.equal(modelFamilyKey({ modelFamily: null, modelId: null }), '(unknown)');
});

test('pruning recovery transform keeps recoveries/decision separate from miss percent', () => {
  const decisions = [
    { toolCountPruned: 2 },
    { toolCountPruned: 1 },
    { toolCountPruned: 0 },
  ] as PreparedPruningEventRow[];
  const signals = [
    { event: 'tool_recovered' },
    { event: 'tool_recovered' },
    { event: 'tool_recovered' },
    { event: 'skill_read' },
    { event: 'skill_read' },
    { event: 'skill_read' },
    { event: 'skill_miss' },
    { event: 'shadow_miss_candidate' },
    { event: 'skill_recovered' },
  ] as PreparedPruningSignalRow[];

  const metrics = pruningRecoveryMetrics(decisions, signals);
  assert.equal(metrics.toolRecoveriesPerDecision, 1.5);
  assert.equal(metrics.skillMissRate, 3 / 6, 'skill_recovered is a miss with the same denominator semantics as createPruningImpact');

  const spec = pruningRecoverySpec(metrics) as unknown as {
    vconcat: Array<{ encoding: { x: { title: string; axis: { format: string } } } }>;
    resolve: { scale: { x: string } };
  };
  assert.equal(spec.vconcat.length, 2);
  assert.match(spec.vconcat[0]!.encoding.x.title, /per tool-pruning decision/);
  assert.equal(spec.vconcat[0]!.encoding.x.axis.format, '.2f');
  assert.match(spec.vconcat[1]!.encoding.x.title, /miss rate/);
  assert.equal(spec.vconcat[1]!.encoding.x.axis.format, '.0%');
  assert.equal(spec.resolve.scale.x, 'independent');
});

function throughputRun(runId: string, modelId: string, modelFamily: string): PreparedRunRow {
  return { runId, modelId, modelFamily } as PreparedRunRow;
}

function throughputTurn(
  runId: string,
  modelId: string,
  tokensPerSecond: number,
  concurrentBusySessions: number,
  endedAt: string,
  modelFamily = 'shared-family',
): PreparedTurnThroughputRow {
  return { runId, modelId, modelFamily, tokensPerSecond, concurrentBusySessions, endedAt } as PreparedTurnThroughputRow;
}

test('latency/friction transforms exclude absent timing and expose overlap', () => {
  const ctx = {
    runs: [
      { runId: 'measured', status: 'closed', modelId: 'm', modelFamily: 'family', skillPruningPrepassDurationMs: 300, toolDurationMs: 1000, criticalPathDurationMs: 700 },
      { runId: 'unmeasured', status: 'closed', modelId: 'm', modelFamily: 'family', skillPruningPrepassDurationMs: null, toolDurationMs: 900, criticalPathDurationMs: null },
      { runId: 'open', status: 'open', modelId: 'm', modelFamily: 'family', skillPruningPrepassDurationMs: 900, toolDurationMs: 9000, criticalPathDurationMs: 8000 },
    ],
    turnThroughputRows: [
      { runId: 'measured', providerQueueMs: 50 },
      { runId: 'unmeasured', providerQueueMs: null },
    ],
    retryTimingRows: [
      { runId: 'measured', scheduledDelayMs: 1000, measuredDelayMs: 1100, durationMs: 3000 },
    ],
  } as any;

  assert.deepEqual(runtimeFrictionTimingRows(ctx).map((row) => [row.component, row.medianMs, row.observationCount]), [
    ['Skill-pruning prepass', 300, 1],
    ['Provider queue', 50, 1],
    ['Retry scheduled delay', 1000, 1],
    ['Retry measured delay', 1100, 1],
    ['Retry episode duration', 3000, 1],
  ]);
  assert.deepEqual(toolTimeOverlapRows(ctx).map((row) => [row.component, row.medianMs, row.runCount]), [
    ['Cumulative', 1000, 1],
    ['Critical path', 700, 1],
    ['Parallel overlap', 300, 1],
  ]);
  assert.equal(runtimeFrictionTimingRows({ ...ctx, runs: [...ctx.runs, { runId: 'open-only', status: 'open', skillPruningPrepassDurationMs: 999 }] } as any).some((row) => row.medianMs === 999), false, 'open-run timing is excluded');
});

test('overlap stack uses component aggregates as its cumulative reference', () => {
  const ctx = {
    runs: [
      { runId: 'a', status: 'closed', modelFamily: 'family', toolDurationMs: 2, criticalPathDurationMs: 1 },
      { runId: 'b', status: 'closed', modelFamily: 'family', toolDurationMs: 4, criticalPathDurationMs: 2 },
    ],
  } as any;
  const rows = toolTimeOverlapRows(ctx);
  const critical = rows.find((row) => row.component === 'Critical path')!.medianMs;
  const overlap = rows.find((row) => row.component === 'Parallel overlap')!.medianMs;
  const cumulative = rows.find((row) => row.component === 'Cumulative')!.medianMs;
  assert.equal(cumulative, critical + overlap);
  assert.deepEqual({ cumulative, critical, overlap }, { cumulative: 3, critical: 2, overlap: 1 }, 'rounding preserves the displayed stack total');
});

test('tool duration aggregates means over timed calls, not total calls', () => {
  const rows = toolDurationRows({
    runs: [{ runId: 'run', status: 'closed' }],
    toolRows: [
      { runId: 'run', toolName: 'bash', totalDurationMs: 1000, callCount: 10, timedCallCount: 2, failureCount: 0 },
    ],
  } as any);
  assert.deepEqual(rows[0], { tool: 'bash', totalDurationSec: 1, meanDurationSec: 0.5, timedCallCount: 2 });
});

test('tool-result pruning impact helper surfaces filtered savings and rankings', () => {
  const html = toolResultPruningImpactHtml({
    schemaVersion: 7,
    rows: [
      { runId: 'selected', toolName: 'bash', rules: ['ansi-strip', 'minify-json'], beforeTokens: 100, afterTokens: 40, tokensSaved: 60 },
      { runId: 'other', toolName: 'read', rules: ['ansi-strip'], beforeTokens: 1000, afterTokens: 0, tokensSaved: 1000 },
    ],
    summary: { totalEvents: 2, totalTokensSaved: 1060, totalBeforeTokens: 1100, totalAfterTokens: 40, byRule: [], byTool: [] },
  } as any, [{ runId: 'selected' }] as any);
  assert.match(html, /Events:<\/strong> 1/);
  assert.match(html, /Total token savings:<\/strong> 60/);
  assert.match(html, /Savings ratio:<\/strong> 60\.0%/);
  assert.match(html, /ansi-strip/);
  assert.match(html, /bash/);
  assert.ok(!html.includes('read'), 'filtered impact excludes other runs');
});

test('throughput transforms group provider ids by family and use concurrency-bin medians with visible n', () => {
  const rows = effectiveThroughputRows(
    [
      throughputRun('a', 'provider-a-model', 'shared-family'),
      throughputRun('b', 'provider-b-model', 'shared-family'),
    ],
    [
      throughputTurn('a', 'provider-a-model', 10, 1, '2026-01-01T00:00:00Z'),
      throughputTurn('a', 'provider-a-model', 30, 1, '2026-01-01T00:01:00Z'),
      throughputTurn('b', 'provider-b-model', 20, 1, '2026-01-01T00:02:00Z'),
      throughputTurn('b', 'provider-b-model', 40, 2, '2026-01-01T00:03:00Z'),
    ],
  );

  assert.deepEqual(new Set(rows.map((row) => row.model)), new Set(['shared-family']));
  const byModel = throughputByModelRows(rows);
  assert.equal(byModel.length, 1);
  assert.equal(byModel[0]!.median, 25);
  assert.equal(byModel[0]!.turnCount, 4);

  const bins = throughputConcurrencyRows(rows);
  assert.deepEqual(bins.map((row) => ({ concurrency: row.concurrency, median: row.medianThroughput, n: row.nLabel })), [
    { concurrency: 1, median: 20, n: 'n=3' },
    { concurrency: 2, median: 40, n: 'n=1' },
  ]);
  const spec = throughputVsConcurrencySpec(bins, ['shared-family']);
  assert.doesNotMatch(JSON.stringify(spec), /loess|rate-limit/i);
  assert.match(JSON.stringify(spec), /nLabel/);
  assert.match(JSON.stringify(spec), /Effective response throughput/i);
});
