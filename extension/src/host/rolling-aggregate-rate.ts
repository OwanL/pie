export const ROLLING_AGGREGATE_RATE_WINDOW_MS = 30_000;

export interface RollingRunOutput {
  runId: string;
  /** Provider-reported cumulative output for settled turns in this run. */
  reportedOutputTokens: number;
  /** Tokenizer-estimated output still absent from reported usage. */
  liveOutputTokens?: number;
}

interface RunMark {
  highWaterTokens: number;
  lastSeenAt: number;
}

interface RateSample {
  at: number;
  cumulativeTokens: number;
}

/**
 * Wall-clock rolling output rate across every observed run.
 *
 * Each input combines provider-reported settled output with the transient live
 * estimate that is not yet represented in reported usage. When a terminal
 * usage report replaces that estimate, the per-run high-water mark prevents
 * double-counting; concurrent still-live output remains additive.
 * Keeping run identity here also captures turns that start and finish between
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
      const total = reported + live;
      const mark = this.runMarks.get(run.runId);
      if (mark) {
        delta += Math.max(0, total - mark.highWaterTokens);
        mark.highWaterTokens = Math.max(mark.highWaterTokens, total);
        mark.lastSeenAt = now;
      } else {
        delta += total;
        this.runMarks.set(run.runId, { highWaterTokens: total, lastSeenAt: now });
      }
    }

    for (const [runId, mark] of this.runMarks) {
      if (!seen.has(runId) && now - mark.lastSeenAt > ROLLING_AGGREGATE_RATE_WINDOW_MS) {
        this.runMarks.delete(runId);
      }
    }

    if (delta > 0) this.cumulativeTokens += delta;

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
