/** Renderer-facing state for the host-measured token-rate indicator. */
export interface TokenRateIndicatorState {
  /** Compact label e.g. "42 tok/s · 1.5s" (rate · avg turn latency); "—" when idle or measuring. */
  label: string;
  ariaLabel: string;
  tooltip: string;
  /** 'idle' (no session selected) | 'generating' | 'paused'. */
  state: 'idle' | 'generating' | 'paused';
  /** True while the generation clock is frozen (tool running / between turns / before the first token). */
  paused: boolean;
  /** Numeric active-generation tokens/sec, or `undefined` when no generation
   * timing is available. This is the primary per-session/composer rate. A
   * provisional value may be exposed during the first sampling interval; it is
   * replaced by the generation-time window once it spans 300ms. */
  rate?: number;
  /** Provider-reported output tokens divided by the full assistant duration for
   * the latest completed/error turn. This is separate from `rate`: it includes
   * the initial wait and is the end-to-end/experienced throughput. It is also
   * available as a fallback for a burst that completed before the live sampler
   * observed two ticks. */
  endToEndRate?: number;
  /** True when `endToEndRate` uses visible-token estimation because the
   * provider did not report output usage. */
  endToEndRateEstimated?: boolean;
  /** Estimated output tokens in the currently-unreported main turn and
   * running subagents. This is transient: provider-reported usage replaces it
   * when the turn/tool completes. Live cost and token totals use it while
   * output streams. */
  liveOutputTokens?: number;
}

/** Default renderer state when no session is selected or no rate is available. */
export const IDLE_STATE: TokenRateIndicatorState = {
  label: '—',
  ariaLabel: 'Generation rate: idle.',
  tooltip: 'No active generation.',
  state: 'idle',
  paused: false,
};
