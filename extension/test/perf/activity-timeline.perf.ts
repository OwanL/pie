/**
 * ActivityTimeline amplification benchmark for pie.
 *
 * Builds a synthetic legacy activity-intervals.json with 222,907 records in a
 * temporary directory (never the real analytics store), then measures:
 *
 *   - Cold synchronous load (compatibility fallback) duration + bytes read
 *   - initialize() warm-up duration, bytes read, and yield behavior
 *   - Warm start/settle/recordMany mutation durations + journal bytes
 *   - Cached projection duration (signature-gated fast path)
 *   - One explicit async compaction (full snapshot rewrite) for cost contrast
 *   - Two alternating hosts on the large warmed base: sibling journal appends
 *     must cost only incremental tail-replay bytes, never a snapshot reread
 *
 * Event-loop delay is isolated PER STAGE: the monitor is enabled only after
 * fixture generation (and retained-fixture release) so GC retention from
 * building the 222k-record payload cannot pollute lifecycle measurements, and
 * it is reset before each stage so the intentional synchronous compatibility
 * fallback and the intentional 20×(start+settle) sync burst are reported as
 * their own labeled buckets instead of inflating the async lifecycles.
 *
 * Run from the repository root: npm run perf:activity-timeline
 * (or: node scripts/run-test-files.mjs extension/test/perf/activity-timeline.perf.ts)
 *
 * Not swept by `npm test` (file is *.perf.ts), so it never runs in CI.
 * Structural assertions below DO fail the process when limits are breached.
 * Writes a timestamped JSON report under the OS temporary directory.
 */

import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';

import { ActivityTimeline } from '../../src/host/activity-timeline/service';
import type { ActivityIntervalRecord } from '../../src/shared/activity-interval';

const RECORD_COUNT = 222_907;
const SESSION_POOL = 512;

function syntheticRecord(index: number): ActivityIntervalRecord {
  return {
    schemaVersion: 1,
    intervalId: `activity:invocation:inv-${index}`,
    sessionId: `session-${index % SESSION_POOL}`,
    sessionPath: `/workspace/sessions/session-${index % SESSION_POOL}.jsonl`,
    parentRunId: `run-${Math.floor(index / 8)}`,
    parentOperationId: `operation-${Math.floor(index / 4)}`,
    invocationId: `inv-${index}`,
    toolId: null,
    kind: index % 8 === 0 ? 'auxiliary' : 'provider',
    startedAt: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
    endedAt: new Date(1_700_000_000_000 + index * 1_000 + 500).toISOString(),
    outcome: 'succeeded',
  };
}

function delta(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(after)) {
    const prior = before[key];
    if (typeof prior === 'number') result[key] = value - prior;
  }
  return result;
}

