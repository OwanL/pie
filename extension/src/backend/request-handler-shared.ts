import type { ModelInfo, ModelSettings, LazyDetailRef, DetailResult, RequestEnvelope, SessionOpenedPayload, SessionSummary, TranscriptPageDirection, TranscriptPagePayload } from '../shared/protocol';
import type { ProviderGateMetrics } from './provider-gate';
import { CreateOperationLedger } from './create-operation-ledger';
import type { SdkModule, SdkSessionManager } from './sdk';
import type { SessionContext, SessionContextCreationReason } from './server-types';
import { BackendError } from './server-io';
import { toErrorMessage } from '../shared/error-message';
import type { SessionSnapshotTransport } from '../shared/transcript-window';

/**
 * Pure prompt-safety decision used by the backend timer and deterministic
 * tests. Exact-request provider-network activity or a provider-wide circuit
 * pause may defer below the cumulative ceiling; missing evidence fails open
 * to firing so an unobservable pre-commit request cannot hang indefinitely.
 */
export interface PromptSafetyTimerDecision {
  action: 'defer' | 'fire';
  /** Plain-language reason for the `preflight.failed` emission. Empty for a
   *  `defer` (no emission). */
  reason: string;
}

export interface TranscriptPageLoadOptions {
  transport: SessionSnapshotTransport;
  requiredMessageId?: string;
}

export function decidePromptSafetyTimerAction(opts: {
  elapsed: number;
  ceiling: number;
  promptTimeoutMs: number;
  provider?: string;
  metrics?: readonly ProviderGateMetrics[];
  /** Worker-local correlation for this exact active request's network phase. */
  requestProviderPending?: boolean;
}): PromptSafetyTimerDecision {
  const { elapsed, ceiling, promptTimeoutMs, provider, metrics, requestProviderPending } = opts;
  const providerMetric = provider
    ? metrics?.find((m) => m.provider === provider)
    : undefined;
  const providerInProgress = requestProviderPending === true || providerMetric?.paused === true;

  if (providerInProgress && elapsed < ceiling) {
    return { action: 'defer', reason: '' };
  }

  const reason = providerInProgress
    ? `Prompt timed out after ${elapsed}ms (hard ceiling): provider "${provider ?? 'unknown'}" remained ${providerMetric?.paused ? 'paused' : 'network-pending'} without reaching a commit point.`
    : `Prompt timed out after ${promptTimeoutMs}ms without reaching a commit point.`;
  return { action: 'fire', reason };
}

const DEFAULT_SESSION_TRANSITION_WAIT_MS = 30 * 1000;
const DEFAULT_SESSION_TRANSITION_POLL_MS = 10;

export type SessionTransitionWaitOutcome<T> =
  | { status: 'ready'; value: T }
  | { status: 'timed-out'; timeoutMs: number };

export interface SessionTransitionWaitOptions<T> {
  resolveCurrent(): Promise<T>;
  isPending(): boolean;
  timeoutMs?: number;
  pollIntervalMs?: number;
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}

