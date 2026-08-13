import * as vscode from 'vscode';
import * as crypto from 'node:crypto';

import { BackendClient } from '../backend/client';
import { resolveSessionOpenedTranscript } from '../core/session-opened-transcript';
import { auditLog } from '../util/audit';
import { toErrorMessage } from '../util/error-message';


import { isPendingTabPath } from '../../shared/tab-behavior';
import { modelSettingsMatchForHydration } from '../../shared/protocol';
import type {
  ModelInfo,
  ModelSettings,
  TranscriptPageDirection,
  TranscriptPagePayload,
} from '../../shared/protocol';
import {
  normalizeAttachUris,
} from '../core/composer';
import { buildTranscriptPageRequest } from '../core/transcript-window';
import { SessionServiceState } from './state';
import type { ScheduleRender } from './types';
import type { ArchState } from '../core/arch-state';
import type { Event } from '../core/events';

interface SessionMessageActionsOptions {
  context: vscode.ExtensionContext;
  backend: BackendClient;
  scheduleRender: ScheduleRender;
  state: SessionServiceState;
  createNewSession: () => string;
  getArchState: () => ArchState;
  dispatchArch: (event: Event) => void;
}

export class SessionMessageActions {
  private readonly context: vscode.ExtensionContext;
  private readonly backend: BackendClient;
  private readonly scheduleRender: ScheduleRender;
  private readonly state: SessionServiceState;
  private readonly createNewSession: () => string;
  private readonly getArchState: () => ArchState;
  private readonly dispatchArch: (event: Event) => void;

  constructor(options: SessionMessageActionsOptions) {
    this.context = options.context;
    this.backend = options.backend;
    this.scheduleRender = options.scheduleRender;
    this.state = options.state;
    this.createNewSession = options.createNewSession;
    this.getArchState = options.getArchState;
    this.dispatchArch = options.dispatchArch;
  }

  normalizeAttachUris(uris: vscode.Uri[]): vscode.Uri[] {
    return normalizeAttachUris(uris);
  }

  async addFilesystemPaths(
    requestedSessionPath: string | undefined,
    paths: string[],
    source: 'picker' | 'drop',
  ): Promise<void> {
    // Thin host-side entry: resolve the target session (possibly creating a new
    // one via createNewSession() when no session is active — the entanglement
    // the handoff flagged), clean the paths (trim, filter empty, dedup), then
    // dispatch the AddFilesystemPaths Command with the RESOLVED session path.
    // The reducer owns the composer-input append (creates filesystemPathRef
    // inputs with IDs from corrId, checks duplicates, appends to
    // pendingComposerInputsBySession) — no Effect or runner side effect (no
    // backend RPC). Mirrors createNewSession: the impure bits (session
    // resolution + path cleaning) happen host-side before the Command dispatch.
    const sessionPath = this.resolveComposerTargetSessionPath(requestedSessionPath);
    const uniquePaths = [...new Set(
      paths
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    )];
    if (!sessionPath || uniquePaths.length === 0) {
      return;
    }

    this.dispatchArch({
      kind: 'Command',
      cmd: {
        kind: 'AddFilesystemPaths',
        corrId: crypto.randomUUID(),
        sessionPath,
        paths: uniquePaths,
        source,
      },
    });
    this.scheduleRender();
  }

  async loadOlderTranscript(requestedSessionPath?: string): Promise<void> {
    await this.loadTranscriptPage('older', requestedSessionPath);
  }

  async loadNewerTranscript(requestedSessionPath?: string): Promise<void> {
    await this.loadTranscriptPage('newer', requestedSessionPath);
  }

  async jumpToLatestTranscript(requestedSessionPath?: string): Promise<void> {
    await this.loadTranscriptPage('latest', requestedSessionPath);
  }

  async hydrateModelState(sessionPath: string): Promise<void> {
    try {
      const [modelSettings, models] = await Promise.all([
        this.backend.request<ModelSettings>('settings.get'),
        this.backend.request<ModelInfo[]>('models.list', { sessionPath }),
      ]);

      // Sync the global `modelSettings` (persisted default model, provider,
      // and thinking level) read-only from the backend. This is a HYDRATE,
      // not a user model switch: it must not touch the focused session's live
      // model or persist anything, so we dispatch `ModelSettingsHydrated` (read-only ArchState
      // update) instead of `SetModel`. The previous implementation dispatched
      // `SetModel` whenever the session's per-session model differed from the
      // global default — a legitimate state (a session can run a non-default
      // model) — which then ran `settings.set` with `isChangingModel=true`,
      // tripping the backend's busy-session guard with a spurious
      // REQUEST_IN_PROGRESS error while a turn was streaming, and would have
      // clobbered the session's per-session model on top of that.
      const archState = this.getArchState();
      const currentSettings = archState.settings.modelSettings;
      const settingsInSync = modelSettingsMatchForHydration(currentSettings, modelSettings);
      if (!settingsInSync) {
        this.dispatchArch({ kind: 'ModelSettingsHydrated', modelSettings });
      }

      const existing = archState.settings.availableModelsBySession[sessionPath] ?? [];
      if (models.length > 0 || existing.length === 0) {
        this.dispatchArch({ kind: 'AvailableModelsChanged', sessionPath, models });
      }
      this.scheduleRender();
    } catch (err) {
      auditLog('session-service', 'hydrateModelState.failed', { error: toErrorMessage(err) });
    }
  }

