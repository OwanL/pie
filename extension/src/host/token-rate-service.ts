import type { ArchState } from './core/arch-state';
import { projectTranscriptView } from './core/live-pipeline/projection';
import { createEmptyLivePipelineState } from './core/live-pipeline/model';

const EMPTY_LIVE_PIPELINE_STATE = createEmptyLivePipelineState();
import {
  computeIdleDisplayState,
  createAccumulator,
  IDLE_STATE,
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

export class TokenRateService {
  private accumulators = new Map<string, Accumulator>();
  private runIdsBySession = new Map<string, string | null>();
  private statesBySession = new Map<string, TokenRateIndicatorState>();
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

      if (
        sessionPath === activePath
        && (prev?.label !== next.label
          || prev?.state !== next.state
          || prev?.tooltip !== next.tooltip)
      ) {
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
      }
    }

    // Seed a latency-bearing idle display state for open sessions that have
    // never been measured this host session — a transcript loaded from disk, or
    // one restored after a window reload. Such sessions have no live rate, but
    // their finished turns still carry an average turn latency that should stay
    // visible on the speed chip even with no active generation (otherwise the
    // chip shows the bare '—' placeholder until the next run begins). Once a
    // session runs it is measured above and `statesBySession` already holds it,
    // so this is a no-op; the idle state is computed once (the transcript is
    // static while idle) and retained until a run replaces it.
    for (const path of openTabs) {
      if (this.statesBySession.has(path)) continue;
      const transcript = projectTranscriptView(
        state.transcript.bySession[path] ?? [],
        state.livePipeline ?? EMPTY_LIVE_PIPELINE_STATE,
        path,
      ).messages;
      const idleState = computeIdleDisplayState(transcript);
      this.statesBySession.set(path, idleState);
      if (path === activePath && idleState !== IDLE_STATE) {
        activeChanged = true;
      }
    }

    if (activeChanged) {
      this.deps.onActiveRateChanged();
    }

    // Aggregate analytics only need a fast refresh when a perceptible live
    // input changed. Avoid rebuilding chart series five times per second while
    // idle or while a running session is stalled at an unchanged tool state.
    const aggregateSignature = [
      `tabs=${[...openTabs].sort().join(',')}`,
      ...[...new Set(running)].sort().map((path) => {
        const measured = this.statesBySession.get(path);
        return `${path}:${measured?.state ?? ''}:${measured?.rate ?? ''}:${measured?.liveOutputTokens ?? ''}`;
      }),
    ].join('|');
    if (aggregateSignature !== this.lastAggregateSignature) {
      this.lastAggregateSignature = aggregateSignature;
      this.deps.onRatesTick?.();
    }
  }
}
