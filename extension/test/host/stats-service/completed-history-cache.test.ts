import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { CompletedHistoryCache, type CompletedHistorySource } from '../../../src/host/completed-history-cache';
import {
  RUN_ANALYTICS_SCHEMA_VERSION,
  coerceRunSnapshot,
  type RunSnapshot,
} from '../../../src/host/run-analytics';
import { serializeJsonLine } from '../../../src/shared/jsonl';
import type { ModelPricingRecord } from '../../../../shared/pricing-core';
import type { PricingCatalog } from '../../../src/host/aggregate-pricing-cache';

const NOW = new Date(2026, 6, 4, 12, 0, 0).getTime();

function validSnapshot(runId: string, updatedAt: string, outputTokens: number): RunSnapshot {
  return {
    runId,
    sessionPath: `/session/${runId}`,
    taskGroupId: `task-${runId}`,
    status: 'closed',
    startedAt: updatedAt,
    updatedAt,
    finalizedAt: updatedAt,
    mixedModelConfig: false,
    mixedTreatmentConfig: false,
    treatmentChangeKinds: [],
    experimentAssignment: null,
    analyticsFactors: null,
    functionalSettings: null,
    sendCount: 1,
    assistantTurnCount: 1,
    assistantTurnDurationMs: 0,
    busyDurationMs: 0,
    busyPeriodCount: 0,
    interruptedCount: 0,
    messageEditCount: 0,
    truncatedAfterCount: 0,
    backendErrorCodes: [],
    contextTokens: null,
    contextLimit: null,
    inputTokens: 0,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    tokenReportedTurnCount: 0,
    lastTurnUsage: null,
    turnThroughputSamples: [],
    filesystemPathRefCount: 0,
    imageInputCount: 0,
    imageInputBytes: 0,
    unsupportedInputCount: 0,
    inputKindsUsed: [],
    toolUsage: {
      totalCount: 0, failureCount: 0, executionFailureCount: 0,
      verificationProjectFailureCount: 0, probeFailureCount: 0, resultIssueCount: 0,
      countsByName: {}, failureCountsByName: {}, failureCountsByKind: {},
      failureCountsByNameAndKind: {}, failureSamples: [],
      resultIssueCountsByName: {}, resultIssueCountsByKind: {},
      resultIssueCountsByNameAndKind: {}, resultIssueSamples: [],
      totalDurationMs: 0, timedCallCount: 0, durationMsByName: {},
      subagentCallCount: 0, subagentTaskCount: 0, subagentAgentNames: [],
    },
    fileMutation: {
      writeCount: 0, editCount: 0, deleteCount: 0, renameCount: 0,
      touchedFileCount: 0, lineAdditions: 0, lineDeletions: 0, lineModifications: 0,
      editCountsByFile: {}, readCountsByFile: {},
    },
    fileExtensions: { readCountsByExtension: {}, writeCountsByExtension: {}, editCountsByExtension: {} },
    verification: { totalCount: 0, failureCount: 0, countsByKind: {} },
  } as unknown as RunSnapshot;
}

function pricingMap(): Map<string, ModelPricingRecord[]> {
  return new Map([['model-a', [{ id: 'model-a', provider: 'provider-a', pricing: { input: 2, output: 6, cacheRead: 0, cacheWrite: 0 } }]]]);
}

function pricingCatalog(signature: string, map: Map<string, ModelPricingRecord[]>): PricingCatalog {
  return { signature, map };
}

interface Harness {
  cache: CompletedHistoryCache;
  persistedQueries: () => number;
  bumpMtime: () => void;
  append: (run: RunSnapshot) => Promise<void>;
  readPersisted: () => Promise<{ completedRuns: RunSnapshot[]; openRuns: RunSnapshot[] }>;
}

/** Build one cache harness. `mode` forces the reload path exercised by each
 *  step: `incremental` reports real growing sizes (suffix parse), `rewrite`
 *  reports a constant size with a bumped mtime (full reload every step). */
