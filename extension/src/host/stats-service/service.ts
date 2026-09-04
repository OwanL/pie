import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { defaultCreateId, defaultNow } from './helpers';
import { appendPieLog } from '../util/pie-log';
import type { RunAnalyticsExportPayload, RunAnalyticsQueryResult } from '../run-analytics/query';
import type { RunSnapshot, TurnLatencyMeasurement, TurnThroughputStatus } from '../run-analytics';
import type {
  AssistantUsage,
  AuxiliaryLlmUsagePayload,
  ComposerInput,
  ThinkingLevel,
  ToolCall,
  WorkingTimeState,
} from '../../shared/protocol';
import { RunAnalyticsStorage } from './storage';
import { SessionRunTracker } from './tracker';
import type { RunObserver, StatsServiceOptions } from './types';
import { resolveSessionIdentity } from '../../backend/session-review-store';
import { WorkingTimeService } from '../working-time-service';
import { BillableInvocationLedger } from '../billable-invocation-ledger/service';
import { ActivityTimeline } from '../activity-timeline/service';
import type { ActivityIntervalRecord } from '../../shared/activity-interval';
import type {
  BillableInvocationKind,
  BillableInvocationOutcome,
  BillableInvocationRecord,
} from '../../shared/billable-invocation';
import {
  buildSubagentUsageSamples,
  sessionUsageSnapshotFromLedger,
  type SessionUsageSample,
  type SessionUsageSnapshot,
} from '../../shared/session-usage';
import { loadModelPricing } from '../../backend/pricing';
import { pricingForPromptTokens, type ModelTokenPricing } from '../../../../shared/pricing-core';
import { resolvePricingCatalogKey } from '../../shared/model-id';

export class StatsService implements RunObserver {
  private readonly scheduleRender: () => void;
  private readonly getArchState: NonNullable<StatsServiceOptions['getArchState']>;
  private readonly dispatchArchEvent: NonNullable<StatsServiceOptions['dispatchArchEvent']>;
  private readonly tracker: SessionRunTracker;
  private readonly storage: RunAnalyticsStorage;
  private readonly workingTime: WorkingTimeService;
  private readonly invocationLedger: BillableInvocationLedger;
  private readonly activityTimeline: ActivityTimeline;
  private readonly activeBusyIntervalsBySession: Record<string, Set<string> | undefined> = {};
  private readonly activeToolIntervalBySessionAndTool: Record<string, string | undefined> = {};
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly getAgentDir: () => string | null;
  private readonly pendingRetryBySession: Record<string, { sourceId: string; occurredAt: string }> = {};
  private readonly assistantInvocationObservedBySession: Record<string, boolean | undefined> = {};
  private readonly lastFailedAssistantSettlementBySession: Record<string, string | undefined> = {};
  private readonly currentBranchSourcesBySession: Record<string, Set<string> | undefined> = {};
  private readonly currentBranchEntriesBySession: Record<string, Set<string> | undefined> = {};
  private readonly currentBranchLeafBySession: Record<string, string | undefined> = {};
  private readonly pendingInvocationWrites = new Map<string, BillableInvocationRecord>();
  private pricingCache?: {
    signature: string;
    catalogVersion: string;
    map: ReturnType<typeof loadModelPricing>;
  };
  private startPromise: Promise<void> | null = null;
  private started = false;

