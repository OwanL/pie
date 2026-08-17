import type { ArchState } from '../arch-state.js';
import type { Command } from '../commands.js';
import type { ReducerResult } from './helpers.js';

/**
 * Phase 5 detail subscription commands — pass-through reducers. The webview
 * owns `detailKey` and its heavy key store; the host session service owns the
 * subscription lifecycle. These commands store nothing in `ArchState`: pages,
 * deltas, and stream state never cross the state boundary. Each handler only
 * emits the side-effect record the EffectRunner needs to reach the session
 * service (which mints the `subscriptionId` for subscribe).
 */
export function handleDetailSubscribe(
  state: ArchState,
  cmd: Extract<Command, { kind: 'DetailSubscribe' }>,
): ReducerResult {
  return {
    state,
    effects: [
      {
        kind: 'DetailSubscribeRpc',
        corrId: cmd.corrId,
        viewGeneration: cmd.viewGeneration,
        detailKey: cmd.detailKey,
        address: cmd.address,
        ...(cmd.cursor !== undefined ? { cursor: cmd.cursor } : {}),
      },
    ],
  };
}

export function handleDetailUnsubscribe(
  state: ArchState,
  cmd: Extract<Command, { kind: 'DetailUnsubscribe' }>,
): ReducerResult {
  return {
    state,
    effects: [
      {
        kind: 'DetailUnsubscribeRpc',
        corrId: cmd.corrId,
        viewGeneration: cmd.viewGeneration,
        detailKey: cmd.detailKey,
        reason: cmd.reason,
      },
    ],
  };
}

export function handleDetailFetchPages(
  state: ArchState,
  cmd: Extract<Command, { kind: 'DetailFetchPages' }>,
): ReducerResult {
  return {
    state,
    effects: [
      {
        kind: 'DetailFetchPagesRpc',
        corrId: cmd.corrId,
        viewGeneration: cmd.viewGeneration,
        detailKey: cmd.detailKey,
        ref: cmd.ref,
      },
    ],
  };
}
