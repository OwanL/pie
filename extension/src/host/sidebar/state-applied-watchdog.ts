import { recordAckLatency, recordWatchdog } from '../util/stream-telemetry';
import { bootLog } from '../util/audit';
import { appendPieLog } from '../util/pie-log';

/** Max wait for the webview to acknowledge a posted state revision. */
const STATE_APPLIED_TIMEOUT_MS = 2_500;
/** Limit forced webview reloads when state acknowledgements are missing. */
export const STATE_APPLIED_RELOAD_LIMIT = 2;
/** Rolling window for missing-ack reload throttling. */
export const STATE_APPLIED_RELOAD_WINDOW_MS = 30_000;
/**
 * Bounded resnapshot retries before escalating to a force-reload while a
 * session is streaming. Each retry re-posts the dirty snapshot and re-arms
 * the watchdog for the new revision (~{@link STATE_APPLIED_TIMEOUT_MS}
 * cadence), giving a slow-but-functional webview several chances to
 * acknowledge without a disruptive reload. Once exhausted the watchdog
 * escalates to a throttled force-reload even while `runningCount > 0`, so a
 * genuinely hung renderer recovers in roughly
 * `(1 + RESNAPSHOT_MAX_RETRIES) * STATE_APPLIED_TIMEOUT_MS` instead of staying
 * frozen for the entire turn (the previous behaviour: the force-reload was
 * suppressed indefinitely while any session was running, so the only
 * recovery was a manual panel reload). The standard reload throttle
 * ({@link STATE_APPLIED_RELOAD_LIMIT} / {@link STATE_APPLIED_RELOAD_WINDOW_MS})
 * still bounds reload storms during the escalation.
 */
const RESNAPSHOT_MAX_RETRIES = 4;

/**
 * Dependencies injected by {@link SidebarViewProvider} so the watchdog has no
 * direct dependency on vscode or on the hot-reloader. All collaborators are
 * expressed as plain callbacks/getters, which keeps the unit testable without
 * a vscode host.
 */
export interface StateAppliedWatchdogDeps {
  getWebviewReady(): boolean;
  getViewVisible(): boolean;
  getRunningSessionCount(): number;
  getHostInstanceId(): string;
  /** Re-post the dirty snapshot (resnapshot path). */
  onResnapshot(): void;
  /** Force a webview reload (reload path). */
  onForceReload(revision: number): Promise<void>;
}

/**
 * Tracks the webview's acknowledgement of posted state revisions and forces a
 * resnapshot (then a reload) when acks go missing. Extracted verbatim from
 * {@link SidebarViewProvider}; see that class for the orchestration contract.
 */
export class StateAppliedWatchdog {
  private stateAppliedTimer?: ReturnType<typeof setTimeout>;
  private pendingStateAppliedRevision: number | null = null;
  private pendingRenderSignature: string | null = null;
  private pendingStateAppliedArmedAt = 0;
  private lastStateAppliedRevision = -1;
  private lastStateAppliedAt = 0;
  private stateAppliedReloadWindowStartedAt = 0;
  private stateAppliedReloadAttempts = 0;
  private resnapshotAttempts = 0;

  constructor(private readonly deps: StateAppliedWatchdogDeps) {}

  recordStateApplied(revision: number, renderSignature?: string | null): void {
    if (
      this.pendingStateAppliedRevision !== null
      && revision >= this.pendingStateAppliedRevision
      && this.pendingRenderSignature !== null
      && renderSignature !== this.pendingRenderSignature
    ) {
      appendPieLog('warn', 'sidebar-provider', 'state-applied semantic mismatch', {
        revision,
        expectedRenderSignature: this.pendingRenderSignature,
        actualRenderSignature: renderSignature ?? null,
      });
      return;
    }
    this.lastStateAppliedRevision = Math.max(this.lastStateAppliedRevision, revision);
    this.lastStateAppliedAt = Date.now();

    if (this.pendingStateAppliedRevision !== null && revision >= this.pendingStateAppliedRevision) {
      if (this.pendingStateAppliedArmedAt > 0) {
        recordAckLatency(Date.now() - this.pendingStateAppliedArmedAt);
      }
      this.clear();
      this.stateAppliedReloadAttempts = 0;
      this.stateAppliedReloadWindowStartedAt = 0;
      this.resnapshotAttempts = 0;
    }
  }

  clear(): void {
    if (this.stateAppliedTimer !== undefined) {
      clearTimeout(this.stateAppliedTimer);
      this.stateAppliedTimer = undefined;
    }
    this.pendingStateAppliedRevision = null;
    this.pendingRenderSignature = null;
  }

  armStateAppliedWatchdog(revision: number, renderSignature?: string): void {
    if (!this.deps.getWebviewReady() || !this.deps.getViewVisible()) {
      return;
    }

    this.pendingStateAppliedRevision = revision;
    this.pendingRenderSignature = renderSignature ?? null;
    this.pendingStateAppliedArmedAt = Date.now();
    if (this.stateAppliedTimer !== undefined) {
      clearTimeout(this.stateAppliedTimer);
    }

    this.stateAppliedTimer = setTimeout(() => {
      void this.handleStateAppliedTimeout(revision);
    }, STATE_APPLIED_TIMEOUT_MS);
  }

