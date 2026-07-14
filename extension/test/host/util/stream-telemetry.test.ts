import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

import {
  getDiagPath,
  isStreamDiagEnabled,
  recordAckLatency,
  recordSnapshotPost,
  recordStreamEvent,
  recordWatchdog,
  setStreamDiagEnabled,
} from '../../../src/host/util/stream-telemetry';

/**
 * stream-telemetry accumulates counts in module-level state and writes one JSON
 * line per active 1s flush window to the OS-temp-dir `pie-diag.jsonl` file. The
 * path is a module-load constant (`path.join(os.tmpdir(), 'pie-diag.jsonl')`)
 * with no env-var redirect, so tests exercise the real file and clean up after
 * themselves. `flush()` runs on an `unref()`ed 1s interval, so we drive it by
 * polling the file for new content rather than sleeping a fixed interval.
 */

const DIAG_PATH = getDiagPath();

interface DiagRecord {
  ts: string;
  windowMs: number;
  deltas: number;
  thinking: number;
  snapshotPosts: number;
  ackCount: number;
  ackMin: number | null;
  ackP50: number | null;
  ackP95: number | null;
  ackMax: number | null;
  wdResnapshot: number;
  wdThrottled: number;
  wdReload: number;
}

function clearDiagFile(): void {
  try {
    fs.writeFileSync(DIAG_PATH, '', 'utf8');
  } catch {
    // best effort — if the file is unwritable, record*-while-disabled tests still
    // exercise the no-throw contract.
  }
}

