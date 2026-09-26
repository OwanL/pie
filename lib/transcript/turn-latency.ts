export interface TurnLatencyMessage {
  role: string;
  status?: string;
  turnLatencyMs?: number;
  overheadMs?: number;
  providerLatencyMs?: number;
}

/**
 * Turn-latency stats. The average turn latency is surfaced INLINE on
 * the generation-speed (tokens/sec) chip — always visible, e.g. `42 tok/s · 1.5s`
 * — while the overhead / time-to-first-token breakdown lives in that chip's
 * tooltip. The latency breakdown is no longer a separate chip.
 *
 * Turn latency is the wall-clock gap from the previous tool call finishing (or
 * the prompt being sent, for the first turn) to the model's first reply token,
 * decomposed into our overhead vs the provider's. Each finished assistant
 * message carries the per-turn measurement (`turnLatencyMs` / `overheadMs` /
 * `providerLatencyMs`); here we average those across every measured turn in the
 * transcript so the speed chip's tooltip reports a stable typical latency
 * rather than the noisy single last turn.
 *
 * The average is session-wide (every measured turn in the transcript), not
 * per-run: latency is a historical statistic, and pooling all measured turns
 * yields a steadier number than the per-run sample (which may be just one or
 * two turns). The live generation rate on the same chip is per-run; the two
 * coexist in one tooltip.
 *
 * Pure transcript math (no I/O, no `Date.now()`), so it lives in `lib/` and
 * is consumed by both the host-side token-rate measurement and the webview.
 * The persisted per-turn breakdown lives on `TurnThroughputSample` in the host
 * analytics.
 */
export interface TurnLatencyStats {
  /** Number of finished assistant turns with a measured `turnLatencyMs`. */
  count: number;
  /** Mean `turnLatencyMs` across measured turns (ms). */
  avgTurnLatencyMs: number;
  /** Mean `overheadMs` across turns that measured it (ms); null if none did. */
  avgOverheadMs: number | null;
  /** Mean `providerLatencyMs` across turns that measured it (ms); null if none did. */
  avgProviderLatencyMs: number | null;
}

export const NO_LATENCY_STATS: TurnLatencyStats = {
  count: 0,
  avgTurnLatencyMs: 0,
  avgOverheadMs: null,
  avgProviderLatencyMs: null,
};

