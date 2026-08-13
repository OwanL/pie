import { JSONL_ENVELOPE_HEADROOM_BYTES, JSONL_MAX_LINE_BYTES, serializeJsonLine } from './jsonl';
import { SESSION_SNAPSHOT_TOO_LARGE_CODE } from './protocol/core';
import type { ChatMessage } from './protocol/messages';
import type { SessionOpenedPayload, SessionSummary, TranscriptWindow } from './protocol/sessions';

export const SESSION_SNAPSHOT_MAX_LINE_BYTES = JSONL_MAX_LINE_BYTES - JSONL_ENVELOPE_HEADROOM_BYTES;

export type SessionSnapshotTransport =
  | { kind: 'event'; event: 'session.opened' }
  | { kind: 'response'; requestId: string };

export class SessionSnapshotTooLargeError extends Error {
  readonly code = SESSION_SNAPSHOT_TOO_LARGE_CODE;
  readonly data: { bytes: number; maxBytes: number; requiredMessageId?: string };

  constructor(bytes: number, maxBytes: number, requiredMessageId?: string) {
    super(`Session snapshot cannot fit without truncating a required durable row (${bytes} > ${maxBytes} bytes).`);
    this.name = 'SessionSnapshotTooLargeError';
    this.data = { bytes, maxBytes, ...(requiredMessageId ? { requiredMessageId } : {}) };
  }
}

export interface TranscriptSnapshotPayload {
  transcript: ChatMessage[];
  transcriptWindow: TranscriptWindow;
  liveTurnCheckpoint?: unknown;
}

const SLIM_PATH_BYTES = 64 * 1024;
const SLIM_IDENTITY_BYTES = 4 * 1024;
const SLIM_SELECTION_BYTES = 4 * 1024;
const SLIM_RECOVERY_ID_BYTES = 1024;
const SNAPSHOT_UNAVAILABLE_MESSAGE = 'The lossless session snapshot exceeded the transport limit. Existing transcript state was preserved where available.';

function boundedUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const truncated = Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8');
  return truncated.endsWith('\uFFFD') ? truncated.slice(0, -1) : truncated;
}

function boundedCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(value)));
}

/**
 * Build the final, metadata-independent `session.opened` fallback. Every
 * retained string has a fixed UTF-8 cap and all user/configuration-owned bulk
 * fields (name, catalog, settings, prompts, reviews and usage) are omitted or
 * replaced. With the fixed event name/envelope this remains far below the
 * producer budget even when the original snapshot contains multi-megabyte
 * metadata.
 */
export function buildSlimSessionOpenedUnavailableFallback(
  payload: SessionOpenedPayload,
  transcriptWindow: TranscriptWindow,
): SessionOpenedPayload {
  const totalCount = boundedCount(transcriptWindow.totalCount);
  const edge = Math.min(totalCount, boundedCount(transcriptWindow.loadedEnd));
  const original = payload.session;
  const session: SessionSummary = {
    path: boundedUtf8(original.path, SLIM_PATH_BYTES),
    cwd: boundedUtf8(original.cwd, SLIM_PATH_BYTES),
    name: 'Conversation snapshot unavailable',
    isPlaceholder: true,
    modifiedAt: boundedUtf8(original.modifiedAt, 64),
    messageCount: boundedCount(original.messageCount),
    ...(original.sessionId
      ? { sessionId: boundedUtf8(original.sessionId, SLIM_IDENTITY_BYTES) }
      : {}),
    ...(original.identityFallback !== undefined ? { identityFallback: original.identityFallback } : {}),
  };
  const recovery = payload.liveTurnRecoveryIdentity;
  return {
    session,
    transcript: [],
    transcriptWindow: {
      totalCount,
      loadedStart: edge,
      loadedEnd: edge,
      hasOlder: edge > 0,
      hasNewer: edge < totalCount,
      isPartial: totalCount > 0,
      hasUserMessages: transcriptWindow.hasUserMessages,
    },
    busy: payload.busy,
    ...(payload.runtimeReady !== undefined ? { runtimeReady: payload.runtimeReady } : {}),
    ...(payload.isCompacting !== undefined ? { isCompacting: payload.isCompacting } : {}),
    ...(recovery ? {
      liveTurnRecoveryIdentity: {
        turnId: boundedUtf8(recovery.turnId, SLIM_RECOVERY_ID_BYTES),
        attemptId: boundedUtf8(recovery.attemptId, SLIM_RECOVERY_ID_BYTES),
      },
    } : {}),
    ...(payload.selectionToken
      ? { selectionToken: boundedUtf8(payload.selectionToken, SLIM_SELECTION_BYTES) }
      : {}),
    snapshotUnavailable: {
      code: SESSION_SNAPSHOT_TOO_LARGE_CODE,
      message: SNAPSHOT_UNAVAILABLE_MESSAGE,
    },
  };
}