function removeDiagFile(): void {
  try {
    fs.rmSync(DIAG_PATH, { force: true });
  } catch {
    // ignore
  }
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Enable diagnostics, wait for one flush to drain any pre-existing window state
 * into the (then-cleared) file, then return a function that records events and
 * a function that drains the next flush and returns its record. This guarantees
 * the observed record contains exactly the events recorded between the two
 * flushes (no stale counts, no split-window loss).
 */
async function beginRecordingWindow(): Promise<{
  record: (fn: () => void) => void;
  drain: () => Promise<DiagRecord>;
}> {
  setStreamDiagEnabled(false);
  clearDiagFile();
  setStreamDiagEnabled(true);
  // Drain any pre-existing window state so it cannot contaminate the next window.
  for (let i = 0; i < 40; i++) {
    await wait(50);
    const txt = fs.readFileSync(DIAG_PATH, 'utf8').trim();
    if (txt.length > 0) {
      clearDiagFile();
      break;
    }
  }

  let recorded = false;
  return {
    record: (fn) => {
      // All record* calls must be synchronous and happen before the next 1s flush
      // so they land in a single window.
      fn();
      recorded = true;
    },
    drain: async () => {
      assert.ok(recorded, 'drain() called without record()');
      let txt = '';
      for (let i = 0; i < 40; i++) {
        await wait(50);
        txt = fs.readFileSync(DIAG_PATH, 'utf8').trim();
        if (txt.length > 0) break;
      }
      setStreamDiagEnabled(false);
      assert.ok(txt.length > 0, 'expected exactly one flushed diagnostic record');
      const lines = txt.split('\n').filter((l) => l.length > 0);
      assert.equal(lines.length, 1, 'exactly one record per active flush window');
      return JSON.parse(lines[lines.length - 1]) as DiagRecord;
    },
  };
}

test('enable/disable toggle round-trips and getDiagPath returns a stable absolute path', () => {
  // Disable first to establish a known state regardless of PI_DIAG env.
  setStreamDiagEnabled(false);
  assert.equal(isStreamDiagEnabled(), false);

  setStreamDiagEnabled(true);
  assert.equal(isStreamDiagEnabled(), true);

  setStreamDiagEnabled(false);
  assert.equal(isStreamDiagEnabled(), false);

  // setStreamDiagEnabled returns the new state.
  assert.equal(setStreamDiagEnabled(true), true);
  assert.equal(setStreamDiagEnabled(false), false);
  setStreamDiagEnabled(false);

  // getDiagPath is a stable absolute path (module-load constant).
  const p1 = getDiagPath();
  const p2 = getDiagPath();
  assert.equal(p1, p2, 'getDiagPath is stable across calls');
  assert.ok(path.isAbsolute(p1), 'getDiagPath returns an absolute path');
  assert.ok(p1.endsWith('pie-diag.jsonl'), 'diagnostic file is pie-diag.jsonl');
});

test('counters accumulate per kind and the flushed record reports exact counts (no double-count, no lost increments)', async () => {
  const { record, drain } = await beginRecordingWindow();
  record(() => {
    // 7 deltas, 3 thinking events, 5 snapshot posts.
    for (let i = 0; i < 7; i++) recordStreamEvent('delta');
    for (let i = 0; i < 3; i++) recordStreamEvent('thinking');
    for (let i = 0; i < 5; i++) recordSnapshotPost();
  });
  const r = await drain();

  assert.equal(r.windowMs, 1000);
  assert.equal(r.deltas, 7, 'delta count equals recorded inputs');
  assert.equal(r.thinking, 3, 'thinking count equals recorded inputs');
  assert.equal(r.snapshotPosts, 5, 'snapshot post count equals recorded inputs');
  assert.equal(r.ackCount, 0, 'no acks recorded');
  assert.equal(r.wdResnapshot, 0);
  assert.equal(r.wdThrottled, 0);
  assert.equal(r.wdReload, 0);
});

test('ack latency recording reports exact count, min, p50, p95, and max', async () => {
  const { record, drain } = await beginRecordingWindow();
  record(() => {
    // Latencies chosen so p50 and p95 fall on distinct samples.
    recordAckLatency(10);
    recordAckLatency(20);
    recordAckLatency(30);
    recordAckLatency(100);
  });
  const r = await drain();

  assert.equal(r.ackCount, 4, 'ack count equals recorded inputs');
  assert.equal(r.ackMin, 10, 'min latency');
  assert.equal(r.ackMax, 100, 'max latency');
  // pct(): sorted=[10,20,30,100]; p50 idx=floor(0.5*4)=2 → 30; p95 idx=min(3,floor(0.95*4))=3 → 100
  assert.equal(r.ackP50, 30, 'p50 latency');
  assert.equal(r.ackP95, 100, 'p95 latency');
});

test('ack percentile handling for a single sample and for an empty window', async () => {
  // Single sample: min == p50 == p95 == max.
  {
    const { record, drain } = await beginRecordingWindow();
    record(() => {
      recordAckLatency(42);
    });
    const r = await drain();
    assert.equal(r.ackCount, 1);
    assert.equal(r.ackMin, 42);
    assert.equal(r.ackP50, 42);
    assert.equal(r.ackP95, 42);
    assert.equal(r.ackMax, 42);
  }
  // Two samples: p50 idx=floor(0.5*2)=1 → sorted[1]; p95 idx=min(1,floor(0.95*2))=1 → sorted[1].
  {
    const { record, drain } = await beginRecordingWindow();
    record(() => {
      recordAckLatency(5);
      recordAckLatency(500);
    });
    const r = await drain();
    assert.equal(r.ackCount, 2);
    assert.equal(r.ackMin, 5);
    assert.equal(r.ackMax, 500);
    assert.equal(r.ackP50, 500, 'p50 picks sorted[1] for two samples');
    assert.equal(r.ackP95, 500, 'p95 picks sorted[1] for two samples');
  }
});

test('watchdog kind tracking routes each kind to the correct field with exact counts', async () => {
  const { record, drain } = await beginRecordingWindow();
  record(() => {
    recordWatchdog('resnapshot');
    recordWatchdog('resnapshot');
    recordWatchdog('throttled');
    recordWatchdog('reload');
    recordWatchdog('reload');
    recordWatchdog('reload');
  });
  const r = await drain();

  assert.equal(r.wdResnapshot, 2, 'resnapshot count');
  assert.equal(r.wdThrottled, 1, 'throttled count');
  assert.equal(r.wdReload, 3, 'reload count');
  assert.equal(r.deltas, 0);
  assert.equal(r.snapshotPosts, 0);
  assert.equal(r.ackCount, 0);
});

test('disabled state short-circuits record* so no increments reach a flushed window', async () => {
  // Drain any stale window state first.
  setStreamDiagEnabled(false);
  clearDiagFile();
  setStreamDiagEnabled(true);
  for (let i = 0; i < 40; i++) {
    await wait(50);
    if (fs.readFileSync(DIAG_PATH, 'utf8').trim().length > 0) break;
  }
  clearDiagFile();
  setStreamDiagEnabled(false);
  assert.equal(isStreamDiagEnabled(), false);

  // Record a non-trivial set of events while disabled — none should increment `current`.
  recordStreamEvent('delta');
  recordStreamEvent('delta');
  recordStreamEvent('thinking');
  recordSnapshotPost();
  recordAckLatency(99);
  recordWatchdog('resnapshot');

  // Re-enable. The fresh window starts empty (disabled record* did not increment).
  // The next flush sees zero activity and is skipped, so NO record is written.
  clearDiagFile();
  setStreamDiagEnabled(true);
  let sawRecord = false;
  for (let i = 0; i < 30; i++) {
    await wait(50);
    if (fs.readFileSync(DIAG_PATH, 'utf8').trim().length > 0) {
      sawRecord = true;
      break;
    }
  }
  setStreamDiagEnabled(false);
  assert.equal(sawRecord, false, 'disabled record* calls must not produce a flushed record (no increments)');
});

test('record* calls do not throw when the diagnostic file is read-only / missing', async () => {
  // The module swallows all flush write errors; record* never touch the disk.
  // Removing the file and recording must not throw.
  removeDiagFile();
  setStreamDiagEnabled(false);
  assert.doesNotThrow(() => recordStreamEvent('delta'));
  assert.doesNotThrow(() => recordSnapshotPost());
  assert.doesNotThrow(() => recordAckLatency(1));
  assert.doesNotThrow(() => recordWatchdog('reload'));

  // Enabling with no writable file must also not throw (flush errors are swallowed).
  assert.doesNotThrow(() => setStreamDiagEnabled(true));
  await wait(50);
  assert.doesNotThrow(() => setStreamDiagEnabled(false));

  // getDiagPath is unaffected by file state.
  assert.ok(getDiagPath().endsWith('pie-diag.jsonl'));
});

// Clean up shared global file after the suite.
test('cleanup', async () => {
  setStreamDiagEnabled(false);
  removeDiagFile();
});