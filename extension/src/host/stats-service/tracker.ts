import {
  analyzeToolCall,
  incrementNamedCount,
  mergeFileMutationDelta,
  normalizeToolCallName,
  type ToolCallAnalysis,
  type ToolFailureKind,
  type ToolResultIssueKind,
} from '../../shared/tool-call-analysis';
import type {
  AssistantUsage,
  ComposerInput,
  RunOutcome,
  ThinkingLevel,
  ToolCall,
} from '../../shared/protocol';
import { appendUnique, summarizeInputs } from './helpers';
import {
  getRenderableSubagentResult,
  getTerminalSubagentAttemptSamplesFromToolCall,
} from '../../shared/subagent-result';
import {
  RUN_ANALYTICS_SCHEMA_VERSION,
  normalizeExperimentAssignment,
  type AgentReviewCompletion,
  type AgentReviewEntry,
  type OutcomeHistoryLogEntry,
  type RunSnapshot,
  type TreatmentChangeKind,
  type TurnLatencyMeasurement,
  type TurnThroughputSample,
  type TurnThroughputStatus,
} from '../run-analytics';
import { SessionRunStateManager } from './run-state-manager';
import type { GetArchState, DispatchArchEvent } from './types';

const TOOL_FAILURE_SAMPLE_LIMIT = 20;

function outcomeFromAgentReview(
  rating: number,
  completion: AgentReviewCompletion,
): RunOutcome | null {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return null;
  }
  const resolution = completion === 'fully'
    ? 'resolved'
    : completion === 'partial'
      ? 'partially_resolved'
      : 'unresolved';
  return { resolution, satisfaction: rating, source: 'agent' };
}

function toNonNegativeInt(value: unknown): number {
  return Number.isFinite(value) && typeof value === 'number' && value > 0 ? Math.trunc(value) : 0;
}

