import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { appendPieLog } from '../util/pie-log';
import type { Event } from '../core/events';
import type { RunSnapshot, TurnThroughputStatus } from '../run-analytics';
import type { ActivityIntervalRecord } from '../../shared/activity-interval';
import type {
  BillableInvocationKind,
  BillableInvocationRecord,
} from '../../shared/billable-invocation';
import {
  buildSubagentUsageSamples,
  sessionUsageSnapshotFromLedger,
  type SessionUsageSample,
} from '../../shared/session-usage';
import type { AssistantUsage, AuxiliaryLlmUsagePayload, SessionUsageSnapshot, ToolCall } from '../../shared/protocol';
import { BillableInvocationLedger } from '../billable-invocation-ledger/service';
import { ActivityTimeline } from '../activity-timeline/service';
import { loadModelPricing } from '../../backend/pricing';
import { pricingForPromptTokens, type ModelTokenPricing } from '../../../../shared/pricing-core';
import { resolvePricingCatalogKey } from '../../shared/model-id';
import type { RunAnalyticsExportPayload } from '../run-analytics/query';

const MIGRATION_ACTIVITY_BATCH_SIZE = 128;
/** Event-loop yield bounds for migration so an already-migrated giant single
 *  run cannot monopolize the host either: yield after this many attempted
 *  rows or after this long a synchronous slice, whichever comes first. */
const MIGRATION_YIELD_ROW_INTERVAL = 128;
const MIGRATION_YIELD_SLICE_MS = 16;
/** Bounded heal batches: the ledger→timeline heal rewrites the timeline once
 *  per this many re-derived intervals instead of one rewrite per row. */
const HEAL_ACTIVITY_BATCH_SIZE = 128;

/** Structured counters for one historical-migration pass. Persisted via the
 *  pie log on completion/cancellation and returned to the caller. */
export interface HistoricalMigrationMetrics {
  /** Legacy runs the pass began processing (including an interrupted one). */
  runsConsidered: number;
  /** Usage rows the pass attempted, including already-present (duplicate) rows. */
  attemptedRows: number;
  /** Attempted rows that produced a new durable ordinary ledger record;
 *  private (process-local) and queued-for-retry rows are not counted. */
  newInvocationRows: number;
  /** Bounded deferred-activity flushes (one timeline rewrite each). */
  activityBatchFlushes: number;
  /** Wall-clock duration of the whole pass, including yields. */
  durationMs: number;
  /** True when shutdown cancellation stopped the pass before the catalogue finished. */
  cancelled: boolean;
}

/** Structured counters for one ledger→timeline heal pass, kept separate from
 *  {@link HistoricalMigrationMetrics} because healing and historical
 *  migration are independently deferred, cancelled, and measured startup
 *  stages. */
export interface ActivityHealMetrics {
  /** Ordinary ledger rows the pass considered as heal sources. */
  ledgerRowsConsidered: number;
  /** Intervals actually appended to the timeline: new at heal start and
   *  written by a batch that applied without throwing. The timeline's own
   *  intervalId idempotence stays authoritative. */
  healedIntervals: number;
  /** Bounded heal batches (one durable timeline mutation each). */
  activityBatchFlushes: number;
  /** Monotonic duration of the whole pass, including yields. */
  durationMs: number;
  /** True when shutdown cancellation stopped the pass before the ledger finished. */
  cancelled: boolean;
}

/**
 * Host-owned billable-accounting adaptation layer between run observation and
 * the durable invocation ledger. Owns:
 *
 * - the billable invocation ledger and correlated activity timeline instances;
 * - event → immutable ledger-record adaptation (conversation, retry,
 *   auxiliary, subagent, skill-pruning prepass) with provenance and pricing;
 * - historical run/usage-snapshot migration into ledger rows;
 * - per-session branch bookkeeping used by the live usage projection;
 * - the pending-write retry queue for transient ledger failures;
 * - the privacy fence transitions over ledger/timeline/pending rows.
 *
 * The {@link ../stats-service/service.ts | StatsService} façade keeps run
 * observation and query delegation; every ledger mutation funnels through
 * here so conservation and privacy rules have one owner.
 */
export interface BillableAccountingDeps {
  /** Directory owning `billable-invocations.jsonl` and `activity-intervals.json`. */
  getStorageDir: () => string;
  now: () => Date;
  scheduleRender: () => void;
  dispatchArchEvent: (event: Event) => void;
  /** Resolve the catalog directory containing models.json for immutable pricing snapshots. */
  getAgentDir: () => string | null;
  isPrivateSession: (sessionPath: string) => boolean;
  sessionIdentity: (
    sessionPath: string,
  ) => { sessionId: string | null; modelId?: string; provider?: string };
  currentRunId: (sessionPath: string) => string | null;
  activeOperationId: (sessionPath: string) => string | null;
  /** Flag derived exports (checkpoint/JSONL) as needing regeneration. */
  markDerivedExportDirty: () => void;
  /** Canonical capture is an exclusive authority switch, never a dual-write.
   * Omitted for the legacy authority and historical tests. */
  canonicalCapture?: {
    captureProviderSettlement(record: BillableInvocationRecord): 'disabled' | 'submitted' | 'rejected';
    captureExecution(
      context: { sessionId: string | null; sessionPath: string; runId?: string | null; operationId?: string | null },
      executionId: string,
      phase: 'begin' | 'phase' | 'end' | 'transcriptEvidence',
      sourceKey: string,
      observedAtMs: number,
      fields: import('../../../../shared/analytics/contracts.js').AnalyticsExecutionFields,
    ): 'disabled' | 'submitted' | 'rejected';
  };
}

interface AppendUsageOptions {
  kind?: BillableInvocationKind;
  branchId?: string | null;
  operationId?: string | null;
  toolId?: string | null;
  outcome?: BillableInvocationRecord['outcome'];
  migration?: boolean;
  sessionId?: string | null;
  /** Startup migration passes one durable snapshot so every row does not
   * reload the full ledger and replay an already-healed activity interval. */
  existingRecords?: Map<string, BillableInvocationRecord>;
  skipExistingActivity?: boolean;
  /** Historical migration batches derived activity writes to avoid one
   * synchronous read-modify-write of the full timeline per ledger row. */
  deferredActivity?: ActivityIntervalRecord[];
  canonicalProjectionOnly?: boolean;
  /** Canonical replay cannot use receipt time as a fallback for a stable
   * producer source. Missing producer time remains the deterministic epoch. */
  stableMissingTime?: boolean;
}

export class BillableAccounting {
  readonly invocationLedger: BillableInvocationLedger;
  readonly activityTimeline: ActivityTimeline;
  private readonly deps: BillableAccountingDeps;
  private readonly pendingRetryBySession: Record<string, { sourceId: string; occurredAt: string } | undefined> = {};
  private readonly assistantInvocationObservedBySession: Record<string, boolean | undefined> = {};
  private readonly lastFailedAssistantSettlementBySession: Record<string, string | undefined> = {};
  private readonly currentBranchSourcesBySession: Record<string, Set<string> | undefined> = {};
  private readonly currentBranchEntriesBySession: Record<string, Set<string> | undefined> = {};
  private readonly currentBranchLeafBySession: Record<string, string | undefined> = {};
  /** Canonical-authority live settlements keyed by stable invocation identity,
   * mirroring the ledger's in-memory projection for the public session-usage
   * UI. The durable authority is the canonical store (P5 read model); these
   * process-local rows keep the live projection synchronous and agree with
   * what the recorder persisted. Dropped on session close/forget. */
  private readonly canonicalSettlementsBySession = new Map<string, Map<string, BillableInvocationRecord>>();
  private readonly pendingInvocationWrites = new Map<string, BillableInvocationRecord>();
  private pricingCache?: {
    signature: string;
    catalogVersion: string;
    map: ReturnType<typeof loadModelPricing>;
  };

