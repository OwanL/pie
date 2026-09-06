import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AuxiliaryLlmUsagePayload, DetailResult, LazyDetailRef, RequestEnvelope, SessionOpenedPayload } from '../shared/protocol';
import { toErrorMessage } from '../shared/error-message';
import { boundTranscriptSnapshot } from '../shared/transcript-window';
import { generateSessionTitle } from './session-title-generator';
import { hasBillableSessionActivity } from './session-activity';
import type { SdkSessionManager } from './sdk';
import type { SessionContext } from './server-types';
import { BackendError } from './server-io';
import {
  validateLoadTranscriptPage,
  validateSessionCreate,
  validateSessionDuplicate,
  validateSessionOpen,
  validateSessionPath,
  validateSessionViewed,
  validateSessionTitleGenerate,
  validateTruncateAfter,
} from './rpc';
import {
  type BackendRequestHandlerDeps,
  type RequestHandler,
  type TranscriptPageLoadOptions,
  getCreateOperationLedger,
  markRequestValidated,
  requireSessionTransition,
} from './request-handler-shared';

async function handleSessionList(
  deps: BackendRequestHandlerDeps,
  _request: RequestEnvelope,
): Promise<unknown> {
  markRequestValidated(deps);
  return await deps.listSessions();
}

/** Attempt and selection metadata are transport concerns, not mutation intent. */
function createOperationIntentFingerprint(
  kind: 'session.create' | 'session.duplicate',
  pathIdentity: string,
): string {
  return JSON.stringify([kind, path.resolve(pathIdentity)]);
}

/** Shared post-durable-create publication phase for `session.create` and
 * `session.duplicate`. Durable manager-handle installation is already complete
 * before this runs; publication remains runtime-free and therefore reports the
 * cold store's `runtimeReady:false` snapshot. */
async function publishCreatedSession(
  deps: BackendRequestHandlerDeps,
  sessionPath: string,
  params: { selectionToken?: string; operationId?: string; operationAttempt?: number },
  publicRequestId: string,
): Promise<{ sessionPath: string }> {
  const viewedRevision = deps.captureViewedSessionRevision?.();
  if (deps.setViewedSessionPathIfCurrent && viewedRevision !== undefined) {
    deps.setViewedSessionPathIfCurrent(sessionPath, viewedRevision);
  } else {
    deps.setViewedSessionPath(sessionPath);
  }
  const payload = await deps.buildSessionOpenedPayload(
    sessionPath,
    params.selectionToken,
    undefined,
    undefined,
    params.operationId,
    params.operationAttempt,
    undefined,
    publicRequestId,
  );
  deps.emit('session.opened', payload);
  void deps.emitSessionListChanged();
  return { sessionPath };
}

function sessionManagerPath(manager: SdkSessionManager): string {
  const sessionPath = manager.getSessionFile?.();
  if (!sessionPath) throw new BackendError('SESSION_CREATE_FAILED', 'The SDK did not allocate a durable session path.');
  return sessionPath;
}

function createColdSession(deps: BackendRequestHandlerDeps, cwd?: string): { sessionPath: string } {
  if (deps.createColdSession) return deps.createColdSession(cwd);
  const manager = deps.sdk.SessionManager.create(cwd || deps.startupCwd, deps.sessionDir);
  return { sessionPath: sessionManagerPath(manager) };
}

async function duplicateColdSession(
  deps: BackendRequestHandlerDeps,
  sourcePath: string,
  publicRequestId: string,
): Promise<{ sessionPath: string }> {
  if (deps.duplicateColdSession) return await deps.duplicateColdSession(sourcePath, publicRequestId);
  const sourceCwd = deps.sdk.SessionManager.open(sourcePath).getCwd() || deps.startupCwd;
  return {
    sessionPath: sessionManagerPath(deps.sdk.SessionManager.forkFrom(sourcePath, sourceCwd, deps.sessionDir)),
  };
}

async function handleSessionCreate(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateSessionCreate(request.params);
  markRequestValidated(deps);
  if (params.operationId !== undefined) {
    // §6.3 idempotent create: dedupe concurrent/retried RPCs by the stable
    // host-generated operation identity. A retry can never create a second
    // durable session; a completed result is reused, and a durable path left
    // behind by a failed publication is resumed instead of recreated.
    const result = await getCreateOperationLedger(deps).run({
      operationId: params.operationId,
      intentFingerprint: createOperationIntentFingerprint(
        'session.create',
        params.cwd || deps.startupCwd,
      ),
      execute: async (registerDurablePath) => {
        const created = createColdSession(deps, params.cwd);
        // The server callback installs the process-local manager handle before
        // returning. Only then may the ledger record the durable commit.
        registerDurablePath(created.sessionPath);
        return await publishCreatedSession(deps, created.sessionPath, params, request.id);
      },
      resume: async (durablePath) => {
        return await publishCreatedSession(deps, durablePath, params, request.id);
      },
      republish: async (sessionPath) => {
        // Best-effort: the durable result is committed; a lost first
        // `session.opened` must not fail the retry ack.
        const payload = await deps.buildSessionOpenedPayload(
          sessionPath,
          params.selectionToken,
          undefined,
          undefined,
          params.operationId,
          params.operationAttempt,
          undefined,
          request.id,
        );
        deps.emit('session.opened', payload);
      },
    });
    return { ok: true, sessionPath: result.sessionPath };
  }
  const created = createColdSession(deps, params.cwd);
  const result = await publishCreatedSession(deps, created.sessionPath, params, request.id);
  return { ok: true, sessionPath: result.sessionPath };
}

