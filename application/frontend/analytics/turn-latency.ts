// Turn-latency stats now live in `shared/turn-latency.ts` so the host-side
// token-rate measurement can reuse them. This file re-exports the shared API
// verbatim so existing webview importers (`hooks.ts`, the token-rate test) keep
// their `from './turn-latency'` / `'../src/webview/panel/composer/turn-latency'`
// imports unchanged.
export {
  collectMeasuredTurns,
  computeTurnLatencyStats,
  formatAvgTurnLatency,
  formatTurnLatencyTooltipLines,
  NO_LATENCY_STATS,
} from '../../../lib/transcript/turn-latency';
export type { TurnLatencyStats } from '../../../lib/transcript/turn-latency';
