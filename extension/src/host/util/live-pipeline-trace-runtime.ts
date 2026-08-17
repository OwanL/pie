import { randomBytes, randomUUID } from 'node:crypto';

import type { LivePipelineTraceEvent } from '../../shared/live-pipeline-trace.js';
import { LivePipelineTraceStore } from '../../shared/live-pipeline-trace-store.js';

const FLUSH_DELAY_MS = 100;
const hmacKey = process.env.PIE_LIVE_PIPELINE_TRACE_KEY?.trim() || randomBytes(32).toString('base64url');
const traceRunId = process.env.PIE_LIVE_PIPELINE_TRACE_RUN_ID?.trim() || randomUUID();
const store = new LivePipelineTraceStore({
  enabled: process.env.PI_DIAG === '1',
  process: 'host',
  traceRunId,
  hmacKey,
  fileName: 'live-pipeline-host.jsonl',
  directory: process.env.PIE_LIVE_PIPELINE_TRACE_DIR?.trim() || undefined,
});
let flushTimer: ReturnType<typeof setTimeout> | undefined;

export function isLivePipelineTraceEnabled(): boolean { return store.isEnabled(); }
export function setLivePipelineTraceEnabled(value: boolean): boolean {
  store.setEnabled(value);
  if (!value) void flushLivePipelineTrace();
  return value;
}
export function recordLivePipelineTrace(event: LivePipelineTraceEvent): boolean {
  const recorded = store.record(event);
  if (recorded && flushTimer === undefined) {
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void store.flush();
    }, FLUSH_DELAY_MS);
    flushTimer.unref?.();
  }
  return recorded;
}
export async function flushLivePipelineTrace(): Promise<void> {
  if (flushTimer !== undefined) { clearTimeout(flushTimer); flushTimer = undefined; }
  await store.flush();
}
export async function disposeLivePipelineTrace(): Promise<void> { await flushLivePipelineTrace(); }
export function getLivePipelineTraceHealth() { return store.getHealth(); }
export function getLivePipelineTracePath(): string { return store.getFilePath(); }
/** Passed only through the child environment; never written to logs/traces. */
export function getLivePipelineTraceHmacKey(): string { return hmacKey; }
export function getLivePipelineTraceRunId(): string { return traceRunId; }
