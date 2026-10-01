import type { ArchState } from '../conversation-state/arch-state.js';
import type {
  LiveSessionActivity,
  LiveSessionClosingEntry,
  LiveSessionMembershipEntry,
  LiveSessionUsageSnapshot,
  HostLiveMembershipSnapshotParams,
} from '../../../harness/agent-processes/lib/rpc/live-session-control.js';
import {
  MAX_LIVE_MEMBERSHIP_CLOSING,
  MAX_LIVE_MEMBERSHIP_SESSIONS,
} from '../../../harness/agent-processes/lib/rpc/live-session-control.js';
import type { RunSnapshot } from '../../../analytics/legacy/run-analytics/types.js';
import type { SessionUsageSnapshot as StatsSessionUsageSnapshot } from '../../../analytics/usage-accounting/session-usage.js';
import type { WorkingTimeState } from '../../lib/protocol/index.js';
import { isPendingTabPath } from '../../../lib/session-path.js';

/**
 * Host-owned live membership projection (agent session-control §§1–2).
 *
 * The host's `openTabPaths` plus its non-terminal host-owned close operations
 * are the ONLY live-membership authority. This module projects that state —
 * plus compact existing activity/request-timing/usage projections — into the
 * typed `session.liveMembership` snapshot, and the sync bridge publishes it to
 * the coordinator at startup restoration and after every reducer transition,
 * strictly ordered before later host mutations on the same FIFO transport. No
 * second durable member list exists; closed sessions leave the projection
 * naturally (tab removed, close operation terminal) and are never revived
 * through it.
 */

export interface HostLiveMembershipOptions {
  /** Optional composition-injected analytics working-time authority
   *  (`AggregateStatsService.getWorkingTimeBySession`). Absent entries keep
   *  the projection's unavailability explicit instead of fabricating zeroes. */
  getWorkingTime?(sessionPath: string): WorkingTimeState | undefined;
  /** Canonical/ledger-backed existing cumulative usage authority. Missing and
   *  unknown snapshots remain unavailable; transcript usage is not a fallback. */
  getSessionUsage?(sessionPath: string): StatsSessionUsageSnapshot | undefined;
  /** Existing live run authority, captured once per membership projection. */
  getOpenRuns?(): readonly Pick<RunSnapshot, 'sessionPath' | 'startedAt'>[];
}

/** Full membership snapshot without the bridge-owned monotonic revision. */
export type HostLiveMembershipSnapshot = Omit<HostLiveMembershipSnapshotParams, 'revision'>;

function currentRequestStartedAt(state: ArchState, sessionPath: string): number | undefined {
  for (const operations of [state.pending.promoted, state.pending.ops]) {
    for (const operation of Object.values(operations)) {
      if (operation.sessionPath !== sessionPath || operation.queued) continue;
      return Number.isSafeInteger(operation.startedAt) && operation.startedAt >= 0
        ? operation.startedAt
        : undefined;
    }
  }
  return undefined;
}

function sessionActivity(state: ArchState, sessionPath: string, openRunStartedAt?: number): {
  activity: LiveSessionActivity;
  requestStartedAt?: number;
  runningTools?: number;
  runningSubagents?: number;
} {
  const pendingUiRequests = state.settings.pendingExtensionUIRequestsBySession[sessionPath];
  const waitingForUser = Object.keys(pendingUiRequests ?? {}).length > 0;
  const turn = state.livePipeline.turnsBySession[sessionPath];
  const turnWaitingForInput = turn?.phase === 'waiting_input';
  const requestStartedAt = currentRequestStartedAt(state, sessionPath) ?? openRunStartedAt;
  let runningTools = 0;
  let runningSubagents = 0;
  if (turn) {
    for (const tool of Object.values(state.livePipeline.toolsByExecutionId)) {
      if (tool.turnId !== turn.turnId || tool.executionEnd) continue;
      if (tool.phase !== 'running' && tool.phase !== 'preparing' && tool.phase !== 'retry_wait') continue;
      runningTools += 1;
      if (tool.name.trim().toLowerCase() === 'subagent') runningSubagents += 1;
    }
  }
  const running = state.sessions.runningSessionPaths.includes(sessionPath)
    || runningTools > 0
    || requestStartedAt !== undefined
    || (turn !== undefined && turn.phase !== 'reconciling_gap' && turn.phase !== 'queued');
  const counts = {
    ...(runningTools > 0 ? { runningTools } : {}),
    ...(runningSubagents > 0 ? { runningSubagents } : {}),
  };
  if (waitingForUser || turnWaitingForInput) {
    return {
      activity: 'waiting-user-input',
      ...(requestStartedAt !== undefined ? { requestStartedAt } : {}),
      ...counts,
    };
  }
  if (running) {
    return {
      activity: 'running',
      ...(requestStartedAt !== undefined ? { requestStartedAt } : {}),
      ...counts,
    };
  }
  return { activity: 'idle' };
}

