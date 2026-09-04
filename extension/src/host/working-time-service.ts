import type { WorkingTimeBreakdown, WorkingTimeState } from '../shared/protocol';
import { normalizeToolCallName } from '../shared/tool-call-analysis/summary';
import type { RunSnapshot } from './run-analytics';

type RunContribution = WorkingTimeBreakdown & {
  /** Timed work known to happen before the backend busy boundary. */
  workingClockExtraMs: number;
};

interface ObservedRun {
  sessionPath: string;
  contribution: RunContribution;
}

export interface PersistedBusyInterval {
  sessionPath: string;
  busyStartedAt: string;
}

/**
 * Tracks cumulative agent-busy wall time per durable session.
 *
 * Busy boundaries come from the backend and cover the complete agent run,
 * including model/provider waits, retries, history compaction, and tool work.
 * Idle time between runs is excluded. The webview receives an accumulated
 * duration plus an optional live start timestamp and advances only the display
 * clock locally. Durable analytics snapshots provide the measured attribution
 * shown in the rich tooltip.
 */
export class WorkingTimeService {
  private readonly now: () => Date;
  private readonly onChanged: () => void;
  private readonly totalMsBySession: Record<string, number> = {};
  private readonly extraMsBySession: Record<string, number> = {};
  private readonly activeSinceBySession: Record<string, number> = {};
  private readonly breakdownBySession: Record<string, WorkingTimeBreakdown> = {};
  private readonly observedRunsById: Record<string, ObservedRun> = {};
  private readonly restoredBusyRunIds: Record<string, true> = {};
  private readonly activeToolsBySession: Record<string, Record<string, { name: string; startedAt: number }>> = {};
  private readonly activeToolSinceBySession: Record<string, number> = {};
  private readonly toolExecutionFloorMsBySession: Record<string, number> = {};
  private cached: Record<string, WorkingTimeState> = {};

  constructor(options: { now: () => Date; onChanged: () => void }) {
    this.now = options.now;
    this.onChanged = options.onChanged;
  }

  /** Seed durable totals, attribution, and any open busy interval from
   * persisted analytics snapshots. Open intervals are restored separately from
   * run.busyDurationMs because the latter excludes the currently open period. */
  restoreRuns(runs: RunSnapshot[], openBusyIntervals: readonly PersistedBusyInterval[] = []): void {
    let changed = false;
    for (const run of runs) {
      if (!run.runId) continue;
      if (!this.restoredBusyRunIds[run.runId]) {
        this.restoredBusyRunIds[run.runId] = true;
        const durationMs = finiteDuration(run.busyDurationMs);
        if (durationMs > 0) {
          this.totalMsBySession[run.sessionPath] = (this.totalMsBySession[run.sessionPath] ?? 0) + durationMs;
          changed = true;
        }
      }
      changed = this.observeRunInternal(run) || changed;
    }

    const nowMs = this.now().getTime();
    for (const interval of openBusyIntervals) {
      if (!interval.sessionPath) continue;
      const parsedStartedAt = Date.parse(interval.busyStartedAt);
      if (!Number.isFinite(parsedStartedAt)) continue;
      const startedAt = Math.min(parsedStartedAt, nowMs);
      const existing = this.activeSinceBySession[interval.sessionPath];
      if (existing === undefined || startedAt < existing) {
        this.activeSinceBySession[interval.sessionPath] = startedAt;
        changed = true;
      }
    }
    if (changed) this.publish();
  }

  /** Refresh one run's monotonic analytics contribution without double-counting
   * restored open runs or repeatedly delivered terminal observations. */
  observeRun(run: RunSnapshot): void {
    if (this.observeRunInternal(run)) this.publish();
  }