export interface BoundTranscriptSnapshotOptions<T extends TranscriptSnapshotPayload> {
  transport: SessionSnapshotTransport;
  /** Edge introduced by the request and retained when rows must be removed. */
  requestedEdge: 'older' | 'newer';
  /** A live/pinned row takes precedence over the requested edge when present. */
  requiredMessageId?: string;
  /** Durable normalized replacement used before any row is removed. */
  checkpointFallback?: Pick<T, 'transcript' | 'transcriptWindow'>;
  /** Explicit metadata-only snapshot used when no required durable row can fit.
   * It must itself fit the final envelope and must truthfully mark the missing
   * transcript; session.opened supplies this to keep post-commit RPCs successful. */
  unavailableFallback?: T | readonly T[];
  /** Test-only override; production uses SESSION_SNAPSHOT_MAX_LINE_BYTES. */
  maxLineBytes?: number;
}

export function sessionSnapshotEnvelope<T>(payload: T, transport: SessionSnapshotTransport): unknown {
  return transport.kind === 'event'
    ? { event: transport.event, payload }
    : { id: transport.requestId, ok: true, result: payload };
}

export function sessionSnapshotLineBytes<T>(payload: T, transport: SessionSnapshotTransport): number {
  return Buffer.byteLength(serializeJsonLine(sessionSnapshotEnvelope(payload, transport)), 'utf8');
}

/**
 * Fits a transcript-bearing session snapshot at its complete final JSONL shape.
 * Degradation is lossless per durable row: an oversized live checkpoint is
 * omitted first in favour of its normalized durable transcript fallback, then
 * whole rows are removed. The requested/pinned edge is retained, and window
 * metadata continues to address the exact surviving contiguous range.
 */