/** Format a millisecond duration as a short seconds label. */
function formatSeconds(ms: number): string {
  if (ms < 100) return '<0.1s';
  if (ms < 1000) return `${Math.round(ms / 100) / 10}s`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Collect measured (finished, non-streaming) assistant turns that carry a
 * `turnLatencyMs`. Streaming turns and turns recorded before tracking existed
 * (undefined latency) are excluded — a streaming turn's latency is not final
 * yet, and a turn without `turnLatencyMs` has nothing to average.
 */
export function collectMeasuredTurns<T extends TurnLatencyMessage>(transcript: T[]): T[] {
  const measured: T[] = [];
  for (const message of transcript) {
    if (message.role !== 'assistant') continue;
    if (message.status === 'streaming') continue;
    if (message.turnLatencyMs === undefined) continue;
    measured.push(message);
  }
  return measured;
}

/**
 * Average the per-turn latency breakdown across every measured turn in the
 * transcript. The total averages over all measured turns; the overhead and
 * provider components average only over turns that measured them (a turn can
 * have a total without a `turn_start`-anchored split), so the component means
 * need not sum to the total mean when some turns lack a component.
 */
export function computeTurnLatencyStats<T extends TurnLatencyMessage>(transcript: T[]): TurnLatencyStats {
  const turns = collectMeasuredTurns(transcript);
  if (turns.length === 0) return NO_LATENCY_STATS;
  let totalLatency = 0;
  let totalOverhead = 0;
  let totalProvider = 0;
  let overheadCount = 0;
  let providerCount = 0;
  for (const turn of turns) {
    totalLatency += turn.turnLatencyMs ?? 0;
    if (turn.overheadMs !== undefined) {
      totalOverhead += turn.overheadMs;
      overheadCount += 1;
    }
    if (turn.providerLatencyMs !== undefined) {
      totalProvider += turn.providerLatencyMs;
      providerCount += 1;
    }
  }
  return {
    count: turns.length,
    avgTurnLatencyMs: totalLatency / turns.length,
    avgOverheadMs: overheadCount > 0 ? totalOverhead / overheadCount : null,
    avgProviderLatencyMs: providerCount > 0 ? totalProvider / providerCount : null,
  };
}

/**
 * Format the average turn latency for inline display on the speed chip
 * (e.g. `42 tok/s · 1.5s`). Returns `null` when no turn has been measured, so
 * the inline segment is omitted until the first turn completes rather than
 * showing a stale dash — the tooltip still carries the `—` placeholder in its
 * breakdown.
 *
 * Turn latency is the wall-clock gap from the previous tool call finishing (or
 * the prompt being sent, for the first turn) to the model's first reply token
 * — i.e. overhead + time-to-first-token. It is the value surfaced inline next
 * to the generation rate; the overhead / time-to-first-token split remains in
 * the tooltip. Averaging the total (not just the provider portion) keeps the
 * inline number a faithful "how long until the model replies" companion to the
 * throughput, and stays visible even when a turn lacked the provider split.
 */
export function formatAvgTurnLatency(stats: TurnLatencyStats): string | null {
  if (stats.count === 0) return null;
  return formatSeconds(stats.avgTurnLatencyMs);
}

/**
 * Format the average turn-latency breakdown as tooltip lines for the speed chip.
 * The total leads with its turn count (and matches the value shown inline on the
 * chip); the overhead and time-to-first-token lines are its components. Returns
 * an empty array when no turns have been measured yet, so the speed tooltip
 * stays concise until latency data exists.
 *
 * The total is averaged over all measured turns (`count`); overhead and
 * time-to-first-token are averaged only over the turns that measured each, so
 * the two component values need not sum to the displayed total. The lines are
 * listed as a breakdown, not an equation, to avoid implying otherwise.
 */
export function formatTurnLatencyTooltipLines(stats: TurnLatencyStats): string[] {
  if (stats.count === 0) return [];
  const total = formatSeconds(stats.avgTurnLatencyMs);
  const overhead = stats.avgOverheadMs !== null ? formatSeconds(stats.avgOverheadMs) : '—';
  const ttft = stats.avgProviderLatencyMs !== null ? formatSeconds(stats.avgProviderLatencyMs) : '—';
  const turns = stats.count === 1 ? '1 turn' : `${stats.count} turns`;
  return [
    `Avg turn latency: ${total} over ${turns}`,
    `  overhead: ${overhead} — inter-turn work before the provider request`,
    `  time to first token: ${ttft} — request prep + network + model first token`,
  ];
}

/**
 * Precomputed latency-display adapters for a speed-chip state. Computes the
 * inline average turn latency and the tooltip breakdown once (from {@link stats})
 * and exposes joins that every chip-state variant — generating, paused, and idle
 * — applies identically, so the inline segment and tooltip lines stay consistent
 * across states and there is a single owner of the `· <turn-latency>` formatting.
 *
 * `withTurnLatency` / `withTurnLatencyAria` append the inline segment only when
 * a turn has been measured (otherwise the segment is omitted, never a stale
 * dash); `withLatencyLines` appends the breakdown only when at least one turn
 * was measured. The closures capture the formatted values, so calling them is
 * cheap and does not re-walk the stats.
 */
export interface LatencyDisplay {
  /** `${label} · <turn-latency>`, or `label` when no turn has been measured. */
  withTurnLatency: (label: string) => string;
  /** `${aria} Average turn latency <turn-latency>.`, or `aria` when none. */
  withTurnLatencyAria: (aria: string) => string;
  /** Base tooltip lines joined with the latency breakdown (when measured). */
  withLatencyLines: (lines: string[]) => string;
}

export function latencyDisplay(stats: TurnLatencyStats): LatencyDisplay {
  const turnLatency = formatAvgTurnLatency(stats);
  const latencyLines = formatTurnLatencyTooltipLines(stats);
  return {
    withTurnLatency: (label) => (turnLatency !== null ? `${label} · ${turnLatency}` : label),
    withTurnLatencyAria: (aria) => (turnLatency !== null ? `${aria} Average turn latency ${turnLatency}.` : aria),
    withLatencyLines: (lines) => (
      latencyLines.length > 0 ? [...lines, ...latencyLines].join('\n') : lines.join('\n')
    ),
  };
}
