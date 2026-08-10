import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { rewritePieHarnessPrompt } from '../../../shared/pie-harness-prompt.js';
import { attachJsonlLineReader, JSONL_MAX_LINE_BYTES } from '../shared/jsonl';
import { toErrorMessage, parseJsonOrThrow } from '../shared/error-message';
import { updateSettingsJsonObject } from '../shared/settings-json-update';
import {
  PROTOCOL_VERSION,
  type BusyChangedPayload,
  type ContextUsageChangedPayload,
  type ContextWindowUsage,
  type DetailResult,
  type LazyDetailRef,
  type MessageAbortedPayload,
  type ModelSettings,
  type RequestEnvelope,
  type SessionListChangedPayload,
  type SessionOpenedPayload,
  type SessionSummary,
  type SystemPromptEntry,
  type ThinkingLevel,
  type TranscriptPageDirection,
  type TranscriptPagePayload,
} from '../shared/protocol';
import { getDefaultAuthDir, ensureDir, isInsideGitWorkTree, migrateAuthFile } from './auth.js';
import { deriveContextUsageFromBranch } from './context-usage';
import { ExtensionUIBridge } from './extension-ui-bridge';
import { handleBackendRequest } from './request-handler';
import { resolveBackendSessionDir } from './session-directory';
import { handleSdkSessionEvent } from './session-event-handler';
import {
  buildCurrentSummary,
  listAvailableModels,
  resolveActiveModel,
} from './session-metadata';
import { SessionCatalog } from './session-catalog';
import {
  ensureReviewsDir,
  getReviewSidecarFingerprint,
  hasActiveReviewClosureActions,
  startReviewWatcher,
} from './session-review-store';
import {
  readSystemPromptTogglesForSession,
  writeSystemPromptTogglesForSession,
} from './system-prompt-toggle-store';
import { forgetPrivateSessionArtifacts } from './private-session-artifacts';
import {
  loadSdk,
  loadSdkInternalModule,
  type SdkModule,
  type SdkSession,
  type SdkSessionEvent,
  type SdkSessionManager,
  type SdkSystemPromptModule,
} from './sdk';
import { ProviderGate } from './provider-gate.js';
import { observeProviderTransport } from './provider-progress-bus.js';
import { observeProviderIncidents, providerIncidentCode } from './provider-incident.js';
import { BackendError, extractRequestError, log, responseError, responseOk, writeStdout } from './server-io';
import { isBackendLivePipelineTraceEnabled, recordBackendLivePipelineTrace } from './live-pipeline-trace-runtime';
import {
  type SessionContext,
  type SessionContextCreationReason,
  type SessionPromptState,
} from './server-types';
import {
  buildSessionSystemPrompts,
  buildToggledSystemPrompt,
  captureOriginalSystemPromptOptions,
  installAutonomousModeToolGuard,
  installSystemPromptToggleRebuildGuard,
  installSystemPromptToolToggleGuard,
  normalizePromptText,
  TOOLS_ENTRY_ID,
} from './system-prompts';
import { buildPagedTranscriptWindow } from './transcript-window';
import { createRuntimeFactory } from './runtime-factory.js';
import { createSessionManagerFence } from './session-manager-fence';
import { installAuxiliaryLlmMeter } from './auxiliary-llm-meter';
import { backendTrace, backendError, backendInfo, backendWarn } from './log';
import {
  buildSessionOpenedPayload as buildSessionOpenedPayloadHelper,
  ensureDisplayTranscriptCache,
  normalizeDanglingTranscript,
} from './session-opened.js';
import { deduplicateToolCallResultsForTransport } from '../shared/chat-message-parts.js';
import { findDurableDetail } from '../shared/lazy-details.js';
import { LIVE_PIPELINE_LIMITS } from '../shared/live-pipeline-protocol.js';
import { ASK_USER_TOOL_NAME } from '../../../shared/autonomous-mode.js';

export function extractPreviewRequestId(preview: string): string | undefined {
  const match = /"id"\s*:\s*"([^"\\]{1,200})"/.exec(preview);
  return match?.[1];
}

/** Simple stopwatch for backend timing probes. */
function timed<T>(label: string, op: () => T): T;
function timed<T>(label: string, op: () => Promise<T>): Promise<T>;
function timed<T>(label: string, op: () => T | Promise<T>): T | Promise<T> {
  const start = Date.now();
  const finish = (result: T | Promise<T>): T | Promise<T> => {
    if (result instanceof Promise) {
      return result.then(
        (value) => {
          backendTrace('timing', 'op.completed', { label, durationMs: Date.now() - start });
          return value;
        },
        (error) => {
          backendTrace('timing', 'op.failed', { level: 'warn', label, durationMs: Date.now() - start, error: toErrorMessage(error) });
          throw error;
        },
      );
    }
    backendTrace('timing', 'op.completed', { label, durationMs: Date.now() - start });
    return result;
  };
  try {
    return finish(op());
  } catch (error) {
    backendTrace('timing', 'op.failed', { level: 'warn', label, durationMs: Date.now() - start, error: toErrorMessage(error) });
    throw error;
  }
}

/** Module-level guard: install the fatal handlers at most once even if
 *  `start()` is invoked more than once. */
let backendFatalHandlersInstalled = false;
const SESSION_CATALOG_POLL_INTERVAL_MS = 10_000;
/** Grace bound for `runtime.dispose()` during replacement and shutdown. A
 *  provider teardown can wedge an SDK runtime; disposal is bounded best-effort
 *  so it can never block recovery or shutdown. Shared by `createSessionContext`
 *  (replacement) and `dispose()` (shutdown) so the bound stays consistent.
 *  `PIE_RUNTIME_DISPOSE_GRACE_MS` overrides the bound (mirroring
 *  `PIE_WILLRETRY_WATCHDOG_GRACE_MS`) so disposal-bound tests need not wait the
 *  full production window. */
function resolveRuntimeDisposeGraceMs(): number {
  const override = Number(process.env.PIE_RUNTIME_DISPOSE_GRACE_MS);
  return Number.isFinite(override) && override > 0 ? override : 5_000;
}

/** Surface swallowed promise rejections and uncaught exceptions on stderr (the
 *  host captures backend stderr) instead of letting them die invisibly. We
 *  deliberately do NOT `process.exit` — the host's backend-exit detection
 *  owns crash handling; this only prevents silent invisibility. */
function installBackendFatalHandlers(): void {
  if (backendFatalHandlersInstalled) return;
  backendFatalHandlersInstalled = true;
  process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? String(reason.stack ?? reason) : String(reason);
    backendError('backend', 'unhandledRejection', { error });
  });
  process.on('uncaughtException', (err) => {
    const error = err instanceof Error ? String(err.stack ?? err) : String(err);
    backendError('backend', 'uncaughtException', { error });
  });
  // Node's default warning text omits the creation stack in normal runs. Keep a
  // structured copy so listener leaks and deprecations point to the call site
  // that created them rather than only reporting the final listener count.
  process.on('warning', (warning) => {
    backendWarn('backend', 'process.warning', {
      warningName: warning.name,
      message: warning.message,
      stack: warning.stack,
      listenerCounts: {
        SIGINT: process.listenerCount('SIGINT'),
        SIGTERM: process.listenerCount('SIGTERM'),
        exit: process.listenerCount('exit'),
        warning: process.listenerCount('warning'),
      },
    });
  });
}

export class BackendServer {
  private sdk!: SdkModule;
  private readonly sdkPath: string;
  private readonly startupCwd: string;
  private sessionDir?: string;
  private sessionDirResolved = false;
  private agentDir = '';
  private authStorage: unknown;
  private viewedSessionPath?: string;
  /** Process-wide user preference mirrored by runtimePrefs.set. */
  private autonomousMode = false;
  private readonly sessionContexts = new Map<string, SessionContext>();
  private readonly sessionCatalog = new SessionCatalog();
  /** Deduplicates concurrent opens/preloads for the same cold session. */
  private readonly pendingSessionContexts = new Map<string, Promise<SessionContext>>();
  /** Paths currently being forgotten; prevents a racing open from installing
   *  a runtime after its transcript has been removed. */
  private readonly forgottenSessionPaths = new Set<string>();
  /** Serializes prompt persistence and live prompt rebuilds for each session. */
  private readonly pendingSystemPromptToggleApplications = new Map<string, Promise<void>>();
  private systemPromptModulePromise?: Promise<SdkSystemPromptModule>;
  /** Disposer for the session-review sidecar watcher (see `startReviewWatcher`). */
  private stopReviewWatcher?: () => void;
  private sessionCatalogPollTimer?: ReturnType<typeof setInterval>;
  private sessionCatalogPollingActive = false;
  private sessionCatalogPollInFlight = false;
  /** Last cheap snapshot of the append-only review/closure files. Used by the
   * catalog poll to recover when fs.watch drops or coalesces an event. */
  private reviewSidecarFingerprint = getReviewSidecarFingerprint();
  /** Cached active-action state belongs to `reviewSidecarFingerprint`; an
   * unchanged poll must not synchronously reparse the growing sidecars. */
  private reviewClosureReconciliationPending = false;
  private stopProviderProgressObserver?: () => void;
  private stopProviderIncidentObserver?: () => void;
  /** Captures request+turn ownership at an attempt's first synchronous gate
   * observation so a late acquisition cannot be charged to a newer request. */
  private readonly providerAttemptOwners = new Map<string, {
    context: SessionContext;
    requestId: string;
    turnSequence: number;
    retryId?: string;
  }>();