  constructor(deps: BillableAccountingDeps) {
    this.deps = deps;
    this.invocationLedger = new BillableInvocationLedger(
      path.join(deps.getStorageDir(), 'billable-invocations.jsonl'),
    );
    this.activityTimeline = new ActivityTimeline(
      path.join(deps.getStorageDir(), 'activity-intervals.json'),
    );
  }

  /** Warm both durable stores without a synchronous full-file parse. The ledger initializes
   *  first (the authoritative source); the activity timeline's asynchronous
   *  warm-up completes before any synchronous projectAll (the startup
   *  timeline-restore stage) reads the cold cache. */
  async initialize(): Promise<void> {
    await this.invocationLedger.initialize();
    await this.activityTimeline.initialize();
  }

  /** Re-derive activity intervals from authoritative ledger rows after a
   *  restart. Ledger commit is authoritative and activity insertion is
   *  idempotent, so this heals the only possible cross-file crash boundary.
   *  Rows are applied in bounded batches (one durable timeline mutation per
   *  batch, event-loop yield between batches) so a giant ledger heal costs
   *  O(n/batch) journal appends instead of one full file rewrite per row or one
   *  monopolizing synchronous pass. A transient write failure (e.g. a
   *  sibling host or antivirus briefly holding the file) degrades to a stale
   *  derived cache — the pass stops without throwing so extension startup
   *  never aborts — and heals again on the next startup.
   *
   *  Working-time note: healed intervals are always `provider`, `auxiliary`,
   *  or `history_compaction` kinds (see {@link activityIntervalFor});
   *  {@link ../working-time-service.ts | WorkingTimeService} consumes only
   *  `busy`/`tool` intervals, so a heal that lands after working-time
   *  restoration can never rewrite or double-count live clocks. */
  async healActivityFromLedger(
    options?: { shouldContinue?: () => boolean },
  ): Promise<ActivityHealMetrics> {
    const shouldContinue = options?.shouldContinue;
    const startedAtMs = performance.now();
    let ledgerRowsConsidered = 0;
    let healedIntervals = 0;
    let activityBatchFlushes = 0;
    let cancelled = false;
    const metrics = (): ActivityHealMetrics => ({
      ledgerRowsConsidered,
      healedIntervals,
      activityBatchFlushes,
      durationMs: Math.max(0, performance.now() - startedAtMs),
      cancelled,
    });
    const finish = (): ActivityHealMetrics => {
      const result = metrics();
      appendPieLog('info', 'billable-accounting', 'activity heal metrics', { ...result });
      return result;
    };
    if (shouldContinue && !shouldContinue()) {
      cancelled = true;
      return finish();
    }
    const records = this.invocationLedger.projectAll({ includePrivate: false }).records;
    const intervals: ActivityIntervalRecord[] = [];
    for (const record of records) {
      if (!record.sessionPath || this.deps.isPrivateSession(record.sessionPath)) continue;
      ledgerRowsConsidered += 1;
      intervals.push(this.activityIntervalFor(record));
    }
    if (intervals.length === 0) return finish();
    // Idempotence knowledge snapshot: intervals already in the timeline are
    // not counted as healed when their bounded batch is checked for insertion.
    const knownIntervalIds = new Set(
      this.activityTimeline.projectAll().map((record) => record.intervalId),
    );
    let anyChanged = false;
    for (let offset = 0; offset < intervals.length; offset += HEAL_ACTIVITY_BATCH_SIZE) {
      if (shouldContinue && !shouldContinue()) {
        cancelled = true;
        break;
      }
      const batch = intervals.slice(offset, offset + HEAL_ACTIVITY_BATCH_SIZE);
      try {
        const batchChanged = this.activityTimeline.recordMany(batch, { durableRequired: true });
        if (batchChanged) {
          anyChanged = true;
          for (const record of batch) {
            if (!knownIntervalIds.has(record.intervalId)) {
              knownIntervalIds.add(record.intervalId);
              healedIntervals += 1;
            }
          }
        }
      } catch (error) {
        appendPieLog('warn', 'billable-accounting', 'activity heal failed; will retry on next startup', {
          error: error instanceof Error ? error.message : String(error),
        });
        return finish();
      }
      activityBatchFlushes += 1;
      // Yield between bounded batches so a giant ledger heal cannot
      // monopolize the extension-host event loop, and so shutdown
      // cancellation takes effect between intervals.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (anyChanged) this.deps.markDerivedExportDirty();
    return finish();
  }

  async migrateHistoricalRunUsage(
    runs: readonly RunSnapshot[],
    options?: { shouldContinue?: () => boolean },
  ): Promise<HistoricalMigrationMetrics> {
    const shouldContinue = options?.shouldContinue;
    const startedAtMs = performance.now();
    let runsConsidered = 0;
    let attemptedRows = 0;
    let newInvocationRows = 0;
    let activityBatchFlushes = 0;
    let cancelled = false;
    let sliceStartedAtMs = startedAtMs;
    const metrics = (): HistoricalMigrationMetrics => ({
      runsConsidered,
      attemptedRows,
      newInvocationRows,
      activityBatchFlushes,
      durationMs: Math.max(0, performance.now() - startedAtMs),
      cancelled,
    });
    // Shutdown can cancel this pass; it then stops at the next run boundary —
    // and between attempted rows within a run — and the remainder resumes on
    // the next startup (same crash-resume semantics as a process exit
    // mid-migration).
    if (shouldContinue && !shouldContinue()) {
      cancelled = true;
      const result = metrics();
      appendPieLog('info', 'billable-accounting', 'historical usage migration skipped', { ...result });
      return result;
    }
    // Replay every deterministic migration source independently. Existing live
    // evidence suppresses compatibility aggregates; migration evidence does
    // not, so a crash after one row can resume the remainder on restart.
    const existingRecords = new Map(
      this.invocationLedger.projectAll({ includePrivate: false }).records
        .map((record) => [record.invocationId, record] as const),
    );
    const recordsByRun = new Map<string, BillableInvocationRecord[]>();
    for (const record of existingRecords.values()) {
      if (!record.parentRunId) continue;
      const records = recordsByRun.get(record.parentRunId);
      if (records) {
        records.push(record);
      } else {
        recordsByRun.set(record.parentRunId, [record]);
      }
    }
    const deferredActivity: ActivityIntervalRecord[] = [];
    const flushDeferredActivity = (): boolean => {
      if (deferredActivity.length === 0) return false;
      const batch = deferredActivity.splice(0, deferredActivity.length);
      this.activityTimeline.recordMany(batch);
      return true;
    };
    const yieldNow = async (): Promise<void> => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      sliceStartedAtMs = performance.now();
    };

    try {
      for (const run of runs) {
        if (shouldContinue && !shouldContinue()) {
          cancelled = true;
          break;
        }
        runsConsidered += 1;
      const existingRunRecords = recordsByRun.get(run.runId) ?? [];
      const hasLiveConversation = existingRunRecords.some((record) => record.evidenceOrigin !== 'migration'
        && (record.kind === 'conversation' || record.kind === 'retry'));
      const hasLiveSubagent = existingRunRecords.some((record) => record.evidenceOrigin !== 'migration'
        && record.kind === 'subagent');
      const endedAt = run.finalizedAt ?? run.updatedAt;
      const append = async (sample: SessionUsageSample, kind: BillableInvocationKind): Promise<void> => {
        // Cancellation applies within a run, not only between runs: a giant
        // already-migrated run must not outlast a shutdown drain.
        if (shouldContinue && !shouldContinue()) {
          cancelled = true;
          return;
        }
        attemptedRows += 1;
        // Only rows the ledger actually appended as durable ordinary rows
        // count: private (process-local) and queued-for-retry rows do not.
        const appended = this.appendUsageSample(run.sessionPath, {
          ...sample,
          parentRunId: run.runId,
          startedAt: sample.startedAt ?? run.startedAt,
          endedAt: sample.endedAt ?? endedAt,
        }, {
          kind,
          migration: true,
          sessionId: run.sessionId ?? null,
          existingRecords,
          skipExistingActivity: true,
          deferredActivity,
        });
        if (appended.appendedDurable) newInvocationRows += 1;
        if (deferredActivity.length >= MIGRATION_ACTIVITY_BATCH_SIZE) {
          // Bounded activity batches: the full timeline is rewritten only
          // once per batch, then the host event loop gets a turn.
          if (flushDeferredActivity()) activityBatchFlushes += 1;
          await yieldNow();
        } else if (attemptedRows % MIGRATION_YIELD_ROW_INTERVAL === 0
          || performance.now() - sliceStartedAtMs >= MIGRATION_YIELD_SLICE_MS) {
          await yieldNow();
        }
      };
      const observedConversation = (run.auxiliaryLlmUsage ?? [])
        .filter((sample) => sample.kind === 'assistant_message');
      const residualConversation = {
        inputTokens: Math.max(0, run.inputTokens - observedConversation.reduce((sum, sample) => sum + sample.inputTokens, 0)),
        outputTokens: Math.max(0, run.outputTokens - observedConversation.reduce((sum, sample) => sum + sample.outputTokens, 0)),
        cacheReadTokens: Math.max(0, run.cacheReadTokens - observedConversation.reduce((sum, sample) => sum + sample.cacheReadTokens, 0)),
        cacheWriteTokens: Math.max(0, run.cacheWriteTokens - observedConversation.reduce((sum, sample) => sum + sample.cacheWriteTokens, 0)),
      };
      const residualConversationTotal = residualConversation.inputTokens + residualConversation.outputTokens
        + residualConversation.cacheReadTokens + residualConversation.cacheWriteTokens;
      if (!hasLiveConversation && residualConversationTotal > 0) {
        await append({
          sourceId: `legacy-run:${run.runId}:conversation-residual`,
          kind: 'conversation',
          modelId: run.modelId,
          provider: run.provider,
          ...residualConversation,
          totalTokens: residualConversationTotal,
          provenance: 'estimated',
        }, 'conversation');
      } else if (!hasLiveConversation && observedConversation.length === 0 && run.tokenReportedTurnCount > 0) {
        for (let index = 0; index < run.tokenReportedTurnCount; index += 1) {
          await append({
            sourceId: `legacy-run:${run.runId}:conversation-gap:${index}`,
            kind: 'conversation',
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 0,
            provenance: 'unknown',
            instrumentationGap: true,
            instrumentationGapReason: 'Historical run recorded a provider turn without per-invocation usage.',
            outcome: 'unknown',
          }, 'conversation');
        }
      }
      for (const [index, auxiliary] of (run.auxiliaryLlmUsage ?? []).entries()) {
        await append({
          sourceId: auxiliary.sourceId || `legacy-run:${run.runId}:auxiliary:${index}`,
          kind: auxiliary.kind === 'assistant_message' ? 'conversation' : auxiliary.kind,
          modelId: auxiliary.modelId,
          provider: auxiliary.provider,
          inputTokens: auxiliary.inputTokens,
          outputTokens: auxiliary.outputTokens,
          cacheReadTokens: auxiliary.cacheReadTokens,
          cacheWriteTokens: auxiliary.cacheWriteTokens,
          totalTokens: auxiliary.inputTokens + auxiliary.outputTokens + auxiliary.cacheReadTokens + auxiliary.cacheWriteTokens,
          ...(auxiliary.reportedCostUsd !== undefined ? { reportedCostUsd: auxiliary.reportedCostUsd } : {}),
          endedAt: auxiliary.occurredAt,
        }, auxiliary.kind === 'assistant_message' ? 'conversation' : auxiliary.kind);
      }
      const subagent = run.toolUsage;
      const observedSubagent = (run.auxiliaryLlmUsage ?? []).filter((sample) => sample.kind === 'subagent');
      const subagentResidual = {
        inputTokens: Math.max(0, subagent.subagentInputTokens - observedSubagent.reduce((sum, sample) => sum + sample.inputTokens, 0)),
        outputTokens: Math.max(0, subagent.subagentOutputTokens - observedSubagent.reduce((sum, sample) => sum + sample.outputTokens, 0)),
        cacheReadTokens: Math.max(0, subagent.subagentCacheReadTokens - observedSubagent.reduce((sum, sample) => sum + sample.cacheReadTokens, 0)),
        cacheWriteTokens: Math.max(0, subagent.subagentCacheWriteTokens - observedSubagent.reduce((sum, sample) => sum + sample.cacheWriteTokens, 0)),
      };
      const subagentTotal = subagentResidual.inputTokens + subagentResidual.outputTokens
        + subagentResidual.cacheReadTokens + subagentResidual.cacheWriteTokens;
      if (!hasLiveSubagent && subagentTotal > 0) {
        await append({
          sourceId: `legacy-run:${run.runId}:subagent-residual`,
          kind: 'subagent',
          ...subagentResidual,
          totalTokens: subagentTotal,
          provenance: 'unpriced',
        }, 'subagent');
      }
      const meteredCompactions = (run.auxiliaryLlmUsage ?? []).filter((sample) => sample.kind === 'history_compaction').length;
      for (let index = meteredCompactions; index < (run.compactionCount ?? 0); index += 1) {
        await append({
          sourceId: `legacy-run:${run.runId}:compaction-gap:${index}`,
          kind: 'history_compaction',
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          provenance: 'unknown',
          instrumentationGap: true,
          instrumentationGapReason: 'Historical compaction count had no provider usage payload.',
          outcome: 'unknown',
        }, 'history_compaction');
      }
      // Historical migration is restart work, not a prerequisite for
      // rendering the UI. Yield between runs so a large legacy catalogue
      // cannot monopolize the extension host event loop. Keep the activity
      // batch across run boundaries so the large timeline is rewritten only
      // once per bounded batch.
      await yieldNow();
      }
    } finally {
      if (flushDeferredActivity()) activityBatchFlushes += 1;
    }
    const result = metrics();
    appendPieLog('info', 'billable-accounting', 'historical usage migration metrics', { ...result });
    return result;
  }