  onBusyChanged(sessionPath: string, busy: boolean): void {
    if (!sessionPath) return;
    if (busy) {
      if (this.activeSinceBySession[sessionPath] !== undefined) return;
      this.activeSinceBySession[sessionPath] = this.now().getTime();
      this.publish();
      return;
    }

    const startedAt = this.activeSinceBySession[sessionPath];
    if (startedAt === undefined) return;
    const endedAt = this.now().getTime();
    this.settleActiveToolInterval(sessionPath, endedAt);
    delete this.activeToolsBySession[sessionPath];
    delete this.activeToolSinceBySession[sessionPath];
    this.totalMsBySession[sessionPath] = (this.totalMsBySession[sessionPath] ?? 0)
      + Math.max(0, endedAt - startedAt);
    delete this.activeSinceBySession[sessionPath];
    this.publish();
  }

  /** Record live tool boundaries separately from durable run telemetry. This
   * keeps an executing MCP/subagent/tool interval out of "Other work" before
   * its terminal analytics snapshot exists. Parallel calls share one wall-time
   * interval while their per-name detail remains cumulative. */
  onToolStarted(sessionPath: string, tool: { id: string; name: string; startedAt?: number }): void {
    if (!sessionPath || !tool.id) return;
    const tools = this.activeToolsBySession[sessionPath] ?? {};
    if (tools[tool.id]) return;
    const observedAt = this.now().getTime();
    const startedAt = finiteTimestamp(tool.startedAt) ?? observedAt;
    if (Object.keys(tools).length === 0) {
      this.toolExecutionFloorMsBySession[sessionPath] = Math.max(
        this.toolExecutionFloorMsBySession[sessionPath] ?? 0,
        this.breakdownBySession[sessionPath]?.toolExecutionMs ?? 0,
      );
      this.activeToolSinceBySession[sessionPath] = startedAt;
    }
    const normalizedName = normalizeToolCallName(tool.name) || tool.name.trim() || '(unknown)';
    tools[tool.id] = { name: normalizedName, startedAt };
    this.activeToolsBySession[sessionPath] = tools;
    this.publish();
  }

  onToolFinished(
    sessionPath: string,
    tool: { id: string; startedAt?: number; durationMs?: number },
  ): void {
    const tools = this.activeToolsBySession[sessionPath];
    if (!tools?.[tool.id]) return;
    const measuredStartedAt = finiteTimestamp(tool.startedAt);
    const measuredDurationMs = finiteOptionalDuration(tool.durationMs);
    const measuredEndedAt = measuredStartedAt !== null && measuredDurationMs !== null
      ? measuredStartedAt + measuredDurationMs
      : null;
    const endedAt = Math.max(
      this.activeToolSinceBySession[sessionPath] ?? 0,
      measuredEndedAt ?? this.now().getTime(),
    );
    this.settleActiveToolInterval(sessionPath, endedAt);
    delete tools[tool.id];
    if (Object.keys(tools).length > 0) {
      this.activeToolSinceBySession[sessionPath] = endedAt;
    } else {
      delete this.activeToolsBySession[sessionPath];
      delete this.activeToolSinceBySession[sessionPath];
    }
    this.publish();
  }

  /** Privacy mode discards prior timing and attribution and optionally starts a
   * fresh, process-local interval for a run that is already active. */
  resetSession(sessionPath: string, active: boolean): void {
    delete this.totalMsBySession[sessionPath];
    delete this.extraMsBySession[sessionPath];
    delete this.activeSinceBySession[sessionPath];
    delete this.breakdownBySession[sessionPath];
    delete this.activeToolsBySession[sessionPath];
    delete this.activeToolSinceBySession[sessionPath];
    delete this.toolExecutionFloorMsBySession[sessionPath];
    for (const [runId, observed] of Object.entries(this.observedRunsById)) {
      if (observed.sessionPath === sessionPath) delete this.observedRunsById[runId];
    }
    if (active) this.activeSinceBySession[sessionPath] = this.now().getTime();
    this.publish();
  }

