import type { ArchState } from './core/arch-state';
import { projectTranscriptView } from './core/live-pipeline/projection';
import { createEmptyLivePipelineState } from './core/live-pipeline/model';

const EMPTY_LIVE_PIPELINE_STATE = createEmptyLivePipelineState();
import {
  computeIdleDisplayState,
  createAccumulator,
  IDLE_STATE,
  RATE_HOLD_MS,
  shouldResetForRun,
  tickTokenRate,
  TICK_MS,
  type Accumulator,
  type TokenRateIndicatorState,
} from '../shared/token-rate';

/**
 * Measures the live "tokens per second" indicator state for every running
 * session host-side, so the average keeps collecting even while a session is
 * not the active/selected tab. The webview simply displays the pre-computed
 * state for its active session — it no longer measures anything itself.
 *
 * Why host-side: the webview only ever receives the *active* session's
 * transcript (`ViewState.transcript`), so it literally could not measure a
 * background session. The host holds every session's transcript in
 * `transcript.bySession`, so it can measure all of them continuously with the
 * exact same `tickTokenRate` logic the webview used to run.
 *
 * The generation clock advances on the service's own {@link TICK_MS} interval
 * (independent of transcript flushes), so it still advances during output
 * stalls (counting them against the rate so it drops to reflect slow-downs
 * rather than freezing on a stale high value) and detects the generating →
 * paused transition at run end / tool calls / between turns even when no state
 * snapshot is otherwise being posted. When the active session's displayed
 * state changes, {@link onActiveRateChanged} is called so the host posts a
 * fresh snapshot (debounced by the sidebar provider).
 *
 * Side-effectful (wall-clock + `setInterval`) by design — it lives outside the
 * pure reducer, mirroring how the reducer purity contract keeps `Date.now()`/
 * timers out of `(State, Event) → State`.
 */

export interface TokenRateServiceDeps {
  getArchState: () => ArchState;
  /** Called when the active session's displayed rate state changed, so the
   * host can post a fresh snapshot to the webview. */
  onActiveRateChanged: () => void;
  /** Called after every measurement tick. Aggregate analytics use this cheap
   * 200 ms signal to refresh live fields without polling history or backend
   * metrics at the same cadence. */
  onRatesTick?: () => void;
}

function terminalSignature(transcript: ReturnType<typeof projectTranscriptView>['messages']): string {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const message = transcript[i];
    if (message.role !== 'assistant'
      || (message.status !== 'completed' && message.status !== 'error' && message.status !== 'interrupted')) continue;
    return `${message.id}:${message.status}:${message.createdAt}:${message.durationMs ?? ''}:${message.usage?.outputTokens ?? ''}:${message.markdown.length}:${message.thinking?.length ?? 0}`;
  }
  return '';
}