async function handleSessionOpen(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateSessionOpen(request.params);
  markRequestValidated(deps);
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
      undefined,
      params.operationId,
      params.operationAttempt,
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
    deps.emitBusyChanged(context, hasBillableSessionActivity(context));
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
  markRequestValidated(deps);
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
  markRequestValidated(deps);
  if (params.operationId !== undefined) {
    // §6.3 idempotent duplicate: same ledger semantics as `session.create`.
    const result = await getCreateOperationLedger(deps).run({
      operationId: params.operationId,
      intentFingerprint: createOperationIntentFingerprint('session.duplicate', params.sessionPath),
      execute: async (registerDurablePath) => {
        const duplicate = await duplicateColdSession(deps, params.sessionPath, request.id);
        registerDurablePath(duplicate.sessionPath);
        return await publishCreatedSession(deps, duplicate.sessionPath, params, request.id);
      },
      resume: async (durablePath) => {
        return await publishCreatedSession(deps, durablePath, params, request.id);
      },
      republish: async (sessionPath) => {
        // Best-effort: the durable result is committed; a lost first
        // `session.opened` must not fail the retry ack.
        const payload = await deps.buildSessionOpenedPayload(
          sessionPath,
          params.selectionToken,
          undefined,
          undefined,
          params.operationId,
          params.operationAttempt,
          undefined,
          request.id,
        );
        deps.emit('session.opened', payload);
      },
    });
    return { ok: true, sessionPath: result.sessionPath };
  }
  const duplicate = await duplicateColdSession(deps, params.sessionPath, request.id);
  const result = await publishCreatedSession(deps, duplicate.sessionPath, params, request.id);
  return { ok: true, sessionPath: result.sessionPath };
}

async function handleSessionPreload(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateSessionPath('session.preload', request.params);
  markRequestValidated(deps);
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
  markRequestValidated(deps);
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
  markRequestValidated(deps);
  const active = deps.getSessionContext(params.sessionPath)?.activeRequest;
  const pageOptions: TranscriptPageLoadOptions = {
    transport: { kind: 'response', requestId: request.id },
    requiredMessageId: active?.currentMessageId ?? active?.lastAssistantMessageId,
  };
  const page = await deps.loadTranscriptPage(
    params.sessionPath,
    params.direction,
    params.loadedStart,
    params.loadedEnd,
    pageOptions,
  );
  const bounded = boundTranscriptSnapshot(page, {
    transport: pageOptions.transport,
    requestedEdge: params.direction === 'older' ? 'older' : 'newer',
    requiredMessageId: pageOptions.requiredMessageId,
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
  markRequestValidated(deps);
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
  markRequestValidated(deps);

  const existingCtx = deps.getSessionContext(params.sessionPath);
  if (existingCtx && hasBillableSessionActivity(existingCtx)) {
    throw new BackendError('STREAMING_BUSY', 'Cannot truncate a session while billable activity is still running.');
  }

  if (!existingCtx) {
    if (!deps.truncateColdSessionAfter) {
      throw new BackendError('UNAVAILABLE', 'Cold session truncate is unavailable.');
    }
    const result = await deps.truncateColdSessionAfter(params.sessionPath, params.entryId);
    const payload = await deps.buildSessionOpenedPayload(result.sessionPath);
    deps.emit('session.opened', payload);
    void deps.emitSessionListChanged();
    return { ok: true, sessionPath: result.sessionPath };
  }

  // Capture the user's chosen model + thinking level BEFORE truncating. The
  // SDK stores model choices as `model_change` entries appended at the session
  // leaf; truncating at an older entry drops every `model_change` that
  // followed, so the reopened session would silently revert to the previous
  // model (and the edit turn would then run on that model — an expensive
  // surprise after a `setModel` the user explicitly made). We re-apply the
  // captured choice to the fresh context below so the model survives a
  // transcript truncation. See STATE_CONTRACT § Optimistic Reconciliation.
  const previousModelId = existingCtx.session.model?.id;
  const previousProvider = existingCtx.session.model?.provider;
  const previousThinkingLevel = existingCtx.session.thinkingLevel;

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

async function handleSessionTitleGenerate(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateSessionTitleGenerate(request.params);
  markRequestValidated(deps);
  const context = await requireSessionTransition(deps, params.sessionPath);
  return await generateSessionTitle(context, {
    sdkPath: deps.sdkPath,
    prompt: params.prompt,
    provider: params.provider,
    model: params.model,
    thinkingLevel: params.thinkingLevel,
    timeoutSec: params.timeoutSec,
  }, {
    onSettled: ({ usage, startedAt, endedAt, outcome }) => {
      deps.emit('auxiliary-llm.usage', {
        sessionPath: params.sessionPath,
        kind: 'session_title',
        sourceId: `session-title:${request.id}`,
        occurredAt: endedAt,
        startedAt,
        modelId: params.model,
        provider: params.provider,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cacheReadTokens: usage?.cacheReadTokens ?? 0,
        cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
        ...(usage?.reportedCostUsd !== undefined ? { reportedCostUsd: usage.reportedCostUsd } : {}),
        durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
        outcome,
        ...(!usage ? {
          instrumentationGap: true,
          instrumentationGapReason: 'The session-title provider invocation exposed no usage.',
        } : {}),
      } satisfies AuxiliaryLlmUsagePayload);
    },
  });
}


export const SESSION_REQUEST_HANDLERS: Readonly<Record<string, RequestHandler>> = {
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
  'session.title.generate': handleSessionTitleGenerate,
};
