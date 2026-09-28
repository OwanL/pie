import type { SessionOpenedPayload } from './session-events.js';
import { SESSION_SNAPSHOT_TOO_LARGE_CODE } from './wire.js';

/**
 * Project a session-opened snapshot onto the metadata-only worker IPC path.
 * The coordinator/host can retrieve rows through the existing transcript-page
 * route; this projection prevents large transcript detail graphs from crossing
 * the private event frame while retaining session metadata. This is used for
 * the private runtime.promote input; the public event path uses
 * `sessionOpenedUnavailableForWorkerIpc` so cold-host gap semantics stay explicit.
 */
export function sessionOpenedMetadataForWorkerIpc(payload: SessionOpenedPayload): SessionOpenedPayload {
  // An unavailable cold snapshot is a real history gap, not a metadata refresh.
  // Keep its page cursor/window intact so a host without a loaded transcript can
  // recover from the correct edge. Existing transcriptSkipped publications are
  // preserved as-is by the spread below.
  if (payload.snapshotUnavailable !== undefined) {
    return { ...payload, transcript: [] };
  }

  const totalCount = Number.isSafeInteger(payload.transcriptWindow.totalCount)
    ? Math.max(0, payload.transcriptWindow.totalCount)
    : 0;
  return {
    ...payload,
    transcript: [],
    transcriptSkipped: true,
    transcriptWindow: {
      ...payload.transcriptWindow,
      loadedStart: 0,
      loadedEnd: 0,
      hasOlder: false,
      hasNewer: totalCount > 0,
      isPartial: totalCount > 0,
    },
  };
}

/**
 * Drop only the transcript rows from a structurally oversized public event.
 * Unlike the private promotion metadata input, this carries explicit
 * snapshotUnavailable semantics and an empty window at the omitted range edge.
 */
export function sessionOpenedUnavailableForWorkerIpc(payload: SessionOpenedPayload): SessionOpenedPayload {
  if (payload.snapshotUnavailable !== undefined) {
    return { ...payload, transcript: [] };
  }

  const totalCount = Number.isSafeInteger(payload.transcriptWindow.totalCount)
    ? Math.max(0, payload.transcriptWindow.totalCount)
    : 0;
  const edge = Number.isSafeInteger(payload.transcriptWindow.loadedEnd)
    ? Math.max(0, Math.min(totalCount, payload.transcriptWindow.loadedEnd))
    : 0;
  return {
    ...payload,
    transcript: [],
    transcriptWindow: {
      ...payload.transcriptWindow,
      loadedStart: edge,
      loadedEnd: edge,
      hasOlder: edge > 0,
      hasNewer: edge < totalCount,
      isPartial: totalCount > 0,
    },
    snapshotUnavailable: {
      code: SESSION_SNAPSHOT_TOO_LARGE_CODE,
      message: 'The session transcript could not fit the worker IPC structural limit. Existing transcript state was preserved where available.',
    },
  };
}