/** Compact cumulative cost/usage projection from the existing StatsService
 *  authority. Missing or not-yet-loaded values remain unavailable. */
function projectSessionUsage(
  sessionPath: string,
  options: HostLiveMembershipOptions,
): LiveSessionUsageSnapshot | undefined {
  const snapshotUsage = options.getSessionUsage?.(sessionPath);
  const workingTime = options.getWorkingTime?.(sessionPath);
  const activeMs = workingTime?.activeSince !== null && workingTime?.activeSince !== undefined
    ? Math.max(0, Date.now() - workingTime.activeSince)
    : 0;
  const accumulatedWorkingTimeMs = workingTime === undefined
    ? undefined
    : workingTime.accumulatedMs + activeMs;
  const workingTimeMs = accumulatedWorkingTimeMs === undefined || !Number.isFinite(accumulatedWorkingTimeMs)
    ? undefined
    : Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(accumulatedWorkingTimeMs)));
  const accountingKnown = snapshotUsage !== undefined && snapshotUsage.authority !== 'unknown';
  let costUsd = 0;
  let hasCost = false;
  let allReported = true;
  if (accountingKnown) {
    for (const sample of snapshotUsage.samples) {
      if (typeof sample.reportedCostUsd === 'number'
        && Number.isFinite(sample.reportedCostUsd) && sample.reportedCostUsd >= 0) {
        costUsd += sample.reportedCostUsd;
        hasCost = true;
        continue;
      }
      if (typeof sample.calculatedCostUsd === 'number'
        && Number.isFinite(sample.calculatedCostUsd) && sample.calculatedCostUsd >= 0) {
        costUsd += sample.calculatedCostUsd;
        hasCost = true;
        allReported = false;
      }
    }
  }
  const roundedCostUsd = Math.round(costUsd * 1e6) / 1e6;
  if (!Number.isFinite(roundedCostUsd)) hasCost = false;
  const freshness = snapshotUsage?.freshness
    ?? (snapshotUsage?.authority === 'unknown' ? 'unknown' : undefined);
  const usage: LiveSessionUsageSnapshot = {
    ...(workingTimeMs !== undefined ? { workingTimeMs } : {}),
    ...(hasCost ? { costUsd: roundedCostUsd } : {}),
    ...(hasCost ? { costProvenance: allReported ? 'reported' as const : 'estimated' as const } : {}),
    ...(accountingKnown && snapshotUsage.unpricedInvocationCount !== undefined
      ? { unpricedInvocations: snapshotUsage.unpricedInvocationCount } : {}),
    ...(accountingKnown && snapshotUsage.incompleteInvocationCount !== undefined
      ? { incompleteInvocations: snapshotUsage.incompleteInvocationCount } : {}),
    ...(freshness !== undefined ? { freshness } : {}),
  };
  const hasAny = usage.workingTimeMs !== undefined
    || usage.costUsd !== undefined
    || usage.unpricedInvocations !== undefined
    || usage.incompleteInvocations !== undefined
    || usage.freshness !== undefined;
  return hasAny ? usage : undefined;
}

/** Project the complete live membership from one reduced host state. Order
 *  follows `openTabPaths` so the coordinator list is host-tab ordered. */
