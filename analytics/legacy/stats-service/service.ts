/**
 * Legacy settlement/accounting persistence for the stats service.
 *
 * This module owns the legacy accounting/storage paths the presentation façade
 * consumes: `RunAnalyticsStorage` + `BillableAccounting` construction and
 * their bridge closures, the legacy startup restore sequence, the deferred
 * ledger-healing/historical-migration background work, and the
 * settlement/flush/export/dispose sequences. Durable storage layout is
 * unchanged; the façade (`application/backend/analytics-views/service.ts`)
 * keeps a single mutable seam by delegating through this module instead of
 * introducing a second analytics store.
 */

import { appendPieLog } from '../../../lib/structured-logging/pie-logger';
import type { RunAnalyticsExportPayload } from '../run-analytics/query';
import type { RunSnapshot } from '../run-analytics/types';
import { RunAnalyticsStorage } from './storage';
import { SessionRunTracker } from './tracker';
import type {
  ActivityIntervalRecord,
} from '../../contracts/activity-interval';
import {
  BillableAccounting,
  type BillableAccountingDeps,
  type BillableAccountingPersistenceFailureNotice,
} from '../billable-accounting/service';
import type { CapturedPricingFacts } from '../../../harness/model-providers/pricing/captured-pricing-facts.js';
import type { CanonicalAnalyticsCapture } from '../../capture/canonical-capture.js';
import type { WorkingTimeService } from '../working-time-service';

/** Ports the settlement needs from its presentation façade and host. */
export interface LegacyStatsSettlementPorts {
  readonly now: () => Date;
  readonly dispatchArchEvent: (event: BillableAccountingPersistenceFailureNotice) => void;
  readonly scheduleRender: () => void;
  /** Captured provider/model pricing facts from the provider pricing owner;
   *  settlement accounting consumes the facts and never resolves runtime
   *  catalogs itself. */
  readonly getCapturedPricingFacts: () => CapturedPricingFacts | undefined;
  readonly isPrivateSession: (sessionPath: string) => boolean;
  readonly sessionIdentity: (sessionPath: string) => { sessionId: string | null; modelId?: string; provider?: string };
  readonly currentRunId: (sessionPath: string) => string | null;
  readonly activeOperationId: (sessionPath: string) => string | null;
  /** Serialize the tracker's current sessions for storage snapshots. The
   * tracker itself is constructed by the façade after the settlement. */
  readonly serializeSessions: () => Record<string, unknown>;
  /** Facade-owned startup stage recorder. */
  readonly recordStage: (
    stage: string,
    startedAtMs: number,
    counts?: Record<string, number>,
    diagnosticsBefore?: Record<string, number>,
  ) => void;
  /** True once the façade is disposed; deferred work polls this. */
  readonly isDisposed: () => boolean;
  /** Rehydrate the façade's live busy/tool interval maps from durable
   * intervals restored at startup (no canonical read is involved). */
  readonly rehydrateRestoredIntervals: (activityIntervals: readonly ActivityIntervalRecord[]) => void;
  /** Facade-owned compaction abort signal for the background timeline
   * compaction; aborted on shutdown. */
  readonly compactionSignal: () => AbortSignal;
  readonly canonicalCapture?: CanonicalAnalyticsCapture;
}

export interface LegacyStatsSettlementOptions {
  dataOutcomesRootPath: string;
  legacyUsageDataRootPath?: string;
  workspaceId: string;
  legacyWorkspaceIds: readonly string[];
}

/**
 * One legacy accounting/storage seam per stats service. The façade reads the
 * collaborators directly (run observation stays with the tracker; the ledger
 * adaptation stays with `BillableAccounting`), while every settlement /
 * persistence sequence lives here.
 */
export class LegacyStatsSettlement {
  readonly storage: RunAnalyticsStorage;
  readonly accounting: BillableAccounting;

  /** Runs captured at startup whose historical usage migration is deferred to
   * the background continuation. */
  private deferredMigrationRuns: readonly RunSnapshot[] = [];

  private readonly ports: LegacyStatsSettlementPorts;

