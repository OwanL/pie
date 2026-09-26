/** Analytics-owned timing facts used to project the host working-time clock. */
export interface WorkingTimeBreakdownFacts {
  /** Parent assistant response-generation time. */
  generationMs: number;
  /** Non-overlapping tool wall time, or a capped estimate for legacy runs. */
  toolExecutionMs: number;
  /** Portion of `toolExecutionMs` estimated from legacy cumulative call time. */
  estimatedToolExecutionMs: number;
  /** Observed or scheduled retry delay before a provider attempt. */
  retryWaitMs: number;
  /** Portion of `retryWaitMs` using scheduled delay because measurement was unavailable. */
  estimatedRetryWaitMs: number;
  /** Timed non-parent model calls such as skill pruning and compaction. */
  auxiliaryGenerationMs: number;
  /** Cumulative child-attempt time, including retry backoff. Parallel and nested
   *  attempts each contribute independently, so this may exceed session wall time. */
  subagentDurationMs?: number;
  /** Portion of `subagentDurationMs` derived from explicitly estimated timing. */
  estimatedSubagentDurationMs?: number;
  /** Number of terminal child attempts observed, including untimed attempts. */
  subagentAttemptCount?: number;
  /** Attempts or calls whose duration telemetry was unavailable. */
  unknownSubagentDurationCount?: number;
  /** Cumulative execution time by normalized tool name. */
  toolDurationMsByName: Record<string, number>;
  /** Number of timed calls by normalized tool name. */
  toolCallCountByName: Record<string, number>;
}

/** Analytics facts underlying the renderer's host-owned working-time clock. */
export interface WorkingTimeStateFacts {
  /** Settled agent work from completed busy intervals plus measured preflight. */
  accumulatedMs: number;
  /** Epoch milliseconds when the current busy interval began, or null idle. */
  activeSince: number | null;
  /** Start of the currently uncovered non-overlapping tool interval. The
   *  renderer may advance this interval locally but never creates its boundary. */
  activeToolSince?: number | null;
  /** Currently executing calls. Their individual durations are cumulative and
   *  may overlap; they feed the live per-tool detail rows only. */
  activeTools?: Array<{ id: string; name: string; startedAt: number }>;
  /** Optional for build-skew compatibility with the initial v9 clock. */
  breakdown?: WorkingTimeBreakdownFacts;
}