  /** True once `dispose()` has begun. Suppresses stale events and payload
   *  builds from in-flight async paths (recovery replacement emissions, catalog
   *  polling, late SDK events) so a dying backend cannot push post-shutdown
   *  state to a host that is already tearing it down. */
  private disposed = false;
  private hostWatchdogTimer?: ReturnType<typeof setInterval>;
  private readonly hostPid?: number;

  constructor(options: { sdkPath: string; cwd: string; hostPid?: number }) {
    this.sdkPath = options.sdkPath;
    this.startupCwd = options.cwd;
    this.hostPid = options.hostPid;
  }

  private getSessionDir(): string | undefined {
    if (!this.sessionDirResolved) {
      this.sessionDir = resolveBackendSessionDir(
        this.agentDir,
        process.env.PI_CODING_AGENT_SESSION_DIR,
      );
      this.sessionDirResolved = true;
    }
    return this.sessionDir;
  }

  async start(): Promise<void> {
    // Install fatal handlers first so even an early spawn-time rejection is
    // surfaced. Idempotent (module-level guard).
    installBackendFatalHandlers();
    await timed('start.loadSdk', async () => {
      this.sdk = await loadSdk(this.sdkPath);
      this.agentDir = this.sdk.getAgentDir();
      this.getSessionDir();
    });

    // Install the host-side provider gate BEFORE any session runtime is
    // created. The gate wraps globalThis.fetch to enforce per-provider
    // concurrency, afterburn sticky slots, stream-liveness, and circuit
    // breaking — replacing the LiteLLM proxy. Configs are read from
    // models.json (in agentDir) which is generated by sync-models from
    // models.yaml providers.<p>.concurrency.
    await timed('start.providerGate', async () => {
      try {
        const modelsJsonPath = path.join(this.agentDir, 'models.json');
        const raw = await fs.readFile(modelsJsonPath, 'utf8');
        const modelsJson = JSON.parse(raw);
        const configs = ProviderGate.resolveConfigs(modelsJson);
        // Install whenever at least one provider ships a concurrency block.
        // The gate matches outbound requests by each config's `baseUrl`, so
        // only providers in `configs` are gated; user overrides via
        // runtimePrefs.set reconfigure the live gate in place (no restart).
        if (configs.length > 0) {
          ProviderGate.install(configs, 120);
        }
      } catch (error) {
        // Non-fatal: if models.json is missing or unreadable, the gate is
        // simply not installed — requests go direct (no concurrency cap).
        backendInfo('backend', 'providerGate.notInstalled', { error: (error as Error).message });
      }
    });

    this.stopProviderProgressObserver = observeProviderTransport((observation) => {
      const currentContext = [...this.sessionContexts.values()].find((candidate) =>
        candidate.session.sessionManager.getSessionId?.() === observation.sessionId,
      );
      const currentRequest = currentContext?.activeRequest;
      let owner = this.providerAttemptOwners.get(observation.attemptId);
      if (!owner && (observation.kind === 'gate_queue' || observation.kind === 'gate_acquired')
        && currentContext && currentRequest && currentRequest.providerTurnSequence !== undefined) {
        owner = {
          context: currentContext,
          requestId: currentRequest.id,
          turnSequence: currentRequest.providerTurnSequence,
          retryId: currentRequest.retryTiming?.retryId,
        };
        this.providerAttemptOwners.set(observation.attemptId, owner);
      }

      const ownerRequest = owner?.context.activeRequest;
      const ownsCurrentRequest = owner !== undefined && ownerRequest?.id === owner.requestId;
      if (owner && ownerRequest?.id === owner.requestId) {
        if (owner.retryId !== undefined
          && ownerRequest.retryTiming?.retryId === owner.retryId
          && ownerRequest.retryTiming.providerAttemptStartedAt === undefined
          && (observation.kind === 'gate_queue' || observation.kind === 'gate_acquired')) {
          ownerRequest.retryTiming.providerAttemptStartedAt = observation.occurredAt;
        }
        if (observation.kind === 'gate_acquired'
          && typeof observation.queueDurationMs === 'number'
          && Number.isFinite(observation.queueDurationMs)) {
          const queueByTurn = ownerRequest.providerQueueByTurn ?? new Map();
          const previous = queueByTurn.get(owner.turnSequence) ?? { durationMs: 0, attemptCount: 0 };
          queueByTurn.set(owner.turnSequence, {
            durationMs: previous.durationMs + Math.max(0, Math.trunc(observation.queueDurationMs)),
            attemptCount: previous.attemptCount + 1,
          });
          ownerRequest.providerQueueByTurn = queueByTurn;
        }
      }
      if (observation.kind === 'gate_rejected' || observation.kind === 'headers_received'
        || observation.kind === 'transport_terminal' || observation.kind === 'transport_error') {
        this.providerAttemptOwners.delete(observation.attemptId);
      }

      const context = owner?.context ?? currentContext;
      const accumulator = ownsCurrentRequest ? ownerRequest.liveTurnAccumulator : undefined;
      const checkpointSeq = accumulator?.currentSeq ?? 0;
      if (context && accumulator && checkpointSeq > 0) {
        if (observation.kind === 'gate_queue') {
          this.emit('live.semantic', accumulator.observe({ kind: 'turn.phase', phase: 'queued', inactivityBudgetMs: 120_000 }, observation.occurredAt));
        } else if (observation.kind === 'headers_wait' || observation.kind === 'headers_received') {
          this.emit('live.semantic', accumulator.observe({ kind: 'turn.phase', phase: 'waiting_provider', inactivityBudgetMs: 120_000 }, observation.occurredAt));
        }
      }
      if (context && isBackendLivePipelineTraceEnabled()) {
        recordBackendLivePipelineTrace({
          stage: 'provider.phase.transition',
          kind: 'transition',
          identifiers: {
            session: context.sessionPath,
            ...(ownsCurrentRequest && owner ? { request: owner.requestId } : {}),
            attempt: observation.attemptId,
          },
          phase: observation.kind === 'gate_queue'
            ? 'provider_gate_queue'
            : observation.kind === 'headers_wait'
              ? 'headers'
              : observation.kind === 'headers_received'
                ? 'pre_first_semantic'
                : observation.kind === 'raw_chunk'
                  ? 'semantic_stream'
                  : 'terminal',
        });
      }
    });

    this.stopProviderIncidentObserver = observeProviderIncidents((incident) => {
      const context = [...this.sessionContexts.values()].find((candidate) =>
        candidate.session.sessionManager.getSessionId?.() === incident.sessionId,
      );
      const active = context?.activeRequest;
      if (!context || !active) return;

      active.latestProviderIncident = incident;
      active.lastProviderErrorForDiagnostics = incident.userMessage;
      const noticeKey = [
        incident.kind,
        incident.providerHost,
        incident.status ?? '',
        incident.retryAt ?? '',
      ].join(':');
      const emitted = active.providerIncidentNoticeKeys ?? new Set<string>();
      active.providerIncidentNoticeKeys = emitted;
      if (!emitted.has(noticeKey)) {
        emitted.add(noticeKey);
        this.emit('operational-error', {
          code: providerIncidentCode(incident.kind),
          message: incident.userMessage,
          detail: incident.detail,
          sessionPath: context.sessionPath,
          requestId: active.id,
        });
      }

      // A terminal quota response cannot recover by waiting on the same
      // provider. Give the SDK a short window to publish its normal terminal
      // message, then fence/replace the runtime if it remains busy. This turns
      // hidden SDK backoff into a bounded, explicit failure.
      if (incident.kind === 'quota_exhausted' && !active.quotaSettlementTimer) {
        const requestId = active.id;
        active.quotaSettlementTimer = setTimeout(() => {
          const current = context.activeRequest;
          if (current?.id !== requestId || current.latestProviderIncident?.kind !== 'quota_exhausted') return;
          this.recoverStuckSession(context, current.latestProviderIncident.userMessage);
        }, 15_000);
        active.quotaSettlementTimer.unref?.();
      }
    });

    const authDir = process.env.PI_CODING_AGENT_AUTH_DIR?.trim();
    let authPath = '';

    await timed('start.authSetup', async () => {
      if (authDir) {
        // Explicit override — use as-is.
        authPath = path.resolve(authDir, 'auth.json');
      } else {
        // Default: check if agentDir is inside a git tree.
        const agentDirAuthPath = path.resolve(this.agentDir, 'auth.json');
        if (await isInsideGitWorkTree(agentDirAuthPath)) {
          const allowInTree = process.env.PIE_ALLOW_IN_TREE_AUTH === '1';
          if (allowInTree) {
            authPath = agentDirAuthPath;
          } else {
            // Auto-resolve to platform-standard safe location.
            const safeDir = getDefaultAuthDir();
            authPath = path.resolve(safeDir, 'auth.json');
            // Migrate existing in-tree auth.json to the safe location.
            await migrateAuthFile(agentDirAuthPath, authPath);
          }
        } else {
          authPath = agentDirAuthPath;
        }
      }

      // Ensure the auth directory exists so the SDK can write to it.
      await ensureDir(path.dirname(authPath));

      this.authStorage = this.sdk.AuthStorage.create(authPath);
    });

    // Attach the stdin reader BEFORE emitting backend.ready so that any
    // request the client sends immediately after receiving ready is captured,
    // rather than racing with reader attachment.
    const detachReader = attachJsonlLineReader(process.stdin, (line) => {
      void this.handleLine(line);
    }, {
      maxLineBytes: JSONL_MAX_LINE_BYTES,
      onOverflow: ({ maxLineBytes, preview }) => {
        const requestId = extractPreviewRequestId(preview);
        log(JSON.stringify({
          level: 'error',
          event: 'protocol.stdin-overflow',
          maxLineBytes,
          requestId: requestId ?? null,
          preview,
        }));
        if (requestId) {
          writeStdout(responseError(
            requestId,
            'REQUEST_TOO_LARGE',
            `Request exceeds the ${maxLineBytes}-byte JSONL transport limit.`,
          ));
        }
      },
    });

    process.stdin.on('end', () => {
      detachReader();
      void this.dispose().finally(() => process.exit(0));
    });

    this.startHostWatchdog();

    this.emit('backend.ready', {
      sdkPath: this.sdkPath,
      agentDir: this.agentDir,
      sdkVersion: this.sdk.VERSION,
      protocolVersion: PROTOCOL_VERSION,
      authPath,
    });

    this.startReviewReconciliation();
  }

