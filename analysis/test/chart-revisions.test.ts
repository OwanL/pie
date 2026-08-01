import assert from 'node:assert/strict';
import test from 'node:test';

import type { PreparedRunRow, PreparedTurnThroughputRow } from '../scripts/contracts.ts';
import { MODEL_PALETTE } from '../site/lib.ts';
import { throughputConcurrencyRows, throughputVsConcurrencySpec } from '../site/charts/throughput.ts';
import { effectiveThroughputRows } from '../site/charts/throughput.ts';

function run(runId: string, modelFamily: string): PreparedRunRow {
  return { runId, modelId: modelFamily, modelFamily } as PreparedRunRow;
}

function turn(runId: string, modelFamily: string, tps: number, concurrency: number, endedAt: string): PreparedTurnThroughputRow {
  return { runId, modelId: modelFamily, modelFamily, tokensPerSecond: tps, concurrentBusySessions: concurrency, endedAt } as PreparedTurnThroughputRow;
}

test('throughput color scale uses the extended palette, not a fixed 5-color array (no >5 collision)', () => {
  // Six model families — the old 5-color range would have collided two of them.
  const families = ['family-a', 'family-b', 'family-c', 'family-d', 'family-e', 'family-f'];
  const rows = effectiveThroughputRows(
    families.map((f, i) => run(`r${i}`, f)),
    families.flatMap((f, i) => [
      turn(`r${i}`, f, 10 + i, 1, '2026-01-01T00:00:00Z'),
      turn(`r${i}`, f, 12 + i, 2, '2026-01-01T00:01:00Z'),
    ]),
  );
  const bins = throughputConcurrencyRows(rows);
  const spec = throughputVsConcurrencySpec(bins, families) as { layer: Array<{ encoding?: { color?: { scale?: { range?: string[] } } } }> };
  // The point layer's color scale must come from modelColorScale (>= 10 colors),
  // proving the hardcoded 5-color range that caused collisions is gone.
  const pointLayer = spec.layer.find((l) => l.encoding?.color?.scale);
  const range = pointLayer!.encoding!.color!.scale!.range;
  assert.ok(range && range.length >= 10, `expected extended palette, got ${range?.length ?? 0} colors`);
  // A supplementary hue (beyond the original five brand colors) must be present.
  assert.ok(range.includes(MODEL_PALETTE[5]!), 'extended palette hue missing');
});
