import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { rewritePieHarnessPrompt } from '../../../shared/pie-harness-prompt.js';
import {
  EXTENSION_TOGGLES_ENV,
  HISTORY_COMPACTION_ENV,
  PROVIDER_TOGGLES_ENV,
  SUBAGENT_PROVIDER_DEFAULTS_ENV,
  SUBAGENT_PROVIDER_TOGGLES_ENV,
  SUBAGENT_ROUTE_AROUND_SATURATED_PROVIDERS_ENV,
  SUBAGENT_FALLBACK_ON_PROVIDER_FAILURE_ENV,
  SUBAGENT_BUCKETS_ENV,
  NESTED_ALLOWED_BUCKETS_ENV,
  type DetailResult,
  type LazyDetailRef,
  type ChatMessage,
  type ModelInfo,
  type ModelSettings,
  type RequestEnvelope,
  type SessionOpenedPayload,
  TranscriptPageDirection,
  TranscriptPagePayload,
} from '../shared/protocol';
import { deduplicateToolCallResultsForTransport } from '../shared/chat-message-parts';
import { compactDurableMessageForTransport, findDurableDetail } from '../shared/lazy-details';
import { LIVE_PIPELINE_LIMITS } from '../shared/live-pipeline-protocol';
import { deriveContextUsageFromBranch } from './context-usage';
import { resolveActiveModel } from './session-metadata';
import { ExtensionUIBridge } from './extension-ui-bridge';
import { installAuxiliaryLlmMeter } from './auxiliary-llm-meter';
import { handleBackendRequest } from './request-handler';
import { createRuntimeFactory, ServiceLoadingGate } from './runtime-factory';
import { handleSdkSessionEvent } from './session-event-handler';
import {
  buildSessionOpenedPayload as buildSessionOpenedPayloadHelper,
  ensureDisplayTranscriptCache,
  normalizeDanglingTranscript,
} from './session-opened';
import { AUTONOMOUS_MODE_ENV, ASK_USER_TOOL_NAME } from '../../../shared/autonomous-mode.js';
import { buildPagedTranscriptWindow } from './transcript-window';
import type {
  SdkModule,
  SdkSessionEvent,
  SdkSessionOwnershipAdapter,
  SdkSessionOwnershipReservation,
  SdkSystemPromptModule,
  SdkSessionReplacementIntent,
  SdkSessionTransferAuthorization,
  SdkSessionWriteLease,
  SdkWorkerOwnershipIdentity,
} from './sdk';
import { loadSdk, loadSdkInternalModule } from './sdk';
import type { SdkPatchIdentity } from './sdk-patch-barrier';
import type { SessionContext, SessionContextCreationReason, SessionPromptState } from './server-types';
import { ProviderGate } from './provider-gate';
import { readSystemPromptTogglesForSession, writeSystemPromptTogglesForSession } from './system-prompt-toggle-store';
import {
  buildSessionSystemPrompts,
  buildToggledSystemPrompt,
  captureOriginalSystemPromptOptions,
  installAutonomousModeToolGuard,
  installSystemPromptToggleRebuildGuard,
  installSystemPromptToolToggleGuard,
  markDisabledEntries,
  normalizePromptText,
  TOOLS_ENTRY_ID,
} from './system-prompts';
import type { DetailCursor, DetailPageRef, LiveSubagentDetailAddress } from '../shared/protocol/subagent-detail.js';
import type { WorkerRuntimeOperation, WorkerJsonObject, WorkerJsonValue } from './worker-protocol';
import { WORKER_IPC_MAX_ORDINARY_FRAME_BYTES } from './worker-protocol';
import { WorkerServer } from './worker-server';
import { installWorkerProviderNetworkLease } from './worker-provider-network-lease';
import { WorkerLiveDetailStore } from './worker-live-detail-store';

export interface WorkerRuntimePromotionPayload extends WorkerJsonObject {
  sdkPath: string;
  agentDir: string;
  startupCwd: string;
  sessionDir: string;
  sessionPath: string;
  creationReason: 'new' | 'resume';
  writeLease: WorkerJsonObject;
  openedPayload: WorkerJsonObject;
  modelSettings: WorkerJsonObject;
}

export interface WorkerRuntimeHostOptions {
  server: WorkerServer;
  owner: SdkWorkerOwnershipIdentity;
  patchIdentity: SdkPatchIdentity;
}

/**
 * Wire headroom reserved for the frame identity fields that surround the
 * terminal message projection (frame base, event wrapper, live-pipeline
 * envelope). The projection budget is the ordinary-frame ceiling minus this
 * margin, so a bounded `turn.terminal` can never be rejected by the writer.
 */
const WORKER_IPC_TERMINAL_MESSAGE_MARGIN = 24 * 1024;
const WORKER_IPC_TERMINAL_MESSAGE_BUDGET =
  WORKER_IPC_MAX_ORDINARY_FRAME_BYTES - WORKER_IPC_TERMINAL_MESSAGE_MARGIN;
/** Same ceiling headroom for a single text/reasoning delta envelope. */
const WORKER_IPC_DELTA_BUDGET = WORKER_IPC_TERMINAL_MESSAGE_BUDGET;

/**
 * Focused per-root execution owner. It deliberately does not embed or start a
 * BackendServer: one host owns exactly one SDK runtime, SessionContext,
 * subscription, ExtensionUIBridge, live accumulator state, and command FIFO.
 */
export class WorkerRuntimeHost {
  private sdk?: SdkModule;
  private context?: SessionContext;
  private promotion?: Promise<void>;
  private disposed = false;
  private commandTail = Promise.resolve();
  private settings: ModelSettings = { defaultModel: '', defaultThinkingLevel: 'medium' };
  private openedPayload?: SessionOpenedPayload;
  private agentDir = '';
  private startupCwd = '';
  private sessionDir = '';
  private uninstallNetworkLease?: () => void;
  private currentLease?: SdkSessionWriteLease;
  private readonly syncRevisions = new Map<string, number>();
  private readonly syncPayloads = new Map<string, WorkerJsonObject>();
  private syncedAuthPath?: string;
  private syncedAuthFingerprint?: string;
  /** Configured catalog authority snapshot consumed from coordinator sync. */
  private syncedCatalogModels?: ModelInfo[];
  private readonly committedAuthorizations = new Map<string, SdkSessionTransferAuthorization>();
  private readonly gate = new ServiceLoadingGate();
  private systemPromptModule?: Promise<SdkSystemPromptModule>;
  private autonomousMode = false;
  private readonly detailStore: WorkerLiveDetailStore;