  /**
   * Stdio EOF is not sufficient when Node is launched through a process
   * manager: the manager can retain the pipe after the extension host dies.
   * Keep a low-cost, unref'd ownership check so a backend cannot outlive its
   * host indefinitely. The host PID is optional for compatibility with direct
   * backend launches and unit tests.
   */
  private startHostWatchdog(): void {
    const hostPid = this.hostPid;
    if (hostPid === undefined || hostPid === process.pid) return;

    const checkHost = (): void => {
      try {
        process.kill(hostPid, 0);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH') return;
        this.stopHostWatchdog();
        backendWarn('backend', 'extension host disappeared; stopping backend', { hostPid });
        void this.dispose().finally(() => process.exit(0));
      }
    };

    this.hostWatchdogTimer = setInterval(checkHost, 2_000);
    this.hostWatchdogTimer.unref?.();
  }

  private stopHostWatchdog(): void {
    if (this.hostWatchdogTimer) clearInterval(this.hostWatchdogTimer);
    this.hostWatchdogTimer = undefined;
  }

  private createRuntimeFactory() {
    return createRuntimeFactory(this.sdk, this.authStorage, this.startupCwd);
  }

  private resolveSessionPath(session: SdkSession): string | undefined {
    return session.sessionFile ?? session.sessionManager.getSessionFile();
  }

  private getSessionContext(sessionPath?: string): SessionContext | undefined {
    return sessionPath ? this.sessionContexts.get(sessionPath) : undefined;
  }

  private async createSessionContext(
    sessionManager: SdkSessionManager,
    reason: SessionContextCreationReason,
  ): Promise<SessionContext> {
    const context = await this.buildSessionContext({ sessionManager, reason });

    const existing = this.sessionContexts.get(context.sessionPath);
    if (existing) {
      context.busySeq = existing.busySeq;
      if (existing.terminalLiveTurn && existing.terminalLiveTurn.expiresAt > Date.now()) {
        context.terminalLiveTurn = existing.terminalLiveTurn;
      }
      const cleanup = (operation: string, action: () => void): void => {
        try {
          action();
        } catch (error) {
          backendWarn('backend-session', `replaced runtime ${operation} failed`, {
            sessionPath: context.sessionPath,
            error: toErrorMessage(error),
          });
        }
      };
      cleanup('watchdog cleanup', () => existing.willRetryWatchdogClear?.());
      cleanup('UI disposal', () => existing.uiBridge?.dispose());
      cleanup('unsubscribe', () => existing.unsubscribe());
      cleanup('session manager fence', () => existing.sessionManagerFence?.invalidate());
      // A provider teardown can wedge the old runtime. The replacement becomes
      // authoritative immediately; old disposal is bounded best-effort and
      // must not block local recovery or the next send.
      let dispose: Promise<void>;
      try {
        dispose = Promise.resolve(existing.runtime.dispose());
      } catch (error) {
        backendWarn('backend-session', 'replaced runtime disposal failed', {
          sessionPath: context.sessionPath,
          error: toErrorMessage(error),
        });
        dispose = Promise.resolve();
      }
      let disposeGraceTimer: ReturnType<typeof setTimeout> | undefined;
      const disposeGrace = new Promise<void>((resolve) => {
        disposeGraceTimer = setTimeout(resolve, resolveRuntimeDisposeGraceMs());
        disposeGraceTimer.unref?.();
      });
      void Promise.race([dispose, disposeGrace])
        .catch(() => undefined)
        .finally(() => {
          if (disposeGraceTimer) clearTimeout(disposeGraceTimer);
        });
    }

    if (this.forgottenSessionPaths.has(context.sessionPath)) {
      context.retired = true;
      context.sessionManagerFence?.invalidate();
      try { context.uiBridge?.dispose(); } catch { /* best effort */ }
      try { context.unsubscribe(); } catch { /* best effort */ }
      try { await context.runtime.dispose(); } catch { /* best effort */ }
      throw new BackendError('SESSION_NOT_FOUND', `The session was forgotten while it was opening: ${context.sessionPath}`);
    }
    this.sessionContexts.set(context.sessionPath, context);
    return context;
  }

  private async buildSessionContext(options: {
    sessionManager: SdkSessionManager;
    reason: SessionContextCreationReason;
  }): Promise<SessionContext> {
    return await timed('buildSessionContext', async () => {
      const { sessionManager, reason } = options;
      const { manager: fencedSessionManager, fence: sessionManagerFence } = createSessionManagerFence(sessionManager);
      const previousSessionFile = this.viewedSessionPath;
      let runtime: SessionContext['runtime'] | undefined;
      try {
      runtime = await this.sdk.createAgentSessionRuntime(this.createRuntimeFactory(), {
        cwd: fencedSessionManager.getCwd() || this.startupCwd,
        agentDir: this.agentDir,
        sessionManager: fencedSessionManager,
        sessionStartEvent: previousSessionFile
          ? {
              type: 'session_start',
              reason,
              previousSessionFile,
            }
          : undefined,
      });

      // Runtime model registries contain the effective request URLs after
      // built-in defaults and credential-specific OAuth rewrites are applied.
      // Feed those URLs into the already-installed gate so configured providers
      // without a static models.json baseUrl (and providers whose URL changes at
      // runtime) are gated and reported like ordinary custom providers.
      const modelRegistry = runtime.services?.modelRegistry;
      ProviderGate.getInstance()?.registerModelBaseUrls(
        modelRegistry?.getAll?.() ?? modelRegistry?.getAvailable?.() ?? [],
      );

      const session = runtime.session;
      const sessionPath = this.resolveSessionPath(session);
      if (!sessionPath) {
        throw new Error('The PI session did not expose a session path.');
      }

      const context: SessionContext = {
        runtime,
        session,
        sessionPath,
        unsubscribe: () => undefined,
        busySeq: 0,
        lastContextUsage: undefined,
        sessionManagerFence,
      };

      // Wire the ExtensionUI bridge so extensions can ask questions through the webview.
      const uiBridge = new ExtensionUIBridge(context.sessionPath, (event, payload) => this.emit(event, payload));
      context.uiBridge = uiBridge;
      const extensionRunner = (session as unknown as { extensionRunner?: { setUIContext?: (ctx: unknown) => void } }).extensionRunner;
      if (extensionRunner?.setUIContext) {
        extensionRunner.setUIContext(uiBridge);
      }

      installAuxiliaryLlmMeter(
        session,
        sessionPath,
        (event, payload) => this.emit(event, payload),
      );
      context.unsubscribe = session.subscribe((event: SdkSessionEvent) => {
        this.handleSessionEvent(context, event);
      });

      // Load persisted picker state before installing guards: both prompt
      // rebuilds and extension-driven tool changes consult this live set.
      const persistedDisabled = await readSystemPromptTogglesForSession(sessionPath);
      context.systemPromptDisabledEntries = persistedDisabled;

      // The SDK rebuilds its base prompt whenever active tools or extension
      // resources change. Guard that synchronous rebuild so it cannot silently
      // restore entries the picker disabled.
      const promptState = this.getSessionPromptState(context);
      if (typeof promptState._rebuildSystemPrompt === 'function') {
        const { buildSystemPrompt } = await this.getSystemPromptModule();
        installSystemPromptToggleRebuildGuard(
          promptState,
          () => context.systemPromptDisabledEntries ?? [],
          buildSystemPrompt,
        );
      }
      installSystemPromptToolToggleGuard(
        session,
        () => context.systemPromptDisabledEntries ?? [],
      );
      installAutonomousModeToolGuard(session, () => this.autonomousMode);

      // Disabling Tools controls both prompt prose and the provider's separate
      // tool-schema field. Capture the initial active set so a later re-enable
      // can restore it, including after reopening a persisted disabled session.
      if (persistedDisabled.includes(TOOLS_ENTRY_ID)) {
        context.systemPromptToolsBeforeDisable = session.getActiveToolNames?.()
          ?? session.getAllTools?.().map((tool) => tool.name)
          ?? [];
        session.setActiveToolsByName?.([]);
      }
      if (persistedDisabled.length > 0) {
        await this.applySystemPromptTogglesToBasePrompt(context, persistedDisabled);
      }
      this.applyAutonomousModeToContext(context, this.autonomousMode);

      return context;
      } catch (error) {
        sessionManagerFence.invalidate();
        if (runtime) {
          try {
            await runtime.dispose();
          } catch {
            // Construction failure remains authoritative; disposal is best effort.
          }
        }
        throw error;
      }
    });
  }

