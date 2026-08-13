import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { EXTENSION_TOGGLES_ENV, HISTORY_COMPACTION_ENV, NESTED_ALLOWED_BUCKETS_ENV, PROVIDER_TOGGLES_ENV, PROTOCOL_VERSION, SUBAGENT_BUCKETS_ENV, SUBAGENT_PROVIDER_DEFAULTS_ENV, SUBAGENT_PROVIDER_TOGGLES_ENV, SUBAGENT_ROUTE_AROUND_SATURATED_PROVIDERS_ENV, SUBAGENT_FALLBACK_ON_PROVIDER_FAILURE_ENV, type CustomMessagePayload, type DetailResult, type ErrorPayload, type LazyDetailRef, type MessageAbortedPayload, type ModelInfo, type ModelSettings, type PreflightFailedPayload, type RequestEnvelope, type SessionOpenedPayload, type SessionSummary, type TranscriptPageDirection, type TranscriptPagePayload } from '../shared/protocol';
import { AUTONOMOUS_MODE_ENV } from '../../../shared/autonomous-mode.js';
import { toErrorMessage } from '../shared/error-message';
import { LIVE_PIPELINE_LIMITS, LIVE_PIPELINE_PROTOCOL_VERSION } from '../shared/live-pipeline-protocol';
import { enrichConnectionError } from '../shared/error-message';
import {
  validateLiveTurnCheckpoint,
  validateLoadTranscriptPage,
  validateMessageSend,
  validateMessageReplaceQueue,
  validateRuntimePrefsSet,
  validateSessionCreate,
  validateSessionDuplicate,
  validateSessionOpen,
  validateSessionPath,
  validateSessionViewed,
  validateSettingsSet,
  validateSystemPromptTogglesSet,
  validateTruncateAfter,
  validateExtensionUiResponse,
  validateOpenTabsSet,
} from './rpc';
import { ProviderGate, type ProviderGateMetrics } from './provider-gate';
import { resolveActiveModel } from './session-metadata';
import type { SdkModule, SdkSessionManager } from './sdk';
import { buildPromptText, lowerImageInputs, normalizeThinkingLevel } from './message-inputs';
import type { SessionContext, SessionContextCreationReason } from './server-types';
import { BackendLiveTurnAccumulator } from './live-turn-accumulator';
import { BackendError } from './server-io';
import {
  boundTranscriptSnapshot,
  type SessionSnapshotTransport,
} from '../shared/transcript-window';
import {
  getBackendLivePipelineTraceHealth,
  recordBackendLivePipelineTrace,
  setBackendLivePipelineTraceEnabled,
} from './live-pipeline-trace-runtime';

/**
 * Backend safety-net timeout for the PRE-COMMIT phase of a `message.send`.
 * `message.send` early-acks and fire-and-forgets the prompt promise (see
 * `handleMessageSend`); without a bound, a prompt that never reaches a commit
 * point (first `message_start`) nor rejects would leave `activeRequest` set
 * forever, blocking all future sends with `REQUEST_IN_PROGRESS`. On fire it
 * aborts the session and emits `preflight.failed` (a post-ack, pre-commit
 * failure) so the host reverts via `pending.promoted`. The SDK `prompt()` does
 * not accept an `AbortSignal`, so the abort is effected via `session.abort()`.
 *
 * SCOPE (critical): this timer is cleared at the commit point — the first
 * `message_start` for this request, handled in `session-event-handler.ts` —
 * NOT only on `session.prompt()` settle. A multi-turn agentic run keeps
 * `session.prompt()` pending across all internal turns until the whole run
 * completes; clearing only on `.finally` would make this a whole-run ceiling
 * that aborts any healthy run exceeding the budget mid-stream. Clearing at the
 * commit point confines the guard to the prepass + first-token window, which
 * is the only phase that can hang without observable SDK events. Distinct from
 * the host-side send-timer (prepass phase) and any streaming watchdog, which
 * own their own windows.
 *
 * METRIC-GATED DEFERRAL: the timer's clock starts at prompt dispatch, BEFORE
 * the request acquires its ProviderGate concurrency slot. When the provider is
 * saturated (`queuedRequests > 0`) or circuit-broken (`paused`), a fire is a
 * FALSE POSITIVE — the turn is legitimately QUEUED, not hung. On fire the
 * handler checks `ProviderGate.getMetrics()` for this request's provider and
 * re-arms the timer (defer) instead of aborting, bounded by
 * `PROMPT_TIMEOUT_HARD_CEILING_MS` (a genuinely-stuck backstop). FAIL-OPEN: if
 * the gate is absent, the provider can't be resolved, or no metric matches, it
 * aborts as before (never hang on a missing gate).
 */
const PROMPT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — tunable

/**
 * Hard ceiling on the CUMULATIVE wall time the pre-commit safety net may
 * defer (across re-arms). Once exceeded the timer aborts even if the provider
 * is still saturated/paused — a genuinely-stuck backstop so a queued turn can
 * never hang forever. 2× the single window: one normal `PROMPT_TIMEOUT_MS`
 * budget plus one deferred window to ride out a transient saturation/pause.
 */
const PROMPT_TIMEOUT_HARD_CEILING_MS = 2 * PROMPT_TIMEOUT_MS; // 20 minutes — tunable

/** The prompt-safety-timer's defer-vs-fire decision for the metric-gated
 *  deferral (FP-C2b). Pure (no I/O, no `Date.now`, no randomness) so it can be
 *  unit-tested directly and called from the backend without violating purity
 *  concerns. Extracted from `onPromptSafetyTimerFire` so the defer branch is
 *  testable without driving the raw `setTimeout` + `session.prompt()`.
 *
 *  - `defer`: the in-flight request's provider is legitimately QUEUED
 *    (`queuedRequests > 0`) or PAUSED (circuit breaker) AND the cumulative
 *    elapsed is under the hard ceiling — a fire now would be a FALSE POSITIVE
 *    (the turn is queued, not hung). Re-arm instead.
 *  - `fire`: genuinely stuck, ceiling exceeded, or fail-open (absent
 *    metrics/provider, or a free slot — not a queue wait). Carries the
 *    plain-language `reason` for the `preflight.failed` emission.
 *
 *  FAIL-OPEN: `provider` undefined, `metrics` undefined, no matching provider
 *  metric, or a non-queued/non-paused provider all yield `fire` (never hang on
 *  a missing gate). Mirrors `EffectRunner.shouldReArmModelStartTimer` (FP-C2a)
 *  but for the backend's pre-commit safety net. */
export interface PromptSafetyTimerDecision {
  action: 'defer' | 'fire';
  /** Plain-language reason for the `preflight.failed` emission. Empty for a
   *  `defer` (no emission). */
  reason: string;
}

export function decidePromptSafetyTimerAction(opts: {
  elapsed: number;
  ceiling: number;
  promptTimeoutMs: number;
  provider?: string;
  metrics?: readonly ProviderGateMetrics[];
}): PromptSafetyTimerDecision {
  const { elapsed, ceiling, promptTimeoutMs, provider, metrics } = opts;
  // Fail-open chain: `providerMetric` is undefined when the gate is absent,
  // the provider can't be resolved, or the provider is ungated (no metric) —
  // in every such case `saturated` is falsy and we fall through to fire.
  const providerMetric = provider
    ? metrics?.find((m) => m.provider === provider)
    : undefined;
  const saturated = !!providerMetric
    && (providerMetric.queuedRequests > 0 || providerMetric.paused);

  if (saturated && elapsed < ceiling) {
    return { action: 'defer', reason: '' };
  }

  const reason = saturated
    ? `Prompt timed out after ${elapsed}ms (hard ceiling): provider "${provider ?? 'unknown'}" remained ${providerMetric?.paused ? 'paused' : 'saturated'} without reaching a commit point.`
    : `Prompt timed out after ${promptTimeoutMs}ms without reaching a commit point.`;
  return { action: 'fire', reason };
}

/** Environment key for the interrupt-abort watchdog. */
const INTERRUPT_ABORT_WATCHDOG_ENV = 'PIE_INTERRUPT_ABORT_WATCHDOG_MS';
/** Default interrupt-abort watchdog window. If `session.abort()` invoked by
 *  `message.interrupt` does not settle within this window, `activeRequest` is
 *  force-cleared so the session is not permanently blocked from sending or
 *  live-switching models (Bug 4). The healthy-abort path (settles promptly) is
 *  untouched — this only bounds the never-settles window. */
