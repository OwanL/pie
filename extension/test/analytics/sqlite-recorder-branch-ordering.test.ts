import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ANALYTICS_SCHEMA_VERSION,
  deriveAnalyticsIdempotencyKey,
  type AnalyticsObservation,
} from '../../../shared/analytics/contracts.js';
import { SqliteAnalyticsRecorder } from '../../src/analytics/sqlite-recorder.js';

function observation(options: {
  generationId: string;
  processGeneration: string;
  sourceKey: string;
  observedAtMs: number;
  entityKind?: AnalyticsObservation['entityKind'];
  entityKey: string;
  observationKind: AnalyticsObservation['observationKind'];
  branchId?: string;
  invocationId?: string;
  sourceSequence: number;
  fields: Record<string, unknown>;
}): AnalyticsObservation {
  const rootSessionId = 'shared-root';
  const base = {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: options.generationId,
    producerKind: 'branch-ordering-test',
    stableOriginId: 'branch-ordering-origin',
    sourceKey: options.sourceKey,
    sourceSequence: options.sourceSequence,
    entityKind: options.entityKind ?? (options.invocationId ? 'providerCall' : 'branch'),
    entityKey: options.entityKey,
    observationKind: options.observationKind,
    observedAtMs: options.observedAtMs,
    scope: {
      workspaceCoverage: 'known' as const,
      workspaceId: 'branch-ordering-workspace',
      rootSessionId,
      ...(options.invocationId ? { invocationId: options.invocationId } : {}),
      ...(options.branchId ? { branchId: options.branchId } : {}),
    },
    captureSubject: { kind: 'session' as const, rootSessionId },
    producer: { buildId: 'branch-ordering-build', processGeneration: options.processGeneration },
    fields: options.fields,
  };
  return { ...base, idempotencyKey: deriveAnalyticsIdempotencyKey(base) };
}

function branch(
  generationId: string,
  processGeneration: string,
  branchId: string,
  parentBranchId: string | null,
  sourceSequence: number,
  observedAtMs: number,
  sourceKey = `edge:${generationId}:${branchId}`,
): AnalyticsObservation {
  return observation({
    generationId,
    processGeneration,
    sourceKey,
    observedAtMs,
    entityKey: branchId,
    observationKind: 'observation',
    branchId,
    sourceSequence,
    fields: { branchId, parentBranchId, sourceEntryId: branchId },
  });
}

function selectBranch(
  generationId: string,
  processGeneration: string,
  branchId: string,
  sourceSequence: number,
  observedAtMs: number,
): AnalyticsObservation {
  return observation({
    generationId,
    processGeneration,
    sourceKey: `selection:${generationId}:${branchId}`,
    observedAtMs,
    entityKey: branchId,
    observationKind: 'phase',
    branchId,
    sourceSequence,
    fields: { branchId, sourceSelectionId: `selection:${generationId}:${branchId}`, sourceEntryId: branchId },
  });
}

function settlement(
  generationId: string,
  processGeneration: string,
  branchId: string,
  invocationId: string,
  cost: number,
  sourceSequence: number,
  observedAtMs: number,
): AnalyticsObservation {
  return observation({
    generationId,
    processGeneration,
    sourceKey: `settlement:${generationId}:${invocationId}`,
    observedAtMs,
    entityKey: invocationId,
    observationKind: 'providerSettlement',
    branchId,
    invocationId,
    sourceSequence,
    fields: {
      invocationId,
      provider: 'branch-ordering-provider',
      dispatchedModel: 'branch-ordering-model',
      reportedCostUsd: cost,
      inputTokens: Math.round(cost * 1_000),
      inputIncludesCache: false,
      outputIncludesReasoning: true,
      cacheChannelsOmittedAsZero: true,
    },
  });
}

function totalCost(rows: ReadonlyArray<{ effectiveCostUsd: number | null }>): number {
  return rows.reduce((total, row) => total + (row.effectiveCostUsd ?? 0), 0);
}

