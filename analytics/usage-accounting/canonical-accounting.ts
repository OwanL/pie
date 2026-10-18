import {
  adaptInvocationRecord, ledgerKind, pruningUsageSamples,
  stableEvidenceTime, stableInvocationId, validIso, validTokenChannel,
} from './invocation-adaptation';
import * as path from 'node:path';

import { appendPieLog } from '../../lib/structured-logging/pie-logger';
import type {
  TurnThroughputStatus,
} from '../legacy/run-analytics/types.js';
import type {
  BillableInvocationKind,
  BillableInvocationRecord,
} from './billable-invocation';
import {
  type SessionUsageSample,
  type SessionUsageSnapshot,
} from './session-usage';
import type { AssistantUsage } from '../contracts/legacy-run-analytics-contracts.js';
import type { AnalyticsAuxiliaryLlmUsageObservation } from '../contracts/run-observation-inputs.js';
import type { CapturedPricingFacts } from '../contracts/model-pricing-facts.js';
import type { InvocationPricingResolver } from '../contracts/invocation-pricing-resolver.js';
import type { CanonicalProviderSettlement } from '../capture/canonical-capture.js';

import type { ActivityTimeline } from '../legacy/activity-timeline/service';
import { workspaceHash } from '../legacy/stats-service/helpers';
export interface BillableAccountingPersistenceFailureNotice {
  kind: 'NoticeShown';
  notice: string;
  noticeKind: 'operational-error';
  noticeRaw: string;
}

export interface CanonicalAccountingDeps {
  now: () => Date;
  scheduleRender: () => void;
  dispatchArchEvent: (event: BillableAccountingPersistenceFailureNotice) => void;
  /** Captured provider/model pricing facts, loaded by the provider pricing
   *  owner and handed across the boundary; settlement accounting never
   *  resolves runtime catalogs itself. Absent facts leave rows explicitly
   *  unpriced. */
  getCapturedPricingFacts: (sessionPath: string) => CapturedPricingFacts | undefined;
  resolveInvocationPricing: InvocationPricingResolver;
  isPrivateSession: (sessionPath: string) => boolean;
  sessionIdentity: (
    sessionPath: string,
  ) => { sessionId: string | null; modelId?: string; provider?: string };
  currentRunId: (sessionPath: string) => string | null;
  activeOperationId: (sessionPath: string) => string | null;
  /** Unavailable capture skips submission; it never selects legacy persistence. */
  canonicalCapture?: {
    captureProviderSettlement(record: CanonicalProviderSettlement): 'disabled' | 'submitted' | 'rejected';
    captureExecution(
      context: { sessionId: string | null; sessionPath: string; runId?: string | null; operationId?: string | null },
      executionId: string,
      phase: 'begin' | 'phase' | 'end' | 'transcriptEvidence',
      sourceKey: string,
      observedAtMs: number,
      fields: import('../contracts/contracts.js').AnalyticsExecutionFields,
    ): 'disabled' | 'submitted' | 'rejected';
  } | null;
}

