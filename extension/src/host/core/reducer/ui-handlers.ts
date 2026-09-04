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
  const isPrepassSucceeded = isPruningResult || event.message.customType === 'preflight-succeeded';
  const prepass = state.pending.prepassBySession[event.sessionPath];
  // A no-op/disabled pruner can finish synchronously. In that case the backend
  // may publish preflight-succeeded before the message.send RPC acknowledgement
  // promotes pending.ops -> pending.promoted. Treat the oldest non-queued op
  // for this session as the owner; session RPC execution is FIFO, so later ops
  // cannot have entered preflight yet.
  const pendingCorrId = Object.entries(state.pending.ops).find(([, op]) =>
    op.sessionPath === event.sessionPath && !op.queued,
  )?.[0];
  const transitionToSucceeded =
    isPrepassSucceeded && (prepass?.phase === 'running' || (!!pendingCorrId && prepass?.phase !== 'succeeded'));
  const refreshSucceededDetails = isPruningResult && prepass?.phase === 'succeeded';
  const latencyMs =
    transitionToSucceeded || refreshSucceededDetails
      ? readPrepassLatencyMs(event.message.customDetails)
      : null;

  const nextState = produce(state, (draft) => {
    if (isPruningResult) {
      draft.transcript.bySession[event.sessionPath] = upsertTranscriptMessage(existing, event.message);
    }
    if (transitionToSucceeded || refreshSucceededDetails) {
      draft.pending.prepassBySession[event.sessionPath] = {
        phase: 'succeeded',
        latencyMs,
      };
    }
  });

  const promotedCorrId = transitionToSucceeded
    ? Object.entries(state.pending.promoted).find(([, op]) => op.sessionPath === event.sessionPath)?.[0]
    : undefined;
  const ownerCorrId = promotedCorrId ?? pendingCorrId;

  return {
    state: nextState,
    effects: transitionToSucceeded && ownerCorrId
      ? [{ kind: 'MarkPrepassSucceeded', corrId: ownerCorrId }]
      : [],
  };
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
      const turn = draft.livePipeline.turnsBySession[sessionPath];
      if (turn && !turn.pendingExtensionUiRequestIds.includes(event.request.id)) {
        turn.pendingExtensionUiRequestIds.push(event.request.id);
        turn.phase = 'waiting_input';
        draft.livePipeline.revisionBySession[sessionPath] =
          (draft.livePipeline.revisionBySession[sessionPath] ?? 0) + 1;
      }
    }),
    effects: [],
  };
}

export function handleIncidentReported(
  state: ArchState,
  event: Extract<Event, { kind: 'IncidentReported' }>,
): ReducerResult {
  const { incident } = event;
  return {
    state: produce(state, (draft) => {
      draft.settings.latestIncident = incident;
      draft.settings.notice = stripReqIds(incident.message);
      draft.settings.noticeSessionPath = incident.sessionPath;
      if (incident.severity === 'error') {
        draft.settings.noticeKind = incident.recovery.restart ? 'backend-exit' : 'operational-error';
        draft.settings.noticeRaw = incident.detail ?? incident.message;
      } else {
        draft.settings.noticeKind = null;
        draft.settings.noticeRaw = null;
      }
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
        // RPC timeouts carry req-NN). The full host-side error is retained as
        // `noticeRaw`; projection redacts credentials before the webview can
        // reveal it via More.
        notice: stripReqIds(event.error),
        // Brief H: classify the generic backend error so the webview renders a
        // fitting recovery action (`operational-error` → show-logs) instead of
        // leaking the prior notice's kind. Reset to null when there is no error
        // text (a clear), matching the clear pattern used elsewhere (NoticeShown,
        // host-handlers). STATE_CONTRACT § Notice Surfacing: `noticeRaw` is
        // non-null only when `notice` is an error notice.
        noticeKind: event.error ? 'operational-error' : null,
        noticeRaw: event.error ? (event.detail ?? event.error) : null,
        noticeSessionPath: event.error ? event.sessionPath : null,
        latestIncident: null,
      },
    },
    effects: [],
  };
}

export function handleNoticeShown(state: ArchState, event: Extract<Event, { kind: 'NoticeShown' }>): ReducerResult {
  return {
    state: produce(state, (draft) => {
      const hasNotice = event.notice !== null;
      const noticeKind = hasNotice ? event.noticeKind ?? null : null;
      draft.settings.notice = event.notice;
      draft.settings.noticeKind = noticeKind;
      // Plain info/warning notices never carry diagnostic detail. Clearing the
      // raw field here also prevents a previous error's "More" content from
      // surviving when a notice is replaced by an untyped notification.
      draft.settings.noticeRaw = noticeKind === null ? null : event.noticeRaw ?? null;
      draft.settings.noticeSessionPath = hasNotice ? (event.sessionPath ?? null) : null;
      draft.settings.latestIncident = null;
    }),
    effects: [],
  };
}

export function handlePendingExtensionUIRequestsCleared(state: ArchState, event: Extract<Event, { kind: 'PendingExtensionUIRequestsCleared' }>): ReducerResult {
  return {
    state: produce(state, (draft) => {
      delete draft.settings.pendingExtensionUIRequestsBySession[event.sessionPath];
      const turn = draft.livePipeline.turnsBySession[event.sessionPath];
      if (turn && turn.pendingExtensionUiRequestIds.length > 0) {
        turn.pendingExtensionUiRequestIds = [];
        if (turn.phase === 'waiting_input') turn.phase = 'running_tool';
        draft.livePipeline.revisionBySession[event.sessionPath] =
          (draft.livePipeline.revisionBySession[event.sessionPath] ?? 0) + 1;
      }
    }),
    effects: [],
  };
}