  private async ensureSessionContext(sessionPath: string): Promise<SessionContext> {
    if (this.forgottenSessionPaths.has(sessionPath)) {
      throw new BackendError('SESSION_NOT_FOUND', `The session has been forgotten: ${sessionPath}`);
    }
    const existing = this.sessionContexts.get(sessionPath);
    if (existing) {
      if (existing.recoveryPromise) {
        try {
          return await existing.recoveryPromise;
        } catch (error) {
          throw new BackendError(
            'SESSION_RUNTIME_RECOVERY_FAILED',
            `The session runtime could not be replaced: ${toErrorMessage(error)}`,
          );
        }
      }
      if (existing.retired) {
        throw new BackendError(
          'SESSION_RUNTIME_RECOVERY_FAILED',
          `The session runtime for ${sessionPath} was retired without a replacement.`,
        );
      }
      return existing;
    }

    const pending = this.pendingSessionContexts.get(sessionPath);
    if (pending) {
      return await pending;
    }

    const creation = this.createSessionContext(this.sdk.SessionManager.open(sessionPath), 'resume');
    this.pendingSessionContexts.set(sessionPath, creation);
    try {
      return await creation;
    } finally {
      if (this.pendingSessionContexts.get(sessionPath) === creation) {
        this.pendingSessionContexts.delete(sessionPath);
      }
    }
  }

  private getPinnedStreamingMessageId(context: SessionContext): string | undefined {
    return context.activeRequest?.currentMessageId ?? context.activeRequest?.lastAssistantMessageId;
  }

  private async loadTranscriptPage(
    sessionPath: string,
    direction: TranscriptPageDirection,
    loadedStart?: number,
    loadedEnd?: number,
  ): Promise<TranscriptPagePayload> {
    const context = await this.ensureSessionContext(sessionPath);
    const cache = ensureDisplayTranscriptCache(context);
    const page = buildPagedTranscriptWindow(cache, {
      direction,
      loadedStart,
      loadedEnd,
      pinnedMessageId: this.getPinnedStreamingMessageId(context),
    });

    const busy = context.session.isStreaming || !!context.activeRequest || context.session.isCompacting === true;
    const transcript = busy ? page.transcript : normalizeDanglingTranscript(page.transcript);
    return {
      sessionPath: context.sessionPath,
      transcript: transcript.map(deduplicateToolCallResultsForTransport),
      transcriptWindow: page.transcriptWindow,
      busy,
    };
  }

  private async loadDetail(sessionPath: string, ref: LazyDetailRef): Promise<DetailResult> {
    if (ref.source !== 'durable') {
      return { sessionPath, key: ref.key, status: 'unavailable', message: 'Live detail is owned by the extension host.' };
    }
    const context = await this.ensureSessionContext(sessionPath);
    const found = findDurableDetail(ensureDisplayTranscriptCache(context).transcript, ref);
    if (found.status === 'unavailable') {
      return { sessionPath, key: ref.key, status: 'unavailable', message: 'The durable detail is no longer available.' };
    }
    if (found.sizeBytes > LIVE_PIPELINE_LIMITS.previewBytes) {
      return { sessionPath, key: ref.key, status: 'unavailable', message: 'The detail exceeds the supported retrieval size.' };
    }
    if (found.sizeBytes !== ref.sizeBytes) {
      return { sessionPath, key: ref.key, status: 'stale', message: 'The durable detail changed; refresh the session and retry.' };
    }
    return { sessionPath, key: ref.key, status: 'loaded', value: found.value, sizeBytes: found.sizeBytes };
  }

  private resolveCurrentContextWindow(context: SessionContext): number | undefined {
    const sessionContextWindow = context.session.model?.contextWindow;
    if (
      typeof sessionContextWindow === 'number'
      && Number.isFinite(sessionContextWindow)
      && sessionContextWindow > 0
    ) {
      return Math.trunc(sessionContextWindow);
    }

    const currentModelId = context.session.model?.id;
    if (!currentModelId) {
      return undefined;
    }

    try {
      const models = context.runtime.services?.modelRegistry?.getAvailable() ?? [];
      const model = models.find((candidate) => candidate.id === currentModelId);
      if (
        typeof model?.contextWindow === 'number'
        && Number.isFinite(model.contextWindow)
        && model.contextWindow > 0
      ) {
        return Math.trunc(model.contextWindow);
      }
    } catch (error) {
      // Ignore model registry issues and fall back to undefined.
      backendTrace('modelRegistry', 'contextWindowLookup.failed', { level: 'warn', error: toErrorMessage(error) });
    }

    return undefined;
  }

  private getContextUsage(context: SessionContext): ContextWindowUsage | undefined {
    // Derive `tokens` from the most recent assistant usage's prompt footprint
    // (input + cacheRead + cacheWrite) — the tokens that actually counted
    // against the context window on the last API call.
    //
    // We deliberately do NOT use the SDK's `getContextUsage().tokens`: that
    // value is `calculateContextTokens(lastUsage)` (= `totalTokens` = prompt
    // footprint + output) plus a chars/4 estimate of trailing in-progress
    // messages. Including output overstates window fill, and the trailing
    // estimate disagrees with the real usage that lands on completion, so the
    // indicator jumps ("doubling" / changing mid-turn and on completion).
    //
    // The prompt footprint is stable during a turn — it only steps forward
    // when a new assistant usage arrives — so the indicator reflects actual
    // window use consistently. `contextWindow` follows the active model.
    const contextWindow = this.resolveCurrentContextWindow(context);
    if (!contextWindow) {
      return undefined;
    }
    const measuredUsage = deriveContextUsageFromBranch(
      context.session.sessionManager.getBranch(),
      contextWindow,
    );
    if (measuredUsage) {
      context.postCompactionEstimatedTokens = undefined;
      return measuredUsage;
    }

    const estimatedTokens = context.postCompactionEstimatedTokens;
    if (estimatedTokens === undefined) {
      return undefined;
    }
    return {
      tokens: estimatedTokens,
      contextWindow,
      percent: Math.min(100, Math.max(0, (estimatedTokens / contextWindow) * 100)),
    };
  }

  private emitContextUsageChanged(context: SessionContext, postCompactionEstimatedTokens?: number): void {
    if (postCompactionEstimatedTokens !== undefined) {
      context.postCompactionEstimatedTokens = postCompactionEstimatedTokens;
    }
    const nextUsage = this.getContextUsage(context) ?? null;
    const previousUsage = context.lastContextUsage;
    const changed = previousUsage === undefined
      || (previousUsage === null
        ? nextUsage !== null
        : nextUsage === null
          || previousUsage.tokens !== nextUsage.tokens
          || previousUsage.contextWindow !== nextUsage.contextWindow
          || previousUsage.percent !== nextUsage.percent);

    if (!changed) {
      return;
    }

    context.lastContextUsage = nextUsage;
    this.emit('contextUsage.changed', {
      sessionPath: context.sessionPath,
      contextUsage: nextUsage,
    } satisfies ContextUsageChangedPayload);
  }

  private async getSystemPromptModule(): Promise<SdkSystemPromptModule> {
    this.systemPromptModulePromise ??= loadSdkInternalModule<SdkSystemPromptModule>(
      this.sdkPath,
      path.join('core', 'system-prompt.js'),
    );
    return await this.systemPromptModulePromise;
  }