interface AppendUsageOptions { kind?: BillableInvocationKind; branchId?: string | null; operationId?: string | null; toolId?: string | null; outcome?: BillableInvocationRecord['outcome']; sessionId?: string | null; stableMissingTime?: boolean; }
/** Structural accounting surface; no legacy persistence owner is required. */
export interface AccountingPort extends Pick<CanonicalAccounting, 'observeAssistantTurnStarted' | 'observeSkillPruningUsage' | 'observeSubagentToolResult' | 'observeAssistantTurnEnded' | 'observeSessionUsageSnapshot' | 'observeBranchEntry' | 'observeAuxiliaryLlmUsage' | 'observeAutoRetry' | 'markSessionOrdinary' | 'markSessionPrivate' | 'onSessionClosed' | 'forgetSession' | 'replaceSessionPath' | 'projectSessionUsage' | 'exportRecords'> {
 readonly activityTimeline: Pick<ActivityTimeline, 'start' | 'settle' | 'record' | 'projectAll'>;
}
export function createCanonicalAccounting(deps: CanonicalAccountingDeps): AccountingPort { return new CanonicalAccounting(deps); }
export class CanonicalAccounting implements AccountingPort {
 get activityTimeline(): AccountingPort['activityTimeline'] {
   throw new Error('Legacy timeline is unavailable under canonical authority.');
 }
 constructor(private readonly deps: CanonicalAccountingDeps) {}
  private readonly pendingRetryBySession: Record<string, { sourceId: string; occurredAt: string } | undefined> = {};
  private readonly assistantInvocationObservedBySession: Record<string, boolean | undefined> = {};
  private readonly lastFailedAssistantSettlementBySession: Record<string, string | undefined> = {};
  private readonly currentBranchSourcesBySession: Record<string, Set<string> | undefined> = {};
  private readonly currentBranchEntriesBySession: Record<string, Set<string> | undefined> = {};
  private readonly branchParentsBySession: Record<string, Map<string, string | null | undefined> | undefined> = {};
  private readonly currentBranchLeafBySession: Record<string, string | undefined> = {};
  private readonly currentBranchDepthBySession: Record<string, number | undefined> = {};
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

