import { produce } from 'immer';

import type { ArchState } from '../arch-state.js';
import type { Command } from '../commands.js';
import type { ComposerInput } from '../../../shared/protocol.js';
import { decodedBase64ByteLength, MAX_AGGREGATE_IMAGE_INPUT_BYTES } from '../../../shared/image-constraints.js';
import type { ReducerResult } from './helpers.js';

export function handleAddComposerInput(state: ArchState, cmd: Extract<Command, { kind: 'AddComposerInput' }>): ReducerResult {
  const input: ComposerInput = { ...cmd.input, id: `${cmd.corrId}:input` } as ComposerInput;
  const existing = state.composer.pendingComposerInputsBySession[cmd.sessionPath] ?? [];
  const aggregateImageBytes = existing.reduce(
    (total, entry) => total + (entry.kind === 'imageBlob'
      ? Math.max(entry.sizeBytes, decodedBase64ByteLength(entry.dataBase64))
      : 0),
    input.kind === 'imageBlob' ? Math.max(input.sizeBytes, decodedBase64ByteLength(input.dataBase64)) : 0,
  );
  if (aggregateImageBytes > MAX_AGGREGATE_IMAGE_INPUT_BYTES) {
    return {
      state: {
        ...state,
        settings: {
          ...state.settings,
          notice: `Cannot attach image: aggregate image size exceeds the ${MAX_AGGREGATE_IMAGE_INPUT_BYTES} byte limit.`,
        },
      },
      effects: [],
    };
  }
  return {
    state: {
      ...state,
      composer: {
        ...state.composer,
        pendingComposerInputsBySession: {
          ...state.composer.pendingComposerInputsBySession,
          [cmd.sessionPath]: [...existing, input],
        },
      },
    },
    effects: [],
  };
}

export function handleRemoveComposerInput(state: ArchState, cmd: Extract<Command, { kind: 'RemoveComposerInput' }>): ReducerResult {
  const existing = state.composer.pendingComposerInputsBySession[cmd.sessionPath] ?? [];
  return {
    state: {
      ...state,
      composer: {
        ...state.composer,
        pendingComposerInputsBySession: {
          ...state.composer.pendingComposerInputsBySession,
          [cmd.sessionPath]: existing.filter((inp) => inp.id !== cmd.inputId),
        },
      },
    },
    effects: [],
  };
}

export function handleSetComposerDraft(state: ArchState, cmd: Extract<Command, { kind: 'SetComposerDraft' }>): ReducerResult {
  return {
    state: produce(state, (draft) => {
      draft.composer.draftTextBySession[cmd.sessionPath] = cmd.text;
    }),
    effects: [],
  };
}

export function handleSetEditingMessage(state: ArchState, cmd: Extract<Command, { kind: 'SetEditingMessage' }>): ReducerResult {
  return {
    state: produce(state, (draft) => {
      draft.transcript.editingMessageIdBySession[cmd.sessionPath] = cmd.messageId;
      delete draft.transcript.editingDraftBySession[cmd.sessionPath];
    }),
    effects: [],
  };
}