const DEFAULT_INTERRUPT_ABORT_WATCHDOG_MS = 30 * 1000;
export function formatInterruptWatchdogDuration(watchdogMs: number): string {
  if (watchdogMs < 1000 || watchdogMs % 1000 !== 0) return `${watchdogMs}ms`;
  const seconds = watchdogMs / 1000;
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}
function resolveInterruptAbortWatchdogMs(): number {
  const raw = process.env[INTERRUPT_ABORT_WATCHDOG_ENV];
  if (raw === undefined || raw === '') return DEFAULT_INTERRUPT_ABORT_WATCHDOG_MS;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_INTERRUPT_ABORT_WATCHDOG_MS;
}

export interface BackendRequestHandlerDeps {
  sdkPath: string;
  agentDir: string;
  startupCwd: string;
  sessionDir?: string;
  sdk: SdkModule;
  getSessionContext(sessionPath?: string): SessionContext | undefined;
  createSessionContext(
    sessionManager: SdkSessionManager,
    reason: SessionContextCreationReason,
  ): Promise<SessionContext>;
  ensureSessionContext(sessionPath: string): Promise<SessionContext>;
  isSessionTransitionPending?(sessionPath: string): boolean;
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
   * session.viewed transition that arrives while runtime creation is pending. */
  captureViewedSessionRevision?(): unknown;
  setViewedSessionPathIfCurrent?(sessionPath: string, revision: unknown): boolean;
  setViewedSessionPath(sessionPath: string | undefined): void;
  buildSessionOpenedPayload(
    sessionPath: string,
    selectionToken?: string,
    transcript?: import('../shared/protocol').TranscriptMode,
    transport?: SessionSnapshotTransport,
  ): Promise<SessionOpenedPayload>;
  /** Build from the replacement installed by the transition currently owning
   * this path; bypasses joining that transition's own promise. */
  buildTransitionSessionOpenedPayload?(sessionPath: string): Promise<SessionOpenedPayload>;
  /** Apply a complete disabled-entry set for a session: persist to the sidecar,
   *  rewrite the SDK base prompt, and re-emit `session.opened`. */
  applySystemPromptToggles(
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
  ): Promise<TranscriptPagePayload>;
  loadDetail?(sessionPath: string, ref: LazyDetailRef): Promise<DetailResult>;
  /** Preserve the backend's non-serialized browse generation stamp when a
   * transport fitter returns a replacement object. */
  transferBrowseResponseOwnership?(source: object, target: object): void;
  emit(event: string, payload?: unknown): void;
  emitBusyChanged(context: SessionContext, busy: boolean): void;
  emitContextUsageChanged(context: SessionContext): void;
  emitSessionListChanged(): Promise<void>;
  listSessions(): Promise<SessionSummary[]>;
  listAvailableModels(context?: SessionContext): ModelInfo[] | Promise<ModelInfo[]>;
  readModelSettings(): Promise<ModelSettings>;
  writeModelSettings(updates: Partial<ModelSettings>): Promise<ModelSettings>;
  /** FP-C2b: provider-gate metrics accessor for the prompt-safety-timer defer
   *  branch. Defaults to `ProviderGate.getInstance()?.getMetrics()` so
   *  production behavior is unchanged. Injectable so the defer branch can be
   *  unit-tested without singleton/private-internals coupling (mirrors
   *  FP-C2a's `EffectRunnerDeps.getProviderGateMetrics`). Optional +
   *  fail-open: when absent the timer fires as before (never hangs). */
  getProviderGateMetrics?: () => readonly ProviderGateMetrics[] | undefined;
  /** FP-C2b: resolve the in-flight request's provider name for the
   *  prompt-safety-timer defer branch. Defaults to
   *  `resolveActiveModel(context).provider`. Injectable for unit tests
   *  (mirrors FP-C2a's `EffectRunnerDeps.resolveSessionProvider`). Optional +
   *  fail-open: when absent the provider is unresolved → the timer fires. */
  resolveSessionProvider?: (context: SessionContext) => string | undefined;
}

type RequestHandler = (deps: BackendRequestHandlerDeps, request: RequestEnvelope) => Promise<unknown>;

function unknownMethodResponse(method: string): never {
  throw new BackendError('UNKNOWN_METHOD', `Unknown method: ${method}`);
}

async function handleAppPing(
  deps: BackendRequestHandlerDeps,
  _request: RequestEnvelope,
): Promise<unknown> {
  return {
    sdkPath: deps.sdkPath,
    agentDir: deps.agentDir,
    sdkVersion: deps.sdk.VERSION,
    protocolVersion: PROTOCOL_VERSION,
  };
}

async function handleRuntimePrefsSet(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateRuntimePrefsSet(request.params);
  process.env[PROVIDER_TOGGLES_ENV] = JSON.stringify(params.providerToggles);
  if (params.subagentProviderDefaults !== undefined) {
    process.env[SUBAGENT_PROVIDER_DEFAULTS_ENV] = JSON.stringify(params.subagentProviderDefaults);
  }
  if (params.subagentProviderTogglesBySession !== undefined) {
    process.env[SUBAGENT_PROVIDER_TOGGLES_ENV] = JSON.stringify(params.subagentProviderTogglesBySession);
  }
  process.env[EXTENSION_TOGGLES_ENV] = JSON.stringify(params.extensionToggles);
  if (params.autonomousMode !== undefined) {
    process.env[AUTONOMOUS_MODE_ENV] = params.autonomousMode ? '1' : '0';
    deps.setAutonomousMode(params.autonomousMode);
  }
  if (params.historyCompaction !== undefined) {
    process.env[HISTORY_COMPACTION_ENV] = JSON.stringify(params.historyCompaction);
  }
  if (params.subagentAlwaysParentModel !== undefined) {
    process.env['PIE_SUBAGENT_ALWAYS_PARENT_MODEL'] = params.subagentAlwaysParentModel ? '1' : '0';
  }
  if (params.subagentRouteAroundSaturatedProviders !== undefined) {
    process.env[SUBAGENT_ROUTE_AROUND_SATURATED_PROVIDERS_ENV] = params.subagentRouteAroundSaturatedProviders ? '1' : '0';
  }
  if (params.subagentFallbackOnProviderFailure !== undefined) {
    process.env[SUBAGENT_FALLBACK_ON_PROVIDER_FAILURE_ENV] = params.subagentFallbackOnProviderFailure ? '1' : '0';
  }
  if (params.subagentMaxDepth !== undefined) {
    process.env['PIE_SUBAGENT_MAX_DEPTH'] = String(params.subagentMaxDepth);
  }
  if (params.subagentMaxTreeSessions !== undefined) {
    process.env['PIE_SUBAGENT_MAX_TREE_SESSIONS'] = String(params.subagentMaxTreeSessions);
  }
  if (params.subagentMaxInflight !== undefined) {
    process.env['PIE_SUBAGENT_MAX_INFLIGHT'] = String(params.subagentMaxInflight);
  }
  if (params.bashWarmPoolSize !== undefined) {
    process.env['PIE_BASH_WARM_POOL'] = String(params.bashWarmPoolSize);
  }
  if (params.bashFastPath !== undefined) {
    process.env['PIE_BASH_FAST_PATH'] = params.bashFastPath ? '1' : '0';
  }
  if (params.bashShellPath !== undefined) {
    process.env['PIE_SHELL'] = params.bashShellPath;
  }
  if (params.bashWarmupTimeoutMs !== undefined) {
    process.env['PIE_BASH_WARMUP_TIMEOUT_MS'] = String(params.bashWarmupTimeoutMs);
  }
  if (params.bashDefaultTimeout !== undefined) {
    process.env['PIE_BASH_DEFAULT_TIMEOUT'] = String(params.bashDefaultTimeout);
  }
  if (params.subagentBuckets !== undefined) {
    process.env[SUBAGENT_BUCKETS_ENV] = JSON.stringify(params.subagentBuckets);
  }
  if (params.subagentNestedAllowedBuckets !== undefined) {
    process.env[NESTED_ALLOWED_BUCKETS_ENV] = JSON.stringify(params.subagentNestedAllowedBuckets);
  }
  if (params.subagentDropTools !== undefined) {
    process.env['PIE_SUBAGENT_DROP_TOOLS_JSON'] = JSON.stringify(params.subagentDropTools);
  }
  // Reconfigure the live ProviderGate with user overrides. The gate merges
  // the overrides onto the models.json base configs and rebuilds the pools
  // in-place — no restart needed. Skipped when no overrides are provided.
  if (params.providerConcurrency !== undefined) {
    const gate = ProviderGate.getInstance();
    if (gate) {
      gate.applyUserOverrides(params.providerConcurrency);
    }
  }
  return params;
}