  shouldThrottleStateAppliedReload(now: number): boolean {
    if (
      this.stateAppliedReloadWindowStartedAt === 0
      || now - this.stateAppliedReloadWindowStartedAt > STATE_APPLIED_RELOAD_WINDOW_MS
    ) {
      this.stateAppliedReloadWindowStartedAt = now;
      this.stateAppliedReloadAttempts = 0;
    }

    if (this.stateAppliedReloadAttempts >= STATE_APPLIED_RELOAD_LIMIT) {
      return true;
    }

    this.stateAppliedReloadAttempts += 1;
    return false;
  }

  /** Reset the resnapshot retry counter (called when the bridge becomes
   *  ready and on a successful ack — a fresh start should not inherit the
   *  retry budget of a previously-unacked episode). */
  resetResnapshotFlag(): void {
    this.resnapshotAttempts = 0;
  }

  getLastStateAppliedRevision(): number {
    return this.lastStateAppliedRevision;
  }

  getPendingStateAppliedRevision(): number | null {
    return this.pendingStateAppliedRevision;
  }

  private async handleStateAppliedTimeout(revision: number): Promise<void> {
    this.stateAppliedTimer = undefined;

    if (this.pendingStateAppliedRevision === null || revision !== this.pendingStateAppliedRevision) {
      return;
    }

    if (this.lastStateAppliedRevision >= revision) {
      this.clear();
      return;
    }

    if (!this.deps.getWebviewReady() || !this.deps.getViewVisible()) {
      return;
    }

    // Re-snapshot-first: before force-reloading the webview HTML, re-post the
    // dirty snapshot up to {@link RESNAPSHOT_MAX_RETRIES} times. Each retry
    // re-arms the watchdog for the freshly-posted revision, so a slow-but-
    // functional webview gets several chances to acknowledge without a
    // disruptive reload. This avoids reload storms on slow transcripts where
    // the webview is slow to ack but still functional.
    if (this.resnapshotAttempts < RESNAPSHOT_MAX_RETRIES) {
      this.resnapshotAttempts += 1;
      recordWatchdog('resnapshot');
      bootLog('sidebar-provider', 'stateApplied.timeout.resnapshot', {
        attempt: this.resnapshotAttempts,
        hostInstanceId: this.deps.getHostInstanceId(),
        maxRetries: RESNAPSHOT_MAX_RETRIES,
        pendingRevision: revision,
        visible: this.deps.getViewVisible(),
        webviewReady: this.deps.getWebviewReady(),
      });
      this.deps.onResnapshot();
      return;
    }

    // Escalation: the resnapshot retries above are exhausted, meaning the
    // webview has not acknowledged a state revision for roughly
    // `(1 + RESNAPSHOT_MAX_RETRIES) * STATE_APPLIED_TIMEOUT_MS` — it is
    // effectively hung. Previously the force-reload was suppressed
    // *indefinitely* whenever `runningCount > 0`, which trapped a hung renderer
    // for the entire turn (the "transcript frozen until I reload the panel"
    // symptom: the host keeps posting, the webview never renders, and nothing
    // short of a manual panel reload recovered it). A mid-stream reload does
    // discard transient streaming state and can flash the "old + new at once"
    // frame, but a bounded, throttled reload is strictly better than a freeze
    // that lasts the whole turn. The standard reload throttle below still
    // bounds reload storms; a slow-but-functional webview never reaches here
    // because its acks reset `resnapshotAttempts` along the way.
    const runningCount = this.deps.getRunningSessionCount();
    const now = Date.now();
    if (this.shouldThrottleStateAppliedReload(now)) {
      recordWatchdog('throttled');
      const throttleContext = {
        hostInstanceId: this.deps.getHostInstanceId(),
        lastStateAppliedRevision: this.lastStateAppliedRevision,
        pendingRevision: revision,
        resnapshotAttempts: this.resnapshotAttempts,
        runningCount,
        visible: this.deps.getViewVisible(),
        webviewReady: this.deps.getWebviewReady(),
      };
      appendPieLog('warn', 'sidebar-provider', 'state-applied watchdog throttled force-reload (reload storm)', throttleContext);
      bootLog('sidebar-provider', 'stateApplied.timeout.throttled', throttleContext);
      return;
    }

    recordWatchdog('reload');
    const reloadContext = {
      hostInstanceId: this.deps.getHostInstanceId(),
      lastStateAppliedAt: this.lastStateAppliedAt || null,
      lastStateAppliedRevision: this.lastStateAppliedRevision,
      pendingRevision: revision,
      resnapshotAttempts: this.resnapshotAttempts,
      runningCount,
      visible: this.deps.getViewVisible(),
      webviewReady: this.deps.getWebviewReady(),
    };
    const reloadMessage = runningCount > 0
      ? 'state-applied watchdog force-reloading webview while session streaming'
      : 'state-applied watchdog force-reloading webview';
    appendPieLog('warn', 'sidebar-provider', reloadMessage, reloadContext);
    bootLog('sidebar-provider', runningCount > 0 ? 'stateApplied.timeout.streaming.escalated' : 'stateApplied.timeout', reloadContext);

    this.clear();
    await this.deps.onForceReload(revision);
  }

  dispose(): void {
    this.clear();
    this.lastStateAppliedRevision = -1;
    this.lastStateAppliedAt = 0;
    this.stateAppliedReloadWindowStartedAt = 0;
    this.stateAppliedReloadAttempts = 0;
  }
}