  /** Subagent usage samples have been adapted at the application boundary;
   *  this owner applies ledger and canonical-settlement authority rules. */
  observeSubagentToolResult(
    sessionPath: string,
    toolCallId: string,
    samples: SessionUsageSample[],
  ): void {
    const reconciledCaptureGaps = new Set<string>();
    for (const sample of samples) {
      const receipt = sample.producerCaptureReceipt;
      if (!receipt) {
        const evidenceIdentity = sample.producerAttemptId ?? sample.sourceId;
        const executionId = `subagent-reconciliation:${toolCallId}:${evidenceIdentity}`;
        if (!reconciledCaptureGaps.has(executionId)) {
          reconciledCaptureGaps.add(executionId);
          const identity = this.deps.sessionIdentity(sessionPath);
          this.deps.canonicalCapture?.captureExecution(
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
              parentToolCallId: toolCallId,
              operationKind: 'subagent-attempt',
              source: 'host-terminal-reconciliation',
              captureIncomplete: true,
              reason: 'The child terminal result had no valid fact ownership receipt; parent aggregates are reconciliation only.',
            },
          );
        }
        continue;
      }
      if (receipt?.factStatus === 'rejected') {
        if (!reconciledCaptureGaps.has(receipt.executionId)) {
          reconciledCaptureGaps.add(receipt.executionId);
          const identity = this.deps.sessionIdentity(sessionPath);
          this.deps.canonicalCapture?.captureExecution(
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
              parentToolCallId: toolCallId,
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
      if (receipt?.factStatus === 'submitted') {
        // The child owns these facts. The durable read model projects them;
        // retaining parent copies would duplicate history in the host.
        continue;
      }
      this.appendUsageSample(sessionPath, sample, {
        kind: 'subagent',
        toolId: toolCallId,
        stableMissingTime: true,
      });
    }
  }

  observeAssistantTurnEnded(
    sessionPath: string,
    turnId: string,
    _durationMs: number,
    usage?: AssistantUsage,
    status?: TurnThroughputStatus,
    billing?: { modelId?: string; provider?: string; occurredAt?: string; operationId?: string; durableEntryId?: string },
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
        ...(usage.tokenChannelsKnown !== undefined ? { tokenChannelsKnown: usage.tokenChannelsKnown } : {}),
        ...(usage.tokenChannelPresence ? { tokenChannelPresence: usage.tokenChannelPresence } : {}),
        ...(usage.tokenChannelsKnown === false ? {
          instrumentationGap: true,
          instrumentationGapReason: 'The assistant provider response omitted one or more token channels.',
        } : {}),
        ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
        ...(usage.reportedCostUsd !== undefined ? { reportedCostUsd: usage.reportedCostUsd } : {}),
        endedAt,
        provenance: usage.reportedCostUsd !== undefined ? 'exact' : undefined,
      }, {
        kind: retry ? 'retry' : 'conversation',
        operationId: billing?.operationId,
        branchId: billing?.durableEntryId ?? this.currentBranchLeafBySession[sessionPath] ?? null,
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
        endedAt,
      }, {
        kind: retry ? 'retry' : 'conversation',
        operationId: billing?.operationId,
        branchId: billing?.durableEntryId ?? this.currentBranchLeafBySession[sessionPath] ?? null,
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
    // Transcript-derived snapshots are a historical migration/rebuild input for
    // the legacy authority only. Under canonical authority the contract forbids
    // transcript reconstruction/backfill: the recorder owns settlements, and
    // invocation identities are root-scoped, so re-deriving history here would
    // not only recapture this session's settled work — a copied session would
    // mint new settlements for inherited work under its own root. Live capture
    // keeps its own seams (auxiliary settlements and the turn-ended fallback);
    // branch bookkeeping below still scopes those live settlements.
    this.currentBranchSourcesBySession[sessionPath] = new Set(snapshot.samples.map((sample) => sample.sourceId));
    const entries = snapshot.branchEntryIds ?? [];
    const priorDepth = this.currentBranchDepthBySession[sessionPath];
    const priorLeaf = this.currentBranchLeafBySession[sessionPath];
    let startIndex = 0;
    if (priorDepth !== undefined && priorLeaf !== undefined) {
      if (entries.length === priorDepth && snapshot.branchId === priorLeaf) startIndex = entries.length;
      else if (entries.length >= priorDepth && priorDepth > 0 && entries[priorDepth - 1] === priorLeaf) {
        startIndex = priorDepth;
      }
    }
    let branchParents = this.branchParentsBySession[sessionPath];
    let branchEntries = this.currentBranchEntriesBySession[sessionPath];
    if (startIndex === 0) {
      branchParents = new Map();
      branchEntries = new Set();
    }
    branchParents ??= new Map();
    branchEntries ??= new Set();
    for (let index = startIndex; index < entries.length; index += 1) {
      const entryId = entries[index]!;
      branchEntries.add(entryId);
      branchParents.set(entryId, index === 0 ? null : entries[index - 1]!);
    }
    this.branchParentsBySession[sessionPath] = branchParents;
    this.currentBranchEntriesBySession[sessionPath] = branchEntries;
    this.currentBranchLeafBySession[sessionPath] = snapshot.branchId;
    this.currentBranchDepthBySession[sessionPath] = entries.length > 0 ? entries.length : undefined;
  }

  observeBranchEntry(
    sessionPath: string,
    entryId: string,
    parentEntryId: string | null | undefined,
    selectedEntryId: string,
  ): void {
    this.currentBranchSourcesBySession[sessionPath] ??= new Set();
    const parents = this.branchParentsBySession[sessionPath] ??= new Map();
    parents.set(entryId, parentEntryId);
    const priorLeaf = this.currentBranchLeafBySession[sessionPath];
    const priorDepth = this.currentBranchDepthBySession[sessionPath];
    const selected = new Set<string>();
    let cursor: string | null | undefined = selectedEntryId;
    while (cursor !== null && cursor !== undefined && !selected.has(cursor)) {
      selected.add(cursor);
      cursor = parents.get(cursor);
    }
    this.currentBranchEntriesBySession[sessionPath] = selected;
    this.currentBranchDepthBySession[sessionPath] = priorLeaf !== undefined
      && priorDepth !== undefined
      && parentEntryId === priorLeaf
      ? priorDepth + 1
      : undefined;
    this.currentBranchLeafBySession[sessionPath] = selectedEntryId;
  }

  /** Adapt one auxiliary/provider usage payload into ledger evidence.
   *  Returns the channel presence decision and the normalized sample so the
   *  caller can forward compatible run-analytics observations exactly once. */
  observeAuxiliaryLlmUsage(
    sessionPath: string,
    sample: AnalyticsAuxiliaryLlmUsageObservation,
  ): {
    channelsKnown: boolean;
    invocationId: string;
    kind: BillableInvocationKind;
    canonicalAccepted?: boolean;
    record?: BillableInvocationRecord;
    sample: AnalyticsAuxiliaryLlmUsageObservation
      & { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  } {
    const declaredPresence = sample.tokenChannelPresence;
    // An undeclared channel presence means "present" only when the sample does
    // not explicitly declare its token channels unknown. Otherwise the
    // normalized zero stand-ins are placeholders for missing channels and must
    // not masquerade as known zeros (missing usage channels are unknown, not
    // zero).
    const presenceDefault = sample.tokenChannelsKnown !== false;
    const tokenChannelPresence = {
      input: validTokenChannel(sample.inputTokens) && (declaredPresence?.input ?? presenceDefault),
      output: validTokenChannel(sample.outputTokens) && (declaredPresence?.output ?? presenceDefault),
      cacheRead: validTokenChannel(sample.cacheReadTokens) && (declaredPresence?.cacheRead ?? presenceDefault),
      cacheWrite: validTokenChannel(sample.cacheWriteTokens) && (declaredPresence?.cacheWrite ?? presenceDefault),
    };
    const channelsKnown = sample.tokenChannelsKnown !== false
      && Object.values(tokenChannelPresence).every(Boolean);
    const inputTokens = validTokenChannel(sample.inputTokens) ? sample.inputTokens : 0;
    const outputTokens = validTokenChannel(sample.outputTokens) ? sample.outputTokens : 0;
    const cacheReadTokens = validTokenChannel(sample.cacheReadTokens) ? sample.cacheReadTokens : 0;
    const cacheWriteTokens = validTokenChannel(sample.cacheWriteTokens) ? sample.cacheWriteTokens : 0;
    const providerTotalTokens = validTokenChannel(sample.providerTotalTokens)
      ? sample.providerTotalTokens
      : undefined;
    const totalTokens = providerTotalTokens
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
    const appended = this.appendUsageSample(sessionPath, {
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
      tokenChannelPresence,
      ...(providerTotalTokens !== undefined ? { providerTotalTokens } : {}),
      ...(sample.reportedCostUsd !== undefined ? { reportedCostUsd: sample.reportedCostUsd } : {}),
      ...(sample.parentOperationId ? { parentOperationId: sample.parentOperationId } : {}),
      endedAt: sample.occurredAt,
      // Duration is not an observed wall-clock endpoint. Keep missing starts
      // unavailable for schedule eligibility instead of synthesizing one from
      // occurredAt - durationMs.
      startedAt: sample.startedAt,
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
    return {
      channelsKnown,
      invocationId: appended.invocationId,
      kind: invocationKind,
      ...(appended.canonicalAccepted !== undefined ? { canonicalAccepted: appended.canonicalAccepted } : {}),
      ...(appended.record ? { record: appended.record } : {}),
      sample: { ...sample, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
    };
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

  /** Flags/branch bookkeeping cleanup shared by every close path. */
  onSessionClosed(sessionPath: string): void {
    delete this.currentBranchSourcesBySession[sessionPath];
    delete this.currentBranchEntriesBySession[sessionPath];
    delete this.branchParentsBySession[sessionPath];
    delete this.currentBranchLeafBySession[sessionPath];
    delete this.currentBranchDepthBySession[sessionPath];
    delete this.pendingRetryBySession[sessionPath];
    delete this.assistantInvocationObservedBySession[sessionPath];
    delete this.lastFailedAssistantSettlementBySession[sessionPath];
  }

  markSessionOrdinary(_sessionPath: string, _sessionId?: string): void {}
  markSessionPrivate(_sessionPath: string, _sessionId?: string): void {}
  forgetSession(sessionPath: string, _sessionId?: string): void { this.onSessionClosed(sessionPath); }
  replaceSessionPath(oldPath: string, newPath: string): void {
    const sources = this.currentBranchSourcesBySession[oldPath];
    if (sources) this.currentBranchSourcesBySession[newPath] = sources;
    const entries = this.currentBranchEntriesBySession[oldPath];
    if (entries) this.currentBranchEntriesBySession[newPath] = entries;
    const parents = this.branchParentsBySession[oldPath];
    if (parents) this.branchParentsBySession[newPath] = parents;
    const leaf = this.currentBranchLeafBySession[oldPath];
    if (leaf) this.currentBranchLeafBySession[newPath] = leaf;
    const depth = this.currentBranchDepthBySession[oldPath];
    if (depth !== undefined) this.currentBranchDepthBySession[newPath] = depth;
    delete this.currentBranchSourcesBySession[oldPath];
    delete this.currentBranchEntriesBySession[oldPath];
    delete this.branchParentsBySession[oldPath];
    delete this.currentBranchLeafBySession[oldPath];
    delete this.currentBranchDepthBySession[oldPath];
  }

  projectSessionUsage(_sessionPath: string): SessionUsageSnapshot { return { samples: [], authority: 'unknown' }; }
  exportRecords(): readonly BillableInvocationRecord[] { return []; }
  private appendUsageSample(sessionPath: string, sample: SessionUsageSample, options: AppendUsageOptions = {}): { invocationId: string; appendedDurable: boolean; canonicalAccepted?: boolean; record?: BillableInvocationRecord } {
 const identity = this.deps.sessionIdentity(sessionPath);
 const stableSessionId = options.sessionId ?? identity.sessionId;
 const kind = options.kind ?? ledgerKind(sample.kind);
 const invocationId = sample.canonicalInvocationId ?? stableInvocationId(stableSessionId ?? sessionPath, kind, sample.sourceId);
    const record = adaptInvocationRecord(sessionPath, sample, {
      ...options,
      invocationId,
      sessionId: stableSessionId,
      kind,
      identity,
      now: () => this.deps.now(),
      getPricingFacts: () => this.deps.getCapturedPricingFacts(sessionPath),
      resolveInvocationPricing: (request) => this.deps.resolveInvocationPricing(request),
      branchId: options.branchId ?? this.currentBranchLeafBySession[sessionPath] ?? null,
      runId: this.deps.currentRunId(sessionPath),
    });
    {
      const capture = this.deps.canonicalCapture?.captureProviderSettlement({
        ...record,
        // Legacy normalization supplies fallback dates. Canonical facts retain
        // only producer evidence so missing dates remain in the undated bucket.
        startedAt: validIso(sample.startedAt),
        endedAt: validIso(sample.endedAt),
      });
      if (capture === 'rejected') {
        appendPieLog('warn', 'canonical-analytics', 'provider settlement capture rejected', {
          invocationId: record.invocationId,
          sourceId: record.sourceId,
        });
      }
      // Canonical mode never falls through to the legacy JSONL ledger. P5
      // replaces the legacy query consumers before P7 is allowed to select
      // this authority.
      return { invocationId, appendedDurable: false, canonicalAccepted: capture !== undefined && capture !== 'rejected', record };
    }
  }
}

/** Path-only compatibility selectors for explicit privacy cleanup. Never
 * instantiate a run store merely to locate retired auxiliary logs. Kept in
 * parity with RunAnalyticsStorage.getGlobalSideChannelStorageDirs(). */
export function legacyPrivacyStorageDirs(options: {
  dataOutcomesRootPath: string;
  legacyUsageDataRootPath?: string;
  workspaceId: string;
  legacyWorkspaceIds?: readonly string[];
}): string[] {
  const hashes = [...new Set([options.workspaceId, ...(options.legacyWorkspaceIds ?? [])])].map(workspaceHash);
  const roots = [
    ...(options.legacyUsageDataRootPath ? [
      path.join(options.legacyUsageDataRootPath, 'runs'),
      path.join(options.legacyUsageDataRootPath, 'usage-data'),
      path.join(options.legacyUsageDataRootPath, 'data', 'outcomes'),
    ] : []),
    path.join(options.dataOutcomesRootPath, 'runs'),
    path.join(options.dataOutcomesRootPath, 'usage-data'),
    options.dataOutcomesRootPath,
  ];
  return [...new Set([
    path.join(options.dataOutcomesRootPath, hashes[0]!),
    ...roots.flatMap((root) => hashes.map((hash) => path.join(root, hash))),
  ])];
}