export class TokenRateService {
  private accumulators = new Map<string, Accumulator>();
  private runIdsBySession = new Map<string, string | null>();
  private statesBySession = new Map<string, TokenRateIndicatorState>();
  /** When a completed burst stopped contributing live output. Retaining the
   * state briefly makes the final average visible without keeping stale rates
   * forever. */
  private rateHoldSinceBySession = new Map<string, number>();
  /** Terminal identity suppressed after the bounded hold expires. A changed
   * identity re-enables short-burst detection even if no running tick was seen. */
  private expiredRateTerminalBySession = new Map<string, string>();
  private rateHoldTerminalBySession = new Map<string, string>();
  private lastAggregateSignature = '';
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly deps: TokenRateServiceDeps) {}

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Read the live indicator state for a session (IDLE if not measured). */
  getRate(sessionPath: string): TokenRateIndicatorState {
    return this.statesBySession.get(sessionPath) ?? IDLE_STATE;
  }

  /** Snapshot of every measured session's state, for the ViewState. */
  getRates(): Record<string, TokenRateIndicatorState> {
    const result: Record<string, TokenRateIndicatorState> = {};
    for (const [path, state] of this.statesBySession) {
      result[path] = state;
    }
    return result;
  }

  /**
   * Advance the measurement one tick for every running session and return the
   * indicator states to display. Public (with an injectable `now`) so the
   * host's flush path and tests can drive a deterministic tick; the
   * {@link TICK_MS} interval calls it with the default wall-clock.
   */
  tick(now: number = Date.now()): void {
    const state = this.deps.getArchState();
    const openTabs = new Set(state.sessions.openTabPaths);
    const running = state.sessions.runningSessionPaths;
    const runningSet = new Set(running);
    const activePath = state.sessions.activeSessionPath;

    // Sessions to measure this tick:
    //  - every running session (the normal case), AND
    //  - any still-open session whose last state was 'generating'. A run that
    //    just finished leaves `runningSessionPaths` but its last tick left it
    //    'generating'; one final tick transitions it to 'paused' so it does
    //    not freeze on a stale 'generating' label. Once 'paused' it stops
    //    being measured (no growth, no clock advance) but its state is
    //    retained for display until the session closes or a new run starts.
    const toMeasure = new Set<string>(running);
    for (const [path, st] of this.statesBySession) {
      if (openTabs.has(path) && st.state === 'generating') {
        toMeasure.add(path);
      }
    }

    let activeChanged = false;

    for (const sessionPath of toMeasure) {
      const transcript = projectTranscriptView(
        state.transcript.bySession[sessionPath] ?? [],
        state.livePipeline ?? EMPTY_LIVE_PIPELINE_STATE,
        sessionPath,
      ).messages;
      const runSummary = state.composer.activeRunSummaryBySession[sessionPath] ?? null;
      const runId = runSummary?.runId ?? null;
      const existingRunId = this.runIdsBySession.get(sessionPath);

      if (shouldResetForRun(existingRunId, runId)) {
        this.accumulators.set(sessionPath, createAccumulator(now));
        this.runIdsBySession.set(sessionPath, runId);
      }

      const acc = this.accumulators.get(sessionPath);
      if (!acc) continue;

      const next = tickTokenRate(acc, transcript, now);
      const prev = this.statesBySession.get(sessionPath);
      this.statesBySession.set(sessionPath, next);
      if (runningSet.has(sessionPath)) {
        this.rateHoldSinceBySession.delete(sessionPath);
        this.rateHoldTerminalBySession.delete(sessionPath);
        this.expiredRateTerminalBySession.delete(sessionPath);
      } else if (next.rate !== undefined || next.endToEndRate !== undefined) {
        this.rateHoldSinceBySession.set(
          sessionPath,
          this.rateHoldSinceBySession.get(sessionPath) ?? now,
        );
        this.rateHoldTerminalBySession.set(sessionPath, terminalSignature(transcript));
      }

      if (
        sessionPath === activePath
        && (prev?.label !== next.label
          || prev?.state !== next.state
          || prev?.tooltip !== next.tooltip
          || prev?.terminalOutputTokensEstimate !== next.terminalOutputTokensEstimate)
      ) {
        activeChanged = true;
      }
    }

    // Retain a useful final/held rate through a short post-burst window. This
    // is intentionally wall-clock bounded: tools keep a running session alive
    // and must not decay its paused chip, while a completed burst eventually
    // returns to the ordinary idle placeholder.
    for (const path of openTabs) {
      if (runningSet.has(path)) continue;
      const current = this.statesBySession.get(path);
      if (!current || (current.rate === undefined && current.endToEndRate === undefined)) continue;
      const heldSince = this.rateHoldSinceBySession.get(path) ?? now;
      this.rateHoldSinceBySession.set(path, heldSince);
      if (now - heldSince <= RATE_HOLD_MS) continue;
      const transcript = projectTranscriptView(
        state.transcript.bySession[path] ?? [],
        state.livePipeline ?? EMPTY_LIVE_PIPELINE_STATE,
        path,
      ).messages;
      const expired = computeIdleDisplayState(transcript, false);
      this.statesBySession.set(path, expired);
      this.rateHoldSinceBySession.delete(path);
      this.rateHoldTerminalBySession.delete(path);
      this.expiredRateTerminalBySession.set(path, terminalSignature(transcript));
      if (path === activePath
        && (current.label !== expired.label
          || current.tooltip !== expired.tooltip
          || current.terminalOutputTokensEstimate !== expired.terminalOutputTokensEstimate)) {
        activeChanged = true;
      }
    }

    // Drop measurement state for sessions that are no longer open (closed or
    // invalidated). Finished-but-open sessions are retained (their last
    // 'paused' state stays visible) even though they are no longer measured.
    for (const path of [...this.statesBySession.keys()]) {
      if (!openTabs.has(path)) {
        this.statesBySession.delete(path);
        this.accumulators.delete(path);
        this.runIdsBySession.delete(path);
        this.rateHoldSinceBySession.delete(path);
        this.rateHoldTerminalBySession.delete(path);
        this.expiredRateTerminalBySession.delete(path);
      }
    }

    // Keep idle projections current as well as seeding them. A short run can
    // begin and finish between two 200ms samples, leaving only its terminal
    // assistant message for this service to observe. Re-projecting idle tabs is
    // bounded by the number of open tabs and lets terminal usage/timestamps
    // provide the final held rate without pretending it was live output.
    for (const path of openTabs) {
      if (runningSet.has(path)) continue;
      const current = this.statesBySession.get(path);
      const pausedWithoutRate = current?.state === 'paused'
        && current.rate === undefined
        && current.endToEndRate === undefined;
      if (current && current.state !== 'idle' && !pausedWithoutRate) continue;
      const transcript = projectTranscriptView(
        state.transcript.bySession[path] ?? [],
        state.livePipeline ?? EMPTY_LIVE_PIPELINE_STATE,
        path,
      ).messages;
      const terminalKey = terminalSignature(transcript);
      if (this.expiredRateTerminalBySession.get(path) === terminalKey) continue;
      this.expiredRateTerminalBySession.delete(path);
      const idleState = computeIdleDisplayState(transcript);
      if (!current || current.label !== idleState.label || current.tooltip !== idleState.tooltip
        || current.endToEndRate !== idleState.endToEndRate
        || current.terminalOutputTokensEstimate !== idleState.terminalOutputTokensEstimate) {
        this.statesBySession.set(path, idleState);
        if (path === activePath && (current !== undefined || idleState !== IDLE_STATE)) activeChanged = true;
      }
      if (idleState.endToEndRate !== undefined) {
        if (this.rateHoldTerminalBySession.get(path) !== terminalKey) {
          this.rateHoldSinceBySession.set(path, now);
          this.rateHoldTerminalBySession.set(path, terminalKey);
        } else {
          this.rateHoldSinceBySession.set(path, this.rateHoldSinceBySession.get(path) ?? now);
        }
      }
    }

    if (activeChanged) {
      this.deps.onActiveRateChanged();
    }

    // Aggregate analytics only need a fast refresh when a perceptible live
    // input changed. Avoid rebuilding chart series five times per second while
    // idle or while a running session is stalled at an unchanged tool state.
    // A terminal no-usage estimate is aggregate-relevant on any open tab — not
    // only running ones — because `RollingAggregateRate` counts it for open and
    // just-finished runs alike (a burst that completed between ticks). It is a
    // deterministic function of the transcript, so listing finished open tabs
    // here cannot churn: the entry only changes when the terminal changes.
    const aggregateSignature = [
      `tabs=${[...openTabs].sort().join(',')}`,
      ...[...new Set(running)].sort().map((path) => {
        const measured = this.statesBySession.get(path);
        return `${path}:${measured?.state ?? ''}:${measured?.rate ?? ''}:${measured?.endToEndRate ?? ''}:${measured?.liveOutputTokens ?? ''}:${measured?.terminalOutputTokensEstimate ?? ''}`;
      }),
      ...[...openTabs]
        .filter((path) => !runningSet.has(path))
        .sort()
        .map((path) => {
          const estimate = this.statesBySession.get(path)?.terminalOutputTokensEstimate;
          return estimate !== undefined ? `${path}:terminal=${estimate}` : '';
        })
        .filter((entry) => entry !== ''),
    ].join('|');
    if (aggregateSignature !== this.lastAggregateSignature) {
      this.lastAggregateSignature = aggregateSignature;
      this.deps.onRatesTick?.();
    }
  }
}
