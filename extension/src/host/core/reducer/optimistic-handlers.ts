import { produce } from 'immer';

import type { ArchState } from '../arch-state.js';
import type { Event } from '../events.js';
import type { ReducerResult } from './helpers.js';
import { appendLocalUserMessage, removeMessage } from './helpers.js';

export function handleOptimisticMessageInserted(state: ArchState, event: Extract<Event, { kind: 'OptimisticMessageInserted' }>): ReducerResult {
  // Pure: `new Date(event.timestamp)` is deterministic (timestamp injected by
  // the dispatcher, not wall-clock time). See arch-boundary-guards.test.ts.
  const nextState = produce(state, (draft) => {
    appendLocalUserMessage(draft, event.sessionPath, event.localId, event.text, undefined, new Date(event.timestamp).toISOString());
  });
  return { state: nextState, effects: [] };
}

export function handleOptimisticMessageRemoved(state: ArchState, event: Extract<Event, { kind: 'OptimisticMessageRemoved' }>): ReducerResult {
  const nextState = produce(state, (draft) => {
    removeMessage(draft, event.sessionPath, event.localId);
  });
  return { state: nextState, effects: [] };
}