  replaceSessionPath(oldPath: string, newPath: string): void {
    if (!oldPath || !newPath || oldPath === newPath) return;
    const oldTotal = this.totalMsBySession[oldPath];
    const oldExtra = this.extraMsBySession[oldPath];
    const oldActiveSince = this.activeSinceBySession[oldPath];
    const oldBreakdown = this.breakdownBySession[oldPath];
    const newBreakdownToolMs = this.breakdownBySession[newPath]?.toolExecutionMs ?? 0;
    const oldActiveTools = this.activeToolsBySession[oldPath];
    const oldActiveToolSince = this.activeToolSinceBySession[oldPath];
    const oldToolFloor = this.toolExecutionFloorMsBySession[oldPath];
    if (oldTotal === undefined && oldExtra === undefined && oldActiveSince === undefined && oldBreakdown === undefined
      && oldActiveTools === undefined && oldToolFloor === undefined) return;

    if (oldTotal !== undefined) {
      this.totalMsBySession[newPath] = (this.totalMsBySession[newPath] ?? 0) + oldTotal;
      delete this.totalMsBySession[oldPath];
    }
    if (oldExtra !== undefined) {
      this.extraMsBySession[newPath] = (this.extraMsBySession[newPath] ?? 0) + oldExtra;
      delete this.extraMsBySession[oldPath];
    }
    if (oldActiveSince !== undefined) {
      const existing = this.activeSinceBySession[newPath];
      this.activeSinceBySession[newPath] = existing === undefined
        ? oldActiveSince
        : Math.min(existing, oldActiveSince);
      delete this.activeSinceBySession[oldPath];
    }
    if (oldBreakdown) {
      applyContribution(this.breakdownBySession, newPath, oldBreakdown, 1);
      delete this.breakdownBySession[oldPath];
      for (const observed of Object.values(this.observedRunsById)) {
        if (observed.sessionPath === oldPath) observed.sessionPath = newPath;
      }
    }
    if (oldActiveTools) {
      this.activeToolsBySession[newPath] = {
        ...(this.activeToolsBySession[newPath] ?? {}),
        ...oldActiveTools,
      };
      delete this.activeToolsBySession[oldPath];
    }
    if (oldActiveToolSince !== undefined) {
      this.activeToolSinceBySession[newPath] = Math.min(
        this.activeToolSinceBySession[newPath] ?? oldActiveToolSince,
        oldActiveToolSince,
      );
      delete this.activeToolSinceBySession[oldPath];
    }
    if (oldToolFloor !== undefined) {
      const oldBaseToolMs = oldBreakdown?.toolExecutionMs ?? 0;
      const oldLiveOnlyMs = Math.max(0, oldToolFloor - oldBaseToolMs);
      const newLiveOnlyMs = Math.max(
        0,
        (this.toolExecutionFloorMsBySession[newPath] ?? 0) - newBreakdownToolMs,
      );
      const mergedBaseToolMs = this.breakdownBySession[newPath]?.toolExecutionMs ?? 0;
      this.toolExecutionFloorMsBySession[newPath] = mergedBaseToolMs + oldLiveOnlyMs + newLiveOnlyMs;
      delete this.toolExecutionFloorMsBySession[oldPath];
    }
    this.publish();
  }

  getStates(): Record<string, WorkingTimeState> {
    return this.cached;
  }

  private observeRunInternal(run: RunSnapshot): boolean {
    if (!run.runId || !run.sessionPath) return false;
    const contribution = contributionFromRun(run);
    const previous = this.observedRunsById[run.runId];
    if (previous?.sessionPath === run.sessionPath
      && contributionsEqual(previous.contribution, contribution)) return false;

    if (previous) {
      applyContribution(this.breakdownBySession, previous.sessionPath, previous.contribution, -1);
      applyClockExtra(this.extraMsBySession, previous.sessionPath, previous.contribution.workingClockExtraMs, -1);
    }
    applyContribution(this.breakdownBySession, run.sessionPath, contribution, 1);
    applyClockExtra(this.extraMsBySession, run.sessionPath, contribution.workingClockExtraMs, 1);
    this.observedRunsById[run.runId] = { sessionPath: run.sessionPath, contribution };
    return true;
  }