export function projectHostLiveMembership(state: ArchState, options: HostLiveMembershipOptions): HostLiveMembershipSnapshot {
  const closingBySessionPath: Record<string, LiveSessionClosingEntry> = Object.create(null) as Record<string, LiveSessionClosingEntry>;
  for (const operation of Object.values(state.operations)) {
    if (operation.kind !== 'session.close' || operation.terminal) continue;
    const sessionPath = operation.session.resolvedPath ?? operation.session.pendingPath;
    // Pending create/duplicate closes resolve through the typed close bridge
    // immediately; they are not live-session reservations.
    if (operation.closeWaitForCreate === true || isPendingTabPath(sessionPath)) continue;
    closingBySessionPath[sessionPath] = {
      path: sessionPath,
      operationId: operation.operationId,
      ...(operation.closePrivacyMode === true ? { privacyMode: true } : {}),
      ...(operation.source.kind === 'agent-session-control' ? { source: 'agent' as const } : { source: 'host' as const }),
    };
  }
  const openRunStartedAtBySession: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const run of options.getOpenRuns?.() ?? []) {
    const startedAt = Date.parse(run.startedAt);
    if (Number.isFinite(startedAt) && startedAt >= 0) openRunStartedAtBySession[run.sessionPath] = startedAt;
  }
  const sessions: LiveSessionMembershipEntry[] = [];
  for (const sessionPath of state.sessions.openTabPaths) {
    if (isPendingTabPath(sessionPath) || Object.hasOwn(closingBySessionPath, sessionPath)) continue;
    const summary = state.sessions.sessions.find((candidate) => candidate.path === sessionPath);
    const activity = sessionActivity(state, sessionPath, openRunStartedAtBySession[sessionPath]);
    const running = state.sessions.runningSessionPaths.includes(sessionPath);
    const usage = projectSessionUsage(sessionPath, options);
    sessions.push({
      path: sessionPath,
      ...(summary?.name !== undefined ? { name: summary.name } : {}),
      // Assigned titles are supplied by the durable title owner; the
      // provisional label is the `name` until then.
      ...(summary?.isAssignedTitle === true && summary.name ? { title: summary.name } : {}),
      ...(summary?.sessionId !== undefined ? { sessionId: summary.sessionId } : {}),
      cwd: summary?.cwd ?? '',
      ...(summary?.agentCreated === true ? { agentCreated: true } : {}),
      ...(state.sessions.intentionallyHiddenRunningPaths.includes(sessionPath) && running ? { hidden: true } : {}),
      ...(summary?.modelId !== undefined ? { modelId: summary.modelId } : {}),
      ...(summary?.provider !== undefined ? { provider: summary.provider } : {}),
      ...(summary?.thinkingLevel !== undefined ? { thinkingLevel: summary.thinkingLevel } : {}),
      activity: activity.activity,
      ...(activity.runningTools !== undefined ? { runningTools: activity.runningTools } : {}),
      ...(activity.runningSubagents !== undefined ? { runningSubagents: activity.runningSubagents } : {}),
      ...(activity.requestStartedAt !== undefined ? { requestStartedAt: activity.requestStartedAt } : {}),
      ...(usage ? { usage } : {}),
    });
  }
  return {
    timestamp: Date.now(),
    sessions: sessions.slice(0, MAX_LIVE_MEMBERSHIP_SESSIONS),
    closing: Object.values(closingBySessionPath).slice(0, MAX_LIVE_MEMBERSHIP_CLOSING),
  };
}

/** Stable fingerprint of the projection's meaningful content; revision and
 *  wall-clock timestamp deliberately excluded so idempotent dispatches stay
 *  silent. */
export function hostLiveMembershipFingerprint(snapshot: HostLiveMembershipSnapshot): string {
  return JSON.stringify({ sessions: snapshot.sessions, closing: snapshot.closing });
}

/** Ordered host→coordinator sync bridge. Issues one bounded snapshot per
 *  backend generation change or reducer-state change; only the newest issued
 *  snapshot advances the fingerprint after its acknowledgement, so a failed
 *  send is retried by the next reducer transition. Synchronization point of
 *  the close-ingress contract: `afterDispatch` runs synchronously *between*
 *  the reducer transition and its effect handlers, so the coordinator observes
 *  a UI/agent close (and its closing reservation) strictly before any later
 *  host mutation, including the close bridge's own acknowledgement and
 *  stop/interrupt writes. */
export class HostLiveMembershipSync {
  private lastSentFingerprint: string | undefined;
  private lastBackendGeneration: number | undefined;
  private lastIssuedSeq = 0;

  constructor(
    state: ArchState,
    private readonly options: {
      request(params: HostLiveMembershipSnapshotParams): Promise<unknown>;
      getBackendGeneration(): number;
      log?(message: string): void;
    },
    private readonly projectionOptions: HostLiveMembershipOptions = {},
  ) {
    this.lastBackendGeneration = options.getBackendGeneration();
    this.afterDispatch(state);
  }

  /** Host reducer post-transition hook (reducer events already applied). */
  afterDispatch(state: ArchState): void {
    const generation = this.options.getBackendGeneration();
    if (generation !== this.lastBackendGeneration) {
      // New backend transport: membership must be resynced even if the
      // reduced state is unchanged; the coordinator restarted with empty
      // membership authority.
      this.lastBackendGeneration = generation;
      this.lastSentFingerprint = undefined;
    }
    const snapshot = projectHostLiveMembership(state, this.projectionOptions);
    const fingerprint = hostLiveMembershipFingerprint(snapshot);
    if (this.lastSentFingerprint !== undefined && this.lastSentFingerprint === fingerprint) return;
    const issued = ++this.lastIssuedSeq;
    const revision = ++revisionCounter;
    void this.options
      .request({
        revision,
        timestamp: snapshot.timestamp,
        sessions: snapshot.sessions,
        closing: snapshot.closing,
      })
      .then(() => {
        if (issued !== this.lastIssuedSeq) return;
        this.lastSentFingerprint = fingerprint;
      })
      .catch((error) => {
        // The stale fingerprint is kept only if a newer snapshot was not
        // issued meanwhile; either way the next transition recomputes.
        this.options.log?.(
          `host live-membership sync failed; retrying on the next transition: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }
}

let revisionCounter = 0;