async function main(): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-activity-timeline-perf-'));
  const reportsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-activity-timeline-report-'));
  try {
    console.log(`Generating ${RECORD_COUNT.toLocaleString()} synthetic records...`);
    const generateStart = performance.now();
    const records = Array.from({ length: RECORD_COUNT }, (_, index) => syntheticRecord(index));
    const payload = `${JSON.stringify(records, null, 2)}\n`;
    const snapshotPath = path.join(directory, 'activity-intervals.json');
    fs.writeFileSync(snapshotPath, payload, 'utf8');
    const snapshotBytes = Buffer.byteLength(payload, 'utf8');
    // Release the retained fixture objects before enabling the event-loop
    // monitor so fixture-generation GC retention cannot pollute the stages.
    records.length = 0;
    if (typeof (globalThis as { gc?: () => void }).gc === 'function') {
      (globalThis as { gc?: () => void }).gc?.();
    }
    console.log(`Snapshot: ${(snapshotBytes / 1_048_576).toFixed(1)} MiB in ${(performance.now() - generateStart).toFixed(0)}ms`);

    const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
    eventLoopDelay.enable();
    try {
      const loopMaxMs = (): number => eventLoopDelay.max / 1e6;

      // --- Cold synchronous load (intentional compatibility fallback) ---
      eventLoopDelay.reset();
      const cold = new ActivityTimeline(snapshotPath);
      const coldStart = performance.now();
      const coldRecords = cold.projectAll();
      const coldDuration = performance.now() - coldStart;
      const coldDiag = cold.getDiagnostics();
      const coldLoopMaxMs = loopMaxMs();
      assert.equal(coldRecords.length, RECORD_COUNT);
      console.log(`Cold sync load (intentional sync fallback): ${coldDuration.toFixed(0)}ms, read=${coldDiag.bytesRead}B, reads=${coldDiag.readCount}, fsync=${coldDiag.fsyncCount}, eventLoopMax=${coldLoopMaxMs.toFixed(1)}ms`);

      // --- Async warm-up with bounded yields ---
      const warm = new ActivityTimeline(snapshotPath);
      let yields = 0;
      let ticking = true;
      const tick = (): void => {
        if (!ticking) return;
        yields += 1;
        setImmediate(tick);
      };
      setImmediate(tick);
      eventLoopDelay.reset();
      const initStart = performance.now();
      const initialization = warm.initialize();
      const interleaveStart = performance.now();
      await initialization;
      const initDuration = performance.now() - initStart;
      const interleaveDelay = performance.now() - interleaveStart;
      const initLoopMaxMs = loopMaxMs();
      ticking = false;
      const initDiag = warm.getDiagnostics();
      console.log(`initialize(): ${initDuration.toFixed(0)}ms, read=${initDiag.bytesRead}B, reads=${initDiag.readCount}, yields observed=${yields}, eventLoopMax=${initLoopMaxMs.toFixed(1)}ms`);

      // --- Warm cached projection ---
      eventLoopDelay.reset();
      const cachedStart = performance.now();
      assert.equal(warm.projectAll().length, RECORD_COUNT);
      const cachedDuration = performance.now() - cachedStart;
      const cachedLoopMaxMs = loopMaxMs();
      const cachedDiag = warm.getDiagnostics();
      console.log(`Cached projection: ${cachedDuration.toFixed(2)}ms, revalidation hits=${cachedDiag.cacheRevalidationHits}, reads=${cachedDiag.readCount}, eventLoopMax=${cachedLoopMaxMs.toFixed(2)}ms`);

      // --- Warm routine mutations: intentional synchronous burst ---
      const mutationCount = 20;
      eventLoopDelay.reset();
      const beforeMutations = warm.getDiagnostics();
      const mutationStart = performance.now();
      for (let index = 0; index < mutationCount; index += 1) {
        const intervalId = `live-busy-${index}`;
        warm.start({
          schemaVersion: 1,
          intervalId,
          sessionId: 'session-live',
          sessionPath: '/workspace/sessions/session-live.jsonl',
          parentRunId: 'run-live',
          parentOperationId: 'operation-live',
          invocationId: null,
          toolId: null,
          kind: 'busy',
          startedAt: new Date().toISOString(),
        }, { durableRequired: true });
        warm.settle(intervalId, new Date().toISOString(), 'succeeded');
      }
      const mutationDuration = performance.now() - mutationStart;
      const mutationsLoopMaxMs = loopMaxMs();
      const afterMutations = warm.getDiagnostics();
      const mutationDelta = delta(beforeMutations, afterMutations);
      assert.equal(mutationDelta.writeCount, 0, 'routine mutations must not rewrite the snapshot');
      assert.ok(mutationDelta.journalAppendedBytes < 2_000 * mutationCount,
        `journal appends must stay small, saw ${mutationDelta.journalAppendedBytes}`);
      assert.equal(afterMutations.applyMutationsCount - beforeMutations.applyMutationsCount, 2 * mutationCount);
      assert.ok(mutationDelta.bytesWritten > 0, 'routine journal appends count into total written IO');
      console.log(`Warm mutations (intentional sync burst, ${mutationCount}× start+settle): ${mutationDuration.toFixed(2)}ms total (${(mutationDuration / mutationCount).toFixed(2)}ms each), journal bytes=${mutationDelta.journalAppendedBytes}, bytesWritten=${mutationDelta.bytesWritten}, fsync=${mutationDelta.fsyncCount} (${mutationDelta.fsyncDurationMs.toFixed(0)}ms), snapshot writes=${mutationDelta.writeCount}, applyMutations=${mutationDelta.applyMutationsDurationMs.toFixed(0)}ms, eventLoopMax=${mutationsLoopMaxMs.toFixed(1)}ms`);

      // --- Explicit async compaction (full canonical rewrite) for contrast ---
      eventLoopDelay.reset();
      const beforeCompaction = warm.getDiagnostics();
      const compactionStart = performance.now();
      assert.equal(await warm.compact(), true);
      const compactionDuration = performance.now() - compactionStart;
      const compactionLoopMaxMs = loopMaxMs();
      const afterCompaction = warm.getDiagnostics();
      const compactionDelta = delta(beforeCompaction, afterCompaction);
      console.log(`Async compaction rewrite: ${compactionDuration.toFixed(0)}ms, bytesWritten=${compactionDelta.bytesWritten} (snapshot=${compactionDelta.snapshotBytesWritten}), fsync=${compactionDelta.fsyncCount}, writes=${compactionDelta.writeCount}, eventLoopMax=${compactionLoopMaxMs.toFixed(1)}ms`);
      assert.equal(warm.projectAll().length, RECORD_COUNT + mutationCount);

      // --- Two alternating hosts on the large warmed base: tail-only reads ---
      const sibling = new ActivityTimeline(snapshotPath);
      eventLoopDelay.reset();
      const siblingInitStart = performance.now();
      await sibling.initialize();
      const siblingInitDuration = performance.now() - siblingInitStart;
      const siblingInitLoopMaxMs = loopMaxMs();
      assert.equal(sibling.projectAll().length, RECORD_COUNT + mutationCount);
      // Absorb the first journal-creation observation (full reload) outside
      // the measured window, then alternate appends between the two hosts.
      warm.start({
        schemaVersion: 1,
        intervalId: 'tail-seed',
        sessionId: 'session-live',
        sessionPath: '/workspace/sessions/session-live.jsonl',
        parentRunId: 'run-live',
        parentOperationId: 'operation-live',
        invocationId: null,
        toolId: null,
        kind: 'busy',
        startedAt: new Date().toISOString(),
      }, { durableRequired: true });
      assert.equal(sibling.projectAll().length, RECORD_COUNT + mutationCount + 1);
      const beforeSibling = sibling.getDiagnostics();
      const alternateRounds = 20;
      eventLoopDelay.reset();
      const alternateStart = performance.now();
      for (let index = 0; index < alternateRounds; index += 1) {
        const intervalId = `alternate-${index}`;
        warm.start({
          schemaVersion: 1,
          intervalId,
          sessionId: 'session-live',
          sessionPath: '/workspace/sessions/session-live.jsonl',
          parentRunId: 'run-live',
          parentOperationId: 'operation-live',
          invocationId: null,
          toolId: null,
          kind: 'busy',
          startedAt: new Date().toISOString(),
        }, { durableRequired: true });
        assert.equal(sibling.projectAll().length, RECORD_COUNT + mutationCount + 2 + 2 * index,
          'sibling observes each append');
        sibling.start({
          schemaVersion: 1,
          intervalId: `sibling-${index}`,
          sessionId: 'session-sibling',
          sessionPath: '/workspace/sessions/session-sibling.jsonl',
          parentRunId: 'run-sibling',
          parentOperationId: 'operation-sibling',
          invocationId: null,
          toolId: null,
          kind: 'busy',
          startedAt: new Date().toISOString(),
        }, { durableRequired: true });
        assert.equal(warm.projectAll().length, RECORD_COUNT + mutationCount + 3 + 2 * index,
          'warm host observes the sibling append');
      }
      const alternateDuration = performance.now() - alternateStart;
      const alternateLoopMaxMs = loopMaxMs();
      const afterSibling = sibling.getDiagnostics();
      const siblingDelta = delta(beforeSibling, afterSibling);
      assert.ok(siblingDelta.journalTailReplayCount >= alternateRounds,
        'sibling appends are observed via incremental tail replays');
      assert.equal(siblingDelta.journalTailReplayCount, siblingDelta.readCount,
        'every sibling reload in the measured window is a tail replay');
      assert.equal(siblingDelta.bytesRead, siblingDelta.journalTailReplayedBytes,
        'tail bytes are the only sibling reads');
      assert.ok(siblingDelta.bytesRead < 100_000,
        `sibling reads must stay tail-bounded, saw ${siblingDelta.bytesRead} bytes for a ${(snapshotBytes / 1_048_576).toFixed(0)} MiB base`);
      console.log(`Alternating hosts (${alternateRounds} rounds): ${alternateDuration.toFixed(0)}ms total, sibling tail replays=${siblingDelta.journalTailReplayCount}, sibling bytes read=${siblingDelta.bytesRead} (${((siblingDelta.bytesRead / snapshotBytes) * 100).toFixed(4)}% of snapshot), eventLoopMax=${alternateLoopMaxMs.toFixed(1)}ms`);
      console.log(`Sibling initialize(): ${siblingInitDuration.toFixed(0)}ms, eventLoopMax=${siblingInitLoopMaxMs.toFixed(1)}ms`);

      const longestAsyncLifecycleDelayMs = Math.max(initLoopMaxMs, compactionLoopMaxMs, alternateLoopMaxMs);
      const report = {
        timestamp: new Date().toISOString(),
        recordCount: RECORD_COUNT,
        snapshotBytes,
        eventLoop: {
          /** Per-stage isolated max event-loop delay. The cold sync load and
           *  the warm-mutation burst are intentional synchronous lifecycles
           *  (compatibility fallback and durability bursts) and are reported
           *  as their own buckets, never folded into the async lifecycles. */
          byStageMs: {
            coldSyncLoadIntentionalSyncFallback: coldLoopMaxMs,
            initialize: initLoopMaxMs,
            cachedProjection: cachedLoopMaxMs,
            warmMutationsIntentionalSyncBurst: mutationsLoopMaxMs,
            compaction: compactionLoopMaxMs,
            alternatingHosts: alternateLoopMaxMs,
            siblingInitialize: siblingInitLoopMaxMs,
          },
          /** The honest async-lifecycle figure: initialize, compaction, and
           *  sibling tail replays only. */
          longestAsyncLifecycleDelayMs,
        },
        coldSyncLoad: {
          durationMs: coldDuration,
          ...coldDiag,
        },
        initialize: {
          durationMs: initDuration,
          interleaveDelayMs: interleaveDelay,
          yieldsObserved: yields,
          ...initDiag,
        },
        cachedProjection: {
          durationMs: cachedDuration,
          revalidationHits: warm.getDiagnostics().cacheRevalidationHits,
        },
        warmMutations: {
          count: mutationCount,
          durationMs: mutationDuration,
          perMutationMs: mutationDuration / mutationCount,
          ...mutationDelta,
        },
        compaction: {
          durationMs: compactionDuration,
          rewriteCount: compactionDelta.writeCount,
          rewriteCounts: {
            canonicalSnapshot: compactionDelta.writeCount,
            journalCompaction: compactionDelta.journalCompactionCount,
          },
          ...compactionDelta,
        },
        alternatingHosts: {
          rounds: alternateRounds,
          durationMs: alternateDuration,
          siblingInitialize: {
            durationMs: siblingInitDuration,
          },
          siblingTailReplays: siblingDelta.journalTailReplayCount,
          siblingBytesRead: siblingDelta.bytesRead,
          siblingBytesReadShareOfSnapshot: siblingDelta.bytesRead / snapshotBytes,
          ...siblingDelta,
        },
      };

      const reportPath = path.join(reportsDirectory, `activity-timeline-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      console.log(`Report written to ${reportPath}`);
      console.log(`Longest async lifecycle event-loop delay (initialize/compaction/alternating): ${longestAsyncLifecycleDelayMs.toFixed(1)}ms`);
    } finally {
      eventLoopDelay.disable();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});