  private getSessionPromptState(context: SessionContext): SessionPromptState {
    return context.session as SdkSession & SessionPromptState;
  }

  private async readHarnessSystemPrompt(context: SessionContext): Promise<string | undefined> {
    const promptState = this.getSessionPromptState(context);
    const options = promptState._baseSystemPromptOptions;
    if (!options) {
      const basePrompt = normalizePromptText(promptState._baseSystemPrompt);
      return basePrompt ? rewritePieHarnessPrompt(basePrompt, this.agentDir) : undefined;
    }

    try {
      const { buildSystemPrompt } = await this.getSystemPromptModule();
      const basePrompt = normalizePromptText(buildSystemPrompt({
        cwd: options.cwd,
        selectedTools: options.selectedTools,
        toolSnippets: options.toolSnippets,
        promptGuidelines: options.promptGuidelines,
      }));
      return basePrompt ? rewritePieHarnessPrompt(basePrompt, this.agentDir) : undefined;
    } catch (error) {
      backendTrace('systemPrompt', 'harnessRead.failed', { level: 'debug', error: toErrorMessage(error) });
      const basePrompt = normalizePromptText(promptState._baseSystemPrompt);
      return basePrompt ? rewritePieHarnessPrompt(basePrompt, this.agentDir) : undefined;
    }
  }

  private async buildSystemPrompts(
    context: SessionContext,
    harnessPromptOverride?: string,
  ): Promise<SystemPromptEntry[]> {
    const promptState = this.getSessionPromptState(context);
    // Refresh the unfiltered-options snapshot from the SDK's live options
    // whenever they're at least as complete as what we cached (e.g. the SDK
    // rebuilt them after a tool/resource change). The display entry list is
    // then built from the snapshot so disabled option-driven entries (context
    // files, skills, append) stay present and re-toggleable instead of
    // vanishing once the live options are filtered for the model prompt.
    captureOriginalSystemPromptOptions(promptState);
    const promptOptions = promptState._originalSystemPromptOptions ?? promptState._baseSystemPromptOptions;
    const harnessPrompt = harnessPromptOverride ?? await this.readHarnessSystemPrompt(context);
    const tools = typeof context.session.getAllTools === 'function'
      ? context.session.getAllTools()
      : [];

    return buildSessionSystemPrompts({
      harnessPrompt,
      promptOptions,
      formatSkillsForPrompt: this.sdk.formatSkillsForPrompt,
      tools,
      activeProvider: resolveActiveModel(context),
      disabledEntries: context.systemPromptDisabledEntries,
    });
  }

  private async readModelSettings(): Promise<ModelSettings> {
    const defaults: ModelSettings = { defaultModel: '', defaultThinkingLevel: 'medium' };
    try {
      const raw = await fs.readFile(path.join(this.agentDir, 'settings.json'), 'utf8');
      const parsed = parseJsonOrThrow<Partial<ModelSettings>>(raw, 'settings.json');
      const result: ModelSettings = {
        defaultModel: parsed.defaultModel ?? defaults.defaultModel,
        defaultThinkingLevel: (parsed.defaultThinkingLevel as ThinkingLevel) ?? defaults.defaultThinkingLevel,
      };
      if (typeof parsed.defaultProvider === 'string' && parsed.defaultProvider.length > 0) {
        result.defaultProvider = parsed.defaultProvider;
      }
      return result;
    } catch (error) {
      backendTrace('modelSettings', 'read.failed', { level: 'warn', error: toErrorMessage(error) });
      return defaults;
    }
  }

  /** Rewrite the SDK session's cached `_baseSystemPrompt` (and the structured
   *  `_baseSystemPromptOptions`) so the next turn sends a prompt with the
   *  disabled entries removed. The SDK reads `_baseSystemPrompt` each turn
   *  (falling back to it when no extension overrides), so this mutation takes
   *  effect on the next `message.send` without restarting the session.
   *
   *  The filtered options are always rebuilt from the unfiltered
   *  `_originalSystemPromptOptions` snapshot (captured before any filtering),
   *  never from the already-filtered live `_baseSystemPromptOptions`. This keeps
   *  re-enabling an entry a true inverse of disabling it (the prior behavior
   *  rebuilt from filtered options, so a toggled-off context file never came
   *  back) and lets rapid toggles compose instead of accumulating drift. */
  private async applySystemPromptTogglesToBasePrompt(
    context: SessionContext,
    disabledEntries: readonly string[],
  ): Promise<void> {
    const promptState = this.getSessionPromptState(context);
    // Capture the unfiltered snapshot from the live options before we touch
    // them. On the first toggle the live options are still the SDK's unfiltered
    // set, so this is the moment the full entry set is recorded. On later
    // toggles the live options are already filtered; `capture...` only refreshes
    // the snapshot when the live set is a superset of the cached one, so a
    // filtered set never clobbers it.
    captureOriginalSystemPromptOptions(promptState);
    const source = promptState._originalSystemPromptOptions ?? promptState._baseSystemPromptOptions;
    if (!source) return;

    try {
      const { buildSystemPrompt } = await this.getSystemPromptModule();
      const toggled = buildToggledSystemPrompt(source, disabledEntries, buildSystemPrompt);
      // Empty is intentional and valid when every entry is disabled. Do not
      // use a truthiness check here or the prior full prompt survives.
      promptState._baseSystemPrompt = toggled.prompt;
      // Keep the structured options in sync so downstream extensions (e.g. the
      // skill-pruner `before_agent_start` hook) see the filtered skill/context
      // sets instead of re-adding stripped sections from the original options.
      promptState._baseSystemPromptOptions = toggled.options;
    } catch (error) {
      // Leave the existing base prompt untouched if the SDK builder is not
      // available; sending the previous known prompt is safer than a partial
      // regex-only rewrite.
      backendTrace('systemPrompt', 'harnessRebuild.failed', { level: 'debug', error: toErrorMessage(error) });
    }
  }

  /** Apply autonomous-mode tool visibility to one live SDK session. */
  private applyAutonomousModeToContext(context: SessionContext, enabled: boolean): void {
    const active = context.session.getActiveToolNames?.()
      ?? context.session.getAllTools?.().map((tool) => tool.name)
      ?? [];

    if (enabled) {
      // Tools-off stores its prior provider schema outside the live active set.
      // Preserve that latent ask_user ownership too: Tools may be switched back
      // on while autonomous mode is still filtering the restoration call.
      const askUserWasCapturedByToolsToggle = (
        context.systemPromptDisabledEntries?.includes(TOOLS_ENTRY_ID) === true
        && context.systemPromptToolsBeforeDisable?.includes(ASK_USER_TOOL_NAME) === true
      );
      context.autonomousModeAskUserWasActive = (
        active.includes(ASK_USER_TOOL_NAME) || askUserWasCapturedByToolsToggle
      );
      if (active.includes(ASK_USER_TOOL_NAME)) {
        context.session.setActiveToolsByName?.(
          active.filter((name) => name !== ASK_USER_TOOL_NAME),
        );
      }
      return;
    }

    if (!context.autonomousModeAskUserWasActive) {
      context.autonomousModeAskUserWasActive = undefined;
      return;
    }

    // If the whole Tools entry is off, preserve the restoration intent in its
    // captured set. The Tools guard intentionally reduces every live update to
    // [], so restoring directly here would otherwise be forgotten.
    if (context.systemPromptDisabledEntries?.includes(TOOLS_ENTRY_ID)) {
      context.systemPromptToolsBeforeDisable = [
        ...new Set([...(context.systemPromptToolsBeforeDisable ?? []), ASK_USER_TOOL_NAME]),
      ];
      context.autonomousModeAskUserWasActive = undefined;
      return;
    }

    const configured = context.session.getAllTools?.().map((tool) => tool.name) ?? [];
    if (configured.includes(ASK_USER_TOOL_NAME) && !active.includes(ASK_USER_TOOL_NAME)) {
      context.session.setActiveToolsByName?.([...active, ASK_USER_TOOL_NAME]);
    }
    context.autonomousModeAskUserWasActive = undefined;
  }

  /** Update every live session immediately; newly created contexts read the
   * process-wide field while installing their tool guard. */
  private setAutonomousMode(enabled: boolean): void {
    if (this.autonomousMode === enabled) return;
    this.autonomousMode = enabled;
    for (const context of this.sessionContexts.values()) {
      this.applyAutonomousModeToContext(context, enabled);
    }
  }

  /** Apply a new disabled-entry set for a session: update the SessionContext,
   *  persist to the sidecar, rewrite the base prompt. (Re-emitting
   *  `session.opened` is the caller's responsibility — the RPC handler does it
   *  after this resolves.) The `disabledEntries` array is the complete set. */
  async applySystemPromptToggles(
    sessionPath: string,
    disabledEntries: readonly string[],
  ): Promise<void> {
    const previous = this.pendingSystemPromptToggleApplications.get(sessionPath) ?? Promise.resolve();
    const application = previous.catch(() => undefined).then(() => (
      this.applySystemPromptTogglesNow(sessionPath, disabledEntries)
    ));
    this.pendingSystemPromptToggleApplications.set(sessionPath, application);
    try {
      await application;
    } finally {
      if (this.pendingSystemPromptToggleApplications.get(sessionPath) === application) {
        this.pendingSystemPromptToggleApplications.delete(sessionPath);
      }
    }
  }