  /** Ledger-side reset when a turn begins: clear provider-settlement and
   *  failed-settlement tracking so the turn's own evidence classifies it. */
  observeAssistantTurnStarted(sessionPath: string): void {
    this.assistantInvocationObservedBySession[sessionPath] = false;
    delete this.lastFailedAssistantSettlementBySession[sessionPath];
  }

  observeSkillPruningUsage(
    sessionPath: string,
    messageId: string,
    occurredAt: string,
    details: unknown,
  ): void {
    for (const sample of pruningUsageSamples(messageId, occurredAt, details)) {
      this.appendUsageSample(sessionPath, sample, { kind: 'skill_pruning_prepass' });
    }
  }

  /** Subagent tool results carry per-child usage samples that become
   *  `subagent` ledger rows before terminal transport compaction loses them. */
  observeSubagentToolResult(sessionPath: string, toolCall: ToolCall): void {
    if (typeof toolCall.name === 'string' && toolCall.name.trim().toLowerCase() === 'subagent') {
      const reconciledCaptureGaps = new Set<string>();
      for (const sample of buildSubagentUsageSamples(toolCall)) {
        const receipt = sample.producerCaptureReceipt;
        if (this.deps.canonicalCapture && !receipt) {
          const evidenceIdentity = sample.producerAttemptId ?? sample.sourceId;
          const executionId = `subagent-reconciliation:${toolCall.id}:${evidenceIdentity}`;
          if (!reconciledCaptureGaps.has(executionId)) {
            reconciledCaptureGaps.add(executionId);
            const identity = this.deps.sessionIdentity(sessionPath);
            this.deps.canonicalCapture.captureExecution(
              {
                sessionId: identity.sessionId,
                sessionPath,
                runId: this.deps.currentRunId(sessionPath),
                operationId: this.deps.activeOperationId(sessionPath),
              },
              executionId,
              'phase',
              `${executionId}:capture-gap`,
              stableEvidenceTime(sample.endedAt),
              {
                ...(sample.producerAttemptId ? { attemptId: sample.producerAttemptId } : {}),
                parentToolCallId: toolCall.id,
                operationKind: 'subagent-attempt',
                source: 'host-terminal-reconciliation',
                captureIncomplete: true,
                reason: 'The child terminal result had no valid fact ownership receipt; parent aggregates are reconciliation only.',
              },
            );
          }
          continue;
        }
        if (this.deps.canonicalCapture && receipt?.factStatus === 'rejected') {
          if (!reconciledCaptureGaps.has(receipt.executionId)) {
            reconciledCaptureGaps.add(receipt.executionId);
            const identity = this.deps.sessionIdentity(sessionPath);
            this.deps.canonicalCapture.captureExecution(
              {
                sessionId: identity.sessionId,
                sessionPath,
                runId: this.deps.currentRunId(sessionPath),
                operationId: this.deps.activeOperationId(sessionPath),
              },
              receipt.executionId,
              'phase',
              `subagent-reconciliation:${receipt.stableOriginId}:capture-gap`,
              stableEvidenceTime(sample.endedAt),
              {
                attemptId: receipt.attemptId,
                parentToolCallId: toolCall.id,
                operationKind: 'subagent-attempt',
                source: 'host-terminal-reconciliation',
                captureIncomplete: true,
                reason: 'The child fact ownership handoff was rejected; terminal aggregates are reconciliation only.',
                lastSubmittedSequence: receipt.lastSubmittedSequence,
                lastAcknowledgedSequence: receipt.lastAcknowledgedSequence ?? null,
                terminalDetailPayloadId: receipt.terminalDetailPayloadId,
                terminalDetailComplete: receipt.terminalDetailComplete,
              },
            );
          }
          continue;
        }
        if (this.deps.canonicalCapture && receipt?.factStatus === 'submitted') {
          // Only a real producer invocation may enter the live projection.
          // Attempt, omitted and inclusive aggregate rows remain reconciliation
          // evidence and add no synthetic provider settlement.
          if (sample.producerEvidenceKind === 'providerInvocation') {
            this.appendUsageSample(sessionPath, sample, {
              kind: 'subagent',
              toolId: toolCall.id,
              canonicalProjectionOnly: true,
              stableMissingTime: true,
            });
          }
          continue;
        }
        this.appendUsageSample(sessionPath, sample, {
          kind: 'subagent',
          toolId: toolCall.id,
          stableMissingTime: !!this.deps.canonicalCapture,
        });
      }
    }
  }