export function boundTranscriptSnapshot<T extends TranscriptSnapshotPayload>(
  payload: T,
  options: BoundTranscriptSnapshotOptions<T>,
): T {
  const maxBytes = options.maxLineBytes ?? SESSION_SNAPSHOT_MAX_LINE_BYTES;
  let candidate = payload;
  let bytes = sessionSnapshotLineBytes(candidate, options.transport);
  if (bytes <= maxBytes) return candidate;

  if (candidate.liveTurnCheckpoint !== undefined) {
    if (!options.checkpointFallback) {
      throw new Error('Oversized live checkpoint snapshots require a normalized durable transcript fallback.');
    }
    const { liveTurnCheckpoint: _omitted, ...withoutCheckpoint } = candidate;
    candidate = {
      ...withoutCheckpoint,
      ...options.checkpointFallback,
    } as T;
    bytes = sessionSnapshotLineBytes(candidate, options.transport);
    if (bytes <= maxBytes) return candidate;
  }

  const sourceTranscript = candidate.transcript;
  let requiredIndex = options.requiredMessageId
    ? sourceTranscript.findIndex((message) => message.id === options.requiredMessageId)
    : -1;
  if (requiredIndex < 0 && sourceTranscript.length > 0) {
    requiredIndex = options.requestedEdge === 'older' ? 0 : sourceTranscript.length - 1;
  }

  const withRemovedRows = (removedCount: number): T => {
    // Prefer dropping oldest rows. Once that would cross the required row,
    // remove the remaining excess from the newer side instead.
    const removedFromStart = Math.min(removedCount, requiredIndex);
    const removedFromEnd = removedCount - removedFromStart;
    const transcript = sourceTranscript.slice(
      removedFromStart,
      sourceTranscript.length - removedFromEnd,
    );
    const loadedStart = candidate.transcriptWindow.loadedStart + removedFromStart;
    const loadedEnd = candidate.transcriptWindow.loadedEnd - removedFromEnd;
    return {
      ...candidate,
      transcript,
      transcriptWindow: rebuildTranscriptWindow(candidate.transcriptWindow, loadedStart, loadedEnd),
    };
  };

  if (sourceTranscript.length === 0) {
    return resolveUnavailableFallback(options, bytes, maxBytes, options.requiredMessageId);
  }

  const requiredOnly = withRemovedRows(sourceTranscript.length - 1);
  const requiredOnlyBytes = sessionSnapshotLineBytes(requiredOnly, options.transport);
  if (requiredOnlyBytes > maxBytes) {
    return resolveUnavailableFallback(
      options,
      requiredOnlyBytes,
      maxBytes,
      sourceTranscript[requiredIndex]?.id ?? options.requiredMessageId,
    );
  }

  // Find the smallest number of whole-row removals that fits. This bounds a
  // 240-row window in at most eight full-envelope serializations rather than
  // repeatedly stringifying a near-30-MiB candidate for every removed row.
  let low = 1;
  let high = sourceTranscript.length - 1;
  let fitted = requiredOnly;
  while (low <= high) {
    const removedCount = Math.floor((low + high) / 2);
    const next = withRemovedRows(removedCount);
    const nextBytes = sessionSnapshotLineBytes(next, options.transport);
    if (nextBytes <= maxBytes) {
      fitted = next;
      high = removedCount - 1;
    } else {
      low = removedCount + 1;
    }
  }
  return fitted;
}

function resolveUnavailableFallback<T extends TranscriptSnapshotPayload>(
  options: BoundTranscriptSnapshotOptions<T>,
  bytes: number,
  maxBytes: number,
  requiredMessageId?: string,
): T {
  const configured = options.unavailableFallback;
  const fallbacks = configured === undefined
    ? []
    : Array.isArray(configured) ? configured : [configured];
  for (const fallback of fallbacks) {
    if (sessionSnapshotLineBytes(fallback, options.transport) <= maxBytes) {
      return fallback as T;
    }
  }
  throw new SessionSnapshotTooLargeError(bytes, maxBytes, requiredMessageId);
}

function rebuildTranscriptWindow(
  original: TranscriptWindow,
  loadedStart: number,
  loadedEnd: number,
): TranscriptWindow {
  return {
    ...original,
    loadedStart,
    loadedEnd,
    hasOlder: loadedStart > 0,
    hasNewer: loadedEnd < original.totalCount,
    isPartial: loadedStart > 0 || loadedEnd < original.totalCount,
  };
}

export interface TranscriptWindowBudgets {
  /** Initial tail rows loaded on open/preload/create. */
  tailCount: number;
  /** Rows requested per older/newer page fetch. */
  pageSize: number;
  /** Hard cap for rows kept in an active loaded window. */
  maxLoadedCount: number;
  /** Tail rows retained for inactive sessions before hard eviction. */
  inactiveTailCount: number;
  /** Inactive session transcript eviction TTL in milliseconds. */
  inactiveTtlMs: number;
}

/**
 * Central transcript windowing budgets used by backend slicing, host culling,
 * and webview paging behavior.
 */
export const TRANSCRIPT_WINDOW_BUDGETS: TranscriptWindowBudgets = {
  // Keep initial open/preload payloads lean while making deep history quick to
  // traverse. A 120-row page reaches the longest observed session in at most
  // 18 actions without raising the 240-row in-memory cap.
  tailCount: 60,
  pageSize: 120,
  maxLoadedCount: 240,
  inactiveTailCount: 40,
  inactiveTtlMs: 2 * 60 * 1000,
};
