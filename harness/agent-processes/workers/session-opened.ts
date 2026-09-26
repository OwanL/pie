/**
 * buildSessionOpenedPayload — extracted from BackendServer, executed by the
 * hot worker runtime. Builds the full payload for a session.opened event.
 */

import { buildSessionAnalyticsFactors } from './session-analytics';
import { buildCurrentSummary } from '../../session-storage/metadata/session-metadata';
import { loadAvailableModels } from '../../model-providers/catalog/model-catalog';
import { deduplicateToolCallResultsForTransport } from '../../session-storage/transcripts/message-parts.js';
import {
  boundTranscriptSnapshot,
  buildSlimSessionOpenedUnavailableFallback,
  type SessionSnapshotTransport,
} from '../../session-storage/transcripts/snapshot-boundary.js';
import { SESSION_SNAPSHOT_TOO_LARGE_CODE } from '../lib/rpc/wire.js';
import type { SessionOpenedPayload, SystemPromptEntry, TranscriptMode } from '../lib/rpc/session-events.js';
import type { SessionContext, SessionPromptState } from '../coordinator/server-types.js';
import type { SdkBuildSystemPromptOptions } from '../lib/sdk-integration/sdk';
import type { SessionEntryLike } from '../../session-storage/transcripts/transcript';
import { buildSessionCapabilities, hasBillableSessionActivity } from './session-activity';
import {
  LIVE_PIPELINE_LIMITS,
  type LiveTurnCheckpoint,
} from '../lib/rpc/live-pipeline.js';
import { buildTailTranscriptWindow, buildDisplayTranscriptCache, isDisplayTranscriptCacheStale } from '../../session-storage/transcripts/transcript-window';
import { normalizeDanglingTranscript } from '../../session-storage/transcripts/normalize-dangling-transcript';