  private async applySystemPromptTogglesNow(
    sessionPath: string,
    disabledEntries: readonly string[],
  ): Promise<void> {
    const context = this.sessionContexts.get(sessionPath);
    if (!context) return;
    const next = [...new Set(disabledEntries)];
    const toolsWereDisabled = context.systemPromptDisabledEntries?.includes(TOOLS_ENTRY_ID) ?? false;
    const toolsWillBeDisabled = next.includes(TOOLS_ENTRY_ID);

    if (!toolsWereDisabled && toolsWillBeDisabled) {
      context.systemPromptToolsBeforeDisable = context.session.getActiveToolNames?.()
        ?? context.session.getAllTools?.().map((tool) => tool.name)
        ?? [];
    }

    // Update the live set before invoking setActiveToolsByName: the installed
    // guard consults it synchronously and prevents extensions from re-exposing
    // schemas while Tools is off.
    context.systemPromptDisabledEntries = next;
    if (!toolsWereDisabled && toolsWillBeDisabled) {
      context.session.setActiveToolsByName?.([]);
    } else if (toolsWereDisabled && !toolsWillBeDisabled) {
      const restore = context.systemPromptToolsBeforeDisable
        ?? context.session.getAllTools?.().map((tool) => tool.name)
        ?? [];
      context.session.setActiveToolsByName?.(restore);
      context.systemPromptToolsBeforeDisable = undefined;
    }

    await writeSystemPromptTogglesForSession(sessionPath, next);
    await this.applySystemPromptTogglesToBasePrompt(context, next);
  }

  private async writeModelSettings(updates: Partial<ModelSettings>): Promise<ModelSettings> {
    const settingsPath = path.join(this.agentDir, 'settings.json');
    // Model updates run in the backend while pruning updates run in the
    // extension host. Share the same cross-process lock so their
    // read-modify-write cycles cannot silently overwrite each other.
    await updateSettingsJsonObject(settingsPath, (existing) => ({ ...existing, ...updates }));
    return await this.readModelSettings();
  }

  private async emitSessionOpened(sessionPath: string, selectionToken?: string): Promise<void> {
    if (this.disposed || !this.sessionContexts.has(sessionPath)) {
      return;
    }
    // Rejection-safe: most callers fire-and-forget this (`void …`). A thrown
    // payload build (transcript scan, context usage, system prompts) must log
    // and swallow instead of becoming an unhandled rejection that leaves the
    // host waiting on a `session.opened` that never arrives.
    try {
      const payload = await this.buildSessionOpenedPayload(sessionPath, selectionToken);
      this.emit('session.opened', payload);
    } catch (error) {
      backendWarn('backend-session', 'emitSessionOpened.failed', {
        sessionPath,
        error: toErrorMessage(error),
      });
    }
  }

  private async buildSessionOpenedPayload(
    sessionPath: string,
    selectionToken?: string,
    transcript?: import('../shared/protocol').TranscriptMode,
  ): Promise<SessionOpenedPayload> {
    return await timed('buildSessionOpenedPayload', () => buildSessionOpenedPayloadHelper(sessionPath, {
      getContextUsage: (context) => this.getContextUsage(context),
      readHarnessSystemPrompt: (context) => this.readHarnessSystemPrompt(context),
      buildSystemPrompts: (context, override) => this.buildSystemPrompts(context, override),
      readModelSettings: () => this.readModelSettings(),
      getPinnedStreamingMessageId: (context) => this.getPinnedStreamingMessageId(context),
      getSessionContext: (path) => this.getSessionContext(path),
      agentDir: this.agentDir,
      startupCwd: this.startupCwd,
    }, selectionToken, transcript));
  }

  private async emitSessionListChanged(): Promise<void> {
    if (this.disposed) return;
    // Rejection-safe: most callers fire-and-forget this (`void …`). A thrown
    // session-list scan must log and swallow instead of becoming an unhandled
    // rejection; the next catalog poll/emit refreshes the list opportunistically.
    try {
      const payload: SessionListChangedPayload = {
        sessions: await this.listSessionSummaries(),
        activeSessionPath: this.viewedSessionPath,
      };
      this.emit('session.list.changed', payload);
    } catch (error) {
      backendWarn('backend-session', 'emitSessionListChanged.failed', {
        error: toErrorMessage(error),
      });
    }
  }

  private async listSessionSummaries(): Promise<SessionSummary[]> {
    const liveSummaries = [...this.sessionContexts.values()]
      .filter((context) => !context.retired)
      .map((context) => buildCurrentSummary(context, this.startupCwd));
    return await this.sessionCatalog.list(this.sdk, this.getSessionDir(), liveSummaries, this.agentDir);
  }

  /** Start durable closure reconciliation. The watcher is a low-latency hint;
   * an unconditional startup list and the bounded sidecar fingerprint poll are
   * the correctness paths, including after a backend restart. */
  private startReviewReconciliation(): void {
    ensureReviewsDir();
    this.refreshReviewSidecarState(true);
    this.stopReviewWatcher = startReviewWatcher(() => {
      this.refreshReviewSidecarState();
      void this.emitSessionListChanged();
    });
    this.startSessionCatalogPolling();
    void this.emitSessionListChanged();
  }

  /** Refresh parsed closure state only when its cheap file fingerprint moves.
   * `force` establishes the startup baseline even when construction happened
   * after PIE_REVIEWS_DIR was already configured. */
  private refreshReviewSidecarState(force = false): boolean {
    const fingerprint = getReviewSidecarFingerprint();
    const changed = fingerprint !== this.reviewSidecarFingerprint;
    if (force || changed) {
      this.reviewSidecarFingerprint = fingerprint;
      this.reviewClosureReconciliationPending = hasActiveReviewClosureActions();
    }
    return changed;
  }

  private startSessionCatalogPolling(intervalMs = SESSION_CATALOG_POLL_INTERVAL_MS): void {
    if (this.sessionCatalogPollTimer) return;
    this.sessionCatalogPollingActive = true;
    this.sessionCatalogPollTimer = setInterval(() => {
      void this.pollSessionCatalog();
    }, intervalMs);
    this.sessionCatalogPollTimer.unref();
  }

  private async pollSessionCatalog(): Promise<void> {
    if (!this.sessionCatalogPollingActive || this.sessionCatalogPollInFlight) return;
    this.sessionCatalogPollInFlight = true;
    let catalogChanged = false;
    try {
      catalogChanged = await this.sessionCatalog.invalidateIfInventoryChanged(
        this.agentDir,
        this.getSessionDir(),
      );
    } catch (error) {
      backendWarn('backend-session', 'catalogInventoryPoll.failed', {
        error: toErrorMessage(error),
      });
    }

    try {
      const sidecarChanged = this.refreshReviewSidecarState();
      // Cached active actions force a bounded retry even when a prior list scan
      // failed after the watcher/fingerprint wake was consumed. The cache is
      // reparsed only when the append-only sidecar fingerprint changes.
      if ((catalogChanged || sidecarChanged || this.reviewClosureReconciliationPending)
        && this.sessionCatalogPollingActive) {
        await this.emitSessionListChanged();
      }
    } finally {
      this.sessionCatalogPollInFlight = false;
    }
  }

  private emitBusyChanged(context: SessionContext, busy: boolean): void {
    context.busySeq += 1;
    const payload: BusyChangedPayload = {
      sessionPath: context.sessionPath,
      busy,
      seq: context.busySeq,
    };
    this.emit('busy.changed', payload);
  }