  private publish(): void {
    const next: Record<string, WorkingTimeState> = {};
    const sessionPaths = new Set([
      ...Object.keys(this.totalMsBySession),
      ...Object.keys(this.extraMsBySession),
      ...Object.keys(this.activeSinceBySession),
      ...Object.keys(this.breakdownBySession),
      ...Object.keys(this.activeToolsBySession),
      ...Object.keys(this.toolExecutionFloorMsBySession),
    ]);
    for (const sessionPath of sessionPaths) {
      const base = this.breakdownBySession[sessionPath];
      const activeTools = Object.entries(this.activeToolsBySession[sessionPath] ?? {}).map(([id, tool]) => ({
        id,
        ...tool,
      }));
      const toolFloor = this.toolExecutionFloorMsBySession[sessionPath] ?? 0;
      const breakdown = base || toolFloor > 0 || activeTools.length > 0
        ? cloneBreakdown(base ?? emptyBreakdown())
        : undefined;
      if (breakdown) breakdown.toolExecutionMs = Math.max(breakdown.toolExecutionMs, toolFloor);
      next[sessionPath] = {
        accumulatedMs: (this.totalMsBySession[sessionPath] ?? 0) + (this.extraMsBySession[sessionPath] ?? 0),
        activeSince: this.activeSinceBySession[sessionPath] ?? null,
        ...(this.activeToolSinceBySession[sessionPath] !== undefined
          ? { activeToolSince: this.activeToolSinceBySession[sessionPath] }
          : {}),
        ...(activeTools.length > 0 ? { activeTools } : {}),
        ...(breakdown ? { breakdown } : {}),
      };
    }
    this.cached = next;
    this.onChanged();
  }

  private settleActiveToolInterval(sessionPath: string, endedAt: number): void {
    const startedAt = this.activeToolSinceBySession[sessionPath];
    if (startedAt === undefined) return;
    const settled = Math.max(
      this.toolExecutionFloorMsBySession[sessionPath] ?? 0,
      this.breakdownBySession[sessionPath]?.toolExecutionMs ?? 0,
    );
    this.toolExecutionFloorMsBySession[sessionPath] = settled + Math.max(0, endedAt - startedAt);
  }
}

function emptyBreakdown(): WorkingTimeBreakdown {
  return {
    generationMs: 0,
    toolExecutionMs: 0,
    estimatedToolExecutionMs: 0,
    retryWaitMs: 0,
    estimatedRetryWaitMs: 0,
    auxiliaryGenerationMs: 0,
    toolDurationMsByName: {},
    toolCallCountByName: {},
  };
}

function cloneBreakdown(value: WorkingTimeBreakdown): WorkingTimeBreakdown {
  return {
    ...value,
    toolDurationMsByName: { ...value.toolDurationMsByName },
    toolCallCountByName: { ...value.toolCallCountByName },
  };
}

