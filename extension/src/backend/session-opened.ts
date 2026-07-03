/**
 * buildSessionOpenedPayload — extracted from BackendServer.
 * Builds the full payload for a session.opened event.
 */

import { buildSessionAnalyticsFactors } from './session-analytics';
import { buildCurrentSummary, listAvailableModels } from './session-metadata';
import { buildTailTranscriptWindow, buildDisplayTranscriptCache, isDisplayTranscriptCacheStale } from './transcript-window';
import type { SessionOpenedPayload, SystemPromptEntry, TranscriptMode } from '../shared/protocol';
import type { SessionContext, SessionPromptState } from './server-types';
import type { SdkBuildSystemPromptOptions } from './sdk';
import type { SessionEntryLike } from './transcript';

export interface BuildSessionOpenedPayloadDeps {
  getContextUsage(context: SessionContext): import('../shared/protocol').ContextWindowUsage | undefined;
  readHarnessSystemPrompt(context: SessionContext): Promise<string | undefined>;
  buildSystemPrompts(context: SessionContext, harnessPromptOverride?: string): Promise<SystemPromptEntry[]>;
  readModelSettings(): Promise<import('../shared/protocol').ModelSettings>;
  getPinnedStreamingMessageId(context: SessionContext): string | undefined;
  getSessionContext(sessionPath: string): SessionContext | undefined;
  agentDir: string;
  startupCwd: string;
}

export async function buildSessionOpenedPayload(
  sessionPath: string,
  deps: BuildSessionOpenedPayloadDeps,
  selectionToken?: string,
  transcript: TranscriptMode = 'tail',
): Promise<SessionOpenedPayload> {
  const context = deps.getSessionContext(sessionPath);
  if (!context) {
    throw new Error(`Unknown session: ${sessionPath}`);
  }

  const harnessPrompt = await deps.readHarnessSystemPrompt(context);
  const [systemPrompts, modelSettings, analyticsFactors] = await Promise.all([
    deps.buildSystemPrompts(context, harnessPrompt),
    deps.readModelSettings(),
    buildSessionAnalyticsFactors({
      harnessPrompt,
      promptOptions: getPromptOptions(context.session),
    }),
  ]);

  const contextUsage = deps.getContextUsage(context) ?? null;
  context.lastContextUsage = contextUsage;

  // `transcript: 'skip'` is a host-driven optimization: the host already has
  // the transcript loaded and only wants a metadata refresh (busy, context
  // usage, model settings, available models, session summary). Shipping the
  // tail window (~100 messages, potentially multi-MB for long sessions) just
  // to be replaced with the identical in-memory copy wastes ~2s per switch on
  // a stdout JSON round-trip. Fall back to `'tail'` when the session is mid-
  // streaming — the host never requests 'skip' for a running session, but this
  // defends against a stale host decision racing a just-started turn: the
  // authoritative snapshot is required during streaming (STATE_CONTRACT
  // "Snapshot Recovery"), so we must not omit it.
  const streaming = context.session.isStreaming || !!context.activeRequest;
  const mode: TranscriptMode = transcript === 'skip' && !streaming ? 'skip' : 'tail';

  const cache = ensureDisplayTranscriptCache(context);
  const transcriptSlice = mode === 'skip'
    ? { transcript: [] as SessionOpenedPayload['transcript'], transcriptWindow: emptySkipWindow(cache) }
    : buildTailTranscriptWindow(cache, {
        pinnedMessageId: deps.getPinnedStreamingMessageId(context),
      });

  return {
    session: buildCurrentSummary(context, deps.startupCwd),
    transcript: transcriptSlice.transcript,
    transcriptWindow: transcriptSlice.transcriptWindow,
    busy: context.session.isStreaming || !!context.activeRequest,
    selectionToken,
    ...(mode === 'skip' && { transcriptSkipped: true }),
    systemPrompts,
    analyticsFactors,
    modelSettings,
    availableModels: listAvailableModels(context, deps.agentDir),
    contextUsage: contextUsage ?? undefined,
  };
}

/** Sentinel window for a skipped-transcript response. The host ignores these
 *  fields when `transcriptSkipped` is set (it keeps its existing window), so
 *  the values only need to be internally consistent, not meaningful. */
function emptySkipWindow(cache: ReturnType<typeof ensureDisplayTranscriptCache>): SessionOpenedPayload['transcriptWindow'] {
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

function getPromptOptions(session: unknown): SdkBuildSystemPromptOptions | undefined {
  return (session as SessionPromptState)._baseSystemPromptOptions;
}

function ensureDisplayTranscriptCache(context: SessionContext) {
  const entries = (context.session.sessionManager.getBranch?.() ?? []) as SessionEntryLike[];
  if (isDisplayTranscriptCacheStale(context.displayTranscriptCache, entries)) {
    context.displayTranscriptCache = buildDisplayTranscriptCache(entries);
  }
  return context.displayTranscriptCache!;
}