export function formatInterruptWatchdogDuration(watchdogMs: number): string {
  if (watchdogMs < 1000 || watchdogMs % 1000 !== 0) return `${watchdogMs}ms`;
  const seconds = watchdogMs / 1000;
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

export interface BackendRequestHandlerDeps {
  sdkPath: string;
  /** Process generation used to reject stale operation-status reconciliation. */
  backendGeneration?: number;
  agentDir: string;
  startupCwd: string;
  sessionDir?: string;
  sdk: Pick<SdkModule, 'VERSION' | 'SessionManager'>;
  getSessionContext(sessionPath?: string): SessionContext | undefined;
  createSessionContext(
    sessionManager: SdkSessionManager,
    reason: SessionContextCreationReason,
  ): Promise<SessionContext>;
  ensureSessionContext(sessionPath: string): Promise<SessionContext>;
  /** Recycle one session's worker runtime (adapter re-reads config at the
   *  next session start). Resolves false when no hot worker exists, one is
   *  busy/transitioning, or the coordinator has no runtime router — never
   *  throws for the ordinary refusal cases. */
  recycleSessionRuntime?(sessionPath: string, reason: string): Promise<boolean>;
  /** Runtime-free coordinator operations. Production wires these to the one
   * generation-scoped ColdSessionStore and retains its process-local manager
   * handle for the first legacy promotion (or later isolated worker transfer). */
  createColdSession?(cwd?: string): { sessionPath: string };
  duplicateColdSession?(sessionPath: string): { sessionPath: string };
  truncateColdSessionAfter?(sessionPath: string, entryId: string): Promise<{ sessionPath: string }>;
  isSessionTransitionPending?(sessionPath: string): boolean;
  /** Synchronous generation/ownership fence checked immediately before a
   * session mutation enters the SDK. Isolated workers use this to reject a
   * context revoked while an async transition wait was settling. */
  isSessionContextCurrent?(sessionPath: string, context: SessionContext): boolean;
  /** Bounded transition-wait scheduler. Injectable only to make timeout/race
   * boundaries deterministic at the request-handler seam. */
  sessionTransitionWait?: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  };
  /** Register a per-path authoritative replacement before any async mutation. */
  transitionSessionContext?(
    sessionPath: string,
    transition: () => Promise<SessionContext>,
  ): Promise<SessionContext>;
  /** Capture predecessor identity without publishing a new viewed path. The
   * opaque rollback token restores prior browse state when the open fails. */
  prepareViewedSessionPath?(sessionPath: string): unknown;
  discardPreparedViewedSessionPath?(sessionPath: string, rollbackToken?: unknown): void;
  /** Commit a prepared open only if no newer visual selection superseded it. */
  commitPreparedViewedSessionPath?(sessionPath: string, rollbackToken?: unknown): boolean;
  /** Record a host-local visual transition without opening the durable file or
   * materializing execution services. */
  recordViewedSessionTransition?(
    sessionPath: string,
    previousSessionPath: string | null,
  ): boolean;
  /** Fence asynchronous create/duplicate selection commits against a newer
   * session.viewed transition that arrives while cold publication is pending. */
  captureViewedSessionRevision?(): unknown;
  setViewedSessionPathIfCurrent?(sessionPath: string, revision: unknown): boolean;
  setViewedSessionPath(sessionPath: string | undefined): void;
  buildSessionOpenedPayload(
    sessionPath: string,
    selectionToken?: string,
    transcript?: import('../shared/protocol').TranscriptMode,
    transport?: SessionSnapshotTransport,
    operationId?: string,
    operationAttempt?: number,
    systemPromptDisabledEntries?: readonly string[],
  ): Promise<SessionOpenedPayload>;
  /** Build from the replacement installed by the transition currently owning
   * this path; bypasses joining that transition's own promise. */
  buildTransitionSessionOpenedPayload?(sessionPath: string): Promise<SessionOpenedPayload>;
  /** Generation/process-scoped create-operation ledger (§6.3) deduplicating
   *  concurrent/retried `session.create`/`session.duplicate` by the optional
   *  host-generated `operationId`. Optional so existing callers/tests that do
   *  not wire one keep working: when absent the handler falls back to a ledger
   *  scoped to this deps object (two deps configurations never share an
   *  operation ledger). */
  createOperationLedger?: CreateOperationLedger;
  /** Apply a complete disabled-entry set for a session: persist to the sidecar,
   *  rewrite the SDK base prompt, and re-emit `session.opened`. */
  applySystemPromptToggles(
    sessionPath: string,
    disabledEntries: readonly string[],
  ): Promise<void>;
  /** Persist canonical Pi model/reasoning change entries while the session is
   * cold. Production wires this to the coordinator-owned ColdSessionStore;
   * hot sessions continue through their owning runtime above. */
  applyColdSessionModelSettings?(
    sessionPath: string,
    updates: {
      model?: { provider: string; modelId: string };
      thinkingLevel?: ModelSettings['defaultThinkingLevel'];
    },
  ): Promise<void>;
  /** Persist system-prompt toggles for a session with no execution runtime. */
  applyColdSystemPromptToggles?(
    sessionPath: string,
    disabledEntries: readonly string[],
  ): Promise<void>;
  /** Apply autonomous-mode tool exclusion to all live session runtimes. */
  setAutonomousMode(enabled: boolean): void;
  /** Retire a session runtime and delete its transcript/sidecars. */
  forgetSession?(sessionPath: string): Promise<void>;
  loadTranscriptPage(
    sessionPath: string,
    direction: TranscriptPageDirection,
    loadedStart?: number,
    loadedEnd?: number,
    options?: TranscriptPageLoadOptions,
  ): Promise<TranscriptPagePayload>;
  loadDetail?(sessionPath: string, ref: LazyDetailRef): Promise<DetailResult>;
  /** Preserve the backend's non-serialized browse generation stamp when a
   * transport fitter returns a replacement object. */
  transferBrowseResponseOwnership?(source: object, target: object): void;
  emit(event: string, payload?: unknown): void;
  /** Publish host-authoritative open/pinned/running summaries into the
   * coordinator's revisioned worker-sync domain. Optional for standalone
   * request-handler tests and legacy embeddings. */
  syncOpenTabsRegistry?(tabs: unknown[], sourceRevision?: number): Promise<void>;
  emitBusyChanged(
    context: SessionContext,
    busy: boolean,
    capabilities?: import('../shared/protocol').SessionCapabilities,
  ): void;
  emitContextUsageChanged(context: SessionContext): void;
  emitSessionListChanged(): Promise<void>;
  listSessions(): Promise<SessionSummary[]>;
  listAvailableModels(context?: SessionContext): ModelInfo[] | Promise<ModelInfo[]>;
  readModelSettings(): Promise<ModelSettings>;
  writeModelSettings(updates: Partial<ModelSettings>): Promise<ModelSettings>;
  /** Provider-gate metrics for prompt-safety deferral. The production default
   *  reads the in-process gate; injection keeps timeout boundaries
   *  deterministic. Missing metrics fail open so the timer never hangs. */
  getProviderGateMetrics?: () => readonly ProviderGateMetrics[] | undefined;
  /** Resolve the in-flight request's provider for prompt-safety deferral. The
   *  production default uses the active session model. Missing resolution
   *  fails open so the timer never hangs. */
  resolveSessionProvider?: (context: SessionContext) => string | undefined;
  /** Called only after the selected handler has validated its request params. */
  onRequestValidated?: () => void;
  /** The server owns the request completion span when it may retry a browse
   *  operation; dispatch-level phases (`route_selected`, `handler_started`)
   *  are still recorded here at their real moments. */
  suppressRequestTrace?: boolean;
  /** Called after the diagnostics trace enablement toggle has been applied, so
   *  the server can start/stop trace-gated monitors (e.g. the event-loop
   *  monitor) in lockstep with the store. */
  onLivePipelineTraceEnabledChange?: (enabled: boolean) => void;
  /** Monotonic diagnostics-toggle generation reserved at production request
   *  receipt (before any awaited handler work) and bound to this exact
   *  request. Concurrent toggle requests are ordered by receipt, not
   *  settlement; the off transition applies only while this generation is
   *  still the latest requested one. Absent for standalone callers, which
   *  apply the off immediately after the handler settles. */
  livePipelineTraceToggleGeneration?: number;
  /** Production may defer an off transition until its request's completion
   *  record has been emitted. The request id is mandatory so concurrent
   *  requests and retries cannot consume one another's pending transition.
   *  The generation is the one reserved at request receipt for this exact
   *  request; the off applies only while it is still the latest requested
   *  generation. The apply callback is invoked exactly once at that
   *  completion boundary, after the trace store has been disabled. */
  deferLivePipelineTraceDisable?: (requestId: string, generation: number, onApplied?: () => void) => boolean;
}