async function createHarness(storageDir: string, mode: 'incremental' | 'rewrite'): Promise<Harness> {
  const snapshotsPath = path.join(storageDir, 'run-snapshots.jsonl');
  await fs.mkdir(storageDir, { recursive: true });
  let mtime = 100;
  let persistedQueries = 0;
  const readPersisted = async (): Promise<{ completedRuns: RunSnapshot[]; openRuns: RunSnapshot[] }> => {
    persistedQueries += 1;
    try {
      const content = await fs.readFile(snapshotsPath, 'utf8');
      const completedRuns = content.split('\n').flatMap((line) => {
        if (!line.trim()) return [];
        try {
          const parsed = JSON.parse(line) as { kind?: unknown; run?: unknown };
          if (parsed.kind !== 'run_snapshot') return [];
          const snapshot = coerceRunSnapshot(parsed.run);
          return snapshot ? [snapshot] : [];
        } catch {
          return [];
        }
      });
      return { completedRuns, openRuns: [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { completedRuns: [], openRuns: [] };
      throw error;
    }
  };
  const source: CompletedHistorySource = {
    getStorageDir: () => storageDir,
    queryPersistedRunAnalytics: readPersisted,
  };
  const stat = async (): Promise<{ mtimeMs: number; size: number }> => {
    if (mode === 'rewrite') return { mtimeMs: mtime, size: 1 };
    try {
      const real = await fs.stat(snapshotsPath);
      return { mtimeMs: mtime, size: real.size };
    } catch {
      return { mtimeMs: -1, size: -1 };
    }
  };
  const cache = new CompletedHistoryCache({
    source,
    mtimeFn: (_statPath, cb) => {
      void stat().then(
        (value) => cb(null, value),
        (err) => cb(err as NodeJS.ErrnoException, { mtimeMs: -1, size: -1 }),
      );
    },
  });
  return {
    cache,
    persistedQueries: () => persistedQueries,
    bumpMtime: () => { mtime += 1; },
    append: async (run) => {
      await fs.appendFile(snapshotsPath, `${serializeJsonLine({
        schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
        kind: 'run_snapshot',
        recordedAt: run.updatedAt,
        run,
      })}\n`, 'utf8');
    },
    readPersisted,
  };
}

test('completed-history cache: incremental ingestion stays in parity with full reloads', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-completed-history-parity-'));
  try {
    const incrementalDir = path.join(tempDir, 'incremental');
    const rewriteDir = path.join(tempDir, 'rewrite');
    const incremental = await createHarness(incrementalDir, 'incremental');
    const rewrite = await createHarness(rewriteDir, 'rewrite');
    const pricing = pricingCatalog('pricing-1', pricingMap());
    const noPending = new Set<string>();
    const nowMs = NOW;

    const compare = (pendingRunIds: ReadonlySet<string>, label: string): void => {
      const layerA = incremental.cache.ensureLayer(nowMs, { force: true });
      const layerB = rewrite.cache.ensureLayer(nowMs, { force: true });
      assert.deepEqual(layerB, layerA, label);
      assert.deepEqual([...rewrite.cache.completedRunIds].sort(), [...incremental.cache.completedRunIds].sort(), label);
    };

    // First refresh: both full-reload from the authoritative query.
    const run1 = validSnapshot('parity-r1', new Date(NOW - 86_400_000).toISOString(), 10);
    await incremental.append(run1);
    await rewrite.append(run1);
    incremental.bumpMtime();
    rewrite.bumpMtime();
    assert.equal((await incremental.cache.refresh(pricing, noPending)).rebuilt, true);
    await rewrite.cache.refresh(pricing, noPending);
    compare(noPending, 'after initial full load');

    // Appends take the incremental path on one side and full reload on the other.
    const run2 = validSnapshot('parity-r2', new Date(NOW - 3_600_000).toISOString(), 20);
    await incremental.append(run2);
    await rewrite.append(run2);
    incremental.bumpMtime();
    rewrite.bumpMtime();
    assert.equal((await incremental.cache.refresh(pricing, noPending)).rebuilt, true);
    await rewrite.cache.refresh(pricing, noPending);
    compare(noPending, 'after incremental append');
    assert.ok(incremental.persistedQueries() === 1, 'incremental ingestion must not re-query persisted analytics');

    // A pending override excludes the run from the completed accumulator.
    const pending = new Set([run2.runId]);
    const rebuiltPending = (await incremental.cache.refresh(pricing, pending)).rebuilt;
    assert.equal(rebuiltPending, true, 'changing the pending-override key rebuilds the completed accumulator');
    await rewrite.cache.refresh(pricing, pending);
    compare(pending, 'with pending override');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('completed-history cache: pricing signature change rebuilds without double counting', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-completed-history-pricing-'));
  try {
    const storageDir = path.join(tempDir, 'history');
    const harness = await createHarness(storageDir, 'incremental');
    const run = validSnapshot('pricing-r1', new Date(NOW - 3_600_000).toISOString(), 1_000_000);
    await harness.append(run);
    harness.bumpMtime();
    const noPending = new Set<string>();
    const pricingA = pricingCatalog('pricing-a', pricingMap());
    await harness.cache.refresh(pricingA, noPending);
    const layerA = harness.cache.ensureLayer(NOW, { force: true });

    // Same content under a new signature: rebuild happens, totals are stable.
    const pricingB = pricingCatalog('pricing-b', pricingMap());
    const rebuilt = (await harness.cache.refresh(pricingB, noPending)).rebuilt;
    assert.equal(rebuilt, true, 'a pricing signature change must rebuild the completed accumulator');
    const layerB = harness.cache.ensureLayer(NOW, { force: true });
    assert.deepEqual(layerB, layerA, 'rebuilding with identical rates preserves totals exactly');

    // Re-preparation without force and without key/date change reuses the layer.
    const layerReused = harness.cache.ensureLayer(NOW);
    assert.equal(layerReused, layerB, 'unchanged keys must reuse the prepared completed layer');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('completed-history cache: rewritten (shrinking) history falls back to a full reload', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-completed-history-prune-'));
  try {
    const storageDir = path.join(tempDir, 'history');
    const snapshotsPath = path.join(storageDir, 'run-snapshots.jsonl');
    const harness = await createHarness(storageDir, 'incremental');
    const noPending = new Set<string>();
    const pricing = pricingCatalog('pricing-1', pricingMap());
    await harness.append(validSnapshot('prune-r1', new Date(NOW - 86_400_000).toISOString(), 5));
    harness.bumpMtime();
    await harness.cache.refresh(pricing, noPending);

    // Inflate the file so the retention rewrite below is unambiguously smaller.
    await fs.appendFile(snapshotsPath, `${' '.repeat(4096)}\n`, 'utf8');
    harness.bumpMtime();
    await harness.cache.refresh(pricing, noPending);

    // Retention prune rewrites the file atomically: size shrinks under a new mtime.
    const kept = validSnapshot('prune-r1-kept', new Date(NOW - 3_600_000).toISOString(), 7);
    await fs.writeFile(snapshotsPath, `${serializeJsonLine({
      schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
      kind: 'run_snapshot',
      recordedAt: kept.updatedAt,
      run: kept,
    })}\n`, 'utf8');
    harness.bumpMtime();
    const rebuilt = (await harness.cache.refresh(pricing, noPending)).rebuilt;
    assert.equal(rebuilt, true, 'a rewritten history must rebuild the completed accumulator');
    assert.deepEqual([...harness.cache.completedRunIds], ['prune-r1-kept'], 'the pruned run id must not survive the cache');
    const layer = harness.cache.ensureLayer(NOW, { force: true });
    assert.ok(layer.accumulator, 'the reloaded accumulator must be usable for layer preparation');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});