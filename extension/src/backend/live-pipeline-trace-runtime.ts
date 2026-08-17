import { randomBytes, randomUUID } from 'node:crypto';

import type { LivePipelineTraceEvent } from '../shared/live-pipeline-trace.js';
import { installRuntimeTraceSink, type RuntimeTraceEvent } from '../shared/runtime-trace-bridge.js';
import { LivePipelineTraceStore } from '../shared/live-pipeline-trace-store.js';

const key = process.env.PIE_LIVE_PIPELINE_TRACE_KEY?.trim() || randomBytes(32).toString('base64url');
const runId = process.env.PIE_LIVE_PIPELINE_TRACE_RUN_ID?.trim() || randomUUID();
const store = new LivePipelineTraceStore({
  enabled: process.env.PI_DIAG === '1',
  process: 'backend',
  traceRunId: runId,
  hmacKey: key,
  fileName: 'live-pipeline-backend.jsonl',
  directory: process.env.PIE_LIVE_PIPELINE_TRACE_DIR?.trim() || undefined,
});
let flushTimer: ReturnType<typeof setTimeout> | undefined;

export function isBackendLivePipelineTraceEnabled(): boolean { return store.isEnabled(); }
export function setBackendLivePipelineTraceEnabled(value: boolean): boolean {
  store.setEnabled(value);
  installRuntimeTraceSink(value ? recordRuntimeTraceEvent : undefined);
  if (!value) void flushBackendLivePipelineTrace();
  return value;
}
/**
 * Convert the cross-loader event to the shared trace contract without copying
 * arbitrary properties. In particular, no prompt, tool body, or recursive
 * payload is ever handed to the trace store.
 */
export function mapRuntimeTraceEvent(event: RuntimeTraceEvent): Omit<LivePipelineTraceEvent, 'process'> {
  const mapped: Omit<LivePipelineTraceEvent, 'process'> = {
    stage: 'backend.subagent',
    kind: 'observation',
    phase: event.phase,
    processRole: 'coordinator',
    pid: process.pid,
  };
  if (event.outcome !== undefined) mapped.outcome = event.outcome;
  if (event.durationMs !== undefined) mapped.durationMs = event.durationMs;
  if (event.sourcePayloadBytes !== undefined) mapped.sourcePayloadBytes = event.sourcePayloadBytes;
  if (event.producedPayloadBytes !== undefined) mapped.producedPayloadBytes = event.producedPayloadBytes;
  if (event.childCount !== undefined) mapped.childCount = event.childCount;
  if (event.messageCount !== undefined) mapped.messageCount = event.messageCount;
  if (event.maxRecursiveDepth !== undefined) mapped.maxRecursiveDepth = event.maxRecursiveDepth;
  if (event.payloadClass !== undefined) mapped.payloadClass = event.payloadClass;
  // No current producer emits detailDelivery. Preserve it only when an
  // actual producer supplies the optional field; never infer it from phase.
  if (event.detailDelivery !== undefined) mapped.detailDelivery = event.detailDelivery;
  if (event.availabilityReason !== undefined) mapped.availabilityReason = event.availabilityReason;
  if (event.identifiers !== undefined) mapped.identifiers = event.identifiers;
  return mapped;
}

function recordRuntimeTraceEvent(event: RuntimeTraceEvent): void {
  recordBackendLivePipelineTrace(mapRuntimeTraceEvent(event));
}

installRuntimeTraceSink(store.isEnabled() ? recordRuntimeTraceEvent : undefined);

let recordedPhase5DetailAvailability = false;
export function recordPhase5DetailAvailability(): void {
  if (recordedPhase5DetailAvailability || !store.isEnabled()) return;
  recordedPhase5DetailAvailability = true;
  for (const payloadClass of ['detail_baseline', 'detail_page', 'detail_delta', 'detail_terminal'] as const) {
    recordBackendLivePipelineTrace({
      stage: 'backend.subagent',
      kind: 'observation',
      phase: 'measure',
      payloadClass,
      detailSubscriberCount: 0,
      availabilityReason: 'detail_delivery_not_implemented_until_phase_5',
      processRole: 'coordinator',
      pid: process.pid,
    });
  }
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
/** Shared run identity for cross-process timeline merge (host passes the same value). */
export function getBackendLivePipelineTraceRunId(): string { return runId; }
/** Test/diagnostics seam mirroring the host runtime: the store HMAC key, so
 *  persisted records can be correlated back to exact identifiers. */
export function getBackendLivePipelineTraceHmacKey(): string { return key; }