export interface BuildSessionOpenedPayloadDeps {
  getContextUsage(context: SessionContext): import('../lib/rpc/session-events.js').ContextWindowUsage | undefined;
  readHarnessSystemPrompt(context: SessionContext): Promise<string | undefined>;
  buildSystemPrompts(context: SessionContext, harnessPromptOverride?: string): Promise<SystemPromptEntry[]>;
  readModelSettings(): Promise<import('../../model-providers/catalog/model-contract.js').ModelSettings>;
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
  transport: SessionSnapshotTransport = { kind: 'event', event: 'session.opened' },
  operationId?: string,
  operationAttempt?: number,
): Promise<SessionOpenedPayload> {
  const context = deps.getSessionContext(sessionPath);
  if (!context) {
    throw new Error(`Unknown session: ${sessionPath}`);
  }

  const harnessPrompt = await deps.readHarnessSystemPrompt(context);
  const promptOptions = getPromptOptions(context.session);
  const activeExtensionIds = getLoadedExtensionIds(context.session);
  const [systemPrompts, modelSettings, analyticsFactors] = await Promise.all([
    deps.buildSystemPrompts(context, harnessPrompt),
    deps.readModelSettings(),
    buildSessionAnalyticsFactors({
      harnessPrompt,
      promptOptions,
      activeExtensionIds,
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
  const billableActivity = hasBillableSessionActivity(context);
  const streaming = context.session.isStreaming || !!context.activeRequest;
  const mode: TranscriptMode = transcript === 'skip' && !billableActivity ? 'skip' : 'tail';

  const cache = ensureDisplayTranscriptCache(context);
  const liveTurnSnapshot = buildSessionOpenedLiveSnapshot(context);
  const liveTurnCheckpoint = liveTurnSnapshot.checkpoint;
  const liveTurnRecoveryIdentity = liveTurnSnapshot.recoveryIdentity;
  const rawTranscriptSlice = mode === 'skip'
    ? { transcript: [] as SessionOpenedPayload['transcript'], transcriptWindow: emptySkipWindow(cache) }
    : buildTailTranscriptWindow(cache, {
        pinnedMessageId: deps.getPinnedStreamingMessageId(context),
      });
  const durableTranscript = normalizeDanglingTranscript(rawTranscriptSlice.transcript)
    .map(deduplicateToolCallResultsForTransport);
  const transportTranscript = (streaming && liveTurnCheckpoint
    ? stripActiveAssistantTail(rawTranscriptSlice.transcript)
    : normalizeDanglingTranscript(rawTranscriptSlice.transcript))
    .map(deduplicateToolCallResultsForTransport);

  const catalog = loadAvailableModels(context, deps.agentDir);
  const payload: SessionOpenedPayload = {
    session: buildCurrentSummary(context, deps.startupCwd),
    transcript: transportTranscript,
    transcriptWindow: rawTranscriptSlice.transcriptWindow,
    busy: billableActivity,
    capabilities: buildSessionCapabilities(context),
    runtimeReady: true,
    // Compaction re-arms busy via `compaction_start`, but `isStreaming` /
    // `activeRequest` are both false while it runs. Carry the explicit flag so
    // a session opened mid-compaction still shows the "Compacting…" indicator
    // instead of reading as idle.
    isCompacting: context.session.isCompacting === true,
    ...(liveTurnCheckpoint ? { liveTurnCheckpoint } : {}),
    ...(liveTurnRecoveryIdentity ? { liveTurnRecoveryIdentity } : {}),
    selectionToken,
    operationId,
    operationAttempt,
    ...(mode === 'skip' && { transcriptSkipped: true }),
    systemPrompts,
    analyticsFactors,
    modelSettings,
    ...(catalog.ok ? { availableModels: catalog.models } : {}),
    contextUsage: contextUsage ?? undefined,
    // Cost/token indicators must describe the whole durable branch, not the
    // bounded transcript slice sent to the renderer. The full mapped cache is
    // already available here, so this adds no session-file scan.
    sessionUsage: cache.sessionUsage,
  };

  const snapshotUnavailable = {
    code: SESSION_SNAPSHOT_TOO_LARGE_CODE,
    message: 'The lossless session transcript snapshot exceeded the transport limit. Existing transcript state was preserved where available.',
  } as const;
  const emptyTranscriptWindow = emptyUnavailableWindow(rawTranscriptSlice.transcriptWindow);
  const { liveTurnCheckpoint: _checkpoint, ...metadata } = payload;
  const metadataUnavailableFallback: SessionOpenedPayload = {
    ...metadata,
    transcript: [],
    transcriptWindow: emptyTranscriptWindow,
    snapshotUnavailable,
  };
  // The final fallback is independent of user/configuration-owned metadata:
  // names, catalogs, settings, prompts, reviews and usage cannot make it grow.
  const slimUnavailableFallback = buildSlimSessionOpenedUnavailableFallback(
    payload,
    emptyTranscriptWindow,
  );

  return boundTranscriptSnapshot(payload, {
    transport,
    requestedEdge: 'newer',
    requiredMessageId: deps.getPinnedStreamingMessageId(context),
    ...(liveTurnCheckpoint ? {
      checkpointFallback: {
        transcript: durableTranscript,
        transcriptWindow: rawTranscriptSlice.transcriptWindow,
      },
    } : {}),
    unavailableFallback: [metadataUnavailableFallback, slimUnavailableFallback],
  });
}

/** Build the atomic busy-open recovery snapshot. If it cannot be represented,
 * retain only its bounded attempt identity so a cold host can still request the
 * exact checkpoint while keeping the durable assistant tail visible. */
export function buildSessionOpenedLiveSnapshot(
  context: Pick<SessionContext, 'activeRequest'>,
): {
  checkpoint?: LiveTurnCheckpoint;
  recoveryIdentity?: NonNullable<SessionOpenedPayload['liveTurnRecoveryIdentity']>;
} {
  let candidate: LiveTurnCheckpoint | undefined;
  try {
    candidate = context.activeRequest?.liveTurnAccumulator?.checkpoint();
  } catch {
    return {};
  }
  if (!candidate || candidate.terminal) return {};
  const recoveryIdentity = { turnId: candidate.turnId, attemptId: candidate.attemptId };
  try {
    const bytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8');
    const checkpoint = bytes <= LIVE_PIPELINE_LIMITS.checkpointBytes
      && bytes <= candidate.checkpointBytes
      && candidate.turn.checkpointBytes === candidate.checkpointBytes
      ? candidate
      : undefined;
    return { checkpoint, recoveryIdentity };
  } catch {
    return { recoveryIdentity };
  }
}

export function buildSessionOpenedLiveCheckpoint(
  context: Pick<SessionContext, 'activeRequest'>,
): LiveTurnCheckpoint | undefined {
  return buildSessionOpenedLiveSnapshot(context).checkpoint;
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

/** Exact zero-row window used when the full lossless snapshot cannot fit.
 * Unlike transcriptSkipped this can reach a cold host, so its gap metadata
 * truthfully identifies that no durable rows were transported. */
function emptyUnavailableWindow(
  original: SessionOpenedPayload['transcriptWindow'],
): SessionOpenedPayload['transcriptWindow'] {
  const edge = original.loadedEnd;
  return {
    ...original,
    loadedStart: edge,
    loadedEnd: edge,
    hasOlder: edge > 0,
    hasNewer: edge < original.totalCount,
    isPartial: original.totalCount > 0,
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

  const loadedIds = getLoadedExtensionIds(session);
  const activeExtensions = [...new Set([...(options.activeExtensions ?? []), ...loadedIds])].sort();
  return { ...options, activeExtensions };
}

export function getLoadedExtensionIds(session: unknown): string[] {
  const promptState = session as SessionPromptState;
  return deriveActiveExtensionIds(promptState._extensionRunner?.getExtensionPaths?.() ?? []);
}

export function ensureDisplayTranscriptCache(context: SessionContext) {
  const entries = (context.session.sessionManager.getBranch?.() ?? []) as SessionEntryLike[];
  if (isDisplayTranscriptCacheStale(context.displayTranscriptCache, entries)) {
    context.displayTranscriptCache = buildDisplayTranscriptCache(entries, context.sessionPath);
  }
  return context.displayTranscriptCache!;
}