  observeAssistantTurnEnded(
    sessionPath: string,
    turnId: string,
    durationMs: number,
    usage?: AssistantUsage,
    status?: TurnThroughputStatus,
    billing?: { modelId?: string; provider?: string; occurredAt?: string; operationId?: string },
  ): void {
    const retry = this.pendingRetryBySession[sessionPath];
    const providerSettlementsObserved = this.assistantInvocationObservedBySession[sessionPath] === true;
    if (!providerSettlementsObserved && usage) {
      const endedAt = validIso(billing?.occurredAt) ?? this.deps.now().toISOString();
      this.appendUsageSample(sessionPath, {
        sourceId: `assistant:${turnId}`,
        kind: retry ? 'retry' : 'conversation',
        modelId: billing?.modelId,
        provider: billing?.provider,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        totalTokens: usage.totalTokens,
        ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
        ...(usage.reportedCostUsd !== undefined ? { reportedCostUsd: usage.reportedCostUsd } : {}),
        startedAt: new Date(Math.max(0, Date.parse(endedAt) - Math.max(0, durationMs))).toISOString(),
        endedAt,
        provenance: usage.reportedCostUsd !== undefined ? 'exact' : undefined,
      }, {
        kind: retry ? 'retry' : 'conversation',
        operationId: billing?.operationId,
        branchId: turnId,
        outcome: status === 'interrupted' ? 'cancelled' : status === 'error' ? 'failed' : 'succeeded',
      });
      delete this.pendingRetryBySession[sessionPath];
    } else if (!providerSettlementsObserved) {
      const endedAt = validIso(billing?.occurredAt) ?? this.deps.now().toISOString();
      this.appendUsageSample(sessionPath, {
        sourceId: `assistant:${turnId}`,
        kind: retry ? 'retry' : 'conversation',
        modelId: billing?.modelId,
        provider: billing?.provider,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        provenance: 'unknown',
        instrumentationGap: true,
        instrumentationGapReason: 'The provider invocation ended without an assistant usage payload.',
        startedAt: new Date(Math.max(0, Date.parse(endedAt) - Math.max(0, durationMs))).toISOString(),
        endedAt,
      }, {
        kind: retry ? 'retry' : 'conversation',
        operationId: billing?.operationId,
        branchId: turnId,
        outcome: status === 'interrupted' ? 'cancelled' : status === 'error' ? 'failed' : 'unknown',
      });
      delete this.pendingRetryBySession[sessionPath];
    }
    delete this.pendingRetryBySession[sessionPath];
    delete this.assistantInvocationObservedBySession[sessionPath];
    delete this.lastFailedAssistantSettlementBySession[sessionPath];
  }