test('late older branch delivery after restart cannot replace selection or duplicate charges', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-analytics-branch-ordering-'));
  const databasePath = path.join(root, 'analytics.sqlite');
  let recorder = new SqliteAnalyticsRecorder(databasePath);
  try {
    recorder.submitBatch([
      branch('generation-1', 'process-1', 'A', null, 1, 100),
      branch('generation-1', 'process-1', 'B', 'A', 2, 100),
      branch('generation-1', 'process-1', 'C', 'A', 3, 100),
      settlement('generation-1', 'process-1', 'A', 'invocation-A', 0.01, 4, 100),
      settlement('generation-1', 'process-1', 'C', 'invocation-C', 0.03, 5, 100),
      selectBranch('generation-1', 'process-1', 'C', 6, 200),
    ]);
    assert.equal(totalCost(recorder.readScopedProviderSettlements({
      kind: 'selectedBranch', generationId: 'generation-1', rootSessionId: 'shared-root',
    }).settlements), 0.04);
    recorder.close();

    recorder = new SqliteAnalyticsRecorder(databasePath);
    const lateB = settlement('generation-1', 'process-2', 'B', 'invocation-B', 0.02, 7, 100);
    const lateSelectionB = selectBranch('generation-1', 'process-2', 'B', 8, 100);
    recorder.submit(lateB);
    recorder.submit(lateB);
    recorder.submit(lateSelectionB);
    recorder.submit(lateSelectionB);
    const selectedGeneration1 = recorder.readScopedProviderSettlements({
      kind: 'selectedBranch', generationId: 'generation-1', rootSessionId: 'shared-root',
    });
    assert.equal(selectedGeneration1.selectionCoverage, 'known');
    assert.deepEqual(selectedGeneration1.settlements.map((row) => row.invocationId), [
      'invocation-A', 'invocation-C',
    ]);
    assert.equal(totalCost(selectedGeneration1.settlements), 0.04);
    assert.equal(recorder.readProviderSettlements().settlements.length, 3);

    recorder.submitBatch([
      branch('generation-2', 'process-2', 'A', null, 1, 100),
      settlement('generation-2', 'process-2', 'A', 'invocation-generation-2-A', 0.10, 2, 100),
      selectBranch('generation-2', 'process-2', 'A', 3, 200),
    ]);
    const selectedGeneration2 = recorder.readScopedProviderSettlements({
      kind: 'selectedBranch', generationId: 'generation-2', rootSessionId: 'shared-root',
    });
    assert.equal(selectedGeneration2.selectionCoverage, 'known');
    assert.deepEqual(selectedGeneration2.settlements.map((row) => row.invocationId), [
      'invocation-generation-2-A',
    ]);
    assert.equal(totalCost(selectedGeneration2.settlements), 0.10);
    assert.equal(totalCost(recorder.readScopedProviderSettlements({
      kind: 'selectedBranch', generationId: 'generation-1', rootSessionId: 'shared-root',
    }).settlements), 0.04);
  } finally {
    recorder.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('equal-time selections choose the same winner across reverse delivery order and reopen', () => {
  const selectedAfterOrder = (selectionOrder: readonly ['B' | 'C', 'B' | 'C']): readonly string[] => {
    const root = mkdtempSync(path.join(tmpdir(), 'pie-analytics-branch-tie-'));
    const databasePath = path.join(root, 'analytics.sqlite');
    let recorder = new SqliteAnalyticsRecorder(databasePath);
    try {
      const selections = {
        B: selectBranch('generation-tie', 'process-1', 'B', 7, 200),
        C: selectBranch('generation-tie', 'process-1', 'C', 8, 200),
      };
      recorder.submitBatch([
        branch('generation-tie', 'process-1', 'A', null, 1, 100),
        branch('generation-tie', 'process-1', 'B', 'A', 2, 100),
        branch('generation-tie', 'process-1', 'C', 'A', 3, 100),
        settlement('generation-tie', 'process-1', 'A', 'invocation-A', 0.01, 4, 100),
        settlement('generation-tie', 'process-1', 'B', 'invocation-B', 0.02, 5, 100),
        settlement('generation-tie', 'process-1', 'C', 'invocation-C', 0.03, 6, 100),
        selections[selectionOrder[0]],
        selections[selectionOrder[1]],
      ]);
      recorder.close();
      recorder = new SqliteAnalyticsRecorder(databasePath);
      return recorder.readScopedProviderSettlements({
        kind: 'selectedBranch', generationId: 'generation-tie', rootSessionId: 'shared-root',
      }).settlements.map((row) => row.invocationId);
    } finally {
      recorder.close();
      rmSync(root, { recursive: true, force: true });
    }
  };

  const forward = selectedAfterOrder(['B', 'C']);
  const reverse = selectedAfterOrder(['C', 'B']);
  assert.deepEqual(reverse, forward);
  assert.deepEqual(forward, ['invocation-A', 'invocation-C']);
});