  constructor(private readonly options: WorkerRuntimeHostOptions) {
    this.detailStore = new WorkerLiveDetailStore({
      emit: (frame) => this.options.server.sendDetailFrame(frame),
    });
  }

  subscribeDetail(requestId: string, subscriptionId: string, address: LiveSubagentDetailAddress, cursor: DetailCursor | undefined, maxPageBytes: number): void {
    this.detailStore.subscribe(requestId, subscriptionId, address, cursor, maxPageBytes);
  }

  unsubscribeDetail(requestId: string, subscriptionId: string): void {
    this.detailStore.unsubscribe(requestId, subscriptionId);
  }

  fetchDetail(requestId: string, subscriptionId: string, address: LiveSubagentDetailAddress, ref: DetailPageRef, maxPageBytes: number): void {
    this.detailStore.fetch(requestId, subscriptionId, address, ref, maxPageBytes);
  }

  applySync(domain: string, revision: number, payload: WorkerJsonObject): void {
    const current = this.syncRevisions.get(domain) ?? 0;
    if (!Number.isSafeInteger(revision) || revision <= current) throw new Error(`Stale worker sync revision for ${domain}.`);
    this.syncRevisions.set(domain, revision);
    this.syncPayloads.set(domain, payload);
    if (domain === 'settings' && payload.values && typeof payload.values === 'object' && !Array.isArray(payload.values)) {
      this.settings = { ...this.settings, ...(payload.values as unknown as Partial<ModelSettings>) };
    } else if (domain === 'catalog' && Array.isArray(payload.models)) {
      // Consume the configured catalog authority snapshot. It is the fallback
      // for `models.list` when the runtime registry is unavailable; the
      // coordinator remains the authority and never replaces it with the
      // worker's runtime discovery reports.
      this.syncedCatalogModels = payload.models as unknown as ModelInfo[];
    } else if (domain === 'auth') {
      if (typeof payload.authPath !== 'string' || typeof payload.fingerprint !== 'string') throw new Error('Invalid auth sync payload.');
      this.syncedAuthPath = payload.authPath;
      this.syncedAuthFingerprint = payload.fingerprint;
    } else if (domain === 'runtimePrefs' && payload.values && typeof payload.values === 'object' && !Array.isArray(payload.values)) {
      this.applyRuntimePrefs(payload.values as WorkerJsonObject);
    } else if (domain === 'providerPolicy' && payload.providers && typeof payload.providers === 'object' && !Array.isArray(payload.providers)) {
      ProviderGate.getInstance()?.applyUserOverrides(payload.providers as never);
    }
  }

  async promote(payload: WorkerRuntimePromotionPayload): Promise<void> {
    if (this.disposed) throw new Error('Worker runtime host is disposed.');
    if (this.promotion) return await this.promotion;
    this.promotion = this.promoteOnce(payload);
    return await this.promotion;
  }