  observeSessionUsageSnapshot(
    sessionPath: string,
    sessionId: string | undefined,
    snapshot: SessionUsageSnapshot,
  ): void {
    const existingRecords = this.invocationLedger
      .projectSession(sessionId ? { sessionId } : { sessionPath }).records;
    const existingSourceIds = new Set(existingRecords.map((record) => record.sourceId));
    this.currentBranchSourcesBySession[sessionPath] = new Set(snapshot.samples.map((sample) => sample.sourceId));
    this.currentBranchEntriesBySession[sessionPath] = new Set(snapshot.branchEntryIds ?? []);
    this.currentBranchLeafBySession[sessionPath] = snapshot.branchId;
    for (const sample of snapshot.samples) {
      // Retry classification is host-only and older transcripts contain
      // aggregate compatibility rows. Source identity prevents either from
      // duplicating already-settled per-invocation evidence on replay.
      if (existingSourceIds.has(sample.sourceId)) continue;
      let migrationSample = sample;
      if ((sample.kind === 'assistant' || sample.kind === 'conversation')
        && (sample.constituentSourceIds?.length ?? 0) > 1) {
        const constituentIds = new Set(sample.constituentSourceIds);
        const covered = existingRecords.filter((record) => constituentIds.has(record.sourceId));
        if (covered.length > 0) {
          const sum = (read: (record: BillableInvocationRecord) => number | undefined): number => covered
            .reduce((total, record) => total + (read(record) ?? 0), 0);
          const residualCost = sample.reportedCostUsd === undefined ? undefined : Math.max(
            0,
            sample.reportedCostUsd - sum((record) => record.providerReportedCostUsd
              ?? record.pricing?.calculatedCostUsd),
          );
          const residualTotal = Math.max(0, sample.totalTokens - sum((record) => record.providerTotalTokens));
          migrationSample = {
            ...sample,
            inputTokens: Math.max(0, sample.inputTokens - sum((record) => record.inputTokens)),
            outputTokens: Math.max(0, sample.outputTokens - sum((record) => record.outputTokens)),
            cacheReadTokens: Math.max(0, sample.cacheReadTokens - sum((record) => record.cacheReadTokens)),
            cacheWriteTokens: Math.max(0, sample.cacheWriteTokens - sum((record) => record.cacheWriteTokens)),
            totalTokens: residualTotal,
            providerTotalTokens: residualTotal,
            ...(residualCost !== undefined ? { reportedCostUsd: residualCost } : {}),
          };
          if (migrationSample.totalTokens === 0 && residualCost === undefined) continue;
        }
      }
      this.appendUsageSample(sessionPath, migrationSample, {
        branchId: snapshot.branchId ?? null,
        migration: true,
        sessionId: sessionId ?? null,
      });
      existingSourceIds.add(sample.sourceId);
    }
  }

