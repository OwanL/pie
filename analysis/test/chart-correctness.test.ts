import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  PreparedPruningEventRow,
  PreparedPruningSignalRow,
  PreparedRunRow,
  PreparedTurnThroughputRow,
} from '../scripts/contracts.ts';
import { modelFamilyKey } from '../site/lib.ts';
import { pruningRecoveryMetrics, pruningRecoverySpec } from '../site/charts/pruning.ts';
import { satisfactionIntervalSpec, settingComparisonRows } from '../site/charts/settings.ts';
import {
  effectiveThroughputRows,
  throughputByModelRows,
  throughputConcurrencyRows,
  throughputVsConcurrencySpec,
} from '../site/charts/throughput.ts';

function settingRun(
  runId: string,
  mode: 'auto' | 'off' | null,
  satisfaction: number | null,
  status = 'scored',
): PreparedRunRow {
  return {
    runId,
    status,
    fsPruningMode: mode,
    satisfaction,
    resolution: satisfaction === null ? null : 'resolved',
  } as unknown as PreparedRunRow;
}

test('modelFamilyKey is canonical, trimmed, and falls back safely', () => {
  assert.equal(modelFamilyKey({ modelFamily: ' shared-family ', modelId: 'provider-id' }), 'shared-family');
  assert.equal(modelFamilyKey({ modelFamily: ' ', modelId: ' provider-id ' }), 'provider-id');
  assert.equal(modelFamilyKey({ modelFamily: null, modelId: null }), '(unknown)');
});

test('setting comparison excludes untracked groups, requires n>=3, and reports coverage', () => {
  const runs = [
    settingRun('auto-1', 'auto', 3),
    settingRun('auto-2', 'auto', 4),
    settingRun('auto-3', 'auto', 5),
    settingRun('off-1', 'off', 4),
    settingRun('off-2', 'off', 5),
    settingRun('untracked-1', null, 1),
    settingRun('untracked-2', null, 2),
    settingRun('untracked-3', null, 3),
    settingRun('untracked-4', null, 4),
  ];

  const comparison = settingComparisonRows(runs, (run) => run.fsPruningMode, ['auto', 'off']);
  assert.deepEqual(comparison.rows.map((row) => row.group), ['auto']);
  assert.equal(comparison.rows[0]!.scoredCount, 3);
  assert.equal(comparison.rows[0]!.nLabel, 'n=3');
  assert.ok(comparison.rows[0]!.ciLower < comparison.rows[0]!.avgSatisfaction);
  assert.ok(comparison.rows[0]!.ciUpper > comparison.rows[0]!.avgSatisfaction);
  assert.equal(comparison.totalRunCount, 9);
  assert.equal(comparison.trackedRunCount, 5);
  assert.equal(comparison.totalScoredCount, 9);
  assert.equal(comparison.trackedScoredCount, 5);
});

test('setting satisfaction spec visibly layers 95% intervals and n labels', () => {
  const rows = settingComparisonRows([
    settingRun('auto-1', 'auto', 3),
    settingRun('auto-2', 'auto', 4),
    settingRun('auto-3', 'auto', 5),
  ], (run) => run.fsPruningMode).rows;
  const spec = satisfactionIntervalSpec(rows) as { layer: Array<Record<string, unknown>>; data: { values: Array<{ nLabel: string }> } };

  assert.deepEqual(spec.layer.map((layer) => (layer.mark as { type: string }).type), ['bar', 'rule', 'point', 'text']);
  assert.equal(spec.data.values[0]!.nLabel, 'n=3');
  const textEncoding = spec.layer[3]!.encoding as { text: { field: string } };
  assert.equal(textEncoding.text.field, 'nLabel');
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
  ] as PreparedPruningSignalRow[];

  const metrics = pruningRecoveryMetrics(decisions, signals);
  assert.equal(metrics.toolRecoveriesPerDecision, 1.5);
  assert.equal(metrics.skillMissRate, 0.4);

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