async function handleSessionList(
  deps: BackendRequestHandlerDeps,
  _request: RequestEnvelope,
): Promise<unknown> {
  return await deps.listSessions();
}

async function handleSessionCreate(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateSessionCreate(request.params);
  const viewedRevision = deps.captureViewedSessionRevision?.();
  const cwd = params.cwd || deps.startupCwd;
  const context = await deps.createSessionContext(
    deps.sdk.SessionManager.create(cwd, deps.sessionDir),
    'new',
  );
  if (deps.setViewedSessionPathIfCurrent && viewedRevision !== undefined) {
    deps.setViewedSessionPathIfCurrent(context.sessionPath, viewedRevision);
  } else {
    deps.setViewedSessionPath(context.sessionPath);
  }
  const createPayload = await deps.buildSessionOpenedPayload(
    context.sessionPath,
    params.selectionToken,
  );
  deps.emit('session.opened', createPayload);
  deps.emitBusyChanged(
    context,
    context.session.isStreaming || !!context.activeRequest || context.session.isCompacting === true,
  );
  void deps.emitSessionListChanged();
  return { ok: true, sessionPath: context.sessionPath };
}

async function handleSessionOpen(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateSessionOpen(request.params);
  // Record browse-time predecessor identity before the viewed path changes.
  // Building a cold payload is deliberately SessionManager-only. The viewed
  // path commits only after the durable read succeeds.
  const viewedPathRollback = deps.prepareViewedSessionPath?.(params.sessionPath);
  let openPayload: SessionOpenedPayload;
  try {
    openPayload = await deps.buildSessionOpenedPayload(
      params.sessionPath,
      params.selectionToken,
      params.transcript,
    );
  } catch (error) {
    deps.discardPreparedViewedSessionPath?.(params.sessionPath, viewedPathRollback);
    throw error;
  }
  if (deps.commitPreparedViewedSessionPath) {
    deps.commitPreparedViewedSessionPath(params.sessionPath, viewedPathRollback);
  } else {
    deps.setViewedSessionPath(params.sessionPath);
  }
  deps.emit('session.opened', openPayload);
  const context = deps.getSessionContext(params.sessionPath);
  if (context) {
    deps.emitBusyChanged(
      context,
      context.session.isStreaming || !!context.activeRequest || context.session.isCompacting === true,
    );
  }
  void deps.emitSessionListChanged();
  // The authoritative snapshot is the session.opened event above. Return only
  // a small acknowledgement instead of duplicating the transcript payload.
  return { ok: true, sessionPath: params.sessionPath };
}

async function handleSessionViewed(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateSessionViewed(request.params);
  if (!deps.recordViewedSessionTransition) {
    throw new BackendError('UNAVAILABLE', 'Viewed-session transition tracking is unavailable.');
  }
  const changed = deps.recordViewedSessionTransition(
    params.sessionPath,
    params.previousSessionPath,
  );
  return { ok: true, sessionPath: params.sessionPath, changed };
}

async function handleSessionDuplicate(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateSessionDuplicate(request.params);
  const viewedRevision = deps.captureViewedSessionRevision?.();
  const sourceContext = deps.getSessionContext(params.sessionPath);
  const sourceCwd = sourceContext?.session.sessionManager.getCwd()
    || deps.sdk.SessionManager.open(params.sessionPath).getCwd()
    || deps.startupCwd;
  const forkedManager = deps.sdk.SessionManager.forkFrom(
    params.sessionPath,
    sourceCwd,
    deps.sessionDir,
  );
  const context = await deps.createSessionContext(forkedManager, 'new');
  if (deps.setViewedSessionPathIfCurrent && viewedRevision !== undefined) {
    deps.setViewedSessionPathIfCurrent(context.sessionPath, viewedRevision);
  } else {
    deps.setViewedSessionPath(context.sessionPath);
  }
  const duplicatePayload = await deps.buildSessionOpenedPayload(
    context.sessionPath,
    params.selectionToken,
  );
  deps.emit('session.opened', duplicatePayload);
  deps.emitBusyChanged(
    context,
    context.session.isStreaming || !!context.activeRequest || context.session.isCompacting === true,
  );
  void deps.emitSessionListChanged();
  return { ok: true, sessionPath: context.sessionPath };
}

async function handleSessionPreload(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateSessionPath('session.preload', request.params);
  return await deps.buildSessionOpenedPayload(
    params.sessionPath,
    undefined,
    'tail',
    { kind: 'response', requestId: request.id },
  );
}

async function handleSessionForget(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateSessionPath('session.forget', request.params);
  if (!deps.forgetSession) throw new BackendError('UNAVAILABLE', 'Session forget is unavailable.');
  await deps.forgetSession(params.sessionPath);
  await deps.emitSessionListChanged();
  return { sessionPath: params.sessionPath, forgotten: true };
}

async function handleSessionLoadTranscriptPage(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateLoadTranscriptPage(request.params);
  const page = await deps.loadTranscriptPage(
    params.sessionPath,
    params.direction,
    params.loadedStart,
    params.loadedEnd,
  );
  const active = deps.getSessionContext(params.sessionPath)?.activeRequest;
  const bounded = boundTranscriptSnapshot(page, {
    transport: { kind: 'response', requestId: request.id },
    requestedEdge: params.direction === 'older' ? 'older' : 'newer',
    requiredMessageId: active?.currentMessageId ?? active?.lastAssistantMessageId,
  });
  deps.transferBrowseResponseOwnership?.(page, bounded);
  return bounded;
}

async function handleSessionLoadDetail(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<DetailResult> {
  const params = request.params;
  if (!params || typeof params !== 'object') {
    throw new BackendError('INVALID_PARAMS', 'session.loadDetail requires an object payload.');
  }
  const { sessionPath } = validateSessionPath('session.loadDetail', params);
  const { ref } = params as { ref?: unknown };
  const candidate = ref as Partial<LazyDetailRef> | undefined;
  if (!candidate
    || typeof candidate.key !== 'string' || candidate.key.length === 0
    || candidate.sessionPath !== sessionPath
    || (candidate.kind !== 'tool-result' && candidate.kind !== 'reasoning')
    || candidate.source !== 'durable'
    || typeof candidate.messageId !== 'string'
    || typeof candidate.summary !== 'string'
    || typeof candidate.available !== 'boolean'
    || !Number.isSafeInteger(candidate.sizeBytes) || (candidate.sizeBytes ?? -1) < 0) {
    throw new BackendError('INVALID_PARAMS', 'session.loadDetail requires sessionPath and ref.');
  }
  if (!deps.loadDetail) {
    return { sessionPath, key: (ref as LazyDetailRef).key, status: 'unavailable', message: 'Detail retrieval is unavailable.' };
  }
  return await deps.loadDetail(sessionPath, ref as LazyDetailRef);
}

async function handleSessionTruncateAfter(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateTruncateAfter(request.params);

  const existingCtx = deps.getSessionContext(params.sessionPath);
  if (existingCtx?.activeRequest || existingCtx?.session.isStreaming) {
    throw new BackendError('STREAMING_BUSY', 'Cannot truncate a session that is currently streaming.');
  }

  // Capture the user's chosen model + thinking level BEFORE truncating. The
  // SDK stores model choices as `model_change` entries appended at the session
  // leaf; truncating at an older entry drops every `model_change` that
  // followed, so the reopened session would silently revert to the previous
  // model (and the edit turn would then run on that model — an expensive
  // surprise after a `setModel` the user explicitly made). We re-apply the
  // captured choice to the fresh context below so the model survives a
  // transcript truncation. See STATE_CONTRACT § Optimistic Reconciliation.
  const durableContext = existingCtx ? undefined : deps.sdk.SessionManager.open(params.sessionPath).buildSessionContext?.();
  const previousModelId = existingCtx?.session.model?.id ?? durableContext?.model?.modelId;
  const previousProvider = existingCtx?.session.model?.provider ?? durableContext?.model?.provider;
  const previousThinkingLevel = existingCtx?.session.thinkingLevel ?? durableContext?.thinkingLevel;

  const replace = async (): Promise<SessionContext> => {
    const raw = await fs.readFile(params.sessionPath, 'utf8');
    const keepLines: string[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as { id?: string };
        if (entry.id === params.entryId) break;
        keepLines.push(line);
      } catch {
        // skip malformed lines
      }
    }
    const newContent = keepLines.length > 0 ? keepLines.join('\n') + '\n' : '';
    // Atomically replace the transcript: write to a temp file in the same
    // directory (same filesystem → `fs.rename` is atomic) then rename over the
    // original. A crash mid-write leaves the original intact instead of
    // truncating/corrupting it. UUID suffix keeps the temp name collision-safe
    // under rapid repeated truncation.
    const dir = path.dirname(params.sessionPath);
    const tmpPath = path.join(
      dir,
      `.${path.basename(params.sessionPath)}.${crypto.randomUUID()}.tmp`,
    );
    await fs.writeFile(tmpPath, newContent, 'utf8');
    try {
      await fs.rename(tmpPath, params.sessionPath);
    } catch (renameError) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw renameError;
    }

    const replacement = await deps.createSessionContext(
      deps.sdk.SessionManager.open(params.sessionPath),
      'resume',
    );

    // Re-apply the user's model choice if the truncate dropped its
    // `model_change` entry (the fresh context opened with a different model).
    await reapplyModelAfterTruncate(replacement, previousModelId, previousProvider, previousThinkingLevel);
    // Hydration publication is part of transition ownership. A concurrent
    // runtime action waiting on this path cannot resume and stream before the
    // authoritative post-truncate snapshot is enqueued.
    const payload = await (deps.buildTransitionSessionOpenedPayload?.(replacement.sessionPath)
      ?? deps.buildSessionOpenedPayload(replacement.sessionPath));
    deps.emit('session.opened', payload);
    deps.emitBusyChanged(replacement, false);
    return replacement;
  };

  // Registration is synchronous and happens before the first file await, so a
  // concurrent send joins this replacement rather than promoting a second
  // authoritative runtime from the pre-truncate file.
  const context = deps.transitionSessionContext
    ? await deps.transitionSessionContext(params.sessionPath, replace)
    : await replace();

  void deps.emitSessionListChanged();
  return { ok: true, sessionPath: context.sessionPath };
}

