import type { ArchState } from '../arch-state.js';
import type { Command } from '../commands.js';
import type { ReducerResult } from './helpers.js';

function hasActiveInlineEditor(state: ArchState, sessionPath: string): boolean {
  const editingMessageId = state.transcript.editingMessageIdBySession[sessionPath];
  return !!editingMessageId
    && (state.transcript.bySession[sessionPath] ?? []).some((message) => message.id === editingMessageId);
}

export function handleLoadOlderTranscript(state: ArchState, cmd: Extract<Command, { kind: 'LoadOlderTranscript' }>): ReducerResult {
  // In-flight guard: at most one transcript paging request per session.
  // The reducer owns this flag (moved from the host-side Set on
  // SessionMessageActions); the matching LoadOlderTranscriptResult clears
  // it and SessionScopeCleared clears it on tab close. The flag is keyed
  // by the Command corrId so a stale result from a superseded request
  // (tab closed + reopened) cannot clear the current request's flag.
  if (
    state.transcript.pagingInFlightBySession[cmd.sessionPath]
    || hasActiveInlineEditor(state, cmd.sessionPath)
  ) {
    return { state, effects: [] };
  }
  return {
    state: {
      ...state,
      transcript: {
        ...state.transcript,
        pagingInFlightBySession: {
          ...state.transcript.pagingInFlightBySession,
          [cmd.sessionPath]: cmd.corrId,
        },
      },
    },
    effects: [
      {
        kind: 'LoadOlderTranscript',
        corrId: cmd.corrId,
        sessionPath: cmd.sessionPath,
      },
    ],
  };
}

export function handleLoadNewerTranscript(state: ArchState, cmd: Extract<Command, { kind: 'LoadNewerTranscript' }>): ReducerResult {
  // In-flight/edit guard — see LoadOlderTranscript.
  if (
    state.transcript.pagingInFlightBySession[cmd.sessionPath]
    || hasActiveInlineEditor(state, cmd.sessionPath)
  ) {
    return { state, effects: [] };
  }
  return {
    state: {
      ...state,
      transcript: {
        ...state.transcript,
        pagingInFlightBySession: {
          ...state.transcript.pagingInFlightBySession,
          [cmd.sessionPath]: cmd.corrId,
        },
      },
    },
    effects: [
      {
        kind: 'LoadNewerTranscript',
        corrId: cmd.corrId,
        sessionPath: cmd.sessionPath,
      },
    ],
  };
}

export function handleJumpToLatestTranscript(state: ArchState, cmd: Extract<Command, { kind: 'JumpToLatestTranscript' }>): ReducerResult {
  // In-flight/edit guard — see LoadOlderTranscript.
  if (
    state.transcript.pagingInFlightBySession[cmd.sessionPath]
    || hasActiveInlineEditor(state, cmd.sessionPath)
  ) {
    return { state, effects: [] };
  }
  return {
    state: {
      ...state,
      transcript: {
        ...state.transcript,
        pagingInFlightBySession: {
          ...state.transcript.pagingInFlightBySession,
          [cmd.sessionPath]: cmd.corrId,
        },
      },
    },
    effects: [
      {
        kind: 'JumpToLatestTranscript',
        corrId: cmd.corrId,
        sessionPath: cmd.sessionPath,
      },
    ],
  };
}
