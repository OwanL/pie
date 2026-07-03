import { produce } from 'immer';

import type { ArchState } from '../arch-state.js';
import type { Event } from '../events.js';
import type { ReducerResult } from './helpers.js';
import { upsertTranscriptMessage } from './helpers.js';
import { stripReqIds } from '../../../shared/error-mapping.js';

export function handleCustomMessage(state: ArchState, event: Extract<Event, { kind: 'CustomMessage' }>): ReducerResult {
  const existing = state.transcript.bySession[event.sessionPath] ?? [];
  // Brief F: a pruning-result custom message arrives when the prepass
  // completes (the skill-pruner `before_agent_start` extension emits it).
  // While the session's prepass phase is 'running' (a promoted op exists,
  // post-ack/pre-commit), this is the success signal — transition to
  // 'succeeded' and capture the prepass latency for the post-hoc summary.
  // Guarded on 'running' so a pruning-result for an already-committed or
  // background turn (no active prepass) does not fabricate a chip.
  const isPruningResult = event.message.customType === 'pruning-result';
  const prepass = state.pending.prepassBySession[event.sessionPath];
  const transitionToSucceeded =
    isPruningResult && prepass?.phase === 'running';
  const latencyMs =
    transitionToSucceeded
      ? readPrepassLatencyMs(event.message.customDetails)
      : null;

  const nextState = produce(state, (draft) => {
    draft.transcript.bySession[event.sessionPath] = upsertTranscriptMessage(existing, event.message);
    if (transitionToSucceeded) {
      draft.pending.prepassBySession[event.sessionPath] = {
        phase: 'succeeded',
        latencyMs,
      };
    }
  });

  return { state: nextState, effects: [] };
}

/** Read `prepassLatencyMs` from a pruning-result custom message's details,
 *  defensively (the host does not normalize the payload — the webview does).
 *  Returns null when absent or non-numeric so the post-hoc summary omits it. */
function readPrepassLatencyMs(details: unknown): number | null {
  if (details && typeof details === 'object') {
    const v = (details as Record<string, unknown>).prepassLatencyMs;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

export function handleExtensionUIRequest(state: ArchState, event: Extract<Event, { kind: 'ExtensionUIRequest' }>): ReducerResult {
  const sessionPath = event.sessionPath;
  if (!sessionPath) {
    // Backward compat: skip if no session path.
    return { state, effects: [] };
  }
  return {
    state: produce(state, (draft) => {
      const sessionMap = draft.settings.pendingExtensionUIRequestsBySession[sessionPath] ?? {};
      sessionMap[event.request.id] = event.request;
      draft.settings.pendingExtensionUIRequestsBySession[sessionPath] = sessionMap;
    }),
    effects: [],
  };
}

export function handleError(state: ArchState, event: Extract<Event, { kind: 'Error' }>): ReducerResult {
  return {
    state: {
      ...state,
      settings: {
        ...state.settings,
        // Brief H: strip any internal req-NN before surfacing (transcript-paging
        // RPC timeouts carry req-NN). The raw, unredacted error is retained as
        // `noticeRaw` so the webview can reveal it via 'show more', and is still
        // logged host-side.
        notice: stripReqIds(event.error),
        noticeRaw: event.error ?? null,
      },
    },
    effects: [],
  };
}

export function handleNoticeShown(state: ArchState, event: Extract<Event, { kind: 'NoticeShown' }>): ReducerResult {
  return {
    state: produce(state, (draft) => {
      draft.settings.notice = event.notice;
      // Plain NoticeShown notices carry no recovery actions — clear any
      // prior error kind so a stale kind doesn't outlive its notice
      // (Brief H invariant: noticeKind non-null only for H-category errors).
      draft.settings.noticeKind = null;
      // Plain notices also carry no raw backend error — clear any prior raw
      // detail so a stale 'show more' doesn't outlive its notice.
      draft.settings.noticeRaw = null;
    }),
    effects: [],
  };
}

export function handlePendingExtensionUIRequestsCleared(state: ArchState, event: Extract<Event, { kind: 'PendingExtensionUIRequestsCleared' }>): ReducerResult {
  const { [event.sessionPath]: _removed, ...remaining } = state.settings.pendingExtensionUIRequestsBySession;
  return {
    state: {
      ...state,
      settings: {
        ...state.settings,
        pendingExtensionUIRequestsBySession: remaining,
      },
    },
    effects: [],
  };
}