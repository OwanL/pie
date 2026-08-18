import * as vscode from 'vscode';

import { BackendClient } from '../backend/client';
import { resolveChatPrefs, buildRuntimePrefsPayload } from '../../shared/protocol';
import type { ChatPrefs, DetailResult, LazyDetailRef, PruningSettings, ToolResultPruningSettings, ThinkingLevel, TranscriptMode } from '../../shared/protocol';
import {
  loadPersistedPruningSettings,
  savePruningSettings,
  type PruningSettingsStorage,
} from './pruning-settings-persistence';
import {
  loadPersistedToolResultPruningSettings,
  saveToolResultPruningSettings,
  type ToolResultPruningSettingsStorage,
} from './tool-result-pruning-settings-persistence';
import { NOOP_RUN_OBSERVER, type RunObserver } from '../stats-service';
import { SessionServiceEvents } from './events';
import { SessionMessageActions } from './message-actions';
import { SessionServiceState } from './state';
import { startSessionBackend } from './startup';
import { setRuntimeAuditLogEnabled } from '../util/audit';
import { SessionTabActions } from './tab-actions';
import type { OnSessionCompleted, PostImperative, ScheduleRender } from './types';
import type { Event } from '../core/events';
import type { ArchState } from '../core/arch-state';
import { resolveLiveDetail } from './detail-retrieval';
import type { LiveSubagentDetailAddress, DetailCursor, DetailPageRef } from '../../shared/protocol/subagent-detail';
import { DetailSubscriptionService } from './detail-subscriptions';

/** Host-owned identities the Phase 5 detail subscription service fences its
 *  imperatives with: the current webview document generation and the current
 *  extension-host instance identity. Wired from `SidebarViewProvider` in
 *  extension-host. */
export interface DetailHostInfo {
  getHostInstanceId(): string;
  getViewGeneration(): number;
}

const DEFAULT_DETAIL_HOST_INFO: DetailHostInfo = {
  getHostInstanceId: () => 'host',
  getViewGeneration: () => 0,
};

const PREFS_STORAGE_KEY = 'chatPrefs';
const PRUNING_STORAGE_KEY = 'pruningSettings';
const TOOL_RESULT_PRUNING_STORAGE_KEY = 'toolResultPruningSettings';
const DETAIL_CACHE_MAX_ENTRIES = 32;
const DETAIL_CACHE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Owns the PI backend process lifecycle and wires backend events to the
 * arch state. All session commands (create, open, close, send, interrupt, etc.) go
 * through this service.
 */
