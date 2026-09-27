import { produce } from 'immer';

import type { ArchState } from '../arch-state.js';
import type { Event } from '../events.js';
import type { ReducerResult } from './helpers.js';
import { AGENT_MESSAGE_CUSTOM_TYPE } from '../../../lib/protocol/messages.js';
import { appendLocalUserMessage, removeMessage } from './helpers.js';

export function handleOptimisticMessageInserted(state: ArchState, event: Extract<Event, { kind: 'OptimisticMessageInserted' }>): ReducerResult {
  // Pure: `new Date(event.timestamp)` is deterministic (timestamp injected by
  // the dispatcher, not wall-clock time). See arch-boundary-guards.test.ts.
  const nextState = produce(state, (draft) => {
    appendLocalUserMessage(draft, event.sessionPath, event.localId, event.text, undefined, new Date(event.timestamp).toISOString());
  });
  return { state: nextState, effects: [] };
}

export function handleAgentMessageReceived(
  state: ArchState,
  event: Extract<Event, { kind: 'AgentMessageReceived' }>,
): ReducerResult {
  // Event delivery may be retried independently of the session_control RPC.
  // A completed acceptance notification reconciles the initial optimistic
  // queued row, while a duplicate queued notification must never downgrade a
  // row already promoted by acceptance or queued delivery.
  const existing = (state.transcript.bySession[event.sessionPath] ?? [])
    .find((message) => message.id === event.localId);
  if (existing) {
    if (event.status !== 'completed' || existing.role !== 'user'
      || existing.customType !== AGENT_MESSAGE_CUSTOM_TYPE || existing.status !== 'queued') {
      return { state, effects: [] };
    }
    const nextState = produce(state, (draft) => {
      const row = draft.transcript.bySession[event.sessionPath]?.find((message) => message.id === event.localId);
      if (row?.role === 'user' && row.customType === AGENT_MESSAGE_CUSTOM_TYPE && row.status === 'queued') {
        row.status = 'completed';
      }
    });
    return { state: nextState, effects: [] };
  }
  const nextState = produce(state, (draft) => {
    appendLocalUserMessage(
      draft,
      event.sessionPath,
      event.localId,
      event.text,
      undefined,
      new Date(event.timestamp).toISOString(),
      event.status,
      AGENT_MESSAGE_CUSTOM_TYPE,
    );
  });
  return { state: nextState, effects: [] };
}

export function handleAgentMessageRejected(
  state: ArchState,
  event: Extract<Event, { kind: 'AgentMessageRejected' }>,
): ReducerResult {
  const nextState = produce(state, (draft) => {
    removeMessage(draft, event.sessionPath, event.localId);
  });
  return { state: nextState, effects: [] };
}

export function handleOptimisticMessageRemoved(state: ArchState, event: Extract<Event, { kind: 'OptimisticMessageRemoved' }>): ReducerResult {
  const nextState = produce(state, (draft) => {
    removeMessage(draft, event.sessionPath, event.localId);
  });
  return { state: nextState, effects: [] };
}