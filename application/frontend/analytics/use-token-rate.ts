import type { TokenRateIndicatorState } from '../../backend/analytics-views/token-rate';
import { IDLE_STATE } from '../../backend/analytics-views/token-rate';

/**
 * Live "average tokens per second" indicator — webview display side.
 *
 * The measurement itself runs **host-side** in `TokenRateService`
 * (`src/host/token-rate-service.ts`), which ticks every running session
 * (including ones that are not the active/selected tab) using the transcripts
 * the host already holds. The host posts the per-session indicator states as
 * `ViewState.tokenRateBySession`; this hook simply looks up the active
 * session's pre-computed state.
 *
 * Measuring host-side fixes the previous behaviour where switching off a
 * session froze its (webview-local) accumulator — the average now keeps
 * collecting for background sessions, so switching back continues smoothly
 * instead of restarting from the selection point.
 *
 * Re-exports the pure measurement primitives (`tickTokenRate`,
 * `createTokenRateAccumulator`, `TokenRateIndicatorState`) from `shared/` for
 * existing importers; the shared module is the single source of truth.
 */
export { tickTokenRate, createTokenRateAccumulator, WINDOW_MS } from '../../backend/analytics-views/token-rate';
export type { TokenRateIndicatorState, Accumulator } from '../../backend/analytics-views/token-rate';

export function useTokenRateIndicator({
  sessionPath,
  tokenRateBySession,
}: {
  sessionPath: string | null;
  tokenRateBySession: Record<string, TokenRateIndicatorState>;
}): TokenRateIndicatorState {
  // The host measures every running session continuously and posts the results
  // as `tokenRateBySession`; this hook just looks up the active session's
  // pre-computed state. The Composer re-renders on every host snapshot
  // regardless (transcript changes drive it), so returning the host's object
  // directly needs no local state or caching here.
  return sessionPath !== null
    ? (tokenRateBySession[sessionPath] ?? IDLE_STATE)
    : IDLE_STATE;
}
