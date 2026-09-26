/**
 * Keep the subagent package independent from the VS Code extension source
 * tree. The backend installs the matching sink under this global symbol when
 * diagnostics are enabled; a standalone pi invocation simply has no sink.
 */
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

/** Closed payload classes shared with the backend trace bridge. */
export type RuntimeTracePayloadClass =
  | 'source'
  | 'compact'
  | 'detail_baseline'
  | 'detail_page'
  | 'detail_delta'
  | 'detail_terminal'
  | 'terminal_append'
  | 'terminal_transport'
  | 'control';

export type RuntimeTraceDetailDelivery =
  | 'none'
  | 'baseline'
  | 'page'
  | 'delta'
  | 'rebase'
  | 'terminal';

export interface RuntimeTraceIdentifiers {
  session?: string;
  request?: string;
  turn?: string;
  attempt?: string;
  tool?: string;
}

export interface RuntimeTraceEvent {
  phase: RuntimeTracePhase;
  /** Dedupe result is metadata-only and uses the shared closed outcome set. */
  outcome?: 'changed' | 'duplicate';
  durationMs?: number;
  sourcePayloadBytes?: number;
  producedPayloadBytes?: number;
  childCount?: number;
  messageCount?: number;
  maxRecursiveDepth?: number;
  payloadClass?: RuntimeTracePayloadClass;
  detailDelivery?: RuntimeTraceDetailDelivery;
  availabilityReason?:
    | 'detail_delivery_not_implemented_until_phase_5'
    | 'source_preview_not_serialized_at_producer_boundary'
    | 'sdk_durability_boundary_exposes_no_serialized_byte_counter';
  identifiers?: RuntimeTraceIdentifiers;
}

const RUNTIME_TRACE_SINK = Symbol.for('pie.runtime-trace-sink.v1');

type RuntimeTraceGlobal = typeof globalThis & {
  [RUNTIME_TRACE_SINK]?: (event: RuntimeTraceEvent) => void;
};

/** Cheaply detect whether byte accounting/timing work is worth doing. */
export function isRuntimeTraceEnabled(): boolean {
  try {
    return typeof (globalThis as RuntimeTraceGlobal)[RUNTIME_TRACE_SINK] === 'function';
  } catch {
    return false;
  }
}

export function recordRuntimeTrace(event: RuntimeTraceEvent): void {
  try {
    (globalThis as RuntimeTraceGlobal)[RUNTIME_TRACE_SINK]?.(event);
  } catch {
    // Instrumentation must never affect runtime liveness or extension behavior.
  }
}