/** Re-apply a model + thinking level captured before a truncate to the freshly
 *  reopened context, so truncating a transcript does not silently revert the
 *  user's model choice (the `model_change` entry is physically dropped when it
 *  sat after the edited message). No-op when the new context already matches,
 *  when there was nothing to restore, or when the session/runtime can't accept
 *  the switch. Best-effort: logs on failure and continues. */
async function reapplyModelAfterTruncate(
  context: SessionContext,
  previousModelId: string | undefined,
  previousProvider: string | undefined,
  previousThinkingLevel: string | undefined,
): Promise<void> {
  if (!previousModelId && !previousThinkingLevel) {
    return;
  }
  const modelChanged = !!previousModelId && (
    context.session.model?.id !== previousModelId
    || (!!previousProvider && context.session.model?.provider !== previousProvider)
  );
  const thinkingChanged = !!previousThinkingLevel && context.session.thinkingLevel !== previousThinkingLevel;
  if (!modelChanged && !thinkingChanged) {
    return;
  }
  try {
    if (modelChanged && previousModelId && typeof context.session.setModel === 'function') {
      const available = context.runtime.services?.modelRegistry?.getAvailable() ?? [];
      const info = available.find((model) => model.id === previousModelId && model.provider === previousProvider)
        ?? (!previousProvider ? available.find((model) => model.id === previousModelId) : undefined);
      if (!info) {
        throw new Error(`Model no longer available in this session: ${previousModelId}`);
      }
      const resolvedModel = context.runtime.services.modelRegistry.find(info.provider, info.id);
      if (!resolvedModel) {
        throw new Error(`Could not resolve model in registry: ${previousModelId}`);
      }
      await context.session.setModel(resolvedModel);
    }
    // `setModel` re-clamps the thinking level to the new model's capabilities,
    // so restore the user's level AFTER the model switch (not before).
    if (thinkingChanged && previousThinkingLevel && typeof context.session.setThinkingLevel === 'function') {
      context.session.setThinkingLevel(previousThinkingLevel);
    }
  } catch (error) {
    // The truncate itself succeeded; only the model re-application failed.
    // Surface a host-side log so this silent revert is debuggable, but do not
    // throw — the alternative (aborting a truncate that already rewrote the
    // session file) would corrupt the session.
    console.warn(`[pie:backend] reapplyModelAfterTruncate failed for ${context.sessionPath}: ${toErrorMessage(error)}`);
  }
}

function clearActiveRequest(
  context: SessionContext,
  requestId: string,
): void {
  if (context.activeRequest?.id === requestId) {
    // Defensive: clear the pre-commit safety-net timer if it is still armed
    // (e.g. interrupt / preflight failure paths). The primary clear is the
    // commit-point clear in `session-event-handler.ts`.
    if (context.activeRequest.promptSafetyTimer) {
      clearTimeout(context.activeRequest.promptSafetyTimer);
      context.activeRequest.promptSafetyTimer = undefined;
    }
    if (context.activeRequest.semanticLeaseTimer) {
      clearTimeout(context.activeRequest.semanticLeaseTimer);
      context.activeRequest.semanticLeaseTimer = undefined;
    }
    if (context.activeRequest.quotaSettlementTimer) {
      clearTimeout(context.activeRequest.quotaSettlementTimer);
      context.activeRequest.quotaSettlementTimer = undefined;
    }
    context.activeRequest.pendingDurableToolTerminals?.clear();
    context.activeRequest = undefined;
  }
}

function reportPromptFailure(
  deps: BackendRequestHandlerDeps,
  context: SessionContext,
  requestId: string,
  error: Error,
): void {
  deps.emit('error', {
    code: 'MESSAGE_SEND_FAILED',
    // Enrich connection-level errors (bare "Connection error.") with the real
    // transport cause; clean 429/5xx with a body pass through unchanged so
    // the upstream reason (e.g. account_suspended) shows.
    message: enrichConnectionError(error),
    requestId,
  } satisfies ErrorPayload);
  clearActiveRequest(context, requestId);
  deps.emitBusyChanged(context, false);
}

/**
 * Post-ack, pre-commit prepass failure: `message.send` has already early-acked
 * (the prompt was queued) but the pruning prepass then failed. Surface it via
 * the dedicated `preflight.failed` backend event so the host dispatches
 * `PreflightFailed` and reverts via `pending.promoted[corrId]` (resolved by
 * `requestId`). Clearing `activeRequest` matches the pre-early-ack failure
 * path: the turn is not proceeding to streaming, so a subsequent send must not
 * be blocked by `REQUEST_IN_PROGRESS`. The host clears its optimistic running
 * state in the `PreflightFailed` reducer handler. See `docs/STATE_CONTRACT.md`
 * § Optimistic Reconciliation "Two failure windows for send".
 */
function emitPreflightFailed(
  deps: BackendRequestHandlerDeps,
  context: SessionContext,
  requestId: string,
  message: string,
): void {
  deps.emit('preflight.failed', {
    requestId,
    sessionPath: context.sessionPath,
    error: message,
  } satisfies PreflightFailedPayload);
  clearActiveRequest(context, requestId);
}

