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

const DIAG_PATH = path.join(os.tmpdir(), 'pie-diag.jsonl');
const FLUSH_INTERVAL_MS = 1000;

let enabled = process.env.PI_DIAG === '1';
let timer: ReturnType<typeof setInterval> | undefined;

interface Window {
  deltas: number;
  thinking: number;
  snapshotPosts: number;
  ackLatencies: number[];
  wdResnapshot: number;
  wdThrottled: number;
  wdReload: number;
}

let current: Window = emptyWindow();

function emptyWindow(): Window {
  return { deltas: 0, thinking: 0, snapshotPosts: 0, ackLatencies: [], wdResnapshot: 0, wdThrottled: 0, wdReload: 0 };
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
  timer = setInterval(flush, FLUSH_INTERVAL_MS);
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

function flush(): void {
  const w = current;
  current = emptyWindow();
  const activity =
    w.deltas + w.thinking + w.snapshotPosts + w.ackLatencies.length + w.wdResnapshot + w.wdThrottled + w.wdReload;
  if (activity === 0) {
    return; // idle second — skip to keep output focused on streaming
  }

  const record = {
    ts: new Date().toISOString(),
    windowMs: FLUSH_INTERVAL_MS,
    deltas: w.deltas,
    thinking: w.thinking,
    snapshotPosts: w.snapshotPosts,
    ackCount: w.ackLatencies.length,
    ackMin: w.ackLatencies.length ? Math.min(...w.ackLatencies) : null,
    ackP50: w.ackLatencies.length ? pct(w.ackLatencies, 50) : null,
    ackP95: w.ackLatencies.length ? pct(w.ackLatencies, 95) : null,
    ackMax: w.ackLatencies.length ? Math.max(...w.ackLatencies) : null,
    wdResnapshot: w.wdResnapshot,
    wdThrottled: w.wdThrottled,
    wdReload: w.wdReload,
  };

  pieDebug('stream-telemetry', 'diagnostic snapshot', record);
  try {
    fsSync.mkdirSync(path.dirname(DIAG_PATH), { recursive: true });
    fsSync.appendFileSync(DIAG_PATH, `${JSON.stringify(record)}\n`, 'utf8');
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
  current.ackLatencies.push(latencyMs);
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
