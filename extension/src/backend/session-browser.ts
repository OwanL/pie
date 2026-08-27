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
  readonly sessionPath: string;
  readonly cache: Readonly<ReturnType<typeof buildDisplayTranscriptCache>>;
  /** Durable summary before review-sidecar decoration. */
  readonly summary: Readonly<SessionSummary>;
  readonly activeModel: Readonly<{ provider: string; modelId: string }> | null;
  readonly contextTokens?: number;
  readonly hasExplicitThinkingLevel: boolean;
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
}): Promise<SessionBrowseSnapshot> {
  const { manager, sessionPath, startupCwd } = options;
  const branch = (manager.getBranch?.() ?? []) as SessionEntryLike[];
  const cache = buildDisplayTranscriptCache(branch, sessionPath);
  const durableContext = manager.buildSessionContext?.();
  const activeModel = durableContext?.model ? { ...durableContext.model } : null;
  // Cache the model-independent prompt footprint. Configured catalogs are
  // coordinator metadata and may change while the durable JSONL does not, so
  // the context-window denominator is applied afresh when an open is built.
  const derivedContextTokens = deriveContextUsageFromBranch(branch, Number.MAX_SAFE_INTEGER)?.tokens;
  const contextTokens = typeof derivedContextTokens === 'number' ? derivedContextTokens : undefined;
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
  // The projection exposes no SessionManager and is immutable by ownership:
  // downstream browse builders only read it. Freeze the small containers to
  // catch accidental replacement without recursively walking a potentially
  // 65 MiB transcript on the cache-fill path.
  Object.freeze(cache);
  Object.freeze(summary);
  if (activeModel) Object.freeze(activeModel);
  return Object.freeze({
    sessionPath,
    cache,
    summary,
    activeModel,
    contextTokens,
    hasExplicitThinkingLevel: branch.some((entry) => entry.type === 'thinking_level_change'),
  });
}

function deriveContextUsage(
  browse: SessionBrowseSnapshot,
  availableModels: readonly ModelInfo[],
): ContextWindowUsage | undefined {
  if (browse.contextTokens === undefined || !browse.activeModel) return undefined;
  const modelInfo = availableModels.find((model) => (
    model.id === browse.activeModel!.modelId && model.provider === browse.activeModel!.provider
  )) ?? availableModels.find((model) => model.id === browse.activeModel!.modelId);
  const rawContextWindow = modelInfo?.contextWindow;
  if (typeof rawContextWindow !== 'number' || !Number.isFinite(rawContextWindow) || rawContextWindow <= 0) {
    return undefined;
  }
  const contextWindow = Math.trunc(rawContextWindow);
  return {
    tokens: browse.contextTokens,
    contextWindow,
    percent: Math.min(100, Math.max(0, (browse.contextTokens / contextWindow) * 100)),
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
  systemPromptDisabledEntries?: readonly string[];
}): SessionOpenedPayload {
  const mode = options.transcript ?? 'tail';
  const slice = mode === 'skip'
    ? { transcript: [], transcriptWindow: skippedWindow(options.browse.cache) }
    : buildTailTranscriptWindow(options.browse.cache);
  const transcript = normalizeDanglingTranscript(slice.transcript)
    .map(deduplicateToolCallResultsForTransport);
  const reviewedSummary = mergeReviewIntoSummary(options.browse.summary, readReviews());
  const session = options.browse.hasExplicitThinkingLevel
    ? reviewedSummary
    : {
        ...reviewedSummary,
        // Pi's empty branch context reports `off` when no durable change entry
        // exists. That is an implementation fallback, not the user's new-chat
        // preference; inherit the configured default until the branch records
        // an explicit reasoning choice.
        thinkingLevel: options.modelSettings.defaultThinkingLevel,
      };
  const payload: SessionOpenedPayload = {
    session,
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
    contextUsage: deriveContextUsage(options.browse, options.availableModels ?? []),
    sessionUsage: options.browse.cache.sessionUsage,
    ...(options.systemPromptDisabledEntries !== undefined
      ? { systemPromptDisabledEntries: [...options.systemPromptDisabledEntries] }
      : {}),
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