  constructor(ports: LegacyStatsSettlementPorts, options: LegacyStatsSettlementOptions) {
    this.ports = ports;
    const {
      dataOutcomesRootPath,
      legacyUsageDataRootPath,
      workspaceId,
      legacyWorkspaceIds,
    } = options;
    let accountingRef: BillableAccounting | null = null;
    this.storage = new RunAnalyticsStorage({
      dataOutcomesRootPath,
      legacyUsageDataRootPath,
      workspaceId,
      legacyWorkspaceIds: [...legacyWorkspaceIds],
      now: ports.now,
      serializeSessions: () => ports.serializeSessions() as Record<string, import('../run-analytics/types').PersistedSessionRunState>,
      getBillableInvocationExport: () => accountingRef?.getBillableInvocationExport()
        ?? { billableInvocations: [], activityIntervals: [] },
      onPersistError: ({ message, at }) => {
        appendPieLog('warn', 'run-analytics', 'persistence error surfaced to UI', { at, error: message });
        ports.dispatchArchEvent({
          kind: 'NoticeShown',
          notice: 'pie could not write run analytics to disk. Some diagnostics may be missing until this is fixed.',
          noticeKind: 'operational-error',
          noticeRaw: `Run analytics persistence failed at ${at}: ${message}`,
        });
      },
    });
    const accountingDeps: BillableAccountingDeps = {
      getStorageDir: () => this.storage.getStorageDir(),
      now: ports.now,
      scheduleRender: ports.scheduleRender,
      dispatchArchEvent: ports.dispatchArchEvent,
      getCapturedPricingFacts: ports.getCapturedPricingFacts,
      isPrivateSession: (sessionPath) => ports.isPrivateSession(sessionPath),
      sessionIdentity: (sessionPath) => ports.sessionIdentity(sessionPath),
      currentRunId: (sessionPath) => ports.currentRunId(sessionPath),
      activeOperationId: (sessionPath) => ports.activeOperationId(sessionPath),
      markDerivedExportDirty: () => this.storage.markDerivedExportDirty(),
      ...(ports.canonicalCapture ? { canonicalCapture: ports.canonicalCapture } : {}),
    };
    accountingRef = new BillableAccounting(accountingDeps);
    this.accounting = accountingRef;
  }

  /** Cumulative ActivityTimeline diagnostics snapshot for stage deltas. */
  timelineDiagnostics(): Record<string, number> {
    return { ...this.accounting.activityTimeline.getDiagnostics() };
  }

  getStorageDir(): string {
    return this.storage.getStorageDir();
  }

