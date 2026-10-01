import type { RendererCommandContext } from '../../lib/protocol/index.js';

/** State-changing actions owned by the common reducer registry. */
export type SessionOperationKind =
  | 'session.create'
  | 'session.duplicate'
  | 'session.open'
  | 'session.close'
  | 'backend.restart'
  | 'message.send'
  | 'message.edit'
  | 'message.interrupt'
  | 'message.continue'
  | 'message.compact';

/** Trusted initiating source. Callback-bearing renderer transport context is
 * reduced to serializable identity before it enters reducer-owned state. */
export type SessionOperationSource =
  | { kind: 'host' }
  | { kind: 'agent-session-control' }
  | {
      kind: 'renderer';
      rendererId: string;
      rendererKind: RendererCommandContext['kind'];
      rendererGeneration: number;
    };

export type SessionOperationPhase =
  | 'awaiting-acceptance'
  | 'draining'
  | 'awaiting-old-generation-death'
  | 'awaiting-commit'
  | 'ambiguous'
  | 'settled';
export type SessionOperationAcceptance = 'pending' | 'ambiguous' | 'accepted' | 'rejected';
export type SessionOperationCommit = 'pending' | 'unknown' | 'committed' | 'not-committed';
export type SessionOperationRecovery = 'retry' | 'restart-backend' | 'reconcile' | 'none';
export type SessionOperationTerminalOutcome = 'settled' | 'cancelled' | 'superseded' | 'failed';
export type SessionOperationTerminalReason =
  | 'durable-commit-observed'
  | 'definitive-rejection'
  | 'backend-generation-ended'
  | 'queue-cleared'
  | 'interrupted-before-commit'
  | 'superseded-before-commit'
  | 'execution-failed';

export interface SessionOperationTerminal {
  outcome: SessionOperationTerminalOutcome;
  reason: SessionOperationTerminalReason;
  recovery: SessionOperationRecovery;
  /** Diagnostic detail retained in host state; capability projection omits it. */
  detail?: string;
}

/** Reducer-owned semantic lifecycle record. It is deliberately common rather
 * than create-specific so later mutation slices can join the same registry. */
export interface SessionOperation {
  operationId: string;
  kind: SessionOperationKind;
  source: SessionOperationSource;
  session: {
    /** Host-only identity used until the backend assigns a durable path. */
    pendingPath: string;
    /** Durable source identity for session.duplicate. */
    sourcePath?: string;
    /** Durable identity learned at the create commit boundary. */
    resolvedPath?: string;
    /** Stable header identity, when the host has already hydrated it. */
    sessionId?: string;
    /** Current durable branch leaf, when the host has already hydrated it. */
    branchId?: string;
  };
  causal: {
    parentOperationId: string | null;
    selectionToken: string;
  };
  /** Backend process generation which owns idempotency for this operation. */
  backendGeneration: number;
  /** Worker process generation when the host has current correlated evidence. */
  workerGeneration?: number;
  /** Replacement generation committed by backend.restart. */
  replacementBackendGeneration?: number;
  /** Monotonic local acknowledgement attempt; operationId remains stable. */
  attempt: number;
  phase: SessionOperationPhase;
  acceptance: SessionOperationAcceptance;
  commit: SessionOperationCommit;
  /** Recovery while non-terminal. Terminal recovery is owned by terminal. */
  recovery: Exclude<SessionOperationRecovery, 'none'> | null;
  /** Set once. Every subsequent terminal observation is an idempotent no-op. */
  terminal?: SessionOperationTerminal;
  /** Closing a delayed placeholder hides presentation but not the operation. */
  hidden?: boolean;
  /** Create intent retained for stable retries and identity validation. */
  cwd?: string;
  /** Optimistic user-row identity for message.send; distinct from operationId. */
  localId?: string;
  /** Canonical host mutation intent; used only to reject changed-ID reuse. */
  intentFingerprint?: string;
  /** Delivery state is independent per send, including queued follow-ups. */
  delivery?: 'pending' | 'direct' | 'queued';
  /** Successful interrupt completion barrier. While set, uncorrelated late
   * lifecycle events from the retired turn cannot resurrect session activity.
   * The next genuine execution command for this session clears the fence. */
  retiredEventFence?: boolean;
  /** Reducer-owned acknowledgement barrier for compound host lifecycle work.
   * Private close distinguishes the initial marker-retaining tab write from
   * the final privacy-marker-removal write. */
  acknowledgements?: Record<string, 'pending' | 'succeeded' | 'failed'>;
  /** Failure detail retained until the complete acknowledgement barrier settles. */
  acknowledgementErrors?: Record<string, string>;
  /** Close semantics are fixed at ingress so late results cannot reclassify cleanup. */
  closeMode?: 'idle-cleanup' | 'private-cleanup' | 'stop-cleanup';
  /** Typed agent close bridge correlation carried into terminal ack effects. */
  closeRequestKey?: string;
  /** Self-close only: stop/cleanup waits until the caller's closeRequested
   *  response has been delivered. */
  closeSelfHandoffRequired?: boolean;
  /** A close can defer cleanup until a pending create resolves to a durable path. */
  closeWaitForCreate?: boolean;
  /** Private deletion intent, including private sessions that must stop first. */
  closePrivacyMode?: boolean;
  /** Irreversible private deletion committed before a later cleanup failure. */
  closeDeletionCommitted?: boolean;
  /** The pending create/duplicate operation whose late result must be cleaned up. */
  closeOperationId?: string;
  /** Reducer-owned barrier-release marker: the deferred close lifecycle effect
   *  was dispatched after its prerequisites succeeded. */
  closeCleanupDispatched?: boolean;
  /** The close-owned stop is held only until a self-close result is handed back
   *  to its agent worker; foreign agent and UI closes stop immediately. */
  closeStopDispatched?: boolean;
  closeStopAbortSendCorrIds?: string[];
  closeStopCancelQueuedOperationIds?: string[];
  closeStopUsePriorityLane?: boolean;
  /** The message.interrupt operation whose settlement releases the deferred
   *  stop-cleanup lifecycle effect. */
  closeStopOperationId?: string;
  /** Next-tab selection captured at close ingress for the deferred cleanup. */
  closeNextPath?: string | null;
  /** Whether the close changed visual selection (deferred cleanup detail). */
  closeSelectionChanged?: boolean;
  /** Reducer-owned bounded read-only reconciliation progress. EffectRunner
   * retains only the timer/promise resource for the described attempt. */
  reconciliation?: {
    attempts: number;
    maxAttempts: number;
    lastError?: string;
  };
  /** Prevent duplicate compact terminal events from re-applying UI outcome. */
  terminalEvidenceApplied?: boolean;
}

export function operationSourceFromRenderer(
  source: RendererCommandContext | undefined,
): SessionOperationSource {
  if (!source) return { kind: 'host' };
  return {
    kind: 'renderer',
    rendererId: source.rendererId,
    rendererKind: source.kind,
    rendererGeneration: source.rendererGeneration,
  };
}