  private emit(event: string, payload?: unknown): void {
    // After disposal begins, suppress every event so in-flight async paths
    // (recovery replacement emissions, catalog polling, late SDK events) cannot
    // push stale state to a host that is already tearing the backend down.
    if (this.disposed) return;
    if (event === 'extension_ui.request' && payload && typeof payload === 'object') {
      const request = payload as { sessionPath?: unknown; id?: unknown };
      if (typeof request.sessionPath === 'string' && typeof request.id === 'string') {
        const context = this.sessionContexts.get(request.sessionPath);
        const accumulator = context?.activeRequest?.liveTurnAccumulator;
        if (accumulator) {
          if (context?.activeRequest?.semanticLeaseTimer) {
            clearTimeout(context.activeRequest.semanticLeaseTimer);
            context.activeRequest.semanticLeaseTimer = undefined;
          }
          this.emit('live.semantic', accumulator.observe({
            kind: 'turn.extensionUi', uiRequestId: request.id, action: 'opened',
          }, Date.now()));
        }
      }
    }
    if (isBackendLivePipelineTraceEnabled()) {
      const scoped = payload && typeof payload === 'object' ? payload as Record<string, unknown> : undefined;
      recordBackendLivePipelineTrace({
        stage: 'backend.mapped',
        kind: 'success',
        identifiers: {
          ...(typeof scoped?.sessionPath === 'string' ? { session: scoped.sessionPath } : {}),
          ...(typeof scoped?.requestId === 'string' ? { request: scoped.requestId } : {}),
          ...(typeof scoped?.turnId === 'string' ? { turn: scoped.turnId } : {}),
          ...(typeof scoped?.attemptId === 'string' ? { attempt: scoped.attemptId } : {}),
          ...(typeof scoped?.messageId === 'string' ? { message: scoped.messageId } : {}),
          ...(typeof scoped?.toolCallId === 'string' ? { tool: scoped.toolCallId } : {}),
        },
        eventKind: backendTraceEventKind(event),
        eventSeq: typeof scoped?.seq === 'number' && Number.isSafeInteger(scoped.seq) && scoped.seq >= 0
          ? scoped.seq
          : undefined,
      });
    }
    writeStdout({ event, payload });
  }

  private async handleLine(line: string): Promise<void> {
    let request: RequestEnvelope;
    try {
      request = parseJsonOrThrow<RequestEnvelope>(line, 'request envelope');
    } catch (error) {
      writeStdout(responseError('parse-error', 'PARSE_ERROR', String(error)));
      return;
    }

    backendTrace('request', 'received', { id: request.id, method: request.method });
    try {
      const result = await timed(`request:${request.method}:${request.id}`, () => this.handleRequest(request));
      backendTrace('request', 'handled', { id: request.id, method: request.method });
      writeStdout(responseOk(request.id, result));
    } catch (error) {
      const details = extractRequestError(error);
      backendTrace('request', 'error', { level: 'warn', id: request.id, method: request.method, code: details.code, message: details.message });
      writeStdout(responseError(request.id, details.code, details.message, details.data));
      this.emit('error', details);
    }
  }

