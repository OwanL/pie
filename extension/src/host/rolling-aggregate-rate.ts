export const ROLLING_AGGREGATE_RATE_WINDOW_MS = 30_000;

export interface RollingRunOutput {
  runId: string;
  /** Provider-reported cumulative output for settled turns in this run. */
  reportedOutputTokens: number;
  /** Tokenizer-estimated output still absent from reported usage. */
  liveOutputTokens?: number;
  /** Conservative visible-output estimate for the newest terminal turn of the
   * session when its provider usage is unavailable (numeric only, never text).
   * A burst that completes between observations never appears in
   * {@link liveOutputTokens}, so this is the only signal that captures it.
   * Because only the newest terminal turn is estimated, a mixed run (some turns
   * reported, some not) reconciles conservatively: the authoritative reported
   * total wins at settlement and older unreported turns are never invented. */
  terminalOutputTokensEstimate?: number;
  /** True when this observation is the run's authoritative terminal snapshot
   * (settlement). The FIRST terminal observation applies a one-time signed
   * correction that reconciles the run's contribution to the terminal total —
   * positive when provider output exceeds the estimates, negative when the live
   * estimate overshot. Later observations of a settled run are monotonic and
   * idempotent, so the correction can never repeat. Open/live transient drops
   * never retract before this terminal authority. */
  terminal?: boolean;
}

interface RunMark {
  highWaterTokens: number;
  lastSeenAt: number;
  /** Set once the one-time terminal settlement correction has been applied. */
  settled: boolean;
}

interface RateSample {
  at: number;
  cumulativeTokens: number;
}

/**
 * Wall-clock rolling output rate across every observed run.
 *
 * Each input combines provider-reported settled output with the transient live
 * estimate that is not yet represented in reported usage, plus the terminal
 * estimate for a final turn whose usage is unavailable. While a run is open the
 * mark is monotonic: output only ever accumulates, so concurrent still-live
 * output stays additive and transient live drops never retract. When the
 * authoritative terminal snapshot arrives, the run's contribution is reconciled
 * once with a signed correction to that terminal total (down when the live
 * estimate overshot it, up when provider output exceeded it); the displayed
 * rate is clamped so this correction can never render a negative rate. Keeping
 * run identity here also captures turns that start and finish between
 * token-rate UI ticks, because their persisted run total still increases.
 */
export class RollingAggregateRate {
  private runMarks = new Map<string, RunMark>();
  private samples: RateSample[] = [];
  private cumulativeTokens = 0;
  private rate = 0;

  observe(now: number, runs: ReadonlyArray<RollingRunOutput>): number {
    let delta = 0;
    const seen = new Set<string>();
    for (const run of runs) {
      if (!run.runId || seen.has(run.runId)) continue;
      seen.add(run.runId);
      const reported = Number.isFinite(run.reportedOutputTokens)
        ? Math.max(0, run.reportedOutputTokens)
        : 0;
      const live = Number.isFinite(run.liveOutputTokens)
        ? Math.max(0, run.liveOutputTokens ?? 0)
        : 0;
      const terminalEstimate = Number.isFinite(run.terminalOutputTokensEstimate)
        ? Math.max(0, run.terminalOutputTokensEstimate ?? 0)
        : 0;
      const total = reported + live + terminalEstimate;
      const mark = this.runMarks.get(run.runId);
      if (mark) {
        if (run.terminal === true && !mark.settled) {
          // One-time settlement reconciliation to terminal authority. The
          // signed correction replaces whatever estimate overshoot accumulated
          // while the run was open; the high-water mark then restarts from the
          // authoritative total so later growth is measured against reality.
          delta += total - mark.highWaterTokens;
          mark.highWaterTokens = total;
          mark.settled = true;
        } else {
          delta += Math.max(0, total - mark.highWaterTokens);
          mark.highWaterTokens = Math.max(mark.highWaterTokens, total);
        }
        mark.lastSeenAt = now;
      } else {
        delta += total;
        this.runMarks.set(run.runId, {
          highWaterTokens: total,
          lastSeenAt: now,
          settled: run.terminal === true,
        });
      }
    }

    for (const [runId, mark] of this.runMarks) {
      if (!seen.has(runId) && now - mark.lastSeenAt > ROLLING_AGGREGATE_RATE_WINDOW_MS) {
        this.runMarks.delete(runId);
      }
    }

    // Signed deltas apply settlement retractions as well as growth; the floor
    // keeps the accumulator from going negative (per-run corrections are
    // bounded by that run's contribution, so this is defensive only).
    if (delta !== 0) this.cumulativeTokens = Math.max(0, this.cumulativeTokens + delta);

    if (this.samples.length === 0) {
      // Output present when the service starts has no known production interval
      // (for example after a reload), so establish it as the baseline. Runs
      // first appearing on later observations are still counted normally.
      this.samples.push({ at: now, cumulativeTokens: this.cumulativeTokens });
      this.rate = 0;
      return this.rate;
    }

    const last = this.samples[this.samples.length - 1]!;
    if (now < last.at) {
      // A clock regression cannot produce a meaningful rate. Preserve run
      // high-water marks, but restart the wall-clock sample window.
      this.samples = [{ at: now, cumulativeTokens: this.cumulativeTokens }];
      this.rate = 0;
      return this.rate;
    }
    if (now === last.at) {
      if (this.samples.length === 1 && last.cumulativeTokens < this.cumulativeTokens) return this.rate;
      last.cumulativeTokens = this.cumulativeTokens;
    } else {
      this.samples.push({ at: now, cumulativeTokens: this.cumulativeTokens });
    }

    const cutoff = now - ROLLING_AGGREGATE_RATE_WINDOW_MS;
    while (this.samples.length > 1 && this.samples[1]!.at <= cutoff) this.samples.shift();

    const first = this.samples[0]!;
    let baselineAt = first.at;
    let baselineTokens = first.cumulativeTokens;
    const second = this.samples[1];
    if (first.at < cutoff) {
      baselineAt = cutoff;
      if (second && second.at > first.at) {
        const fraction = Math.min(1, Math.max(0, (cutoff - first.at) / (second.at - first.at)));
        baselineTokens = first.cumulativeTokens
          + fraction * (second.cumulativeTokens - first.cumulativeTokens);
      }
    }

    const elapsedMs = now - baselineAt;
    const tokens = Math.max(0, this.cumulativeTokens - baselineTokens);
    const rawRate = elapsedMs > 0 && tokens > 0 ? tokens / (elapsedMs / 1000) : 0;
    this.rate = rawRate >= 10 ? Math.round(rawRate) : Math.round(rawRate * 10) / 10;
    return this.rate;
  }

  getRate(): number {
    return this.rate;
  }
}