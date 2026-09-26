import type { SessionAnalyticsFactors } from '../../contracts/legacy-run-analytics-contracts.js';
import type {
  PersistedSessionRunState,
  RunFinalizationReason,
  RunSnapshot,
  TaskBoundaryIntent,
  TreatmentChangeKind,
} from '../run-analytics/types.js';

/** Mutable in-memory state for one legacy analytics session. */
export interface SessionRunState {
  currentRun: RunSnapshot | null;
  lastRun: RunSnapshot | null;
  nextTaskIntent: TaskBoundaryIntent;
  queuedUnsupportedInputCount: number;
  turnIdsSeenInCurrentRun: Set<string>;
  /** Turn IDs already processed by onAssistantTurnEnded. */
  endedTurnIdsInCurrentRun: Set<string>;
  /** Tool call IDs already processed by onToolStarted. */
  startedToolCallIdsInCurrentRun: Set<string>;
  /** Tool call IDs already processed by onToolFinished. */
  finishedToolCallIdsInCurrentRun: Set<string>;
  /** Start-time attribution by call id, used to reconcile a name first learned at terminal time. */
  toolNamesByCallIdInCurrentRun: Map<string, string>;
  /** Merged, non-overlapping wall-clock tool intervals for critical-path union. */
  toolExecutionIntervalsInCurrentRun: Array<{ startedAt: number; endedAt: number }>;
  busyStartedAt: string | null;
}

/** Construct the empty mutable state used when an analytics session is first observed. */
export function emptySessionRunState(): SessionRunState {
  return {
    currentRun: null,
    lastRun: null,
    nextTaskIntent: null,
    queuedUnsupportedInputCount: 0,
    turnIdsSeenInCurrentRun: new Set<string>(),
    endedTurnIdsInCurrentRun: new Set<string>(),
    startedToolCallIdsInCurrentRun: new Set<string>(),
    finishedToolCallIdsInCurrentRun: new Set<string>(),
    toolNamesByCallIdInCurrentRun: new Map<string, string>(),
    toolExecutionIntervalsInCurrentRun: [],
    busyStartedAt: null,
  };
}

/** Application-owned run-state manager surface consumed by the analytics tracker. */
export interface SessionRunStateManagerPort {
  readonly sessions: Map<string, SessionRunState>;
  restore(checkpointSessions: Record<string, PersistedSessionRunState>): void;
  serializeSessions(): Record<string, PersistedSessionRunState>;
  getOrCreateSessionState(sessionPath: string): SessionRunState;
  getMostRelevantRun(sessionPath: string): RunSnapshot | null;
  createRunSnapshot(sessionPath: string, state: SessionRunState): RunSnapshot;
  finalizeCurrentRun(sessionPath: string, reason: RunFinalizationReason): RunSnapshot | null;
  markTreatmentChanges(run: RunSnapshot, kinds: TreatmentChangeKind[]): void;
  diffAnalyticsFactors(current: SessionAnalyticsFactors, next: SessionAnalyticsFactors): TreatmentChangeKind[];
  closeBusyInterval(state: SessionRunState): boolean;
  syncSessionSummary(sessionPath: string): void;
  persist(snapshotToAppend?: RunSnapshot): void;
  isoNow(): string;
}