/** Per-dependency fallback ledger. The façade installs this on each spread
 * handler dependency object so retries retain one process-local idempotency
 * authority instead of accidentally receiving a fresh ledger per request. */
const fallbackCreateOperationLedgers = new WeakMap<BackendRequestHandlerDeps, CreateOperationLedger>();

export function getCreateOperationLedger(deps: BackendRequestHandlerDeps): CreateOperationLedger {
  const wired = deps.createOperationLedger;
  if (wired) return wired;
  let fallback = fallbackCreateOperationLedgers.get(deps);
  if (!fallback) {
    fallback = new CreateOperationLedger();
    fallbackCreateOperationLedgers.set(deps, fallback);
  }
  return fallback;
}

export function markRequestValidated(deps: BackendRequestHandlerDeps): void {
  deps.onRequestValidated?.();
}

/** Join the currently visible runtime owner without relying on an unbounded
 * resolved-promise loop. The deadline also bounds a stuck
 * `ensureSessionContext`; poll wake-ups yield to timers so a synchronously
 * resolving stale owner cannot starve the deadline. */
export async function waitForSessionTransition<T>(
  options: SessionTransitionWaitOptions<T>,
): Promise<SessionTransitionWaitOutcome<T>> {
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_SESSION_TRANSITION_WAIT_MS;
  const pollIntervalMs = options.pollIntervalMs && options.pollIntervalMs > 0
    ? options.pollIntervalMs
    : DEFAULT_SESSION_TRANSITION_POLL_MS;
  const schedule = options.setTimeout ?? setTimeout;
  const cancel = options.clearTimeout ?? clearTimeout;
  const timedOut: SessionTransitionWaitOutcome<T> = { status: 'timed-out', timeoutMs };
  let expired = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let wakePoll: (() => void) | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<SessionTransitionWaitOutcome<T>>((resolve) => {
    deadlineTimer = schedule(() => {
      expired = true;
      if (pollTimer !== undefined) cancel(pollTimer);
      pollTimer = undefined;
      wakePoll?.();
      wakePoll = undefined;
      resolve(timedOut);
    }, timeoutMs);
  });

  const transition = (async (): Promise<SessionTransitionWaitOutcome<T>> => {
    let value = await options.resolveCurrent();
    while (!expired && options.isPending()) {
      await new Promise<void>((resolve) => {
        wakePoll = resolve;
        pollTimer = schedule(resolve, pollIntervalMs);
      });
      pollTimer = undefined;
      wakePoll = undefined;
      if (expired) return timedOut;
      value = await options.resolveCurrent();
    }
    return expired ? timedOut : { status: 'ready', value };
  })();

  try {
    return await Promise.race([transition, deadline]);
  } finally {
    if (deadlineTimer !== undefined) cancel(deadlineTimer);
    if (pollTimer !== undefined) cancel(pollTimer);
  }
}

