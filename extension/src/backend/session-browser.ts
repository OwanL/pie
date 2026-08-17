import * as fs from 'node:fs/promises';

import { deriveSessionNameFromText, NEW_SESSION_NAME } from '../shared/session-name';
import {
  SESSION_SNAPSHOT_TOO_LARGE_CODE,
  type ContextWindowUsage,
  type ModelInfo,
  type ModelSettings,
  type SessionOpenedPayload,
  type SessionSummary,
  type TranscriptMode,
} from '../shared/protocol';
import {
  boundTranscriptSnapshot,
  buildSlimSessionOpenedUnavailableFallback,
  type SessionSnapshotTransport,
} from '../shared/transcript-window';
import { deduplicateToolCallResultsForTransport } from '../shared/chat-message-parts';
import { deriveContextUsageFromBranch } from './context-usage';
import { mergeReviewIntoSummary, readReviews } from './session-review-store';
import type { SdkSessionManager } from './sdk';
import { normalizeThinkingLevel } from './message-inputs';
import { buildDisplayTranscriptCache, buildTailTranscriptWindow } from './transcript-window';
import { normalizeDanglingTranscript } from './session-opened';
import type { SessionEntryLike } from './transcript';

export interface SessionBrowseSnapshot {
  manager: SdkSessionManager;
  sessionPath: string;
  cache: ReturnType<typeof buildDisplayTranscriptCache>;
  summary: SessionSummary;
  contextUsage?: ContextWindowUsage;
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Array<{ type?: string; text?: string }>)
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('');
}

function deriveName(manager: SdkSessionManager, branch: SessionEntryLike[]): { name: string; isPlaceholder: boolean } {
  const explicit = manager.getSessionName();
  if (explicit) return { name: explicit, isPlaceholder: false };
  for (const entry of branch) {
    if (entry.type === 'message' && entry.message?.role === 'user') {
      const derived = deriveSessionNameFromText(messageText(entry.message.content));
      if (!derived.isPlaceholder) return derived;
    }
  }
  return { name: NEW_SESSION_NAME, isPlaceholder: true };
}

export async function openSessionBrowseSnapshot(options: {
  manager: SdkSessionManager;
  sessionPath: string;
  startupCwd: string;
  availableModels: readonly ModelInfo[];
}): Promise<SessionBrowseSnapshot> {
  const { manager, sessionPath, startupCwd, availableModels } = options;
  const branch = (manager.getBranch?.() ?? []) as SessionEntryLike[];
  const cache = buildDisplayTranscriptCache(branch, sessionPath);
  const durableContext = manager.buildSessionContext?.();
  const activeModel = durableContext?.model ?? null;
  const modelInfo = activeModel
    ? availableModels.find((model) => model.id === activeModel.modelId && model.provider === activeModel.provider)
      ?? availableModels.find((model) => model.id === activeModel.modelId)
    : undefined;
  const contextUsage = modelInfo?.contextWindow
    ? deriveContextUsageFromBranch(branch, modelInfo.contextWindow)
    : undefined;
  const { name, isPlaceholder } = deriveName(manager, branch);
  let modifiedAt = new Date(0).toISOString();
  try {
    modifiedAt = (await fs.stat(sessionPath)).mtime.toISOString();
  } catch {
    // SessionManager.open supplied the authoritative readable snapshot. A
    // missing stat is represented by a stable epoch rather than wall-clock data.
  }
  const summary: SessionSummary = {
    path: sessionPath,
    cwd: manager.getCwd() || startupCwd,
    name,
    isPlaceholder,
    modifiedAt,
    messageCount: durableContext?.messages.length ?? cache.transcript.length,
    ...(activeModel ? { modelId: activeModel.modelId, provider: activeModel.provider } : {}),
    ...(durableContext?.thinkingLevel ? { thinkingLevel: normalizeThinkingLevel(durableContext.thinkingLevel) } : {}),
    ...(manager.getSessionId?.() ? { sessionId: manager.getSessionId?.() } : {}),
  };
  return {
    manager,
    sessionPath,
    cache,
    summary: mergeReviewIntoSummary(summary, readReviews()),
    contextUsage,
  };
}

function skippedWindow(cache: SessionBrowseSnapshot['cache']): SessionOpenedPayload['transcriptWindow'] {
  const totalCount = cache.transcript.length;
  return {
    totalCount,
    loadedStart: 0,
    loadedEnd: 0,
    hasOlder: false,
    hasNewer: totalCount > 0,
    isPartial: totalCount > 0,
    hasUserMessages: cache.hasUserMessages,
  };
}

export function buildBrowseSessionOpenedPayload(options: {
  browse: SessionBrowseSnapshot;
  modelSettings: ModelSettings;
  /** Omitted when catalog loading failed; an empty array is a successful,
   * authoritative empty catalog. */
  availableModels?: ModelInfo[];
  selectionToken?: string;
  /** Create-operation identity echoed from the creating RPC (§6.3), so the
   *  host can reconcile late success with the exact operation even when the
   *  snapshot had to fall back to the cold browse path. */
  operationId?: string;
  operationAttempt?: number;
  transcript?: TranscriptMode;
  transport?: SessionSnapshotTransport;
}): SessionOpenedPayload {
  const mode = options.transcript ?? 'tail';
  const slice = mode === 'skip'
    ? { transcript: [], transcriptWindow: skippedWindow(options.browse.cache) }
    : buildTailTranscriptWindow(options.browse.cache);
  const transcript = normalizeDanglingTranscript(slice.transcript)
    .map(deduplicateToolCallResultsForTransport);
  const payload: SessionOpenedPayload = {
    session: options.browse.summary,
    transcript,
    transcriptWindow: slice.transcriptWindow,
    busy: false,
    runtimeReady: false,
    selectionToken: options.selectionToken,
    operationId: options.operationId,
    operationAttempt: options.operationAttempt,
    ...(mode === 'skip' ? { transcriptSkipped: true } : {}),
    modelSettings: options.modelSettings,
    ...(options.availableModels !== undefined ? { availableModels: options.availableModels } : {}),
    contextUsage: options.browse.contextUsage,
    sessionUsage: options.browse.cache.sessionUsage,
  };
  const unavailableWindow = {
    ...slice.transcriptWindow,
    loadedStart: slice.transcriptWindow.loadedEnd,
    hasOlder: slice.transcriptWindow.loadedEnd > 0,
    isPartial: slice.transcriptWindow.totalCount > 0,
  };
  const metadataUnavailableFallback: SessionOpenedPayload = {
    ...payload,
    transcript: [],
    transcriptWindow: unavailableWindow,
    snapshotUnavailable: {
      code: SESSION_SNAPSHOT_TOO_LARGE_CODE,
      message: 'The lossless session transcript snapshot exceeded the transport limit. Existing transcript state was preserved where available.',
    },
  };
  const slimUnavailableFallback = buildSlimSessionOpenedUnavailableFallback(
    payload,
    unavailableWindow,
  );
  return boundTranscriptSnapshot(payload, {
    transport: options.transport ?? { kind: 'event', event: 'session.opened' },
    requestedEdge: 'newer',
    unavailableFallback: [metadataUnavailableFallback, slimUnavailableFallback],
  });
}