async function handleMessageSend(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateMessageSend(request.params);
  let context = await deps.ensureSessionContext(params.sessionPath);
  // An existing-hot lookup can resolve just before truncate/recovery reserves
  // the path. Rejoin that synchronously visible owner before claiming active
  // work; after this check activeRequest is installed without another await,
  // so a later truncate observes STREAMING_BUSY instead of replacing us.
  while (deps.isSessionTransitionPending?.(params.sessionPath)) {
    context = await deps.ensureSessionContext(params.sessionPath);
  }
  if (context.recoveryPromise) {
    try {
      context = await context.recoveryPromise;
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
  // Steering: if a turn is already running, inject this message into the
  // current turn via the SDK's `steer()` (delivered after in-flight tool calls
  // finish, before the next LLM call). Falls back to `followUp()` (queue for the
  // next fresh turn) on an older SDK that doesn't expose `steer`. No
  // `activeRequest` is created here (this call starts no turn) and no
  // pre-commit safety-net timer is armed (steering has no pruning prepass). We
  // `await` the call so a queuing failure (e.g. the text is an extension
  // command, or a skill/template expansion error) rejects the RPC — the host
  // then reverts its optimistic 'queued' message via the pre-ack
  // `SendResult{ok:false}` path, exactly like a normal send pre-ack failure.
  // The SDK emits `message_start` (role 'user') when the loop injects the
  // queued message; the backend forwards that as `message.queuedDelivered` so
  // the host promotes the message from 'queued' to 'completed'.
  if (context.activeRequest || context.session.isStreaming) {
    if ((context.queuedLocalIds?.length ?? 0) >= LIVE_PIPELINE_LIMITS.queuedMessageCorrelations) {
      throw new BackendError('QUEUE_CAPACITY_EXCEEDED', 'Too many queued follow-up messages. Wait for delivery or clear the queue before sending more.');
    }
    const queuedImages = lowerImageInputs(params.inputs);
    const queuedImagePayload = queuedImages.length > 0 ? queuedImages : undefined;
    const queuedPromptText = buildPromptText(params.text, params.inputs);
    // Register before entering the SDK: steer/followUp may synchronously emit
    // the delivery message_start before its promise settles.
    const deliveryLocalId = params.localId ?? '';
    const queuedLocalIds = context.queuedLocalIds ??= [];
    queuedLocalIds.push(deliveryLocalId);
    try {
      if (context.session.steer) {
        await context.session.steer(queuedPromptText, queuedImagePayload);
      } else {
        await context.session.followUp(queuedPromptText, queuedImagePayload);
      }
    } catch (error) {
      // Remove only our still-pending slot. If synchronous delivery already
      // consumed it, there is no stale correlation to remove.
      const index = queuedLocalIds.indexOf(deliveryLocalId);
      if (index >= 0) queuedLocalIds.splice(index, 1);
      throw error;
    }
    return { queued: true };
  }

  const requestId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const canonicalMessageId = `${requestId}:1`;
  const modelId = context.session.model?.id;
  const provider = context.session.model?.provider;
  const thinkingLevel = normalizeThinkingLevel(context.session.thinkingLevel);
  context.activeRequest = {
    id: requestId,
    messageIndex: 0,
    liveTurnAccumulator: new BackendLiveTurnAccumulator({
      protocolVersion: LIVE_PIPELINE_PROTOCOL_VERSION,
      sessionPath: context.sessionPath,
      requestId,
      turnId,
      attemptId,
      canonicalMessageId,
      modelId,
      thinkingLevel,
      startedAt: Date.now(),
    }),
    modelId,
    provider,
    thinkingLevel,
    // The first turn has no preceding tool call, so its latency window opens at
    // prompt-send. Subsequent turns overwrite this on `tool_execution_end`.
    turnBoundaryAt: Date.now(),
    aborted: false,
  };

  const images = lowerImageInputs(params.inputs);
  const imagePayload = images.length > 0 ? images : undefined;
  const promptText = buildPromptText(params.text, params.inputs);

  // Early ack: resolve {requestId} as soon as the prompt is QUEUED (before the
  // pruning prepass), so a slow prepass can no longer time out `message.send`.
  // The prepass runs concurrently inside `session.prompt()`; its outcome is
  // surfaced post-ack via the `preflightResult` callback:
  //  - success → the turn proceeds to streaming (commit point = first
  //    `MessageStarted` for the requestId, handled host-side).
  //  - failure → emit `preflight.failed` so the host dispatches `PreflightFailed`
  //    and reverts via `pending.promoted` (STATE_CONTRACT § Optimistic
  //    Reconciliation "Two failure windows for send").
  // `preflightFailed` makes the failure emission one-shot so `preflightResult`,
  // the `PROMPT_TIMEOUT_MS` safety net, and a concurrent `session.prompt()`
  // rejection cannot both emit.
  let preflightFailed = false;

  // Backend safety net (see PROMPT_TIMEOUT_MS): bound the fire-and-forget
  // prompt promise so a hung SDK call cannot pin `activeRequest` forever. It
  // is cleared at the commit point (first `message_start`) — see
  // `session-event-handler.ts` — and defensively on settle via `.finally`
  // below, so it never fires for a healthy turn. The `activeRequest` identity
  // check guards the edge case where this request was already superseded (turn
  // completed or a new send started) but the old promise has not yet settled —
  // it must not abort an unrelated turn. The handle is stashed on
  // `activeRequest.promptSafetyTimer` so `session-event-handler.ts` can clear
  // it at the commit point; clearing only on `.finally` would make this a
  // whole-run ceiling that aborts healthy multi-turn runs mid-stream.
  //
  // METRIC-GATED DEFERRAL: on fire, BEFORE aborting, check whether this
  // request's provider is saturated (`queuedRequests > 0`) or paused. If so
  // the timer is a FALSE POSITIVE — the turn is legitimately QUEUED waiting
  // for a ProviderGate slot — so re-arm (defer) instead of aborting, bounded
  // by `PROMPT_TIMEOUT_HARD_CEILING_MS`. FAIL-OPEN: absent gate / unresolvable
  // provider / missing metric falls through to abort (never hang). `firstArmedAt`
  // is a closure local anchoring the cumulative ceiling (no other site reads it).
  const firstArmedAt = Date.now();
  // FP-C2b: resolve the provider-gate accessor + provider resolver from deps,
  // defaulting to the production singletons so behavior is unchanged when the
  // deps are not injected (production wiring). Injectable so the defer branch
  // is unit-testable (mirrors FP-C2a's EffectRunnerDeps accessors).
  const getProviderGateMetrics = deps.getProviderGateMetrics
    ?? (() => ProviderGate.getInstance()?.getMetrics());
  const resolveSessionProvider = deps.resolveSessionProvider
    ?? ((ctx) => resolveActiveModel(ctx).provider);
  const onPromptSafetyTimerFire = () => {
    if (!context.activeRequest || context.activeRequest.id !== requestId) return;
    if (preflightFailed) return;

    const elapsed = Date.now() - firstArmedAt;
    const provider = resolveSessionProvider(context);
    const metrics = getProviderGateMetrics();
    const decision = decidePromptSafetyTimerAction({
      elapsed,
      ceiling: PROMPT_TIMEOUT_HARD_CEILING_MS,
      promptTimeoutMs: PROMPT_TIMEOUT_MS,
      provider,
      metrics,
    });

    if (decision.action === 'defer') {
      // DEFER: re-arm for another window. `preflightFailed` is intentionally
      // NOT set here — the one-shot guard is set ONLY in the FIRE branch
      // below, so a deferred re-arm can still be superseded by a real
      // preflight failure from `preflightResult(false)` / `.catch`. The re-
      // armed handle replaces `promptSafetyTimer` so the commit-point clear in
      // `session-event-handler.ts` (and `clearActiveRequest`) clears the LIVE
      // handle, not the already-fired original.
      context.activeRequest.promptSafetyTimer = setTimeout(onPromptSafetyTimerFire, PROMPT_TIMEOUT_MS);
      return;
    }

    // FIRE: genuinely stuck, ceiling exceeded, or fail-open. The
    // `preflightFailed` one-shot is set ONLY here.
    preflightFailed = true;
    void context.session.abort().catch(() => {
      // Best-effort abort; the failure is surfaced via `preflight.failed` below.
    });
    emitPreflightFailed(deps, context, requestId, decision.reason);
  };
  const promptTimer = setTimeout(onPromptSafetyTimerFire, PROMPT_TIMEOUT_MS);
  context.activeRequest.promptSafetyTimer = promptTimer;

  try {
    context.session
      .prompt(promptText, {
        source: 'rpc',
        images: imagePayload,
        preflightResult: (success) => {
          if (context.retired) return;
          if (preflightFailed) return;
          if (success) {
            // Explicit phase boundary for the host watchdog. This internal
            // custom event is not inserted into the visible transcript; the
            // durable pruning-result entry independently supplies the UI summary.
            deps.emit('message.custom', {
              requestId,
              sessionPath: context.sessionPath,
              message: {
                id: `${requestId}:preflight-succeeded`,
                role: 'system',
                createdAt: new Date().toISOString(),
                markdown: '',
                status: 'completed',
                customType: 'preflight-succeeded',
              },
            } satisfies CustomMessagePayload);
            // Prepass succeeded: the turn is proceeding to streaming.
            // `emitBusyChanged(true)` is idempotent (the host set running
            // optimistically at Send time; `agent_start` will also fire it) —
            // kept for parity with the pre-early-ack path.
            deps.emitBusyChanged(context, true);
          } else {
            preflightFailed = true;
            emitPreflightFailed(deps, context, requestId, 'Prompt rejected before PI accepted the request.');
          }
        },
      })
      .catch((error: Error) => {
        // `session.prompt()` rejected. With early ack the RPC has already
        // resolved, so this is a post-ack failure. If streaming already started
        // (commit point reached) it is an in-turn error → legacy `error` emit
        // (no rollback, matching the post-commit contract). Otherwise it is a
        // pre-commit failure → emit `preflight.failed` so the host reverts via
        // `pending.promoted`. `preflightFailed` guards a double emit when
        // `preflightResult(false)` already settled.
        if (context.retired || preflightFailed) return;
        if (context.activeRequest?.currentMessageId) {
          reportPromptFailure(deps, context, requestId, error);
          return;
        }
        preflightFailed = true;
        emitPreflightFailed(deps, context, requestId, enrichConnectionError(error) || 'Prompt failed before streaming started.');
      })
      .finally(() => {
        // Defensive clear: the commit-point clear in `session-event-handler.ts`
        // is the primary clear (so a healthy long run is never aborted); this
        // covers the settle-without-commit case (reject) and any race where the
        // commit-point clear was skipped.
        clearTimeout(promptTimer);
        if (context.activeRequest?.promptSafetyTimer === promptTimer) {
          context.activeRequest.promptSafetyTimer = undefined;
        }
      });
  } catch (syncError) {
    // `session.prompt` threw synchronously before returning a promise — treat
    // as a pre-ack failure: clear activeRequest and let the RPC reject so the
    // host dispatches `SendResult{ok:false}` and reverts via `pending.ops`.
    clearTimeout(promptTimer);
    if (context.activeRequest?.promptSafetyTimer === promptTimer) {
      context.activeRequest.promptSafetyTimer = undefined;
    }
    clearActiveRequest(context, requestId);
    throw syncError;
  }

  return { requestId };
}

async function handleMessageCompact(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateSessionPath('message.compact', request.params);
  const context = await deps.ensureSessionContext(params.sessionPath);
  if (context.activeRequest || context.session.isStreaming || context.session.isCompacting) {
    throw new BackendError('REQUEST_IN_PROGRESS', 'Cannot compact while this session is running.');
  }
  await context.session.compact();
  return { compacted: true };
}

async function handleMessageInterrupt(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateSessionPath('message.interrupt', request.params);
  const context = deps.getSessionContext(params.sessionPath);
  if (!context) {
    throw new BackendError('SESSION_NOT_FOUND', `Cannot interrupt an unopened session: ${params.sessionPath}`);
  }
  if (context.retired || context.recoveryPromise) {
    return { interrupted: false, alreadyStopped: true, recoveryPending: true };
  }
  // Relaxed guard: an interrupt is valid whenever ANY billable window is
  // running — a streaming turn (activeRequest / isStreaming) OR one of the
  // post-agent_end billable LLM/tool windows the SDK exposes (compaction,
  // branch summary, retry, bash). After agent_end the backend already cleared
  // activeRequest + emitted busy=false, but the SDK may still be running a
  // billable compaction/retry/bash call (isCompacting/isRetrying/isBashRunning)
  // — the legacy `!activeRequest && !isStreaming` guard would wrongly reject
  // that as SESSION_NOT_RUNNING (the "appears stopped but still burning money"
  // bug). An older SDK that doesn't expose the predicates (undefined → falsy)
  // keeps the legacy behaviour: only an activeRequest or isStreaming passes.
  const nothingRunning =
    !context.activeRequest
    && !context.session.isStreaming
    && !context.session.isCompacting
    && !context.session.isRetrying
    && !context.session.isBashRunning;
  if (nothingRunning) {
    // Stop is idempotent. The host can be a few events ahead/behind the SDK at
    // turn boundaries; treating that race as an error wedges the optimistic
    // "Stopping…" state and makes rapid stop→send unnecessarily fragile.
    context.session.clearQueue();
    context.queuedLocalIds = [];
    return { interrupted: false, alreadyStopped: true };
  }
  if (context.activeRequest) {
    context.activeRequest.aborted = true;
    const accumulator = context.activeRequest.liveTurnAccumulator;
    if (accumulator) {
      deps.emit('live.semantic', accumulator.observe({
        kind: 'turn.phase', phase: 'aborting', inactivityBudgetMs: resolveInterruptAbortWatchdogMs(),
      }, Date.now()));
    }
  }
  const abortRequestId = context.activeRequest?.id;
  context.uiBridge?.cancelAll();
  // Clear any queued follow-up messages so a Stop cancels pending queued
  // messages too. The SDK `abort()` preserves the followUp queue; without this
  // a queued message would be drained by the next `prompt()` and run as part
  // of an unrelated future send. The host also removes 'queued' transcript
  // messages on `InterruptResult{ok:true}` to stay in sync.
  context.session.clearQueue();
  // Handoff §F: the SDK queue is gone; drop the localId correlation queue so
  // we don't try to match stale ids if the backend emits a late user-role
  // message_start before the host finishes reconciling the interrupt.
  context.queuedLocalIds = [];
  // Hard-stop every billable window the SDK exposes BEFORE the un-awaited
  // `session.abort()` runs. `abort()` alone does NOT stop the post-agent_end
  // compaction / branch-summary / retry / bash LLM calls, so spend would keep
  // accumulating until abort() settles (and if it never settles, forever).
  // Each is a no-op when its window isn't running; optional-chained so an
  // older SDK that doesn't expose them is unaffected.
  context.session.abortCompaction?.();
  context.session.abortBranchSummary?.();
  context.session.abortBash?.();
  context.session.abortRetry?.();
  // The RPC acknowledgement is a completion barrier, not merely an "abort was
  // requested" acknowledgement. The host serializes stop→send/edit operations
  // behind this request; returning before abort settles allowed the next send
  // to enter the dying turn as a queued follow-up and then disappear.
  const watchdogMs = resolveInterruptAbortWatchdogMs();
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    watchdogTimer = setTimeout(() => resolve('timeout'), watchdogMs);
  });
  const abort = context.session.abort().then(
    () => 'settled' as const,
    (error: unknown) => ({ error: toErrorMessage(error) } as const),
  );
  const outcome = await Promise.race([abort, timeout]);
  if (watchdogTimer) clearTimeout(watchdogTimer);

  // Another watchdog may have retired this runtime while abort() was pending.
  // Recovery ownership is single-writer: never replace the replacement that
  // semantic recovery has already started for this context.
  if (context.retired || context.recoveryPromise) {
    return { interrupted: false, alreadyStopped: true, recoveryPending: true };
  }

  if (outcome === 'timeout') {
    const watchdogLabel = formatInterruptWatchdogDuration(watchdogMs);
    const message = `Stop did not settle within ${watchdogLabel}, so Pie ended the turn locally and is refreshing the session runtime.`;
    const active = context.activeRequest;
    context.retired = true;
    context.sessionManagerFence?.invalidate();
    context.uiBridge?.dispose();
    if (active?.semanticLeaseTimer) clearTimeout(active.semanticLeaseTimer);
    active?.pendingDurableToolTerminals?.clear();
    if (active?.liveTurnAccumulator) {
      context.terminalLiveTurn = { accumulator: active.liveTurnAccumulator, expiresAt: Date.now() + 10_000 };
    }
    context.activeRequest = undefined;
    deps.emit('operational-error', {
      code: 'INTERRUPT_ABORT_STUCK', message, requestId: abortRequestId, sessionPath: params.sessionPath,
    });
    if (abortRequestId) deps.emit('message.aborted', {
      requestId: abortRequestId,
      sessionPath: params.sessionPath,
      messageId: active?.lastAssistantMessageId,
      userInitiated: true,
    } satisfies MessageAbortedPayload);
    deps.emitBusyChanged(context, false);
    const createReplacement = async () => {
      const replacement = await deps.createSessionContext(
        deps.sdk.SessionManager.open(params.sessionPath),
        'resume',
      );
      await Promise.allSettled([
        (deps.buildTransitionSessionOpenedPayload?.(replacement.sessionPath)
          ?? deps.buildSessionOpenedPayload(replacement.sessionPath))
          .then((payload) => deps.emit('session.opened', payload)),
        deps.emitSessionListChanged(),
      ]);
      return replacement;
    };
    context.recoveryPromise = deps.transitionSessionContext
      ? deps.transitionSessionContext(params.sessionPath, createReplacement)
      : createReplacement();
    void context.recoveryPromise.catch((error) => {
      deps.emit('operational-error', {
        code: 'SESSION_RUNTIME_RECOVERY_FAILED',
        message: `Could not replace the stalled session runtime: ${toErrorMessage(error)}`,
        sessionPath: params.sessionPath,
        requestId: abortRequestId,
      });
    });
    return { interrupted: true, settled: false, teardownTimedOut: true };
  }

  if (typeof outcome === 'object') {
    throw new BackendError('MESSAGE_INTERRUPT_FAILED', outcome.error);
  }

  // turn_end normally clears this. Defensively reconcile providers that settle
  // abort without emitting turn_end before acknowledging Stop to the host.
  if (!context.session.isStreaming && context.activeRequest?.id === abortRequestId) {
    context.activeRequest = undefined;
    deps.emitBusyChanged(context, false);
  }
  return { interrupted: true, settled: true };
}

