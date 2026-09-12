/**
 * Lightweight streaming-transport diagnostic. Off by default; zero cost when
 * disabled (all record* calls short-circuit).
 *
 * Toggle at runtime via the `pie.toggleStreamDiag` command, or enable at launch
 * with the `PI_DIAG=1` environment variable.
 *
 * Captures, per 1s window during active streaming:
 *  - delta/thinking event rate (model throughput from the backend)
 *  - state-snapshot post rate (host→webview `state` messages)
 *  - ack latency (ms from a `state` post being delivered to the webview
 *    acknowledging it applied the revision)
 *  - watchdog events (resnapshot / throttled / reload) — the force-reload path
 *
 * Output: one JSON line per active second to `pie-diag.jsonl` in the OS temp dir
 * AND to the unified pie logger at debug level (`[pie][debug][stream-telemetry]`).
 *
 * Interpretation:
 *  - high stream-event rate + watchdog events / high ack latency
 *      ⇒ host↔webview transport is overloaded (apply R1–R4)
 *  - low stream-event rate even for prompts that should stream fast
 *      ⇒ model provider / thinking level, not the UI link
 */
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { pieDebug } from './pie-logger.js';

const DIAG_PATH = process.env['NODE_TEST_CONTEXT']
  ? path.join(os.tmpdir(), 'pie-test-logs', `process-${process.pid}`, 'pie-diag.jsonl')
  : path.join(os.tmpdir(), 'pie-diag.jsonl');
const FLUSH_INTERVAL_MS = 1000;
const MAX_DIAG_LOG_BYTES = 5 * 1024 * 1024;
const MAX_ACK_SAMPLES_PER_WINDOW = 4096;

let enabled = process.env.PI_DIAG === '1';
let timer: ReturnType<typeof setInterval> | undefined;

interface Window {
  deltas: number;
  thinking: number;
  snapshotPosts: number;
  ackLatencies: number[];
  ackCount: number;
  ackSamplesDropped: number;
  ackSampleCursor: number;
  ackMin: number | null;
  ackMax: number | null;
  wdResnapshot: number;
  wdThrottled: number;
  wdReload: number;
}

let current: Window = emptyWindow();

function emptyWindow(): Window {
  return {
    deltas: 0,
    thinking: 0,
    snapshotPosts: 0,
    ackLatencies: [],
    ackCount: 0,
    ackSamplesDropped: 0,
    ackSampleCursor: 0,
    ackMin: null,
    ackMax: null,
    wdResnapshot: 0,
    wdThrottled: 0,
    wdReload: 0,
  };
}

export function isStreamDiagEnabled(): boolean {
  return enabled;
}

export function setStreamDiagEnabled(value: boolean): boolean {
  enabled = value;
  if (enabled) {
    ensureTimer();
  } else if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
  return enabled;
}

function ensureTimer(): void {
  if (timer !== undefined) {
    return;
  }
  timer = setInterval(flushStreamDiag, FLUSH_INTERVAL_MS);
  // Never keep the extension host alive solely for diagnostics.
  timer.unref?.();
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) {
    return 0;
  }
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/** Flush the current diagnostic window immediately (also used on orderly shutdown and in tests). */
export function flushStreamDiag(): void {
  const w = current;
  current = emptyWindow();
  const activity =
    w.deltas + w.thinking + w.snapshotPosts + w.ackCount + w.wdResnapshot + w.wdThrottled + w.wdReload;
  if (activity === 0) {
    return; // idle second — skip to keep output focused on streaming
  }

  const record = {
    ts: new Date().toISOString(),
    windowMs: FLUSH_INTERVAL_MS,
    deltas: w.deltas,
    thinking: w.thinking,
    snapshotPosts: w.snapshotPosts,
    // ackCount/min/max cover every observed sample. Percentiles use the
    // bounded retained tail; the explicit counters make dropped samples clear.
    ackCount: w.ackCount,
    ackSamplesRetained: w.ackLatencies.length,
    ackSamplesDropped: w.ackSamplesDropped,
    ackMin: w.ackMin,
    ackP50: w.ackLatencies.length ? pct(w.ackLatencies, 50) : null,
    ackP95: w.ackLatencies.length ? pct(w.ackLatencies, 95) : null,
    ackMax: w.ackMax,
    wdResnapshot: w.wdResnapshot,
    wdThrottled: w.wdThrottled,
    wdReload: w.wdReload,
  };

  pieDebug('stream-telemetry', 'diagnostic snapshot', record);
  try {
    fsSync.mkdirSync(path.dirname(DIAG_PATH), { recursive: true });
    rotateDiagIfNeeded();
    fsSync.appendFileSync(DIAG_PATH, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // Diagnostics must never affect extension behavior.
  }
}

/** Keep this opt-in diagnostic to the same 5 MiB + one-backup policy used by
 * the persistent Pie logger. A failed rotation never affects streaming. */
function rotateDiagIfNeeded(): void {
  try {
    const stat = fsSync.statSync(DIAG_PATH);
    if (stat.size < MAX_DIAG_LOG_BYTES) return;
    const backup = `${DIAG_PATH}.1`;
    fsSync.rmSync(backup, { force: true });
    fsSync.renameSync(DIAG_PATH, backup);
  } catch {
    // Diagnostics must never affect extension behavior.
  }
}

export function recordStreamEvent(kind: 'delta' | 'thinking'): void {
  if (!enabled) {
    return;
  }
  if (kind === 'delta') {
    current.deltas += 1;
  } else {
    current.thinking += 1;
  }
}

export function recordSnapshotPost(): void {
  if (!enabled) {
    return;
  }
  current.snapshotPosts += 1;
}

export function recordAckLatency(latencyMs: number): void {
  if (!enabled) {
    return;
  }
  current.ackCount += 1;
  current.ackMin = current.ackMin === null ? latencyMs : Math.min(current.ackMin, latencyMs);
  current.ackMax = current.ackMax === null ? latencyMs : Math.max(current.ackMax, latencyMs);
  if (current.ackLatencies.length < MAX_ACK_SAMPLES_PER_WINDOW) {
    current.ackLatencies.push(latencyMs);
    current.ackSampleCursor = current.ackLatencies.length % MAX_ACK_SAMPLES_PER_WINDOW;
    return;
  }
  // Retain a bounded, newest-window sample without allocating per event.
  current.ackLatencies[current.ackSampleCursor] = latencyMs;
  current.ackSampleCursor = (current.ackSampleCursor + 1) % MAX_ACK_SAMPLES_PER_WINDOW;
  current.ackSamplesDropped += 1;
}

export function recordWatchdog(kind: 'resnapshot' | 'throttled' | 'reload'): void {
  if (!enabled) {
    return;
  }
  if (kind === 'resnapshot') {
    current.wdResnapshot += 1;
  } else if (kind === 'throttled') {
    current.wdThrottled += 1;
  } else {
    current.wdReload += 1;
  }
}

export function getDiagPath(): string {
  return DIAG_PATH;
}
