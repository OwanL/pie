import { bootLog } from '../util/audit';
import { appendPieLog } from '../util/pie-log';
import { recordWatchdog } from '../util/stream-telemetry';
import type { StateDeliveryRecovery } from './state-delivery-controller';

/** Provisional retry count preserved from the previous watchdog; not calibrated. */
export const PROVISIONAL_COMMIT_RESNAPSHOT_MAX_RETRIES = 4;
/** Provisional reload-storm limit preserved from the previous watchdog. */
export const STATE_APPLIED_RELOAD_LIMIT = 2;
/** Provisional rolling reload window preserved from the previous watchdog. */
export const STATE_APPLIED_RELOAD_WINDOW_MS = 30_000;

export interface StateAppliedWatchdogDeps {
  getHostInstanceId(): string;
  getRunningSessionCount(): number;
  onForceReload(recovery: StateDeliveryRecovery): Promise<void>;
  now?(): number;
}

/**
 * Reload escalation/storm gate retained under the historical name.
 *
 * It intentionally owns no timer and no commit ledger. StateDeliveryController
 * is the sole owner of the lack-of-transcript-commit deadline. This helper only
 * decides whether a classified controller recovery should reload immediately
 * or after the provisional resnapshot budget.
 */
export class StateAppliedWatchdog {
  private reloadAttemptTimestamps: number[] = [];
  private commitTimeouts = 0;
  private reloadInFlight = false;
  private reloadCircuitOpen = false;
  private disposed = false;
  private lastDecision: 'resnapshot' | 'reload' | 'throttled' | 'circuit-open' | 'ignored' = 'ignored';

  constructor(private readonly deps: StateAppliedWatchdogDeps) {}

  recordCommitAdvanced(): void {
    // A commit proves that state reached the replacement renderer, but not that
    // the renderer is stable. Keep reload history across commits so a
    // mount → commit → error cycle cannot reset the storm circuit.
    this.commitTimeouts = 0;
  }

  resetRecoveryEpisode(): void {
    this.commitTimeouts = 0;
  }

  handleRecovery(recovery: StateDeliveryRecovery): boolean {
    this.lastDecision = 'ignored';
    if (this.disposed) return false;
    if (this.reloadCircuitOpen) {
      const now = this.deps.now?.() ?? Date.now();
      this.pruneReloadAttempts(now);
      if (this.reloadAttemptTimestamps.length >= STATE_APPLIED_RELOAD_LIMIT) {
        this.lastDecision = 'circuit-open';
        return false;
      }
      this.reloadCircuitOpen = false;
    }

    if (recovery.reason === 'commit-timeout') {
      this.commitTimeouts += 1;
      if (this.commitTimeouts <= PROVISIONAL_COMMIT_RESNAPSHOT_MAX_RETRIES) {
        this.lastDecision = 'resnapshot';
        recordWatchdog('resnapshot');
        bootLog('sidebar-provider', 'transcriptCommit.timeout.resnapshot', {
          attempt: this.commitTimeouts,
          hostInstanceId: this.deps.getHostInstanceId(),
          maxRetries: PROVISIONAL_COMMIT_RESNAPSHOT_MAX_RETRIES,
          revision: recovery.revision ?? null,
          viewGeneration: recovery.viewGeneration,
        });
        return false;
      }
    }

    return this.requestReload(recovery);
  }

  getLastDecision(): 'resnapshot' | 'reload' | 'throttled' | 'circuit-open' | 'ignored' {
    return this.lastDecision;
  }

  shouldThrottleStateAppliedReload(now: number): boolean {
    this.pruneReloadAttempts(now);
    if (this.reloadAttemptTimestamps.length >= STATE_APPLIED_RELOAD_LIMIT) return true;
    this.reloadAttemptTimestamps.push(now);
    return false;
  }

  dispose(): void {
    this.disposed = true;
    this.commitTimeouts = 0;
    this.reloadAttemptTimestamps = [];
    this.reloadInFlight = false;
    this.reloadCircuitOpen = true;
  }

  private pruneReloadAttempts(now: number): void {
    this.reloadAttemptTimestamps = this.reloadAttemptTimestamps.filter(
      (attemptedAt) => now - attemptedAt < STATE_APPLIED_RELOAD_WINDOW_MS,
    );
  }

  private requestReload(recovery: StateDeliveryRecovery): boolean {
    if (this.reloadInFlight) return false;
    const now = this.deps.now?.() ?? Date.now();
    if (this.shouldThrottleStateAppliedReload(now)) {
      this.lastDecision = 'throttled';
      this.reloadCircuitOpen = true;
      recordWatchdog('throttled');
      const context = {
        failure: recovery.failure ?? null,
        hostInstanceId: this.deps.getHostInstanceId(),
        reason: recovery.reason,
        revision: recovery.revision ?? null,
        runningCount: this.deps.getRunningSessionCount(),
        viewGeneration: recovery.viewGeneration,
      };
      appendPieLog('warn', 'sidebar-provider', 'webview recovery reload throttled', context);
      bootLog('sidebar-provider', 'recovery.reload.throttled', context);
      return false;
    }

    this.lastDecision = 'reload';
    this.reloadInFlight = true;
    recordWatchdog('reload');
    const context = {
      classification: recovery.renderFailure?.classification ?? null,
      failure: recovery.failure ?? null,
      hostInstanceId: this.deps.getHostInstanceId(),
      reason: recovery.reason,
      revision: recovery.revision ?? null,
      runningCount: this.deps.getRunningSessionCount(),
      surface: recovery.renderFailure?.surface ?? null,
      viewGeneration: recovery.viewGeneration,
    };
    appendPieLog('warn', 'sidebar-provider', 'force-reloading webview after classified recovery', context);
    bootLog('sidebar-provider', 'recovery.reload', context);
    void this.deps.onForceReload(recovery).finally(() => {
      this.reloadInFlight = false;
      if (recovery.reason === 'commit-timeout') this.commitTimeouts = 0;
    });
    return true;
  }
}