/** Host → backend push of the currently-open tab summaries. Stored into
 *  `process.env.PIE_OPEN_TABS` (JSON) so the `session_review` tool (running in
 *  this backend process) can list currently-open sessions without host state
 *  access. Fire-and-forget from the host's tab-persistence site. */
async function handleMessageReplaceQueue(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateMessageReplaceQueue(request.params);
  const context = deps.getSessionContext(params.sessionPath);
  if (!context) {
    throw new BackendError('SESSION_NOT_FOUND', `Cannot edit the queue for an unopened session: ${params.sessionPath}`);
  }
  if (!context.activeRequest && !context.session.isStreaming) {
    throw new BackendError('QUEUE_NOT_RUNNING', 'The queued message is already being delivered and can no longer be edited.');
  }

  const enqueueAll = async (messages: typeof params.messages): Promise<void> => {
    // Register every correlation first, then invoke every SDK enqueue without
    // yielding. Current SDK steer/followUp implementations mutate their queues
    // synchronously before returning a resolved promise, so clear + complete
    // replacement occurs in one JavaScript turn and cannot expose a transient
    // empty/partial queue to the agent loop.
    context.queuedLocalIds = messages.map((message) => message.localId);
    const enqueues: Promise<void>[] = [];
    for (const message of messages) {
      const promptText = buildPromptText(message.text, message.inputs);
      const images = lowerImageInputs(message.inputs);
      const imagePayload = images.length > 0 ? images : undefined;
      enqueues.push(context.session.steer
        ? context.session.steer(promptText, imagePayload)
        : context.session.followUp(promptText, imagePayload));
    }
    await Promise.all(enqueues);
  };

  context.session.clearQueue();
  try {
    await enqueueAll(params.messages);
  } catch (replaceError) {
    // Queue replacement is all-or-nothing from the host's perspective. Restore
    // the original ordered queue before returning the edit failure.
    context.session.clearQueue();
    try {
      await enqueueAll(params.fallbackMessages);
    } catch (restoreError) {
      context.session.clearQueue();
      context.queuedLocalIds = [];
      return {
        updated: false,
        queueCleared: true,
        error: `Could not update or restore the queued messages: ${toErrorMessage(replaceError)}; restore failed: ${toErrorMessage(restoreError)}`,
      };
    }
    throw replaceError;
  }
  return { updated: true, count: params.messages.length };
}

