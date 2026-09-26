import type {
  LivePipelineTraceAvailabilityReason,
  LivePipelineTraceDetailDelivery,
  LivePipelineTraceOutcome,
  LivePipelineTracePayloadClass,
} from '../../../../lib/structured-logging/live-pipeline-trace.js';

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

/** Bounded, metadata-only SDK instrumentation event. */
export interface RuntimeTraceEvent {
  phase: RuntimeTracePhase;
  outcome?: LivePipelineTraceOutcome;
  durationMs?: number;
  sourcePayloadBytes?: number;
  producedPayloadBytes?: number;
  childCount?: number;
  messageCount?: number;
  maxRecursiveDepth?: number;
  payloadClass?: LivePipelineTracePayloadClass;
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
