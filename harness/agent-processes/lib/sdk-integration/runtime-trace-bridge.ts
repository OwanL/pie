import type { RuntimeTraceEvent } from './runtime-trace-contract.js';

type RuntimeTraceSink = (event: RuntimeTraceEvent) => void;
const RUNTIME_TRACE_SINK = Symbol.for('pie.runtime-trace-sink.v1');

type RuntimeTraceGlobal = typeof globalThis & {
  [RUNTIME_TRACE_SINK]?: RuntimeTraceSink;
};

/** Install the process-local sink shared across Pi's independently loaded jiti modules. */
export function installRuntimeTraceSink(sink: RuntimeTraceSink | undefined): void {
  const target = globalThis as RuntimeTraceGlobal;
  if (sink) target[RUNTIME_TRACE_SINK] = sink;
  else delete target[RUNTIME_TRACE_SINK];
}

/** Emit bounded metadata without allowing optional instrumentation to affect liveness. */
export function recordRuntimeTrace(event: RuntimeTraceEvent): void {
  try {
    (globalThis as RuntimeTraceGlobal)[RUNTIME_TRACE_SINK]?.(event);
  } catch {
    // Instrumentation must never affect runtime liveness or extension behavior.
  }
}

export type { RuntimeTraceEvent, RuntimeTracePhase } from './runtime-trace-contract.js';