async function handleMessageClearQueue(
  _deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateSessionPath('message.clearQueue', request.params);
  const context = _deps.getSessionContext(params.sessionPath);
  if (!context) {
    throw new BackendError('SESSION_NOT_FOUND', `Cannot clear queue for an unopened session: ${params.sessionPath}`);
  }
  // Clear all queued steering + follow-up messages. The host removes its
  // optimistic 'queued' transcript messages on the result; this is the
  // authoritative backend clear so the SDK will not drain them later.
  const cleared = context.session.clearQueue();
  // Handoff §F: drop the localId correlation queue so a late user-role
  // message_start cannot carry a stale localId back to the host.
  context.queuedLocalIds = [];
  return { cleared };
}

async function handleOpenTabsSet(
  _deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateOpenTabsSet(request.params);
  process.env['PIE_OPEN_TABS'] = JSON.stringify(params.tabs);
  return { ok: true, count: params.tabs.length };
}

/** `systemPromptToggles.set` — apply the complete disabled-entry set for a
 *  session: persist to the sidecar, rewrite the SDK base prompt, and re-emit
 *  `session.opened` so the webview's display entries + toggle menu reflect the
 *  new state. Returns `{ ok: true }`. */
async function handleSystemPromptTogglesSet(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateSystemPromptTogglesSet(request.params);
  await deps.ensureSessionContext(params.sessionPath);
  await deps.applySystemPromptToggles(params.sessionPath, params.disabledEntries);
  const payload = await deps.buildSessionOpenedPayload(params.sessionPath);
  deps.emit('session.opened', payload);
  return { ok: true };
}

async function handleExtensionUiResponse(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateExtensionUiResponse(request.params);
  const context = deps.getSessionContext(params.sessionPath);
  if (!context?.uiBridge) {
    throw new BackendError('NO_UI_BRIDGE', `No UI bridge for session: ${params.sessionPath}`);
  }
  if (!context.uiBridge.resolveRequest(params.response)) {
    throw new BackendError('UI_REQUEST_NOT_PENDING', 'The extension UI request is no longer pending.');
  }
  const accumulator = context.activeRequest?.liveTurnAccumulator;
  if (accumulator) {
    deps.emit('live.semantic', accumulator.observe({
      kind: 'turn.extensionUi', uiRequestId: params.response.id, action: 'closed',
    }, Date.now()));
  }
  return { ok: true };
}

async function handleModelsList(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateSessionPath('models.list', request.params);
  return await deps.listAvailableModels(deps.getSessionContext(params.sessionPath));
}

async function handleSettingsGet(
  deps: BackendRequestHandlerDeps,
  _request: RequestEnvelope,
): Promise<unknown> {
  return await deps.readModelSettings();
}