  constructor(options: StatsServiceOptions) {
    this.scheduleRender = options.scheduleRender ?? (() => undefined);
    const dispatchArchEvent = options.dispatchArchEvent ?? ((_event) => { /* no-op if not provided */ });
    this.dispatchArchEvent = dispatchArchEvent;
    const getArchState = options.getArchState ?? (() => { throw new Error('getArchState not provided'); });
    this.getArchState = getArchState;
    const now = options.now ?? defaultNow;
    const createId = options.createId ?? defaultCreateId;
    this.now = now;
    this.createId = createId;
    this.getAgentDir = options.getAgentDir ?? (() => null);
    const getExperimentAssignment = options.getExperimentAssignment ?? (() => null);
    this.workingTime = new WorkingTimeService({
      now,
      onChanged: this.scheduleRender,
    });

    const trackerRef: { current: SessionRunTracker | null } = { current: null };
    const ledgerRef: { current: BillableInvocationLedger | null } = { current: null };
    const timelineRef: { current: ActivityTimeline | null } = { current: null };
    this.storage = new RunAnalyticsStorage({
      dataOutcomesRootPath: options.dataOutcomesRootPath,
      legacyUsageDataRootPath: options.legacyUsageDataRootPath,
      workspaceId: options.workspaceId,
      legacyWorkspaceIds: options.legacyWorkspaceIds,
      now,
      serializeSessions: () => trackerRef.current?.serializeSessions() ?? {},
      getBillableInvocationExport: () => {
        const ledger = ledgerRef.current;
        return ledger ? {
          billableInvocations: [...ledger.exportRecords()],
          billableInvocationSummary: ledger.projectAll({ includePrivate: false }).summary,
          activityIntervals: [...(timelineRef.current?.projectAll() ?? [])],
        } : { billableInvocations: [], activityIntervals: [] };
      },
      onPersistError: ({ message, at }) => {
        appendPieLog('warn', 'run-analytics', 'persistence error surfaced to UI', { at, error: message });
        dispatchArchEvent({
          kind: 'NoticeShown',
          notice: 'pie could not write run analytics to disk. Some diagnostics may be missing until this is fixed.',
          noticeKind: 'operational-error',
          noticeRaw: `Run analytics persistence failed at ${at}: ${message}`,
        });
      },
    });
    this.invocationLedger = new BillableInvocationLedger(
      path.join(this.storage.getStorageDir(), 'billable-invocations.jsonl'),
    );
    ledgerRef.current = this.invocationLedger;
    this.activityTimeline = new ActivityTimeline(
      path.join(this.storage.getStorageDir(), 'activity-intervals.json'),
    );
    timelineRef.current = this.activityTimeline;
    const tracker = new SessionRunTracker({
      getArchState,
      dispatchArchEvent,
      scheduleRender: this.scheduleRender,
      schedulePersist: (snapshotToAppend) => this.storage.schedulePersist(snapshotToAppend),
      now,
      createId,
      getExperimentAssignment,
    });
    trackerRef.current = tracker;
    this.tracker = tracker;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    if (this.startPromise) {
      return await this.startPromise;
    }

    this.startPromise = (async () => {
      const checkpoint = await this.storage.start();
      this.tracker.restore(checkpoint?.sessions ?? {});
      const openBusyIntervals = this.tracker.getOpenBusyIntervals()
        .filter((interval) => !this.isPrivateSession(interval.sessionPath));
      let persistedRuns: RunSnapshot[] = [];
      try {
        const persisted = await this.storage.queryPersistedRunAnalytics();
        persistedRuns = [...persisted.completedRuns, ...persisted.openRuns]
          .filter((run) => !this.isPrivateSession(run.sessionPath));
      } catch (error) {
        appendPieLog('warn', 'working-time', 'could not restore historical session working time', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      // Heal the only possible cross-file crash boundary before projections:
      // ledger commit is authoritative and activity insertion is idempotent.
      this.invocationLedger.transaction(() => {
        for (const record of this.invocationLedger.projectAll({ includePrivate: false }).records) {
          this.recordInvocationActivity(record);
        }
      });
      const activityIntervals = this.activityTimeline.projectAll()
        .filter((interval) => !this.isPrivateSession(interval.sessionPath));
      this.workingTime.restoreActivityIntervals(activityIntervals);
      const timelineCoveredBusyPaths = new Set(activityIntervals
        .filter((interval) => interval.kind === 'busy')
        .map((interval) => interval.sessionPath));
      this.workingTime.restoreRuns(
        persistedRuns,
        openBusyIntervals.filter((interval) => !timelineCoveredBusyPaths.has(interval.sessionPath)),
      );
      for (const interval of activityIntervals) {
        if (!interval.endedAt && interval.kind === 'busy') {
          (this.activeBusyIntervalsBySession[interval.sessionPath] ??= new Set()).add(interval.intervalId);
        } else if (!interval.endedAt && interval.kind === 'tool' && interval.toolId) {
          this.activeToolIntervalBySessionAndTool[this.toolIntervalKey(interval.sessionPath, interval.toolId)] = interval.intervalId;
        }
      }
      this.migrateHistoricalRunUsage(persistedRuns);
      this.started = true;
      this.scheduleRender();
    })();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private isPrivateSession(sessionPath: string): boolean {
    return this.getArchState().sessions.privacyModeBySession[sessionPath] === true;
  }

  private syncWorkingTimeBreakdown(sessionPath: string): void {
    const run = this.tracker.getMostRelevantRun(sessionPath);
    if (run) this.workingTime.observeRun(run);
  }

  private sessionIdentity(sessionPath: string): { sessionId: string | null; modelId?: string; provider?: string } {
    const summary = this.getArchState().sessions.sessions.find((session) => session.path === sessionPath);
    return {
      sessionId: summary?.identityFallback === true ? null : summary?.sessionId?.trim() || null,
      modelId: summary?.modelId,
      provider: summary?.provider,
    };
  }

  private currentRunId(sessionPath: string): string | null {
    return this.tracker.getMostRelevantRun(sessionPath)?.runId ?? null;
  }

  private pricingFor(
    modelId: string | undefined,
    provider: string | undefined,
    usage: Pick<SessionUsageSample, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>,
  ): BillableInvocationRecord['pricing'] {
    if (!modelId) return undefined;
    const agentDir = this.getAgentDir();
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

  private persistInvocationRecord(record: BillableInvocationRecord): void {
    this.invocationLedger.transaction(() => {
      this.invocationLedger.append(record, {
        visibility: record.sessionPath && this.isPrivateSession(record.sessionPath) ? 'private' : 'ordinary',
      });
      this.recordInvocationActivity(record);
    });
  }

  private retryPendingInvocationWrites(): void {
    for (const [invocationId, record] of this.pendingInvocationWrites) {
      try {
        this.persistInvocationRecord(record);
        this.pendingInvocationWrites.delete(invocationId);
        this.storage.markDerivedExportDirty();
        if (record.sessionPath && (record.kind === 'conversation' || record.kind === 'retry'
          || record.kind === 'subagent' || record.kind === 'skill_pruning_prepass')) {
          this.currentBranchSourcesBySession[record.sessionPath]?.add(record.sourceId);
        }
        this.scheduleRender();
      } catch {
        // Retain for the next invocation/flush/shutdown attempt. The first
        // failure already surfaced a host notice with the stable identity.
      }
    }
  }

  private appendUsageSample(
    sessionPath: string,
    sample: SessionUsageSample,
    options: {
      kind?: BillableInvocationKind;
      branchId?: string | null;
      operationId?: string | null;
      toolId?: string | null;
      outcome?: BillableInvocationOutcome;
      migration?: boolean;
      sessionId?: string | null;
    } = {},
  ): string {
    this.retryPendingInvocationWrites();
    const identity = this.sessionIdentity(sessionPath);
    const stableSessionId = options.sessionId ?? identity.sessionId;
    const kind = options.kind ?? ledgerKind(sample.kind);
    const invocationId = stableInvocationId(stableSessionId ?? sessionPath, kind, sample.sourceId);
    const existing = this.invocationLedger.projectAll().records.find((record) => record.invocationId === invocationId);
    if (existing) {
      this.invocationLedger.transaction(() => this.recordInvocationActivity(existing));
      return invocationId;
    }
    const endedAt = validIso(sample.endedAt) ?? validIso(sample.startedAt) ?? this.now().toISOString();
    const startedAt = validIso(sample.startedAt)
      ?? new Date(Math.max(0, Date.parse(endedAt))).toISOString();
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
      parentRunId: sample.parentRunId ?? this.currentRunId(sessionPath),
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
    try {
      this.persistInvocationRecord(record);
      this.storage.markDerivedExportDirty();
      if (kind === 'conversation' || kind === 'retry' || kind === 'subagent' || kind === 'skill_pruning_prepass') {
        this.currentBranchSourcesBySession[sessionPath]?.add(sample.sourceId);
      }
      this.scheduleRender();
    } catch (error) {
      this.pendingInvocationWrites.set(record.invocationId, record);
      appendPieLog('warn', 'billable-ledger', 'could not append invocation; queued for retry', {
        sessionPath,
        sourceId: sample.sourceId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.dispatchArchEvent({
        kind: 'NoticeShown',
        notice: 'pie could not persist provider usage accounting. The invocation is queued for retry.',
        noticeKind: 'operational-error',
        noticeRaw: `Billable invocation ${record.invocationId} persistence failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    return invocationId;
  }

  private activeOperationId(sessionPath: string): string | null {
    const operation = Object.values(this.getArchState().operations).find((candidate) => (
      !candidate.terminal
      && (candidate.session.resolvedPath === sessionPath || candidate.session.pendingPath === sessionPath)
    ));
    return operation?.operationId ?? null;
  }

  private toolIntervalKey(sessionPath: string, toolId: string): string {
    return `${sessionPath}\0${toolId}`;
  }

  private recordInvocationActivity(record: BillableInvocationRecord): void {
    const sessionPath = record.sessionPath;
    if (!sessionPath || this.isPrivateSession(sessionPath)) return;
    const kind: ActivityIntervalRecord['kind'] = record.kind === 'history_compaction'
      ? 'history_compaction'
      : record.kind === 'conversation' || record.kind === 'retry'
        ? 'provider' : 'auxiliary';
    this.activityTimeline.record({
      schemaVersion: 1,
      intervalId: `activity:invocation:${record.invocationId}`,
      sessionId: record.sessionId,
      sessionPath,
      parentRunId: record.parentRunId,
      parentOperationId: record.parentOperationId,
      invocationId: record.invocationId,
      toolId: record.parentToolId,
      kind,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      outcome: record.outcome,
    }, { durableRequired: true });
    this.storage.markDerivedExportDirty();
  }

  private migrateHistoricalRunUsage(runs: readonly RunSnapshot[]): void {
    // Replay every deterministic migration source independently. Existing live
    // evidence suppresses compatibility aggregates; migration evidence does
    // not, so a crash after one row can resume the remainder on restart.
    for (const run of runs) {
      const existingRunRecords = this.invocationLedger.projectAll({ includePrivate: false }).records
        .filter((record) => record.parentRunId === run.runId);
      const hasLiveConversation = existingRunRecords.some((record) => record.evidenceOrigin !== 'migration'
        && (record.kind === 'conversation' || record.kind === 'retry'));
      const hasLiveSubagent = existingRunRecords.some((record) => record.evidenceOrigin !== 'migration'
        && record.kind === 'subagent');
      const endedAt = run.finalizedAt ?? run.updatedAt;
      const append = (sample: SessionUsageSample, kind: BillableInvocationKind): void => {
        this.appendUsageSample(run.sessionPath, {
          ...sample,
          parentRunId: run.runId,
          startedAt: sample.startedAt ?? run.startedAt,
          endedAt: sample.endedAt ?? endedAt,
        }, { kind, migration: true, sessionId: run.sessionId ?? null });
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
        append({
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
          append({
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
        append({
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
        append({
          sourceId: `legacy-run:${run.runId}:subagent-residual`,
          kind: 'subagent',
          ...subagentResidual,
          totalTokens: subagentTotal,
          provenance: 'unpriced',
        }, 'subagent');
      }
      const meteredCompactions = (run.auxiliaryLlmUsage ?? []).filter((sample) => sample.kind === 'history_compaction').length;
      for (let index = meteredCompactions; index < (run.compactionCount ?? 0); index += 1) {
        append({
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
    }
  }

  /** Enable/disable host-side privacy bookkeeping. Enabling immediately drops
   *  the current in-memory run and removes any already-written analytics for
   *  this session; the mode itself remains host-only. */
  async setSessionPrivacy(sessionPath: string, enabled: boolean): Promise<void> {
    const sessionId = this.getArchState().sessions.sessions.find((session) => session.path === sessionPath)?.sessionId;
    if (!enabled) {
      this.invocationLedger.transaction(() => {
        this.invocationLedger.markSessionOrdinary({ sessionPath });
        if (sessionId) this.invocationLedger.markSessionOrdinary({ sessionId });
      });
      return;
    }
    this.workingTime.resetSession(
      sessionPath,
      this.getArchState().sessions.runningSessionPaths.includes(sessionPath),
    );
    this.tracker.discardSession(sessionPath);
    // Publish the durable privacy fence before touching pending rows. Stale
    // sibling hosts then classify any concurrent append as process-local.
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
    this.storage.markDerivedExportDirty();
    await this.storage.forgetSession(sessionPath, sessionId);
  }

  prepareForSend(sessionPath: string, inputs: ComposerInput[], initialUserMessage = ''): string {
    if (this.isPrivateSession(sessionPath)) return 'private-run';
    return this.tracker.prepareForSend(sessionPath, inputs, initialUserMessage);
  }

  onAssistantTurnStarted(sessionPath: string, turnId: string): void {
    this.assistantInvocationObservedBySession[sessionPath] = false;
    delete this.lastFailedAssistantSettlementBySession[sessionPath];
    if (this.isPrivateSession(sessionPath)) return;
    this.tracker.onAssistantTurnStarted(sessionPath, turnId);
  }

  onSkillPruningUsage(
    sessionPath: string,
    messageId: string,
    occurredAt: string,
    details: unknown,
  ): void {
    for (const sample of pruningUsageSamples(messageId, occurredAt, details)) {
      this.appendUsageSample(sessionPath, sample, { kind: 'skill_pruning_prepass' });
    }
    if (this.isPrivateSession(sessionPath)) return;
    this.tracker.onSkillPruningUsage(sessionPath, messageId, occurredAt, details);
    this.syncWorkingTimeBreakdown(sessionPath);
  }

  onAssistantTurnEnded(
    sessionPath: string,
    turnId: string,
    durationMs: number,
    usage?: AssistantUsage,
    status?: TurnThroughputStatus,
    latency?: TurnLatencyMeasurement,
    billing?: { modelId?: string; provider?: string; occurredAt?: string; operationId?: string },
  ): void {
    const retry = this.pendingRetryBySession[sessionPath];
    const providerSettlementsObserved = this.assistantInvocationObservedBySession[sessionPath] === true;
    if (!providerSettlementsObserved && usage) {
      const endedAt = validIso(billing?.occurredAt) ?? this.now().toISOString();
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
      const endedAt = validIso(billing?.occurredAt) ?? this.now().toISOString();
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
    if (this.isPrivateSession(sessionPath)) return;
    this.tracker.onAssistantTurnEnded(sessionPath, turnId, durationMs, usage, status, latency);
    this.syncWorkingTimeBreakdown(sessionPath);
  }

  onSessionUsageSnapshot(
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
      // Retry classification is host-only and older pruning transcripts contain
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

  onToolStarted(sessionPath: string, toolCall: ToolCall): void {
    if (this.isPrivateSession(sessionPath)) return;
    this.tracker.onToolStarted(sessionPath, toolCall);
    this.workingTime.onToolStarted(sessionPath, toolCall);
    const runId = this.currentRunId(sessionPath);
    const intervalId = `activity:tool:${runId ?? sessionPath}:${toolCall.id}`;
    this.activeToolIntervalBySessionAndTool[this.toolIntervalKey(sessionPath, toolCall.id)] = intervalId;
    const startedAt = new Date(toolCall.startedAt ?? this.now().getTime()).toISOString();
    this.activityTimeline.start({
      schemaVersion: 1,
      intervalId,
      sessionId: this.sessionIdentity(sessionPath).sessionId,
      sessionPath,
      parentRunId: runId,
      parentOperationId: this.activeOperationId(sessionPath),
      invocationId: null,
      toolId: toolCall.id,
      kind: 'tool',
      startedAt,
    });
    this.storage.markDerivedExportDirty();
  }

  onToolFinished(sessionPath: string, toolCall: ToolCall): void {
    if (typeof toolCall.name === 'string' && toolCall.name.trim().toLowerCase() === 'subagent') {
      for (const sample of buildSubagentUsageSamples(toolCall)) {
        this.appendUsageSample(sessionPath, sample, { kind: 'subagent', toolId: toolCall.id });
      }
    }
    if (this.isPrivateSession(sessionPath)) return;
    // Close the live wall-time interval before durable telemetry catches up;
    // the service reconciles the two sources without double-counting.
    this.workingTime.onToolFinished(sessionPath, toolCall);
    const toolKey = this.toolIntervalKey(sessionPath, toolCall.id);
    const intervalId = this.activeToolIntervalBySessionAndTool[toolKey];
    if (intervalId) {
      this.activityTimeline.settle(
        intervalId,
        new Date(toolCall.startedAt !== undefined && toolCall.durationMs !== undefined
          ? toolCall.startedAt + toolCall.durationMs : this.now().getTime()).toISOString(),
        toolCall.status === 'failed' ? 'failed' : 'succeeded',
      );
      delete this.activeToolIntervalBySessionAndTool[toolKey];
      this.storage.markDerivedExportDirty();
    }
    this.tracker.onToolFinished(sessionPath, toolCall);
    this.syncWorkingTimeBreakdown(sessionPath);
  }

  onInterrupted(sessionPath: string): void {
    if (this.isPrivateSession(sessionPath)) return;
    this.tracker.onInterrupted(sessionPath);
  }

  onCompaction(sessionPath: string): void {
    if (this.isPrivateSession(sessionPath)) return;
    this.tracker.onCompaction(sessionPath);
  }

  onAuxiliaryLlmUsage(
    sessionPath: string,
    sample: Omit<AuxiliaryLlmUsagePayload, 'sessionPath'>,
  ): void {
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
    if (this.isPrivateSession(sessionPath)) return;
    if (channelsKnown) {
      this.tracker.onAuxiliaryLlmUsage(sessionPath, {
        ...sample,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
      });
    }
    this.syncWorkingTimeBreakdown(sessionPath);
  }

  onAutoRetry(
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
    if (this.isPrivateSession(sessionPath)) return;
    this.tracker.onAutoRetry(sessionPath, timing);
    this.syncWorkingTimeBreakdown(sessionPath);
  }

  onAutoRetryMeasured(
    sessionPath: string,
    sourceId: string,
    measuredDelayMs: number | undefined,
    durationMs: number,
  ): void {
    if (this.isPrivateSession(sessionPath)) return;
    this.tracker.onAutoRetryMeasured(sessionPath, sourceId, measuredDelayMs, durationMs);
    const endedAtMs = this.now().getTime();
    const elapsed = Math.max(0, measuredDelayMs ?? durationMs);
    this.activityTimeline.record({
      schemaVersion: 1,
      intervalId: `activity:retry-wait:${this.currentRunId(sessionPath) ?? sessionPath}:${sourceId}`,
      sessionId: this.sessionIdentity(sessionPath).sessionId,
      sessionPath,
      parentRunId: this.currentRunId(sessionPath),
      parentOperationId: this.activeOperationId(sessionPath),
      invocationId: null,
      toolId: null,
      kind: 'retry_wait',
      startedAt: new Date(Math.max(0, endedAtMs - elapsed)).toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
      outcome: 'succeeded',
    });
    this.storage.markDerivedExportDirty();
    this.syncWorkingTimeBreakdown(sessionPath);
  }

  onMessageEdited(sessionPath: string, _messageId: string): void {
    if (this.isPrivateSession(sessionPath)) return;
    this.tracker.onMessageEdited(sessionPath);
  }

  onTruncatedAfter(sessionPath: string, _messageId: string): void {
    if (this.isPrivateSession(sessionPath)) return;
    this.tracker.onTruncatedAfter(sessionPath);
  }

  onBackendError(sessionPath: string | undefined, code: string): void {
    if (!sessionPath || this.isPrivateSession(sessionPath)) return;
    this.tracker.onBackendError(sessionPath, code);
  }

  onContextUsageChanged(sessionPath: string, tokens: number | null, limit: number): void {
    if (this.isPrivateSession(sessionPath)) return;
    this.tracker.onContextUsageChanged(sessionPath, tokens, limit);
  }

  onBusyChanged(sessionPath: string, busy: boolean): void {
    this.workingTime.onBusyChanged(sessionPath, busy);
    if (this.isPrivateSession(sessionPath)) return;
    this.tracker.onBusyChanged(sessionPath, busy);
    const nowIso = this.now().toISOString();
    if (busy && (this.activeBusyIntervalsBySession[sessionPath]?.size ?? 0) === 0) {
      const runId = this.currentRunId(sessionPath);
      const operationId = this.activeOperationId(sessionPath);
      const intervalId = `activity:busy:${operationId ?? runId ?? `${sessionPath}:${nowIso}`}`;
      (this.activeBusyIntervalsBySession[sessionPath] ??= new Set()).add(intervalId);
      this.activityTimeline.start({
        schemaVersion: 1,
        intervalId,
        sessionId: this.sessionIdentity(sessionPath).sessionId,
        sessionPath,
        parentRunId: runId,
        parentOperationId: operationId,
        invocationId: null,
        toolId: null,
        kind: 'busy',
        startedAt: nowIso,
      });
    } else if (!busy) {
      const intervalIds = this.activeBusyIntervalsBySession[sessionPath];
      for (const intervalId of intervalIds ?? []) {
        this.activityTimeline.settle(intervalId, nowIso, 'succeeded');
      }
      delete this.activeBusyIntervalsBySession[sessionPath];
    }
    this.storage.markDerivedExportDirty();
    this.syncWorkingTimeBreakdown(sessionPath);
  }

  onModelConfigChanged(
    sessionPath: string,
    modelId: string | undefined,
    thinkingLevel: ThinkingLevel | undefined,
    provider?: string,
  ): void {
    if (this.isPrivateSession(sessionPath)) return;
    this.tracker.onModelConfigChanged(sessionPath, modelId, thinkingLevel, provider);
  }

  onUnsupportedInputAttempt(sessionPath: string): void {
    if (this.isPrivateSession(sessionPath)) return;
    this.tracker.onUnsupportedInputAttempt(sessionPath);
  }

  onSessionClosed(sessionPath: string): void {
    if (this.isPrivateSession(sessionPath)) {
      const sessionId = this.getArchState().sessions.sessions.find((session) => session.path === sessionPath)?.sessionId;
      this.workingTime.resetSession(sessionPath, false);
      this.tracker.discardSession(sessionPath);
      this.invocationLedger.scrubPrivateRecords({ sessionPath });
      delete this.pendingRetryBySession[sessionPath];
      delete this.assistantInvocationObservedBySession[sessionPath];
      delete this.lastFailedAssistantSettlementBySession[sessionPath];
      delete this.currentBranchSourcesBySession[sessionPath];
      delete this.currentBranchEntriesBySession[sessionPath];
      delete this.currentBranchLeafBySession[sessionPath];
      delete this.activeBusyIntervalsBySession[sessionPath];
      for (const key of Object.keys(this.activeToolIntervalBySessionAndTool)) {
        if (key.startsWith(`${sessionPath}\0`)) delete this.activeToolIntervalBySessionAndTool[key];
      }
      this.invocationLedger.transaction(() => {
        this.invocationLedger.markSessionOrdinary({ sessionPath });
        if (sessionId) this.invocationLedger.markSessionOrdinary({ sessionId });
      });
      return;
    }
    this.syncWorkingTimeBreakdown(sessionPath);
    this.tracker.onSessionClosed(sessionPath);
    delete this.currentBranchSourcesBySession[sessionPath];
    delete this.currentBranchEntriesBySession[sessionPath];
    delete this.currentBranchLeafBySession[sessionPath];
    delete this.pendingRetryBySession[sessionPath];
    delete this.assistantInvocationObservedBySession[sessionPath];
    delete this.lastFailedAssistantSettlementBySession[sessionPath];
  }

  replaceSessionPath(oldPath: string, newPath: string, stableSessionId?: string): void {
    this.workingTime.replaceSessionPath(oldPath, newPath);
    this.tracker.replaceSessionPath(oldPath, newPath, stableSessionId);
    const sources = this.currentBranchSourcesBySession[oldPath];
    if (sources) this.currentBranchSourcesBySession[newPath] = sources;
    const entries = this.currentBranchEntriesBySession[oldPath];
    if (entries) this.currentBranchEntriesBySession[newPath] = entries;
    const leaf = this.currentBranchLeafBySession[oldPath];
    if (leaf) this.currentBranchLeafBySession[newPath] = leaf;
    delete this.currentBranchSourcesBySession[oldPath];
    delete this.currentBranchEntriesBySession[oldPath];
    delete this.currentBranchLeafBySession[oldPath];
  }

  startNewTask(sessionPath: string): void {
    if (this.isPrivateSession(sessionPath)) return;
    this.tracker.startNewTask(sessionPath);
  }

  continueTask(sessionPath: string): void {
    if (this.isPrivateSession(sessionPath)) return;
    this.tracker.continueTask(sessionPath);
  }

  onExperimentAssignmentChanged(assignment: string | null): void {
    this.tracker.onExperimentAssignmentChanged(assignment);
  }

  private filterPrivateAnalytics(result: RunAnalyticsQueryResult): RunAnalyticsQueryResult {
    return {
      completedRuns: result.completedRuns.filter((run) => !this.isPrivateSession(run.sessionPath)),
      openRuns: result.openRuns.filter((run) => !this.isPrivateSession(run.sessionPath)),
    };
  }

  async queryRunAnalytics(): Promise<RunAnalyticsQueryResult> {
    await this.start();
    return this.filterPrivateAnalytics(await this.storage.queryRunAnalytics());
  }

  /** The resolved run-analytics storage directory (see {@link RunAnalyticsStorage.getStorageDir}). */
  getStorageDir(): string {
    return this.storage.getStorageDir();
  }

  /** Host-owned cumulative agent working-time clocks for renderer projection. */
  getWorkingTimeBySession(): Record<string, WorkingTimeState> {
    return this.workingTime.getStates();
  }

  /** Ledger-backed session usage projection for UI and fixture conservation checks. */
  getSessionUsage(sessionPath: string): SessionUsageSnapshot {
    const currentSources = this.currentBranchSourcesBySession[sessionPath];
    const currentEntries = this.currentBranchEntriesBySession[sessionPath];
    const records = this.invocationLedger.projectSession({ sessionPath }).records.filter((record) => (
      !currentSources
      || (record.kind !== 'conversation' && record.kind !== 'retry'
        && record.kind !== 'subagent' && record.kind !== 'skill_pruning_prepass')
      || currentSources.has(record.sourceId)
      || (record.branchId !== null && currentEntries?.has(record.branchId) === true)
      || ((record.kind === 'conversation' || record.kind === 'retry') && record.sourceId.startsWith('assistant:')
        && currentEntries?.has(record.sourceId.slice('assistant:'.length)) === true)
    ));
    return sessionUsageSnapshotFromLedger(records);
  }

  /** Correlated activity authority used by conservation tests and exports. */
  getActivityIntervals(): readonly ActivityIntervalRecord[] {
    return this.activityTimeline.projectAll();
  }

  /** Immutable ordinary invocation rows used by aggregate projections/export. */
  getBillableInvocationRecords(): readonly BillableInvocationRecord[] {
    return this.invocationLedger.exportRecords();
  }

  /** Current in-memory runs for live aggregate updates; does not touch disk. */
  getOpenRuns(): RunSnapshot[] {
    return this.tracker.getOpenRuns().filter((run) => !this.isPrivateSession(run.sessionPath));
  }

  /** Finalized snapshots waiting for their batched JSONL append. This is the
   * completion bridge used by AggregateStatsService, preserving finalized
   * status/outcome/timestamps rather than its last observed open snapshot. */
  getPendingCompletedRuns(): RunSnapshot[] {
    return this.storage.getPendingCompletedRuns().filter((run) => !this.isPrivateSession(run.sessionPath));
  }

  /** Query the completed-data cache source without forcing pending analytics
   * to flush. Intended for mtime-gated host rollups. */
  async queryPersistedRunAnalytics(): Promise<RunAnalyticsQueryResult> {
    await this.start();
    return this.filterPrivateAnalytics(await this.storage.queryPersistedRunAnalytics());
  }

  async exportRunAnalytics(targetPath: string): Promise<RunAnalyticsExportPayload> {
    await this.start();
    const privatePaths = new Set(
      Object.entries(this.getArchState().sessions.privacyModeBySession)
        .filter(([, enabled]) => enabled)
        .map(([sessionPath]) => sessionPath),
    );
    const privateIds = new Set<string>();
    for (const sessionPath of privatePaths) {
      const summaryId = this.getArchState().sessions.sessions.find((session) => session.path === sessionPath)?.sessionId;
      if (summaryId) privateIds.add(summaryId);
      try { privateIds.add(resolveSessionIdentity(sessionPath).sessionId); } catch { /* path filtering remains authoritative */ }
    }
    return await this.storage.exportRunAnalytics(targetPath, privatePaths, privateIds);
  }

  async flush(): Promise<void> {
    this.retryPendingInvocationWrites();
    this.activityTimeline.flush();
    await this.storage.flush();
    this.retryPendingInvocationWrites();
    this.activityTimeline.flush();
  }

  async shutdown(): Promise<void> {
    this.tracker.finalizeOpenRunsForShutdown();
    this.retryPendingInvocationWrites();
    this.activityTimeline.flush();
    await this.storage.dispose();
  }
}

function validIso(value: string | undefined): string | undefined {
  if (!value || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(Date.parse(value)).toISOString();
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