function contributionFromRun(run: RunSnapshot): RunContribution {
  let observedParentGenerationMs = 0;
  let auxiliaryGenerationMs = 0;
  let workingClockExtraMs = 0;
  const seenAuxiliarySamples = new Set<string>();
  for (const sample of run.auxiliaryLlmUsage ?? []) {
    const dedupKey = `${sample.kind}:${sample.sourceId}`;
    if (seenAuxiliarySamples.has(dedupKey)) continue;
    seenAuxiliarySamples.add(dedupKey);
    if (sample.kind === 'assistant_message') {
      observedParentGenerationMs += finiteDuration(sample.durationMs);
    } else if (sample.kind !== 'subagent') {
      const durationMs = finiteDuration(sample.durationMs);
      auxiliaryGenerationMs += durationMs;
      // The backend asserts busy only after the before-agent-start prepass.
      // Add that measured prepass once to the session clock; compaction and
      // branch-summary calls already occur inside busy intervals.
      if (sample.kind === 'skill_pruning_prepass') workingClockExtraMs += durationMs;
    }
  }
  // Durable assistant-message samples expose every provider turn in an active
  // tool loop, whereas the terminal counter is a historical/final-turn
  // fallback. Reconcile rather than sum so the final provider response is not
  // counted twice.
  const generationMs = Math.max(
    finiteDuration(run.assistantTurnDurationMs),
    observedParentGenerationMs,
  );
  let retryWaitMs = 0;
  let estimatedRetryWaitMs = 0;
  for (const sample of run.retryTimingSamples ?? []) {
    if (sample.measuredDelayMs !== null && sample.measuredDelayMs !== undefined) {
      retryWaitMs += finiteDuration(sample.measuredDelayMs);
    } else {
      const scheduledMs = finiteDuration(sample.scheduledDelayMs);
      retryWaitMs += scheduledMs;
      estimatedRetryWaitMs += scheduledMs;
    }
  }

  const subagent = subagentContribution(run);
  const cumulativeToolMs = finiteDuration(run.toolUsage?.totalDurationMs);
  const measuredToolMs = finiteOptionalDuration(run.toolUsage?.criticalPathDurationMs);
  const remainingBusyMs = Math.max(
    0,
    finiteDuration(run.busyDurationMs) - generationMs - auxiliaryGenerationMs - retryWaitMs,
  );
  const estimatedToolMs = measuredToolMs === null
    ? finiteDuration(run.busyDurationMs) > 0
      ? Math.min(cumulativeToolMs, remainingBusyMs)
      : cumulativeToolMs
    : 0;
  const toolExecutionMs = measuredToolMs ?? estimatedToolMs;

  return {
    workingClockExtraMs,
    generationMs,
    toolExecutionMs,
    estimatedToolExecutionMs: estimatedToolMs,
    retryWaitMs,
    estimatedRetryWaitMs,
    auxiliaryGenerationMs,
    ...subagent,
    toolDurationMsByName: finiteDurationRecord(run.toolUsage?.durationMsByName),
    toolCallCountByName: finiteDurationRecord(run.toolUsage?.timedCallCountsByName),
  };
}

function applyContribution(
  bySession: Record<string, WorkingTimeBreakdown>,
  sessionPath: string,
  contribution: WorkingTimeBreakdown,
  direction: 1 | -1,
): void {
  const target = bySession[sessionPath] ?? emptyBreakdown();
  target.generationMs = nonNegative(target.generationMs + direction * contribution.generationMs);
  target.toolExecutionMs = nonNegative(target.toolExecutionMs + direction * contribution.toolExecutionMs);
  target.estimatedToolExecutionMs = nonNegative(target.estimatedToolExecutionMs + direction * contribution.estimatedToolExecutionMs);
  target.retryWaitMs = nonNegative(target.retryWaitMs + direction * contribution.retryWaitMs);
  target.estimatedRetryWaitMs = nonNegative(target.estimatedRetryWaitMs + direction * contribution.estimatedRetryWaitMs);
  target.auxiliaryGenerationMs = nonNegative(target.auxiliaryGenerationMs + direction * contribution.auxiliaryGenerationMs);
  applyOptionalMetric(target, 'subagentDurationMs', contribution.subagentDurationMs, direction);
  applyOptionalMetric(target, 'estimatedSubagentDurationMs', contribution.estimatedSubagentDurationMs, direction);
  applyOptionalMetric(target, 'subagentAttemptCount', contribution.subagentAttemptCount, direction);
  applyOptionalMetric(target, 'unknownSubagentDurationCount', contribution.unknownSubagentDurationCount, direction);
  applyRecord(target.toolDurationMsByName, contribution.toolDurationMsByName, direction);
  applyRecord(target.toolCallCountByName, contribution.toolCallCountByName, direction);
  if (breakdownHasValues(target)) bySession[sessionPath] = target;
  else delete bySession[sessionPath];
}

function applyClockExtra(
  bySession: Record<string, number>,
  sessionPath: string,
  contribution: number,
  direction: 1 | -1,
): void {
  const next = nonNegative((bySession[sessionPath] ?? 0) + direction * contribution);
  if (next > 0) bySession[sessionPath] = next;
  else delete bySession[sessionPath];
}