  command(operation: WorkerRuntimeOperation, payload: WorkerJsonObject, publicRequestId: string): Promise<WorkerJsonValue> {
    const owned = this.commandTail.then(async () => {
      if (!this.context || !this.sdk) throw new Error('Worker runtime is not promoted.');
      const params = (payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params))
        ? payload.params
        : payload;
      if (operation === 'test.extensionCommand') {
        if (process.env.PIE_PHASE2_PACKAGE_SMOKE !== '1' || typeof params.command !== 'string') {
          throw new Error('Extension command dispatch is available only to the packaged worker smoke.');
        }
        await this.context.session.prompt(params.command, { source: 'rpc' });
        return asWorkerJson({ sessionPath: this.context.sessionPath });
      }
      return asWorkerJson(await handleBackendRequest(this.requestDeps(), {
        id: publicRequestId,
        method: operation,
        params,
      } as RequestEnvelope));
    });
    this.commandTail = owned.then(() => undefined, () => undefined);
    return owned;
  }

  async interrupt(): Promise<{ interrupted: boolean; settled?: boolean; alreadyStopped?: boolean }> {
    const context = this.context;
    if (!context) return { interrupted: false, alreadyStopped: true };
    const running = !!context.activeRequest || context.session.isStreaming || context.session.isCompacting
      || context.session.isRetrying || context.session.isBashRunning;
    const interruptedRequest = context.activeRequest;
    const interruptedExtensionCommand = context.pendingExtensionCommand;
    context.uiBridge?.cancelAll();
    context.session.clearQueue();
    context.queuedLocalIds = [];
    if (!running) return { interrupted: false, alreadyStopped: true };
    if (context.activeRequest) context.activeRequest.aborted = true;
    context.session.abortCompaction?.();
    context.session.abortBranchSummary?.();
    context.session.abortBash?.();
    context.session.abortRetry?.();
    await context.session.abort();
    // Some SDK adapters resolve abort without producing agent_end for a slash
    // command that never started an agent turn. Close that still-owned early
    // ack locally; normal agent turns remain on the SDK event lifecycle.
    if (interruptedExtensionCommand
      && context.pendingExtensionCommand === interruptedExtensionCommand
      && (!interruptedRequest || context.activeRequest === interruptedRequest)
      && (!interruptedRequest
        || (interruptedRequest.messageIndex === 0
          && !interruptedRequest.lastAssistantMessageId
          && !interruptedRequest.currentMessageId))) {
      if (interruptedRequest?.promptSafetyTimer) clearTimeout(interruptedRequest.promptSafetyTimer);
      if (interruptedRequest?.semanticLeaseTimer) clearTimeout(interruptedRequest.semanticLeaseTimer);
      if (interruptedRequest?.quotaSettlementTimer) clearTimeout(interruptedRequest.quotaSettlementTimer);
      if (interruptedRequest) {
        interruptedRequest.promptSafetyTimer = undefined;
        interruptedRequest.semanticLeaseTimer = undefined;
        interruptedRequest.quotaSettlementTimer = undefined;
        interruptedRequest.pendingDurableToolTerminals?.clear();
      }
      this.emit('preflight.failed', {
        requestId: interruptedExtensionCommand.requestId,
        sessionPath: interruptedExtensionCommand.sessionPath,
        error: 'Extension command was interrupted before starting an agent turn.',
      });
      context.pendingExtensionCommand = undefined;
      context.activeRequest = undefined;
      this.emitBusyChanged(context, false);
    }
    return { interrupted: true, settled: true };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.gate.dispose();
    const context = this.context;
    this.context = undefined;
    if (context) {
      context.retired = true;
      context.uiBridge?.dispose();
      context.unsubscribe();
      context.session.sessionManager.revokePieWriteLease?.();
      await context.runtime.dispose();
    }
    this.detailStore.dispose();
    ProviderGate.uninstall();
    this.uninstallNetworkLease?.();
    this.uninstallNetworkLease = undefined;
  }

  private async promoteOnce(payload: WorkerRuntimePromotionPayload): Promise<void> {
    this.assertPromotionPayload(payload);
    this.agentDir = payload.agentDir;
    this.startupCwd = payload.startupCwd;
    this.sessionDir = payload.sessionDir;
    this.settings = {
      ...(payload.modelSettings as unknown as ModelSettings),
      ...this.settings,
    };
    this.openedPayload = payload.openedPayload as unknown as SessionOpenedPayload;
    this.currentLease = payload.writeLease as unknown as SdkSessionWriteLease;

    this.uninstallNetworkLease = installWorkerProviderNetworkLease({
      acquire: async (requestId, request) => {
        const response = await this.options.server.requestFrame(
          { kind: 'provider.acquire', request },
          'provider.granted',
          requestId,
        );
        return { leaseId: response.lease.leaseId };
      },
      cancel: async (targetRequestId, reason) => {
        await this.options.server.requestFrame(
          { kind: 'provider.cancel', targetRequestId, reason },
          'provider.cancelAck',
        );
      },
      observe: (leaseId, observation) => {
        this.options.server.sendFrame({ kind: 'provider.observation', leaseId, observation });
      },
      release: async (leaseId, outcome) => {
        await this.options.server.requestFrame({ kind: 'provider.release', leaseId, outcome }, 'provider.released');
      },
    }, () => ({
      provider: this.context?.activeRequest?.provider ?? this.context?.session.model?.provider,
      model: this.context?.activeRequest?.modelId ?? this.context?.session.model?.id,
      turnId: this.context?.activeRequest?.id,
      attemptId: this.context?.activeRequest?.id,
    }));

    this.sdk = await loadSdk(payload.sdkPath, { mode: 'worker', patchIdentity: this.options.patchIdentity });
    // Isolated workers perform provider I/O but never install an independent
    // ProviderGate admission/circuit. The coordinator lease above is the sole
    // cross-worker capacity and circuit authority.
    const syncedRuntimePrefs = this.syncPayloads.get('runtimePrefs')?.values;
    if (syncedRuntimePrefs && typeof syncedRuntimePrefs === 'object' && !Array.isArray(syncedRuntimePrefs)) {
      this.applyRuntimePrefs(syncedRuntimePrefs as WorkerJsonObject);
    }
    const syncedProviderPolicy = this.syncPayloads.get('providerPolicy')?.providers;
    if (syncedProviderPolicy && typeof syncedProviderPolicy === 'object' && !Array.isArray(syncedProviderPolicy)) {
      ProviderGate.getInstance()?.applyUserOverrides(syncedProviderPolicy as never);
    }
    const authPath = this.syncedAuthPath ?? resolveAuthPath(this.agentDir);
    await fs.mkdir(path.dirname(authPath), { recursive: true });
    if (this.syncedAuthFingerprint && this.syncedAuthFingerprint !== 'startup-unavailable') {
      const fingerprint = await fs.stat(authPath)
        .then((stat) => `${stat.size}:${stat.mtimeMs}`)
        .catch(() => 'missing');
      if (fingerprint !== this.syncedAuthFingerprint) throw new Error('Authoritative auth revision changed during worker promotion.');
    }
    const authStorage = this.sdk.AuthStorage.create(authPath);
    // Open with the exact canonical spelling carried by the lease. The pinned
    // SDK's fail-closed shape check intentionally compares path.resolve()
    // spellings before it delegates to the adapter (important on Windows 8.3
    // temp paths), so reopening the non-canonical grant alias would fail.
    const manager = this.sdk.SessionManager.open(this.currentLease.canonicalSessionPath);
    const runtime = await this.sdk.createAgentSessionRuntime(
      createRuntimeFactory(this.sdk, authStorage, this.startupCwd, this.gate),
      {
        cwd: manager.getCwd() || this.startupCwd,
        agentDir: this.agentDir,
        sessionManager: manager,
        ownershipAdapter: this.createOwnershipAdapter(),
        writeLease: this.currentLease,
        sessionStartEvent: { type: 'session_start', reason: payload.creationReason },
      },
    );
    const session = runtime.session;
    const sessionPath = session.sessionFile ?? session.sessionManager.getSessionFile();
    if (!sessionPath || !sameSessionPath(sessionPath, this.currentLease.canonicalSessionPath)) {
      await runtime.dispose();
      throw new Error('Promoted runtime path does not match its coordinator write lease.');
    }
    const context: SessionContext = {
      runtime,
      session,
      sessionPath,
      sessionOwnershipEpoch: 0,
      unsubscribe: () => undefined,
      busySeq: 0,
    };
    this.context = context;
    runtime.setRebindSession?.(async (replacement) => {
      await this.bindSession(context, replacement);
      this.emit('session.opened', { ...this.openedPayload, runtimeReady: true });
    });
    await this.bindSession(context, session);

    // This publication is sequenced before runtime.ready. The router waits for
    // runtime.ready before dispatching the initiating command, therefore the
    // host observes runtime-hydrated session.opened before any stream event.
    this.emit('session.opened', { ...this.openedPayload, runtimeReady: true });
    this.reportRuntimeCatalog();
  }

  private async bindSession(context: SessionContext, session: SessionContext['session']): Promise<void> {
    const previousSession = context.session;
    const previousSessionPath = context.sessionPath;
    const previousSessionOwnershipEpoch = context.sessionOwnershipEpoch ?? 0;
    const previousActiveRequest = context.activeRequest;
    const pendingExtensionCommand = context.pendingExtensionCommand;
    const pendingExtensionCommandOwned = pendingExtensionCommand?.session === previousSession
      && pendingExtensionCommand.sessionPath === previousSessionPath
      && pendingExtensionCommand.sessionOwnershipEpoch === previousSessionOwnershipEpoch;
    const sessionPath = session.sessionFile ?? session.sessionManager.getSessionFile();
    if (!sessionPath) throw new Error('Replacement session did not expose a path.');
    // A replacement can be initiated by an extension command before the SDK
    // emits agent_end/message_start. Close the source's busy window while its
    // path still identifies the source; otherwise the replacement's later
    // callbacks can leave an unmatched busy=true on the source path.
    if (previousActiveRequest || pendingExtensionCommandOwned || previousSession.isStreaming || previousSession.isCompacting
      || previousSession.isRetrying || previousSession.isBashRunning) {
      this.emitBusyChanged(context, false);
    }
    // The public message.send already acknowledged this request, but the
    // replacement itself prevents the source prompt from ever reaching an
    // agent message_start. Close that host-side promoted send on the source
    // path; late preflight/final callbacks are fenced by the epoch below.
    if (pendingExtensionCommandOwned && (!previousActiveRequest
      || (previousActiveRequest.messageIndex === 0
        && !previousActiveRequest.lastAssistantMessageId
        && !previousActiveRequest.currentMessageId))) {
      this.emit('preflight.failed', {
        requestId: pendingExtensionCommand!.requestId,
        sessionPath: previousSessionPath,
        error: 'Extension command replaced the session before starting an agent turn.',
      });
      context.pendingExtensionCommand = undefined;
    }
    if (pendingExtensionCommandOwned) context.pendingExtensionCommand = undefined;
    context.sessionOwnershipEpoch = previousSessionOwnershipEpoch + 1;
    try { context.unsubscribe(); } catch { /* initial placeholder or old subscription */ }
    try { context.uiBridge?.dispose(); } catch { /* old session UI is no longer authoritative */ }
    if (context.activeRequest?.promptSafetyTimer) clearTimeout(context.activeRequest.promptSafetyTimer);
    if (context.activeRequest?.semanticLeaseTimer) clearTimeout(context.activeRequest.semanticLeaseTimer);
    if (context.activeRequest?.quotaSettlementTimer) clearTimeout(context.activeRequest.quotaSettlementTimer);
    context.activeRequest?.pendingDurableToolTerminals?.clear();
    context.willRetryWatchdogClear?.();
    if (context.willRetryWatchdogTimer) clearTimeout(context.willRetryWatchdogTimer);
    context.session = session;
    context.sessionPath = sessionPath;
    context.activeRequest = undefined;
    if (!sameSessionPath(previousSessionPath, sessionPath)) {
      context.busySeq = 0;
      context.lastContextUsage = undefined;
      context.postCompactionEstimatedTokens = undefined;
      context.compactionStartedAt = undefined;
    }
    context.queuedLocalIds = [];
    context.terminalLiveTurn = undefined;
    context.willRetryWatchdogTimer = undefined;
    context.willRetryWatchdogClear = undefined;
    context.autonomousModeAskUserWasActive = undefined;
    context.systemPromptToolsBeforeDisable = undefined;
    context.displayTranscriptCache = undefined;
    const persistedPromptToggles = await readSystemPromptTogglesForSession(sessionPath);
    context.systemPromptDisabledEntries = [];
    const promptState = session as typeof session & SessionPromptState;
    if (typeof promptState._rebuildSystemPrompt === 'function') {
      const { buildSystemPrompt } = await this.getSystemPromptModule();
      installSystemPromptToggleRebuildGuard(promptState, () => context.systemPromptDisabledEntries ?? [], buildSystemPrompt);
    }
    installSystemPromptToolToggleGuard(session, () => context.systemPromptDisabledEntries ?? []);
    installAutonomousModeToolGuard(session, () => this.autonomousMode);
    if (persistedPromptToggles.length > 0) {
      await this.applySystemPromptToggles(context, persistedPromptToggles);
    }
    if (this.autonomousMode) this.applyAutonomousModeToContext(context, true);
    const uiBridge = new ExtensionUIBridge(sessionPath, (event, eventPayload) => this.emit(event, eventPayload));
    context.uiBridge = uiBridge;
    const { newSession, fork, switchSession } = context.runtime;
    if (!newSession || !fork || !switchSession) {
      throw new Error('Worker runtime does not expose the complete extension command replacement surface.');
    }
    await session.bindExtensions({
      uiContext: uiBridge,
      mode: 'rpc',
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: async (options) => newSession.call(context.runtime, options),
        fork: async (entryId, options) => {
          const result = await fork.call(context.runtime, entryId, options);
          return { cancelled: result.cancelled };
        },
        navigateTree: async (targetId, options) => {
          const result = await session.navigateTree(targetId, {
            summarize: options?.summarize,
            customInstructions: options?.customInstructions,
            replaceInstructions: options?.replaceInstructions,
            label: options?.label,
          });
          return { cancelled: result.cancelled };
        },
        switchSession: async (targetSessionPath, options) => (
          switchSession.call(context.runtime, targetSessionPath, options)
        ),
        reload: async () => { await session.reload(); },
      },
      // The embedded backend has no process-level extension shutdown command;
      // preserve the existing worker lifecycle owner rather than letting an
      // extension tear down only its SessionContext behind the coordinator.
      shutdownHandler: () => undefined,
      onError: (error) => this.emit('operational-error', {
        incidentId: `extension:${this.options.owner.workerId}:${Date.now()}`,
        code: 'EXTENSION_ERROR',
        message: `${error.extensionPath} (${error.event}): ${error.error}`,
        sessionPath: context.sessionPath,
      }),
    });
    installAuxiliaryLlmMeter(session, sessionPath, (event, eventPayload) => this.emit(event, eventPayload));
    context.unsubscribe = session.subscribe((event: SdkSessionEvent) => this.handleSessionEvent(context, event));
    if (this.openedPayload) {
      const previous = this.openedPayload;
      const replacementSource = previousSessionPath && !sameSessionPath(previousSessionPath, sessionPath)
        ? previousSessionPath
        : undefined;
      this.openedPayload = await this.buildOpenedPayload(
        sessionPath,
        replacementSource ? undefined : previous.selectionToken,
        replacementSource ? undefined : previous.operationId,
        replacementSource ? undefined : previous.operationAttempt,
      );
      if (replacementSource) {
        this.openedPayload = { ...this.openedPayload, replacesSessionPath: replacementSource };
      }
    }
  }

  private createOwnershipAdapter(): SdkSessionOwnershipAdapter {
    return {
      reserveReplacement: async (intent: SdkSessionReplacementIntent): Promise<SdkSessionOwnershipReservation> => {
        const response = await this.options.server.requestFrame({ kind: 'ownership.reserve', intent }, 'ownership.reserved');
        return response.reservation;
      },
      abortPrecommit: async (reservation, reason) => {
        await this.options.server.requestFrame({ kind: 'ownership.abort', reservation, reason }, 'ownership.aborted');
      },
      commitTransfer: async (reservation, sourceLease) => {
        const response = await this.options.server.requestFrame(
          { kind: 'ownership.commit', reservation, sourceLease },
          'ownership.committed',
        );
        this.committedAuthorizations.set(response.authorization.authorizationId, response.authorization);
        this.currentLease = response.authorization.destinationLease;
        this.options.server.updateLeaseIdentity(
          response.authorization.destinationLease.canonicalSessionPath,
          response.authorization.destinationLease.ownershipRevision,
        );
        return response.authorization;
      },
      consumeTransferAuthorization: async (authorization, canonicalDestinationPath) => {
        const cached = this.committedAuthorizations.get(authorization.authorizationId);
        if (!cached || cached.nonce !== authorization.nonce
          || cached.canonicalDestinationPath !== canonicalDestinationPath) {
          throw new Error('Replacement transfer authorization is stale or was not coordinator-committed.');
        }
        const response = await this.options.server.requestFrame(
          { kind: 'ownership.consume', authorization: cached, canonicalDestinationPath },
          'ownership.consumed',
        );
        if (response.authorizationId !== authorization.authorizationId
          || response.lease.nonce !== cached.destinationLease.nonce) {
          throw new Error('Coordinator ownership-consume acknowledgement did not match the committed transfer.');
        }
        this.committedAuthorizations.delete(authorization.authorizationId);
        return response.lease;
      },
      assertWriteLease: (lease, canonicalPath) => {
        if (!this.currentLease || lease.nonce !== this.currentLease.nonce
          || !sameSessionPath(canonicalPath, this.currentLease.canonicalSessionPath)) {
          throw new Error(`Stale worker session write lease for ${canonicalPath}.`);
        }
      },
      runtimeReady: async (lease, canonicalPath) => {
        const response = await this.options.server.requestFrame(
          { kind: 'ownership.runtimeReady', lease, canonicalPath },
          'ownership.runtimeReadyAck',
        );
        if (response.ownershipRevision !== lease.ownershipRevision) throw new Error('Ownership runtime-ready revision mismatch.');
        // bindSession owns the public context-path transition after the SDK has
        // installed the replacement session. Advancing it here would erase the
        // source identity needed for replacesSessionPath and opened ordering.
      },
      failClosed: async (error): Promise<never> => {
        const terminal = error instanceof Error ? error : new Error(String(error));
        this.options.server.failRuntime(terminal);
        await this.dispose().catch(() => undefined);
        throw terminal;
      },
    };
  }

  private handleSessionEvent(context: SessionContext, event: SdkSessionEvent): void {
    if (context.retired) return;
    handleSdkSessionEvent({
      emit: (name, payload) => this.emit(name, payload),
      emitBusyChanged: (owner, busy) => this.emitBusyChanged(owner, busy),
      emitContextUsageChanged: (owner, estimated) => this.emitContextUsageChanged(owner, estimated),
      emitSessionOpened: async () => this.emit('session.opened', { ...this.openedPayload, runtimeReady: true }),
      emitSessionListChanged: async () => undefined,
      observeSubagentDetail: (root, details) => this.detailStore.observe({ ...root, details }),
      terminalizeSubagentDetail: (root, durableEntryId) => this.detailStore.terminal(root, durableEntryId),
      recoverStuckSession: (owner, reason) => {
        void this.interrupt().catch(() => this.emit('operational-error', {
          code: 'SESSION_RUNTIME_RECOVERY_FAILED', message: reason, sessionPath: owner.sessionPath,
        }));
      },
    }, context, event);
  }

  private emitBusyChanged(context: SessionContext, busy: boolean): void {
    context.busySeq += 1;
    this.emit('busy.changed', { sessionPath: context.sessionPath, busy, seq: context.busySeq });
  }

  private emitContextUsageChanged(context: SessionContext, estimated?: number): void {
    if (estimated !== undefined) context.postCompactionEstimatedTokens = estimated;
    const contextWindow = context.session.model?.contextWindow;
    const measured = contextWindow
      ? deriveContextUsageFromBranch(context.session.sessionManager.getBranch(), contextWindow)
      : undefined;
    const next = measured ?? (contextWindow && context.postCompactionEstimatedTokens !== undefined
      ? {
          tokens: context.postCompactionEstimatedTokens,
          contextWindow,
          percent: Math.min(100, Math.max(0, context.postCompactionEstimatedTokens / contextWindow * 100)),
        }
      : null);
    context.lastContextUsage = next;
    this.emit('contextUsage.changed', { sessionPath: context.sessionPath, contextUsage: next });
  }

  private emit(event: string, payload?: unknown): void {
    // The accumulator allows terminal messages up to its 30 MiB checkpoint
    // ceiling (the legacy monolithic JSONL record budget). The worker's
    // ordinary IPC frames are capped at 256 KiB, so outbound live semantics
    // are projected onto the wire budget here; the durable session remains
    // lossless and detailRefs keep every large body retrievable.
    if (event === 'live.semantic') {
      const bounded = boundLiveSemanticPayload(payload);
      if (bounded === undefined) return; // dropped delta: host recovers via checkpoint rebase
      payload = bounded;
    }
    this.options.server.sendFrame({
      kind: 'runtime.event',
      event: event as never,
      payload: asWorkerJsonObject(payload ?? {}),
    });
  }

  private requestDeps(): Parameters<typeof handleBackendRequest>[0] {
    const sdk = this.sdk!;
    const context = this.context!;
    return {
      sdkPath: this.options.patchIdentity.sdkPath,
      agentDir: this.agentDir,
      startupCwd: this.startupCwd,
      sessionDir: this.sessionDir,
      sdk,
      getSessionContext: (sessionPath) => sessionPath && sameSessionPath(sessionPath, context.sessionPath) ? context : undefined,
      createSessionContext: (manager, reason) => this.createSessionContext(manager, reason),
      ensureSessionContext: async (sessionPath) => {
        if (!sameSessionPath(sessionPath, context.sessionPath)) throw new Error('Cross-session worker command rejected.');
        return context;
      },
      isSessionTransitionPending: () => false,
      setViewedSessionPath: () => undefined,
      buildSessionOpenedPayload: async (sessionPath, selectionToken, transcript, transport, operationId, operationAttempt) => (
        this.buildOpenedPayload(sessionPath, selectionToken, operationId, operationAttempt, transcript, transport)
      ),
      applySystemPromptToggles: async (sessionPath, disabledEntries) => {
        if (!sameSessionPath(sessionPath, context.sessionPath)) throw new Error('Cross-session prompt toggle rejected.');
        await this.applySystemPromptToggles(context, disabledEntries);
      },
      setAutonomousMode: (enabled) => this.setAutonomousMode(enabled),
      loadTranscriptPage: async (sessionPath, direction, loadedStart, loadedEnd) => (
        this.loadTranscriptPage(context, sessionPath, direction, loadedStart, loadedEnd)
      ),
      loadDetail: async (sessionPath, ref) => this.loadDetail(context, sessionPath, ref),
      emit: (event, payload) => this.emit(event, payload),
      emitBusyChanged: (owner, busy) => this.emitBusyChanged(owner, busy),
      emitContextUsageChanged: (owner) => this.emitContextUsageChanged(owner),
      emitSessionListChanged: async () => undefined,
      listSessions: async () => this.openedPayload ? [this.openedPayload.session] : [],
      listAvailableModels: () => this.availableModels(),
      readModelSettings: async () => ({ ...this.settings }),
      writeModelSettings: async (updates) => {
        // The coordinator is the sole persistence/revision authority. Apply
        // locally only after its correlated acknowledgement, so failed writes
        // cannot leave this worker ahead of future workers/settings.get.
        const response = await this.options.server.requestFrame({
          kind: 'settings.mutate',
          updates: asWorkerJsonObject(updates),
        }, 'settings.authoritative');
        this.settings = response.values as unknown as ModelSettings;
        return { ...this.settings };
      },
      suppressRequestTrace: true,
    };
  }

  private async loadTranscriptPage(
    context: SessionContext,
    sessionPath: string,
    direction: TranscriptPageDirection,
    loadedStart?: number,
    loadedEnd?: number,
  ): Promise<TranscriptPagePayload> {
    if (!sameSessionPath(sessionPath, context.sessionPath)) throw new Error('Cross-session transcript page rejected.');
    const page = buildPagedTranscriptWindow(ensureDisplayTranscriptCache(context), {
      direction, loadedStart, loadedEnd,
      pinnedMessageId: context.activeRequest?.currentMessageId ?? context.activeRequest?.lastAssistantMessageId,
    });
    const busy = context.session.isStreaming || !!context.activeRequest || context.session.isCompacting === true;
    return {
      sessionPath: context.sessionPath,
      transcript: (busy ? page.transcript : normalizeDanglingTranscript(page.transcript))
        .map(deduplicateToolCallResultsForTransport),
      transcriptWindow: page.transcriptWindow,
      busy,
    };
  }

  private async loadDetail(context: SessionContext, sessionPath: string, ref: LazyDetailRef): Promise<DetailResult> {
    if (!sameSessionPath(sessionPath, context.sessionPath)) throw new Error('Cross-session detail request rejected.');
    if (ref.source !== 'durable') {
      return { sessionPath: context.sessionPath, key: ref.key, status: 'unavailable', message: 'Live detail is owned by the extension host.' };
    }
    const found = findDurableDetail(ensureDisplayTranscriptCache(context).transcript, ref);
    if (found.status === 'unavailable') return { sessionPath: context.sessionPath, key: ref.key, status: 'unavailable', message: 'The durable detail is no longer available.' };
    if (found.sizeBytes > LIVE_PIPELINE_LIMITS.previewBytes) return { sessionPath: context.sessionPath, key: ref.key, status: 'unavailable', message: 'The detail exceeds the supported retrieval size.' };
    if (found.sizeBytes !== ref.sizeBytes) return { sessionPath: context.sessionPath, key: ref.key, status: 'stale', message: 'The durable detail changed; refresh and retry.' };
    return { sessionPath: context.sessionPath, key: ref.key, status: 'loaded', value: found.value, sizeBytes: found.sizeBytes };
  }

  private async createSessionContext(
    manager: import('./sdk').SdkSessionManager,
    reason: SessionContextCreationReason,
  ): Promise<SessionContext> {
    if (!this.sdk || !this.currentLease) throw new Error('Worker runtime is not promoted.');
    const managerPath = manager.getSessionFile();
    if (!managerPath || !sameSessionPath(managerPath, this.currentLease.canonicalSessionPath)) {
      throw new Error('Runtime context manager does not match the current write lease.');
    }
    const authStorage = this.sdk.AuthStorage.create(this.syncedAuthPath ?? resolveAuthPath(this.agentDir));
    const runtime = await this.sdk.createAgentSessionRuntime(
      createRuntimeFactory(this.sdk, authStorage, this.startupCwd, this.gate),
      {
        cwd: manager.getCwd() || this.startupCwd,
        agentDir: this.agentDir,
        sessionManager: manager,
        ownershipAdapter: this.createOwnershipAdapter(),
        writeLease: this.currentLease,
        sessionStartEvent: { type: 'session_start', reason },
      },
    );
    const context: SessionContext = {
      runtime,
      session: runtime.session,
      sessionPath: managerPath,
      sessionOwnershipEpoch: 0,
      unsubscribe: () => undefined,
      busySeq: 0,
    };
    this.context = context;
    runtime.setRebindSession?.(async (replacement) => {
      await this.bindSession(context, replacement);
      this.emit('session.opened', { ...this.openedPayload, runtimeReady: true });
    });
    await this.bindSession(context, runtime.session);
    return context;
  }

  private async readHarnessSystemPrompt(context: SessionContext): Promise<string | undefined> {
    const promptState = context.session as typeof context.session & SessionPromptState;
    const options = promptState._baseSystemPromptOptions;
    if (options) {
      try {
        const { buildSystemPrompt } = await this.getSystemPromptModule();
        const rebuilt = normalizePromptText(buildSystemPrompt({
          cwd: options.cwd,
          selectedTools: options.selectedTools,
          toolSnippets: options.toolSnippets,
          promptGuidelines: options.promptGuidelines,
        }));
        if (rebuilt) return rewritePieHarnessPrompt(rebuilt, this.agentDir);
      } catch { /* fall back to the runtime's current base prompt */ }
    }
    const base = normalizePromptText(promptState._baseSystemPrompt);
    return base ? rewritePieHarnessPrompt(base, this.agentDir) : undefined;
  }

  private async buildSystemPrompts(
    context: SessionContext,
    harnessPromptOverride?: string,
  ): Promise<import('../shared/protocol').SystemPromptEntry[]> {
    const promptState = context.session as typeof context.session & SessionPromptState;
    captureOriginalSystemPromptOptions(promptState);
    const promptOptions = promptState._originalSystemPromptOptions ?? promptState._baseSystemPromptOptions;
    const harnessPrompt = harnessPromptOverride ?? await this.readHarnessSystemPrompt(context);
    const tools = context.session.getAllTools?.() ?? [];
    return buildSessionSystemPrompts({
      harnessPrompt,
      promptOptions,
      formatSkillsForPrompt: this.sdk?.formatSkillsForPrompt,
      tools,
      activeProvider: resolveActiveModel(context),
      disabledEntries: context.systemPromptDisabledEntries,
    });
  }

  private async buildOpenedPayload(
    sessionPath: string,
    selectionToken?: string,
    operationId?: string,
    operationAttempt?: number,
    transcript: import('../shared/protocol').TranscriptMode = 'tail',
    transport?: import('../shared/transcript-window').SessionSnapshotTransport,
  ): Promise<SessionOpenedPayload> {
    const context = this.context;
    if (!context || !sameSessionPath(sessionPath, context.sessionPath)) {
      throw new Error(`Cross-session snapshot rejected: ${sessionPath}`);
    }
    return await buildSessionOpenedPayloadHelper(sessionPath, {
      getContextUsage: (owner) => owner.lastContextUsage ?? undefined,
      readHarnessSystemPrompt: (owner) => this.readHarnessSystemPrompt(owner),
      buildSystemPrompts: (owner, harnessPrompt) => this.buildSystemPrompts(owner, harnessPrompt),
      readModelSettings: async () => ({ ...this.settings }),
      getPinnedStreamingMessageId: (owner) => owner.activeRequest?.currentMessageId
        ?? owner.activeRequest?.lastAssistantMessageId,
      getSessionContext: (candidate) => sameSessionPath(candidate, context.sessionPath) ? context : undefined,
      agentDir: this.agentDir,
      startupCwd: this.startupCwd,
    }, selectionToken, transcript, transport, operationId, operationAttempt);
  }

  private applyRuntimePrefs(values: WorkerJsonObject): void {
    const jsonEnv: Array<[string, string]> = [
      ['providerToggles', PROVIDER_TOGGLES_ENV],
      ['subagentProviderDefaults', SUBAGENT_PROVIDER_DEFAULTS_ENV],
      ['subagentProviderTogglesBySession', SUBAGENT_PROVIDER_TOGGLES_ENV],
      ['extensionToggles', EXTENSION_TOGGLES_ENV],
      ['historyCompaction', HISTORY_COMPACTION_ENV],
      ['subagentBuckets', SUBAGENT_BUCKETS_ENV],
      ['subagentNestedAllowedBuckets', NESTED_ALLOWED_BUCKETS_ENV],
      ['subagentDropTools', 'PIE_SUBAGENT_DROP_TOOLS_JSON'],
    ];
    for (const [key, env] of jsonEnv) {
      if (values[key] !== undefined) process.env[env] = JSON.stringify(values[key]);
    }
    const booleanEnv: Array<[string, string]> = [
      ['subagentAlwaysParentModel', 'PIE_SUBAGENT_ALWAYS_PARENT_MODEL'],
      ['subagentRouteAroundSaturatedProviders', SUBAGENT_ROUTE_AROUND_SATURATED_PROVIDERS_ENV],
      ['subagentFallbackOnProviderFailure', SUBAGENT_FALLBACK_ON_PROVIDER_FAILURE_ENV],
      ['bashFastPath', 'PIE_BASH_FAST_PATH'],
    ];
    for (const [key, env] of booleanEnv) {
      if (typeof values[key] === 'boolean') process.env[env] = values[key] ? '1' : '0';
    }
    const scalarEnv: Array<[string, string]> = [
      ['subagentMaxDepth', 'PIE_SUBAGENT_MAX_DEPTH'],
      ['subagentMaxTreeSessions', 'PIE_SUBAGENT_MAX_TREE_SESSIONS'],
      ['subagentMaxInflight', 'PIE_SUBAGENT_MAX_INFLIGHT'],
      ['bashWarmPoolSize', 'PIE_BASH_WARM_POOL'],
      ['bashWarmupTimeoutMs', 'PIE_BASH_WARMUP_TIMEOUT_MS'],
      ['bashDefaultTimeout', 'PIE_BASH_DEFAULT_TIMEOUT'],
      ['bashShellPath', 'PIE_SHELL'],
    ];
    for (const [key, env] of scalarEnv) {
      if (typeof values[key] === 'string' || typeof values[key] === 'number') process.env[env] = String(values[key]);
    }
    if (typeof values.autonomousMode === 'boolean') {
      process.env[AUTONOMOUS_MODE_ENV] = values.autonomousMode ? '1' : '0';
      this.setAutonomousMode(values.autonomousMode);
    }
    if (values.providerConcurrency && typeof values.providerConcurrency === 'object'
      && !Array.isArray(values.providerConcurrency)) {
      ProviderGate.getInstance()?.applyUserOverrides(values.providerConcurrency as never);
    }
  }

  private setAutonomousMode(enabled: boolean): void {
    if (this.autonomousMode === enabled) return;
    this.autonomousMode = enabled;
    if (this.context) this.applyAutonomousModeToContext(this.context, enabled);
  }

  private applyAutonomousModeToContext(context: SessionContext, enabled: boolean): void {
    const active = context.session.getActiveToolNames?.()
      ?? context.session.getAllTools?.().map((tool) => tool.name)
      ?? [];
    if (enabled) {
      if (context.autonomousModeAskUserWasActive !== undefined) return;
      context.autonomousModeAskUserWasActive = active.includes(ASK_USER_TOOL_NAME);
      if (context.autonomousModeAskUserWasActive) {
        context.session.setActiveToolsByName?.(active.filter((name) => name !== ASK_USER_TOOL_NAME));
      }
      return;
    }
    if (context.autonomousModeAskUserWasActive && !active.includes(ASK_USER_TOOL_NAME)) {
      context.session.setActiveToolsByName?.([...active, ASK_USER_TOOL_NAME]);
    }
    context.autonomousModeAskUserWasActive = undefined;
  }

  private async applySystemPromptToggles(context: SessionContext, disabledEntries: readonly string[]): Promise<void> {
    const next = [...new Set(disabledEntries)];
    const promptState = context.session as typeof context.session & SessionPromptState;
    captureOriginalSystemPromptOptions(promptState);
    const source = promptState._originalSystemPromptOptions ?? promptState._baseSystemPromptOptions;
    if (source) {
      const { buildSystemPrompt } = await this.getSystemPromptModule();
      const toggled = buildToggledSystemPrompt(source, next, buildSystemPrompt);
      promptState._baseSystemPrompt = toggled.prompt;
      promptState._baseSystemPromptOptions = toggled.options;
    }
    const disablingTools = next.includes(TOOLS_ENTRY_ID);
    const wasDisablingTools = context.systemPromptDisabledEntries?.includes(TOOLS_ENTRY_ID) === true;
    if (disablingTools && !wasDisablingTools) {
      context.systemPromptToolsBeforeDisable = context.session.getActiveToolNames?.()
        ?? context.session.getAllTools?.().map((tool) => tool.name)
        ?? [];
      context.session.setActiveToolsByName?.([]);
    } else if (!disablingTools && wasDisablingTools) {
      context.session.setActiveToolsByName?.(context.systemPromptToolsBeforeDisable ?? []);
      context.systemPromptToolsBeforeDisable = undefined;
    }
    context.systemPromptDisabledEntries = next;
    await writeSystemPromptTogglesForSession(context.sessionPath, next);
    if (this.openedPayload?.systemPrompts) {
      this.openedPayload = {
        ...this.openedPayload,
        systemPrompts: markDisabledEntries(
          this.openedPayload.systemPrompts.map((entry) => ({ ...entry, disabled: false })),
          new Set(next),
        ),
      };
    }
  }

  private getSystemPromptModule(): Promise<SdkSystemPromptModule> {
    this.systemPromptModule ??= loadSdkInternalModule<SdkSystemPromptModule>(
      this.options.patchIdentity.sdkPath,
      path.join('core', 'system-prompt.js'),
      { mode: 'worker', patchIdentity: this.options.patchIdentity },
    );
    return this.systemPromptModule;
  }

  private availableModels(): ModelInfo[] {
    let models: ModelInfo[] = [];
    try {
      models = (this.context?.runtime.services.modelRegistry.getAvailable() ?? []).map((model) => ({
        id: model.id,
        name: model.name,
        provider: model.provider,
        reasoning: model.reasoning,
        inputKinds: model.input,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      }));
    } catch {
      models = [];
    }
    // The configured catalog authority snapshot consumed from coordinator sync
    // keeps the picker non-empty when the runtime registry is unavailable.
    if (models.length === 0 && this.syncedCatalogModels !== undefined) return this.syncedCatalogModels;
    return models;
  }

  /** Report runtime-discovered models to the coordinator without replacing its
   * configured catalog authority. Fire-and-forget; a rejected frame is
   * retried on the next command/event cycle via the promotion report. */
  private reportRuntimeCatalog(): void {
    try {
      const models = asWorkerJson(this.availableModels());
      this.options.server.sendFrame({
        kind: 'runtime.report',
        domain: 'catalog',
        payload: { models },
      });
    } catch {
      // The report is best-effort telemetry; never fail promotion for it.
    }
  }

  private assertPromotionPayload(payload: WorkerRuntimePromotionPayload): void {
    for (const key of ['sdkPath', 'agentDir', 'startupCwd', 'sessionDir', 'sessionPath', 'creationReason'] as const) {
      if (typeof payload[key] !== 'string' || payload[key].length === 0) throw new Error(`Invalid runtime promotion ${key}.`);
    }
    if (!payload.writeLease || typeof payload.writeLease !== 'object' || Array.isArray(payload.writeLease)) throw new Error('Invalid runtime promotion writeLease.');
    if (!payload.openedPayload || typeof payload.openedPayload !== 'object' || Array.isArray(payload.openedPayload)) throw new Error('Invalid runtime promotion openedPayload.');
  }
}

