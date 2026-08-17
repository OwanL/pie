/**
 * Tiny cross-loader instrumentation bridge. Pi loads extensions through jiti,
 * so importing the backend trace store directly from an extension would create
 * a second store (and would couple the extension package to backend internals).
 * A global symbol keeps the sink process-local while the event remains a
 * closed, metadata-only shape.
 */
import type {
  LivePipelineTraceAvailabilityReason,
  LivePipelineTraceDetailDelivery,
  LivePipelineTraceOutcome,
  LivePipelineTracePayloadClass,
} from './live-pipeline-trace.js';

export type RuntimeTracePhase =
  | 'source_update'
  | 'dedupe'
  | 'clone'
  | 'json_safe_normalization'
  | 'recursive_projection'
  | 'diff'
  | 'measure'
  | 'serialize'
  | 'terminal';

export interface RuntimeTraceEvent {
  phase: RuntimeTracePhase;
  /** Optional semantic-change/dedupe result from the producer. */
  outcome?: LivePipelineTraceOutcome;
  durationMs?: number;
  sourcePayloadBytes?: number;
  producedPayloadBytes?: number;
  childCount?: number;
  messageCount?: number;
  maxRecursiveDepth?: number;
  payloadClass?: LivePipelineTracePayloadClass;
  /** Reserved and optional: no current producer emits detail deliveries. */
  detailDelivery?: LivePipelineTraceDetailDelivery;
  availabilityReason?: LivePipelineTraceAvailabilityReason;
  identifiers?: {
    session?: string;
    request?: string;
    turn?: string;
    attempt?: string;
    tool?: string;
  };
}

type RuntimeTraceSink = (event: RuntimeTraceEvent) => void;
const RUNTIME_TRACE_SINK = Symbol.for('pie.runtime-trace-sink.v1');

type RuntimeTraceGlobal = typeof globalThis & {
  [RUNTIME_TRACE_SINK]?: RuntimeTraceSink;
};

export function installRuntimeTraceSink(sink: RuntimeTraceSink | undefined): void {
  const target = globalThis as RuntimeTraceGlobal;
  if (sink) target[RUNTIME_TRACE_SINK] = sink;
  else delete target[RUNTIME_TRACE_SINK];
}

export function recordRuntimeTrace(event: RuntimeTraceEvent): void {
  try {
    (globalThis as RuntimeTraceGlobal)[RUNTIME_TRACE_SINK]?.(event);
  } catch {
    // Instrumentation must never affect runtime liveness or extension behavior.
  }
}