  /** Retire a private session runtime and remove every durable session-side
   *  artifact. Called only after the host has chosen privacy mode; ordinary
   *  tab closes intentionally keep sessions reopenable. */
  private async forgetSession(sessionPath: string): Promise<void> {
    this.forgottenSessionPaths.add(sessionPath);
    const pending = this.pendingSessionContexts.get(sessionPath);
    if (pending) await pending.catch(() => undefined);
    const context = this.sessionContexts.get(sessionPath);
    if (context) {
      context.retired = true;
      context.sessionManagerFence?.invalidate();
      context.willRetryWatchdogClear?.();
      context.willRetryWatchdogClear = undefined;
      const active = context.activeRequest;
      if (active) {
        active.aborted = true;
        if (active.promptSafetyTimer) clearTimeout(active.promptSafetyTimer);
        if (active.semanticLeaseTimer) clearTimeout(active.semanticLeaseTimer);
        if (active.quotaSettlementTimer) clearTimeout(active.quotaSettlementTimer);
        active.pendingDurableToolTerminals?.clear();
        context.activeRequest = undefined;
        await Promise.race([
          Promise.resolve().then(() => context.session.abort()).catch(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
        ]);
      }
      try { context.uiBridge?.dispose(); } catch { /* best effort */ }
      try { context.unsubscribe(); } catch { /* best effort */ }
      try {
        await Promise.race([
          Promise.resolve(context.runtime.dispose()).catch(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
        ]);
      } finally {
        this.sessionContexts.delete(sessionPath);
      }
    }

    let transcriptDeleted = false;
    try {
      // Review/system-prompt sidecars are fallible and must be removed before
      // transcript deletion commits; otherwise a cleanup failure could leave a
      // recoverable private transcript with its forget tombstone removed.
      await forgetPrivateSessionArtifacts(sessionPath);
      transcriptDeleted = true;
      this.sessionCatalog.remove(sessionPath);
      if (this.viewedSessionPath === sessionPath) this.viewedSessionPath = undefined;
    } catch (error) {
      // Once transcript deletion commits the tombstone is permanent. There are
      // deliberately no fallible operations after that boundary.
      if (!transcriptDeleted) this.forgottenSessionPaths.delete(sessionPath);
      throw error;
    }
    // Keep the successful tombstone for the life of this backend process so a
    // queued session.open cannot recreate the deleted file after this RPC.
  }

  private async handleRequest(request: RequestEnvelope): Promise<unknown> {
    const sessionDir = this.getSessionDir();
    return await handleBackendRequest({
      sdkPath: this.sdkPath,
      agentDir: this.agentDir,
      startupCwd: this.startupCwd,
      sessionDir,
      sdk: this.sdk,
      getSessionContext: (sessionPath) => this.getSessionContext(sessionPath),
      createSessionContext: (sessionManager, reason) => this.createSessionContext(sessionManager, reason),
      ensureSessionContext: (sessionPath) => this.ensureSessionContext(sessionPath),
      setViewedSessionPath: (sessionPath) => {
        this.viewedSessionPath = sessionPath;
      },
      buildSessionOpenedPayload: (sessionPath, selectionToken, transcript) => (
        this.buildSessionOpenedPayload(sessionPath, selectionToken, transcript)
      ),
      applySystemPromptToggles: (sessionPath, disabledEntries) => (
        this.applySystemPromptToggles(sessionPath, disabledEntries)
      ),
      setAutonomousMode: (enabled) => this.setAutonomousMode(enabled),
      forgetSession: (sessionPath) => this.forgetSession(sessionPath),
      loadTranscriptPage: (sessionPath, direction, loadedStart, loadedEnd) => (
        this.loadTranscriptPage(sessionPath, direction, loadedStart, loadedEnd)
      ),
      loadDetail: (sessionPath, ref) => this.loadDetail(sessionPath, ref),
      emit: (event, payload) => this.emit(event, payload),
      emitBusyChanged: (context, busy) => this.emitBusyChanged(context, busy),
      emitContextUsageChanged: (sessionContext) => this.emitContextUsageChanged(sessionContext),
      emitSessionListChanged: () => this.emitSessionListChanged(),
      listSessions: () => this.listSessionSummaries(),
      listAvailableModels: (context) => listAvailableModels(context, this.agentDir),
      readModelSettings: () => this.readModelSettings(),
      writeModelSettings: (updates) => this.writeModelSettings(updates),
    }, request);
  }

  private handleSessionEvent(context: SessionContext, event: SdkSessionEvent): void {
    if (context.retired) return;
    handleSdkSessionEvent({
      emit: (name, payload) => this.emit(name, payload),
      emitBusyChanged: (sessionContext, busy) => this.emitBusyChanged(sessionContext, busy),
      emitContextUsageChanged: (sessionContext, postCompactionEstimatedTokens) => (
        this.emitContextUsageChanged(sessionContext, postCompactionEstimatedTokens)
      ),
      emitSessionOpened: (sessionPath, selectionToken) => this.emitSessionOpened(sessionPath, selectionToken),
      emitSessionListChanged: () => this.emitSessionListChanged(),
      recoverStuckSession: (sessionContext, reason) => {
        void this.recoverStuckSession(sessionContext, reason);
      },
    }, context, event);
  }

  /**
   * Locally terminalize a stuck runtime immediately, then replace it without
   * waiting for provider teardown. The old runtime is fenced before any async
   * work so late SDK events cannot revive or terminalize the request twice.
   */
  private recoverStuckSession(context: SessionContext, reason: string): void {
    if (context.retired || context.recoveryPromise) return;
    const active = context.activeRequest;
    if (!active) {
      return;
    }

    const requestId = active.id;
    const messageId = active.lastAssistantMessageId ?? active.currentMessageId;
    context.retired = true;
    const bestEffort = (operation: string, action: () => void): void => {
      try {
        action();
      } catch (error) {
        backendWarn('backend-session', `stuck runtime ${operation} failed`, {
          sessionPath: context.sessionPath,
          requestId,
          error: toErrorMessage(error),
        });
      }
    };
    bestEffort('session manager fence', () => context.sessionManagerFence?.invalidate());
    bestEffort('watchdog cleanup', () => context.willRetryWatchdogClear?.());
    context.willRetryWatchdogClear = undefined;
    if (active.promptSafetyTimer) clearTimeout(active.promptSafetyTimer);
    if (active.semanticLeaseTimer) clearTimeout(active.semanticLeaseTimer);
    if (active.quotaSettlementTimer) clearTimeout(active.quotaSettlementTimer);
    active.promptSafetyTimer = undefined;
    active.semanticLeaseTimer = undefined;
    active.quotaSettlementTimer = undefined;
    active.pendingDurableToolTerminals?.clear();
    active.aborted = true;
    if (active.liveTurnAccumulator) {
      context.terminalLiveTurn = {
        accumulator: active.liveTurnAccumulator,
        expiresAt: Date.now() + 10_000,
      };
    }
    context.activeRequest = undefined;
    bestEffort('UI disposal', () => context.uiBridge?.dispose());
    bestEffort('queue cleanup', () => { context.session.clearQueue(); });
    context.queuedLocalIds = [];
    bestEffort('retry abort', () => context.session.abortRetry?.());
    bestEffort('compaction abort', () => context.session.abortCompaction?.());
    bestEffort('branch-summary abort', () => context.session.abortBranchSummary?.());
    bestEffort('bash abort', () => context.session.abortBash?.());

    this.emit('message.aborted', {
      requestId,
      sessionPath: context.sessionPath,
      messageId,
      userInitiated: false,
      reason,
    } satisfies MessageAbortedPayload);

    let abortGraceTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = Promise.resolve()
      .then(() => context.session.abort())
      .then(
        () => 'settled' as const,
        (error) => {
          backendWarn('backend-session', 'stuck runtime abort failed', {
            sessionPath: context.sessionPath,
            requestId,
            error: toErrorMessage(error),
          });
          return 'failed' as const;
        },
      );
    const abortGrace = new Promise<'timeout'>((resolve) => {
      abortGraceTimer = setTimeout(() => resolve('timeout'), 5_000);
      abortGraceTimer.unref?.();
    });
    void Promise.race([abort, abortGrace]).then((outcome) => {
      if (abortGraceTimer) clearTimeout(abortGraceTimer);
      if (outcome === 'timeout') {
        backendWarn('backend-session', 'stuck runtime abort did not settle within grace', {
          sessionPath: context.sessionPath,
          requestId,
        });
      }
    });

    const replacementPromise = Promise.resolve()
      .then(() => this.createSessionContext(
        this.sdk.SessionManager.open(context.sessionPath),
        'resume',
      ))
      .then(async (replacement) => {
        this.emitBusyChanged(replacement, false);
        await Promise.allSettled([
          this.emitSessionOpened(replacement.sessionPath),
          this.emitSessionListChanged(),
        ]);
        return replacement;
      });
    context.recoveryPromise = replacementPromise;
    void replacementPromise.catch((error) => {
      this.emit('operational-error', {
        code: 'SESSION_RUNTIME_RECOVERY_FAILED',
        message: `Failed to replace the stuck session runtime: ${toErrorMessage(error)}`,
        sessionPath: context.sessionPath,
        requestId,
      });
    });
  }

  async dispose(): Promise<void> {
    // Idempotent: stdin-end and host dispose (or a re-entrant call) must not
    // run teardown twice. The flag also suppresses stale events from in-flight
    // async paths via the `disposed` guard on `emit`/`emitSessionOpened`/
    // `emitSessionListChanged`.
    if (this.disposed) return;
    this.disposed = true;
    this.stopHostWatchdog();

    const contexts = [...this.sessionContexts.values()];
    this.sessionContexts.clear();

    // Reject provider waiters and clear referenced queue/afterburn timers even
    // when an SDK runtime ignores abort during shutdown. The global fetch
    // wrapper is process-owned, so server disposal is its production teardown.
    ProviderGate.uninstall();

    this.sessionCatalogPollingActive = false;
    if (this.sessionCatalogPollTimer) clearInterval(this.sessionCatalogPollTimer);
    this.sessionCatalogPollTimer = undefined;
    this.stopReviewWatcher?.();
    this.stopReviewWatcher = undefined;
    this.stopProviderProgressObserver?.();
    this.stopProviderProgressObserver = undefined;
    this.stopProviderIncidentObserver?.();
    this.stopProviderIncidentObserver = undefined;
    this.providerAttemptOwners.clear();

    // Teardown is best-effort per context: one cleanup that throws or rejects
    // must not strand this context's remaining cleanup or any later context.
    const runCleanup = (label: string, action: () => void): void => {
      try {
        action();
      } catch (err) {
        log(`${label} failed: ${String(err)}`);
      }
    };

    // Clear every active-request/watchdog timer a context may still hold. These
    // are `unref`'d so they do not keep the process alive, but a late fire
    // would touch retired/freed state (prompt-safety abort, semantic-lease
    // recovery, quota settlement, retry-stuck watchdog). The watchdog clear fn
    // is the primary path; the direct handle clear is belt-and-suspenders for a
    // missing or already-invoked clear fn.
    const clearContextTimers = (context: SessionContext): void => {
      runCleanup('session retry-watchdog cleanup', () => context.willRetryWatchdogClear?.());
      context.willRetryWatchdogClear = undefined;
      if (context.willRetryWatchdogTimer) {
        clearTimeout(context.willRetryWatchdogTimer);
        context.willRetryWatchdogTimer = undefined;
      }
      const active = context.activeRequest;
      if (active) {
        if (active.promptSafetyTimer) {
          clearTimeout(active.promptSafetyTimer);
          active.promptSafetyTimer = undefined;
        }
        if (active.semanticLeaseTimer) {
          clearTimeout(active.semanticLeaseTimer);
          active.semanticLeaseTimer = undefined;
        }
        if (active.quotaSettlementTimer) {
          clearTimeout(active.quotaSettlementTimer);
          active.quotaSettlementTimer = undefined;
        }
        active.pendingDurableToolTerminals?.clear();
      }
    };

    // Bound `runtime.dispose()` so a wedged provider teardown can never block
    // shutdown. Mirrors the replacement-path grace in `createSessionContext`
    // (resolveRuntimeDisposeGraceMs) so shutdown and recovery share one bound.
    const disposeRuntimeBounded = (context: SessionContext): Promise<void> => {
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<void>((resolve) => {
        graceTimer = setTimeout(resolve, resolveRuntimeDisposeGraceMs());
        graceTimer.unref?.();
      });
      let dispose: Promise<void>;
      try {
        dispose = Promise.resolve(context.runtime.dispose());
      } catch (error) {
        backendWarn('backend-session', 'session runtime dispose threw', {
          sessionPath: context.sessionPath,
          error: toErrorMessage(error),
        });
        dispose = Promise.resolve();
      }
      return Promise.race([dispose, grace])
        .catch((error) => {
          backendWarn('backend-session', 'session runtime dispose failed', {
            sessionPath: context.sessionPath,
            error: toErrorMessage(error),
          });
        })
        .finally(() => {
          if (graceTimer) clearTimeout(graceTimer);
        });
    };

    const teardownContext = async (context: SessionContext): Promise<void> => {
      clearContextTimers(context);
      runCleanup('session UI bridge dispose', () => context.uiBridge?.dispose());
      runCleanup('session event unsubscribe', () => context.unsubscribe());
      runCleanup('session manager fence invalidation', () => context.sessionManagerFence?.invalidate());
      await disposeRuntimeBounded(context);
    };

    for (const context of contexts) {
      await teardownContext(context);
    }

    // Handle in-flight recovery replacement contexts. A retired context may
    // have a replacement runtime being constructed asynchronously by
    // `recoverStuckSession` (or the abort-replacement path in request-handler);
    // the snapshot above predates that replacement (the map was cleared), so
    // its freshly created runtime would otherwise leak and its post-replacement
    // emissions would fire post-shutdown. Await each in-flight recovery
    // (bounded) and tear down the replacement runtime too. The `disposed` guard
    // on `emit`/`emitSessionOpened`/`emitSessionListChanged` makes the
    // recovery's post-replacement emissions no-ops.
    const inFlightRecoveries = contexts
      .map((context) => context.recoveryPromise)
      .filter((recovery): recovery is Promise<SessionContext> => Boolean(recovery));
    if (inFlightRecoveries.length > 0) {
      await Promise.allSettled(inFlightRecoveries.map(async (recovery) => {
        let waitTimer: ReturnType<typeof setTimeout> | undefined;
        const waitGrace = new Promise<SessionContext | null>((resolve) => {
          waitTimer = setTimeout(() => resolve(null), resolveRuntimeDisposeGraceMs());
          waitTimer.unref?.();
        });
        let replacement: SessionContext | null;
        try {
          replacement = await Promise.race([recovery, waitGrace]);
        } catch {
          // Recovery failed; its own .catch already surfaced the error (now
          // suppressed by the `disposed` guard). Nothing left to tear down.
          replacement = null;
        } finally {
          if (waitTimer) clearTimeout(waitTimer);
        }
        if (replacement) {
          await teardownContext(replacement);
        }
      }));
    }
  }
}

function backendTraceEventKind(event: string) {
  if (event === 'message.delta') return 'text' as const;
  if (event === 'message.thinking') return 'reasoning' as const;
  if (event === 'message.toolCallDelta') return 'tool_draft' as const;
  if (event === 'tool.started') return 'tool_start' as const;
  if (event === 'tool.progress') return 'tool_progress' as const;
  if (event === 'tool.finished') return 'tool_terminal' as const;
  if (event === 'message.started') return 'turn_start' as const;
  if (event === 'message.finished' || event === 'message.aborted') return 'turn_terminal' as const;
  return 'control' as const;
}