/**
 * Project one live.semantic payload onto the worker IPC ordinary-frame
 * ceiling. Returns `undefined` when the envelope must not be sent at all
 * (the host detects the resulting seq gap and recovers the full content
 * through the checkpoint rebase path).
 */
function boundLiveSemanticPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const envelope = payload as { kind?: unknown; delta?: unknown; sessionPath?: unknown; durableMessage?: unknown };
  if (envelope.kind === 'turn.terminal') {
    const durableMessage = envelope.durableMessage as ChatMessage;
    const sessionPath = typeof envelope.sessionPath === 'string' ? envelope.sessionPath : '';
    return {
      ...envelope,
      durableMessage: compactDurableMessageForTransport(
        durableMessage,
        sessionPath,
        WORKER_IPC_TERMINAL_MESSAGE_BUDGET,
      ),
    };
  }
  if (envelope.kind === 'turn.text' || envelope.kind === 'turn.reasoning') {
    // A single delta must fit the ordinary-frame ceiling with the envelope
    // overhead. The accumulator's turn caps allow a part up to 512 KiB (its
    // legacy JSONL-record budget); a provider emitting one giant update
    // cannot ride the worker wire, so the envelope is dropped and the host
    // recovers through the seq-gap checkpoint rebase path.
    if (typeof envelope.delta === 'string'
      && Buffer.byteLength(envelope.delta, 'utf8') > WORKER_IPC_DELTA_BUDGET) {
      return undefined;
    }
  }
  return payload;
}

function sameSessionPath(left: string, right: string): boolean {
  const canonical = (value: string): string => {
    const absolute = path.resolve(value);
    let resolved = absolute;
    try { resolved = fsSync.realpathSync.native(absolute); } catch { /* destination may not exist yet */ }
    const normalized = path.normalize(resolved);
    return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
  };
  return canonical(left) === canonical(right);
}

function resolveAuthPath(agentDir: string): string {
  const authDir = process.env.PI_CODING_AGENT_AUTH_DIR?.trim();
  return authDir ? path.resolve(authDir, 'auth.json') : path.resolve(agentDir, 'auth.json');
}

function asWorkerJson(value: unknown): WorkerJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as WorkerJsonValue;
}

function asWorkerJsonObject(value: unknown): WorkerJsonObject {
  const normalized = asWorkerJson(value);
  return normalized && typeof normalized === 'object' && !Array.isArray(normalized)
    ? normalized as WorkerJsonObject
    : { value: normalized };
}
