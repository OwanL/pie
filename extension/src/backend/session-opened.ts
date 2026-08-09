/**
 * buildSessionOpenedPayload — extracted from BackendServer.
 * Builds the full payload for a session.opened event.
 */

import { buildSessionAnalyticsFactors } from './session-analytics';
import { buildCurrentSummary, listAvailableModels } from './session-metadata';
import { buildTailTranscriptWindow, buildDisplayTranscriptCache, isDisplayTranscriptCacheStale } from './transcript-window';
import { deduplicateToolCallResultsForTransport } from '../shared/chat-message-parts';
import { buildSessionUsageSnapshot } from '../shared/session-usage';
import type { SessionOpenedPayload, SystemPromptEntry, TranscriptMode } from '../shared/protocol';
import type { SessionContext, SessionPromptState } from './server-types';
import type { SdkBuildSystemPromptOptions } from './sdk';
import type { SessionEntryLike } from './transcript';
import {
  LIVE_PIPELINE_LIMITS,
  type LiveTurnCheckpoint,
} from '../shared/live-pipeline-protocol.js';

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
  const liveTurnCheckpoint = buildSessionOpenedLiveCheckpoint(context);
  const rawTranscriptSlice = mode === 'skip'
    ? { transcript: [] as SessionOpenedPayload['transcript'], transcriptWindow: emptySkipWindow(cache) }
    : buildTailTranscriptWindow(cache, {
        pinnedMessageId: deps.getPinnedStreamingMessageId(context),
      });
  const transcriptSlice = {
    ...rawTranscriptSlice,
    transcript: streaming && liveTurnCheckpoint
      ? stripActiveAssistantTail(rawTranscriptSlice.transcript)
      : normalizeDanglingTranscript(rawTranscriptSlice.transcript),
  };
  const transportTranscript = transcriptSlice.transcript.map(deduplicateToolCallResultsForTransport);

  return {
    session: buildCurrentSummary(context, deps.startupCwd),
    transcript: transportTranscript,
    transcriptWindow: transcriptSlice.transcriptWindow,
    busy: context.session.isStreaming || !!context.activeRequest,
    ...(liveTurnCheckpoint ? { liveTurnCheckpoint } : {}),
    selectionToken,
    ...(mode === 'skip' && { transcriptSkipped: true }),
    systemPrompts,
    analyticsFactors,
    modelSettings,
    availableModels: listAvailableModels(context, deps.agentDir),
    contextUsage: contextUsage ?? undefined,
    // Cost/token indicators must describe the whole durable branch, not the
    // bounded transcript slice sent to the renderer. The full mapped cache is
    // already available here, so this adds no session-file scan.
    sessionUsage: buildSessionUsageSnapshot(cache.transcript),
  };
}

/** Build the atomic busy-open recovery snapshot. If it cannot be represented
 * within the protocol bound, return no checkpoint; the caller then keeps the
 * durable assistant tail visible instead of creating a false-empty session. */
export function buildSessionOpenedLiveCheckpoint(
  context: Pick<SessionContext, 'activeRequest'>,
): LiveTurnCheckpoint | undefined {
  const checkpoint = context.activeRequest?.liveTurnAccumulator?.checkpoint();
  if (!checkpoint || checkpoint.terminal) return undefined;
  try {
    const bytes = Buffer.byteLength(JSON.stringify(checkpoint), 'utf8');
    return bytes <= LIVE_PIPELINE_LIMITS.checkpointBytes
      && bytes <= checkpoint.checkpointBytes
      && checkpoint.turn.checkpointBytes === checkpoint.checkpointBytes
      ? checkpoint
      : undefined;
  } catch {
    return undefined;
  }
}

export function stripActiveAssistantTail(
  transcript: SessionOpenedPayload['transcript'],
): SessionOpenedPayload['transcript'] {
  let assistantIndex = -1;
  let userIndex = -1;
  for (let row = transcript.length - 1; row >= 0 && (assistantIndex < 0 || userIndex < 0); row -= 1) {
    if (assistantIndex < 0 && transcript[row]?.role === 'assistant') assistantIndex = row;
    if (userIndex < 0 && transcript[row]?.role === 'user') userIndex = row;
  }
  return assistantIndex <= userIndex
    ? transcript
    : transcript.filter((_message, row) => row !== assistantIndex);
}

export function normalizeDanglingTranscript(
  transcript: SessionOpenedPayload['transcript'],
): SessionOpenedPayload['transcript'] {
  return transcript.map((message) => {
    const hasDanglingTool = message.toolCalls?.some((tool) => tool.status === 'running') ?? false;
    if (!hasDanglingTool && message.status !== 'streaming') return message;
    const toolCalls = message.toolCalls?.map((tool) => tool.status === 'running'
      ? { ...tool, status: 'failed' as const }
      : tool);
    const parts = message.parts?.map((part) => part.kind === 'toolCall'
      ? { kind: 'toolCall' as const, toolCall: toolCalls?.find((tool) => tool.id === part.toolCall.id) ?? part.toolCall }
      : part);
    return {
      ...message,
      status: 'interrupted' as const,
      errorDetail: message.errorDetail ?? 'The prior process ended before this turn completed.',
      toolCalls,
      parts,
    };
  });
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

export function deriveActiveExtensionIds(extensionPaths: string[]): string[] {
  const ids = extensionPaths.flatMap((extensionPath) => {
    const segments = extensionPath.replace(/\\/g, '/').split('/').filter(Boolean);
    if (segments.length === 0 || extensionPath.startsWith('<')) return [];

    const nodeModulesIndex = segments.lastIndexOf('node_modules');
    if (nodeModulesIndex >= 0 && segments[nodeModulesIndex + 1]) {
      const packageName = segments[nodeModulesIndex + 1];
      return packageName.startsWith('@') && segments[nodeModulesIndex + 2]
        ? [`${packageName}/${segments[nodeModulesIndex + 2]}`]
        : [packageName];
    }

    const fileName = segments.at(-1)!;
    const stem = fileName.replace(/\.(?:[cm]?[jt]s|[jt]sx)$/, '');
    return [stem === 'index' && segments.length > 1 ? segments.at(-2)! : stem];
  });
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))].sort();
}

export function getPromptOptions(session: unknown): SdkBuildSystemPromptOptions | undefined {
  const promptState = session as SessionPromptState;
  const options = promptState._baseSystemPromptOptions;
  if (!options) return undefined;

  const loadedIds = deriveActiveExtensionIds(promptState._extensionRunner?.getExtensionPaths?.() ?? []);
  const activeExtensions = [...new Set([...(options.activeExtensions ?? []), ...loadedIds])].sort();
  return { ...options, activeExtensions };
}

export function ensureDisplayTranscriptCache(context: SessionContext) {
  const entries = (context.session.sessionManager.getBranch?.() ?? []) as SessionEntryLike[];
  if (isDisplayTranscriptCacheStale(context.displayTranscriptCache, entries)) {
    context.displayTranscriptCache = buildDisplayTranscriptCache(entries, context.sessionPath);
  }
  return context.displayTranscriptCache!;
}