  /** Adapt one auxiliary/provider usage payload into ledger evidence.
   *  Returns the channel presence decision and the normalized sample so the
   *  caller can forward compatible run-analytics observations exactly once. */
  observeAuxiliaryLlmUsage(
    sessionPath: string,
    sample: Omit<AuxiliaryLlmUsagePayload, 'sessionPath'>,
  ): {
    channelsKnown: boolean;
    sample: Omit<AuxiliaryLlmUsagePayload, 'sessionPath'>
      & { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  } {
    const channelsKnown = sample.inputTokens !== undefined && sample.outputTokens !== undefined
      && sample.cacheReadTokens !== undefined && sample.cacheWriteTokens !== undefined;
    const inputTokens = sample.inputTokens ?? 0;
    const outputTokens = sample.outputTokens ?? 0;
    const cacheReadTokens = sample.cacheReadTokens ?? 0;
    const cacheWriteTokens = sample.cacheWriteTokens ?? 0;
    const totalTokens = sample.providerTotalTokens
      ?? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
    const assistantInvocation = sample.kind === 'assistant_message';
    if (assistantInvocation) {
      this.assistantInvocationObservedBySession[sessionPath] = true;
      this.lastFailedAssistantSettlementBySession[sessionPath] = sample.outcome === 'failed'
        ? sample.sourceId : undefined;
    }
    const invocationKind: BillableInvocationKind = sample.kind === 'assistant_message'
      ? this.pendingRetryBySession[sessionPath] ? 'retry' : 'conversation'
      : sample.kind;
    this.appendUsageSample(sessionPath, {
      sourceId: sample.sourceId,
      kind: invocationKind,
      modelId: sample.modelId,
      provider: sample.provider,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens,
      tokenChannelsKnown: channelsKnown,
      tokenChannelPresence: {
        input: sample.inputTokens !== undefined,
        output: sample.outputTokens !== undefined,
        cacheRead: sample.cacheReadTokens !== undefined,
        cacheWrite: sample.cacheWriteTokens !== undefined,
      },
      ...(sample.providerTotalTokens !== undefined ? { providerTotalTokens: sample.providerTotalTokens } : {}),
      ...(sample.reportedCostUsd !== undefined ? { reportedCostUsd: sample.reportedCostUsd } : {}),
      ...(sample.parentOperationId ? { parentOperationId: sample.parentOperationId } : {}),
      endedAt: sample.occurredAt,
      startedAt: sample.startedAt
        ?? new Date(Math.max(0, Date.parse(sample.occurredAt) - (sample.durationMs ?? 0))).toISOString(),
      ...((sample.instrumentationGap || !channelsKnown) ? {
        instrumentationGap: true,
        instrumentationGapReason: sample.instrumentationGapReason
          ?? 'The provider response exposed no complete token-channel usage.',
      } : {}),
      outcome: sample.outcome,
    }, {
      kind: invocationKind,
      operationId: sample.parentOperationId ?? null,
      outcome: sample.outcome,
    });
    if (assistantInvocation) delete this.pendingRetryBySession[sessionPath];
    return { channelsKnown, sample: { ...sample, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } };
  }

  observeAutoRetry(
    sessionPath: string,
    timing?: { sourceId: string; occurredAt: string; attempt: number; scheduledDelayMs: number },
  ): void {
    if (timing) {
      const settledFailedResponse = this.lastFailedAssistantSettlementBySession[sessionPath] !== undefined;
      if (!settledFailedResponse) this.appendUsageSample(sessionPath, {
        sourceId: `retry-gap:${timing.sourceId}`,
        kind: 'retry',
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        provenance: 'unknown',
        instrumentationGap: true,
        instrumentationGapReason: 'The failed provider attempt triggered an SDK retry but exposed no per-attempt usage.',
        outcome: 'failed',
        startedAt: timing.occurredAt,
        endedAt: timing.occurredAt,
      }, { kind: 'retry', outcome: 'failed' });
      delete this.lastFailedAssistantSettlementBySession[sessionPath];
      this.pendingRetryBySession[sessionPath] = {
        sourceId: timing.sourceId,
        occurredAt: timing.occurredAt,
      };
    }
  }

  /** Stop classifying future rows for this session as private. */
  markSessionOrdinary(sessionPath: string, sessionId?: string): void {
    this.invocationLedger.transaction(() => {
      this.invocationLedger.markSessionOrdinary({ sessionPath });
      if (sessionId) this.invocationLedger.markSessionOrdinary({ sessionId });
    });
  }

  /** Publish the durable privacy fence before touching pending rows, then
   *  scrub the live timeline and reclassify queued writes as process-local.
   *  Stale sibling hosts classify any concurrent append as process-local. */
  markSessionPrivate(sessionPath: string, sessionId?: string): void {
    this.invocationLedger.transaction(() => {
      this.invocationLedger.markSessionPrivate({ sessionPath });
      if (sessionId) this.invocationLedger.markSessionPrivate({ sessionId });
    });
    this.activityTimeline.forgetSession(sessionPath, sessionId);
    for (const [invocationId, record] of this.pendingInvocationWrites) {
      if (record.sessionPath !== sessionPath && (!sessionId || record.sessionId !== sessionId)) continue;
      this.pendingInvocationWrites.delete(invocationId);
      this.invocationLedger.append(record, { visibility: 'private' });
    }
    this.deps.markDerivedExportDirty();
  }

  /** Flags/branch bookkeeping cleanup shared by every close path. */
  onSessionClosed(sessionPath: string): void {
    delete this.currentBranchSourcesBySession[sessionPath];
    delete this.currentBranchEntriesBySession[sessionPath];
    delete this.currentBranchLeafBySession[sessionPath];
    delete this.pendingRetryBySession[sessionPath];
    delete this.assistantInvocationObservedBySession[sessionPath];
    delete this.lastFailedAssistantSettlementBySession[sessionPath];
    this.canonicalSettlementsBySession.delete(sessionPath);
  }

  /** Close a private session: scrub process-local rows, release the privacy
   *  fence, and drop per-session accounting state. */
  forgetSession(sessionPath: string, sessionId?: string): void {
    this.invocationLedger.scrubPrivateRecords({ sessionPath });
    this.onSessionClosed(sessionPath);
    this.markSessionOrdinary(sessionPath, sessionId);
  }

  replaceSessionPath(oldPath: string, newPath: string): void {
    const sources = this.currentBranchSourcesBySession[oldPath];
    if (sources) this.currentBranchSourcesBySession[newPath] = sources;
    const entries = this.currentBranchEntriesBySession[oldPath];
    if (entries) this.currentBranchEntriesBySession[newPath] = entries;
    const leaf = this.currentBranchLeafBySession[oldPath];
    if (leaf) this.currentBranchLeafBySession[newPath] = leaf;
    delete this.currentBranchSourcesBySession[oldPath];
    delete this.currentBranchEntriesBySession[oldPath];
    delete this.currentBranchLeafBySession[oldPath];
    const settlements = this.canonicalSettlementsBySession.get(oldPath);
    if (settlements) this.canonicalSettlementsBySession.set(newPath, settlements);
    this.canonicalSettlementsBySession.delete(oldPath);
  }

  /** Flush queued ledger writes that failed transiently; retained rows keep
   *  their stable identities so retries stay idempotent. */
  retryPendingWrites(): void {
    for (const [invocationId, record] of this.pendingInvocationWrites) {
      try {
        this.persistInvocationRecord(record);
        this.pendingInvocationWrites.delete(invocationId);
        this.deps.markDerivedExportDirty();
        if (record.sessionPath && (record.kind === 'conversation' || record.kind === 'retry'
          || record.kind === 'subagent' || record.kind === 'skill_pruning_prepass')) {
          this.currentBranchSourcesBySession[record.sessionPath]?.add(record.sourceId);
        }
        this.deps.scheduleRender();
      } catch {
        // Retain for the next invocation/flush/shutdown attempt. The first
        // failure already surfaced a host notice with the stable identity.
      }
    }
  }

  /** Ledger/canonical-backed session usage projection for UI and fixture
   *  conservation checks. Canonical mode projects the in-memory settlements
   *  this host captured; empty means the projection is not answerable
   *  synchronously (authority `unknown`) and the P5 canonical read model is
   *  the async authority — legacy JSONL is never substituted. */
  projectSessionUsage(sessionPath: string): SessionUsageSnapshot {
    const currentSources = this.currentBranchSourcesBySession[sessionPath];
    const currentEntries = this.currentBranchEntriesBySession[sessionPath];
    const filter = (record: BillableInvocationRecord): boolean => (
      !currentSources
      || (record.kind !== 'conversation' && record.kind !== 'retry'
        && record.kind !== 'subagent' && record.kind !== 'skill_pruning_prepass')
      || currentSources.has(record.sourceId)
      || (record.branchId !== null && currentEntries?.has(record.branchId) === true)
      || ((record.kind === 'conversation' || record.kind === 'retry') && record.sourceId.startsWith('assistant:')
        && currentEntries?.has(record.sourceId.slice('assistant:'.length)) === true)
    );
    const canonical = this.canonicalSettlementsBySession.get(sessionPath);
    if (this.deps.canonicalCapture) {
      if (!canonical || canonical.size === 0) {
        return { samples: [], authority: 'unknown' };
      }
      return sessionUsageSnapshotFromLedger([...canonical.values()].filter(filter), 'canonical');
    }
    const records = this.invocationLedger.projectSession({ sessionPath }).records.filter(filter);
    return sessionUsageSnapshotFromLedger(records);
  }

  /** Immutable ordinary invocation rows used by aggregate projections/export. */
  exportRecords(): readonly BillableInvocationRecord[] {
    return this.invocationLedger.exportRecords();
  }

  /** Ledger/timeline export payload consumed by run analytics exports. */
  getBillableInvocationExport(): Pick<
    RunAnalyticsExportPayload,
    'billableInvocations' | 'billableInvocationSummary' | 'activityIntervals'
  > {
    return {
      billableInvocations: [...this.invocationLedger.exportRecords()],
      billableInvocationSummary: this.invocationLedger.projectAll({ includePrivate: false }).summary,
      activityIntervals: [...this.activityTimeline.projectAll()],
    };
  }

  private pricingFor(
    modelId: string | undefined,
    provider: string | undefined,
    usage: Pick<SessionUsageSample, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>,
  ): BillableInvocationRecord['pricing'] {
    if (!modelId) return undefined;
    const agentDir = this.deps.getAgentDir();
    if (!agentDir) return undefined;
    const modelsPath = path.join(agentDir, 'models.json');
    let stat: fs.Stats;
    let raw: string;
    try {
      stat = fs.statSync(modelsPath);
      raw = fs.readFileSync(modelsPath, 'utf8');
    } catch {
      return undefined;
    }
    const signature = `${modelsPath}:${stat.mtimeMs}:${stat.size}`;
    if (this.pricingCache?.signature !== signature) {
      this.pricingCache = {
        signature,
        catalogVersion: `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`,
        map: loadModelPricing(modelsPath, path.join(agentDir, 'analysis', 'model-pricing-history.json')),
      };
    }
    const key = resolvePricingCatalogKey(modelId, (candidate) => this.pricingCache!.map.has(candidate));
    const records = key ? this.pricingCache.map.get(key) : undefined;
    const pricing = records?.find((record) => !provider || record.provider === provider)?.pricing
      ?? (records?.length === 1 ? records[0]?.pricing : undefined);
    if (!pricing) return undefined;
    const effective = pricingForPromptTokens(
      pricing,
      usage.inputTokens,
      usage.cacheReadTokens,
      usage.cacheWriteTokens,
    );
    return {
      catalogVersion: this.pricingCache.catalogVersion,
      calculatedCostUsd: calculatedCost(usage, effective),
      rateSnapshot: {
        inputTokensUsdPerMillion: effective.input,
        outputTokensUsdPerMillion: effective.output,
        cacheReadTokensUsdPerMillion: effective.cacheRead,
        cacheWriteTokensUsdPerMillion: effective.cacheWrite,
      },
    };
  }

  /** Persist one invocation row and its correlated activity interval as one
   *  workspace transaction. Returns whether the row was actually appended as
   *  a durable ordinary ledger row (private/process-local and duplicate rows
   *  return false) so callers can report honest append metrics. */
  private persistInvocationRecord(
    record: BillableInvocationRecord,
    deferredActivity?: ActivityIntervalRecord[],
  ): boolean {
    return this.invocationLedger.transaction(() => {
      const appended = this.invocationLedger.append(record, {
        visibility: record.sessionPath && this.deps.isPrivateSession(record.sessionPath) ? 'private' : 'ordinary',
      }) === 'appended';
      if (deferredActivity && record.sessionPath && !this.deps.isPrivateSession(record.sessionPath)) {
        deferredActivity.push(this.activityIntervalFor(record));
      } else {
        this.recordInvocationActivity(record);
      }
      return appended;
    });
  }

  private appendUsageSample(
    sessionPath: string,
    sample: SessionUsageSample,
    options: AppendUsageOptions = {},
  ): { invocationId: string; appendedDurable: boolean } {
    this.retryPendingWrites();
    const identity = this.deps.sessionIdentity(sessionPath);
    const stableSessionId = options.sessionId ?? identity.sessionId;
    const kind = options.kind ?? ledgerKind(sample.kind);
    const invocationId = this.deps.canonicalCapture && sample.canonicalInvocationId
      ? sample.canonicalInvocationId
      : stableInvocationId(stableSessionId ?? sessionPath, kind, sample.sourceId);
    const existing = this.deps.canonicalCapture ? undefined : (
      options.existingRecords?.get(invocationId)
      ?? this.invocationLedger.projectAll().records.find((record) => record.invocationId === invocationId)
    );
    if (existing) {
      if (!options.skipExistingActivity) {
        this.invocationLedger.transaction(() => this.recordInvocationActivity(existing));
      }
      return { invocationId, appendedDurable: false };
    }
    const normalizedTimes = normalizeInvocationTimes(
      sample.startedAt,
      sample.endedAt,
      options.stableMissingTime ? new Date(0) : this.deps.now(),
      sample.sourceId,
    );
    const { startedAt, endedAt } = normalizedTimes;
    const provider = sample.provider ?? identity.provider ?? 'unknown-provider';
    const model = sample.modelId ?? identity.modelId ?? 'unknown-model';
    const gap = sample.instrumentationGap === true || sample.provenance === 'unknown';
    const pricing = gap || sample.tokenChannelsKnown === false
      || sample.provenance === 'unpriced' || sample.provenance === 'unknown'
      ? undefined : this.pricingFor(model, provider, sample);
    const provenance = sample.provenance
      ?? (sample.reportedCostUsd !== undefined ? 'exact'
        : gap ? 'unknown'
          : pricing ? 'estimated' : 'unpriced');
    const base = {
      schemaVersion: 1 as const,
      invocationId,
      sourceId: sample.sourceId,
      sessionId: stableSessionId,
      sessionPath,
      branchId: options.branchId ?? this.currentBranchLeafBySession[sessionPath] ?? null,
      parentOperationId: options.operationId ?? sample.parentOperationId ?? null,
      parentRunId: sample.parentRunId ?? this.deps.currentRunId(sessionPath),
      parentToolId: options.toolId ?? sample.parentToolId ?? null,
      kind,
      provider,
      model,
      provenance,
      evidenceOrigin: options.migration ? 'migration' as const : 'live' as const,
      startedAt,
      endedAt,
      outcome: options.outcome ?? sample.outcome ?? 'succeeded',
    };
    const costEvidence = {
      ...(sample.reportedCostUsd !== undefined ? { providerReportedCostUsd: sample.reportedCostUsd } : {}),
      ...(pricing ? { pricing } : {}),
    };
    const record: BillableInvocationRecord = gap ? {
      ...base,
      instrumentationGap: true,
      instrumentationGapReason: sample.instrumentationGapReason
        ?? 'This provider seam did not expose complete per-invocation usage.',
      ...(sample.tokenChannelPresence?.input ? { inputTokens: sample.inputTokens } : {}),
      ...(sample.tokenChannelPresence?.output ? { outputTokens: sample.outputTokens } : {}),
      ...(sample.tokenChannelPresence?.cacheRead ? { cacheReadTokens: sample.cacheReadTokens } : {}),
      ...(sample.tokenChannelPresence?.cacheWrite ? { cacheWriteTokens: sample.cacheWriteTokens } : {}),
      ...(sample.providerTotalTokens !== undefined ? { providerTotalTokens: sample.providerTotalTokens } : {}),
      ...costEvidence,
    } : {
      ...base,
      instrumentationGap: false,
      inputTokens: sample.inputTokens,
      outputTokens: sample.outputTokens,
      cacheReadTokens: sample.cacheReadTokens,
      cacheWriteTokens: sample.cacheWriteTokens,
      ...(sample.reasoningTokens !== undefined ? { reasoningTokens: sample.reasoningTokens } : {}),
      providerTotalTokens: sample.providerTotalTokens ?? sample.totalTokens,
      ...costEvidence,
    };
    if (this.deps.canonicalCapture) {
      const capture = options.canonicalProjectionOnly
        ? 'submitted'
        : this.deps.canonicalCapture.captureProviderSettlement(record);
      if (capture === 'rejected') {
        appendPieLog('warn', 'canonical-analytics', 'provider settlement capture rejected', {
          invocationId: record.invocationId,
          sourceId: record.sourceId,
        });
      } else if (capture === 'submitted') {
        // Live consumer path: keep the settled record in the bounded process-local
        // projection so the synchronous session-usage UI reads the same facts the
        // recorder persisted. Durable historical queries use the P5 read model.
        let settlements = this.canonicalSettlementsBySession.get(sessionPath);
        if (!settlements) {
          settlements = new Map();
          this.canonicalSettlementsBySession.set(sessionPath, settlements);
        }
        settlements.set(record.invocationId, record);
      }
      // Canonical mode never falls through to the legacy JSONL ledger. P5
      // replaces the legacy query consumers before P7 is allowed to select
      // this authority.
      return { invocationId, appendedDurable: false };
    }
    try {
      const appendedDurable = this.persistInvocationRecord(record, options.deferredActivity);
      options.existingRecords?.set(record.invocationId, record);
      this.deps.markDerivedExportDirty();
      if (kind === 'conversation' || kind === 'retry' || kind === 'subagent' || kind === 'skill_pruning_prepass') {
        this.currentBranchSourcesBySession[sessionPath]?.add(sample.sourceId);
      }
      this.deps.scheduleRender();
      return { invocationId, appendedDurable };
    } catch (error) {
      this.pendingInvocationWrites.set(record.invocationId, record);
      appendPieLog('warn', 'billable-ledger', 'could not append invocation; queued for retry', {
        sessionPath,
        sourceId: sample.sourceId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.deps.dispatchArchEvent({
        kind: 'NoticeShown',
        notice: 'pie could not persist provider usage accounting. The invocation is queued for retry.',
        noticeKind: 'operational-error',
        noticeRaw: `Billable invocation ${record.invocationId} persistence failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    return { invocationId, appendedDurable: false };
  }

  private recordInvocationActivity(record: BillableInvocationRecord): void {
    const sessionPath = record.sessionPath;
    if (!sessionPath || this.deps.isPrivateSession(sessionPath)) return;
    this.activityTimeline.record(this.activityIntervalFor(record), { durableRequired: true });
    this.deps.markDerivedExportDirty();
  }

  private activityIntervalFor(record: BillableInvocationRecord): ActivityIntervalRecord {
    const kind: ActivityIntervalRecord['kind'] = record.kind === 'history_compaction'
      ? 'history_compaction'
      : record.kind === 'conversation' || record.kind === 'retry'
        ? 'provider' : 'auxiliary';
    return {
      schemaVersion: 1,
      intervalId: `activity:invocation:${record.invocationId}`,
      sessionId: record.sessionId,
      sessionPath: record.sessionPath as string,
      parentRunId: record.parentRunId,
      parentOperationId: record.parentOperationId,
      invocationId: record.invocationId,
      toolId: record.parentToolId,
      kind,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      outcome: record.outcome,
    };
  }
}

function validIso(value: string | undefined): string | undefined {
  if (!value || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(Date.parse(value)).toISOString();
}

function stableEvidenceTime(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function normalizeInvocationTimes(
  startedAtValue: string | undefined,
  endedAtValue: string | undefined,
  now: Date,
  sourceId: string,
): { startedAt: string; endedAt: string } {
  const endedAt = validIso(endedAtValue) ?? validIso(startedAtValue) ?? now.toISOString();
  const originalStartedAt = validIso(startedAtValue);
  if (originalStartedAt && Date.parse(endedAt) < Date.parse(originalStartedAt)) {
    appendPieLog('warn', 'billable-accounting', 'provider usage timestamps were reversed; clamping start to end', {
      sourceId,
      startedAt: originalStartedAt,
      endedAt,
    });
    return { startedAt: endedAt, endedAt };
  }
  return {
    startedAt: originalStartedAt ?? endedAt,
    endedAt,
  };
}

function stableInvocationId(sessionIdentity: string, kind: BillableInvocationKind, sourceId: string): string {
  return `inv:${crypto.createHash('sha256').update(`${sessionIdentity}\0${kind}\0${sourceId}`).digest('hex')}`;
}

function ledgerKind(kind: SessionUsageSample['kind']): BillableInvocationKind {
  if (kind === 'assistant') return 'conversation';
  return kind;
}

function calculatedCost(
  usage: Pick<SessionUsageSample, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>,
  pricing: ModelTokenPricing,
): number {
  return (usage.inputTokens * pricing.input
    + usage.outputTokens * pricing.output
    + usage.cacheReadTokens * pricing.cacheRead
    + usage.cacheWriteTokens * pricing.cacheWrite) / 1_000_000;
}

function pruningUsageSamples(messageId: string, occurredAt: string, details: unknown): SessionUsageSample[] {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return [];
  const value = details as Record<string, unknown>;
  const invocations = Array.isArray(value.prepassInvocations) ? value.prepassInvocations : undefined;
  if (invocations) {
    return invocations.flatMap((candidate, index) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
      const invocation = candidate as Record<string, unknown>;
      const read = (key: string): number | undefined => typeof invocation[key] === 'number'
        && Number.isFinite(invocation[key]) && (invocation[key] as number) >= 0
        ? invocation[key] as number : undefined;
      const input = read('input');
      const output = read('output');
      const cacheRead = read('cacheRead');
      const cacheWrite = read('cacheWrite');
      const usageKnown = input !== undefined && output !== undefined
        && cacheRead !== undefined && cacheWrite !== undefined;
      const sourceId = typeof invocation.invocationId === 'string' && invocation.invocationId.trim()
        ? invocation.invocationId : `skill-pruning:${messageId}:attempt:${index}`;
      const startedAt = validIso(typeof invocation.startedAt === 'string' ? invocation.startedAt : undefined)
        ?? occurredAt;
      const endedAt = validIso(typeof invocation.endedAt === 'string' ? invocation.endedAt : undefined)
        ?? occurredAt;
      const reportedCost = read('reportedCostUsd');
      return [{
        sourceId,
        kind: 'skill_pruning_prepass',
        modelId: typeof value.prepassModel === 'string' ? value.prepassModel : undefined,
        provider: typeof value.prepassProvider === 'string' ? value.prepassProvider : undefined,
        inputTokens: input ?? 0,
        outputTokens: output ?? 0,
        cacheReadTokens: cacheRead ?? 0,
        cacheWriteTokens: cacheWrite ?? 0,
        totalTokens: usageKnown ? input + output + cacheRead + cacheWrite : 0,
        ...(reportedCost !== undefined ? { reportedCostUsd: reportedCost } : {}),
        provenance: usageKnown ? (reportedCost !== undefined ? 'exact' : 'estimated') : 'unknown',
        instrumentationGap: !usageKnown,
        ...(!usageKnown ? { instrumentationGapReason: 'The pruning provider invocation returned no usage.' } : {}),
        outcome: invocation.outcome === 'failed' || invocation.outcome === 'cancelled'
          ? invocation.outcome : 'succeeded',
        startedAt,
        endedAt,
      } satisfies SessionUsageSample];
    });
  }

  if (value.cacheHit === true) return [];
  const read = (key: string): number => typeof value[key] === 'number'
    && Number.isFinite(value[key]) && (value[key] as number) >= 0 ? value[key] as number : 0;
  const inputTokens = read('prepassInputTokens');
  const outputTokens = read('prepassOutputTokens');
  const cacheReadTokens = read('prepassCacheReadTokens');
  const cacheWriteTokens = read('prepassCacheWriteTokens');
  const reportedCostUsd = typeof value.prepassReportedCostUsd === 'number'
    && Number.isFinite(value.prepassReportedCostUsd) && value.prepassReportedCostUsd >= 0
    ? value.prepassReportedCostUsd : undefined;
  const hasUsage = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens > 0
    || reportedCostUsd !== undefined;
  if (!value.prepassModel && !hasUsage && !value.prepassError) return [];
  return [{
    sourceId: `skill-pruning:${messageId}`,
    kind: 'skill_pruning_prepass',
    modelId: typeof value.prepassModel === 'string' ? value.prepassModel : undefined,
    provider: typeof value.prepassProvider === 'string' ? value.prepassProvider : undefined,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    ...(reportedCostUsd !== undefined ? { reportedCostUsd } : {}),
    provenance: hasUsage ? (reportedCostUsd !== undefined ? 'exact' : 'estimated') : 'unknown',
    instrumentationGap: !hasUsage,
    ...(!hasUsage ? { instrumentationGapReason: 'The pruning prepass completed without provider usage.' } : {}),
    outcome: value.prepassError ? 'failed' : 'succeeded',
    startedAt: occurredAt,
    endedAt: occurredAt,
  }];
}
