// Turn-latency stats now live in `lib/transcript/turn-latency.ts` so the
// host-side token-rate measurement in `application/backend/analytics-views/
// token-rate.ts` can reuse them. This file re-exports the API verbatim so
// existing webview importers (`composer/hooks.ts`, the turn-latency test)
// keep their `from '../analytics/turn-latency'` imports unchanged.
export {
  collectMeasuredTurns,
  computeTurnLatencyStats,
  formatAvgTurnLatency,
  formatTurnLatencyTooltipLines,
  NO_LATENCY_STATS,
} from '../../../lib/transcript/turn-latency';
export type { TurnLatencyStats } from '../../../lib/transcript/turn-latency';
