import type { DurationClockDomain } from './timing.js';

/** Minimal tool-call data consumed by analytics analysis and projections. */
export interface ToolCallAnalysisInput {
  name: string;
  input: unknown;
  result?: unknown;
  status?: string;
}

/** Tool-call fields captured by canonical analytics without depending on the
 * host's RPC DTO. Rich detail references remain opaque at this boundary. */
export interface ToolCallCaptureInput extends ToolCallAnalysisInput {
  id: string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  durationClockDomain?: DurationClockDomain;
  durableEntryId?: string;
  argumentsText?: string;
  detailRef?: unknown;
}
