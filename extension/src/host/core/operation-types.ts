import type { RendererCommandContext } from '../../shared/protocol.js';

/** State-changing actions owned by the common reducer registry. */
export type SessionOperationKind =
  | 'session.create'
  | 'session.duplicate'
  | 'message.send'
  | 'message.edit'
  | 'message.interrupt'
  | 'message.continue'
  | 'message.compact';

/** Trusted initiating source. Callback-bearing renderer transport context is
 * reduced to serializable identity before it enters reducer-owned state. */
export type SessionOperationSource =
  | { kind: 'host' }
  | {
      kind: 'renderer';
      rendererId: string;
      rendererKind: RendererCommandContext['kind'];
      rendererGeneration: number;
    };

export type SessionOperationPhase = 'awaiting-acceptance' | 'awaiting-commit' | 'ambiguous' | 'settled';
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
  };
  causal: {
    parentOperationId: string | null;
    selectionToken: string;
  };
  /** Backend process generation which owns idempotency for this operation. */
  backendGeneration: number;
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