  /** Legacy startup restoration: storage start, tracker checkpoint restore,
   * the persisted analytics query, ledger and timeline warm-up, and
   * working-time restoration. Healing and historical migration are deferred
   * background work (see {@link runDeferredWork}) so the first usable panel
   * never waits for either. Returns the private-filtered persisted runs
   * captured for the deferred migration. */
  async restoreLegacyStartup(deps: {
    readonly tracker: SessionRunTracker;
    readonly workingTime: WorkingTimeService;
  }): Promise<readonly RunSnapshot[]> {
    const storageStartAt = performance.now();
    const checkpoint = await this.storage.start();
    this.ports.recordStage('storage.start', storageStartAt);
    if (this.ports.isDisposed()) return [];
    deps.tracker.restore((checkpoint?.sessions ?? {}) as Parameters<SessionRunTracker['restore']>[0]);
    const openBusyIntervals = deps.tracker.getOpenBusyIntervals()
      .filter((interval) => !this.ports.isPrivateSession(interval.sessionPath));
    const persistedRuns: RunSnapshot[] = [];
    try {
      const queryStartAt = performance.now();
      const persisted = await this.storage.queryPersistedRunAnalytics();
      if (this.ports.isDisposed()) return [];
      for (const run of [...persisted.completedRuns, ...persisted.openRuns]) {
        if (!this.ports.isPrivateSession(run.sessionPath)) persistedRuns.push(run);
      }
      this.deferredMigrationRuns = persistedRuns;
      this.ports.recordStage('persisted-query', queryStartAt, {
        completedRuns: persisted.completedRuns.length,
        openRuns: persisted.openRuns.length,
      });
    } catch (error) {
      appendPieLog('warn', 'working-time', 'could not restore historical session working time', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (this.ports.isDisposed()) return persistedRuns;
    // Capture the timeline diagnostics before the warm-up so the stage
    // delta includes the timeline's own initialize counters.
    const initializeDiagnostics = this.timelineDiagnostics();
    const initializeStartAt = performance.now();
    await this.accounting.initialize();
    if (this.ports.isDisposed()) return persistedRuns;
    this.ports.recordStage('accounting.initialize', initializeStartAt, {
      ledgerRows: this.accounting.exportRecords().length,
    }, initializeDiagnostics);
    // Working-time restoration reads the timeline file projection, not the
    // ledger heal, so healing can be deferred off the startup path.
    const restoreStartAt = performance.now();
    const restoreDiagnostics = this.timelineDiagnostics();
    const activityIntervals = this.accounting.activityTimeline.projectAll()
      .filter((interval) => !this.ports.isPrivateSession(interval.sessionPath));
    deps.workingTime.restoreActivityIntervals(activityIntervals);
    const timelineCoveredBusyPaths = new Set(activityIntervals
      .filter((interval) => interval.kind === 'busy')
      .map((interval) => interval.sessionPath));
    deps.workingTime.restoreRuns(
      persistedRuns,
      openBusyIntervals.filter((interval) => !timelineCoveredBusyPaths.has(interval.sessionPath)),
    );
    this.ports.rehydrateRestoredIntervals(activityIntervals);
    this.ports.recordStage('timeline-restore', restoreStartAt, {
      restoredIntervals: activityIntervals.length,
    }, restoreDiagnostics);
    return persistedRuns;
  }

  /** Background continuation of legacy startup: ledger→timeline healing and
   * the historical usage migration, followed by the explicit compaction
   * boundary. Runs strictly after the start() promise resolved; failures are
   * logged, never surfaced as unhandled rejections. */
  async runDeferredWork(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (this.ports.isDisposed()) return;

    const healStartAt = performance.now();
    const healDiagnostics = this.timelineDiagnostics();
    try {
      const heal = await this.accounting.healActivityFromLedger({
        shouldContinue: () => !this.ports.isDisposed(),
      });
      this.ports.recordStage('timeline-healing', healStartAt, {
        ledgerRowsConsidered: heal.ledgerRowsConsidered,
        healedIntervals: heal.healedIntervals,
        activityBatchFlushes: heal.activityBatchFlushes,
        cancelled: heal.cancelled ? 1 : 0,
      }, healDiagnostics);
    } catch (error) {
      appendPieLog('warn', 'stats-service', 'activity heal failed; continuing to historical migration', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (this.ports.isDisposed()) return;

    const migrationStartAt = performance.now();
    const migrationDiagnostics = this.timelineDiagnostics();
    try {
      const metrics = await this.accounting.migrateHistoricalRunUsage(
        this.deferredMigrationRuns,
        { shouldContinue: () => !this.ports.isDisposed() },
      );
      this.ports.recordStage('historical-migration', migrationStartAt, {
        runsConsidered: metrics.runsConsidered,
        attemptedRows: metrics.attemptedRows,
        newInvocationRows: metrics.newInvocationRows,
        activityBatchFlushes: metrics.activityBatchFlushes,
        cancelled: metrics.cancelled ? 1 : 0,
      }, migrationDiagnostics);
    } catch (error) {
      appendPieLog('warn', 'stats-service', 'historical usage migration failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Explicit background compaction boundary: routine mutations append only,
    // and the migration's bounded journal batches leave delta-journal lines
    // behind. Fold them into the canonical snapshot in the background, never
    // after shutdown.
    if (this.ports.isDisposed()) return;
    try {
      await this.accounting.activityTimeline.compact({ signal: this.ports.compactionSignal() });
    } catch (error) {
      appendPieLog('warn', 'stats-service', 'activity timeline compaction failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Finalized snapshots waiting for their batched JSONL append. */
  getPendingCompletedRuns(): RunSnapshot[] {
    return this.storage.getPendingCompletedRuns();
  }

  /** Legacy durable export. Private-path/identity filtering stays with the
   * privacy-authoritative façade. */
  async exportLegacyRunAnalytics(
    targetPath: string,
    privatePaths: ReadonlySet<string>,
    privateIds: ReadonlySet<string>,
  ): Promise<RunAnalyticsExportPayload> {
    return await this.storage.exportRunAnalytics(targetPath, privatePaths, privateIds);
  }

  /** Settlement flush: pending accounting writes, then the storage flush, then
   * a final retry/timeline flush pass (exact original ordering). */
  async flush(): Promise<void> {
    this.accounting.retryPendingWrites();
    this.accounting.activityTimeline.flush();
    await this.storage.flush();
    this.accounting.retryPendingWrites();
    this.accounting.activityTimeline.flush();
  }

  /** Terminal drain: retry pending accounting writes, flush the timeline, and
   * dispose the durable storage. */
  async dispose(): Promise<void> {
    this.accounting.retryPendingWrites();
    this.accounting.activityTimeline.flush();
    await this.storage.dispose();
  }

}