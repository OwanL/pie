import type { CanonicalAnalyticsReadModel } from './query-entry.js';

export interface CanonicalRevisionRefresherOptions {
  /** Read model used only for the cheap revision read. */
  readModel: CanonicalAnalyticsReadModel;
  /** Invoked with the new revision after this host observes a change. */
  onRevisionChange: (revision: string) => void;
  /** Bounded check interval; the contract's tuning target is roughly one second. */
  intervalMs?: number;
  /** Optional idle-budget counter hook, so checks are measurable. */
  onCheck?: (info: { revision: string | null; changed: boolean; durationMs: number }) => void;
  /** Optional bounded error sink; repeated failures must not spam. */
  onError?: (error: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 1_000;
const MIN_INTERVAL_MS = 100;
const MAX_INTERVAL_MS = 60_000;

/** Bounded cross-host live-summary refresh.
 *
 * The contract requires a host to notice another host's committed summary,
 * correction or private close without polling event history, recalculating
 * history, or scanning the database. This reads only the small shared
 * projection revision at a bounded interval and notifies its owner when that
 * revision moves; the owner then reads its relevant summary rows.
 *
 * Deliberately not a broker and not an event log: a missed window is only a
 * delayed refresh, and the revision itself is the single source of truth, so
 * the loop must never accumulate state proportional to history. The timer is
 * unref'd so an idle host can exit, checks are serialized so a slow read cannot
 * overlap itself, and read failures are bounded to one notification per
 * outcome change rather than one per interval. */
export class CanonicalRevisionRefresher {
  private readonly readModel: CanonicalAnalyticsReadModel;
  private readonly onRevisionChange: (revision: string) => void;
  private readonly intervalMs: number;
  private readonly onCheck: CanonicalRevisionRefresherOptions['onCheck'];
  private readonly onError: CanonicalRevisionRefresherOptions['onError'];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private revision: string | null = null;
  private running = false;
  private stopped = false;
  private failing = false;
  private checks = 0;
  private changes = 0;
  private lastDurationMs = 0;
  private currentCheck: Promise<void> | undefined;
  private currentCheckAbort: AbortController | undefined;

  constructor(options: CanonicalRevisionRefresherOptions) {
    this.readModel = options.readModel;
    this.onRevisionChange = options.onRevisionChange;
    this.onCheck = options.onCheck;
    this.onError = options.onError;
    const requested = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (!Number.isSafeInteger(requested) || requested < MIN_INTERVAL_MS) {
      throw new RangeError('CanonicalRevisionRefresher intervalMs must be a safe integer of at least 100.');
    }
    this.intervalMs = Math.min(requested, MAX_INTERVAL_MS);
  }

  /** Establish the baseline without notifying, then poll at the bounded
   * interval. Returns the baseline revision, or null when it is not yet
   * readable (an absent or not-yet-created database is not an error). */
  async start(): Promise<string | null> {
    if (this.stopped) throw new Error('CanonicalRevisionRefresher is stopped.');
    await this.check();
    if (this.stopped) return this.revision;
    this.running = true;
    this.rearm();
    return this.revision;
  }

  /** Observable counters for idle-resource measurement and diagnostics. */
  getStats(): { checks: number; changes: number; lastDurationMs: number; revision: string | null; failing: boolean } {
    return {
      checks: this.checks,
      changes: this.changes,
      lastDurationMs: this.lastDurationMs,
      revision: this.revision,
      failing: this.failing,
    };
  }

  /** Stop future polling, abort an interval read if one is in flight, and
   * resolve only after that read has reached its terminal state. Existing
   * callers may ignore the returned promise; owners that remove resources
   * can await it to prove no revision callback remains outstanding. */
  stop(): Promise<void> {
    this.stopped = true;
    this.running = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.currentCheckAbort?.abort(new Error('Canonical revision refresh stopped.'));
    return this.currentCheck?.then(() => undefined, () => undefined) ?? Promise.resolve();
  }

  /** One revision read. Serialized by {@link running} so an interval cannot
   * overlap a still-pending read on a slow host. */
  private check(): Promise<void> {
    if (this.currentCheck) return this.currentCheck;
    const controller = new AbortController();
    const check = this.performCheck(controller.signal);
    this.currentCheck = check;
    this.currentCheckAbort = controller;
    // The returned rejection is handled by the owner of check(); this branch
    // only clears the tracking slot and must never become an unhandled
    // promise from a timer callback.
    void check.then(
      () => this.clearCurrentCheck(check),
      () => this.clearCurrentCheck(check),
    );
    return check;
  }

  private clearCurrentCheck(check: Promise<void>): void {
    if (this.currentCheck !== check) return;
    this.currentCheck = undefined;
    this.currentCheckAbort = undefined;
  }

  private async performCheck(signal: AbortSignal): Promise<void> {
    const startedAt = performance.now();
    try {
      const current = await this.readModel.readRevision(signal);
      if (this.stopped || signal.aborted) return;
      this.lastDurationMs = performance.now() - startedAt;
      this.checks += 1;
      this.failing = false;
      const changed = this.revision !== null && current !== this.revision;
      this.revision = current;
      if (changed) {
        this.changes += 1;
        this.onRevisionChange(current);
      }
      this.onCheck?.({ revision: current, changed, durationMs: this.lastDurationMs });
    } catch (error) {
      if (this.stopped || signal.aborted) return;
      this.lastDurationMs = performance.now() - startedAt;
      this.checks += 1;
      // Report only the transition into failure; an unreachable database must
      // not produce one notification per interval.
      if (!this.failing) {
        this.failing = true;
        this.onError?.(error);
      }
      this.onCheck?.({ revision: this.revision, changed: false, durationMs: this.lastDurationMs });
    }
  }

  private rearm(): void {
    if (!this.running || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (!this.running || this.stopped) return;
    await this.check();
    this.rearm();
  }
}
