import { randomBytes, randomUUID } from 'node:crypto';

import type { LivePipelineTraceEvent } from '../shared/live-pipeline-trace.js';
import { LivePipelineTraceStore } from '../shared/live-pipeline-trace-store.js';

const key = process.env.PIE_LIVE_PIPELINE_TRACE_KEY?.trim() || randomBytes(32).toString('base64url');
const runId = process.env.PIE_LIVE_PIPELINE_TRACE_RUN_ID?.trim() || randomUUID();
const store = new LivePipelineTraceStore({
  enabled: process.env.PI_DIAG === '1',
  process: 'backend',
  traceRunId: runId,
  hmacKey: key,
  fileName: 'live-pipeline-backend.jsonl',
});
let flushTimer: ReturnType<typeof setTimeout> | undefined;

export function isBackendLivePipelineTraceEnabled(): boolean { return store.isEnabled(); }
export function setBackendLivePipelineTraceEnabled(value: boolean): boolean {
  store.setEnabled(value);
  if (!value) void flushBackendLivePipelineTrace();
  return value;
}
export function recordBackendLivePipelineTrace(event: Omit<LivePipelineTraceEvent, 'process'>): boolean {
  const recorded = store.record({ ...event, process: 'backend' });
  if (recorded && flushTimer === undefined) {
    flushTimer = setTimeout(() => { flushTimer = undefined; void store.flush(); }, 100);
    flushTimer.unref?.();
  }
  return recorded;
}
export async function flushBackendLivePipelineTrace(): Promise<void> {
  if (flushTimer !== undefined) { clearTimeout(flushTimer); flushTimer = undefined; }
  await store.flush();
}
export function getBackendLivePipelineTraceHealth() { return store.getHealth(); }
export function getBackendLivePipelineTracePath(): string { return store.getFilePath(); }
