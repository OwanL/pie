import type { ArchState } from '../arch-state.js';
import type { Event } from '../events.js';
import type { ReducerResult } from './helpers.js';

export function handleActiveRunSummaryChanged(
  state: ArchState,
  event: Extract<Event, { kind: 'ActiveRunSummaryChanged' }>,
): ReducerResult {
  return {
    state: {
      ...state,
      composer: {
        ...state.composer,
        activeRunSummaryBySession: {
          ...state.composer.activeRunSummaryBySession,
          [event.sessionPath]: event.summary,
        },
      },
    },
    effects: [],
  };
}

export function handleComposerInputsReplaced(
  state: ArchState,
  event: Extract<Event, { kind: 'ComposerInputsReplaced' }>,
): ReducerResult {
  const next = { ...state.composer.pendingComposerInputsBySession };
  if (event.inputs === null || event.inputs.length === 0) {
    delete next[event.sessionPath];
  } else {
    next[event.sessionPath] = event.inputs;
  }
  return {
    state: {
      ...state,
      composer: {
        ...state.composer,
        pendingComposerInputsBySession: next,
      },
    },
    effects: [],
  };
}