async function handleSettingsSet(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateSettingsSet(request.params);
  const { sessionPath, ...rawUpdates } = params;
  const previousSettings = await deps.readModelSettings();
  const targetContext = sessionPath ? await deps.ensureSessionContext(sessionPath) : undefined;
  // The picker sends `defaultModel` (bare id) + `defaultProvider` as separate
  // fields so models that exist under multiple providers (e.g. gpt-5.5 under
  // both github-copilot and openai-codex) can be routed unambiguously, and so
  // the SDK can restore the model on new sessions via
  // `modelRegistry.find(defaultProvider, defaultModel)`. When `defaultProvider`
  // is omitted (e.g. a thinking-level-only change), keep the current provider.
  const currentSessionModel = targetContext?.session.model;
  const currentProvider = currentSessionModel?.provider ?? previousSettings.defaultProvider;
  const currentId = currentSessionModel?.id ?? previousSettings.defaultModel;
  const requestedId = params.defaultModel ?? currentId;
  const requestedProvider = params.defaultProvider ?? currentProvider;
  const currentThinkingLevel = targetContext?.session.thinkingLevel ?? previousSettings.defaultThinkingLevel;
  const requestedThinkingLevel = params.defaultThinkingLevel ?? previousSettings.defaultThinkingLevel;
  // A model switch is any change to the id OR the provider (so switching
  // github-copilot/gpt-5.5 -> openai-codex/gpt-5.5 is detected even though the
  // id is identical).
  const isChangingModel = requestedId !== currentId || requestedProvider !== currentProvider;
  const isChangingThinkingLevel = params.defaultThinkingLevel !== undefined
    && requestedThinkingLevel !== currentThinkingLevel;
  const hasPersistedChanges = (params.defaultModel !== undefined
      && (requestedId !== previousSettings.defaultModel
        || (params.defaultProvider !== undefined && requestedProvider !== previousSettings.defaultProvider)))
    || (params.defaultThinkingLevel !== undefined && requestedThinkingLevel !== previousSettings.defaultThinkingLevel);

  // Persist the bare id + explicit provider (never a `provider/id` compound)
  // so the SDK's restore path resolves correctly on new sessions.
  const settingsUpdates: Partial<ModelSettings> = { ...rawUpdates };
  if (params.defaultModel !== undefined) {
    settingsUpdates.defaultModel = requestedId;
    if (requestedProvider) {
      settingsUpdates.defaultProvider = requestedProvider;
    } else {
      delete settingsUpdates.defaultProvider;
    }
  }

  if ((isChangingModel || isChangingThinkingLevel) && targetContext && (targetContext.activeRequest || targetContext.session.isStreaming)) {
    throw new BackendError('REQUEST_IN_PROGRESS', 'Cannot switch model or thinking level while a request is in progress for this session.');
  }

  const result = hasPersistedChanges
    ? await deps.writeModelSettings(settingsUpdates)
    : previousSettings;

  try {
    if (targetContext && (params.defaultModel || params.defaultThinkingLevel)) {
      if (isChangingModel) {
        const available = targetContext.runtime.services?.modelRegistry?.getAvailable() ?? [];
        const info = available.find((model) => model.provider === requestedProvider && model.id === requestedId)
          ?? available.find((model) => model.id === requestedId);
        if (!info) {
          throw new BackendError('MODEL_UNAVAILABLE', `Model not available in this session: ${params.defaultModel}`);
        }

        const resolvedModel = targetContext.runtime.services.modelRegistry.find(info.provider, info.id);
        if (!resolvedModel) {
          throw new BackendError('MODEL_UNAVAILABLE', `Could not resolve model in registry: ${params.defaultModel}`);
        }

        if (typeof targetContext.session.setModel !== 'function') {
          throw new BackendError('MODEL_SWITCH_UNSUPPORTED', 'This PI session does not support live model switching.');
        }

        await targetContext.session.setModel(resolvedModel);
        if (targetContext.session.model?.id !== requestedId || targetContext.session.model?.provider !== requestedProvider) {
          throw new BackendError('MODEL_SWITCH_FAILED', `Live model switch did not take effect: ${params.defaultModel}`);
        }
      }

      if (params.defaultThinkingLevel && isChangingThinkingLevel) {
        targetContext.session.setThinkingLevel?.(params.defaultThinkingLevel);
      }

      // Re-emit a fresh context-usage reading immediately so the indicator
      // reflects the new model's context window with the same conversation,
      // instead of blanking to null (which previously made the indicator flip
      // to a tokenizer-based transcript estimate until the next turn).
      // emitContextUsageChanged resolves the new model's window and the last
      // assistant prompt footprint, and no-ops via change-detection when
      // nothing differs.
      if (isChangingModel || isChangingThinkingLevel) {
        deps.emitContextUsageChanged(targetContext);
      }
    }

    return result;
  } catch (error) {
    // Roll back to the exact previous settings. defaultProvider must be
    // restored too (the merge-only writer can't otherwise drop a provider we
    // just added), and when it was previously absent we explicitly delete it
    // so the file returns to its prior shape rather than retaining `undefined`.
    const rollback: Partial<ModelSettings> = {
      defaultModel: previousSettings.defaultModel,
      defaultThinkingLevel: previousSettings.defaultThinkingLevel,
    };
    // Explicitly set defaultProvider (even to undefined) so the merge-only
    // writer drops a provider we just added when the previous state had none.
    rollback.defaultProvider = previousSettings.defaultProvider;
    await deps.writeModelSettings(rollback);
    throw error;
  }
}

async function handleLivePipelineTraceSetEnabled(
  _deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = request.params && typeof request.params === 'object'
    ? request.params as Record<string, unknown>
    : undefined;
  if (typeof params?.enabled !== 'boolean') {
    throw new BackendError('INVALID_PARAMS', 'diagnostics.livePipeline.setEnabled requires boolean enabled.');
  }
  setBackendLivePipelineTraceEnabled(params.enabled);
  return { enabled: params.enabled, health: getBackendLivePipelineTraceHealth() };
}

async function handleLiveTurnCheckpoint(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateLiveTurnCheckpoint(request.params);
  const context = deps.getSessionContext(params.sessionPath);
  if (!context) return { status: 'backend_restarted', checkpoint: null, watermark: null };
  const now = Date.now();
  if (context.terminalLiveTurn && context.terminalLiveTurn.expiresAt <= now) {
    context.terminalLiveTurn = undefined;
  }
  const activeAccumulator = context.activeRequest?.liveTurnAccumulator;
  const terminalAccumulator = context.terminalLiveTurn?.accumulator;
  const matchesRequestedAttempt = (accumulator: BackendLiveTurnAccumulator | undefined): accumulator is BackendLiveTurnAccumulator =>
    !!accumulator
      && (params.turnId === undefined
        || (accumulator.turnId === params.turnId && accumulator.attemptId === params.attemptId));
  const accumulator = params.turnId === undefined
    ? activeAccumulator ?? terminalAccumulator
    : matchesRequestedAttempt(activeAccumulator)
      ? activeAccumulator
      : matchesRequestedAttempt(terminalAccumulator)
        ? terminalAccumulator
        : undefined;
  if (!accumulator) return { status: 'inactive', checkpoint: null, watermark: null };
  const checkpoint = accumulator.checkpoint();
  let encodedBytes: number;
  try { encodedBytes = Buffer.byteLength(JSON.stringify(checkpoint), 'utf8'); }
  catch { return { status: 'oversize', checkpoint: null, watermark: accumulator.lifecycleWatermark() ?? null }; }
  const checkpointByteLimit = checkpoint.terminal
    ? LIVE_PIPELINE_LIMITS.terminalCheckpointBytes
    : LIVE_PIPELINE_LIMITS.checkpointBytes;
  if (encodedBytes > checkpointByteLimit
    || encodedBytes > checkpoint.checkpointBytes
    || checkpoint.turn.checkpointBytes !== checkpoint.checkpointBytes) {
    return { status: 'oversize', checkpoint: null, watermark: accumulator.lifecycleWatermark() ?? null };
  }
  if (getBackendLivePipelineTraceHealth().enabled) {
    recordBackendLivePipelineTrace({
      stage: 'backend.checkpoint.built', kind: 'success',
      identifiers: { session: params.sessionPath, request: checkpoint.turn.requestId, turn: checkpoint.turnId, attempt: checkpoint.attemptId },
      eventKind: 'checkpoint', eventSeq: checkpoint.checkpointSeq, snapshotBytes: encodedBytes,
    });
  }
  return {
    status: accumulator === activeAccumulator ? 'active' : 'terminal_grace',
    checkpoint,
    watermark: accumulator.lifecycleWatermark() ?? null,
  };
}

async function handleProviderGateMetrics(
  _deps: BackendRequestHandlerDeps,
  _request: RequestEnvelope,
): Promise<unknown> {
  // In-memory read of the host-side provider gate (wraps globalThis.fetch in
  // the backend process). Returns {enabled:false, providers:[]} when the gate
  // is not installed (no provider has a concurrency config) — the host strip
  // hides the segment.
  const gate = ProviderGate.getInstance();
  if (!gate) return { enabled: false, providers: [] };
  return { enabled: true, providers: gate.getMetrics() };
}

const handlers: Record<string, RequestHandler> = {
  'app.ping': handleAppPing,
  'runtimePrefs.set': handleRuntimePrefsSet,
  'session.list': handleSessionList,
  'session.create': handleSessionCreate,
  'session.open': handleSessionOpen,
  'session.viewed': handleSessionViewed,
  'session.duplicate': handleSessionDuplicate,
  'session.preload': handleSessionPreload,
  'session.forget': handleSessionForget,
  'session.loadTranscriptPage': handleSessionLoadTranscriptPage,
  'session.loadDetail': handleSessionLoadDetail,
  'session.truncateAfter': handleSessionTruncateAfter,
  'message.send': handleMessageSend,
  'message.compact': handleMessageCompact,
  'message.interrupt': handleMessageInterrupt,
  'message.clearQueue': handleMessageClearQueue,
  'message.replaceQueue': handleMessageReplaceQueue,
  'extension_ui.response': handleExtensionUiResponse,
  'openTabs.set': handleOpenTabsSet,
  'models.list': handleModelsList,
  'settings.get': handleSettingsGet,
  'settings.set': handleSettingsSet,
  'systemPromptToggles.set': handleSystemPromptTogglesSet,
  'provider_gate.metrics': handleProviderGateMetrics,
  'liveTurn.checkpoint': handleLiveTurnCheckpoint,
  'diagnostics.livePipeline.setEnabled': handleLivePipelineTraceSetEnabled,
};

export async function handleBackendRequest(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  return handlers[request.method]?.(deps, request) ?? unknownMethodResponse(request.method);
}