export async function requireSessionTransition(
  deps: BackendRequestHandlerDeps,
  sessionPath: string,
): Promise<SessionContext> {
  const configured = deps.sessionTransitionWait;
  const outcome = await waitForSessionTransition({
    resolveCurrent: async () => {
      let context = await deps.ensureSessionContext(sessionPath);
      // Semantic-recovery ownership lives on the retiring context until its
      // replacement is authoritative. Join it inside the same bounded wait as
      // coordinator/worker transitions instead of awaiting recoveryPromise at
      // individual mutation sites without a deadline.
      const joinedRecoveries = new Set<Promise<SessionContext>>();
      while (context.recoveryPromise) {
        const recovery = context.recoveryPromise;
        if (joinedRecoveries.has(recovery)) {
          throw new BackendError(
            'SESSION_RUNTIME_RECOVERY_FAILED',
            'The session runtime recovery did not publish a replacement owner.',
          );
        }
        joinedRecoveries.add(recovery);
        try {
          context = await recovery;
        } catch (error) {
          throw new BackendError(
            'SESSION_RUNTIME_RECOVERY_FAILED',
            `The session runtime could not be replaced: ${toErrorMessage(error)}`,
          );
        }
      }
      if (context.retired) {
        throw new BackendError(
          'SESSION_RUNTIME_RECOVERY_FAILED',
          'The previous session runtime was retired before a replacement became available.',
        );
      }
      return context;
    },
    isPending: () => deps.isSessionTransitionPending?.(sessionPath) === true,
    ...configured,
  });
  if (outcome.status === 'ready') return outcome.value;
  throw new BackendError(
    'SESSION_TRANSITION_TIMEOUT',
    `The session runtime transition did not settle within ${formatInterruptWatchdogDuration(outcome.timeoutMs)}.`,
  );
}

export function assertCurrentSessionMutationOwner(
  deps: BackendRequestHandlerDeps,
  sessionPath: string,
  context: SessionContext,
): void {
  if (context.retired || context.recoveryPromise
    || deps.isSessionContextCurrent?.(sessionPath, context) === false) {
    throw new BackendError(
      'SESSION_RUNTIME_RECOVERY_FAILED',
      'The session runtime owner changed before the mutation could start.',
    );
  }
}

export type RequestHandler = (deps: BackendRequestHandlerDeps, request: RequestEnvelope) => Promise<unknown>;