  private async loadTranscriptPage(
    direction: TranscriptPageDirection,
    requestedSessionPath?: string,
  ): Promise<void> {
    const sessionPath = this.requireOpenSessionPath('load transcript page', requestedSessionPath);
    if (!sessionPath) {
      return;
    }

    const archState = this.getArchState();
    const transcriptWindow = archState.transcript.windowBySession[sessionPath];
    if (!transcriptWindow) {
      return;
    }

    if (direction === 'older' && !transcriptWindow.hasOlder) {
      return;
    }

    if (direction === 'newer' && !transcriptWindow.hasNewer) {
      return;
    }

    if (direction === 'latest' && !transcriptWindow.isPartial) {
      return;
    }

    // The in-flight guard + request-identity bookkeeping moved to the reducer
    // (TranscriptState.pagingInFlightBySession, keyed by the Command corrId).
    // The reducer blocks a second paging Command while one is in flight, so
    // this method is invoked at most once per in-flight request and no longer
    // needs its own in-flight Set or request-seq counter. The in-flight flag is
    // cleared by the matching *Result (or SessionScopeCleared on tab close).
    // The epoch/window/open-tabs staleness re-checks below stay host-side for
    // now (Phase 3/4 will fold the reducer-state reads into the reducer).
    const requestEpoch = this.state.getSessionDataEpoch(sessionPath);
    const requestWindow = {
      totalCount: transcriptWindow.totalCount,
      loadedStart: transcriptWindow.loadedStart,
      loadedEnd: transcriptWindow.loadedEnd,
    };

    try {
      const payload = await this.backend.request<TranscriptPagePayload>('session.loadTranscriptPage', {
        sessionPath,
        ...buildTranscriptPageRequest(transcriptWindow, direction),
      });

      if (this.state.getSessionDataEpoch(payload.sessionPath) !== requestEpoch) {
        return;
      }

      if (!this.getArchState().sessions.openTabPaths.includes(payload.sessionPath)) {
        return;
      }

      const currentWindow = this.getArchState().transcript.windowBySession[payload.sessionPath];
      if (
        !currentWindow
        || currentWindow.totalCount !== requestWindow.totalCount
        || currentWindow.loadedStart !== requestWindow.loadedStart
        || currentWindow.loadedEnd !== requestWindow.loadedEnd
      ) {
        return;
      }

      const resolution = resolveSessionOpenedTranscript({
        busy: payload.busy,
        incomingTranscript: payload.transcript,
        incomingTranscriptWindow: payload.transcriptWindow,
        localTranscript: this.getArchState().transcript.bySession[payload.sessionPath] ?? [],
      });

      this.dispatchArch({
        kind: 'TranscriptPageLoaded',
        sessionPath: payload.sessionPath,
        transcript: resolution.transcript,
        transcriptWindow: resolution.transcriptWindow,
      });

      this.state.touchSessionTranscript(payload.sessionPath);
      this.state.evictInactiveTranscriptWindows();
      this.scheduleRender();
    } catch (error) {
      this.dispatchArch({ kind: 'Error', sessionPath, error: `Failed to load transcript page: ${toErrorMessage(error)}` });
      this.scheduleRender();
    }
  }

  private requireOpenSessionPath(actionName: string, sessionPath?: string): string | null {
    // STATE_CONTRACT: callers must supply an explicit sessionPath. We no longer
    // silently fall back to the active session, because that masked bugs where
    // a webview message addressed to session A would land on session B after
    // the user switched tabs mid-flight (R3 / B4). If sessionPath is missing,
    // treat it as a malformed request and refuse.
    if (!sessionPath) {
      this.dispatchArch({ kind: 'NoticeShown', notice: `Cannot ${actionName}: missing session reference.` });
      this.scheduleRender();
      return null;
    }
    const resolvedSessionPath = sessionPath;
    if (isPendingTabPath(resolvedSessionPath)) {
      this.dispatchArch({ kind: 'NoticeShown', notice: `Cannot ${actionName}: the session is still opening.` });
      this.scheduleRender();
      return null;
    }
    if (!this.getArchState().sessions.openTabPaths.includes(resolvedSessionPath)) {
      this.dispatchArch({ kind: 'NoticeShown', notice: `Cannot ${actionName}: the selected session is no longer open.` });
      this.scheduleRender();
      return null;
    }
    return resolvedSessionPath;
  }

  private resolveComposerTargetSessionPath(requestedSessionPath?: string): string | null {
    const existingPath = this.resolveExistingComposerTargetSessionPath(requestedSessionPath);
    if (existingPath) {
      return existingPath;
    }

    return this.createNewSession();
  }

  private resolveExistingComposerTargetSessionPath(requestedSessionPath?: string): string | null {
    const archState = this.getArchState();
    // STATE_CONTRACT: composer-target resolution must come from the webview's
    // explicit sessionPath. The previous `?? selectActiveSessionPath` fallback
    // could land composer edits on a different tab if the webview's view of
    // the active session lagged behind the host (R3).
    const sessionPath = requestedSessionPath;
    if (!sessionPath) {
      return null;
    }
    if (!archState.sessions.openTabPaths.includes(sessionPath)) {
      this.dispatchArch({ kind: 'NoticeShown', notice: 'Cannot update composer inputs: the selected session is no longer open.' });
      this.scheduleRender();
      return null;
    }
    return sessionPath;
  }
}