function finiteOrNull(value: unknown): number | null {
  return Number.isFinite(value) && typeof value === 'number' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

interface SessionRunTrackerOptions {
  getArchState: GetArchState;
  dispatchArchEvent: DispatchArchEvent;
  scheduleRender: () => void;
  schedulePersist: (snapshotToAppend?: RunSnapshot, outcomeToAppend?: OutcomeHistoryLogEntry) => void;
  schedulePersistAgentReview: (entry: AgentReviewEntry) => void;
  now: () => Date;
  createId: () => string;
  getExperimentAssignment: () => string | null;
}

export class SessionRunTracker {
  private readonly dispatchArchEvent: DispatchArchEvent;
  private readonly scheduleRender: () => void;
  private readonly runState: SessionRunStateManager;
  /**
   * Session paths currently mid-run (busy) across ALL sessions. Maintained on
   * the shared tracker instance so per-turn throughput samples can stamp how
   * many sessions were concurrently active — the multi-session load signal
   * for throughput / rate-limit-resilience analysis.
   */
  private readonly busySessionPaths = new Set<string>();

  constructor(options: SessionRunTrackerOptions) {
    this.dispatchArchEvent = options.dispatchArchEvent;
    this.scheduleRender = options.scheduleRender;
    this.runState = new SessionRunStateManager({
      getArchState: options.getArchState,
      dispatchArchEvent: options.dispatchArchEvent,
      schedulePersist: options.schedulePersist,
      schedulePersistAgentReview: options.schedulePersistAgentReview,
      now: options.now,
      createId: options.createId,
      getExperimentAssignment: options.getExperimentAssignment,
    });
  }

  restore(checkpointSessions: Parameters<SessionRunStateManager['restore']>[0]): void {
    this.runState.restore(checkpointSessions);
  }

  serializeSessions(): ReturnType<SessionRunStateManager['serializeSessions']> {
    return this.runState.serializeSessions();
  }

  getOpenRuns(): RunSnapshot[] {
    const runs: RunSnapshot[] = [];
    for (const state of this.runState.sessions.values()) {
      if (state.currentRun) runs.push(state.currentRun);
    }
    return runs;
  }

  prepareForSend(sessionPath: string, inputs: ComposerInput[], initialUserMessage = ''): string {
    const state = this.runState.getOrCreateSessionState(sessionPath);

    if (state.currentRun) {
      this.runState.finalizeCurrentRun(
        sessionPath,
        state.nextTaskIntent === 'new_task' ? 'new_task' : 'closed_unscored',
      );
    }

    const run = this.runState.createRunSnapshot(sessionPath, state);
    state.currentRun = run;
    state.turnIdsSeenInCurrentRun.clear();
    state.endedTurnIdsInCurrentRun.clear();
    state.startedToolCallIdsInCurrentRun.clear();
    state.finishedToolCallIdsInCurrentRun.clear();
    state.toolNamesByCallIdInCurrentRun.clear();
    state.toolExecutionIntervalsInCurrentRun = [];
    state.busyStartedAt = null;

    run.sendCount += 1;
    run.initialUserMessageChars = Array.from(initialUserMessage.trim()).length;
    run.updatedAt = this.runState.isoNow();
    summarizeInputs(run, inputs);
    if (state.queuedUnsupportedInputCount > 0) {
      run.unsupportedInputCount += state.queuedUnsupportedInputCount;
      state.queuedUnsupportedInputCount = 0;
    }
    state.nextTaskIntent = null;

    this.runState.syncSessionSummary(sessionPath);
    this.runState.persist();
    this.scheduleRender();
    return run.runId;
  }

  onAssistantTurnStarted(sessionPath: string, turnId: string): void {
    const state = this.runState.sessions.get(sessionPath);
    const run = state?.currentRun;
    if (!run || !state) {
      return;
    }

    if (!state.turnIdsSeenInCurrentRun.has(turnId)) {
      state.turnIdsSeenInCurrentRun.add(turnId);
      run.assistantTurnCount += 1;
      run.updatedAt = this.runState.isoNow();
      this.runState.persist();
    }
  }

  /** Record the skill-pruning prepass call carried by its CustomMessage. */
  onSkillPruningUsage(
    sessionPath: string,
    messageId: string,
    occurredAt: string,
    details: unknown,
  ): void {
    const run = this.runState.sessions.get(sessionPath)?.currentRun;
    if (!run || !messageId || !isRecord(details)) {
      return;
    }

    const inputTokens = toNonNegativeInt(details.prepassInputTokens);
    const outputTokens = toNonNegativeInt(details.prepassOutputTokens);
    const cacheReadTokens = toNonNegativeInt(details.prepassCacheReadTokens);
    const cacheWriteTokens = toNonNegativeInt(details.prepassCacheWriteTokens);
    const durationMs = typeof details.prepassLatencyMs === 'number'
      && Number.isFinite(details.prepassLatencyMs) && details.prepassLatencyMs >= 0
      ? Math.trunc(details.prepassLatencyMs)
      : undefined;
    if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens === 0 && durationMs === undefined) {
      return;
    }

    const samples = run.auxiliaryLlmUsage ?? [];
    if (samples.some((sample) => sample.kind === 'skill_pruning_prepass' && sample.sourceId === messageId)) {
      return;
    }

    run.auxiliaryLlmUsage = [...samples, {
      kind: 'skill_pruning_prepass',
      sourceId: messageId,
      occurredAt: occurredAt || this.runState.isoNow(),
      modelId: typeof details.prepassModel === 'string' && details.prepassModel ? details.prepassModel : undefined,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      ...(durationMs === undefined ? {} : { durationMs }),
    }];
    run.updatedAt = this.runState.isoNow();
    this.runState.persist();
  }

  onAssistantTurnEnded(
    sessionPath: string,
    turnId: string,
    durationMs: number,
    usage?: AssistantUsage,
    status: TurnThroughputStatus = 'completed',
    latency?: TurnLatencyMeasurement,
  ): void {
    const state = this.runState.sessions.get(sessionPath);
    const run = state?.currentRun;
    if (!run || !state) {
      return;
    }

    if (!state.turnIdsSeenInCurrentRun.has(turnId)) {
      state.turnIdsSeenInCurrentRun.add(turnId);
      run.assistantTurnCount += 1;
    }

    // Ignore duplicate `message.finished` events for the same turn so duration,
    // token totals, and throughput samples are not double-counted.
    if (state.endedTurnIdsInCurrentRun.has(turnId)) {
      return;
    }
    state.endedTurnIdsInCurrentRun.add(turnId);

    const generationDurationMs = Math.max(0, Math.trunc(durationMs));
    run.assistantTurnDurationMs += generationDurationMs;
    const outputTokens = usage ? toNonNegativeInt(usage.outputTokens) : 0;
    const inputTokens = usage ? toNonNegativeInt(usage.inputTokens) : 0;
    const cacheReadTokens = usage ? toNonNegativeInt(usage.cacheReadTokens) : 0;
    const cacheWriteTokens = usage ? toNonNegativeInt(usage.cacheWriteTokens) : 0;
    if (usage) {
      run.inputTokens += toNonNegativeInt(usage.inputTokens);
      run.outputTokens += toNonNegativeInt(usage.outputTokens);
      run.cacheReadTokens += toNonNegativeInt(usage.cacheReadTokens);
      run.cacheWriteTokens += toNonNegativeInt(usage.cacheWriteTokens);
      run.tokenReportedTurnCount += 1;
      run.lastTurnUsage = usage;
    }

    // Record a throughput sample whenever the turn produced measurable
    // generation time or tokens, ended abnormally, or captured a turn-latency
    // measurement (any component — overhead alone still counts, e.g. a turn
    // that observed `turn_start` but produced no content delta). This keeps the
    // sum of sample durations / tokens aligned with the cumulative counters
    // above while still capturing errored turns (a rate-limit / failure signal)
    // and turns where latency was observable even if generation was negligible.
    const hasLatency = latency !== undefined
      && (latency.turnLatencyMs !== undefined
        || latency.overheadMs !== undefined
        || latency.providerLatencyMs !== undefined
        || latency.providerQueueMs !== undefined);
    if (generationDurationMs > 0 || outputTokens > 0 || status !== 'completed' || hasLatency) {
      const sample: TurnThroughputSample = {
        endedAt: this.runState.isoNow(),
        outputTokens,
        inputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        contextTokens: run.contextTokens,
        generationDurationMs,
        concurrentBusySessions: this.busySessionPaths.size,
        status,
        modelId: run.modelId ?? undefined,
        provider: run.provider ?? undefined,
        turnLatencyMs: finiteOrNull(latency?.turnLatencyMs),
        overheadMs: finiteOrNull(latency?.overheadMs),
        providerLatencyMs: finiteOrNull(latency?.providerLatencyMs),
        providerQueueMs: finiteOrNull(latency?.providerQueueMs),
        providerQueueAttemptCount: toNonNegativeInt(latency?.providerQueueAttemptCount),
      };
      run.turnThroughputSamples = [...run.turnThroughputSamples, sample];
    }

    run.updatedAt = this.runState.isoNow();
    this.runState.persist();
  }

  onToolStarted(sessionPath: string, toolCall: ToolCall): void {
    const state = this.runState.sessions.get(sessionPath);
    const run = state?.currentRun;
    if (!run || !state) {
      return;
    }

    if (!toolCall.id || state.startedToolCallIdsInCurrentRun.has(toolCall.id)) {
      return;
    }
    state.startedToolCallIdsInCurrentRun.add(toolCall.id);

    const normalizedName = normalizeToolCallName(toolCall.name) || toolCall.name.trim() || '(unknown)';
    state.toolNamesByCallIdInCurrentRun.set(toolCall.id, normalizedName);
    run.toolUsage.totalCount += 1;
    incrementNamedCount(run.toolUsage.countsByName, normalizedName);
    run.updatedAt = this.runState.isoNow();
    this.runState.persist();
  }

  onToolFinished(sessionPath: string, toolCall: ToolCall): void {
    const state = this.runState.sessions.get(sessionPath);
    const run = state?.currentRun;
    if (!run || !state) {
      return;
    }

    if (!toolCall.id || state.finishedToolCallIdsInCurrentRun.has(toolCall.id)) {
      return;
    }
    state.finishedToolCallIdsInCurrentRun.add(toolCall.id);

    const terminalName = normalizeToolCallName(toolCall.name) || toolCall.name.trim() || '(unknown)';
    const startedName = state.toolNamesByCallIdInCurrentRun.get(toolCall.id);
    const normalizedName = terminalName === '(unknown)' ? (startedName ?? terminalName) : terminalName;
    if (startedName && startedName !== normalizedName) {
      const previousCount = run.toolUsage.countsByName[startedName] ?? 0;
      if (previousCount <= 1) delete run.toolUsage.countsByName[startedName];
      else run.toolUsage.countsByName[startedName] = previousCount - 1;
      incrementNamedCount(run.toolUsage.countsByName, normalizedName);
      state.toolNamesByCallIdInCurrentRun.set(toolCall.id, normalizedName);
    }
    const analysis = analyzeToolCall(toolCall);

    this.recordToolDuration(run, state, normalizedName, toolCall);

    if (toolCall.status === 'failed') {
      if (analysis.failure) {
        // Execution failure: the tool could not complete its job.
        this.recordExecutionFailure(run, normalizedName, analysis);
      } else if (analysis.resultIssue) {
        // Non-success result: the tool ran fine but reported a non-success outcome
        // (a failing test/build/lint, or an empty probe/search). Measured, not a failure.
        this.recordResultIssue(run, normalizedName, analysis);
      }
    }

    if (analysis.subagentCallCount > 0) {
      this.recordSubagentUsage(run, analysis, toolCall);
      this.recordSubagentThroughput(run, toolCall);
      this.recordSubagentLifecycle(run, toolCall);
    }

    if (analysis.verificationKinds.length > 0) {
      this.recordVerification(run, toolCall, analysis);
    }

    if (toolCall.status !== 'failed') {
      this.recordFileMutationAndExtensions(run, analysis);
    }

    run.updatedAt = this.runState.isoNow();
    this.runState.persist();
  }

  /** Roll up a tool call's execution duration (when reported and finite). */
  private recordToolDuration(
    run: RunSnapshot,
    state: { toolExecutionIntervalsInCurrentRun: Array<{ startedAt: number; endedAt: number }> },
    normalizedName: string,
    toolCall: ToolCall,
  ): void {
    if (typeof toolCall.durationMs !== 'number' || !Number.isFinite(toolCall.durationMs) || toolCall.durationMs < 0) {
      return;
    }
    const durationMs = Math.trunc(toolCall.durationMs);
    run.toolUsage.totalDurationMs += durationMs;
    run.toolUsage.timedCallCount += 1;
    run.toolUsage.durationMsByName[normalizedName] =
      (run.toolUsage.durationMsByName[normalizedName] ?? 0) + durationMs;
    run.toolUsage.timedCallCountsByName[normalizedName] =
      (run.toolUsage.timedCallCountsByName[normalizedName] ?? 0) + 1;

    if (typeof toolCall.startedAt !== 'number' || !Number.isFinite(toolCall.startedAt)) return;
    const startedAt = toolCall.startedAt;
    const endedAt = startedAt + durationMs;
    let newlyCoveredMs = Math.max(0, endedAt - startedAt);
    for (const interval of state.toolExecutionIntervalsInCurrentRun) {
      newlyCoveredMs -= Math.max(0, Math.min(endedAt, interval.endedAt) - Math.max(startedAt, interval.startedAt));
    }
    const next = [...state.toolExecutionIntervalsInCurrentRun, { startedAt, endedAt }]
      .sort((left, right) => left.startedAt - right.startedAt);
    const merged: Array<{ startedAt: number; endedAt: number }> = [];
    for (const interval of next) {
      const previous = merged[merged.length - 1];
      if (!previous || interval.startedAt > previous.endedAt) merged.push({ ...interval });
      else previous.endedAt = Math.max(previous.endedAt, interval.endedAt);
    }
    state.toolExecutionIntervalsInCurrentRun = merged;
    run.toolUsage.criticalPathDurationMs = (run.toolUsage.criticalPathDurationMs ?? 0) + Math.max(0, newlyCoveredMs);
  }

  /** Record an execution failure: the tool could not complete its job. */
  private recordExecutionFailure(run: RunSnapshot, normalizedName: string, analysis: ToolCallAnalysis): void {
    const failure = analysis.failure!;
    run.toolUsage.failureCount += 1;
    run.toolUsage.executionFailureCount += 1;
    incrementNamedCount(run.toolUsage.failureCountsByName, normalizedName);
    incrementNamedCount(run.toolUsage.failureCountsByKind, failure.kind);
    const countsForTool = run.toolUsage.failureCountsByNameAndKind[normalizedName] ?? {} as Record<ToolFailureKind, number>;
    run.toolUsage.failureCountsByNameAndKind[normalizedName] = countsForTool;
    incrementNamedCount(countsForTool, failure.kind);

    this.appendCappedSample(run.toolUsage.failureSamples, {
      toolName: normalizedName,
      failureKind: failure.kind,
      exitCode: failure.exitCode,
      errorExcerpt: failure.errorExcerpt,
      verificationKinds: analysis.verificationKinds,
      occurredAt: this.runState.isoNow(),
    });
  }

  /** Record a non-success result: the tool ran fine but reported a non-success outcome. */
  private recordResultIssue(run: RunSnapshot, normalizedName: string, analysis: ToolCallAnalysis): void {
    const resultIssue = analysis.resultIssue!;
    run.toolUsage.resultIssueCount += 1;
    incrementNamedCount(run.toolUsage.resultIssueCountsByName, normalizedName);
    incrementNamedCount(run.toolUsage.resultIssueCountsByKind, resultIssue.kind);
    const issueCountsForTool = run.toolUsage.resultIssueCountsByNameAndKind[normalizedName] ?? {} as Record<ToolResultIssueKind, number>;
    run.toolUsage.resultIssueCountsByNameAndKind[normalizedName] = issueCountsForTool;
    incrementNamedCount(issueCountsForTool, resultIssue.kind);

    if (resultIssue.kind === 'verification_failure') {
      run.toolUsage.verificationProjectFailureCount += 1;
    } else {
      run.toolUsage.probeFailureCount += 1;
    }

    this.appendCappedSample(run.toolUsage.resultIssueSamples, {
      toolName: normalizedName,
      resultIssueKind: resultIssue.kind,
      exitCode: resultIssue.exitCode,
      errorExcerpt: resultIssue.errorExcerpt,
      verificationKinds: resultIssue.verificationKinds,
      occurredAt: this.runState.isoNow(),
    });
  }

  /** Append a failure/result-issue sample, capped at TOOL_FAILURE_SAMPLE_LIMIT entries. */
  private appendCappedSample<TSample>(samples: TSample[], sample: TSample): void {
    if (samples.length < TOOL_FAILURE_SAMPLE_LIMIT) {
      samples.push(sample);
    }
  }

  /** Roll up sub-agent call/task counts, score dimensions, and usage attribution. */
  private recordSubagentUsage(run: RunSnapshot, analysis: ToolCallAnalysis, toolCall: ToolCall): void {
    run.toolUsage.subagentCallCount += analysis.subagentCallCount;
    run.toolUsage.subagentTaskCount += analysis.subagentTaskCount;
    run.toolUsage.subagentAgentNames = appendUnique(
      run.toolUsage.subagentAgentNames,
      analysis.subagentAgentNames,
    );
    run.toolUsage.subagentScoredTaskCount += analysis.subagentScoredTaskCount;
    const dims = ['precision', 'creativity', 'reasoning', 'thoroughness'] as const;
    for (const dim of dims) {
      const src = analysis.subagentTaskScores[dim];
      const dst = run.toolUsage.subagentTaskScores[dim];
      dst.sum   += src.sum;
      dst.count += src.count;
      dst.max   = Math.max(dst.max, src.max);
    }
    // These are the canonical subagent totals. Aggregate accounting adds them
    // to parent-turn usage; auxiliary samples below only preserve the actual
    // child model and timestamp and must not be counted a second time.
    run.toolUsage.subagentInputTokens += analysis.subagentInputTokens;
    run.toolUsage.subagentOutputTokens += analysis.subagentOutputTokens;
    run.toolUsage.subagentCacheReadTokens += analysis.subagentCacheReadTokens;
    run.toolUsage.subagentCacheWriteTokens += analysis.subagentCacheWriteTokens;

    const renderable = getRenderableSubagentResult(toolCall.result);
    if (!renderable) {
      return;
    }
    const samples = run.auxiliaryLlmUsage ?? [];
    const additions = renderable.results.flatMap((result, index) => {
      const usage = result.usage;
      if (!usage) {
        return [];
      }
      const inputTokens = toNonNegativeInt(usage.input);
      const outputTokens = toNonNegativeInt(usage.output);
      const cacheReadTokens = toNonNegativeInt(usage.cacheRead);
      const cacheWriteTokens = toNonNegativeInt(usage.cacheWrite);
      if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens === 0) {
        return [];
      }
      const endedTimes = (result.turnThroughputSamples ?? [])
        .map((sample) => Date.parse(sample.endedAt))
        .filter((ms) => !Number.isNaN(ms));
      const occurredAt = endedTimes.length > 0
        ? new Date(Math.max(...endedTimes)).toISOString()
        : this.runState.isoNow();
      return [{
        kind: 'subagent' as const,
        sourceId: `${toolCall.id}:${index}`,
        occurredAt,
        modelId: result.model ?? result.selectedModel,
        ...(result.provider ? { provider: result.provider } : {}),
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
      }];
    });
    run.auxiliaryLlmUsage = [...samples, ...additions];
  }

  /** Persist terminal child-attempt diagnostics exactly once per stable attempt id.
   * Every terminal subagent tool call is accounted for at ingestion: a call
   * without parseable records increments explicit unknown coverage, so mixed
   * runs (one well-formed call plus one malformed call) stay mixed on reload. */
  private recordSubagentLifecycle(run: RunSnapshot, toolCall: ToolCall): void {
    const { samples: additions, coverageComplete } = getTerminalSubagentAttemptSamplesFromToolCall(toolCall);
    // Presence of an empty list is meaningful: this run has new-format
    // lifecycle ingestion, so aggregate code must not apply the legacy fallback.
    // Persisting source IDs makes terminal replay after checkpoint restore
    // idempotent even though process-local finished-tool sets are rebuilt.
    run.unknownSubagentAttemptRecordSourceIds ??= [];
    if (!coverageComplete && !run.unknownSubagentAttemptRecordSourceIds.includes(toolCall.id)) {
      run.unknownSubagentAttemptRecordSourceIds = [...run.unknownSubagentAttemptRecordSourceIds, toolCall.id];
    }
    const existing = run.subagentAttemptSamples ?? [];
    const seen = new Set(existing.map((sample) => sample.sourceId));
    const unique = additions.filter((sample) => !seen.has(sample.sourceId));
    if (unique.length > 0) {
      run.subagentAttemptSamples = [...existing, ...unique];
    }
  }

  /** Forward nested subagent per-turn throughput into the parent run snapshot. */
  private recordSubagentThroughput(run: RunSnapshot, toolCall: ToolCall): void {
    const renderable = getRenderableSubagentResult(toolCall.result);
    if (!renderable) {
      return;
    }
    for (const result of renderable.results) {
      if (!Array.isArray(result.turnThroughputSamples) || result.turnThroughputSamples.length === 0) {
        continue;
      }
      for (const sample of result.turnThroughputSamples) {
        if (!sample || typeof sample !== 'object') {
          continue;
        }
        const endedAt = typeof sample.endedAt === 'string' ? sample.endedAt : this.runState.isoNow();
        const outputTokens = toNonNegativeInt(sample.outputTokens);
        const generationDurationMs = toNonNegativeInt(sample.generationDurationMs);
        const status = typeof sample.status === 'string' ? sample.status : 'completed';
        const modelId = typeof result.model === 'string' ? result.model : sample.modelId;
        run.turnThroughputSamples.push({
          endedAt,
          outputTokens,
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          contextTokens: null,
          generationDurationMs,
          concurrentBusySessions: this.busySessionPaths.size,
          status: status as TurnThroughputStatus,
          modelId: modelId ?? undefined,
          ...(result.provider ? { provider: result.provider } : {}),
          turnLatencyMs: null,
          overheadMs: null,
          providerLatencyMs: null,
        });
      }
    }
  }

  /** Roll up verification-command counts (and failures, when the call failed). */
  private recordVerification(run: RunSnapshot, toolCall: ToolCall, analysis: ToolCallAnalysis): void {
    run.verification.totalCount += analysis.verificationKinds.length;
    for (const kind of analysis.verificationKinds) {
      run.verification.countsByKind[kind] += 1;
    }
    if (toolCall.status === 'failed') {
      run.verification.failureCount += analysis.verificationKinds.length;
    }
  }

  /** Roll up file mutations and per-extension read/write/edit counts (non-failed calls only). */
  private recordFileMutationAndExtensions(run: RunSnapshot, analysis: ToolCallAnalysis): void {
    run.fileMutation = mergeFileMutationDelta(run.fileMutation, analysis.fileMutation);

    if (analysis.fileExtension) {
      const { extension, operation } = analysis.fileExtension;
      const target = operation === 'read' ? run.fileExtensions.readCountsByExtension
        : operation === 'write' ? run.fileExtensions.writeCountsByExtension
        : run.fileExtensions.editCountsByExtension;
      incrementNamedCount(target, extension);
    }
  }

  onInterrupted(sessionPath: string): void {
    const run = this.runState.sessions.get(sessionPath)?.currentRun;
    if (!run) {
      return;
    }

    run.interruptedCount += 1;
    run.updatedAt = this.runState.isoNow();
    this.runState.persist();
  }

  /** Count a history-compaction (`/compact`) LLM call against the relevant run.
   *  Compaction emits no `message_start`/`message_end`, so its tokens are absent
   *  from the run totals — this count is the only available compaction signal. */
  onCompaction(sessionPath: string): void {
    const state = this.runState.sessions.get(sessionPath);
    const run = state ? (state.currentRun ?? state.lastRun) : null;
    if (!run || !state) {
      return;
    }

    run.compactionCount = (run.compactionCount ?? 0) + 1;
    run.updatedAt = this.runState.isoNow();
    this.runState.persist(state.currentRun ? undefined : run);
  }

  /** Count an auto-retry and retain its configured backoff even before a
   * measured terminal boundary becomes available. */
  onAutoRetry(
    sessionPath: string,
    timing?: { sourceId: string; occurredAt: string; attempt: number; scheduledDelayMs: number },
  ): void {
    const state = this.runState.sessions.get(sessionPath);
    const run = state ? (state.currentRun ?? state.lastRun) : null;
    if (!run || !state) return;

    const samples = run.retryTimingSamples ?? [];
    if (timing && samples.some((sample) => sample.sourceId === timing.sourceId)) return;
    run.autoRetryCount = (run.autoRetryCount ?? 0) + 1;
    if (timing) {
      run.retryTimingSamples = [...samples, {
        sourceId: timing.sourceId,
        occurredAt: timing.occurredAt,
        attempt: toNonNegativeInt(timing.attempt),
        scheduledDelayMs: toNonNegativeInt(timing.scheduledDelayMs),
        measuredDelayMs: null,
        durationMs: null,
      }];
    }
    run.updatedAt = this.runState.isoNow();
    this.runState.persist(state.currentRun ? undefined : run);
  }

  onAutoRetryMeasured(
    sessionPath: string,
    sourceId: string,
    measuredDelayMs: number | undefined,
    durationMs: number,
  ): void {
    const state = this.runState.sessions.get(sessionPath);
    const run = state ? (state.currentRun ?? state.lastRun) : null;
    if (!run || !state || !sourceId) return;
    const samples = run.retryTimingSamples ?? [];
    const index = samples.findIndex((sample) => sample.sourceId === sourceId);
    if (index < 0) return;
    const existing = samples[index]!;
    const updated = {
      ...existing,
      measuredDelayMs: measuredDelayMs === undefined ? null : toNonNegativeInt(measuredDelayMs),
      durationMs: toNonNegativeInt(durationMs),
    };
    run.retryTimingSamples = samples.map((sample, sampleIndex) => sampleIndex === index ? updated : sample);
    run.updatedAt = this.runState.isoNow();
    this.runState.persist(state.currentRun ? undefined : run);
  }

  onMessageEdited(sessionPath: string): void {
    const state = this.runState.sessions.get(sessionPath);
    const run = state ? (state.currentRun ?? state.lastRun) : null;
    if (!run || !state) {
      return;
    }

    run.messageEditCount += 1;
    run.updatedAt = this.runState.isoNow();
    // Only append a snapshot when mutating a finalized run (lastRun). An active
    // currentRun's full snapshot is appended at finalization, so mid-run mutations
    // just update the checkpoint — avoiding write amplification and leaking
    // in-progress runs into the completedRuns export.
    this.runState.persist(state.currentRun ? undefined : run);
  }

  onTruncatedAfter(sessionPath: string): void {
    const state = this.runState.sessions.get(sessionPath);
    const run = state ? (state.currentRun ?? state.lastRun) : null;
    if (!run || !state) {
      return;
    }

    run.truncatedAfterCount += 1;
    run.updatedAt = this.runState.isoNow();
    this.runState.persist(state.currentRun ? undefined : run);
  }

  onBackendError(sessionPath: string | undefined, code: string): void {
    if (!sessionPath) {
      return;
    }
    const state = this.runState.sessions.get(sessionPath);
    const run = state ? (state.currentRun ?? state.lastRun) : null;
    if (!run || !state) {
      return;
    }

    run.backendErrorCodes = [...run.backendErrorCodes, code];
    run.updatedAt = this.runState.isoNow();
    this.runState.persist(state.currentRun ? undefined : run);
  }

  onContextUsageChanged(sessionPath: string, tokens: number | null, limit: number): void {
    const run = this.runState.sessions.get(sessionPath)?.currentRun;
    if (!run) {
      return;
    }

    run.contextTokens = tokens;
    run.contextLimit = limit;
    run.updatedAt = this.runState.isoNow();
    this.runState.persist();
  }

  onBusyChanged(sessionPath: string, busy: boolean): void {
    // Track concurrent busy sessions globally (before the run-state guard) so
    // the counter stays accurate even for sessions whose run snapshot hasn't
    // been created yet or has already been finalized.
    if (busy) {
      this.busySessionPaths.add(sessionPath);
    } else {
      this.busySessionPaths.delete(sessionPath);
    }

    const state = this.runState.sessions.get(sessionPath);
    const run = state?.currentRun;
    if (!state || !run) {
      return;
    }

    if (busy) {
      if (!state.busyStartedAt) {
        state.busyStartedAt = this.runState.isoNow();
        run.busyPeriodCount += 1;
        run.updatedAt = this.runState.isoNow();
        this.runState.persist();
      }
      return;
    }

    if (this.runState.closeBusyInterval(state)) {
      run.updatedAt = this.runState.isoNow();
      this.runState.persist();
    }
  }

  onModelConfigChanged(
    sessionPath: string,
    modelId: string | undefined,
    thinkingLevel: ThinkingLevel | undefined,
    provider?: string,
  ): void {
    const run = this.runState.sessions.get(sessionPath)?.currentRun;
    if (!run) {
      return;
    }

    const changedKinds: TreatmentChangeKind[] = [];
    if ((run.modelId ?? null) !== (modelId ?? null) || (run.provider ?? null) !== (provider ?? null)) {
      changedKinds.push('model');
    }
    if ((run.thinkingLevel ?? null) !== (thinkingLevel ?? null)) {
      changedKinds.push('thinking');
    }
    if (changedKinds.length === 0) {
      return;
    }

    run.mixedModelConfig = true;
    // Record the latest model/thinking level on the run so downstream analytics
    // can attribute provider and cost. Without this, a run created before the
    // model was resolved (modelId placeholder/undefined) stays stuck at that
    // placeholder even after the real model is known, leaving provider and
    // estimatedCostUsd unattributable (resolveModelProvider / estimateRunCostUsd
    // derive both from run.modelId). Only overwrite with a defined value so a
    // transient undefined never clobbers a known model. For genuinely mixed
    // runs the latest model is recorded (mixedModelConfig flags the mix).
    if (modelId) run.modelId = modelId;
    if (provider) run.provider = provider;
    if (thinkingLevel) run.thinkingLevel = thinkingLevel;
    this.runState.markTreatmentChanges(run, changedKinds);
    run.updatedAt = this.runState.isoNow();
    this.runState.persist();
  }

  onUnsupportedInputAttempt(sessionPath: string): void {
    const state = this.runState.getOrCreateSessionState(sessionPath);
    if (state.currentRun) {
      state.currentRun.unsupportedInputCount += 1;
      state.currentRun.updatedAt = this.runState.isoNow();
    } else {
      state.queuedUnsupportedInputCount += 1;
    }
    this.runState.persist();
  }

  onSessionClosed(sessionPath: string): void {
    this.busySessionPaths.delete(sessionPath);
    if (this.runState.sessions.get(sessionPath)?.currentRun) {
      this.runState.finalizeCurrentRun(sessionPath, 'closed_unscored');
    }
    this.runState.sessions.delete(sessionPath);
    this.dispatchArchEvent({ kind: 'ActiveRunSummaryChanged', sessionPath, summary: null });
    this.runState.persist();
    this.scheduleRender();
  }

  replaceSessionPath(oldPath: string, newPath: string): void {
    if (!oldPath || !newPath || oldPath === newPath) {
      return;
    }
    if (this.busySessionPaths.has(oldPath)) {
      this.busySessionPaths.delete(oldPath);
      this.busySessionPaths.add(newPath);
    }
    const state = this.runState.sessions.get(oldPath);
    if (!state) {
      return;
    }

    if (state.currentRun) {
      state.currentRun = { ...state.currentRun, sessionPath: newPath };
    }
    if (state.lastRun) {
      state.lastRun = { ...state.lastRun, sessionPath: newPath };
    }

    // Only append a snapshot when there is no active currentRun (i.e. the rename
    // affects a finalized lastRun that won't otherwise be re-appended). An active
    // currentRun's renamed snapshot is appended at finalization; appending here
    // would leak an in-progress run into the completedRuns export.
    const snapshotToAppend = state.currentRun ? undefined : state.lastRun;

    this.runState.sessions.delete(oldPath);
    this.runState.sessions.set(newPath, state);
    this.runState.persist(snapshotToAppend ?? undefined);
  }

  recordOutcome(sessionPath: string, outcome: RunOutcome): void {
    // User outcomes historically had no provenance field; keep that wire shape
    // stable and reserve the explicit `agent` marker for agent-authored scores.
    this.recordOutcomeWithSource(sessionPath, {
      resolution: outcome.resolution,
      satisfaction: outcome.satisfaction,
    });
  }

  private recordOutcomeWithSource(sessionPath: string, outcome: RunOutcome): void {
    const state = this.runState.getOrCreateSessionState(sessionPath);

    if (state.currentRun) {
      this.runState.finalizeCurrentRun(sessionPath, 'scored', outcome);
      this.scheduleRender();
      return;
    }

    // A user outcome may replace an agent-authored outcome, and a corrected
    // agent review may replace its earlier agent-authored outcome. Never let an
    // agent review overwrite an existing user outcome.
    const canUpdateLastRun = state.lastRun?.status === 'closed_unscored'
      || (state.lastRun?.status === 'scored' && state.lastRun.outcome?.source === 'agent');
    if (!state.lastRun || !canUpdateLastRun) {
      return;
    }

    const updatedRun: RunSnapshot = {
      ...state.lastRun,
      status: 'scored',
      scored: true,
      outcome,
      finalizationReason: 'scored',
      finalizedAt: state.lastRun.finalizedAt ?? this.runState.isoNow(),
      updatedAt: this.runState.isoNow(),
    };
    state.lastRun = updatedRun;

    this.runState.syncSessionSummary(sessionPath);
    this.runState.persist(
      updatedRun,
      this.runState.buildOutcomeHistoryEntry(updatedRun, outcome),
    );
    this.scheduleRender();
  }

  recordAgentReview(
    sessionPath: string,
    review: {
      done: boolean;
      rating: number;
      completion: AgentReviewCompletion;
      reason: string;
      evaluatedAt: string;
      reviewerBuckets: string[];
      reviewerCount: number;
    },
  ): void {
    const state = this.runState.getOrCreateSessionState(sessionPath);
    const run = state.currentRun ?? state.lastRun;
    if (!run) {
      return;
    }
    const recordedAt = this.runState.isoNow();
    const entry: AgentReviewEntry = {
      schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
      kind: 'agent_review',
      recordedAt,
      sessionPath,
      runId: run.runId,
      taskGroupId: run.taskGroupId,
      done: review.done,
      rating: review.rating,
      completion: review.completion,
      reason: review.reason,
      evaluatedAt: review.evaluatedAt ?? recordedAt,
      reviewerBuckets: review.reviewerBuckets ?? [],
      reviewerCount: review.reviewerCount ?? 0,
    };
    this.runState.persistAgentReview(entry);

    // A completed agent review is a first-class run outcome. Persist the
    // provenance on the outcome, but otherwise feed it through the same scored
    // run path as a user rating so every aggregate and leaderboard sees it.
    const outcome = review.done
      ? outcomeFromAgentReview(review.rating, review.completion)
      : null;
    if (outcome) {
      this.recordOutcomeWithSource(sessionPath, outcome);
    }
  }

  startNewTask(sessionPath: string): void {
    const state = this.runState.getOrCreateSessionState(sessionPath);
    if (state.nextTaskIntent === 'new_task') {
      return;
    }

    state.nextTaskIntent = 'new_task';
    this.runState.syncSessionSummary(sessionPath);
    this.runState.persist();
    this.scheduleRender();
  }

  continueTask(sessionPath: string): void {
    const state = this.runState.getOrCreateSessionState(sessionPath);
    if (state.nextTaskIntent === 'continue_task') {
      return;
    }

    state.nextTaskIntent = 'continue_task';
    this.runState.syncSessionSummary(sessionPath);
    this.runState.persist();
    this.scheduleRender();
  }

  onExperimentAssignmentChanged(assignment: string | null): void {
    const normalized = normalizeExperimentAssignment(assignment);
    let changed = false;
    for (const state of this.runState.sessions.values()) {
      const run = state.currentRun;
      if (!run || run.experimentAssignment === normalized) {
        continue;
      }
      this.runState.markTreatmentChanges(run, ['experimentAssignment']);
      run.updatedAt = this.runState.isoNow();
      changed = true;
    }
    if (changed) {
      this.runState.persist();
    }
  }

  finalizeOpenRunsForShutdown(): void {
    const openSessionPaths = [...this.runState.sessions.entries()]
      .filter(([, state]) => !!state.currentRun)
      .map(([sessionPath]) => sessionPath);

    for (const sessionPath of openSessionPaths) {
      this.runState.finalizeCurrentRun(sessionPath, 'closed_unscored');
    }
    this.busySessionPaths.clear();
  }
}