function applyOptionalMetric(
  target: WorkingTimeBreakdown,
  key: 'subagentDurationMs' | 'estimatedSubagentDurationMs' | 'subagentAttemptCount' | 'unknownSubagentDurationCount',
  contribution: number | undefined,
  direction: 1 | -1,
): void {
  const next = nonNegative((target[key] ?? 0) + direction * (contribution ?? 0));
  if (next > 0) target[key] = next;
  else delete target[key];
}

function applyRecord(target: Record<string, number>, contribution: Record<string, number>, direction: 1 | -1): void {
  for (const [key, value] of Object.entries(contribution)) {
    const next = nonNegative((target[key] ?? 0) + direction * value);
    if (next === 0) delete target[key];
    else target[key] = next;
  }
}

function breakdownHasValues(value: WorkingTimeBreakdown): boolean {
  return value.generationMs > 0
    || value.toolExecutionMs > 0
    || value.retryWaitMs > 0
    || value.auxiliaryGenerationMs > 0
    || (value.subagentAttemptCount ?? 0) > 0
    || (value.unknownSubagentDurationCount ?? 0) > 0
    || Object.keys(value.toolDurationMsByName).length > 0;
}

function contributionsEqual(left: RunContribution, right: RunContribution): boolean {
  return left.workingClockExtraMs === right.workingClockExtraMs
    && left.generationMs === right.generationMs
    && left.toolExecutionMs === right.toolExecutionMs
    && left.estimatedToolExecutionMs === right.estimatedToolExecutionMs
    && left.retryWaitMs === right.retryWaitMs
    && left.estimatedRetryWaitMs === right.estimatedRetryWaitMs
    && left.auxiliaryGenerationMs === right.auxiliaryGenerationMs
    && (left.subagentDurationMs ?? 0) === (right.subagentDurationMs ?? 0)
    && (left.estimatedSubagentDurationMs ?? 0) === (right.estimatedSubagentDurationMs ?? 0)
    && (left.subagentAttemptCount ?? 0) === (right.subagentAttemptCount ?? 0)
    && (left.unknownSubagentDurationCount ?? 0) === (right.unknownSubagentDurationCount ?? 0)
    && recordsEqual(left.toolDurationMsByName, right.toolDurationMsByName)
    && recordsEqual(left.toolCallCountByName, right.toolCallCountByName);
}

function recordsEqual(left: Record<string, number>, right: Record<string, number>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => left[key] === right[key]);
}

function subagentContribution(run: RunSnapshot): Partial<WorkingTimeBreakdown> {
  if (!Array.isArray(run.subagentAttemptSamples) || run.subagentAttemptSamples.length === 0) return {};

  let durationMs = 0;
  let estimatedDurationMs = 0;
  let unknownDurationCount = run.unknownSubagentAttemptRecordSourceIds?.length ?? 0;
  for (const sample of run.subagentAttemptSamples) {
    if (sample.durationMs === null || sample.durationSource === 'unknown') {
      unknownDurationCount += 1;
    } else {
      const duration = finiteDuration(sample.durationMs);
      durationMs += duration;
      if (sample.durationSource === 'estimated') estimatedDurationMs += duration;
    }

    if (sample.retryIndex > 0 && sample.backoffMs !== null && sample.backoffSource !== 'unknown') {
      const backoff = finiteDuration(sample.backoffMs);
      durationMs += backoff;
      if (sample.backoffSource === 'estimated') estimatedDurationMs += backoff;
    }
  }

  return {
    subagentDurationMs: durationMs,
    estimatedSubagentDurationMs: estimatedDurationMs,
    subagentAttemptCount: run.subagentAttemptSamples.length,
    unknownSubagentDurationCount: unknownDurationCount,
  };
}

function finiteDurationRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, number> = {};
  for (const [key, duration] of Object.entries(value)) {
    const finite = finiteDuration(duration);
    if (finite > 0) result[key] = finite;
  }
  return result;
}

function finiteOptionalDuration(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function finiteTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function finiteDuration(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;
}

function nonNegative(value: number): number {
  return Math.max(0, Math.trunc(value));
}