export class SessionService implements vscode.Disposable {
  private readonly state: SessionServiceState;
  private readonly events: SessionServiceEvents;
  private readonly tabs: SessionTabActions;
  private readonly messages: SessionMessageActions;
  private readonly getArchState: () => ArchState;
  private readonly detailSubscriptions: DetailSubscriptionService;
  private readonly dispatchArch: (event: Event) => void;
  private readonly detailCache = new Map<string, { result: DetailResult; bytes: number }>();
  private readonly detailRequests = new Map<string, Promise<DetailResult>>();
  private readonly detailEpochBySession = new Map<string, number>();
  private detailCacheBytes = 0;
  private detailGeneration = 0;
  private readonly correlatedFailureSubscription: vscode.Disposable;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly backend: BackendClient,
    private readonly scheduleRender: ScheduleRender,
    postImperative: PostImperative,
    dispatchArch: (event: Event) => void,
    getArchState: () => ArchState,
    onSessionCompleted?: OnSessionCompleted,
    private readonly runObserver: RunObserver = NOOP_RUN_OBSERVER,
    private readonly detailHostInfo: DetailHostInfo = DEFAULT_DETAIL_HOST_INFO,
  ) {
    this.getArchState = getArchState;
    this.dispatchArch = dispatchArch;

    this.state = new SessionServiceState(context, backend, scheduleRender, getArchState, dispatchArch);
    this.detailSubscriptions = new DetailSubscriptionService({
      backend,
      postImperative,
      getHostInstanceId: () => this.detailHostInfo.getHostInstanceId(),
      getViewGeneration: () => this.detailHostInfo.getViewGeneration(),
      getBackendGeneration: () => this.state.getBackendGeneration(),
    });
    this.correlatedFailureSubscription = typeof backend.onDidCorrelatedRequestFail === 'function'
      ? backend.onDidCorrelatedRequestFail((failure) => {
          if (!this.state.claimOperationalIncident(undefined, failure.requestId, failure.backendGeneration)) return;
          // The owning EffectResult remains responsible for rollback/user notice;
          // this shared identity registry owns the single analytics record and
          // suppresses a legacy operational-error echo with the same requestId.
          this.runObserver.onBackendError(failure.sessionPath, failure.code);
        })
      : { dispose: () => undefined };
    this.events = new SessionServiceEvents({
      context,
      scheduleRender,
      onSessionCompleted,
      runObserver,
      state: this.state,
      dispatchArch,
      getArchState,
      onDetailStream: (message) => this.detailSubscriptions.handleStream(message),
    });
    this.tabs = new SessionTabActions({
      context,
      scheduleRender,
      runObserver,
      state: this.state,
      getArchState,
      dispatchArch,
      notifySessionViewed: (sessionPath, previousSessionPath) => this.backend.request(
        'session.viewed',
        { sessionPath, previousSessionPath },
        { timeoutMs: 5_000 },
      ),
    });
    this.messages = new SessionMessageActions({
      context,
      backend,
      scheduleRender,
      state: this.state,
      createNewSession: () => this.tabs.createNewSession(),
      getArchState,
      dispatchArch,
    });
    this.state.setPreloadedSessionOpenedHandler((payload) => {
      this.events.applySessionOpened(payload);
    });
  }

  async start(): Promise<void> {
    await startSessionBackend({
      context: this.context,
      backend: this.backend,
      scheduleRender: this.scheduleRender,
      events: this.events,
      state: this.state,
      service: this,
      openSession: (sessionPath) => this.tabs.openSession(sessionPath),
      getArchState: this.getArchState,
      dispatchArch: this.dispatchArch,
    });
  }

  /** Expose queue routing for the Phase 3 EffectRunner. */
  get queues(): { enqueueLifecycle: SessionServiceState['enqueueLifecycle']; enqueueSessionOperation: SessionServiceState['enqueueSessionOperation'] } {
    return {
      enqueueLifecycle: (task) => this.state.enqueueLifecycle(task),
      enqueueSessionOperation: (sessionPath, task) => this.state.enqueueSessionOperation(sessionPath, task),
    };
  }

  /** Expose completion-notification suppression for interrupt (Phase 3). */
  suppressNextCompletionNotificationFor(sessionPath: string): void {
    this.state.suppressNextCompletionNotificationFor(sessionPath);
  }

  /** Bind a backend request ID to a session path (Phase 4). */
  bindRequestSessionPath(requestId: string, sessionPath: string): void {
    this.state.bindRequestSessionPath(requestId, sessionPath);
  }

  /** Retain a timed-out create/duplicate operation for late success. */
  handleCreateOperationDelayed(selectionToken: string, operationId: string, notice: string, expectedAttempt?: number): void {
    this.state.handleCreateOperationDelayed(selectionToken, operationId, notice, expectedAttempt);
  }

  /** Feed correlated close/persistence results to the V2 closure outbox
   *  observer before the reducer consumes its no-op result handlers. */
  handleReviewClosureEffectResult(
    event: Extract<Event, { kind: 'CloseSessionResult' | 'PersistTabsResult' }>,
  ): void {
    this.state.handleReviewClosureEffectResult(event);
  }

  /** Bump the data epoch for a session (Phase 4, pre-send/edit). */
  bumpSessionDataEpoch(sessionPath: string): void {
    this.clearDetailCacheForSession(sessionPath);
    this.state.bumpSessionDataEpoch(sessionPath);
  }

  async restart(): Promise<void> {
    this.detailGeneration += 1;
    this.detailSubscriptions.reset();
    this.detailCache.clear();
    this.detailCacheBytes = 0;
    this.events.detach();
    this.state.failPendingCreateOperations('PI backend generation ended while the session was being created.');
    await this.backend.stop();
    // startSessionBackend owns the single generation reset for the replacement
    // process. Resetting here as well would drift host failure identities one
    // generation ahead of BackendClient after every restart.
    this.dispatchArch({ kind: 'RunningSessionsChanged', sessionPaths: [] });
    this.dispatchArch({ kind: 'BackendReadyChanged', ready: false });
    this.dispatchArch({ kind: 'NoticeShown', notice: null });
    this.scheduleRender();
    await this.start();
  }

  dispose(): void {
    this.detailGeneration += 1;
    this.detailSubscriptions.reset();
    this.detailCache.clear();
    this.detailCacheBytes = 0;
    this.events.detach();
    this.correlatedFailureSubscription.dispose();
  }

  createNewSession(): string {
    return this.tabs.createNewSession();
  }

  // ─── Phase 5 detail subscription ownership (public routing) ────────────────

  /** Subscribe a renderer-owned detail key. The EffectRunner mints the
   *  `subscriptionId`; the service records the exact owner and forwards the
   *  coordinator's `detail.start` only for that owner. */
  subscribeDetail(options: {
    subscriptionId: string;
    viewGeneration: number;
    detailKey: string;
    address: LiveSubagentDetailAddress;
    cursor?: DetailCursor;
    rendererId?: string;
    rendererGeneration?: number;
  }): void {
    this.detailSubscriptions.subscribe(
      options.subscriptionId,
      options.viewGeneration,
      options.detailKey,
      options.address,
      options.cursor,
      options.rendererId,
      options.rendererGeneration,
    );
  }

  /** Collapse/unmount/session-change: discard the owner, tombstone its
   *  subscription, and notify the backend best-effort. */
  unsubscribeDetail(options: {
    viewGeneration: number;
    detailKey: string;
    reason: 'collapse' | 'unmount' | 'session-change';
    rendererId?: string;
    rendererGeneration?: number;
  }): void {
    this.detailSubscriptions.unsubscribe(options.viewGeneration, options.detailKey, options.reason, options.rendererId, options.rendererGeneration);
  }

  /** Refetch a page of the active baseline for a subscribed key. */
  fetchDetailPages(options: {
    viewGeneration: number;
    detailKey: string;
    ref: DetailPageRef;
    rendererId?: string;
    rendererGeneration?: number;
  }): void {
    this.detailSubscriptions.fetchPages(options.viewGeneration, options.detailKey, options.ref, options.rendererId, options.rendererGeneration);
  }

  captureSelectionRequestStart(selectionToken: string, operationAttempt?: number): void {
    this.state.captureSelectionRequestStart(selectionToken, operationAttempt);
  }

  handleCreateOperationAcknowledged(selectionToken: string, operationId: string, sessionPath: string): void {
    const pendingPath = this.state.handleCreateOperationAcknowledged(selectionToken, operationId, sessionPath);
    if (pendingPath) this.runObserver.replaceSessionPath(pendingPath, sessionPath, undefined);
  }

  /** Re-arm a delayed create/duplicate with the same operation identity. */
  retryCreateOperation(operationId: string): boolean {
    return this.tabs.retryCreateSession(operationId);
  }

  /** Fail delayed creates when the backend generation dies. */
  failPendingCreateOperations(notice: string): void {
    this.state.failPendingCreateOperations(notice);
  }

  /** Effect-side delegate: recover from a failed/timed-out selection by
   *  finishing the request and dispatching the reducer transitions that undo
   *  the optimistic tab setup. */
  handleSelectionFailure(selectionToken: string, notice: string, expectedAttempt?: number): void {
    this.state.handleSelectionFailure(selectionToken, notice, expectedAttempt);
  }

  isSessionRuntimeReady(sessionPath: string): boolean {
    return this.state.isSessionRuntimeKnown(sessionPath);
  }

  getOpenTranscriptMode(sessionPath: string): TranscriptMode {
    const arch = this.getArchState();
    const loaded = arch.transcript.windowBySession[sessionPath] !== undefined;
    const running = arch.sessions.runningSessionPaths.includes(sessionPath);
    return loaded && !running ? 'skip' : 'tail';
  }

  openSession(sessionPath: string): void {
    this.tabs.openSession(sessionPath);
  }

  async closeSession(sessionPath: string, nextPath: string | null, privacyMode = false, selectionChanged = false): Promise<void> {
    this.clearDetailCacheForSession(sessionPath);
    if (privacyMode) {
      // The reducer evicts the privacy marker before this effect runs, so
      // explicitly scrub the observer before the ordinary close callback can
      // finalize anything. Reopen only while the transcript still exists: a
      // successful session.forget is the irreversible deletion boundary.
      try {
        await this.runObserver.setSessionPrivacy?.(sessionPath, true);
        await this.backend.request('session.forget', { sessionPath });
      } catch (error) {
        this.dispatchArch({
          kind: 'Command',
          cmd: { kind: 'SetPrivacyMode', corrId: `privacy-retry:${Date.now()}`, sessionPath, enabled: true },
        });
        this.tabs.openSession(sessionPath);
        throw error;
      }
      // Runtime disposal may emit a final warm-bash/session summary. The first
      // scrub already committed privacy before deletion, so this second pass is
      // best-effort and must never attempt to reopen a deleted transcript.
      await Promise.resolve(this.runObserver.setSessionPrivacy?.(sessionPath, true)).catch(() => undefined);
    }
    await this.tabs.closeSession(sessionPath, nextPath, selectionChanged);
    if (privacyMode) {
      // The close effect initially persisted the marker as a retry guard;
      // clear it only after backend deletion and host cleanup both succeed.
      const archState = this.getArchState();
      this.dispatchArch({
        kind: 'Command',
        cmd: {
          kind: 'PersistTabs',
          corrId: `private-cleared:${Date.now()}`,
          openTabPaths: archState.sessions.openTabPaths,
          activeSessionPath: archState.sessions.activeSessionPath,
          pinnedTabPaths: archState.sessions.pinnedTabPaths,
          pinnedTabGroups: archState.sessions.pinnedTabGroups,
        },
      });
    }
  }

  duplicateSession(sessionPath: string): void {
    this.tabs.duplicateSession(sessionPath);
  }

  async addFilesystemPaths(
    requestedSessionPath: string | undefined,
    paths: string[],
    source: 'picker' | 'drop',
  ): Promise<void> {
    await this.messages.addFilesystemPaths(requestedSessionPath, paths, source);
  }

  async loadOlderTranscript(sessionPath?: string): Promise<void> {
    await this.messages.loadOlderTranscript(sessionPath);
  }

  async loadNewerTranscript(sessionPath?: string): Promise<void> {
    await this.messages.loadNewerTranscript(sessionPath);
  }

  async jumpToLatestTranscript(sessionPath?: string): Promise<void> {
    await this.messages.jumpToLatestTranscript(sessionPath);
  }

  /** Bounded, deduplicated retrieval for details omitted from state snapshots. */
  async loadDetail(sessionPath: string, ref: LazyDetailRef): Promise<DetailResult> {
    const cacheKey = `${sessionPath}\u0000${ref.key}`;
    const cached = this.detailCache.get(cacheKey);
    if (cached) {
      this.detailCache.delete(cacheKey);
      this.detailCache.set(cacheKey, cached);
      return cached.result;
    }
    const pending = this.detailRequests.get(cacheKey);
    if (pending) return await pending;

    const requestEpoch = this.detailEpochBySession.get(sessionPath) ?? 0;
    const requestGeneration = this.detailGeneration;
    const request = (async (): Promise<DetailResult> => {
      try {
        const result = ref.source === 'live'
          ? resolveLiveDetail(this.getArchState(), sessionPath, ref)
          : await this.backend.request<DetailResult>('session.loadDetail', { sessionPath, ref });
        if (this.detailGeneration !== requestGeneration
          || (this.detailEpochBySession.get(sessionPath) ?? 0) !== requestEpoch) {
          return { sessionPath, key: ref.key, status: 'stale', message: 'The session changed while details were loading.' };
        }
        if (result.status === 'loaded') this.cacheDetail(cacheKey, result);
        return result;
      } catch {
        return { sessionPath, key: ref.key, status: 'failure', message: 'Could not load details. Retry to try again.' };
      } finally {
        this.detailRequests.delete(cacheKey);
      }
    })();
    this.detailRequests.set(cacheKey, request);
    return await request;
  }

  private clearDetailCacheForSession(sessionPath: string): void {
    this.detailEpochBySession.set(sessionPath, (this.detailEpochBySession.get(sessionPath) ?? 0) + 1);
    const prefix = `${sessionPath}\u0000`;
    for (const [key, entry] of this.detailCache) {
      if (!key.startsWith(prefix)) continue;
      this.detailCache.delete(key);
      this.detailCacheBytes -= entry.bytes;
    }
  }

  private cacheDetail(cacheKey: string, result: Extract<DetailResult, { status: 'loaded' }>): void {
    const existing = this.detailCache.get(cacheKey);
    if (existing) this.detailCacheBytes -= existing.bytes;
    this.detailCache.delete(cacheKey);
    this.detailCache.set(cacheKey, { result, bytes: result.sizeBytes });
    this.detailCacheBytes += result.sizeBytes;
    while (this.detailCache.size > DETAIL_CACHE_MAX_ENTRIES || this.detailCacheBytes > DETAIL_CACHE_MAX_BYTES) {
      const oldestKey = this.detailCache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = this.detailCache.get(oldestKey);
      this.detailCache.delete(oldestKey);
      this.detailCacheBytes -= oldest?.bytes ?? 0;
    }
  }

  /** Effect-side delegate for the run-analytics observer. The reducer owns
   *  the ArchState model-switch transitions; the EffectRunner calls this on
   *  `SetModelRpc` success to record the (disk-persisting) model-config
   *  change in run analytics. */
  onModelConfigChanged(sessionPath: string, modelId: string, thinkingLevel: ThinkingLevel, provider?: string): void {
    this.runObserver.onModelConfigChanged(sessionPath, modelId, thinkingLevel, provider);
  }

  async hydrateModelState(sessionPath: string, metadata?: {
    hydrationRevision?: number;
    modelWriteFence?: number;
  }): Promise<void> {
    await this.messages.hydrateModelState(sessionPath, metadata);
  }

  normalizeAttachUris(uris: vscode.Uri[]): vscode.Uri[] {
    return this.messages.normalizeAttachUris(uris);
  }

  async setPrefs(prefs: Partial<ChatPrefs>): Promise<void> {
    const current = this.getArchState().settings.prefs;
    const deepMerged: Partial<ChatPrefs> = {
      ...prefs,
      ...(prefs.extensionToggles && {
        extensionToggles: { ...current.extensionToggles, ...prefs.extensionToggles },
      }),
      ...(prefs.providerToggles && {
        providerToggles: { ...current.providerToggles, ...prefs.providerToggles },
      }),
      ...(prefs.subagentProviderDefaults && {
        subagentProviderDefaults: {
          ...current.subagentProviderDefaults,
          ...prefs.subagentProviderDefaults,
        },
      }),
      ...(prefs.subagentProviderTogglesBySession && {
        subagentProviderTogglesBySession: {
          ...current.subagentProviderTogglesBySession,
          ...prefs.subagentProviderTogglesBySession,
        },
      }),
    };
    const merged = resolveChatPrefs({ ...current, ...deepMerged });
    // Apply the runtime-audit-log toggle to the audit module so emit decisions
    // take effect immediately on live updates AND on cold-start restore (which
    // also routes through this method via the SetPrefs → SetPrefsRpc pipeline).
    setRuntimeAuditLogEnabled(merged.runtimeAuditLog);
    // NOTE: This method is the *effect handler* for SetPrefsRpc. The caller
    // (webview message router or startup restore) already dispatched a SetPrefs
    // Command through the reducer, which updated ArchState — including the
    // unread-finished-sessions clear when suppressCompletionNotifications is
    // set (that transition now lives in the reducer's SetPrefs handler). Do
    // NOT dispatch another SetPrefs Command here — that would recurse through
    // the reducer → EffectRunner → service.setPrefs → Command → ... and
    // overflow the stack.
    await Promise.resolve(this.context.globalState.update(PREFS_STORAGE_KEY, merged));

    // Cold-start restore intentionally reduces preferences before the backend
    // is spawned. Persist them now, then let startup's authoritative full
    // runtimePrefs.set apply them after readiness. For a live backend, await
    // the RPC so the EffectRunner can report a real failure instead of
    // acknowledging a provider toggle that never took effect.
    if (this.getArchState().settings.backendReady) {
      await this.backend.request('runtimePrefs.set', buildRuntimePrefsPayload(merged));
    }
  }

  /** Push the complete disabled-entry set for a session's system prompts to the
   *  backend (`systemPromptToggles.set`). The backend persists the set to a
   *  sidecar, rewrites the SDK base prompt, and re-emits `session.opened` —
   *  that re-emit (not this call's result) updates the host's
   *  `systemPromptsBySession` with fresh `disabled` flags. */
  async setSystemPromptToggles(sessionPath: string, disabledEntries: readonly string[]): Promise<void> {
    await this.backend.request('systemPromptToggles.set', {
      sessionPath,
      disabledEntries: [...disabledEntries],
    });
  }

  async setPruningSettings(updates: Partial<PruningSettings>): Promise<void> {
    const storage = this.createPruningSettingsStorage();
    await savePruningSettings(
      storage,
      // SET path: the reducer already applied the update optimistically, so do
      // not re-dispatch PruningSettingsChanged (avoids a lost-update flicker
      // under rapid sequential changes). Persistence still writes-or-mirrors and
      // notifies on disk failure. The LOAD path keeps its own dispatch.
      undefined,
      () => this.getArchState().settings.pruningSettings,
      updates,
      (message) => this.dispatchArch({ kind: 'NoticeShown', notice: message }),
    );
  }

  async loadPruningSettings(): Promise<void> {
    const storage = this.createPruningSettingsStorage();
    await loadPersistedPruningSettings(
      storage,
      (settings) => this.dispatchArch({ kind: 'PruningSettingsChanged', pruningSettings: settings }),
    );
  }

  private createPruningSettingsStorage(): PruningSettingsStorage {
    return {
      get: () => this.context.globalState.get<PruningSettings>(PRUNING_STORAGE_KEY),
      update: (value) => this.context.globalState.update(PRUNING_STORAGE_KEY, value),
    };
  }

  async setToolResultPruningSettings(updates: Partial<ToolResultPruningSettings>): Promise<void> {
    const storage = this.createToolResultPruningSettingsStorage();
    await saveToolResultPruningSettings(
      storage,
      // SET path: the reducer already applied the update optimistically, so do
      // not re-dispatch ToolResultPruningSettingsChanged (avoids a lost-update
      // flicker under rapid sequential changes). Persistence still writes-or-
      // mirrors and notifies on disk failure. The LOAD path keeps its own dispatch.
      undefined,
      () => this.getArchState().settings.toolResultPruningSettings,
      updates,
      (message) => this.dispatchArch({ kind: 'NoticeShown', notice: message }),
    );
  }

  async loadToolResultPruningSettings(): Promise<void> {
    const storage = this.createToolResultPruningSettingsStorage();
    await loadPersistedToolResultPruningSettings(
      storage,
      (settings) => this.dispatchArch({ kind: 'ToolResultPruningSettingsChanged', toolResultPruningSettings: settings }),
    );
  }

  private createToolResultPruningSettingsStorage(): ToolResultPruningSettingsStorage {
    return {
      get: () => this.context.globalState.get<ToolResultPruningSettings>(TOOL_RESULT_PRUNING_STORAGE_KEY),
      update: (value) => this.context.globalState.update(TOOL_RESULT_PRUNING_STORAGE_KEY, value),
    };
  }
}
