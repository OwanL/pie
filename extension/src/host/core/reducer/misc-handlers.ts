import type { ArchState } from '../arch-state.js';
import type { Event } from '../events.js';
import type { ReducerResult } from './helpers.js';

export function handleTruncateResult(state: ArchState, event: Extract<Event, { kind: 'TruncateResult' }>): ReducerResult {
  if (event.ok) return { state, effects: [] };
  return {
    state: {
      ...state,
      settings: {
        ...state.settings,
        notice: 'Could not delete the transcript from this point. The session was not changed.',
        noticeKind: 'operational-error',
        noticeRaw: event.error ?? 'session.truncateAfter failed without an error message',
        noticeSessionPath: event.sessionPath,
      },
    },
    effects: [],
  };
}

export function handleCreateSessionResult(state: ArchState, _event: Extract<Event, { kind: 'CreateSessionResult' }>): ReducerResult {
  return { state, effects: [] };
}

export function handleDuplicateSessionResult(state: ArchState, _event: Extract<Event, { kind: 'DuplicateSessionResult' }>): ReducerResult {
  // No-op: recovery is host-driven via `handleSelectionFailure` (which
  // dispatches SessionScopeCleared + SelectSession-fallback + NoticeShown to
  // undo the optimistic setup), mirroring CreateSession/OpenSession. The result
  // event exists only to complete the Command→reducer→Effect→runner→Result
  // spine; the reducer has no pending snapshot to reconcile.
  return { state, effects: [] };
}

export function handleOpenSessionResult(state: ArchState, _event: Extract<Event, { kind: 'OpenSessionResult' }>): ReducerResult {
  return { state, effects: [] };
}

export function handleCloseSessionResult(state: ArchState, _event: Extract<Event, { kind: 'CloseSessionResult' }>): ReducerResult {
  // No-op: close is purely host-side (no backend RPC), and the reducer already
  // did the optimistic tab-close + select-next + map clearing. The runner's
  // CloseSession Effect does host-side cleanup (clearSelectionRequests,
  // onSessionClosed, clearSessionScope, evict) + the recursive
  // openSession(nextPath) — none of which needs reducer reconciliation. The
  // result event exists only to complete the Command→reducer→Effect→runner→
  // Result spine.
  return { state, effects: [] };
}

export function handlePersistTabsResult(state: ArchState, _event: Extract<Event, { kind: 'PersistTabsResult' }>): ReducerResult {
  return { state, effects: [] };
}